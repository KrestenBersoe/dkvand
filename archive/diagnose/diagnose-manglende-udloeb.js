// ═══════════════════════════════════════════════════════════════════════════
// diagnose-manglende-udloeb.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const STATIC_DIR = __dirname;

const riskModel = require('./risk-model');
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const areas = raw.w || [];
const rows = raw.d || raw;
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  return { id: i, name: derived.name || `Udløb ${i}`, waterArea: areas[r[4]] || 'Ukendt', lat: derived.lat, lng: derived.lng };
});

const targets = ['RUD87', 'RUD81', 'RUD80', 'RUD79', 'LJR0109', 'LLR0109', 'LLR0902'];
for (const t of targets) {
  const matches = points.filter(p => p.name === t);
  if (matches.length === 0) {
    console.log(`${t}: FINDES IKKE i PULS-data overhovedet (hverken navn eller nogen variant)`);
    continue;
  }
  for (const m of matches) {
    console.log(`${t}: waterArea="${m.waterArea}"  lat/lng=${m.lat},${m.lng}`);
  }
}
