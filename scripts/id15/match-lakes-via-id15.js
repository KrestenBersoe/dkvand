#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// match-lakes-via-id15.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Sidste trin i ID15-baseret opstrøms-matching. Forudsætter at følgende er
// kørt/genereret først:
//   1. Python-forbehandling: id15-polygons.json (adjacency + WKT-geometri),
//      soe-to-id15.json (sø -> ID15), puls-to-id15.json (PULS-punkt -> ID15)
//   2. build-id15-flow-graph.js: id15-flow-graph.json (minimumshøjde pr. ID15)
//
// Bygger en rettet graf: hvert ID15-opland peger på ALLE naboer, der er
// reelt lavere (en DAG, ikke et træ — se begrundelse ved downstream-
// grafen nedenfor). Sporer derefter opstrøms fra hver sø gennem grafen og
// matcher PULS-udløb hvis ID15-opland ligger i den opstrøms-forbundne
// mængde.
//
// RETTET (fuldt omskrevet — tekstmatch/manuel undtagelsesliste fjernet
// helt, efter eksplicit tilbagemelding): et konkret, bekræftet tilfælde
// (Farum Sø/Furesø, forbundet af en kort kanal) viste at problemets rod
// ikke er tekstlig, men RETNINGSMÆSSIG — et udløb i selve kanalen mellem
// to søer kan falde inden for DEN ENE søs kilometerstore ID15-opland,
// selvom den fysiske strømretning reelt går til den ANDEN, nedstrøms sø.
// Et forsøg på at rette dette via PULS' eget waterArea-tekstfelt løste
// det bekræftede tilfælde delvist, men var i sagens natur ufuldstændigt
// (et udløb hvis waterArea kun navngiver et mindre, mellemliggende
// vandløb — ikke den endelige sø — kan aldrig fanges af tekstmatch,
// uanset hvor godt formuleret matchen er) og krævede i praksis en
// voksende, manuelt vedligeholdt undtagelsesliste for hvert nyt tilfælde.
//
// Denne fil markerer i stedet, for hvert matchet udløb, PRÆCIS hvordan det
// blev fundet: "viaOwnCatchment: true" betyder udløbet blot geografisk
// falder i søens EGET startopland (den usikre kategori — her kan
// kanaltilfælde som Farum Sø/Furesø opstå), "viaOwnCatchment: false"
// betyder det blev fundet via reel opstrøms-sporing gennem naboer, med
// bekræftet højdefald hele vejen (den sikre kategori). Selve
// GEOMETRISKE opløsningen af den usikre kategori — er udløbet fysisk
// tættere på en nedstrøms nabosø end på denne sø selv? — sker i et
// SEPARAT, efterfølgende Python-script (resolve-canal-ambiguity.py), der
// bruger shapely til korrekt punkt-til-polygon-afstand, i stedet for
// tekstmatch. Se dén fils hoved for selve opløsningslogikken.
//
// Brug:
//   node match-lakes-via-id15.js
//
// Output: id15-lake-matches.json — { [soeNavn]: { id15: number,
//   mstId: number[]|null, mstIdAmbiguous: boolean, upstreamId15Count: number,
//   pulsPoints: [{id, travelTimeHours, viaOwnCatchment}], stoppedAtLakes: [...] } }
//
// NYT: mstId/mstIdAmbiguous — se soe-name-to-mstid.json (produceret af
// build-id15-geometry.py). Løser IKKE tvetydigheden for de ~10 delte
// sonavne (find_containing_id15 vælger stadig geometrisk, uafhængigt af
// dette), men GØR den synlig for downstream-forbrugere i stedet for
// stiltiende at antage navnet er entydigt.
//
// EFTERFØLGENDE TRIN (påkrævet for korrekt kanal-opløsning):
//   python3 resolve-canal-ambiguity.py

'use strict';

const fs = require('fs');
const path = require('path');

// RETTET (fundet ved Furesø-krydstjek, tredje runde): selv efter de to
// forrige rettelser (flere samtidige tilløb tilladt; sporing stopper ved
// andre søer) viste et par PULS-punkter mærket "Kajerød Å, Sjælsø" sig
// stadig at blive tilskrevet Furesø. Årsagen: det opland, de ligger i,
// grænser op til BÅDE Sjælsø (minhøjde 18,2m) OG Furesø (minhøjde 15,52m)
// — og dets egen minimumshøjde er 18,3m. Forskellen til Sjælsø er kun
// 0,1m: inden for støjmarginen for denne metode (ét minimumstal for et
// helt kilometerstort opland, ikke den faktiske højde ved selve
// grænsefladen mellem to naboer). 18,2% af alle kanter i grafen har under
// 1m forskel. MIN_ELEVATION_MARGIN_M filtrerer disse fra — en nabo tæller
// kun som reelt "nedstrøms", hvis forskellen er meningsfuldt større end
// den sandsynlige usikkerhed i data, ikke bare teknisk lavere.
const MIN_ELEVATION_MARGIN_M = 1.0;

const DIR = __dirname;
const paths = {
  polygons: path.join(DIR, 'id15-polygons.json'),
  flowGraph: path.join(DIR, 'id15-flow-graph.json'),
  soeToId15: path.join(DIR, 'soe-to-id15.json'),
  soeNameToMstId: path.join(DIR, 'soe-name-to-mstid.json'),   // NYT, valgfri
  pulsToId15: path.join(DIR, 'puls-to-id15.json'),
  travelTimes: path.join(DIR, 'id15-travel-times.json'),
  output: path.join(DIR, 'id15-lake-matches.json'),
};

function main() {
  console.log('Indlæser data...');
  // NYT: soeNameToMstId er VALGFRI — findes kun hvis build-id15-geometry.py
  // er kørt igen efter tilføjelsen af mst_id-sporingen. Ældre kørsler af
  // hele ID15-pipelinen (før denne rettelse) har filen ikke, og skal
  // stadig kunne producere id15-lake-matches.json, blot uden mstId-feltet.
  for (const [name, p] of Object.entries(paths)) {
    if (name === 'output' || name === 'soeNameToMstId') continue;
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${p} — kør forbehandlingstrinnene først (se filhoved).`);
      process.exit(1);
    }
  }

  const polygons = JSON.parse(fs.readFileSync(paths.polygons, 'utf8'));
  const flowGraph = JSON.parse(fs.readFileSync(paths.flowGraph, 'utf8'));
  const soeToId15 = JSON.parse(fs.readFileSync(paths.soeToId15, 'utf8'));
  const pulsToId15 = JSON.parse(fs.readFileSync(paths.pulsToId15, 'utf8'));

  let soeNameToMstId = {};
  if (fs.existsSync(paths.soeNameToMstId)) {
    soeNameToMstId = JSON.parse(fs.readFileSync(paths.soeNameToMstId, 'utf8'));
  } else {
    console.warn(`⚠ ${paths.soeNameToMstId} ikke fundet — id15-lake-matches.json skrives UDEN mstId-felt. Kør build-id15-geometry.py på ny (kun det lokale geometri-trin, IKKE hele setup-id15-terrain-model.sh) for at få det med.`);
  }

  console.log(`${polygons.length} ID15-polygoner, ${Object.keys(flowGraph).length} med højdedata, ` +
    `${Object.keys(soeToId15).length} søer, ${Object.keys(pulsToId15).length} PULS-punkter.`);

  // ── Byg rettet downstream-graf ──────────────────────────────────────────
  // RETTET (fundet ved Furesø-krydstjek mod kendt navnematch-data): den
  // oprindelige version lod hvert opland pege på KUN sin ene stejleste
  // nedadgående nabo (en streng træstruktur). For søer med mange reelle
  // tilløbsretninger — som Furesø, der har 13 nabo-oplande — betød det at
  // langt de fleste naboer aldrig blev valgt som "flyder hertil", selvom
  // de fysisk grænser op til søens opland. Løsningen er en mere permissiv
  // graf: hvert opland peger nu på ALLE naboer der er reelt lavere (en
  // DAG, ikke et træ) — stadig filtreret på ægte højdeforskel, blot uden
  // kravet om at vælge kun ÉN.
  const downstream = {}; // id15 -> [id15, ...] (kan nu være flere)
  let noElevData = 0, noDownstream = 0;

  for (const poly of polygons) {
    const own = flowGraph[poly.id15];
    if (!own || own.minElev == null) { noElevData++; continue; }

    const targets = [];
    for (const neighborIdx of poly.neighbors) {
      const neighborPoly = polygons[neighborIdx];
      const neighborData = flowGraph[neighborPoly.id15];
      if (!neighborData || neighborData.minElev == null) continue;
      if (own.minElev - neighborData.minElev >= MIN_ELEVATION_MARGIN_M) targets.push(neighborPoly.id15);
    }
    downstream[poly.id15] = targets;
    if (targets.length === 0) noDownstream++;
  }

  console.log(`\nDownstream-graf bygget: ${Object.keys(downstream).length} opland behandlet, ` +
    `${noElevData} uden højdedata, ${noDownstream} uden nogen nedadgående nabo (terminale oplande).`);

  // ── Byg omvendt (upstream) opslag til BFS ──────────────────────────────
  const upstream = {}; // id15 -> [id15, ...] der peger PÅ dette opland
  for (const [id15, targets] of Object.entries(downstream)) {
    for (const target of targets) {
      if (!upstream[target]) upstream[target] = [];
      upstream[target].push(Number(id15));
    }
  }

  // ── PULS-punkt -> ID15 grupperet (til hurtigt opslag pr. opland) ───────
  const pulsById15 = {};
  for (const [pulsIdx, id15] of Object.entries(pulsToId15)) {
    if (!pulsById15[id15]) pulsById15[id15] = [];
    pulsById15[id15].push(Number(pulsIdx));
  }

  // ── Rejsetider (produceret af compute-travel-times.js — kør DEN først) ──
  // Slås sammen her, så hvert matchet PULS-punkt får sin egen rejsetid til
  // netop DENNE sø. Et punkt kan i princippet være opstrøms for flere søer
  // samtidig (fx hvis det ligger tidligt i et forgrenet system), med
  // FORSKELLIG rejsetid til hver — derfor beregnes/gemmes det pr. sø, ikke
  // som en global egenskab ved selve PULS-punktet.
  let travelTimesByLake = {};
  if (fs.existsSync(paths.travelTimes)) {
    travelTimesByLake = JSON.parse(fs.readFileSync(paths.travelTimes, 'utf8'));
  } else {
    console.warn(`⚠ ${paths.travelTimes} ikke fundet — kør compute-travel-times.js først for rejsetids-baseret henfald. Fortsætter uden (pulsPointIds uden travelTimeHours).`);
  }

  // RETTET (fundet ved Furesø-krydstjek): traceUpstream() fortsatte
  // tidligere ubegrænset opstrøms, UANSET om et opland undervejs selv
  // indeholder en ANDEN sø. Konkret betød det at Furesøs "opstrøms"-mængde
  // ved et tjek viste sig at indeholde 17 andre selvstændige søer —
  // Farum Sø, Sjælsø, Søllerød Sø, Lyngby Sø m.fl. — fordi de alle indgår
  // i samme overordnede Mølleå-vandsystem. Det er hydrologisk set ikke
  // forkert at der ER en forbindelse, men enhver CSO-udledning nær disse
  // søer hører med rette til DERES EGEN risikovurdering: vandet bliver
  // tilbageholdt/fortyndet i den mellemliggende sø, længe før det når
  // Furesø. Sporingen skal derfor STOPPE ved enhver anden sø, den støder
  // på undervejs — hverken inkludere den mellemliggende sø's eget opland,
  // eller fortsætte forbi den.
  const id15ToLakeNames = {};
  for (const [navn, id15] of Object.entries(soeToId15)) {
    if (!id15ToLakeNames[id15]) id15ToLakeNames[id15] = [];
    id15ToLakeNames[id15].push(navn);
  }

  function traceUpstreamStoppingAtOtherLakes(startId15, ownLakeNavn) {
    const visited = new Set([startId15]);
    const queue = [startId15];
    let stoppedAtLakes = new Set();
    while (queue.length) {
      const current = queue.pop();
      const preds = upstream[current] || [];
      for (const p of preds) {
        if (visited.has(p)) continue;
        const lakesHere = id15ToLakeNames[p];
        const isOtherLake = lakesHere && lakesHere.some(n => n !== ownLakeNavn);
        if (isOtherLake) {
          // Stop HER: dette opland hører til en anden sø. Ekskluder det
          // fra den nuværende søs opstrøms-mængde, og gå ikke videre forbi
          // det — men registrér det, så det kan rapporteres (nyttigt for
          // gennemsigtighed/fejlsøgning).
          for (const n of lakesHere) stoppedAtLakes.add(n);
          continue;
        }
        visited.add(p);
        queue.push(p);
      }
    }
    return { visited, stoppedAtLakes };
  }

  // ── Match hver sø ───────────────────────────────────────────────────────
  const results = {};
  let totalMatched = 0, zeroMatches = 0;
  let missingTravelTime = 0;
  let totalViaOwnCatchment = 0;

  for (const [soeNavn, id15] of Object.entries(soeToId15)) {
    const { visited: upstreamSet, stoppedAtLakes } = traceUpstreamStoppingAtOtherLakes(id15, soeNavn);
    const lakeTravelTimes = travelTimesByLake[soeNavn] || {};
    const pulsPoints = [];
    for (const u of upstreamSet) {
      const ids = pulsById15[u];
      if (!ids) continue;
      let travelTimeHours = lakeTravelTimes[u];
      if (travelTimeHours === undefined) {
        missingTravelTime++;
        travelTimeHours = null;
      }
      // NYT: viaOwnCatchment markerer den usikre kategori — udløb fundet
      // udelukkende fordi de geografisk falder i søens EGET startopland
      // (u === id15), ikke via en bekræftet opstrøms-kæde af naboer med
      // reelt højdefald. Se filhovedet og resolve-canal-ambiguity.py.
      const viaOwnCatchment = (String(u) === String(id15));
      if (viaOwnCatchment) totalViaOwnCatchment += ids.length;
      for (const pulsId of ids) pulsPoints.push({ id: pulsId, travelTimeHours, viaOwnCatchment });
    }
    results[soeNavn] = {
      id15,
      // NYT: mstId fra soe-name-to-mstid.json (kildens eget entydige id).
      // Kan være et array med >1 element hvis navnet er tvetydigt (fx
      // "Mossø", som findes flere steder i landet) — så ved man IKKE med
      // sikkerhed hvilken af dem der reelt blev matchet af find_containing_id15
      // ovenfor, kun at en af dem blev. mstIdAmbiguous flager netop dette,
      // så downstream-forbrugere (fx diagnostik af de forbundne sø-grupper)
      // kan skelne "entydigt sø" fra "navn delt af flere søer i kilden".
      mstId: soeNameToMstId[soeNavn] || null,
      mstIdAmbiguous: (soeNameToMstId[soeNavn] || []).length > 1,
      upstreamId15Count: upstreamSet.size,
      pulsPoints,
      stoppedAtLakes: [...stoppedAtLakes],
    };
    if (pulsPoints.length > 0) totalMatched++;
    else zeroMatches++;
  }

  fs.writeFileSync(paths.output, JSON.stringify(results, null, 2));
  console.log(`\n${Object.keys(results).length} søer behandlet.`);
  console.log(`Med mindst ét matchet PULS-udløb: ${totalMatched}`);
  console.log(`Uden matches: ${zeroMatches}`);
  console.log(`Udløb markeret "viaOwnCatchment" (usikre — afgøres geometrisk af resolve-canal-ambiguity.py): ${totalViaOwnCatchment}`);
  if (missingTravelTime > 0) {
    console.warn(`⚠ ${missingTravelTime} punkt-match(es) manglede en beregnet rejsetid (travelTimeHours=null) — tjek at compute-travel-times.js er kørt med samme datagrundlag.`);
  }
  console.log(`Skrevet til ${paths.output}`);
  console.log(`\n➡ Kør nu: python3 resolve-canal-ambiguity.py`);
}

main();
