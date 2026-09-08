#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ea-api.js — shared client for the Environment Agency's "Water Quality
// Explorer" (WQE) API, https://environment.data.gov.uk/water-quality.
//
// This is the LIVE replacement for the old, now-dead
// environment.data.gov.uk/bwq/ Bathing Water Quality API (confirmed dead:
// 403 from both this sandbox and the user's own browser at every /bwq/
// path tried; confirmed live: this API's own OpenAPI spec at
// /water-quality/api/swagger, and real requests against it returning real
// 2024 Brighton bathing-water sample results — see the chat thread this
// was found in). Search engines still only index the dead /bwq/ URLs, so
// this endpoint was found by reading data.gov.uk's own dataset catalogue
// page for "Water Quality Explorer" (updated 10 April 2026) rather than
// any web search.
//
// Endpoints used here (of the full set in the OpenAPI spec):
//   GET  /sampling-point                — list/filter sampling points (sites)
//   POST /data/observation              — bulk sample results, multi-site,
//                                          CSV or JSON-LD, filterable by
//                                          date range and determinand
//   (site-scoped GET .../observation exists too but caps at 250 rows/page
//    and one site at a time — the POST bulk endpoint allows up to 100
//    site notations and 2500 rows/page, an order of magnitude fewer
//    round-trips for a whole region's history)
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { streamCsvRows } = require('./csv-stream');

const WQE_BASE = 'https://environment.data.gov.uk/water-quality';
const USER_AGENT = 'dkvand-ukwater-research/1.0 (bathing-water model validation research; contact via github.com/KrestenBersoe/dkvand)';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Retries on 429 (respecting Retry-After if the server sends one) and on
// 5xx (transient gateway/server errors) with exponential backoff. Any
// other non-OK status (400, 404, ...) is a real bug in the request, not a
// transient condition — thrown immediately, same principle as
// scripts/lib/badevand-backtest-utils.js's fetchArchive().
async function fetchWithRetry(url, options = {}, attempt = 0) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
  });
  if (res.status === 429) {
    if (attempt >= 6) throw new Error(`${url}: HTTP 429 (rate limited) — gave up after ${attempt} retries`);
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 2000 * 2 ** attempt;
    await sleep(waitMs);
    return fetchWithRetry(url, options, attempt + 1);
  }
  if (res.status >= 500) {
    if (attempt >= 4) throw new Error(`${url}: HTTP ${res.status} — gave up after ${attempt} retries`);
    await sleep(1000 * 2 ** attempt);
    return fetchWithRetry(url, options, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${url}: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return res;
}

// The API's own WKT geometry, e.g. "POINT(0.7602 51.4433)
// <http://www.opengis.net/def/crs/EPSG/0/4326>" — WGS84 lng/lat, confirmed
// by requesting it via the Accept-Crs header (default CRS is British
// National Grid easting/northing, EPSG:27700, not lng/lat).
function parseWktPoint(wkt) {
  if (!wkt) return { lat: null, lng: null };
  const m = /POINT\(\s*([-0-9.]+)\s+([-0-9.]+)\s*\)/.exec(wkt);
  if (!m) return { lat: null, lng: null };
  return { lng: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

// Fetches every sampling point matching a region + sampling-point-type
// filter (e.g. region=SO, samplingPointType=CA → Southern Water's
// territory's designated saline-water bathing beaches — 97 sites,
// confirmed live). Paginates defensively (limit up to 250/page) though a
// single region's bathing sites has never been observed to exceed one
// page. NOT cached to disk — this is one cheap request for order-of-100
// rows, and re-designation of bathing sites (added/withdrawn) is exactly
// the kind of small, slow-moving change worth seeing fresh every run
// rather than risking a stale cached list silently dropping a new site.
async function fetchAllSites({ region, samplingPointType, limit = 250 }) {
  const sites = [];
  let skip = 0;
  for (;;) {
    const url = `${WQE_BASE}/sampling-point?region=${encodeURIComponent(region)}&samplingPointType=${encodeURIComponent(samplingPointType)}&limit=${limit}&skip=${skip}`;
    const res = await fetchWithRetry(url, {
      headers: {
        Accept: 'application/ld+json',
        'Accept-Crs': 'http://www.opengis.net/def/crs/EPSG/0/4326',
      },
    });
    const json = await res.json();
    const members = json.member || [];
    for (const m of members) {
      const { lat, lng } = parseWktPoint(m.geometry && m.geometry.asWKT);
      sites.push({
        notation: m.notation,
        prefLabel: m.prefLabel,
        altLabel: m.altLabel,
        lat,
        lng,
        region: m.region && m.region.prefLabel,
        area: m.area && m.area.prefLabel,
        subArea: m.subArea && m.subArea.prefLabel,
        status: m.samplingPointStatus && m.samplingPointStatus.notation,
        samplingPointType: m.samplingPointType && m.samplingPointType.notation,
        samplingPointTypeLabel: m.samplingPointType && m.samplingPointType.prefLabel,
      });
    }
    if (members.length < limit) break;
    skip += limit;
  }
  return sites;
}

// One page of the bulk multi-site observation endpoint, as raw CSV text.
// determinand: array of determinand notation codes, or empty/undefined to
// fetch every determinand the API reports for these sites (see
// fetch-ea-samples.js's filehead for why NOT pre-filtering is the honest
// default here).
async function fetchObservationsCsvPage({ pointNotations, determinand, dateFrom, dateTo, skip, limit }) {
  const params = new URLSearchParams({
    pointNotation: pointNotations.join(','),
    dateFrom,
    dateTo,
    skip: String(skip),
    limit: String(limit),
  });
  if (determinand && determinand.length) params.set('determinand', determinand.join(','));
  const url = `${WQE_BASE}/data/observation?${params.toString()}`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Accept: 'text/csv',
      'CSV-Header': 'present',
      'Content-Type': 'application/json',
    },
    // POST /data/observation's body is an OPTIONAL GeoJSON Polygon/
    // MultiPolygon spatial filter (see the OpenAPI spec's
    // SamplingPointBodyParameters schema) — 'null' means "no extra
    // spatial filter, use only the query-param filters above", confirmed
    // against the live API during this investigation.
    body: 'null',
  });
  return res.text();
}

// Parses one CSV page (header + rows, as returned with CSV-Header:
// present) into row objects, deriving a numeric interpretation of the
// "result" column. Verified against real EA responses: below/above-
// detection-limit results are reported as plain strings like "<10" or
// ">2419.6" (same left/right-censoring the JSON-LD form of this API
// expresses via separate hasResult.{numericValue,upperBound,lowerBound}
// fields) — CSV does NOT split these into separate columns, so this
// reproduces that split by hand. Treating "<10" as the number 10 (instead
// of "true value unknown, but below 10") would silently fabricate
// precision the lab result never had — same caution as dkvand's own
//'Ongoing' EDM events not being treated as final.
async function* parseObservationCsv(csvText) {
  async function* single() { yield csvText; }
  let header = null;
  for await (const fields of streamCsvRows(single(), ',')) {
    if (!header) { header = fields; continue; }
    if (fields.length < header.length) continue; // trailing blank line etc.
    const row = {};
    header.forEach((h, i) => { row[h] = fields[i]; });

    const raw = (row.result || '').trim();
    let numericValue = null;
    let censored = 'none'; // 'none' | 'below' | 'above' — NEVER treat `bound` as the true value
    let bound = null;
    if (raw.startsWith('<')) { censored = 'below'; bound = parseFloat(raw.slice(1)); }
    else if (raw.startsWith('>')) { censored = 'above'; bound = parseFloat(raw.slice(1)); }
    else if (raw !== '') { numericValue = parseFloat(raw); }

    yield {
      sampleId: row.id,
      siteNotation: row['samplingPoint.notation'],
      siteName: row['samplingPoint.prefLabel'],
      region: row['samplingPoint.region'],
      area: row['samplingPoint.area'],
      subArea: row['samplingPoint.subArea'],
      samplingPointType: row['samplingPoint.samplingPointType'],
      phenomenonTime: row.phenomenonTime,
      samplingPurpose: row.samplingPurpose,
      sampleMaterialType: row.sampleMaterialType,
      determinandCode: row['determinand.notation'],
      determinandLabel: row['determinand.prefLabel'],
      rawResult: raw,
      numericValue: Number.isFinite(numericValue) ? numericValue : null,
      censored,
      bound: Number.isFinite(bound) ? bound : null,
      unit: row.unit,
    };
  }
}

module.exports = {
  WQE_BASE,
  fetchWithRetry,
  parseWktPoint,
  fetchAllSites,
  fetchObservationsCsvPage,
  parseObservationCsv,
  sleep,
};
