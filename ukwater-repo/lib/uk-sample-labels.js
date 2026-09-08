#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// uk-sample-labels.js — builds one labeled record per real physical EA
// sample (grouping ea-samples.ndjson's per-determinand observation rows back
// together) with E. coli/enterococci exceedance labels. Factored out of
// validate-uk-model.js so it and validate-uk-risk-score.js (which scores the
// SAME samples with the REAL scoreSite() cascade instead of a raw event
// count) compute IDENTICAL labels — if this logic ever diverged between the
// two, their results would silently stop being comparable, which would
// defeat the entire point of testing two signals against the same ground
// truth. See validate-uk-model.js's own filehead for the regulatory
// threshold citation and censored-value handling rationale — unchanged here,
// just relocated.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const readline = require('readline');

const ECOLI_CODE = '2348'; // Escherichia coli : Confirmed : MF — the ONLY E. coli code present in the real data (verified)
const ENTEROCOCCI_CODES_PREFERRED = ['3723', '3722']; // Confirmed:MF preferred over Presumptive:MF when both exist

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

function effectiveValue(obs) {
  return obs.numericValue != null ? obs.numericValue : obs.bound;
}

/**
 * @param {string} samplesPath - path to ea-samples.ndjson
 * @param {Map<string, object>} siteByNotation - EA site notation -> site record (for `area`)
 * @param {number} ecoliThreshold
 * @param {number} enterococciThreshold
 * @param {(scanned: number, grouped: number) => void} [onProgress]
 * @returns {Promise<Array>} one record per physical sample with at least one determinand present
 */
async function buildLabeledSampleEvents(samplesPath, siteByNotation, ecoliThreshold, enterococciThreshold, onProgress) {
  const sampleGroups = new Map(); // `${siteNotation}|${sampleNumericId}` -> { siteNotation, phenomenonTime, ecoli, enterococciByCode }
  const SAMPLE_ID_RE = /\/sample\/([^/]+)\/observation\//;
  let samplesScanned = 0;
  for await (const obs of ndjsonLines(samplesPath)) {
    samplesScanned++;
    if (obs.determinandCode !== ECOLI_CODE && !ENTEROCOCCI_CODES_PREFERRED.includes(obs.determinandCode)) continue;
    const m = SAMPLE_ID_RE.exec(obs.sampleId || '');
    if (!m) continue;
    const key = `${obs.siteNotation}|${m[1]}`;
    let g = sampleGroups.get(key);
    if (!g) { g = { siteNotation: obs.siteNotation, phenomenonTime: obs.phenomenonTime, ecoli: null, enterococciByCode: {} }; sampleGroups.set(key, g); }
    if (obs.determinandCode === ECOLI_CODE) g.ecoli = obs;
    else g.enterococciByCode[obs.determinandCode] = obs;
  }

  const sampleEvents = [];
  for (const g of sampleGroups.values()) {
    const entero = ENTEROCOCCI_CODES_PREFERRED.map((c) => g.enterococciByCode[c]).find((o) => o != null) || null;
    const ecoliVal = g.ecoli ? effectiveValue(g.ecoli) : null;
    const enteroVal = entero ? effectiveValue(entero) : null;
    const ecoliExceeds = ecoliVal != null ? ecoliVal > ecoliThreshold : null;
    const enteroExceeds = enteroVal != null ? enteroVal > enterococciThreshold : null;
    if (ecoliExceeds === null && enteroExceeds === null) continue; // neither determinand present — nothing to label
    const eitherExceeds = (ecoliExceeds === true) || (enteroExceeds === true);
    const site = siteByNotation.get(g.siteNotation);
    sampleEvents.push({
      siteNotation: g.siteNotation,
      area: site ? site.area : null,
      phenomenonTime: g.phenomenonTime,
      tsMs: g.phenomenonTime ? Date.parse(g.phenomenonTime.endsWith('Z') || /[+-]\d\d:\d\d$/.test(g.phenomenonTime) ? g.phenomenonTime : g.phenomenonTime + 'Z') : null,
      ecoliValue: ecoliVal, ecoliExceeds,
      enterococciValue: enteroVal, enterococciExceeds: enteroExceeds,
      eitherExceeds,
    });
  }
  if (onProgress) onProgress(samplesScanned, sampleEvents.length);
  return sampleEvents;
}

module.exports = { buildLabeledSampleEvents, ECOLI_CODE, ENTEROCOCCI_CODES_PREFERRED, effectiveValue };
