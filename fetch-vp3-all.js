#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// fetch-vp3-all.js — henter ALLE fem VP3-lag appen bruger fra Miljøportalens
// WFS-tjeneste: kystvande, søer, vandløb, badevand og RBU-punkter.
//
// Udvidelse af det oprindelige fetch-vp3-water-layers.js (søer/vandløb) til
// at dække samtlige VP3-datakilder i én samlet, ensartet proces.
//
// Brug:
//   node fetch-vp3-all.js
//   node fetch-vp3-all.js --out ./data
//   node fetch-vp3-all.js --badevand-layer "vp3_2endelig2025:XXX" (manuel override, se nedenfor)
//
// Samme fremgangsmåde som det oprindelige script: henter FØRST WFS'ens
// GetCapabilities og leder selv efter de rigtige lag-navne — i stedet for
// at gætte på faste navne, som let kan ændre sig ved en dataopdatering.
// Hvis den automatiske søgning ikke finder præcis ét lag af en type,
// printes alle fundne VP3-lag, så du kan angive det korrekte navn manuelt
// via --<type>-layer.
//
// Output (rå, ikke-simplificerede filer — se update-all-data.sh for
// efterfølgende mapshaper-simplificering til de opløsninger appen bruger):
//   vp3_kystvande_raw.geojson   (polygoner)
//   vp3_soeer_raw.geojson       (polygoner)
//   vp3_vandlob_raw.geojson     (linjer)
//   vp3_badevand.geojson        (punkter — ingen simplificering nødvendig)
//   vp3_rbu_raw.geojson         (punkter — ingen simplificering nødvendig)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const WFS_BASE  = 'https://wfs2-miljoegis.mim.dk/ows';
const PAGE_SIZE = 2000;

const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}
const OUT_DIR = path.resolve(argVal('--out') || __dirname);

// Hver type: navnemønster til automatisk søgning + hvilken fil den skal gemmes som.
// RETTET: løs "indeholder nøgleord"-matching gav flere kandidater end
// forventet i praksis (fx "soe_hoved_ind_p"/"_t" — hovedindløbspunkter, ikke
// selve søen; "marin_samlet_1mil" — en anden afgrænsning end hovedlaget).
// De rigtige, samlede geometrilag følger konsekvent et "_samlet"/"_saml"-
// SLUTNINGSMØNSTER — matcher nu specifikt på det, verificeret mod den
// fulde kandidatliste fra en reel GetCapabilities-forespørgsel.
const LAYER_TYPES = [
  { key: 'kystvande', pattern: /marin_samlet$/i,   excludePattern: /(?!)/, outFile: 'vp3_kystvande_raw.geojson' },
  { key: 'soeer',     pattern: /soe_samlet$/i,      excludePattern: /(?!)/, outFile: 'vp3_soeer_raw.geojson' },
  { key: 'vandlob',   pattern: /vandloeb_samlet$/i, excludePattern: /(?!)/, outFile: 'vp3_vandlob_raw.geojson' },
  { key: 'badevand',  pattern: /badevand$/i,        excludePattern: /(?!)/, outFile: 'vp3_badevand.geojson' },
  { key: 'rbu',       pattern: /rbu_saml$/i,        excludePattern: /(?!)/, outFile: 'vp3_rbu_raw.geojson' },
];

// ── HTTP hjælpefunktion ──────────────────────────────────────────────────────
function fetchUrl(rawUrl, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, { headers: { 'Accept': '*/*' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function discoverLayerNames() {
  const url = `${WFS_BASE}?service=WFS&version=2.0.0&request=GetCapabilities`;
  console.log('Henter GetCapabilities fra', url, '…');
  const xml = await fetchUrl(url, 30000);
  const names = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
  const vp3Names = names.filter(n => n.toLowerCase().includes('vp3'));
  console.log(`Fandt ${names.length} lag i alt, ${vp3Names.length} under VP3.\n`);
  return vp3Names;
}

function buildWfsUrl(typename, startIndex = 0) {
  return `${WFS_BASE}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(typename)}` +
    `&outputFormat=application%2Fjson` +
    `&srsName=EPSG%3A4326` +
    `&count=${PAGE_SIZE}&startIndex=${startIndex}`;
}

async function fetchAllFeatures(typename) {
  const features = [];
  let start = 0, total = null;
  process.stdout.write(`  Henter ${typename}:`);
  while (true) {
    const wfsUrl = buildWfsUrl(typename, start);
    let body;
    try {
      body = await fetchUrl(wfsUrl, 60000);
    } catch (e) {
      throw new Error(`WFS-fejl ved ${typename} (start=${start}): ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`JSON-parse fejl (start=${start}): ${body.slice(0, 300)}`);
    }
    if (parsed.exceptions || parsed.ExceptionReport) {
      throw new Error(`WFS Exception: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    const batch = parsed.features || [];
    if (total === null) total = parsed.totalFeatures ?? parsed.numberMatched ?? '?';
    features.push(...batch);
    process.stdout.write(` ${features.length}/${total}`);
    if (batch.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  console.log(' ✓');
  return features;
}

(async () => {
  try {
    const vp3Names = await discoverLayerNames();
    const results = {};
    const problems = [];

    for (const type of LAYER_TYPES) {
      const manualOverride = argVal(`--${type.key}-layer`);
      let candidates = vp3Names.filter(n => type.pattern.test(n) && !type.excludePattern.test(n));

      // RETTET: WFS-kataloget indeholder flere ÅRGANGE af samme lag-type
      // side om side (2019, 2021, 2022, 2024, 2025 — historiske
      // planversioner er bevaret) — det gjorde at næsten alle typer fik
      // flere kandidater, selvom kun én reelt er den aktuelle/endelige. Er
      // "vp3_2endelig2025:"-arbejdsområdet blandt kandidaterne, foretrækkes
      // det automatisk fremfor at kræve manuel angivelse hver gang.
      if (candidates.length > 1) {
        const current = candidates.filter(n => n.startsWith('vp3_2endelig2025:'));
        if (current.length >= 1) candidates = current;
      }

      let chosen = manualOverride;
      if (!chosen) {
        if (candidates.length === 1) chosen = candidates[0];
        else {
          problems.push({ type: type.key, candidates });
          continue;
        }
      }
      console.log(`[${type.key}] bruger lag: ${chosen}`);
      results[type.key] = { layer: chosen, outFile: type.outFile };
    }

    if (problems.length > 0) {
      console.log('\n⚠️  Kunne ikke entydigt identificere følgende lag automatisk:\n');
      problems.forEach(p => {
        console.log(`${p.type}-kandidater:`, p.candidates.length ? p.candidates.join(', ') : '(ingen fundet)');
      });
      console.log('\nAlle VP3-lag fundet i GetCapabilities:');
      vp3Names.forEach(n => console.log('  -', n));
      console.log('\nKør scriptet igen med de manglende lag angivet manuelt, fx:');
      problems.forEach(p => {
        console.log(`  --${p.type}-layer "vp3_2endelig2025:DET_RIGTIGE_NAVN"`);
      });
      process.exit(1);
    }

    console.log('');
    for (const [key, info] of Object.entries(results)) {
      const features = await fetchAllFeatures(info.layer);
      const outPath = path.join(OUT_DIR, info.outFile);
      fs.writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }));
      console.log(`✅ Skrev ${features.length} features til ${outPath}`);
    }

    console.log('\nNæste skridt: kør update-all-data.sh (eller mapshaper manuelt) for at');
    console.log('simplificere polygon-/linje-lagene til de opløsninger appen bruger.');
  } catch (e) {
    console.error('\n❌ Fejl:', e.message);
    process.exit(1);
  }
})();
