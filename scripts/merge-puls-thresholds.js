#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// merge-puls-thresholds.js — kør fra repo-roden:
//   node scripts/merge-puls-thresholds.js
// (kræver puls-data.json og puls-udloeb-taerskler.json, se
//  scripts/compute-puls-udloeb-taerskler.js, som skal køres først)
//
// Fletter den udløbs-specifikke empiriske nedbørstærskel
// (puls-udloeb-taerskler.json) ind i puls-data.json som et nyt, bagestillet
// felt — samme mønster som outfallId/reducedArea/type/sewerStructure/
// latestDischargeYear allerede blev tilføjet på (se update-puls.js's eget
// filhoved). risk-model.js læser feltet eksplicit.
//
// RETTET (2026-08-20 — kritisk databug, bruger-rapporteret): skrev
// OPRINDELIGT til row[13] — men update-puls.js udvidede SENERE (samme
// fils "2. runde"-kommentar) skemaet med cod/bod/nitrogen/fosfor/
// normalårs-feltsættet, som OGSÅ lægger sig ved position 13 og fremefter,
// uden at denne fil blev opdateret til at flytte sig. Resultat: for de
// udløb, der IKKE fik et tærskel-match (row[13]=null-grenen nedenfor blev
// aldrig ramt), stod update-puls.js's cod-værdi uændret tilbage på
// position 13 — og risk-model.js's derivePulsFields() læste den stille som
// en regntærskel i mm. For de udløb, der DID få et match, blev cod
// omvendt overskrevet og tabt. Skriver nu til row[24] i stedet (efter hele
// normalårs-feltsættet, position 17-23) — en position INGEN anden fil
// nogensinde skriver til.
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
// IDEMPOTENT: sætter row[24] eksplicit på HVER kørsel (nummer eller null),
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
    row[24] = thresholdMm;
  }

  fs.writeFileSync(PULS_DATA_FILE, JSON.stringify(puls));
  console.log(`merge-puls-thresholds: ${matched} af ${rows.length} udløb fik en tærskel flettet ind (row[24]).`);
}

main();
