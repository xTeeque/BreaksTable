/* public/sw.js */
/* Service Worker להתראות Push */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title = data.title || 'תזכורת';
  const body  = data.body  || '';
  const icon  = data.icon  || '/icon-192.png'; // אם יש לכם אייקון
  const url   = data.url   || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body, icon, data: { url },
      badge: '/icon-badge.png', // אופציונלי
      dir: 'rtl',
      lang: 'he-IL',
      vibrate: [100, 50, 100],
      tag: data.tag || 'breaks-reminder',
      renotify: false,
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) { client.navigate(url); return client.focus(); }
      }
      if (clients.openWindow) { return clients.openWindow(url); }
    })
  );
});
