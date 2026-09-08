#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// compute-outlet-thresholds.js — derives a REAL calibrated per-outlet
// rainfall threshold (tier 1 of staticFrequencyBaseline.js's 3-tier
// priority), using the ACTUAL, unmodified functions from krestenbersoe/
// ukwater's pipeline/14-compute-outlet-thresholds.js (collapsePeaks,
// sliceYear, accumulateDecayed, deriveThresholdForOutlet,
// kNearestByDistance) — imported directly, not reimplemented, same
// principle as validate-uk-risk-score.js importing the real scoreSite().
//
// validate-uk-risk-score.js's first run used tier 2 (the frequency
// heuristic) for every outlet, because no calibratedThreshold existed —
// this script produces that missing tier-1 input, so a rerun can use it.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER schema-map-edm.js OG
// fetch-outlet-rainfall-history.js:
//   node compute-outlet-thresholds.js --ukwater-repo /path/to/ukwater
//
// ── One real divergence from the source pipeline, worth flagging ─────────
// pipeline/14 reads outlet.spillFrequency.longTermAverageSpillCount as an
// ANNUAL rate (it's used directly as N, "the Nth-highest peak WITHIN one
// calendar year" — deriveThresholdForOutlet's own `eventsYear` parameter
// name says as much). This project's own outlet construction elsewhere
// (validate-uk-risk-score.js) had been using each outlet's RAW total
// genuine-event count over the whole ~11-year dataset — fine for tier 2's
// heuristic (a pure ratio, so a consistent unit cancels out), but WRONG for
// tier 1 if fed in unconverted: an outlet with 41 total events over 11
// years is a ~3.7/year outlet, not a 41/year one, and asking
// deriveThresholdForOutlet for "the 41st-highest peak in a single year"
// would silently pick a far less extreme (or entirely nonexistent) peak
// than intended. Recomputed here as a proper annual rate — total genuine
// Ended events divided by the number of distinct calendar years that
// outlet's own events span — and used consistently for both tiers.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const EVENTS_PATH = path.resolve(argVal('--events', path.join(DIR, 'edm-events.ndjson')));
const HISTORY_PATH = path.resolve(argVal('--history', path.join(DIR, 'outlet-rainfall-history.json')));
const OUT_PATH = path.resolve(argVal('--out', path.join(DIR, 'outlet-calibrated-thresholds.json')));
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));

const pipeline14Path = path.join(UKWATER_REPO, 'pipeline', '14-compute-outlet-thresholds.js');
const cellKeyPath = path.join(UKWATER_REPO, 'pipeline', '13-fetch-outlet-rainfall-history.js');
for (const [label, p] of [['pipeline/14', pipeline14Path], ['pipeline/13', cellKeyPath]]) {
  if (!fs.existsSync(p)) { console.error(`Kan ikke finde ${label} (${p}). Angiv --ukwater-repo.`); process.exit(1); }
}
const { deriveThresholdForOutlet, kNearestByDistance } = require(pipeline14Path);
const { cellKey } = require(cellKeyPath);

for (const [label, p] of [['edm-events.ndjson', EVENTS_PATH], ['outlet-rainfall-history.json', HISTORY_PATH]]) {
  if (!fs.existsSync(p)) { console.error(`Mangler ${label} (${p}).`); process.exit(1); }
}

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

async function main() {
  console.log(`Læser ${EVENTS_PATH} og bygger udløbs-liste med reel årlig hændelsesrate...`);
  const outletYears = new Map(); // outletId -> Set(year)
  const outletLatLng = new Map();
  let scanned = 0;
  for await (const ev of ndjsonLines(EVENTS_PATH)) {
    scanned++;
    if (!ev.outfall) continue;
    // See fetch-outlet-rainfall-history.js's own comment — a real malformed
    // coordinate exists in the source EDM export (STAPLEFIELD, lat=51032),
    // excluded here rather than let it corrupt kNearestByDistance()'s
    // donor-matching with a bogus, enormous distance.
    if (ev.lat != null && ev.lng != null && ev.lat >= -90 && ev.lat <= 90 && ev.lng >= -180 && ev.lng <= 180 && !outletLatLng.has(ev.outfall)) outletLatLng.set(ev.outfall, { lat: ev.lat, lon: ev.lng });
    if (!ev.genuine || ev.endedStatus !== 'Ended' || ev.startTsMs == null) continue; // see filehead — 'Ongoing' excluded, matches validate-uk-risk-score.js's own reconstruction
    const year = new Date(ev.startTsMs).getUTCFullYear();
    if (!outletYears.has(ev.outfall)) outletYears.set(ev.outfall, new Set());
    outletYears.get(ev.outfall).add(year);
  }
  // Total events per outlet, separately from the per-year Set above (need the
  // COUNT of events, not just which years had any).
  const outletTotalEvents = new Map();
  {
    const rl2 = readline.createInterface({ input: fs.createReadStream(EVENTS_PATH) });
    for await (const line of rl2) {
      if (!line) continue;
      const ev = JSON.parse(line);
      if (!ev.outfall || !ev.genuine || ev.endedStatus !== 'Ended' || ev.startTsMs == null) continue;
      outletTotalEvents.set(ev.outfall, (outletTotalEvents.get(ev.outfall) || 0) + 1);
    }
  }

  const outlets = [];
  for (const [outletId, years] of outletYears) {
    const pos = outletLatLng.get(outletId);
    if (!pos) continue;
    const total = outletTotalEvents.get(outletId) || 0;
    // Years SPANNED (min..max inclusive), not just years WITH an event —
    // an outlet quiet for a year in the middle of its span still had that
    // year's rainfall "fail" to trigger it, which is real information the
    // annual rate should reflect, not skip over.
    const yearList = [...years].sort((a, b) => a - b);
    const yearsSpanned = yearList[yearList.length - 1] - yearList[0] + 1;
    const annualRate = total / Math.max(1, yearsSpanned);
    outlets.push({ outletId, lat: pos.lat, lon: pos.lon, spillFrequency: { longTermAverageSpillCount: annualRate, totalEvents: total, yearsSpanned } });
  }
  console.log(`${scanned.toLocaleString('en')} hændelser scannet, ${outlets.length} udløb med koordinater og mindst én Ended/genuine hændelse.`);

  console.log(`Læser ${HISTORY_PATH}...`);
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  const availableYears = [];
  for (let y = parseInt(history.meta.startDate.slice(0, 4), 10); y <= parseInt(history.meta.endDate.slice(0, 4), 10); y++) availableYears.push(y);
  console.log(`Regnhistorik dækker ${history.meta.startDate} – ${history.meta.endDate} (kandidatår: ${availableYears.join(', ')}), ${Object.keys(history.cells).length} gitterceller.`);

  // ── Group 1: direct derivation, using the REAL deriveThresholdForOutlet() ──
  const derived = [];
  const excludedCount = { too_few_events: 0, no_whole_years_in_cell_data: 0, no_cell_data: 0 };
  for (const outlet of outlets) {
    const cell = history.cells[cellKey(outlet.lat, outlet.lon)];
    if (!cell) { excludedCount.no_cell_data++; continue; }
    const result = deriveThresholdForOutlet(outlet.spillFrequency.longTermAverageSpillCount, cell.mm, cell.startTime, availableYears);
    if (result.excluded) { excludedCount[result.reason] = (excludedCount[result.reason] || 0) + 1; continue; }
    derived.push({ ...outlet, thresholdMm: +result.thresholdMm.toFixed(2), confidence: result.confidence, eventsUsed: result.eventsUsed, yearsUsed: result.yearsUsed });
  }
  console.log(`Gruppe 1 (direkte): ${derived.length} udløb fik en afledt tærskel. Udelukket: ${JSON.stringify(excludedCount)}`);

  const calibrated = {};
  let writtenDirect = 0;
  for (const d of derived) {
    if (d.confidence === 'low') continue; // computed, not confident enough to ship — same rule as the real pipeline
    calibrated[d.outletId] = { thresholdMm: d.thresholdMm, confidence: d.confidence, source: 'derived', eventsUsed: d.eventsUsed, yearsUsed: d.yearsUsed };
    writtenDirect++;
  }

  // ── Group 2: borrow from the K nearest Group-1 outlets, using the REAL
  // kNearestByDistance() — donors need lat/lon/thresholdMm directly (no
  // `company` field: this dataset is single-company, so the real function's
  // same-company preference is a no-op here, correctly).
  const donorPool = derived.map((d) => ({ lat: d.lat, lon: d.lon, outletId: d.outletId, thresholdMm: d.thresholdMm }));
  const needsBorrowing = outlets.filter((o) => !calibrated[o.outletId]);
  let writtenBorrowed = 0;
  for (const outlet of needsBorrowing) {
    if (donorPool.length === 0) break;
    const donors = kNearestByDistance({ lat: outlet.lat, lon: outlet.lon }, donorPool, 3);
    if (donors.length === 0) continue;
    const thresholdMm = donors.reduce((sum, d) => sum + d.donor.thresholdMm * d.weight, 0);
    calibrated[outlet.outletId] = { thresholdMm: +thresholdMm.toFixed(2), confidence: 'borrowed', source: 'borrowed', donorOutletIds: donors.map((d) => d.donor.outletId) };
    writtenBorrowed++;
  }
  console.log(`Gruppe 2 (lånt): ${writtenBorrowed}/${needsBorrowing.length} udløb uden brugbar egen tælling fik en lånt tærskel.`);
  console.log(`I alt: ${writtenDirect} direkte + ${writtenBorrowed} lånt = ${Object.keys(calibrated).length} af ${outlets.length} udløb.`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), thresholds: calibrated }, null, 2), 'utf8');
  console.log(`Skrevet: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('compute-outlet-thresholds fejlede:', err);
  process.exit(1);
});
