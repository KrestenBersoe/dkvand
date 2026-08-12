// ═══════════════════════════════════════════════════════════════════════════
// diagnose-manglende-badesteder.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
//
// FORUDSÆTTER: en frisk kopi af den LIVE badevand-risk-respons gemt lokalt:
//   curl -s https://ditbadevand.dk/api/badevand-risk > badevand-risk-live.json
//
// For hvert badested med source==='ingen' findes:
//   1. noDataMatch — hvilken sø/kystvand det geometrisk matcher (hvis nogen)
//   2. De 5 NÆRMESTE faktiske PULS-udløb, UANSET waterArea-tekst — dette er
//      det afgørende tjek: hvis der findes udløb 200 m væk, som blot aldrig
//      blev tekstmatchet, er "ingen data" en fejl i matchlogikken. Hvis de
//      nærmeste udløb er 15+ km væk, er "ingen data" en reel, korrekt
//      afspejling af, at der ikke findes kendte udledninger i nærheden.
'use strict';

const fs = require('fs');
const path = require('path');
const STATIC_DIR = __dirname;

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn(`Kunne ikke indlæse ${p} — ${e.message}`); return fallback; }
}

const badevandRisk = loadJson(path.join(STATIC_DIR, 'badevand-risk-live.json'), null);
if (!badevandRisk) {
  console.log('Mangler badevand-risk-live.json — kør først:');
  console.log('  curl -s https://ditbadevand.dk/api/badevand-risk > badevand-risk-live.json');
  process.exit(1);
}

const riskModel = require('./risk-model');
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const areas = raw.w || [];
const rows = raw.d || raw;
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  const areaIdx = r[4];
  return { id: i, name: derived.name || `Udløb ${i}`, waterArea: areas[areaIdx] || 'Ukendt', lat: derived.lat, lng: derived.lng };
}).filter(p => p.lat != null && p.lng != null);

const badevandGeojson = loadJson(path.join(STATIC_DIR, 'vp3_badevand.geojson'), { features: [] });
const navnById = {};
for (const f of badevandGeojson.features || []) {
  navnById[f.properties?.bathingwat] = { navn: f.properties?.nametext, coords: f.geometry.coordinates };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const missing = (badevandRisk.badevand || []).filter(b => b.source === 'ingen');
console.log(`${missing.length} badesteder uden data.\n`);

// Sorterer efter afstand til nærmeste udløb — mest mistænkelige (nære udløb, men alligevel "ingen data") først
const results = missing.map(b => {
  const meta = navnById[b.id] || {};
  const [lng, lat] = meta.coords || [null, null];
  if (lat == null) return { id: b.id, navn: meta.navn || '?', fejl: 'ingen koordinat fundet' };
  const withDist = points.map(p => ({ ...p, distKm: haversineKm(lat, lng, p.lat, p.lng) }))
    .sort((a, b2) => a.distKm - b2.distKm)
    .slice(0, 5);
  return {
    id: b.id, navn: meta.navn || '?', lat, lng,
    noDataMatch: b.noDataMatch,
    naermesteUdloeb: withDist,
  };
});

results.sort((a, b) => (a.naermesteUdloeb?.[0]?.distKm ?? 9999) - (b.naermesteUdloeb?.[0]?.distKm ?? 9999));

console.log('── Sorteret efter afstand til nærmeste udløb (mest mistænkelige først) ──\n');
for (const r of results) {
  if (r.fejl) { console.log(`${r.id} (${r.navn}): ${r.fejl}\n`); continue; }
  const nm = r.noDataMatch ? `${r.noDataMatch.type} "${r.noDataMatch.navn}"` : 'intet geometrisk match';
  console.log(`${r.id} — ${r.navn}  [${nm}]`);
  for (const u of r.naermesteUdloeb) {
    console.log(`    ${u.distKm.toFixed(2)} km  ${u.name.padEnd(14)} waterArea="${u.waterArea}"`);
  }
  console.log('');
}

const under1km = results.filter(r => r.naermesteUdloeb?.[0]?.distKm < 1).length;
const under5km = results.filter(r => r.naermesteUdloeb?.[0]?.distKm < 5).length;
const over15km = results.filter(r => r.naermesteUdloeb?.[0]?.distKm >= 15).length;
console.log('── Opsummering ──');
console.log(`  Nærmeste udløb <1 km væk (stærk mistanke om match-fejl): ${under1km}`);
console.log(`  Nærmeste udløb <5 km væk (mulig match-fejl):            ${under5km}`);
console.log(`  Nærmeste udløb ≥15 km væk (sandsynligvis reel mangel):  ${over15km}`);
