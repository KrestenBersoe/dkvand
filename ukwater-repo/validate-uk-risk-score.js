#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// validate-uk-risk-score.js — walk-forward backtest of the REAL,
// unmodified UK risk-score cascade (krestenbersoe/ukwater's
// server/risk/scoreSite.js — cloned locally, imported directly, never
// reimplemented) against real EA bathing-water lab samples. This is the
// score-based counterpart to validate-uk-model.js (which tested Southern
// Water's raw EDM "Impacted" classification directly) — this script tests
// the actual computed risk SCORE the real product would have shown, at the
// time of each historical lab sample.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER schema-map-edm.js,
// fetch-ea-samples.js, check-site-match.js, join-edm-ea.js OG
// fetch-uk-rainfall.js alle er kørt, OG efter krestenbersoe/ukwater er
// klonet lokalt (den ægte model-kode, ikke en genimplementering):
//   git clone https://github.com/KrestenBersoe/ukwater /path/to/ukwater
//   node validate-uk-risk-score.js --ukwater-repo /path/to/ukwater
//
// ── What's genuinely tested, and what isn't ───────────────────────────────
// scoreSite()'s cascade has three layers: (1) a rainfall-decay baseline
// probability per outlet, (2) a live-EDM-status override on top of it
// (confirmed-active -> probability 1; confirmed-recently-inactive ->
// suppressed; anything else/stale -> falls through to the rainfall
// baseline), (3) distance/current/flow decay. Layer (1) is exercised here
// with REAL historical rainfall (fetch-uk-rainfall.js, Open-Meteo archive,
// same source the real product itself uses per rainfallDecay.js's own
// comment). Layer (2) is reconstructed from REAL EDM event start/end
// timestamps (see buildLiveStatusAt() below) — not simulated, the actual
// recorded discharge windows. Layer (3)'s distance/isotropic-decay math
// runs exactly as shipped; its CURRENT-BIAS sub-path does NOT (no CMEMS
// current data has been fetched for the UK in this project) — this falls
// back gracefully to the isotropic distance decay, exactly as the real
// code's own designed fallback for "no current data for this cell" (see
// currentBias.js), so nothing crashes or is faked, but the current-aware
// refinement specifically is untested here. Its FLOW-DECAY sub-path
// (Lake/River network topology) never engages either — every site in this
// dataset is samplingPointType=CA, i.e. waterBodyType='CoastalWater'.
//
// ── Reconstructing "live" status at a past sample time, leakage-safe ──────
// The real live-override layer answers "is this outlet's EDM feed CURRENTLY
// reporting active, and how stale is that reading" — a real-time concept
// with no direct equivalent in a historical CSV export. buildLiveStatusAt()
// below answers the equivalent historical question from real event
// start/end timestamps: at query time T, was T inside some genuine event's
// [start,end] window (-> 'active', lastUpdated=T, always fresh by
// construction) — or was T shortly after some genuine event's real end
// (-> 'inactive', lastUpdated=that end, degrading past FRESHNESS_HOURS
// exactly as the real code does) — or neither (-> unknown, baseline-only).
// Only events with startTsMs <= T ever inform this, and 'Ongoing' events
// (no resolved endTsMs — ~0.01% of all events, see edm-diagnostics.json)
// are EXCLUDED from this reconstruction entirely rather than guessed at,
// since their true end is fundamentally unknowable from this export and
// guessing one would risk leaking information the real system wouldn't
// have had either.
//
// ── nearbyOutlets — real assessment history, not a spatial index ──────────
// The real product indexes "which outlets are within ~15km of this site"
// once, spatially. This project has no such index — instead, nearbyOutlets
// here is every outfall Southern Water's OWN EDM export has ever assessed
// against this site (join-edm-ea.js's output), with real haversine distance
// computed directly. Arguably a MORE precise source than a blind radius
// (it's grounded in Southern Water's own tidal/geographic judgement of
// relevance, not just proximity) — but it does mean an outfall that would
// exist in the real product's spatial index but was never actually
// assessed against this site in the EDM export (e.g. gaps in Southern
// Water's own assessment coverage) is invisible here too. The real code's
// own exponential distance decay (~3km characteristic distance for coastal
// water) makes any outlet beyond a few km contribute almost nothing
// regardless, so this is unlikely to matter much in practice, but it's a
// real substitution, not the real index.
//
// ── Output ──────────────────────────────────────────────────────────────
// <out-dir>/uk-risk-score-results-<timestamp>.json — per label-type ×
//   segment: confusion stats (Wilson CIs) at the real app's own Low/Medium
//   boundary (score > 0.2, same "elevated risk" flag convention dkvand's
//   own Danish validation used for ITS real app threshold), full PR curve
//   + AUC-PR, calibration curve — for both the combined score and the
//   bacterial-only sub-score (this dataset has no viral-pathogen lab
//   measurements to check the viral sub-score against).
// <out-dir>/uk-risk-score-summary.csv — flat table.
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
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));
const ECOLI_THRESHOLD = parseFloat(argVal('--ecoli-threshold', '500'));
const ENTEROCOCCI_THRESHOLD = parseFloat(argVal('--enterococci-threshold', '185'));
// Matches the real app's own Low(<=0.2)/Medium boundary — see
// server/risk/scoreSite.js's RISK_BANDS in the cloned repo — same
// "the app's own real flag threshold, not an arbitrary one" convention
// dkvand's Danish validation used for ITS real app's 0.2 threshold.
const FLAG_THRESHOLD = parseFloat(argVal('--flag-threshold', '0.2'));
// Isolates ONE internal rule inside the real currentBias.js, not the whole
// currents module — the "currents on/off" isolation runs already done
// (--currents pointing at a nonexistent path) test whether real current
// DATA helps; this tests whether the hard `dot<=0 -> return 0` exclusion
// rule inside coastalContributionFactor() specifically is what's costing
// AUC-PR, by softening it to the SAME isotropic fallback already used for
// "no current data for this cell" (distanceDecayFactor), instead of zeroing
// the outlet's contribution outright. See the monkey-patch block below for
// exactly what changed vs. the real source (one line, quoted inline).
const SOFTEN_CURRENT_EXCLUSION = process.argv.includes('--soften-current-exclusion');
// A second, more sophisticated isolation variant, mutually exclusive with
// the one above: instead of a hard binary step (isotropic <=500m /
// fully-current-gated beyond), blend isotropic and directional decay by a
// TRUST factor that ramps smoothly from 0 at ALWAYS_INCLUDE_DISTANCE_M
// (500m — current direction unresolvable this close, matches the real
// code's own justification for that constant) to 1 at the CMEMS grid's own
// native resolution (7km — beyond that, distinguishing direction is exactly
// as trustworthy as the real code already assumes it is everywhere beyond
// 500m). Strictly refines the real logic, not a separate design: identical
// output below 500m (trust=0 -> pure isotropic, same as real code) and
// identical output at/beyond 7km (trust=1 -> pure directional, INCLUDING
// the real hard dot<=0 exclusion at that point) — only the 500m-7km band,
// where the real code currently jumps straight to full directional trust
// at 501m, is changed.
const GRADUATED_CURRENT_TRUST = process.argv.includes('--graduated-current-trust');
if (SOFTEN_CURRENT_EXCLUSION && GRADUATED_CURRENT_TRUST) {
  console.error('--soften-current-exclusion og --graduated-current-trust er to forskellige, indbyrdes udelukkende currentBias-varianter — vælg én.');
  process.exit(1);
}

const scoreSitePath = path.join(UKWATER_REPO, 'server', 'risk', 'scoreSite.js');
if (!fs.existsSync(scoreSitePath)) {
  console.error(`Kan ikke finde ${scoreSitePath}.`);
  console.error(`Klon krestenbersoe/ukwater lokalt og angiv stien med --ukwater-repo, fx:`);
  console.error(`  git clone https://github.com/KrestenBersoe/ukwater /path/to/ukwater`);
  console.error(`  node validate-uk-risk-score.js --ukwater-repo /path/to/ukwater`);
  process.exit(1);
}

if (SOFTEN_CURRENT_EXCLUSION) {
  // Monkey-patch: mutate currentBias.js's OWN exports object before
  // scoreSite.js is required — scoreSite.js does
  // `const { coastalContributionFactor } = require('./currentBias')`,
  // and Node's require cache is keyed by resolved absolute path, so
  // requiring currentBias.js here (same absolute path scoreSite.js's own
  // relative require resolves to) and overwriting its export BEFORE
  // scoreSite.js's first require reaches that destructure means
  // scoreSite.js picks up the patched function, not the real one. Every
  // other real function (rainfallDecay, baselineProbability, liveOverride,
  // distanceDecay, flowDecay, staticFrequencyBaseline) stays untouched.
  const currentBiasPath = path.join(UKWATER_REPO, 'server', 'risk', 'currentBias.js');
  const { distanceDecayFactor } = require(path.join(UKWATER_REPO, 'server', 'risk', 'distanceDecay.js'));
  const { DECAY_LAMBDA } = require(path.join(UKWATER_REPO, 'server', 'risk', 'rainfallDecay.js'));
  const currentBiasModule = require(currentBiasPath);
  const COASTAL_TYPES = currentBiasModule.COASTAL_TYPES;
  const ALWAYS_INCLUDE_DISTANCE_M = currentBiasModule.ALWAYS_INCLUDE_DISTANCE_M;
  // Byte-identical to the real coastalContributionFactor() (server/risk/
  // currentBias.js) EXCEPT the single flagged line — real source read and
  // quoted directly, not reconstructed from memory:
  //   if (dot <= 0) return 0; // confirmed downstream or transverse — excluded, not dampened
  // becomes:
  //   if (dot <= 0) return isotropic();
  currentBiasModule.coastalContributionFactor = function patchedCoastalContributionFactor(outletLonLat, siteLonLat, distanceM, currentVectorAtOutlet, waterBodyType) {
    const isotropic = () => distanceDecayFactor(distanceM, waterBodyType);
    if (!COASTAL_TYPES.has(waterBodyType)) return isotropic();
    if (distanceM <= ALWAYS_INCLUDE_DISTANCE_M) return isotropic();
    const speed = currentVectorAtOutlet ? Math.hypot(currentVectorAtOutlet.u, currentVectorAtOutlet.v) : 0;
    if (!currentVectorAtOutlet || speed === 0) return isotropic();
    const dLon = siteLonLat[0] - outletLonLat[0];
    const dLat = siteLonLat[1] - outletLonLat[1];
    const toSiteMag = Math.hypot(dLon, dLat);
    if (toSiteMag === 0) return isotropic();
    const dot = dLon * currentVectorAtOutlet.u + dLat * currentVectorAtOutlet.v;
    if (dot <= 0) return isotropic(); // PATCHED — real code: `return 0;`
    const travelTimeHours = distanceM / speed / 3600;
    return Math.exp(-DECAY_LAMBDA * travelTimeHours);
  };
  console.log('--soften-current-exclusion: dot<=0 (downstream/transverse) nu isotropisk henfald i stedet for hård udelukkelse (0). Se filens header for det ene ændrede linje, citeret ordret fra den ægte kilde.');
}

if (GRADUATED_CURRENT_TRUST) {
  const currentBiasPath = path.join(UKWATER_REPO, 'server', 'risk', 'currentBias.js');
  const { distanceDecayFactor } = require(path.join(UKWATER_REPO, 'server', 'risk', 'distanceDecay.js'));
  const { DECAY_LAMBDA } = require(path.join(UKWATER_REPO, 'server', 'risk', 'rainfallDecay.js'));
  const currentBiasModule = require(currentBiasPath);
  const COASTAL_TYPES = currentBiasModule.COASTAL_TYPES;
  const ALWAYS_INCLUDE_DISTANCE_M = currentBiasModule.ALWAYS_INCLUDE_DISTANCE_M; // 500 — ramp start
  const CMEMS_GRID_M = 7000; // ramp end — same real product resolution cited elsewhere (isolate-distance-effect.js, the doc's references)

  function trustFactor(distanceM) {
    if (distanceM <= ALWAYS_INCLUDE_DISTANCE_M) return 0;
    if (distanceM >= CMEMS_GRID_M) return 1;
    return (distanceM - ALWAYS_INCLUDE_DISTANCE_M) / (CMEMS_GRID_M - ALWAYS_INCLUDE_DISTANCE_M);
  }

  currentBiasModule.coastalContributionFactor = function graduatedCoastalContributionFactor(outletLonLat, siteLonLat, distanceM, currentVectorAtOutlet, waterBodyType) {
    const isotropic = () => distanceDecayFactor(distanceM, waterBodyType);
    if (!COASTAL_TYPES.has(waterBodyType)) return isotropic();

    const speed = currentVectorAtOutlet ? Math.hypot(currentVectorAtOutlet.u, currentVectorAtOutlet.v) : 0;
    if (!currentVectorAtOutlet || speed === 0) return isotropic(); // no data — graceful fallback, same as real code

    const dLon = siteLonLat[0] - outletLonLat[0];
    const dLat = siteLonLat[1] - outletLonLat[1];
    const toSiteMag = Math.hypot(dLon, dLat);
    if (toSiteMag === 0) return isotropic();

    const dot = dLon * currentVectorAtOutlet.u + dLat * currentVectorAtOutlet.v;
    let directionalValue;
    if (dot > 0) {
      const travelTimeHours = distanceM / speed / 3600;
      directionalValue = Math.exp(-DECAY_LAMBDA * travelTimeHours);
    } else {
      directionalValue = 0; // current suggests downstream/transverse — same signal the real code uses, just not applied at full weight below the grid's own resolution
    }

    const trust = trustFactor(distanceM);
    return trust * directionalValue + (1 - trust) * isotropic();
  };
  console.log(`--graduated-current-trust: dot<=0/dot>0-beslutningen vægtes nu 0-100% (lineær rampe ${ALWAYS_INCLUDE_DISTANCE_M}m-${CMEMS_GRID_M}m) i stedet for et hårdt spring ved ${ALWAYS_INCLUDE_DISTANCE_M}m. Identisk med den ægte kode under ${ALWAYS_INCLUDE_DISTANCE_M}m og over ${CMEMS_GRID_M}m.`);
}

const { scoreSite } = require(scoreSitePath);

for (const [label, p] of [
  ['ea-samples.ndjson', SAMPLES_PATH], ['edm-events.ndjson', EVENTS_PATH],
  ['joined-impacts.ndjson', IMPACTS_PATH], ['ea-sites.json', SITES_PATH],
]) {
  if (!fs.existsSync(p)) {
    console.error(`Mangler ${label} (${p}). Kør schema-map-edm.js, fetch-ea-samples.js, check-site-match.js, join-edm-ea.js først.`);
    process.exit(1);
  }
}
if (!fs.existsSync(RAINFALL_DIR)) {
  console.error(`Mangler regndata (${RAINFALL_DIR}). Kør fetch-uk-rainfall.js først.`);
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

// Binary-search a sorted-by-start events array for the live status AS OF
// time T — see filehead's "Reconstructing live status" section for the
// full reasoning. events: [{startTsMs, endTsMs}], startTsMs ascending,
// ALREADY excludes 'Ongoing' (no real end) and non-genuine events.
function buildLiveStatusAt(sortedEvents, tMs) {
  if (!sortedEvents || sortedEvents.length === 0) return null;
  // Find the last event with startTsMs <= tMs (upper bound - 1).
  let lo = 0, hi = sortedEvents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedEvents[mid].startTsMs <= tMs) lo = mid + 1; else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return null; // no event has started yet as of T
  const ev = sortedEvents[idx];
  if (tMs <= ev.endTsMs) return { status: 'active', lastUpdated: tMs }; // T is inside this event's real window
  return { status: 'inactive', lastUpdated: ev.endTsMs }; // most recent relevant event already ended by T
}

function median(nums) {
  const sorted = nums.filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const t0 = Date.now();

  console.log(`Læser ${SITES_PATH}...`);
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  const siteByNotation = new Map(sites.map((s) => [s.notation, s]));

  console.log(`Læser ${EVENTS_PATH} og bygger udløbs-historik...`);
  const outletEventsByName = new Map(); // outfall name -> [{startTsMs, endTsMs}] sorted, genuine + Ended only
  const outletLatLngByName = new Map();
  let eventsScanned = 0, ongoingExcluded = 0;
  for await (const ev of ndjsonLines(EVENTS_PATH)) {
    eventsScanned++;
    if (!ev.outfall) continue;
    // See fetch-outlet-rainfall-history.js's own comment — a real malformed
    // coordinate exists in the source EDM export (STAPLEFIELD, lat=51032),
    // excluded here rather than let it corrupt this outlet's distance-decay
    // contribution with a bogus, enormous distance.
    if (ev.lat != null && ev.lng != null && ev.lat >= -90 && ev.lat <= 90 && ev.lng >= -180 && ev.lng <= 180 && !outletLatLngByName.has(ev.outfall)) outletLatLngByName.set(ev.outfall, { lat: ev.lat, lng: ev.lng });
    if (!ev.genuine) continue;
    if (ev.endedStatus !== 'Ended' || ev.endTsMs == null || ev.startTsMs == null) { ongoingExcluded++; continue; } // see filehead — 'Ongoing' events excluded, not guessed at
    if (!outletEventsByName.has(ev.outfall)) outletEventsByName.set(ev.outfall, []);
    outletEventsByName.get(ev.outfall).push({ startTsMs: ev.startTsMs, endTsMs: ev.endTsMs });
  }
  for (const arr of outletEventsByName.values()) arr.sort((a, b) => a.startTsMs - b.startTsMs);
  console.log(`${eventsScanned.toLocaleString('en')} hændelser, ${outletEventsByName.size.toLocaleString('en')} distinkte udløb med mindst én Ended/genuine hændelse (${ongoingExcluded.toLocaleString('en')} Ongoing/ufuldstændige ekskluderet).`);

  // spillFrequency.longTermAverageSpillCount MUST be an ANNUAL rate, not a
  // raw multi-year total — the real staticFrequencyBaseline.js's tier-2
  // heuristic only uses it as a ratio (unit-independent, a raw total would
  // have worked too), but compute-outlet-thresholds.js's tier-1 calibration
  // (deriveThresholdForOutlet(), imported from the real pipeline/14) uses
  // it directly as N — "the Nth-highest peak WITHIN one calendar year" — so
  // an inconsistent unit here would silently mismatch the two tiers. Fixed
  // to total genuine Ended events / distinct calendar years spanned, same
  // computation compute-outlet-thresholds.js already uses.
  const outlets = [];
  for (const [name, events] of outletEventsByName) {
    const pos = outletLatLngByName.get(name);
    const years = new Set(events.map((e) => new Date(e.startTsMs).getUTCFullYear()));
    const yearList = [...years].sort((a, b) => a - b);
    const yearsSpanned = yearList.length ? yearList[yearList.length - 1] - yearList[0] + 1 : 1;
    outlets.push({
      outletId: name,
      lat: pos ? pos.lat : null,
      lon: pos ? pos.lng : null,
      spillFrequency: { longTermAverageSpillCount: events.length / Math.max(1, yearsSpanned) },
      calibratedThreshold: null,
      events,
    });
  }

  // Real tier-1 calibrated thresholds, if compute-outlet-thresholds.js has
  // been run — optional: without it, every outlet falls through to tier 2
  // (the frequency heuristic above), exactly as before, so this stays a
  // strict improvement, never a hard requirement.
  const CALIBRATED_PATH = path.resolve(argVal('--calibrated-thresholds', path.join(DIR, 'outlet-calibrated-thresholds.json')));
  let calibratedCount = 0;
  if (fs.existsSync(CALIBRATED_PATH)) {
    const calibratedData = JSON.parse(fs.readFileSync(CALIBRATED_PATH, 'utf8'));
    const thresholds = calibratedData.thresholds || {};
    for (const outlet of outlets) {
      const t = thresholds[outlet.outletId];
      if (t) { outlet.calibratedThreshold = t; calibratedCount++; }
    }
    console.log(`Læste ${CALIBRATED_PATH}: ${calibratedCount}/${outlets.length} udløb fik en REEL kalibreret tærskel (tier 1); resten falder til frekvens-heuristikken (tier 2).`);
  } else {
    console.log(`Ingen kalibrerede tærskler fundet (${CALIBRATED_PATH}) — alle udløb bruger frekvens-heuristikken (tier 2). Kør compute-outlet-thresholds.js først for tier 1.`);
  }

  const medianLongTermSpillCount = median(outlets.map((o) => o.spillFrequency.longTermAverageSpillCount));
  console.log(`Median langsigtet årlig hændelsesrate pr. udløb: ${medianLongTermSpillCount != null ? medianLongTermSpillCount.toFixed(2) : 'n/a'}.`);

  console.log(`Læser ${IMPACTS_PATH} og bygger nearbyOutlets pr. station...`);
  const nearbyOutletNamesBySite = new Map(); // siteNotation -> Set(outfall name)
  let impactsScanned = 0;
  for await (const im of ndjsonLines(IMPACTS_PATH)) {
    impactsScanned++;
    if (!im.eaSiteNotation || !im.outfall) continue;
    if (!nearbyOutletNamesBySite.has(im.eaSiteNotation)) nearbyOutletNamesBySite.set(im.eaSiteNotation, new Set());
    nearbyOutletNamesBySite.get(im.eaSiteNotation).add(im.outfall);
  }
  console.log(`${impactsScanned.toLocaleString('en')} impact-rækker læst.`);

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
  console.log(`Regndata indlæst for ${rainfallBySite.size}/${sites.length} stationer.`);

  // Real historical CMEMS currents (fetch_uk_currents_historical.py's
  // output) — optional, matches the rainfall/calibration pattern: if
  // absent, getCurrentAt stays null and every outlet falls back to the
  // real code's own designed isotropic-decay path, exactly as the first
  // run did. currentsIndex.getCurrentAt() takes a date STRING (YYYY-MM-DD,
  // this dataset's own daily resolution), not a full timestamp.
  let currentsIndex = null;
  if (fs.existsSync(CURRENTS_PATH)) {
    currentsIndex = buildCurrentsIndex(CURRENTS_PATH);
    console.log(`Læste ${CURRENTS_PATH}: ${currentsIndex.meta.gridPointCount ?? '?'} gitterpunkter, reel dækning ${currentsIndex.meta.actualDateRange ? currentsIndex.meta.actualDateRange.join(' .. ') : '?'}.`);
  } else {
    console.log(`Ingen CMEMS-strømdata fundet (${CURRENTS_PATH}) — bruger den isotropiske afstands-henfald-fallback for alle udløb. Kør fetch_uk_currents_historical.py først for reelle strømme.`);
  }

  console.log(`Læser ${SAMPLES_PATH} og bygger etiketter...`);
  const sampleEvents = await buildLabeledSampleEvents(SAMPLES_PATH, siteByNotation, ECOLI_THRESHOLD, ENTEROCOCCI_THRESHOLD,
    (scanned, grouped) => console.log(`${scanned.toLocaleString('en')} observationsrækker scannet, ${grouped.toLocaleString('en')} prøver indgår.`));

  // NYT: fremskridtslinje hver 1.000 prøve. Hver scoreSite()-kald scanner
  // sin stations FULDE flertidige regn-array to gange (bakteriel + viral
  // henfald, rainfallDecay.js's computeDecayedAccumulation() — ikke
  // vinduesindekseret i den ÆGTE kode, bevidst ikke ændret her, se
  // filhovedet) — reelt ~19ms/prøve, målt på et 163-prøve-deltest. Ved
  // ~17.000 prøver (denne UK-datasæts fulde størrelse) er det ~5 minutter
  // tavs CPU-tid uden fremskridtslinje — nøjagtig den slags stilhed, der
  // tidligere i dette projekt er blevet misforstået som en hængende proces
  // (se fetch-ea-samples.js/schema-map-edm.js's egne tråd-tidsstempler,
  // tilføjet af samme årsag).
  console.log(`Scorer ${sampleEvents.length.toLocaleString('en')} prøver med den ÆGTE scoreSite()-kaskade...`);
  const scoreT0 = Date.now();
  let scored = 0, skippedNoRainfall = 0, skippedNoTs = 0;
  let processed = 0;
  for (const s of sampleEvents) {
    processed++;
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
    // Looked up per OUTLET (not once per site), exactly as the real
    // runScoring.js does — currents vary across a bay, see currentBias.js's
    // own comment. Bound to THIS sample's own historical date, never a
    // later one — same leakage discipline as buildLiveStatusAt() above.
    const sampleDateStr = s.phenomenonTime.slice(0, 10);
    const getCurrentAtForSample = currentsIndex
      ? (lat, lon) => {
          const p = currentsIndex.getCurrentAt(lat, lon, sampleDateStr);
          return p ? { u: p.uo, v: p.vo } : null;
        }
      : null;
    const result = scoreSite(siteWithType, nearbyWithLive, rainfall, getCurrentAtForSample, nowDate, medianLongTermSpillCount, null, null);
    s.riskScore = result.score;
    s.riskScoreBacterial = result.bacterial.score;
    s.riskScoreViral = result.viral.score;
    // The cascade's rainfall-decay term ALONE — no outlets, no live-EDM
    // status, no distance/current/flow decay. hazardScore() already
    // computes and returns this (rainfallBaselineProbability) for both
    // hazards internally; MAX of the two mirrors scoreSite()'s own
    // bacterial/viral combination rule (see that file's header comment)
    // rather than introducing a new combination logic. Answers "how much of
    // the full cascade's AUC-PR is rainfall alone already getting you."
    s.riskScoreRainfallOnly = Math.max(result.bacterial.rainfallBaselineProbability, result.viral.rainfallBaselineProbability);
    s.riskLabel = result.label;
    s.anyConfirmedActive = result.anyConfirmedActive;
    scored++;
    if (processed % 1000 === 0 || processed === sampleEvents.length) {
      const elapsedS = (Date.now() - scoreT0) / 1000;
      const perSampleMs = (elapsedS * 1000) / processed;
      const remainingS = (perSampleMs * (sampleEvents.length - processed)) / 1000;
      console.log(`  ${processed.toLocaleString('en')}/${sampleEvents.length.toLocaleString('en')} (+${elapsedS.toFixed(1)}s, ~${remainingS.toFixed(0)}s tilbage)`);
    }
  }
  console.log(`${scored.toLocaleString('en')} prøver scoret på ${((Date.now() - scoreT0) / 1000).toFixed(1)}s (${skippedNoRainfall} uden regndata, ${skippedNoTs} uden gyldigt tidsstempel).`);

  const areas = [...new Set(sites.map((s) => s.area).filter(Boolean))];

  // NYT: afstandsbånd-segmentering — tester direkte hypotesen fra UK-RISK-
  // SCORE-VALIDERING-RESULTATER.md's "What's still untested" (bruger-
  // opfølgning: "Check whether the effect is smaller for widely-separated
  // sites"). CMEMS' NWSHELF-produkt har 7km nativ gitteropløsning (se
  // fetch_uk_currents_historical.py's filhoved) — hvis den retningsbestemte
  // strøm-model gør det VÆRRE for stationer med et NÆRT udløb (samme eller
  // nabo-gittercelle, hvor 7km-opløsningen umuligt kan opløse lokal
  // strømretning), men IKKE (eller mindre) for stationer med et FJERNT
  // udløb (flere gitterceller væk, hvor storskala-strømningsmønstre er
  // mere sammenhængende og 7km derfor er en rimelig tilnærmelse), er det
  // reelt gitteropløsningen der er problemet — ikke retningsmodellen selv.
  // Båndgrænsen er sat PRÆCIS ved 7km, ikke et rundt tal, netop for at
  // matche den reelle gitterstørrelse.
  const CMEMS_GRID_KM = 7;
  const nearestOutletDistanceMBySite = new Map();
  for (const [siteNotation, list] of nearbyOutletsBySite) {
    if (list.length === 0) continue;
    nearestOutletDistanceMBySite.set(siteNotation, Math.min(...list.map((o) => o.distanceM)));
  }
  function distanceBandOf(siteNotation) {
    const d = nearestOutletDistanceMBySite.get(siteNotation);
    if (d == null) return null;
    return d < CMEMS_GRID_KM * 1000 ? 'close' : 'far';
  }

  const segments = [
    { key: 'overall', label: 'Alle stationer', filter: () => true },
    ...areas.map((a) => ({ key: `area:${a}`, label: a, filter: (s) => s.area === a })),
    { key: `distance:close`, label: `Nærmeste udløb <${CMEMS_GRID_KM}km (inden for én CMEMS-gittercelle)`, filter: (s) => distanceBandOf(s.siteNotation) === 'close' },
    { key: `distance:far`, label: `Nærmeste udløb ≥${CMEMS_GRID_KM}km (flere CMEMS-gitterceller væk)`, filter: (s) => distanceBandOf(s.siteNotation) === 'far' },
  ];
  // Excellent-tier thresholds: Bathing Water Regulations 2013 (SI 2013/1675)
  // Schedule 5, coastal/transitional waters, 95th-percentile "Excellent"
  // class — confirmed against the legislation text directly (not from
  // memory), same source already cited for the 500/185 "Sufficient" tier
  // used elsewhere in this file. Added as EXTRA labelTypes alongside the
  // existing Sufficient-tier ones, not a replacement — a stricter label
  // answers a different question ("did this look worse than mild pollution
  // levels") than the regulatory-failure question the 500/185 label
  // answers, and the two shouldn't be conflated. Computed directly from
  // each sample's raw ecoliValue/enterococciValue (unaffected by
  // --ecoli-threshold/--enterococci-threshold, which only control the
  // Sufficient-tier ecoliExceeds/enterococciExceeds/eitherExceeds fields
  // baked in by buildLabeledSampleEvents).
  const EXCELLENT_ECOLI_THRESHOLD = 250;
  const EXCELLENT_ENTEROCOCCI_THRESHOLD = 100;
  const ecoliExcellentExceeds = (s) => (s.ecoliValue != null ? s.ecoliValue > EXCELLENT_ECOLI_THRESHOLD : null);
  const enterococciExcellentExceeds = (s) => (s.enterococciValue != null ? s.enterococciValue > EXCELLENT_ENTEROCOCCI_THRESHOLD : null);

  const labelTypes = [
    { key: 'ecoli', label: 'E. coli (>500 cfu/100ml, Sufficient-grænsen)', get: (s) => s.ecoliExceeds },
    { key: 'enterococci', label: 'Intestinal enterococci (>185 cfu/100ml, Sufficient-grænsen)', get: (s) => s.enterococciExceeds },
    { key: 'either', label: 'Enten (Sufficient-grænsen, kombineret)', get: (s) => s.eitherExceeds },
    { key: 'ecoli_excellent', label: `E. coli (>${EXCELLENT_ECOLI_THRESHOLD} cfu/100ml, Excellent-grænsen)`, get: ecoliExcellentExceeds },
    { key: 'enterococci_excellent', label: `Intestinal enterococci (>${EXCELLENT_ENTEROCOCCI_THRESHOLD} cfu/100ml, Excellent-grænsen)`, get: enterococciExcellentExceeds },
    { key: 'either_excellent', label: 'Enten (Excellent-grænsen, kombineret)', get: (s) => (ecoliExcellentExceeds(s) === true) || (enterococciExcellentExceeds(s) === true) },
  ];
  const scoreFields = [
    { key: 'combined', label: 'Kombineret score (bakteriel/viral MAX — det brugeren reelt ser)', get: (s) => s.riskScore },
    { key: 'bacterial', label: 'Kun bakteriel sub-score', get: (s) => s.riskScoreBacterial },
    { key: 'rainfall_only', label: 'Kun regnhenfald (ingen udløb, live-status, afstand, strøm)', get: (s) => s.riskScoreRainfallOnly },
  ];

  const results = [];
  for (const sf of scoreFields) {
    for (const lt of labelTypes) {
      for (const seg of segments) {
        const rows = sampleEvents.filter((s) => s.riskScore != null && lt.get(s) != null && seg.filter(s));
        if (rows.length === 0) continue;
        const points = rows.map((s) => ({ score: sf.get(s), failed: lt.get(s) }));
        let tp = 0, fp = 0, tn = 0, fn = 0;
        for (const p of points) {
          const predicted = p.score > FLAG_THRESHOLD;
          if (predicted && p.failed) tp++;
          else if (predicted && !p.failed) fp++;
          else if (!predicted && p.failed) fn++;
          else tn++;
        }
        const confusion = confusionStats({ tp, fp, tn, fn });
        const pr = precisionRecallCurve(points);
        const calib = calibrationCurve(points);
        const baseRate = pr.totalPositive / rows.length;
        // AUC-PR's own random-classifier baseline equals the base rate, so
        // raw AUC-PR isn't comparable across labelTypes with different base
        // rates (e.g. the 500/185 vs 250/100 thresholds here) — lift-over-
        // base-rate (aucPr / baseRate) is the fair comparison: 1.0 means "no
        // better than guessing," regardless of how common the label is.
        const liftOverBaseRate = pr.aucPr != null && baseRate > 0 ? pr.aucPr / baseRate : null;
        results.push({
          scoreField: sf.key, scoreFieldLabel: sf.label,
          labelType: lt.key, labelDescription: lt.label,
          segment: seg.key, segmentLabel: seg.label,
          n: rows.length, totalPositive: pr.totalPositive, baseRate,
          confusionAtFlagGt0_2: confusion, aucPr: pr.aucPr, liftOverBaseRate,
          precisionRecallCurve: pr.curve, calibrationCurve: calib.buckets,
        });
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `uk-risk-score-results-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: {
      ecoliThreshold: ECOLI_THRESHOLD, enterococciThreshold: ENTEROCOCCI_THRESHOLD,
      excellentEcoliThreshold: EXCELLENT_ECOLI_THRESHOLD, excellentEnterococciThreshold: EXCELLENT_ENTEROCOCCI_THRESHOLD,
      flagThreshold: FLAG_THRESHOLD, softenCurrentExclusion: SOFTEN_CURRENT_EXCLUSION, graduatedCurrentTrust: GRADUATED_CURRENT_TRUST,
      ukwaterRepo: UKWATER_REPO, medianLongTermSpillCount,
      note: 'Scored with the REAL, unmodified scoreSite() from krestenbersoe/ukwater — see this file\'s own header for exactly which cascade layers were exercised vs. gracefully degraded (no CMEMS current data, no flow-network data, live-EDM-status reconstructed from real event start/end timestamps).',
    },
    sampleEventCount: sampleEvents.length, scoredCount: scored,
    results,
  }, null, 2), 'utf8');

  const csvPath = path.join(OUT_DIR, 'uk-risk-score-summary.csv');
  const csvHeader = ['scoreField', 'labelType', 'segment', 'n', 'totalPositive', 'baseRate', 'tp', 'fp', 'tn', 'fn', 'precision', 'precisionLo', 'precisionHi', 'recall', 'recallLo', 'recallHi', 'npv', 'npvLo', 'npvHi', 'aucPr', 'liftOverBaseRate'];
  const csvRows = [csvHeader.join(',')];
  for (const r of results) {
    const c = r.confusionAtFlagGt0_2;
    csvRows.push([
      r.scoreField, r.labelType, r.segment, r.n, r.totalPositive, r.baseRate.toFixed(4),
      c.tp, c.fp, c.tn, c.fn,
      c.precision.p != null ? c.precision.p.toFixed(4) : '', c.precision.lo != null ? c.precision.lo.toFixed(4) : '', c.precision.hi != null ? c.precision.hi.toFixed(4) : '',
      c.recall.p != null ? c.recall.p.toFixed(4) : '', c.recall.lo != null ? c.recall.lo.toFixed(4) : '', c.recall.hi != null ? c.recall.hi.toFixed(4) : '',
      c.npv.p != null ? c.npv.p.toFixed(4) : '', c.npv.lo != null ? c.npv.lo.toFixed(4) : '', c.npv.hi != null ? c.npv.hi.toFixed(4) : '',
      r.aucPr != null ? r.aucPr.toFixed(4) : '',
      r.liftOverBaseRate != null ? r.liftOverBaseRate.toFixed(3) : '',
    ].join(','));
  }
  fs.writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8');

  console.log('\n═══ Resultat (Alle stationer) — Sufficient-grænsen (>500/185, regulatorisk fejl) vs. Excellent-grænsen (>250/100, strengere) ═══');
  console.log(`Tidsforbrug: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log('AUC-PR alene er ikke sammenlignelig mellem de to grænser (forskellig baggrundsrate) — se liftOverBaseRate (aucPr / baseRate; 1.0 = ikke bedre end at gætte).');
  for (const sf of scoreFields) {
    console.log(`\n${sf.label}:`);
    for (const ltKey of ['either', 'either_excellent']) {
      const r = results.find((x) => x.scoreField === sf.key && x.labelType === ltKey && x.segment === 'overall');
      if (!r) continue;
      const c = r.confusionAtFlagGt0_2;
      console.log(`  [${ltKey}] n=${r.n}, positive=${r.totalPositive} (${(r.baseRate * 100).toFixed(1)}%), AUC-PR=${r.aucPr != null ? r.aucPr.toFixed(3) : 'n/a'}, lift=${r.liftOverBaseRate != null ? r.liftOverBaseRate.toFixed(2) + 'x' : 'n/a'}`);
      console.log(`    Ved flag-tærskel >${FLAG_THRESHOLD} (appens egen Low/Medium-grænse): precision=${c.precision.p != null ? (c.precision.p * 100).toFixed(1) + '%' : 'n/a'} [${c.precision.lo != null ? (c.precision.lo * 100).toFixed(1) : '?'}-${c.precision.hi != null ? (c.precision.hi * 100).toFixed(1) : '?'}%], recall=${c.recall.p != null ? (c.recall.p * 100).toFixed(1) + '%' : 'n/a'} [${c.recall.lo != null ? (c.recall.lo * 100).toFixed(1) : '?'}-${c.recall.hi != null ? (c.recall.hi * 100).toFixed(1) : '?'}%]`);
    }
  }
  console.log(`\nSkrevet: ${jsonPath}`);
  console.log(`Skrevet: ${csvPath}`);
  console.log(`\n(Segmenteret pr. område og determinand-type ligger i JSON'en.)`);
}

main().catch((err) => {
  console.error('validate-uk-risk-score fejlede:', err);
  process.exit(1);
});
