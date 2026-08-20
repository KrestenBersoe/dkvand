// ═══════════════════════════════════════════════════════════════════════════
// page-views.js — daglig visningstæller pr. badested/udløb
// ═══════════════════════════════════════════════════════════════════════════
//
// Kommune Dashboard, "Statistik"-panelet (bruger-krav 2026-08-20 — "der skal
// nu opsamles tæller for antal visninger per badested", til brug for
// "# Visninger (badesteder eller overløb)"-totalen og trend-grafen). Samme
// daglige-aggregat-mønster som badevand_daily_risk/badested_alert_daily —
// ÉN række pr. (entity, dato), inkrementeret ved hver visning, ikke rå
// tidsstemplede enkeltrækker (som ville vokse ubegrænset — se app-metrics.
// js's filhoved for samme begrundelse om push_send_log's beskæring).
//
// entity_type skelner badested-visninger fra udløb-visninger — begge tæller
// med i den kommunale "# Visninger"-total, men holdes adskilt her så en
// fremtidig pr.-badested/pr.-udløb visning forbliver mulig uden en ny
// migrering.

'use strict';
const { query } = require('./db');

const ready = query(`
  CREATE TABLE IF NOT EXISTS page_views_daily (
    entity_id   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    date        TEXT NOT NULL,
    views       INT NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, entity_type, date)
  );
  CREATE INDEX IF NOT EXISTS idx_page_views_type_date ON page_views_daily(entity_type, date);
`).then(() => console.info('page-views: Postgres-skema klar'))
  .catch(e => { console.error('page-views: skemaoprettelse fejlede —', e.message); throw e; });

const VALID_ENTITY_TYPES = new Set(['badested', 'udloeb']);

function todayDateString() {
  return new Date().toISOString().slice(0, 10); // UTC-kalenderdato, samme konvention som resten af appen
}

/** Inkrementerer ÉN visning for et badested eller udløb, for i dag. */
async function recordView(entityId, entityType) {
  if (!entityId || !VALID_ENTITY_TYPES.has(entityType)) {
    const e = new Error(`Ugyldigt entityId/entityType: ${entityId}/${entityType}`);
    e.code = 'VALIDATION';
    throw e;
  }
  await query(`
    INSERT INTO page_views_daily (entity_id, entity_type, date, views)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (entity_id, entity_type, date) DO UPDATE SET views = page_views_daily.views + 1
  `, [String(entityId), entityType, todayDateString()]);
}

/**
 * Samlet visningstal (badested + udløb) for et sæt entity-id'er i et
 * datointerval — til Statistik-panelets "# Visninger"-headlinetal. IKKE
 * skelnet mellem entity_type her, da badesteder/udløb allerede er to
 * disjunkte id-rum (aldrig samme streng), og totalen bevidst er kombineret
 * ("badesteder ELLER overløb", jf. bruger-krav).
 */
async function getTotalViews(entityIds, fromDate, toDate) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) return 0;
  const { rows } = await query(`
    SELECT COALESCE(SUM(views), 0)::int AS total
    FROM page_views_daily
    WHERE entity_id = ANY($1) AND date >= $2 AND date <= $3
  `, [entityIds.map(String), fromDate, toDate]);
  return rows[0].total;
}

/** Dags-grupperet visningstrend (badested + udløb kombineret) — til grafen. */
async function getViewTrend(entityIds, fromDate, toDate) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) return [];
  const { rows } = await query(`
    SELECT date, SUM(views)::int AS n
    FROM page_views_daily
    WHERE entity_id = ANY($1) AND date >= $2 AND date <= $3
    GROUP BY date
    ORDER BY date
  `, [entityIds.map(String), fromDate, toDate]);
  return rows.map(r => ({ date: r.date, value: r.n }));
}

module.exports = { ready, recordView, getTotalViews, getViewTrend };
