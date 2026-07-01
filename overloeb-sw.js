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

// ── Notification click ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => new URL(c.url).origin === self.location.origin);
      return existing ? existing.focus() : clients.openWindow(url);
    })
  );
});
