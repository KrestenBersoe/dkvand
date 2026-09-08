#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// fetch-outlet-rainfall-history.js — per-OUTLET-GRID-CELL rainfall history,
// the exact input compute-outlet-thresholds.js (this repo's port of
// krestenbersoe/ukwater's pipeline/14-compute-outlet-thresholds.js) needs to
// derive a REAL calibrated per-outlet threshold — tier 1 of
// staticFrequencyBaseline.js's own 3-tier priority, not the tier-2 frequency
// heuristic validate-uk-risk-score.js's first run already exercised.
//
// Deliberately mirrors the real pipeline/13-fetch-outlet-rainfall-history.js
// exactly (same 0.25° grid dedup via its own exported cellKey(), same
// Open-Meteo archive endpoint) — imported directly, not reimplemented, so
// compute-outlet-thresholds.js's cell lookups line up byte-for-byte with
// what the real pipeline/14 expects. The one deliberate difference: the real
// pipeline fetches YEARS_BACK=3 (it's calibrating for CURRENT live scoring);
// this fetches the FULL backtest range (2015-today) since our own outlets'
// events span that whole period, not just the last 3 years.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER schema-map-edm.js er kørt
// (behøver edm-events.ndjson for real outlet lat/lng):
//   node fetch-outlet-rainfall-history.js --ukwater-repo /path/to/ukwater
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const EVENTS_PATH = path.resolve(argVal('--events', path.join(DIR, 'edm-events.ndjson')));
const OUT_PATH = path.resolve(argVal('--out', path.join(DIR, 'outlet-rainfall-history.json')));
const UKWATER_REPO = path.resolve(argVal('--ukwater-repo', '/home/user/ukwater'));
const DATE_FROM = argVal('--date-from', '2015-01-01');
const DATE_TO = argVal('--date-to', new Date().toISOString().slice(0, 10));
const CONCURRENCY = Math.max(1, parseInt(argVal('--concurrency', '4'), 10));
const NO_CACHE = hasFlag('--no-cache');

const cellKeyPath = path.join(UKWATER_REPO, 'pipeline', '13-fetch-outlet-rainfall-history.js');
if (!fs.existsSync(cellKeyPath)) {
  console.error(`Kan ikke finde ${cellKeyPath}. Angiv --ukwater-repo.`);
  process.exit(1);
}
const { cellKey } = require(cellKeyPath);

if (!fs.existsSync(EVENTS_PATH)) {
  console.error(`Mangler ${EVENTS_PATH}. Kør schema-map-edm.js først.`);
  process.exit(1);
}

async function* ndjsonLines(p) {
  const rl = readline.createInterface({ input: fs.createReadStream(p) });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchArchiveCell(lat, lon, startDate, endDate, retries = 4) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${startDate}&end_date=${endDate}&hourly=precipitation&timezone=UTC`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    const transient = [429, 502, 503, 504].includes(res.status);
    if (attempt >= retries || !transient) throw new Error(`Archive API ${res.status} for ${lat},${lon}`);
    const waitMs = res.status === 429 ? 5000 * 2 ** attempt : 1500 * (attempt + 1);
    await sleep(waitMs);
  }
}
async function mapWithConcurrency(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const t0 = Date.now();
  console.log(`Læser ${EVENTS_PATH} og udtrækker udløbs-koordinater...`);
  const cellCenters = new Map(); // cellKey string -> {lat, lon}
  for await (const ev of ndjsonLines(EVENTS_PATH)) {
    // NYT (fundet ved selvtest — reel datakvalitetsfejl i selve EDM-
    // kilden, ikke en kodefejl her): mindst ét udløb ("STAPLEFIELD") har
    // lat=51032 i kildeeksporten — tydeligvis et tabt decimalpunkt
    // (burde være ~51.032). Uden dette tjek fik Open-Meteo's archive-API
    // simpelthen et gyldigheds-afvist 400-kald for netop den celle;
    // ufarligt her (kun ét gitter mistet), men et udløb med denne
    // koordinat ville sprede en falsk kæmpe-afstand videre i
    // compute-outlet-thresholds.js/validate-uk-risk-score.js hvis det
    // ikke blev filtreret allerede her.
    if (ev.lat == null || ev.lng == null) continue;
    if (ev.lat < -90 || ev.lat > 90 || ev.lng < -180 || ev.lng > 180) continue;
    const key = cellKey(ev.lat, ev.lng);
    if (!cellCenters.has(key)) {
      const [clat, clon] = key.split(':').map(Number);
      cellCenters.set(key, { lat: clat, lon: clon });
    }
  }
  console.log(`${cellCenters.size} distinkte 0.25° gitterceller (samme celleopdeling som den ægte pipeline/13's cellKey()).`);

  let cache = {};
  if (!NO_CACHE && fs.existsSync(OUT_PATH)) {
    const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    if (existing.meta && existing.meta.startDate === DATE_FROM && existing.meta.endDate === DATE_TO) cache = existing.cells || {};
  }

  const keys = [...cellCenters.keys()].filter((k) => !cache[k]);
  console.log(`${Object.keys(cache).length} fra cache, ${keys.length} skal hentes...`);

  const cells = { ...cache };
  let failed = 0;
  await mapWithConcurrency(keys, CONCURRENCY, async (key) => {
    const { lat, lon } = cellCenters.get(key);
    try {
      const data = await fetchArchiveCell(lat, lon, DATE_FROM, DATE_TO);
      cells[key] = { mm: data.hourly.precipitation, startTime: data.hourly.time[0] };
    } catch (err) {
      failed++;
      console.error(`  celle ${key} fejlede: ${err.message}`);
    }
  }, (done, total) => {
    if (done % 20 === 0 || done === total) console.log(`  ${done}/${total} celler hentet (+${((Date.now() - t0) / 1000).toFixed(1)}s, ${failed} fejlede)`);
  });

  const output = {
    generatedAt: new Date().toISOString(),
    meta: { gridDegrees: 0.25, startDate: DATE_FROM, endDate: DATE_TO, cellCount: Object.keys(cells).length, failedCells: failed },
    cells,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));
  console.log(`\nSkrevet ${Object.keys(cells).length}/${cellCenters.size} celler til ${OUT_PATH} (${failed} fejlede, ${((Date.now() - t0) / 1000).toFixed(1)}s i alt).`);
}

main().catch((err) => {
  console.error('fetch-outlet-rainfall-history fejlede:', err);
  process.exit(1);
});
