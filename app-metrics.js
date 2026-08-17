// ═══════════════════════════════════════════════════════════════════════════
// app-metrics.js — installations-telemetri + daglig badevands-risikohistorik
//                  + udsendte webpush pr. type
// ═══════════════════════════════════════════════════════════════════════════
//
// Tre adskilte, men beslægtede datasæt, der alle fodrer /api/stats:
//
// 1) app_installs — ÉN række pr. installId (klient-genereret, se
//    dansk-overloeb-kort.html). Opdateres ved hvert "heartbeat" (stille
//    push, periodicSync, eller almindelig forgrunds-besøg), se
//    recordHeartbeat(). Bruges til at tælle AKTIVE installationer pr.
//    platform og push-adoption — se getInstallStats().
//
// 2) badevand_daily_risk — ÉN række pr. (badested, dato), et PERSISTERET
//    løbende gennemsnit (cumulative moving average), ikke rå timedata og
//    ikke en in-memory-akkumulator. Se accumulateDailyBadevandRisk()'s
//    filhoved for hvorfor.
//
// 3) push_send_log / push_send_totals — hvor mange webpush er REELT sendt
//    (ikke blot sat i kø), pr. type (risikovarsel/heartbeat/ugentlig-
//    digest/ny-vurdering, se PUSH_SEND_TYPES i server.js). Samme sum/
//    rå-log-opdeling som badevand_daily_risk, af samme grund — se
//    getPushSendStats()'s filhoved.
//
// RETTET (2026-08-02): migreret fra SQLite (better-sqlite3, lokal /data-
// volume) til Fly Managed Postgres (db.js) — SQLite-filen levede kun på ÉN
// maskines eget, ikke-delte volume, så to Fly-maskiner endte med to helt
// adskilte datasæt (bekræftet direkte ved at inspicere begge maskiner: 67
// vs. 3 installs). Postgres er netværkstilgængeligt fra alle maskiner.
// Alle funktioner herunder er derfor nu ASYNC (netværkskald, ikke længere
// lokale, synkrone filsystemkald) — kaldsstederne i server.js er opdateret
// tilsvarende. `ready` eksporteres, så server.js kan afvente skemaoprettelse
// før den begynder at modtage trafik.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const { query } = require('./db');

const ready = query(`
  CREATE TABLE IF NOT EXISTS app_installs (
    install_id    TEXT PRIMARY KEY,
    platform      TEXT NOT NULL,
    push_enabled  BOOLEAN NOT NULL DEFAULT false,
    first_seen    BIGINT NOT NULL,
    last_seen     BIGINT NOT NULL,
    last_seen_via TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_installs_platform_lastseen ON app_installs(platform, last_seen);

  CREATE TABLE IF NOT EXISTS badevand_daily_risk (
    badested_id  TEXT NOT NULL,
    date         TEXT NOT NULL,
    sum_bact     DOUBLE PRECISION NOT NULL DEFAULT 0, n_bact     INTEGER NOT NULL DEFAULT 0,
    sum_viral    DOUBLE PRECISION NOT NULL DEFAULT 0, n_viral    INTEGER NOT NULL DEFAULT 0,
    sum_algae    DOUBLE PRECISION NOT NULL DEFAULT 0, n_algae    INTEGER NOT NULL DEFAULT 0,
    sum_forecast DOUBLE PRECISION NOT NULL DEFAULT 0, n_forecast INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (badested_id, date)
  );

  -- NYT: udsendte webpush pr. TYPE (risikovarsel / heartbeat / ugentlig-
  -- digest / ny-vurdering, se PUSH_SEND_TYPES) — til /api/stats' "hvor mange
  -- push er sendt, og af hvilken slags"-rapportering. To tabeller, samme
  -- princip som badevand_daily_risk's sum/n-opdeling ovenfor: én ubegrænset
  -- voksende rå-log ville koste unødigt meget over tid for et tal, der kun
  -- nogensinde slås op i to faste vinduer (24t/7d) + en løbende totalsum.
  --   push_send_log    — rå tidsstemplede rækker, KUN brugt til 24t/7d-
  --                       vinduerne, beskåret løbende (se pruneOldPushSendLog())
  --                       til 8 dages historik — netop nok til begge vinduer.
  --   push_send_totals — ét løbende, aldrig beskåret tal pr. type (rene
  --                       lifetime-totaler, ubegrænset lille datamængde:
  --                       ét tal pr. type, ikke pr. afsendelse).
  CREATE TABLE IF NOT EXISTS push_send_log (
    type    TEXT NOT NULL,
    sent_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_send_log_type_time ON push_send_log(type, sent_at);
  CREATE INDEX IF NOT EXISTS idx_push_send_log_time      ON push_send_log(sent_at);

  CREATE TABLE IF NOT EXISTS push_send_totals (
    type  TEXT PRIMARY KEY,
    total INTEGER NOT NULL DEFAULT 0
  );

  -- NYT (bruger-ønske 2026-08-10): ét dagligt øjebliksbillede af de samme
  -- totaler /api/stats allerede viser LIVE — til /stats' udviklings-grafer
  -- (installationer/abonnenter/vurderinger/risikovarsel-push over tid).
  -- ÉN række pr. dato (PRIMARY KEY date), UPSERT'et af recordDailySnapshot()
  -- (se dens filhoved for hvorfor idempotent overskrivning er bevidst, ikke
  -- en fejl) — samme "lille, aldrig ubegrænset voksende tabel"-princip som
  -- push_send_totals ovenfor: én række pr. dag, ikke pr. hændelse. 365
  -- dage er under 10 KB, ingen beskæring nødvendig i overskuelig fremtid.
  CREATE TABLE IF NOT EXISTS daily_stats_snapshot (
    date                TEXT PRIMARY KEY,
    active_installs     INTEGER NOT NULL,
    push_subscriptions  INTEGER NOT NULL,
    vurderinger_total   INTEGER NOT NULL,
    risk_push_total     INTEGER NOT NULL,
    recorded_at         BIGINT  NOT NULL
  );

  -- NYT (Kommunepakke, modul 6 — badested-statistik): dagligt aggregat af
  -- FAKTISK leverede webpush PR. BADESTED, opdelt på type (risikovarsel/
  -- ny-vurdering/kommune-override, se PUSH_SEND_TYPES i server.js). Samme
  -- "daglig aggregat, ikke rå event-log"-princip som badevand_daily_risk
  -- ovenfor — nødvendigt her fordi kommune-dashboardet skal kunne vise
  -- "kvartal"/"år", hvilket push_send_log's 8-dages-beskæring (se
  -- pruneOldPushSendLog() nedenfor) ikke rækker til. ÉN række pr.
  -- (badested, dato, type), aldrig beskåret — samme størrelsesorden som
  -- badevand_daily_risk, ikke ubegrænset voksende pr. afsendelse.
  CREATE TABLE IF NOT EXISTS badested_alert_daily (
    badested_id TEXT NOT NULL,
    date        TEXT NOT NULL,
    type        TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (badested_id, date, type)
  );
  CREATE INDEX IF NOT EXISTS idx_badested_alert_daily_badested_date ON badested_alert_daily(badested_id, date);
`).then(() => console.info('app-metrics: Postgres-skema klar'))
  .catch(e => { console.error('app-metrics: skemaoprettelse fejlede —', e.message); throw e; });

const VALID_PLATFORMS = new Set(['ios', 'android', 'desktop', 'other']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // dækker både UUID-installId og DKBW-koder

function todayDateString() {
  return new Date().toISOString().slice(0, 10); // UTC — bevidst, se filhoved: kun til en daglig bucket, ikke tidszone-kritisk
}

// ── Del 1: installations-heartbeat ──────────────────────────────────────────

/**
 * Registrerer/opdaterer ét "stadig installeret"-signal. Kaldes fra
 * POST /api/install/heartbeat (forgrund, periodicSync) og fra det
 * periodiske server-side heartbeat-push-job (se server.js).
 * @param {object} p
 * @param {string} p.installId   — klient-genereret, stabil pr. installation
 * @param {string} p.platform    — 'ios' | 'android' | 'desktop' | 'other'
 * @param {boolean} p.pushEnabled
 * @param {string} [p.via]       — 'foreground' | 'push' | 'periodicsync', kun til diagnosticering
 */
async function recordHeartbeat({ installId, platform, pushEnabled, via }) {
  if (typeof installId !== 'string' || !ID_RE.test(installId)) {
    const err = new Error('Ugyldigt installId'); err.code = 'VALIDATION'; throw err;
  }
  const safePlatform = VALID_PLATFORMS.has(platform) ? platform : 'other';
  const now = Date.now();
  await query(`
    INSERT INTO app_installs (install_id, platform, push_enabled, first_seen, last_seen, last_seen_via)
    VALUES ($1, $2, $3, $4, $4, $5)
    ON CONFLICT (install_id) DO UPDATE SET
      platform      = EXCLUDED.platform,
      push_enabled  = EXCLUDED.push_enabled,
      last_seen     = EXCLUDED.last_seen,
      last_seen_via = EXCLUDED.last_seen_via
  `, [installId, safePlatform, !!pushEnabled, now, typeof via === 'string' ? via.slice(0, 32) : null]);
}

/**
 * Installationstal til /api/stats — se filhovedets begrundelse for hvorfor
 * "aktiv" (heartbeat inden for et frisk-vindue) og "nogensinde set" (alle
 * rækker) rapporteres adskilt, i stedet for ét samlet tal der ville foregive
 * baggrundsdækning appen ikke reelt har på iOS uden push (se overloeb-sw.js).
 */
async function getInstallStats(activeWindowMs = 14 * 24 * 3600 * 1000) {
  const since = Date.now() - activeWindowMs;
  // NYT: ÉT samlet opslag i stedet for 5 separate — Postgres FILTER-klausulen
  // lader hver aggregering tælle sin egen delmængde af samme scan, i stedet
  // for 5 separate netværks-rundture for hvad der reelt er ét spørgsmål.
  const [byPlatform, totals] = await Promise.all([
    query(`
      SELECT platform,
        COUNT(*)::int AS ever_seen,
        COUNT(*) FILTER (WHERE last_seen > $1)::int AS active
      FROM app_installs
      GROUP BY platform
    `, [since]),
    query(`
      SELECT
        COUNT(*)::int AS ever_total,
        COUNT(*) FILTER (WHERE last_seen > $1)::int AS active_total,
        COUNT(*) FILTER (WHERE last_seen > $1 AND push_enabled)::int AS active_push_enabled
      FROM app_installs
    `, [since]),
  ]);
  const t = totals.rows[0];

  return {
    activeWindowDays: Math.round(activeWindowMs / (24 * 3600 * 1000)),
    everSeenByPlatform: Object.fromEntries(byPlatform.rows.map(r => [r.platform, r.ever_seen])),
    everSeenTotal: t.ever_total,
    activeByPlatform: Object.fromEntries(byPlatform.rows.map(r => [r.platform, r.active])),
    activeTotal: t.active_total,
    activePushEnabled: t.active_push_enabled,
  };
}

// ── Del 2: daglig badevands-risikohistorik (persisteret løbende gennemsnit) ─

/**
 * Akkumulerer ÉT evalueringstjeks resultat (kaldes hver ~15 min fra
 * _evaluatePushNotificationsInner() i server.js, lige efter
 * badevandRiskCache sættes) ind i dagens løbende sum pr. badested. Se
 * filhovedet for hvorfor dette er en direkte SQL-UPSERT og ikke et
 * in-memory-objekt.
 *
 * RETTET (Postgres-migrering): var tidligere 1.039 synkrone, nul-latency
 * SQLite-kald i én lokal JS-transaktion. Under Postgres har HVERT kald en
 * reel netværks-rundtur — at bevare "1.039 separate queries i et loop"
 * ville betyde 1.039 sekventielle rundture hvert 15. minut. I stedet: ÉT
 * multi-row INSERT ... VALUES (...),(...),... ON CONFLICT DO UPDATE — alle
 * badesteder, én rundtur.
 * @param {Array<{id, bact, viral, algae, forecast}>} badevandArray — badevandRiskCache.badevand / cascadeResult.badevand
 */
async function accumulateDailyBadevandRisk(badevandArray) {
  if (!Array.isArray(badevandArray) || badevandArray.length === 0) return;
  const date = todayDateString();
  const valid = badevandArray.filter(b => b != null && b.id != null);
  if (valid.length === 0) return;

  const COLS = 10; // badested_id, date, sum_bact, n_bact, sum_viral, n_viral, sum_algae, n_algae, sum_forecast, n_forecast
  const values = [];
  const placeholders = valid.map((b, i) => {
    const base = i * COLS;
    values.push(
      String(b.id), date,
      b.bact     ?? 0, b.bact     != null ? 1 : 0,
      b.viral    ?? 0, b.viral    != null ? 1 : 0,
      b.algae    ?? 0, b.algae    != null ? 1 : 0,
      b.forecast ?? 0, b.forecast != null ? 1 : 0,
    );
    return `(${Array.from({ length: COLS }, (_, j) => `$${base + j + 1}`).join(',')})`;
  });

  try {
    await query(`
      INSERT INTO badevand_daily_risk
        (badested_id, date, sum_bact, n_bact, sum_viral, n_viral, sum_algae, n_algae, sum_forecast, n_forecast)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (badested_id, date) DO UPDATE SET
        sum_bact     = badevand_daily_risk.sum_bact     + EXCLUDED.sum_bact,     n_bact     = badevand_daily_risk.n_bact     + EXCLUDED.n_bact,
        sum_viral    = badevand_daily_risk.sum_viral    + EXCLUDED.sum_viral,    n_viral    = badevand_daily_risk.n_viral    + EXCLUDED.n_viral,
        sum_algae    = badevand_daily_risk.sum_algae    + EXCLUDED.sum_algae,    n_algae    = badevand_daily_risk.n_algae    + EXCLUDED.n_algae,
        sum_forecast = badevand_daily_risk.sum_forecast + EXCLUDED.sum_forecast, n_forecast = badevand_daily_risk.n_forecast + EXCLUDED.n_forecast
    `, values);
  } catch (e) {
    console.warn('accumulateDailyBadevandRisk fejlede:', e.message);
  }
}

/**
 * Seneste op til 7 dages gennemsnit for ét badested, nyeste først.
 * Gennemsnittet beregnes her ved LÆSNING (sum/n), aldrig gemt som eget felt.
 */
async function getWeeklyBadevandHistory(badestedId) {
  const { rows } = await query(`
    SELECT date, sum_bact, n_bact, sum_viral, n_viral, sum_algae, n_algae, sum_forecast, n_forecast
    FROM badevand_daily_risk
    WHERE badested_id = $1
    ORDER BY date DESC
    LIMIT 7
  `, [String(badestedId)]);
  return rows.map(rowToWeeklyHistoryEntry);
}

function rowToWeeklyHistoryEntry(r) {
  return {
    date:     r.date,
    bact:     r.n_bact     > 0 ? r.sum_bact     / r.n_bact     : null,
    viral:    r.n_viral    > 0 ? r.sum_viral    / r.n_viral    : null,
    algae:    r.n_algae    > 0 ? r.sum_algae    / r.n_algae    : null,
    forecast: r.n_forecast > 0 ? r.sum_forecast / r.n_forecast : null,
  };
}

/**
 * Seneste 7 dages historik for ALLE badesteder i ét opslag, grupperet pr.
 * badested_id — bruges af runPeriodicEngagementJob() i server.js, som
 * ellers ville kalde getWeeklyBadevandHistory() pr. badevandGroup PR.
 * abonnement (541 abonnementer × op til flere grupper hver = potentielt
 * tusindvis af sekventielle rundture). Kaldes ÉN gang pr. kørsel af jobbet
 * (hver 12. time), resultatet slås op i et JS-Map i selve loopet.
 * @returns {Promise<Map<string, object[]>>} badestedId → seneste ≤7 dages rækker, nyeste først
 */
async function getAllWeeklyBadevandHistory() {
  const since = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString().slice(0, 10); // 8 dage margin, samme princip som pruneOldPushSendLog
  const { rows } = await query(`
    SELECT badested_id, date, sum_bact, n_bact, sum_viral, n_viral, sum_algae, n_algae, sum_forecast, n_forecast
    FROM badevand_daily_risk
    WHERE date > $1
    ORDER BY badested_id, date DESC
  `, [since]);

  const byBadested = new Map();
  for (const r of rows) {
    const list = byBadested.get(r.badested_id) || [];
    if (list.length < 7) list.push(rowToWeeklyHistoryEntry(r)); // rækker er allerede DESC pr. badested_id, se ORDER BY
    byBadested.set(r.badested_id, list);
  }
  return byBadested;
}

// Samme tærskler som klientens riskLabel() (dansk-overloeb-kort.html) — HOLD
// I SYNC, så en ugentlig digest-besked aldrig kan modsige farven brugeren
// ser på selve kortet for samme dag.
function riskBucket(r) {
  if (r === null || r === undefined) return null;
  if (r >= 0.6) return 'høj';
  if (r >= 0.2) return 'moderat';
  return 'lav';
}

/**
 * Kommunepakke, modul 4 — grøn/gul/rød-dagtal pr. badested for én
 * kalendermåned (UTC, samme dato-konvention som todayDateString()/hele
 * badevand_daily_risk). ÉN forespørgsel for ALLE badestedIds (WHERE
 * badested_id = ANY($1)), ikke én pr. badested — se planens eksplicitte
 * krav om en effektiv forespørgsel.
 *
 * Kombinerer bact/viral PRÆCIS som buildWeeklyDigestMessage() ovenfor
 * (Math.max, algae/forecast bevidst UDELADT — samme HÅRDE grænse som
 * badested-observations.js's filhoved: alge må aldrig påvirke den
 * officielle farve). En dag uden NOGEN matchende række (badestedet var
 * ikke oprettet endnu, eller lå før denne tabel fandtes) tælles som
 * `noData`, ALDRIG stille som grøn.
 *
 * @param {string[]} badestedIds
 * @param {string} yearMonth — 'YYYY-MM'
 * @returns {Promise<Map<string, {green:number, yellow:number, red:number, noData:number, daysInMonth:number}>>}
 */
async function getMonthlyRiskBuckets(badestedIds, yearMonth) {
  const result = new Map();
  if (!Array.isArray(badestedIds) || badestedIds.length === 0) return result;
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) throw new Error(`getMonthlyRiskBuckets: ugyldigt yearMonth-format "${yearMonth}", forventede 'YYYY-MM'`);
  const year = parseInt(m[1], 10), monthIdx = parseInt(m[2], 10) - 1; // 0-baseret måned til Date.UTC

  const rangeStart = new Date(Date.UTC(year, monthIdx, 1)).toISOString().slice(0, 10);
  const rangeEnd   = new Date(Date.UTC(year, monthIdx + 1, 1)).toISOString().slice(0, 10); // eksklusiv — næste måneds 1.
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

  const ids = badestedIds.map(String);
  for (const id of ids) result.set(id, { green: 0, yellow: 0, red: 0, noData: daysInMonth, daysInMonth });

  const { rows } = await query(`
    SELECT badested_id, date, sum_bact, n_bact, sum_viral, n_viral
    FROM badevand_daily_risk
    WHERE badested_id = ANY($1) AND date >= $2 AND date < $3
  `, [ids, rangeStart, rangeEnd]);

  for (const r of rows) {
    const entry = result.get(r.badested_id);
    if (!entry) continue; // kan ikke ske givet WHERE badested_id = ANY($1), men fail-safe
    const bact  = r.n_bact  > 0 ? r.sum_bact  / r.n_bact  : null;
    const viral = r.n_viral > 0 ? r.sum_viral / r.n_viral : null;
    const combined = (bact != null || viral != null) ? Math.max(bact ?? 0, viral ?? 0) : null;
    const bucket = riskBucket(combined);
    if (bucket === null) continue; // ingen bact/viral-data for netop denne dag — forbliver i noData
    entry.noData--;
    if (bucket === 'høj') entry.red++;
    else if (bucket === 'moderat') entry.yellow++;
    else entry.green++;
  }
  return result;
}

/**
 * Bygger titel/body til den ugentlige badested-digest, eller null hvis der
 * endnu ikke er nok historik (kræver alle 7 foregående dage — ny
 * funktionalitet, ingen bagudrettet data, se plan). Kombinerer bact/viral
 * som samme "værste af de to" klienten allerede viser (colorBadevandByRisk()
 * i dansk-overloeb-kort.html). Ren, synkron funktion — ingen DB-adgang.
 */
function buildWeeklyDigestMessage(name, history) {
  if (!Array.isArray(history) || history.length < 7) return null;

  let lav = 0, moderat = 0, hoej = 0, ingenData = 0;
  for (const day of history) {
    const combined = (day.bact != null || day.viral != null)
      ? Math.max(day.bact ?? 0, day.viral ?? 0)
      : null;
    const bucket = riskBucket(combined);
    if (bucket === null) ingenData++;
    else if (bucket === 'høj') hoej++;
    else if (bucket === 'moderat') moderat++;
    else lav++;
  }
  if (ingenData === history.length) return null; // ingen reel data hele ugen — spring stille over

  const parts = [];
  if (lav > 0)     parts.push(`sikkert ${lav} af 7 dage`);
  if (moderat > 0) parts.push(`${moderat} dag${moderat === 1 ? '' : 'e'} moderat risiko`);
  if (hoej > 0)    parts.push(`${hoej} dag${hoej === 1 ? '' : 'e'} høj risiko`);

  return {
    title: `📊 Ugestatus: ${name}`,
    body: `${name} den seneste uge: ${parts.join(', ')}.`,
  };
}

// ── Del 4: udsendte webpush pr. type (til /api/stats) ───────────────────────
// Se PUSH_SEND_TYPES i server.js for hvilke typer der reelt findes
// (risikovarsel/heartbeat/ugentlig-digest/ny-vurdering) — dette modul
// kender bevidst IKKE til den liste, kun til hvad der faktisk logges, så en
// ny type i server.js aldrig kræver en tilsvarende ændring her.

/**
 * Registrerer ÉN faktisk lykkedes push-afsendelse. Kaldes fra server.js's
 * flushPushQueue() — KUN ved bekræftet vellykket levering (r.ok), aldrig
 * ved blot kø-tilmelding, så tallet afspejler reelt sendte beskeder.
 */
async function recordPushSent(type) {
  const t = typeof type === 'string' && type ? type : 'ukendt';
  const now = Date.now();
  await Promise.all([
    query(`INSERT INTO push_send_log (type, sent_at) VALUES ($1, $2)`, [t, now]),
    query(`
      INSERT INTO push_send_totals (type, total) VALUES ($1, 1)
      ON CONFLICT (type) DO UPDATE SET total = push_send_totals.total + 1
    `, [t]),
  ]);
}

/** Beskærer push_send_log til de seneste `maxAgeMs` — se tabellens filhoved. */
async function pruneOldPushSendLog(maxAgeMs = 8 * 24 * 3600 * 1000) {
  try { await query(`DELETE FROM push_send_log WHERE sent_at < $1`, [Date.now() - maxAgeMs]); }
  catch (e) { console.warn('pruneOldPushSendLog fejlede:', e.message); }
}

/**
 * "Hvor mange webpush er sendt, og af hvilken type" — seneste 24 timer,
 * seneste 7 dage, og alt-i-alt (lifetime, fra push_send_totals — upåvirket
 * af push_send_log's beskæring), pr. type og som samlet sum.
 */
async function getPushSendStats() {
  const now = Date.now();
  const since24h = now - 24 * 3600 * 1000;
  const since7d  = now - 7  * 24 * 3600 * 1000;

  const [windowResult, totalResult] = await Promise.all([
    query(`
      SELECT type,
        COUNT(*) FILTER (WHERE sent_at > $1)::int AS last24h,
        COUNT(*) FILTER (WHERE sent_at > $2)::int AS last7d
      FROM push_send_log
      GROUP BY type
    `, [since24h, since7d]),
    query(`SELECT type, total FROM push_send_totals`),
  ]);

  const byType = new Map();
  for (const r of totalResult.rows)  byType.set(r.type, { type: r.type, last24h: 0, last7d: 0, total: r.total });
  for (const r of windowResult.rows) {
    const entry = byType.get(r.type) || { type: r.type, last24h: 0, last7d: 0, total: 0 };
    entry.last24h = r.last24h;
    entry.last7d  = r.last7d;
    byType.set(r.type, entry);
  }

  const list = [...byType.values()].sort((a, b) => b.total - a.total);
  const totals = list.reduce((acc, r) => ({
    last24h: acc.last24h + r.last24h,
    last7d:  acc.last7d  + r.last7d,
    total:   acc.total   + r.total,
  }), { last24h: 0, last7d: 0, total: 0 });

  return { byType: list, totals };
}

/** UTC-dato ('YYYY-MM-DD') for et givet millisekund-tidsstempel — samme konvention som todayDateString(). */
function dateStringFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Registrerer ÉT faktisk lykkedes, badested-scopet webpush — Kommunepakke,
 * modul 6's badested-statistik ("hvor mange varsler er udsendt for DETTE
 * sted"). Kaldes fra server.js's flushPushQueue(), KUN ved bekræftet
 * vellykket levering (samme regel som recordPushSent() ovenfor), én gang
 * pr. (badested, job) — et job der dækker flere badesteder (se
 * enqueuePushNotifications()' RISIKOVARSEL) kalder denne én gang PR. id.
 * @param {string} badestedId
 * @param {string} type — PUSH_SEND_TYPES-værdi
 * @param {number} sentAtMs — job'ets enqueued_at (ikke Date.now() ved flush-tidspunktet — se kaldestedets begrundelse)
 */
async function recordBadestedAlertSent(badestedId, type, sentAtMs) {
  const date = dateStringFromMs(sentAtMs);
  await query(`
    INSERT INTO badested_alert_daily (badested_id, date, type, count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (badested_id, date, type) DO UPDATE SET count = badested_alert_daily.count + 1
  `, [String(badestedId), date, type]);
}

/**
 * Summerer udsendte varsler pr. badested i et INKLUSIVT datointerval (begge
 * 'YYYY-MM-DD') — bruges af GET /admin/api/badested-alert-stats. Et
 * badested uden nogen rækker i intervallet er simpelthen fraværende fra
 * Map'et (kaldestedet behandler det som 0), IKKE en fejl — gælder lige så
 * vel gamle/tomme måneder som helt nye badesteder uden historik endnu.
 * @param {string[]} badestedIds
 * @param {string} fromDate
 * @param {string} toDate
 * @returns {Promise<Map<string, number>>}
 */
async function getAlertCountsForBadestedIds(badestedIds, fromDate, toDate) {
  const result = new Map();
  if (!Array.isArray(badestedIds) || badestedIds.length === 0) return result;
  const { rows } = await query(`
    SELECT badested_id, SUM(count)::int AS n
    FROM badested_alert_daily
    WHERE badested_id = ANY($1) AND date >= $2 AND date <= $3
    GROUP BY badested_id
  `, [badestedIds.map(String), fromDate, toDate]);
  for (const r of rows) result.set(r.badested_id, r.n);
  return result;
}

// NYT (Kommunepakke, modul 7 — kommune-scopet statistik, se GET /admin/api/
// stats i server.js): rå (dato, type, count)-rækker for en kommunes
// badested_id'er, UDEN dato-afgrænsning — kaldestedet bruger SAMME rækker
// til to ting (dags/7d/total-opdeling PR. type, og risikovarsel-udviklings-
// grafen), så én hentning her er nok i stedet for flere separate forespørgsler
// (datamængden er lille: én række pr. badested/dag/type, ikke pr. afsendt push).
async function getAlertRowsForBadestedIds(badestedIds) {
  if (!Array.isArray(badestedIds) || badestedIds.length === 0) return [];
  const { rows } = await query(`
    SELECT date, type, count
    FROM badested_alert_daily
    WHERE badested_id = ANY($1)
  `, [badestedIds.map(String)]);
  return rows;
}

// NYT (kommune-benchmark-rapporten, se server.js's computeKommuneBenchmark())
// — samme aggregat som getAlertCountsForBadestedIds() ovenfor, men for ALLE
// badesteder på én gang (ingen badestedIds-liste — benchmarket sammenligner
// PÅ TVÆRS af samtlige kommuner, ikke kun én tenants egne) og filtreret til
// ÉN varsels-type ('risikovarsel' — hverken 'ny-vurdering' eller
// 'kommune-override' måler det samme som en model-baseret risikoadvarsel).
// Samme INKLUSIVE datointerval-konvention som getAlertCountsForBadestedIds().
async function getAlertCountsGroupedByBadestedId(type, fromDate, toDate) {
  const { rows } = await query(`
    SELECT badested_id, SUM(count)::int AS n
    FROM badested_alert_daily
    WHERE type = $1 AND date >= $2 AND date <= $3
    GROUP BY badested_id
  `, [type, fromDate, toDate]);
  const result = new Map();
  for (const r of rows) result.set(r.badested_id, r.n);
  return result;
}

// NYT (kommune-benchmark-rapporten) — DAGE (ikke SUM) hvor et badested fik
// mindst ét 'risikovarsel' sendt, i intervallet. Bruges til KPI 2 ("dage med
// mindst ét ... varslet badested pr. kommune") som proxy for model-baseret
// risikotilstand — se planens filhoved for hvorfor dette er en proxy
// (kun badesteder med reelle push-abonnenter genererer overhovedet en
// badested_alert_daily-række), ikke en fuldstændig historisk risikolog.
async function getAlertDaysGroupedByBadestedId(type, fromDate, toDate) {
  const { rows } = await query(`
    SELECT DISTINCT badested_id, date
    FROM badested_alert_daily
    WHERE type = $1 AND count > 0 AND date >= $2 AND date <= $3
  `, [type, fromDate, toDate]);
  const result = new Map(); // badested_id -> Set<date>
  for (const r of rows) {
    if (!result.has(r.badested_id)) result.set(r.badested_id, new Set());
    result.get(r.badested_id).add(r.date);
  }
  return result;
}

// ── Del 5: dagligt statistik-øjebliksbillede (til /stats' udviklingsgrafer) ─

/**
 * Gemmer/overskriver DAGENS række med de aktuelle totaler — kaldes fra
 * server.js's periodiske job (se runDailyStatsSnapshotJob()), som selv
 * indsamler tallene på tværs af app-metrics/badested-observations/
 * push_subscriptions (denne funktion ved bevidst intet om hvor tallene
 * kommer fra, samme adskillelse som resten af modulet).
 *
 * RETTET/BEVIDST: UPSERT (ON CONFLICT DO UPDATE), ikke en ren INSERT — jobbet
 * køres både kort efter serverstart OG hver 24. time (se server.js), så
 * flere kørsler samme dag er FORVENTEDE, ikke en fejl. Idempotent
 * overskrivning betyder "dato"-rækken altid afspejler det SENESTE tal for
 * dagen indtil den ruller over til en ny dato, i stedet for at fastfryse
 * et vilkårligt tidspunkt på dagen (fx lige efter en deploy/genstart).
 */
async function recordDailyStatsSnapshot({ activeInstalls, pushSubscriptions, vurderingerTotal, riskPushTotal }) {
  const date = todayDateString();
  await query(`
    INSERT INTO daily_stats_snapshot (date, active_installs, push_subscriptions, vurderinger_total, risk_push_total, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (date) DO UPDATE SET
      active_installs    = EXCLUDED.active_installs,
      push_subscriptions = EXCLUDED.push_subscriptions,
      vurderinger_total  = EXCLUDED.vurderinger_total,
      risk_push_total    = EXCLUDED.risk_push_total,
      recorded_at         = EXCLUDED.recorded_at
  `, [date, activeInstalls, pushSubscriptions, vurderingerTotal, riskPushTotal, Date.now()]);
}

/**
 * Seneste op til `days` dages øjebliksbilleder, ÆLDSTE først (modsat de
 * øvrige "seneste N"-opslag i denne fil, som alle er nyeste-først) — en
 * graf tegnes venstre-til-højre i kronologisk rækkefølge, så klienten
 * slipper for selv at vende rækkefølgen.
 */
async function getStatsHistory(days = 90) {
  const { rows } = await query(`
    SELECT date, active_installs, push_subscriptions, vurderinger_total, risk_push_total
    FROM daily_stats_snapshot
    ORDER BY date DESC
    LIMIT $1
  `, [days]);
  return rows.reverse();
}

module.exports = {
  ready,
  recordHeartbeat,
  getInstallStats,
  accumulateDailyBadevandRisk,
  getWeeklyBadevandHistory,
  getAllWeeklyBadevandHistory,
  buildWeeklyDigestMessage,
  riskBucket,
  getMonthlyRiskBuckets,
  recordPushSent,
  pruneOldPushSendLog,
  getPushSendStats,
  recordBadestedAlertSent,
  getAlertCountsForBadestedIds,
  getAlertRowsForBadestedIds,
  getAlertCountsGroupedByBadestedId,
  getAlertDaysGroupedByBadestedId,
  recordDailyStatsSnapshot,
  getStatsHistory,
};
