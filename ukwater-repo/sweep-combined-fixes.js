#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// sweep-combined-fixes.js — runs the two confirmed, independently-validated
// fixes from this session (shrinkage calibration, current-bias exclusion
// softening) alone and together, in one command, so the combined effect is
// measured rather than assumed. Both were validated separately — shrinkage
// calibration with currents off, the current-bias fix with the ORIGINAL
// count-matched (or no) calibration — never together with real currents on.
// They patch different real files (baselineProbability.js's calibrated-
// threshold LOOKUP is untouched by shrinkage calibration itself — it just
// feeds a different --calibrated-thresholds file in; currentBias.js is a
// separate module entirely), so the gains plausibly stack, but "plausibly"
// isn't "confirmed."
//
// Runs 4 configs against the exact same sample set:
//   baseline        - no calibration, no currents
//   shrinkage-only   - shrinkage calibration, no currents
//   currentfix-only  - no calibration, real currents + softened exclusion
//   combined         - shrinkage calibration + real currents + softened exclusion
//
// REQUIRES output/outlet-calibrated-thresholds-shrinkage.json to already
// exist — run compute-outlet-thresholds-shrinkage.js first (fails fast
// with a clear message if missing, rather than silently falling back to
// tier 2 for the two configs that are supposed to use it).
//
// Kør fra ukwater-repo/:
//   node sweep-combined-fixes.js --ukwater-repo /path/to/ukwater [--dir output]
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
const SHRINKAGE_PATH = path.resolve(argVal('--shrinkage-thresholds', path.join(DIR, 'outlet-calibrated-thresholds-shrinkage.json')));

if (!fs.existsSync(SHRINKAGE_PATH)) {
  console.error(`Mangler ${SHRINKAGE_PATH}.`);
  console.error('Kør compute-outlet-thresholds-shrinkage.js først:');
  console.error(`  node compute-outlet-thresholds-shrinkage.js --ukwater-repo ${UKWATER_REPO}`);
  process.exit(1);
}

const RUNS = [
  { key: 'baseline', label: 'Baseline (ingen kalibrering, ingen strøm)', extraArgs: ['--calibrated-thresholds', NONEXISTENT, '--currents', NONEXISTENT] },
  { key: 'shrinkage-only', label: 'Kun shrinkage-kalibrering (ingen strøm)', extraArgs: ['--calibrated-thresholds', SHRINKAGE_PATH, '--currents', NONEXISTENT] },
  { key: 'currentfix-only', label: 'Kun strøm-fix (reelle strømme + softened exclusion, ingen kalibrering)', extraArgs: ['--calibrated-thresholds', NONEXISTENT, '--soften-current-exclusion'] },
  { key: 'combined', label: 'Kombineret (shrinkage-kalibrering + reelle strømme + softened exclusion)', extraArgs: ['--calibrated-thresholds', SHRINKAGE_PATH, '--soften-current-exclusion'] },
];

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

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }
function fmtAuc(x) { return x == null ? 'n/a' : x.toFixed(4); }
function fmtLift(x) { return x == null ? 'n/a' : x.toFixed(2) + 'x'; }

async function main() {
  const headlineByRun = [];
  for (const run of RUNS) {
    console.log(`\n═══ Kører: ${run.label} ═══`);
    const outDir = path.join(DIR, `sweep-combined-${run.key}`);
    fs.mkdirSync(outDir, { recursive: true });
    const args = [
      path.join(__dirname, 'validate-uk-risk-score.js'),
      '--ukwater-repo', UKWATER_REPO,
      '--out-dir', outDir,
      ...run.extraArgs,
    ];
    const t0 = Date.now();
    execFileSync(process.execPath, args, { stdio: 'inherit' });
    console.log(`(${run.key}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    headlineByRun.push({ label: run.label, key: run.key, ...extractHeadline(newestResultsJson(outDir)) });
  }

  for (const scoreField of ['combined', 'bacterial']) {
    console.log(`\n\n═══════════════════════════════════════════════════════════════`);
    console.log(`  Kombinerede fixes — ${scoreField === 'combined' ? 'kombineret score' : 'kun bakteriel sub-score'}, "enten"-determinand, alle stationer, flag-tærskel >0.2`);
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log('Konfiguration'.padEnd(14), 'AUC-PR'.padEnd(9), 'Lift'.padEnd(8), 'Precision'.padEnd(11), 'Recall');
    for (const h of headlineByRun) {
      const r = h[scoreField];
      if (!r) { console.log(h.key.padEnd(14), '(mangler)'); continue; }
      console.log(h.key.padEnd(14), fmtAuc(r.aucPr).padEnd(9), fmtLift(r.liftOverBaseRate).padEnd(8), fmtPct(r.precision).padEnd(11), fmtPct(r.recall));
    }
    const base = headlineByRun.find((h) => h.key === 'baseline')?.[scoreField];
    const shrinkage = headlineByRun.find((h) => h.key === 'shrinkage-only')?.[scoreField];
    const currentfix = headlineByRun.find((h) => h.key === 'currentfix-only')?.[scoreField];
    const combo = headlineByRun.find((h) => h.key === 'combined')?.[scoreField];
    if (base?.aucPr != null && shrinkage?.aucPr != null && currentfix?.aucPr != null && combo?.aucPr != null) {
      const shrinkageGain = shrinkage.aucPr - base.aucPr;
      const currentfixGain = currentfix.aucPr - base.aucPr;
      const comboGain = combo.aucPr - base.aucPr;
      const additivePrediction = base.aucPr + shrinkageGain + currentfixGain;
      console.log(`\n  Individuelle AUC-PR-gevinster: shrinkage=${shrinkageGain >= 0 ? '+' : ''}${shrinkageGain.toFixed(4)}, strøm-fix=${currentfixGain >= 0 ? '+' : ''}${currentfixGain.toFixed(4)}`);
      console.log(`  Hvis additivt (uafhængige effekter), forventet kombineret AUC-PR: ~${additivePrediction.toFixed(4)}`);
      console.log(`  Faktisk kombineret AUC-PR: ${combo.aucPr.toFixed(4)} (${comboGain >= 0 ? '+' : ''}${comboGain.toFixed(4)} vs. baseline)`);
      const diff = combo.aucPr - additivePrediction;
      console.log(`  Afvigelse fra additiv forudsigelse: ${diff >= 0 ? '+' : ''}${diff.toFixed(4)} (${Math.abs(diff) < 0.003 ? 'omtrent additivt' : diff > 0 ? 'super-additivt — gevinsterne forstærker hinanden' : 'sub-additivt — gevinsterne overlapper delvist'})`);
    }
  }

  const summaryPath = path.join(DIR, 'sweep-combined-fixes-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), headlineByRun }, null, 2), 'utf8');
  console.log(`\nSkrevet: ${summaryPath}`);
}

main().catch((err) => {
  console.error('sweep-combined-fixes fejlede:', err);
  process.exit(1);
});
