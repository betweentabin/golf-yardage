// オフライン対応。アプリ本体は事前にキャッシュし、地図タイルは表示したものを保存する。
const VERSION = 'v6';
const APP_CACHE = `app-${VERSION}`;
// 写真の画素を読むため CORS で保存する。旧 'tiles' は no-cors（読めない形式）なので使わない
const TILE_CACHE = 'tiles-v2';
const TILE_LIMIT = 3000;

const APP_FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/geo.js',
  'js/map.js',
  'js/osm.js',
  'js/position.js',
  'js/select.js',
  'js/trace.js',
  'js/holeview.js',
  'js/store.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith('app-') && k !== APP_CACHE) || k === 'tiles').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isTile = (url) =>
  url.hostname === 'cyberjapandata.gsi.go.jp' || url.hostname === 'tile.openstreetmap.org';

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) {
    // 地図タイル: キャッシュ優先、なければ取得して保存
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req.url);
        // CORS の要求に読めない形式（opaque）を返すと失敗するので、その場合は取り直す
        if (hit && !(hit.type === 'opaque' && req.mode === 'cors')) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          cache.put(req.url, res.clone());
          if (Math.random() < 0.02) trimTiles();
        }
        return res;
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    // アプリ本体: ネットにつながれば最新を取り、つながらなければキャッシュ
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(APP_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
    );
  }
});
