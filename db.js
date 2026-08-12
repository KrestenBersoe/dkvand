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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

pool.on('error', (err) => {
  // NYT: ubehandlede fejl på en IDLE pool-forbindelse (fx databasen lukker
  // forbindelsen efter inaktivitet) crasher ellers HELE Node-processen —
  // samme klasse fejl som ville have ramt en uventet SQLite-fejl før i
  // tiden, blot at pg's pool har sin egen 'error'-event for netop dette.
  console.error('Uventet fejl på idle Postgres-forbindelse:', err.message);
});

/** @param {string} text @param {any[]} [params] */
async function query(text, params) {
  return pool.query(text, params);
}

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
