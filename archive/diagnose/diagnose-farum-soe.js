// ═══════════════════════════════════════════════════════════════════════════
// diagnose-farum-soe.js — kør fra repo-roden: node diagnose-farum-soe.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Sporer PRÆCIS hvordan VD-U57, VD-U53, VD-U52 (bekræftet nedstrøms for
// Doktorens Bugt) bidrager til "Farum Sø"s samlede score i badevand-risk.js
// — via RBU-kobling (Trin 0), navnematch på waterArea (Trin 1), eller ID15 +
// rejsetid (Trin 0,5). De tre kræver forskellige rettelser:
//   RBU        → myndighedsfastsat kobling, kan ikke "rettes" uden at
//                anfægte selve myndighedsdata — kræver whitelist/exclusion.
//   Navnematch → ren tekstmatch, ingen retning/position — nemmest at
//                begrænse eller fjerne for store søer med flere bugte.
//   ID15       → HAR rejsetid, men ingen retning i søen — forklarer hvorfor
//                "nedstrøms" stadig tæller: modellen har intet begreb om
//                retning inden i en sø, kun forsinkelse.
'use strict';

const fs = require('fs');
const path = require('path');
const STATIC_DIR = __dirname;

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

const riskModel = require('./risk-model');
const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8'));
const auths = raw.a || [];
const areas = raw.w || [];
const rows  = raw.d || raw;
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  const [, , , authIdx, areaIdx] = r;
  return { id: i, name: derived.name || `Udløb ${i}`, waterArea: areas[areaIdx] || 'Ukendt', lat: derived.lat, lng: derived.lng };
});

const TARGETS = ['VD-U57', 'VD-U53', 'VD-U52'];
const LAKE = 'Farum Sø';

console.log(`Søger efter ${TARGETS.join(', ')} blandt ${points.length} PULS-punkter...\n`);
const targetPoints = points.filter(p => TARGETS.some(t => p.name.includes(t)));
if (targetPoints.length === 0) {
  console.log('INGEN af de tre ID\'er fundet i PULS-punkternes navnefelt. De optræder muligvis under et andet navneformat — send et par fulde eksempler på pt.name for punkter nær Doktorens Bugt, så kan matchen justeres.');
} else {
  targetPoints.forEach(p => console.log(`  fundet: id=${p.id}  navn="${p.name}"  waterArea="${p.waterArea}"  lat/lng=${p.lat},${p.lng}`));
}

// ── Trin 0: RBU ───────────────────────────────────────────────────────────
const rbuLakeLinks = loadJson(path.join(STATIC_DIR, 'rbu-lake-links.json'), {});
console.log('\n── Trin 0 (RBU-koblinger) ──');
for (const p of targetPoints) {
  const soeNavn = rbuLakeLinks[String(p.name || '').toLowerCase()];
  console.log(`  ${p.name}: ${soeNavn ? `RBU-koblet til "${soeNavn}"` : 'ingen RBU-kobling'}`);
}

// ── Trin 1: navnematch ───────────────────────────────────────────────────
console.log('\n── Trin 1 (navnematch på waterArea) ──');
const lakeKey = normSoeName(LAKE);
for (const p of targetPoints) {
  const raw2 = p.waterArea || '';
  if (!raw2 || !/sø/i.test(raw2)) { console.log(`  ${p.name}: waterArea "${raw2}" indeholder ikke "sø" — udelukket fra navnematch`); continue; }
  const key = normSoeName(stripPulsRecipientPrefix(raw2));
  console.log(`  ${p.name}: waterArea="${raw2}" → normaliseret="${key}" ${key === lakeKey ? '★ MATCHER "Farum Sø"' : '(matcher ikke)'}`);
}

// ── Trin 0,5: ID15 + rejsetid ────────────────────────────────────────────
console.log('\n── Trin 0,5 (ID15 + rejsetid) ──');
const id15LakeMatches = loadJson(path.join(STATIC_DIR, 'id15-lake-matches.json'), {});
const entry = id15LakeMatches[LAKE];
if (!entry || !entry.pulsPoints) {
  console.log(`  Intet ID15-opslag for "${LAKE}" overhovedet.`);
} else {
  for (const p of targetPoints) {
    const match = entry.pulsPoints.find(e => e.id === p.id);
    console.log(`  ${p.name} (id=${p.id}): ${match ? `★ I ID15-listen, rejsetid=${match.travelTimeHours}t` : 'ikke i ID15-listen for Farum Sø'}`);
  }
  console.log(`  (Farum Sø har i alt ${entry.pulsPoints.length} ID15-koblede punkter)`);
}

console.log('\n── Konklusion ──');
console.log('Se ★-markeringerne ovenfor — de viser præcis hvilke(n) kilde(r) der reelt trækker VD-U57/53/52 ind i Farum Søs samlede score.');
