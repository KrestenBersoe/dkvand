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
//
// RETTET (produktionshændelse, found live while diagnosing a shared-IP
// Open-Meteo 429 storm that took ukwater's and frwater's own hub-scheduled
// pollers down too, same day, same hub machine): this used to fire up to
// CONCURRENCY=10 simultaneous PER-CELL requests across every one of the
// ~171 PULS grid cells, with no backoff on 429 specifically
// (isTransientOpenMeteoError only treats 502/503/504 as retryable) — easily
// enough on its own to trip Open-Meteo's per-IP rate limit, and since
// Open-Meteo rate-limits by source IP, that took the other two hub-
// scheduled pollers' own much smaller batched requests down as collateral
// damage from the SAME IP. Rewritten to use fetchOpenMeteoBatchWithRetry()
// (multi-location single request, same pattern ukwater/frwater's own
// liveRainfall.js already uses and the exact fix that ended THEIR identical
// 2026-08-28 per-cell-burst incident) — collapses this to ~1 request total
// for PULS's own cell count, sequential across batches (never more than one
// in-flight request from this process at a time), with the same batch-level
// 429 backoff liveRainfall.js's warmRainfallCache() uses.
'use strict';

const fs = require('fs');
const path = require('path');
const weather = require('./open-meteo-weather');

const PULS_DATA_PATH = path.join(__dirname, 'puls-data.json');
const OUT_PATH = path.join(__dirname, 'weather-cache.json');
const WEATHER_TTL_MS = 3 * 60 * 60 * 1000; // matches server.js's own WEATHER_TTL_MS

function loadPrevious() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return Array.isArray(parsed) ? new Map(parsed) : new Map();
  } catch {
    return new Map();
  }
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

async function main() {
  const cells = weather.buildPulsGrid(PULS_DATA_PATH);
  const cache = loadPrevious();

  // TTL check happens up front, before batching — same reasoning
  // liveRainfall.js's warmRainfallCache() gives: a fully-warm cache costs
  // zero network requests, not even one just to find out a cell could be
  // skipped.
  const now = Date.now();
  const stale = cells.filter((cell) => {
    const cached = cache.get(weather.gridKey(cell.lat, cell.lng));
    return !cached || now - cached.ts >= WEATHER_TTL_MS;
  });
  const skipped = cells.length - stale.length;

  let fetched = 0, failed = 0;
  const batches = chunk(stale, weather.BATCH_SIZE);
  for (const batch of batches) {
    try {
      const results = await weather.fetchOpenMeteoBatchWithRetry(batch);
      const fetchedAt = Date.now();
      batch.forEach((cell, i) => {
        const key = weather.gridKey(cell.lat, cell.lng);
        cache.set(key, { ts: fetchedAt, data: weather.computeMetrics(results[i]) });
      });
      fetched += batch.length;
    } catch (e) {
      failed += batch.length;
      console.warn(`[watershed-hub-open-meteo-poll] batch fetch failed (${batch.length} cells):`, e.message);
      if (e.status === 429) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify([...cache]));
  console.log(
    `[watershed-hub-open-meteo-poll] ${fetched} fetched, ${skipped} skipped, ${failed} failed, ${batches.length} batch(es) — ${cache.size} cells cached`
  );

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
