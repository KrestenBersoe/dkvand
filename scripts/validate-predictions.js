#!/usr/bin/env node
// Compares predicted bacterial risk (badevand_daily_risk, app-metrics.js)
// against real lab sample results (badevand-proeve-historik.json, written
// by scripts/build-badevand-analyseresultater.js alongside its usual
// "latest sample per station" output — see that script's OUT_SAMPLES_FILE
// comment) for every station+date where both exist.
//
// Manual/occasional, not a live server code path. Needs
// badevand-proeve-historik.json to actually exist first — it's only
// produced by re-running build-badevand-analyseresultater.js against a
// fresh PULS CSV export (an offline, manual 2.1GB import, not something
// this script or the running app fetches on its own — see that script's
// own header for the two data sources it needs).
//
// Same threshold/classification approach as that build script's own
// classifySample(): a sample "fails" at >= these thresholds, the EU
// directive's single-sample cutoffs already used elsewhere in this repo,
// not the real rolling-4-year official classification.
//
// Needs DATABASE_URL set (same Postgres the running server uses) to read
// badevand_daily_risk — run this from an environment that has it.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const SAMPLES_FILE = path.join(__dirname, '..', 'badevand-proeve-historik.json');
const ECOLI_THRESHOLD = 500;
const ENTERO_THRESHOLD = 200;
const FLAG_THRESHOLD = 0.2; // same 'medium' cutoff as ukwater/frwater's dailyRiskHistory.js

function sampleFailed(sample) {
  const { ecoli, enterokokker } = sample;
  if (ecoli == null && enterokokker == null) return null;
  return (ecoli != null && ecoli >= ECOLI_THRESHOLD) || (enterokokker != null && enterokokker >= ENTERO_THRESHOLD);
}

async function main() {
  if (!fs.existsSync(SAMPLES_FILE)) {
    console.error(`${SAMPLES_FILE} doesn't exist yet.`);
    console.error('Run scripts/build-badevand-analyseresultater.js against a fresh PULS CSV export first — see its own header for the two data sources it needs (the 2.1GB "Badevand: Analyse- og Måleresultater" CSV plus the WFS layers). It writes this file automatically alongside its usual output.');
    process.exit(1);
  }
  const samplesData = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf8'));
  console.log(`Loaded ${samplesData.samples.length} samples.`);

  const { rows: riskRows } = await pool.query('SELECT badested_id, date, sum_bact, n_bact FROM badevand_daily_risk');
  const riskByKey = new Map(riskRows.map((r) => [`${r.badested_id}|${r.date}`, r]));
  console.log(`Loaded ${riskRows.length} badevand_daily_risk rows.`);

  let noResult = 0;
  let noPrediction = 0;
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const sample of samplesData.samples) {
    const failed = sampleFailed(sample);
    if (failed === null) { noResult++; continue; }

    const risk = riskByKey.get(`${sample.siteId}|${sample.dateIso}`);
    if (!risk || risk.n_bact === 0) { noPrediction++; continue; }

    const avgBact = risk.sum_bact / risk.n_bact;
    const flagged = avgBact >= FLAG_THRESHOLD;

    if (failed && flagged) tp++;
    else if (!failed && flagged) fp++;
    else if (!failed && !flagged) tn++;
    else fn++;
  }

  const compared = tp + fp + tn + fn;
  console.log('');
  console.log(`Compared: ${compared} sample+prediction pairs`);
  console.log(`Skipped: ${noResult} (no lab result), ${noPrediction} (no matching prediction for that day)`);
  console.log('');
  console.log('Confusion matrix (failed sample vs. flagged prediction):');
  console.log(`  True positive  (failed + flagged):     ${tp}`);
  console.log(`  False positive (passed + flagged):     ${fp}`);
  console.log(`  True negative  (passed + not flagged): ${tn}`);
  console.log(`  False negative (failed + not flagged): ${fn}`);
  if (compared > 0) {
    const totalFailed = tp + fn;
    const totalPassed = fp + tn;
    console.log('');
    if (totalFailed > 0) console.log(`  Recall (caught real fails):  ${((tp / totalFailed) * 100).toFixed(1)}% (${tp}/${totalFailed})`);
    if (totalPassed > 0) console.log(`  False alarm rate:            ${((fp / totalPassed) * 100).toFixed(1)}% (${fp}/${totalPassed})`);
    console.log(`  Overall accuracy:            ${(((tp + tn) / compared) * 100).toFixed(1)}%`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('validate-predictions failed:', err);
  process.exit(1);
});
