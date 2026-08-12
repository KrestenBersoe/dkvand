#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// compute-vandlob-directions.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Beregner strømretning + sikkerhed for hver vandløbslinje ud fra dens to
// endepunkters ID15-delvandopland (se map-vandlob-to-id15.py) og den
// allerede byggede ID15 flow-graf (build-id15-flow-graph.js).
//
// PRINCIP: samme som match-lakes-via-id15.js's opstrøms-sporing, men her
// anvendt direkte på to enkelt-punkter i stedet for et helt opstrøms-træ.
// Det opland, der indeholder linjens ene endepunkt, har en minimumshøjde;
// det andet ligeså. Det opland med LAVEST minimumshøjde er nedstrøms for
// det andet — samme antagelse, samme kilde til usikkerhed (ét enkelt
// minimumstal for et helt kilometerstort opland, ikke selve højden ved
// PRÆCIS linjens endepunkt), og derfor SAMME margen
// (MIN_ELEVATION_MARGIN_M = 1,0 m), fundet og kalibreret ved det reelle
// Furesø/Sjælsø-krydstjek i match-lakes-via-id15.js — genbrugt her uændret
// i stedet for at opfinde en ny, ukalibreret tærskel.
//
// VIGTIGT, EKSPLICIT BEGRÆNSNING (bevidst, ikke en fejl): denne metode
// kræver IKKE at de to oplande er naboer i adjacency-grafen — et fald i
// minimumshøjde er gyldigt uanset hvor mange mellemliggende oplande
// linjen krydser undervejs, siden vand pr. definition løber nedad. Til
// gengæld betyder det at metoden IKKE kan skelne "denne linje løber hele
// vejen fra A til B" fra "denne linje ligger et sted midt i et længere
// forløb, der tilfældigvis starter højere og slutter lavere" — den
// afgør RETNING korrekt, ikke nødvendigvis at netop DENNE linje er hele
// vandløbets fulde længde. Det er tilstrækkeligt til visning af pile på
// selve linjen (formålet her), men bør ikke over-fortolkes som en fuld
// hydrologisk rute-rekonstruktion.
//
// Forudsætninger:
//   vandlob-to-id15.json (fra map-vandlob-to-id15.py)
//   id15-flow-graph.json (fra build-id15-flow-graph.js)
//   id15_adjacency.json (kun records-delen bruges: index -> ID15)
//
// Brug:
//   node compute-vandlob-directions.js
//
// Output: vandlob-directions.json —
//   [{ index: <linjeindeks, matcher vandlob-to-id15.json og vp3_vandlob_raw.geojson>,
//      direction: "AtilB" | "BtilA" | null,   // null = kan ikke afgøres (samme opland/manglende data)
//      confidence: "sikker" | "usikker" }, ...]
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const MIN_ELEVATION_MARGIN_M = 1.0;  // samme, allerede kalibrerede margen som match-lakes-via-id15.js

const DIR = __dirname;
const paths = {
  vandlobToId15: path.join(DIR, 'vandlob-to-id15.json'),
  flowGraph:     path.join(DIR, 'id15-flow-graph.json'),
  output:        path.join(DIR, 'vandlob-directions.json'),
};

function main() {
  for (const [name, p] of Object.entries(paths)) {
    if (name === 'output') continue;
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${p} — kør map-vandlob-to-id15.py og build-id15-flow-graph.js først.`);
      process.exit(1);
    }
  }

  console.log('Indlæser data...');
  const vandlobToId15 = JSON.parse(fs.readFileSync(paths.vandlobToId15, 'utf8'));
  const flowGraph     = JSON.parse(fs.readFileSync(paths.flowGraph, 'utf8'));
  console.log(`  ${vandlobToId15.length} vandløbslinjer, ${Object.keys(flowGraph).length} oplande med højdedata`);

  let sikker = 0, usikkerSammeOpland = 0, usikkerLavMargen = 0, manglendeData = 0;
  const results = [];

  for (const entry of vandlobToId15) {
    const { index, id15A, id15B } = entry;

    if (id15A == null || id15B == null) {
      // Kun ét endepunkt matchede et ID15-opland (typisk en direkte
      // kystudledning) — ingen retning kan udledes fra to punkter, når
      // kun ét findes.
      manglendeData++;
      results.push({ index, direction: null, confidence: 'usikker' });
      continue;
    }

    if (id15A === id15B) {
      // Begge endepunkter i SAMME kilometerstore opland — ID15-niveauets
      // opløsning kan pr. definition ikke sige noget meningsfuldt om
      // retningen for en linje, der ikke krydser en oplandsgrænse.
      usikkerSammeOpland++;
      results.push({ index, direction: null, confidence: 'usikker' });
      continue;
    }

    const elevA = flowGraph[id15A]?.minElev;
    const elevB = flowGraph[id15B]?.minElev;

    if (elevA == null || elevB == null) {
      manglendeData++;
      results.push({ index, direction: null, confidence: 'usikker' });
      continue;
    }

    const diff = elevA - elevB;  // positiv: A højere end B => B er nedstrøms (retning A->B)
    if (Math.abs(diff) <= MIN_ELEVATION_MARGIN_M) {
      // Højdeforskellen er inden for den kendte usikkerhedsmargen for
      // denne metode — viser stadig en retning (den bedste tilgængelige
      // gætning), men markeret usikker, IKKE udeladt. Brugeren bad
      // eksplicit om at se USIKRE retninger, blot farvet anderledes, ikke
      // om at få dem skjult.
      usikkerLavMargen++;
      results.push({ index, direction: diff >= 0 ? 'AtilB' : 'BtilA', confidence: 'usikker' });
      continue;
    }

    sikker++;
    results.push({ index, direction: diff > 0 ? 'AtilB' : 'BtilA', confidence: 'sikker' });
  }

  console.log(`\nSikker retning (>${MIN_ELEVATION_MARGIN_M}m højdeforskel): ${sikker}`);
  console.log(`Usikker — højdeforskel under margen: ${usikkerLavMargen}`);
  console.log(`Usikker — begge endepunkter i samme opland: ${usikkerSammeOpland}`);
  console.log(`Usikker — manglende data (kun ét endepunkt matchet, eller intet højdedata): ${manglendeData}`);
  console.log(`I alt: ${results.length}`);

  fs.writeFileSync(paths.output, JSON.stringify(results));
  console.log(`\nSkrevet ${paths.output}`);
}

main();
