// ═══════════════════════════════════════════════════════════════════════════
// diagnose-id15-kystvand-daekning.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
// Tjekker om id15-kystvand-matches.json ALLEREDE har RUD87/81/80/79
// (Sejerø Bugt, DKCOAST28) og LJR0109/LLR0109/LLR0902 (Fakse Bugt,
// DKCOAST46) koblet korrekt — uafhængigt af tekstmatch-fejlen, som vi
// allerede har bekræftet IKKE kan fange dem (ingen tekstligt slægtskab
// mellem "Nekselø Bugt"/"Fakse Å" og de overordnede kystvandsnavne).
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
  return { id: i, name: derived.name || `Udløb ${i}`, waterArea: areas[r[4]] || 'Ukendt' };
});

const id15Kystvand = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'id15-kystvand-matches.json'), 'utf8'));

const cases = [
  { ovId: 'DKCOAST28', navn: 'Sejerø Bugt', targets: ['RUD87', 'RUD81', 'RUD80', 'RUD79'] },
  { ovId: 'DKCOAST46', navn: 'Fakse Bugt',  targets: ['LJR0109', 'LLR0109', 'LLR0902'] },
];

for (const c of cases) {
  console.log(`\n── ${c.navn} (${c.ovId}) ──`);
  const entry = id15Kystvand[c.ovId];
  if (!entry) {
    console.log(`  Intet ID15-opslag overhovedet for ${c.ovId}.`);
    continue;
  }
  const pulsPointIds = entry.pulsPointIds || [];
  console.log(`  ID15 har ${pulsPointIds.length} koblede udløb i alt for dette kystvand.`);
  for (const t of c.targets) {
    const pt = points.find(p => p.name === t);
    if (!pt) { console.log(`  ${t}: findes ikke i PULS-data.`); continue; }
    const isLinked = pulsPointIds.includes(pt.id);
    console.log(`  ${t} (id=${pt.id}): ${isLinked ? '★ ALLEREDE KOBLET i ID15' : 'IKKE koblet i ID15'}`);
  }
}
