// ═══════════════════════════════════════════════════════════════════════════
// diagnose-tekstmatch-fejl.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const STATIC_DIR = __dirname;

const kystvandGeojson = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'vp3_kystvande_simplified.geojson'), 'utf8'));
const riskModel = require('./risk-model');
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const areas = raw.w || [];
const rows = raw.d || raw;

// Find Lillebælt, Bredningen-polygonen
const feat = (kystvandGeojson.features || []).find(f => (f.properties?.ov_navn || '').toLowerCase().includes('bredningen') && (f.properties?.ov_navn || '').toLowerCase().includes('lillebælt'));
if (!feat) { console.log('Fandt ikke "Lillebælt, Bredningen" — prøver løsere søgning:'); 
  const candidates = (kystvandGeojson.features||[]).filter(f=>/lillebælt/i.test(f.properties?.ov_navn||''));
  console.log(candidates.map(f=>f.properties.ov_navn));
  process.exit(1);
}
const ovNavn = feat.properties.ov_navn;
const c = String(ovNavn).toLowerCase().trim();
console.log('Polygonens ov_navn (rå):', JSON.stringify(ovNavn));
console.log('Efter toLowerCase().trim():', JSON.stringify(c));
console.log('Char codes:', [...c].map(ch => ch.codePointAt(0)).join(','));
console.log('');

// Find alle unikke waterArea-varianter der indeholder "lillebælt" (case-insensitive, løs regex)
const variants = new Set();
for (const r of rows) {
  const a = areas[r[4]];
  if (a && /lillebæ|lillebae|lillebälte/i.test(a)) variants.add(a);
}
console.log(`${variants.size} waterArea-varianter fundet der ligner "Lillebælt":`);
for (const v of variants) {
  const key = String(v).toLowerCase().trim();
  const includesTest1 = c.includes(key);
  const includesTest2 = key.includes(c);
  console.log(`  "${v}" → key="${JSON.stringify(key)}" → c.includes(key)=${includesTest1}  key.includes(c)=${includesTest2}`);
  if (!includesTest1 && !includesTest2) {
    console.log(`    ⚠ INGEN MATCH — char codes for key: [${[...key].map(ch=>ch.codePointAt(0)).join(',')}]`);
  }
}
