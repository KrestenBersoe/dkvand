// ═══════════════════════════════════════════════════════════════════════════
// scripts/migrate-push-subscriptions.js — éngangs-migrering af
// push-subscriptions.json → push_subscriptions (Postgres)
// ═══════════════════════════════════════════════════════════════════════════
//
// RETTET (2026-08-02, produktionshændelse): denne migrering blev ved en
// fejl UDELADT fra Deploy 2 (server.js's Postgres-omlægning af push-
// abonnementer) — 557 reelle abonnenters data lå fortsat KUN i den gamle
// push-subscriptions.json på volumen, usynlig for den nye kode, indtil
// dette script blev kørt. Se scripts/migrate-to-postgres.js for samme
// mønster brugt til app-metrics.db/badested-observations.db.
//
// Brug:
//   DATABASE_URL=postgresql://... node scripts/migrate-push-subscriptions.js \
//     --file=/sti/til/push-subscriptions.json
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../db');

function argValue(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : fallback;
}

const FILE_PATH = argValue('file', path.join(__dirname, '..', 'push-subscriptions.json'));

(async () => {
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error('Forventede et array i ' + FILE_PATH);

    let inserted = 0, skipped = 0;
    for (const e of entries) {
      const endpoint = e?.subscription?.endpoint;
      if (!endpoint) { skipped++; continue; }
      // ON CONFLICT DO NOTHING: hvis en frisk subscribe allerede er landet
      // i Postgres for samme endpoint (fx en bruger, der åbnede appen efter
      // deploy men før dette script kørte), er den nyere Postgres-række
      // mere korrekt end den migrerede historiske.
      const res = await query(`
        INSERT INTO push_subscriptions (endpoint, subscription, favourites, badevand_groups, install_id, platform, notified_state, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (endpoint) DO NOTHING
      `, [
        endpoint,
        JSON.stringify(e.subscription),
        JSON.stringify(e.favourites || []),
        JSON.stringify(e.badevandGroups || []),
        e.installId || null,
        e.platform || null,
        JSON.stringify(e.notifiedState || {}),
        e.ts ? new Date(e.ts) : new Date(),
      ]);
      inserted += res.rowCount;
    }
    console.log(`push_subscriptions: ${entries.length} kilde-rækker, ${inserted} indsat, ${skipped} sprunget over (manglende endpoint eller allerede nyere data)`);
  } catch (e) {
    console.error('Migrering fejlede:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
