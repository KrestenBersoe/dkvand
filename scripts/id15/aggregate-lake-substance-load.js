#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// aggregate-lake-substance-load.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Aggregerer stofbelastning (COD, BOD, kvælstof, fosfor) og volumen per sø,
// ved at koble id15-lake-matches.json (opstrøms-sporet udløb->sø via
// terrænmodel, se match-lakes-via-id15.js) med de nye stof-felter i
// puls-data.json (kræver at update-puls.js er kørt MED den udvidede
// feltudtrækning — se dens filhoved for array-positioner).
//
// FORBEHOLD, LÆS FØR BRUG:
//   1. Dette er en RÅ SUM, ikke en flow-routet/henfaldsvægtet belastning.
//      travelTimeHours findes per udløb-sø-par i id15-lake-matches.json,
//      men bruges IKKE her — samme τ-henfaldsmodel som risk-model.js
//      allerede bruger til CSO kunne genbruges, men er ikke implementeret.
//   2. Søer der er hydrologisk forbundet via kanal (fx Sortedams Sø Nord/
//      Syd/Peblingesø i København) kan dele samme ID15-opland og dermed
//      samme matchede udløb — hvilket giver IDENTISK sum for flere "søer".
//      Scriptet flagger dette (samme sæt af udløbs-id'er brugt af >1 sø)
//      men LØSER det ikke. Tjek "possiblyConnectedGroups" i outputtet.
//   3. Kun ~14-19% af udløb har "reelle" (kvalitetskode 0) volumendata —
//      resten er verificeret nul, estimeret eller mangler helt. Stof-
//      felterne er formentlig underlagt samme mønster (kør
//      check-stof-coverage.js for at bekræfte). Summerne er derfor
//      MODELESTIMATER, ikke målte belastninger.
//   4. Kun outlets med et ikke-null tal for et givet stof indgår i summen
//      for DET stof — null tælles ikke som 0. "coverage"-feltet viser hvor
//      stor en andel af de matchede udløb der reelt bidrog til hver sum.
//
// Forudsætninger:
//   scripts/id15/id15-lake-matches.json (allerede genereret)
//   puls-data.json i repo-roden, MED de udvidede stof-felter (kør
//   update-puls.js på ny, hvis filen stadig kun har de gamle 13 felter)
//
// Brug:
//   node scripts/id15/aggregate-lake-substance-load.js
//   node scripts/id15/aggregate-lake-substance-load.js --out /sti/til/output.json
//
// Output: lake-substance-load.json i repo-roden (medmindre --out angivet)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

const DIR  = __dirname;                          // scripts/id15
const ROOT = path.join(DIR, '..', '..');         // repo-rod

// RETTET: læste tidligere fra scripts/id15/id15-lake-matches.json, men den
// KANONISKE, deployede version er den kanal-korrigerede kopi i repo-roden
// (skrevet af resolve-canal-ambiguity.py + update-all-data.sh trin 10).
// De to er identiske lige nu, men scripts/id15/-udgaven kan drive ud af sync,
// hvis nogen kører match-lakes-via-id15.js isoleret uden opfølgende
// kanal-korrektion — se update-all-data.sh's egen kommentar om netop dette.
const LAKE_MATCHES_PATH = path.join(ROOT, 'id15-lake-matches.json');
const PULS_PATH         = path.resolve(argVal('--puls-data', path.join(ROOT, 'puls-data.json')));
const OUTPUT_PATH       = path.resolve(argVal('--out', path.join(ROOT, 'lake-substance-load.json')));

// Array-positioner i puls-data.json's 'd'-rækker — skal matche
// update-puls.js's compress()-funktion.
const IDX = {
  vol: 5, ev: 6, quality: 7,
  cod: 13, bod: 14, nitrogen: 15, phosphor: 16,
  normalYear: 17, normalVol: 18, normalEv: 19,
  normalCod: 20, normalBod: 21, normalNitrogen: 22, normalPhosphor: 23,
};

const SUBSTANCE_FIELDS = ['vol', 'cod', 'bod', 'nitrogen', 'phosphor'];
const NORMAL_FIELDS    = ['normalVol', 'normalCod', 'normalBod', 'normalNitrogen', 'normalPhosphor'];

function main() {
  for (const [label, p] of [['id15-lake-matches.json', LAKE_MATCHES_PATH], ['puls-data.json', PULS_PATH]]) {
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${label}: ${p}`);
      process.exit(1);
    }
  }

  const lakeMatches = JSON.parse(fs.readFileSync(LAKE_MATCHES_PATH, 'utf8'));
  const puls        = JSON.parse(fs.readFileSync(PULS_PATH, 'utf8'));
  const rows         = puls.d || [];

  if (rows.length > 0 && rows[0].length <= IDX.phosphor) {
    console.error(`❌ puls-data.json har kun ${rows[0].length} felter — stof-felterne (position ${IDX.cod}+) mangler.`);
    console.error(`   Kør update-puls.js på ny med den udvidede extractPoints()/compress().`);
    process.exit(1);
  }

  console.log(`${Object.keys(lakeMatches).length} søer i id15-lake-matches.json`);
  console.log(`${rows.length.toLocaleString('da')} aktive udløb i puls-data.json\n`);

  const results = {};
  // Til opdagelse af forbundne søer, der deler samme udløbssæt (se forbehold 2)
  const outletSetToLakes = new Map();  // sorteret id-streng -> [sønavne]

  for (const [lakeName, info] of Object.entries(lakeMatches)) {
    const pts = info.pulsPoints || [];
    if (pts.length === 0) continue;

    const outletIds = pts.map(p => p.id).sort((a, b) => a - b);
    const setKey = outletIds.join(',');
    if (!outletSetToLakes.has(setKey)) outletSetToLakes.set(setKey, []);
    outletSetToLakes.get(setKey).push(lakeName);

    const sums     = {};   // felt -> { total, nContributing }
    for (const f of [...SUBSTANCE_FIELDS, ...NORMAL_FIELDS]) sums[f] = { total: 0, nContributing: 0 };

    let nViaOwnCatchment = 0, nViaUpstream = 0;
    let qCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };

    for (const pt of pts) {
      const row = rows[pt.id];
      if (!row) continue;  // udløb ikke længere i puls-data.json (fx nedlagt siden matching)

      if (pt.viaOwnCatchment) nViaOwnCatchment++; else nViaUpstream++;
      const q = row[IDX.quality];
      if (q !== null && q !== undefined && qCounts[q] !== undefined) qCounts[q]++;

      for (const f of SUBSTANCE_FIELDS) {
        const v = row[IDX[f]];
        if (v !== null && v !== undefined) { sums[f].total += v; sums[f].nContributing++; }
      }
      for (const f of NORMAL_FIELDS) {
        const v = row[IDX[f]];
        if (v !== null && v !== undefined) { sums[f].total += v; sums[f].nContributing++; }
      }
    }

    const outletsTotal = pts.length;
    const round = n => Math.round(n * 100) / 100;

    results[lakeName] = {
      outletsMatched: outletsTotal,
      viaOwnCatchment: nViaOwnCatchment,     // usikker kategori — se match-lakes-via-id15.js
      viaUpstream: nViaUpstream,             // sikker kategori (bekræftet højdefald)
      qualityCodeCounts: qCounts,            // 0=reelle 1=verificeret nul 2=estimeret 3=ingen data
      concretYear: {
        volumeM3:   round(sums.vol.total),      volumeCoverage:   `${sums.vol.nContributing}/${outletsTotal}`,
        codKg:      round(sums.cod.total),      codCoverage:      `${sums.cod.nContributing}/${outletsTotal}`,
        bodKg:      round(sums.bod.total),      bodCoverage:      `${sums.bod.nContributing}/${outletsTotal}`,
        nitrogenKg: round(sums.nitrogen.total), nitrogenCoverage: `${sums.nitrogen.nContributing}/${outletsTotal}`,
        phosphorKg: round(sums.phosphor.total), phosphorCoverage: `${sums.phosphor.nContributing}/${outletsTotal}`,
      },
      normalYear: {
        volumeM3:   round(sums.normalVol.total),      volumeCoverage:   `${sums.normalVol.nContributing}/${outletsTotal}`,
        codKg:      round(sums.normalCod.total),      codCoverage:      `${sums.normalCod.nContributing}/${outletsTotal}`,
        bodKg:      round(sums.normalBod.total),      bodCoverage:      `${sums.normalBod.nContributing}/${outletsTotal}`,
        nitrogenKg: round(sums.normalNitrogen.total), nitrogenCoverage: `${sums.normalNitrogen.nContributing}/${outletsTotal}`,
        phosphorKg: round(sums.normalPhosphor.total), phosphorCoverage: `${sums.normalPhosphor.nContributing}/${outletsTotal}`,
      },
    };
  }

  // Grupper søer der deler PRÆCIS samme udløbssæt — sandsynligt tegn på
  // kanalforbundne søer med fælles ID15-opland (se forbehold 2).
  const possiblyConnectedGroups = [...outletSetToLakes.values()].filter(lakes => lakes.length > 1);

  const output = {
    generatedAt: new Date().toISOString(),
    lakeCount: Object.keys(results).length,
    caveat: 'Rå sum af matchede udløb, IKKE flow-routet/henfaldsvægtet. Se scriptets filhoved for fulde forbehold.',
    possiblyConnectedGroups,
    lakes: results,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log(`${Object.keys(results).length} søer med ≥1 matchet udløb aggregeret.`);
  if (possiblyConnectedGroups.length > 0) {
    console.log(`\n⚠ ${possiblyConnectedGroups.length} grupper af søer deler PRÆCIS samme udløbssæt (mulig kanalforbindelse):`);
    possiblyConnectedGroups.forEach(g => console.log(`  - ${g.join(' / ')}`));
  }
  console.log(`\nSkrevet: ${OUTPUT_PATH}`);
}

main();
