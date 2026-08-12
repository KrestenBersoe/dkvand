// ═══════════════════════════════════════════════════════════════════════════
// compute-travel-times.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Beregner REJSETID (ikke bare "forbundet/ikke forbundet") fra hvert
// opstrøms ID15-opland til dets sø, via Manning's ligning for
// vandhastighed. Dette er grundlaget for at anvende jeres eksisterende
// bakterie-/viral-henfaldsmodel (seasonalTau/seasonalTauViral i
// dansk-overloeb-kort.html) på TRANSPORTAFSTAND, ikke kun tid siden selve
// udledningshændelsen — de to bruger samme underliggende fysik (henfald er
// en funktion af forløbet tid, uanset om tiden kommer fra "tid siden
// hændelse" eller "yderligere rejsetid til søen").
//
// ── Manning's ligning: V = (1/n) × R^(2/3) × S^(1/2) ────────────────────
// (Gauckler-Manning-formlen, standardmetoden til at estimere
// vandhastighed i åbne vandløb uden direkte målt strømningsdata — se
// f.eks. Chow 1959, "Open-Channel Hydraulics", den klassiske reference.)
//
//   n (ruhedskoefficient): 0,035 — typisk værdi for naturlige,
//     let-vegeterede jordkanaler/åer i danske forhold (Chow 1959-tabeller,
//     midt i det almindelige interval 0,030–0,050 for denne kanaltype).
//     IKKE dansk-specifikt kalibreret — en rimelig, litteraturbegrundet
//     midtværdi, ikke en målt konstant.
//
//   S (hældning): beregnet DIREKTE fra vores egne højdedata — forskel i
//     minimumshøjde mellem to forbundne oplande, divideret med afstanden
//     mellem deres centroider. Det mest solidt underbyggede led i modellen,
//     da det bygger på faktiske DHM-højdemålinger, ikke en antagelse.
//
//   R (hydraulisk radius): DET MEST USIKRE led. Vi har ingen direkte mål
//     for vandløbenes tværsnitsgeometri, så R estimeres via "downstream
//     hydraulic geometry" — et veletableret, men regionalt varierende
//     skaleringsprincip (Leopold & Maddock 1953; opsummeret i nyere
//     regionale studier, fx det franske vandløbsdatabase-studie der finder
//     stærke potens-sammenhænge mellem opland-areal og både bredde og
//     dybde, R²=0,57–0,91 på tværs af hydro-øko-regioner). Vi bruger:
//       R = R_REF × (A_opstrøms / A_REF)^HYDRAULIC_GEOMETRY_EXPONENT
//     med eksponent 0,3 — inden for det typiske interval for
//     dybde-areal-skalering i den internationale litteratur (ofte angivet
//     til 0,3–0,4). R_REF er kalibreret til at give en fysisk plausibel
//     R (~0,15 m) for et lille kildevandsopland (1 km²) — IKKE en målt
//     dansk værdi. Dette er en anerkendt METODE, men de konkrete tal er en
//     rimelig tilnærmelse, ikke en valideret dansk konstant.
//
// Brug:
//   node compute-travel-times.js
//
// Output: id15-travel-times.json — { [id15]: { toLakeId15, travelTimeHours,
//   accumulatedAreaKm2 } } for hvert opland, PR. SØ det er opstrøms for.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const paths = {
  polygons: path.join(DIR, 'id15-polygons.json'),
  flowGraph: path.join(DIR, 'id15-flow-graph.json'),
  areaCentroid: path.join(DIR, 'id15-area-centroid.json'),
  soeToId15: path.join(DIR, 'soe-to-id15.json'),
  output: path.join(DIR, 'id15-travel-times.json'),
};

// ── Manning-parametre (se filhoved for fuld begrundelse og kildehenvisning) ──
const MANNING_N = 0.035;
const HYDRAULIC_GEOMETRY_EXPONENT = 0.3;
const R_REF_M = 0.15;      // hydraulisk radius ved A_REF
const A_REF_KM2 = 1.0;     // referenceareal for R_REF
const MIN_VELOCITY_MS = 0.02; // sikkerhedsgulv — undgår division med ~0 og urealistisk uendelig rejsetid ved næsten flad hældning
const MIN_ELEVATION_MARGIN_M = 1.0; // samme margin som match-lakes-via-id15.js — se dér for begrundelse

function manningVelocity(slope, accumulatedAreaKm2) {
  const R = R_REF_M * Math.pow(Math.max(accumulatedAreaKm2, A_REF_KM2) / A_REF_KM2, HYDRAULIC_GEOMETRY_EXPONENT);
  const V = (1 / MANNING_N) * Math.pow(R, 2 / 3) * Math.sqrt(Math.max(slope, 0));
  return Math.max(V, MIN_VELOCITY_MS);
}

function euclideanDistanceM(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function main() {
  console.log('Indlæser data...');
  const polygons = JSON.parse(fs.readFileSync(paths.polygons, 'utf8'));
  const flowGraph = JSON.parse(fs.readFileSync(paths.flowGraph, 'utf8'));
  const areaCentroid = JSON.parse(fs.readFileSync(paths.areaCentroid, 'utf8'));
  const soeToId15 = JSON.parse(fs.readFileSync(paths.soeToId15, 'utf8'));

  // ── Byg downstream-graf (samme logik + margin som match-lakes-via-id15.js) ──
  const downstream = {}; // id15 -> [{ target, distanceM, slope }, ...]
  for (const poly of polygons) {
    const own = flowGraph[poly.id15];
    if (!own || own.minElev == null) continue;
    const ownGeom = areaCentroid[poly.id15];
    const edges = [];
    for (const neighborIdx of poly.neighbors) {
      const neighborPoly = polygons[neighborIdx];
      const neighborData = flowGraph[neighborPoly.id15];
      if (!neighborData || neighborData.minElev == null) continue;
      const elevDiff = own.minElev - neighborData.minElev;
      if (elevDiff < MIN_ELEVATION_MARGIN_M) continue;
      const neighborGeom = areaCentroid[neighborPoly.id15];
      const distanceM = euclideanDistanceM(ownGeom.centroidX, ownGeom.centroidY, neighborGeom.centroidX, neighborGeom.centroidY);
      edges.push({ target: neighborPoly.id15, distanceM, slope: elevDiff / distanceM });
    }
    downstream[poly.id15] = edges;
  }

  // ── Flow-akkumulering: total opstrøms areal pr. opland ──────────────────
  // Topologisk behandling: søer fra HØJESTE til LAVESTE kote (garanteret
  // acyklisk, se begrundelse i match-lakes-via-id15.js), summerer areal fra
  // alle oplande der peger PÅ det aktuelle opland.
  const upstreamOf = {}; // id15 -> [id15, ...] der peger PÅ dette
  for (const [id15, edges] of Object.entries(downstream)) {
    for (const e of edges) {
      if (!upstreamOf[e.target]) upstreamOf[e.target] = [];
      upstreamOf[e.target].push(Number(id15));
    }
  }

  const sortedByElevDesc = polygons
    .filter(p => flowGraph[p.id15] && flowGraph[p.id15].minElev != null)
    .sort((a, b) => flowGraph[b.id15].minElev - flowGraph[a.id15].minElev);

  const accumulatedAreaKm2 = {};
  for (const poly of sortedByElevDesc) {
    const ownAreaKm2 = (areaCentroid[poly.id15]?.areaM2 || 0) / 1e6;
    // Da grafen er en DAG behandlet i faldende højdeorden, er alle
    // opstrøms-bidragydere allerede beregnet på dette tidspunkt.
    let total = ownAreaKm2;
    // NB: simpel sum uden dobbelttælling er kun eksakt for et TRÆ. I vores
    // DAG (flere mulige nedstrøms-mål) kan areal i teorien tælles med i
    // mere end én gren. Dette er en KENDT, accepteret tilnærmelse — en
    // præcis DAG-akkumulering kræver at spore hvilken andel af hvert
    // opstrøms opland der reelt løber hvilken vej, hvilket vi ikke har
    // grundlag for at vide. Konsekvensen er at hydraulisk radius (og
    // dermed hastighed) kan blive LIDT overvurderet nogle steder — en
    // rimelig afvejning givet formålet (grov rejsetid til henfald), ikke
    // en præcis afløbsmodel.
    for (const upId15 of (upstreamOf[poly.id15] || [])) {
      total += accumulatedAreaKm2[upId15] || 0;
    }
    accumulatedAreaKm2[poly.id15] = total;
  }

  console.log(`Flow-akkumulering beregnet for ${Object.keys(accumulatedAreaKm2).length} oplande.`);

  // ── Dijkstra: korteste REJSETID fra hvert opland til dets sø ────────────
  // Kører separat pr. sø (fra søens eget opland, baglæns via upstreamOf),
  // ligesom traceUpstreamStoppingAtOtherLakes i match-lakes-via-id15.js,
  // men akkumulerer TID i stedet for blot at markere "besøgt".
  const id15ToLakeNames = {};
  for (const [navn, id15] of Object.entries(soeToId15)) {
    if (!id15ToLakeNames[id15]) id15ToLakeNames[id15] = [];
    id15ToLakeNames[id15].push(navn);
  }

  const results = {}; // soeNavn -> { [id15]: travelTimeHours }
  let processed = 0;

  for (const [soeNavn, startId15] of Object.entries(soeToId15)) {
    processed++;
    const travelTimeHours = { [startId15]: 0 };
    // Prioritetskø (simpel array-baseret — antallet af noder pr. sø er
    // lille nok, at en fuld binær heap er unødvendig kompleksitet her)
    const queue = [{ id15: startId15, time: 0 }];

    while (queue.length) {
      queue.sort((a, b) => a.time - b.time);
      const { id15: current, time: currentTime } = queue.shift();
      if (currentTime > travelTimeHours[current]) continue; // forældet queue-indgang

      for (const predId15 of (upstreamOf[current] || [])) {
        if (predId15 in travelTimeHours && travelTimeHours[predId15] <= currentTime) continue;

        // Stop ved en anden sø (samme regel som match-lakes-via-id15.js)
        const lakesHere = id15ToLakeNames[predId15];
        if (lakesHere && lakesHere.some(n => n !== soeNavn)) continue;

        const edge = downstream[predId15]?.find(e => e.target === current);
        if (!edge) continue; // bør ikke ske, men defensivt
        const accArea = accumulatedAreaKm2[predId15] || A_REF_KM2;
        const velocity = manningVelocity(edge.slope, accArea);
        const edgeTimeHours = (edge.distanceM / velocity) / 3600;
        const candidateTime = currentTime + edgeTimeHours;

        if (!(predId15 in travelTimeHours) || candidateTime < travelTimeHours[predId15]) {
          travelTimeHours[predId15] = candidateTime;
          queue.push({ id15: predId15, time: candidateTime });
        }
      }
    }

    results[soeNavn] = travelTimeHours;
    if (processed % 100 === 0) console.log(`  ${processed}/${Object.keys(soeToId15).length} søer behandlet...`);
  }

  fs.writeFileSync(paths.output, JSON.stringify(results, null, 2));
  console.log(`\n${processed} søer behandlet. Skrevet til ${paths.output}`);

  // ── Diagnostik: fordeling af rejsetider ──────────────────────────────────
  const allTimes = [];
  for (const times of Object.values(results)) {
    for (const t of Object.values(times)) allTimes.push(t);
  }
  allTimes.sort((a, b) => a - b);
  const pct = p => allTimes[Math.min(allTimes.length - 1, Math.floor(allTimes.length * p / 100))];
  console.log(`\nRejsetids-fordeling (timer), alle oplande på tværs af alle søer:`);
  console.log(`  p10=${pct(10).toFixed(1)}  p50=${pct(50).toFixed(1)}  p90=${pct(90).toFixed(1)}  p99=${pct(99).toFixed(1)}  max=${allTimes[allTimes.length - 1].toFixed(1)}`);
}

main();
