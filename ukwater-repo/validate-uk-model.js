#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// validate-uk-model.js — walk-forward backtest of Southern Water's own EDM
// discharge-impact assessment against real EA bathing-water lab samples.
// This is the UK analogue of dkvand's scripts/validate-badevand-model.js —
// same discipline (leakage-safe, baseline comparison, binomial CIs, PR/
// calibration curves, no headline "accuracy") — applied to a structurally
// different, and structurally BETTER, input: Denmark's PULS system has only
// one undated ANNUAL overflow count per outlet (see
// BADEVAND-MODEL-VALIDERING-RESULTATER.md's root-cause #1 — no official
// event definition exists to calibrate against); the UK's EDM export is
// genuinely event-level — dated start/end timestamps AND Southern Water's
// own tidal/geographic model already saying which bathing water each event
// was assessed to impact. So this backtest tests something more direct than
// Denmark's: not a rainfall-derived proxy threshold, but Southern Water's
// own "Impacted" flag, taken as-is.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER schema-map-edm.js,
// fetch-ea-samples.js, check-site-match.js OG join-edm-ea.js alle er kørt
// (alle skriver som standard til ./output/):
//   node validate-uk-model.js
//   node validate-uk-model.js --lags 24,48,72 --out-dir ./output/validation
//
// ── No worker_threads — deliberate, see schema-map-edm.js's own reasoning
// for the same call the other direction ──────────────────────────────────
// The expensive part elsewhere in this repo (a single risk-cascade
// computation, or parsing a multi-GB CSV) genuinely costs CPU seconds per
// unit of work. Here, per sample-event, the work is a handful of binary-
// searches over pre-sorted per-site arrays (O(log n) each) — the entire
// backtest, at the real scale seen so far (tens of thousands of samples,
// hundreds of thousands of events), runs in low single-digit seconds
// single-threaded. Threading it would add process overhead for a workload
// that was never CPU-bound to begin with.
//
// ── Label: what counts as a "failed" sample ───────────────────────────────
// The Bathing Water Regulations 2013 (SI 2013/1675), Schedule 5 — read
// directly at legislation.gov.uk during this investigation — sets these
// COASTAL/TRANSITIONAL standards (all Southern Water sites here are
// coastal), in cfu/100ml, evaluated as a 90th-percentile-over-4-years for
// "Sufficient": Intestinal enterococci 185, Escherichia coli 500. The
// OFFICIAL annual classification is that 4-year percentile computation, not
// a literal single-sample cutoff — but exactly as dkvand's own Danish
// validation treats an individual lab result as "failed" if it exceeds a
// fixed numeric threshold (rather than trying to reproduce a multi-year
// classification per sample), this backtest applies the SAME real
// regulatory numbers directly to each individual sample. A sample is
// labeled failed if EITHER determinand exceeds its own threshold — the
// same "either indicator" logic the regulations themselves use for
// classification, just applied per-sample instead of per-percentile.
// Source: https://www.legislation.gov.uk/uksi/2013/1675/schedule/5
//
// ── Censored lab results — verified against the real data, not assumed ────
// 60-65% of E. coli/enterococci observations in ea-samples.ndjson are
// left-censored ("<10" — below the lab method's detection limit): checked
// directly (20,947 of 20,961 below-censored rows are exactly "<10"),
// always far under either threshold (185/500), so treating the censoring
// bound as the effective value can NEVER wrongly flag a below-detection
// result as a failure. The rare above-censored results ("<1% of rows,
// values like ">10000", ">9000") are equally always far ABOVE either
// threshold. So `numericValue ?? bound` is a safe, verified stand-in for
// the true value on both sides of the real data's censoring — this would
// NOT be safe in general (a censoring bound close to the threshold would
// need real interval-censored statistics), it's safe here specifically
// because the real bounds observed are never close to 185/500.
//
// ── Three signals compared, not one ────────────────────────────────────────
// MODEL: a genuine event Southern Water's own tidal/geographic assessment
//   marked "Impacted" for this specific site, started within the lag
//   window — the thing actually being validated.
// BASELINE (site-any): a genuine event assessed against this site AT ALL
//   (Impacted OR Not Impacted), started within the window — tests whether
//   the Impact Status classification itself (the sophisticated, modeled
//   part) adds anything over "a discharge was merely evaluated against
//   this site recently".
// BASELINE (region-any): ANY genuine event anywhere in the whole dataset,
//   started within the window — tests whether site-specific information
//   matters at all, over "it's been a wet/busy period regionally".
// Mirrors dkvand's flat-rainfall baseline: each layer of Southern Water's
// own modeling sophistication is tested against a cruder version of itself,
// not just against "no model at all".
//
// ── Leakage note ───────────────────────────────────────────────────────────
// Every count uses ONLY event START timestamps strictly within
// [sampleTime - lagHours, sampleTime] — never an event's end time (which
// for a small number of still-'Ongoing' events in the source export is not
// yet known — see schema-map-edm-worker.js's own comment on this). Unlike
// the Danish threshold model, nothing here is FIT to this data — Southern
// Water's Impact Status is an external artifact this script only reads, it
// calibrates no parameter against the lab samples — so there is structurally
// no look-ahead leakage of the kind the Danish validation had to guard
// against in its threshold-derivation step.
//
// ── Output ──────────────────────────────────────────────────────────────
// <out-dir>/uk-validation-results-<timestamp>.json — full structured
//   results: per lag × signal × label-type × segment: confusion stats
//   (Wilson CIs), PR curve + AUC-PR, calibration curve, positive counts.
// <out-dir>/uk-validation-summary.csv — flat table, one row per
//   lag × signal × label-type × segment, for spreadsheet review.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { confusionStats, precisionRecallCurve, calibrationCurve } = require('./lib/backtest-stats');
const { buildLabeledSampleEvents } = require('./lib/uk-sample-labels');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const OUT_DIR = path.resolve(argVal('--out-dir', DIR));
const SAMPLES_PATH = path.resolve(argVal('--samples', path.join(DIR, 'ea-samples.ndjson')));
const IMPACTS_PATH = path.resolve(argVal('--joined-impacts', path.join(DIR, 'joined-impacts.ndjson')));
const SITES_PATH = path.resolve(argVal('--sites', path.join(DIR, 'ea-sites.json')));
const LAG_HOURS = argVal('--lags', '24,48,72').split(',').map((s) => parseFloat(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
// Schedule 5, coastal/transitional "Sufficient" standard — see filehead citation.
const ECOLI_THRESHOLD = parseFloat(argVal('--ecoli-threshold', '500'));
const ENTEROCOCCI_THRESHOLD = parseFloat(argVal('--enterococci-threshold', '185'));

for (const [label, p] of [['ea-samples.ndjson', SAMPLES_PATH], ['joined-impacts.ndjson', IMPACTS_PATH], ['ea-sites.json', SITES_PATH]]) {
  if (!fs.existsSync(p)) {
    console.error(`Mangler ${label} (${p}).`);
    console.error('Kør først, i rækkefølge: schema-map-edm.js, fetch-ea-samples.js, check-site-match.js, join-edm-ea.js — alle skriver som standard til ./output/.');
    process.exit(1);
  }
}

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

// Sorted-ascending array of millisecond timestamps -> count of entries in
// (endTs - windowMs, endTs] via two binary searches (upper bounds).
function upperBoundIndex(sortedArr, value) {
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedArr[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function countInWindow(sortedArr, endTs, windowMs) {
  if (!sortedArr || sortedArr.length === 0) return 0;
  return upperBoundIndex(sortedArr, endTs) - upperBoundIndex(sortedArr, endTs - windowMs);
}

async function main() {
  const t0 = Date.now();

  console.log(`Læser ${SITES_PATH}...`);
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  const siteByNotation = new Map(sites.map((s) => [s.notation, s]));

  // ── 1. Build one labeled record per real physical sample — see
  // lib/uk-sample-labels.js (shared with validate-uk-risk-score.js so both
  // scripts label the SAME samples identically).
  console.log(`Læser ${SAMPLES_PATH} og grupperer pr. fysisk prøve...`);
  const sampleEvents = await buildLabeledSampleEvents(SAMPLES_PATH, siteByNotation, ECOLI_THRESHOLD, ENTEROCOCCI_THRESHOLD,
    (scanned, grouped) => console.log(`${scanned.toLocaleString('en')} observationsrækker scannet, ${grouped.toLocaleString('en')} prøver har mindst én af de to determinander og indgår i backtesten.`));

  // ── 2. Build per-site sorted event-start arrays from the join, plus one
  // deduplicated (by eventId) region-wide array for the region-any baseline.
  console.log(`Læser ${IMPACTS_PATH}...`);
  const modelStartsBySite = new Map();
  const anyAssessedStartsBySite = new Map();
  const globalGenuineStartByEvent = new Map(); // eventId -> startTsMs, dedup across repeated site rows
  let impactsScanned = 0;
  for await (const im of ndjsonLines(IMPACTS_PATH)) {
    impactsScanned++;
    if (!im.genuine || im.startTsMs == null) continue;
    if (!globalGenuineStartByEvent.has(im.eventId)) globalGenuineStartByEvent.set(im.eventId, im.startTsMs);
    if (!anyAssessedStartsBySite.has(im.eaSiteNotation)) anyAssessedStartsBySite.set(im.eaSiteNotation, []);
    anyAssessedStartsBySite.get(im.eaSiteNotation).push(im.startTsMs);
    if (im.impactStatus === 'Impacted') {
      if (!modelStartsBySite.has(im.eaSiteNotation)) modelStartsBySite.set(im.eaSiteNotation, []);
      modelStartsBySite.get(im.eaSiteNotation).push(im.startTsMs);
    }
  }
  for (const arr of modelStartsBySite.values()) arr.sort((a, b) => a - b);
  for (const arr of anyAssessedStartsBySite.values()) arr.sort((a, b) => a - b);
  const globalGenuineStarts = [...globalGenuineStartByEvent.values()].sort((a, b) => a - b);
  console.log(`${impactsScanned.toLocaleString('en')} impact-rækker læst; ${globalGenuineStarts.length.toLocaleString('en')} distinkte ægte hændelser region-bredt.`);

  // ── 3. Score every sample-event at every lag, for all three signals.
  const signals = [
    { key: 'model', label: 'MODEL (genuine + Impacted, denne station)', starts: (site) => modelStartsBySite.get(site) },
    { key: 'baseline_site_any', label: 'BASELINE (genuine, denne station, uanset Impact Status)', starts: (site) => anyAssessedStartsBySite.get(site) },
    { key: 'baseline_region_any', label: 'BASELINE (genuine, hele regionen)', starts: () => globalGenuineStarts },
  ];
  const labelTypes = [
    { key: 'ecoli', label: 'E. coli (>500 cfu/100ml)', get: (s) => s.ecoliExceeds },
    { key: 'enterococci', label: 'Intestinal enterococci (>185 cfu/100ml)', get: (s) => s.enterococciExceeds },
    { key: 'either', label: 'Enten (kombineret)', get: (s) => s.eitherExceeds },
  ];

  for (const s of sampleEvents) {
    s.scoresByLag = {};
    for (const lagH of LAG_HOURS) {
      const windowMs = lagH * 3600 * 1000;
      const scores = {};
      for (const sig of signals) {
        const arr = sig.starts(s.siteNotation);
        scores[sig.key] = s.tsMs != null ? countInWindow(arr, s.tsMs, windowMs) : null;
      }
      s.scoresByLag[lagH] = scores;
    }
  }

  // ── 4. Aggregate: per lag × signal × label-type × segment.
  const areas = [...new Set(sites.map((s) => s.area).filter(Boolean))];
  const segments = [
    { key: 'overall', label: 'Alle stationer', filter: () => true },
    ...areas.map((a) => ({ key: `area:${a}`, label: a, filter: (s) => s.area === a })),
  ];

  const results = [];
  for (const lagH of LAG_HOURS) {
    for (const sig of signals) {
      for (const lt of labelTypes) {
        for (const seg of segments) {
          // tsMs (and so every lag's score) can only be null for a sample
          // whose phenomenonTime failed to parse — vanishingly rare in
          // practice (real EA timestamps are consistently well-formed),
          // but excluded explicitly rather than silently coerced to 0 via
          // `score || 0`, which would misrepresent "unknown" as "no event".
          const rows = sampleEvents.filter((s) => lt.get(s) != null && seg.filter(s) && s.scoresByLag[lagH][sig.key] != null);
          if (rows.length === 0) continue;
          const points = rows.map((s) => ({ score: s.scoresByLag[lagH][sig.key], failed: lt.get(s) }));
          const flagged = points.map((p) => ({ ...p, predicted: p.score >= 1 }));
          let tp = 0, fp = 0, tn = 0, fn = 0;
          for (const p of flagged) {
            if (p.predicted && p.failed) tp++;
            else if (p.predicted && !p.failed) fp++;
            else if (!p.predicted && p.failed) fn++;
            else tn++;
          }
          const confusion = confusionStats({ tp, fp, tn, fn });
          const pr = precisionRecallCurve(points);
          const calib = calibrationCurve(points);
          results.push({
            lagHours: lagH, signal: sig.key, signalLabel: sig.label,
            labelType: lt.key, labelDescription: lt.label,
            segment: seg.key, segmentLabel: seg.label,
            n: rows.length, totalPositive: pr.totalPositive,
            baseRate: pr.totalPositive / rows.length,
            confusionAtFlagGte1: confusion,
            aucPr: pr.aucPr,
            precisionRecallCurve: pr.curve,
            calibrationCurve: calib.buckets,
          });
        }
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `uk-validation-results-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: { lagHours: LAG_HOURS, ecoliThreshold: ECOLI_THRESHOLD, enterococciThreshold: ENTEROCOCCI_THRESHOLD, thresholdSource: 'https://www.legislation.gov.uk/uksi/2013/1675/schedule/5 (coastal/transitional "Sufficient" standard)' },
    sampleEventCount: sampleEvents.length,
    results,
  }, null, 2), 'utf8');

  const csvPath = path.join(OUT_DIR, 'uk-validation-summary.csv');
  const csvHeader = ['lagHours', 'signal', 'labelType', 'segment', 'n', 'totalPositive', 'baseRate', 'tp', 'fp', 'tn', 'fn', 'precision', 'precisionLo', 'precisionHi', 'recall', 'recallLo', 'recallHi', 'npv', 'npvLo', 'npvHi', 'aucPr'];
  const csvRows = [csvHeader.join(',')];
  for (const r of results) {
    const c = r.confusionAtFlagGte1;
    csvRows.push([
      r.lagHours, r.signal, r.labelType, r.segment, r.n, r.totalPositive, r.baseRate.toFixed(4),
      c.tp, c.fp, c.tn, c.fn,
      c.precision.p != null ? c.precision.p.toFixed(4) : '', c.precision.lo != null ? c.precision.lo.toFixed(4) : '', c.precision.hi != null ? c.precision.hi.toFixed(4) : '',
      c.recall.p != null ? c.recall.p.toFixed(4) : '', c.recall.lo != null ? c.recall.lo.toFixed(4) : '', c.recall.hi != null ? c.recall.hi.toFixed(4) : '',
      c.npv.p != null ? c.npv.p.toFixed(4) : '', c.npv.lo != null ? c.npv.lo.toFixed(4) : '', c.npv.hi != null ? c.npv.hi.toFixed(4) : '',
      r.aucPr != null ? r.aucPr.toFixed(4) : '',
    ].join(','));
  }
  fs.writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8');

  // ── Console headline: overall segment, "either" label, all lags/signals —
  // the single most representative comparison, mirroring dkvand's own
  // "model vs. baseline, at every lag" headline table.
  console.log('\n═══ Resultat (Alle stationer, Enten-determinand) ═══');
  console.log(`Tidsforbrug: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  for (const lagH of LAG_HOURS) {
    console.log(`\n-- Lag ${lagH}t --`);
    for (const sig of signals) {
      const r = results.find((x) => x.lagHours === lagH && x.signal === sig.key && x.labelType === 'either' && x.segment === 'overall');
      if (!r) continue;
      const c = r.confusionAtFlagGte1;
      console.log(`  ${sig.label}: n=${r.n}, positive=${r.totalPositive} (${(r.baseRate * 100).toFixed(1)}%), AUC-PR=${r.aucPr != null ? r.aucPr.toFixed(3) : 'n/a'}, precision=${c.precision.p != null ? (c.precision.p * 100).toFixed(1) + '%' : 'n/a'} [${c.precision.lo != null ? (c.precision.lo * 100).toFixed(1) : '?'}-${c.precision.hi != null ? (c.precision.hi * 100).toFixed(1) : '?'}%], recall=${c.recall.p != null ? (c.recall.p * 100).toFixed(1) + '%' : 'n/a'} [${c.recall.lo != null ? (c.recall.lo * 100).toFixed(1) : '?'}-${c.recall.hi != null ? (c.recall.hi * 100).toFixed(1) : '?'}%]`);
    }
  }
  console.log(`\nSkrevet: ${jsonPath}`);
  console.log(`Skrevet: ${csvPath}`);
  console.log(`\n(Segmenteret pr. område og determinand-type ligger i JSON'en — konsollen viser kun hovedsammenligningen.)`);
}

main().catch((err) => {
  console.error('validate-uk-model fejlede:', err);
  process.exit(1);
});
