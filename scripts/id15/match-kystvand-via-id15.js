#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// match-kystvand-via-id15.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Kystvandenes udgave af match-lakes-via-id15.js — samme bevist-virkende
// metode (nedstrøms-graf via minimumshøjde, permissiv DAG, opstrøms-
// sporing med BFS), anvendt på kystvande i stedet for søer.
//
// FORSKEL FRA SØER: en sø har ÉT id15-opland (soe-to-id15.json er 1:1).
// Et kystvand modtager derimod fra MANGE id15-oplande samtidig — dette er
// allerede kodet direkte i id15-flow-graph.json's eget kystvandId-felt
// (sat af build-id15-flow-graph.js, fra DCE's egen ID15-klassificering).
// Der er derfor IKKE brug for en separat "kystvand-to-id15.json" — vi
// grupperer blot flow-grafens EGNE oplande efter deres kystvandId og
// sporer opstrøms fra HELE den mængde samtidig, ikke fra ét enkelt punkt.
//
// VIGTIGT, NYT I FORHOLD TIL SØ-VERSIONEN: sporingen stopper nu IKKE kun
// ved andre SØER (samme begrundelse som i match-lakes-via-id15.js — vand
// tilbageholdes/fortyndes undervejs), men ved ENHVER sø overhovedet, uanset
// hvilket kystvand oplandet i øvrigt afvander til. En strøm, der passerer
// gennem en sø, FØR den når kysten, hører rettelig til søens EGEN
// risikovurdering (allerede dækket af id15-lake-matches.json) — ikke en
// ekstra, udiluteret bidrag til kystvandets risiko oveni.
//
// KENDT, EKSPLICIT BEGRÆNSNING (ærligt angivet, ikke skjult): denne
// version har INGEN rejsetids-baseret henfald, i modsætning til søernes
// travelTimeHours (fra compute-travel-times.js). Den fil blev bygget
// specifikt til afstande TIL EN SPECIFIK SØ — der findes intet
// tilsvarende "afstand til nærmeste kystlinje-punkt for et helt kystvand"
// endnu. Matchede udløb bruges derfor her UDEN afstandsdæmpning, samme
// princip som lake-matchingens egen "Trin 2 rumlig nærhed"-fallback, ikke
// søernes fulde, rejsetids-vægtede Trin 0,5. En fremtidig udvidelse kunne
// beregne tilsvarende rejsetider til kystvande, hvis det viser sig
// værdifuldt i praksis.
//
// Forudsætninger:
//   id15-polygons.json, id15-flow-graph.json, puls-to-id15.json (samme som match-lakes-via-id15.js)
//   soe-to-id15.json (bruges her KUN til at identificere hvilke oplande der skal stoppe sporingen, ikke til selve sø-matchingen)
//
// Brug:
//   node match-kystvand-via-id15.js
//
// Output: id15-kystvand-matches.json —
//   { [kystvandId]: { id15Count: number, pulsPointIds: number[], stoppedAtLakes: string[] } }
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const MIN_ELEVATION_MARGIN_M = 1.0;  // samme, allerede kalibrerede margen som match-lakes-via-id15.js

const DIR = __dirname;
const paths = {
  polygons:   path.join(DIR, 'id15-polygons.json'),
  flowGraph:  path.join(DIR, 'id15-flow-graph.json'),
  soeToId15:  path.join(DIR, 'soe-to-id15.json'),
  pulsToId15: path.join(DIR, 'puls-to-id15.json'),
  output:     path.join(DIR, 'id15-kystvand-matches.json'),
};

function main() {
  console.log('Indlæser data...');
  for (const [name, p] of Object.entries(paths)) {
    if (name === 'output') continue;
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${p} — kør forbehandlingstrinnene først (se filhoved).`);
      process.exit(1);
    }
  }

  const polygons   = JSON.parse(fs.readFileSync(paths.polygons, 'utf8'));
  const flowGraph  = JSON.parse(fs.readFileSync(paths.flowGraph, 'utf8'));
  const soeToId15  = JSON.parse(fs.readFileSync(paths.soeToId15, 'utf8'));
  const pulsToId15 = JSON.parse(fs.readFileSync(paths.pulsToId15, 'utf8'));

  console.log(`${polygons.length} ID15-polygoner, ${Object.keys(flowGraph).length} med højdedata, ` +
    `${Object.keys(soeToId15).length} søer, ${Object.keys(pulsToId15).length} PULS-punkter.`);

  // ── Byg rettet downstream-graf (identisk metode som match-lakes-via-id15.js) ──
  const downstream = {};
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
    `${noElevData} uden højdedata, ${noDownstream} terminale oplande.`);

  const upstream = {};
  for (const [id15, targets] of Object.entries(downstream)) {
    for (const target of targets) {
      if (!upstream[target]) upstream[target] = [];
      upstream[target].push(Number(id15));
    }
  }

  // NYT ift. sø-versionen: stopper ved ENHVER sø, ikke kun "andre" søer —
  // et kystvands opstrøms-sporing skal ALTID stoppe ved en sø undervejs,
  // uanset hvilket kystvand den i øvrigt tilhører (se filhovedets
  // begrundelse).
  const lakeId15Set = new Set(Object.values(soeToId15).map(Number));
  const id15ToLakeNames = {};
  for (const [navn, id15] of Object.entries(soeToId15)) {
    if (!id15ToLakeNames[id15]) id15ToLakeNames[id15] = [];
    id15ToLakeNames[id15].push(navn);
  }

  function traceUpstreamStoppingAtLakes(startSet) {
    const visited = new Set(startSet);
    const queue = [...startSet];
    const stoppedAtLakes = new Set();
    while (queue.length) {
      const current = queue.pop();
      const preds = upstream[current] || [];
      for (const p of preds) {
        if (visited.has(p)) continue;
        if (lakeId15Set.has(p)) {
          for (const n of (id15ToLakeNames[p] || [])) stoppedAtLakes.add(n);
          continue;  // stop her — ikke medtaget, ikke fortsat forbi
        }
        visited.add(p);
        queue.push(p);
      }
    }
    return { visited, stoppedAtLakes };
  }

  const pulsById15 = {};
  for (const [pulsIdx, id15] of Object.entries(pulsToId15)) {
    if (!pulsById15[id15]) pulsById15[id15] = [];
    pulsById15[id15].push(Number(pulsIdx));
  }

  // ── Grupér oplande efter kystvandId (mange-til-én, allerede i flow-grafen) ──
  const id15sByKystvand = {};
  for (const [id15, data] of Object.entries(flowGraph)) {
    if (data.kystvandId == null) continue;
    if (!id15sByKystvand[data.kystvandId]) id15sByKystvand[data.kystvandId] = [];
    id15sByKystvand[data.kystvandId].push(Number(id15));
  }
  console.log(`${Object.keys(id15sByKystvand).length} distinkte kystvande fundet i flow-grafen.`);

  // ── Match hvert kystvand ────────────────────────────────────────────────
  const results = {};
  let totalMatched = 0, zeroMatches = 0;

  for (const [kystvandId, startId15s] of Object.entries(id15sByKystvand)) {
    // Ekskluder eventuelle sø-oplande fra selve STARTMÆNGDEN — et opland,
    // der ER en sø, skal ikke selv bidrage direkte til kystvandets
    // opstrøms-mængde (det er søens egen risikovurdering, der dækker det).
    const startSet = startId15s.filter(id15 => !lakeId15Set.has(id15));
    if (startSet.length === 0) { zeroMatches++; results[kystvandId] = { id15Count: 0, pulsPointIds: [], stoppedAtLakes: [] }; continue; }

    const { visited: upstreamSet, stoppedAtLakes } = traceUpstreamStoppingAtLakes(startSet);
    const pulsPointIds = [];
    for (const u of upstreamSet) {
      for (const idx of (pulsById15[u] || [])) pulsPointIds.push(idx);
    }

    if (pulsPointIds.length > 0) totalMatched++; else zeroMatches++;
    results[kystvandId] = {
      id15Count: upstreamSet.size,
      pulsPointIds,
      stoppedAtLakes: [...stoppedAtLakes],
    };
  }

  console.log(`\nKystvande med mindst ét matchet PULS-udløb: ${totalMatched}`);
  console.log(`Kystvande uden noget matchet udløb: ${zeroMatches}`);

  fs.writeFileSync(paths.output, JSON.stringify(results, null, 2));
  console.log(`\nSkrevet ${paths.output}`);
}

main();
