// ═══════════════════════════════════════════════════════════════════════════
// badested-observations.js — borgerobservationer for badesteder
// ═══════════════════════════════════════════════════════════════════════════
//
// Én "vurdering" = én indsendelse for ét badested, der kan indeholde flere
// samtidigt valgte statustyper: "Ser fint ud / Alger set / Uklart vand /
// Affald" (se LAYER1_TYPES). Vælges "Alger set", SKAL et algeniveau
// (Ingen/Få/Mange) angives sammen med den — se recordVurdering(). Foto er
// stadig understøttet her server-side (samme validering som før), men
// UI'en i dansk-overloeb-kort.html skjuler pt. muligheden for at vedhæfte
// et (efter eksplicit produktejer-ønske) — koden er bevidst IKKE fjernet.
//
// ⚠️⚠️⚠️ HÅRD GRÆNSE — MÅ ALDRIG BRYDES ⚠️⚠️⚠️
// Borgerobservationer i dette modul må ALDRIG indgå i, eller på nogen måde
// påvirke, badestedets officielle risikofarve/-badge (badevand-risk.js,
// computeBadevandRisk(), colorBadevandByRisk()). Det er en bevidst,
// produktejer-godkendt beslutning, samme princip som algerisiko allerede er
// adskilt fra den officielle sikkerhedsvurdering ("Alge påvirker ikke
// badestedets farve/varselsniveau" — se dansk-overloeb-kort.html's
// dokumentationsside). Dette modul eksponerer UDELUKKENDE sit eget,
// tydeligt mærkede lag (getObservationSummary()) — intet herfra må nogensinde
// læses af badevand-risk.js eller bruges til at beregne bact/viral/algae-tal.
// Enhver fremtidig ændring, der kobler de to sammen, er en fejl, ikke en
// forbedring — spørg produktejeren igen, hvis det virker fristende.
//
// Kommunepakke, modul 6 (badested-overrides.js, "Kommunalt Varsel") holder
// sig endnu tydeligere væk fra denne grænse: den rører ALDRIG bact/viral/
// farve/badge overhovedet — den tilføjer udelukkende et separat, rent
// additivt banner-felt (overrideInfo), vist for abonnenter på badestedets
// side og i push, men uden nogensinde at ændre den officielle,
// modelberegnede status. Grænsen ovenfor gælder fortsat UDELUKKENDE
// uautentificerede borgerobservationer — modul 6 er ikke en undtagelse fra
// den, det er en helt separat mekanisme, der aldrig kommer i nærheden af
// de samme felter.
//
// ── Lagring ───────────────────────────────────────────────────────────────
// RETTET (2026-08-02): migreret fra SQLite (better-sqlite3, lokal /data-
// volume) til Fly Managed Postgres (db.js) — SQLite-filen levede kun på ÉN
// maskines eget, ikke-delte volume, se app-metrics.js's filhoved for den
// fulde begrundelse (samme migrering, samme root cause). Fotos
// (PHOTOS_DIR) forbliver bevidst lokal filsystem-lagring, uændret — den
// upload-vej er skjult fra UI'en (se ovenfor), derfor ikke en del af denne
// migrering.
//
// ── Henfaldsvægtning ─────────────────────────────────────────────────────
// Samme matematiske form som patogenmodellens τ-henfald (risk-model.js:
// residual = amplitude * e^(-alder/τ)), her genbrugt til at vægte HVOR MEGET
// én enkelt vurdering tæller i "X rapporter"-tælleren og i selve
// Badestedsvurdering-panelet — IKKE til at ændre nogen risikoberegning.
// τ er sat til et døgn (se OBSERVATION_TAU_HOURS): med maks. 2 vurderinger
// pr. bruger pr. dag (se rate limit nedenfor) skal ikke-helt-friske
// vurderinger stadig tælle synligt med, i stedet for reelt at forsvinde fra
// panelet efter blot ét døgn — nyere vurderinger vejer stadig mest.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { query, getClient } = require('./db');

// ── Konfiguration — navngivne konstanter, ikke hardcodet inline ────────────
// (samme konvention som ECOLI_THRESHOLD_PER_100ML i
// scripts/build-badevand-analyseresultater.js)

// Henfaldstidskonstant for vurderingers VÆGT i UI'en, i timer. Sat til ét
// døgn: en vurdering fra i går er stadig på e^(-24/24)=37% vægt, én fra for
// tre dage siden er nede på ~5% — synligt aftagende, men ikke forsvundet,
// jf. filhovedets begrundelse. Overstyrbar via miljøvariabel til
// test/tuning uden kodeændring.
const OBSERVATION_TAU_HOURS = parseFloat(process.env.OBSERVATION_TAU_HOURS) || 24;

// SQL-forespørgslernes tidsvindue: alt ældre end dette bidrager reelt intet
// (e^(-8)≈0,03%) til den henfaldsvægtede sum — undgår at skulle scanne en
// stations FULDE historik for hver visning, uden at det ændrer resultatet
// mærkbart.
const OBSERVATION_LOOKBACK_HOURS = OBSERVATION_TAU_HOURS * 8;

// Rate limiting — server-side, ikke til at omgå fra klienten. Én "vurdering"
// er ÉN indsendelse (uanset hvor mange statustyper der er valgt samtidig i
// den, se recordVurdering()) — ikke én række i databasen.
const MAX_VURDERINGER_PER_IP_PER_DAY = 5;  // maks. 5 vurderinger pr. IP pr. dag (rullende 24t)
// RETTET (bruger-rapporteret): den tidligere grænse på 2 var for stram til
// reel brug (en bruger, der besøger et badested flere gange samme dag —
// morgen/eftermiddag — ramte den rutinemæssigt). Hævet til 5.
//
// Højere grænse for indsendelser hvor server.js (via GPS-koordinater sendt
// af klienten, sammenholdt med badestedets EGNE, server-kendte koordinater —
// se server.js's beregning af isNearBadested) har bekræftet at brugeren
// fysisk befinder sig ved DET badested, der vurderes. Dette er et blødt
// signal, ikke en kryptografisk garanti (klienten kan i princippet sende
// falske koordinater direkte til API'et, uden om selve GPS'en) — men det
// hæver bar­ren for automatiseret misbrug betydeligt, uden at genere en ægte
// bruger, der reelt står ved badestedet og indsender flere observationer
// hen over en dag (fx morgen/middag/aften).
const MAX_VURDERINGER_PER_IP_PER_DAY_NEAR_BADESTED = 50;
// FJERNET (bruger-rapporteret): der var tidligere ÉN yderligere regel her —
// alle vurderinger inden for samme rullende døgn skulle gælde SAMME badested,
// ellers blev en anden badested-vurdering afvist selvom antal-loftet ovenfor
// ikke var nået. Ramte en ægte bruger, der besøgte flere badesteder samme
// dag (rapporteret som "kan stadig kun lave én vurdering om dagen" — den
// egentlige årsag var IKKE antal-loftet, men denne regel). Antal-loftet
// ovenfor er nu ENESTE grænse — se _insertVurderingTxn() nedenfor.

// Foto-validering.
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;  // 5 MB — rigeligt til et komprimeret mobilfoto, uden at kunne fylde volumen hurtigt op
// Sniffes fra de faktiske bytes (magic numbers), IKKE fra klientens
// Content-Type/filnavn — begge er trivielt forfalskelige.
const PHOTO_MAGIC_BYTES = [
  { ext: 'jpg',  sig: [0xFF, 0xD8, 0xFF] },
  { ext: 'png',  sig: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  // WEBP: "RIFF" (0-3), størrelse (4-7, ligegyldig her), "WEBP" (8-11)
  { ext: 'webp', sig: [0x52, 0x49, 0x46, 0x46], offset: 0, secondarySig: { sig: [0x57, 0x45, 0x42, 0x50], offset: 8 } },
];

const LAYER1_TYPES = ['ser_fint_ud', 'alger_set', 'uklart_vand', 'affald'];
// Legacy observation_type fra FØR algeniveau/foto blev lagt direkte på
// 'alger_set'-rækken (se recordVurdering()) — findes kun i ældre data på
// volumen, aldrig skrevet af koden længere. weightedCounts() skal stadig
// kunne læse den, så gammel historik ikke bare forsvinder fra panelet.
const ALGAE_TYPE    = 'algeobservation';
const ALGAE_LEVELS  = ['ingen', 'faa', 'mange'];
const OBSERVATION_TYPES = [...LAYER1_TYPES, ALGAE_TYPE];

// ── Foto-lagring — fortsat lokal filsystem, IKKE en del af Postgres-
// migreringen (se filhovedet: upload-vejen er skjult fra UI'en) ───────────
const DATA_DIR   = fs.existsSync('/data') ? '/data' : __dirname;
const PHOTOS_DIR = path.join(DATA_DIR, 'observation-photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ── IP-hashing (GDPR — IP gemmes ALDRIG i klartekst) ───────────────────────
// RETTET (2026-08-02): saltet var tidligere en fil på den lokale /data-
// volume (auto-genereret ved første opstart). Det duer ikke på tværs af
// flere maskiner — saltet SKAL være BYTE-IDENTISK overalt, ellers hasher
// samme IP forskelligt afhængig af hvilken maskine der svarer, og
// underminerer selve rate limit-formålet (og "samme bruger igen"-
// genkendelsen). Flyttet til en Fly secret (OBSERVATION_IP_SALT), samme
// mønster som VAPID_PUBLIC_KEY/CMEMS-credentials i server.js — automatisk
// identisk på alle maskiner uden noget delt lager. Kan ikke længere
// selv-generere ved manglende værdi (en kørende proces kan ikke sætte sin
// egen Fly secret) — se README/CLAUDE.md for engangs-opsætning:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   fly secrets set OBSERVATION_IP_SALT=<værdi> -a dkvand
const IP_SALT = process.env.OBSERVATION_IP_SALT;
if (!IP_SALT) {
  // Hård fejl, ikke et stille fald tilbage — en manglende/ustabil salt
  // underminerer rate limitingens sikkerhedsformål (se ovenfor), samme
  // alvorlighedsniveau som en manglende VAPID-nøgle ville have for push.
  throw new Error('OBSERVATION_IP_SALT mangler — sæt den som Fly secret før opstart (se badested-observations.js filhoved).');
}

function hashIp(rawIp) {
  return crypto.createHmac('sha256', IP_SALT).update(String(rawIp || 'ukendt')).digest('hex');
}

// ── Database-opsætning ──────────────────────────────────────────────────────
const ready = query(`
  CREATE TABLE IF NOT EXISTS badested_vurderinger (
    id           SERIAL PRIMARY KEY,
    badested_id  TEXT   NOT NULL,
    ip_hash      TEXT   NOT NULL,
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vurdering_ip_time ON badested_vurderinger(ip_hash, created_at);

  CREATE TABLE IF NOT EXISTS badested_observations (
    id               SERIAL PRIMARY KEY,
    vurdering_id     INTEGER,
    badested_id      TEXT   NOT NULL,
    observation_type TEXT   NOT NULL,
    algae_level      TEXT,
    photo_path       TEXT,
    ip_hash          TEXT   NOT NULL,
    created_at       BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_badested_ip_time ON badested_observations(badested_id, ip_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_ip_time          ON badested_observations(ip_hash, created_at);
`).then(() => console.info('badested-observations: Postgres-skema klar'))
  .catch(e => { console.error('badested-observations: skemaoprettelse fejlede —', e.message); throw e; });

// ── Foto-validering (magic bytes — se PHOTO_MAGIC_BYTES ovenfor) ──────────
function sniffPhotoExtension(buf) {
  for (const m of PHOTO_MAGIC_BYTES) {
    const off = m.offset || 0;
    if (buf.length < off + m.sig.length) continue;
    const matches = m.sig.every((b, i) => buf[off + i] === b);
    if (!matches) continue;
    if (m.secondarySig) {
      const so = m.secondarySig.offset;
      if (buf.length < so + m.secondarySig.sig.length) continue;
      if (!m.secondarySig.sig.every((b, i) => buf[so + i] === b)) continue;
    }
    return m.ext;
  }
  return null;
}

/**
 * Validerer og gemmer et uploadet foto til PHOTOS_DIR.
 * @param {Buffer} buffer — rå filindhold (fra multer's memoryStorage)
 * @returns {string} relativ URL-sti til det gemte foto (til photo_path)
 * @throws {Error} hvis filen ikke genkendes som et af de tilladte billedformater
 */
function savePhoto(buffer) {
  // RETTET: begge fejl her mangl​ede oprindeligt .code='VALIDATION' — de
  // endte derfor i server.js's generiske catch-gren som en uventet 500-fejl
  // i stedet for den korrekte, klare 400-valideringsfejl (opdaget ved at
  // curl-teste et forfalsket "foto" — se filhovedets/PR-beskrivelsens
  // verifikationsafsnit).
  if (buffer.length > MAX_PHOTO_BYTES) {
    const err = new Error(`Foto for stort (maks ${(MAX_PHOTO_BYTES / 1024 / 1024).toFixed(0)} MB)`);
    err.code = 'VALIDATION';
    throw err;
  }
  const ext = sniffPhotoExtension(buffer);
  if (!ext) {
    const err = new Error('Ukendt eller ikke-understøttet billedformat');
    err.code = 'VALIDATION';
    throw err;
  }
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
  return `/observation-photos/${filename}`;
}

// ── Rate limit + insert i ÉN transaktion ────────────────────────────────────
// RETTET (2026-08-02, Postgres-migrering): better-sqlite3 var synkron og
// enkelt-trådet i sig selv (Node's event loop + SQLite's egen låsning) —
// db.transaction() garanterede derfor ATOMICITET mellem "tæl dagens
// vurderinger" og "indsæt ny" HELT GRATIS, uden at kunne opstå en race
// mellem to samtidige requests. Postgres tillader ÆGTE samtidige skrivere
// — samme "tæl, så indsæt"-logik ville UDEN videre få et race condition-
// vindue (to requests fra samme IP i samme øjeblik kunne begge se "0
// vurderinger i dag" og begge indsætte, og dermed omgå grænsen).
//
// Løsning: pg_advisory_xact_lock(hashtext(ip_hash)) som det FØRSTE i
// transaktionen — låser eksklusivt PR. ip_hash for transaktionens
// varighed (frigives automatisk ved COMMIT/ROLLBACK). To samtidige
// requests fra SAMME IP serialiseres dermed korrekt; requests fra
// FORSKELLIGE IP'er er helt upåvirkede af hinandens lock (hashtext()
// spreder nøglerne, kollision mellem to forskellige IP'er er astronomisk
// usandsynlig og selv da kun et ydelses-, ikke korrekthedsproblem).
async function insertVurderingTxn(badestedId, entries, ipHash, now, maxPerDay) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ipHash]);

    const since = now - 24 * 3600 * 1000;
    const { rows: todaysVurderinger } = await client.query(
      `SELECT badested_id FROM badested_vurderinger WHERE ip_hash = $1 AND created_at > $2`,
      [ipHash, since]
    );

    if (todaysVurderinger.length >= maxPerDay) {
      const err = new Error('rate-limited-max-per-day');
      err.code = 'RATE_LIMITED';
      err.limit = maxPerDay;
      throw err;
    }

    // NYT: "er dette DAGENS FØRSTE vurdering af DETTE badested" — bevidst en
    // ANDEN afgrænsning end rate limit-tjekket ovenfor (som er en rullende
    // 24-timers-grænse PR. IP). Dette er kalenderdag (UTC) og på tværs af
    // ALLE afsendere — bruges af server.js's /api/badested-observation til
    // at afgøre om et push-varsel til badestedets abonnenter skal udsendes
    // (kun for dagens allerførste indsendelse). Ikke omfattet af
    // advisory-lock'en ovenfor (den er pr. ip_hash, ikke pr. badested) —
    // et ekstremt sjældent, lavt-stakes edge case (to helt samtidige
    // FØRSTE indsendelser til samme, splinternye badested samme sekund)
    // kunne i teorien dobbelt-udløse push-broadcasten, accepteret uden en
    // ekstra lock (ville kræve låsning i en anden rækkefølge end
    // ip_hash-låsen og risikere deadlock mellem de to).
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const { rows: firstTodayRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM badested_vurderinger WHERE badested_id = $1 AND created_at >= $2`,
      [badestedId, dayStart.getTime()]
    );
    const isFirstToday = firstTodayRows[0].n === 0;

    const { rows: insertedVurdering } = await client.query(
      `INSERT INTO badested_vurderinger (badested_id, ip_hash, created_at) VALUES ($1, $2, $3) RETURNING id`,
      [badestedId, ipHash, now]
    );
    const vurderingId = insertedVurdering[0].id;

    for (const e of entries) {
      await client.query(
        `INSERT INTO badested_observations (vurdering_id, badested_id, observation_type, algae_level, photo_path, ip_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [vurderingId, badestedId, e.observationType, e.algaeLevel, e.photoPath, ipHash, now]
      );
    }

    await client.query('COMMIT');
    return { vurderingId, isFirstToday };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Registrerer ÉN vurdering (indsendelse) for et badested. Kan indeholde
 * flere samtidigt valgte statustyper (fx "Alger set" + "Affald" i samme
 * vurdering, se LAYER1_TYPES) — det er stadig kun ÉT rate limit-forbrug,
 * ikke ét pr. valgt type. Kaster en Error med .code='RATE_LIMITED' ved
 * rate limit-afvisning, .code='VALIDATION' ved ugyldigt input — kaldstedet
 * (server.js) er ansvarlig for at IKKE videregive de specifikke grænser til
 * klienten i det tilfælde (se filhovedets rate limit-afsnit).
 *
 * @param {object} p
 * @param {string} p.badestedId          — samme nøgle som badevandsvurderingen (bathingwat/DKBW-kode)
 * @param {string[]} p.observationTypes  — 1-4 unikke værdier fra LAYER1_TYPES
 * @param {string|null} p.algaeLevel     — én af ALGAE_LEVELS, PÅKRÆVET hvis 'alger_set' er blandt observationTypes, ellers skal den være null
 * @param {Buffer|null} p.photoBuffer    — valgfrit foto, kun gyldigt sammen med 'alger_set' (UI'en skjuler pt. denne mulighed)
 * @param {string} p.rawIp               — klientens rå IP (hashes her, gemmes ALDRIG i klartekst)
 * @param {boolean} [p.isNearBadested]   — beregnet af server.js ud fra klientens GPS-koordinater sammenholdt
 *   med badestedets EGNE, server-kendte koordinater — se MAX_VURDERINGER_PER_IP_PER_DAY_NEAR_BADESTED ovenfor.
 *   Denne funktion stoler blindt på værdien (den rummer selv ingen geo-data); et blødt tillidssignal, ikke en garanti.
 */
async function recordVurdering({ badestedId, observationTypes, algaeLevel, photoBuffer, rawIp, isNearBadested }) {
  if (typeof badestedId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(badestedId)) {
    const err = new Error('Ugyldigt badested-id'); err.code = 'VALIDATION'; throw err;
  }
  if (!Array.isArray(observationTypes) || observationTypes.length === 0 || observationTypes.length > LAYER1_TYPES.length) {
    const err = new Error('Vælg mindst én observation'); err.code = 'VALIDATION'; throw err;
  }
  const uniqueTypes = [...new Set(observationTypes)];
  if (uniqueTypes.length !== observationTypes.length || uniqueTypes.some(t => !LAYER1_TYPES.includes(t))) {
    const err = new Error('Ugyldig observationstype'); err.code = 'VALIDATION'; throw err;
  }
  const hasAlgae = uniqueTypes.includes('alger_set');
  if (hasAlgae && !ALGAE_LEVELS.includes(algaeLevel)) {
    const err = new Error('Vælg mængden af alger (Ingen/Få/Mange)'); err.code = 'VALIDATION'; throw err;
  }
  if (!hasAlgae && algaeLevel != null) {
    const err = new Error('algae_level må kun angives sammen med alger_set'); err.code = 'VALIDATION'; throw err;
  }
  if (photoBuffer && !hasAlgae) {
    const err = new Error('Foto er kun understøttet sammen med alger_set'); err.code = 'VALIDATION'; throw err;
  }

  let photoPath = null;
  if (photoBuffer) photoPath = savePhoto(photoBuffer);  // kaster VALIDATION-agtig Error ved ugyldigt foto — se savePhoto()

  // NYT: timestamp SÆTTES HER, server-side — der læses aldrig noget
  // klient-leveret tidsfelt noget sted i dette modul. Forhindrer forfalskede
  // gamle/fremtidige indsendelser (samme princip som RUN_TS_MS-guarden i
  // scripts/build-badevand-analyseresultater.js, blot her ved selve
  // INDSÆTTELSEN i stedet for ved indlæsning af historiske data).
  const now = Date.now();
  const entries = uniqueTypes.map(t => ({
    observationType: t,
    algaeLevel: t === 'alger_set' ? algaeLevel : null,
    photoPath:  t === 'alger_set' ? photoPath  : null,
  }));
  const maxPerDay = isNearBadested ? MAX_VURDERINGER_PER_IP_PER_DAY_NEAR_BADESTED : MAX_VURDERINGER_PER_IP_PER_DAY;
  const { vurderingId, isFirstToday } = await insertVurderingTxn(badestedId, entries, hashIp(rawIp), now, maxPerDay);
  return { createdAt: now, vurderingId, isFirstToday };
}

// ── Henfaldsvægtet opslag pr. badested ──────────────────────────────────────
// Samme matematiske form som risk-model.js: vaegt = e^(-alder_timer/τ).
// INGEN kalender-"i dag"-afgrænsning (WHERE created_at > midnat) — det ville
// modsige selve pointen med kontinuert henfald (en vurdering fra 23:59 i
// går ville tælle 0 under en kalendergrænse, men næsten fuld vægt under
// henfald; se filhovedets begrundelse). SQL-forespørgslen afgrænses i stedet
// til OBSERVATION_LOOKBACK_HOURS, som ren ydelsesoptimering — bidraget fra
// noget ældre er allerede forsvindende.
async function weightedCounts(badestedId) {
  const since = Date.now() - OBSERVATION_LOOKBACK_HOURS * 3600 * 1000;
  const { rows } = await query(
    `SELECT observation_type, algae_level, created_at, photo_path
     FROM badested_observations
     WHERE badested_id = $1 AND created_at > $2
     ORDER BY created_at DESC`,
    [badestedId, since]
  );

  const now = Date.now();
  const layer1 = {};
  for (const t of LAYER1_TYPES) layer1[t] = 0;
  const algaeLevels = {};
  for (const l of ALGAE_LEVELS) algaeLevels[l] = 0;
  let latestAlgae = null;
  // NYT (bruger-ønske): tidsstemplet for den SENESTE vurdering af enhver
  // type (ikke kun algeobservationer, se latestAlgae ovenfor) — rows er
  // allerede ORDER BY created_at DESC, så rows[0] er entydigt den nyeste.
  const latestObservationAt = rows.length > 0 ? Number(rows[0].created_at) : null;

  for (const row of rows) {
    const ageHours = (now - Number(row.created_at)) / 3600000;
    const weight   = Math.exp(-ageHours / OBSERVATION_TAU_HOURS);

    // Algeniveau: enten fra en 'alger_set'-række (niveauet ligger direkte på
    // rækken, se recordVurdering()) eller — for ældre data fra FØR denne
    // sammenlægning — en selvstændig legacy 'algeobservation'-række.
    if (row.algae_level && algaeLevels[row.algae_level] != null) {
      algaeLevels[row.algae_level] += weight;
      if (!latestAlgae) {
        latestAlgae = { level: row.algae_level, createdAt: Number(row.created_at), photoUrl: row.photo_path || null };
      }
    }
    if (row.observation_type !== ALGAE_TYPE && layer1[row.observation_type] != null) {
      layer1[row.observation_type] += weight;
    }
  }

  return { layer1, algaeLevels, latestAlgae, latestObservationAt, rawCount: rows.length };
}

/**
 * Samlet, klar-til-visning opsummering for ÉT badested — GET
 * /api/badested-observation/:id's eneste datakilde. Al henfaldsberegning
 * sker HER, server-side — frontend renderer udelukkende de færdige tal,
 * samme server-autoritative princip som resten af risikomodellen (se
 * filhovedets HÅRDE GRÆNSE-advarsel: intet herfra må nogensinde bruges til
 * at ændre den officielle risikofarve).
 */
async function getObservationSummary(badestedId) {
  const { layer1, algaeLevels, latestAlgae, latestObservationAt, rawCount } = await weightedCounts(badestedId);
  return {
    badestedId,
    generatedAt: Date.now(),
    layer1,       // { ser_fint_ud, alger_set, uklart_vand, affald } → henfaldsvægtet sum, "X rapporter"-tal
    // NYT: rå (u-vægtet) antal rækker inden for lookback-vinduet — bruges af
    // klienten til at afgøre "er der overhovedet nogen data" UAFHÆNGIGT af
    // om den henfaldsvægtede sum er rundet ned til 0. Uden dette kunne en
    // reelt eksisterende, blot lidt ældre vurdering fejlagtigt vises som
    // "ingen vurderinger endnu" (se dansk-overloeb-kort.html's
    // renderBadestedVurderingPanel()).
    hasAnyReports: rawCount > 0,
    // NYT (bruger-ønske): tidsstemplet (ms epoch) for den seneste vurdering
    // af enhver type — klienten omregner selv til "X dage, Y timer siden"
    // (se renderBadestedVurderingPanel()). null hvis ingen vurderinger
    // findes inden for OBSERVATION_LOOKBACK_HOURS.
    latestObservationAt,
    algae: {
      levels: algaeLevels,   // { ingen, faa, mange } → henfaldsvægtet sum pr. niveau
      latest: latestAlgae,   // seneste algeobservation (rå, ikke vægtet) eller null
    },
  };
}

/**
 * Samlet antal indsendte vurderinger (uafhængigt af badested) — til
 * /api/stats. Én "vurdering" er ÉN indsendelse, samme optælling som
 * MAX_VURDERINGER_PER_IP_PER_DAY rater imod (badested_vurderinger, ikke
 * badested_observations — sidstnævnte kan have flere rækker pr. vurdering).
 */
async function getVurderingStats() {
  const now = Date.now();
  const since7d  = now - 7  * 24 * 3600 * 1000;
  const since30d = now - 30 * 24 * 3600 * 1000;
  const { rows } = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE created_at > $1)::int AS last7d,
      COUNT(*) FILTER (WHERE created_at > $2)::int AS last30d
    FROM badested_vurderinger
  `, [since7d, since30d]);
  return rows[0];
}

// NYT (Kommunepakke, modul 7 — kommune-scopet statistik, se GET /admin/api/
// stats i server.js): SAMME tal som getVurderingStats() ovenfor, men
// begrænset til ÉN kommunes badested_id'er — genbruger IKKE forespørgslen
// direkte, da WHERE badested_id = ANY($1) skal med i selve COUNT-udtrykkene.
async function getVurderingStatsForBadestedIds(badestedIds) {
  if (!Array.isArray(badestedIds) || badestedIds.length === 0) return { total: 0, last7d: 0, last30d: 0 };
  const now = Date.now();
  const since7d  = now - 7  * 24 * 3600 * 1000;
  const since30d = now - 30 * 24 * 3600 * 1000;
  const { rows } = await query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE created_at > $2)::int AS last7d,
      COUNT(*) FILTER (WHERE created_at > $3)::int AS last30d
    FROM badested_vurderinger
    WHERE badested_id = ANY($1)
  `, [badestedIds.map(String), since7d, since30d]);
  return rows[0];
}

// NYT (bruger-ønske 2026-08-17 — "Badestedsvurdering"-sektionen på
// /badested/:slug, se seo-pages.js's buildSsrContent()): i modsætning til
// getVurderingStatsForBadestedIds() ovenfor (ÉT aggregeret tal på tværs af
// en liste af id'er, til kommune-dashboardets sum) skal denne PR. badested,
// til alle ~1.039 badesteder på én gang — GROUP BY, ikke et filter i WHERE.
// Bevidst ÉN forespørgsel for ALLE sites (kaldes fra en periodisk
// cache-opfriskning i server.js, ALDRIG pr. request — se dens filhoved for
// hvorfor et pr.-request-DB-kald pr. af de ~2.000 crawlede SSR-sider ville
// være uforsvarligt belastende for den delte forbindelses-pool, se db.js).
async function getVurderingCounts30dGrouped() {
  const since30d = Date.now() - 30 * 24 * 3600 * 1000;
  const { rows } = await query(`
    SELECT badested_id, COUNT(*)::int AS count
    FROM badested_vurderinger
    WHERE created_at > $1
    GROUP BY badested_id
  `, [since30d]);
  return rows;
}

// NYT (samme modul) — dags-optalt antal vurderinger for kommunens badesteder,
// til udviklingsgrafen i Kommune-dashboardet. created_at er BIGINT ms (ikke
// en DATE-kolonne), så dato udledes her via to_timestamp(...)::date — samme
// UTC-konvention som resten af appens dags-nøgler (se fx dateStringFromMs()
// i app-metrics.js).
async function getVurderingTrendForBadestedIds(badestedIds, days = 90) {
  if (!Array.isArray(badestedIds) || badestedIds.length === 0) return [];
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  const { rows } = await query(`
    SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS date, COUNT(*)::int AS n
    FROM badested_vurderinger
    WHERE badested_id = ANY($1) AND created_at > $2
    GROUP BY date
    ORDER BY date
  `, [badestedIds.map(String), sinceMs]);
  return rows;
}

module.exports = {
  ready,
  recordVurdering,
  getObservationSummary,
  getVurderingStats,
  getVurderingStatsForBadestedIds,
  getVurderingCounts30dGrouped,
  getVurderingTrendForBadestedIds,
  hashIp,
  PHOTOS_DIR,
  OBSERVATION_TYPES,
  LAYER1_TYPES,
  ALGAE_TYPE,
  ALGAE_LEVELS,
  MAX_PHOTO_BYTES,
  // NYT (bruger-ønske): eksporteret så server.js kan formulere en KONKRET
  // fejlbesked ved rate limiting (se dens .code==='RATE_LIMITED'-gren) i
  // stedet for den tidligere bevidst vage besked — selve tallet defineres
  // fortsat kun ÉT sted (her), så beskeden aldrig kan komme ud af sync med
  // den faktisk håndhævede grænse. (Den faktisk anvendte grænse for en given
  // afvisning ligger også på selve fejlobjektet, .limit — se
  // insertVurderingTxn() — server.js behøver derfor ikke selv regne ud
  // hvilken af de to grænser der blev ramt.)
  MAX_VURDERINGER_PER_IP_PER_DAY,
  MAX_VURDERINGER_PER_IP_PER_DAY_NEAR_BADESTED,
};
