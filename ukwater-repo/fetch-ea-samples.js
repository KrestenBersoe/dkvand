#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// fetch-ea-samples.js — pulls real bathing-water lab sample results from the
// Environment Agency's Water Quality Explorer (WQE) API and writes them into
// the same clean, structured intermediate shape as schema-map-edm.js's EDM
// output — this is the OTHER half of the UK ingestion (outcome data:
// Y = did a sample fail, vs. schema-map-edm.js's cause data: X = discharge
// events). Both are ingestion-only; the actual UK backtest (walk-forward,
// same discipline as dkvand's validate-badevand-model.js) is the next stage,
// once this and schema-map-edm.js's output can be joined on bathing-water
// site.
//
// Kør fra ukwater-repo/ (denne mappe):
//   node fetch-ea-samples.js [--region SO] [--sampling-point-type CA]
//     [--date-from 2015-01-01] [--date-to <today>] [--out-dir DIR]
//     [--cache-dir DIR] [--no-cache] [--concurrency 4] [--determinand CODES]
//
// ── Why POST /data/observation, not the site-scoped GET ──────────────────
// The API also exposes GET /sampling-point/{id}/observation (one site at a
// time, 250 rows/page cap). POST /data/observation takes up to 100 site
// notations and 2500 rows/page — confirmed against the live API. Southern
// Water's territory (region=SO, samplingPointType=CA = "SALINE WATER -
// DESIGNATED BATHING BEACHES") is 97 sites, so this ships as ONE site
// batch, several year-chunked date ranges, instead of 97 separate site
// crawls.
//
// ── Why no determinand filter by default ──────────────────────────────────
// A first unfiltered probe against a real Brighton bathing-water sample
// (SO-F0001874) showed EVERY statutory bathing-water sample reports more
// than E. coli/enterococci: water temperature, salinity, and — directly
// relevant to dkvand's own "non-sewage bacteria sources" open question
// (BADEVAND-MODEL-VALIDERING-RESULTATER.md, "What's untested, not ruled
// out") — bird counts, dog counts, sewage debris, algal bloom, litter.
// Pre-filtering to just the two compliance determinands here would throw
// that covariate data away before the backtest stage ever gets a chance to
// use it. Confirmed compliance determinand codes (for reference, NOT
// applied as a filter): 3723 = Enterococci Intestinal Confirmed:MF,
// 2348 = E. coli Confirmed:MF (3722 = Enterococci Presumptive:MF, an
// earlier/faster read of the same sample, also present).
//
// ── Multi-threading / concurrency design ──────────────────────────────────
// schema-map-edm.js's worker_threads design earns its keep on a genuinely
// CPU-bound, multi-GB local file. This script's bottleneck is the opposite:
// network round-trip latency against a remote API, for a modest total row
// count (tens of thousands, not millions — 97 sites × weekly-in-season
// samples × ~11 years). worker_threads would add process overhead for no
// benefit here (fetch() is already non-blocking I/O on the main thread);
// the correct lever is CONCURRENT REQUESTS, not CPU parallelism — same
// principle as scripts/lib/badevand-backtest-utils.js's mapWithConcurrency()
// for the (also I/O-bound) Open-Meteo weather backfill.
//
// ── Caching ─────────────────────────────────────────────────────────────
// Unlike Open-Meteo's historical weather archive (genuinely immutable once
// the date has passed — see scripts/validate-badevand-model.js's weather
// cache), the EA's own FAQ (read directly on environment.data.gov.uk during
// this investigation) states the archive gets "a complete data refresh each
// month which may include corrections to earlier data". So: every year
// STRICTLY BEFORE the current calendar year is cached to disk and reused
// on rerun; the current calendar year is always re-fetched fresh. --no-cache
// forces a full refetch of everything, for when a stale correction is
// suspected.
//
// ── A real backend bug, found empirically, worked around here ────────────
// The live API 502s under two SEPARATE conditions, confirmed by bisecting
// against the real endpoint (not guessed):
//   1. More than ~70 site notations in ONE request's pointNotation list —
//      regardless of date range or determinand filter (a 1-month, 2-code-
//      filtered query with 97 sites 502s exactly like a full-year,
//      unfiltered one; 70 sites always succeeds, 72 always fails).
//   2. skip>0 on a multi-site request — even a 50-site query with limit=100
//      502s the moment skip is anything but 0 (2-site queries paginate via
//      skip fine; the failure tracks site COUNT, not row count).
// Southern Water's region is 97 sites — over the (1) ceiling on its own —
// and unfiltered fetching (see above) easily exceeds 2500 rows/request,
// which would normally need (2) to page through. Both failure modes are
// avoided the same way: keep each request's site batch safely under the
// ceiling (SITE_BATCH_SIZE, default 50) AND replace skip-based pagination
// with recursive DATE-RANGE BISECTION — if a page comes back at the
// PAGE_LIMIT (meaning more rows may exist), split its date window in half
// and re-request each half from scratch (skip always 0), recursing down to
// single-day windows if truly needed. Slower than pagination would be at
// real sampling frequencies (which never come close to 2500 rows/day for a
// 50-site batch) — but skip pagination is the one thing empirically proven
// broken here, so this sidesteps it entirely rather than retrying into it.
//
// ── Output ──────────────────────────────────────────────────────────────
// <out-dir>/ea-sites.json       — one record per bathing-water sampling point
// <out-dir>/ea-samples.ndjson   — one record per (sample, determinand) observation
// <out-dir>/ea-diagnostics.json — row/determinand/date-range counts
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  fetchAllSites,
  fetchObservationsCsvPage,
  parseObservationCsv,
} = require('./lib/ea-api');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const REGION = argVal('--region', 'SO');
const SAMPLING_POINT_TYPE = argVal('--sampling-point-type', 'CA');
const DETERMINAND_ARG = argVal('--determinand', ''); // '' = no filter, see filehead
const DATE_FROM = argVal('--date-from', '2015-01-01');
const DATE_TO = argVal('--date-to', new Date().toISOString().slice(0, 10));
const OUT_DIR = path.resolve(argVal('--out-dir', path.join(__dirname, 'output')));
const CACHE_DIR = path.resolve(argVal('--cache-dir', path.join(__dirname, 'cache', 'ea-observations')));
const NO_CACHE = hasFlag('--no-cache');
const CONCURRENCY = Math.max(1, parseInt(argVal('--concurrency', '4'), 10));
const PAGE_LIMIT = Math.max(1, Math.min(2500, parseInt(argVal('--page-limit', '2500'), 10)));
// Empirically-found ceiling is ~70-72 site notations/request (see filehead)
// — default leaves real margin, since 502s got LESS deterministic near the
// ceiling under repeated testing (consistent with a backend timeout, not a
// hard-coded limit).
const SITE_BATCH_SIZE = Math.max(1, Math.min(70, parseInt(argVal('--site-batch-size', '50'), 10)));
const CURRENT_YEAR = new Date().getUTCFullYear();

const determinandList = DETERMINAND_ARG
  ? DETERMINAND_ARG.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Splits [dateFrom,dateTo] into calendar-year windows — the natural
// cache-invalidation unit given the "current year is never cached" rule
// above (same "contiguous chunk" shape as dkvand's chunkContiguous(), by
// year here instead of by day).
function yearWindows(dateFrom, dateTo) {
  const fromYear = parseInt(dateFrom.slice(0, 4), 10);
  const toYear = parseInt(dateTo.slice(0, 4), 10);
  const windows = [];
  for (let y = fromYear; y <= toYear; y++) {
    windows.push({
      year: y,
      dateFrom: y === fromYear ? dateFrom : `${y}-01-01`,
      dateTo: y === toYear ? dateTo : `${y}-12-31`,
    });
  }
  return windows;
}

function siteBatchKey(pointNotations) {
  return crypto.createHash('sha1').update(pointNotations.join(',')).digest('hex').slice(0, 10);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toEpochDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
function fromEpochDay(epochDay) {
  return new Date(epochDay * 86400000).toISOString().slice(0, 10);
}
// Splits [dateFrom,dateTo] into two adjoining halves, or returns null if
// the range is already a single day (recursion base case — see filehead's
// "real backend bug" section for why this replaces skip-based pagination).
function bisectDateRange(dateFrom, dateTo) {
  const a = toEpochDay(dateFrom);
  const b = toEpochDay(dateTo);
  if (a >= b) return null;
  const mid = a + Math.floor((b - a) / 2);
  const midDate = fromEpochDay(mid);
  if (midDate === dateFrom) return null;
  return [[dateFrom, midDate], [fromEpochDay(mid + 1), dateTo]];
}

async function getWindowCsv({ pointNotations, year, dateFrom, dateTo, cacheable }) {
  const cachePath = path.join(CACHE_DIR, `${siteBatchKey(pointNotations)}_${year}_${dateFrom}_${dateTo}.csv`);
  if (cacheable && !NO_CACHE && fs.existsSync(cachePath)) {
    return { text: fs.readFileSync(cachePath, 'utf8'), fromCache: true };
  }
  // skip is ALWAYS 0 here — see filehead: skip>0 is the confirmed-broken
  // half of the backend bug this bisection strategy avoids entirely.
  const text = await fetchObservationsCsvPage({
    pointNotations, determinand: determinandList, dateFrom, dateTo, skip: 0, limit: PAGE_LIMIT,
  });
  if (cacheable && !NO_CACHE) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, text, 'utf8');
  }
  return { text, fromCache: false };
}

// Fetches one (site batch, date window) job, recursively bisecting the
// date range whenever a request comes back AT the page limit (meaning more
// rows may exist beyond it — see filehead). Every actual HTTP request uses
// skip=0; "pagination" here is entirely date-range narrowing, not offset
// paging.
async function* fetchWindowRecursive({ pointNotations, year, dateFrom, dateTo, cacheable }) {
  const { text, fromCache } = await getWindowCsv({ pointNotations, year, dateFrom, dateTo, cacheable });
  const records = [];
  for await (const record of parseObservationCsv(text)) records.push(record);

  if (records.length >= PAGE_LIMIT) {
    const halves = bisectDateRange(dateFrom, dateTo);
    if (halves) {
      yield { __pageMeta: true, dateFrom, dateTo, rowCountThisPage: records.length, fromCache, bisected: true };
      for (const [a, b] of halves) {
        yield* fetchWindowRecursive({ pointNotations, year, dateFrom: a, dateTo: b, cacheable });
      }
      return;
    }
    // Base case: a single day still returned >= PAGE_LIMIT rows for this
    // site batch. At real bathing-season sampling frequencies (order of
    // one sample/site/week) this should never trigger — surfaced loudly
    // rather than silently dropping whatever's past the limit.
    console.warn(`⚠ ${pointNotations.length} stationer, ${dateFrom}: ${records.length} rækker på ÉN dag, ramte sidegrænsen (${PAGE_LIMIT}) — data kan være afskåret. Prøv en mindre --site-batch-size.`);
  }

  for (const r of records) yield r;
  yield { __pageMeta: true, dateFrom, dateTo, rowCountThisPage: records.length, fromCache, bisected: false };
}

async function main() {
  const scriptStartMs = Date.now();

  console.log(`Henter badevandsstationer: region=${REGION} samplingPointType=${SAMPLING_POINT_TYPE}...`);
  const sites = await fetchAllSites({ region: REGION, samplingPointType: SAMPLING_POINT_TYPE });
  if (sites.length === 0) {
    console.error(`Ingen stationer fundet for region=${REGION} samplingPointType=${SAMPLING_POINT_TYPE} — tjek koderne (se codelist/... endpoints i lib/ea-api.js's kommentarer).`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'ea-sites.json'), JSON.stringify(sites, null, 2), 'utf8');
  console.log(`${sites.length} stationer fundet, skrevet til ea-sites.json.`);

  const pointNotations = sites.map((s) => s.notation);
  const siteBatches = chunk(pointNotations, SITE_BATCH_SIZE);
  const windows = yearWindows(DATE_FROM, DATE_TO);
  const jobs = [];
  for (const batch of siteBatches) {
    for (const w of windows) {
      jobs.push({ pointNotations: batch, ...w, cacheable: !NO_CACHE && w.year !== CURRENT_YEAR });
    }
  }
  console.log(`${jobs.length} job (${siteBatches.length} stations-skår × ${windows.length} årsvinduer), ${CONCURRENCY} samtidige forbindelser...`);
  console.log(`Determinand-filter: ${determinandList.length ? determinandList.join(',') : '(ingen — henter alle rapporterede determinander, se filhoved)'}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const samplesPath = path.join(OUT_DIR, 'ea-samples.ndjson');
  const samplesStream = fs.createWriteStream(samplesPath);

  let totalObservations = 0;
  let totalPages = 0;
  let cachedPages = 0;
  const determinandCounts = {};
  const siteCounts = {};
  let earliestTime = null;
  let latestTime = null;
  let doneJobs = 0;

  await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
    for await (const item of fetchWindowRecursive(job)) {
      if (item.__pageMeta) {
        totalPages++;
        if (item.fromCache) cachedPages++;
        continue;
      }
      samplesStream.write(JSON.stringify(item) + '\n');
      totalObservations++;
      determinandCounts[item.determinandCode] = (determinandCounts[item.determinandCode] || 0) + 1;
      siteCounts[item.siteNotation] = (siteCounts[item.siteNotation] || 0) + 1;
      if (item.phenomenonTime) {
        if (earliestTime === null || item.phenomenonTime < earliestTime) earliestTime = item.phenomenonTime;
        if (latestTime === null || item.phenomenonTime > latestTime) latestTime = item.phenomenonTime;
      }
    }
    doneJobs++;
    console.log(`  [${doneJobs}/${jobs.length}] station-skår ${siteBatchKey(job.pointNotations)} år ${job.year} færdig (+${((Date.now() - scriptStartMs) / 1000).toFixed(1)}s)`);
  });

  await new Promise((resolve) => samplesStream.end(resolve));

  const determinandLabels = {};
  // Re-derive a determinand code -> label lookup from the data itself
  // (streamed, so not held in the merge loop above) rather than a second
  // API call — cheap since ea-samples.ndjson is already on disk.
  {
    const rl = require('readline').createInterface({ input: fs.createReadStream(samplesPath) });
    for await (const line of rl) {
      if (!line) continue;
      const rec = JSON.parse(line);
      if (rec.determinandCode && !determinandLabels[rec.determinandCode]) determinandLabels[rec.determinandCode] = rec.determinandLabel;
    }
  }

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    samplingPointType: SAMPLING_POINT_TYPE,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    determinandFilter: determinandList.length ? determinandList : null,
    siteCount: sites.length,
    totalObservations,
    distinctSitesWithData: Object.keys(siteCounts).length,
    determinandCounts: Object.fromEntries(
      Object.entries(determinandCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => [code, { count, label: determinandLabels[code] || null }]),
    ),
    dateRangeObserved: earliestTime ? { earliest: earliestTime, latest: latestTime } : null,
    pagesFetched: totalPages,
    pagesFromCache: cachedPages,
    pagesFetchedLive: totalPages - cachedPages,
    cacheDir: CACHE_DIR,
    cachingNote: 'Every calendar year strictly before the current one is cached to disk and reused on rerun; the current year is always fetched fresh (EA data can be retrospectively corrected — see filehead). Use --no-cache to force a full refetch.',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'ea-diagnostics.json'), JSON.stringify(diagnostics, null, 2), 'utf8');

  console.log('\n═══ Resultat ═══');
  console.log(`Tidsforbrug i alt: ${((Date.now() - scriptStartMs) / 1000).toFixed(1)}s.`);
  console.log(`Stationer: ${sites.length} (${diagnostics.distinctSitesWithData} med mindst én prøve i perioden).`);
  console.log(`Observationer (prøve × determinand): ${totalObservations.toLocaleString('en')}.`);
  console.log(`Sider hentet: ${totalPages} (${cachedPages} fra cache, ${totalPages - cachedPages} live).`);
  if (diagnostics.dateRangeObserved) console.log(`Datointerval (faktisk data): ${diagnostics.dateRangeObserved.earliest} .. ${diagnostics.dateRangeObserved.latest}`);
  console.log('Determinand-fordeling (top 10):');
  Object.entries(diagnostics.determinandCounts).slice(0, 10).forEach(([code, v]) => {
    console.log(`  ${code} (${v.label}): ${v.count.toLocaleString('en')}`);
  });
  console.log(`\nSkrevet: ${path.join(OUT_DIR, 'ea-sites.json')}`);
  console.log(`Skrevet: ${samplesPath}`);
  console.log(`Skrevet: ${path.join(OUT_DIR, 'ea-diagnostics.json')}`);
}

main().catch((err) => {
  console.error('fetch-ea-samples fejlede:', err);
  process.exit(1);
});
