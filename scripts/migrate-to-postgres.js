// ═══════════════════════════════════════════════════════════════════════════
// scripts/migrate-to-postgres.js — éngangs-migrering af SQLite → Postgres
// ═══════════════════════════════════════════════════════════════════════════
//
// Kopierer eksisterende data fra app-metrics.db og badested-observations.db
// (better-sqlite3, den gamle lagring — se app-metrics.js/badested-
// observations.js's filhoveder for HVORFOR appen migrerede væk fra dem: to
// Fly-maskiner endte med to helt adskilte SQLite-filer, bekræftet direkte
// ved inspektion) over i de nye Postgres-tabeller.
//
// Kør ÉN gang, FØR den nye Postgres-baserede app-kode går i produktion —
// se samtalens plan for den fulde begrundelse. Idempotent i praksis (ON
// CONFLICT-håndtering pr. tabel, se hver sektion), så et gentaget kald mod
// en allerede-migreret database ikke dublerer data, men er IKKE beregnet
// til at køre løbende.
//
// Brug:
//   DATABASE_URL=postgresql://... node scripts/migrate-to-postgres.js \
//     --app-metrics-db=/sti/til/app-metrics.db \
//     --badested-observations-db=/sti/til/badested-observations.db
//
// Kræver better-sqlite3 (fjernes fra package.json EFTER denne migrering er
// bekræftet — se package.json's dependencies).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const { query, pool } = require('../db');

function argValue(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : fallback;
}

const APP_METRICS_DB_PATH = argValue('app-metrics-db', path.join(__dirname, '..', 'app-metrics.db'));
const BADESTED_OBS_DB_PATH = argValue('badested-observations-db', path.join(__dirname, '..', 'badested-observations.db'));

async function migrateAppMetrics() {
  const db = new Database(APP_METRICS_DB_PATH, { readonly: true });
  console.log(`\n── app-metrics.db (${APP_METRICS_DB_PATH}) ──`);

  // app_installs — ON CONFLICT DO NOTHING: hvis en frisk heartbeat allerede
  // er landet i Postgres for samme install_id (fx hvis dette script
  // undtagelsesvis køres EFTER ny trafik er begyndt), er den nyere Postgres-
  // række mere korrekt end den migrerede historiske — behold den, spring
  // den gamle over, i stedet for at overskrive med forældede data.
  const installs = db.prepare('SELECT * FROM app_installs').all();
  let installsInserted = 0;
  for (const r of installs) {
    const res = await query(`
      INSERT INTO app_installs (install_id, platform, push_enabled, first_seen, last_seen, last_seen_via)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (install_id) DO NOTHING
    `, [r.install_id, r.platform, !!r.push_enabled, r.first_seen, r.last_seen, r.last_seen_via]);
    installsInserted += res.rowCount;
  }
  console.log(`  app_installs: ${installs.length} kilde-rækker, ${installsInserted} indsat (resten sprunget over — allerede nyere data i Postgres)`);

  // badevand_daily_risk — ON CONFLICT DO UPDATE (SUM): en dags sum kan i
  // teorien være delvist akkumuleret i BÅDE den gamle SQLite-fil (før
  // deploy) OG allerede i Postgres (efter deploy, før denne migrering
  // køres) — sum/n er additive af natur (se accumulateDailyBadevandRisk()),
  // så at ADDERE er det korrekte, ikke at overskrive.
  const dailyRisk = db.prepare('SELECT * FROM badevand_daily_risk').all();
  for (const r of dailyRisk) {
    await query(`
      INSERT INTO badevand_daily_risk
        (badested_id, date, sum_bact, n_bact, sum_viral, n_viral, sum_algae, n_algae, sum_forecast, n_forecast)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (badested_id, date) DO UPDATE SET
        sum_bact     = badevand_daily_risk.sum_bact     + EXCLUDED.sum_bact,     n_bact     = badevand_daily_risk.n_bact     + EXCLUDED.n_bact,
        sum_viral    = badevand_daily_risk.sum_viral    + EXCLUDED.sum_viral,    n_viral    = badevand_daily_risk.n_viral    + EXCLUDED.n_viral,
        sum_algae    = badevand_daily_risk.sum_algae    + EXCLUDED.sum_algae,    n_algae    = badevand_daily_risk.n_algae    + EXCLUDED.n_algae,
        sum_forecast = badevand_daily_risk.sum_forecast + EXCLUDED.sum_forecast, n_forecast = badevand_daily_risk.n_forecast + EXCLUDED.n_forecast
    `, [r.badested_id, r.date, r.sum_bact, r.n_bact, r.sum_viral, r.n_viral, r.sum_algae, r.n_algae, r.sum_forecast, r.n_forecast]);
  }
  console.log(`  badevand_daily_risk: ${dailyRisk.length} rækker migreret`);

  // push_send_log — ingen unik nøgle, altid sikkert at indsætte.
  const sendLog = db.prepare('SELECT * FROM push_send_log').all();
  for (const r of sendLog) {
    await query(`INSERT INTO push_send_log (type, sent_at) VALUES ($1, $2)`, [r.type, r.sent_at]);
  }
  console.log(`  push_send_log: ${sendLog.length} rækker migreret`);

  // push_send_totals — samme additive begrundelse som badevand_daily_risk.
  const sendTotals = db.prepare('SELECT * FROM push_send_totals').all();
  for (const r of sendTotals) {
    await query(`
      INSERT INTO push_send_totals (type, total) VALUES ($1, $2)
      ON CONFLICT (type) DO UPDATE SET total = push_send_totals.total + EXCLUDED.total
    `, [r.type, r.total]);
  }
  console.log(`  push_send_totals: ${sendTotals.length} rækker migreret`);

  db.close();
}

async function migrateBadestedObservations() {
  const db = new Database(BADESTED_OBS_DB_PATH, { readonly: true });
  console.log(`\n── badested-observations.db (${BADESTED_OBS_DB_PATH}) ──`);

  // badested_vurderinger/badested_observations — Postgres tildeler FRISKE
  // SERIAL-id'er (i stedet for at forsøge at genbruge SQLite's gamle
  // rowid'er, som kunne kollidere med allerede-indsatte nye rækker hvis
  // dette script undtagelsesvis køres efter ny trafik) — vurdering_id-
  // relationen ombygges eksplicit via et id-map, så observationer stadig
  // korrekt peger på deres tilhørende vurdering.
  const vurderinger = db.prepare('SELECT * FROM badested_vurderinger ORDER BY id').all();
  const oldToNewVurderingId = new Map();
  for (const v of vurderinger) {
    const { rows } = await query(`
      INSERT INTO badested_vurderinger (badested_id, ip_hash, created_at)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [v.badested_id, v.ip_hash, v.created_at]);
    oldToNewVurderingId.set(v.id, rows[0].id);
  }
  console.log(`  badested_vurderinger: ${vurderinger.length} rækker migreret`);

  const observations = db.prepare('SELECT * FROM badested_observations ORDER BY id').all();
  let obsInserted = 0;
  for (const o of observations) {
    const newVurderingId = o.vurdering_id != null ? oldToNewVurderingId.get(o.vurdering_id) ?? null : null;
    await query(`
      INSERT INTO badested_observations
        (vurdering_id, badested_id, observation_type, algae_level, photo_path, ip_hash, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [newVurderingId, o.badested_id, o.observation_type, o.algae_level, o.photo_path, o.ip_hash, o.created_at]);
    obsInserted++;
  }
  console.log(`  badested_observations: ${obsInserted} rækker migreret`);

  db.close();
}

(async () => {
  try {
    await migrateAppMetrics();
    await migrateBadestedObservations();
    console.log('\nMigrering færdig.');
  } catch (e) {
    console.error('\nMigrering fejlede:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
