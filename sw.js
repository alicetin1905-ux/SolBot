// SolBot service worker: makes the home-screen app open without network and shows
// notifications. Network-first for our own files (so updates are never stale);
// API calls to other sites are never cached.
const CACHE = 'solbot-shell-v2'; // bump to refresh cached icons
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/apple-touch-icon.png', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // live data: always network
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
        // keep only the newest version of each versioned file (?v=…)
        for (const k of await cache.keys()) {
          const ku = new URL(k.url);
          if (ku.pathname === url.pathname && ku.search !== url.search && url.search.includes('v=')) await cache.delete(k);
        }
      }
      return res;
    } catch {
      return (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('./#/paper');
  })());
});
