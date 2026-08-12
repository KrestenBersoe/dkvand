// diagnose-puls-taerskler.js — kør fra repo-roden: node scripts/diagnose-puls-taerskler.js
//
// Stikprøvetjek af puls-udloeb-taerskler.json mod 5 konkret navngivne,
// levende PULS-udløb (bekræftet eksisterende via direkte WFS-opslag under
// udviklingen af compute-puls-udloeb-taerskler.js) — dækker begge kilder
// (udledt/lånt), begge tillidsgrad-yderpunkter og et eksplicit udeladt
// udløb, så man IKKE kun ser de "pæne" tilfælde. Ren rapportering, ingen
// påstande der ikke er verificeret mod selve outputfilen.

'use strict';
const fs   = require('fs');
const path = require('path');

const STATIC_DIR   = path.join(__dirname, '..');
const OUTPUT_FILE  = path.join(STATIC_DIR, 'puls-udloeb-taerskler.json');

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch(e) { console.warn(`Kunne ikke læse ${p}: ${e.message}`); return null; }
}

const data = loadJson(OUTPUT_FILE);
if (!data) {
  console.error('Ingen puls-udloeb-taerskler.json fundet — kør scripts/compute-puls-udloeb-taerskler.js først.');
  process.exit(1);
}

const outletsById = new Map(data.outlets.map(o => [o.outfallId, o]));

// VIGTIGT: opslag sker på outfallId, IKKE navn. Navnet "U47" viste sig ved
// første kørsel af dette script rent faktisk at tilhøre TO FORSKELLIGE
// udløb i datasættet (kollision, præcis den risiko update-puls.js' egen
// kommentar advarer om) — et navnebaseret Map ville have vist det forkerte
// udløb, stille og uden fejl. outfallId'erne herunder er bekræftet direkte
// mod WFS-kilden (puls:Regnbetingedeudloeb) under udviklingen.
const KNOWN = {
  U47_LEJRE:     '002a4cef-e018-4cf8-bfe4-de555113439b',
  KC00000_KOLDING: '0043e48e-3ef9-4e9f-9cce-f90560a589b6',
  '501035U_SKIVE': '004cb38d-2047-414b-8d78-61994e28946f',
};

console.log('═══════════════════════════════════════════════');
console.log('Stikprøvetjek: PULS-udløb nedbørstærskler');
console.log('═══════════════════════════════════════════════\n');

// ── 1. U47 (Lejre) — lille reduceret areal, meget hyppige overløb ──────────
console.log('── U47 (Lejre kommune) — lille areal, høj hændelsesfrekvens ──');
{
  const o = outletsById.get(KNOWN.U47_LEJRE);
  if (!o) console.log('  IKKE FUNDET i output.');
  else {
    console.log(`  Kilde: ${o.source}, tillidsgrad: ${o.confidence}`);
    console.log(`  Reduceret areal: ${o.reducedArea} ha, type: "${o.type}"`);
    console.log(`  Hændelser brugt: ${o.eventsUsed} (fra rapporteret år), år brugt til gennemsnit: ${o.yearsUsed.join(', ')}`);
    console.log(`  Udledt tærskel: ${o.thresholdMm} mm akkumuleret nedbør`);
    console.log(`  Forventning: lille areal (1,1 ha) + 101 hændelser/år -> forholdsvis LAV tærskel (overløber let/ofte).`);
    console.log(`  ${o.thresholdMm < 25 ? 'OK — stemmer med forventningen.' : 'UVENTET — tærsklen er højere end forventet for et lille, hyppigt overløbende areal.'}`);
  }
}

// ── 2. KC00000 (Kolding) — stort areal, bassin, sjældnere overløb ─────────
console.log('\n── KC00000 (Kolding kommune) — stort areal, bassin, lav hændelsesfrekvens ──');
{
  const o = outletsById.get(KNOWN.KC00000_KOLDING);
  if (!o) console.log('  IKKE FUNDET i output.');
  else {
    console.log(`  Kilde: ${o.source}, tillidsgrad: ${o.confidence}`);
    console.log(`  Reduceret areal: ${o.reducedArea} ha, type: "${o.type}"`);
    console.log(`  Hændelser brugt: ${o.eventsUsed}, år brugt: ${o.yearsUsed.join(', ')}`);
    console.log(`  Udledt tærskel: ${o.thresholdMm} mm`);
    console.log(`  Forventning: stort areal (20,07 ha) MED bassin + kun 13 hændelser/år -> forholdsvis HØJ tærskel (bassinet skal fyldes først).`);
    console.log(`  ${o.thresholdMm > 20 ? 'OK — stemmer med forventningen.' : 'UVENTET — tærsklen er lavere end forventet for et stort, bassinforsynet areal.'}`);
  }
}

// ── 3. 501035U (Skive) — grænsetilfælde for lav tillidsgrad (N=4) ─────────
console.log('\n── 501035U (Skive kommune) — grænsetilfælde, kun 4 hændelser/år ──');
{
  const o = outletsById.get(KNOWN['501035U_SKIVE']);
  if (!o) console.log('  IKKE FUNDET i output.');
  else {
    console.log(`  Kilde: ${o.source}, tillidsgrad: ${o.confidence}`);
    console.log(`  Hændelser brugt: ${o.eventsUsed} (lige inden for 3-4-intervallet for LAV tillidsgrad)`);
    console.log(`  Udledt tærskel: ${o.thresholdMm} mm`);
    console.log(`  ${o.confidence === 'low' ? 'OK — korrekt klassificeret som lav tillidsgrad.' : `UVENTET — forventede 'low', fik '${o.confidence}'.`}`);
  }
}

// ── 4. Et eksplicit udeladt udløb (< 3 hændelser) ──────────────────────────
console.log('\n── Et eksplicit udeladt udløb (for få hændelser, N<3) ──');
{
  const excludedSample = data.meta.excludedOutlets.find(e => e.reason === 'for_faa_haendelser');
  if (!excludedSample) console.log('  Ingen udeladte udløb med denne årsag fundet (uventet, tjek datasættet).');
  else {
    console.log(`  Udløb: "${excludedSample.name}" (${excludedSample.outfallId})`);
    console.log(`  Årsag: ${excludedSample.reason} (eventsYear=${excludedSample.eventsYear})`);
    const inOutput = outletsById.get(excludedSample.outfallId);
    console.log(`  ${inOutput ? 'FEJL — udløbet optræder BÅDE som udeladt OG i outletlisten.' : 'OK — udløbet optræder korrekt IKKE i selve outlet-listen.'}`);
  }
}

// ── 5. Et lånt (gruppe 2) udløb med sporbare donorer ──────────────────────
console.log('\n── Et lånt udløb (gruppe 2) — tjek donor-sporbarhed ──');
{
  const borrowed = data.outlets.find(o => o.source === 'borrowed' && o.donorOutletIds && o.donorOutletIds.length > 0);
  if (!borrowed) console.log('  Intet lånt udløb med donorer fundet.');
  else {
    console.log(`  Udløb: "${borrowed.name}", reduceret areal: ${borrowed.reducedArea} ha`);
    console.log(`  Lånt tærskel: ${borrowed.thresholdMm} mm, fra ${borrowed.donorOutletIds.length} donor-udløb`);
    const donorsById = new Map(data.outlets.filter(o => o.source === 'derived').map(o => [o.outfallId, o]));
    let allDonorsFound = true;
    for (const id of borrowed.donorOutletIds) {
      const donor = donorsById.get(id);
      if (!donor) { allDonorsFound = false; console.log(`    Donor ${id}: IKKE FUNDET blandt de udledte udløb.`); continue; }
      console.log(`    Donor "${donor.name}": areal ${donor.reducedArea} ha (differens ${Math.abs(donor.reducedArea - borrowed.reducedArea).toFixed(2)} ha), tærskel ${donor.thresholdMm} mm`);
    }
    console.log(`  ${allDonorsFound ? 'OK — alle donorer er sporbare tilbage til reelt udledte gruppe-1-tærskler.' : 'FEJL — mindst én donor kunne ikke spores.'}`);
  }
}

// ── Konklusion ──────────────────────────────────────────────────────────
console.log('\n── Konklusion ──');
console.log(`Datasæt: ${data.outlets.length} udløb med tærskel (${data.outlets.filter(o=>o.source==='derived').length} udledt, ${data.outlets.filter(o=>o.source==='borrowed').length} lånt), ${data.meta.excludedOutlets.length} eksplicit udeladt.`);
console.log(`Lånevalidering (den ærlige måling): median ${data.meta.validation.lendingValidation.medianAbsPctDeviation}% afvigelse (n=${data.meta.validation.lendingValidation.n}).`);
console.log('Gennemgå ovenstående "UVENTET"/"FEJL"-markeringer manuelt, hvis nogen er vist, før datasættet tages i brug.');
