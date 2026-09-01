// ═══════════════════════════════════════════════════════════════════════════
// admin-stats.js — cross-market admin dashboard: dkvand's egne 7 nøgletal
// ═══════════════════════════════════════════════════════════════════════════
//
// Erstatter det offentlige, ikke-periode-følsomme /stats (stats.html) med et
// internt dashboard, der viser SAMME slags tal (installationer, webpush-
// abonnenter, indberetninger, udsendte varsler) PLUS tre nye (sidevisninger,
// site-detaljevisninger, lukkede badesteder), alle for en VALGBAR periode —
// se server.js's GET /internal/api/admin-stats.
//
// Bevidst ÉN samlet fil for alle 7 målinger, fremfor at sprede nye
// funktioner ud over page-views.js/app-metrics.js/badested-overrides.js/
// badested-observations.js — denne funktions ENESTE ansvar er "aggregér for
// admin-dashboardet", den ejer ingen af de underliggende tabeller selv
// (samme adskillelse som badested-overrides.js's egen "de rene funktioner
// ligger et andet sted"-princip). Kun DK's egne tal — server.js kombinerer
// selv med UK/FR (server-til-server, se dens filhoved for hvorfor IKKE
// klient-side cross-origin denne gang).
'use strict';
const { query } = require('./db');

// Matcher badested-override-logic.js's OVERRIDE_BUCKETS — ikke importeret
// derfra (kun denne ene værdi er relevant her), men SKAL holdes i sync hvis
// den fils bucket-navne nogensinde ændres.
const CLOSED_BUCKET = 'lukket';
const ACTIVE_INSTALL_WINDOW_MS = 14 * 24 * 3600 * 1000; // samme vindue som app-metrics.js's egen getInstallStats() default

/**
 * Udfylder ALLE dage i [fromDate, toDate] (inklusiv) med 0, overskrevet med
 * faktiske værdier hvor de findes — uden dette ville en graf med nul-dage
 * midt i perioden fejlagtigt tegne en lige linje henover dem i stedet for
 * at vise det reelle fald til nul.
 * @param {string} fromDate 'YYYY-MM-DD'
 * @param {string} toDate 'YYYY-MM-DD'
 * @param {Map<string, number>} sparse
 * @returns {{date: string, value: number}[]}
 */
function fillDateRange(fromDate, toDate, sparse) {
  const out = [];
  const cur = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    out.push({ date: d, value: sparse.get(d) || 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function rowsToSparseMap(rows, dateKey = 'date', valueKey = 'n') {
  return new Map(rows.map(r => [r[dateKey], Number(r[valueKey])]));
}

/** @param {string} dateStr 'YYYY-MM-DD' @returns {number} ms ved dagens START (UTC) */
function dateStartMs(dateStr) { return new Date(dateStr + 'T00:00:00.000Z').getTime(); }
/** @param {string} dateStr 'YYYY-MM-DD' @returns {number} ms ved dagens SLUT (UTC, inklusiv) */
function dateEndMs(dateStr) { return new Date(dateStr + 'T23:59:59.999Z').getTime(); }

/**
 * @param {{fromDate: string, toDate: string}} p — begge 'YYYY-MM-DD', inklusive
 */
async function getAdminDashboardStats({ fromDate, toDate }) {
  const fromMs = dateStartMs(fromDate), toMs = dateEndMs(toDate);
  const fromTs = new Date(fromMs), toTs = new Date(toMs); // push_subscriptions/badested_overrides bruger TIMESTAMPTZ, ikke BIGINT ms

  const [
    siteViewsTotal, siteViewsTrend,
    pageViewsTotal, pageViewsTrend,
    newInstallsTotal, newInstallsTrend, activeInstallsNow,
    newSubsTotal, newSubsTrend, subsNow,
    reportsTotal, reportsTrend,
    alertsTotal, alertsTrend,
    overrideRows,
  ] = await Promise.all([
    query(`SELECT COALESCE(SUM(views),0)::int AS n FROM page_views_daily WHERE entity_type IN ('badested','udloeb') AND date BETWEEN $1 AND $2`, [fromDate, toDate]),
    query(`SELECT date, SUM(views)::int AS n FROM page_views_daily WHERE entity_type IN ('badested','udloeb') AND date BETWEEN $1 AND $2 GROUP BY date`, [fromDate, toDate]),
    query(`SELECT COALESCE(SUM(views),0)::int AS n FROM page_views_daily WHERE entity_type = 'side' AND date BETWEEN $1 AND $2`, [fromDate, toDate]),
    query(`SELECT date, SUM(views)::int AS n FROM page_views_daily WHERE entity_type = 'side' AND date BETWEEN $1 AND $2 GROUP BY date`, [fromDate, toDate]),
    query(`SELECT COUNT(*)::int AS n FROM app_installs WHERE first_seen BETWEEN $1 AND $2`, [fromMs, toMs]),
    query(`SELECT (date_trunc('day', to_timestamp(first_seen/1000.0) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date::text AS date, COUNT(*)::int AS n FROM app_installs WHERE first_seen BETWEEN $1 AND $2 GROUP BY 1`, [fromMs, toMs]),
    query(`SELECT COUNT(*)::int AS n FROM app_installs WHERE last_seen > $1`, [Date.now() - ACTIVE_INSTALL_WINDOW_MS]),
    query(`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE created_at BETWEEN $1 AND $2`, [fromTs, toTs]),
    query(`SELECT (date_trunc('day', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date::text AS date, COUNT(*)::int AS n FROM push_subscriptions WHERE created_at BETWEEN $1 AND $2 GROUP BY 1`, [fromTs, toTs]),
    query(`SELECT COUNT(*)::int AS n FROM push_subscriptions`),
    query(`SELECT COUNT(*)::int AS n FROM badested_vurderinger WHERE created_at BETWEEN $1 AND $2`, [fromMs, toMs]),
    query(`SELECT (date_trunc('day', to_timestamp(created_at/1000.0) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date::text AS date, COUNT(*)::int AS n FROM badested_vurderinger WHERE created_at BETWEEN $1 AND $2 GROUP BY 1`, [fromMs, toMs]),
    query(`SELECT COALESCE(SUM(count),0)::int AS n FROM badested_alert_daily WHERE date BETWEEN $1 AND $2`, [fromDate, toDate]),
    query(`SELECT date, SUM(count)::int AS n FROM badested_alert_daily WHERE date BETWEEN $1 AND $2 GROUP BY date`, [fromDate, toDate]),
    // NYT (lukkede badesteder): henter overlappende overstyringer ÉN gang for
    // hele perioden — antallet er typisk lille (få hundrede rækker for en
    // borgervarslings-app), så den daglige distinct-optælling beregnes i JS
    // nedenfor i stedet for en generate_series-SQL-forespørgsel pr. dag.
    query(
      `SELECT badested_id, created_at, revoked_at, expires_at FROM badested_overrides
       WHERE bucket = $1 AND created_at <= $3 AND (revoked_at IS NULL OR revoked_at >= $2) AND expires_at >= $2`,
      [CLOSED_BUCKET, fromTs, toTs]
    ),
  ]);

  // Dagligt distinct-lukket-antal — ét badested tæller kun én gang pr. dag,
  // selv med flere overlappende overstyringer.
  const closedTrendMap = new Map();
  let closedAnyDaySet = new Set();
  {
    const cur = new Date(fromDate + 'T00:00:00Z');
    const end = new Date(toDate + 'T00:00:00Z');
    while (cur <= end) {
      const dayStart = cur.getTime(), dayEnd = dayStart + 24 * 3600 * 1000 - 1;
      const ids = new Set();
      for (const r of overrideRows.rows) {
        const created = new Date(r.created_at).getTime();
        const revoked = r.revoked_at ? new Date(r.revoked_at).getTime() : null;
        const expires = new Date(r.expires_at).getTime();
        if (created <= dayEnd && expires >= dayStart && (revoked === null || revoked >= dayStart)) {
          ids.add(r.badested_id);
          closedAnyDaySet.add(r.badested_id);
        }
      }
      closedTrendMap.set(cur.toISOString().slice(0, 10), ids.size);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  return {
    totals: {
      siteViews: siteViewsTotal.rows[0].n,
      pageViews: pageViewsTotal.rows[0].n,
      newInstalls: newInstallsTotal.rows[0].n,
      activeInstalls: activeInstallsNow.rows[0].n,
      newPushSubscriptions: newSubsTotal.rows[0].n,
      pushSubscriptions: subsNow.rows[0].n,
      reports: reportsTotal.rows[0].n,
      alertsSent: alertsTotal.rows[0].n,
      closedSites: closedAnyDaySet.size,
    },
    trends: {
      siteViews: fillDateRange(fromDate, toDate, rowsToSparseMap(siteViewsTrend.rows)),
      pageViews: fillDateRange(fromDate, toDate, rowsToSparseMap(pageViewsTrend.rows)),
      newInstalls: fillDateRange(fromDate, toDate, rowsToSparseMap(newInstallsTrend.rows)),
      newPushSubscriptions: fillDateRange(fromDate, toDate, rowsToSparseMap(newSubsTrend.rows)),
      reports: fillDateRange(fromDate, toDate, rowsToSparseMap(reportsTrend.rows)),
      alertsSent: fillDateRange(fromDate, toDate, rowsToSparseMap(alertsTrend.rows)),
      closedSites: fillDateRange(fromDate, toDate, closedTrendMap),
    },
  };
}

module.exports = { getAdminDashboardStats, fillDateRange, rowsToSparseMap };
