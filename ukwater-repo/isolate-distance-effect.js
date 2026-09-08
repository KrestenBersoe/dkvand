#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// isolate-distance-effect.js — answers ONE question in a single command:
// is the AUC-PR/precision/recall drop caused by real CMEMS currents smaller
// for sites whose nearest outlet is ≥7km away (several CMEMS grid cells,
// so the current vector is less likely to be spatially wrong) than for
// sites <7km away (inside a single CMEMS cell, where the fetched current
// may not represent the true local flow)?
//
// Consolidates what were two manual runs of validate-uk-risk-score.js
// (baseline: no currents, no calibration / currents-only: no calibration)
// plus two manual node -e extraction snippets into one script:
//   1. runs validate-uk-risk-score.js twice as child processes, pointing
//      --currents / --calibrated-thresholds at a nonexistent path to
//      isolate exactly one real input at a time (same technique already
//      used for the calibration-vs-currents isolation runs)
//   2. reads both runs' newest uk-risk-score-results-*.json
//   3. prints the distance:close / distance:far AUC-PR, precision@0.2,
//      recall@0.2 for baseline vs currents-only side by side, plus the
//      delta each band shows when currents are added
//
// Kør fra ukwater-repo/:
//   node isolate-distance-effect.js --ukwater-repo /path/to/ukwater [--dir output]
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
// validate-uk-risk-score.js's OWN default for --currents is <output-dir>/currents-history.json,
// but where that file actually got saved has varied by machine (repo root vs.
// output/) in earlier runs this session — so try both known locations before
// giving up, rather than assuming one.
const CURRENTS_CANDIDATES = [
  argVal('--currents', null),
  path.join(DIR, 'currents-history.json'),
  path.join(__dirname, 'currents-history.json'),
].filter(Boolean).map((p) => path.resolve(p));
const CURRENTS_PATH = CURRENTS_CANDIDATES.find((p) => fs.existsSync(p));
if (!CURRENTS_PATH) {
  console.error('CMEMS-strømfil ikke fundet. Forsøgte:');
  for (const p of CURRENTS_CANDIDATES) console.error(`  ${p}`);
  console.error('Angiv den reelle sti med --currents /sti/til/currents-history.json');
  process.exit(1);
}

const RUNS = [
  {
    key: 'baseline', label: 'Baseline (ingen strøm, ingen kalibrering — tier 2 for alle udløb)',
    outDir: path.join(DIR, 'isolate-distance-baseline'),
    extraArgs: ['--currents', NONEXISTENT, '--calibrated-thresholds', NONEXISTENT],
  },
  {
    key: 'currents', label: 'Kun reelle CMEMS-strømme (stadig ingen kalibrering — tier 2)',
    outDir: path.join(DIR, 'isolate-distance-currents'),
    extraArgs: ['--currents', CURRENTS_PATH, '--calibrated-thresholds', NONEXISTENT],
  },
];

function newestResultsJson(outDir) {
  const files = fs.readdirSync(outDir).filter((f) => /^uk-risk-score-results-.*\.json$/.test(f));
  if (files.length === 0) throw new Error(`Ingen uk-risk-score-results-*.json fundet i ${outDir}`);
  files.sort();
  return path.join(outDir, files[files.length - 1]);
}

function extractBands(resultsJsonPath) {
  const data = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8'));
  const bands = {};
  for (const bandKey of ['distance:close', 'distance:far']) {
    const r = data.results.find((x) => x.scoreField === 'combined' && x.labelType === 'either' && x.segment === bandKey);
    if (!r) { bands[bandKey] = null; continue; }
    const c = r.confusionAtFlagGt0_2;
    bands[bandKey] = {
      n: r.n, totalPositive: r.totalPositive, baseRate: r.baseRate, aucPr: r.aucPr,
      precision: c.precision.p, recall: c.recall.p,
    };
  }
  return bands;
}

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }
function fmtAuc(x) { return x == null ? 'n/a' : x.toFixed(3); }

async function main() {
  const bandsByRun = {};
  for (const run of RUNS) {
    console.log(`\n═══ Kører: ${run.label} ═══`);
    fs.mkdirSync(run.outDir, { recursive: true });
    const args = [
      path.join(__dirname, 'validate-uk-risk-score.js'),
      '--ukwater-repo', UKWATER_REPO,
      '--out-dir', run.outDir,
      ...run.extraArgs,
    ];
    const t0 = Date.now();
    execFileSync(process.execPath, args, { stdio: 'inherit' });
    console.log(`(${run.key}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    bandsByRun[run.key] = extractBands(newestResultsJson(run.outDir));
  }

  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  Er strøm-effekten mindre for vidt adskilte stationer (≥7km)?');
  console.log('  (kombineret score, "enten" E. coli/enterococci, flag-tærskel >0.2)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const bandKey of ['distance:close', 'distance:far']) {
    const base = bandsByRun.baseline[bandKey];
    const cur = bandsByRun.currents[bandKey];
    const label = bandKey === 'distance:close' ? 'CLOSE (<7km, inden for én CMEMS-celle)' : 'FAR (≥7km, flere CMEMS-celler væk)';
    console.log(`── ${label} ──`);
    if (!base || !cur) { console.log('  (mangler data for et af de to runs)\n'); continue; }
    console.log(`  n: baseline=${base.n}, currents=${cur.n}`);
    console.log(`  AUC-PR:     baseline=${fmtAuc(base.aucPr)}  ->  currents=${fmtAuc(cur.aucPr)}  (Δ=${base.aucPr != null && cur.aucPr != null ? (cur.aucPr - base.aucPr).toFixed(3) : 'n/a'})`);
    console.log(`  Precision:  baseline=${fmtPct(base.precision)}  ->  currents=${fmtPct(cur.precision)}`);
    console.log(`  Recall:     baseline=${fmtPct(base.recall)}  ->  currents=${fmtPct(cur.recall)}`);
    console.log('');
  }

  const closeDelta = bandsByRun.baseline['distance:close']?.aucPr != null && bandsByRun.currents['distance:close']?.aucPr != null
    ? bandsByRun.currents['distance:close'].aucPr - bandsByRun.baseline['distance:close'].aucPr : null;
  const farDelta = bandsByRun.baseline['distance:far']?.aucPr != null && bandsByRun.currents['distance:far']?.aucPr != null
    ? bandsByRun.currents['distance:far'].aucPr - bandsByRun.baseline['distance:far'].aucPr : null;

  console.log('── Konklusion ──');
  if (closeDelta == null || farDelta == null) {
    console.log('  Utilstrækkeligt data i et af båndene til at konkludere (for få stationer/prøver).');
  } else {
    console.log(`  ΔAUC-PR close = ${closeDelta.toFixed(3)}, ΔAUC-PR far = ${farDelta.toFixed(3)}.`);
    if (Math.abs(farDelta) < Math.abs(closeDelta)) {
      console.log('  => Effekten er MINDRE for vidt adskilte stationer — konsistent med hypotesen om, at CMEMS\' 7km gitteropløsning er for grov tæt på kysten.');
    } else {
      console.log('  => Effekten er IKKE mindre for vidt adskilte stationer — den grove CMEMS-opløsning forklarer næppe alene forringelsen.');
    }
  }

  const summaryPath = path.join(DIR, 'isolate-distance-effect-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), bandsByRun, closeDelta, farDelta }, null, 2), 'utf8');
  console.log(`\nSkrevet: ${summaryPath}`);
}

main().catch((err) => {
  console.error('isolate-distance-effect fejlede:', err);
  process.exit(1);
});
