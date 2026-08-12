// ═══════════════════════════════════════════════════════════════════════════
// diagnose-dkcoast217.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const STATIC_DIR = __dirname;
const waterClass = require('./water-classification');

const kystvandGeojson = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'vp3_kystvande_simplified.geojson'), 'utf8'));
const riskModel = require('./risk-model');
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const areas = raw.w || [];
const auths = raw.a || [];
const rows = raw.d || raw;
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  return { id: i, name: derived.name || `Udløb ${i}`, waterArea: areas[r[4]] || 'Ukendt', lat: derived.lat, lng: derived.lng };
});

const feat = (kystvandGeojson.features || []).find(f => f.properties?.ov_id === 'DKCOAST217');
if (!feat) { console.log('Fandt ikke DKCOAST217.'); process.exit(1); }
console.log('DKCOAST217 fundet. ov_navn:', feat.properties.ov_navn);
console.log('Geometri-type:', feat.geometry?.type);
console.log('Antal koordinatringe:', feat.geometry?.coordinates?.length);
console.log('');

const uas03r = points.find(p => p.name === 'UAS03R');
if (!uas03r) { console.log('Fandt ikke UAS03R i PULS-punkterne.'); process.exit(1); }
console.log('UAS03R:', JSON.stringify(uas03r));
console.log('');

// Trin 1: er punktet inde i / nær polygonen? (samme test som badevand-matching bruger)
function isPointNearPolygonEdge(lat, lng, geometry, buf) {
  function distToSegment(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(lng - x1, lat - y1);
    let t = ((lng - x1) * dx + (lat - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(lng - (x1 + t * dx), lat - (y1 + t * dy));
  }
  let minDeg = Infinity;
  function walkRing(ring) {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = distToSegment(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
      if (d < minDeg) minDeg = d;
    }
  }
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(walkRing);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => poly.forEach(walkRing));
  return minDeg;
}

const inside = waterClass.pointInGeometry(uas03r.lat, uas03r.lng, feat.geometry);
console.log('UAS03R er STRENGT inde i DKCOAST217s polygon:', inside);
const minDegDist = isPointNearPolygonEdge(uas03r.lat, uas03r.lng, feat.geometry, Infinity);
const minMDist = minDegDist * 111320;
console.log('UAS03R afstand til DKCOAST217s nærmeste kant:', minMDist.toFixed(1), 'm  (grænse er 10.000 m)');
console.log('');

// Trin 2: matcher teksten? (nøjagtig samme logik som lookupAreaRecord)
const c1 = String(feat.properties.ov_navn || '').toLowerCase().trim();
const c2 = String(feat.properties.ov_id || '').toLowerCase().trim();
const key = String(uas03r.waterArea || '').toLowerCase().trim();
console.log('Kandidat 1 (ov_navn):', JSON.stringify(c1), '→ includes key?', c1.includes(key), ' key includes candidate?', key.includes(c1));
console.log('Kandidat 2 (ov_id):  ', JSON.stringify(c2), '→ includes key?', c2.includes(key), ' key includes candidate?', key.includes(c2));
console.log('UAS03R waterArea-nøgle:', JSON.stringify(key));
console.log('');

console.log('── Konklusion ──');
if (!c1.includes(key) && !key.includes(c1)) {
  console.log('Tekstmatch fejler for netop denne polygon — se kandidat/nøgle-strengene ovenfor for uoverensstemmelsen.');
} else if (minMDist > 10000) {
  console.log('Tekstmatch virker, men afstanden overstiger 10 km-grænsen — geometrien for DKCOAST217 er muligvis anderledes end forventet (fx dækker kun en lille del af det navngivne område).');
} else {
  console.log('Både tekstmatch OG afstand ser korrekte ud isoleret — fejlen sidder et andet sted i selve badevand-risk.js (fx en fejl i hvordan mergedIds samles på tværs af flere ov_navn/ov_id-kandidater, eller en Map-iterationsrækkefølge-effekt). Kræver at se på koden igen, ikke mere isoleret data-diagnostik.');
}
