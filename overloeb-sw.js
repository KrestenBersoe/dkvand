// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko Service Worker — Web Push handler
// Receives push messages from the server and shows native notifications,
// even when the app is closed or the screen is locked.
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

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
