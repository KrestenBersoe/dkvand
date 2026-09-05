// ═══════════════════════════════════════════════════════════════════════════
// db.js — delt Postgres-forbindelse (Fly Managed Postgres)
// ═══════════════════════════════════════════════════════════════════════════
//
// Erstatter de tidligere per-modul SQLite-filer (better-sqlite3) på den
// lokale /data-volume — SQLite-filerne levede kun på ÉN maskines eget,
// ikke-delte volume, så to Fly-maskiner endte med to helt adskilte
// datasæt (bekræftet direkte ved at inspicere begge — se
// app-metrics.js/badested-observations.js's historik for den fulde
// begrundelse). Postgres er netværkstilgængeligt fra ALLE maskiner, så
// dette problem forsvinder strukturelt, uanset hvor mange maskiner appen
// kører på.
//
// Ingen ORM — rå SQL via `pg`, samme "ingen abstraktion oveni"-stil som
// better-sqlite3-brugen havde. `query()` er en tynd bekvemmeligheds-
// wrapper; moduler der har brug for en TRANSAKTION (fx badested-
// observations.js's rate limit-tjek) låner selv en klient via
// `pool.connect()` direkte — se getClient().
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL ikke sat — Postgres-afhængige funktioner vil fejle ved første kald.');
}

// NYT: max hævet fra pg's default (10) — flushPushQueue() gør nu et par
// samtidige batch-forespørgsler pr. kørsel (send-jobs, notifiedState-
// opdateringer), og med op til få hundrede abonnenter er der plads til at
// undgå at queue'e forespørgsler internt i klienten. Stadig langt under
// hvad Fly Managed Postgres' Basic-plan tillader af samtidige forbindelser.
//
// NYT (2026-08-20, produktionshændelse — gentagne "Connection terminated
// unexpectedly"): pg's egne standardværdier er idleTimeoutMillis=10000 (10
// sek.) og connectionTimeoutMillis=0 (ALDRIG timeout ved forsøg på at åbne
// en ny forbindelse — et hængende forsøg venter derfor uendeligt i stedet
// for at fejle hurtigt og tydeligt).
//  - connectionTimeoutMillis: 5000 — et forsøg på at hente en forbindelse
//    fejler nu hurtigt (5 sek.) i stedet for evigt, hvis Postgres/proxyen
//    er utilgængelig — fejlen rammer da den almindelige try/catch om det
//    pågældende kald i stedet for at lade requesten hænge på ubestemt tid.
//
// RETTET (2026-09-05, produktionshændelse — poolStats() i query()'s
// filhoved viste PRÆCIS mekanismen): idleTimeoutMillis blev dengang sat til
// 30000 med en eksplicit note om at værdien var en ubekræftet gætning, der
// "BØR verificeres/justeres ud fra faktisk observeret adfærd" — denne
// hændelse ER den verifikation. Logget poolStats() viste gentagne gange en
// forespørgsel fejle med "Connection terminated due to connection timeout"
// PÅ TRODS af at poolen selv rapporterede raske idle-forbindelser lige
// forinden (fx total:5/idle:4 fulgt af en fejl sekunder efter) — Fly
// Managed Postgres kører med "Pooling: Enabled" (bekræftet i dashboardet,
// en PgBouncer-lignende mellemlagspulje), som tilsyneladende lukker en
// ledig forbindelse HURTIGERE end vores egne 30 sek., så vores pulje blev
// ved med at tilbyde forbindelser der allerede var døde i den anden ende —
// opdaget først når en forespørgsel rent faktisk forsøgte at bruge dem.
// To uafhængige rettelser mod netop dette:
//  - idleTimeoutMillis sænket til 8000 — vores egen pulje resirkulerer nu
//    en ledig forbindelse FØR Fly-siden når at gøre det for os, uanset
//    hvor kort dens eget vindue reelt er.
//  - keepAlive: true — TCP-keepalive-pakker holder en ellers stille
//    forbindelse synligt i live over for NAT/proxy/mellemled undervejs, så
//    den slet ikke bliver anset for "død og kan smides væk" i første
//    omgang, i stedet for kun at opdage det bagefter ved fejl.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 8000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
});

pool.on('error', (err) => {
  // NYT: ubehandlede fejl på en IDLE pool-forbindelse (fx databasen lukker
  // forbindelsen efter inaktivitet) crasher ellers HELE Node-processen —
  // samme klasse fejl som ville have ramt en uventet SQLite-fejl før i
  // tiden, blot at pg's pool har sin egen 'error'-event for netop dette.
  console.error('Uventet fejl på idle Postgres-forbindelse:', err.message, poolStats());
});

// NYT (produktionshændelse 2026-09-05 — gentagne "Connection terminated due
// to connection timeout" på TVÆRS af samtlige Postgres-kaldende moduler,
// samtidigt med gentagne OOM-kills): hvert enkelt kaldested logger allerede
// sin egen fejlbesked, men INGEN af dem viser poolens tilstand i selve
// øjeblikket — umuligt derfor at skelne mellem tre meget forskellige
// rodårsager, der alle giver samme fejltekst:
//   1) Postgres/Fly's proxy reelt utilgængelig  → waitingCount højt, totalCount
//      hurtigt mod 0 (ingen forbindelser kan overhovedet oprettes).
//   2) Puljen fuld af RIGTIGE, aktive forbindelser (reel overbelastning)
//      → totalCount = max (20), waitingCount højt.
//   3) Puljen fuld af DØDE forbindelser efter et netværksglip, som pg endnu
//      ikke har opdaget/smidt ud (kendt pg-adfærd) → totalCount = max,
//      idleCount lavt, men intet reelt arbejde udføres.
// poolStats() vedhæftes derfor CENTRALT her — ét sted, alle kaldere får det
// automatisk — i stedet for at rette op til et dusin spredte try/catch-blokke.
function poolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

/** @param {string} text @param {any[]} [params] */
async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.warn('Postgres-forespørgsel fejlede —', e.message, poolStats());
    throw e;
  }
}

// NYT (samme hændelse): et lavfrekvent, altid-kørende hjertslag — uafhængigt
// af om noget rent faktisk fejler lige nu — så en efterfølgende gennemgang
// af logs kan se poolens tilstand HELE vejen op til en OOM-kill, ikke kun i
// de sekunder hvor en fejl tilfældigvis også blev logget. 5 min er hyppigt
// nok til at fange optrapningen af et problem, sjældent nok til ikke selv at
// blive støj i logs' normaldrift.
setInterval(() => {
  const s = poolStats();
  if (s.total > 0 || s.waiting > 0) console.log('Postgres-pulje:', s);
}, 5 * 60 * 1000);

/**
 * Låner en dedikeret klient til transaktioner (BEGIN/COMMIT/ROLLBACK) —
 * SKAL altid parres med et `finally { client.release() }`, ellers lækker
 * poolen forbindelser. Se badested-observations.js for brugsmønsteret
 * (rate limit-tjek + insert i samme transaktion, med et advisory lock).
 */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
