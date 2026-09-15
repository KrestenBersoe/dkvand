// ═══════════════════════════════════════════════════════════════════════════
// open-meteo-weather.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Extracted from server.js's own inline weatherCache/warmCache/computeMetrics
// code, verbatim (no behavior change) — this file holds only the PURE parts
// (grid derivation, the actual Open-Meteo fetch, the metrics computation),
// none of the STATEFUL parts (the weatherCache Map itself, its disk
// persistence, apiCallCount/cacheHitCount/fetchErrors). Those stay in
// server.js exactly as they are, since ~10 different call sites throughout
// the file read/write that Map directly for their own per-request fallback
// paths (a cold cell not covered by the PULS grid still needs its own live
// fetch, same as before this file existed) — moving THOSE would be a much
// larger, riskier change than what's actually needed to fix the real
// problem: every dkvand replica independently re-fetching the SAME ~171
// PULS-grid cells from Open-Meteo on its own WEATHER_CHECK_INTERVAL_MS timer.
//
// Exists so BOTH server.js (unchanged fallback behavior) and the hub-side
// watershed-hub-open-meteo-poll.js (the new bulk fetch, run on the hub's own
// schedule instead of every replica's own) can share the exact same
// fetch/compute logic — one source of truth for the request shape and the
// derived-metrics formula, not two copies that could drift apart.
'use strict';

const https = require('https');
const fs = require('fs');
const riskModel = require('./risk-model');

const GRID_DEG = 0.25;

function gridKey(lat, lng) {
  const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  return `${clat.toFixed(4)}:${clng.toFixed(4)}`;
}

// Denmark + Bornholm bounding box at 0.25°. Fallback if buildPulsGrid fails.
function buildDenmarkGrid() {
  const iLatMin = Math.floor(54.5 / GRID_DEG);
  const iLatMax = Math.ceil(57.9 / GRID_DEG);
  const iLngMin = Math.floor(8.0 / GRID_DEG);
  const iLngMax = Math.ceil(15.4 / GRID_DEG);
  const cells = [], seen = new Set();
  for (let iLat = iLatMin; iLat < iLatMax; iLat++) {
    for (let iLng = iLngMin; iLng < iLngMax; iLng++) {
      const key = gridKey((iLat + 0.1) * GRID_DEG, (iLng + 0.1) * GRID_DEG);
      if (seen.has(key)) continue;
      seen.add(key);
      const [ls, gs] = key.split(':');
      cells.push({ lat: parseFloat(ls), lng: parseFloat(gs) });
    }
  }
  return cells;
}

// Build grid from actual PULS overflow point coordinates — only cells that
// contain real data points. Avoids warming ~220 sea/foreign bbox cells.
// puls-data.json format: { a: [authorities], w: [waterAreas], d: [[lat,lng,...], ...] }
// pulsDataPath is now an explicit parameter (was a hardcoded STATIC_DIR path
// in server.js) so the hub-side script can point it at its own checkout's
// copy of the same file — same logic, different caller, same reason
// dmi-rain.js's allStationIds() was added instead of hardcoding a path.
function buildPulsGrid(pulsDataPath) {
  try {
    const raw = fs.readFileSync(pulsDataPath, 'utf8');
    const data = JSON.parse(raw);
    const rows = data?.d || data; // compressed: { d: rows } or raw array
    const seen = new Set();
    const cells = [];
    for (const r of rows) {
      const lat = parseFloat(Array.isArray(r) ? r[0] : (r.lat ?? r.Lat));
      const lng = parseFloat(Array.isArray(r) ? r[1] : (r.lng ?? r.Lon ?? r.lon));
      if (isNaN(lat) || isNaN(lng)) continue;
      const key = gridKey(lat, lng);
      if (seen.has(key)) continue;
      seen.add(key);
      const [ls, gs] = key.split(':');
      cells.push({ lat: parseFloat(ls), lng: parseFloat(gs) });
    }
    console.log(`buildPulsGrid: ${cells.length} unique cells from ${rows.length} PULS points`);
    return cells;
  } catch (e) {
    console.warn('buildPulsGrid failed, falling back to bbox grid:', e.message);
    return buildDenmarkGrid();
  }
}

// Single-location fetch — proven reliable with Open-Meteo.
function fetchOpenMeteo(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&hourly=precipitation,temperature_2m,windspeed_10m,winddirection_10m` +
      `&wind_speed_unit=ms&past_days=7&forecast_days=4` +
      `&models=best_match&timezone=Europe%2FCopenhagen`;
    https.get(url, (resp) => {
      if (resp.statusCode !== 200) {
        reject(new Error(`Open-Meteo HTTP ${resp.statusCode}`));
        resp.resume();
        return;
      }
      let body = '';
      resp.on('data', (c) => (body += c));
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function isTransientOpenMeteoError(err) {
  return /Open-Meteo HTTP (502|503|504)/.test(err.message || '');
}

async function fetchOpenMeteoWithRetry(lat, lng, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOpenMeteo(lat, lng);
    } catch (e) {
      if (attempt >= retries || !isTransientOpenMeteoError(e)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// Compute derived precipitation metrics from raw Open-Meteo JSON.
function computeMetrics(json) {
  const times = json?.hourly?.time || [];
  const values = json?.hourly?.precipitation || [];
  const tempVals = json?.hourly?.temperature_2m || [];
  const windVals = json?.hourly?.windspeed_10m || [];
  const windDirs = json?.hourly?.winddirection_10m || [];
  const now = Date.now();
  const MS_HOUR = 3600 * 1000;
  const TAU = 3.0;
  let todayMM = 0, forecastMM = 0, forecastMM72h = 0, totalRain7d = 0;
  const hourlyObs = [], hourlyFore = [], hourlyWeek = [];
  let tempSum72h = 0, tempCount72h = 0;
  const hourlyTempWeek = [];
  let todayMaxAirTemp = null;
  const todayDateStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' });

  let currentWindSpeed = null, currentWindDir = null, bestWindDiffMs = Infinity;

  times.forEach((tStr, i) => {
    const mm = Math.max(Number(values[i]) || 0, 0);
    const tMs = new Date(tStr).getTime();
    if (isNaN(tMs)) return;
    const diffMs = now - tMs;

    const temp = Number(tempVals[i]);
    const hasTemp = !isNaN(temp);
    hourlyTempWeek.push(hasTemp ? temp : null);
    if (hasTemp && tStr.slice(0, 10) === todayDateStr) {
      if (todayMaxAirTemp === null || temp > todayMaxAirTemp) todayMaxAirTemp = temp;
    }

    const windSpeed = Number(windVals[i]);
    if (!isNaN(windSpeed) && Math.abs(diffMs) < bestWindDiffMs) {
      bestWindDiffMs = Math.abs(diffMs);
      currentWindSpeed = windSpeed;
      const wd = Number(windDirs[i]);
      currentWindDir = isNaN(wd) ? null : wd;
    }

    if (diffMs >= 0) {
      totalRain7d += mm;
      hourlyWeek.push(mm);
      if (diffMs < 24 * MS_HOUR) { todayMM += mm; hourlyObs.push(mm); }
      if (hasTemp && diffMs < 72 * MS_HOUR) { tempSum72h += temp; tempCount72h++; }
    } else {
      if (-diffMs <= 24 * MS_HOUR) { forecastMM += mm; hourlyFore.push(mm); }
      if (-diffMs <= 72 * MS_HOUR) { forecastMM72h += mm; }
    }
  });
  const recentAirTempAvg = tempCount72h > 0 ? tempSum72h / tempCount72h : null;
  const decayedSeries = riskModel.accumulateDecayed(hourlyWeek, TAU);
  const antecedentMM = decayedSeries.length ? decayedSeries[decayedSeries.length - 1] : 0;
  return {
    antecedentMM, todayMM, forecastMM, forecastMM72h, totalRain7d, hourlyObs, hourlyFore, hourlyWeek,
    recentAirTempAvg, todayMaxAirTemp, hourlyTempWeek,
    currentWindSpeed, currentWindDir,
  };
}

module.exports = {
  GRID_DEG, gridKey, buildDenmarkGrid, buildPulsGrid,
  fetchOpenMeteo, isTransientOpenMeteoError, fetchOpenMeteoWithRetry, computeMetrics,
};
