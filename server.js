// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko — Node/Express server
//
// Serves the static map app and provides a weather proxy with a shared
// server-side cache. This collapses Open-Meteo calls from "per browser"
// to "per 0.5° grid cell per 6h, globally".
//
// Run:
//   npm install
//   node server.js
//   → http://localhost:3000
//
// Endpoints:
//   GET /                      → dansk-overloeb-kort.html
//   GET /puls-data.json        → PULS dataset (Cache-Control 1 year)
//   GET /api/weather?lat=&lng= → weather for a grid cell (shared cache, 6h)
//   GET /api/health            → status + cache stats
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Static files with appropriate cache headers ─────────────────────────────
const STATIC_DIR = __dirname;

// PULS data: changes once a year → cache aggressively
app.get('/puls-data.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
  res.sendFile(path.join(STATIC_DIR, 'puls-data.json'));
});

// HTML: no-cache so the browser always revalidates with the server.
// (Use a short max-age in production once stable; no-cache avoids stale-JS
// confusion during active development.)
app.get(['/', '/dansk-overloeb-kort.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(STATIC_DIR, 'dansk-overloeb-kort.html'));
});

// Service worker: never cache (must update immediately)
app.get('/overloeb-sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(STATIC_DIR, 'overloeb-sw.js'));
});

// ── Weather proxy with shared server-side cache ─────────────────────────────
// Cache key = rounded 0.5° grid cell. TTL = 6 hours.
const WEATHER_TTL_MS = 6 * 3600 * 1000;
const weatherCache   = new Map(); // key → { ts, data }
let   apiCallCount   = 0;
let   cacheHitCount  = 0;

function gridKey(lat, lng) {
  const clat = Math.floor(lat / 0.5) * 0.5 + 0.25;
  const clng = Math.floor(lng / 0.5) * 0.5 + 0.25;
  return `${clat.toFixed(2)}:${clng.toFixed(2)}`;
}

function fetchOpenMeteo(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&hourly=precipitation&past_days=7&forecast_days=2` +
      `&models=dmi_seamless&timezone=Europe%2FCopenhagen`;

    https.get(url, resp => {
      if (resp.statusCode !== 200) {
        reject(new Error(`Open-Meteo HTTP ${resp.statusCode}`));
        resp.resume();
        return;
      }
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Compute the derived precipitation metrics server-side so the client
// receives ready-to-use values (antecedentMM with fixed 3-day hydrological tau,
// todayMM, forecastMM, totalRain7d).
function computeMetrics(json) {
  const times  = json?.hourly?.time         || [];
  const values = json?.hourly?.precipitation || [];
  const now    = Date.now();
  const MS_HOUR = 3600 * 1000;
  const TAU    = 3.0; // days — hydrological memory (soil saturation / sewer load)

  let antecedentMM = 0, todayMM = 0, forecastMM = 0, totalRain7d = 0;

  times.forEach((tStr, i) => {
    const mm = Math.max(Number(values[i]) || 0, 0);
    if (mm === 0) return;
    const tMs = new Date(tStr).getTime();
    if (isNaN(tMs)) return;
    const diffMs  = now - tMs;
    const ageDays = diffMs / (86400 * 1000);
    if (diffMs >= 0) {
      antecedentMM += mm * Math.exp(-ageDays / TAU);
      totalRain7d  += mm;
      if (diffMs < 24 * MS_HOUR) todayMM += mm;
    } else {
      if (-diffMs <= 24 * MS_HOUR) forecastMM += mm;
    }
  });

  return { antecedentMM, todayMM, forecastMM, totalRain7d };
}

app.get('/api/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  const key = gridKey(lat, lng);
  const cached = weatherCache.get(key);

  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
    cacheHitCount++;
    res.set('Cache-Control', 'public, max-age=21600'); // 6h browser/CDN cache
    res.set('X-Cache', 'HIT');
    return res.json(cached.data);
  }

  try {
    apiCallCount++;
    // Fetch using the cell centre coordinates for consistency
    const clat = Math.floor(lat / 0.5) * 0.5 + 0.25;
    const clng = Math.floor(lng / 0.5) * 0.5 + 0.25;
    const raw  = await fetchOpenMeteo(clat, clng);
    const data = computeMetrics(raw);
    weatherCache.set(key, { ts: Date.now(), data });
    res.set('Cache-Control', 'public, max-age=21600');
    res.set('X-Cache', 'MISS');
    res.json(data);
  } catch (e) {
    // On failure, serve stale cache if available rather than nothing
    if (cached) {
      res.set('X-Cache', 'STALE');
      return res.json(cached.data);
    }
    res.status(502).json({ error: e.message });
  }
});

// ── Bulk weather endpoint — fetch many cells in one request ─────────────────
// POST body: { cells: [{lat, lng}, ...] }  → { "key": {metrics}, ... }
// Lets the client request all ~56 grid cells in a single round-trip.
app.use(express.json({ limit: '256kb' }));

app.post('/api/weather/bulk', async (req, res) => {
  const cells = Array.isArray(req.body?.cells) ? req.body.cells : [];
  if (cells.length === 0 || cells.length > 200) {
    return res.status(400).json({ error: 'cells array (1–200) required' });
  }

  const out = {};
  // Process with limited concurrency to avoid hammering Open-Meteo
  const CONCURRENCY = 6;
  let idx = 0;

  async function worker() {
    while (idx < cells.length) {
      const cell = cells[idx++];
      const lat = parseFloat(cell.lat), lng = parseFloat(cell.lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      const key = gridKey(lat, lng);

      const cached = weatherCache.get(key);
      if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
        cacheHitCount++;
        out[key] = cached.data;
        continue;
      }
      try {
        apiCallCount++;
        const clat = Math.floor(lat / 0.5) * 0.5 + 0.25;
        const clng = Math.floor(lng / 0.5) * 0.5 + 0.25;
        const raw  = await fetchOpenMeteo(clat, clng);
        const data = computeMetrics(raw);
        weatherCache.set(key, { ts: Date.now(), data });
        out[key] = data;
      } catch (e) {
        if (cached) out[key] = cached.data;
        else out[key] = { antecedentMM: 0, todayMM: 0, forecastMM: 0, totalRain7d: 0, error: true };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  res.set('Cache-Control', 'public, max-age=21600');
  res.json(out);
});

// ── Health / cache stats ────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    weatherCacheCells: weatherCache.size,
    openMeteoCalls: apiCallCount,
    cacheHits: cacheHitCount,
    hitRate: apiCallCount + cacheHitCount > 0
      ? (cacheHitCount / (apiCallCount + cacheHitCount) * 100).toFixed(1) + '%'
      : 'n/a',
    ttlHours: WEATHER_TTL_MS / 3600000,
  });
});

// Serve any other static assets (varsel page if split out, etc.)
app.use(express.static(STATIC_DIR, { maxAge: '5m' }));

// ── Periodic cache cleanup ──────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of weatherCache) {
    if (now - val.ts > WEATHER_TTL_MS * 2) weatherCache.delete(key);
  }
}, 3600 * 1000);

app.listen(PORT, () => {
  console.log(`Overløbsrisiko server kører på http://localhost:${PORT}`);
  console.log(`  Vejr-proxy: /api/weather?lat=55.7&lng=12.5`);
  console.log(`  Bulk:       POST /api/weather/bulk { cells: [...] }`);
  console.log(`  Status:     /api/health`);
});
