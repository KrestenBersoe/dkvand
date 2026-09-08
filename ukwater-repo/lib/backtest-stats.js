#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// backtest-stats.js — the same general-purpose statistical helpers dkvand's
// Danish validation uses (scripts/lib/badevand-backtest-utils.js:
// wilsonInterval, confusionStats, precisionRecallCurve, calibrationCurve),
// duplicated here rather than cross-required from scripts/lib/ — ukwater-repo
// is its own subtree, explicitly noted elsewhere (.gitignore) as possibly a
// future standalone repo, so a relative require() reaching up out of it
// would break the moment that split happens. These four functions are pure
// (no dkvand-specific state, no file I/O) and unchanged in logic from the
// originals — this is intentional reuse of a validated approach, not a
// rewrite, so the same statistical methodology (Wilson score intervals for
// honest small-n/extreme-p confidence bounds, trapezoidal AUC-PR, decile
// calibration buckets) applies to both countries' validations.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// ── Wilson score interval — binomial confidence interval for a proportion
// (precision/recall/PPV/NPV) — better than the normal approximation at
// small n or p near 0/1, both common here (few real exceedances). ────────
function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { p: null, lo: null, hi: null, n: 0 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { p, lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom), n: total };
}

// ── Precision/recall/PPV/NPV + CI from a confusion matrix ────────────────
function confusionStats({ tp, fp, tn, fn }) {
  const precision = wilsonInterval(tp, tp + fp); // = PPV
  const recall = wilsonInterval(tp, tp + fn);
  const npv = wilsonInterval(tn, tn + fn);
  const falseAlarm = wilsonInterval(fp, fp + tn);
  const accuracy = wilsonInterval(tp + tn, tp + fp + tn + fn);
  return { tp, fp, tn, fn, precision, recall, ppv: precision, npv, falseAlarmRate: falseAlarm, accuracy };
}

// ── Precision-recall curve over the whole score range ────────────────────
// points: [{score, failed}], higher score = "more risk". Sweeps the
// threshold over every unique observed score (descending), computes
// precision/recall AT that threshold (>=). Returns curve points + a rough
// AUC-PR (trapezoidal rule over the recall axis, sorted ascending by recall).
function precisionRecallCurve(points) {
  const withScore = points.filter((p) => p.score != null && p.failed != null);
  const totalPositive = withScore.filter((p) => p.failed).length;
  if (withScore.length === 0 || totalPositive === 0) return { curve: [], aucPr: null, n: withScore.length, totalPositive };

  const thresholds = [...new Set(withScore.map((p) => p.score))].sort((a, b) => b - a);
  const curve = [];
  for (const t of thresholds) {
    let tp = 0, fp = 0;
    for (const p of withScore) {
      if (p.score >= t) { if (p.failed) tp++; else fp++; }
    }
    const predictedPositive = tp + fp;
    curve.push({
      threshold: t,
      precision: predictedPositive > 0 ? tp / predictedPositive : null,
      recall: tp / totalPositive,
      predictedPositive,
    });
  }
  const sorted = curve.filter((c) => c.precision != null).slice().sort((a, b) => a.recall - b.recall);
  let aucPr = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dRecall = sorted[i].recall - sorted[i - 1].recall;
    const avgPrecision = (sorted[i].precision + sorted[i - 1].precision) / 2;
    aucPr += dRecall * avgPrecision;
  }
  if (sorted.length > 0) aucPr += sorted[0].recall * sorted[0].precision;
  return { curve, aucPr: sorted.length ? aucPr : null, n: withScore.length, totalPositive };
}

// ── Calibration/reliability curve — decile buckets of predicted score,
// observed fail rate per bucket + Wilson CI. Tells you whether a score of
// 0.8 REALLY means ~80% fail chance, or whether the model is over-/
// underconfident. ─────────────────────────────────────────────────────
function calibrationCurve(points, numBuckets = 10) {
  const withScore = points.filter((p) => p.score != null && p.failed != null).slice().sort((a, b) => a.score - b.score);
  const n = withScore.length;
  if (n === 0) return { buckets: [], n: 0 };
  const buckets = [];
  for (let b = 0; b < numBuckets; b++) {
    const lo = Math.floor((b * n) / numBuckets);
    const hi = Math.floor(((b + 1) * n) / numBuckets);
    const slice = withScore.slice(lo, hi);
    if (slice.length === 0) continue;
    const meanScore = slice.reduce((a, p) => a + p.score, 0) / slice.length;
    const failedCount = slice.filter((p) => p.failed).length;
    const observed = wilsonInterval(failedCount, slice.length);
    buckets.push({
      bucket: b + 1, n: slice.length,
      scoreRange: [slice[0].score, slice[slice.length - 1].score],
      meanPredictedScore: meanScore,
      observedFailRate: observed.p, ci95: [observed.lo, observed.hi],
    });
  }
  return { buckets, n };
}

module.exports = { wilsonInterval, confusionStats, precisionRecallCurve, calibrationCurve };
