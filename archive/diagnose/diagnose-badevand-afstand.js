// ═══════════════════════════════════════════════════════════════════════════
// diagnose-badevand-afstand.js — kør fra repo-roden: node diagnose-badevand-afstand.js
// ═══════════════════════════════════════════════════════════════════════════
//
// For hvert badested i kategori B (intet geometrisk match, se
// diagnose-badevand.js) måles afstanden til nærmeste kendte sø-/kystvand-
// polygon-kant eller vandløbslinje. Afgør om de 206 er "lige-uden-for-
// bufferzonen" (bufferzone-fix) eller reelt langt fra al kendt geometri
// (datamangel — kræver nye/flere geometrier, ikke en justeret bufferzone).
//
// PERFORMANCE: bruger bbox-afstand som billigt forfilter (top ~15 nærmeste
// kandidater pr. badested), og beregner kun præcis kant-/linjeafstand for
// dem — undgår O(206 × alle ~6000 features × alle deres segmenter).
'use strict';

const fs = require('fs');
const path = require('path');
const waterClass = require('./water-classification');

const STATIC_DIR = __dirname;
const WATERBODY_MATCH_BUFFER_DEG = 0.003;
const VANDLOB_BUFFER_DEG = 0.0009;

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`Kunne ikke indlæse ${p} — ${e.message}`); return fallback; }
}

const soeerGeojson    = loadJson(path.join(STATIC_DIR, 'vp3_soeer.geojson'), { features: [] });
const kystvandGeojson = loadJson(path.join(STATIC_DIR, 'vp3_kystvande_simplified.geojson'), { features: [] });
const badevandGeojson = loadJson(path.join(STATIC_DIR, 'vp3_badevand.geojson'), { features: [] });
const vandlobDisplay  = loadJson(path.join(STATIC_DIR, 'vandlob-display.json'), []);
const vandlobUpstream = loadJson(path.join(STATIC_DIR, 'vandlob-upstream-matches.json'), []);
const vandlobUpstreamByIndex = {};
for (const entry of vandlobUpstream) vandlobUpstreamByIndex[entry.index] = entry;

const lakeFeatures = (soeerGeojson.features || []).map(f => ({
  navn: f.properties?.ov_navn || f.properties?.navn || 'Sø',
  type: 'sø', geometry: f.geometry, bbox: waterClass.computeGeometryBbox(f.geometry),
}));
const kystvandFeatures = (kystvandGeojson.features || []).map(f => ({
  navn: f.properties?.ov_navn || f.properties?.ov_id || 'Kystvand',
  type: 'kystvand', geometry: f.geometry, bbox: waterClass.computeGeometryBbox(f.geometry),
}));
const vandlobEntries = [];
for (const entry of vandlobDisplay) {
  const match = vandlobUpstreamByIndex[entry.index];
  if (!match || !match.pulsPointIds || match.pulsPointIds.length === 0) continue;
  const geometry = { type: 'LineString', coordinates: entry.coords.map(([lat, lng]) => [lng, lat]) };
  vandlobEntries.push({ navn: 'Vandløb', type: 'vandløb', geometry, bbox: waterClass.computeGeometryBbox(geometry) });
}
const allFeatures = [...lakeFeatures, ...kystvandFeatures, ...vandlobEntries];

function bboxDistDeg(lat, lng, b) {
  const dLat = lat < b.minLat ? b.minLat - lat : lat > b.maxLat ? lat - b.maxLat : 0;
  const dLng = lng < b.minLng ? b.minLng - lng : lng > b.maxLng ? lng - b.maxLng : 0;
  return Math.hypot(dLat, dLng);
}

function distToSegment(lat, lng, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(lng - x1, lat - y1);
  let t = ((lng - x1) * dx + (lat - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(lng - (x1 + t * dx), lat - (y1 + t * dy));
}

// Præcis min-afstand (grader) fra punkt til geometriens kant/linje.
function exactDistDeg(lat, lng, geometry) {
  let min = Infinity;
  function walkLine(coords) {
    for (let i = 0; i < coords.length - 1; i++) {
      const d = distToSegment(lat, lng, coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
      if (d < min) min = d;
    }
  }
  function walkRing(ring) { walkLine(ring); }
  function walkPolygon(coords) { coords.forEach(walkRing); }
  if (geometry.type === 'Polygon') walkPolygon(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(walkPolygon);
  else if (geometry.type === 'LineString') walkLine(geometry.coordinates);
  else if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(walkLine);
  return min;
}

const DEG_TO_M = 111320; // ~ ved danske breddegrader, nok til bucket-inddeling

// ── Find kategori B: samme matching som diagnose-badevand.js, uden matchdata-tjek ──
const badevandFeatures = (badevandGeojson.features || []).filter(f => f.geometry?.type === 'Point');
const unmatched = [];
for (const feat of badevandFeatures) {
  const [lng, lat] = feat.geometry.coordinates;
  const props = feat.properties || {};
  let matched = false;
  for (const f of allFeatures) {
    const b = f.bbox;
    const buf = f.type === 'vandløb' ? VANDLOB_BUFFER_DEG : WATERBODY_MATCH_BUFFER_DEG;
    if (lat < b.minLat - buf || lat > b.maxLat + buf || lng < b.minLng - buf || lng > b.maxLng + buf) continue;
    const hit = f.type === 'vandløb' ? waterClass.pointNearLine(lat, lng, f.geometry, buf) : waterClass.pointInGeometry(lat, lng, f.geometry);
    if (hit) { matched = true; break; }
  }
  if (!matched) unmatched.push({ id: props.bathingwat ?? props.id, navn: props.nametext ?? '?', lat, lng });
}
console.log(`${unmatched.length} badesteder uden geometrisk match — måler afstand til nærmeste kendte geometri...`);

const buckets = { '<100m': 0, '100m-500m': 0, '500m-2km': 0, '2km-10km': 0, '>10km': 0 };
const results = [];
for (const pt of unmatched) {
  const candidates = allFeatures
    .map(f => ({ f, bboxDist: bboxDistDeg(pt.lat, pt.lng, f.bbox) }))
    .sort((a, b) => a.bboxDist - b.bboxDist)
    .slice(0, 15);
  let bestM = Infinity, bestNavn = '?', bestType = '?';
  for (const { f } of candidates) {
    const dDeg = exactDistDeg(pt.lat, pt.lng, f.geometry);
    const dM = dDeg * DEG_TO_M;
    if (dM < bestM) { bestM = dM; bestNavn = f.navn; bestType = f.type; }
  }
  results.push({ ...pt, distM: bestM, nearest: bestNavn, nearestType: bestType });
  if (bestM < 100) buckets['<100m']++;
  else if (bestM < 500) buckets['100m-500m']++;
  else if (bestM < 2000) buckets['500m-2km']++;
  else if (bestM < 10000) buckets['2km-10km']++;
  else buckets['>10km']++;
}

console.log('\nAfstandsfordeling til nærmeste kendte sø/kystvand/vandløb-geometri:');
for (const [range, n] of Object.entries(buckets)) {
  console.log(`  ${range.padEnd(10)} ${n}`);
}

console.log('\nDe 15 tætteste (mest sandsynlige bufferzone-/simplificeringsfejl):');
results.sort((a, b) => a.distM - b.distM).slice(0, 15).forEach(r => {
  console.log(`  ${Math.round(r.distM).toString().padStart(6)} m  ${r.navn} → nærmest: ${r.nearest} (${r.nearestType})`);
});

console.log('\nDe 15 fjerneste (mest sandsynlige reelle datamangel):');
results.sort((a, b) => b.distM - a.distM).slice(0, 15).forEach(r => {
  console.log(`  ${Math.round(r.distM).toString().padStart(6)} m  ${r.navn} → nærmest: ${r.nearest} (${r.nearestType})`);
});
