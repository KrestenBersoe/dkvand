#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// currents-lookup.js — fast nearest-grid-point, nearest-date lookup over
// fetch_uk_currents_historical.py's output ({grid: [{lat,lon,dates,uo,vo}]}).
//
// Called up to ~15M times in a full backtest run (874 outlets × ~17,000
// samples) — a linear scan over the few-hundred grid points per call would
// be too slow, so lat/lon lookup is index-based (O(log n) binary search per
// axis, not O(gridSize)) and the per-point date series is binary-searched
// too, same "sorted array + binary search" pattern already used elsewhere
// in this repo (fetch-ea-samples.js's date bisection, validate-uk-model.js's
// countInWindow()).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');

function buildCurrentsIndex(currentsJsonPath) {
  const data = JSON.parse(fs.readFileSync(currentsJsonPath, 'utf8'));
  const grid = data.grid || [];

  const lats = [...new Set(grid.map((g) => g.lat))].sort((a, b) => a - b);
  const lons = [...new Set(grid.map((g) => g.lon))].sort((a, b) => a - b);
  const byLatLon = new Map(); // `${latIdx}:${lonIdx}` -> grid point
  const latIndex = new Map(lats.map((v, i) => [v, i]));
  const lonIndex = new Map(lons.map((v, i) => [v, i]));
  for (const g of grid) byLatLon.set(`${latIndex.get(g.lat)}:${lonIndex.get(g.lon)}`, g);

  function nearestIdx(sortedArr, value) {
    let lo = 0, hi = sortedArr.length - 1;
    if (value <= sortedArr[0]) return 0;
    if (value >= sortedArr[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (sortedArr[mid] < value) lo = mid; else hi = mid;
    }
    return value - sortedArr[lo] <= sortedArr[hi] - value ? lo : hi;
  }

  // Nearest grid point to (lat,lon), expanding a small ring of neighbouring
  // indices if the closest index pair is a masked/land cell (absent from
  // byLatLon) — real coastal outlets sit right at the land/sea boundary, so
  // the single nearest index pair missing is expected, not exceptional.
  function nearestGridPoint(lat, lon) {
    const li = nearestIdx(lats, lat);
    const oi = nearestIdx(lons, lon);
    for (let radius = 0; radius <= 3; radius++) {
      for (let dli = -radius; dli <= radius; dli++) {
        for (let doi = -radius; doi <= radius; doi++) {
          if (Math.max(Math.abs(dli), Math.abs(doi)) !== radius) continue; // only the new ring each pass
          const key = `${li + dli}:${oi + doi}`;
          const g = byLatLon.get(key);
          if (g) return g;
        }
      }
    }
    return null;
  }

  // Nearest date <= target within one grid point's own series (never a
  // future date relative to the query — leakage-safe, matches this repo's
  // other lookups' own discipline).
  function valueAtDate(gridPoint, dateStr) {
    const dates = gridPoint.dates;
    let lo = 0, hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (dates[mid] <= dateStr) lo = mid + 1; else hi = mid;
    }
    const idx = lo - 1;
    if (idx < 0) return null; // query date is before this point's series starts
    return { uo: gridPoint.uo[idx], vo: gridPoint.vo[idx], date: dates[idx] };
  }

  return {
    meta: data.meta,
    // (lat, lon, dateStr "YYYY-MM-DD") -> {uo, vo, date} | null
    getCurrentAt(lat, lon, dateStr) {
      const g = nearestGridPoint(lat, lon);
      if (!g) return null;
      return valueAtDate(g, dateStr);
    },
  };
}

module.exports = { buildCurrentsIndex };
