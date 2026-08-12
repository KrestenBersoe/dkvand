#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// match-vandlob-via-id15.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Vandløbenes udgave af match-lakes-via-id15.js / match-kystvand-via-id15.js
// — samme bevist-virkende metode (nedstrøms-graf via minimumshøjde,
// permissiv DAG, opstrøms-sporing med BFS, stopper ved søer), anvendt pr.
// VANDLØBSLINJE i stedet for pr. sø eller kystvandgruppe.
//
// HVORFOR DETTE ER NØDVENDIGT: badevandsvurderingen matcher i dag kun
// søer og kystvande — et badested ved et vandløb (uden at være ved en
// målsat sø eller direkte kystlinje) har ingen matching-vej overhovedet,
// og viser derfor altid "ukendt", uanset hvor tæt et reelt forbundet
// udløb ligger. Denne fil lukker det hul.
//
// ANKERPUNKT PR. LINJE: en vandløbslinje har to endepunkter (A og B, se
// map-vandlob-to-id15.py) — opstrøms-sporing skal ankres ved det
// NEDSTRØMS endepunkt (alt der flyder FORBI dette punkt, inklusiv hele
// linjens eget opstrøms-forløb), ikke et vilkårligt af de to. Bruger
// derfor vandlob-directions.json's allerede beregnede retning:
//   - direction === 'AtilB' → B er nedstrøms → ankr ved B
//   - direction === 'BtilA' → A er nedstrøms → ankr ved A
//   - direction === null (usikker/ukendt) → ankr ved BEGGE endepunkter
//     samtidig (foreningsmængde) — en bevidst konservativ fallback: bedre
//     at inkludere lidt for meget end at miste linjen fuldstændigt, men
//     markeret som lavere pålidelighed (se lowConfidence-feltet i output).
//
// Samme "stop ved enhver sø"-regel som kystvande — vand der passerer
// gennem en sø, hører til SØENS egen risikovurdering, ikke vandløbets.
//
// KENDT, EKSPLICIT BEGRÆNSNING: ingen rejsetids-baseret henfald endnu,
// samme begrundelse som kystvande — matchede udløb bruges ved fuld vægt.
//
// Forudsætninger:
//   id15-polygons.json, id15-flow-graph.json, puls-to-id15.json, soe-to-id15.json
//   vandlob-to-id15.json (map-vandlob-to-id15.py)
//   vandlob-directions.json (compute-vandlob-directions.js)
//
// Brug:
//   node match-vandlob-via-id15.js
//
// Output: vandlob-upstream-matches.json —
//   [{ index: <linjeindeks>, pulsPointIds: number[], lowConfidence: boolean }, ...]
//   (kun linjer med mindst ét matchet udløb medtages)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const MIN_ELEVATION_MARGIN_M = 1.0;  // samme, allerede kalibrerede margen som de øvrige ID15-scripts

const DIR = __dirname;
const paths = {
  polygons:         path.join(DIR, 'id15-polygons.json'),
  flowGraph:        path.join(DIR, 'id15-flow-graph.json'),
  soeToId15:        path.join(DIR, 'soe-to-id15.json'),
  pulsToId15:       path.join(DIR, 'puls-to-id15.json'),
  vandlobToId15:    path.join(DIR, 'vandlob-to-id15.json'),
  vandlobDirections: path.join(DIR, 'vandlob-directions.json'),
  output:           path.join(DIR, 'vandlob-upstream-matches.json'),
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

  const polygons         = JSON.parse(fs.readFileSync(paths.polygons, 'utf8'));
  const flowGraph        = JSON.parse(fs.readFileSync(paths.flowGraph, 'utf8'));
  const soeToId15        = JSON.parse(fs.readFileSync(paths.soeToId15, 'utf8'));
  const pulsToId15       = JSON.parse(fs.readFileSync(paths.pulsToId15, 'utf8'));
  const vandlobToId15    = JSON.parse(fs.readFileSync(paths.vandlobToId15, 'utf8'));
  const vandlobDirections = JSON.parse(fs.readFileSync(paths.vandlobDirections, 'utf8'));

  console.log(`${polygons.length} ID15-polygoner, ${Object.keys(soeToId15).length} søer, ` +
    `${Object.keys(pulsToId15).length} PULS-punkter, ${vandlobToId15.length} vandløbslinjer.`);

  // ── Byg rettet downstream-graf (identisk metode som de øvrige ID15-scripts) ──
  const downstream = {};
  for (const poly of polygons) {
    const own = flowGraph[poly.id15];
    if (!own || own.minElev == null) continue;
    const targets = [];
    for (const neighborIdx of poly.neighbors) {
      const neighborPoly = polygons[neighborIdx];
      const neighborData = flowGraph[neighborPoly.id15];
      if (!neighborData || neighborData.minElev == null) continue;
      if (own.minElev - neighborData.minElev >= MIN_ELEVATION_MARGIN_M) targets.push(neighborPoly.id15);
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
  console.log(`Downstream-graf bygget: ${Object.keys(downstream).length} opland.`);

  const lakeId15Set = new Set(Object.values(soeToId15).map(Number));

  function traceUpstreamStoppingAtLakes(startSet) {
    const visited = new Set(startSet);
    const queue = [...startSet];
    while (queue.length) {
      const current = queue.pop();
      const preds = upstream[current] || [];
      for (const p of preds) {
        if (visited.has(p) || lakeId15Set.has(p)) continue;  // stop ved søer, medtag dem ikke
        visited.add(p);
        queue.push(p);
      }
    }
    return visited;
  }

  const pulsById15 = {};
  for (const [pulsIdx, id15] of Object.entries(pulsToId15)) {
    if (!pulsById15[id15]) pulsById15[id15] = [];
    pulsById15[id15].push(Number(pulsIdx));
  }

  const dirByIndex = {};
  for (const d of vandlobDirections) dirByIndex[d.index] = d;

  // ── Match hver vandløbslinje ─────────────────────────────────────────────
  const results = [];
  let sikkerAnker = 0, usikkerAnker = 0, ingenMatch = 0, zeroOutlets = 0;

  for (const entry of vandlobToId15) {
    const { index, id15A, id15B } = entry;
    if (id15A == null && id15B == null) continue;

    const dir = dirByIndex[index];
    let startSet, lowConfidence;

    if (dir && dir.direction === 'AtilB' && id15B != null) {
      startSet = [id15B]; lowConfidence = dir.confidence !== 'sikker'; sikkerAnker++;
    } else if (dir && dir.direction === 'BtilA' && id15A != null) {
      startSet = [id15A]; lowConfidence = dir.confidence !== 'sikker'; sikkerAnker++;
    } else {
      // Ukendt retning — ankr ved BEGGE endepunkter, markeret lav pålidelighed.
      startSet = [id15A, id15B].filter(x => x != null);
      lowConfidence = true;
      usikkerAnker++;
    }
    if (startSet.length === 0) { ingenMatch++; continue; }

    // Ekskluder søoplande fra selve startmængden — samme princip som kystvande.
    const filteredStart = startSet.filter(id15 => !lakeId15Set.has(id15));
    if (filteredStart.length === 0) { ingenMatch++; continue; }

    const upstreamSet = traceUpstreamStoppingAtLakes(filteredStart);
    const pulsPointIds = [];
    for (const u of upstreamSet) {
      for (const idx of (pulsById15[u] || [])) pulsPointIds.push(idx);
    }

    if (pulsPointIds.length === 0) { zeroOutlets++; continue; }
    results.push({ index, pulsPointIds, lowConfidence });
  }

  console.log(`\nLinjer med sikkert anker: ${sikkerAnker}`);
  console.log(`Linjer med usikkert/dobbelt anker: ${usikkerAnker}`);
  console.log(`Linjer uden noget anker overhovedet: ${ingenMatch}`);
  console.log(`Linjer med anker, men ingen matchede udløb: ${zeroOutlets}`);
  console.log(`Linjer med mindst ét matchet udløb (medtaget i output): ${results.length}`);

  fs.writeFileSync(paths.output, JSON.stringify(results));
  console.log(`\nSkrevet ${paths.output}`);
}

main();
