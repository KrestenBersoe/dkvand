#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// sweep-sigmoid-steepness.js — runs validate-uk-risk-score.js's
// --sigmoid-baseline-probability variant once per steepness value in one
// command, then prints AUC-PR/precision/recall/lift side by side so a
// steepness sweep doesn't require running and comparing 4-6 full backtests
// by hand. Follows the same child-process-per-run + newest-results-file
// pattern as isolate-distance-effect.js.
//
// Each run takes ~5-6 minutes (full 16,855-sample backtest) — the default
// steepness list (1,2,4,6) is 4 runs, ~20-25 minutes total. Pass
// --steepness-values to change it.
//
// Kør fra ukwater-repo/:
//   node sweep-sigmoid-steepness.js --ukwater-repo /path/to/ukwater [--steepness-values 1,2,4,6] [--dir output]
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));
const NONEXISTENT = path.join(DIR, '__does-not-exist__.json');
const STEEPNESS_VALUES = argVal('--steepness-values', '1,2,4,6').split(',').map((s) => parseFloat(s.trim()));
// Optional: also compare against the real exponential curve (no sigmoid
// flag at all) as the steepness=0 reference row, so the sweep table is
// self-contained rather than requiring a separate compare-runs.js call.
const INCLUDE_EXPONENTIAL_REFERENCE = !process.argv.includes('--no-exponential-reference');

function newestResultsJson(outDir) {
  const files = fs.readdirSync(outDir).filter((f) => /^uk-risk-score-results-.*\.json$/.test(f));
  if (files.length === 0) throw new Error(`Ingen uk-risk-score-results-*.json fundet i ${outDir}`);
  files.sort();
  return path.join(outDir, files[files.length - 1]);
}

function extractHeadline(resultsJsonPath) {
  const data = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8'));
  const rows = {};
  for (const key of ['combined', 'bacterial']) {
    const r = data.results.find((x) => x.scoreField === key && x.labelType === 'either' && x.segment === 'overall');
    if (!r) continue;
    const c = r.confusionAtFlagGt0_2;
    rows[key] = { n: r.n, aucPr: r.aucPr, liftOverBaseRate: r.liftOverBaseRate, precision: c.precision.p, recall: c.recall.p };
  }
  return rows;
}

async function main() {
  const runs = []; // { label, steepness, outDir }
  if (INCLUDE_EXPONENTIAL_REFERENCE) {
    runs.push({ label: 'exponential (ægte kode)', steepness: null, outDir: path.join(DIR, 'sweep-sigmoid-exponential'), extraArgs: [] });
  }
  for (const s of STEEPNESS_VALUES) {
    runs.push({ label: `sigmoid steepness=${s}`, steepness: s, outDir: path.join(DIR, `sweep-sigmoid-steepness-${s}`), extraArgs: ['--sigmoid-baseline-probability', '--sigmoid-steepness', String(s)] });
  }

  const headlineByRun = [];
  for (const run of runs) {
    console.log(`\n═══ Kører: ${run.label} ═══`);
    fs.mkdirSync(run.outDir, { recursive: true });
    const args = [
      path.join(__dirname, 'validate-uk-risk-score.js'),
      '--ukwater-repo', UKWATER_REPO,
      '--out-dir', run.outDir,
      '--currents', NONEXISTENT,
      '--calibrated-thresholds', NONEXISTENT,
      ...run.extraArgs,
    ];
    const t0 = Date.now();
    execFileSync(process.execPath, args, { stdio: 'inherit' });
    console.log(`(${run.label}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    headlineByRun.push({ label: run.label, steepness: run.steepness, ...extractHeadline(newestResultsJson(run.outDir)) });
  }

  function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }
  function fmtAuc(x) { return x == null ? 'n/a' : x.toFixed(4); }
  function fmtLift(x) { return x == null ? 'n/a' : x.toFixed(2) + 'x'; }

  for (const scoreField of ['combined', 'bacterial']) {
    console.log(`\n\n═══════════════════════════════════════════════════════════════`);
    console.log(`  Sigmoid-stejlhed sweep — ${scoreField === 'combined' ? 'kombineret score' : 'kun bakteriel sub-score'}, "enten"-determinand, alle stationer, flag-tærskel >0.2`);
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log('Label'.padEnd(28), 'AUC-PR'.padEnd(9), 'Lift'.padEnd(8), 'Precision'.padEnd(11), 'Recall');
    for (const h of headlineByRun) {
      const r = h[scoreField];
      if (!r) { console.log(h.label.padEnd(28), '(mangler)'); continue; }
      console.log(h.label.padEnd(28), fmtAuc(r.aucPr).padEnd(9), fmtLift(r.liftOverBaseRate).padEnd(8), fmtPct(r.precision).padEnd(11), fmtPct(r.recall));
    }
  }

  const summaryPath = path.join(DIR, 'sweep-sigmoid-steepness-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), steepnessValues: STEEPNESS_VALUES, headlineByRun }, null, 2), 'utf8');
  console.log(`\nSkrevet: ${summaryPath}`);
}

main().catch((err) => {
  console.error('sweep-sigmoid-steepness fejlede:', err);
  process.exit(1);
});
