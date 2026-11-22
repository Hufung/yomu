/* Yomu service worker — app shell only.
 *
 * The books themselves never touch the network, so there is nothing to cache
 * for them; IndexedDB already holds every byte. This worker exists so the app
 * launches offline and installs as a PWA.
 *
 * pdf.js and its CMaps/fonts (~2.5 MB) are deliberately NOT precached: most
 * users never open a PDF. They are cached on first use by the runtime rule.
 */
const VERSION = 'yomu-v7';
const SHELL = [
  './',
  'index.html',
  '404.html',
  'css/app.css',
  'js/vendor/fflate.js',
  'js/vendor/fflate.mjs',
  'js/db.js',
  'js/epub.js',
  'js/txt.js',
  'js/mobi7.js',
  'js/mobi.js',
  'js/pdf.js',
  'js/highlight.js',
  'js/i18n.js',
  'js/app.js',
  'js/vendor/mobi/lingo-mobi.mjs',
  'js/vendor/mobi/lingo-shared.mjs',
  'js/vendor/mobi/sax.js',
  'js/vendor/mobi/events.js',
  'js/vendor/mobi/path-browserify.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll is atomic: one 404 would leave the shell empty, so add one by one.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never proxy third parties

  // Navigations: network-first so a new deploy is picked up, cache as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Static assets: cache-first, refreshing in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            // Runtime-cache the heavy PDF assets the first time they are used,
            // so the second PDF still opens offline.
            if (/\/pdfjs\//.test(url.pathname)) {
              caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            }
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetched;
    })
  );
});
