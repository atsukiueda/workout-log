// オフライン対応: 取得できたらキャッシュを更新し、オフライン時はキャッシュを返す
//   GitHub Pages はファイルに「10分間はブラウザのキャッシュを使ってよい」（max-age=600）を付けるため、
//   アプリのファイルは毎回サーバーに更新の有無を確かめてから使う（変わっていなければ 304 で軽い）。
const VERSION = 'v18';
const CACHE = `workout-log-${VERSION}`;
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
  // 古いコピーを取り込まないよう、ブラウザのキャッシュを通さずに取得する
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(a => new Request(encodeURI(a), { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => {
  if (e.data === 'version') e.source?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 同一オリジンと、ライブラリの CDN だけをキャッシュする（Supabase の API 通信は対象外）
  if (e.request.method !== 'GET' || (url.origin !== location.origin && url.hostname !== 'cdn.jsdelivr.net')) return;
  // アプリのファイルは毎回更新を確認。CDN のライブラリは版が固定なので通常どおり
  const live = url.origin === location.origin ? fetch(url.href, { cache: 'no-cache' }) : fetch(e.request);
  e.respondWith(
    live
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
