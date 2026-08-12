#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-stof-coverage.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Rapporterer dækningsgrad for de nye stof-felter (COD/BOD/kvælstof/fosfor,
// konkretår + normalår) i puls-data.json, EFTER update-puls.js er kørt med
// den udvidede feltudtrækning. Kør dette FØR I bygger videre på
// sø-belastningsaggregering (aggregate-lake-substance-load.js) — hvis
// dækningen er for lav til at være meningsfuld, er det bedre at vide det nu.
//
// Array-positioner (skal matche update-puls.js's compress()-funktion,
// se dens filhoved):
//   0=lat 1=lng 2=navn 3=aIdx 4=wIdx 5=vol 6=ev 7=q
//   8=outfallId 9=reducedArea 10=type 11=sewerStructure 12=latestDischargeYear
//   13=cod 14=bod 15=nitrogen 16=phosphor
//   17=normalYear 18=normalVol 19=normalEv 20=normalCod 21=normalBod
//   22=normalNitrogen 23=normalPhosphor
//
// Brug:
//   node scripts/check-stof-coverage.js [--puls-data ./puls-data.json]
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

const ROOT      = path.join(__dirname, '..');
const PULS_PATH = path.resolve(argVal('--puls-data', path.join(ROOT, 'puls-data.json')));

const IDX = {
  cod: 13, bod: 14, nitrogen: 15, phosphor: 16,
  normalYear: 17, normalVol: 18, normalEv: 19,
  normalCod: 20, normalBod: 21, normalNitrogen: 22, normalPhosphor: 23,
};

function pct(n, total) {
  return total === 0 ? '0.0' : (100 * n / total).toFixed(1);
}

function main() {
  if (!fs.existsSync(PULS_PATH)) {
    console.error(`❌ Findes ikke: ${PULS_PATH}`);
    console.error(`   Kør update-puls.js først (med den udvidede feltudtrækning).`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(PULS_PATH, 'utf8'));
  const rows = data.d || [];
  const total = rows.length;

  if (total === 0) {
    console.error('❌ Ingen rækker i puls-data.json — noget er galt.');
    process.exit(1);
  }

  if (rows[0].length <= IDX.phosphor) {
    console.error(`❌ Rækkerne har kun ${rows[0].length} felter — de nye stof-felter (position ${IDX.cod}+)`);
    console.error(`   findes ikke endnu. Kør update-puls.js med den udvidede extractPoints()/compress() først.`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('Stofdata-dækningstjek');
  console.log(`Datakilde: ${PULS_PATH}`);
  console.log(`Aktive udløb i alt: ${total.toLocaleString('da')}`);
  console.log('═══════════════════════════════════════════════\n');

  // ── Konkretår ────────────────────────────────────────────────────────────
  console.log('KONKRETÅR (seneste indberettede år, varierer pr. udløb):');
  for (const field of ['cod', 'bod', 'nitrogen', 'phosphor']) {
    const nonNull = rows.filter(r => r[IDX[field]] !== null && r[IDX[field]] !== undefined).length;
    console.log(`  ${field.padEnd(10)}: ${nonNull.toLocaleString('da').padStart(7)} / ${total.toLocaleString('da')}  (${pct(nonNull, total)}%)`);
  }

  // ── Normalår ─────────────────────────────────────────────────────────────
  console.log('\nNORMALÅR (MST-beregnet gennemsnit, 10-30 års nedbørsdata):');
  for (const field of ['normalCod', 'normalBod', 'normalNitrogen', 'normalPhosphor']) {
    const nonNull = rows.filter(r => r[IDX[field]] !== null && r[IDX[field]] !== undefined).length;
    console.log(`  ${field.padEnd(16)}: ${nonNull.toLocaleString('da').padStart(7)} / ${total.toLocaleString('da')}  (${pct(nonNull, total)}%)`);
  }

  // ── Krydstjek: kun udløb med volumen (kvalitetskode 0/2) har vel stofdata? ──
  const qIdx = 7;
  const withVol = rows.filter(r => r[qIdx] === 0 || r[qIdx] === 2);
  const withVolAndCod = withVol.filter(r => r[IDX.cod] !== null && r[IDX.cod] !== undefined);
  console.log('\nKRYDSTJEK — stofdata blandt udløb der HAR volumen (q=0 eller q=2):');
  console.log(`  Udløb med volumendata: ${withVol.length.toLocaleString('da')}`);
  console.log(`  ...heraf med COD:      ${withVolAndCod.length.toLocaleString('da')} (${pct(withVolAndCod.length, withVol.length)}%)`);

  // ── Alle fire stoffer samtidig (mest restriktive, mest brugbare delmængde) ──
  const allFour = rows.filter(r =>
    r[IDX.cod] !== null && r[IDX.bod] !== null &&
    r[IDX.nitrogen] !== null && r[IDX.phosphor] !== null
  ).length;
  console.log(`\nUdløb med ALLE FIRE stoffer samtidig (konkretår): ${allFour.toLocaleString('da')} (${pct(allFour, total)}%)`);

  console.log('\n─────────────────────────────────────────────────');
  console.log('Fortolkning: hvis dækningen ligner vol/ev-mønsteret (~85% har');
  console.log('volumen, men kun ~14% er "reelle data" jf. kvalitetskoden), er');
  console.log('stoffelterne formentlig underlagt samme rapporteringshuller.');
  console.log('Tjek IKKE kun procenttal — luk enkelte rækker op manuelt og se');
  console.log('om værdierne virker plausible (fx N/P-forhold, COD > BOD).');
}

main();
