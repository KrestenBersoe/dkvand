// ═══════════════════════════════════════════════════════════════════════════
// puls-risk-scoring.js
// ═══════════════════════════════════════════════════════════════════════════
//
// NYT (bruger-ønske 2026-09-16, "hub som central scorings-leder", trin 0):
// ren udtrækning af server.js's _evaluatePushNotificationsInner()'s
// PULS-punkt-risikoløkke — 100% adfærdsbevarende, ingen ny logik. Se den
// samtale, der førte hertil, for den fulde begrundelse: dette er den FØRSTE
// af to udtrækninger (denne + computeBadevandRiskCascade()'s worker-kald,
// endnu ikke flyttet) der skal lande, verificeret uændret, FØR noget
// hub-adapter-arbejde starter. Bevidst IKKE en ren FP-funktion i streng
// forstand — den muterer stadig `pt.riskScore`/`pt.viralScore`/osv. DIREKTE
// på hvert punktobjekt (badevand-risk.js's kaskade læser dem sådan bagefter,
// se server.js's eget kaldested) og `lastKnownBucketByPointId` (den
// delte, kalder-ejede Map, uændret adfærd) — men rører IKKE Postgres,
// SSE eller push-afsendelse. Selve DEN adskillelse er hele pointen: en
// fremtidig hub-adapter kan kalde denne samme funktion med sin EGEN,
// hub-lokale lastKnownBucketByPointId-Map, uden at nogen af kalderne
// risikerer at overskrive hinandens Postgres-skriv (se samtalen om
// "hvorfor ingen Postgres-skriv her").
'use strict';

const fs = require('fs');
const path = require('path');
const riskModel = require('./risk-model');
const slugIndex = require('./slug-index');
const { getCurrentAtServer } = require('./current-grid');

// NYT (trin 1, samme samtale som computeAllPointRisks() ovenfor): flyttet
// verbatim fra server.js's loadPulsPointsFull() — den HUB-adapter, der skal
// kalde computeAllPointRisks(), har brug for PRÆCIS samme punkt-liste som
// server.js selv bruger, og en kopi ét sted til ville med tiden drifte fra
// den anden (samme begrundelse som open-meteo-weather.js/current-grid.js's
// egne udtrækninger tidligere denne session). server.js's eget kaldested
// er uændret i adfærd — kun memoiseringen er nu pr.-staticDir i stedet for
// et modul-lokalt `_pulsPointsFull`, så to forskellige processer (app vs.
// hub-adapter, hver med sin egen __dirname) aldrig kan dele/forurene
// hinandens cache ved et uheld.
const _pulsPointsFullByDir = new Map();
function loadPulsPointsFull(staticDir) {
  if (_pulsPointsFullByDir.has(staticDir)) return _pulsPointsFullByDir.get(staticDir);
  let pulsPointsFull;
  try {
    const raw  = fs.readFileSync(path.join(staticDir, 'puls-data.json'), 'utf8');
    const data = JSON.parse(raw);
    const auths = data.a || [];
    const areas = data.w || [];
    const rows  = data.d || data;
    pulsPointsFull = rows.map((r, i) => {
      const derived = riskModel.derivePulsFields(r);
      const [, , , authIdx, areaIdx] = r;
      const outfallId = (r[8] != null && r[8] !== '') ? String(r[8]) : null;
      return {
        id: String(i),
        outfallId,
        name: derived.name || `Udløb ${i}`,
        municipality: auths[authIdx] || '—',
        waterArea: areas[areaIdx] || 'Ukendt',
        lat: derived.lat, lng: derived.lng,
        meanVolumePerEvent: derived.meanVolumePerEvent,
        overflowProbBase: derived.overflowProbBase,
        thresholdMm: derived.thresholdMm,
        isWastewater: derived.isWastewater,
        dataQuality: derived.dataQuality,
        volumeM3: r[5] ?? null,
        eventsPerYear: r[6] ?? null,
        reducedArea: r[9] ?? null,
        type: r[10] ?? null,
        sewerStructure: r[11] ?? null,
        latestDischargeYear: r[12] ?? null,
        cod: r[13] ?? null,
        bod: r[14] ?? null,
        nitrogen: r[15] ?? null,
        phosphor: r[16] ?? null,
        normalYear: r[17] ?? null,
        normalVol: r[18] ?? null,
        normalEv: r[19] ?? null,
        normalCod: r[20] ?? null,
        normalBod: r[21] ?? null,
        normalNitrogen: r[22] ?? null,
        normalPhosphor: r[23] ?? null,
      };
    });
    console.log(`loadPulsPointsFull: ${pulsPointsFull.length} PULS-punkter indlæst (${staticDir})`);
  } catch (e) {
    console.warn('loadPulsPointsFull fejlede:', e.message);
    pulsPointsFull = [];
  }
  _pulsPointsFullByDir.set(staticDir, pulsPointsFull);
  return pulsPointsFull;
}

/**
 * @param {Array} points - fra loadPulsPointsFull(), MUTERES (riskScore/viralScore/foreRisk/foreViralRisk/algaeScore/rainSource sættes direkte på hvert punkt)
 * @param {object} deps
 * @param {Map} deps.weatherCache - cellKey -> { ts, data }
 * @param {object} deps.dmiRain - dmi-rain.js's modul (getMeasuredForCell())
 * @param {Map|undefined} deps.waterFlagsCache - pointId -> boolean|undefined
 * @param {{ grid: object|null }} deps.currentsCache - samme form som server.js's egen
 * @param {Map} deps.lastKnownBucketByPointId - MUTERES (samme delte Map som kalderen ejer og persisterer)
 * @param {number} deps.minRisk - foreRisk-tærskel for warnPoints
 * @returns {{ warnPoints: Array, pointRisks: Map, allPointRisks: Array, bucketTransitions: Array, bucketPersistUpdates: Array, cellMatched: number, cellMissing: number, maxForecastMMSeen: number, maxTodayMMSeen: number, maxForeRiskSeen: number }}
 */
function computeAllPointRisks(points, deps) {
  const { weatherCache, dmiRain, waterFlagsCache, currentsCache, lastKnownBucketByPointId, minRisk } = deps;

  const warnPoints = [];
  const pointRisks = new Map();
  const allPointRisks = [];
  const bucketTransitions = [];
  const bucketPersistUpdates = [];

  let cellMatched = 0, cellMissing = 0;
  let maxForecastMMSeen = 0, maxTodayMMSeen = 0, maxForeRiskSeen = 0;

  for (const pt of points) {
    const key = riskModel.cellKey(pt.lat, pt.lng);
    const cached = weatherCache.get(key);
    const w = cached ? cached.data : null;
    if (!w) { cellMissing++; continue; } // ingen vejrdata for denne celle endnu
    cellMatched++;

    const measuredRain = dmiRain.getMeasuredForCell(key);
    const rainHourlyWeek = measuredRain ? measuredRain.hourlyWeek : w.hourlyWeek;
    pt.rainSource = measuredRain ? 'malt' : 'prognose';

    const precipMM = rainHourlyWeek?.length
      ? riskModel.accumulateDecayed(rainHourlyWeek, riskModel.HOURLY_DECAY_TAU_DAYS)[rainHourlyWeek.length - 1]
      : (w.antecedentMM ?? null);
    const todayMM      = measuredRain ? measuredRain.todayMM : (w.todayMM ?? null);
    const forecastMM   = w.forecastMM ?? null;
    const lastEventAge = riskModel.estimateLastEventAge(rainHourlyWeek, pt.thresholdMm);

    const riskInput = {
      overflowProbBase: pt.overflowProbBase,
      meanVolumePerEvent: pt.meanVolumePerEvent,
      thresholdMm: pt.thresholdMm,
      precipMM, forecastMM, lastEventAge,
    };
    const nowResult      = riskModel.computeRisk(riskInput);
    const nowViralRisk   = riskModel.computeViralRisk(riskInput);
    const foreRisk        = riskModel.computeForecastRisk(riskInput);
    const foreViralRisk   = riskModel.computeForecastViralRisk(riskInput);

    const ovlBucket = riskModel.riskBucket(nowResult.risk);
    const ovlPrevBucket = lastKnownBucketByPointId.get(pt.id);
    if (riskModel.shouldLogTransition(ovlPrevBucket, ovlBucket)) {
      bucketTransitions.push({
        pointId: pt.id,
        municipalityKey: slugIndex.normalizeKommuneKey(pt.municipality || ''),
        bucket: ovlBucket,
        prevBucket: ovlPrevBucket,
        risk: nowResult.risk,
        createdAt: Date.now(),
      });
    }
    if (ovlPrevBucket !== ovlBucket) {
      bucketPersistUpdates.push({ pointId: pt.id, bucket: ovlBucket, updatedAt: Date.now() });
    }
    lastKnownBucketByPointId.set(pt.id, ovlBucket);
    const foreRisk72h = riskModel.computeForecastRisk({ ...riskInput, forecastMM: w.forecastMM72h ?? null });
    pt.riskScore  = nowResult.risk;
    pt.viralScore = nowViralRisk;
    pt.foreRisk      = foreRisk;
    pt.foreViralRisk = foreViralRisk;

    let algaeScore = null;
    const isWaterPt = waterFlagsCache?.get(pt.id);
    let waterTemp = null;
    if (isWaterPt && currentsCache.grid) {
      const c = getCurrentAtServer(pt.lat, pt.lng, currentsCache.grid);
      if (c && c.temp != null) waterTemp = c.temp;
    }
    if (waterTemp === null && w.recentAirTempAvg != null) {
      waterTemp = riskModel.computeFreshwaterTemp(w.recentAirTempAvg);
    }
    if (waterTemp !== null) {
      algaeScore = riskModel.computeAlgaeRisk({ totalRain7d: w.totalRain7d, volumeM3Year: pt.volumeM3Year, waterTemp });
    }
    pt.algaeScore = algaeScore;
    if ((forecastMM || 0) > maxForecastMMSeen) maxForecastMMSeen = forecastMM || 0;
    if ((todayMM || 0) > maxTodayMMSeen) maxTodayMMSeen = todayMM || 0;
    if ((foreRisk || 0) > maxForeRiskSeen) maxForeRiskSeen = foreRisk || 0;

    const riskEntry = {
      id: pt.id, outfallId: pt.outfallId, name: pt.name, municipality: pt.municipality, waterArea: pt.waterArea,
      foreRisk, foreViralRisk, forecastMM, todayMM,
      isWastewater: pt.isWastewater,
    };
    pointRisks.set(String(pt.id), riskEntry);
    if (pt.outfallId) pointRisks.set(pt.outfallId, riskEntry);

    allPointRisks.push({
      id: pt.id,
      riskScore: nowResult.risk,
      viralScore: nowViralRisk,
      algaeScore,
      // NYT (trin 2, hub-scoring): tilføjet så et hub-synkroniseret
      // allPointRisks kan gen-mærkes tilbage på server.js's egen
      // points-array (matchet på id) og fuldt genskabe de pt.*-mutationer,
      // badevand-risk.js's kaskade læser bagefter — var tidligere KUN sat
      // direkte på pt, aldrig med i selve allPointRisks-outputtet, harmløst
      // her (ren tilføjelse, intet eksisterende kald læser/forventer dens
      // fravær).
      rainSource: pt.rainSource,
      foreRisk, foreViralRisk, foreRisk72h,
      noData: nowResult.noData,
      isWater: waterFlagsCache?.get(pt.id),
      lat: pt.lat, lng: pt.lng, municipality: pt.municipality, isWastewater: pt.isWastewater, name: pt.name,
      waterArea: pt.waterArea, dataQuality: pt.dataQuality, weatherKey: riskModel.cellKey(pt.lat, pt.lng),
      forecastMM, todayMM,
      meanVolumePerEvent: pt.meanVolumePerEvent,
      outfallId: pt.outfallId,
      overflowProbBase: pt.overflowProbBase,
      thresholdMm: pt.thresholdMm,
      volumeM3: pt.volumeM3, eventsPerYear: pt.eventsPerYear,
      reducedArea: pt.reducedArea, type: pt.type, sewerStructure: pt.sewerStructure,
      latestDischargeYear: pt.latestDischargeYear,
      cod: pt.cod, bod: pt.bod, nitrogen: pt.nitrogen, phosphor: pt.phosphor,
      normalYear: pt.normalYear, normalVol: pt.normalVol, normalEv: pt.normalEv,
      normalCod: pt.normalCod, normalBod: pt.normalBod,
      normalNitrogen: pt.normalNitrogen, normalPhosphor: pt.normalPhosphor,
    });

    if ((foreRisk || 0) > minRisk) {
      warnPoints.push({
        id: pt.id, outfallId: pt.outfallId, name: pt.name, municipality: pt.municipality, waterArea: pt.waterArea,
        foreRisk, forecastMM, todayMM,
      });
    }
  }

  return {
    warnPoints, pointRisks, allPointRisks, bucketTransitions, bucketPersistUpdates,
    cellMatched, cellMissing, maxForecastMMSeen, maxTodayMMSeen, maxForeRiskSeen,
  };
}

module.exports = { computeAllPointRisks, loadPulsPointsFull };
