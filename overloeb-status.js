// ═══════════════════════════════════════════════════════════════════════════
// overloeb-status.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Kommune Dashboard, "Overløb"-fanen (bruger-ønske 2026-08-19) — ren
// beregningsfunktion (intet DB/netværk-kald selv) der kommune-scoper og
// rød/gul/grøn-bucketer BÅDE de udløb (PULS-punkter, kloak+regnvand) OG de
// badesteder en given tenant/kommune skal se på sit live overløbskort.
//
// Kaldes af server.js's GET /admin/api/overloeb-status med data der ALLEREDE
// er beregnet/cachet af den eksisterende 15-minutters cyklus
// (_evaluatePushNotificationsInner() → riskScoresCache/badevandRiskCache) —
// ingen live-genberegning her, samme cache-filosofi som resten af appen.

const riskModel = require('./risk-model');
const { normalizeKommuneKey } = require('./slug-index');

const HORIZON_FIELDS = { nu: 'riskScore', '24h': 'foreRisk', '72h': 'foreRisk72h' };

function resolveHorizonField(horizon) {
  return HORIZON_FIELDS[horizon] || HORIZON_FIELDS.nu;
}

// NYT — REQUIRED-SYNCED med dansk-overloeb-kort.html's colorBadevandByRisk()
// (de tre særlige `source`-tilstande, i samme rækkefølge/forrang): ændres
// farvelogikken for badevands-markørerne på hovedkortet, skal denne
// funktion opdateres tilsvarende, ellers kan Kommune Dashboardets
// badested-status komme til at afvige fra hovedkortets.
function bucketForBadested(entry) {
  if (!entry) return 'ingen-data';
  // Aktiv kommune-override vinder over alt andet — samme forrang som
  // badested-overrides.js's applyActiveOverrides()-kommentar beskriver
  // (overrideInfo er PURT ADDITIVT et andet sted, men her er det bevidst
  // den autoritative visning, fordi det ER hvad kommunen selv har sat).
  if (entry.overrideInfo?.bucket) return entry.overrideInfo.bucket;
  if (entry.source === 'server-utilgaengelig') return 'ingen-data';
  if (entry.source === 'ingen-bekraeftet' || entry.source === 'nedstroms-bekraeftet') return 'groen';
  const active = [entry.bact, entry.viral].filter(v => v !== null && v !== undefined);
  const risk = active.length ? Math.max(...active) : null;
  return riskModel.riskBucket(risk);
}

/**
 * @param {object} p
 * @param {{name: string}} p.tenant
 * @param {'nu'|'24h'|'72h'} p.horizon
 * @param {Array} p.riskScoresPoints  — riskScoresCache.points (server.js) — alle PULS-punkter, ukommune-scopet
 * @param {Array} p.badevandList      — badevandRiskCache.badevand (server.js)
 * @param {Array} p.tenantBadesteder  — tenantBadesteder.resolveTenantBadesteder()'s resultat, [{id,slug,navn,lat,lng}]
 */
function computeOverloebStatusForTenant({ tenant, horizon, riskScoresPoints, badevandList, tenantBadesteder }) {
  const horizonField = resolveHorizonField(horizon);
  const tenantKey = normalizeKommuneKey(tenant?.name || '');

  // "Samtlige overløb" — ALLE PULS-punkter hvis EGEN municipality-felt
  // matcher kommunen (samme mekanisme som Datakvalitet-KPI'en i
  // computeKommuneBenchmark(), server.js), IKKE begrænset til dem der
  // allerede er koblet til et badested. isWastewater bruges kun som
  // type-mærkning (kloak/regnvand), aldrig som filter her.
  const udloeb = (riskScoresPoints || [])
    .filter(pt => pt.municipality && normalizeKommuneKey(pt.municipality) === tenantKey)
    .map(pt => {
      const risk = pt[horizonField] ?? null;
      return {
        id: pt.id,
        navn: pt.name,
        lat: pt.lat,
        lng: pt.lng,
        isWastewater: pt.isWastewater,
        risk,
        bucket: riskModel.riskBucket(risk),
        forecastMM: pt.forecastMM ?? null,
        todayMM: pt.todayMM ?? null,
      };
    });

  const totals = { roed: 0, gul: 0, groen: 0, ingenData: 0 };
  for (const u of udloeb) {
    if (u.bucket === 'roed') totals.roed++;
    else if (u.bucket === 'gul') totals.gul++;
    else if (u.bucket === 'groen') totals.groen++;
    else totals.ingenData++;
  }

  // Udløbs-alarmlisten under kortet — kun aktive gul/rød-varsler, højeste
  // risiko øverst (samme "mest presserende først"-princip som Varsler-fanen).
  const varsler = udloeb
    .filter(u => u.bucket === 'roed' || u.bucket === 'gul')
    .sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1));

  const badevandById = new Map((badevandList || []).map(e => [String(e.id), e]));
  const badesteder = (tenantBadesteder || []).map(b => ({
    id: b.id,
    slug: b.slug,
    navn: b.navn,
    lat: b.lat,
    lng: b.lng,
    bucket: bucketForBadested(badevandById.get(String(b.id))),
  }));

  return { horizon, totals, udloeb, varsler, badesteder };
}

module.exports = { computeOverloebStatusForTenant, bucketForBadested, resolveHorizonField };
