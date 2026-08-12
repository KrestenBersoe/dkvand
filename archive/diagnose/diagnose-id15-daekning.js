// ═══════════════════════════════════════════════════════════════════════════
// diagnose-id15-daekning.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
// Afgør: dækker id15-lake-matches.json ALLE søer i vp3_soeer.geojson (med
// eksplicit pulsPoints:[] for dem uden fund — en ægte "undersøgt og tom"-
// bekræftelse), eller optræder kun et udsnit af søerne overhovedet i filen
// (i så fald kan "sø mangler i filen" IKKE bruges som bekræftelse på noget —
// det betyder blot "aldrig behandlet", ikke "behandlet og fundet tom").
'use strict';
const fs = require('fs');
const path = require('path');
const STATIC_DIR = __dirname;

const soeerGeojson = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'vp3_soeer.geojson'), 'utf8'));
const id15 = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'id15-lake-matches.json'), 'utf8'));

const alleSoeNavne = new Set();
for (const f of soeerGeojson.features || []) {
  const navn = f.properties?.ov_navn || f.properties?.navn;
  if (navn) alleSoeNavne.add(navn);
}

let findes_med_indhold = 0;      // navn findes i filen, pulsPoints har elementer
let findes_eksplicit_tom = 0;    // navn findes i filen, pulsPoints er et TOMT array
let findes_men_uden_pulsPoints_felt = 0; // navn findes, men intet pulsPoints-felt overhovedet
let findes_slet_ikke = 0;        // navn findes IKKE som nøgle i filen overhovedet

const eksempler_eksplicit_tom = [];
const eksempler_slet_ikke = [];

for (const navn of alleSoeNavne) {
  if (!(navn in id15)) {
    findes_slet_ikke++;
    if (eksempler_slet_ikke.length < 5) eksempler_slet_ikke.push(navn);
    continue;
  }
  const entry = id15[navn];
  if (!('pulsPoints' in entry)) { findes_men_uden_pulsPoints_felt++; continue; }
  if (Array.isArray(entry.pulsPoints) && entry.pulsPoints.length === 0) {
    findes_eksplicit_tom++;
    if (eksempler_eksplicit_tom.length < 5) eksempler_eksplicit_tom.push(navn);
  } else if (Array.isArray(entry.pulsPoints) && entry.pulsPoints.length > 0) {
    findes_med_indhold++;
  }
}

console.log(`${alleSoeNavne.size} søer i alt i vp3_soeer.geojson.\n`);
console.log(`Findes i id15-lake-matches.json MED mindst ét pulsPoint:     ${findes_med_indhold}`);
console.log(`Findes i id15-lake-matches.json med EKSPLICIT TOM liste:     ${findes_eksplicit_tom}`);
console.log(`Findes i filen, men uden noget pulsPoints-felt overhovedet:  ${findes_men_uden_pulsPoints_felt}`);
console.log(`Findes SLET IKKE som nøgle i filen:                          ${findes_slet_ikke}`);
console.log('');

if (eksempler_eksplicit_tom.length) {
  console.log('Eksempler på "eksplicit tom" (ægte bekræftelse, hvis dette tal er stort):');
  eksempler_eksplicit_tom.forEach(n => console.log('  ' + n));
  console.log('');
}
if (eksempler_slet_ikke.length) {
  console.log('Eksempler på "findes slet ikke" (IKKE en bekræftelse — betyder "aldrig behandlet"):');
  eksempler_slet_ikke.forEach(n => console.log('  ' + n));
  console.log('');
}

console.log('── Konklusion ──');
if (findes_eksplicit_tom > 0 && findes_slet_ikke === 0) {
  console.log('Filen dækker ALLE søer med eksplicit tomt/ikke-tomt resultat. "Eksplicit tom" kan trygt bruges som ægte bekræftelse på ingen udledningsforbindelse.');
} else if (findes_eksplicit_tom > 0 && findes_slet_ikke > 0) {
  console.log('Filen har BEGGE tilstande. Kun "eksplicit tom" (pulsPoints:[]) er en ægte bekræftelse — søer der slet ikke findes i filen må IKKE tolkes som bekræftet risikofrie.');
} else if (findes_eksplicit_tom === 0 && findes_slet_ikke > 0) {
  console.log('Filen skelner IKKE — den indeholder kun søer med reelle fund, aldrig eksplicit tomme resultater. "Manglende nøgle" kan IKKE bruges som bekræftelse af nogen art. En automatisk kategori kan ikke bygges sikkert på denne fil alene.');
}
