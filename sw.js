// Shrinkray service worker: precache the app shell so it works offline; refresh in the background.
const VERSION = 'v3';
const CACHE = `shrinkray-${VERSION}`;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'plan.js', 'shrink.js', 'vendor/mediabunny.min.mjs', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');
  if (!sameOrigin && !isFont) return; // never touch the counter or anything else
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
      return cached || (await fresh) || new Response('Offline', { status: 503 });
    }),
  );
});
