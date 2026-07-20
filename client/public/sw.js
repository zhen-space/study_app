const CACHE = 'tt-v5';   // 換版號強制丟掉舊快取，確保拿到新程式
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
