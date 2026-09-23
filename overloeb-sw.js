// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko Service Worker — Web Push handler
// Receives push messages from the server and shows native notifications,
// even when the app is closed or the screen is locked.
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await clients.claim();
    // Rydder tidligere versioner af tile-/map-assets-cachen, hvis navnet
    // (v1, v2, ...) nogensinde ændres i en senere rettelse.
    const keep  = new Set([TILE_CACHE_NAME, MAP_ASSETS_CACHE_NAME]);
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('overloeb-') && !keep.has(n)).map(n => caches.delete(n))
    );
  })());
});

// ── Kort-flise- og map-assets-caching (Cache Storage API) ───────────────────
// RETTET (bruger-rapporteret: baggrundskortet forsvinder i PWA'en på Android
// efter et stykke tid): denne SW havde tidligere INGEN 'fetch'-handler
// overhovedet. Kort-fliserne (coverage.pmtiles, hentet af MapLibre/pmtiles
// via mange små Range-requests, se server.js's /tiles-route) og map-assets
// (style.json/sprite/fonts) lå derfor udelukkende i browserens almindelige
// HTTP-diskcache — som Android frit rydder under lagerplads-pres, UDEN at en
// installeret PWA har nogen særlig beskyttelse (der er ingen
// navigator.storage.persist()-kald noget sted i kodebasen, se
// registerSW() i dansk-overloeb-kort.html for det nye kald). Cache Storage
// API (denne fil) deltager derimod i browserens "persistent storage"-
// kvotesystem og overlever markant længere under samme pres.
//
// Fliserne kan IKKE caches som hele filer (coverage.pmtiles er ~5,5 GB) —
// kun de faktisk hentede byte-ranges caches, hver Range-request som sin egen
// post. Cache API matcher som udgangspunkt KUN på URL, ikke headers — uden en
// Vary: Range-header på det cachede svar ville alle Range-requests til
// samme fil kollidere (forkert byterække returneret for en ny range).
// cacheTilePut() sætter derfor selv Vary: Range på hvert cachet 206-svar.
const TILE_CACHE_NAME       = 'overloeb-tiles-v1';
const MAP_ASSETS_CACHE_NAME = 'overloeb-map-assets-v1';
const TILE_CACHE_INDEX_URL  = '/__tile-cache-index__';   // syntetisk nøgle inde i selve tile-cachen — aldrig hentet fra netværket, kun brugt til evictions-metadata
const TILE_CACHE_MAX_BYTES  = 200 * 1024 * 1024;          // 200 MB — rigeligt til en almindelig browsing-session, langt under filens fulde 5,5 GB

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/tiles/coverage.pmtiles') {
    e.respondWith(handleTileFetch(request));
  } else if (url.pathname.startsWith('/map-assets/')) {
    e.respondWith(handleMapAssetFetch(request));
  }
});

async function handleTileFetch(request) {
  const cache  = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);   // offline + ingen cache-hit for denne specifikke byterække: fejlen propagerer som normalt
  if (response.status === 200 || response.status === 206) {
    cacheTilePut(cache, request, response.clone()).catch(() => {});
  }
  return response;
}

async function cacheTilePut(cache, request, response) {
  const headers      = new Headers(response.headers);
  const existingVary = headers.get('Vary');
  if (!existingVary) headers.set('Vary', 'Range');
  else if (!existingVary.split(',').map(s => s.trim()).includes('Range')) headers.set('Vary', existingVary + ', Range');

  const body   = await response.arrayBuffer();
  const stored = new Response(body, { status: response.status, statusText: response.statusText, headers });
  await cache.put(request, stored);
  await recordTileCacheEntry(cache, request, body.byteLength);
}

// Simpelt FIFO-evictions-register, gemt som sin egen JSON-post INDE i selve
// tile-cachen — undgår at skulle bumpe den delte overloeb_cache IndexedDB-
// version, som både denne fil og dansk-overloeb-kort.html i forvejen deler
// skrøbeligt (se DB_VERSION=3-kommentaren dér).
async function recordTileCacheEntry(cache, request, size) {
  const range    = request.headers.get('Range') || '';
  const entryKey = request.url + '|' + range;

  let index = [];
  const idxResp = await cache.match(TILE_CACHE_INDEX_URL);
  if (idxResp) {
    try { index = await idxResp.json(); } catch (_) { index = []; }
  }
  index = index.filter(entry => entry.key !== entryKey);
  index.push({ key: entryKey, size, ts: Date.now(), url: request.url, range: range || null });

  let total = index.reduce((sum, entry) => sum + entry.size, 0);
  while (total > TILE_CACHE_MAX_BYTES && index.length > 0) {
    const oldest = index.shift();
    total -= oldest.size;
    const evictReq = new Request(oldest.url, oldest.range ? { headers: { Range: oldest.range } } : undefined);
    await cache.delete(evictReq).catch(() => {});
  }

  await cache.put(TILE_CACHE_INDEX_URL, new Response(JSON.stringify(index)));
}

async function handleMapAssetFetch(request) {
  const cache  = await caches.open(MAP_ASSETS_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.status === 200) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

// ── Push event ──────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(_) {}

  // NYT: installations-heartbeat, sendt af serverens periodiske engagement-
  // job (se server.js's runPeriodicEngagementJob()) — BEVIDST INGEN
  // showNotification() her. Formålet er udelukkende at bekræfte SW'en
  // stadig vækkes/lever på dette device, ikke at vise brugeren noget. Ved
  // kun 1-2 stille push/dag er dette almindelig, veletableret praksis;
  // installId/platform kommer direkte fra push-payloaden (serveren husker
  // dem allerede fra abonnerings-tidspunktet, se /api/push/subscribe), så
  // denne sti behøver IKKE selv slå noget op i IndexedDB.
  if (data.type === 'heartbeat') {
    e.waitUntil(
      fetch('/api/install/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: data.installId, platform: data.platform, pushEnabled: true, via: 'push' }),
      }).catch(() => {})   // stille — en fejlet fetch her må ikke kaste ubehandlet inde i waitUntil
    );
    return;
  }

  const title   = data.title || '⚠ Overløbsvarsling';
  const options = {
    body:               data.body || 'Et favorit-udløb har forhøjet overløbsrisiko.',
    tag:                data.tag  || 'overloeb',
    icon:               '/icon-192.png',
    badge:              '/icon-192.png',
    data:               { url: data.url || '/' },
    requireInteraction: false,
    vibrate:            [200, 100, 200],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Periodic Background Sync (Android/Chrome kun — best-effort, ingen
// garanteret kadence, browseren styrer selv timing) ─────────────────────────
// Supplerer push-heartbeatet ovenfor for installationer der IKKE har givet
// notifikationstilladelse — kan derfor ikke nås via push, men kan stadig
// bekræfte sig selv "stadig installeret" via denne sti på Android/Chrome.
// iOS/Safari understøtter ikke Periodic Background Sync overhovedet — for
// den slags installationer sker bekræftelse KUN når brugeren rent faktisk
// åbner appen (se sendInstallHeartbeat() i dansk-overloeb-kort.html).
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'heartbeat') return;
  e.waitUntil(sendPeriodicSyncHeartbeat());
});

// Duplikeret, minimal IndexedDB-læsning — SW'en kan ikke importere
// dansk-overloeb-kort.html's egen openDB()/dbGet()-helper (separat
// script-kontekst), men læser samme database/store, skrevet af klienten ved
// boot (se STORE_INSTALL/DB_VERSION 3 i dansk-overloeb-kort.html). Ingen
// onupgradeneeded her — siden har altid allerede oprettet storen FØR SW'en
// kan modtage et periodicsync (registreringen sker fra samme side-context).
function openInstallDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('overloeb_cache', 3);
    req.onsuccess = ev => resolve(ev.target.result);
    req.onerror   = ev => reject(ev.target.error);
  });
}

async function sendPeriodicSyncHeartbeat() {
  try {
    const db   = await openInstallDb();
    const info = await new Promise((resolve, reject) => {
      const tx  = db.transaction('install_store', 'readonly');
      const req = tx.objectStore('install_store').get('info');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = ev => reject(ev.target.error);
    });
    if (!info?.id) return;   // klienten har endnu ikke nået at skrive installId — intet at sende
    const sub = await self.registration.pushManager.getSubscription();
    await fetch('/api/install/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: info.id, platform: info.platform, pushEnabled: !!sub, via: 'periodicsync' }),
    });
  } catch (_) {
    // Stille — periodicSync er best-effort i forvejen (se filhoved), ingen bruger ser dette
  }
}

// ── Notification click ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => new URL(c.url).origin === self.location.origin);
      // RETTET: fokuserede tidligere blot en allerede åben fane UDEN at
      // navigere den til selve varslets URL — en bruger, der allerede
      // havde appen åben (fx på forsiden), fik derfor aldrig det
      // pågældende udløb/badested vist; fanen blev bare bragt frem,
      // stadig visende hvad den viste i forvejen. navigate() sikrer
      // fanen rent faktisk skifter til den korrekte side først.
      if (existing) {
        return existing.navigate(url).then(c => c.focus());
      }
      return clients.openWindow(url);
    })
  );
});
