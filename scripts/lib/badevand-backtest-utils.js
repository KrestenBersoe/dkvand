#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// badevand-backtest-utils.js — delte, rene funktioner til historisk
// badevands-backtesting (scripts/validate-predictions-historical.js og
// scripts/validate-badevand-model.js/-worker.js). Udtrukket hertil for at
// undgå at kopiere den samme henfaldsformel/CSV-hentning/statistik to
// steder — se hvert kaldested for hvordan de bruges.
//
// Ingen af funktionerne her rører disk/netværk undtagen fetchArchive()
// (Open-Meteo) — resten er rene, testbare funktioner.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

function isoDate(d) { return d.toISOString().slice(0, 10); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ── Prøve-klassifikation (EU-direktivets enkeltprøve-cutoffs, samme som
// resten af repoet — se build-badevand-analyseresultater.js's filhoved) ────
const ECOLI_THRESHOLD = 500;
const ENTERO_THRESHOLD = 200;

function sampleFailed(sample) {
  const { ecoli, enterokokker } = sample;
  if (ecoli == null && enterokokker == null) return null;
  return (ecoli != null && ecoli >= ECOLI_THRESHOLD) || (enterokokker != null && enterokokker >= ENTERO_THRESHOLD);
}

function sampleExceedanceRatio(sample) {
  const { ecoli, enterokokker } = sample;
  const ratios = [];
  if (ecoli != null) ratios.push(ecoli / ECOLI_THRESHOLD);
  if (enterokokker != null) ratios.push(enterokokker / ENTERO_THRESHOLD);
  return ratios.length ? Math.max(...ratios) : null;
}

// ── Spearman rangkorrelation (se validate-predictions-historical.js for
// den fulde begrundelse for hvorfor rang, ikke Pearson på rå værdier) ──────
function rankOf(values) {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const rx = rankOf(xs), ry = rankOf(ys);
  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX, dy = ry[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

// ── Wilson score-interval — binomialt konfidensinterval for en andel
// (precision/recall/PPV/NPV) — bedre end normalapproksimation ved lille n
// eller p tæt på 0/1, begge hyppige her (få reelle overskridelser). ────────
function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { p: null, lo: null, hi: null, n: 0 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { p, lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom), n: total };
}

// ── Precision/recall/PPV/NPV + CI ud fra en confusion-matrix ────────────
function confusionStats({ tp, fp, tn, fn }) {
  const precision = wilsonInterval(tp, tp + fp); // = PPV
  const recall = wilsonInterval(tp, tp + fn);
  const npv = wilsonInterval(tn, tn + fn);
  const falseAlarm = wilsonInterval(fp, fp + tn);
  const accuracy = wilsonInterval(tp + tn, tp + fp + tn + fn);
  return { tp, fp, tn, fn, precision, recall, ppv: precision, npv, falseAlarmRate: falseAlarm, accuracy };
}

// ── Precision-recall-kurve over hele scoreintervallet ───────────────────
// points: [{score, failed}], score højere = "mere risiko". Sveller
// tærsklen over hvert unikt observeret score-punkt (faldende), beregner
// precision/recall PÅ DEN tærskel (>=). Returnerer kurvepunkter + en grov
// AUC-PR (trapez-regel over recall-aksen, sorteret stigende efter recall).
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
  // AUC-PR: trapez over recall (stigende), kun punkter med defineret precision.
  const sorted = curve.filter((c) => c.precision != null).slice().sort((a, b) => a.recall - b.recall);
  let aucPr = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dRecall = sorted[i].recall - sorted[i - 1].recall;
    const avgPrecision = (sorted[i].precision + sorted[i - 1].precision) / 2;
    aucPr += dRecall * avgPrecision;
  }
  if (sorted.length > 0) aucPr += sorted[0].recall * sorted[0].precision; // fra recall=0 til første punkt
  return { curve, aucPr: sorted.length ? aucPr : null, n: withScore.length, totalPositive };
}

// ── Kalibrerings-/pålidelighedskurve — decil-bøtter af predikteret score,
// observeret fejlrate pr. bøtte + Wilson-CI. Fortæller om en score på 0,8
// REELT betyder ~80% chance for at fejle, eller om modellen er over-/
// underkonfident. ──────────────────────────────────────────────────────
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

// ── Open-Meteo historisk arkiv-hentning (uændret fra validate-predictions-
// historical.js — genbrugt, ikke omskrevet) ─────────────────────────────
async function fetchArchive(lat, lng, startDate, endDate, attempt = 0) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${startDate}&end_date=${endDate}&hourly=precipitation&timezone=UTC`;
  const res = await fetch(url);
  if (res.status === 429) {
    if (attempt >= 6) throw new Error(`Open-Meteo archive API 429 for ${lat},${lng} — gave up after ${attempt} retries`);
    await sleep(2000 * 2 ** attempt);
    return fetchArchive(lat, lng, startDate, endDate, attempt + 1);
  }
  if (!res.ok) {
    if (attempt >= 2) throw new Error(`Open-Meteo archive API ${res.status} for ${lat},${lng} — gave up after ${attempt} retries`);
    await sleep(1000 * (attempt + 1));
    return fetchArchive(lat, lng, startDate, endDate, attempt + 1);
  }
  const json = await res.json();
  return { time: json.hourly.time, mm: json.hourly.precipitation };
}

async function mapWithConcurrency(items, limit, fn, pacingMs, onProgress) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i).catch((err) => ({ error: err.message }));
      done++;
      if (onProgress) onProgress(done, items.length);
      if (pacingMs) await sleep(pacingMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Skærer en cellens fulde time-serie til vinduet [endDate - windowHours,
// endDate] (UTC-middag-konvention, se filhoved) — chronological (ældste
// først), samme brug som server.js' hourlyWeek.
function hourlySeriesEndingAt(cellSeries, endDate, windowHours) {
  const endMs = new Date(`${endDate}T12:00:00Z`).getTime();
  const startMs = endMs - windowHours * 3600 * 1000;
  const out = [];
  for (let i = 0; i < cellSeries.time.length; i++) {
    const raw = cellSeries.time[i];
    const tMs = new Date(raw.endsWith('Z') ? raw : `${raw}Z`).getTime();
    if (tMs >= startMs && tMs <= endMs) out.push(Math.max(cellSeries.mm[i] || 0, 0));
  }
  return out;
}

// RÅ (ikke henfaldet) nedbørssum over et vindue — bruges KUN til den
// trivielle baseline-model (se filhoved for scripts/validate-badevand-
// model.js): "flag hvis rå nedbør overstiger X mm i et fast vindue, ingen
// pr.-udløbs-kalibrering" — adskilt fra den henfaldede/kalibrerede
// hovedmodel med vilje, netop for at være en ÆRLIG, uafhængig sammenligning.
function rawRainSumWindow(cellSeries, endDate, windowHours) {
  const hourly = hourlySeriesEndingAt(cellSeries, endDate, windowHours);
  return hourly.reduce((a, b) => a + b, 0);
}

function seasonalTauForMonth(riskModel, month) {
  const T = riskModel.DK_WATER_TEMP[month];
  const light = riskModel.DK_DAYLIGHT_HRS[month];
  const tempFactor = Math.pow(riskModel.Q10, (20 - T) / 10);
  const lightFactor = 12 / Math.max(light, 4);
  return riskModel.TAU_BASE_DAYS * tempFactor * lightFactor;
}
function seasonalTauViralForMonth(riskModel, month) {
  const T = riskModel.DK_WATER_TEMP[month];
  const light = riskModel.DK_DAYLIGHT_HRS[month];
  const tempFactor = Math.pow(riskModel.Q10_VIRAL, (20 - T) / 10);
  const lightFactor = T >= 12 ? (12 / Math.max(light, 4)) : 1.0;
  return riskModel.TAU_VIRAL_BASE * tempFactor * lightFactor;
}

// Badesæson, groft maj-september (bruger-krav i opgaven) — 0-indekserede
// måneder (4=maj .. 8=september).
function isBathingSeasonMonth(month) { return month >= 4 && month <= 8; }

module.exports = {
  isoDate, sleep,
  ECOLI_THRESHOLD, ENTERO_THRESHOLD, sampleFailed, sampleExceedanceRatio,
  rankOf, spearman,
  wilsonInterval, confusionStats, precisionRecallCurve, calibrationCurve,
  fetchArchive, mapWithConcurrency,
  hourlySeriesEndingAt, rawRainSumWindow,
  seasonalTauForMonth, seasonalTauViralForMonth, isBathingSeasonMonth,
};
