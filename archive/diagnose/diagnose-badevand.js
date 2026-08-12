// ═══════════════════════════════════════════════════════════════════════════
// diagnose-badevand.js — kør fra repo-roden: node diagnose-badevand.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Splitter de 229 "source: ingen"-badesteder (se /api/badevand-risk) i to
// reelt forskellige kategorier, som selve API-svaret ikke skelner mellem:
//
//   A) GEOMETRI MATCHER, MEN INGEN MATCHDATA — badestedet ligger i en sø/
//      kystvand/vandløb-geometri, men den sø/kystvand/vandløb har INGEN
//      forbindelse overhovedet til noget PULS-udløb i RBU-koblinger,
//      ID15-matches eller navnematch. Strukturel datamangel — vil ALDRIG
//      få data, uanset vejr, før selve matchdata rettes/udvides.
//   B) INTET GEOMETRISK MATCH — badestedet ligger uden for alle kendte
//      sø-/kystvand-/vandløbsgeometrier. Enten en datamangel i selve
//      geometrifilerne, eller badestedet ligger i et andet vandsystem end
//      de tre vi tjekker (fx havn/dam ikke dækket af VP3).
//
// Bevidst UDELADT: faktiske risikoscorer (kræver vejrdata + weather-cache,
// kun tilgængeligt on-server). Det er ikke nødvendigt her — hvis der slet
// ingen matchdata findes for et vandområde, vil det ALTID ende som "ingen
// data", uanset vejret. Denne test finder derfor det STRUKTURELLE problem,
// ikke midlertidige mangler.
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

function normSoeName(s) {
  return String(s || '').toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function stripPulsRecipientPrefix(s) {
  let t = String(s || '');
  t = t.replace(/^\d+(\.\d+)*\s*-?\s*/i, '');
  t = t.replace(/^afl[øo]b(et)?\s+(fra|til)\s+/i, '');
  t = t.replace(/^udl[øo]b(et)?\s+(fra|til)\s+/i, '');
  t = t.replace(/^tilb?l[øo]b(et)?\s+(fra|til)\s+/i, '');
  return t.trim();
}

// ── PULS-punkter (kun navn/waterArea/id — ingen risikoberegning nødvendig) ──
const riskModel = require('./risk-model');
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const auths = raw.a || [];
const areas = raw.w || [];
const rows  = raw.d || raw;
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  const [, , , authIdx, areaIdx] = r;
  return { id: i, name: derived.name || `Udløb ${i}`, waterArea: areas[areaIdx] || 'Ukendt' };
});
console.log(`${points.length} PULS-punkter indlæst (kun navn/waterArea, ingen risikoberegning)`);

const rbuLakeLinks        = loadJson(path.join(STATIC_DIR, 'rbu-lake-links.json'), {});
const id15LakeMatches     = loadJson(path.join(STATIC_DIR, 'id15-lake-matches.json'), {});
const id15KystvandMatches = loadJson(path.join(STATIC_DIR, 'id15-kystvand-matches.json'), {});
const soeerGeojson        = loadJson(path.join(STATIC_DIR, 'vp3_soeer.geojson'), { features: [] });
const kystvandGeojson     = loadJson(path.join(STATIC_DIR, 'vp3_kystvande_simplified.geojson'), { features: [] });
const badevandGeojson     = loadJson(path.join(STATIC_DIR, 'vp3_badevand.geojson'), { features: [] });
const vandlobDisplay      = loadJson(path.join(STATIC_DIR, 'vandlob-display.json'), []);
const vandlobUpstream     = loadJson(path.join(STATIC_DIR, 'vandlob-upstream-matches.json'), []);
const vandlobUpstreamByIndex = {};
for (const entry of vandlobUpstream) vandlobUpstreamByIndex[entry.index] = entry;

// ── Har denne sø/kystvand/vandløb NOGEN matchdatakilde? (uanset scoreværdi) ──
const rbuNames  = new Set(Object.values(rbuLakeLinks).map(normSoeName));
const nameMatchNames = new Set();
for (const pt of points) {
  const raw2 = pt.waterArea || '';
  if (!raw2 || !/sø/i.test(raw2)) continue;
  const key = normSoeName(stripPulsRecipientPrefix(raw2));
  if (key) nameMatchNames.add(key);
}

function lakeHasAnyMatch(navn) {
  const key = normSoeName(navn);
  if (rbuNames.has(key)) return true;
  if (nameMatchNames.has(key)) return true;
  const e = id15LakeMatches[navn];
  if (e && e.pulsPoints && e.pulsPoints.length > 0) return true;
  return false;
}

const areaKeys = new Set();
for (const pt of points) { const k = (pt.waterArea || '').toLowerCase().trim(); if (k) areaKeys.add(k); }
function kystvandHasAnyMatch(props) {
  const candidates = [props.ov_navn, props.ov_id, props.ho_na].filter(Boolean).map(s => String(s).toLowerCase().trim());
  for (const c of candidates) {
    for (const key of areaKeys) { if (key.includes(c) || c.includes(key)) return true; }
  }
  const e = id15KystvandMatches[props.ov_id];
  return !!(e && e.pulsPointIds && e.pulsPointIds.length > 0);
}

const lakeFeatures = (soeerGeojson.features || []).map(f => ({
  navn: f.properties?.ov_navn || f.properties?.navn || 'Sø',
  geometry: f.geometry, bbox: waterClass.computeGeometryBbox(f.geometry),
  hasMatch: lakeHasAnyMatch(f.properties?.ov_navn || f.properties?.navn || 'Sø'),
}));
const kystvandFeatures = (kystvandGeojson.features || []).map(f => ({
  navn: f.properties?.ov_navn || f.properties?.ov_id || 'Kystvand',
  geometry: f.geometry, bbox: waterClass.computeGeometryBbox(f.geometry),
  hasMatch: kystvandHasAnyMatch(f.properties || {}),
}));
const vandlobEntries = [];
for (const entry of vandlobDisplay) {
  const match = vandlobUpstreamByIndex[entry.index];
  if (!match || !match.pulsPointIds || match.pulsPointIds.length === 0) continue;
  const geometry = { type: 'LineString', coordinates: entry.coords.map(([lat, lng]) => [lng, lat]) };
  vandlobEntries.push({ geometry, bbox: waterClass.computeGeometryBbox(geometry) });
}

// ── Badesteder ────────────────────────────────────────────────────────────
const badevandFeatures = (badevandGeojson.features || []).filter(f => f.geometry?.type === 'Point');
let matchedWithData = 0, matchedNoData = 0, noGeomMatch = 0;
const noDataNames = new Map(); // navn -> antal badesteder ramt

for (const feat of badevandFeatures) {
  const [lng, lat] = feat.geometry.coordinates;
  let matched = null;

  for (const lake of lakeFeatures) {
    const b = lake.bbox;
    if (lat < b.minLat - WATERBODY_MATCH_BUFFER_DEG || lat > b.maxLat + WATERBODY_MATCH_BUFFER_DEG ||
        lng < b.minLng - WATERBODY_MATCH_BUFFER_DEG || lng > b.maxLng + WATERBODY_MATCH_BUFFER_DEG) continue;
    if (waterClass.pointInGeometry(lat, lng, lake.geometry)) { matched = lake; break; }
  }
  if (!matched) {
    for (const k of kystvandFeatures) {
      const b = k.bbox;
      if (lat < b.minLat - WATERBODY_MATCH_BUFFER_DEG || lat > b.maxLat + WATERBODY_MATCH_BUFFER_DEG ||
          lng < b.minLng - WATERBODY_MATCH_BUFFER_DEG || lng > b.maxLng + WATERBODY_MATCH_BUFFER_DEG) continue;
      if (waterClass.pointInGeometry(lat, lng, k.geometry)) { matched = k; break; }
    }
  }
  if (!matched) {
    for (const v of vandlobEntries) {
      const b = v.bbox;
      if (lat < b.minLat - VANDLOB_BUFFER_DEG || lat > b.maxLat + VANDLOB_BUFFER_DEG ||
          lng < b.minLng - VANDLOB_BUFFER_DEG || lng > b.maxLng + VANDLOB_BUFFER_DEG) continue;
      if (waterClass.pointNearLine(lat, lng, v.geometry, VANDLOB_BUFFER_DEG)) { matched = { hasMatch: true, navn: 'Vandløb' }; break; }
    }
  }

  if (!matched) { noGeomMatch++; continue; }
  if (matched.hasMatch) { matchedWithData++; continue; }
  matchedNoData++;
  noDataNames.set(matched.navn, (noDataNames.get(matched.navn) || 0) + 1);
}

console.log(`\n${badevandFeatures.length} badesteder i alt:`);
console.log(`  A) Vandområde matchet, men INGEN matchdatakilde overhovedet: ${matchedNoData}`);
console.log(`  B) Intet geometrisk match i nogen sø/kystvand/vandløb-kilde:   ${noGeomMatch}`);
console.log(`  (til sammenligning: matchet MED datakilde, dvs. forventes at have en score): ${matchedWithData}`);

console.log(`\nTop vandområder i kategori A (flest ramte badesteder først):`);
[...noDataNames.entries()].sort((a, b) => b[1] - a[1]).forEach(([navn, n]) => {
  console.log(`  ${n.toString().padStart(4)}  ${navn}`);
});
