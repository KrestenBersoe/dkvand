#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// build-rbu-lake-links.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Udtrækker de OFFICIELLE, myndighedsfastsatte recipient-koblinger mellem
// PULS-udløb og søer fra VP3's RBU-lag (vp3_rbu_raw.geojson, hentet af
// fetch-vp3-all.js). Feltet `forb_id` (udfyldt for kun ~1% af punkterne)
// indeholder søens `ov_id` direkte, når myndigheden har fastsat den
// officielle recipient — 100% bekræftet nøjagtig ved krydstjek mod
// søer-laget (63/63 matchede et reelt ov_id).
//
// Dette er den MEST pålidelige kilde vi har til søers recipient-kobling —
// mere pålidelig end navnematch (kan fejlmatche) og terræn-catchment
// (afhænger af DHM-datas opløsning, som er strukturelt "blind" i fladt
// terræn). Til gengæld dækker den kun en lille brøkdel af søerne (~60 ud af
// 985) — den er et supplement til, ikke en erstatning for, de øvrige
// metoder i colorSoeerByRisk().
//
// Brug:
//   node build-rbu-lake-links.js
//   (forventer vp3_rbu_raw.geojson og vp3_soeer_raw.geojson i SAMME MAPPE
//   som scriptet selv — brug --rbu-path/--soeer-path/--out til at pege
//   andre steder hen, hvis dine filer ligger et andet sted)
//
// Output: rbu-lake-links.json — { [pulsUdloebsnavn_lowercase]: soeOvNavn }
// Lille fil (under 100 punkter), tænkt til at blive fetchet direkte af
// frontend ved siden af puls-data.json og vp3_soeer.geojson.

'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

// RETTET: antog tidligere at scriptet lå to mapper nede (fx
// scripts/catchment/), og gik derfor to niveauer op for at finde
// datafilerne — men fejlede da scriptet i praksis blev lagt direkte i
// projektroden. Bruger nu scriptets EGEN mappe som standard i stedet for
// at gætte på mappedybden, plus flag til at pege andre steder hen hvis
// dine filer ligger et tredje sted.
//   node build-rbu-lake-links.js --rbu-path /sti/til/vp3_rbu_raw.geojson --soeer-path /sti/til/vp3_soeer_raw.geojson --out /sti/til/rbu-lake-links.json
const RBU_PATH = path.resolve(argVal('--rbu-path', path.join(__dirname, 'vp3_rbu_raw.geojson')));
const SOEER_PATH = path.resolve(argVal('--soeer-path', path.join(__dirname, 'vp3_soeer_raw.geojson')));
const OUTPUT_PATH = path.resolve(argVal('--out', path.join(__dirname, 'rbu-lake-links.json')));

function main() {
  console.log('Indlæser VP3 RBU og søer...');
  console.log(`  RBU:   ${RBU_PATH}`);
  console.log(`  Søer:  ${SOEER_PATH}`);
  for (const [navn, p] of [['RBU-fil', RBU_PATH], ['Søer-fil', SOEER_PATH]]) {
    if (!fs.existsSync(p)) {
      console.error(`\n❌ ${navn} findes ikke: ${p}`);
      console.error(`   Angiv korrekt sti med ${navn === 'RBU-fil' ? '--rbu-path' : '--soeer-path'} <sti>, eller læg filen i samme mappe som scriptet.`);
      process.exit(1);
    }
  }
  const rbu = JSON.parse(fs.readFileSync(RBU_PATH, 'utf8'));
  const soeer = JSON.parse(fs.readFileSync(SOEER_PATH, 'utf8'));

  const soeIdToNavn = new Map();
  for (const f of soeer.features) {
    const id = f.properties?.ov_id;
    const navn = f.properties?.ov_navn;
    if (id && navn) soeIdToNavn.set(id, navn);
  }
  console.log(`${soeIdToNavn.size} søer indlæst fra søer-laget.`);

  const lakeLinks = new Map(); // pkt_navn (lowercase) -> { navn, ov_id, sourcePktNavn }
  let totalRbu = 0, withForbId = 0, lakeMedie = 0, matchedToSoe = 0, duplicateConflicts = 0;

  for (const f of rbu.features) {
    totalRbu++;
    const props = f.properties || {};
    const forbMedie = props.forb_medie;
    const forbId = props.forb_id;
    const pktNavn = props.pkt_navn;

    if (!forbId) continue;
    withForbId++;
    if (forbMedie !== 'SWB' || !String(forbId).startsWith('DKLAKE')) continue;
    lakeMedie++;

    const soeNavn = soeIdToNavn.get(forbId);
    if (!soeNavn) {
      console.warn(`  ⚠ forb_id "${forbId}" (RBU "${pktNavn}") findes ikke i søer-laget — springer over`);
      continue;
    }
    matchedToSoe++;

    if (!pktNavn) continue;
    const key = String(pktNavn).toLowerCase();
    if (lakeLinks.has(key) && lakeLinks.get(key).ov_id !== forbId) {
      // Sanity-tjek: samme udløbsnavn koblet til to FORSKELLIGE søer ville
      // være en datakvalitetskonflikt, ikke bare en almindelig duplet
      // (samme navn, samme sø kan forekomme flere gange i RBU-datasættet
      // uden problem — kun konflikt hvis søen er forskellig).
      console.warn(`  ⚠ Konflikt: "${pktNavn}" koblet til både "${lakeLinks.get(key).navn}" og "${soeNavn}" — springer over (for usikkert)`);
      duplicateConflicts++;
      lakeLinks.delete(key);
      continue;
    }
    lakeLinks.set(key, { navn: soeNavn, ov_id: forbId, sourcePktNavn: pktNavn });
  }

  console.log(`\nRBU-punkter i alt: ${totalRbu}`);
  console.log(`Med udfyldt forb_id: ${withForbId}`);
  console.log(`Med sø-recipient (forb_medie=SWB, forb_id starter DKLAKE): ${lakeMedie}`);
  console.log(`Matchet til et reelt ov_id i søer-laget: ${matchedToSoe}`);
  console.log(`Konflikter sprunget over: ${duplicateConflicts}`);
  console.log(`Endeligt antal unikke, bekræftede udløb->sø-koblinger: ${lakeLinks.size}`);

  const output = {};
  for (const [key, { navn }] of lakeLinks) output[key] = navn;

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSkrevet til ${OUTPUT_PATH}`);
}

main();
