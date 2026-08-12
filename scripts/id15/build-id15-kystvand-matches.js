// ═══════════════════════════════════════════════════════════════════════════
// build-id15-kystvand-matches.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
// Bygger en NY, fuldstændig id15-kystvand-matches.json ud fra
// id15-polygons.json (3.355 ID15-delvandoplande, hver med et allerede
// DCE-tildelt kystvandId — ingen flow-/højdedatasporing nødvendig, DCE har
// allerede afgjort hvilket kystvand hvert opland dræner til).
//
// Metode: hvert PULS-punkts lat/lng konverteres til UTM32N (EPSG:25832,
// samme CRS som oplandenes WKT-geometri) og testes mod oplandene direkte i
// UTM — undgår at skulle reprojicere 3.355 polygoners fulde koordinatsæt,
// kun de 21.556 punkter konverteres.
//
// ERSTATTER den eksisterende id15-kystvand-matches.json fuldstændigt — det
// nye datagrundlag har 100% dækning (alle 3.355 oplande har et kystvandId),
// mod den gamle fils meget sparsomme, ukendte delvise dækning (bekræftet i
// denne samtale: intet opslag overhovedet for hverken Sejerø Bugt eller
// Fakse Bugt).
'use strict';
const fs = require('fs');
const path = require('path');
const proj4 = require('proj4');
// RETTET: antog tidligere at scriptet lå i repo-roden (samme sted som
// puls-data.json/risk-model.js) — men projektets egen konvention placerer
// ID15-værktøjer i scripts/id15/, en eller to mapper væk fra roden. Søger
// nu opad fra scriptets egen placering efter en mappe der indeholder
// puls-data.json, i stedet for at antage en fast relativ dybde.
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) { // maks. 6 niveauer opad, for en sikkerheds skyld
    if (fs.existsSync(path.join(dir, 'puls-data.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // nået filsystemets rod
    dir = parent;
  }
  throw new Error(`Kunne ikke finde puls-data.json i ${startDir} eller nogen overliggende mappe — kør scriptet fra eller under repo-roden, eller flyt puls-data.json/risk-model.js/id15-polygons.json til samme mappe som dette script.`);
}
const STATIC_DIR = findRepoRoot(__dirname);
console.log('Bruger datamappe:', STATIC_DIR);

proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const toUTM32 = proj4('EPSG:4326', 'EPSG:25832');

// ── WKT-parser (POLYGON og MULTIPOLYGON, med hulstøtte) ────────────────────
function parseWktCoordRing(ringStr) {
  return ringStr.trim().split(',').map(pair => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x, y];
  });
}
function parseWkt(wkt) {
  // Returnerer altid en liste af "polygoner" (hver en liste af ringe: [ydre, hul1, hul2, ...])
  const isMulti = wkt.startsWith('MULTIPOLYGON');
  const body = wkt.slice(wkt.indexOf('(') + (isMulti ? 2 : 1), wkt.lastIndexOf(')') - (isMulti ? 1 : 0));
  if (!isMulti) {
    // POLYGON ((ring1),(ring2)...)
    const rings = [];
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
      if (ch === ')') { depth--; if (depth === 0) { rings.push(parseWktCoordRing(cur)); continue; } }
      if (depth >= 1) cur += ch;
    }
    return [rings];
  } else {
    // MULTIPOLYGON (((ring1),(ring2)), ((ring1)), ...)
    const polygons = [];
    let depth = 0, curPoly = '', polyDepthStart = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(') { depth++; if (depth === 2) { polyDepthStart = i + 1; } }
      if (ch === ')') {
        if (depth === 2) {
          const polyBody = body.slice(polyDepthStart, i);
          const rings = [];
          let d2 = 0, cur = '';
          for (const c2 of polyBody) {
            if (c2 === '(') { d2++; if (d2 === 1) { cur = ''; continue; } }
            if (c2 === ')') { d2--; if (d2 === 0) { rings.push(parseWktCoordRing(cur)); continue; } }
            if (d2 >= 1) cur += c2;
          }
          polygons.push(rings);
        }
        depth--;
      }
    }
    return polygons;
  }
}

function computeBboxUTM(polygons) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygons(x, y, polygons) {
  for (const rings of polygons) {
    if (!rings.length) continue;
    if (!pointInRing(x, y, rings[0])) continue;
    let inHole = false;
    for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

// NYT: kant-afstand i UTM-METER — langt simplere end de tilsvarende
// funktioner i badevand-risk.js (som skal konvertere grader til meter
// tilnærmelsesvist); her er koordinaterne allerede i meter, ingen
// omregning nødvendig. Bruges som bufferzone-fallback for kystnære udløb
// (fx RUD87/RUD79), der ligger lige uden for et opland — ID15-oplandene
// dækker kun LAND, så et udløb, der fysisk sidder ved eller lige i
// vandkanten, vil ofte falde strengt UDENFOR ethvert opland, selvom det
// reelt hydrologisk hører til det nærmeste.
function distToSegmentUTM(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
function edgeDistanceUTM(x, y, polygons) {
  let min = Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const d = distToSegmentUTM(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
        if (d < min) min = d;
      }
    }
  }
  return min;
}
const COASTAL_BUFFER_M = 500; // samme størrelsesorden som badevand-risk.js's øvrige afstandstolerancer

// ── Indlæs oplande ──────────────────────────────────────────────────────────
console.log('Indlæser id15-polygons.json...');
// NYT: id15-polygons.json kan ligge et andet sted end selve repo-roden
// (fx ved siden af dette script) — prøver begge, i den rækkefølge.
function findFile(filename, ...candidateDirs) {
  for (const dir of candidateDirs) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Fandt ikke ${filename} i nogen af: ${candidateDirs.join(', ')}`);
}
const id15PolygonsPath = findFile('id15-polygons.json', STATIC_DIR, __dirname);
const catchments = JSON.parse(fs.readFileSync(id15PolygonsPath, 'utf8'));
console.log(`${catchments.length} oplande indlæst. Parser geometri...`);
for (const c of catchments) {
  c._polygons = parseWkt(c.wkt);
  c._bbox = computeBboxUTM(c._polygons);
}
console.log('Geometri parset.');

// ── Indlæs PULS-punkter ──────────────────────────────────────────────────
const riskModel = require(path.join(STATIC_DIR, 'risk-model'));
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const rows = raw.d || raw;
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  return { id: i, lat: derived.lat, lng: derived.lng };
}).filter(p => p.lat != null && p.lng != null);
console.log(`${points.length} PULS-punkter med koordinater indlæst.`);

// ── Match hvert punkt mod oplandene (UTM32N, bbox-forfiltreret) ──────────
const kystvandMatches = {}; // "DKCOAST<kystvandId>" -> Set af punkt-ID'er
let matchedCount = 0, strictCount = 0, bufferCount = 0;
for (let i = 0; i < points.length; i++) {
  const pt = points[i];
  const [x, y] = toUTM32.forward([pt.lng, pt.lat]);
  let matchedCatchment = null;

  // Trin 1: strengt punkt-i-polygon
  for (const c of catchments) {
    const b = c._bbox;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
    if (pointInPolygons(x, y, c._polygons)) { matchedCatchment = c; break; }
  }
  if (matchedCatchment) strictCount++;

  // NYT: Trin 2 — bufferzone-fallback for kystnære udløb (fx RUD87/RUD79),
  // der ligger lige uden for ethvert opland, fordi ID15-oplandene kun
  // dækker land. Finder nærmeste opland inden for COASTAL_BUFFER_M,
  // KUN hvis trin 1 intet fandt — påvirker aldrig et punkt, der allerede
  // strengt ligger inden for et opland.
  if (!matchedCatchment) {
    let bestDist = Infinity, bestCatchment = null;
    for (const c of catchments) {
      const b = c._bbox;
      // Billig bbox-forkastelse med buffer-margin
      if (x < b.minX - COASTAL_BUFFER_M || x > b.maxX + COASTAL_BUFFER_M ||
          y < b.minY - COASTAL_BUFFER_M || y > b.maxY + COASTAL_BUFFER_M) continue;
      const d = edgeDistanceUTM(x, y, c._polygons);
      if (d < bestDist) { bestDist = d; bestCatchment = c; }
    }
    if (bestCatchment && bestDist <= COASTAL_BUFFER_M) {
      matchedCatchment = bestCatchment;
      bufferCount++;
    }
  }

  if (matchedCatchment) {
    const key = `DKCOAST${matchedCatchment.kystvandId}`;
    if (!kystvandMatches[key]) kystvandMatches[key] = new Set();
    kystvandMatches[key].add(pt.id);
    matchedCount++;
  }
  if (i % 2000 === 0) console.log(`  ${i}/${points.length}...`);
}

console.log(`\n${matchedCount} punkter matchet til et opland i alt (${strictCount} strengt, ${bufferCount} via ${COASTAL_BUFFER_M}m-bufferzone).`);
console.log(`${Object.keys(kystvandMatches).length} kystvande fik mindst ét matchet udløb.`);

// ── Skriv output i samme format som den eksisterende fil ─────────────────
const output = {};
for (const [key, idSet] of Object.entries(kystvandMatches)) {
  output[key] = { pulsPointIds: [...idSet] };
}
fs.writeFileSync(path.join(STATIC_DIR, 'id15-kystvand-matches.json'), JSON.stringify(output));
console.log('\nSkrevet til id15-kystvand-matches.json — ERSTATTER den eksisterende fil.');
console.log('Husk at committe/deploye den nye fil, og at fjerne den midlertidige id15-polygons.json fra repoet igen, hvis den ikke skal ligge der permanent (den er 22 MB).');
