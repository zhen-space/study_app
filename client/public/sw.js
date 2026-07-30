const CACHE = 'tt-v7';   // 換版號強制丟掉舊快取，確保拿到新程式
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png'];

// 裝好就先把外殼放進新快取：不然「舊快取剛被清掉、新快取還是空的」那一瞬間，
// 如果剛好沒網路（iOS 從背景喚醒很常這樣）連 index.html 都拿不到 → 白屏
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api') || req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const r = await fetch(req);
      // 只快取真正成功的回應，別把 404／500 存起來反覆餵給使用者
      if (r && r.status === 200 && r.type === 'basic') {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return r;
    } catch (err) {
      // 離線／網路不穩：依序退回快取、外殼首頁，最後一定要回一個真的 Response。
      // 原本回傳 undefined 會讓整個導覽直接失敗，那就是白屏的來源。
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        const shell = (await caches.match('/')) || (await caches.match('/index.html'));
        if (shell) return shell;
      }
      return new Response('離線中，請連上網路後重新開啟', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
