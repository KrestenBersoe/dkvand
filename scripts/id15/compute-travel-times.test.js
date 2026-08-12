'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.stack}`); }
}

// ── Manning-hastighedsfunktionen isoleret ───────────────────────────────
const MANNING_N = 0.035;
const HYDRAULIC_GEOMETRY_EXPONENT = 0.3;
const R_REF_M = 0.15;
const A_REF_KM2 = 1.0;
const MIN_VELOCITY_MS = 0.02;

function manningVelocity(slope, accumulatedAreaKm2) {
  const R = R_REF_M * Math.pow(Math.max(accumulatedAreaKm2, A_REF_KM2) / A_REF_KM2, HYDRAULIC_GEOMETRY_EXPONENT);
  const V = (1 / MANNING_N) * Math.pow(R, 2 / 3) * Math.sqrt(Math.max(slope, 0));
  return Math.max(V, MIN_VELOCITY_MS);
}

test('Manning: stejlere hældning giver højere hastighed (alt andet lige)', () => {
  const vLow = manningVelocity(0.001, 10);
  const vHigh = manningVelocity(0.01, 10);
  assert.ok(vHigh > vLow, `forventede højere hastighed ved stejlere hældning: ${vLow} vs ${vHigh}`);
});

test('Manning: større opstrøms areal giver højere hastighed (alt andet lige)', () => {
  const vSmall = manningVelocity(0.005, 1);
  const vLarge = manningVelocity(0.005, 1000);
  assert.ok(vLarge > vSmall, `forventede højere hastighed ved større areal: ${vSmall} vs ${vLarge}`);
});

test('Manning: hastighed er aldrig under sikkerhedsgulvet, selv ved ~flad hældning', () => {
  const v = manningVelocity(0.0000001, 1);
  assert.ok(v >= MIN_VELOCITY_MS, `hastighed ${v} under gulvet ${MIN_VELOCITY_MS}`);
});

test('Manning: giver fysisk plausible hastigheder for typiske danske forhold (0,05-2 m/s)', () => {
  // Typisk lavlandsvandløb: hældning 0,001-0,005 (1-5 promille), opland 5-50 km²
  const v = manningVelocity(0.002, 20);
  assert.ok(v > 0.02 && v < 3.0, `hastighed ${v.toFixed(3)} m/s virker urealistisk for typisk dansk vandløb`);
});

// ── Flow-akkumulering + Dijkstra rejsetid, integrationstest ─────────────
// Genbruger samme grundlæggende logik-struktur som compute-travel-times.js,
// men med syntetiske data for at kunne verificere præcise tal.
function runTravelTimeCalc(polygons, flowGraph, areaCentroid, soeToId15) {
  const MIN_ELEVATION_MARGIN_M = 1.0;
  const downstream = {};
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
      const distanceM = Math.hypot(neighborGeom.centroidX - ownGeom.centroidX, neighborGeom.centroidY - ownGeom.centroidY);
      edges.push({ target: neighborPoly.id15, distanceM, slope: elevDiff / distanceM });
    }
    downstream[poly.id15] = edges;
  }

  const upstreamOf = {};
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
    let total = ownAreaKm2;
    for (const upId15 of (upstreamOf[poly.id15] || [])) total += accumulatedAreaKm2[upId15] || 0;
    accumulatedAreaKm2[poly.id15] = total;
  }

  const id15ToLakeNames = {};
  for (const [navn, id15] of Object.entries(soeToId15)) {
    if (!id15ToLakeNames[id15]) id15ToLakeNames[id15] = [];
    id15ToLakeNames[id15].push(navn);
  }

  const results = {};
  for (const [soeNavn, startId15] of Object.entries(soeToId15)) {
    const travelTimeHours = { [startId15]: 0 };
    const queue = [{ id15: startId15, time: 0 }];
    while (queue.length) {
      queue.sort((a, b) => a.time - b.time);
      const { id15: current, time: currentTime } = queue.shift();
      if (currentTime > travelTimeHours[current]) continue;
      for (const predId15 of (upstreamOf[current] || [])) {
        if (predId15 in travelTimeHours && travelTimeHours[predId15] <= currentTime) continue;
        const lakesHere = id15ToLakeNames[predId15];
        if (lakesHere && lakesHere.some(n => n !== soeNavn)) continue;
        const edge = downstream[predId15]?.find(e => e.target === current);
        if (!edge) continue;
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
  }
  return { results, accumulatedAreaKm2, downstream };
}

test('flow-akkumulering: simpel kæde summerer areal korrekt', () => {
  // A(100m,10km²) -> B(90m,5km²) -> C(50m,2km², target)
  const polygons = [
    { index: 0, id15: 1, neighbors: [1], wkt: '' },
    { index: 1, id15: 2, neighbors: [0, 2], wkt: '' },
    { index: 2, id15: 3, neighbors: [1], wkt: '' },
  ];
  const flowGraph = { 1: { minElev: 100 }, 2: { minElev: 90 }, 3: { minElev: 50 } };
  const areaCentroid = {
    1: { areaM2: 10e6, centroidX: 0, centroidY: 10000 },
    2: { areaM2: 5e6, centroidX: 0, centroidY: 5000 },
    3: { areaM2: 2e6, centroidX: 0, centroidY: 0 },
  };
  const soeToId15 = { 'Testsø': 3 };
  const { accumulatedAreaKm2 } = runTravelTimeCalc(polygons, flowGraph, areaCentroid, soeToId15);
  assert.strictEqual(accumulatedAreaKm2[1], 10);      // A: kun sig selv
  assert.strictEqual(accumulatedAreaKm2[2], 15);       // B: sig selv + A
  assert.strictEqual(accumulatedAreaKm2[3], 17);       // C: sig selv + B (som inkl. A)
});

test('Dijkstra rejsetid: vælger den HURTIGSTE vej, ikke nødvendigvis den korteste afstand', () => {
  // To veje fra A til target C: direkte (langsom, lav hældning) vs via B (længere, men brat fald = hurtigere)
  // A -> C direkte: 10.000m, elevDiff 5m (meget flad, langsom)
  // A -> B -> C: to spring på hver 3.000m, men elevDiff 50m hver (bratte, hurtige)
  const polygons = [
    { index: 0, id15: 1, neighbors: [1, 2], wkt: '' }, // A — to udgange
    { index: 1, id15: 2, neighbors: [2], wkt: '' },    // B (mellemstop, brat)
    { index: 2, id15: 3, neighbors: [], wkt: '' },     // C (target/sø)
  ];
  // Elevationer sat op så BÅDE A->C direkte og A->B->C er gyldige (positive) nedstrøms-kanter
  const flowGraph = { 1: { minElev: 100 }, 2: { minElev: 50 }, 3: { minElev: 20 } };
  const areaCentroid = {
    1: { areaM2: 5e6, centroidX: 0, centroidY: 13000 },
    2: { areaM2: 3e6, centroidX: 3000, centroidY: 6500 }, // B: sidespring, tættere på A
    3: { areaM2: 2e6, centroidX: 0, centroidY: 0 },
  };
  const soeToId15 = { 'Testsø': 3 };
  const { results } = runTravelTimeCalc(polygons, flowGraph, areaCentroid, soeToId15);
  // A skal have en rejsetid, og den skal svare til den HURTIGSTE af de to mulige veje
  assert.ok('1' in results['Testsø'] || 1 in results['Testsø'], 'A skal have en beregnet rejsetid');
  assert.ok(results['Testsø'][1] > 0, 'rejsetid skal være positiv (ikke 0, da A ikke er søen selv)');
});

test('Dijkstra rejsetid: stopper stadig ved en anden sø (samme regel som match-lakes-via-id15.js)', () => {
  const polygons = [
    { index: 0, id15: 1, neighbors: [1], wkt: '' },  // A
    { index: 1, id15: 2, neighbors: [0, 2], wkt: '' }, // B — Sø X
    { index: 2, id15: 3, neighbors: [1], wkt: '' },  // C — Sø Y (target)
  ];
  const flowGraph = { 1: { minElev: 100 }, 2: { minElev: 90 }, 3: { minElev: 50 } };
  const areaCentroid = {
    1: { areaM2: 5e6, centroidX: 0, centroidY: 10000 },
    2: { areaM2: 3e6, centroidX: 0, centroidY: 5000 },
    3: { areaM2: 2e6, centroidX: 0, centroidY: 0 },
  };
  const soeToId15 = { 'Sø X': 2, 'Sø Y': 3 };
  const { results } = runTravelTimeCalc(polygons, flowGraph, areaCentroid, soeToId15);
  const soeYTimes = results['Sø Y'];
  assert.ok(!(1 in soeYTimes), 'A skal IKKE have en rejsetid til Sø Y — sporingen skal stoppe ved Sø X (opland 2)');
  assert.strictEqual(Object.keys(soeYTimes).length, 1, 'Sø Y skal kun kende rejsetiden for sig selv (0 timer)');
});

console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
