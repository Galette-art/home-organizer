// Keep installed/PWA launches aligned with the current GitHub Pages build.
const APP_PREFIX = '/home-organizer/';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove only caches belonging to this app, never unrelated caches on the
    // shared github.io origin.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('home-organizer-'))
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

  // The UI is a single HTML file with inline application code. Always request
  // navigations and local auth/config scripts without the browser HTTP cache,
  // so an OAuth return cannot reopen a UI version without recent features.
  const appShellRequest =
    request.mode === 'navigate' ||
    url.pathname === APP_PREFIX + 'cloud-sync.js' ||
    url.pathname === APP_PREFIX + 'supabase-config.js' ||
    url.pathname === APP_PREFIX + 'manifest.json';

  if (appShellRequest) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
  }
});
