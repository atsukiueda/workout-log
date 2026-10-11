// オフライン対応: 取得できたらキャッシュを更新し、オフライン時はキャッシュを返す
const CACHE = 'workout-log-v13';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/supabase-config.js',
  'js/config.js',
  'js/sync.js',
  'js/timer.js',
  'js/calc.js',
  'js/app.js',
  'manifest.webmanifest',
  'icon.svg',
  '種目マスタ/トレーニング種目マスタ.csv',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => encodeURI(a)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 同一オリジンと、ライブラリの CDN だけをキャッシュする（Supabase の API 通信は対象外）
  if (e.request.method !== 'GET' || (url.origin !== location.origin && url.hostname !== 'cdn.jsdelivr.net')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
