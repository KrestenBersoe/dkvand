#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// add-puls-outlet-type.js — tilføjer udløbstype (RBU regn/Kloak) til
// puls-data.json's rækker.
//
// Miljøportalens live puls:Regnbetingedeudloeb-lag har et "Type"-felt på
// HVERT udløb ("Separat regnvand..." vs. "Overløbsbygværk..." — regnvands-
// udløb hhv. fælleskloak-/overløbsbygværker), som update-puls.js's egen
// stamdata-hentning (TYPENAME_STAMDATA = 'puls:rbu_punkt') aldrig har
// medtaget — det feltnavn findes ikke længere på WFS-endpointet
// (bekræftet: GetFeature på 'puls:rbu_punkt' fejler nu med "unknown feature
// type"; GetCapabilities lister kun 'puls:Regnbetingedeudloeb'). Det er
// desuden en ANDEN feltskematik end den update-puls.js's merge() forventer
// (engelske PascalCase-felter, intet vandområde/recipient-felt) — at rette
// update-puls.js's hovedpipeline til det er et separat, større arbejde
// (ville kræve at genfinde vandområde-tilknytningen et andet sted) og røres
// IKKE her.
//
// Dette script gør kun ÉN ting: matcher hver eksisterende række i
// puls-data.json til det live lag på navn + nærmeste koordinat, og
// tilføjer klassifikationen som et 9. array-felt. Alt andet i filen
// (lat/lng/navn/kommune/vandområde/volumen/hændelser/kvalitet) røres ikke.
//
// Matchrate verificeret manuelt: 21.470/21.556 rækker (99,6%) matcher
// sikkert (samme navn + < ~1 km); resten får outletType=null (ukendt)
// fremfor et gæt.
//
// Brug:
//   node add-puls-outlet-type.js               (skriver til ./puls-data.json)
//   node add-puls-outlet-type.js --dry-run      (printer statistik uden at skrive)
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const LIVE_WFS =
  'https://pulsgeo.miljoeportal.dk/geoserver/wfs?service=WFS&version=2.0.0' +
  '&request=GetFeature&typeNames=puls:Regnbetingedeudloeb' +
  '&outputFormat=application/json&srsName=EPSG:4326&propertyName=Name,Type,Closed';

const DATA_FILE = path.join(__dirname, 'puls-data.json');
const DRY_RUN   = process.argv.includes('--dry-run');

// Matchtolerance — samme størrelsesorden som update-puls.js/appens egne
// "samme fysiske udløb"-tjek (der bruger < 50 m for et sikkert match); her
// bruges en lidt rummeligere gradtolerance for at tåle mindre koordinat-
// afvigelser mellem det gamle og det nuværende WFS-lag.
const MAX_DEG = 0.01;  // ≈ 1 km

function fetchJson(u) {
  return new Promise((resolve, reject) => {
    https.get(u, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return; }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON-parse fejl: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// 0 = RBU regn (separat regnvandsudløb), 1 = RBU Kloak (overløbsbygværk/
// fælleskloak), 2 = andet
function classify(type) {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes('separat regnvand'))  return 0;
  if (t.includes('overløbsbygværk'))   return 1;
  return 2;
}

async function main() {
  console.log('Henter live Regnbetingedeudloeb-lag fra Miljøportalen…');
  const live = await fetchJson(LIVE_WFS);
  const features = live.features || [];
  console.log(`  ${features.length} features hentet (aktive + nedlagte)`);

  // Kun aktive udløb — Closed==='Aktivt' er den faktiske værdi feltet
  // bruger for et ikke-nedlagt udløb (ikke tom streng/null).
  const byName = new Map();  // navn (lowercase, trimmet) → [{lat,lng,type}]
  for (const f of features) {
    if (f.properties?.Closed !== 'Aktivt') continue;
    const name = (f.properties?.Name || '').trim().toLowerCase();
    if (!name) continue;
    const [lng, lat] = f.geometry?.coordinates || [];
    if (lat == null || lng == null) continue;
    let bucket = byName.get(name);
    if (!bucket) { bucket = []; byName.set(name, bucket); }
    bucket.push({ lat, lng, type: f.properties.Type });
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const counts = { regn: 0, kloak: 0, andet: 0, ukendt: 0 };

  data.d = data.d.map(row => {
    const [lat, lng, navn] = row;
    const candidates = byName.get(String(navn).trim().toLowerCase());
    let type = null;
    if (candidates) {
      let best = null, bestDist = Infinity;
      for (const c of candidates) {
        const d = Math.hypot(c.lat - lat, c.lng - lng);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (best && bestDist < MAX_DEG) type = classify(best.type);
    }
    counts[type === 0 ? 'regn' : type === 1 ? 'kloak' : type === 2 ? 'andet' : 'ukendt']++;
    return [...row, type];
  });

  console.log(`\nUdløbstype (${data.d.length} rækker):`);
  console.log(`  RBU regn:  ${counts.regn.toLocaleString('da')}`);
  console.log(`  RBU Kloak: ${counts.kloak.toLocaleString('da')}`);
  console.log(`  Andet:     ${counts.andet.toLocaleString('da')}`);
  console.log(`  Ukendt:    ${counts.ukendt.toLocaleString('da')}`);

  if (DRY_RUN) { console.log('\n(dry-run — intet skrevet)'); return; }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  console.log(`\nSkrevet: ${DATA_FILE}`);
}

main().catch(e => { console.error('FEJL:', e.message); process.exit(1); });
