// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko — Node/Express server
//
// Serves the static map app and provides a weather proxy with a shared
// server-side cache. This collapses Open-Meteo calls from "per browser"
// to "per 0.1° grid cell per hour, globally".
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
// Grid: 0.1° (~7×11 km) — matches DMI HARMONIE-AROME resolution closely.
// TTL: 1 hour — balances freshness with API budget.
// Warming: at startup and every hour, all ~1.200 DK cells are refreshed
//          proactively in 12 bulk calls (100 cells each) so users always
//          hit a warm cache. 12 calls/hour × 24h = 288 calls/day — well
//          within Open-Meteo free tier (10.000/day).
const GRID_DEG       = 0.1;
const WEATHER_TTL_MS = 1 * 3600 * 1000;  // 1 hour
const weatherCache   = new Map(); // key → { ts, data }
let   apiCallCount   = 0;
let   cacheHitCount  = 0;

function gridKey(lat, lng) {
  const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  return `${clat.toFixed(4)}:${clng.toFixed(4)}`;
}

// Denmark bounding box + Bornholm. Generates ~1.200 cells at 0.1°.
// Uses integer iteration to avoid floating point drift from repeated += 0.1.
// Cell centres are derived via gridKey() itself — guaranteeing they always
// match what gridKey() produces for any real PULS point inside the cell.
function buildDenmarkGrid() {
  const iLatMin = Math.floor(54.5 / GRID_DEG);  // 545
  const iLatMax = Math.ceil(57.9  / GRID_DEG);  // 579
  const iLngMin = Math.floor(8.0  / GRID_DEG);  // 80
  const iLngMax = Math.ceil(15.4  / GRID_DEG);  // 154

  const cells = [];
  const seen  = new Set();

  for (let iLat = iLatMin; iLat < iLatMax; iLat++) {
    for (let iLng = iLngMin; iLng < iLngMax; iLng++) {
      // Sample a point 10% into the cell — avoids boundary ambiguity.
      // gridKey() snaps it to the canonical cell centre.
      const sampLat = (iLat + 0.1) * GRID_DEG;
      const sampLng = (iLng + 0.1) * GRID_DEG;
      const key = gridKey(sampLat, sampLng);
      if (seen.has(key)) continue;
      seen.add(key);
      const [latStr, lngStr] = key.split(':');
      cells.push({ lat: parseFloat(latStr), lng: parseFloat(lngStr) });
    }
  }
  return cells;
}

// Bulk fetch up to 100 locations in a single Open-Meteo request.
// Returns array of results in same order as input cells.
function fetchOpenMeteoBulk(cells) {
  return new Promise((resolve, reject) => {
    const lats = cells.map(c => c.lat.toFixed(4)).join(',');
    const lngs = cells.map(c => c.lng.toFixed(4)).join(',');
    const url  = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lats}&longitude=${lngs}` +
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
        try {
          const parsed = JSON.parse(body);
          // Single location → wrap in array for uniform handling
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Single-cell fetch (used by /api/weather endpoint as fallback)
function fetchOpenMeteo(lat, lng) {
  return fetchOpenMeteoBulk([{ lat, lng }]).then(arr => arr[0]);
}

// Compute derived precipitation metrics from raw Open-Meteo JSON.
function computeMetrics(json) {
  const times  = json?.hourly?.time         || [];
  const values = json?.hourly?.precipitation || [];
  const now    = Date.now();
  const MS_HOUR = 3600 * 1000;
  const TAU    = 3.0; // days — hydrological memory (soil saturation / sewer load)

  let antecedentMM = 0, todayMM = 0, forecastMM = 0, totalRain7d = 0;
  const hourlyObs  = [];  // last 24h observed, oldest first
  const hourlyFore = [];  // next 24h forecast, soonest first

  times.forEach((tStr, i) => {
    const mm  = Math.max(Number(values[i]) || 0, 0);
    const tMs = new Date(tStr).getTime();
    if (isNaN(tMs)) return;
    const diffMs  = now - tMs;
    const ageDays = diffMs / (86400 * 1000);
    if (diffMs >= 0) {
      if (mm > 0) antecedentMM += mm * Math.exp(-ageDays / TAU);
      totalRain7d += mm;
      if (diffMs < 24 * MS_HOUR) { todayMM += mm; hourlyObs.push(mm); }
    } else {
      if (-diffMs <= 24 * MS_HOUR) { forecastMM += mm; hourlyFore.push(mm); }
    }
  });

  return { antecedentMM, todayMM, forecastMM, totalRain7d, hourlyObs, hourlyFore };
}

// ── Proactive cache warming ──────────────────────────────────────────────────
// Refreshes all stale cells. Runs at startup and every hour.
// CHUNK=10: conservative — Open-Meteo multi-location works reliably at ≤10.
let warmRunning = false;
async function warmCache() {
  if (warmRunning) return;
  warmRunning = true;
  const cells  = buildDenmarkGrid();
  const CHUNK  = 10;
  let fetched  = 0, skipped = 0, failed = 0;
  const t0     = Date.now();

  for (let i = 0; i < cells.length; i += CHUNK) {
    const chunk = cells.slice(i, i + CHUNK);
    const stale = chunk.filter(c => {
      const cached = weatherCache.get(gridKey(c.lat, c.lng));
      return !cached || Date.now() - cached.ts >= WEATHER_TTL_MS;
    });
    skipped += chunk.length - stale.length;
    if (stale.length === 0) continue;

    try {
      apiCallCount++;
      const results = await fetchOpenMeteoBulk(stale);
      results.forEach((json, idx) => {
        const cell = stale[idx];
        if (!cell || !json?.hourly) return;  // skip malformed responses
        weatherCache.set(gridKey(cell.lat, cell.lng), { ts: Date.now(), data: computeMetrics(json) });
        fetched++;
      });
    } catch(e) {
      failed += stale.length;
      console.warn(`warmCache chunk ${i}–${i + CHUNK} failed:`, e.message);
    }

    // 200ms pause between chunks
    if (i + CHUNK < cells.length) await new Promise(r => setTimeout(r, 200));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`warmCache: ${fetched} fetched, ${skipped} skipped, ${failed} failed — ${elapsed}s — cache size: ${weatherCache.size}`);
  warmRunning = false;
}

// Stagger first warm by 2s to let server finish binding, then every hour.
setTimeout(warmCache, 2000);
setInterval(warmCache, WEATHER_TTL_MS);

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
    res.set('Cache-Control', 'public, max-age=3600');
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
    res.set('Cache-Control', 'public, max-age=3600');
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

  const etag = `"${warm}-${Math.floor(Date.now() / 60000)}"`;  // changes each minute
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', etag);
  res.set('X-Warm-Cells',  String(warm));
  res.set('X-Stale-Cells', String(stale));
  res.json(out);
});

// ── GET /api/weather/hourly?key= — hourly arrays for one cell on demand ──────
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
