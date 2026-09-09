#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// compute-outlet-thresholds-shrinkage.js — a second, genuinely-learned
// per-outlet threshold calibration, replacing compute-outlet-thresholds.js's
// count-matching approach ("pick whichever rainfall peak makes the FREQUENCY
// come out right") with one that looks at the actual rainfall level present
// at each outlet's REAL event onsets, and shrinks toward a neighbor-borrowed
// prior in proportion to how much of that real data exists — no hard
// event-count cutoff, same "graduated, not a step function" principle
// already applied to currentBias.js's distance/exclusion behavior this
// session.
//
// ── Why this exists ───────────────────────────────────────────────────────
// The real pipeline/14 deriveThresholdForOutlet() forces the calibrated
// threshold to reproduce an outlet's annual event COUNT by picking the Nth-
// highest rainfall peak — it never looks at what rainfall level actually
// preceded any specific real event. Two outlets with the same event count
// get calibrated identically regardless of whether one reliably spills at
// 4mm and the other only at 20mm. edm-outlet-coverage-stats.js showed this
// is worth fixing: 76.1% of outlets (665/874) have 10+ real genuine events —
// plenty of data for a real per-outlet empirical estimate, not just a count.
//
// ── The method ─────────────────────────────────────────────────────────────
// For each outlet, using its own grid cell's REAL hourly rainfall history
// (accumulateDecayed() — real, unmodified, pipeline/14) and its REAL event
// start timestamps (edm-events.ndjson): read the decayed rainfall
// accumulation at the moment each genuine event started. The MEDIAN of
// those values is the outlet's empirical "own" threshold estimate — an
// actual measurement of what rainfall level precedes this outlet's real
// discharges, not a count-matching artifact.
//
// For the neighbor-borrowed side: kNearestByDistance() (real, pipeline/14)
// over every outlet that has its OWN empirical estimate (donor pool),
// inverse-distance-weighted, same as the existing pipeline's borrowing.
//
// The two are blended by SHRINKAGE, not a hard "enough events / not enough"
// cutoff:
//   threshold = (nOwn × ownMedian + PSEUDO_COUNT × neighborValue) / (nOwn + PSEUDO_COUNT)
// At nOwn=0 this is exactly a pure borrow (matches the existing pipeline's
// fallback). At nOwn=1 the single real event pulls the estimate partway
// toward itself, not all the way — a single event is real signal, but with
// n=1 it's one noisy draw, not a reliable median. As nOwn grows, the
// estimate converges to the outlet's own empirical value. PSEUDO_COUNT is a
// new, explicitly undocumented/untuned constant (same honesty as the real
// K_MM=8 comment) — default 3, matching the k=3 neighbors already used
// elsewhere; override with --pseudo-count.
//
// Writes the SAME JSON shape compute-outlet-thresholds.js does
// ({ thresholds: { [outletId]: { thresholdMm, ... } } }), so it's a drop-in
// --calibrated-thresholds input for validate-uk-risk-score.js — no changes
// needed there.
//
// KNOWN LIMITATION, not fixed here: no temporal holdout. Like the real
// pipeline's own calibration, this uses an outlet's full event history to
// derive its threshold, then a full-history backtest evaluates it — the
// same train/test overlap flagged for the original calibration approach.
// Answering "does event-onset calibration genuinely generalize" would need
// a held-out time split, which this script does not attempt.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER schema-map-edm.js OG
// fetch-outlet-rainfall-history.js:
//   node compute-outlet-thresholds-shrinkage.js --ukwater-repo /path/to/ukwater [--pseudo-count 3]
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
const OUT_PATH = path.resolve(argVal('--out', path.join(DIR, 'outlet-calibrated-thresholds-shrinkage.json')));
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));
const PSEUDO_COUNT = parseFloat(argVal('--pseudo-count', '3'));
// Temporal holdout support: only events strictly BEFORE this date inform
// calibration. Pair with validate-uk-risk-score.js's own --samples-after
// (same cutoff, or later) to test whether this calibration generalizes to
// a period it never saw, rather than evaluating on the same years it was
// fit from. Without this flag, behavior is unchanged — every genuine event
// is used, exactly as the original (non-holdout) run did.
const EVENTS_BEFORE_ISO = argVal('--events-before', null);
const EVENTS_BEFORE_MS = EVENTS_BEFORE_ISO ? Date.parse(EVENTS_BEFORE_ISO.endsWith('Z') ? EVENTS_BEFORE_ISO : `${EVENTS_BEFORE_ISO}Z`) : null;

const pipeline14Path = path.join(UKWATER_REPO, 'pipeline', '14-compute-outlet-thresholds.js');
const cellKeyPath = path.join(UKWATER_REPO, 'pipeline', '13-fetch-outlet-rainfall-history.js');
const rainfallDecayPath = path.join(UKWATER_REPO, 'server', 'risk', 'rainfallDecay.js');
for (const [label, p] of [['pipeline/14', pipeline14Path], ['pipeline/13', cellKeyPath], ['server/risk/rainfallDecay.js', rainfallDecayPath]]) {
  if (!fs.existsSync(p)) { console.error(`Kan ikke finde ${label} (${p}). Angiv --ukwater-repo.`); process.exit(1); }
}
const { accumulateDecayed, kNearestByDistance } = require(pipeline14Path);
const { cellKey } = require(cellKeyPath);
const { DECAY_LAMBDA } = require(rainfallDecayPath);

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

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  console.log(`Læser ${EVENTS_PATH}...`);
  const outletEvents = new Map(); // outletId -> { lat, lon, startTsMsList }
  let scanned = 0, badCoord = 0, afterCutoff = 0;
  for await (const ev of ndjsonLines(EVENTS_PATH)) {
    scanned++;
    if (!ev.outfall) continue;
    if (!ev.genuine || ev.endedStatus !== 'Ended' || ev.startTsMs == null) continue; // same exclusion as validate-uk-risk-score.js/compute-outlet-thresholds.js — 'Ongoing' has no knowable true end
    if (!(ev.lat != null && ev.lng != null && ev.lat >= -90 && ev.lat <= 90 && ev.lng >= -180 && ev.lng <= 180)) { badCoord++; continue; } // same STAPLEFIELD-style bad-coordinate guard used elsewhere
    if (EVENTS_BEFORE_MS != null && ev.startTsMs >= EVENTS_BEFORE_MS) { afterCutoff++; continue; } // holdout: this event is in the test period, calibration must not see it
    let o = outletEvents.get(ev.outfall);
    if (!o) { o = { lat: ev.lat, lon: ev.lng, startTsMsList: [] }; outletEvents.set(ev.outfall, o); }
    o.startTsMsList.push(ev.startTsMs);
  }
  console.log(`${scanned.toLocaleString('en')} rækker scannet, ${outletEvents.size} udløb med mindst én ægte, afsluttet hændelse og gyldige koordinater (${badCoord} rækker med ugyldige koordinater sprunget over).`);
  if (EVENTS_BEFORE_MS != null) console.log(`--events-before ${EVENTS_BEFORE_ISO}: ${afterCutoff.toLocaleString('en')} hændelser på/efter cutoff udelukket fra kalibrering (holdout).`);

  console.log(`Læser ${HISTORY_PATH}...`);
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  console.log(`Regnhistorik dækker ${history.meta.startDate} – ${history.meta.endDate}, ${Object.keys(history.cells).length} gitterceller.`);

  // ── Pass 1: own empirical estimate per outlet, from REAL event onsets ────
  const decayedSeriesByCellKey = new Map(); // cache — many outlets share a grid cell
  const perOutlet = new Map(); // outletId -> { lat, lon, ownMedian, nOwn, nEventsTotal, nOutsideWindow }
  let noCellData = 0;
  for (const [outletId, o] of outletEvents) {
    const key = cellKey(o.lat, o.lon);
    const cell = history.cells[key];
    if (!cell) { noCellData++; perOutlet.set(outletId, { lat: o.lat, lon: o.lon, ownMedian: null, nOwn: 0, nEventsTotal: o.startTsMsList.length, nOutsideWindow: o.startTsMsList.length }); continue; }

    let series = decayedSeriesByCellKey.get(key);
    if (!series) { series = accumulateDecayed(cell.mm, DECAY_LAMBDA); decayedSeriesByCellKey.set(key, series); }
    const cellStartMs = new Date(cell.startTime.endsWith('Z') ? cell.startTime : `${cell.startTime}Z`).getTime();

    const onsetValues = [];
    let outsideWindow = 0;
    for (const startTsMs of o.startTsMsList) {
      const idx = Math.round((startTsMs - cellStartMs) / 3600000);
      if (idx < 0 || idx >= series.length) { outsideWindow++; continue; } // event predates or postdates the fetched rainfall window
      onsetValues.push(series[idx]);
    }
    perOutlet.set(outletId, {
      lat: o.lat, lon: o.lon,
      ownMedian: onsetValues.length > 0 ? median(onsetValues) : null,
      nOwn: onsetValues.length,
      nEventsTotal: o.startTsMsList.length,
      nOutsideWindow: outsideWindow,
    });
  }
  console.log(`Egen empirisk median beregnet for ${[...perOutlet.values()].filter((o) => o.ownMedian != null).length}/${perOutlet.size} udløb (${noCellData} uden gittercelle-data).`);

  // ── Pass 2: donor pool + shrinkage blend ──────────────────────────────────
  const donorPool = [...perOutlet.entries()]
    .filter(([, o]) => o.ownMedian != null)
    .map(([outletId, o]) => ({ outletId, lat: o.lat, lon: o.lon, ownMedian: o.ownMedian }));
  console.log(`Donor-pulje til nabo-lån: ${donorPool.length} udløb.`);

  const thresholds = {};
  let nShrinkage = 0, nPureBorrow = 0, nExcludedNoDonor = 0;
  for (const [outletId, o] of perOutlet) {
    const others = donorPool.filter((d) => d.outletId !== outletId);
    let neighborValue = null;
    if (others.length > 0) {
      const donors = kNearestByDistance({ lat: o.lat, lon: o.lon }, others.map((d) => ({ lat: d.lat, lon: d.lon, outletId: d.outletId, thresholdMm: d.ownMedian })), Math.min(3, others.length));
      if (donors.length > 0) neighborValue = donors.reduce((sum, d) => sum + d.donor.thresholdMm * d.weight, 0);
    }

    let thresholdMm, source;
    if (o.ownMedian != null && neighborValue != null) {
      thresholdMm = (o.nOwn * o.ownMedian + PSEUDO_COUNT * neighborValue) / (o.nOwn + PSEUDO_COUNT);
      source = 'shrinkage'; nShrinkage++;
    } else if (o.ownMedian != null) {
      thresholdMm = o.ownMedian; source = 'own-only-no-donors'; nShrinkage++; // no other donors existed (tiny dataset edge case) — own median stands alone
    } else if (neighborValue != null) {
      thresholdMm = neighborValue; source = 'borrowed'; nPureBorrow++;
    } else {
      nExcludedNoDonor++; continue; // no own data AND no donor pool available — cannot calibrate this outlet at all
    }

    thresholds[outletId] = {
      thresholdMm: +thresholdMm.toFixed(2),
      confidence: o.nOwn >= 10 ? 'high' : o.nOwn >= 3 ? 'medium' : o.nOwn >= 1 ? 'low' : 'borrowed',
      source,
      nOwn: o.nOwn,
      ownMedian: o.ownMedian != null ? +o.ownMedian.toFixed(2) : null,
      neighborBorrowedValue: neighborValue != null ? +neighborValue.toFixed(2) : null,
      nEventsTotal: o.nEventsTotal,
      nOutsideRainfallWindow: o.nOutsideWindow,
    };
  }
  console.log(`I alt: ${nShrinkage} shrinkage-blandet (egen + nabo), ${nPureBorrow} rent nabo-lånt (nOwn=0), ${nExcludedNoDonor} udelukket (hverken egne data eller donorer).`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: { pseudoCount: PSEUDO_COUNT, decayLambda: DECAY_LAMBDA, method: 'event-onset-median-shrinkage', eventsBefore: EVENTS_BEFORE_ISO },
    thresholds,
  }, null, 2), 'utf8');
  console.log(`Skrevet: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('compute-outlet-thresholds-shrinkage fejlede:', err);
  process.exit(1);
});
