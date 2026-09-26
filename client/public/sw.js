// Shows Tower's push notifications and opens the conversation they are about. It caches nothing: the page always
// comes from the server.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let message;
  try { message = event.data ? event.data.json() : undefined; } catch { message = undefined; }
  if (!message || typeof message.title !== 'string') return;
  const url = typeof message.url === 'string' && message.url.startsWith('/') ? message.url : '/';
  event.waitUntil(self.registration.showNotification(message.title, {
    body: typeof message.body === 'string' ? message.body : '',
    tag: typeof message.tag === 'string' ? message.tag : undefined,
    icon: '/icon-192.png?v=rainbow-1', badge: '/icon-192.png?v=rainbow-1', data: { url },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find(client => new URL(client.url).origin === self.location.origin);
    // An open page switches to the conversation itself instead of reloading.
    if (page) { page.postMessage({ type: 'tower:open', url: target }); await page.focus().catch(() => {}); return; }
    await self.clients.openWindow(target);
  })());
});
