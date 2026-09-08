#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// validate-uk-risk-score-traveltime.js — a VARIANT of validate-uk-risk-
// score.js, run alongside it (not replacing it), that corrects one specific
// gap found in the real scoreSite() cascade during this validation: it
// computes a real per-outlet travel time (distance ÷ measured current
// speed, or the flow-network time for Lake/River) and DOES use it — via
// coastalContributionFactor()/flowTravelTimeDecayFactor() — to discount how
// MUCH of an outlet's contribution reaches the site. What it does NOT do is
// shift WHEN that outlet's live-EDM-status/rainfall is read — every outlet,
// however far away, has its spill status and local rainfall looked up at
// the sample's own exact timestamp. So a spill that ended (per the EDM
// feed) more than FRESHNESS_HOURS=2 before the sample is read as "stale,
// fall back to rainfall baseline" even when the plume it produced, given
// real travel time, would still be arriving at the site right now.
//
// This script does NOT reimplement the underlying physics — every formula
// used (rainfallToProbability, applyLiveOverride, computeDecayedAccumulation,
// outletKMm, coastalContributionFactor, flowTravelTimeDecayFactor) is
// imported directly from the real krestenbersoe/ukwater repo, unmodified,
// same principle as validate-uk-risk-score.js. What differs is ORCHESTRATION:
// scoreSite()/hazardScore() take one shared `now` for every nearby outlet;
// this script instead calls the real sub-components once PER OUTLET, each
// with that outlet's own time-shifted `now` = sample_time − travel_time,
// then combines by MAX itself — the exact same combination rule
// scoreSite.js's own header documents and justifies (nearby outlets share
// one underlying rainfall-decay probability, so MAX is the mathematically
// correct combination, not noisy-OR).
//
// A spill isn't a point pulse — real events run from minutes to (per the
// repo owner, confirmed against real EDM durations) sometimes days. Time-
// shifting the query point is mathematically equivalent to time-shifting
// the outlet's whole [start,end] active window forward by the same travel
// time and checking whether the ORIGINAL sample time falls inside it — so
// this correctly captures a multi-hour or multi-day event's full duration
// arriving at the site with a lag, not just its start. No internal
// ramp/peak/taper shape is imposed within an event — the real EDM export
// gives only start/end/duration, nothing about within-event intensity, so
// assuming any particular curve shape would be inventing structure the
// data doesn't support.
//
// ── The one real asymmetry, documented rather than papered over ──────────
// Travel time is only computable where a real velocity exists: measured
// CMEMS current speed (coastal, when data is available and points toward
// the site) or the flow-network time (Lake/River — never engaged here,
// every site in this dataset is CoastalWater). Outlets that fall back to
// ISOTROPIC distance decay (no usable current for that cell, or within
// ALWAYS_INCLUDE_DISTANCE_M, or non-coastal) have no speed in that model at
// all — there is no data-supported travel time for them, so their live-
// status/rainfall lookup stays at the sample's own raw time, unshifted,
// same as validate-uk-risk-score.js already does. Outlets excluded outright
// by direction (current flowing away from the site, contribution forced to
// 0) need no time shift either — they contribute nothing regardless.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER validate-uk-risk-score.js's
// own prerequisites (schema-map-edm.js, fetch-ea-samples.js,
// check-site-match.js, join-edm-ea.js, fetch-uk-rainfall.js, and ideally
// compute-outlet-thresholds.js + fetch_uk_currents_historical.py — this
// variant's travel-time correction only ever engages for outlets that
// currents data resolves as directional in the first place):
//   node validate-uk-risk-score-traveltime.js --ukwater-repo /path/to/ukwater
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { confusionStats, precisionRecallCurve, calibrationCurve } = require('./lib/backtest-stats');
const { buildLabeledSampleEvents } = require('./lib/uk-sample-labels');
const { buildCurrentsIndex } = require('./lib/currents-lookup');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const OUT_DIR = path.resolve(argVal('--out-dir', DIR));
const SAMPLES_PATH = path.resolve(argVal('--samples', path.join(DIR, 'ea-samples.ndjson')));
const EVENTS_PATH = path.resolve(argVal('--events', path.join(DIR, 'edm-events.ndjson')));
const IMPACTS_PATH = path.resolve(argVal('--joined-impacts', path.join(DIR, 'joined-impacts.ndjson')));
const SITES_PATH = path.resolve(argVal('--sites', path.join(DIR, 'ea-sites.json')));
const RAINFALL_DIR = path.resolve(argVal('--rainfall-dir', path.join(DIR, 'rainfall')));
const CURRENTS_PATH = path.resolve(argVal('--currents', path.join(DIR, 'currents-history.json')));
const CALIBRATED_PATH = path.resolve(argVal('--calibrated-thresholds', path.join(DIR, 'outlet-calibrated-thresholds.json')));
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));
const ECOLI_THRESHOLD = parseFloat(argVal('--ecoli-threshold', '500'));
const ENTEROCOCCI_THRESHOLD = parseFloat(argVal('--enterococci-threshold', '185'));
const FLAG_THRESHOLD = parseFloat(argVal('--flag-threshold', '0.2'));

function req(rel) { return require(path.join(UKWATER_REPO, rel)); }
let computeDecayedAccumulation, DECAY_LAMBDA, VIRAL_DECAY_LAMBDA;
let rainfallToProbability;
let outletKMm;
let applyLiveOverride;
let coastalContributionFactor, ALWAYS_INCLUDE_DISTANCE_M, COASTAL_TYPES;
let distanceDecayFactor;
let flowTravelTimeDecayFactor;
let riskLabel;
try {
  ({ computeDecayedAccumulation, DECAY_LAMBDA, VIRAL_DECAY_LAMBDA } = req('server/risk/rainfallDecay.js'));
  ({ rainfallToProbability } = req('server/risk/baselineProbability.js'));
  ({ outletKMm } = req('server/risk/staticFrequencyBaseline.js'));
  ({ applyLiveOverride } = req('server/risk/liveOverride.js'));
  ({ coastalContributionFactor, ALWAYS_INCLUDE_DISTANCE_M, COASTAL_TYPES } = req('server/risk/currentBias.js'));
  ({ distanceDecayFactor } = req('server/risk/distanceDecay.js'));
  ({ flowTravelTimeDecayFactor } = req('server/risk/flowDecay.js'));
  ({ riskLabel } = req('server/risk/scoreSite.js'));
} catch (err) {
  console.error(`Kan ikke indlæse ægte moduler fra --ukwater-repo (${UKWATER_REPO}): ${err.message}`);
  process.exit(1);
}

for (const [label, p] of [
  ['ea-samples.ndjson', SAMPLES_PATH], ['edm-events.ndjson', EVENTS_PATH],
  ['joined-impacts.ndjson', IMPACTS_PATH], ['ea-sites.json', SITES_PATH],
]) {
  if (!fs.existsSync(p)) { console.error(`Mangler ${label} (${p}).`); process.exit(1); }
}
if (!fs.existsSync(RAINFALL_DIR)) { console.error(`Mangler regndata (${RAINFALL_DIR}). Kør fetch-uk-rainfall.js først.`); process.exit(1); }

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) { if (!line) continue; yield JSON.parse(line); }
}
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function median(nums) {
  const sorted = nums.filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// Same live-status-at-T reconstruction as validate-uk-risk-score.js — see
// that file's header for the leakage-safety reasoning, unchanged here.
function buildLiveStatusAt(sortedEvents, tMs) {
  if (!sortedEvents || sortedEvents.length === 0) return null;
  let lo = 0, hi = sortedEvents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedEvents[mid].startTsMs <= tMs) lo = mid + 1; else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return null;
  const ev = sortedEvents[idx];
  if (tMs <= ev.endTsMs) return { status: 'active', lastUpdated: tMs };
  return { status: 'inactive', lastUpdated: ev.endTsMs };
}

// Mirrors coastalContributionFactor()'s own decision tree EXACTLY (same
// imported constants/functions, same branch order) but returns the
// intermediate travel time that function computes internally and discards,
// instead of only the final decay factor — see this file's header for why
// that one extra piece of information is needed here. Returns:
//   { mode: 'isotropic' }        — no data-supported travel time; don't shift
//   { mode: 'excluded' }         — confirmed downstream/transverse; contributes 0 regardless, don't shift
//   { mode: 'directional', travelTimeHours }
function classifyOutletTransport(outletLonLat, siteLonLat, distanceM, currentVectorAtOutlet, waterBodyType) {
  if (!COASTAL_TYPES.has(waterBodyType)) return { mode: 'isotropic' };
  if (distanceM <= ALWAYS_INCLUDE_DISTANCE_M) return { mode: 'isotropic' };
  const speed = currentVectorAtOutlet ? Math.hypot(currentVectorAtOutlet.u, currentVectorAtOutlet.v) : 0;
  if (!currentVectorAtOutlet || speed === 0) return { mode: 'isotropic' };
  const dLon = siteLonLat[0] - outletLonLat[0];
  const dLat = siteLonLat[1] - outletLonLat[1];
  if (Math.hypot(dLon, dLat) === 0) return { mode: 'isotropic' };
  const dot = dLon * currentVectorAtOutlet.u + dLat * currentVectorAtOutlet.v;
  if (dot <= 0) return { mode: 'excluded' };
  return { mode: 'directional', travelTimeHours: distanceM / speed / 3600 };
}

// One hazard (bacterial or viral) for one site, combining nearby outlets by
// MAX — same rule as the real hazardScore(), but each outlet's live-status
// and rainfall are read at ITS OWN time-shifted `now` when a real travel
// time is available (see classifyOutletTransport() above), not the site's
// shared sample time.
function hazardScoreTravelTimeCorrected(site, nearbyOutlets, siteRainfallHourly, getCurrentAt, sampleNow, medianLongTermSpillCount, decayLambda) {
  let best = 0;
  let anyConfirmedActive = false;
  for (const { outlet, distanceM } of nearbyOutlets) {
    const currentVectorAtOutlet = getCurrentAt ? getCurrentAt(outlet.lat, outlet.lon) : null;
    const transport = classifyOutletTransport([outlet.lon, outlet.lat], [site.lon, site.lat], distanceM, currentVectorAtOutlet, site.waterBodyType);
    if (transport.mode === 'excluded') continue; // contributes 0 either way — see header

    const shiftedNowMs = transport.mode === 'directional' ? sampleNow.getTime() - transport.travelTimeHours * 3600 * 1000 : sampleNow.getTime();
    const shiftedNow = new Date(shiftedNowMs);

    const decayedMm = siteRainfallHourly ? computeDecayedAccumulation(siteRainfallHourly, shiftedNow, decayLambda) : 0;
    const kMm = outletKMm(outlet, medianLongTermSpillCount);
    const baseline = rainfallToProbability(decayedMm, kMm);
    const live = buildLiveStatusAt(outlet.events, shiftedNowMs);
    const { probability, confirmedActive } = applyLiveOverride(live, baseline, shiftedNow);

    const decayFactor = transport.mode === 'directional'
      ? Math.exp(-decayLambda * transport.travelTimeHours) // same DECAY_LAMBDA-based transit decay coastalContributionFactor() applies — see that function; recomputed here per-lambda (bacterial vs viral) since the real function hardcodes rainfallDecay's own DECAY_LAMBDA, not a caller-supplied one
      : distanceDecayFactor(distanceM, site.waterBodyType);

    const contribution = Math.min(1, probability * decayFactor);
    if (contribution > best) best = contribution;
    if (confirmedActive) anyConfirmedActive = true;
  }
  return { score: best, anyConfirmedActive };
}

function scoreSiteTravelTimeCorrected(site, nearbyOutlets, siteRainfallHourly, getCurrentAt, sampleNow, medianLongTermSpillCount, viralDecayLambda) {
  const bacterial = hazardScoreTravelTimeCorrected(site, nearbyOutlets, siteRainfallHourly, getCurrentAt, sampleNow, medianLongTermSpillCount, DECAY_LAMBDA);
  const viral = hazardScoreTravelTimeCorrected(site, nearbyOutlets, siteRainfallHourly, getCurrentAt, sampleNow, medianLongTermSpillCount, viralDecayLambda ?? VIRAL_DECAY_LAMBDA);
  return { score: Math.max(bacterial.score, viral.score), bacterial, viral };
}

async function main() {
  const t0 = Date.now();

  console.log(`Læser ${SITES_PATH}...`);
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  const siteByNotation = new Map(sites.map((s) => [s.notation, s]));

  console.log(`Læser ${EVENTS_PATH} og bygger udløbs-historik...`);
  const outletEventsByName = new Map();
  const outletLatLngByName = new Map();
  let eventsScanned = 0, ongoingExcluded = 0;
  for await (const ev of ndjsonLines(EVENTS_PATH)) {
    eventsScanned++;
    if (!ev.outfall) continue;
    if (ev.lat != null && ev.lng != null && ev.lat >= -90 && ev.lat <= 90 && ev.lng >= -180 && ev.lng <= 180 && !outletLatLngByName.has(ev.outfall)) outletLatLngByName.set(ev.outfall, { lat: ev.lat, lng: ev.lng });
    if (!ev.genuine) continue;
    if (ev.endedStatus !== 'Ended' || ev.endTsMs == null || ev.startTsMs == null) { ongoingExcluded++; continue; }
    if (!outletEventsByName.has(ev.outfall)) outletEventsByName.set(ev.outfall, []);
    outletEventsByName.get(ev.outfall).push({ startTsMs: ev.startTsMs, endTsMs: ev.endTsMs });
  }
  for (const arr of outletEventsByName.values()) arr.sort((a, b) => a.startTsMs - b.startTsMs);
  console.log(`${eventsScanned.toLocaleString('en')} hændelser, ${outletEventsByName.size.toLocaleString('en')} distinkte udløb (${ongoingExcluded.toLocaleString('en')} Ongoing/ufuldstændige ekskluderet).`);

  const outlets = [];
  for (const [name, events] of outletEventsByName) {
    const pos = outletLatLngByName.get(name);
    const years = new Set(events.map((e) => new Date(e.startTsMs).getUTCFullYear()));
    const yearList = [...years].sort((a, b) => a - b);
    const yearsSpanned = yearList.length ? yearList[yearList.length - 1] - yearList[0] + 1 : 1;
    outlets.push({
      outletId: name, lat: pos ? pos.lat : null, lon: pos ? pos.lng : null,
      spillFrequency: { longTermAverageSpillCount: events.length / Math.max(1, yearsSpanned) },
      calibratedThreshold: null, events,
    });
  }

  let calibratedCount = 0;
  if (fs.existsSync(CALIBRATED_PATH)) {
    const calibratedData = JSON.parse(fs.readFileSync(CALIBRATED_PATH, 'utf8'));
    const thresholds = calibratedData.thresholds || {};
    for (const outlet of outlets) { const t = thresholds[outlet.outletId]; if (t) { outlet.calibratedThreshold = t; calibratedCount++; } }
    console.log(`Kalibrerede tærskler: ${calibratedCount}/${outlets.length} udløb (tier 1).`);
  } else {
    console.log(`Ingen kalibrerede tærskler fundet — alle udløb bruger frekvens-heuristikken (tier 2).`);
  }
  const medianLongTermSpillCount = median(outlets.map((o) => o.spillFrequency.longTermAverageSpillCount));
  console.log(`Median langsigtet årlig hændelsesrate: ${medianLongTermSpillCount != null ? medianLongTermSpillCount.toFixed(2) : 'n/a'}.`);

  console.log(`Læser ${IMPACTS_PATH} og bygger nearbyOutlets pr. station...`);
  const nearbyOutletNamesBySite = new Map();
  for await (const im of ndjsonLines(IMPACTS_PATH)) {
    if (!im.eaSiteNotation || !im.outfall) continue;
    if (!nearbyOutletNamesBySite.has(im.eaSiteNotation)) nearbyOutletNamesBySite.set(im.eaSiteNotation, new Set());
    nearbyOutletNamesBySite.get(im.eaSiteNotation).add(im.outfall);
  }
  const outletByName = new Map(outlets.map((o) => [o.outletId, o]));
  const nearbyOutletsBySite = new Map();
  for (const [siteNotation, names] of nearbyOutletNamesBySite) {
    const site = siteByNotation.get(siteNotation);
    if (!site || site.lat == null || site.lng == null) continue;
    const list = [];
    for (const name of names) {
      const outlet = outletByName.get(name);
      if (!outlet || outlet.lat == null || outlet.lon == null) continue;
      list.push({ outlet, distanceM: haversineM(site.lat, site.lng, outlet.lat, outlet.lon) });
    }
    nearbyOutletsBySite.set(siteNotation, list);
  }

  console.log(`Læser regndata fra ${RAINFALL_DIR}...`);
  const rainfallBySite = new Map();
  for (const site of sites) {
    const p = path.join(RAINFALL_DIR, `${site.notation}.json`);
    if (fs.existsSync(p)) rainfallBySite.set(site.notation, JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  console.log(`Regndata indlæst for ${rainfallBySite.size}/${sites.length} stationer.`);

  let currentsIndex = null;
  if (fs.existsSync(CURRENTS_PATH)) {
    currentsIndex = buildCurrentsIndex(CURRENTS_PATH);
    console.log(`Strømdata: ${currentsIndex.meta.gridPointCount ?? '?'} gitterpunkter, dækning ${currentsIndex.meta.actualDateRange ? currentsIndex.meta.actualDateRange.join(' .. ') : '?'}.`);
  } else {
    console.log(`Ingen CMEMS-strømdata fundet — uden strøm er ALLE udløb isotropiske, så denne variant vil give IDENTISKE resultater til validate-uk-risk-score.js (ingen udløb kan få en retningsbestemt rejsetid uden strømvektorer). Kør fetch_uk_currents_historical.py først for at denne variant skal vise noget nyt.`);
  }

  console.log(`Læser ${SAMPLES_PATH} og bygger etiketter...`);
  const sampleEvents = await buildLabeledSampleEvents(SAMPLES_PATH, siteByNotation, ECOLI_THRESHOLD, ENTEROCOCCI_THRESHOLD,
    (scanned, grouped) => console.log(`${scanned.toLocaleString('en')} observationsrækker scannet, ${grouped.toLocaleString('en')} prøver indgår.`));

  console.log(`Scorer ${sampleEvents.length.toLocaleString('en')} prøver med rejsetids-korrigeret scoring...`);
  const scoreT0 = Date.now();
  let scored = 0, skippedNoRainfall = 0, skippedNoTs = 0, processed = 0;
  let directionalOutletHits = 0, isotropicOutletHits = 0, excludedOutletHits = 0;
  for (const s of sampleEvents) {
    processed++;
    if (s.tsMs == null) { skippedNoTs++; continue; }
    const site = siteByNotation.get(s.siteNotation);
    const rainfall = rainfallBySite.get(s.siteNotation);
    if (!rainfall) { skippedNoRainfall++; continue; }
    const nearby = nearbyOutletsBySite.get(s.siteNotation) || [];
    const sampleDateStr = s.phenomenonTime.slice(0, 10);
    const getCurrentAtForSample = currentsIndex
      ? (lat, lon) => { const p = currentsIndex.getCurrentAt(lat, lon, sampleDateStr); return p ? { u: p.uo, v: p.vo } : null; }
      : null;
    const siteWithType = { siteId: site.notation, lat: site.lat, lon: site.lng, waterBodyType: 'CoastalWater' };
    const nowDate = new Date(s.tsMs);

    for (const { outlet, distanceM } of nearby) {
      const cv = getCurrentAtForSample ? getCurrentAtForSample(outlet.lat, outlet.lon) : null;
      const t = classifyOutletTransport([outlet.lon, outlet.lat], [siteWithType.lon, siteWithType.lat], distanceM, cv, siteWithType.waterBodyType);
      if (t.mode === 'directional') directionalOutletHits++; else if (t.mode === 'excluded') excludedOutletHits++; else isotropicOutletHits++;
    }

    const result = scoreSiteTravelTimeCorrected(siteWithType, nearby, rainfall, getCurrentAtForSample, nowDate, medianLongTermSpillCount, null);
    s.riskScoreTT = result.score;
    s.riskScoreBacterialTT = result.bacterial.score;
    scored++;
    if (processed % 1000 === 0 || processed === sampleEvents.length) {
      const elapsedS = (Date.now() - scoreT0) / 1000;
      const remainingS = (elapsedS * 1000 / processed) * (sampleEvents.length - processed) / 1000;
      console.log(`  ${processed.toLocaleString('en')}/${sampleEvents.length.toLocaleString('en')} (+${elapsedS.toFixed(1)}s, ~${remainingS.toFixed(0)}s tilbage)`);
    }
  }
  console.log(`${scored.toLocaleString('en')} prøver scoret på ${((Date.now() - scoreT0) / 1000).toFixed(1)}s (${skippedNoRainfall} uden regndata, ${skippedNoTs} uden gyldigt tidsstempel).`);
  console.log(`Udløbs-klassificering (talt pr. prøve × nærliggende udløb, ikke unikke udløb): ${directionalOutletHits.toLocaleString('en')} retningsbestemt (rejsetid anvendt), ${isotropicOutletHits.toLocaleString('en')} isotropisk (ingen rejsetid tilgængelig), ${excludedOutletHits.toLocaleString('en')} udelukket (nedstrøms/tværgående).`);

  const areas = [...new Set(sites.map((s) => s.area).filter(Boolean))];
  const segments = [{ key: 'overall', label: 'Alle stationer', filter: () => true }, ...areas.map((a) => ({ key: `area:${a}`, label: a, filter: (s) => s.area === a }))];
  const labelTypes = [
    { key: 'ecoli', label: 'E. coli (>500 cfu/100ml)', get: (s) => s.ecoliExceeds },
    { key: 'enterococci', label: 'Intestinal enterococci (>185 cfu/100ml)', get: (s) => s.enterococciExceeds },
    { key: 'either', label: 'Enten (kombineret)', get: (s) => s.eitherExceeds },
  ];
  const scoreFields = [
    { key: 'combined_tt', label: 'Kombineret score, rejsetids-korrigeret', get: (s) => s.riskScoreTT },
    { key: 'bacterial_tt', label: 'Bakteriel sub-score, rejsetids-korrigeret', get: (s) => s.riskScoreBacterialTT },
  ];

  const results = [];
  for (const sf of scoreFields) {
    for (const lt of labelTypes) {
      for (const seg of segments) {
        const rows = sampleEvents.filter((s) => sf.get(s) != null && lt.get(s) != null && seg.filter(s));
        if (rows.length === 0) continue;
        const points = rows.map((s) => ({ score: sf.get(s), failed: lt.get(s) }));
        let tp = 0, fp = 0, tn = 0, fn = 0;
        for (const p of points) {
          const predicted = p.score > FLAG_THRESHOLD;
          if (predicted && p.failed) tp++; else if (predicted && !p.failed) fp++; else if (!predicted && p.failed) fn++; else tn++;
        }
        const confusion = confusionStats({ tp, fp, tn, fn });
        const pr = precisionRecallCurve(points);
        const calib = calibrationCurve(points);
        results.push({
          scoreField: sf.key, scoreFieldLabel: sf.label, labelType: lt.key, labelDescription: lt.label,
          segment: seg.key, segmentLabel: seg.label, n: rows.length, totalPositive: pr.totalPositive, baseRate: pr.totalPositive / rows.length,
          confusionAtFlagGt0_2: confusion, aucPr: pr.aucPr, precisionRecallCurve: pr.curve, calibrationCurve: calib.buckets,
        });
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `uk-risk-score-traveltime-results-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: { ecoliThreshold: ECOLI_THRESHOLD, enterococciThreshold: ENTEROCOCCI_THRESHOLD, flagThreshold: FLAG_THRESHOLD, ukwaterRepo: UKWATER_REPO, medianLongTermSpillCount, calibratedCount },
    outletClassificationCounts: { directional: directionalOutletHits, isotropic: isotropicOutletHits, excluded: excludedOutletHits },
    sampleEventCount: sampleEvents.length, scoredCount: scored, results,
  }, null, 2), 'utf8');

  const csvPath = path.join(OUT_DIR, 'uk-risk-score-traveltime-summary.csv');
  const csvHeader = ['scoreField', 'labelType', 'segment', 'n', 'totalPositive', 'baseRate', 'tp', 'fp', 'tn', 'fn', 'precision', 'precisionLo', 'precisionHi', 'recall', 'recallLo', 'recallHi', 'npv', 'npvLo', 'npvHi', 'aucPr'];
  const csvRows = [csvHeader.join(',')];
  for (const r of results) {
    const c = r.confusionAtFlagGt0_2;
    csvRows.push([
      r.scoreField, r.labelType, r.segment, r.n, r.totalPositive, r.baseRate.toFixed(4), c.tp, c.fp, c.tn, c.fn,
      c.precision.p != null ? c.precision.p.toFixed(4) : '', c.precision.lo != null ? c.precision.lo.toFixed(4) : '', c.precision.hi != null ? c.precision.hi.toFixed(4) : '',
      c.recall.p != null ? c.recall.p.toFixed(4) : '', c.recall.lo != null ? c.recall.lo.toFixed(4) : '', c.recall.hi != null ? c.recall.hi.toFixed(4) : '',
      c.npv.p != null ? c.npv.p.toFixed(4) : '', c.npv.lo != null ? c.npv.lo.toFixed(4) : '', c.npv.hi != null ? c.npv.hi.toFixed(4) : '',
      r.aucPr != null ? r.aucPr.toFixed(4) : '',
    ].join(','));
  }
  fs.writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8');

  console.log('\n═══ Resultat (Alle stationer, Enten-determinand, rejsetids-korrigeret) ═══');
  console.log(`Tidsforbrug: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  for (const sf of scoreFields) {
    const r = results.find((x) => x.scoreField === sf.key && x.labelType === 'either' && x.segment === 'overall');
    if (!r) continue;
    const c = r.confusionAtFlagGt0_2;
    console.log(`\n${sf.label}:`);
    console.log(`  n=${r.n}, positive=${r.totalPositive} (${(r.baseRate * 100).toFixed(1)}%), AUC-PR=${r.aucPr != null ? r.aucPr.toFixed(3) : 'n/a'}`);
    console.log(`  Ved flag-tærskel >${FLAG_THRESHOLD}: precision=${c.precision.p != null ? (c.precision.p * 100).toFixed(1) + '%' : 'n/a'} [${c.precision.lo != null ? (c.precision.lo * 100).toFixed(1) : '?'}-${c.precision.hi != null ? (c.precision.hi * 100).toFixed(1) : '?'}%], recall=${c.recall.p != null ? (c.recall.p * 100).toFixed(1) + '%' : 'n/a'} [${c.recall.lo != null ? (c.recall.lo * 100).toFixed(1) : '?'}-${c.recall.hi != null ? (c.recall.hi * 100).toFixed(1) : '?'}%]`);
  }
  console.log(`\nSkrevet: ${jsonPath}`);
  console.log(`Skrevet: ${csvPath}`);
  console.log(`\nSammenlign disse tal DIREKTE med den seneste (samme kalibrering/strøm-input) kørsel af validate-uk-risk-score.js — samme prøver, samme etiketter, samme kalibrering, samme strømdata, kun forskel: HVORNÅR hvert udløbs live-status/regn læses.`);
}

main().catch((err) => {
  console.error('validate-uk-risk-score-traveltime fejlede:', err);
  process.exit(1);
});
