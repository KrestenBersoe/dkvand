#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// fetch-uk-rainfall.js — historical hourly rainfall per EA bathing site, via
// the same free Open-Meteo archive API dkvand's own Danish validation uses
// (scripts/lib/badevand-backtest-utils.js's fetchArchive()) and the REAL UK
// risk model itself expects as input (see the cloned krestenbersoe/ukwater
// repo's server/risk/rainfallDecay.js — "Open-Meteo is queried with
// timezone=UTC and returns bare ISO8601... {time, precipitationMm}", exactly
// the shape written here).
//
// Why this exists: validate-uk-risk-score.js calls the REAL, unmodified
// scoreSite()/hazardScore() from krestenbersoe/ukwater directly — not a
// reimplementation — and that function's rainfall-decay baseline layer
// (rainfallDecay.js + baselineProbability.js) needs real siteRainfallHourly
// data to be exercised at all. Without it, `decayedMm` is always 0 and the
// rainfall-only baseline collapses to 0 for every outlet, silently reducing
// the whole cascade to just its live-EDM-override layer — see
// validate-uk-risk-score.js's filehead for how big a limitation that would
// be if left unaddressed.
//
// Kør fra ukwater-repo/ (denne mappe), EFTER fetch-ea-samples.js (behøver
// ea-sites.json for the site list/coordinates):
//   node fetch-uk-rainfall.js
//   node fetch-uk-rainfall.js --date-from 2015-01-01 --date-to 2026-09-08
//
// ── Caching ─────────────────────────────────────────────────────────────
// One file per site (output/rainfall/<siteNotation>.json), the FULL
// requested range in one request/file — unlike fetch-ea-samples.js's EA
// data, Open-Meteo's historical reanalysis for a past date is genuinely
// immutable (same reasoning dkvand's own weather cache already relies on),
// so there's no "current year stays uncached" carve-out here. Rerun with
// --no-cache to force a refetch (e.g. if a wider date range is wanted).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const DIR = path.resolve(argVal('--dir', path.join(__dirname, 'output')));
const SITES_PATH = path.resolve(argVal('--sites', path.join(DIR, 'ea-sites.json')));
const OUT_DIR = path.resolve(argVal('--out-dir', path.join(DIR, 'rainfall')));
const DATE_FROM = argVal('--date-from', '2015-01-01');
const DATE_TO = argVal('--date-to', new Date().toISOString().slice(0, 10));
const CONCURRENCY = Math.max(1, parseInt(argVal('--concurrency', '4'), 10));
const NO_CACHE = hasFlag('--no-cache');

if (!fs.existsSync(SITES_PATH)) {
  console.error(`Mangler ${SITES_PATH}. Kør fetch-ea-samples.js først (skriver ea-sites.json).`);
  process.exit(1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Same retry shape as scripts/lib/badevand-backtest-utils.js's fetchArchive()
// and this repo's lib/ea-api.js — 429 with backoff, other non-OK thrown.
async function fetchArchive(lat, lng, startDate, endDate, attempt = 0) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${startDate}&end_date=${endDate}&hourly=precipitation&timezone=UTC`;
  const res = await fetch(url);
  if (res.status === 429) {
    if (attempt >= 6) throw new Error(`Open-Meteo archive API 429 for ${lat},${lng} — gave up after ${attempt} retries`);
    await sleep(3000 * 2 ** attempt);
    return fetchArchive(lat, lng, startDate, endDate, attempt + 1);
  }
  if (!res.ok) {
    if (attempt >= 3) throw new Error(`Open-Meteo archive API ${res.status} for ${lat},${lng} — gave up after ${attempt} retries`);
    await sleep(2000 * (attempt + 1));
    return fetchArchive(lat, lng, startDate, endDate, attempt + 1);
  }
  const json = await res.json();
  return { time: json.hourly.time, precipitationMm: json.hourly.precipitation };
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
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));
  console.log(`${sites.length} stationer, henter regn ${DATE_FROM}..${DATE_TO}, ${CONCURRENCY} samtidige forbindelser...`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let fromCache = 0, fetchedLive = 0, failed = 0;

  await mapWithConcurrency(sites, CONCURRENCY, async (site) => {
    const cachePath = path.join(OUT_DIR, `${site.notation}.json`);
    if (!NO_CACHE && fs.existsSync(cachePath)) { fromCache++; return; }
    if (site.lat == null || site.lng == null) { failed++; console.warn(`  ${site.notation}: ingen koordinater, springer over.`); return; }
    try {
      const hourly = await fetchArchive(site.lat, site.lng, DATE_FROM, DATE_TO);
      fs.writeFileSync(cachePath, JSON.stringify(hourly), 'utf8');
      fetchedLive++;
    } catch (err) {
      failed++;
      console.warn(`  ${site.notation}: fejlede — ${err.message}`);
    }
  }, (done, total) => {
    if (done % 10 === 0 || done === total) console.log(`  ${done}/${total} stationer færdige (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  });

  console.log('\n═══ Resultat ═══');
  console.log(`Tidsforbrug: ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`${fromCache} fra cache, ${fetchedLive} hentet live, ${failed} fejlede.`);
  console.log(`Skrevet til: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('fetch-uk-rainfall fejlede:', err);
  process.exit(1);
});
