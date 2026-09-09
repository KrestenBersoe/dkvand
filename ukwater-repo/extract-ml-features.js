#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// extract-ml-features.js — dumps a labeled feature table (NDJSON) for
// training an ALTERNATIVE model (gradient-boosted trees / logistic
// regression) against the same real, labeled dataset validate-uk-risk-
// score.js backtests the hand-designed scoreSite() cascade against.
//
// Not a reimplementation of the cascade: every feature is either read
// directly off the REAL hazardScore() result (decayedRainfallMm,
// rainfallBaselineProbability, allContributors' own contribution/distanceM/
// baseline/confirmedActive fields) or looked up from the same real currents
// index the real code uses (currents-lookup.js) — nothing here recomputes
// distance decay, rainfall decay, or the live-override rule by hand. The
// one thing this script does NOT reuse is scoreSite()'s own MAX-of-outlets
// COMBINATION step for the ML feature vector itself — the whole point is to
// hand a learned model the same raw per-outlet ingredients and let it learn
// its own combination, rather than being told the answer is "take the max."
// scoreSite()'s own combined score IS still computed and recorded (twice —
// with and without currents) purely as the comparison baseline.
//
// Per sample, two REAL scoreSite() calls are made: one with real currents
// (getCurrentAt wired up, same as validate-uk-risk-score.js's default run),
// one without (getCurrentAt=null) — giving both rule-based comparison
// numbers in one pass, at 2x the per-sample cost. Always uses the shrinkage-
// calibrated thresholds (this session's own best-evidenced calibration
// fix) — matches the "shrinkage-only, no currents" configuration already
// documented as the best-performing tested rule-based config.
//
// Kør fra ukwater-repo/, efter schema-map-edm.js, fetch-ea-samples.js,
// check-site-match.js, join-edm-ea.js, fetch-uk-rainfall.js OG
// compute-outlet-thresholds-shrinkage.js er kørt:
//   node extract-ml-features.js --ukwater-repo /path/to/ukwater
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { buildLabeledSampleEvents } = require('./lib/uk-sample-labels');
const { buildCurrentsIndex } = require('./lib/currents-lookup');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const SAMPLES_PATH = path.resolve(argVal('--samples', path.join(DIR, 'ea-samples.ndjson')));
const EVENTS_PATH = path.resolve(argVal('--events', path.join(DIR, 'edm-events.ndjson')));
const IMPACTS_PATH = path.resolve(argVal('--joined-impacts', path.join(DIR, 'joined-impacts.ndjson')));
const SITES_PATH = path.resolve(argVal('--sites', path.join(DIR, 'ea-sites.json')));
const RAINFALL_DIR = path.resolve(argVal('--rainfall-dir', path.join(DIR, 'rainfall')));
const CURRENTS_PATH = path.resolve(argVal('--currents', path.join(DIR, 'currents-history.json')));
const CALIBRATED_PATH = path.resolve(argVal('--calibrated-thresholds', path.join(DIR, 'outlet-calibrated-thresholds-shrinkage.json')));
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));
const ECOLI_THRESHOLD = parseFloat(argVal('--ecoli-threshold', '500'));
const ENTEROCOCCI_THRESHOLD = parseFloat(argVal('--enterococci-threshold', '185'));
const OUT_PATH = path.resolve(argVal('--out', path.join(DIR, 'ml-features.ndjson')));
const TOP_K = parseInt(argVal('--top-k', '5'), 10);

const { scoreSite } = require(path.join(UKWATER_REPO, 'server', 'risk', 'scoreSite.js'));
const { distanceDecayFactor } = require(path.join(UKWATER_REPO, 'server', 'risk', 'distanceDecay.js'));

for (const [label, p] of [
  ['ea-samples.ndjson', SAMPLES_PATH], ['edm-events.ndjson', EVENTS_PATH],
  ['joined-impacts.ndjson', IMPACTS_PATH], ['ea-sites.json', SITES_PATH],
  ['outlet-calibrated-thresholds-shrinkage.json', CALIBRATED_PATH],
]) {
  if (!fs.existsSync(p)) {
    console.error(`Mangler ${label} (${p}).`);
    process.exit(1);
  }
}
if (!fs.existsSync(RAINFALL_DIR)) {
  console.error(`Mangler regndata (${RAINFALL_DIR}).`);
  process.exit(1);
}

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Identical binary-search reconstruction of "live status as of T" as
// validate-uk-risk-score.js — see that file for the leakage-safety
// reasoning (only real event start/end timestamps, Ongoing excluded).
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

function median(nums) {
  const sorted = nums.filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const LIVE_SOURCE_CODE = { 'baseline-only': 0, 'baseline-only-stale-live': 0, 'live-confirmed': 2, 'live-suppressed': 1 };

async function main() {
  const t0 = Date.now();

  console.log(`Læser ${SITES_PATH}...`);
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  const siteByNotation = new Map(sites.map((s) => [s.notation, s]));

  console.log(`Læser ${EVENTS_PATH} og bygger udløbs-historik...`);
  const outletEventsByName = new Map();
  const outletLatLngByName = new Map();
  for await (const ev of ndjsonLines(EVENTS_PATH)) {
    if (!ev.outfall) continue;
    if (ev.lat != null && ev.lng != null && ev.lat >= -90 && ev.lat <= 90 && ev.lng >= -180 && ev.lng <= 180 && !outletLatLngByName.has(ev.outfall)) outletLatLngByName.set(ev.outfall, { lat: ev.lat, lng: ev.lng });
    if (!ev.genuine) continue;
    if (ev.endedStatus !== 'Ended' || ev.endTsMs == null || ev.startTsMs == null) continue;
    if (!outletEventsByName.has(ev.outfall)) outletEventsByName.set(ev.outfall, []);
    outletEventsByName.get(ev.outfall).push({ startTsMs: ev.startTsMs, endTsMs: ev.endTsMs });
  }
  for (const arr of outletEventsByName.values()) arr.sort((a, b) => a.startTsMs - b.startTsMs);

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

  const calibratedData = JSON.parse(fs.readFileSync(CALIBRATED_PATH, 'utf8'));
  const thresholds = calibratedData.thresholds || {};
  let calibratedCount = 0;
  for (const outlet of outlets) {
    const t = thresholds[outlet.outletId];
    if (t) { outlet.calibratedThreshold = t; calibratedCount++; }
  }
  console.log(`${calibratedCount}/${outlets.length} udløb fik en shrinkage-kalibreret tærskel.`);

  const medianLongTermSpillCount = median(outlets.map((o) => o.spillFrequency.longTermAverageSpillCount));

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
      const distanceM = haversineM(site.lat, site.lng, outlet.lat, outlet.lon);
      list.push({ outlet, distanceM });
    }
    nearbyOutletsBySite.set(siteNotation, list);
  }

  console.log(`Læser regndata fra ${RAINFALL_DIR}...`);
  const rainfallBySite = new Map();
  for (const site of sites) {
    const p = path.join(RAINFALL_DIR, `${site.notation}.json`);
    if (fs.existsSync(p)) rainfallBySite.set(site.notation, JSON.parse(fs.readFileSync(p, 'utf8')));
  }

  let currentsIndex = null;
  if (fs.existsSync(CURRENTS_PATH)) {
    currentsIndex = buildCurrentsIndex(CURRENTS_PATH);
    console.log(`Læste ${CURRENTS_PATH}.`);
  } else {
    console.log(`Ingen strømdata fundet — strøm-features udelades.`);
  }

  console.log(`Læser ${SAMPLES_PATH} og bygger etiketter...`);
  const sampleEvents = await buildLabeledSampleEvents(SAMPLES_PATH, siteByNotation, ECOLI_THRESHOLD, ENTEROCOCCI_THRESHOLD,
    (scanned, grouped) => console.log(`${scanned.toLocaleString('en')} observationsrækker scannet, ${grouped.toLocaleString('en')} prøver indgår.`));

  console.log(`Udtrækker features for ${sampleEvents.length.toLocaleString('en')} prøver...`);
  const out = fs.createWriteStream(OUT_PATH);
  let written = 0, skippedNoRainfall = 0, skippedNoTs = 0;
  const t1 = Date.now();

  for (let i = 0; i < sampleEvents.length; i++) {
    const s = sampleEvents[i];
    if (s.tsMs == null) { skippedNoTs++; continue; }
    const site = siteByNotation.get(s.siteNotation);
    const rainfall = rainfallBySite.get(s.siteNotation);
    if (!rainfall) { skippedNoRainfall++; continue; }
    const nearby = nearbyOutletsBySite.get(s.siteNotation) || [];
    const nowDate = new Date(s.tsMs);
    const nearbyWithLive = nearby.map(({ outlet, distanceM }) => ({
      outlet: { ...outlet, live: buildLiveStatusAt(outlet.events, s.tsMs) },
      distanceM,
    }));
    const siteWithType = { siteId: site.notation, lat: site.lat, lon: site.lng, waterBodyType: 'CoastalWater' };
    const sampleDateStr = s.phenomenonTime.slice(0, 10);
    const getCurrentAtForSample = currentsIndex
      ? (lat, lon) => { const p = currentsIndex.getCurrentAt(lat, lon, sampleDateStr); return p ? { u: p.uo, v: p.vo } : null; }
      : null;

    // REAL scoreSite(), twice — with and without currents — see filehead.
    const resultWithCurrents = scoreSite(siteWithType, nearbyWithLive, rainfall, getCurrentAtForSample, nowDate, medianLongTermSpillCount, null, null);
    const resultNoCurrents = scoreSite(siteWithType, nearbyWithLive, rainfall, null, nowDate, medianLongTermSpillCount, null, null);

    const bact = resultWithCurrents.bacterial;
    const viral = resultWithCurrents.viral;
    const contributors = bact.allContributors; // sorted desc by contribution, real code's own order

    const row = {
      siteNotation: s.siteNotation, area: s.area, tsMs: s.tsMs, phenomenonTime: s.phenomenonTime,
      ecoliValue: s.ecoliValue, enterococciValue: s.enterococciValue,
      ecoliExceeds: s.ecoliExceeds, enterococciExceeds: s.enterococciExceeds, eitherExceeds: s.eitherExceeds,
      ruleBasedScoreWithCurrents: resultWithCurrents.score,
      ruleBasedScoreNoCurrents: resultNoCurrents.score,
      ruleBasedRainfallOnly: Math.max(bact.rainfallBaselineProbability, viral.rainfallBaselineProbability),
      f_bactDecayedMm: bact.decayedRainfallMm,
      f_bactBaselineProb: bact.rainfallBaselineProbability,
      f_viralDecayedMm: viral.decayedRainfallMm,
      f_viralBaselineProb: viral.rainfallBaselineProbability,
      f_nearbyOutletCount: nearby.length,
      f_anyConfirmedActive: bact.anyConfirmedActive ? 1 : 0,
      f_minDistanceM: nearby.length > 0 ? Math.min(...nearby.map((o) => o.distanceM)) : null,
    };

    for (let k = 0; k < TOP_K; k++) {
      const c = contributors[k];
      const outletMeta = c ? outletByName.get(c.outletId) : null;
      const distanceM = c ? c.distanceM : null;
      let curDot = null, curSpeed = null;
      if (c && currentsIndex && outletMeta && outletMeta.lat != null) {
        const p = currentsIndex.getCurrentAt(outletMeta.lat, outletMeta.lon, sampleDateStr);
        if (p) {
          const dLon = site.lng - outletMeta.lon, dLat = site.lat - outletMeta.lat;
          const mag = Math.hypot(dLon, dLat);
          curSpeed = Math.hypot(p.uo, p.vo);
          curDot = mag > 0 ? (dLon * p.uo + dLat * p.vo) / mag : null; // signed, toward-site-normalized
        }
      }
      row[`f_top${k}_contribution`] = c ? c.contribution : 0;
      row[`f_top${k}_distanceM`] = distanceM != null ? distanceM : null;
      row[`f_top${k}_baseline`] = c ? c.baseline : 0;
      row[`f_top${k}_liveSourceCode`] = c ? (LIVE_SOURCE_CODE[c.liveSource] ?? 0) : 0;
      row[`f_top${k}_isotropicContribution`] = c ? Math.min(1, c.baseline * distanceDecayFactor(distanceM, 'CoastalWater')) : 0;
      row[`f_top${k}_currentDot`] = curDot;
      row[`f_top${k}_currentSpeed`] = curSpeed;
    }

    out.write(JSON.stringify(row) + '\n');
    written++;
    if ((i + 1) % 1000 === 0 || i + 1 === sampleEvents.length) {
      const elapsedS = (Date.now() - t1) / 1000;
      console.log(`  ${(i + 1).toLocaleString('en')}/${sampleEvents.length.toLocaleString('en')} (+${elapsedS.toFixed(1)}s)`);
    }
  }
  out.end();
  console.log(`${written.toLocaleString('en')} rækker skrevet til ${OUT_PATH} (${skippedNoRainfall} uden regndata, ${skippedNoTs} uden tidsstempel). Total: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

main().catch((err) => { console.error('extract-ml-features fejlede:', err); process.exit(1); });
