// ═══════════════════════════════════════════════════════════════════════════
// Overløbsrisiko Service Worker
// Handles WebPush notifications for favourite overflow points
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'overloeb-sw-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Push event — payload from server (or triggered locally via showNotification)
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  const title   = data.title   || '⚠ Overløbsvarsling';
  const body    = data.body    || 'Et favorit-udløb har høj overløbsrisiko.';
  const tag     = data.tag     || 'overloeb-warn';
  const url     = data.url     || '/';
  const icon    = data.icon    || '';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon,
      badge: icon,
      data: { url },
      requireInteraction: false,
      vibrate: [200, 100, 200],
    })
  );
});

// Notification click — focus or open the map
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('overloeb'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
