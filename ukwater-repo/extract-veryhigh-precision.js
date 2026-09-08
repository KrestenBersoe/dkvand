#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// extract-veryhigh-precision.js — answers "when the risk score is in the
// app's own Very High band (score > 0.8, per server/risk/scoreSite.js's
// RISK_BANDS), how often is that actually correct?" for every backtest
// result file already on disk — no rerun needed.
//
// Every uk-risk-score(-traveltime)?-results-*.json already stores a full
// precision/recall curve (one entry per DISTINCT observed score, precision
// = TP/(TP+FP) among samples with score >= that threshold — see
// lib/backtest-stats.js's precisionRecallCurve()). Very High is score > 0.8
// (strictly above — 0.8 itself is High, per RISK_BANDS' `score <= max`
// rule), so this picks, per result entry, the curve row whose threshold is
// the SMALLEST observed score strictly greater than 0.8 — that row's
// "score >= threshold" set is exactly "score > 0.8" by construction (no
// observed score sits between 0.8 and that threshold).
//
// Kør fra ukwater-repo/ (denne mappe):
//   node extract-veryhigh-precision.js [--dir output] [--all]
// --all viser hvert scoreField/labelType/segment, ikke kun det samlede
// (overall, either-determinand) resultat pr. fil.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SHOW_ALL = process.argv.includes('--all');
const BAND_MIN = parseFloat(argVal('--above', '0.8')); // RISK_BANDS' High/Very High boundary
const ROOT = path.resolve(argVal('--dir', path.join(__dirname, 'output')));

function findResultFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findResultFiles(p));
    else if (/^uk-risk-score(-traveltime)?-results-.*\.json$/.test(entry.name)) out.push(p);
  }
  return out;
}

// The curve row whose "score >= threshold" set is exactly "score > BAND_MIN":
// the smallest observed threshold strictly greater than BAND_MIN.
function veryHighFromCurve(curve, bandMin) {
  const above = curve.filter((c) => c.threshold > bandMin);
  if (above.length === 0) return null; // no sample ever scored above the band boundary
  above.sort((a, b) => a.threshold - b.threshold);
  const row = above[0];
  return { cutAt: row.threshold, precision: row.precision, recall: row.recall, flaggedCount: row.predictedPositive };
}

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }

function main() {
  const files = findResultFiles(ROOT).sort();
  if (files.length === 0) {
    console.error(`Ingen uk-risk-score(-traveltime)?-results-*.json fundet under ${ROOT}.`);
    process.exit(1);
  }
  console.log(`${files.length} resultatfil(er) fundet under ${ROOT}.\n`);

  const rows = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of data.results || []) {
      if (!SHOW_ALL && !(r.segment === 'overall' && r.labelType === 'either')) continue;
      const vh = veryHighFromCurve(r.precisionRecallCurve || [], BAND_MIN);
      rows.push({
        file: rel, scoreField: r.scoreField, scoreFieldLabel: r.scoreFieldLabel,
        labelType: r.labelType, segment: r.segment, n: r.n, totalPositive: r.totalPositive,
        baseRate: r.baseRate, veryHigh: vh,
      });
    }
  }

  console.log(`═══ Ved score > ${BAND_MIN} ("Very High"-båndet i RISK_BANDS): hvor ofte er det reelt korrekt? ═══\n`);
  for (const row of rows) {
    const label = SHOW_ALL ? `${row.file} :: ${row.scoreFieldLabel} :: ${row.labelType} :: ${row.segment}` : `${row.file} :: ${row.scoreFieldLabel}`;
    console.log(label);
    console.log(`  Baggrundsrate (andel reelt forurenet, alle prøver): ${fmtPct(row.baseRate)} (n=${row.n})`);
    if (!row.veryHigh) {
      console.log(`  Ingen prøver scoret over ${BAND_MIN} i denne fil — Very High-båndet blev aldrig ramt.\n`);
      continue;
    }
    const vh = row.veryHigh;
    console.log(`  Very High (score > ${BAND_MIN}, reelt målt fra score >= ${vh.cutAt.toFixed(4)}): precision=${fmtPct(vh.precision)}, recall=${fmtPct(vh.recall)}, antal flagget=${vh.flaggedCount}`);
    console.log('');
  }

  const outPath = path.join(ROOT, 'veryhigh-precision-summary.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), bandMin: BAND_MIN, rows }, null, 2), 'utf8');
  console.log(`Skrevet: ${outPath}`);
}

main();
