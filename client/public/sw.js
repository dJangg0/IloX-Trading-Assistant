// BandAlert service worker: push receiver + notificationclick (handoff §7.5).
// Apple permanently revokes push permission if a push arrives without a visible notification,
// so EVERY push event must call showNotification inside waitUntil, even when the payload is bad.

self.addEventListener('install', () => self.skipWaiting());

// Pass-through fetch handler. Chrome requires one for installability. No caching, so the server always answers.
self.addEventListener('fetch', () => {});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function parsePayload(event) {
  if (!event.data) return { title: 'BandAlert', body: 'New alert' };
  try {
    return event.data.json();
  } catch {
    return { title: 'BandAlert', body: event.data.text() || 'New alert' };
  }
}

self.addEventListener('push', (event) => {
  const data = parsePayload(event);
  const timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
  const symbol = data.symbol || 'ALERT';
  const timeframe = data.timeframe || 'NA';

  event.waitUntil(
    self.registration.showNotification(data.title || 'BandAlert', {
      body: data.body || '',
      tag: `${symbol}-${timeframe}-${timestamp}`,
      renotify: true,
      timestamp,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
