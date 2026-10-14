/* OS1 web app service worker.
   Strategy:
   - App shell (HTML/CSS/JS/icons/manifest): cache-first, so the app opens
     instantly + works installed/offline.
   - API calls (/api/*): network-only, never cached (live agent state + auth).
   Bump CACHE_VERSION on any shell change to force-refresh installed clients. */

const CACHE_VERSION = 'os1-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/css/os1.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API/auth traffic — always go to network.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Only handle same-origin GETs for the shell.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          // Runtime-cache successful same-origin shell assets.
          if (resp.ok && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match('/index.html')); // SPA fallback when offline
    })
  );
});
