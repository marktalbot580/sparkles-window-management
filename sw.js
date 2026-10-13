// Offline cache so the round still opens with no signal.
const CACHE = 'swm-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'cloud.js', 'config.js', 'pdf-inv.js', 'manifest.json', 'logo.svg', 'icon-192.png', 'icon-512.png',
  'lib/jspdf.umd.min.js', 'fonts/bricolage-grotesque-latin-800-normal.woff2', 'fonts/bricolage-grotesque-latin-700-normal.woff2', 'fonts/instrument-sans-latin-400-normal.woff2', 'fonts/instrument-sans-latin-600-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;   // never cache calls to Supabase or postcode lookups
  // network first so updates arrive, fall back to the cache when offline
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
    return res;
  }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
});
