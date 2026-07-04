// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko — Node/Express server
//
// Serves the static map app and provides a weather proxy with a shared
// server-side cache. This collapses Open-Meteo calls from "per browser"
// to "per 0.25° grid cell per 3h, globally".
//
// Run:
//   npm install
//   node server.js
//   → http://localhost:3000
//
// Endpoints:
//   GET /                         → dansk-overloeb-kort.html
//   GET /puls-data.json           → PULS dataset (Cache-Control 14 days)
//   GET /api/weather/all          → full pre-warmed grid as one cacheable response
//   GET /api/weather/hourly?key=  → hourlyObs+hourlyFore for one cell (on demand)
//   GET /api/weather?lat=&lng=    → single cell (fallback)
//   GET /api/health               → status + cache stats
// ═══════════════════════════════════════════════════════════════════════════

const express     = require('express');
const compression = require('compression');
const path        = require('path');
const https       = require('https');
const webpush     = require('web-push');

// ── VAPID configuration ─────────────────────────────────────────────────────
// Set these as environment variables on Fly.io:
//   fly secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...
// Never commit private key to git.
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@dkvand.fly.dev';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('Web Push VAPID configured');
} else {
  console.warn('VAPID keys not set — push notifications disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
}

// In-memory subscription store — persists for server lifetime.
// For multi-instance or persistent storage, replace with a database.
const pushSubscriptions = new Map();  // key: endpoint URL → subscription object

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Gzip everything — JSON payloads compress ~70-80%
app.use(compression());

// ── Static files with appropriate cache headers ─────────────────────────────
const STATIC_DIR = __dirname;

// PULS data: changes once a year → cache aggressively
app.get('/puls-data.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=1209600');  // 14 days
  res.sendFile(path.join(STATIC_DIR, 'puls-data.json'));
});

// VP3 geodata: static reference files updated rarely → cache 1 week
const VP3_FILES = [
  'vp3_kystvande_simplified.geojson',
  'vp3_badevand.geojson',
  'vp3_rbu_slim.geojson',
];
VP3_FILES.forEach(f => {
  app.get('/' + f, (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');  // 7 days
    res.sendFile(path.join(STATIC_DIR, f));
  });
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
// Grid: 0.25° (~17×28 km) — 4× finer than original 0.5°, reliable API usage.
// TTL: 3 hours. warmCache uses individual single-location calls (proven to work).
// API budget: ~220 cells × 8 warmups/day = ~1.760 calls/day (well under 10.000).
const GRID_DEG       = 0.25;
const WEATHER_TTL_MS = 6 * 3600 * 1000;  // 6 hours — 420 cells × 4/day = 1.680 calls/day
const weatherCache   = new Map();
let   apiCallCount   = 0;
let   cacheHitCount  = 0;
const fetchErrors    = [];   // ring buffer — last 5 errors from fetchOpenMeteo

function gridKey(lat, lng) {
  const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  return `${clat.toFixed(4)}:${clng.toFixed(4)}`;
}

// Build grid from actual PULS overflow point coordinates — only cells that
// contain real data points. Avoids warming ~220 sea/foreign bbox cells.
// puls-data.json format: { a: [authorities], w: [waterAreas], d: [[lat,lng,...], ...] }
// Typically ~150-180 unique 0.25° cells vs 420 for full bbox.
let _pulsGrid = null;
function buildPulsGrid() {
  if (_pulsGrid) return _pulsGrid;
  try {
    const raw  = require('fs').readFileSync(path.join(STATIC_DIR, 'puls-data.json'), 'utf8');
    const data = JSON.parse(raw);
    const rows = data?.d || data;                  // compressed: { d: rows } or raw array
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
    _pulsGrid = cells;
    return cells;
  } catch(e) {
    console.warn('buildPulsGrid failed, falling back to bbox grid:', e.message);
    return buildDenmarkGrid();
  }
}

// Denmark + Bornholm bounding box at 0.25°. Fallback if buildPulsGrid fails.
function buildDenmarkGrid() {
  const iLatMin = Math.floor(54.5 / GRID_DEG);
  const iLatMax = Math.ceil(57.9  / GRID_DEG);
  const iLngMin = Math.floor(8.0  / GRID_DEG);
  const iLngMax = Math.ceil(15.4  / GRID_DEG);
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

// Single-location fetch — proven reliable with Open-Meteo.
function fetchOpenMeteo(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&hourly=precipitation&past_days=7&forecast_days=2` +
      `&models=best_match&timezone=Europe%2FCopenhagen`;
    https.get(url, resp => {
      if (resp.statusCode !== 200) {
        reject(new Error(`Open-Meteo HTTP ${resp.statusCode}`));
        resp.resume(); return;
      }
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Compute derived precipitation metrics from raw Open-Meteo JSON.
function computeMetrics(json) {
  const times  = json?.hourly?.time         || [];
  const values = json?.hourly?.precipitation || [];
  const now    = Date.now();
  const MS_HOUR = 3600 * 1000;
  const TAU    = 3.0;
  let antecedentMM = 0, todayMM = 0, forecastMM = 0, totalRain7d = 0;
  const hourlyObs = [], hourlyFore = [], hourlyWeek = [];
  times.forEach((tStr, i) => {
    const mm  = Math.max(Number(values[i]) || 0, 0);
    const tMs = new Date(tStr).getTime();
    if (isNaN(tMs)) return;
    const diffMs  = now - tMs;
    const ageDays = diffMs / (86400 * 1000);
    if (diffMs >= 0) {
      if (mm > 0) antecedentMM += mm * Math.exp(-ageDays / TAU);
      totalRain7d += mm;
      hourlyWeek.push(mm);  // full 7-day history
      if (diffMs < 24 * MS_HOUR) { todayMM += mm; hourlyObs.push(mm); }
    } else {
      if (-diffMs <= 24 * MS_HOUR) { forecastMM += mm; hourlyFore.push(mm); }
    }
  });
  return { antecedentMM, todayMM, forecastMM, totalRain7d, hourlyObs, hourlyFore, hourlyWeek };
}

// ── Proactive cache warming ──────────────────────────────────────────────────
// Individual single-location calls, CONCURRENCY=30. ~220 cells → ~10s warmup.
let warmRunning = false;
async function warmCache() {
  if (warmRunning) return;
  warmRunning = true;
  const cells = buildPulsGrid();
  const CONC  = 10;    // 10 parallelle kald — undgår burst rate-limit hos Open-Meteo
  let idx = 0, fetched = 0, skipped = 0, failed = 0;
  const t0 = Date.now();

  async function worker(workerIdx) {
    // Stagger worker start times med 200ms — fordeler burst-toppen
    await new Promise(r => setTimeout(r, workerIdx * 200));
    while (idx < cells.length) {
      const cell = cells[idx++];
      const key  = gridKey(cell.lat, cell.lng);
      const cached = weatherCache.get(key);
      if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) { skipped++; continue; }
      try {
        apiCallCount++;
        const raw  = await fetchOpenMeteo(cell.lat, cell.lng);
        const data = computeMetrics(raw);
        weatherCache.set(key, { ts: Date.now(), data });
        fetched++;
      } catch(e) {
        failed++;
        const errMsg = e.message;
        console.warn('warmCache cell failed:', key, errMsg);
        fetchErrors.push({ ts: new Date().toISOString(), key, error: errMsg });
        if (fetchErrors.length > 10) fetchErrors.shift();
        // Vent 2s ved 429 inden næste forsøg i denne worker
        if (errMsg.includes('429')) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, cells.length) }, (_, i) => worker(i)));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`warmCache: ${fetched} fetched, ${skipped} skipped, ${failed} failed — ${elapsed}s — cache: ${weatherCache.size} cells`);
  warmRunning = false;
}

// Opvarm ved opstart (2 forsøg: 2s og 10s) og derefter hvert 6. time.
// To setTimeout-kald sikrer at opvarmning sker selvom det første fejler.
setTimeout(() => warmCache().catch(e => console.warn('warmCache (2s):', e.message)), 2000);
setTimeout(() => { if (weatherCache.size === 0) warmCache().catch(e => console.warn('warmCache (10s):', e.message)); }, 10000);
setInterval(() => warmCache().catch(e => console.warn('warmCache (interval):', e.message)), WEATHER_TTL_MS);

app.get('/api/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  const key    = gridKey(lat, lng);
  const cached = weatherCache.get(key);

  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
    cacheHitCount++;
    res.set('Cache-Control', 'public, max-age=10800');  // 3h
    res.set('X-Cache', 'HIT');
    return res.json(cached.data);
  }

  try {
    apiCallCount++;
    const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
    const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
    const raw  = await fetchOpenMeteo(clat, clng);
    const data = computeMetrics(raw);
    weatherCache.set(key, { ts: Date.now(), data });
    res.set('Cache-Control', 'public, max-age=10800');
    res.set('X-Cache', 'MISS');
    res.json(data);
  } catch(e) {
    if (cached) { res.set('X-Cache', 'STALE'); return res.json(cached.data); }
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/weather/all — full pre-warmed grid in one cacheable response ────
// Returns all warm cells as { "lat:lng": {antecedentMM, todayMM, forecastMM,
// totalRain7d}, ... } — hourly arrays are excluded to keep payload small.
// Browser caches with max-age=3600 (matches server TTL).
// ETag allows 304 Not Modified when data hasn't changed.
app.get('/api/weather/all', (req, res) => {
  // Start opvarmning straks hvis cachen er tom — robust mod manglende setTimeout
  if (weatherCache.size === 0 && !warmRunning) {
    console.log('Cache tom ved /api/weather/all — starter warmCache');
    warmCache().catch(e => console.warn('warmCache fejl:', e.message));
  }

  const out = {};
  let warm = 0, stale = 0;

  for (const [key, entry] of weatherCache) {
    if (Date.now() - entry.ts < WEATHER_TTL_MS) {
      // Strip hourly arrays — client fetches /hourly on demand
      const { hourlyObs: _o, hourlyFore: _f, ...slim } = entry.data;
      out[key] = slim;
      warm++;
      cacheHitCount++;
    } else {
      stale++;
    }
  }

  // ETag baseret på antal varme celler — ændres når cache-indhold ændrer sig
  const etag = `"w${warm}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  // no-cache: browser revaliderer altid via ETag.
  // Forhindrer at en tom {} respons fra cold-start caches i 3 timer.
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', etag);
  res.set('X-Warm-Cells',  String(warm));
  res.set('X-Stale-Cells', String(stale));
  res.json(out);
});

// ── GET /api/weather/weekly?key= — 7-day hourly arrays for bathing water detail
app.get('/api/weather/weekly', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });

  let cached = weatherCache.get(key);

  // Exact cache miss — try nearest cached cell (badevand may be in uncached coastal cell)
  if (!cached || Date.now() - cached.ts >= WEATHER_TTL_MS) {
    const parts = key.split(':');
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'invalid key' });

    // Find nearest warm cell in cache
    let minDist = Infinity;
    for (const [k, entry] of weatherCache) {
      if (Date.now() - entry.ts >= WEATHER_TTL_MS) continue;
      const [kLat, kLng] = k.split(':').map(Number);
      const d = Math.hypot(kLat - lat, kLng - lng);
      if (d < minDist) { minDist = d; cached = entry; }
    }

    // If still no cached cell or too far away (>0.5° ≈ 55km), fetch directly
    if (!cached || minDist > 0.5) {
      try {
        apiCallCount++;
        const raw  = await fetchOpenMeteo(lat, lng);
        const data = computeMetrics(raw);
        weatherCache.set(key, { ts: Date.now(), data });
        cached = { data };
      } catch(e) {
        return res.status(502).json({ error: `Open-Meteo: ${e.message}` });
      }
    }
  }

  const d = cached.data;
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    hourlyObs:   d.hourlyObs  || [],
    hourlyFore:  d.hourlyFore || [],
    hourlyWeek:  d.hourlyWeek || [],
    todayMM:     d.todayMM,
    forecastMM:  d.forecastMM,
    totalRain7d: d.totalRain7d,
  });
});
// Called when user clicks a point or opens a varsel card. Much cheaper than
// bundling 48 floats × 2500 cells into the main /all response.
app.get('/api/weather/hourly', (req, res) => {
  const key    = req.query.key;
  const cached = key ? weatherCache.get(key) : null;

  if (!cached || Date.now() - cached.ts >= WEATHER_TTL_MS) {
    return res.status(404).json({ error: 'Cell not in cache' });
  }

  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    hourlyObs:  cached.data.hourlyObs  || [],
    hourlyFore: cached.data.hourlyFore || [],
  });
});

// ── POST /api/weather/bulk — fallback with limited individual fetches ─────────
// Returns warm cells from cache immediately. Cold cells are fetched individually
// with concurrency=4 so the endpoint is useful even before warmCache completes.
app.use(express.json({ limit: '1mb' }));

app.post('/api/weather/bulk', async (req, res) => {
  const cells = Array.isArray(req.body?.cells) ? req.body.cells : [];
  if (cells.length === 0 || cells.length > 5000) {
    return res.status(400).json({ error: 'cells array (1–5000) required' });
  }

  const out     = {};
  const cold    = [];
  let   hits = 0, misses = 0;

  for (const cell of cells) {
    const lat = parseFloat(cell.lat), lng = parseFloat(cell.lng);
    if (isNaN(lat) || isNaN(lng)) continue;
    const key    = gridKey(lat, lng);
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
      const { hourlyObs: _o, hourlyFore: _f, ...slim } = cached.data;
      out[key] = slim;
      hits++;
      cacheHitCount++;
    } else {
      cold.push({ lat, lng, key, cached });
      misses++;
    }
  }

  // Fetch cold cells individually with limited concurrency
  if (cold.length > 0) {
    const CONC = 4;
    let idx = 0;
    async function worker() {
      while (idx < cold.length) {
        const { lat, lng, key, cached } = cold[idx++];
        try {
          apiCallCount++;
          const raw  = await fetchOpenMeteo(lat, lng);
          const data = computeMetrics(raw);
          weatherCache.set(key, { ts: Date.now(), data });
          const { hourlyObs: _o, hourlyFore: _f, ...slim } = data;
          out[key] = slim;
        } catch(e) {
          if (cached) {
            const { hourlyObs: _o, hourlyFore: _f, ...slim } = cached.data;
            out[key] = slim;
          } else {
            out[key] = null;
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, cold.length) }, worker));
  }

  res.set('Cache-Control', 'no-store');
  res.set('X-Cache-Hits',   String(hits));
  res.set('X-Cache-Misses', String(misses));
  res.json(out);
});

// ── Save latest warnPoints for push evaluation ──────────────────────────────
// The client POSTs its computed warnPoints after each render so the server
// can send push notifications to subscribers who have matching favourites.
let _latestWarnPoints = [];
app.post('/api/push/warnpoints', async (req, res) => {
  const { warnPoints } = req.body || {};
  if (!Array.isArray(warnPoints)) return res.status(400).json({ error: 'Invalid' });
  _latestWarnPoints = warnPoints;
  await sendPushNotifications(warnPoints);
  res.json({ ok: true, warned: warnPoints.length });
});

// ── Web Push: VAPID public key ─────────────────────────────────────────────
// Client fetches this to create a push subscription.
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ── Web Push: save subscription ────────────────────────────────────────────
// Client POSTs its PushSubscription object here after subscribing.
// Body: { subscription: {...}, favourites: [id, ...] }
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, favourites } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  pushSubscriptions.set(subscription.endpoint, {
    subscription,
    favourites: favourites || [],
    ts: Date.now(),
  });
  console.info('Push subscription saved, total:', pushSubscriptions.size);
  res.json({ ok: true });
});

// ── Web Push: update favourites for a subscription ─────────────────────────
app.post('/api/push/update-favourites', (req, res) => {
  const { endpoint, favourites } = req.body || {};
  const entry = pushSubscriptions.get(endpoint);
  if (!entry) return res.status(404).json({ error: 'Subscription not found' });
  entry.favourites = favourites || [];
  res.json({ ok: true });
});

// ── Web Push: unsubscribe ──────────────────────────────────────────────────
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  pushSubscriptions.delete(endpoint);
  res.json({ ok: true });
});

// ── Web Push: send notifications to all subscribers ────────────────────────
// Called internally by the server's weather-refresh cycle.
// Also exposed as POST /api/push/send for manual triggering (e.g. cron job).
async function sendPushNotifications(warnPoints) {
  if (!VAPID_PUBLIC_KEY || pushSubscriptions.size === 0) return;

  const warnMap = new Map(warnPoints.map(p => [String(p.id), p]));
  let sent = 0, failed = 0;

  for (const [endpoint, entry] of pushSubscriptions) {
    const { subscription, favourites } = entry;
    // Find which of this user's favourites are in the warn list
    const hits = (favourites || [])
      .map(id => warnMap.get(String(id)))
      .filter(Boolean)
      .filter(pt => (pt.forecastMM || 0) > 5 || (pt.todayMM || 0) > 5);

    if (hits.length === 0) continue;

    const payload = JSON.stringify({
      title: `⚠ Overløbsvarsling: ${hits[0].name}${hits.length > 1 ? ` +${hits.length - 1}` : ''}`,
      body: hits.map(pt =>
        `${pt.name} · ${(( pt.foreRisk || 0)*100).toFixed(0)}% risiko · ${(pt.forecastMM||0).toFixed(1)} mm prognose`
      ).join('\n'),
      tag: 'overloeb-varsling',
      url: '/',
    });

    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription expired — remove it
        pushSubscriptions.delete(endpoint);
      }
      failed++;
    }
  }

  if (sent + failed > 0) {
    console.info(`Push sent: ${sent}, failed/expired: ${failed}`);
  }
}

// Manual trigger endpoint (for testing)
app.post('/api/push/send', async (req, res) => {
  // Accept a warnPoints array directly for testing
  const { warnPoints } = req.body || {};
  if (!Array.isArray(warnPoints)) return res.status(400).json({ error: 'warnPoints array required' });
  await sendPushNotifications(warnPoints);
  res.json({ ok: true, subscribers: pushSubscriptions.size });
});

// ── GET /api/debug — cache diagnostics ───────────────────────────────────────
app.get('/api/debug', (req, res) => {
  const all   = [...weatherCache.entries()];
  const now   = Date.now();
  const warm  = all.filter(([, e]) => now - e.ts < WEATHER_TTL_MS);
  const stale = all.filter(([, e]) => now - e.ts >= WEATHER_TTL_MS);
  const sample = warm.slice(0, 5).map(([k, e]) => ({
    key:          k,
    antecedentMM: e.data?.antecedentMM ?? null,
    todayMM:      e.data?.todayMM      ?? null,
    forecastMM:   e.data?.forecastMM   ?? null,
    hourlyObsLen: e.data?.hourlyObs?.length ?? 0,
    ageSeconds:   Math.round((now - e.ts) / 1000),
  }));
  res.json({
    timestamp:      new Date().toISOString(),
    GRID_DEG,
    WEATHER_TTL_MS,
    warmRunning,
    cacheTotal:     all.length,
    warmCells:      warm.length,
    staleCells:     stale.length,
    apiCallsTotal:  apiCallCount,
    cacheHitsTotal: cacheHitCount,
    buildGridSize:  buildDenmarkGrid().length,
    pulsGridSize:   (_pulsGrid || buildPulsGrid()).length,
    lastErrors:     fetchErrors,
    sample,
  });
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

app.listen(PORT, HOST, () => {
  console.log(`Overløbsrisiko server kører på http://${HOST}:${PORT}`);
  console.log(`  Vejr-proxy: /api/weather?lat=55.7&lng=12.5`);
  console.log(`  Bulk:       POST /api/weather/bulk { cells: [...] }`);
  console.log(`  Status:     /api/health`);
});
