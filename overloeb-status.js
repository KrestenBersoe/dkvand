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
 * @param {Map<string,number>} [p.subscriberCounts] — badestedId (string) -> antal webpush-abonnenter, se server.js's getSubscriberCountsForBadestedIds()
 */
function computeOverloebStatusForTenant({ tenant, horizon, riskScoresPoints, badevandList, tenantBadesteder, subscriberCounts }) {
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
        // NYT (klik-detaljepanel, bruger-ønske 2026-08-19) — panelet viser
        // TRE risikobjælker samtidig (nu/24h/72h), uafhængigt af kortets
        // egen horisont-vælger (som kun styrer `risk`/`bucket` ovenfor).
        riskNu: pt.riskScore ?? null,
        foreRisk24h: pt.foreRisk ?? null,
        foreRisk72h: pt.foreRisk72h ?? null,
        viralScore: pt.viralScore ?? null,
        algaeScore: pt.algaeScore ?? null,
        waterArea: pt.waterArea ?? null,
        dataQuality: pt.dataQuality ?? null,
        weatherKey: pt.weatherKey ?? null,
        meanVolumePerEvent: pt.meanVolumePerEvent ?? null,
        // NYT (bruger-krav 2026-08-20 — "samtlige puls data" i udløbs-
        // detaljepanelet): resten af de rå PULS-stamdata, gennemstukket fra
        // riskScoresPoints (se server.js's allPointRisks.push() for
        // feltbeskrivelser og hvorfor `cod` bevidst er udeladt).
        outfallId: pt.outfallId ?? null,
        overflowProbBase: pt.overflowProbBase ?? null,
        thresholdMm: pt.thresholdMm ?? null,
        volumeM3: pt.volumeM3 ?? null,
        eventsPerYear: pt.eventsPerYear ?? null,
        reducedArea: pt.reducedArea ?? null,
        type: pt.type ?? null,
        sewerStructure: pt.sewerStructure ?? null,
        latestDischargeYear: pt.latestDischargeYear ?? null,
        cod: pt.cod ?? null,
        bod: pt.bod ?? null,
        nitrogen: pt.nitrogen ?? null,
        phosphor: pt.phosphor ?? null,
        normalYear: pt.normalYear ?? null,
        normalVol: pt.normalVol ?? null,
        normalEv: pt.normalEv ?? null,
        normalCod: pt.normalCod ?? null,
        normalBod: pt.normalBod ?? null,
        normalNitrogen: pt.normalNitrogen ?? null,
        normalPhosphor: pt.normalPhosphor ?? null,
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
  const badesteder = (tenantBadesteder || []).map(b => {
    const entry = badevandById.get(String(b.id));
    return {
      id: b.id,
      slug: b.slug,
      navn: b.navn,
      lat: b.lat,
      lng: b.lng,
      bucket: bucketForBadested(entry),
      // NYT (klik-detaljepanel for badesteder, bruger-krav 2026-08-20 —
      // "samtlige informationer tilgængelige for såvel badestrande som
      // udløb ved klik"): samme princip som udløbenes ekstra felter
      // ovenfor — panelet skal kunne vise fuld info uden et ekstra
      // server-opslag pr. klik, `entry` er allerede i scope her.
      bact: entry?.bact ?? null,
      viral: entry?.viral ?? null,
      algae: entry?.algae ?? null,
      forecast: entry?.forecast ?? null,
      source: entry?.source ?? null,
      confirmReason: entry?.confirmReason ?? null,
      dataConfidence: entry?.dataConfidence ?? null,
      outletCount: Array.isArray(entry?.outlets) ? entry.outlets.length : 0,
      // NYT (bruger-krav 2026-08-20 — "de data om det enkelte overløb som
      // er tilgængelige i dkvand for brugerne er ikke tilgængelig i
      // kommunalt dashboard badevand kortet ... i tillæg til de øvrige
      // data"): det fulde udløbs-array, samme felter (id/navn/kommune/
      // afstand/risiko/type) som den offentlige badested-panels "Vis
      // udløb"-liste (dansk-overloeb-kort.html) allerede viser til
      // borgerne — kommune-dashboardet skal ikke vise MINDRE end det
      // offentlige site. `entry` er allerede i scope, intet ekstra opslag.
      outlets: Array.isArray(entry?.outlets) ? entry.outlets : [],
      overrideInfo: entry?.overrideInfo ?? null,
      // NYT (bruger-krav 2026-08-20 — "antal webpush abonnenter for det
      // pågældende badested" i detaljepanelet): subscriberCounts er valgfri
      // (undefined for kaldssteder der ikke har brug for det, se filhovedet)
      // — falder tilbage til 0, aldrig undefined, så klienten altid kan
      // vise et tal uden selv at skulle null-tjekke.
      subscriberCount: subscriberCounts?.get(String(b.id)) ?? 0,
    };
  });

  return { horizon, totals, udloeb, varsler, badesteder };
}

module.exports = { computeOverloebStatusForTenant, bucketForBadested, resolveHorizonField };
