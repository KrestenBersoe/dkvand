#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// watershed-hub-open-meteo-poll.js
// ═══════════════════════════════════════════════════════════════════════════
//
// One-shot Watershed adapter — bulk Open-Meteo forecast fetch for every PULS
// grid cell, run on the hub's own schedule instead of every dkvand replica
// independently fetching the same ~171 cells on its own WEATHER_CHECK_INTERVAL_MS
// timer. Reuses open-meteo-weather.js's real fetch/compute functions
// directly (buildPulsGrid, fetchOpenMeteoWithRetry, computeMetrics) — no
// protocol/formula logic duplicated here.
//
// Reads puls-data.json from THIS checkout (already produced by the hub's own
// "full-rebuild" manifest entry, which this entry depends on — see this
// project's manifest entry's own dependsOn) rather than needing dkvand's own
// site list some other way.
//
// Writes weather-cache.json in the EXACT [[gridKey, {ts, data}], ...] shape
// server.js's own loadPersistedWeatherCache()/persistWeatherCacheToDisk()
// already use, so dkvand's server.js can load it with the same parsing
// logic (see loadWeatherCacheFromSyncedFile() in server.js).
//
// Skips still-fresh cells same as warmCache() always has (WEATHER_TTL_MS,
// 3h) — reads its own PREVIOUS output first so a run landing inside that
// window is cheap, not a full re-fetch.
'use strict';

const fs = require('fs');
const path = require('path');
const weather = require('./open-meteo-weather');

const PULS_DATA_PATH = path.join(__dirname, 'puls-data.json');
const OUT_PATH = path.join(__dirname, 'weather-cache.json');
const WEATHER_TTL_MS = 3 * 60 * 60 * 1000; // matches server.js's own WEATHER_TTL_MS
const CONCURRENCY = 10; // matches warmCache()'s own CONC

function loadPrevious() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return Array.isArray(parsed) ? new Map(parsed) : new Map();
  } catch {
    return new Map();
  }
}

async function main() {
  const cells = weather.buildPulsGrid(PULS_DATA_PATH);
  const cache = loadPrevious();

  let idx = 0, fetched = 0, skipped = 0, failed = 0;
  async function worker(workerIdx) {
    await new Promise((r) => setTimeout(r, workerIdx * 200)); // same burst-stagger warmCache() uses
    while (idx < cells.length) {
      const cell = cells[idx++];
      const key = weather.gridKey(cell.lat, cell.lng);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) { skipped++; continue; }
      try {
        const raw = await weather.fetchOpenMeteoWithRetry(cell.lat, cell.lng);
        const data = weather.computeMetrics(raw);
        cache.set(key, { ts: Date.now(), data });
        fetched++;
      } catch (e) {
        failed++;
        console.warn(`[watershed-hub-open-meteo-poll] cell ${key} failed:`, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cells.length) }, (_, i) => worker(i)));

  fs.writeFileSync(OUT_PATH, JSON.stringify([...cache]));
  console.log(`[watershed-hub-open-meteo-poll] ${fetched} fetched, ${skipped} skipped, ${failed} failed — ${cache.size} cells cached`);

  if (failed > 0 && fetched === 0 && skipped === 0) {
    process.exitCode = 1; // every cell failed and nothing usable already cached — a real failure, not partial degradation
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[watershed-hub-open-meteo-poll] failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
