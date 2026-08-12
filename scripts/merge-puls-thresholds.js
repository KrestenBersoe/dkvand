#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// merge-puls-thresholds.js — kør fra repo-roden:
//   node scripts/merge-puls-thresholds.js
// (kræver puls-data.json og puls-udloeb-taerskler.json, se
//  scripts/compute-puls-udloeb-taerskler.js, som skal køres først)
//
// Fletter den udløbs-specifikke empiriske nedbørstærskel
// (puls-udloeb-taerskler.json) ind i puls-data.json som et nyt, bagestillet
// row[13]-felt — samme mønster som outfallId/reducedArea/type/sewerStructure/
// latestDischargeYear allerede blev tilføjet på (se update-puls.js's eget
// filhoved). Ingen eksisterende forbruger destrukturerer mere end position 8
// i dag, så dette er bagudkompatibelt; risk-model.js/dansk-overloeb-kort.html
// læser nu row[13] eksplicit.
//
// SCOPE: kun tærskler med tillidsgrad 'high', 'medium' eller 'borrowed'
// flettes ind — 'low' (kun 3-4 hændelser bag tallet) springes bevidst over
// og forbliver null, ligesom udløb uden nogen beregnet tærskel overhovedet.
// Disse falder alle tilbage til den generiske 25mm-model i
// computeIntensityFactor() (se risk-model.js — RETTET 2026-07-30, var
// tidligere 5mm, se filens egen begrundelse for kalibreringen). Beslutning
// og begrundelse for selve 'low'-udelukkelsen: se PULS-TAERSKLER-
// RAPPORT.md's valideringsafsnit (lånt gruppe: median 13,8% afvigelse —
// for usikkert for 'low'-gruppens kun 3-4 hændelser).
//
// IDEMPOTENT: sætter row[13] eksplicit på HVER kørsel (nummer eller null),
// uafhængigt af hvad der stod der fra en tidligere kørsel — trygt at køre
// gentagne gange, som resten af update-all-data.sh-pipelinen.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs   = require('fs');
const path = require('path');

const PULS_DATA_FILE  = path.join(__dirname, '..', 'puls-data.json');
const TAERSKLER_FILE  = path.join(__dirname, '..', 'puls-udloeb-taerskler.json');

const EXCLUDED_CONFIDENCE = new Set(['low']);

function main() {
  const puls      = JSON.parse(fs.readFileSync(PULS_DATA_FILE, 'utf8'));
  const taerskler = JSON.parse(fs.readFileSync(TAERSKLER_FILE, 'utf8'));

  const thresholdByOutfallId = new Map();
  for (const o of taerskler.outlets) {
    if (EXCLUDED_CONFIDENCE.has(o.confidence)) continue;
    thresholdByOutfallId.set(o.outfallId, o.thresholdMm);
  }

  const rows = puls.d || puls;
  let matched = 0;
  for (const row of rows) {
    const outfallId = row[8];
    const thresholdMm = thresholdByOutfallId.has(outfallId)
      ? thresholdByOutfallId.get(outfallId)
      : null;
    if (thresholdMm !== null) matched++;
    row[13] = thresholdMm;
  }

  fs.writeFileSync(PULS_DATA_FILE, JSON.stringify(puls));
  console.log(`merge-puls-thresholds: ${matched} af ${rows.length} udløb fik en tærskel flettet ind (row[13]).`);
}

main();
