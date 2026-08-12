#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// derive-water-area.js — kør fra repo-roden, EFTER resten af update-all-data.sh
// ═══════════════════════════════════════════════════════════════════════════
//
// Udleder waterArea (recipient-visningstekst) for hvert PULS-punkt via en
// hybrid af tre metoder — myndigheden har fjernet det tilsvarende fritekst-
// felt fra PULS' egen WFS (se update-puls.js's filhoved), så update-puls.js
// sætter nu altid waterArea til tom streng. Dette script fylder den ud igen,
// ikke fra kilden (den findes ikke længere), men afledt af data vi allerede
// henter/beregner i forvejen.
//
// Metodevalg PR. KATEGORI er bevidst forskelligt, baseret på empirisk test
// (628/582/5.236 PULS-punkter, hvis gamle waterArea-felt navngav en ægte,
// eksisterende VP3-enhed, brugt som facit):
//
//   1. Søer:      id15-lake-matches.json (allerede beregnet opstrøms-sporing,
//                 se scripts/id15/match-lakes-via-id15.js) — langt bedre end
//                 ren geometrisk nærhed (76% "samme sø" vs. 51-79% selv med
//                 2 km buffer). Et udløb ligger sjældent fysisk ved søens
//                 bred — det løber typisk til via et vandløb et stykke væk.
//   2. Kystvande: geometrisk punkt-i-polygon + 10 km bufferfallback (samme
//                 grænse som appens egen kystvand-tekstmatch allerede
//                 dokumenterer, se dansk-overloeb-kort.html) — langt bedre
//                 end id15-kystvand-matches.json (99% vs. 67% "samme"). Et
//                 udløb ligger typisk direkte ved kysten.
//   3. Vandløb:   geometrisk punkt-nær-linje + 3 km bufferfallback — bedre
//                 end vandlob-upstream-matches.json (80% vs. 64% "samme").
//                 Segmenter uden navn ("Uden navn") springes over.
//
// KOMBINATION VED FLERE SAMTIDIGE MATCH: "nærmeste vinder", IKKE en fast
// kategori-prioritet. Et FØRSTE forsøg gav SØ ubetinget forrang (matchede
// hvordan det gamle felt ofte navngav en sø som recipient, selvom udløbet
// lå et stykke opstrøms) — men id15-lake-matches.json's opstrøms-sporing
// dækker så bredt (~50% af ALLE punkter, op til ~27 timers "rejsetid"), at
// den endte med at overtrumfe åbenlyst bedre kystvands-/vandløbs-match for
// punkter, der reelt lå lige ved kysten eller en navngiven å. Valideret
// direkte mod facit-sættene: fast SØ-prioritet gav vandløb ned på blot 4,7%
// "samme" (var 80,4% isoleret!). Løsningen er at konvertere søens
// travelTimeHours til en VIRTUEL AFSTAND (samme ASSUMED_STREAM_VELOCITY_M_
// PER_S = 0,3 m/s som badevand-risk.js allerede bruger til præcis dette
// formål) og lade den korteste afstand vinde uanset kategori. Det genopretter
// vandløb til 57,4% og giver et langt mere afbalanceret samlet resultat
// (søer 67,4%, kystvand 76,1%, vandløb 57,4% — vægtet gennemsnit 60,0%,
// kun 68/21.556 punkter uden noget match overhovedet).
//
// RETTET (efter stikprøvekontrol af 12 konkrete "gammel=vandløb, ny=sø"-
// tilfælde): søens candidate-afstand brugte oprindeligt 0 meter for ENHVER
// viaOwnCatchment-kandidat (udløbet ligger blot i søens ID15-opland, INGEN
// bekræftet strømningssporing) — hvilket vandt over ALT andet, inkl. et
// vandløb kun 6 meter væk (5/12 stikprøver). Bruger nu i stedet søens
// FAKTISKE geometriske afstand for viaOwnCatchment-kandidater (se
// matchSoe() nedenfor) — løser samtidig uafgjorte tilfælde ved flere
// samtidige viaOwnCatchment-søer på samme punkt.
//
// VIGTIGT, ÆRLIGT FORBEHOLD: dette er stadig en AFLEDT TILNÆRMELSE, ikke en
// genskabelse af den officielle, tilladelses-fastsatte recipient — det gamle
// felt og denne udledning er PÅVIST at pege på forskellige navne i en del af
// de tilfælde, hvor det gamle felt kunne verificeres (se samtalen bag denne
// fil). Brugbar som visningstekst og som input til den eksisterende
// tekstmatch-tier i badevand-risk.js — ikke en juridisk kilde.
//
// Forudsætninger (skal alle være friske — kør efter update-all-data.sh's
// øvrige trin, se dér for rækkefølgen):
//   puls-data.json, id15-lake-matches.json,
//   vp3_kystvande_simplified.geojson, vp3_vandlob.geojson
//
// Brug:
//   node scripts/derive-water-area.js [--puls-data ./puls-data.json]
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fs    = require('fs');
const path  = require('path');
const proj4 = require('proj4');

const argv = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

const ROOT           = path.join(__dirname, '..');
const PULS_PATH       = path.resolve(argVal('--puls-data', path.join(ROOT, 'puls-data.json')));
const LAKE_MATCHES_PATH = path.join(ROOT, 'id15-lake-matches.json');
const SOEER_PATH     = path.join(ROOT, 'vp3_soeer.geojson');
const KYSTVANDE_PATH = path.join(ROOT, 'vp3_kystvande_simplified.geojson');
const VANDLOB_PATH   = path.join(ROOT, 'vp3_vandlob.geojson');

const KYSTVAND_BUFFER_M = 10000;  // samme grænse som appens egen kystvand-tekstmatch (se dansk-overloeb-kort.html)
const VANDLOB_BUFFER_M  = 3000;   // kalibreret empirisk, se filhoved
// Samme konstant som badevand-risk.js's ASSUMED_STREAM_VELOCITY_M_PER_S —
// bruges til at gøre søens travelTimeHours sammenlignelig med kystvande/
// vandløbs faktiske meter-afstande, se filhoved.
const ASSUMED_STREAM_VELOCITY_M_PER_S = 0.3;
const SOE_VIRTUAL_BUFFER_M = 10000;

proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const toUTM32 = proj4('EPSG:4326', 'EPSG:25832');

// ── Minimal geometri-hjælpere (GeoJSON-koordinater, allerede i UTM32-meter) ──
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
function pointInPolygonCoords(x, y, polyCoords) {
  // polyCoords: [ [ring0 (ydre)], [ring1 (hul)], ... ]
  if (!pointInRing(x, y, polyCoords[0])) return false;
  for (let k = 1; k < polyCoords.length; k++) if (pointInRing(x, y, polyCoords[k])) return false;
  return true;
}
function pointInGeometry(x, y, geom) {
  if (geom.type === 'Polygon') return pointInPolygonCoords(x, y, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(poly => pointInPolygonCoords(x, y, poly));
  return false;
}
function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
function distToRing(x, y, ring) {
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = distToSegment(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    if (d < min) min = d;
  }
  return min;
}
function distToGeometryEdge(x, y, geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  let min = Infinity;
  for (const poly of polys) for (const ring of poly) { const d = distToRing(x, y, ring); if (d < min) min = d; }
  return min;
}
function distToLineGeometry(x, y, geom) {
  const lines = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
  let min = Infinity;
  for (const line of lines) { const d = distToRing(x, y, line); if (d < min) min = d; }
  return min;
}
function bboxOfRings(rings) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}
function bboxOfPolygonGeom(geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates.flat() : geom.coordinates;
  return bboxOfRings(polys);
}
function bboxOfLineGeom(geom) {
  const lines = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
  return bboxOfRings(lines);
}
function reprojectRing(ring) { return ring.map(([lng, lat]) => toUTM32.forward([lng, lat])); }
function reprojectGeometry(geom) {
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(reprojectRing) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(poly => poly.map(reprojectRing)) };
  if (geom.type === 'LineString') return { type: 'LineString', coordinates: reprojectRing(geom.coordinates) };
  if (geom.type === 'MultiLineString') return { type: 'MultiLineString', coordinates: geom.coordinates.map(reprojectRing) };
  return geom;
}

function main() {
  const paths = { 'puls-data.json': PULS_PATH, 'id15-lake-matches.json': LAKE_MATCHES_PATH,
    'vp3_soeer.geojson': SOEER_PATH,
    'vp3_kystvande_simplified.geojson': KYSTVANDE_PATH, 'vp3_vandlob.geojson': VANDLOB_PATH };
  for (const [label, p] of Object.entries(paths)) {
    if (!fs.existsSync(p)) {
      console.error(`❌ Mangler ${label} (${p}) — kør update-all-data.sh's øvrige trin først (se filhoved).`);
      process.exit(1);
    }
  }

  console.log('Indlæser data...');
  const puls = JSON.parse(fs.readFileSync(PULS_PATH, 'utf8'));
  const rows = puls.d;

  // ── 1. Søer: id15-lake-matches.json (ALLE kandidater pr. punkt, ikke kun
  // den bedste) + søernes egen geometri ────────────────────────────────────
  // RETTET: viaOwnCatchment=true (udløbet ligger blot i søens ID15-opland —
  // INGEN bekræftet strømningssporing, den svageste af de tre sø-bevistyper)
  // blev tidligere behandlet som 0 meters afstand, som pr. definition vandt
  // over ALT andet — bekræftet konkret ved stikprøve: 5/12 tilfælde havde et
  // vandløb blot 6-632 m væk, der tabte UDELUKKENDE fordi søen fik en gratis
  // 0'er. Bruger nu i stedet den FAKTISKE geometriske afstand til søens egen
  // polygon for viaOwnCatchment-kandidater — kun ægte opstrøms-sporede match
  // (travelTimeHours > 0, viaOwnCatchment=false) bruger fortsat rejsetids-
  // omregningen (en bekræftet strømningsvej kan sagtens være "tættere" i
  // rejsetid end i luftlinje, se REC27-7 i samtalens stikprøve: 7.299 m væk,
  // men kun 266 m "virtuel" rejsetids-afstand — et legitimt, ikke et snydt,
  // resultat). Løser SAMTIDIG uafgjorte tilfælde ved flere samtidige
  // viaOwnCatchment-søer på samme punkt (tidligere valgt vilkårligt efter
  // JSON-nøglerækkefølge, nu afgjort af hvilken sø der faktisk er tættest).
  const lakeMatches = JSON.parse(fs.readFileSync(LAKE_MATCHES_PATH, 'utf8'));
  const pointToLakeCandidates = new Map();  // pulsId -> [{ navn, travelTimeHours, viaOwnCatchment }, ...]
  for (const [lakeNavn, rec] of Object.entries(lakeMatches)) {
    for (const p of rec.pulsPoints || []) {
      if (!pointToLakeCandidates.has(p.id)) pointToLakeCandidates.set(p.id, []);
      pointToLakeCandidates.get(p.id).push({
        navn: lakeNavn,
        travelTimeHours: p.travelTimeHours ?? Infinity,
        viaOwnCatchment: !!p.viaOwnCatchment,
      });
    }
  }
  console.log(`  Søer: ${pointToLakeCandidates.size} PULS-punkter har mindst én sø-kandidat (id15-lake-matches.json)`);

  const soeerGeojson = JSON.parse(fs.readFileSync(SOEER_PATH, 'utf8'));
  const soeGeomByName = new Map();
  for (const f of soeerGeojson.features || []) {
    const navn = f.properties?.ov_navn;
    if (!navn || !f.geometry) continue;
    soeGeomByName.set(navn, reprojectGeometry(f.geometry));
  }
  console.log(`  Søer: ${soeGeomByName.size} sø-geometrier indlæst (til afstandsberegning af viaOwnCatchment-kandidater)`);

  // ── 2. Kystvande: geometri, reprojiceret til UTM32 ──────────────────────
  const kystGeojson = JSON.parse(fs.readFileSync(KYSTVANDE_PATH, 'utf8'));
  const kystvande = [];
  for (const f of kystGeojson.features || []) {
    const navn = f.properties?.ov_navn;
    if (!navn || !f.geometry) continue;
    const geom = reprojectGeometry(f.geometry);
    kystvande.push({ navn, geom, bbox: bboxOfPolygonGeom(geom) });
  }
  console.log(`  Kystvande: ${kystvande.length} polygoner indlæst`);

  // ── 3. Vandløb: geometri, navngivne segmenter, reprojiceret til UTM32 ──
  const vandlobGeojson = JSON.parse(fs.readFileSync(VANDLOB_PATH, 'utf8'));
  const vandlob = [];
  for (const f of vandlobGeojson.features || []) {
    const navn = f.properties?.ov_navn;
    if (!navn || navn.trim().toLowerCase() === 'uden navn' || !f.geometry) continue;
    const geom = reprojectGeometry(f.geometry);
    vandlob.push({ navn, geom, bbox: bboxOfLineGeom(geom) });
  }
  console.log(`  Vandløb: ${vandlob.length} navngivne linjer indlæst (ud af ${vandlobGeojson.features.length} i alt)`);

  // ── Match-funktioner — returnerer { navn, dist } eller null ─────────────
  function matchSoe(x, y, lakeCandidates) {
    if (!lakeCandidates) return null;
    let best = null, bestDist = Infinity;
    for (const cand of lakeCandidates) {
      let dist;
      if (cand.viaOwnCatchment) {
        const geom = soeGeomByName.get(cand.navn);
        if (!geom) continue;  // søen findes ikke i vp3_soeer.geojson (bør ikke ske, men fail-safe)
        dist = pointInGeometry(x, y, geom) ? 0 : distToGeometryEdge(x, y, geom);
      } else {
        dist = cand.travelTimeHours * 3600 * ASSUMED_STREAM_VELOCITY_M_PER_S;
      }
      if (dist < bestDist) { bestDist = dist; best = cand.navn; }
    }
    return best !== null && bestDist <= SOE_VIRTUAL_BUFFER_M ? { navn: best, dist: bestDist } : null;
  }
  function matchKystvand(x, y) {
    let best = null, bestDist = Infinity;
    for (const k of kystvande) {
      const b = k.bbox;
      if (x < b.minX - KYSTVAND_BUFFER_M || x > b.maxX + KYSTVAND_BUFFER_M ||
          y < b.minY - KYSTVAND_BUFFER_M || y > b.maxY + KYSTVAND_BUFFER_M) continue;
      if (pointInGeometry(x, y, k.geom)) return { navn: k.navn, dist: 0 };
      const d = distToGeometryEdge(x, y, k.geom);
      if (d < bestDist) { bestDist = d; best = k.navn; }
    }
    return best !== null && bestDist <= KYSTVAND_BUFFER_M ? { navn: best, dist: bestDist } : null;
  }
  function matchVandlob(x, y) {
    let best = null, bestDist = Infinity;
    for (const v of vandlob) {
      const b = v.bbox;
      if (x < b.minX - VANDLOB_BUFFER_M || x > b.maxX + VANDLOB_BUFFER_M ||
          y < b.minY - VANDLOB_BUFFER_M || y > b.maxY + VANDLOB_BUFFER_M) continue;
      const d = distToLineGeometry(x, y, v.geom);
      if (d < bestDist) { bestDist = d; best = v.navn; }
    }
    return best !== null && bestDist <= VANDLOB_BUFFER_M ? { navn: best, dist: bestDist } : null;
  }

  // ── Anvend hybriden pr. PULS-punkt: "nærmeste vinder" på tværs af alle
  // tre kategorier (se filhoved for hvorfor fast SØ-prioritet blev forkastet) ──
  const cat = { soe: 0, kyst: 0, vl: 0 };
  let nIngen = 0;
  const newAreaByRowIdx = new Array(rows.length).fill(null);

  for (let i = 0; i < rows.length; i++) {
    const [lat, lng] = rows[i];
    const [x, y] = toUTM32.forward([lng, lat]);

    const candidates = [];
    const soe = matchSoe(x, y, pointToLakeCandidates.get(i));
    if (soe) candidates.push({ dist: soe.dist, navn: soe.navn, kat: 'soe' });
    const kyst = matchKystvand(x, y);
    if (kyst) candidates.push({ dist: kyst.dist, navn: kyst.navn, kat: 'kyst' });
    const vl = matchVandlob(x, y);
    if (vl) candidates.push({ dist: vl.dist, navn: vl.navn, kat: 'vl' });

    if (candidates.length === 0) { nIngen++; continue; }
    candidates.sort((a, b) => a.dist - b.dist);
    const winner = candidates[0];
    newAreaByRowIdx[i] = winner.navn;
    cat[winner.kat]++;
  }
  const { soe: nSoe, kyst: nKyst, vl: nVandlob } = cat;

  console.log(`\nAfledt waterArea:`);
  console.log(`  Sø (id15-lake-matches.json):        ${nSoe.toLocaleString('da')}`);
  console.log(`  Kystvand (geometrisk, ${(KYSTVAND_BUFFER_M/1000)} km):     ${nKyst.toLocaleString('da')}`);
  console.log(`  Vandløb (geometrisk, ${(VANDLOB_BUFFER_M/1000)} km):      ${nVandlob.toLocaleString('da')}`);
  console.log(`  Intet match (tom waterArea):         ${nIngen.toLocaleString('da')}`);
  console.log(`  I alt:                               ${rows.length.toLocaleString('da')}`);

  // ── Skriv tilbage i samme komprimerede format ({a, w, d}) ───────────────
  const newAreaMap = new Map();  // navn -> idx
  const newAreas   = [];
  function areaIdx(name) {
    const key = name || 'Ukendt';
    if (!newAreaMap.has(key)) { newAreaMap.set(key, newAreas.length); newAreas.push(key); }
    return newAreaMap.get(key);
  }
  for (let i = 0; i < rows.length; i++) {
    rows[i][4] = areaIdx(newAreaByRowIdx[i]);
  }
  puls.w = newAreas;

  fs.writeFileSync(PULS_PATH, JSON.stringify(puls));
  console.log(`\nSkrevet: ${PULS_PATH}`);
}

main();
