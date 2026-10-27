// Home Organizer service worker.
// Strategy: network-first for the app shell so launches stay aligned with the
// current GitHub Pages build, with the last good copy kept in a versioned
// cache so the (local-first) app still opens when the network is unavailable.
// Older app caches are removed on activate; unrelated caches on the shared
// github.io origin are never touched.
const APP_BUILD = '2026-10-27-defect-fixes-v1';
const CACHE_NAME = 'home-organizer-shell-' + APP_BUILD;
const APP_PREFIX = '/home-organizer/';
const APP_SHELL = [
  APP_PREFIX,
  APP_PREFIX + 'index.html',
  APP_PREFIX + 'cloud-sync.js',
  APP_PREFIX + 'supabase-config.js',
  APP_PREFIX + 'manifest.json',
  APP_PREFIX + 'icons/galette-app-icon-192.jpg',
  APP_PREFIX + 'icons/galette-app-icon-512.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache each shell file independently so one failure cannot block install.
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response.ok) await cache.put(url, response);
      } catch (e) { /* offline install: the fetch handler will retry later */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('home-organizer-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const appShellRequest =
    request.mode === 'navigate' ||
    url.pathname === APP_PREFIX + 'cloud-sync.js' ||
    url.pathname === APP_PREFIX + 'supabase-config.js' ||
    url.pathname === APP_PREFIX + 'manifest.json';

  if (appShellRequest) {
    // Network-first (bypassing the HTTP cache, so an OAuth return cannot
    // reopen a stale UI), falling back to the cached shell when offline.
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request, { ignoreSearch: true }) ||
          await cache.match(APP_PREFIX + 'index.html');
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  // Other same-origin GETs (icons and static assets): cache-first, then
  // network, keeping a copy for offline launches.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
