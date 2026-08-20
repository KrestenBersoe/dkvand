// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko — Node/Express server
//
// Serves the static map app and provides a weather proxy with a shared
// server-side cache. This collapses Open-Meteo calls from "per browser"
// to "per 0.25° grid cell per 3h, globally".
//
// Run:
//   npm install
//   node server.js
//   → http://localhost:3000
//
// Endpoints:
//   GET /                         → dansk-overloeb-kort.html
//   GET /puls-data.json           → PULS dataset (Cache-Control 14 days)
//   GET /api/weather/all          → full pre-warmed grid as one cacheable response
//   GET /api/weather/hourly?key=  → hourlyObs+hourlyFore for one cell (on demand)
//   GET /api/weather?lat=&lng=    → single cell (fallback)
//   GET /api/health               → status + cache stats
// ═══════════════════════════════════════════════════════════════════════════

const express     = require('express');
const compression = require('compression');
const path        = require('path');
const https       = require('https');
const fs          = require('fs');
const zlib        = require('zlib');
const crypto      = require('crypto');
const webpush     = require('web-push');
// NYT (2026-08-20, event loop-blokerings-rettelse): kun brugt af
// runBadevandRiskCascadeInWorker() — se dens filhoved og badevand-risk-
// worker.js for hvorfor computeBadevandRiskCascade() flyttede til en
// separat OS-tråd.
const { Worker }  = require('worker_threads');
// NYT: portering af risikomodellen fra dansk-overloeb-kort.html, så
// serveren selv kan evaluere overløbsrisiko UAFHÆNGIGT af om en klient har
// en fane åben — se server-modules/risk-model.js for fuld begrundelse.
const riskModel    = require('./risk-model');
const waterClass    = require('./water-classification');
const badevandRisk  = require('./badevand-risk');
// NYT: borgerobservationer (ét-tryks status + algeobservation) — se modulets
// eget filhoved for den HÅRDE grænse mod at dette nogensinde må påvirke
// badevandRisk's officielle farve/badge. Egen SQLite-fil på samme Volume,
// ikke en del af badevandRisk's eget datagrundlag.
const badestedObs  = require('./badested-observations');
// NYT (Kommunepakke, modul 6): kommune-overstyring af et badesteds
// offentlige status — se modulets eget filhoved for den fulde begrundelse,
// inkl. hvorfor dette IKKE er en undtagelse fra badested-observations.js's
// HÅRDE GRÆNSE ovenfor.
const badestedOverrides = require('./badested-overrides');
// NYT: installations-telemetri (stille heartbeat, aktiv-installationstal pr.
// platform) + daglig badevands-risikohistorik (grundlag for ugentlig
// badested-digest) — se modulets eget filhoved for begrundelsen bag
// persisteret løbende gennemsnit frem for in-memory-akkumulering.
const appMetrics   = require('./app-metrics');
// NYT (Kommune Dashboard-udvidelse, "Overløb"-fanen) — ren beregningsfunktion,
// se modulets eget filhoved for hvorfor kommune-scoping/bucketing er isoleret
// her i stedet for direkte i selve ruterne nedenfor.
const overloebStatus = require('./overloeb-status');
const overloebEvents = require('./overloeb-events');
// NYT (Kommune Dashboard-udvidelse, "Skilte"-fanen) — PDF/QR-genererings-
// logik (ren funktion, se dens filhoved) og SSRF-sikker logo-hentning.
const skilte = require('./skilte');
const logoFetch = require('./logo-fetch');
const PDFDocument = require('pdfkit');
// NYT (bruger-ønske 2026-08-10 — URL-arkitektur/SEO): navn-kommune-slugs for
// Tier 1/2 (/badested/:slug, /soe/:slug) + sitemap.xml — se modulets eget
// filhoved for hvorfor slug-skemaet er bekræftet mod reelle data (0
// kollisioner), ikke antaget.
const slugIndex    = require('./slug-index');
const seoPages     = require('./seo-pages');
// NYT (Kommunepakke, modul 1 — se planen cached-toasting-stardust.md):
// tenant-model, database-skema, trial-login og sessions-cookie for det
// kommende kommune-admin-dashboard. Se modulets eget filhoved for den fulde
// afgrænsning af hvad der ER og IKKE ER med i dette modul.
const tenantAdmin  = require('./tenant-admin');
// NYT (Kommunepakke, modul 3): dynamisk OAuth-login (openid-client) — se
// modulets eget filhoved.
const oauthLogin   = require('./oauth-login');
// NYT (Kommunepakke, modul 4): tenant -> badesteder-mapping (normaliseret
// kommune-navnematch) — se modulets eget filhoved.
const tenantBadesteder = require('./tenant-badesteder');
// NYT: delt Postgres-forbindelse — push-abonnementer/-kø (nedenfor) er den
// sidste del af appen der stadig lå i en lokal, ikke-delt fil/Map, se
// db.js's filhoved for den fulde begrundelse (samme multi-maskine-
// fragmenterings-problem som app-metrics.js/badested-observations.js
// allerede blev migreret væk fra).
const { query } = require('./db');
const multer       = require('multer');

// ── Persistent Volume-mount, hvis tilgængelig ────────────────────────────────
// Se fly.toml [[mounts]]. Containerens rodfilsystem (__dirname) nulstilles
// ved hvert fuldt Fly-autostop, så alt der skal overleve en rigtig genstart
// (strøm-cache, push-subscriptions) skal ligge her i stedet. Falder tilbage
// til __dirname hvis /data ikke findes (lokal udvikling, eller før volumen
// er oprettet), så koden virker uændret begge steder.
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;

// ── VAPID configuration ─────────────────────────────────────────────────────
// Set these as environment variables on Fly.io:
//   fly secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...
// Never commit private key to git.
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@ditbadevand.dk';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('Web Push VAPID configured');
} else {
  console.warn('VAPID keys not set — push notifications disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
}

// ── Push-subscriptions + -afsendelseskø: Postgres (Fly Managed Postgres) ────
// RETTET (2026-08-02): var tidligere en in-memory Map + JSON-fil på den
// lokale /data-volume — SAMME multi-maskine-fragmenteringsproblem som
// app-metrics.js/badested-observations.js allerede blev migreret væk fra
// (se disse moduler, og fly.toml's [[mounts]]-advarsel, for den fulde
// begrundelse: to Fly-maskiner ville ende med to helt adskilte
// abonnentlister). Postgres er netværkstilgængeligt fra alle maskiner.
//
// Konsekvens af migreringen — INGEN in-memory tilstand længere: hot-path-
// funktioner (enqueuePushNotifications(), runPeriodicEngagementJob())
// henter nu en FRISK kopi af alle abonnementer ÉN gang pr. kørsel (samme
// batch-hentnings-mønster som badevand_daily_risk i app-metrics.js), i
// stedet for at iterere en langtlevende Map. CRUD-endepunkterne
// (subscribe/unsubscribe/update-favourites) er nu direkte, målrettede
// Postgres-forespørgsler — INGEN fil-persistering, ingen crash-vindue at
// bekymre sig om (en INSERT/UPDATE ER allerede holdbart gemt, i modsætning
// til den tidligere synkrone fs.writeFileSync()-af-hele-filen-hver-gang).
//
// push-afsendelseskøen (tidligere pushSendQueue-arrayet + push-queue.json)
// er samme historie: en INSERT er allerede persisteret, så den tidligere
// "genindlæs ventende jobs fra disk ved opstart"-logik er overflødig — et
// job, der blev BESLUTTET men ikke nået at blive SENDT før en genstart,
// ligger stadig i push_send_queue-tabellen og bliver naturligt hentet af
// den NÆSTE flushPushQueue()-kørsel (kaldt periodisk fra
// evaluatePushNotifications()-kæden) uden nogen særskilt opstartslogik.
const schema = query(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint        TEXT PRIMARY KEY,
    subscription    JSONB NOT NULL,
    favourites      JSONB NOT NULL DEFAULT '[]',
    badevand_groups JSONB NOT NULL DEFAULT '[]',
    install_id      TEXT,
    platform        TEXT,
    notified_state  JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS push_send_queue (
    id          BIGSERIAL PRIMARY KEY,
    endpoint    TEXT NOT NULL,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    hit_stamps  JSONB NOT NULL DEFAULT '[]',
    enqueued_at BIGINT NOT NULL
  );
`).then(() => console.info('push_subscriptions/push_send_queue: Postgres-skema klar'))
  .catch(e => { console.error('push_subscriptions/push_send_queue: skemaoprettelse fejlede —', e.message); throw e; });

// NYT: de fire typer beskeder appen reelt sender — sat på hvert job ved
// enqueue-tidspunkt (se de fire pushSendQueue-INSERT-kaldssteder), læst af
// flushPushQueue() til at logge FAKTISK lykkedes afsendelser via
// appMetrics.recordPushSent(), til /api/stats' "hvor mange push, af hvilken
// slags"-rapportering (se appMetrics.getPushSendStats()).
const PUSH_SEND_TYPES = {
  RISIKOVARSEL:     'risikovarsel',      // overløbs-/badevands-risikovarsel (enqueuePushNotifications())
  HEARTBEAT:        'heartbeat',         // stille installations-heartbeat (runPeriodicEngagementJob())
  UGENTLIG_DIGEST:  'ugentlig-digest',   // ugentlig badested-status (runPeriodicEngagementJob())
  NY_VURDERING:     'ny-vurdering',      // dagens første borger-vurdering af et badested (broadcastFirstVurderingOfDay())
  KOMMUNE_OVERRIDE: 'kommune-override',  // Kommunepakke, modul 6 — kommune-overstyring af et badesteds status (POST /admin/api/override)
};

// Rå Postgres-række → samme feltnavne (camelCase) som resten af koden
// allerede forventede fra den gamle in-memory Map's entry-objekter.
function mapSubscriptionRow(row) {
  return {
    endpoint: row.endpoint,
    subscription: row.subscription,
    favourites: row.favourites || [],
    badevandGroups: row.badevand_groups || [],
    installId: row.install_id,
    platform: row.platform,
    notifiedState: row.notified_state || {},
  };
}

/** Alle abonnementer, ÉN batch-hentning — se filhovedet for hvorfor. */
async function getAllPushSubscriptions() {
  const { rows } = await query(`SELECT * FROM push_subscriptions`);
  return rows.map(mapSubscriptionRow);
}

async function getPushSubscriptionCount() {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`);
  return rows[0].n;
}

// Sender ét job — fanger ALTID selv sin fejl og returnerer et almindeligt
// resultat-objekt i stedet for at kaste, så Promise.all (ikke .allSettled)
// er tilstrækkeligt og enkelt i flushPushQueue() nedenfor.
async function sendOnePushJob(job, subsByEndpoint) {
  // Slår abonnementet op i den batch, flushPushQueue() allerede har hentet
  // (se dér) — respekterer korrekt en afmelding, der skete i det korte
  // vindue mellem enqueue og selve afsendelsen, da den batch hentes FRISK
  // ved hvert flush-kald, ikke ved enqueue-tidspunktet.
  const entry = subsByEndpoint.get(job.endpoint);
  if (!entry) return { job, ok: false, expired: false };
  try {
    await webpush.sendNotification(entry.subscription, job.payload);
    return { job, entry, ok: true };
  } catch (e) {
    return { job, entry, ok: false, expired: e.statusCode === 410 || e.statusCode === 404 };
  }
}

let _flushingPushQueue = false;
async function flushPushQueue() {
  // Samme reentrancy-mønster som evaluatePushNotifications() — et
  // samtidigt kald genbruger blot resultatet af den allerede kørende
  // tømning, i stedet for at starte en overlappende ekstra kørsel.
  if (_flushingPushQueue) return;
  _flushingPushQueue = true;
  try {
    // NYT: DELETE ... RETURNING claimer og fjerner HELE køen ATOMISK i ét
    // statement — simplere og mere robust end den tidligere splice-array-
    // så-persistér-tom-fil-to-trins-proces (ingen mellemtilstand hvor køen
    // er tømt i hukommelsen men endnu ikke gemt).
    const { rows: jobs } = await query(`
      DELETE FROM push_send_queue
      RETURNING endpoint, type, payload, hit_stamps, enqueued_at
    `);
    if (jobs.length === 0) return;

    // ÉT batch-opslag af de abonnementer, der reelt er relevante for denne
    // afsendelse — ikke ét opslag PR. job (ville kunne udtømme pg.Pool'ens
    // forbindelser ved en stor kø, se db.js).
    const endpoints = [...new Set(jobs.map(j => j.endpoint))];
    const { rows: subRows } = await query(`SELECT * FROM push_subscriptions WHERE endpoint = ANY($1)`, [endpoints]);
    const subsByEndpoint = new Map(subRows.map(r => [r.endpoint, mapSubscriptionRow(r)]));

    // NYT: SAMTIDIG afsendelse — Promise.all i stedet for en sekventiel
    // for-await-løkke. Ved den nuværende, beskedne abonnenttal (typisk
    // få-til-nogle-og-tyve) er der ingen grund til en kunstig
    // samtidigheds-grænse (p-limit-lignende); bliver abonnenttallet
    // markant større (hundreder+), er det værd at genoverveje for ikke at
    // ramme push-tjenesternes egne rate-grænser.
    const results = await Promise.all(jobs.map(job => sendOnePushJob(job, subsByEndpoint)));

    let sent = 0, failed = 0;
    const expiredEndpoints = [];
    const notifiedStateByEndpoint = new Map(); // endpoint -> sammenflettet notifiedState-objekt
    const pushSentLogs = [];

    for (const r of results) {
      if (r.ok) {
        sent++;
        const merged = notifiedStateByEndpoint.get(r.job.endpoint) || { ...(r.entry.notifiedState || {}) };
        for (const h of r.job.hit_stamps) merged[h.key] = { ts: Number(r.job.enqueued_at), risk: h.risk };
        notifiedStateByEndpoint.set(r.job.endpoint, merged);
        // NYT: logger KUN her — ved bekræftet vellykket levering, aldrig ved
        // blot kø-tilmelding — se app-metrics.js's recordPushSent(). Samlet
        // op og afventet SAMTIDIGT nedenfor (uafhængige inserts, ingen
        // rækkefølge-afhængighed) i stedet for at afvente hver enkelt
        // sekventielt inde i loopet.
        pushSentLogs.push(appMetrics.recordPushSent(r.job.type));
      } else {
        failed++;
        if (r.expired) expiredEndpoints.push(r.job.endpoint);
      }
    }

    await Promise.all([
      ...pushSentLogs,
      ...[...notifiedStateByEndpoint.entries()].map(([endpoint, state]) =>
        query(`UPDATE push_subscriptions SET notified_state = $1 WHERE endpoint = $2`, [JSON.stringify(state), endpoint])),
      expiredEndpoints.length > 0
        ? query(`DELETE FROM push_subscriptions WHERE endpoint = ANY($1)`, [expiredEndpoints])
        : Promise.resolve(),
    ]).catch(e => console.warn('flushPushQueue (efterbehandling) fejl:', e.message));

    console.info(`Push-kø tømt: ${sent} sendt (samtidigt), ${failed} fejlet/udløbet/afmeldt siden`);
  } finally {
    _flushingPushQueue = false;
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Gzip everything — JSON payloads compress ~70-80%
app.use(compression());

// ── Static files with appropriate cache headers ─────────────────────────────
const STATIC_DIR = __dirname;

// NYT (bruger-ønske 2026-08-10): bygges ÉN gang her, synkront, ved opstart —
// se slug-index.js's filhoved for hvorfor runtime-genopbygning ikke er
// nødvendig (kilde-filerne ændres kun via den offline update-all-data.sh-
// pipeline). Bruges af /badested/:slug, /soe/:slug og /sitemap.xml nedenfor.
const { badestedSlugToInfo, idToBadestedSlug, soeSlugToInfo, navnToSoeSlug, kommuneKeyToBadesteder } = slugIndex.buildSlugIndex(STATIC_DIR);
// NYT (bruger-ønske 2026-08-17 — "Badesteder i nærheden" på /badested/:slug):
// badestedSlugToInfo's værdier bærer ikke selve slug'et (kun kortets nøgle
// gør) — bygget ÉN gang her (samme livscyklus som slug-index selv), ikke
// pr. request, se nearestBadesteder()'s kaldested.
const allBadestederWithSlug = [...badestedSlugToInfo.entries()].map(([slug, v]) => ({ slug, navn: v.navn, lat: v.lat, lng: v.lng }));

// PULS data: changes once a year → cache aggressively
app.get('/puls-data.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=1209600');  // 14 days
  res.sendFile(path.join(STATIC_DIR, 'puls-data.json'));
});

// VP3 geodata: static reference files updated rarely, men "rarely" var
// før i dag også hvad vi troede om selve indholdet, indtil et helt kodet og
// deployet farve-skel (spildevand vs. ikke) forblev usynligt for brugeren i
// flere runder, fordi klientens browser-cache (max-age=604800 = 7 dage)
// aldrig gengav en betinget forespørgsel — den så end ikke om filen var
// ændret på serveren, uanset hvor mange gange VI redeployede. no-cache
// tvinger en (billig, ETag-baseret) revalidering ved HVER indlæsning i
// stedet, så en fil-opdatering slår igennem med det samme, ikke op til en
// uge senere.
const VP3_FILES = [
  'vp3_kystvande_simplified.geojson',
  'vp3_badevand.geojson',
  'vp3_rbu_slim.geojson',
];
VP3_FILES.forEach(f => {
  app.get('/' + f, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(STATIC_DIR, f));
  });
});

// HTML: no-cache so the browser always revalidates with the server.
// (Use a short max-age in production once stable; no-cache avoids stale-JS
// confusion during active development.)
//
// RETTET/FJERNET: injicerede tidligere en MAPTILER_KEY fra en Fly secret
// ind i HTML'en ved hvert kald (se git-historik hvis den gamle mekanisme
// skal genfindes). Overflødig nu — kortet henter fliser fra vores egen,
// selv-hostede tileserver (se tileserver/-mappen), som ikke kræver nogen
// nøgle. Simplere OG fjerner afhængigheden af en ekstern kvote helt.
// RETTET: no-cache tillader browseren at GEMME en kopi, blot med krav om at
// den først bekræfter med serveren, om noget er ændret (via ETag/Last-
// Modified), før den bruges — en revalideringsdans, iOS' WebView-motor for
// installerede PWA'er er kendt for at håndtere upålideligt/for aggressivt i
// praksis. no-store er en langt mere utvetydig instruks: cache overhovedet
// intet, hent altid en frisk kopi. For selve app-skallen (denne ene HTML-
// fil, ikke de store statiske datafiler) er den lille bandbredde-omkostning
// et fornuftigt bytte mod at udelukke forældet-app-kode som forklaring.
// ── Pre-komprimeret app-skal — gzip/brotli beregnes ÉN gang pr. filversion,
// ikke pr. forespørgsel ─────────────────────────────────────────────────────
// RETTET (bruger-ønske: "optimer i forhold til gzip og hurtig levering af
// scripts og html"): denne rute svarer med Cache-Control: no-store
// (bevidst, se kommentaren nedenfor — undgår en kendt iOS WebView-cache-
// fejl for installerede PWA'er), hvilket betyder browseren ALDRIG selv
// cacher filen — hver eneste sidevisning henter (og, indtil nu,
// GENkomprimerer) samtlige ~430 KB fra bunden. Den generiske
// compression()-middleware ovenfor gzip'er responsen PÅ NY for hver
// forespørgsel, selvom selve filindholdet kun ændrer sig ved en deploy —
// ren spildt CPU-tid for identisk output, især mærkbart på den delte vCPU
// (se samtalen om evaluatePushNotifications()' egen overbelastningshændelse).
//
// Beregner nu i stedet gzip (niveau 9, maksimal kompression — billigt at
// vælge det højeste niveau, når arbejdet alligevel kun sker én gang) OG
// brotli (kvalitet 11 — ~19% mindre end gzip for denne fil, moderne
// browsere foretrækker br via Accept-Encoding) ÉN gang, cachet i
// hukommelsen og nøglet på filens mtime (ugyldiggøres automatisk, hvis
// filen skulle ændre sig uden en fuld proces-genstart — sker ikke i
// praksis, da en deploy altid genstarter processen, men koster intet at
// være korrekt om). Selve HTTP-cachingen (no-store) er UÆNDRET — dette
// handler kun om at undgå at gentage identisk kompressionsarbejde ved
// hver eneste forespørgsel, ikke om at ændre klientens cache-adfærd.
//
// Sætter selv Content-Encoding, FØR noget skrives til res — compression()-
// middleware'ns egen shouldCompress()-tjek springer korrekt over en
// response, der allerede har Content-Encoding sat (bekræftet ved test:
// ingen dobbelt-komprimering).
let _htmlCompressedCache = null; // { mtimeMs, raw, gzip, brotli }
function getCompressedHtml() {
  const filePath = path.join(STATIC_DIR, 'dansk-overloeb-kort.html');
  const stat = fs.statSync(filePath);
  if (_htmlCompressedCache && _htmlCompressedCache.mtimeMs === stat.mtimeMs) return _htmlCompressedCache;
  // NYT (bruger-ønske 2026-08-10 — URL-arkitektur/SEO, punkt 5 "intern
  // linking"): den skjulte, men egte crawlbare sitelinks-liste (se
  // seo-pages.js's buildSitelinksHtml()) injiceres HER, FØR gzip/brotli
  // beregnes — nul pr.-request-omkostning, samme princip som selve
  // forkomprimeringen. Gælder derfor automatisk BÅDE '/' og de nye Tier
  // 1/2/3-sider (som alle genbruger denne cache som base, se
  // baseAppHtml()/de nye routes).
  const rawFile = fs.readFileSync(filePath, 'utf8');
  const withSitelinks = rawFile.replace('<body>', `<body>${seoPages.buildSitelinksHtml(badestedSlugToInfo, soeSlugToInfo)}`);
  const raw    = Buffer.from(withSitelinks, 'utf8');
  const gzip   = zlib.gzipSync(raw, { level: 9 });
  const brotli = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]:   11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  _htmlCompressedCache = { mtimeMs: stat.mtimeMs, raw, gzip, brotli };
  console.log(`HTML forkomprimeret: ${raw.length} B → gzip ${gzip.length} B (${Math.round(100*gzip.length/raw.length)}%), brotli ${brotli.length} B (${Math.round(100*brotli.length/raw.length)}%)`);
  return _htmlCompressedCache;
}

// SEO-rettelse (bruger-rapporteret 2026-08-17 — Google indekserer ikke de
// fleste /badested/:slug-sider, GSC: "Duplicate, Google chose different
// canonical than user"): roden er at ALLE badested/soe-sider deler den
// SAMME 612KB app-shell som '/' — inkl. #tab-doc's fulde "Om"-panel
// (Formål/Datakilder/Kortlag/Risikomodel/.../Referencer), som er skjult via
// en CSS-klasse, ikke fjernet fra DOM'en. Målt: ~58.560 tegn synlig tekst,
// identisk på ALLE ~2.000 sider, mod kun ~200-400 tegns reelt unikt indhold
// pr. side (buildSsrContent()) — det forhold er hvad der får Google til at
// klynge siderne som næsten-duplikater og se bort fra hver sides i øvrigt
// korrekte, selv-refererende canonical-tag.
//
// Løsning: #tab-doc udelades HELT fra den shell badested/soe-siderne
// bruger (denne funktion) og flyttes til sin egen, selvstændigt
// indekserbare /om-side (se /om-routen nedenfor), som genbruger den
// UBESKÅRNE getCompressedHtml().raw. '/' og /udloeb/:id er upåvirkede — de
// bruger fortsat getCompressedHtml() direkte.
let _ssrShellCache = null; // { mtimeMs, html }
function getSsrShellHtml() {
  const filePath = path.join(STATIC_DIR, 'dansk-overloeb-kort.html');
  const stat = fs.statSync(filePath);
  if (_ssrShellCache && _ssrShellCache.mtimeMs === stat.mtimeMs) return _ssrShellCache.html;
  const full = getCompressedHtml().raw.toString('utf8');
  // Ankret til BEGGE ender (åbnings-tag + den eksplicitte afslutnings-
  // kommentar, se dansk-overloeb-kort.html:2135/2593) — et rent
  // start-tag-match ville også kunne ramme forkert ved en fremtidig
  // ombygning af selve panelet.
  const stripped = full.replace(
    /<div class="tab-panel" id="tab-doc">[\s\S]*?<\/div><!-- \/tab-doc -->/,
    '<div class="tab-panel" id="tab-doc"></div><!-- /tab-doc -->'
  );
  if (stripped === full) {
    console.warn('getSsrShellHtml: #tab-doc-blokken blev IKKE fundet/fjernet — falder tilbage til den fulde shell (badested/soe-sider vil fortsat indeholde Om-panelet).');
  }
  // Signalerer til klienten (se #tab-btn-doc's openDocTab() i dansk-
  // overloeb-kort.html) at #tab-doc er tom her, og "Om"-knappen derfor skal
  // navigere til /om i stedet for at skifte fane lokalt.
  //
  // BUG (produktions-rapporteret 2026-08-17 — "Uncaught SyntaxError:
  // Unexpected end of input" på /badested/farum-soe-doktorens-bugt-furesoe,
  // reelt alle badested/soe-sider): .replace('</body>', …) er en STRENG,
  // ikke en global regex, og rammer derfor kun den FØRSTE forekomst af
  // "</body>" i hele filen — men print-skilt-funktionen (dansk-overloeb-
  // kort.html:8924) bygger selv et HTML-dokument som en JS-template-streng,
  // og DEN indeholder også teksten "</body>", TIDLIGERE i filen end sidens
  // egen, rigtige lukke-tag (:11486). Indsættelsen landede derfor midt i
  // den JS-streng, kløvede den, og gav ugyldig JS på ALLE badested/soe-
  // sider. lastIndexOf() rammer i stedet altid den SIDSTE — og dermed
  // reelt eneste rigtige — forekomst, uanset hvor mange "</body>"-agtige
  // tekststumper der måtte findes tidligere inde i selve app-JS'en.
  const bodyCloseIdx = stripped.lastIndexOf('</body>');
  const html = bodyCloseIdx === -1
    ? stripped
    : stripped.slice(0, bodyCloseIdx) + '<script>window.__DOC_PANEL_STRIPPED__=true;</script>' + stripped.slice(bodyCloseIdx);
  _ssrShellCache = { mtimeMs: stat.mtimeMs, html };
  return html;
}

app.get(['/', '/dansk-overloeb-kort.html'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Vary', 'Accept-Encoding'); // afgørende for korrekthed bag Cloudflare — se samtalen om cachelaget foran appen
  const cached = getCompressedHtml();
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('br')) {
    res.set('Content-Encoding', 'br');
    res.end(cached.brotli);
  } else if (acceptEncoding.includes('gzip')) {
    res.set('Content-Encoding', 'gzip');
    res.end(cached.gzip);
  } else {
    // Ekstremt sjældent i praksis (stort set alle klienter siden ~2010
    // understøtter gzip) — men et ukomprimeret svar er stadig korrekt,
    // fremfor at antage support og risikere en ulæselig side.
    res.end(cached.raw);
  }
});

// ── Statistikside — offentlig, ingen adgangsbeskyttelse (bevidst valg) ──────
// Letvægts, selvstændig side (IKKE en del af den store SPA-fil ovenfor) —
// henter selv GET /api/stats client-side, se stats.html.
app.get('/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(STATIC_DIR, 'stats.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
// Kommunepakke, modul 1 — se tenant-admin.js's filhoved for den fulde
// afgrænsning (kun trial-login virker i dette modul, OAuth-login er et
// fremtidigt modul). Alle tre ruter er BEVIDST placeret her, før
// PUBLIC_STATIC_EXTENSIONS-gatemiddleware'en længere nede — /admin/trial/:token
// og /admin/dashboard har ingen fil-endelse og ville ellers blive 404'et af den
// (samme begrundelse som Tier 1/2/3-URL-arkitekturens routes ovenfor).
// ═══════════════════════════════════════════════════════════════════════════

// Trial-login: hasher token'et, slår op, sætter sessions-cookien, redirect.
// Fejler ALTID til en generisk fejlbesked (aldrig "token findes ikke" vs.
// "token udløbet" separat) — et gættet/forsøgt token skal ikke kunne
// skelne de to, samme princip som badested-observations.js's bevidst vage
// rate limit-besked mod automatiseret afprøvning.
app.get('/admin/trial/:token', async (req, res) => {
  try {
    const trial = await tenantAdmin.consumeTrialLogin(req.params.token);
    if (!trial) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      return res.status(401).type('text/plain').send('Login-link er ugyldigt, udløbet eller tilbagekaldt.');
    }
    const cookieValue = tenantAdmin.signSession({ tenantId: trial.tenantId, authMethod: 'trial' });
    res.set('Set-Cookie', tenantAdmin.buildSessionSetCookieHeader(cookieValue));
    res.redirect('/admin/dashboard');
  } catch (e) {
    console.error('admin/trial: uventet fejl —', e.message);
    res.status(500).type('text/plain').send('Kunne ikke behandle login-linket lige nu.');
  }
});

// ── Internt værktøj — selvbetjent trial-oprettelse for salg ────────────────
// Erstatter det tidligere manuelle behov for at et driftsteam-medlem selv
// skulle SSH'e ind og køre scripts/create-tenant-trial.js for hver eneste
// trial (se den fils filhoved for den GAMLE arbejdsgang). Samme underlæggende
// tenantAdmin.createTenant()/issueTrialLogin()-kald, blot bag en HTTP-rute
// fremfor en CLI, så salgsmedarbejdere selv kan generere et login-link.
//
// BEVIDST simpel auth: ÉT delt kodeord (INTERNAL_ADMIN_PASSWORD, Fly secret),
// tjekket via HTTP Basic Auth — IKKE et rigtigt personligt staff-login (der
// findes stadig ingen web-baseret platform-admin-brugerdatabase, samme
// bevidste "uden for scope" som tenant-admin.js's filhoved allerede
// beskriver for selve CLI-scriptet). Tilstrækkeligt til at holde det UDE AF
// offentlighedens rækkevidde uden at bygge et helt login-system for et lille,
// betroet internt team — men giver INGEN person-specifik audit-log (kun
// hvad brugeren selv skriver i "issued-by"-feltet, ikke verificeret).
// Genovervej en rigtig intern login-løsning, hvis det behov opstår.
function requireInternalAuth(req, res, next) {
  const expected = process.env.INTERNAL_ADMIN_PASSWORD || '';
  if (!expected) {
    return res.status(503).type('text/plain').send('Internt værktøj er ikke konfigureret (INTERNAL_ADMIN_PASSWORD mangler som Fly secret).');
  }
  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');
  let providedPassword = '';
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    providedPassword = sepIdx >= 0 ? decoded.slice(sepIdx + 1) : decoded;
  }
  // RETTET: timingSafeEqual kaster hvis buffer-længderne ikke matcher (i
  // stedet for blot at returnere false) — kræver derfor et eksplicit
  // længde-tjek FØRST, ellers ville et forkert-langt kodeord crashe
  // requesten i stedet for pænt at give 401.
  const a = Buffer.from(providedPassword);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="Internt vaerktoej"');
    return res.status(401).type('text/plain').send('Login paakraevet.');
  }
  next();
}

app.get('/internal/create-trial', requireInternalAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(STATIC_DIR, 'internal-create-trial.html'));
});

app.post('/internal/api/create-trial', requireInternalAuth, express.json(), async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const days = Number(req.body?.days);
    const issuedBy = typeof req.body?.issuedBy === 'string' ? req.body.issuedBy.trim() : '';
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null;
    const logoUrl = typeof req.body?.logoUrl === 'string' && req.body.logoUrl.trim() ? req.body.logoUrl.trim() : null;

    if (!name) return res.status(400).json({ error: 'Kommunens navn mangler.' });
    if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ error: 'Trial-længde skal være et positivt antal dage.' });
    if (!issuedBy) return res.status(400).json({ error: 'Dit navn mangler.' });

    const tenant = await tenantAdmin.createTenant({
      name, status: 'trial', trialDays: days, createdBy: issuedBy, logoUrl,
    });
    const rawToken = await tenantAdmin.issueTrialLogin({
      tenantId: tenant.id, expiresAt: tenant.trial_expires_at, issuedBy, note,
    });
    const loginUrl = `${seoPages.SITE_URL}/admin/trial/${rawToken}`;

    res.json({
      tenant: { id: tenant.id, name: tenant.name, trialExpiresAt: tenant.trial_expires_at },
      loginUrl,
    });
  } catch (e) {
    if (e.code === 'VALIDATION') {
      return res.status(400).json({ error: e.message });
    }
    console.error('internal/api/create-trial: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke oprette trial lige nu.' });
  }
});

// NYT (bruger-ønske — kommune-vælger til trial-formularen i stedet for fri
// tekst, se internal-create-trial.html's filhoved): kilden er BEVIDST
// kommuneKeyToBadesteder (slug-index.js), IKKE puls-data.json's rå
// auths-liste — det er PRÆCIS den samme kilde normalizeKommuneKey(tenant.
// name) senere slås op imod alle andre steder i appen (fx
// resolveTenantBadesteder(), computeKommuneBenchmark()), så et navn valgt
// her er GARANTERET at finde badesteder senere. Den rå PULS-liste har
// derimod bekræftede datakvalitetsproblemer (inkonsistent store/små
// bogstaver, en udgået "LEJRE KOMMUNE (Udgået 31-08-2007)"-post — fundet
// under kommune-benchmark-arbejdet, se computeKommuneBenchmark()'s
// datakvalitets-gruppering), som ville sende sales-medarbejdere direkte i
// samme fælde som den frie tekst-indtastning allerede advarede imod.
// Ingen DB-forespørgsel — rent in-memory opslag, samme "kilde allerede i
// module scope" som computeKommuneBenchmark() selv bruger.
app.get('/internal/api/kommuner', requireInternalAuth, (req, res) => {
  const list = [...kommuneKeyToBadesteder.entries()]
    .filter(([, badesteder]) => badesteder.length > 0)
    .map(([, badesteder]) => ({
      name: (badestedSlugToInfo.get(badesteder[0].slug)?.kommune || badesteder[0].navn)
        .replace(/\s*kommune\s*$/i, '').trim(),
      badestedCount: badesteder.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'da'));
  res.set('Cache-Control', 'no-store');
  res.json(list);
});

// NYT (bruger-ønske — salgsteamets adgang til EKSISTERENDE kommuner): liste
// til vælgeren i internal-create-trial.html's nye kort. Ingen status-filter
// (se listTenants()'s filhoved) — status vises i selve UI'en i stedet.
app.get('/internal/api/tenants', requireInternalAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await tenantAdmin.listTenants());
  } catch (e) {
    console.error('internal/api/tenants: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente kommuneliste lige nu.' });
  }
});

// NYT (bruger-ønske — salgsteamets adgang til EKSISTERENDE kommuner): SAMME
// tenantAdmin.issueTrialLogin()-kald som POST /internal/api/create-trial
// ovenfor bruger, blot UDEN det forudgående createTenant() — se
// issueTrialLogin()'s filhoved (tenant-admin.js): funktionen er allerede
// fuldt generisk over for tenant.status (rører den slet ikke), og det
// udstedte link er genbrugeligt-indtil-udløb, ikke engangsbrug, så den
// fungerer identisk godt til "giv mig adgang til en kommune der allerede
// findes" som til en frisk trial. Svarformen matcher BEVIDST /internal/
// api/create-trial's (samme tenant/loginUrl-felter), så klienten kan
// genbruge samme visnings-kode for begge.
app.post('/internal/api/tenants/:id/login-link', requireInternalAuth, express.json(), async (req, res) => {
  try {
    const days = Number(req.body?.days);
    const issuedBy = typeof req.body?.issuedBy === 'string' ? req.body.issuedBy.trim() : '';
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null;

    if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ error: 'Gyldighed skal være et positivt antal dage.' });
    if (!issuedBy) return res.status(400).json({ error: 'Dit navn mangler.' });

    const tenant = await tenantAdmin.getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Kommunen findes ikke.' });

    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    const rawToken = await tenantAdmin.issueTrialLogin({
      tenantId: tenant.id, expiresAt, issuedBy, note,
    });
    const loginUrl = `${seoPages.SITE_URL}/admin/trial/${rawToken}`;

    res.json({
      tenant: { id: tenant.id, name: tenant.name, trialExpiresAt: expiresAt },
      loginUrl,
    });
  } catch (e) {
    console.error('internal/api/tenants/:id/login-link: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke generere login-link lige nu.' });
  }
});

// NYT (bruger-ønske — dedikeret sales-portal): SAMME requireInternalAuth-
// gate (Basic Auth, INTERNAL_ADMIN_PASSWORD) som resten af /internal/*
// ovenfor — ingen ny adgangskontrol, kun en NY side der samler trial-
// oprettelse + login-til-eksisterende-kommune (begge allerede byggede
// ovenfor) med et NYT tredje kort: kommune-benchmark for ALLE kommuner,
// uden at kræve en tenant-session. internal-sales.html er en SEPARAT fil
// fra internal-create-trial.html (den forbliver uændret/virker stadig
// standalone) — undgår at ændre et allerede fungerende værktøj, mens det
// nye, bredere sales-flow bygges ved siden af.
app.get('/internal/sales', requireInternalAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(STATIC_DIR, 'internal-sales.html'));
});

// NYT — SAMME computeKommuneBenchmark()/periode-parsing som GET /admin/api/
// kommune-benchmark (se dens filhoved), men bag requireInternalAuth i
// stedet for tenantAdmin.requireTenantSession — sales er ikke logget ind
// som ÉN kommune, og skal netop kunne se ALLE på én gang (samme "fuld
// navngivet sammenligning"-beslutning som allerede gælder for kommunernes
// eget dashboard, se planens sikkerhedsnote for /admin/api/kommune-
// benchmark — denne rute deler samme egenskab: kun aggregerede tal, aldrig
// rå operationelle data).
app.get('/internal/api/kommune-benchmark', requireInternalAuth, async (req, res) => {
  try {
    let range;
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
        return res.status(400).json({ error: "Ugyldigt from/to-format, forventede 'YYYY-MM-DD'." });
      }
      range = { from: req.query.from, to: req.query.to };
    } else {
      const period = typeof req.query.period === 'string' ? req.query.period : '';
      if (!VALID_ALERT_PERIODS.has(period)) {
        return res.status(400).json({ error: `Ugyldig period — skal være én af: ${[...VALID_ALERT_PERIODS].join(', ')}, eller angiv ?from=&to=.` });
      }
      const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
      range = computeAlertStatsRange(period, monthParam);
      if (!range) return res.status(400).json({ error: "Ugyldigt month-format, forventede 'YYYY-MM'." });
    }

    const result = await computeKommuneBenchmark({ fromDate: range.from, toDate: range.to });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (e) {
    console.error('internal/api/kommune-benchmark: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke beregne kommune-benchmark lige nu.' });
  }
});

// Dashboard-placeholder — se admin-dashboard.html's filhoved. Tenant-data
// injiceres server-side (samme "%%TOKEN%%".replace()-princip som seo-
// pages.js's injectHead(), men lokalt her fremfor en delt hjælpefunktion,
// da dette er den ENESTE side der endnu har brug for det i dette modul).
app.get('/admin/dashboard', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).type('text/plain').send('Kommunen findes ikke længere — log ind igen.');
    }
    const tenantJson = JSON.stringify({
      name: tenant.name,
      status: tenant.status,
      trialExpiresAt: tenant.trial_expires_at,
      agreementSignedAt: tenant.agreement_signed_at,
      authMethod: req.tenant.authMethod,
    });
    const html = fs.readFileSync(path.join(STATIC_DIR, 'admin-dashboard.html'), 'utf8')
      .replace('%%TENANT_JSON%%', tenantJson);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('admin/dashboard: uventet fejl —', e.message);
    res.status(500).type('text/plain').send('Kunne ikke hente dashboard lige nu.');
  }
});

app.post('/admin/logout', (req, res) => {
  res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
  res.json({ ok: true });
});

// ── Kommunepakke, modul 2 — selvbetjent OAuth-konfigurationsflow ───────────
// Se planens "Vigtig afgrænsning i forhold til brief'ens ordlyd": dette er
// en INDSTILLINGSSIDE for en allerede-logget-ind (i dag udelukkende via
// trial) tenant, IKKE et offentligt signup-flow — samme princip som
// resten af /admin/*.
app.get('/admin/settings/oauth', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const config = await tenantAdmin.getOauthConfig(req.tenant.tenantId);
    // NYT (Kommunepakke, modul 3): redirectUri kan først vises nu selve
    // callback-ruten reelt findes — kommunen skal registrere DENNE præcise
    // URL som deres tilladte redirect_uri hos egen udbyder.
    const html = fs.readFileSync(path.join(STATIC_DIR, 'admin-oauth-setup.html'), 'utf8')
      .replace('%%OAUTH_CONFIG_JSON%%', JSON.stringify({ config, redirectUri: oauthLogin.CALLBACK_URL }));
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('admin/settings/oauth GET: uventet fejl —', e.message);
    res.status(500).type('text/plain').send('Kunne ikke hente OAuth-opsætning lige nu.');
  }
});

// NYT: rute-lokal express.json() — den GLOBALE express.json() (server.js
// længere nede) sidder EFTER disse /admin/*-ruter, og 1400+ linjers
// eksisterende ruter mellem de to punkter kan afhænge af den nuværende
// rækkefølge. En rute-lokal parser her er den korrekte, isolerede løsning
// (Express' eget understøttede mønster for netop dette), fremfor at flytte
// den globale middleware og risikere at ændre opførsel for ruter der intet
// har med Kommunepakken at gøre.
app.post('/admin/settings/oauth', tenantAdmin.requireTenantSession, express.json(), async (req, res) => {
  try {
    const { providerType, clientId, clientSecret, discoveryUrl, allowedEmailDomains: rawDomains } = req.body || {};

    if (!tenantAdmin.isValidProviderType(providerType)) {
      return res.status(400).json({ error: 'Vælg en gyldig OAuth-udbyder.', field: 'provider' });
    }
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      return res.status(400).json({ error: 'Client ID er påkrævet.', field: 'client-id' });
    }
    if (typeof discoveryUrl !== 'string' || discoveryUrl.trim().length === 0) {
      return res.status(400).json({ error: 'Discovery URL er påkrævet.', field: 'discovery-url' });
    }
    let allowedEmailDomains;
    try {
      allowedEmailDomains = tenantAdmin.normalizeEmailDomains(rawDomains);
    } catch (e) {
      return res.status(400).json({ error: e.message, field: 'domains' });
    }

    // RETTET (bruger-ønske): kun ÉT netværkskald til den bruger-angivne
    // discovery-URL sker HER, EFTER al format-/felt-validering ovenfor —
    // undgår at spilde et SSRF-sikkert (men stadig ikke-gratis) DNS-
    // opslag+HTTPS-kald på indlysende ugyldigt input.
    const verifyResult = await tenantAdmin.validateDiscoveryUrl(discoveryUrl.trim());

    // Gemmes UANSET om bekræftelsen lykkedes — brugeren skal ikke miste
    // sit indtastede arbejde pga. en midlertidigt utilgængelig discovery-
    // URL; verified_at forbliver blot null, og modul 3's OAuth-login vil
    // (når det findes) naturligt afvise indtil en efterfølgende, lykkedes
    // gemning sætter den.
    try {
      await tenantAdmin.upsertOauthConfig({
        tenantId: req.tenant.tenantId,
        providerType,
        clientId: clientId.trim(),
        clientSecret: typeof clientSecret === 'string' ? clientSecret : '',
        discoveryUrl: discoveryUrl.trim(),
        allowedEmailDomains,
        verified: verifyResult.ok,
      });
    } catch (e) {
      if (e.code === 'SECRET_REQUIRED') {
        return res.status(400).json({ error: e.message, field: 'client-secret' });
      }
      throw e;
    }

    const config = await tenantAdmin.getOauthConfig(req.tenant.tenantId);
    res.json({
      ok: true,
      config,
      verified: verifyResult.ok,
      verifyReason: verifyResult.ok ? undefined : verifyResult.reason,
    });
  } catch (e) {
    console.error('admin/settings/oauth POST: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke gemme OAuth-opsætning lige nu.' });
  }
});

// ── Kommunepakke, modul 3 — dynamisk OAuth-login ────────────────────────────
// Se oauth-login.js's filhoved for selve flowet (autorisationskode+PKCE,
// standard OIDC). Ingen requireTenantSession her — det er JO netop det,
// brugeren er ved at opnå.
app.get('/admin/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(STATIC_DIR, 'admin-login.html'));
});

// NYT: rute-lokal express.urlencoded() — admin-login.html bruger en
// ALMINDELIG HTML-formular-POST (ikke fetch/JSON, se dens filhoved for
// hvorfor), browseren sender derfor application/x-www-form-urlencoded,
// IKKE JSON. Samme "rute-lokal, ikke global"-begrundelse som
// POST /admin/settings/oauths express.json() ovenfor.
app.post('/admin/login', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const atIdx = email.lastIndexOf('@');
    if (atIdx < 0 || atIdx === email.length - 1) {
      return res.redirect('/admin/login?error=' + encodeURIComponent('Angiv en gyldig e-mailadresse.'));
    }
    const domain = email.slice(atIdx + 1).toLowerCase();

    // Bevidst GENERISK fejlbesked ved intet match — samme "afslør ikke
    // præcis hvorfor"-princip som trial-loginets fejlbesked (se
    // GET /admin/trial/:token) — ikke et forsøg på hemmeligholdelse af
    // hvilke kommuner der bruger platformen (lav-stakes B2G-kontekst,
    // ikke en hemmelighed i sig selv), men almindelig hygiejne mod
    // automatiseret afprøvning af domænelisten.
    const providerConfig = await tenantAdmin.findTenantOauthConfigByEmailDomain(domain);
    if (!providerConfig) {
      return res.redirect('/admin/login?error=' + encodeURIComponent('Kunne ikke finde en kommune tilknyttet denne e-mailadresse.'));
    }

    let redirectUrl, stateCookieValue;
    try {
      ({ redirectUrl, stateCookieValue } = await oauthLogin.buildAuthorizationRedirect({
        tenantId: providerConfig.tenantId,
        clientId: providerConfig.clientId,
        discoveryUrl: providerConfig.discoveryUrl,
      }));
    } catch (e) {
      console.error('admin/login: kunne ikke bygge autorisations-URL —', e.message);
      return res.redirect('/admin/login?error=' + encodeURIComponent(e.message));
    }

    res.set('Set-Cookie', oauthLogin.buildOauthStateSetCookieHeader(stateCookieValue));
    res.redirect(redirectUrl.href);
  } catch (e) {
    console.error('admin/login POST: uventet fejl —', e.message);
    res.redirect('/admin/login?error=' + encodeURIComponent('Der opstod en uventet fejl — prøv igen.'));
  }
});

app.get(oauthLogin.CALLBACK_PATH, async (req, res) => {
  try {
    const cookies = tenantAdmin.parseCookies(req.headers.cookie);
    const stateCookieValue = cookies[oauthLogin.OAUTH_STATE_COOKIE_NAME];
    // NYT: currentUrl bygges fra seoPages.SITE_URL (fast, kendt korrekt —
    // samme kilde som resten af appens absolutte URL'er) + req.originalUrl,
    // IKKE fra req.protocol/req.get('host') — undgår enhver tvivl om
    // hvorvidt Fly's proxy-headere (X-Forwarded-*) er korrekt tillid-
    // svækkede her; fly.toml's force_https garanterer allerede at eksterne
    // requests ankommer som https.
    const currentUrl = new URL(seoPages.SITE_URL + req.originalUrl);

    const { tenantId, email } = await oauthLogin.handleCallback({ stateCookieValue, currentUrl });
    // RETTET: rydning af state-cookien og udstedelse af den nye sessions-
    // cookie skal ske i SAMME Set-Cookie-header — res.set() OVERSKRIVER
    // (ikke tilføjer til) en tidligere sat Set-Cookie-header, et separat
    // clearStateCookie()-kald HER ville derfor blot være blevet overskrevet
    // igen af linjen nedenfor og aldrig reelt sendt til klienten.
    // NYT (Kommunepakke, modul 6): email lægges nu med i sessionen (allerede
    // valideret/autentificeret af oauth-login.js's handleCallback() ovenfor)
    // — bruges bl.a. til at registrere HVEM der satte en overstyring, se
    // badested-overrides.js.
    const sessionCookie = tenantAdmin.signSession({ tenantId, authMethod: 'oauth', email });
    res.set('Set-Cookie', [oauthLogin.buildClearOauthStateSetCookieHeader(), tenantAdmin.buildSessionSetCookieHeader(sessionCookie)]);
    console.info(`admin/oauth/callback: login lykkedes for ${email.replace(/^(.).*(@.*)$/, '$1***$2')} (tenant=${tenantId})`);
    res.redirect('/admin/dashboard');
  } catch (e) {
    res.set('Set-Cookie', oauthLogin.buildClearOauthStateSetCookieHeader());
    // e.message er ALTID bruger-sikker her — se oauth-login.js's
    // handleCallback(), hver kastet fejl har eksplicit en formuleret,
    // ikke-lækkende besked. e.cause (hvis sat) logges server-side for
    // egen fejlfinding, aldrig videre til klienten.
    console.error(`admin/oauth/callback: fejlede (${e.code || 'UKENDT'}) —`, e.message, e.cause ? `— cause: ${e.cause.message}` : '');
    res.redirect('/admin/login?error=' + encodeURIComponent(e.message || 'Login mislykkedes — prøv igen.'));
  }
});

// ── Kommunepakke, modul 4 — månedlig badevandshistorik ──────────────────────
// Se app-metrics.js's getMonthlyRiskBuckets() og tenant-badesteder.js's
// resolveTenantBadesteder() for selve beregningen/mappingen.
app.get('/admin/api/badested-history', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
    if (monthParam && !/^\d{4}-\d{2}$/.test(monthParam)) {
      return res.status(400).json({ error: "Ugyldigt month-format, forventede 'YYYY-MM'." });
    }
    const month = monthParam || new Date().toISOString().slice(0, 7); // default: indeværende UTC-måned

    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }

    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    if (badesteder.length === 0) {
      // NYT: IKKE en fejl (401/500) — en tenant med reelt 0 badesteder
      // (eller et tastefejlsramt tenants.name, se planens "Bevidst uden
      // for scope") skal se en klar, handlingsanvisende besked, ikke et
      // crash. Logges også server-side, så et tastefejlsramt navn er let
      // at diagnosticere fra driftssiden.
      console.warn(`admin/api/badested-history: intet badested-match for tenant.name="${tenant.name}" (tenant=${req.tenant.tenantId})`);
      return res.json({ month, badesteder: [], warning: `Ingen badesteder fundet for "${tenant.name}" — kontakt support hvis dette er forkert.` });
    }

    const buckets = await appMetrics.getMonthlyRiskBuckets(badesteder.map(b => b.id), month);
    const result = badesteder.map(b => ({ id: b.id, slug: b.slug, navn: b.navn, ...buckets.get(String(b.id)) }));
    res.set('Cache-Control', 'no-store');
    res.json({ month, badesteder: result });
  } catch (e) {
    console.error('admin/api/badested-history: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente badevandshistorik lige nu.' });
  }
});

// ── Kommunepakke, modul 6 — overstyringsknap ────────────────────────────────
// Se badested-overrides.js's filhoved for den fulde begrundelse/HÅRD GRÆNSE-
// afgrænsning. Alle tre ruter er tenant-scoped: en tenant kan UDELUKKENDE
// overstyre badesteder tenant-badesteder.resolveTenantBadesteder() rapporterer
// som deres egne (samme ejerskabs-tjek som modul 4's historik).
app.post('/admin/api/override', tenantAdmin.requireTenantSession, express.json(), async (req, res) => {
  try {
    const { badestedId, bucket, message, durationHours } = req.body || {};
    if (typeof badestedId !== 'string' || !badestedId) {
      return res.status(400).json({ error: 'badestedId er påkrævet.' });
    }
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const owned = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    const target = owned.find(b => String(b.id) === String(badestedId));
    if (!target) {
      return res.status(403).json({ error: 'Dette badested tilhører ikke jeres kommune.' });
    }

    let overrideRow;
    try {
      overrideRow = await badestedOverrides.createOverride({
        badestedId, tenantId: req.tenant.tenantId, bucket, message,
        setBy: req.tenant.email || req.tenant.authMethod, durationHours,
      });
    } catch (e) {
      if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
      throw e;
    }

    // NYT (badested-statistik): ÉT varsel talt her — pr. UDSENDT Kommunalt
    // Varsel, ALDRIG pr. abonnent (se GET /admin/api/badested-alert-stats).
    // Tælles uafhængigt af pushSent nedenfor, som er antal ABONNENTER,
    // en helt anden metrik.
    await appMetrics.recordBadestedAlertSent(badestedId, PUSH_SEND_TYPES.KOMMUNE_OVERRIDE, Date.now());

    // Patcher den ALLEREDE LIVE cache med det samme — se
    // applyLiveOverridesToCache()'s egen begrundelse ("under 10 sekunder").
    await applyLiveOverridesToCache();

    // NYT: udsender webpush til badestedets abonnenter — AWAITER
    // flushPushQueue() (IKKE fire-and-forget som broadcastFirstVurderingOfDay()
    // ovenfor) — "under 10 sekunder"-kravet betyder svaret skal kunne
    // bekræfte reel afsendelse, ikke blot antage den lykkedes.
    let pushSent = 0;
    if (VAPID_PUBLIC_KEY) {
      const matches = await getSubscriptionsForBadested(badestedId);
      if (matches.length > 0) {
        const now = Date.now();
        await Promise.all(matches.map(({ endpoint, group }) => query(`
          INSERT INTO push_send_queue (endpoint, type, payload, hit_stamps, enqueued_at)
          VALUES ($1, $2, $3, '[]'::jsonb, $4)
        `, [
          endpoint,
          PUSH_SEND_TYPES.KOMMUNE_OVERRIDE,
          JSON.stringify({
            title: `⚠️ ${tenant.name}: ${target.navn}`,
            body: message,
            tag: `override-${badestedId}-${overrideRow.id}`,
            url: (group.lat != null && group.lng != null) ? `/#badevand=${group.lat}:${group.lng}` : '/',
          }),
          now,
        ])));
        await flushPushQueue();
        pushSent = matches.length;
      }
      console.info(`admin/api/override: ${bucket} sat for ${badestedId} (tenant=${req.tenant.tenantId}), ${pushSent} abonnent(er) varslet`);
    }

    res.json({ ok: true, expiresAt: overrideRow.expires_at, pushSent });
  } catch (e) {
    console.error('admin/api/override POST: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke oprette overstyring lige nu.' });
  }
});

app.post('/admin/api/override/:badestedId/clear', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const { badestedId } = req.params;
    // revokeOverride() tjekker SELV tenant_id i sin WHERE-klausul (se dens
    // filhoved) — en tenant kan derfor aldrig rydde en anden tenants
    // overstyring, selv ved en fremtidig fejl i et tidligere ejerskabs-tjek.
    const revoked = await badestedOverrides.revokeOverride({ badestedId, tenantId: req.tenant.tenantId });
    if (!revoked) {
      return res.status(404).json({ error: 'Ingen aktiv overstyring fundet for dette badested.' });
    }
    await applyLiveOverridesToCache();
    res.json({ ok: true });
  } catch (e) {
    console.error('admin/api/override/:badestedId/clear POST: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke rydde overstyringen lige nu.' });
  }
});

app.get('/admin/api/overrides', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const overrides = await badestedOverrides.listActiveOverridesForTenant(req.tenant.tenantId);
    res.set('Cache-Control', 'no-store');
    res.json({ overrides });
  } catch (e) {
    console.error('admin/api/overrides GET: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente overstyringer lige nu.' });
  }
});

// ── Kommunepakke, modul 6 — badested-statistik (varsler + abonnenter) ──────
const VALID_ALERT_PERIODS = new Set(['today', '7d', 'month', 'quarter', 'year']);

/**
 * Oversætter en periode-forespørgsel til et INKLUSIVT ['YYYY-MM-DD', 'YYYY-MM-DD']-
 * interval til appMetrics.getAlertCountsForBadestedIds(). 'month' er den
 * ENESTE kalender-forankrede periode — kan pege på EN HVILKEN SOM HELST
 * måned (også uden data, også fremtidige), samme frie måned-vælger-mønster
 * som GET /admin/api/badested-history's egen month-parameter. De øvrige
 * ('7d'/'quarter'/'year') er bevidst RULLENDE vinduer endende i dag, ikke
 * kalenderafgrænsede — samme "sidste N dage"-princip som '7d' allerede
 * antyder i sit eget navn.
 * @returns {{from: string, to: string}|null} null ved ugyldigt month-format
 */
function computeAlertStatsRange(period, monthParam) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysAgo = n => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (period === 'today')   return { from: todayStr, to: todayStr };
  if (period === '7d')      return { from: daysAgo(6), to: todayStr };
  if (period === 'quarter') return { from: daysAgo(89), to: todayStr };
  if (period === 'year')    return { from: daysAgo(364), to: todayStr };
  // period === 'month'
  const month = monthParam || todayStr.slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = parseInt(m[1], 10), monthIdx = parseInt(m[2], 10) - 1;
  return {
    from: new Date(Date.UTC(year, monthIdx, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, monthIdx + 1, 0)).toISOString().slice(0, 10), // månedens sidste dag
  };
}

app.get('/admin/api/badested-alert-stats', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const period = typeof req.query.period === 'string' ? req.query.period : '';
    if (!VALID_ALERT_PERIODS.has(period)) {
      return res.status(400).json({ error: `Ugyldig period — skal være én af: ${[...VALID_ALERT_PERIODS].join(', ')}.` });
    }
    const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
    const range = computeAlertStatsRange(period, monthParam);
    if (!range) {
      return res.status(400).json({ error: "Ugyldigt month-format, forventede 'YYYY-MM'." });
    }

    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    if (badesteder.length === 0) {
      return res.json({ period, from: range.from, to: range.to, badesteder: [], warning: `Ingen badesteder fundet for "${tenant.name}" — kontakt support hvis dette er forkert.` });
    }

    const ids = badesteder.map(b => b.id);
    const [alertCounts, subscriberCounts] = await Promise.all([
      appMetrics.getAlertCountsForBadestedIds(ids, range.from, range.to),
      getSubscriberCountsForBadestedIds(ids),
    ]);
    const result = badesteder.map(b => ({
      id: b.id, slug: b.slug, navn: b.navn,
      alertCount: alertCounts.get(String(b.id)) || 0,
      subscriberCount: subscriberCounts.get(String(b.id)) || 0,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ period, from: range.from, to: range.to, badesteder: result });
  } catch (e) {
    console.error('admin/api/badested-alert-stats: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente badested-statistik lige nu.' });
  }
});

// ── Kommunepakke, modul 7 — kommune-scopet udgave af /stats ────────────────
// Bruger-krav: "alle statistik elementer fra /stats skal kopieres til
// Kommunal Dashboard og alle nøgletal skal beregnes for den pågældende
// kommune". Kun DE elementer, der faktisk KAN kommune-scopes, er med her —
// /stats' installations-/platform-tal har INGEN lokations-tilknytning i det
// hele taget (app_installs har ingen badested/kommune-kolonne), så de kan
// ikke ærligt genberegnes pr. kommune uden ny instrumentering, og er derfor
// bevidst UDELADT her (i stedet for en misvisende 0/nationalt tal). Samme
// tre-trins mønster (getTenant → resolveTenantBadesteder → scopet
// forespørgsel) som GET /admin/api/badested-alert-stats og GET /admin/api/
// badested-history ovenfor.
app.get('/admin/api/stats', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    if (badesteder.length === 0) {
      return res.json({ badesteder: [], warning: `Ingen badesteder fundet for "${tenant.name}" — kontakt support hvis dette er forkert.` });
    }
    const ids = badesteder.map(b => b.id);

    const [vurderinger, subscriberCounts, alertRows, vurderingTrendRows] = await Promise.all([
      badestedObs.getVurderingStatsForBadestedIds(ids),
      getSubscriberCountsForBadestedIds(ids),
      appMetrics.getAlertRowsForBadestedIds(ids),
      badestedObs.getVurderingTrendForBadestedIds(ids, 90),
    ]);

    const subscribers = [...subscriberCounts.values()].reduce((a, b) => a + b, 0);

    // RETTET: /stats' "24t"-kolonne er en RULLENDE 24-timers-vindue (fra
    // push_send_log's tidsstemplede rækker) — badested_alert_daily har KUN
    // dags-granularitet (ingen klokkeslæt), så det bedste ærlige modstykke
    // her er "i dag" (UTC-kalenderdato), ikke et sandt 24t-vindue. Klientens
    // kolonneoverskrift siger derfor "I dag", ikke "24t", bevidst forskelligt
    // fra /stats' egen tabel.
    const todayStr        = new Date().toISOString().slice(0, 10);
    const sevenDaysAgoStr = new Date(Date.now() - 6  * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const ninetyDaysAgoStr= new Date(Date.now() - 89 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // Kun de tre typer, der reelt registreres pr. badested (se recordBadested
    // AlertSent()'s kaldesteder) — heartbeat/ugentlig-digest findes kun som
    // globale tal (push_send_log), ikke pr. badested, og udelades derfor her
    // i stedet for at vise et falsk 0.
    const TRACKED_TYPES = [PUSH_SEND_TYPES.RISIKOVARSEL, PUSH_SEND_TYPES.NY_VURDERING, PUSH_SEND_TYPES.KOMMUNE_OVERRIDE];
    const byType = {};
    for (const t of TRACKED_TYPES) byType[t] = { today: 0, last7d: 0, total: 0 };
    const risikovarselByDate = new Map();
    for (const row of alertRows) {
      const bucket = byType[row.type];
      if (!bucket) continue;
      bucket.total += row.count;
      if (row.date >= sevenDaysAgoStr) bucket.last7d += row.count;
      if (row.date === todayStr) bucket.today += row.count;
      if (row.type === PUSH_SEND_TYPES.RISIKOVARSEL && row.date >= ninetyDaysAgoStr) {
        risikovarselByDate.set(row.date, (risikovarselByDate.get(row.date) || 0) + row.count);
      }
    }
    const risikovarselTrend = [...risikovarselByDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, n]) => ({ date, value: n }));

    res.set('Cache-Control', 'no-store');
    res.json({
      badestedCount: badesteder.length,
      vurderinger,
      subscribers,
      pushByType: byType,
      trends: {
        vurderinger: vurderingTrendRows.map(r => ({ date: r.date, value: r.n })),
        risikovarsel: risikovarselTrend,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('admin/api/stats: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente statistik lige nu.' });
  }
});

// ── Kommunepakke, modul 8 — læsning af borgerindsendte badestedsvurderinger ──
// Bruger-ønske (2026-08-18): "kommunerne [skal] kunne læse de enkelte
// badevandsvurderinger indsendt af borgerne. De skal ikke kunne rette dem,
// blot læse dem. Især er det vigtigt med rapporter for alger og affald - da
// det måske kræver at kommunen besigtiger stedet." Derfor KUN denne ene
// GET-rute — ingen PUT/DELETE tilføjes, se badested-observations.js's
// filhoved for hvorfor borgerobservationer aldrig må kunne rettes af nogen,
// heller ikke af kommunen selv. Samme tre-trins mønster (getTenant →
// resolveTenantBadesteder → scopet forespørgsel) som GET /admin/api/stats
// ovenfor.
app.get('/admin/api/vurderinger', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    if (badesteder.length === 0) {
      return res.json({ vurderinger: [] });
    }
    const navnById = new Map(badesteder.map(b => [String(b.id), b.navn]));
    const slugById = new Map(badesteder.map(b => [String(b.id), b.slug]));
    const rows = await badestedObs.getVurderingListForBadestedIds(badesteder.map(b => b.id), { limit: 300 });
    const vurderinger = rows.map(r => ({
      id: r.id,
      badestedId: r.badested_id,
      badestedNavn: navnById.get(String(r.badested_id)) || r.badested_id,
      badestedSlug: slugById.get(String(r.badested_id)) || null,
      createdAt: Number(r.created_at),
      types: r.types || [],
      algaeLevel: r.algae_level || null,
      photoUrl: r.photo_path || null,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ vurderinger });
  } catch (e) {
    console.error('admin/api/vurderinger: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente borgerindsendte vurderinger lige nu.' });
  }
});

// ── Kommunepakke, modul 9 — "Overløb"-fanen (bruger-ønske 2026-08-19) ───────
// Live kort + varselsliste for kommunens EGNE overløb (samtlige PULS-
// punkter, kloak+regnvand — ikke kun dem koblet til et badested) plus
// badestedernes aktuelle status. Al kommune-scoping/bucketing sker i
// overloeb-status.js (ren funktion, se dens filhoved) — denne rute læser
// udelukkende de allerede cachede riskScoresCache/badevandRiskCache, ingen
// live-genberegning pr. request, samme cache-filosofi som resten af appen.
const OVERLOEB_HORIZONS = new Set(['nu', '24h', '72h']);
app.get('/admin/api/overloeb-status', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const horizon = OVERLOEB_HORIZONS.has(req.query.horizon) ? req.query.horizon : 'nu';
    const tenantBadestederList = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    // NYT (bruger-krav 2026-08-20 — "antal webpush abonnenter for det
    // pågældende badested" i badested-detaljepanelet): computeOverloebStatusForTenant()
    // er bevidst en ren, DB-fri funktion (se dens filhoved) — abonnenttallet
    // hentes derfor HER (ét samlet DB-opslag for ALLE tenantens badesteder,
    // samme genbrugte funktion som /admin/api/badested-alert-stats allerede
    // bruger) og gives ind som ren data, ligesom riskScoresPoints/badevandList.
    const subscriberCounts = await getSubscriberCountsForBadestedIds(tenantBadestederList.map(b => b.id));
    const result = overloebStatus.computeOverloebStatusForTenant({
      tenant,
      horizon,
      riskScoresPoints: riskScoresCache.points,
      badevandList: badevandRiskCache.badevand,
      tenantBadesteder: tenantBadestederList,
      subscriberCounts,
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (e) {
    console.error('admin/api/overloeb-status: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente overløbsstatus lige nu.' });
  }
});

// NYT — se broadcastOverloebUpdate()'s filhoved (module-scope, tæt på
// riskScoresCache/badevandRiskCache) for hvorfor Server-Sent Events blev
// valgt frem for en WebSocket-pakke. requireTenantSession virker uændret
// her, fordi EventSource sender den eksisterende session-cookie automatisk
// for samme origin, ganske som en almindelig fetch() ville.
app.get('/admin/api/overloeb-stream', tenantAdmin.requireTenantSession, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // undgår proxy-buffering af SSE-strømmen
  });
  res.write(': forbundet\n\n');
  overloebStreamClients.add(res);
  // NYT: ~30s kommentar-heartbeat — forhindrer at Fly.io's proxy (eller en
  // browser/mellemled) lukker forbindelsen som "idle" mellem de 15-minutters
  // rigtige opdateringer.
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); }
    catch (e) { /* fanges af 'close' nedenfor */ }
  }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    overloebStreamClients.delete(res);
  });
});

// ── Overløb-fanen: hændelseslog-baseret historik (bruger-ønske 2026-08-19,
// opfølgning på "gemmer vi varsler pr. udløb med timestamp") ───────────────
// Fast 90-dages rullende vindue — samme konvention som den eksisterende
// Badestedsvurderinger-graf (badestedObs.getVurderingTrendForBadestedIds(ids,
// 90)) — INGEN periodevælger her, kun til den prioriterede liste nedenfor.
app.get('/admin/api/overloeb-varsler-historik', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const municipalityKey = slugIndex.normalizeKommuneKey(tenant.name);
    const toMs = Date.now();
    const fromMs = toMs - 90 * 24 * 3600 * 1000;
    const trend = await overloebEvents.getVarselTrendForMunicipality({ municipalityKey, fromMs, toMs });
    res.set('Cache-Control', 'no-store');
    res.json({ trend });
  } catch (e) {
    console.error('admin/api/overloeb-varsler-historik: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente overløbshistorik lige nu.' });
  }
});

// NYT — den prioriterede liste: "flest varsler" ELLER (togglebart) "størst
// estimeret akkumuleret udledning". estimeretLiterTotal beregnes HER, IKKE
// gemt pr. hændelse (se overloeb-events.js's filhoved) — ganger antal
// gul/rød-episoder i perioden med punktets `meanVolumePerEvent` (m³,
// risk-model.js's derivePulsFields(), ×1000 for liter), slået op i den
// allerede-i-hukommelsen riskScoresCache (samme kilde Overløb-kortet selv
// bruger), ikke et nyt DB-opslag.
const OVERLOEB_PRIORITERET_SORT_KEYS = new Set(['varsler', 'udledning']);
app.get('/admin/api/overloeb-prioriteret', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const period = typeof req.query.period === 'string' ? req.query.period : '';
    if (!VALID_ALERT_PERIODS.has(period)) {
      return res.status(400).json({ error: `Ugyldig period — skal være én af: ${[...VALID_ALERT_PERIODS].join(', ')}.` });
    }
    const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
    const range = computeAlertStatsRange(period, monthParam);
    if (!range) {
      return res.status(400).json({ error: "Ugyldigt month-format, forventede 'YYYY-MM'." });
    }
    const sortBy = OVERLOEB_PRIORITERET_SORT_KEYS.has(req.query.sortBy) ? req.query.sortBy : 'varsler';

    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const municipalityKey = slugIndex.normalizeKommuneKey(tenant.name);
    const fromMs = new Date(range.from + 'T00:00:00.000Z').getTime();
    const toMs   = new Date(range.to   + 'T23:59:59.999Z').getTime();
    const counts = await overloebEvents.getVarselCountsByPoint({ municipalityKey, fromMs, toMs });

    const pointById = new Map(riskScoresCache.points.map(p => [String(p.id), p]));
    let liste = counts.map(c => {
      const pt = pointById.get(String(c.pointId));
      return {
        id: c.pointId,
        navn: pt?.name || c.pointId,
        isWastewater: pt?.isWastewater ?? null,
        varslerTotal: c.total,
        varslerGul: c.gul,
        varslerRoed: c.roed,
        estimeretLiterTotal: pt?.meanVolumePerEvent != null ? Math.round(c.total * pt.meanVolumePerEvent * 1000) : null,
      };
    });
    liste.sort((a, b) => sortBy === 'udledning'
      ? (b.estimeretLiterTotal ?? -1) - (a.estimeretLiterTotal ?? -1)
      : b.varslerTotal - a.varslerTotal);
    liste = liste.slice(0, 20);

    res.set('Cache-Control', 'no-store');
    res.json({ period, from: range.from, to: range.to, sortBy, liste });
  } catch (e) {
    console.error('admin/api/overloeb-prioriteret: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente prioriteret overløbsliste lige nu.' });
  }
});

// ── Overløb-fanen: kommune-scopet RBU Regn/Kloak (bruger-ønske 2026-08-19,
// opfølgning: "Samme mulighed for at vælge regn og kloak RBUer") ───────────
// vp3_rbu_slim.geojson er 5,6 MB / 21.375 landsdækkende punkter — hovedkortet
// (dansk-overloeb-kort.html) henter og filtrerer den FULDE fil client-side,
// acceptabelt for en borger der alligevel henter hele kortet, men urimeligt
// for et kommune-scopet dashboard der kun skal vise en brøkdel. Filtreres
// derfor HER, server-side, via features' egen `komm_navn`-egenskab (samme
// felt hovedkortets RBU-tooltip allerede viser) — klienten modtager kun sin
// egen kommunes punkter. Samme wastewater-klassificering (bgv_type) som
// hovedkortets isRbuWastewater().
const RBU_WASTEWATER_TYPES = new Set(['OS', 'OV', 'OF', 'OVI', 'OSI', 'OK', 'OKI']);
let _rbuFeaturesCache = null;
function loadRbuFeatures() {
  if (_rbuFeaturesCache) return _rbuFeaturesCache;
  const raw = fs.readFileSync(path.join(STATIC_DIR, 'vp3_rbu_slim.geojson'), 'utf8');
  const geojson = JSON.parse(raw);
  _rbuFeaturesCache = geojson.features || [];
  return _rbuFeaturesCache;
}

app.get('/admin/api/overloeb-rbu', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const tenantKey = slugIndex.normalizeKommuneKey(tenant.name);
    const features = loadRbuFeatures();
    const rbu = [];
    for (const f of features) {
      const p = f.properties || {};
      if (!p.komm_navn || slugIndex.normalizeKommuneKey(p.komm_navn) !== tenantKey) continue;
      const coords = f.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      rbu.push({
        id: p.pkt_id ?? null,
        navn: p.pkt_navn || null,
        lat: coords[1], lng: coords[0],
        isWastewater: RBU_WASTEWATER_TYPES.has(p.bgv_type),
        vandomraade: p.vandomr_id || null,
        tilstand: p.udl_va_sta || null,
      });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ rbu });
  } catch (e) {
    console.error('admin/api/overloeb-rbu: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente RBU-punkter lige nu.' });
  }
});

// ── Overløb-fanen: iframe-indlejring (bruger-ønske 2026-08-19) ─────────────
// Se tenant-admin.js's tenant_embed_tokens-kommentar for hele token-
// designbegrundelsen (revokabel DB-token, ikke en stateless HMAC-signeret
// en). De to genererings-/administrations-ruter herunder KRÆVER fortsat en
// gyldig dashboard-session — kun selve embed-SIDEN og dens to API-ruter
// nedenfor er token-autentificerede i stedet for cookie-autentificerede.
app.post('/admin/api/overloeb-embed-token', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const token = await tenantAdmin.issueEmbedToken({ tenantId: req.tenant.tenantId });
    // NYT: bygget fra seoPages.SITE_URL (fast, kendt korrekt), IKKE fra
    // req.protocol/req.get('host') — samme begrundelse som oauth-login-
    // callbackens currentUrl ovenfor: 'trust proxy' er bevidst ikke sat i
    // denne fil, så req.protocol ville rapportere Fly-proxyens interne
    // http, ikke den offentlige https.
    const embedUrl = `${seoPages.SITE_URL}/admin/overloeb-embed?token=${encodeURIComponent(token)}`;
    res.json({ token, embedUrl });
  } catch (e) {
    console.error('admin/api/overloeb-embed-token: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke generere indlejrings-link lige nu.' });
  }
});

app.post('/admin/api/overloeb-embed-token/revoke-all', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    await tenantAdmin.revokeEmbedTokensForTenant(req.tenant.tenantId);
    res.json({ ok: true });
  } catch (e) {
    console.error('admin/api/overloeb-embed-token/revoke-all: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke tilbagekalde indlejrings-links lige nu.' });
  }
});

// NYT: IKKE requireTenantSession — en iframe på en ekstern (kommunens egen)
// hjemmeside har ingen adgang til dashboardets sessions-cookie (og bør
// heller ikke have, se tredjeparts-cookie-begrundelsen i planen). Validerer
// i stedet ?token= via tenantAdmin.verifyEmbedToken().
app.get('/admin/overloeb-embed', async (req, res) => {
  try {
    const tenant = await tenantAdmin.verifyEmbedToken(typeof req.query.token === 'string' ? req.query.token : '');
    if (!tenant) {
      return res.status(403).type('text/plain').send('Ugyldigt eller tilbagekaldt indlejrings-link.');
    }
    const embedJson = JSON.stringify({ tenantName: tenant.tenantName, token: req.query.token });
    const html = fs.readFileSync(path.join(STATIC_DIR, 'overloeb-embed.html'), 'utf8')
      .replace('%%EMBED_JSON%%', embedJson);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('admin/overloeb-embed: uventet fejl —', e.message);
    res.status(500).type('text/plain').send('Kunne ikke hente det indlejrede kort lige nu.');
  }
});

app.get('/admin/api/overloeb-status-embed', async (req, res) => {
  try {
    const tenant = await tenantAdmin.verifyEmbedToken(typeof req.query.token === 'string' ? req.query.token : '');
    if (!tenant) {
      return res.status(403).json({ error: 'Ugyldigt eller tilbagekaldt indlejrings-link.' });
    }
    const horizon = OVERLOEB_HORIZONS.has(req.query.horizon) ? req.query.horizon : 'nu';
    const tenantBadestederList = tenantBadesteder.resolveTenantBadesteder(tenant.tenantName, kommuneKeyToBadesteder);
    const result = overloebStatus.computeOverloebStatusForTenant({
      tenant: { name: tenant.tenantName },
      horizon,
      riskScoresPoints: riskScoresCache.points,
      badevandList: badevandRiskCache.badevand,
      tenantBadesteder: tenantBadestederList,
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (e) {
    console.error('admin/api/overloeb-status-embed: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente overløbsstatus lige nu.' });
  }
});

app.get('/admin/api/overloeb-stream-embed', async (req, res) => {
  const tenant = await tenantAdmin.verifyEmbedToken(typeof req.query.token === 'string' ? req.query.token : '');
  if (!tenant) {
    return res.status(403).json({ error: 'Ugyldigt eller tilbagekaldt indlejrings-link.' });
  }
  // NYT: deler PRÆCIS samme overloebStreamClients-Set/broadcastOverloebUpdate()
  // som den cookie-autentificerede /admin/api/overloeb-stream ovenfor —
  // pingen er content-fri, så embed- og dashboard-klienter er ikke til at
  // skelne fra hinanden på selve broadcast-siden, kun i hvordan de
  // efterfølgende genhenter deres egen (identisk scopede) status.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': forbundet\n\n');
  overloebStreamClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); }
    catch (e) { /* fanges af 'close' nedenfor */ }
  }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    overloebStreamClients.delete(res);
  });
});

// ── Kommune Dashboard, "Skilte"-fanen (bruger-ønske 2026-08-19) ────────────
// Tre undermuligheder: (1) samlet, flersidet PDF med QR + kommune-logo,
// (2) rene QR-EPS-vektorfiler pr. badested til professionelt tryk, (3) et
// live, offentligt digitalt skilt pr. badested (se GET /skilt/:slug og
// GET /api/badevand-risk-stream længere nede — INGEN auth, badevands-status
// er allerede offentlig). Se skilte.js/logo-fetch.js for selve genererings-
// logikken — disse ruter binder blot tenant-scoping + HTTP sammen.
app.get('/admin/api/skilte/badesteder', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder)
      .map(b => ({ id: b.id, slug: b.slug, navn: b.navn }));
    res.set('Cache-Control', 'no-store');
    res.json({ badesteder });
  } catch (e) {
    console.error('admin/api/skilte/badesteder: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente badesteder lige nu.' });
  }
});

// NYT — ÉN samlet, flersidet PDF (ét A4-skilt pr. badested), IKKE en ZIP
// med individuelle filer — undgår en tredje ny afhængighed (ZIP-bibliotek),
// og "download alle" er præcis hvad bruger-ønsket beder om. Henter
// kommune-logoet ÉN gang (ikke pr. side); logo_url er SSRF-sikret hentet
// via logo-fetch.js — fejler den (utilgængelig/ugyldig/for stor), streames
// PDF'en stadig, blot uden logo (se skilte.js's drawSignPage()).
app.get('/admin/api/skilte/pdf', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    if (badesteder.length === 0) {
      return res.status(404).json({ error: `Ingen badesteder fundet for "${tenant.name}".` });
    }

    let logoBuffer = null;
    if (tenant.logo_url) {
      const logoResult = await logoFetch.fetchTenantLogo(tenant.logo_url);
      if (logoResult.ok) logoBuffer = logoResult.buffer;
    }

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="badevands-skilte-${slugIndex.slugify(tenant.name)}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    doc.on('error', e => console.error('admin/api/skilte/pdf: pdfkit-fejl —', e.message));
    doc.pipe(res);
    for (const b of badesteder) {
      doc.addPage();
      const url = `${seoPages.SITE_URL}/badested/${b.slug}`;
      const qrMatrix = skilte.buildQrMatrix(url);
      skilte.drawSignPage(doc, { navn: b.navn, url, qrMatrix, logoBuffer });
    }
    doc.end();
  } catch (e) {
    console.error('admin/api/skilte/pdf: uventet fejl —', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Kunne ikke generere PDF-skilte lige nu.' });
  }
});

// NYT — bevidst PR.-BADESTED, ikke en bulk-ZIP: brugeren bad specifikt om
// at kunne vælge "præcis de skilte de selv ønsker" til professionelt tryk.
// Ejerskabstjek (badestedId skal høre til tenantens egen liste) — samme
// mønster som andre kommune-scopede ruter, forhindrer enumerering på tværs
// af kommuner selvom selve QR-indholdet ikke er hemmeligt.
app.get('/admin/api/skilte/qr-eps/:badestedId', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    const tenant = await tenantAdmin.getTenant(req.tenant.tenantId);
    if (!tenant) {
      res.set('Set-Cookie', tenantAdmin.buildClearSessionSetCookieHeader());
      return res.status(401).json({ error: 'Kommunen findes ikke længere — log ind igen.' });
    }
    const badesteder = tenantBadesteder.resolveTenantBadesteder(tenant.name, kommuneKeyToBadesteder);
    const badested = badesteder.find(b => String(b.id) === req.params.badestedId);
    if (!badested) {
      return res.status(404).json({ error: 'Badested ikke fundet for jeres kommune.' });
    }
    const url = `${seoPages.SITE_URL}/badested/${badested.slug}`;
    const qrMatrix = skilte.buildQrMatrix(url);
    const eps = skilte.buildQrEps(qrMatrix, { sizeMm: 40 });
    res.set('Content-Type', 'application/postscript');
    res.set('Content-Disposition', `attachment; filename="qr-${badested.slug}.eps"`);
    res.send(eps);
  } catch (e) {
    console.error('admin/api/skilte/qr-eps: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke generere QR-EPS lige nu.' });
  }
});

// NYT — det live digitale skilt: IKKE requireTenantSession, badevands-
// status for ét badested er allerede 100% offentlig (samme data som
// GET /api/badevand-risk og /badested/:slug altid har vist). Validerer kun at
// slug'et findes.
app.get('/skilt/:slug', (req, res) => {
  try {
    const info = badestedSlugToInfo.get(req.params.slug);
    if (!info) {
      return res.status(404).type('text/plain').send('Badested ikke fundet.');
    }
    // UDVIDET (bruger-ønske 2026-08-19 — skiltet skal vise opdelt risiko,
    // temperatur, vind/strøm og nedbørsgraf, ikke kun samlet risiko): lat/lng
    // medbragt her, så klienten selv kan slå vejr (GET /api/weather/weekly)
    // og strøm (GET /api/current-at) op for PRÆCIS badestedets koordinat —
    // samme mønster som badested-panelets egen showBadevandPanel().
    // RETTET (bruger-krav 2026-08-20 — "logo skal ALENE gælde skilte
    // leveret via kommune dashboard, de almindelige skilte i dkvand-appen
    // skal være uændrede"): logoet vises derfor KUN når ?kommunelogo=1 er
    // sat — det ENESTE, der adskiller admin-dashboardets "Kopiér iframe"-
    // link (toggleSkiltEmbed(), admin-dashboard.html) fra det almindelige,
    // offentlige /skilt/:slug-link (fx det borgere selv udskriver fra
    // badestedssiden). Opslag i den præ-beregnede kommuneLogoCache (se
    // dens filhoved), IKKE en server-side hentning af selve billedet —
    // samme "klientens browser henter direkte fra logo_url"-mønster som
    // det eksisterende kommunale varsel-banner (dansk-overloeb-kort.html/
    // seo-pages.js) allerede bruger, ikke logo-fetch.js's SSRF-sikrede
    // server-hentning (den er kun nødvendig for PDF-genereringen, som selv
    // skal LÆSE billed-bytes for at indlejre dem i PDF'en).
    const wantsKommuneLogo = req.query.kommunelogo === '1';
    const logoUrl = (wantsKommuneLogo && info.kommune)
      ? kommuneLogoCache.get(slugIndex.normalizeKommuneKey(info.kommune)) || null
      : null;
    const skiltJson = JSON.stringify({ badestedId: info.id, navn: info.navn, slug: req.params.slug, lat: info.lat, lng: info.lng, logoUrl });
    const html = fs.readFileSync(path.join(STATIC_DIR, 'badested-skilt.html'), 'utf8')
      .replace('%%SKILT_JSON%%', skiltJson);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('/skilt/:slug: uventet fejl —', e.message);
    res.status(500).type('text/plain').send('Kunne ikke hente skiltet lige nu.');
  }
});

// NYT — offentlig SSE-ping til de digitale skilte, se
// broadcastBadevandSignUpdate()'s filhoved for hvorfor denne er en
// SEPARAT strøm fra kommune-dashboardets egen (/admin/api/overloeb-stream).
app.get('/api/badevand-risk-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': forbundet\n\n');
  badevandSignStreamClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); }
    catch (e) { /* fanges af 'close' nedenfor */ }
  }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    badevandSignStreamClients.delete(res);
  });
});

// ── Kommune-benchmark-rapporten (bruger-ønske) ──────────────────────────────
// Sammenlignende ranking på tværs af ALLE kommuner med mindst ét matchet
// badested (kommuneKeyToBadesteder, se slug-index.js) — IKKE kun den
// indloggede tenants egen, se sikkerhedsnoten ved selve ruten nedenfor.
// Tre hovedmetrikker (varsler/lukkedage/badestedsvurderinger), indekseret
// pr. antal badesteder for at korrigere for at kommuner med bedre
// overvågning naturligt registrerer FLERE hændelser (se planens
// "Kendt metodisk risiko") — samt en fjerde, SEPARAT datakvalitets-liste
// (andel udløbspunkter med reelt målt PULS-data), bevidst IKKE vægtet ind i
// samlet rang.
const KOMMUNE_BENCHMARK_MIN_BADESTEDER = 3; // bruger-bekræftet lav-n-grænse

async function computeKommuneBenchmark({ fromDate, toDate }) {
  const fromMs = new Date(fromDate + 'T00:00:00.000Z').getTime();
  const toMs   = new Date(toDate   + 'T23:59:59.999Z').getTime();

  const [alertCounts, alertDays, lukketIntervals, vurderingRows] = await Promise.all([
    appMetrics.getAlertCountsGroupedByBadestedId(PUSH_SEND_TYPES.RISIKOVARSEL, fromDate, toDate),
    appMetrics.getAlertDaysGroupedByBadestedId(PUSH_SEND_TYPES.RISIKOVARSEL, fromDate, toDate),
    badestedOverrides.getLukketIntervalsInRange(fromDate, toDate),
    badestedObs.getVurderingCountsGrouped(fromMs, toMs),
  ]);

  const vurderingCounts = new Map();
  for (const r of vurderingRows) vurderingCounts.set(r.badested_id, r.count);

  // Ekspanderer 'lukket'-intervaller (badested_overrides, ægte historik, se
  // getLukketIntervalsInRange()'s filhoved) til pr.-badested dato-sæt,
  // klippet til [fromDate, toDate] — samme dato-streng-format som
  // alertDays, så de to kan forenes med Set-union nedenfor til KPI 2.
  const lukketDaysByBadested = new Map(); // badested_id -> Set<'YYYY-MM-DD'>
  const clipDate = (d, lo, hi) => (d < lo ? lo : (d > hi ? hi : d));
  for (const iv of lukketIntervals) {
    const start = clipDate(new Date(iv.created_at).toISOString().slice(0, 10), fromDate, toDate);
    const end   = clipDate(new Date(iv.revoked_at || iv.expires_at).toISOString().slice(0, 10), fromDate, toDate);
    if (!lukketDaysByBadested.has(iv.badested_id)) lukketDaysByBadested.set(iv.badested_id, new Set());
    const set = lukketDaysByBadested.get(iv.badested_id);
    for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      set.add(d.toISOString().slice(0, 10));
    }
  }

  // ── Pr.-kommune aggregering (KPI 1-3) ──────────────────────────────────
  const rows = [];
  for (const badesteder of kommuneKeyToBadesteder.values()) {
    if (badesteder.length === 0) continue;
    // kommuneKeyToBadesteder's elementer bærer ikke selve kommune-navnet
    // (kun badested-info, se slug-index.js:141) — slås op via
    // badestedSlugToInfo, samme normaliserede visningsform som resten af
    // appen (fx server.js's /badested/:slug-route) allerede bruger.
    const kommuneNavn = (badestedSlugToInfo.get(badesteder[0].slug)?.kommune || badesteder[0].navn)
      .replace(/\s*kommune\s*$/i, '').trim();

    let varslerRaw = 0, vurderingerRaw = 0;
    const affectedDays = new Set();
    for (const b of badesteder) {
      const id = String(b.id);
      varslerRaw += alertCounts.get(id) || 0;
      for (const d of (alertDays.get(id) || [])) affectedDays.add(d);
      for (const d of (lukketDaysByBadested.get(id) || [])) affectedDays.add(d);
      vurderingerRaw += vurderingCounts.get(id) || 0;
    }

    rows.push({
      kommuneNavn,
      badestedCount: badesteder.length,
      varslerRaw,
      varslerIndekseret: varslerRaw / badesteder.length,
      lukkedageRaw: affectedDays.size,
      lukkedageIndekseret: affectedDays.size / badesteder.length,
      vurderingerRaw,
      vurderingerIndekseret: vurderingerRaw / badesteder.length,
    });
  }

  const hovedranking = rows.filter(r => r.badestedCount >= KOMMUNE_BENCHMARK_MIN_BADESTEDER);
  const lavN = rows.filter(r => r.badestedCount < KOMMUNE_BENCHMARK_MIN_BADESTEDER)
    .sort((a, b) => a.kommuneNavn.localeCompare(b.kommuneNavn, 'da'));

  // Rangering: LAVEST indekseret = bedst (rang 1) for varsler/lukkedage,
  // HØJEST = bedst for vurderinger (mere borgerengagement er positivt —
  // modsat retning end de to andre, se planens formel-afsnit).
  function assignRanks(list, key, rangKey, direction) {
    [...list].sort((a, b) => direction * (a[key] - b[key])).forEach((r, i) => { r[rangKey] = i + 1; });
  }
  assignRanks(hovedranking, 'varslerIndekseret', 'rangVarsler', 1);
  assignRanks(hovedranking, 'lukkedageIndekseret', 'rangLukkedage', 1);
  assignRanks(hovedranking, 'vurderingerIndekseret', 'rangVurderinger', -1);
  for (const r of hovedranking) {
    r.samletRang = (r.rangVarsler + r.rangLukkedage + r.rangVurderinger) / 3; // ligevægtet, bruger-bekræftet
  }
  hovedranking.sort((a, b) => a.samletRang - b.samletRang);

  // ── Datakvalitet (KPI 5) — separat, periode-uafhængig, INGEN lav-n-udelukkelse ──
  // Læses direkte fra loadPulsPointsFull() (municipality + dataQuality
  // allerede pr. punkt, se dens filhoved) — kræver INGEN badevand-risk-
  // cascade-matching, da dette måler udløbenes EGEN kommune, ikke hvilke
  // badesteder de påvirker.
  const pulsPoints = loadPulsPointsFull();
  const dqByKommune = new Map(); // normaliseret nøgle -> {navn, total, maalt}
  for (const p of pulsPoints) {
    if (!p.municipality || p.municipality === '—') continue;
    const key = slugIndex.normalizeKommuneKey(p.municipality);
    if (!dqByKommune.has(key)) {
      dqByKommune.set(key, { navn: p.municipality.replace(/\s*kommune\s*$/i, '').trim(), total: 0, maalt: 0 });
    }
    const entry = dqByKommune.get(key);
    entry.total++;
    if (p.dataQuality === 0) entry.maalt++; // se planens "Definitions-valg" — kun kode 0 ("reelle data") tæller som reelt målt
  }
  const datakvalitet = [...dqByKommune.values()]
    .map(e => ({ kommuneNavn: e.navn, udloebPunkter: e.total, reeltMaalt: e.maalt, andel: e.total > 0 ? e.maalt / e.total : 0 }))
    .sort((a, b) => b.andel - a.andel);

  return { fromDate, toDate, hovedranking, lavN, datakvalitet };
}

// NYT — se computeKommuneBenchmark()'s filhoved for KPI-definitionerne.
// Periode: enten et preset (samme som /admin/api/badested-alert-stats'
// today|7d|month|quarter|year, via computeAlertStatsRange()) ELLER en helt
// fri ?from=&to= (bruger-krav: "periodeafgrænsning er valgfri").
//
// ⚠ SIKKERHEDSNOTE (bevidst afvigelse, bruger-bekræftet: "fuld navngivet
// sammenligning"): dette er den FØRSTE tenant-autentificerede route i
// kodebasen, der returnerer aggregerede tal for ANDRE kommuner end den
// indloggede tenants egen — resten af /admin/api/* er strengt tenant-
// scopet via resolveTenantBadesteder() (se fx ruterne ovenfor). Kun
// AGGREGEREDE tæller/indekser/andele eksponeres her, ALDRIG rå
// operationelle data (overstyringers beskeder/set_by, abonnenttal,
// individuelle badested-navne ud over selve kommunenavnet) — se
// getLukketIntervalsInRange()'s filhoved for samme forbehold ved kilden.
app.get('/admin/api/kommune-benchmark', tenantAdmin.requireTenantSession, async (req, res) => {
  try {
    let range;
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
        return res.status(400).json({ error: "Ugyldigt from/to-format, forventede 'YYYY-MM-DD'." });
      }
      range = { from: req.query.from, to: req.query.to };
    } else {
      const period = typeof req.query.period === 'string' ? req.query.period : '';
      if (!VALID_ALERT_PERIODS.has(period)) {
        return res.status(400).json({ error: `Ugyldig period — skal være én af: ${[...VALID_ALERT_PERIODS].join(', ')}, eller angiv ?from=&to=.` });
      }
      const monthParam = typeof req.query.month === 'string' ? req.query.month : null;
      range = computeAlertStatsRange(period, monthParam);
      if (!range) return res.status(400).json({ error: "Ugyldigt month-format, forventede 'YYYY-MM'." });
    }

    const result = await computeKommuneBenchmark({ fromDate: range.from, toDate: range.to });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (e) {
    console.error('admin/api/kommune-benchmark: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke beregne kommune-benchmark lige nu.' });
  }
});

// Service worker: never cache (must update immediately)
app.get('/overloeb-sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(STATIC_DIR, 'overloeb-sw.js'));
});

// Vendorede (ikke CDN-loadede) strøm-visualiserings-scripts, se
// windy-currents.js' filhoved — SAMME mønster som overloeb-sw.js ovenfor:
// egen eksplicitte route, IKKE dækket af PUBLIC_STATIC_EXTENSIONS-
// allowlisten nedenfor (som bevidst udelukker .js generelt, netop for at
// undgå at eksponere server-side kildekode fra samme STATIC_DIR-rod — se
// allowlistens filhoved). Disse to filer ER beregnet til offentlig
// udlevering (loades via <script src> i dansk-overloeb-kort.html), så en
// navngivet undtagelse her er den rigtige løsning, IKKE en generel
// åbning af .js i allowlisten.
// RETTET (bruger-rapport, samme dag: "stadig rød"/"gammel skala" efter
// flere redeploys) — max-age=86400 (1 dag) betød at ENHVER bruger, der
// havde åbnet siden bare ÉN gang tidligere samme dag, blev ved med at
// køre en flere-timer-gammel udgave af selve motoren, uafhængigt af hvor
// mange gange den omkringliggende dansk-overloeb-kort.html (no-cache)
// blev genindlæst — <script src>-tagget peger jo på PRÆCIS samme URL, så
// browseren så aldrig grund til at spørge serveren igen. no-cache (samme
// politik som HTML'en selv) tvinger en (billig, ETag-baseret) revalidering
// ved hver indlæsning i stedet, mens denne funktion stadig er under aktiv
// iteration.
for (const publicJsFile of ['windy-currents.js', 'leaflet-canvas-layer.js']) {
  app.get('/' + publicJsFile, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript');
    res.sendFile(path.join(STATIC_DIR, publicJsFile));
  });
}

// robots.txt: egen eksplicitte route (samme mønster som ovenfor), IKKE
// dækket af PUBLIC_STATIC_EXTENSIONS-allowlisten nedenfor — '.txt' er
// bevidst udeladt derfra, da det ellers også ville have åbnet
// requirements.txt (se dens filhoved for den fulde begrundelse).
app.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('text/plain');
  res.sendFile(path.join(STATIC_DIR, 'robots.txt'));
});

// ═══════════════════════════════════════════════════════════════════════════
// URL-arkitektur/SEO (bruger-ønske 2026-08-10) — Tier 1 (/badested/:slug),
// Tier 2 (/soe/:slug), Tier 3 (/udloeb/:id), sitemap.xml + OG-badges.
// Se seo-pages.js/slug-index.js for selve render-/slug-logikken — disse
// routes wire'r blot serverens allerede eksisterende, hvert-15.-minut-
// opdaterede badevandRiskCache/badevandByIdCache sammen med dem. Dynamisk
// pr. request (ingen ny build-pipeline), risikostatus derfor altid ≤15 min
// frisk — se planen (staged-doodling-eagle.md) for hvorfor denne tilgang
// blev valgt frem for prækomputerede statiske filer.
//
// KRITISK: skal stå FØR PUBLIC_STATIC_EXTENSIONS-gatemiddleware'en
// (længere nede i filen) — disse stier har ingen fil-endelse og ville
// ellers blive 404'et af den.
// ═══════════════════════════════════════════════════════════════════════════

function baseAppHtml() {
  return getSsrShellHtml();
}

// NYT (bruger-ønske 2026-08-17) — fælles afstands-sorterings-/afskærings-
// logik for de to "andre badesteder"-lister på /badested/:slug (se
// seo-pages.js's buildNearbyListHtml()). `candidates` er allerede den
// relevante kandidat-liste fra kaldestedet (enten hele badestedSlugToInfo
// for "i nærheden", eller kommuneKeyToBadesteder.get(key) for kommune-
// listen) — denne funktion filtrerer/sorterer/afkorter blot.
function nearestBadesteder(fromInfo, candidates, excludeSlug, maxKm, cap) {
  const out = [];
  for (const b of candidates) {
    if (b.slug === excludeSlug || b.lat == null || b.lng == null) continue;
    const distKm = badevandRisk.haversineM(fromInfo.lat, fromInfo.lng, b.lat, b.lng) / 1000;
    if (maxKm != null && distKm > maxKm) continue;
    out.push({ slug: b.slug, navn: b.navn, distKm });
  }
  out.sort((a, b) => a.distKm - b.distKm);
  return out.slice(0, cap);
}

app.get('/badested/:slug', (req, res) => {
  const info = badestedSlugToInfo.get(req.params.slug);
  if (!info) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).type('text/plain').send('Badested ikke fundet.');
  }
  const entry = badevandByIdCache.get(info.id);
  const { text } = seoPages.describeBadestedRisk(entry);
  // NYT (bruger-ønske — datakonfidens): entry.dataConfidence er sat af
  // badevand-risk.js's deriveDataConfidence() for hvert badested — se dens
  // filhoved. null hvis entry mangler (kold cache) eller feltet endnu ikke
  // findes (ældre cache-snapshot fra før dette blev tilføjet).
  const confidence = seoPages.describeDataConfidence(entry?.dataConfidence);
  const kommune = info.kommune ? info.kommune.replace(/\s*kommune\s*$/i, '').trim() : null;
  const title = `${info.navn} badevand – aktuel risiko | Dit Badevand`;
  const description = `${info.navn}${kommune ? ' i ' + kommune : ''}: ${text}`;

  // NYT (bruger-ønske 2026-08-17) — to adskilte "andre badesteder"-lister:
  // fysisk nærhed (på tværs af kommunegrænser, ≤20km — undgår meningsløse
  // links i tyndt befolkede områder) og kommune-tilhørsforhold (samme
  // administrative gruppering som tenant-badesteder.js allerede bruger).
  // Overlap mellem de to er forventet og fint — de svarer på to forskellige
  // spørgsmål ("hvad er tæt på" vs. "hvad hører administrativt sammen").
  const nearbyDistance = nearestBadesteder(info, allBadestederWithSlug, req.params.slug, 20, 6);
  const kommuneKey = info.kommune ? slugIndex.normalizeKommuneKey(info.kommune) : null;
  const nearbyKommune = kommuneKey
    ? nearestBadesteder(info, kommuneKeyToBadesteder.get(kommuneKey) || [], req.params.slug, null, 8)
    : [];
  const vurderingCount30d = vurderingCount30dCache.get(String(info.id)) || 0;

  let html = seoPages.injectHead(baseAppHtml(), {
    title, description,
    canonicalPath: `/badested/${req.params.slug}`,
    ogImagePath: `/og/badested/${req.params.slug}`,
    jsonLd: seoPages.buildJsonLd({
      name: info.navn, lat: info.lat, lng: info.lng, addressLocality: kommune, description,
      dataset: {
        name: `Badevandsrisiko og modelestimater for ${info.navn}`,
        description: 'Modelbaserede estimater for forureningsrisiko baseret på overløbsfrekvens, observeret og prognosticeret nedbør samt patogenoverlevelse.'
          + (confidence ? ` ${confidence.text}` : ''),
        temporalCoverage: new Date(badevandRiskCache.ts || Date.now()).toISOString(),
        variableMeasured: ['Forureningsrisiko per udløbspunkt', 'Overløbsfrekvens', 'Prognosticeret nedbør'],
      },
    }),
  });
  const ssrContent = seoPages.buildSsrContent({
    navn: info.navn, kommune, riskText: text,
    updatedAt: new Date(badevandRiskCache.ts || Date.now()).toLocaleString('da-DK'),
    outlets: entry?.outlets || [],
    confidenceText: confidence?.text || null,
    // Kommunepakke, modul 6 — entry kommer fra badevandByIdCache, som
    // applyLiveOverridesToCache() allerede har patchet med overrideInfo
    // (se server.js's cascade-cyklus). Rent gennemstik, ingen ekstra opslag.
    overrideInfo: entry?.overrideInfo || null,
    lat: info.lat, lng: info.lng,
    nearbyDistance, nearbyKommune,
    vurderingCount30d,
  });
  // RETTET (bruger-rapporteret 2026-08-10 — /badested/:slug-siden viste
  // permanent kun det statiske SSR-indhold, aldrig den rigtige app): denne
  // linje sendte tidligere { type: 'badested', id: info.id } — men
  // dansk-overloeb-kort.html's handleSsrRoute() tjekker udelukkende
  // "route.lat != null && route.lng != null" for netop denne type (se dens
  // egen goToBadevand(lat, lng)-kald, SAMME koordinat-baserede mønster som
  // sitets etablerede #badevand=lat:lng-dybe-links, aldrig id-baseret).
  // Betingelsen var derfor ALTID falsk, goToBadevand() blev aldrig kaldt,
  // og appen forblev permanent på det statiske SSR-indhold uden nogensinde
  // at overtage. info.lat/info.lng findes allerede på samme objekt
  // (slug-index.js's buildBadestedSlugs), ingen ny data nødvendig.
  html = seoPages.injectBodyContent(html, ssrContent + seoPages.buildSsrRouteScript({ type: 'badested', lat: info.lat, lng: info.lng }));

  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/soe/:slug', (req, res) => {
  const info = soeSlugToInfo.get(req.params.slug);
  if (!info) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).type('text/plain').send('Sø ikke fundet.');
  }
  const entry = badevandRiskCache.lakes?.[info.navn];
  const { text } = seoPages.describeSoeRisk(entry);
  // NYT (bruger-ønske — datakonfidens for sø-siderne): entry.dataConfidence
  // er sat af badevand-risk.js's deriveLakeDataConfidence() for hver sø —
  // se dens filhoved for hvorfor sø-tier'en er grovere (kun hoej/middel/
  // ingen-data, ingen 'lav') end badested-udgaven.
  const confidence = seoPages.describeDataConfidence(entry?.dataConfidence);
  const kommune = info.kommune ? info.kommune.replace(/\s*kommune\s*$/i, '').trim() : null;
  const title = `${info.navn} – søvand risiko | Dit Badevand`;
  const description = `${info.navn}${kommune ? ' i ' + kommune : ''}: ${text}`;

  let html = seoPages.injectHead(baseAppHtml(), {
    title, description,
    canonicalPath: `/soe/${req.params.slug}`,
    ogImagePath: `/og/soe/${req.params.slug}`,
    jsonLd: seoPages.buildJsonLd({
      name: info.navn, lat: info.lat, lng: info.lng, addressLocality: kommune, description,
      dataset: {
        name: `Badevandsrisiko og modelestimater for ${info.navn}`,
        description: 'Modelbaserede estimater for forureningsrisiko baseret på overløbsfrekvens, observeret og prognosticeret nedbør samt patogenoverlevelse.'
          + (confidence ? ` ${confidence.text}` : ''),
        temporalCoverage: new Date(badevandRiskCache.ts || Date.now()).toISOString(),
        variableMeasured: ['Forureningsrisiko per udløbspunkt', 'Overløbsfrekvens', 'Prognosticeret nedbør'],
      },
    }),
  });
  const ssrContent = seoPages.buildSsrContent({
    navn: info.navn, kommune, riskText: text,
    updatedAt: new Date(badevandRiskCache.ts || Date.now()).toLocaleString('da-DK'),
    outlets: entry?.outlets || [],
    confidenceText: confidence?.text || null,
  });
  html = seoPages.injectBodyContent(html, ssrContent + seoPages.buildSsrRouteScript({ type: 'soe', navn: info.navn }));

  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// /om — selvstændig, indekserbar side for #tab-doc's fulde "Om"-panel (se
// getSsrShellHtml()'s filhoved for hvorfor det IKKE længere ligger inline på
// hver badested/soe-side). Genbruger BEVIDST getCompressedHtml().raw direkte
// (ikke getSsrShellHtml()) — dette er netop den ene side, panelet SKAL være
// til stede på.
app.get('/om', (req, res) => {
  let html = seoPages.injectHead(getCompressedHtml().raw.toString('utf8'), {
    title: 'Om · Formål, datakilder & risikomodel | Dit Badevand',
    description: 'Formål, datakilder, kortlag, risikomodel og begrænsninger bag Dit Badevands forureningsrisiko-estimater for badesteder, søer og kystvande i Danmark.',
    canonicalPath: '/om',
  });
  html = seoPages.injectBodyContent(html, seoPages.buildSsrRouteScript({ type: 'doc' }));
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Tier 3 — bevidst INGEN data-forudfyldning server-side (se planen: "kan
// forblive rent client-side renderet"), kun robots/canonical injiceret.
// Holder de ~21.000 sider billige at servere.
app.get('/udloeb/:id', (req, res) => {
  // RETTET (bruger-rapporteret 2026-08-11 — se loadPulsPointsFull()'s
  // filhoved for den fulde begrundelse, inkl. hvorfor id IKKE (endnu) er
  // outfallId): behandler id som en ugennemsigtig streng, ikke et heltal
  // — den gamle parseInt/Number.isInteger-grænsetjek er unødvendigt
  // restriktiv og ville forhindre en fremtidig GUID-baseret id. Slår op i
  // et Set af faktiske id'er i stedet for et rent bounds-tjek.
  const id = req.params.id;
  const points = loadPulsPointsFull();
  // NYT: indeholder nu BÅDE id (rækkeindeks) og outfallId (stabil GUID, se
  // loadPulsPointsFull()) — points ændrer sig aldrig i processens levetid
  // (kun ved genstart, som også nulstiller _pulsIdSet), så et simpelt
  // engangs-lazy-build er nok; det gamle size-baserede staleness-tjek gav
  // ingen reel beskyttelse og ville fejlagtigt gen-bygge hver gang (dobbelt
  // størrelse pga. outfallId-nøglerne).
  if (!_pulsIdSet) {
    _pulsIdSet = new Set();
    for (const p of points) { _pulsIdSet.add(p.id); if (p.outfallId) _pulsIdSet.add(p.outfallId); }
  }
  if (!_pulsIdSet.has(id)) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).type('text/plain').send('Udløb ikke fundet.');
  }
  const html = seoPages.injectRobotsOnly(baseAppHtml(), `/udloeb/${id}`);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex, follow');
  res.send(html);
});

// Bygget ÉN gang her (samme livscyklus som slug-index selv — se dens
// filhoved) — kun Tier 1+2, se planens robots.txt-afsnit for hvorfor Tier 3
// hverken må stå her eller disallowes i robots.txt (noindex alene, via
// meta-taggen ovenfor, er den korrekte mekanisme).
const _sitemapXml = seoPages.buildSitemapXml([
  { loc: `${seoPages.SITE_URL}/om` },
  ...[...badestedSlugToInfo.keys()].map(slug => ({ loc: `${seoPages.SITE_URL}/badested/${slug}` })),
  ...[...soeSlugToInfo.keys()].map(slug => ({ loc: `${seoPages.SITE_URL}/soe/${slug}` })),
]);
app.get('/sitemap.xml', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/xml');
  res.send(_sitemapXml);
});

app.get('/og/badested/:slug', (req, res) => {
  const info = badestedSlugToInfo.get(req.params.slug);
  if (!info) return res.status(404).type('text/plain').send('Badested ikke fundet.');
  const entry = badevandByIdCache.get(info.id);
  const { label } = seoPages.describeBadestedRisk(entry);
  const active = [entry?.bact, entry?.viral].filter(v => v != null);
  const risk = active.length ? Math.max(...active) : (entry?.source === 'ingen-bekraeftet' || entry?.source === 'nedstroms-bekraeftet' || (entry?.source === 'ingen' && !entry?.noDataMatch) ? 0 : null);
  const { color } = seoPages.riskInfo(risk);
  const kommune = info.kommune ? info.kommune.replace(/\s*kommune\s*$/i, '').trim() : null;
  res.set('Cache-Control', 'public, max-age=900'); // 15 min — matcher badevandRiskCache's eget opdateringsinterval
  res.type('image/svg+xml');
  res.send(seoPages.buildOgSvg({ navn: info.navn, kommune, label, color }));
});

app.get('/og/soe/:slug', (req, res) => {
  const info = soeSlugToInfo.get(req.params.slug);
  if (!info) return res.status(404).type('text/plain').send('Sø ikke fundet.');
  const entry = badevandRiskCache.lakes?.[info.navn];
  const { label } = seoPages.describeSoeRisk(entry);
  const active = [entry?.bact, entry?.viral].filter(v => v != null);
  const risk = active.length ? Math.max(...active) : (entry?.confirmedNoOutlet ? 0 : null);
  const { color } = seoPages.riskInfo(risk);
  const kommune = info.kommune ? info.kommune.replace(/\s*kommune\s*$/i, '').trim() : null;
  res.set('Cache-Control', 'public, max-age=900');
  res.type('image/svg+xml');
  res.send(seoPages.buildOgSvg({ navn: info.navn, kommune, label, color }));
});

// ── Weather proxy with shared server-side cache ─────────────────────────────
// Grid: 0.25° (~17×28 km) — 4× finer than original 0.5°, reliable API usage.
// TTL: 3 hours. warmCache uses individual single-location calls (proven to work).
// API budget: ~220 cells × 8 warmups/day = ~1.760 calls/day (well under 10.000).
const GRID_DEG       = 0.25;
// RETTET: sat til 6 timer — men DMI's HARMONIE-model (som Open-Meteos
// best_match rent faktisk bruger for Danmark, bekræftet via DMI's egen
// dokumentation) opdaterer selv sin prognose hver 3. time, ikke hver 6.
// At hente sjældnere end kilden selv opdaterer betyder at appen kan gå
// glip af en hel modelopdatering — særligt relevant for HARMONIE, som er
// specifikt designet til at fange lokale, hurtigt udviklende
// sommerbyger bedre end grovere modeller. At hente OFTERE end hver 3.
// time ville omvendt være spild (samme, uændrede prognose igen). API-
// forbrug ved 3 timer: ~170 celler × 8 hentninger/dag = 1.360 kald/dag —
// stadig under den oprindeligt accepterede budgetramme (1.680/dag).
const WEATHER_TTL_MS = 3 * 3600 * 1000;  // 3 timer — matcher DMI HARMONIE's egen opdateringstakt
const weatherCache   = new Map();
let   apiCallCount   = 0;
let   cacheHitCount  = 0;
const fetchErrors    = [];   // ring buffer — last 5 errors from fetchOpenMeteo

function gridKey(lat, lng) {
  const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  return `${clat.toFixed(4)}:${clng.toFixed(4)}`;
}

// Build grid from actual PULS overflow point coordinates — only cells that
// contain real data points. Avoids warming ~220 sea/foreign bbox cells.
// puls-data.json format: { a: [authorities], w: [waterAreas], d: [[lat,lng,...], ...] }
// Typically ~150-180 unique 0.25° cells vs 420 for full bbox.
let _pulsGrid = null;
function buildPulsGrid() {
  if (_pulsGrid) return _pulsGrid;
  try {
    const raw  = require('fs').readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8');
    const data = JSON.parse(raw);
    const rows = data?.d || data;                  // compressed: { d: rows } or raw array
    const seen = new Set();
    const cells = [];
    for (const r of rows) {
      const lat = parseFloat(Array.isArray(r) ? r[0] : (r.lat ?? r.Lat));
      const lng = parseFloat(Array.isArray(r) ? r[1] : (r.lng ?? r.Lon ?? r.lon));
      if (isNaN(lat) || isNaN(lng)) continue;
      const key = gridKey(lat, lng);
      if (seen.has(key)) continue;
      seen.add(key);
      const [ls, gs] = key.split(':');
      cells.push({ lat: parseFloat(ls), lng: parseFloat(gs) });
    }
    console.log(`buildPulsGrid: ${cells.length} unique cells from ${rows.length} PULS points`);
    _pulsGrid = cells;
    return cells;
  } catch(e) {
    console.warn('buildPulsGrid failed, falling back to bbox grid:', e.message);
    return buildDenmarkGrid();
  }
}

// Denmark + Bornholm bounding box at 0.25°. Fallback if buildPulsGrid fails.
function buildDenmarkGrid() {
  const iLatMin = Math.floor(54.5 / GRID_DEG);
  const iLatMax = Math.ceil(57.9  / GRID_DEG);
  const iLngMin = Math.floor(8.0  / GRID_DEG);
  const iLngMax = Math.ceil(15.4  / GRID_DEG);
  const cells = [], seen = new Set();
  for (let iLat = iLatMin; iLat < iLatMax; iLat++) {
    for (let iLng = iLngMin; iLng < iLngMax; iLng++) {
      const key = gridKey((iLat + 0.1) * GRID_DEG, (iLng + 0.1) * GRID_DEG);
      if (seen.has(key)) continue;
      seen.add(key);
      const [ls, gs] = key.split(':');
      cells.push({ lat: parseFloat(ls), lng: parseFloat(gs) });
    }
  }
  return cells;
}

// Single-location fetch — proven reliable with Open-Meteo.
function fetchOpenMeteo(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      // NYT: windspeed_10m/winddirection_10m tilføjet — samme kilde vi
      // allerede henter nedbør+temperatur fra, blot udvidet med to ekstra
      // variable. wind_speed_unit=ms sikrer samme enhed (m/s) som
      // strømdataen (CMEMS uo/vo), så de to kan sammenlignes direkte i UI'en.
      `&hourly=precipitation,temperature_2m,windspeed_10m,winddirection_10m` +
      // RETTET (Kommune Dashboard-udvidelse, "Overløb"-fanens 72h-prognose):
      // forecast_days var tidligere 2 (nok til den eksisterende 24h-sum,
      // forecastMM nedenfor) — hævet til 4 for at have nok rå prognosetimer
      // til også at kunne summere en 72h-prognose (forecastMM72h). Den
      // eksisterende 24h-sum er UÆNDRET af dette, kun mere data hentes.
      `&wind_speed_unit=ms&past_days=7&forecast_days=4` +
      `&models=best_match&timezone=Europe%2FCopenhagen`;
    https.get(url, resp => {
      if (resp.statusCode !== 200) {
        reject(new Error(`Open-Meteo HTTP ${resp.statusCode}`));
        resp.resume(); return;
      }
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Transiente serverfejl (503/502/504) hos Open-Meteo er ofte kortvarige —
// et par sekunders pause og ét gen-forsøg løser typisk problemet, i stedet
// for at give hele cellen op med det samme. Ikke-transiente fejl (4xx,
// netværksfejl) gives videre uden forsinkelse.
function isTransientOpenMeteoError(err) {
  return /Open-Meteo HTTP (502|503|504)/.test(err.message || '');
}

async function fetchOpenMeteoWithRetry(lat, lng, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOpenMeteo(lat, lng);
    } catch (e) {
      if (attempt >= retries || !isTransientOpenMeteoError(e)) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// Compute derived precipitation metrics from raw Open-Meteo JSON.
function computeMetrics(json) {
  const times     = json?.hourly?.time             || [];
  const values    = json?.hourly?.precipitation    || [];
  const tempVals  = json?.hourly?.temperature_2m   || [];
  const windVals  = json?.hourly?.windspeed_10m    || [];
  const windDirs  = json?.hourly?.winddirection_10m || [];
  const now    = Date.now();
  const MS_HOUR = 3600 * 1000;
  const TAU    = 3.0;
  let todayMM = 0, forecastMM = 0, forecastMM72h = 0, totalRain7d = 0;
  const hourlyObs = [], hourlyFore = [], hourlyWeek = [];
  // Luft-temperatur — TO ADSKILTE FORMÅL, der tidligere delte samme tal:
  //   1) recentAirTempAvg (72h glidende gennemsnit): bruges INTERNT til at
  //      ESTIMERE vandtemperatur i søer/åer (Mohseni-Stefan-model, se
  //      computeFreshwaterTemp() client-side) — et gennemsnit er her
  //      hydrologisk korrekt, fordi selv lavvandede vandområder har en vis
  //      termisk træghed og reagerer på flere dages vejr, ikke et enkelt
  //      døgns udsving.
  //   2) todayMaxAirTemp (RETTET/NYT): den faktiske lufttemperatur en
  //      badegæst oplever — dagens HØJESTE temperatur, ikke et
  //      bagudskuende gennemsnit der iblander kolde nattetimer. Blev
  //      tidligere fejlagtigt vist til brugeren i stedet for dette tal,
  //      hvilket kunne gøre luft "koldere" end vand, selvom det reelt var
  //      dagens varmeste periode der var relevant. Dækker HELE
  //      kalenderdagen (allerede observerede timer + resten af dagens
  //      prognose), ikke kun et ±24-timers rullende vindue, så en
  //      forespørgsel om morgenen stadig fanger eftermiddagens forventede
  //      maksimum.
  //   3) hourlyTempWeek (NYT): fuld time-for-time temperaturkurve for hele
  //      7-dages-vinduet (parallel til hourlyWeek for nedbør) — til en
  //      fremtidig graf, hvis et enkelt dagsmaksimum ikke er nok.
  let tempSum72h = 0, tempCount72h = 0;
  const hourlyTempWeek = [];
  let todayMaxAirTemp = null;
  const todayDateStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' }); // "YYYY-MM-DD", matcher Open-Meteos lokale hourly.time-strenge

  // NYT: vind — i modsætning til temperatur (hvor dagens HØJESTE er det
  // relevante) er det NUVÆRENDE vindforhold, der er relevant for en
  // badegæst — vind ændrer sig hurtigt, og et dagsgennemsnit/-maksimum
  // ville være misvisende. Finder timen tættest på "nu" (mindste |diffMs|),
  // uanset om den er observeret eller prognoseret.
  let currentWindSpeed = null, currentWindDir = null, bestWindDiffMs = Infinity;

  times.forEach((tStr, i) => {
    const mm  = Math.max(Number(values[i]) || 0, 0);
    const tMs = new Date(tStr).getTime();
    if (isNaN(tMs)) return;
    const diffMs  = now - tMs;

    const temp = Number(tempVals[i]);
    const hasTemp = !isNaN(temp);
    hourlyTempWeek.push(hasTemp ? temp : null);
    if (hasTemp && tStr.slice(0, 10) === todayDateStr) {
      if (todayMaxAirTemp === null || temp > todayMaxAirTemp) todayMaxAirTemp = temp;
    }

    const windSpeed = Number(windVals[i]);
    if (!isNaN(windSpeed) && Math.abs(diffMs) < bestWindDiffMs) {
      bestWindDiffMs = Math.abs(diffMs);
      currentWindSpeed = windSpeed;
      const wd = Number(windDirs[i]);
      currentWindDir = isNaN(wd) ? null : wd;
    }

    if (diffMs >= 0) {
      totalRain7d += mm;
      hourlyWeek.push(mm);  // full 7-day history
      if (diffMs < 24 * MS_HOUR) { todayMM += mm; hourlyObs.push(mm); }
      if (hasTemp && diffMs < 72 * MS_HOUR) { tempSum72h += temp; tempCount72h++; }
    } else {
      if (-diffMs <= 24 * MS_HOUR) { forecastMM += mm; hourlyFore.push(mm); }
      // NYT (Kommune Dashboard-udvidelse, "Overløb"-fanens 72h-prognose) —
      // parallel 72h-sum ved siden af den eksisterende 24h-sum ovenfor,
      // IKKE en erstatning for den (badested-kaskaden/hovedrisikoen bruger
      // fortsat forecastMM/24h uændret). Kræver forecast_days=4 ovenfor for
      // at have rå prognosetimer nok til at nå 72h frem.
      if (-diffMs <= 72 * MS_HOUR) { forecastMM72h += mm; }
    }
  });
  const recentAirTempAvg = tempCount72h > 0 ? tempSum72h / tempCount72h : null;
  // RETTET: antecedentMM regnede tidligere sin egen, parallelle udgave af
  // samme henfaldsformel inline i loopet ovenfor. Genbruger nu
  // riskModel.accumulateDecayed() (samme rullende τ=3-dages henfald som
  // estimateLastEventAge() allerede brugte) — sidste værdi i den returnerede
  // serie SVARER til "akkumuleret henfaldet nedbør ved seneste observerede
  // time", som er præcis hvad antecedentMM altid har repræsenteret. Se
  // kommentar ved accumulateDecayed() i risk-model.js for den mikroskopiske
  // (<1,5 %), accepterede præcisionsforskel dette medfører.
  const decayedSeries = riskModel.accumulateDecayed(hourlyWeek, TAU);
  const antecedentMM  = decayedSeries.length ? decayedSeries[decayedSeries.length - 1] : 0;
  return {
    antecedentMM, todayMM, forecastMM, forecastMM72h, totalRain7d, hourlyObs, hourlyFore, hourlyWeek,
    recentAirTempAvg, todayMaxAirTemp, hourlyTempWeek,
    currentWindSpeed, currentWindDir,
  };
}

// ── Proactive cache warming ──────────────────────────────────────────────────
// Individual single-location calls, CONCURRENCY=30. ~220 cells → ~10s warmup.
let warmRunning       = false;
let currentWarmPromise = null;

function warmCache() {
  if (warmRunning) return currentWarmPromise;
  warmRunning = true;
  currentWarmPromise = (async () => {
    const cells = buildPulsGrid();
    const CONC  = 10;    // 10 parallelle kald — undgår burst rate-limit hos Open-Meteo
    let idx = 0, fetched = 0, skipped = 0, failed = 0;
    const t0 = Date.now();

    async function worker(workerIdx) {
      // Stagger worker start times med 200ms — fordeler burst-toppen
      await new Promise(r => setTimeout(r, workerIdx * 200));
      while (idx < cells.length) {
        const cell = cells[idx++];
        const key  = gridKey(cell.lat, cell.lng);
        const cached = weatherCache.get(key);
        if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) { skipped++; continue; }
        try {
          apiCallCount++;
          const raw  = await fetchOpenMeteoWithRetry(cell.lat, cell.lng);
          const data = computeMetrics(raw);
          weatherCache.set(key, { ts: Date.now(), data });
          fetched++;
        } catch(e) {
          failed++;
          const errMsg = e.message;
          console.warn('warmCache cell failed:', key, errMsg);
          fetchErrors.push({ ts: new Date().toISOString(), key, error: errMsg });
          if (fetchErrors.length > 10) fetchErrors.shift();
          // Vent 2s ved 429 inden næste forsøg i denne worker
          if (errMsg.includes('429')) await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONC, cells.length) }, (_, i) => worker(i)));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`warmCache: ${fetched} fetched, ${skipped} skipped, ${failed} failed — ${elapsed}s — cache: ${weatherCache.size} cells`);
    warmRunning = false;
    currentWarmPromise = null;
  })();
  return currentWarmPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVERSTYRET PUSH-EVALUERING
// ═══════════════════════════════════════════════════════════════════════════
// TIDLIGERE: push-notifikationer blev KUN udløst hvis en klient selv havde
// en fane åben, opdagede risikoen client-side, og POSTede den til
// /api/push/warnpoints (se checkFavNotifications() i dansk-overloeb-kort.html
// og /api/push/warnpoints-routen nedenfor, som stadig findes og virker som
// supplement). Det modsagde selve formålet med web push — at kunne advare
// brugere UDEN at de har appen åben. Nu evaluerer SERVEREN selv risikoen for
// alle PULS-punkter, hver gang frisk vejrdata er hentet (warmCache), uanset
// om nogen klient overhovedet er tilsluttet.

// Fuld PULS-punktliste (ikke kun unikke gitterceller som buildPulsGrid()) —
// indlæst og cachet én gang, ligesom buildPulsGrid() gør det for celler.
let _pulsPointsFull = null;
let _pulsIdSet = null; // Set af PULS-punkt-id'er — cachet lazy, se /udloeb/:id-routen
function loadPulsPointsFull() {
  if (_pulsPointsFull) return _pulsPointsFull;
  try {
    const raw  = fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8');
    const data = JSON.parse(raw);
    const auths = data.a || [];
    const areas = data.w || [];
    const rows  = data.d || data;
    // RETTET (bruger-rapporteret 2026-08-11 — "F-U9 i Furesø" åbnede et
    // udløb i Odense ved klik): id bruger rækkeindekset (i) i puls-data.
    // json's d-array som id for /udloeb/:id-URL'er, udløbslister,
    // favoritter osv. — men filen genopbygges periodisk, og rækkefølgen er
    // IKKE stabil på tværs af genopbygninger (bekræftet: samme indeks 4050
    // var tre FORSKELLIGE reelle udløb i tre snapshots taget uger fra
    // hinanden), mens klienten cacher filen i IndexedDB i 14 dage
    // (TTL_PULS_MS) — en klient med en ældre cache er derfor midlertidigt
    // uenig med serveren om hvad et givet id betyder.
    //
    // FORSØGT RETTET til r[8] (outfallId, en ægte stabil GUID fra selve
    // PULS-kilden — se update-puls.js's egen kommentar) — men RULLET
    // TILBAGE samme dag: id15-lake-matches.json, id15-kystvand-matches.json
    // og vandlob-upstream-matches.json (offline-forudberegnede ID15-match-
    // filer, bygget af scripts/id15/*.js) refererer ALLE PULS-punkter via
    // PRÆCIS dette rækkeindeks, ikke outfallId — GUID-skiftet brød derfor
    // pointsById-opslaget for ALLE tre filer på én gang, hvilket viste sig
    // som confirmedNoOutlet/"no-candidates" for stort set alle søer/
    // kystvande der er afhængige af ID15-matching (værre end fejlen det
    // skulle løse). En fuld migrering kræver enten at genköre de tre
    // scripts mod det AKTUELLE puls-data.json (så de selv outputter
    // outfallId i stedet for indeks), eller en oversættelsestabel — begge
    // dele et separat, større arbejde, IKKE gjort her. id er derfor
    // bevidst tilbage ved rækkeindekset (som streng, ikke tal — resten af
    // kodebasen behandler det allerede som en ugennemsigtig streng efter
    // denne rettelses øvrige ændringer, se handleUdloebPath()/#udlob=
    // parsing/onclick-quoting, som ALLE forbliver korrekte uanset hvilken
    // streng id rent faktisk er).
    _pulsPointsFull = rows.map((r, i) => {
      const derived = riskModel.derivePulsFields(r);
      const [, , , authIdx, areaIdx] = r;
      // NYT (rettelse af ustabil-id-fejlen ovenfor): outfallId (felt 8) er
      // den ægte stabile GUID fra PULS-kilden — bruges IKKE til at erstatte
      // id (rækkeindekset, stadig grundlaget for pointsById/id15-matching,
      // se ovenfor), men medbringes som et PARALLELT felt til alt der
      // krydser en dataopdatering: klientens favoritter (toggleFav()) og
      // badevands-favoritgruppers pulsIds (toggleBadevandFav()). pointRisks
      // (se enqueuePushNotifications()) slår op via BÅDE id og outfallId,
      // så gamle (indeks-baserede) og nye (GUID-baserede) klientreferencer
      // begge virker under overgangen. (Push for INDIVIDUELLE udløbs-
      // favoritter — det tidligere warnMap/outletHits — er fjernet efter
      // bruger-ønske 2026-08-12: push handler nu udelukkende om badesteder.)
      const outfallId = (r[8] != null && r[8] !== '') ? String(r[8]) : null;
      // NYT (bruger-krav 2026-08-20 — "samtlige puls data vi har i
      // dkvand-appen" i kommune-dashboardets udløbs-detaljepanel):
      // resten af de bagvedliggende PULS-felter (se update-puls.js's
      // filhoved for den fulde d[]-skema-liste), hidtil ALDRIG udtrukket
      // her — kun brugt internt af scripts/compute-puls-udloeb-taerskler.js
      // (reducedArea/type/sewerStructure) eller slet ikke (resten).
      //
      // ⚠️ BEVIDST UDELADT: cod (r[13]) — se scripts/merge-puls-
      // thresholds.js's `row[13] = thresholdMm`-kollision med update-puls.
      // js's NYERE cod-felt på SAMME index (opdaget 2026-08-20, afventer
      // egen rettelse): for ~70% af udløbene (dem uden et faktisk merget
      // tærskel-match) er r[13] stadig den ægte cod-værdi, men for de
      // resterende ~30% er den overskrevet af en tærskel i mm — der er
      // INGEN pålidelig måde at vide hvilken af de to r[13] rent faktisk
      // er for et givet udløb, før selve kollisionen er rettet. Resten af
      // feltnavnene nedenfor (bod/nitrogen/phosphor/normalår-sættet)
      // rammes IKKE af denne kollision (egne, urørte indices).
      return {
        id: String(i),
        outfallId,
        name: derived.name || `Udløb ${i}`,
        municipality: auths[authIdx] || '—',
        waterArea: areas[areaIdx] || 'Ukendt',
        lat: derived.lat, lng: derived.lng,
        meanVolumePerEvent: derived.meanVolumePerEvent,
        overflowProbBase: derived.overflowProbBase,
        thresholdMm: derived.thresholdMm,
        // NYT (bruger-ønske 2026-07-25): se derivePulsFields()'s filhoved —
        // bruges af badevandRisk.computeBadevandRiskCascade() til at
        // udelukke bekræftede regnvandsudløb fra bakteriel/viral-risikoen.
        isWastewater: derived.isWastewater,
        // NYT (bruger-ønske — kommune-benchmark-rapportens datakvalitets-KPI,
        // se computeKommuneBenchmark()): qualityCode fra PULS-grunddata,
        // se derivePulsFields()'s filhoved.
        dataQuality: derived.dataQuality,
        // NYT (bruger-krav 2026-08-20) — rå stamdata, kun til visning
        // (indgår ikke i nogen risikoberegning):
        volumeM3: r[5] ?? null,               // seneste registrerede års udledte volumen (m³)
        eventsPerYear: r[6] ?? null,           // seneste registrerede års antal overløbshændelser
        reducedArea: r[9] ?? null,             // reduceret (befæstet) opland, hektar
        type: r[10] ?? null,                   // udløbstype, allerede menneskelæsbar tekst fra PULS-kilden
        sewerStructure: r[11] ?? null,         // kloaksystem-kode (SE/SF m.fl. — se PULS_NO_WASTEWATER_CODES)
        latestDischargeYear: r[12] ?? null,
        bod: r[14] ?? null,                    // biokemisk iltforbrug, kg/år
        nitrogen: r[15] ?? null,               // kg/år
        phosphor: r[16] ?? null,               // kg/år
        normalYear: r[17] ?? null,             // MST's normalårs-referenceperiode
        normalVol: r[18] ?? null,
        normalEv: r[19] ?? null,
        normalCod: r[20] ?? null,
        normalBod: r[21] ?? null,
        normalNitrogen: r[22] ?? null,
        normalPhosphor: r[23] ?? null,
      };
    });
    console.log(`loadPulsPointsFull: ${_pulsPointsFull.length} PULS-punkter indlæst til push-evaluering`);
  } catch (e) {
    console.warn('loadPulsPointsFull fejlede:', e.message);
    _pulsPointsFull = [];
  }
  return _pulsPointsFull;
}

// NYT (bruger-ønske 2026-07-26): koordinat -> bathingwat-ID-opslag for
// vp3_badevand.geojson, indlæst/cachet én gang — bruges af
// enqueuePushNotifications() til at slå en favoriseret badested-gruppes
// gemte lat/lng (se getBadevandFavGroups() i dansk-overloeb-kort.html) op
// mod det FAKTISKE, allerede spildevands-filtrerede resultat fra
// badevandRisk.computeBadevandRiskCascade(), i stedet for kun at genberegne
// en simpel, ufiltreret max-værdi over den gemte 15 km-udløbsliste.
// Nøglet på 4 decimaler (samme afrunding som klientens egen favKey, se
// toggleBadevandFav()) — lat/lng stammer fra PRÆCIS samme GeoJSON-feature,
// så et eksakt (afrundet) match er pålideligt.
let _badevandCoordIndex = null;
function getBadevandCoordIndex() {
  if (_badevandCoordIndex) return _badevandCoordIndex;
  _badevandCoordIndex = new Map();
  try {
    const raw  = fs.readFileSync(path.join(STATIC_DIR, 'vp3_badevand.geojson'), 'utf8');
    const data = JSON.parse(raw);
    for (const f of data.features || []) {
      const coords = f.geometry?.coordinates;
      const id = f.properties?.bathingwat ?? f.properties?.ov_id ?? f.properties?.id ?? null;
      if (!coords || id == null) continue;
      const key = `${coords[1].toFixed(4)}:${coords[0].toFixed(4)}`; // lat:lng
      _badevandCoordIndex.set(key, String(id));
    }
  } catch (e) {
    console.warn('getBadevandCoordIndex fejlede:', e.message);
  }
  return _badevandCoordIndex;
}

// NYT (bruger-ønske): modsat retning af ovenstående — bathingwat-ID -> egne,
// server-kendte koordinater. Bruges af POST /api/badested-observation til at
// afgøre om en indsender er fysisk ved DET badested, der vurderes (se
// badested-observations.js's MAX_VURDERINGER_PER_IP_PER_DAY_NEAR_BADESTED) —
// badestedets koordinat hentes HERFRA, aldrig fra klienten, så kun brugerens
// EGEN GPS-position er et klient-leveret tal i den sammenligning.
let _badevandIdCoordIndex = null;
function getBadevandIdCoordIndex() {
  if (_badevandIdCoordIndex) return _badevandIdCoordIndex;
  _badevandIdCoordIndex = new Map();
  try {
    const raw  = fs.readFileSync(path.join(STATIC_DIR, 'vp3_badevand.geojson'), 'utf8');
    const data = JSON.parse(raw);
    for (const f of data.features || []) {
      const coords = f.geometry?.coordinates;
      const id = f.properties?.bathingwat ?? f.properties?.ov_id ?? f.properties?.id ?? null;
      if (!coords || id == null) continue;
      _badevandIdCoordIndex.set(String(id), { lat: coords[1], lng: coords[0] });
    }
  } catch (e) {
    console.warn('getBadevandIdCoordIndex fejlede:', e.message);
  }
  return _badevandIdCoordIndex;
}

// Kører EFTER hver warmCache()-opdatering (se de tre kaldssteder nedenfor) —
// ALDRIG på en selvstændig timer, for at undgå at evaluere på forældet vejr,
// og for at undgå gentagne/overflødige kørsler mellem reelle datafriskninger.
// RETTET: brugte tidligere en ekstra "hasRain"-port (forecastMM/todayMM >
// 5mm) oveni selve risikotærsklen — men risikoen (foreRisk) inkluderer
// allerede korrekt henfaldsvægtet nedbør (antecedentMM). Et reelt fund
// (foreRisk=0,835) blev filtreret fra, fordi det havde regnet for et par
// dage siden, men var tørt lige nu/i nærmeste prognose. Nu er ren risiko
// (foreRisk > minRisk) det ENESTE filter — se checkFavNotifications() i
// dansk-overloeb-kort.html, som SKAL holdes i sync med denne ændring.
// NYT: `testThresholds` er UDELUKKENDE til manuel afprøvning via
// /api/push/evaluate-now?test=1 (se routen nedenfor) — når parameteren
// udelades (som ved ALLE periodiske/automatiske kald, se de tre
// warmCache()-kædede kaldssteder), bruges de rigtige produktionstærskler
// (0,35 risiko / 5mm regn) helt uændret. Formålet er at kunne bekræfte
// hele find-og-send-kæden med en kunstigt lav tærskel, uden at kunne
// risikere at sænke tærsklen for de RIGTIGE, automatiske varsler, der går
// til jeres faktiske brugere.
// NYT: persisteret cache af FÆRDIGBEREGNET risiko pr. PULS-punkt —
// grundlaget for at flytte den tunge klient-side beregning (21.556 punkter,
// målt til 276-2244 ms pr. sidevisning, se samtalen om første-sidevisnings
// ydelse) over på serveren. Beregnes ÉN GANG pr. opdateringscyklus her,
// leveres færdigt til alle klienter via /api/risk-scores nedenfor, i stedet
// for at hver eneste klient genberegner nøjagtig det samme selv.
// RETTET: denne beregning lå tidligere UDELUKKENDE inde i
// evaluatePushNotifications(), som selv sprang HELT over, hvis ingen havde
// et push-abonnement (pushSubscriptions.size === 0) — hvilket betød ingen
// server-side risikoberegning overhovedet fandt sted for de fleste
// installationer. Beregningen kører nu ALTID; kun selve push-AFSENDELSEN
// (nederst i funktionen) forbliver betinget af at der findes abonnenter.
let riskScoresCache = { ts: 0, points: [] };
// NYT: se badevand-risk.js — { ts, lakes, kystvande, badevand }
let badevandRiskCache = { ts: 0, lakes: {}, kystvande: {}, badevand: [] };

// RETTET (bruger-krav 2026-08-20 — "må aldrig kun stå i hukommelsen, skal
// altid kunne overleve en server-genstart"): stod tidligere KUN i
// hukommelsen (nulstillet ved hver genstart/deploy), hvilket betød det
// FØRSTE reelle bucket-skift for hvert punkt efter en genstart aldrig blev
// opdaget (shouldLogTransition() kræver en kendt forrige bucket — se dens
// filhoved i risk-model.js). Selve Map'en her er fortsat den HURTIGE
// læsesti (21.563 opslag hver 15. minut skal ikke ramme databasen for
// hvert eneste punkt) — men er nu bagvedliggende af
// puls_point_last_bucket i Postgres (se overloeb-events.js), indlæst ved
// opstart (_lastBucketsHydrated nedenfor) og opdateret der HVER GANG et
// punkts bucket ændrer sig (eller ses for allerførste gang).
let lastKnownBucketByPointId = new Map();
// NYT: awaited i starten af _evaluatePushNotificationsInner() — garanterer
// at Map'en er hydreret fra Postgres FØR første sammenligning, uanset om
// den 2-sekunders opstarts-opvarmning (se WEATHER_CHECK_INTERVAL_MS's
// kaldssteder) skulle nå at køre først. Fejler indlæsningen (forbigående
// DB-hik ved opstart), fortsætter appen alligevel — Map'en forbliver da
// blot tom for DENNE proces-levetid (samme "en forbigående fejl skal ikke
// stoppe alt andet"-princip som resten af appen), og retter sig selv ved
// næste succesfulde genstart.
// RETTET: afventer eksplicit overloebEvents.ready (CREATE TABLE) FØRST —
// uden dette kunne loadAllLastBuckets()' SELECT i sjældne tilfælde nå at
// fyre af, før tabellen overhovedet var oprettet (begge køres synkront ved
// modul-indlæsning, men CREATE TABLE'ens netværkskald resolver ikke
// nødvendigvis før dette løber), og fejle med "relation does not exist".
let _lastBucketsHydrated = overloebEvents.ready
  .then(() => overloebEvents.loadAllLastBuckets())
  .then(map => { lastKnownBucketByPointId = map; console.info(`overloeb-events: ${map.size} kendte bucket-tilstande indlæst fra Postgres`); })
  .catch(e => console.warn('overloeb-events: kunne ikke indlæse puls_point_last_bucket ved opstart —', e.message));

// NYT (Kommune Dashboard-udvidelse, "Overløb"-fanen, bruger-krav: "live med
// en socketforbindelse ... automatisk opdateres hver gang der er en
// opdatering af overløbenes status") — Server-Sent Events, ikke en rå
// WebSocket/`ws`-pakke: kræver ingen ny npm-afhængighed, virker over den
// eksisterende cookie-session (EventSource sender cookies automatisk for
// samme origin), og har indbygget gen-forbindelse i browseren. Sender KUN
// en let ping (intet payload) — klienten genhenter selv GET /admin/api/
// overloeb-status med sin AKTUELT valgte horisont (nu/24h/72h), så push og
// visning aldrig kan komme til at afvige fra hinanden.
const overloebStreamClients = new Set();
function broadcastOverloebUpdate() {
  for (const res of overloebStreamClients) {
    try { res.write('event: overloeb-updated\ndata: {}\n\n'); }
    catch (e) { overloebStreamClients.delete(res); }
  }
}

// NYT (Kommune Dashboard-udvidelse, "Skilte"-fanen — bruger-ønske
// 2026-08-19: "en live socket forbindelse til serveren hvor badevands-
// informationen opdateres hvert 15. minut") — SAMME content-frie SSE-ping-
// mønster som broadcastOverloebUpdate() ovenfor, men en BEVIDST SEPARAT
// Set/funktion: denne er OFFENTLIG (intet requireTenantSession, se
// GET /skilt/:slug og GET /api/badevand-risk-stream nedenfor) — en anden
// tillidsgrænse end kommune-dashboardets egen strøm, selvom begge udløses
// fra samme sted (se kaldestedet nedenfor, lige ved siden af
// broadcastOverloebUpdate()'s eget kald).
const badevandSignStreamClients = new Set();
function broadcastBadevandSignUpdate() {
  for (const res of badevandSignStreamClients) {
    try { res.write('event: badevand-updated\ndata: {}\n\n'); }
    catch (e) { badevandSignStreamClients.delete(res); }
  }
}
// NYT (bruger-ønske 2026-08-17 — "Badestedsvurdering"-sektionen på
// /badested/:slug, se seo-pages.js's buildSsrContent()): badested_id (streng)
// -> antal vurderinger seneste 30 dage. Bevidst PRÆ-BEREGNET og genopfrisket
// periodisk (se refreshVurderingCount30dCache()/VURDERING_COUNT_REFRESH_MS
// nedenfor), IKKE et pr.-request DB-opslag — /badested/:slug-routen er i
// dag fuldt synkron og læser kun in-memory caches, og bliver crawlet på
// tværs af ~2.000 URL'er; at hænge et Postgres-kald på hver af de requests
// ville lægge en uforsvarlig, burst-agtig belastning på den delte
// forbindelses-pool (se db.js), præcis når en re-indekserings-crawl kører.
// Tom Map indtil første opfriskning er kørt (se Promise.all-blokken
// nederst i filen) — badesteder viser da 0 vurderinger, aldrig en fejl.
let vurderingCount30dCache = new Map();
// NYT (bruger-ønske 2026-08-10 — /badested/:slug m.fl.): badevandRiskCache.badevand
// er et ARRAY (1.039 elementer) — de nye path-baserede sider slår et enkelt
// badested op PR. CRAWL-HIT, så et O(1)-Map-opslag er værd at holde ved siden
// af arrayet, i stedet for at gentage en lineær .find() pr. request.
// Genopbygges sammen med badevandRiskCache selv, se evaluatePushNotifications().
let badevandByIdCache = new Map();
// NYT (Kommunepakke, modul 6): den RÅ, UPATCHEDE badevand-liste fra seneste
// cascade-kørsel — ADSKILT fra badevandRiskCache.badevand/badevandByIdCache,
// som ALTID er DENNE + eventuelle aktive overstyringer patchet OVENPÅ (se
// applyLiveOverridesToCache() nedenfor). Uden denne rå kilde ville en
// tilbagekaldt overstyring IKKE kunne genskabe de oprindelige bact/viral-tal
// — badested-overrides.js's patchBadevandEntry() ERSTATTER dem, den husker
// dem ikke selv, så et andet patch-kald på et ALLEREDE patchet resultat ville
// (uden en frisk, ren kilde at patche FRA hver gang) fastlåse den syntetiske
// overstyrings-værdi permanent, selv efter tilbagekaldelse.
let _rawBadevandCascade = [];

/**
 * Genanvendes af override-oprettelses-/rydnings-ruterne (se dem nedenfor)
 * til at patche den LIVE cache SYNKRONT, med det samme — uden at vente på
 * næste periodiske cyklus (~15 min). "Under 10 sekunder"-kravet er ellers
 * ikke reelt. Patcher ALTID fra _rawBadevandCascade (den rene kilde),
 * ALDRIG fra den allerede patchede badevandRiskCache.badevand — se dens
 * egen kommentar for hvorfor. Rører BEVIDST kun .badevand — ts/lakes/
 * kystvande forbliver uændrede (en overstyring er IKKE en frisk model-
 * beregning, at bumpe ts her ville vildledende antyde det).
 */
async function applyLiveOverridesToCache() {
  const patched = await badestedOverrides.applyActiveOverrides(_rawBadevandCascade);
  badevandRiskCache = { ...badevandRiskCache, badevand: patched };
  badevandByIdCache = new Map(patched.map(b => [String(b.id), b]));
}

// NYT: se water-classification.js for fuld begrundelse. Beregnes ÉN GANG
// her (ikke pr. opdateringscyklus som vejr/risiko — geometrien ændrer sig
// praktisk talt aldrig, kun ved en manuel VP3-dataopdatering), og slås op
// pr. punkt, når /api/risk-scores bygges nedenfor.
let waterFlagsCache = null;
async function ensureWaterFlagsCache() {
  // NYT: kun EGENTLIGT vellykkede resultater "låser" cachen (undgår
  // genberegning hver 15. minut, unødvendigt for statisk geometri). Et
  // tomt resultat (fil manglede/fejlede) forsøges IGEN ved næste kald —
  // billigt hvis fejlen er permanent (fx en glemt Dockerfile-linje, retter
  // sig alligevel kun ved redeploy/genstart), men lader en forbigående
  // fejl (kortvarig filsystem-hikke) rette sig selv i stedet for at
  // fastfryse en tom cache resten af serverens levetid.
  if (waterFlagsCache && waterFlagsCache.size > 0) return;
  try {
    const points = loadPulsPointsFull().map(p => ({ id: p.id, lat: p.lat, lng: p.lng }));
    // RETTET (forårsagede fuld serverfrysning — se water-classification.js
    // filhoved): brugte tidligere den SYNKRONE computeWaterFlags(), som
    // blokerede hele Node-processen (og dermed ALLE brugeres HTTP-
    // forespørgsler samtidig) i så lang tid beregningen tog. Bruger nu den
    // ikke-blokerende, portionsvise udgave, der løbende giver kontrollen
    // tilbage til event loopet.
    waterFlagsCache = await waterClass.computeWaterFlagsAsync(points, STATIC_DIR);
  } catch (e) {
    console.warn('ensureWaterFlagsCache fejlede:', e.message);
    waterFlagsCache = new Map(); // tomt kort — isWater falder tilbage til undefined, klienten falder videre tilbage til lokal beregning
  }
}

// RETTET (produktionshændelse, opdaget lige efter deploy af
// ensureFreshRiskCaches() nedenfor): denne funktion havde INGEN
// reentrancy-lås — modsat warmCache()'s egen warmRunning-mønster.
// warmCache() selv var korrekt beskyttet, men INTET forhindrede flere
// SAMTIDIGE kald til evaluatePushNotifications() — én fra de tre
// warmCache()-kædede periodiske kaldssteder nedenfor (2s/10s/interval), én
// fra ensureFreshRiskCaches()'s nye on-demand kold-cache-opvarmning, som
// typisk rammer PRÆCIS samme 2-10 sekunders vindue efter en deploy. Hvert
// overlappende kald gentog UAFHÆNGIGT 21.600 punkters risikoberegning +
// hele badevands-kaskaden — og ensureWaterFlagsCache()'s egen
// "kun-vellykket-resultat-låser"-tjek (se ovenfor) er ikke atomisk imod et
// samtidigt kald, så selv den engangs-beregning kunne udløses flere gange.
// På en delt vCPU (Fly.io) spiralerede det: observeret badevand-risk-tid
// 12s → 26s → 43s, water-classification genkørt og målt til 89s — imens
// var HELE Node-processen (single-threaded event loop) så optaget, at selv
// /api/health blev uansvarlig i flere minutter. Samme mønster som
// water-classification.js's egen tidligere "fuld serverfrysning"-fejl (se
// ensureWaterFlagsCache()'s kommentar), blot forårsaget af et andet
// manglende lås. Rettet identisk til warmCache()'s warmRunning-mønster:
// et samtidigt kald genbruger nu det allerede kørende kalds promise, i
// stedet for at starte endnu en parallel kørsel.
let _evalPushInFlight = null;
async function evaluatePushNotifications(testThresholds) {
  if (_evalPushInFlight) return _evalPushInFlight;
  _evalPushInFlight = _evaluatePushNotificationsInner(testThresholds).finally(() => { _evalPushInFlight = null; });
  return _evalPushInFlight;
}

// NYT (2026-08-20, event loop-blokerings-rettelse): kører
// badevandRisk.computeBadevandRiskCascade() i en engangs worker_thread i
// stedet for direkte på hovedtråden — se badevand-risk-worker.js's filhoved
// for den fulde begrundelse (45-57 sek. pr. kørsel, uden event loop-
// afgivelse undervejs i hovedparten af funktionen). points/staticDir er
// allerede rene data; currentPoints sendes som `[...grid.values()]` (de rå
// strømpunkter), IKKE selve grid-Map'en — strukturklonings-algoritmen
// (workerData bruger samme mekanisme som postMessage) bevarer Map'ens
// nøgle/værdi-par, men IKKE den bolt-på'ede `.buckets`-property
// buildCurrentGrid() sætter direkte på Map-instansen (se current-grid.js) —
// workeren genopbygger derfor sit eget, ækvivalente grid+bucket-index
// lokalt ud fra de rå punkter, i stedet for at modtage et allerede bygget
// (og dermed delvist tabt) grid.
//
// Engangs-worker pr. kald (ikke en genbrugt pool) — kørslen sker kun hvert
// 15. minut (se WEATHER_CHECK_INTERVAL_MS), så opstartsomkostningen ved en
// ny worker (typisk lav tocifret ms) er ubetydelig sammenlignet med de
// 45-57 sek. selve beregningen tager.
function runBadevandRiskCascadeInWorker(points, staticDir, grid) {
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(path.join(__dirname, 'badevand-risk-worker.js'), {
      workerData: {
        points,
        staticDir,
        currentPoints: grid ? [...grid.values()] : null,
      },
    });
    worker.once('message', (msg) => {
      done = true;
      worker.terminate();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(`badevand-risk-worker fejlede: ${msg.error}`));
    });
    worker.once('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (done) return;
      done = true;
      reject(new Error(`badevand-risk-worker afsluttede uventet (kode ${code})`));
    });
  });
}

// NYT: selve arbejdet, uændret fra før — kun kaldt via låsen ovenfor.
// BEMÆRK: hvis dette kald genbruger et allerede kørende kald (låsen ovenfor
// slog til), IGNORERES dette kalds testThresholds stiltiende — accepteret
// afvejning, da det kun rammer den sjældne, manuelle /api/push/evaluate-now
// (se dens rute nedenfor), og kun i det korte vindue hvor en automatisk
// cyklus allerede kører. Uendeligt bedre end det alternativ, dette retter.
async function _evaluatePushNotificationsInner(testThresholds) {
  const points = loadPulsPointsFull();
  if (points.length === 0) return;

  // RETTET og genindsat: se ensureWaterFlagsCache() — bruger nu den
  // ikke-blokerende udgave, som ikke længere kan fryse serveren.
  await ensureWaterFlagsCache();
  // NYT (bruger-krav 2026-08-20): garanterer at lastKnownBucketByPointId er
  // hydreret fra Postgres FØR nogen sammenligning nedenfor — se
  // _lastBucketsHydrated's filhoved. Resolver øjeblikkeligt efter første
  // vellykkede (eller mislykkede) opstartsindlæsning.
  await _lastBucketsHydrated;

  const minRisk   = testThresholds?.minRisk   ?? 0.35;

  const warnPoints = [];
  const pointRisks = new Map();
  // NYT: fuld liste til /api/risk-scores — bact/viral BÅDE nu og prognose,
  // for hvert punkt, uanset om det krydser nogen varslingstærskel. Klienten
  // erstatter sin egen computeRisk()/computeViralRisk()-løkke med denne.
  const allPointRisks = [];
  // NYT (Overløb-fanen, hændelseslog) — samlet HER, ét bulk-INSERT efter
  // løkken, ikke ét pr. punkt. Se overloeb-events.js's filhoved.
  const bucketTransitions = [];
  // NYT (bruger-krav 2026-08-20) — punkter hvis bucket ændrede sig ELLER ses
  // for allerførste gang denne cyklus, til puls_point_last_bucket
  // (holdbarhed på tværs af genstarter) — se upsertLastBuckets(). Bredere
  // end bucketTransitions ovenfor (som kun tager RIGTIGE skift, ikke
  // førstegangs-observationer, se shouldLogTransition()).
  const bucketPersistUpdates = [];

  let cellMatched = 0, cellMissing = 0;
  let maxForecastMMSeen = 0, maxTodayMMSeen = 0, maxForeRiskSeen = 0;

  for (const pt of points) {
    const key = riskModel.cellKey(pt.lat, pt.lng);
    const cached = weatherCache.get(key);
    const w = cached ? cached.data : null;
    if (!w) { cellMissing++; continue; } // ingen vejrdata for denne celle endnu
    cellMatched++;

    const precipMM    = w.antecedentMM ?? null;
    const todayMM      = w.todayMM ?? null;
    const forecastMM   = w.forecastMM ?? null;
    const lastEventAge = riskModel.estimateLastEventAge(w.hourlyWeek);

    const riskInput = {
      overflowProbBase: pt.overflowProbBase,
      meanVolumePerEvent: pt.meanVolumePerEvent,
      thresholdMm: pt.thresholdMm,
      precipMM, forecastMM, lastEventAge,
    };
    // NYT: beregner nu ogsÅ "nu"-risikoen (uden prognose-tillæg), ikke kun
    // foreRisk — det er DEN, klientens hovedtal ("Samlet forureningsrisiko")
    // faktisk viser i dag, ikke prognoseværdien.
    const nowResult      = riskModel.computeRisk(riskInput);
    const nowViralRisk   = riskModel.computeViralRisk(riskInput);
    const foreRisk        = riskModel.computeForecastRisk(riskInput);
    const foreViralRisk   = riskModel.computeForecastViralRisk(riskInput);

    // NYT (Overløb-fanen, hændelseslog) — KUN "nu"-risikoen (nowResult),
    // ALDRIG foreRisk/foreRisk72h herunder — prognosehorisonterne skifter
    // konstant uden at noget reelt er indtruffet, og ville forurene loggen
    // med støj. Se overloeb-events.js's shouldLogTransition() for hvorfor
    // den allerførste observation af et punkt (prevBucket undefined) IKKE
    // logges som et skift.
    const ovlBucket = riskModel.riskBucket(nowResult.risk);
    const ovlPrevBucket = lastKnownBucketByPointId.get(pt.id);
    if (riskModel.shouldLogTransition(ovlPrevBucket, ovlBucket)) {
      bucketTransitions.push({
        pointId: pt.id,
        municipalityKey: slugIndex.normalizeKommuneKey(pt.municipality || ''),
        bucket: ovlBucket,
        prevBucket: ovlPrevBucket,
        risk: nowResult.risk,
        createdAt: Date.now(),
      });
    }
    // NYT (bruger-krav 2026-08-20): ovlPrevBucket !== ovlBucket dækker BÅDE
    // et rigtigt skift OG et punkt set for allerførste gang (ovlPrevBucket
    // undefined) — begge skal persisteres, ellers gentager hukommelses-
    // tab-problemet sig for netop førstegangs-punkter ved næste genstart.
    if (ovlPrevBucket !== ovlBucket) {
      bucketPersistUpdates.push({ pointId: pt.id, bucket: ovlBucket, updatedAt: Date.now() });
    }
    lastKnownBucketByPointId.set(pt.id, ovlBucket);
    // NYT (Kommune Dashboard-udvidelse, "Overløb"-fanens 72h-prognose) —
    // samme computeForecastRisk()-funktion, blot fodret med den 72h-summede
    // nedbørsprognose (w.forecastMM72h, se computeMetrics() ovenfor) i
    // stedet for den 24h-summede. Kun bakteriel (ikke viral) — matcher
    // præcis den eksisterende konvention for udløbs-varselsringe på
    // hovedkortet, som også kun bruger foreRisk (bakteriel), aldrig viral.
    const foreRisk72h = riskModel.computeForecastRisk({ ...riskInput, forecastMM: w.forecastMM72h ?? null });
    // NYT: sat DIREKTE på selve punktet (ikke kun i allPointRisks/
    // pointRisks nedenfor), så badevandRisk.computeBadevandRiskCascade()
    // kan bruge SAMME `points`-array uden at genopbygge det — det array
    // har allerede name/waterArea/municipality, som kun mangler i de to
    // andre, mere begrænsede datastrukturer.
    pt.riskScore  = nowResult.risk;
    pt.viralScore = nowViralRisk;
    // RETTET: foreRisk/foreViralRisk blev tidligere KUN gemt i de lokale
    // pointRisks/allPointRisks-strukturer nedenfor, ikke sat direkte på pt
    // selv — i modsætning til riskScore/viralScore/algaeScore lige ovenfor.
    // badevandRisk.computeBadevandRiskCascade() (se badevand-risk.js) læser
    // udelukkende felter direkte på pt via samme points-array, og kunne
    // derfor ikke se prognosen overhovedet — den forsvandt stille fra
    // sø-/kystvand-tooltippen ved server-omlægningen af badevands-risiko.
    pt.foreRisk      = foreRisk;
    pt.foreViralRisk = foreViralRisk;

    // NYT: se risk-model.js's computeAlgaeRisk() filhoved — alt dette har
    // brug for var allerede hentet server-side (CMEMS-temp, 7-dages
    // nedbør, glidende lufttemperatur-gennemsnit), kun selve
    // beregningen manglede at blive flyttet fra klienten.
    let algaeScore = null;
    const isWaterPt = waterFlagsCache?.get(pt.id);
    let waterTemp = null;
    if (isWaterPt && currentsCache.grid) {
      const c = getCurrentAtServer(pt.lat, pt.lng, currentsCache.grid);
      if (c && c.temp != null) waterTemp = c.temp;
    }
    if (waterTemp === null && w.recentAirTempAvg != null) {
      waterTemp = riskModel.computeFreshwaterTemp(w.recentAirTempAvg);
    }
    if (waterTemp !== null) {
      algaeScore = riskModel.computeAlgaeRisk({ totalRain7d: w.totalRain7d, volumeM3Year: pt.volumeM3Year, waterTemp });
    }
    pt.algaeScore = algaeScore;
    if ((forecastMM || 0) > maxForecastMMSeen) maxForecastMMSeen = forecastMM || 0;
    if ((todayMM || 0) > maxTodayMMSeen) maxTodayMMSeen = todayMM || 0;
    if ((foreRisk || 0) > maxForeRiskSeen) maxForeRiskSeen = foreRisk || 0;

    const riskEntry = {
      id: pt.id, outfallId: pt.outfallId, name: pt.name, municipality: pt.municipality, waterArea: pt.waterArea,
      foreRisk, foreViralRisk, forecastMM, todayMM,
      // NYT (bruger-ønske 2026-07-26): se derivePulsFields()'s filhoved i
      // risk-model.js — bruges af enqueuePushNotifications() til at
      // udelukke bekræftede regnvandsudløb fra badested-favoritters
      // prognose-baserede varsling, samme filter som badevand-risk.js's
      // "nu"-beregning allerede respekterer.
      isWastewater: pt.isWastewater,
    };
    // NYT (ustabil-id-rettelse — se loadPulsPointsFull()): registreres
    // under BEGGE id'er, samme objekt, så et opslag fra en klient (som nu
    // kan sende enten det gamle rækkeindeks eller den nye stabile
    // outfallId — se toggleFav()/toggleBadevandFav()) rammer uanset hvilket.
    pointRisks.set(String(pt.id), riskEntry);
    if (pt.outfallId) pointRisks.set(pt.outfallId, riskEntry);

    allPointRisks.push({
      id: pt.id,
      riskScore: nowResult.risk,   // null hvis noData
      viralScore: nowViralRisk,
      algaeScore,  // NYT: se risk-model.js's computeAlgaeRisk() — tidligere kun beregnet klient-side
      foreRisk, foreViralRisk, foreRisk72h,
      noData: nowResult.noData,
      isWater: waterFlagsCache?.get(pt.id),  // NYT: undefined hvis cachen ikke kunne bygges — klienten falder tilbage til lokal beregning i så fald
      // NYT (Kommune Dashboard-udvidelse, "Overløb"-fanen) — lat/lng/
      // municipality/isWastewater/name var tidligere IKKE med her (kun i
      // pointRisks/riskEntry ovenfor) — tilføjet så overloeb-status.js kan
      // kommune-scope og plotte punkterne direkte fra denne allerede
      // cachede liste, uden selv at skulle genindlæse loadPulsPointsFull().
      lat: pt.lat, lng: pt.lng, municipality: pt.municipality, isWastewater: pt.isWastewater, name: pt.name,
      // NYT (Kommune Dashboard-udvidelse, udløbs-detaljepanel) — waterArea/
      // dataQuality til stamdata-visning, weatherKey (samme 0,25°-gitter-
      // celle som resten af appen, se riskModel.cellKey()) så klienten kan
      // hente den offentlige 7-dages nedbørsgraf (GET /api/weather/weekly)
      // uden selv at skulle genimplementere cellKey()-beregningen en tredje
      // gang (server.js/dansk-overloeb-kort.html har den allerede hver for sig).
      waterArea: pt.waterArea, dataQuality: pt.dataQuality, weatherKey: riskModel.cellKey(pt.lat, pt.lng),
      // RETTET: forecastMM/todayMM manglede her fra sidste feature —
      // overloeb-status.js's udloeb[].forecastMM/todayMM (vist i "Udløb med
      // aktive varsler"-listen) læste dermed altid `pt.forecastMM`/`pt.
      // todayMM` som undefined→null, og viste stille "0.0 mm" for begge felter
      // uanset faktisk nedbør. Begge er allerede i scope i denne løkke (`w.
      // forecastMM`/`w.todayMM`, se riskInput ovenfor).
      forecastMM, todayMM,
      // RETTET: meanVolumePerEvent manglede her fra sidste feature —
      // /admin/api/overloeb-prioriteret's "størst estimeret udledning"-
      // sortering slog altid op i denne (`riskScoresCache.points`), fandt
      // undefined, og satte estimeretLiterTotal:null for ALLE udløb — den
      // sorteringsmulighed var derfor reelt ikke-funktionel. pt.
      // meanVolumePerEvent er allerede i scope (bruges i riskInput ovenfor).
      meanVolumePerEvent: pt.meanVolumePerEvent,
      // NYT (bruger-krav 2026-08-20 — "samtlige puls data" i udløbs-
      // detaljepanelet): gennemstik af loadPulsPointsFull()'s rå PULS-
      // stamdata (se dens filhoved for feltbeskrivelser og hvorfor `cod`
      // bevidst IKKE er med) — samme "allerede i scope på pt"-mønster som
      // waterArea/dataQuality ovenfor.
      outfallId: pt.outfallId,
      overflowProbBase: pt.overflowProbBase,
      thresholdMm: pt.thresholdMm,
      volumeM3: pt.volumeM3, eventsPerYear: pt.eventsPerYear,
      reducedArea: pt.reducedArea, type: pt.type, sewerStructure: pt.sewerStructure,
      latestDischargeYear: pt.latestDischargeYear,
      bod: pt.bod, nitrogen: pt.nitrogen, phosphor: pt.phosphor,
      normalYear: pt.normalYear, normalVol: pt.normalVol, normalEv: pt.normalEv,
      normalCod: pt.normalCod, normalBod: pt.normalBod,
      normalNitrogen: pt.normalNitrogen, normalPhosphor: pt.normalPhosphor,
    });

    if ((foreRisk || 0) > minRisk) {
      warnPoints.push({
        id: pt.id, outfallId: pt.outfallId, name: pt.name, municipality: pt.municipality, waterArea: pt.waterArea,
        foreRisk, forecastMM, todayMM,
      });
    }
  }

  riskScoresCache = { ts: Date.now(), points: allPointRisks };

  // NYT (Overløb-fanen, hændelseslog) — ét bulk-INSERT for hele cyklussens
  // transitions. Fejler den (DB-hik), stopper resten af cyklussen IKKE —
  // samme resiliens-princip som cascade-try/catch'en lige nedenfor.
  if (bucketTransitions.length > 0) {
    try { await overloebEvents.recordTransitions(bucketTransitions); }
    catch (e) { console.warn('overloeb-events: recordTransitions fejlede —', e.message); }
  }
  // RETTET (bruger-krav 2026-08-20 — "må aldrig kun stå i hukommelsen, skal
  // altid kunne overleve en server-genstart"): persisterer den opdaterede
  // bucket for hvert ændret/førstegangs-set punkt til Postgres, se
  // lastKnownBucketByPointId's filhoved. Fejler den (DB-hik), stopper
  // resten af cyklussen IKKE — Map'en i hukommelsen er allerede opdateret
  // ovenfor, så DENNE proces' egen sammenligning næste cyklus er upåvirket;
  // kun holdbarheden på tværs af en eventuel genstart mistes midlertidigt
  // for lige netop denne cyklus' ændringer.
  if (bucketPersistUpdates.length > 0) {
    try { await overloebEvents.upsertLastBuckets(bucketPersistUpdates); }
    catch (e) { console.warn('overloeb-events: upsertLastBuckets fejlede —', e.message); }
  }

  // NYT: se badevand-risk.js filhoved — server-side gengivelse af sø-/
  // kystvand-/badevands-kaskaden, der tidligere blokerede browseren i
  // 6+ sekunder. Genbruger `points` (nu MED riskScore/viralScore sat
  // direkte, se ovenfor) — ingen ekstra vejr-/risikoberegning her.
  let cascadeResult = null;
  try {
    // RETTET (2026-08-20, event loop-blokerings-hændelse): kaldte tidligere
    // badevandRisk.computeBadevandRiskCascade() DIREKTE her, synkront på
    // hovedtråden — observeret 45-57 sek. pr. kørsel, hvoraf hovedparten af
    // funktionen (se badevand-risk-worker.js's filhoved) ALDRIG afgiver
    // kontrollen til event loopet undervejs. HELE Node-processen (HTTP +
    // pg-pool) stod derfor reelt stille i op mod et minut, hver 15. minut.
    // Kører nu i egen worker_thread — se runBadevandRiskCascadeInWorker()
    // og badevand-risk-worker.js. Selve funktionen (badevand-risk.js) er
    // 100% uændret; kun HVOR den kører er ændret.
    const result = await runBadevandRiskCascadeInWorker(points, STATIC_DIR, currentsCache.grid);
    // NYT (Kommunepakke, modul 6): _rawBadevandCascade gemmer det UPATCHEDE
    // resultat — se dens egen filhoveds-kommentar for hvorfor dette SKAL
    // holdes adskilt fra den patchede udgave (uden en ren kilde at patche
    // FRA hver gang kan en tilbagekaldt overstyring ikke genskabe de
    // oprindelige tal). computeBadevandRiskCascade() selv er 100% uændret;
    // patchningen sker UDENFOR den, FØR alt nedenfor (cache-tildeling OG
    // den daglige historik-akkumulering) — begge skal reflektere en aktiv
    // overstyring, ikke kun selve kort-farven, jf. badested-overrides.js's
    // "Injektionsprincip".
    _rawBadevandCascade = result.badevand || [];
    const patchedBadevand = await badestedOverrides.applyActiveOverrides(_rawBadevandCascade);
    result.badevand = patchedBadevand;
    badevandRiskCache = { ts: Date.now(), ...result };
    badevandByIdCache = new Map(patchedBadevand.map(b => [String(b.id), b]));
    // NYT (Skilte-fanen, live digitale skilte) — modsat broadcastOverloebUpdate()
    // (kaldt ubetinget nedenfor) er DENNE bevidst KUN inde i try-blokken:
    // badevandRiskCache blev netop lige opdateret her, en fejlet kaskade
    // (catch-grenen nedenfor) beholder den GAMLE cache uændret, og skal
    // derfor heller ikke udløse en "der er nyt"-ping til de digitale skilte.
    broadcastBadevandSignUpdate();
    cascadeResult = result; // NYT: genbruges nedenfor af enqueuePushNotifications() til badested-favoritters "nu"-risiko, se dér
    // RETTET (bruger-rapporteret 2026-08-20 — Odsherred: adskillige
    // badesteder viste 16-24 "dage uden data" i Historik-panelet, selvom
    // badestedets EGEN side samme dag viser "Lav risiko"/grønt):
    // computeBadevandRiskCascade() sætter BEVIDST bact:null/viral:null for
    // et badested UDEN bekræftet aktiv forureningskilde (source ===
    // 'ingen-bekraeftet'/'nedstroms-bekraeftet', eller 'ingen' UDEN
    // noDataMatch) — men "ingen bekræftet kilde" betyder ellers OVERALT i
    // appen "sikkert", ikke "ukendt", se colorBadevandByRisk() i dansk-
    // overloeb-kort.html (linje ~4136-4137, den kanoniske definition,
    // holdt i sync her) og riskInfo() i badested-skilt.html. Uden denne
    // patch akkumulerede BÅDE den ugentlige push-digest OG Historik-
    // panelet (app-metrics.js's buildWeeklyDigestMessage()/
    // getRollingRiskBuckets()) disse dage som "ingen data" — i modstrid
    // med badestedets egen, samtidige visning. Patches KUN til selve
    // akkumuleringen (en lokal kopi, `accumulationInput`) — IKKE
    // `result.badevand` selv, som badevandRiskCache/badevandByIdCache
    // fortsat skal vise med den oprindelige, ærlige bact:null (den
    // eksisterende source-baserede UI-logik oversætter allerede DEN
    // korrekt til "Lav risiko" ved visning). Kun FREMADRETTET — allerede
    // gemte "ingen data"-dage for disse badesteder kan ikke rettes
    // bagudrettet, da source ikke er gemt pr. dag i badevand_daily_risk.
    const accumulationInput = result.badevand.map(b => {
      const confirmedSafeNoSource = b.source === 'ingen-bekraeftet' || b.source === 'nedstroms-bekraeftet'
        || (b.source === 'ingen' && !b.noDataMatch);
      return confirmedSafeNoSource ? { ...b, bact: b.bact ?? 0, viral: b.viral ?? 0 } : b;
    });
    // NYT: akkumulerer dette tjeks bact/viral/algae/forecast pr. badested ind
    // i det persisterede daglige løbende gennemsnit — se app-metrics.js's
    // filhoved for hvorfor dette er en direkte SQL-UPSERT pr. tjek, ikke en
    // in-memory-sum der ville forsvinde ved næste genstart/deploy.
    await appMetrics.accumulateDailyBadevandRisk(accumulationInput);
  } catch (e) {
    console.warn('computeBadevandRiskCascade fejlede:', e.message);
    // Bevidst INGEN nulstilling af badevandRiskCache til tomt her — en
    // forbigående fejl beholder den seneste, gyldige beregning i stedet
    // for at slette god data. Klienten falder under alle omstændigheder
    // tilbage til lokal beregning, hvis cachen mangler/er forældet.
  }

  // NYT (Kommune Dashboard-udvidelse, "Overløb"-fanen) — riskScoresCache
  // (udløbenes risiko) er ALTID frisk her uanset om kaskaden ovenfor lykkedes,
  // så broadcastes uafhængigt af try/catch'en — kommune-dashboards skal ikke
  // gå glip af en udløbs-opdatering blot fordi badested-kaskaden fejlede.
  broadcastOverloebUpdate();

  const diagnostics = { cellMatched, cellMissing, maxForecastMMSeen, maxTodayMMSeen, maxForeRiskSeen };
  _latestDiagnostics = diagnostics; // se /api/push/evaluate-now, hvor dette rapporteres tilbage i testMode

  _latestWarnPoints = warnPoints; // samme delte tilstand som /api/push/warnpoints bruger, se Varsler-fanens øvrige endpoints
  const subCount = VAPID_PUBLIC_KEY ? await getPushSubscriptionCount() : 0;
  console.log(`evaluatePushNotifications: kørt (${points.length} punkter tjekket, ${cellMatched} matchet vejrcelle, ${cellMissing} manglede, maxForecastMM=${maxForecastMMSeen.toFixed(2)}, maxTodayMM=${maxTodayMMSeen.toFixed(2)}, maxForeRisk=${maxForeRiskSeen.toFixed(4)}, ${warnPoints.length} over tærsklen [minRisk=${minRisk}], ${subCount} abonnement(er))`);

  // NYT: selve push-AFSENDELSEN er stadig (med rette) betinget af at der
  // findes noget at sende til og en VAPID-nøgle er konfigureret — kun
  // BEREGNINGEN ovenfor blev gjort ubetinget, ikke selve udsendelsen.
  // enqueuePushNotifications() AFVENTES her (ren DB-INSERT, hurtig), men
  // flushPushQueue() (den faktiske netværksdel mod eksterne push-
  // tjenester) afventes IKKE — den periodiske risikoberegningscyklus (og
  // dermed, via denne funktions egen reentrancy-lås, NÆSTE cyklus) skal
  // ikke stå og vente på svar fra eksterne push-tjenester.
  if (VAPID_PUBLIC_KEY && subCount > 0) {
    await enqueuePushNotifications(warnPoints, pointRisks, !!testThresholds, cascadeResult);
    flushPushQueue().catch(e => console.warn('flushPushQueue (automatisk cyklus) fejl:', e.message));
  }
}

// RETTET (bruger-rapporteret: "Ingen data" ved allerførste sidevisning,
// rettet med det samme ved en manuel genindlæsning) — root cause: efter en
// deploy/genstart er riskScoresCache/badevandRiskCache tomme (ts:0) indtil
// FØRSTE warmCache()+evaluatePushNotifications()-kørsel er færdig (kan tage
// adskillige sekunder, se de tre kaldssteder nedenfor). /api/risk-scores og
// /api/badevand-risk svarede tidligere ØJEBLIKKELIGT med den tomme cache i
// dette vindue, i stedet for at vente — nøjagtig samme klasse fejl, som
// allerede blev fundet og rettet for /api/weather/all nedenfor (se dens
// kommentar), men de to ruter her manglede samme rettelse. Fly.io's
// min_machines_running=1 (se fly.toml) betyder dette vindue KUN opstår lige
// efter en `fly deploy` — men enhver bruger, der rammer akkurat dét vindue,
// oplevede "ingen data", indtil en efterfølgende automatisk opdatering eller
// en manuel genindlæsning ramte den nu-varme cache.
//
// Delt in-flight-promise (ikke bare "kald warmCache()+evaluatePushNotifications()
// direkte i hver rute") — uden denne ville hver samtidig bruger i det kolde
// vindue udløse sin EGEN fulde opvarmning parallelt (21.600 punkters
// risikoberegning + badevands-kaskaden, hver for sig), unødvendigt
// arbejdsspild og en reel risiko for at de skriver til de samme caches i
// utilsigtet rækkefølge.
let _coldCacheWarmupPromise = null;
async function ensureFreshRiskCaches() {
  if (riskScoresCache.ts !== 0 && badevandRiskCache.ts !== 0) return; // allerede varmet
  if (_coldCacheWarmupPromise) return _coldCacheWarmupPromise;
  console.log('Cache tom ved /api/risk-scores eller /api/badevand-risk — venter kort på warmCache + evaluatePushNotifications');
  _coldCacheWarmupPromise = warmCache()
    .then(() => evaluatePushNotifications())
    .catch(e => console.warn('ensureFreshRiskCaches fejl:', e.message))
    .finally(() => { _coldCacheWarmupPromise = null; });
  return _coldCacheWarmupPromise;
}

// Opvarm ved opstart (2 forsøg: 2s og 10s) og tjek derefter HYPPIGT for
// manglende/forældede celler.
//
// RETTET: den tidligere 10-sekunders-retry ("hvis cachen stadig er helt
// tom") og selve den periodiske timer (kun hver WEATHER_TTL_MS = 6 timer)
// dækkede ikke det tilfælde, hvor NOGLE (men ikke alle) celler lykkedes
// ved opstart — fx ved en kortvarig forstyrrelse hos Open-Meteo, der ramte
// de fleste, men ikke alle, af de 170 celler. Så snart blot 1-2 celler var
// varme, var cachen ikke længere "helt tom", 10-sekunders-sikkerhedsnettet
// udløste aldrig, og appen sad fast med en næsten-tom cache i op til 6
// timer — observeret som "2 ud af 170 varme celler".
//
// Løsningen er at ADSKILLE hvor ofte vi TJEKKER for manglende celler fra
// hvor LÆNGE en celle regnes som frisk (TTL). warmCache() springer allerede
// enhver stadig-frisk celle over (se skipped++ i selve funktionen) — at
// kalde den oftere koster derfor næsten intet ekstra i normal drift (næsten
// alt bliver "skipped"), men betyder at en delvis fejl retter sig selv
// inden for minutter i stedet for at kunne stå i op til 6 timer.
const WEATHER_CHECK_INTERVAL_MS = 15 * 60 * 1000;  // tjek hvert 15. minut — billigt, da fortsat-friske celler bare springes over
setTimeout(() => warmCache()
  .then(() => evaluatePushNotifications())
  .catch(e => console.warn('warmCache (2s):', e.message)), 2000);
setTimeout(() => warmCache()
  .then(() => evaluatePushNotifications())
  .catch(e => console.warn('warmCache (10s):', e.message)), 10000);
setInterval(() => warmCache()
  .then(() => evaluatePushNotifications())
  .catch(e => console.warn('warmCache (interval):', e.message)), WEATHER_CHECK_INTERVAL_MS);

// NYT (bruger-ønske 2026-08-17) — se vurderingCount30dCache's filhoved for
// hvorfor dette er præ-beregnet fremfor et pr.-request DB-kald. Time-cadence
// (ikke WEATHER_CHECK_INTERVAL_MS's 15 minutter) er rigeligt — et 30-dages
// rullende tal ændrer sig ikke mærkbart inden for en time. Kaldt fra
// Promise.all-blokken nederst i filen (efter badestedObs.ready), samme
// begrundelse som runDailyStatsSnapshotJob dér: kræver badested_vurderinger-
// skemaet, må ikke køre før det er klar.
async function refreshVurderingCount30dCache() {
  const rows = await badestedObs.getVurderingCounts30dGrouped();
  const next = new Map();
  for (const r of rows) next.set(String(r.badested_id), r.count);
  vurderingCount30dCache = next;
}
const VURDERING_COUNT_REFRESH_MS = 60 * 60 * 1000;

// NYT (bruger-krav 2026-08-20 — "Når platformen har et link til kommunens
// logo, skal ... live/iframe skilte" vise det): kommuneKey -> logo_url,
// KUN for tenants med et udfyldt logo_url. Samme "præ-beregnet cache
// fremfor pr.-request DB-kald"-princip som vurderingCount30dCache ovenfor
// — GET /skilt/:slug rammes langt hyppigere end en admin-ændring af et
// logo sker, så et opslag i denne Map (i stedet for en query pr. request)
// er den rigtige afvejning. Genopfrisket periodisk (se
// KOMMUNE_LOGO_REFRESH_MS), ikke kun ved opstart, så et nyt/ændret logo i
// admin-dashboardet slår igennem på skiltene uden en redeploy.
let kommuneLogoCache = new Map();
async function refreshKommuneLogoCache() {
  const { rows } = await query(`SELECT name, logo_url FROM tenants WHERE logo_url IS NOT NULL AND logo_url <> ''`);
  const next = new Map();
  for (const r of rows) next.set(slugIndex.normalizeKommuneKey(r.name), r.logo_url);
  kommuneLogoCache = next;
}
const KOMMUNE_LOGO_REFRESH_MS = 10 * 60 * 1000;

// NYT: leverer den server-beregnede risiko for alle PULS-punkter som ét,
// kompakt JSON-svar — se riskScoresCache (bygget i evaluatePushNotifications())
// for selve beregningen. Erstatter klientens egen computeRisk()/
// computeViralRisk()-løkke over alle 21.556 punkter (målt til 276-2244 ms
// ved første sidevisning, se samtalen om første-sidevisnings ydelse).
// ETag baseret på beregningstidspunktet — ikke selve indholdet — så
// klienter der allerede har den nyeste version får et billigt 304 i stedet
// for at hente hele svaret igen unødigt.
app.get('/api/risk-scores', async (req, res) => {
  // Se ensureFreshRiskCaches()'s filhoved — kappet ved 25 sek som
  // sikkerhedsnet (samme princip som /api/weather/all's 15 sek, men
  // rummeligere, da denne opvarmning gør markant mere arbejde: fuld
  // vejr-opvarmning OG 21.600 punkters risikoberegning OG badevands-
  // kaskaden, ikke kun vejr-hentning).
  if (riskScoresCache.ts === 0) {
    await Promise.race([ensureFreshRiskCaches(), new Promise(resolve => setTimeout(resolve, 25000))]);
  }
  const etag = `"risk-${riskScoresCache.ts}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache'); // altid revalider — data ændrer sig hvert 15. minut
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json({ ts: riskScoresCache.ts, points: riskScoresCache.points });
});

// NYT: se badevand-risk.js filhoved — server-beregnet sø-/kystvand-/
// badevands-kaskade (bakteriel+viral, IKKE alge — se begrundelse i
// badevand-risk.js). Erstatter klientens 6+ sekunders blokerende
// colorBadevandByRisk()-løkke. Samme ETag-mønster som risk-scores.
app.get('/api/badevand-risk', async (req, res) => {
  // Se ensureFreshRiskCaches()'s filhoved. Deler samme in-flight-promise
  // som /api/risk-scores ovenfor — rammer begge ruter cachen kold samtidig
  // (meget sandsynligt, da klienten henter dem parallelt, se loadAll()),
  // venter de på ÉN fælles opvarmning, ikke to.
  if (badevandRiskCache.ts === 0) {
    await Promise.race([ensureFreshRiskCaches(), new Promise(resolve => setTimeout(resolve, 25000))]);
  }
  const etag = `"bvrisk-${badevandRiskCache.ts}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  // NYT (bruger-ønske 2026-08-10 — URL-arkitektur/SEO): slug tilføjet pr.
  // badevand-entry, IKKE ved at mutere den delte badevandRiskCache selv
  // (genbruges andre steder uændret) — kun i selve JSON-svaret her. Giver
  // klienten det PRÆCISE, server-genererede slug (fra slug-index.js) for
  // hash→path-omdirigering (se dansk-overloeb-kort.html's
  // redirectBadevandHashToPath()) — klienten kan IKKE selv genudlede det
  // korrekt, da kommune-feltet (en del af slug'et for 1.033 af 1.039
  // badesteder) kun findes i badevand-analyseresultater.json, som kun
  // serveren parser.
  res.json({
    ...badevandRiskCache,
    badevand: (badevandRiskCache.badevand || []).map(b => ({ ...b, slug: idToBadestedSlug.get(String(b.id)) || null })),
  });
});

// ── Borgerobservationer (badested-observations.js) ──────────────────────────
// ⚠️ Se badested-observations.js's filhoved: disse to ruter må ALDRIG fodre
// noget ind i badevandRisk/computeBadevandRisk — eget, adskilt lag.
//
// memoryStorage (ikke diskStorage): fotoet skal først valideres (magic
// bytes, størrelse — se savePhoto() i modulet) FØR det overhovedet lander på
// disk. Ellers ville en ondsindet/fejlbehæftet upload nå at ramme volumen,
// også selvom den efterfølgende blev afvist.
const observationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: badestedObs.MAX_PHOTO_BYTES, files: 1 },
});

// RETTET: Fly.io's edge-proxy sætter 'Fly-Client-IP' direkte — mere
// pålideligt end at stole på Express' req.ip/X-Forwarded-For-parsing uden
// eksplicit 'trust proxy'-konfiguration (som IKKE er sat andetsteds i denne
// fil). Falder tilbage til socket-adressen for lokal udvikling, hvor Fly's
// header naturligvis ikke findes.
function getClientIp(req) {
  return req.headers['fly-client-ip'] || req.socket.remoteAddress || 'ukendt';
}

// Samme afstand som klientens EGEN, uafhængige "vis prompten proaktivt"-tjek
// (OBSERVATION_PROXIMITY_METERS i dansk-overloeb-kort.html) — de to bruges
// til forskellige ting (dér: UX-trigger, her: hvilken rate limit-grænse der
// gælder, se badested-observations.js), men samme fysiske betydning af
// "fysisk ved badestedet", så samme værdi. HOLD I SYNC hvis den nogensinde
// ændres et af de to steder.
const NEAR_BADESTED_METERS = 300;

// NYT (bruger-ønske): afgør om indsenderen fysisk er ved badestedet, ud fra
// GPS-koordinater klienten selv sender (userLat/userLng i req.body) —
// badestedets EGNE koordinater slås op server-side (getBadevandIdCoordIndex),
// aldrig klient-leverede, så kun brugerens egen position er et klient-tal i
// sammenligningen. Et blødt tillidssignal (se badested-observations.js's
// filhoved for MAX_VURDERINGER_PER_IP_PER_DAY_NEAR_BADESTED) — en klient,
// der taler direkte til API'et uden om selve GPS'en, kan i princippet
// forfalske userLat/userLng, ligesom rate limitingens IP-baggrund i forvejen
// kan omgås med en anden IP. Fejler stille (returnerer false) ved
// manglende/ugyldige koordinater eller ukendt badested-id.
function isNearBadested(badestedId, rawLat, rawLng) {
  const userLat = parseFloat(rawLat);
  const userLng = parseFloat(rawLng);
  if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) return false;
  if (userLat < -90 || userLat > 90 || userLng < -180 || userLng > 180) return false;
  const coords = getBadevandIdCoordIndex().get(String(badestedId));
  if (!coords) return false;
  return badevandRisk.haversineM(userLat, userLng, coords.lat, coords.lng) <= NEAR_BADESTED_METERS;
}

app.post('/api/badested-observation', (req, res) => {
  // NYT: multer kaldes MANUELT her (i stedet for som deklarativ middleware)
  // for at kunne fange dens egne fejl (fx LIMIT_FILE_SIZE, hvis fotoet
  // overskrider MAX_PHOTO_BYTES) i almindelig JSON-form — ellers ville en
  // sådan fejl aldrig nå ind i denne handler og i stedet ende som Expres'
  // egen, rå (HTML/stack trace) standardfejlside.
  observationUpload.single('photo')(req, res, async (uploadErr) => {
    if (uploadErr) {
      console.warn('badested-observation: upload-fejl —', uploadErr.message);
      return res.status(400).json({ error: 'Kunne ikke behandle foto-upload (for stort, eller ugyldigt format).' });
    }
    try {
      const { badestedId, algaeLevel, userLat, userLng } = req.body || {};
      // NYT: klienten sender flere valgte statustyper som ÉN vurdering, se
      // badested-observations.js's recordVurdering() — JSON-kodet i ét
      // formfelt (fremfor gentagne 'observationTypes[]'-felter) for at
      // undgå at skulle stole på multer/busboys array-håndtering af
      // gentagne feltnavne i multipart-formularer.
      let observationTypes;
      try {
        observationTypes = JSON.parse(req.body?.observationTypes || '[]');
      } catch (parseErr) {
        observationTypes = [];
      }
      const result = await badestedObs.recordVurdering({
        badestedId,
        observationTypes,
        algaeLevel: algaeLevel || null,
        photoBuffer: req.file ? req.file.buffer : null,
        rawIp: getClientIp(req),
        isNearBadested: isNearBadested(badestedId, userLat, userLng),
      });
      // NYT (bruger-ønske): dagens ALLERFØRSTE vurdering af et badested
      // (se _insertVurderingTxn()'s isFirstToday, badested-observations.js)
      // deles til badestedets push-abonnenter — KUN den første, for ikke at
      // spamme abonnenter ved flere indsendelser samme dag. Fejler dette
      // (fx VAPID ikke konfigureret), skal selve vurderingen stadig gemmes
      // korrekt — derfor sit eget try/catch, adskilt fra hovedstien.
      if (result.isFirstToday) {
        try { await broadcastFirstVurderingOfDay(badestedId, observationTypes, algaeLevel || null); }
        catch (e) { console.warn('broadcastFirstVurderingOfDay fejlede:', e.message); }
      }
      res.json({ ok: true, createdAt: result.createdAt });
    } catch (e) {
      if (e.code === 'RATE_LIMITED') {
        // RETTET (bruger-ønske): viste tidligere BEVIDST en helt generisk
        // besked her — begrundelsen var at undgå at lære en spam-bot
        // præcis hvor grænsen går. Omgjort efter eksplicit ønske: en ægte
        // bruger, der rammer grænsen, skal kunne se HVORFOR, ikke bare at
        // "noget gik galt". e.limit er den faktisk håndhævede grænse (5,
        // eller 50 hvis isNearBadested — se badested-observations.js).
        console.warn(`badested-observation: rate-limited (${e.message}), ip-hash=${badestedObs.hashIp(getClientIp(req)).slice(0, 12)}…, badested=${req.body?.badestedId}`);
        const msg = `Du har allerede indsendt ${e.limit || badestedObs.MAX_VURDERINGER_PER_IP_PER_DAY} vurderinger i dag — prøv igen i morgen.`;
        return res.status(429).json({ error: msg });
      }
      if (e.code === 'VALIDATION') {
        return res.status(400).json({ error: e.message });
      }
      console.error('badested-observation: uventet fejl —', e.message);
      res.status(500).json({ error: 'Kunne ikke registrere observation lige nu.' });
    }
  });
});

app.get('/api/badested-observation/:id', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');  // altid frisk — henfaldsvægten ændrer sig time for time
    res.json(await badestedObs.getObservationSummary(req.params.id));
  } catch (e) {
    console.error('badested-observation GET: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente observationer lige nu.' });
  }
});

// NYT (bruger-ønske 2026-08-20 — ugestatus/månedsstatus på badested-
// detaljesiden, samme information som den ugentlige push-digest allerede
// bygger, se app-metrics.js's buildWeeklyDigestMessage()/getRollingRiskBuckets()):
// to uafhængige DB-opslag (7/30 dage) for ÉT badested, kørt PARALLELT — ikke
// den bulk-forespørgsel getAllWeeklyBadevandHistory()/getMonthlyRiskBuckets()
// bruger (dem er designet til ALLE badesteder på én gang, til digest-jobbet
// hhv. admin-dashboardets kalendermåned).
app.get('/api/badested-history-summary/:id', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const [week, month] = await Promise.all([
      appMetrics.getRollingRiskBuckets(req.params.id, 7),
      appMetrics.getRollingRiskBuckets(req.params.id, 30),
    ]);
    res.json({ week, month });
  } catch (e) {
    console.error('badested-history-summary GET: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke hente ugestatus lige nu.' });
  }
});

// NYT (bruger-ønske 2026-08-17 — "Badestedsvurdering"-kortet i det levende
// badevand-panel, se dansk-overloeb-kort.html's renderBadestedExtras()):
// LÆSER UDELUKKENDE den allerede præ-beregnede vurderingCount30dCache
// (opfrisket hver time, se dens filhoved) — INTET Postgres-kald pr.
// request, i modsætning til /api/badested-observation/:id ovenfor. Kaldes
// ét let gang pr. panelåbning fra en rigtig besøgende, ikke pr. crawlet
// /badested/:slug-side (den bruger vurderingCount30dCache direkte,
// server-side, se app.get('/badested/:slug', …)).
app.get('/api/vurdering-count-30d/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ count: vurderingCount30dCache.get(String(req.params.id)) || 0 });
});

// Servér uploadede fotos — filnavne er altid server-genererede UUID'er (se
// savePhoto() i badested-observations.js), aldrig klient-leverede, så der
// er ingen path traversal-risiko ved direkte statisk servering.
app.use('/observation-photos', express.static(badestedObs.PHOTOS_DIR, { maxAge: '7d' }));

app.get('/api/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  const key    = gridKey(lat, lng);
  const cached = weatherCache.get(key);

  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
    cacheHitCount++;
    res.set('Cache-Control', 'public, max-age=10800');  // 3h
    res.set('X-Cache', 'HIT');
    return res.json(cached.data);
  }

  try {
    apiCallCount++;
    const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
    const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
    const raw  = await fetchOpenMeteoWithRetry(clat, clng);
    const data = computeMetrics(raw);
    weatherCache.set(key, { ts: Date.now(), data });
    res.set('Cache-Control', 'public, max-age=10800');
    res.set('X-Cache', 'MISS');
    res.json(data);
  } catch(e) {
    if (cached) { res.set('X-Cache', 'STALE'); return res.json(cached.data); }
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/debug-status — samlet, utvetydig status for ALLE server-side
// datasæt, med reelle tidsstempler. Bygget efter gentagne runder, hvor det
// var uklart om et problem sad i klientens cache, serverens cache, eller
// selve deploy-synkroniseringen — denne slags forvirring skal fremover
// kunne afklares med ét kald, ikke gætværk. Sammenlign direkte med
// klientens eget "Datakilder & cache-status"-panel (samme nøgler/navne med
// vilje, for nem side-om-side sammenligning).
app.get('/api/debug-status', async (req, res) => {
  const now = Date.now();

  // Vejr: ældste/nyeste celle i cachen, ikke kun et samlet tal
  let weatherOldest = null, weatherNewest = null, weatherWarm = 0, weatherStale = 0;
  for (const [, entry] of weatherCache) {
    if (now - entry.ts < WEATHER_TTL_MS) weatherWarm++; else weatherStale++;
    if (weatherOldest === null || entry.ts < weatherOldest) weatherOldest = entry.ts;
    if (weatherNewest === null || entry.ts > weatherNewest) weatherNewest = entry.ts;
  }

  // PULS: statisk fil, ikke en runtime-cache — relevant "friskhed" er filens
  // egen sidst-ændret-tidspunkt (hvornår update-puls.js sidst blev kørt og
  // deployet), ikke noget serveren selv genopfrisker automatisk.
  let pulsFileTs = null, pulsFileAgeHours = null;
  try {
    const stat = fs.statSync(path.join(STATIC_DIR, 'puls-data.json'));
    pulsFileTs = stat.mtimeMs;
    pulsFileAgeHours = Math.round((now - pulsFileTs) / 3600000 * 10) / 10;
  } catch(e) { /* fil findes ikke — bør ikke ske i produktion */ }

  // NYT: antal web push-abonnenter + ventende kø-jobs — begge nu Postgres-
  // forespørgsler (se push_subscriptions/push_send_queue), ét samlet
  // opslag i stedet for to separate round-trips.
  const [{ rows: subCountRows }, { rows: queueLenRows }] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`),
    query(`SELECT COUNT(*)::int AS n FROM push_send_queue`),
  ]);

  res.set('Cache-Control', 'no-store');
  res.json({
    servertid: now,
    vejr: {
      ttlTimer: WEATHER_TTL_MS / 3600000,
      varmeCeller: weatherWarm,
      forældedeCeller: weatherStale,
      ældsteCelleAlderMin: weatherOldest !== null ? Math.round((now - weatherOldest) / 60000) : null,
      nyesteCelleAlderMin: weatherNewest !== null ? Math.round((now - weatherNewest) / 60000) : null,
    },
    strøm: {
      ttlTimer: CURRENTS_TTL / 3600000,
      alderMin: currentsCache.ts ? Math.round((now - currentsCache.ts) / 60000) : null,
      forældet: currentsCache.ts ? (now - currentsCache.ts) > CURRENTS_TTL : null,
      punkter: currentsCache.grid ? currentsCache.grid.size : 0,
      genhentningIGang: currentsRefreshInFlight,
      sidsteFejl: currentsCache.error || null,
    },
    puls: {
      filAlderTimer: pulsFileAgeHours,
      filSidstÆndret: pulsFileTs,
    },
    // NYT: antal web push-abonnenter i "Datakilder & cache-status"-panelet
    // (se showDebugPanel() i dansk-overloeb-kort.html) — bruger-ønske.
    // ventendeIKø viser push_send_queue's aktuelle størrelse — normalt 0,
    // kun midlertidigt >0 mens en samtidig afsendelses-batch er i gang.
    push: {
      abonnenter: subCountRows[0].n,
      konfigureret: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      ventendeIKø: queueLenRows[0].n,
    },
  });
});

// ── GET /api/weather/all — full pre-warmed grid in one cacheable response ────
// Returns all warm cells as { "lat:lng": {antecedentMM, todayMM, forecastMM,
// totalRain7d}, ... } — hourly arrays are excluded to keep payload small.
// Browser caches with max-age=3600 (matches server TTL).
// ETag allows 304 Not Modified when data hasn't changed.
app.get('/api/weather/all', async (req, res) => {
  // Hvis cachen er tom (typisk lige efter en genstart), er serverens egen
  // warmCache() markant hurtigere end klientens fallback-metode (170 celler
  // på ~2 sek ved 10 samtidige kald, mod klientens egen 1-2 minutter ved kun
  // 4 samtidige kald). Vent derfor kort på den, i stedet for straks at sende
  // en tom cache og tvinge klienten ud i den langsomme vej.
  // Kappet ved 15 sek som sikkerhedsnet, hvis Open-Meteo selv skulle være
  // usædvanligt langsom — så falder vi tilbage til at svare med hvad end vi
  // har, fremfor at lade klienten vente i det uendelige.
  if (weatherCache.size === 0) {
    console.log('Cache tom ved /api/weather/all — venter kort på warmCache');
    await Promise.race([
      warmCache().catch(e => console.warn('warmCache fejl:', e.message)),
      new Promise(resolve => setTimeout(resolve, 15000)),
    ]);
  }

  const out = {};
  let warm = 0, stale = 0, maxTs = 0;

  for (const [key, entry] of weatherCache) {
    if (Date.now() - entry.ts < WEATHER_TTL_MS) {
      // Strip hourly arrays — client fetches /hourly on demand
      const { hourlyObs: _o, hourlyFore: _f, ...slim } = entry.data;
      out[key] = slim;
      warm++;
      cacheHitCount++;
      if (entry.ts > maxTs) maxTs = entry.ts;
    } else {
      stale++;
    }
  }

  // RETTET: ETag var tidligere KUN baseret på antal varme celler
  // (`"w${warm}"`) — men det tal ændrer sig stort set aldrig mellem
  // opdateringscyklusser (samme ~170 danske gittterceller varmes op hver
  // gang), selvom selve VÆRDIERNE indeni har ændret sig fuldstændigt.
  // Browseren ville derfor få et 304 Not Modified-svar og blive ved med at
  // vise sin egen, lokalt cachede (og efterhånden forældede) kopi —
  // UAFHÆNGIGT af appens egen IndexedDB-cache, da dette er et separat,
  // lavere HTTP-cache-lag, som ikke ryddes ved at rydde app-data. Tilføjer
  // nu det seneste faktiske opdateringstidspunkt til ETag'en, så den
  // ÆNDRER SIG, hver gang mindst én celle reelt er blevet opdateret.
  const etag = `"w${warm}-${maxTs}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  // no-cache: browser revaliderer altid via ETag.
  // Forhindrer at en tom {} respons fra cold-start caches i 3 timer.
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', etag);
  res.set('X-Warm-Cells',  String(warm));
  res.set('X-Stale-Cells', String(stale));
  res.json(out);
});

// ── GET /api/weather/weekly?key= — 7-day hourly arrays for bathing water detail
app.get('/api/weather/weekly', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });

  let cached = weatherCache.get(key);

  // Exact cache miss — try nearest cached cell (badevand may be in uncached coastal cell)
  if (!cached || Date.now() - cached.ts >= WEATHER_TTL_MS) {
    const parts = key.split(':');
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'invalid key' });

    // Find nearest warm cell in cache
    let minDist = Infinity;
    for (const [k, entry] of weatherCache) {
      if (Date.now() - entry.ts >= WEATHER_TTL_MS) continue;
      const [kLat, kLng] = k.split(':').map(Number);
      const d = Math.hypot(kLat - lat, kLng - lng);
      if (d < minDist) { minDist = d; cached = entry; }
    }

    // If still no cached cell or too far away (>0.5° ≈ 55km), fetch directly
    if (!cached || minDist > 0.5) {
      try {
        apiCallCount++;
        const raw  = await fetchOpenMeteoWithRetry(lat, lng);
        const data = computeMetrics(raw);
        weatherCache.set(key, { ts: Date.now(), data });
        cached = { data };
      } catch(e) {
        return res.status(502).json({ error: `Open-Meteo: ${e.message}` });
      }
    }
  }

  const d = cached.data;
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    hourlyObs:   d.hourlyObs  || [],
    hourlyFore:  d.hourlyFore || [],
    hourlyWeek:  d.hourlyWeek || [],
    todayMM:     d.todayMM,
    forecastMM:  d.forecastMM,
    totalRain7d: d.totalRain7d,
    // RETTET: recentAirTempAvg manglede tidligere helt i dette svar.
    // NYT: todayMaxAirTemp — se computeMetrics() for hvorfor gennemsnittet
    // alene ikke er retvisende at VISE til en badegæst (det er fortsat
    // korrekt til den interne vandtemperatur-ESTIMERING, som beholder
    // gennemsnittet uændret via recentAirTempAvg).
    recentAirTempAvg: d.recentAirTempAvg,
    todayMaxAirTemp:  d.todayMaxAirTemp,
    hourlyTempWeek:   d.hourlyTempWeek || [],
    // NYT: vind — samme Open-Meteo-kilde, nu udvidet med windspeed_10m/
    // winddirection_10m (se fetchOpenMeteo()).
    currentWindSpeed: d.currentWindSpeed,
    currentWindDir:   d.currentWindDir,
    // NYT: diagnostik til at afgøre om et manglende todayMaxAirTemp
    // skyldes en reel datamangel hos Open-Meteo (validTempCount lavt/0)
    // eller noget andet (validTempCount højt, men todayMaxAirTemp
    // alligevel null ville pege på en fejl i selve dato-matchingen).
    _tempDiagnostic: {
      hourlyTempWeekLength: (d.hourlyTempWeek || []).length,
      validTempCount: (d.hourlyTempWeek || []).filter(t => t !== null).length,
    },
  });
});
// Called when user clicks a point or opens a varsel card. Much cheaper than
// bundling 48 floats × 2500 cells into the main /all response.
app.get('/api/weather/hourly', (req, res) => {
  const key    = req.query.key;
  const cached = key ? weatherCache.get(key) : null;

  if (!cached || Date.now() - cached.ts >= WEATHER_TTL_MS) {
    return res.status(404).json({ error: 'Cell not in cache' });
  }

  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    hourlyObs:  cached.data.hourlyObs  || [],
    hourlyFore: cached.data.hourlyFore || [],
  });
});

// ── POST /api/weather/bulk — fallback with limited individual fetches ─────────
// Returns warm cells from cache immediately. Cold cells are fetched individually
// with concurrency=4 so the endpoint is useful even before warmCache completes.
app.use(express.json({ limit: '1mb' }));

app.post('/api/weather/bulk', async (req, res) => {
  const cells = Array.isArray(req.body?.cells) ? req.body.cells : [];
  if (cells.length === 0 || cells.length > 5000) {
    return res.status(400).json({ error: 'cells array (1–5000) required' });
  }

  const out     = {};
  const cold    = [];
  let   hits = 0, misses = 0;

  for (const cell of cells) {
    const lat = parseFloat(cell.lat), lng = parseFloat(cell.lng);
    if (isNaN(lat) || isNaN(lng)) continue;
    const key    = gridKey(lat, lng);
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
      const { hourlyObs: _o, hourlyFore: _f, ...slim } = cached.data;
      out[key] = slim;
      hits++;
      cacheHitCount++;
    } else {
      cold.push({ lat, lng, key, cached });
      misses++;
    }
  }

  // Fetch cold cells individually with limited concurrency
  if (cold.length > 0) {
    const CONC = 4;
    let idx = 0;
    async function worker() {
      while (idx < cold.length) {
        const { lat, lng, key, cached } = cold[idx++];
        try {
          apiCallCount++;
          const raw  = await fetchOpenMeteoWithRetry(lat, lng);
          const data = computeMetrics(raw);
          weatherCache.set(key, { ts: Date.now(), data });
          const { hourlyObs: _o, hourlyFore: _f, ...slim } = data;
          out[key] = slim;
        } catch(e) {
          if (cached) {
            const { hourlyObs: _o, hourlyFore: _f, ...slim } = cached.data;
            out[key] = slim;
          } else {
            out[key] = null;
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, cold.length) }, worker));
  }

  res.set('Cache-Control', 'no-store');
  res.set('X-Cache-Hits',   String(hits));
  res.set('X-Cache-Misses', String(misses));
  res.json(out);
});

// ── Save latest warnPoints for push evaluation ──────────────────────────────
// The client POSTs its computed warnPoints after each render so the server
// can send push notifications to subscribers who have matching favourites.
let _latestWarnPoints = [];
let _latestDiagnostics = {}; // se evaluatePushNotifications() — cellMatched/cellMissing/hasRainCount/maxForecastMMSeen osv.
app.post('/api/push/warnpoints', (req, res) => {
  const { warnPoints } = req.body || {};
  if (!Array.isArray(warnPoints)) return res.status(400).json({ error: 'Invalid' });
  _latestWarnPoints = warnPoints;
  // RETTET: klientens baggrunds-upload (checkFavNotifications(), kaldt ved
  // hver renderMap()) skal ikke lade HTTP-svaret vente på faktiske
  // push-afsendelser — enqueue er hurtig (rent CPU), selve afsendelsen
  // fortsætter løsrevet. Se pushSendQueue's filhoved.
  // RETTET (2026-08-20, produktionshændelse): manglede tidligere en
  // .catch() her — i modsætning til flushPushQueue() lige nedenfor.
  // enqueuePushNotifications() → getAllPushSubscriptions() → pg-pool kan
  // afvise (fx "Connection terminated unexpectedly"), og uden nogen .catch
  // ét eneste sted i kaldekæden blev det en UBEHANDLET promise-rejection —
  // som crashede hele Node-processen (og dermed ALLE samtidige brugere),
  // ikke kun dette ene request. pool.on('error', ...) i db.js fanger kun
  // fejl på en IDLE forbindelse, ikke en afvist promise fra et aktivt kald
  // som dette.
  enqueuePushNotifications(warnPoints).catch(e => console.warn('enqueuePushNotifications (warnpoints) fejl:', e.message));
  flushPushQueue().catch(e => console.warn('flushPushQueue (warnpoints) fejl:', e.message));
  res.json({ ok: true, warned: warnPoints.length });
});

// ── Web Push: VAPID public key ─────────────────────────────────────────────
// Client fetches this to create a push subscription.
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ── Web Push: save subscription ────────────────────────────────────────────
// Client POSTs its PushSubscription object here after subscribing.
// Body: { subscription: {...}, favourites: [id, ...] }
app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, favourites, badevandGroups, installId, platform } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  try {
    // RETTET: dette endpoint blev tidligere ALTID kaldt fra klientens
    // syncPushSubscription() — som selv kaldes fra toggleFav() ved HVER
    // ENESTE favorit-ændring, ikke kun ved førstegangs-tilmelding (der
    // findes ikke noget separat "opdatér blot favoritter"-kald i klienten
    // overhovedet — se dansk-overloeb-kort.html). Dette endpoint skrev
    // tidligere ubetinget notifiedState: {} ved hvert kald, hvilket i
    // praksis betød: favoriserer/fjerner en bruger favorit på ét sted,
    // nulstilles varslingshistorikken for ALLE brugerens steder på én
    // gang — uanset om selve risikoen for de øvrige, upåvirkede steder
    // overhovedet havde ændret sig.
    //
    // ON CONFLICT DO UPDATE nedenfor rører BEVIDST ikke notified_state —
    // en eksisterende rækkes varslingshistorik forbliver derfor urørt ved
    // hver ny subscribe/favorit-opdatering, kun en HELT NY subscription
    // (INSERT-grenen) starter med '{}'::jsonb. install_id/platform bevares
    // via COALESCE hvis klienten ikke sender dem med (ældre klientkode).
    await query(`
      INSERT INTO push_subscriptions (endpoint, subscription, favourites, badevand_groups, install_id, platform, notified_state)
      VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
      ON CONFLICT (endpoint) DO UPDATE SET
        subscription    = EXCLUDED.subscription,
        favourites      = EXCLUDED.favourites,
        badevand_groups = EXCLUDED.badevand_groups,
        install_id      = COALESCE(EXCLUDED.install_id, push_subscriptions.install_id),
        platform        = COALESCE(EXCLUDED.platform, push_subscriptions.platform)
    `, [
      subscription.endpoint,
      JSON.stringify(subscription),
      JSON.stringify(favourites || []),
      JSON.stringify(Array.isArray(badevandGroups) ? badevandGroups : []),
      typeof installId === 'string' ? installId : null,
      typeof platform === 'string' ? platform : null,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('push/subscribe fejlede:', e.message);
    res.status(500).json({ error: 'Kunne ikke gemme abonnement.' });
  }
});

// ── Web Push: update favourites for a subscription ─────────────────────────
app.post('/api/push/update-favourites', async (req, res) => {
  const { endpoint, favourites } = req.body || {};
  try {
    const result = await query(`UPDATE push_subscriptions SET favourites = $1 WHERE endpoint = $2`, [JSON.stringify(favourites || []), endpoint]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('push/update-favourites fejlede:', e.message);
    res.status(500).json({ error: 'Kunne ikke opdatere favoritter.' });
  }
});

// ── Web Push: unsubscribe ──────────────────────────────────────────────────
app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  try {
    await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    res.json({ ok: true });
  } catch (e) {
    console.error('push/unsubscribe fejlede:', e.message);
    res.status(500).json({ error: 'Kunne ikke afmelde abonnement.' });
  }
});

// ── Installations-heartbeat ──────────────────────────────────────────────────
// Kaldt fra klientens sendInstallHeartbeat() (forgrund/visibilitychange),
// fra service workerens periodicsync-handler, og — for push-abonnenter — fra
// selve SW'ens stille 'heartbeat'-push-håndtering (se overloeb-sw.js). Se
// app-metrics.js's filhoved for hvorfor installationer skal bekræftes
// GENTAGNE gange (ikke bare registreres én gang ved installation).
app.post('/api/install/heartbeat', async (req, res) => {
  try {
    const { installId, platform, pushEnabled, via } = req.body || {};
    await appMetrics.recordHeartbeat({ installId, platform, pushEnabled: !!pushEnabled, via });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
    console.error('install/heartbeat: uventet fejl —', e.message);
    res.status(500).json({ error: 'Kunne ikke registrere heartbeat.' });
  }
});

// Finder alle push-abonnementer, der har ETSPECIFIKT badested favoriseret —
// genbruges af det ugentlige digest-job og af "første vurdering i dag"-
// beskeden (se POST /api/badested-observation). Samme koordinat-opslags-
// mønster som enqueuePushNotifications() allerede bruger til badested-
// grupper (se getBadevandCoordIndex()).
async function getSubscriptionsForBadested(badestedId) {
  const coordIndex = getBadevandCoordIndex();
  const subs = await getAllPushSubscriptions();
  const matches = [];
  for (const entry of subs) {
    for (const group of (entry.badevandGroups || [])) {
      if (group.lat == null || group.lng == null) continue;
      const bvId = coordIndex.get(`${group.lat.toFixed(4)}:${group.lng.toFixed(4)}`);
      if (bvId != null && String(bvId) === String(badestedId)) {
        matches.push({ endpoint: entry.endpoint, entry, group });
        break; // ét match pr. abonnement er nok — undgå dubletter hvis samme badested optræder i flere grupper
      }
    }
  }
  return matches;
}

// NYT (Kommunepakke, modul 6 — badested-statistik): SAMME koordinat-
// opslags-princip som getSubscriptionsForBadested() ovenfor, men for MANGE
// badested_id'er i ÉT gennemløb af abonnementerne i stedet for ét kald pr.
// badested (undgår N separate fulde getAllPushSubscriptions()-hentninger
// for et kommune-dashboard med flere badesteder).
async function getSubscriberCountsForBadestedIds(badestedIds) {
  const result = new Map(badestedIds.map(id => [String(id), 0]));
  const coordIndex = getBadevandCoordIndex();
  const subs = await getAllPushSubscriptions();
  for (const entry of subs) {
    const seen = new Set(); // ét abonnement tælles højst én gang pr. badested, selv ved flere matchende grupper
    for (const group of (entry.badevandGroups || [])) {
      if (group.lat == null || group.lng == null) continue;
      const bvId = coordIndex.get(`${group.lat.toFixed(4)}:${group.lng.toFixed(4)}`);
      if (bvId == null || seen.has(bvId)) continue;
      const key = String(bvId);
      if (!result.has(key)) continue;
      result.set(key, result.get(key) + 1);
      seen.add(bvId);
    }
  }
  return result;
}

// Samme danske labels som selve indsendelses-UI'en (bv-obs-btn-knapperne og
// bv-algae-level-btn-knapperne i dansk-overloeb-kort.html) — HOLD I SYNC,
// så push-beskeden aldrig kan afvige fra hvad brugeren faktisk trykkede på.
const VURDERING_TYPE_LABELS = {
  ser_fint_ud: 'Ser fint ud',
  alger_set:   'Alger set',
  uklart_vand: 'Uklart vand',
  affald:      'Affald',
};
const ALGAE_LEVEL_LABELS = { ingen: 'Ingen', faa: 'Få', mange: 'Mange' };

// ── Besked ved dagens FØRSTE badestedsvurdering ─────────────────────────────
// Kaldes fra POST /api/badested-observation når badestedObs.recordVurdering()
// rapporterer isFirstToday — se badested-observations.js's _insertVurderingTxn().
// Kun DENNE ene indsendelse pr. badested pr. dag udløser en besked; ingen
// afsender-identificerbar info medtages (kun de valgte statustyper, som er
// det eneste badestedObs kender om indsendelsen).
async function broadcastFirstVurderingOfDay(badestedId, observationTypes, algaeLevel) {
  if (!VAPID_PUBLIC_KEY) return;
  const matches = await getSubscriptionsForBadested(badestedId);
  if (matches.length === 0) return;

  const typeLabels = (observationTypes || []).map(t => VURDERING_TYPE_LABELS[t]).filter(Boolean);
  if (observationTypes?.includes('alger_set') && algaeLevel && ALGAE_LEVEL_LABELS[algaeLevel]) {
    const idx = typeLabels.indexOf(VURDERING_TYPE_LABELS.alger_set);
    if (idx !== -1) typeLabels[idx] = `Alger set (${ALGAE_LEVEL_LABELS[algaeLevel]})`;
  }
  const body = typeLabels.length > 0 ? typeLabels.join(', ') : 'Ny observation indsendt';
  const now = Date.now();

  // NYT (badested-statistik): ÉT varsel talt her, pr. kald (matches.length
  // > 0 er allerede bekræftet ovenfor) — ALDRIG pr. abonnent. Samme
  // "count events, not recipients"-princip som modul 6's kommunale varsel.
  appMetrics.recordBadestedAlertSent(badestedId, PUSH_SEND_TYPES.NY_VURDERING, now)
    .catch(e => console.warn('recordBadestedAlertSent (ny vurdering) fejl:', e.message));

  await Promise.all(matches.map(({ endpoint, group }) => query(`
    INSERT INTO push_send_queue (endpoint, type, payload, hit_stamps, enqueued_at)
    VALUES ($1, $2, $3, '[]'::jsonb, $4)
  `, [
    endpoint,
    PUSH_SEND_TYPES.NY_VURDERING,
    JSON.stringify({
      title: `🧑‍🤝‍🧑 Ny vurdering: ${group.name || 'dit badested'}`,
      body,
      tag: `vurdering-${badestedId}-${todayDateStringLocal()}`,   // dedup pr. badested pr. dag hvis SW modtager samme push flere gange
      url: (group.lat != null && group.lng != null) ? `/#badevand=${group.lat}:${group.lng}` : '/',
    }),
    now,
  ])));
  console.info(`Ny vurdering (${badestedId}): ${matches.length} abonnent(er) varslet`);
  flushPushQueue().catch(e => console.warn('flushPushQueue (ny vurdering) fejl:', e.message));
}

// UTC-datostreng, samme konvention som app-metrics.js's todayDateString() —
// kun brugt til at give et stabilt 'tag' (Notification API dedup'er selv på
// tag hvis samme device skulle modtage duplikerede pushes).
function todayDateStringLocal() {
  return new Date().toISOString().slice(0, 10);
}

// ── GET /api/stats — offentlig, ingen adgangsbeskyttelse (bevidst valg) ─────
// Installationstal pr. platform, push-adoption, indsendte badestedsvurderinger,
// og udsendte webpush pr. type (24t/7d/total). Se app-metrics.js's filhoved
// for hvorfor "aktiv"/"nogensinde set" hhv. "24t/7d/total" rapporteres
// adskilt i stedet for ét samlet tal.
app.get('/api/stats', async (req, res) => {
  try {
    const [installStats, vurderingStats, pushSendStats, pushSubscriptionCount] = await Promise.all([
      appMetrics.getInstallStats(),
      badestedObs.getVurderingStats(),
      appMetrics.getPushSendStats(),
      getPushSubscriptionCount(),
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      generatedAt: Date.now(),
      installs: installStats,
      pushSubscriptions: pushSubscriptionCount,
      vurderinger: vurderingStats,
      pushSends: pushSendStats,
    });
  } catch (e) {
    console.error('/api/stats fejlede:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente statistik.' });
  }
});

// ── GET /api/stats/history — dagligt statistik-øjebliksbillede over tid ────
// Adskilt fra /api/stats ovenfor (som viser NUVÆRENDE totaler) — denne
// leverer historikken der driver /stats' udviklingsgrafer, se
// runDailyStatsSnapshotJob() og appMetrics.getStatsHistory(). Offentlig,
// ingen adgangsbeskyttelse, samme bevidste valg som /api/stats selv.
app.get('/api/stats/history', async (req, res) => {
  try {
    // NYT: ?days= valgfri, capped 7-365 — undgår både et meningsløst
    // 0/negativt vindue og et ubegrænset stort opslag ved en forkert/
    // ondsindet query-parameter. Standard 90 dage — nok til at vise en
    // meningsfuld trend uden at overbelaste den lille graf med for mange
    // punkter.
    const requested = parseInt(req.query.days, 10);
    const days = Number.isFinite(requested) ? Math.max(7, Math.min(365, requested)) : 90;
    const history = await appMetrics.getStatsHistory(days);
    res.set('Cache-Control', 'no-store');
    res.json({ generatedAt: Date.now(), days, history });
  } catch (e) {
    console.error('/api/stats/history fejlede:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente statistikhistorik.' });
  }
});

// ── Web Push: send notifications to all subscribers ────────────────────────
// Called internally by the server's weather-refresh cycle.
// Also exposed as POST /api/push/send for manual triggering (e.g. cron job).
//
// RETTET (se samtalen for baggrund): sendte tidligere KUN varsler baseret på
// enkelte udløbs egen bakterielle prognoserisiko — også for badested-
// favoritter, hvor beskeden viste kryptiske udløbskoder ("U17 +2") i stedet
// for badestedets navn. To problemer løst her:
//   1. Badested-favoritter aggregeres nu til SAMME "samlede risiko"-metrik
//      badevandspanelet selv viser (max af bakteriel+viral prognoserisiko
//      på tværs af alle nærliggende udløb) — matematisk identisk
//      udløsningsbetingelse som "mindst ét udløb over tærsklen", men nu
//      korrekt navngivet efter badestedet, og inkluderer viral (ikke kun
//      bakteriel som før).
//   2. Alge UDELADT bevidst — afhænger af CMEMS-strømdata/vandmaske, der
//      kun findes klient-side, se risk-model.js.
// `pointRisks` er valgfri (Map af udløbs-ID -> {foreRisk, foreViralRisk,
// hasRain, ...}) — udelades den (fx ved manuelle test-kald til
// /api/push/send), fungerer badested-grupper simpelthen ikke, uden at
// resten af funktionen fejler.
// RETTET: gensendte tidligere SAMME varsel hver 15. minut, så længe en
// risiko forblev over tærsklen — tag: 'overloeb-varsling' erstatter kun
// notifikationen VISUELT i bakken, men forhindrer ikke enheden i at
// ringe/vibrere igen ved hver kørsel. En regnhændelse holder typisk
// risikoen forhøjet i mange timer, så dette betød reel, gentagen spam for
// samme, uændrede situation. Deduplikerer nu pr. sted (udløb/badested):
// et sted varsles kun igen hvis (a) det er FØRSTE gang det krydser
// tærsklen, (b) der er gået mindst COOLDOWN_MS siden sidste varsel om
// PRÆCIS dette sted, eller (c) risikoen er steget markant siden sidst
// (reel, ny information, selv inden for cooldown-perioden).
const NOTIFY_ESCALATION_DELTA = 0.15;              // 15 procentpoint stigning udløser genvarsling

// RETTET: opdelt i enqueuePushNotifications() (ren beslutning, intet
// netværkskald) og flushPushQueue() (selve den samtidige afsendelse) — se
// pushSendQueue's filhoved ovenfor for fuld begrundelse. Denne funktion
// beslutter fortsat PRÆCIS det samme som før (uændret dedup-/eskalerings-
// logik og selve beskeden), men sætter nu jobbet i kø i stedet for at
// afsende det direkte her.
// RETTET (bruger-ønske 2026-07-26): `cascadeResult` (badevandRisk.
// computeBadevandRiskCascade()'s {lakes, kystvande, badevand}-resultat) er
// nu valgfri fjerde parameter — bruges til at give badested-favoritters
// "nu"-signal PRÆCIS samme, allerede spildevands-filtrerede og (for
// kystvand) afstandskorrigerede tal som badevandspanelet selv viser, i
// stedet for udelukkende at stole på den simple 15 km-radius-prognose
// nedenfor. Udelades den (fx den manuelle /api/push/send-test), falder
// koden tilbage til KUN prognose-signalet, som før denne rettelse.
async function enqueuePushNotifications(warnPoints, pointRisks, bypassDedup = false, cascadeResult = null) {
  if (!VAPID_PUBLIC_KEY) return 0;
  // NYT (Postgres-migrering): ÉT batch-opslag af ALLE abonnementer, i
  // stedet for at iterere en langtlevende in-memory Map — se
  // getAllPushSubscriptions()/mapSubscriptionRow() ovenfor. mapSubscriptionRow()
  // garanterer allerede notifiedState er et objekt (aldrig undefined), så
  // ingen særskilt "initialisér hvis manglende"-gren er nødvendig længere.
  const subs = await getAllPushSubscriptions();
  if (subs.length === 0) return 0;
  pointRisks = pointRisks || new Map();
  const badevandById = new Map((cascadeResult?.badevand || []).map(b => [String(b.id), b]));
  const coordIndex = cascadeResult ? getBadevandCoordIndex() : null;

  // RETTET (bruger-ønske 2026-08-12): der blev tidligere ALSO sendt push
  // for individuelt favoriserede PULS-udløb (favourites-arrayet, se
  // toggleFav()/warnMap ovenfor — begge nu fjernet), ikke kun for
  // badested-favoritter (badevandGroups). Push skal alene handle om
  // BADESTEDER — et enkelt regnvandsudløb er ikke i sig selv relevant nok
  // til en notifikation, kun det SAMLEDE billede for et badested (som
  // beachHits nedenfor allerede beregner, spildevands-filtreret og
  // afstands-/strømkorrigeret). favourites-arrayet gemmes fortsat server-
  // side (se /api/push/subscribe), men bruges ikke længere her.
  const now = Date.now();
  let queued = 0, skippedDuplicate = 0;
  const inserts = [];
  // NYT (badested-statistik): denne løkke kører PR. ABONNENT — to abonnenter
  // kan udløses på FORSKELLIGE tidspunkter for samme badested (egen
  // notifiedState/dedup hver), så "ét varsel udsendt for badested X" tælles
  // her som "X optrådte i mindst ét worthyHits denne kørsel", IKKE pr.
  // abonnent-job nedenfor — se recordBadestedAlertSent()-kaldet efter loopet.
  const alertedBadestedIds = new Set();

  for (const entry of subs) {
    const { endpoint, badevandGroups, notifiedState } = entry;

    // Badested-grupper: aggregér til SAMME metrik badevandspanelet viser
    const beachHits = [];
    for (const group of (badevandGroups || [])) {
      let nowRisk = 0;
      let forecastRisk = 0;
      let scopedForecast = false;
      // NYT (bruger-ønske 2026-07-26): "nu"-signalet bruger badevandspanelets
      // EGET, allerede beregnede resultat (wastewater-filtreret, og for
      // kystvand gennemsnit af de faktisk matchede badesteders egne
      // afstands-/strømkorrigerede scorer, se badevand-risk.js) — slås op
      // via samme koordinat-nøgle som badestedet blev favoriseret med.
      if (coordIndex && group.lat != null && group.lng != null) {
        const bvId = coordIndex.get(`${group.lat.toFixed(4)}:${group.lng.toFixed(4)}`);
        const bv = bvId != null ? badevandById.get(bvId) : null;
        if (bv) {
          nowRisk = Math.max(bv.bact || 0, bv.viral || 0);
          // RETTET (bruger-rapporteret — "Vester Lyng ved Havnsø": push om
          // natten, badestedssiden viste grønt og ingen 24h-varsel ved
          // opslag): forecastRisk blev tidligere ALTID beregnet ud fra
          // group.pulsIds (klientens rå, uretningsbestemte 15 km-boks — se
          // toggleBadevandFav()/_currentBvNearbyIds), helt uafhængigt af
          // badevandspanelets EGEN "⚡ 24h prognose"-visning, som bruger
          // bv.forecast (badevand-risk.js's badested-scopede, spildevands-
          // filtrerede prognose, samme kilde som lige ovenfor for nowRisk).
          // Et PULS-punkt 10+ km væk, i et andet vandsystem, men inden for
          // den rå boks, kunne dermed udløse et push, mens badestedets
          // EGET prognosetal (det brugeren så ved at følge linket) forblev
          // 0/grønt — nøjagtig samme klasse fejl som "Vollerup Badebro"
          // (se isForecast nedenfor), blot i prognose-halvdelen af
          // signalet, som den daværende rettelse ikke dækkede, fordi
          // bv.forecast dengang ikke fandtes endnu.
          //
          // RETTET (bruger-rapporteret — Saltbæk Badebro: push med "(prognose)"
          // og markant risiko, men badestedets EGEN "⚡ 24h prognose"-bjælke
          // viste 0% ved opslag): faldt tidligere tilbage til den brede,
          // urelaterede 15 km-boks blot fordi bv.forecast var null — men det
          // sker IKKE kun ved et helt umatchet badested (source:'ingen', se
          // fallback-kommentaren nedenfor), også ved et BEKRÆFTET sø-/
          // kystvand-match, hvis dets egne matchede udløb midlertidigt mangler
          // vejrdata i netop denne kørsel (se _evaluatePushNotificationsInner()'s
          // cellMissing-gren — pt.foreRisk sættes da aldrig). Et bekræftet
          // match uden forecast-data skal her behandles som 0 — PRÆCIS samme
          // `?? 0`-koercion som badevandspanelets egen prognose-bjælke bruger
          // (se dansk-overloeb-kort.html's showBadevandPanel()) — i stedet for
          // at falde tilbage til et potentielt helt urelateret punkts prognose.
          const isConfirmedMatch = bv.source !== 'ingen' && bv.source !== 'server-utilgaengelig';
          if (bv.forecast != null || isConfirmedMatch) { forecastRisk = bv.forecast ?? 0; scopedForecast = true; }
        }
      }
      // Fallback KUN hvis badestedet ikke har noget cascade-match overhovedet
      // (source:'ingen' — intet bekræftet sø-/kystvand fundet, ELLER coordIndex-
      // opslaget ovenfor slet ikke fandt nogen bv) — her findes intet scopet
      // bv.forecast at falde tilbage på, så den brede, uretningsbestemte
      // 15 km-radius-liste er stadig bedre end intet signal. Respekterer
      // samme spildevandsfilter som før (se pointRisks' isWastewater, sat i
      // _evaluatePushNotificationsInner()).
      if (!scopedForecast) {
        for (const id of (group.pulsIds || [])) {
          const pr = pointRisks.get(String(id));
          if (!pr || pr.isWastewater === false) continue;
          forecastRisk = Math.max(forecastRisk, pr.foreRisk || 0, pr.foreViralRisk || 0);
        }
      }
      const maxRisk = Math.max(nowRisk, forecastRisk);
      if (maxRisk > 0.35) {
        // RETTET (bruger-rapporteret — Vollerup Badebro: push viste "100%
        // risiko", men badestedets EGEN nu-score var ~0%): et badested-
        // varsel kan udløses UDELUKKENDE af forecastRisk (nærliggende PULS-
        // punkters foreRisk/foreViralRisk, ingen relation til bv.bact/viral,
        // som badevandspanelet selv viser som "nu"). isForecast afgør om
        // det reelt VAR forecast-delen, der udløste varslet — bruges
        // herunder til at tilføje en "(prognose)"-markering i selve
        // beskeden, så den ikke fremstår som en påstand om nuet.
        const isForecast = forecastRisk > nowRisk;
        // NYT: lat/lng medbringes nu, så selve push-beskeden kan linke
        // direkte til badestedets detaljeside (se url herunder) i stedet
        // for altid at pege på forsiden.
        beachHits.push({ kind: 'beach', key: `beach:${group.key || group.name}`, name: group.name, risk: maxRisk, isForecast, lat: group.lat, lng: group.lng });
      }
    }

    // RETTET (bruger-ønske 2026-08-12): kun badested-hits — se filhovedets
    // begrundelse ovenfor for hvorfor individuelle udløbs-favoritter
    // (tidligere outletHits her) ikke længere bidrager til push.
    const hits = beachHits;
    if (hits.length === 0) continue;

    // Afgør om MINDST ét sted reelt er "nyt nok" til at retfærdiggøre en
    // notifikation nu — resten af hits vises stadig MED i selve beskeden
    // for kontekst, men udløser ikke i sig selv en ny notifikation.
    //
    // RETTET: fjernet den tidsbaserede "påmindelse hver 6. time"-regel
    // helt, efter eksplicit tilbagemelding — kun to betingelser udløser nu
    // et varsel: (1) FØRSTE gang stedet krydser tærsklen, eller (2) risikoen
    // er steget markant siden sidste varsel. INGEN automatisk gentagelse
    // baseret på forløbet tid alene, uanset hvor længe risikoen forbliver
    // uændret forhøjet.
    const worthyHits = bypassDedup ? hits : hits.filter(h => {
      const prev = notifiedState[h.key];
      if (!prev) return true;                                            // aldrig varslet før
      if ((h.risk || 0) - (prev.risk || 0) > NOTIFY_ESCALATION_DELTA) return true; // markant eskaleret
      return false;
    });
    if (worthyHits.length === 0) { skippedDuplicate++; continue; }
    if (coordIndex) {
      for (const h of worthyHits) {
        if (h.lat == null || h.lng == null) continue;
        const bvId = coordIndex.get(`${h.lat.toFixed(4)}:${h.lng.toFixed(4)}`);
        if (bvId != null) alertedBadestedIds.add(String(bvId));
      }
    }

    // RETTET: url pegede tidligere ALTID på forsiden ('/'), uanset hvad
    // varslet faktisk handlede om. Bruger nu det samme #badevand=lat:lng /
    // #udlob=id deep-link-mønster, appens egen frontend allerede
    // understøtter (se handleHash() i dansk-overloeb-kort.html), så et
    // klik på notifikationen åbner PRÆCIS det pågældende sted — badested
    // eller udløbspunkt — i stedet for bare forsiden, hvor brugeren selv
    // skulle lede det frem igen.
    const primaryHit = hits[0];
    // RETTET (bruger-ønske 2026-08-12): hits indeholder nu KUN badested-
    // hits (se filhovedet ovenfor) — #udlob=id-grenen er derfor fjernet,
    // den kunne aldrig længere rammes.
    const notifyUrl = (primaryHit.lat != null && primaryHit.lng != null) ? `/#badevand=${primaryHit.lat}:${primaryHit.lng}` : '/';

    const payload = JSON.stringify({
      title: `⚠ Overløbsvarsling: ${hits[0].name}${hits.length > 1 ? ` +${hits.length - 1}` : ''}`,
      body: hits.map(h =>
        `${h.name} · ${((h.risk || 0)*100).toFixed(0)}% risiko${h.isForecast ? ' (prognose)' : ''}`
      ).join('\n'),
      tag: 'overloeb-varsling',
      url: notifyUrl,
    });

    // NYT: sættes i kø i stedet for at sende her direkte — selve
    // netværkskaldet (og den tilhørende notifiedState-opdatering, som KUN
    // må ske ved en FAKTISK lykkedes afsendelse, ikke blot en beslutning om
    // at sende) sker nu i flushPushQueue() nedenfor. hitStamps bærer
    // ALLE viste steder videre (ikke kun det udløsende), samme begrundelse
    // som den tidligere inline-opdatering havde. INSERT er allerede
    // holdbart gemt — ingen separat persistPushQueue()-fil-skrivning
    // nødvendig længere (se filhovedet).
    inserts.push(query(`
      INSERT INTO push_send_queue (endpoint, type, payload, hit_stamps, enqueued_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [endpoint, PUSH_SEND_TYPES.RISIKOVARSEL, payload, JSON.stringify(hits.map(h => ({ key: h.key, risk: h.risk }))), now]));
    queued++;
  }

  await Promise.all(inserts);

  if (alertedBadestedIds.size > 0) {
    await Promise.all([...alertedBadestedIds].map(id =>
      appMetrics.recordBadestedAlertSent(id, PUSH_SEND_TYPES.RISIKOVARSEL, now)
    )).catch(e => console.warn('recordBadestedAlertSent (risikovarsel) fejl:', e.message));
  }

  // RETTET: loggede tidligere kun ved faktisk afsendelse/fejl — men "0
  // sendt" er nu et FORVENTET, normalt udfald (deduplikering), ikke kun et
  // tegn på at ingenting var galt. Log altid, uanset udfald, så et roligt
  // 15-minutters-tjek kan skelnes fra "kørte aldrig" og fra "sendte reelt
  // ingenting fordi alt allerede var varslet for nyligt".
  console.info(`Push: ${queued} varsel(er) sat i kø, ${skippedDuplicate} deduplikeret (allerede varslet for nyligt)`);
  return queued;
}

// Bekvemmeligheds-wrapper: sætter i kø OG AFVENTER selve den samtidige
// afsendelse er færdig, før den returnerer. Bruges KUN af de manuelle
// test-endpoints nedenfor, hvor et menneske forventer at se det reelle
// udfald med det samme. Den automatiske, periodiske sti
// (evaluatePushNotifications() længere nede) kalder i stedet
// enqueuePushNotifications() direkte og AFVENTER IKKE flushPushQueue() —
// se pushSendQueue's filhoved for hvorfor.
async function sendPushNotifications(warnPoints, pointRisks, bypassDedup = false) {
  await enqueuePushNotifications(warnPoints, pointRisks, bypassDedup);
  await flushPushQueue();
}

// Manual trigger endpoint (for testing)
app.post('/api/push/send', async (req, res) => {
  // Accept a warnPoints array directly for testing
  const { warnPoints } = req.body || {};
  if (!Array.isArray(warnPoints)) return res.status(400).json({ error: 'warnPoints array required' });
  // bypassDedup=true: dette ER en manuel test — skal altid rent faktisk
  // sende, uafhængigt af om en reel notifikation for samme sted allerede
  // gik ud for nyligt (se NOTIFY_ESCALATION_DELTA i sendPushNotifications()).
  await sendPushNotifications(warnPoints, null, true);
  res.json({ ok: true, subscribers: await getPushSubscriptionCount() });
});

// NYT: manuel udløsning af den FULDE, autonome evaluering (vejr-opslag +
// risikoberegning + tærskel-filter + afsendelse) — i modsætning til
// /api/push/send ovenfor, som kræver at warnPoints allerede er kendt.
// Bruges til at teste hele kæden med det samme, uden at vente på et reelt
// vejrudsving eller den periodiske 6-timers cyklus.
//
// NYT (?test=1): sænker MIDLERTIDIGT tærsklen til et minimalt niveau —
// KUN for dette ene kald — så selv et forsvindende lille, men reelt,
// vejrsignal udløser et fund. Formålet er at bekræfte at find-og-send-
// kæden virker korrekt, når der rent faktisk ER noget at finde, uden at
// skulle vente på et ægte kraftigt regnvejr. Den periodiske,
// AUTOMATISKE evaluering (se de tre warmCache()-kædede kaldssteder
// ovenfor) kalder ALDRIG med dette flag — jeres rigtige brugere kan
// derfor ikke modtage et varsel udløst af denne sænkede tærskel.
app.post('/api/push/evaluate-now', async (req, res) => {
  try {
    const testMode = req.query.test === '1';
    const testThresholds = testMode ? { minRisk: 0.001 } : undefined;
    await evaluatePushNotifications(testThresholds);
    res.json({
      ok: true,
      testMode,
      thresholds: testThresholds || { minRisk: 0.35 },
      diagnostics: _latestDiagnostics,
      subscribers: await getPushSubscriptionCount(),
      warnPointsFound: _latestWarnPoints.length,
      warnPoints: _latestWarnPoints,
      weatherCacheCells: weatherCache.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CMEMS Baltic Current Data ────────────────────────────────────────────────
// Dataset: cmems_mod_bal_phy_cur_anfc_2.5km_PT1H-i
// Variables: uo (eastward m/s), vo (northward m/s)
// Auth: CMEMS_USERNAME + CMEMS_PASSWORD (Fly.io secrets)
// Cache: 6 hours — currents change slowly relative to our use case
//
// Access strategy: delegeret til Python via den officielle Copernicus Marine
// Toolbox (`copernicusmarine`-pakken, se fetch_currents.py). Den tidligere
// version parsede OPeNDAP/THREDDS ASCII-output manuelt med regex, hvilket var
// skrøbeligt overfor selv små formatændringer på THREDDS-serveren. Toolbox'en
// håndterer autentificering, dataset-opslag og subsetting korrekt og er den
// anbefalede adgangsvej til CMEMS-data.
// Falls back to null gracefully — app works without currents data.

const { execFile } = require('child_process');

// RETTET: var sat til 6 timer, men appens egen UI-tekst (se
// "Strømdata (CMEMS) ... opdateres hver time" i dansk-overloeb-kort.html)
// lover brugerne HVER TIME — en reel, målelig uoverensstemmelse mellem det
// lovede og det faktiske, ikke blot en cache, der "føltes" forældet.
// Ingen dokumenteret grund (fx rate-limit hos Copernicus Marine) blev
// fundet for det oprindelige 6-timers-valg. Sat til at matche det, appen
// selv hævder.
const CURRENTS_TTL       = 1 * 3600 * 1000;
const PYTHON_SCRIPT      = path.join(__dirname, 'fetch_currents.py');
const PYTHON_BIN         = process.env.PYTHON_BIN || 'python3';
const PYTHON_TIMEOUT     = 180 * 1000; // CMEMS-opslag over Fly's netværk kan tage 100+ sek
// DATA_DIR (Volume-mount) er defineret øverst i filen — genbruges her til
// samme strøm-cache-fil.
const CURRENTS_CACHE_FILE = path.join(DATA_DIR, 'currents-cache.json');

let currentsCache          = { ts: 0, grid: null, error: null };
let currentsRefreshInFlight = false;
let currentsRefreshPromise  = null;

// ── Disk-persistens ───────────────────────────────────────────────────────
// Fly.io autostopper maskinen ved inaktivitet og genstarter den ved næste
// request. Uden persistens ville HVER genstart tvinge den første bruger til
// at vente 100+ sekunder på et koldt CMEMS-opslag. Ved at gemme sidste
// vellykkede resultat på disk (samme VM-filsystem, overlever autostop/start —
// men ikke en fuld ny deploy) kan vi indlæse det øjeblikkeligt ved opstart
// og opdatere i baggrunden i stedet.
function loadPersistedCurrents() {
  try {
    const raw    = fs.readFileSync(CURRENTS_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.ts && Array.isArray(parsed.points) && parsed.points.length) {
      currentsCache = { ts: parsed.ts, grid: buildCurrentGrid(parsed.points), error: null };
      const ageMin = Math.round((Date.now() - parsed.ts) / 60000);
      console.log(`CMEMS currents: indlæst ${parsed.points.length} punkter fra disk-cache (alder: ${ageMin} min)`);
    }
  } catch (e) {
    // Helt normalt ved allerførste deploy — ingen disk-cache endnu
  }
}

function persistCurrentsToDisk(points, ts) {
  fs.writeFile(CURRENTS_CACHE_FILE, JSON.stringify({ ts, points }), (err) => {
    if (err) console.warn('Kunne ikke skrive strøm-cache til disk:', err.message);
  });
}

// Kør fetch_currents.py og parse JSON på stdout
//
// To CPU-hensyn, vigtige på Fly's delte vCPU'er:
// 1. `nice -n 19` sænker processens OS-skemalægningsprioritet til minimum,
//    så den kun bruger CPU-tid Node ikke selv har brug for i øjeblikket —
//    uden dette konkurrerer den tunge xarray/numpy-regning direkte med
//    Node's event loop om processortid, og HELE appen (ikke kun strøm-
//    endpointet) bliver mærkbart langsom, mens scriptet kører.
// 2. *_NUM_THREADS=1 forhindrer numpy/BLAS i selv at sprede beregninger over
//    flere tråde — på en maskine med få (delte) vCPU'er skaber det kun
//    kontekst-skift-overhead i stedet for reel fremskyndelse.
const PYTHON_ENV = {
  ...process.env,
  OMP_NUM_THREADS: '1',
  OPENBLAS_NUM_THREADS: '1',
  MKL_NUM_THREADS: '1',
  NUMEXPR_NUM_THREADS: '1',
};

function runPythonFetch() {
  return new Promise((resolve, reject) => {
    execFile(
      'nice',
      ['-n', '19', PYTHON_BIN, PYTHON_SCRIPT],
      { timeout: PYTHON_TIMEOUT, maxBuffer: 32 * 1024 * 1024, env: PYTHON_ENV },
      (err, stdout, stderr) => {
        if (stderr && stderr.trim()) {
          console.warn('fetch_currents.py stderr:', stderr.trim().slice(0, 500));
        }
        // Scriptet outputter altid gyldig JSON på stdout, også ved fejl
        // ({"error": "..."}), så vi forsøger at parse uanset exit code.
        let parsed;
        try {
          parsed = JSON.parse((stdout || '').trim());
        } catch (parseErr) {
          return reject(new Error(
            err ? `python fejlede: ${err.message}` : `ugyldigt output: ${parseErr.message}`
          ));
        }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve(parsed);
      }
    );
  });
}

// UDSKILT (2026-08-20, event loop-blokerings-rettelse): buildCurrentGrid()/
// getCurrentAtServer() bor nu i current-grid.js, som BÅDE denne fil og
// badevand-risk-worker.js kræver hver for sig — se dens filhoved for
// hvorfor (workerData kan ikke bære funktions-referencer over en
// worker_thread-grænse, kun rene data, så begge tråde må bygge deres eget
// grid lokalt fra hver sin kopi af de rå strømpunkter).
const { buildCurrentGrid, getCurrentAtServer } = require('./current-grid');

// Selve netværkskaldet — altid asynkront, opdaterer cache + disk ved succes,
// beholder eksisterende (forældede) cache ved fejl i stedet for at nulstille.
async function refreshCurrentsNow() {
  try {
    const result = await runPythonFetch();
    if (!result.points || !result.points.length) throw new Error('Ingen strømpunkter modtaget');

    const ts = Date.now();
    currentsCache = { ts, grid: buildCurrentGrid(result.points), error: null };
    persistCurrentsToDisk(result.points, ts);
    console.log(`CMEMS currents: ${result.points.length} punkter hentet via Python (${result.ts})`);
  } catch (e) {
    console.warn('CMEMS currents fetch failed:', e.message);
    if (currentsCache.grid) {
      console.warn('Beholder forældet strøm-cache pga. fejlet opdatering');
    } else {
      currentsCache = { ts: Date.now(), grid: null, error: e.message };
    }
  }
  return currentsCache.grid;
}

function startCurrentsRefresh() {
  currentsRefreshInFlight = true;
  currentsRefreshPromise = refreshCurrentsNow().finally(() => {
    currentsRefreshInFlight = false;
    currentsRefreshPromise = null;
  });
  return currentsRefreshPromise;
}

function triggerBackgroundRefresh() {
  if (currentsRefreshInFlight) return;
  startCurrentsRefresh();
}

// Stale-while-revalidate: frisk cache → returnér med det samme.
// Forældet men til stede (fx indlæst fra disk efter genstart) → returnér
// med det samme OG trigger en baggrunds-opdatering, uden at blokere kalderen.
// Ingen cache overhovedet (kun ved allerførste kolde deploy) → vent synkront.
async function fetchCMEMSCurrents() {
  const isFresh = currentsCache.grid && (Date.now() - currentsCache.ts < CURRENTS_TTL);
  if (isFresh) return currentsCache.grid;

  if (currentsCache.grid) {
    triggerBackgroundRefresh();
    return currentsCache.grid;
  }

  // Ingen cache overhovedet — flere samtidige kald (fx det planlagte
  // opvarmningskald og en rigtig brugerforespørgsel, der rammer inden for
  // samme sekund ved kold opstart) skal dele ÉN igangværende hentning i
  // stedet for hver at starte deres egen Python-proces. Genbruger samme
  // in-flight-lås som triggerBackgroundRefresh().
  if (currentsRefreshInFlight) return currentsRefreshPromise;
  return startCurrentsRefresh();
}

// Indlæs evt. tidligere gemte strømdata synkront ved opstart, før noget andet
loadPersistedCurrents();

// Warm currents on startup, then keep self-correcting based on ACTUAL
// cache age — ikke en fast timer.
// RETTET: brugte tidligere setInterval(fn, CURRENTS_TTL) — men den slags
// interval tæller fra det tidspunkt SERVERPROCESSEN starter, ikke fra
// hvornår data sidst faktisk blev hentet med succes. Enhver genstart
// (deploy, Fly-genstart, OOM) nulstillede timeren til at tælle forfra,
// mens den PERSISTEREDE cache beholdt sit gamle, ægte tidsstempel — gabet
// mellem "sidste succesfulde hentning" og "næste forsøg" kunne derfor
// blive LÆNGERE end selve TTL'en, præcis som observeret (86 min alder på
// en nominel 60-min TTL). Tjekker nu hvert minut om cachen REELT er
// forældet (baseret på currentsCache.ts, ikke på hvor længe processen har
// kørt) — selv-korrigerende uanset hvor mange genstarter der sker
// undervejs.
setTimeout(() => fetchCMEMSCurrents(), 30000);
setInterval(() => {
  if (Date.now() - currentsCache.ts > CURRENTS_TTL) fetchCMEMSCurrents();
}, 60 * 1000);

// Fylder ethvert tomt (null) gitterpunkt med værdierne fra det NÆRMESTE
// gitterpunkt, der rent faktisk har CMEMS-data — flood-fill/BFS fra alle
// "kilde"-celler samtidig, ét lag ad gangen udad, over det almindelige
// 4-forbundne gitter (op/ned/venstre/højre). Multi-source BFS på et
// regulært, fuldt sammenhængende gitter garanterer at ALLE celler nås, og
// finder den nærmeste kilde i gittercelle-afstand (rimelig tilnærmelse til
// geografisk afstand, cellerne er ~ensstore).
//
// RETTET (bruger-krav: "strøm-animation skal dække ALT hav", ikke bare mere
// af det): forsøgte først kun at lempe windy-currents.js' krav om, at alle
// FIRE gitterhjørner skal have data (se dens interpolate()-kommentar) — men
// selv efter det og en halveret gitterafstand havde kun ~19% af cellerne
// omkring Isefjord nok nabodata til overhovedet at blive tegnet, fordi
// CMEMS' Østersø-model (se DATASET_ID i fetch_currents.py) reelt IKKE HAR
// data derinde, uanset gitterets opløsning — der er intet at interpolere
// FRA. Løsningen må derfor ligge her, server-side: erstat "intet data" med
// "samme strøm som nærmeste sted, vi RENT FAKTISK måler" — geografisk en
// rimelig antagelse over korte afstande, og altid bedre end slet ingen
// animation. Sikkert at fylde ALLE tomme celler ubetinget, også dem der er
// land — klienten klipper allerede canvas'et præcist til de faktiske
// vandpolygoner (updateWaterClipPath() i dansk-overloeb-kort.html), så et
// fyldt landpunkt bliver aldrig vist, uanset hvad denne funktion sætter det
// til.
function fillNearestNeighbor(uData, vData, tData, nx, ny) {
  const n = nx * ny;
  const filled = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qHead = 0, qTail = 0;
  for (let i = 0; i < n; i++) {
    if (uData[i] !== null) {
      filled[i] = 1;
      queue[qTail++] = i;
    }
  }
  if (qTail === 0) return; // ingen kilder overhovedet — intet at fylde fra
  while (qHead < qTail) {
    const i = queue[qHead++];
    const row = (i / nx) | 0, col = i % nx;
    if (row > 0)      { const j = i - nx; if (!filled[j]) { filled[j] = 1; uData[j] = uData[i]; vData[j] = vData[i]; tData[j] = tData[i]; queue[qTail++] = j; } }
    if (row < ny - 1) { const j = i + nx; if (!filled[j]) { filled[j] = 1; uData[j] = uData[i]; vData[j] = vData[i]; tData[j] = tData[i]; queue[qTail++] = j; } }
    if (col > 0)      { const j = i - 1;  if (!filled[j]) { filled[j] = 1; uData[j] = uData[i]; vData[j] = vData[i]; tData[j] = tData[i]; queue[qTail++] = j; } }
    if (col < nx - 1) { const j = i + 1;  if (!filled[j]) { filled[j] = 1; uData[j] = uData[i]; vData[j] = vData[i]; tData[j] = tData[i]; queue[qTail++] = j; } }
  }
}

// ── Strøm-visualisering — windy-currents.js grid-format ──────────────────────
// Genbruger SAMME currentsCache.grid som /api/currents (og dermed samme CMEMS-
// hentning/cache/TTL) — kun output-formatet er nyt. windy-currents.js (vendoret
// kopi af wind-js-leaflet's windy.js, se filhovedet der) forventer et GRIB2-
// lignende TRIPPEL (U/V/temperatur) af regulære gitre (header + flad data-
// array, række for række fra nord mod syd, kolonne for kolonne fra vest mod
// øst) — den matcher komponenterne via header.parameterCategory+","+
// header.parameterNumber === "2,2" (U), "2,3" (V), "0,0" (temperatur, Kelvin).
// fetch_currents.py's punkter STAMMER fra et regulært lat/lon-gitter (strided
// xarray-udsnit), men nogle celler mangler (NaN/fill-value droppet der) —
// disse fyldes nu med nærmeste ægte nabopunkts data (fillNearestNeighbor()
// ovenfor) i stedet for at blive sendt som null/tomme til klienten.
function buildVelocityGridJSON(grid) {
  const lats = new Set(), lngs = new Set();
  let tempSum = 0, tempCount = 0;
  for (const [, v] of grid) {
    lats.add(v.lat); lngs.add(v.lng);
    if (v.temp != null) { tempSum += v.temp; tempCount++; }
  }
  if (lats.size < 2 || lngs.size < 2) return null; // for lidt til et meningsfuldt gitter
  // Fallback for punkter uden temperatur (thetao kan mangle, se fetch_currents.py) —
  // gittergennemsnittet er en langt bedre gæt end en vilkårlig konstant.
  const fallbackTempC = tempCount ? tempSum / tempCount : 12;

  const latArr = [...lats].sort((a, b) => b - a); // nord → syd (la1 = nordligste)
  const lngArr = [...lngs].sort((a, b) => a - b); // vest → øst (lo1 = vestligste)
  const ny = latArr.length, nx = lngArr.length;
  const la1 = latArr[0], la2 = latArr[ny - 1];
  const lo1 = lngArr[0], lo2 = lngArr[nx - 1];
  const dy = (la1 - la2) / (ny - 1);
  const dx = (lo2 - lo1) / (nx - 1);

  // RETTET: NaN kan ikke JSON-serialiseres (JSON.stringify(NaN) → "null",
  // men uden en semantisk forskel fra "punkt aldrig sat") — bruger null
  // direkte som sentinel i stedet, matcher windy-currents.js' createWindBuilder.
  const uData = new Array(nx * ny).fill(null);
  const vData = new Array(nx * ny).fill(null);
  const tData = new Array(nx * ny).fill(fallbackTempC + 273.15);
  let idx = 0;
  for (const lat of latArr) {
    for (const lng of lngArr) {
      const p = grid.get(`${lat.toFixed(2)}:${lng.toFixed(2)}`);
      if (p) {
        uData[idx] = p.uo;
        vData[idx] = p.vo;
        tData[idx] = (p.temp != null ? p.temp : fallbackTempC) + 273.15;
      }
      idx++;
    }
  }

  fillNearestNeighbor(uData, vData, tData, nx, ny);

  const header = {
    nx, ny, lo1, la1, lo2, la2, dx, dy,
    refTime: new Date(currentsCache.ts).toISOString(),
    forecastTime: 0,
  };
  return [
    { header: { ...header, parameterCategory: 2, parameterNumber: 2, parameterUnit: 'm.s-1', parameterNumberName: 'Eastward current' }, data: uData },
    { header: { ...header, parameterCategory: 2, parameterNumber: 3, parameterUnit: 'm.s-1', parameterNumberName: 'Northward current' }, data: vData },
    { header: { ...header, parameterCategory: 0, parameterNumber: 0, parameterUnit: 'K', parameterNumberName: 'Temperature' }, data: tData },
  ];
}

app.get('/api/currents/velocity', async (req, res) => {
  const grid = await fetchCMEMSCurrents();
  if (!grid) {
    return res.status(503).json({ error: currentsCache.error || 'No current data' });
  }
  const velocityJSON = buildVelocityGridJSON(grid);
  if (!velocityJSON) {
    return res.status(503).json({ error: 'Utilstrækkeligt gitter til velocity-format' });
  }
  res.set('Cache-Control', 'public, max-age=21600');
  res.json(velocityJSON);
});

// ── GET /api/currents — serve current vector grid ────────────────────────────
app.get('/api/currents', async (req, res) => {
  const grid = await fetchCMEMSCurrents();
  if (!grid) {
    return res.status(503).json({
      error: currentsCache.error || 'No current data',
      fallback: true
    });
  }
  const out = {};
  for (const [key, val] of grid) out[key] = val;
  const ageMinutes = Math.round((Date.now() - currentsCache.ts) / 60000);
  res.set('Cache-Control', 'public, max-age=21600');
  // RETTET: brugte tidligere et HÅRDKODET tal (360 minutter = 6 timer) her,
  // fuldstændig UAFHÆNGIGT af CURRENTS_TTL-konstanten ovenfor. Da
  // CURRENTS_TTL blev rettet fra 6t til 1t tidligere, blev denne anden,
  // adskilte reference overset — den refererede slet ikke til konstanten,
  // kun et løsrevet tal. Serveren blev derfor ved med at kalde 3 timer
  // gammel data "ikke forældet", uanset den rettede TTL. Bruger nu
  // konstanten direkte, så der kun er ét sted at holde synkroniseret
  // fremover.
  res.json({ ts: currentsCache.ts, ageMinutes, stale: (Date.now() - currentsCache.ts) > CURRENTS_TTL, points: out });
});

// ── GET /api/current-at?lat=&lng= — strøm for ÉT punkt ───────────────────────
// NYT (bruger-ønske 2026-08-19 — det live digitale skilt, se GET /skilt/:slug):
// et badested-skilt kører ubevogtet i dagevis og skal IKKE hente den fulde
// ~1.500-punkts strøm-grid (GET /api/currents) bare for ét enkelt opslag —
// tynd server-side wrapper om getCurrentAtServer()/currentsCache.grid,
// PRÆCIS samme opslagslogik som klientens getCurrentAt() allerede bruger.
app.get('/api/current-at', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat/lng required' });
  const grid = await fetchCMEMSCurrents();
  const c = grid ? getCurrentAtServer(lat, lng, grid) : null;
  res.set('Cache-Control', 'public, max-age=1800');
  res.json(c ? { speed: c.speed, dir: c.dir, temp: c.temp } : null);
});

// ── GET /api/debug additions ──────────────────────────────────────────────────

app.get('/api/debug', (req, res) => {
  const all   = [...weatherCache.entries()];
  const now   = Date.now();
  const warm  = all.filter(([, e]) => now - e.ts < WEATHER_TTL_MS);
  const stale = all.filter(([, e]) => now - e.ts >= WEATHER_TTL_MS);
  const sample = warm.slice(0, 5).map(([k, e]) => ({
    key:          k,
    antecedentMM: e.data?.antecedentMM ?? null,
    todayMM:      e.data?.todayMM      ?? null,
    forecastMM:   e.data?.forecastMM   ?? null,
    hourlyObsLen: e.data?.hourlyObs?.length ?? 0,
    ageSeconds:   Math.round((now - e.ts) / 1000),
  }));
  res.json({
    timestamp:      new Date().toISOString(),
    GRID_DEG,
    WEATHER_TTL_MS,
    warmRunning,
    cacheTotal:     all.length,
    warmCells:      warm.length,
    staleCells:     stale.length,
    apiCallsTotal:  apiCallCount,
    cacheHitsTotal: cacheHitCount,
    buildGridSize:  buildDenmarkGrid().length,
    pulsGridSize:   (_pulsGrid || buildPulsGrid()).length,
    lastErrors:     fetchErrors,
    currents: {
      loaded:  !!currentsCache.grid,
      points:  currentsCache.grid?.size ?? 0,
      ageMin:  currentsCache.ts ? Math.round((now - currentsCache.ts) / 60000) : null,
      error:   currentsCache.error ?? null,
    },
    sample,
  });
});

// ── Health / cache stats ────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    weatherCacheCells: weatherCache.size,
    openMeteoCalls: apiCallCount,
    cacheHits: cacheHitCount,
    hitRate: apiCallCount + cacheHitCount > 0
      ? (cacheHitCount / (apiCallCount + cacheHitCount) * 100).toFixed(1) + '%'
      : 'n/a',
    ttlHours: WEATHER_TTL_MS / 3600000,
  });
});

// KRITISK RETTET (fundet 10. august 2026, under en robots.txt-forespørgsel):
// express.static(STATIC_DIR, ...) nedenfor serverede TIDLIGERE bogstaveligt
// enhver fil i STATIC_DIR (= __dirname, containerens fulde /app) uden nogen
// begrænsning — bekræftet direkte i produktion: GET /server.js, /db.js,
// /badested-observations.js, /app-metrics.js, /risk-model.js,
// /badevand-risk.js, /water-classification.js, /package.json OG
// /node_modules/express/package.json gav alle HTTP 200. Al server-side
// kildekode og hele npm-afhængighedstræet var dermed offentligt
// downloadbart. Ingen hardkodede hemmeligheder blev fundet ved gennemgang
// (VAPID-nøgler, OBSERVATION_IP_SALT, CMEMS-login — alle læses fra
// process.env/Fly secrets, aldrig fra kildekoden), men eksponeret rate-
// limit-logik (MAX_VURDERINGER_PER_IP_PER_DAY m.fl.), den præcise IP-hash-
// metode (HMAC-SHA256) og DB-forespørgselsstruktur er stadig unødvendig
// rekognoscering for en angriber, og generel god praksis er ALDRIG at
// eksponere server-side kildekode.
//
// Klienten henter, bekræftet ved gennemgang af dansk-overloeb-kort.html/
// stats.html/manifest.json, KUN .json/.geojson (data) og .png/.ico
// (ikoner) via denne generiske "alt andet"-rute. HTML-siderne, service
// workeren OG de to vendorede strøm-visualiserings-scripts (windy-
// currents.js/leaflet-canvas-layer.js — RETTET: disse to ER nu lokale,
// offentligt beregnede .js-filer, se deres egne eksplicitte routes
// ovenfor) har hver deres egen, eksplicitte route OVENFOR (afvikles
// derfor allerede FØR dette filter nås) — .js forbliver BEVIDST UDENFOR
// selve allowlisten nedenfor, præcis fordi den ellers ville åbne for HELE
// server-side kildekoden i samme STATIC_DIR-rod (server.js, db.js,
// tenant-*.js, osv.); enhver ny offentlig .js-fil skal have sin EGEN
// navngivne route, aldrig en generel .js-undtagelse her. Fail-closed
// ALLOWLIST (ikke en denylist) af filtyper, håndhævet FØR selve
// express.static() kaldes.
//
// RETTET (bruger-præcisering, samme samtale): indhold (siderne, data-
// filerne) skal fortsat frit kunne crawles/indekseres af Google m.fl. —
// KUN kildekoden skal blokeres.
//
// RETTET IGEN (fundet ved EGEN efterfølgende produktionsverifikation, FØR
// den forrige udgave af denne kommentar reelt var bekræftet sand — se
// dens forkerte "Verificeret: ...node_modules/* giver nu 404"-påstand,
// som ALDRIG blev testet mod en kørende server): en ren udvidelses-
// allowliste er UTILSTRÆKKELIG alene, fordi package.json/package-lock.json
// (roden) og HVER ENESTE package.json i hele node_modules/-træet selv har
// endelsen .json — nøjagtig samme endelse som de tilsigtede datafiler
// (puls-data.json m.fl.). GET /package.json og GET /node_modules/express/
// package.json gav derfor STADIG 200 efter den første rettelse, bekræftet
// direkte i produktion. Løsning: en STI-baseret spærring (node_modules/-
// præfiks + eksakte filnavne) tjekkes NU FØRST, før selve endelses-
// allowlisten — de to lag dækker hver sin svaghed (endelse alene kan ikke
// skelne to .json-filer fra hinanden efter FORMÅL, kun en eksplicit sti-
// regel kan). '.txt' er bevidst IKKE i endelses-allowlisten — den ville
// af samme grund uforvarende have åbnet requirements.txt; robots.txt
// serveres i stedet via sin egen eksplicitte route (se den, samme mønster
// som /overloeb-sw.js).
const BLOCKED_STATIC_PATH_PATTERNS = [
  /^\/node_modules\//i,
  /^\/package(-lock)?\.json$/i,
  /^\/requirements\.txt$/i,
];
const PUBLIC_STATIC_EXTENSIONS = new Set(['.json', '.geojson', '.png', '.ico']);
app.use((req, res, next) => {
  const blocked = BLOCKED_STATIC_PATH_PATTERNS.some(re => re.test(req.path))
    || !PUBLIC_STATIC_EXTENSIONS.has(path.extname(req.path).toLowerCase());
  if (blocked) {
    // NYT: X-Robots-Tag på selve 404'en er reelt overflødigt (en 404 har
    // intet indhold at indeksere), men koster intet og gør hensigten
    // eksplicit/maskinlæsbar for enhver bot der alligevel forsøger — samme
    // "bekræft med en header, stol ikke kun på statuskoden"-princip som
    // robots.txt's tilsvarende Disallow-linjer nedenfor.
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).end();
  }
  next();
});

// Serve any other static assets (varsel page if split out, etc.)
// RETTET (bruger-ønske: hurtig levering): 5 minutter var urimeligt kort for
// de facto statiske filer, der reelt havner her — PWA-ikonerne
// (icons/*.png, kun nogle få KB hver, men hentet ved HVER app-opstart på
// en installeret PWA) og manifest.json, som begge kun ændrer sig ved en
// bevidst, sjælden opdatering, ikke løbende. 1 dag er en rimelig,
// mærkbart bedre standard for denne generiske "alt andet"-rute, uden at
// være så aggressiv som VP3-filernes 7 dage eller PULS' 14 dage, som
// begge har en kendt, langt sjældnere opdateringsrytme.
app.use(express.static(STATIC_DIR, { maxAge: '1d' }));

// ── Periodic cache cleanup ──────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of weatherCache) {
    if (now - val.ts > WEATHER_TTL_MS * 2) weatherCache.delete(key);
  }
  // NYT: beskærer push_send_log til 8 dages historik — se app-metrics.js's
  // filhoved for hvorfor (kun 24t/7d-vinduerne har brug for rå rækker,
  // lifetime-totalen holdes separat i push_send_totals, upåvirket).
  // .catch(): funktionen logger allerede selv internt ved fejl, dette er
  // blot en sikkerhed mod en ubehandlet promise-rejection (setInterval-
  // callbacken herover er ikke async).
  appMetrics.pruneOldPushSendLog().catch(() => {});
}, 3600 * 1000);

// ── Periodisk engagement-job: stille heartbeat-push + ugentlig badested-digest
// Kører hver 12. time ("et par gange dagligt", bruger-ønske) — dækker de to
// formål der begge kræver at kunne nå push-abonnenter UDEN at de selv har
// åbnet appen: (1) bekræfte installationen stadig lever (stille — se
// overloeb-sw.js's 'heartbeat'-gren, INGEN synlig notifikation), (2) sende
// badested-abonnenters ugentlige status hvis mindst 7 dage er gået siden
// sidste (samme notifiedState-dedup-mønster som overløbsvarslernes
// escalation-tjek i enqueuePushNotifications(), blot en ny nøgle-namespace
// 'weekly:', ingen ny lagerstruktur nødvendig).
const ENGAGEMENT_JOB_INTERVAL_MS = 12 * 3600 * 1000;
const WEEKLY_DIGEST_MIN_GAP_MS   = 7  * 24 * 3600 * 1000;

async function runPeriodicEngagementJob() {
  if (!VAPID_PUBLIC_KEY) return;
  const now = Date.now();
  const coordIndex = getBadevandCoordIndex();
  let heartbeats = 0, digests = 0;
  const inserts = [];

  // NYT (Postgres-migrering): ÉT batch-opslag af ALLE abonnementer (se
  // getAllPushSubscriptions() ovenfor) OG ét samlet opslag for ALLE
  // badesteders seneste 7 dage, i stedet for ét opslag PR. badevandGroup
  // PR. abonnement (541 abonnementer × op til flere grupper hver — ville
  // have været tusindvis af sekventielle netværks-rundture under
  // Postgres, hvor det under SQLite var gratis lokale kald). Se
  // app-metrics.js's getAllWeeklyBadevandHistory().
  const [subs, allWeeklyHistory] = await Promise.all([
    getAllPushSubscriptions(),
    appMetrics.getAllWeeklyBadevandHistory(),
  ]);
  if (subs.length === 0) return;

  for (const entry of subs) {
    const { endpoint, notifiedState } = entry;

    // (1) Stille heartbeat — kun hvis vi kender installId (ældre
    // abonnementer fra før denne funktion fandtes mangler det; de dækkes
    // stadig af klientens egne forgrunds-heartbeats, blot ikke via push).
    if (entry.installId) {
      inserts.push(query(`
        INSERT INTO push_send_queue (endpoint, type, payload, hit_stamps, enqueued_at)
        VALUES ($1, $2, $3, '[]'::jsonb, $4)
      `, [endpoint, PUSH_SEND_TYPES.HEARTBEAT, JSON.stringify({ type: 'heartbeat', installId: entry.installId, platform: entry.platform }), now]));
      heartbeats++;
    }

    // (2) Ugentlig badested-digest — én pr. favoriseret badested, hvis
    // mindst 7 dage siden sidste (eller aldrig sendt før).
    for (const group of (entry.badevandGroups || [])) {
      if (group.lat == null || group.lng == null) continue;
      const badestedId = coordIndex.get(`${group.lat.toFixed(4)}:${group.lng.toFixed(4)}`);
      if (badestedId == null) continue;

      const stampKey = `weekly:${badestedId}`;
      const prev = notifiedState[stampKey];
      if (prev && now - prev.ts < WEEKLY_DIGEST_MIN_GAP_MS) continue;

      const history = allWeeklyHistory.get(badestedId) || [];
      const msg = appMetrics.buildWeeklyDigestMessage(group.name || 'Dit badested', history);
      if (!msg) continue; // for lidt historik endnu, eller ingen reel data hele ugen — spring stille over

      inserts.push(query(`
        INSERT INTO push_send_queue (endpoint, type, payload, hit_stamps, enqueued_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        endpoint, PUSH_SEND_TYPES.UGENTLIG_DIGEST,
        JSON.stringify({ title: msg.title, body: msg.body, tag: `weekly-${badestedId}`, url: `/#badevand=${group.lat}:${group.lng}` }),
        // NYT: 'risk' er ubrugt for en digest, men hitStamps-formatet
        // (fælles med overløbsvarslerne) kræver feltet — se
        // flushPushQueue(), som SKRIVER notifiedState[stampKey] her, men
        // KUN ved faktisk lykkedes afsendelse, ikke blot ved kø-tilmelding.
        JSON.stringify([{ key: stampKey, risk: 0 }]),
        now,
      ]));
      digests++;
    }
  }

  if (heartbeats > 0 || digests > 0) {
    await Promise.all(inserts);
    console.info(`Engagement-job: ${heartbeats} heartbeat-push, ${digests} ugentlig digest sat i kø`);
    flushPushQueue().catch(e => console.warn('flushPushQueue (engagement-job) fejl:', e.message));
  }
}
setInterval(() => runPeriodicEngagementJob().catch(e => console.warn('runPeriodicEngagementJob fejl:', e.message)), ENGAGEMENT_JOB_INTERVAL_MS);

// ── Dagligt statistik-øjebliksbillede (bruger-ønske 2026-08-10) ─────────────
// Til /stats' udviklingsgrafer (installationer/abonnenter/vurderinger/
// risikovarsel-push over tid) — indsamler PRÆCIS de samme totaler
// GET /api/stats allerede beregner LIVE (se dens handler nedenfor) og
// gemmer dem som ét øjebliksbillede pr. dato via
// appMetrics.recordDailyStatsSnapshot() (se dens filhoved for hvorfor
// UPSERT, ikke ren INSERT, er bevidst — flere kørsler samme dag er
// FORVENTEDE, ikke en fejl).
async function runDailyStatsSnapshotJob() {
  const [installStats, pushSubscriptionCount, vurderingStats, pushSendStats] = await Promise.all([
    appMetrics.getInstallStats(),
    getPushSubscriptionCount(),
    badestedObs.getVurderingStats(),
    appMetrics.getPushSendStats(),
  ]);
  // NYT: kun risikovarsel-typen tælles her — "# Webpush for risikovarsler"
  // var eksplicit efterspurgt, ikke summen af alle push-typer (som
  // allerede vises separat på /stats via pushSends.totals).
  const riskPushTotal = pushSendStats.byType.find(r => r.type === PUSH_SEND_TYPES.RISIKOVARSEL)?.total ?? 0;
  await appMetrics.recordDailyStatsSnapshot({
    activeInstalls:     installStats.activeTotal,
    pushSubscriptions:  pushSubscriptionCount,
    vurderingerTotal:   vurderingStats.total,
    riskPushTotal,
  });
}
const DAILY_STATS_SNAPSHOT_INTERVAL_MS = 24 * 3600 * 1000;

// NYT (Postgres-migrering): afventer at BEGGE moduler har oprettet deres
// skema, FØR serveren begynder at modtage trafik — en request der rammer
// fx POST /api/badested-observation før CREATE TABLE er kørt færdig ville
// ellers fejle med en forvirrende "relation does not exist"-fejl i stedet
// for blot at vente de få hundrede ms det tager. Alt ANDET boot-arbejde
// ovenfor (rute-registrering, setInterval-opsætning, den forsinkede
// warmCache()-opstart) kræver ikke databasen og kører uændret synkront —
// kun selve lytte-starten er gated.
Promise.all([appMetrics.ready, badestedObs.ready, tenantAdmin.ready, badestedOverrides.ready, overloebEvents.ready, schema])
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Overløbsrisiko server kører på http://${HOST}:${PORT}`);
      console.log(`  Vejr-proxy: /api/weather?lat=55.7&lng=12.5`);
      console.log(`  Bulk:       POST /api/weather/bulk { cells: [...] }`);
      console.log(`  Status:     /api/health`);
    });
    // NYT: kørt HER (ikke en løs setTimeout som warmCache() ovenfor bruger)
    // — denne funktion, i modsætning til warmCache(), læser DIREKTE fra
    // daily_stats_snapshot/app_installs/badested_vurderinger, og skal derfor
    // GARANTERET have skemaet klar, ikke blot "sandsynligvis nok tid gået".
    // Kørt straks (ikke først om 24 timer) så en frisk deploy ikke lader
    // /stats' grafer mangle dagens punkt i op til et helt døgn.
    runDailyStatsSnapshotJob().catch(e => console.warn('runDailyStatsSnapshotJob (opstart) fejl:', e.message));
    setInterval(() => runDailyStatsSnapshotJob().catch(e => console.warn('runDailyStatsSnapshotJob fejl:', e.message)), DAILY_STATS_SNAPSHOT_INTERVAL_MS);
    refreshVurderingCount30dCache().catch(e => console.warn('refreshVurderingCount30dCache (opstart) fejl:', e.message));
    setInterval(() => refreshVurderingCount30dCache().catch(e => console.warn('refreshVurderingCount30dCache fejl:', e.message)), VURDERING_COUNT_REFRESH_MS);
    refreshKommuneLogoCache().catch(e => console.warn('refreshKommuneLogoCache (opstart) fejl:', e.message));
    setInterval(() => refreshKommuneLogoCache().catch(e => console.warn('refreshKommuneLogoCache fejl:', e.message)), KOMMUNE_LOGO_REFRESH_MS);
  })
  .catch(e => {
    console.error('Kunne ikke klargøre Postgres-skema ved opstart — serveren starter IKKE:', e.message);
    process.exit(1);
  });
