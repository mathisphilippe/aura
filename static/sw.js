self.addEventListener('push', (event) => {
  if (!event.data) return;
  const payload = event.data.json();

  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/' },
    vibrate: [200, 100, 200]
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || '⚡ Nouveau sur Aura', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});