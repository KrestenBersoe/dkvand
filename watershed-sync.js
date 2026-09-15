#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// watershed-sync.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Watershed hub sync client — the "cold data" lane from the architecture
// doc: conditional-GETs each dataset this project's manifest entry
// (watershed/manifests/dkvand.json) declares, and writes the body straight
// to the exact root-level file server.js already reads (puls-data.json,
// vp3_*.geojson, etc.) — server.js itself is UNCHANGED by this.
//
// Deliberately opt-in and non-destructive: does nothing at all unless
// WATERSHED_HUB_URL is sat. update-all-data.sh keeps working exactly as
// before — dette er en additiv alternativ kilde til de samme filer, ikke en
// erstatning, før der er reel tillid til hub'en til at skifte over.
//
// NYT: dkvand's manifest (watershed/manifests/dkvand.json) is currently ÉT
// composite "full-rebuild"-entry, ikke separate entries per fil (se den
// manifestfils egne noter for hvorfor) — men denne sync-klient henter
// stadig hver fil for sig, samme mønster som ukwater/frwater, fordi det er
// destinationssiden, ikke kilde-granulariteten, der bestemmer hvordan
// filerne skal placeres lokalt.
const fs = require('fs');
const path = require('path');

const HUB_URL = process.env.WATERSHED_HUB_URL;
const PROJECT = 'dkvand';
const ROOT_DIR = __dirname;
const ETAG_CACHE_PATH = path.join(ROOT_DIR, '.watershed-etags.json');

// datasetKey -> local path relative to the repo root — must match the
// datasetKey watershed/manifests/dkvand.json's "full-rebuild" entry
// declares in its own `outputs`.
const DATASETS = {
  'puls-data': 'puls-data.json',
  'puls-thresholds': 'puls-udloeb-taerskler.json',
  'vp3-kystvande': 'vp3_kystvande_simplified.geojson',
  'vp3-soeer': 'vp3_soeer.geojson',
  'vp3-vandlob': 'vp3_vandlob_simplified.geojson',
  'vp3-badevand': 'vp3_badevand.geojson',
  'vp3-rbu': 'vp3_rbu_slim.geojson',
  'vandlob-directions': 'vandlob-directions.json',
  'vandlob-display': 'vandlob-display.json',
  // Live-event tier (15-min hub cadence, matches WEATHER_CHECK_INTERVAL_MS)
  // — synced separately, at a faster cadence than this file's own DATASETS
  // loop, by watershed-live-sync.js. Listed here too so main()'s own
  // manual/cron sync (whatever cadence THAT runs at) also picks it up as a
  // fallback, same as every other dataset.
  'dmi-rain-history': 'dmi-rain-history.json',
};

function loadEtagCache() {
  if (!fs.existsSync(ETAG_CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ETAG_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveEtagCache(cache) {
  fs.writeFileSync(ETAG_CACHE_PATH, JSON.stringify(cache));
}

async function syncOne(datasetKey, relativePath, etagCache) {
  const url = `${HUB_URL}/api/data/${PROJECT}/${datasetKey}`;
  const headers = etagCache[datasetKey] ? { 'If-None-Match': etagCache[datasetKey] } : {};
  const res = await fetch(url, { headers });

  if (res.status === 304) return { datasetKey, status: 'unchanged' };
  if (res.status === 404) return { datasetKey, status: 'not-yet-fetched-by-hub' };
  if (!res.ok) return { datasetKey, status: 'error', error: `HTTP ${res.status}` };

  const body = Buffer.from(await res.arrayBuffer());
  const targetPath = path.join(ROOT_DIR, relativePath);
  fs.writeFileSync(targetPath, body);

  const etag = res.headers.get('etag');
  if (etag) etagCache[datasetKey] = etag;

  return { datasetKey, status: 'updated', bytes: body.length };
}

async function main() {
  if (!HUB_URL) {
    console.log('[watershed-sync] WATERSHED_HUB_URL ikke sat — springer over (denne app kører stadig sin egen update-all-data.sh direkte)');
    return;
  }

  const etagCache = loadEtagCache();
  const results = [];
  for (const [datasetKey, relativePath] of Object.entries(DATASETS)) {
    results.push(await syncOne(datasetKey, relativePath, etagCache));
  }
  saveEtagCache(etagCache);

  for (const r of results) {
    console.log(`[watershed-sync] ${r.datasetKey}: ${r.status}${r.bytes ? ` (${r.bytes} bytes)` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }

  const failed = results.filter((r) => r.status === 'error');
  if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[watershed-sync] fejlede:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { syncOne, DATASETS, main };
