#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// compare-runs.js — prints a side-by-side delta between two
// uk-risk-score-results-*.json files (any two variants: baseline,
// calibration-only, currents-only, soften-current-exclusion, etc.) at the
// app's own flag-threshold (>0.2, confusionAtFlagGt0_2) and AUC-PR/lift, for
// every scoreField × labelType at segment=overall by default. Generalizes
// the ad-hoc node -e extraction snippets used earlier this session (e.g. for
// the distance-band isolation comparison) into one reusable tool, since this
// "did variant A beat variant B" comparison keeps recurring.
//
// Kør fra ukwater-repo/:
//   node compare-runs.js --a output/isolate-currents-only --b output/isolate-soften-exclusion
// --a/--b accept either a directory (newest uk-risk-score-results-*.json in
// it is used) or a direct path to one such file. --all shows every
// segment (area:*, distance:*), not just overall.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SHOW_ALL_SEGMENTS = process.argv.includes('--all');

function resolveResultsFile(p) {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) { console.error(`Findes ikke: ${resolved}`); process.exit(1); }
  if (fs.statSync(resolved).isFile()) return resolved;
  const files = fs.readdirSync(resolved).filter((f) => /^uk-risk-score(-traveltime)?-results-.*\.json$/.test(f));
  if (files.length === 0) { console.error(`Ingen uk-risk-score(-traveltime)?-results-*.json fundet i ${resolved}.`); process.exit(1); }
  files.sort();
  return path.join(resolved, files[files.length - 1]);
}

const A_PATH = argVal('--a', null);
const B_PATH = argVal('--b', null);
const LABEL_A = argVal('--label-a', 'A');
const LABEL_B = argVal('--label-b', 'B');
if (!A_PATH || !B_PATH) {
  console.error('Brug: node compare-runs.js --a <dir-eller-fil> --b <dir-eller-fil> [--label-a NAVN] [--label-b NAVN] [--all]');
  process.exit(1);
}

const fileA = resolveResultsFile(A_PATH);
const fileB = resolveResultsFile(B_PATH);
const dataA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
const dataB = JSON.parse(fs.readFileSync(fileB, 'utf8'));

function keyOf(r) { return `${r.scoreField}::${r.labelType}::${r.segment}`; }
const byKeyB = new Map(dataB.results.map((r) => [keyOf(r), r]));

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }
function fmtNum(x, d = 3) { return x == null ? 'n/a' : x.toFixed(d); }
function fmtDelta(a, b, d = 3) { if (a == null || b == null) return 'n/a'; const delta = b - a; return `${delta >= 0 ? '+' : ''}${delta.toFixed(d)}`; }

console.log(`A = ${LABEL_A}: ${fileA}`);
console.log(`B = ${LABEL_B}: ${fileB}`);
console.log('');

let shown = 0;
for (const rA of dataA.results) {
  if (!SHOW_ALL_SEGMENTS && rA.segment !== 'overall') continue;
  const rB = byKeyB.get(keyOf(rA));
  if (!rB) continue;
  shown++;
  const cA = rA.confusionAtFlagGt0_2, cB = rB.confusionAtFlagGt0_2;
  console.log(`── ${rA.scoreFieldLabel} :: ${rA.labelDescription} :: ${rA.segmentLabel} ──`);
  console.log(`  n: ${LABEL_A}=${rA.n}, ${LABEL_B}=${rB.n}${rA.n !== rB.n ? '  [ADVARSEL: forskellig n — sammenligning kan være misvisende]' : ''}`);
  console.log(`  AUC-PR:  ${LABEL_A}=${fmtNum(rA.aucPr)}  ${LABEL_B}=${fmtNum(rB.aucPr)}  Δ=${fmtDelta(rA.aucPr, rB.aucPr)}`);
  console.log(`  Lift over baggrundsrate:  ${LABEL_A}=${fmtNum(rA.liftOverBaseRate, 2)}x  ${LABEL_B}=${fmtNum(rB.liftOverBaseRate, 2)}x  Δ=${fmtDelta(rA.liftOverBaseRate, rB.liftOverBaseRate, 2)}`);
  console.log(`  Precision (>0.2):  ${LABEL_A}=${fmtPct(cA.precision.p)}  ${LABEL_B}=${fmtPct(cB.precision.p)}  Δ=${fmtDelta(cA.precision.p, cB.precision.p, 4)}`);
  console.log(`  Recall (>0.2):     ${LABEL_A}=${fmtPct(cA.recall.p)}  ${LABEL_B}=${fmtPct(cB.recall.p)}  Δ=${fmtDelta(cA.recall.p, cB.recall.p, 4)}`);
  console.log('');
}
if (shown === 0) console.error('Ingen fælles scoreField/labelType/segment-rækker fundet mellem de to filer — er de fra samme script-version?');
