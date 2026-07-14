// ============================================================
// sw.js — Service Worker（オフライン対応）
// ※アプリ更新時は下のCACHE名と js/app.js の APP_VER を両方上げること
// ============================================================
const CACHE = 'fitfuel-v1.14.0';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/sync.js',
  './js/calc.js',
  './js/foods.js',
  './js/ui.js',
  './js/charts.js',
  './js/timer.js',
  './js/views/onboarding.js',
  './js/views/home.js',
  './js/views/meals.js',
  './js/views/train.js',
  './js/views/log.js',
  './js/views/settings.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// インストール時に全ファイルをキャッシュ（一時保存）する。
// {cache:'reload'}でブラウザのHTTPキャッシュを迂回して必ずサーバーから取り直す
// （GitHub Pagesのmax-age=600により、更新直後だと古いファイルを掴む事故を防ぐ）
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// 古いバージョンのキャッシュを削除する
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// キャッシュ優先で応答し、なければネットワークから取得する
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 外部ドメイン（Google認証・Googleドライブ等）は横取りせず素通しする
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
