'use strict';
// Offline test af selve graf-logikken i match-lakes-via-id15.js, med
// syntetiske ID15-oplande, adjacency og højder — for at verificere
// downstream-graf-opbygning og opstrøms-BFS FØR den dyre, ægte DHM-kørsel
// (build-id15-flow-graph.js, ~3.990 opland, potentielt flere timer).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '_test_tmp');
fs.mkdirSync(TEST_DIR, { recursive: true });

// ── Syntetisk scenarie ───────────────────────────────────────────────────
// Fem oplande i en kæde A -> B -> C -> D -> E (faldende højde), plus et
// sjette isoleret opland F (ingen forbindelse til kæden — tester at det
// ikke fejlagtigt inkluderes).
//   A(100m) -> B(80m) -> C(60m) -> D(40m) -> E(20m, "søens" opland)
//   F(50m) — isoleret, ingen naboer
//
// PULS-punkter: 2 i A, 1 i C, 1 i F. Søen sidder i E.
// Forventet resultat: opstrøms fra E finder A,B,C,D (ikke F) -> 3 PULS-punkter matchet (2 fra A, 1 fra C).

const polygons = [
  { index: 0, id15: 100, kystvandId: 1, neighbors: [1], wkt: 'POLYGON EMPTY' },      // A
  { index: 1, id15: 200, kystvandId: 1, neighbors: [0, 2], wkt: 'POLYGON EMPTY' },   // B
  { index: 2, id15: 300, kystvandId: 1, neighbors: [1, 3], wkt: 'POLYGON EMPTY' },   // C
  { index: 3, id15: 400, kystvandId: 1, neighbors: [2, 4], wkt: 'POLYGON EMPTY' },   // D
  { index: 4, id15: 500, kystvandId: 1, neighbors: [3], wkt: 'POLYGON EMPTY' },      // E (sø)
  { index: 5, id15: 600, kystvandId: 1, neighbors: [], wkt: 'POLYGON EMPTY' },       // F (isoleret)
];

const flowGraph = {
  100: { minElev: 100, pointCount: 10, kystvandId: 1, index: 0 },
  200: { minElev: 80,  pointCount: 10, kystvandId: 1, index: 1 },
  300: { minElev: 60,  pointCount: 10, kystvandId: 1, index: 2 },
  400: { minElev: 40,  pointCount: 10, kystvandId: 1, index: 3 },
  500: { minElev: 20,  pointCount: 10, kystvandId: 1, index: 4 },
  600: { minElev: 50,  pointCount: 10, kystvandId: 1, index: 5 },
};

const soeToId15 = { 'Testsø': 500 };

const pulsToId15 = {
  0: 100, 1: 100,  // to punkter i A
  2: 300,          // ét punkt i C
  3: 600,          // ét punkt i det isolerede F
};

fs.writeFileSync(path.join(TEST_DIR, 'id15-polygons.json'), JSON.stringify(polygons));
fs.writeFileSync(path.join(TEST_DIR, 'id15-flow-graph.json'), JSON.stringify(flowGraph));
fs.writeFileSync(path.join(TEST_DIR, 'soe-to-id15.json'), JSON.stringify(soeToId15));
fs.writeFileSync(path.join(TEST_DIR, 'puls-to-id15.json'), JSON.stringify(pulsToId15));

// Kør selve match-scriptets logik ved at indlæse det som modul-lignende
// (scriptet er skrevet som et selvstændigt CLI-script, så vi kopierer dets
// kernelogik hertil for testformål — se match-lakes-via-id15.js for den
// autoritative version, denne test skal holdes i sync med den).
// NB: Denne test-fils interne runMatching() bruger et FORENKLET output
// (pulsPointIds som flad liste) for at holde topologi-testene overskuelige.
// Det virkelige match-lakes-via-id15.js output nester nu i stedet hvert
// punkt som { id, travelTimeHours } (se compute-travel-times.js og
// compute-travel-times.test.js for den del af logikken, testet separat).
// Denne fil tester udelukkende selve graf-topologien (hvilke punkter
// matches, ikke deres rejsetid) — de to bekymringer er uafhængige af
// hinanden, og adskilt her for at holde hver testfil fokuseret.
function runMatching(polygons, flowGraph, soeToId15, pulsToId15, minMarginM = 1.0) {
  const downstream = {};
  for (const poly of polygons) {
    const own = flowGraph[poly.id15];
    if (!own || own.minElev == null) continue;
    const targets = [];
    for (const neighborIdx of poly.neighbors) {
      const neighborPoly = polygons[neighborIdx];
      const neighborData = flowGraph[neighborPoly.id15];
      if (!neighborData || neighborData.minElev == null) continue;
      if (own.minElev - neighborData.minElev >= minMarginM) targets.push(neighborPoly.id15);
    }
    downstream[poly.id15] = targets;
  }

  const upstream = {};
  for (const [id15, targets] of Object.entries(downstream)) {
    for (const target of targets) {
      if (!upstream[target]) upstream[target] = [];
      upstream[target].push(Number(id15));
    }
  }

  const pulsById15 = {};
  for (const [pulsIdx, id15] of Object.entries(pulsToId15)) {
    if (!pulsById15[id15]) pulsById15[id15] = [];
    pulsById15[id15].push(Number(pulsIdx));
  }

  const id15ToLakeNames = {};
  for (const [navn, id15] of Object.entries(soeToId15)) {
    if (!id15ToLakeNames[id15]) id15ToLakeNames[id15] = [];
    id15ToLakeNames[id15].push(navn);
  }

  function traceUpstreamStoppingAtOtherLakes(startId15, ownLakeNavn) {
    const visited = new Set([startId15]);
    const queue = [startId15];
    const stoppedAtLakes = new Set();
    while (queue.length) {
      const current = queue.pop();
      const preds = upstream[current] || [];
      for (const p of preds) {
        if (visited.has(p)) continue;
        const lakesHere = id15ToLakeNames[p];
        const isOtherLake = lakesHere && lakesHere.some(n => n !== ownLakeNavn);
        if (isOtherLake) { for (const n of lakesHere) stoppedAtLakes.add(n); continue; }
        visited.add(p);
        queue.push(p);
      }
    }
    return { visited, stoppedAtLakes };
  }

  const results = {};
  for (const [soeNavn, id15] of Object.entries(soeToId15)) {
    const { visited: upstreamSet, stoppedAtLakes } = traceUpstreamStoppingAtOtherLakes(id15, soeNavn);
    const pulsIds = [];
    for (const u of upstreamSet) { const ids = pulsById15[u]; if (ids) pulsIds.push(...ids); }
    results[soeNavn] = { id15, upstreamId15Count: upstreamSet.size, pulsPointIds: pulsIds, stoppedAtLakes: [...stoppedAtLakes] };
  }
  return { results, downstream, upstream };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e.message}`); }
}

const { results, downstream } = runMatching(polygons, flowGraph, soeToId15, pulsToId15);

test('downstream-kæde: A->B->C->D->E korrekt bestemt af faldende højde', () => {
  assert.deepStrictEqual(downstream[100], [200]); // A -> B
  assert.deepStrictEqual(downstream[200], [300]); // B -> C
  assert.deepStrictEqual(downstream[300], [400]); // C -> D
  assert.deepStrictEqual(downstream[400], [500]); // D -> E
  assert.deepStrictEqual(downstream[500], []);    // E: ingen lavere nabo (terminal)
});

test('isoleret opland F har intet nedstrøms mål (ingen naboer overhovedet)', () => {
  assert.deepStrictEqual(downstream[600], []);
});

test('Testsø (opland E) finder opstrøms A,B,C,D — IKKE det isolerede F', () => {
  assert.strictEqual(results['Testsø'].upstreamId15Count, 5); // A,B,C,D,E selv
});

test('Testsø matcher præcis de 3 PULS-punkter i A og C — ikke punktet i isolerede F', () => {
  const ids = results['Testsø'].pulsPointIds.sort();
  assert.deepStrictEqual(ids, [0, 1, 2]);
});

// ── Regressionstest for Furesø-fundet ────────────────────────────────────
// Efterligner det PRÆCISE mønster, der afslørede buggen: en sø (Y) med
// FLERE nabo-oplande, der hver især er højere end Y, men hvor kun ÉT af
// dem tilfældigvis er "det stejleste". Den gamle (fejlende) logik ville
// kun inkludere det stejleste — denne test kræver at ALLE reelt lavere
// naboer inkluderes.
test('sø med flere samtidige tilløb: alle naboer der reelt er lavere end søen, tælles med', () => {
  const multiPolygons = [
    { index: 0, id15: 10, neighbors: [3], wkt: '' },  // P (100m) -> Y
    { index: 1, id15: 20, neighbors: [3], wkt: '' },  // Q (90m)  -> Y
    { index: 2, id15: 30, neighbors: [3], wkt: '' },  // R (80m)  -> Y (den "stejleste" — gammel logik ville KUN tage denne)
    { index: 3, id15: 40, neighbors: [0, 1, 2], wkt: '' }, // Y (sø, 20m) — modtager fra P, Q OG R
  ];
  const multiFlowGraph = {
    10: { minElev: 100 }, 20: { minElev: 90 }, 30: { minElev: 80 }, 40: { minElev: 20 },
  };
  const multiSoeToId15 = { 'Multisø': 40 };
  const multiPulsToId15 = { 0: 10, 1: 20, 2: 30 }; // ét PULS-punkt i hver af de tre opstrøms-naboer

  const { results: multiResults } = runMatching(multiPolygons, multiFlowGraph, multiSoeToId15, multiPulsToId15);
  const ids = multiResults['Multisø'].pulsPointIds.sort();
  assert.deepStrictEqual(ids, [0, 1, 2], 'alle tre opstrøms-naboer (P, Q, R) skal bidrage, ikke kun den stejleste (R)');
});

// ── Regressionstest for "17 andre søer i Furesøs opstrøms-mængde"-fundet ─
// Kæde: A(100m) -> B(90m, HED søen "Sø X"s eget opland) -> C(50m, target:
// "Sø Y"). Sporing opstrøms fra Y skal stoppe VED B (fordi B tilhører en
// anden sø) — B skal IKKE selv indgå i Y's opstrøms-mængde, og A (som
// ligger endnu længere opstrøms, bag B) skal slet ikke nås.
test('opstrøms-sporing stopper ved en anden sø — fortsætter IKKE forbi den, og medtager den heller ikke selv', () => {
  const chainPolygons = [
    { index: 0, id15: 1, neighbors: [1], wkt: '' },  // A
    { index: 1, id15: 2, neighbors: [0, 2], wkt: '' }, // B — Sø X's eget opland
    { index: 2, id15: 3, neighbors: [1], wkt: '' },  // C — Sø Y's eget opland (target)
  ];
  const chainFlowGraph = { 1: { minElev: 100 }, 2: { minElev: 90 }, 3: { minElev: 50 } };
  const chainSoeToId15 = { 'Sø X': 2, 'Sø Y': 3 };
  const chainPulsToId15 = { 0: 1, 1: 2 }; // ét punkt bag Sø X (A), ét i Sø X's eget opland (B)

  const { results: chainResults } = runMatching(chainPolygons, chainFlowGraph, chainSoeToId15, chainPulsToId15);
  const soeY = chainResults['Sø Y'];

  assert.strictEqual(soeY.upstreamId15Count, 1, 'Sø Y skal kun have sit eget opland (C) — hverken B eller A');
  assert.deepStrictEqual(soeY.pulsPointIds, [], 'ingen PULS-punkter fra A eller B må tilskrives Sø Y');
  assert.deepStrictEqual(soeY.stoppedAtLakes, ['Sø X'], 'Sø Y bør registrere at sporingen stoppede ved Sø X');

  // Sø X selv skal til gengæld korrekt finde punktet i sit eget opland (B)
  // OG punktet opstrøms for det (A) — den anden sø bryder ikke DENS kæde.
  const soeX = chainResults['Sø X'];
  assert.deepStrictEqual(soeX.pulsPointIds.sort(), [0, 1], 'Sø X skal finde punkter i både sit eget opland og opstrøms for det');
});

// ── Regressionstest for "Kajerød Å, Sjælsø"-fundet (marginale kanter) ────
test('marginal højdeforskel (under margin) filtreres fra, robust forskel accepteres', () => {
  const marginPolygons = [
    { index: 0, id15: 1, neighbors: [1, 2], wkt: '' }, // fælles opland, grænser til begge søer
    { index: 1, id15: 2, neighbors: [0], wkt: '' },    // Sø A — kun 0,1m lavere (marginal, bør IKKE tælle)
    { index: 2, id15: 3, neighbors: [0], wkt: '' },    // Sø B — 5m lavere (robust, bør tælle)
  ];
  const marginFlowGraph = {
    1: { minElev: 18.3 },
    2: { minElev: 18.2 }, // kun 0,1m under opland 1
    3: { minElev: 13.3 }, // 5m under opland 1
  };
  const marginSoeToId15 = { 'Sø A': 2, 'Sø B': 3 };
  const marginPulsToId15 = { 0: 1 }; // ét punkt i det fælles opland

  const { results: marginResults } = runMatching(marginPolygons, marginFlowGraph, marginSoeToId15, marginPulsToId15, 1.0);

  assert.deepStrictEqual(marginResults['Sø A'].pulsPointIds, [], 'Sø A (kun 0,1m lavere) bør IKKE få punktet — under margin');
  assert.deepStrictEqual(marginResults['Sø B'].pulsPointIds, [0], 'Sø B (5m lavere, robust) bør få punktet');
});

fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log(`\n${passed} bestået, ${failed} fejlet`);
process.exit(failed > 0 ? 1 : 0);
