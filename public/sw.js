// GCP Pro service worker -- v11.11.
// Static-cache shell only. Navigation requests are network-first with
// cache fallback; same-origin static assets are cache-first; /api/* routes
// pass through unchanged so the existing v11.9 dedup, GCP poll loop, and
// gold poll behaviour are untouched. v11.12 will add API last-good fallback.
//
// Bump SW_VERSION on every shipped change to invalidate the previous cache
// and force re-precache. v11.13 will surface this as a "New version
// available" toast; for now the SW silently activates the new version.

const SW_VERSION  = 'gcppro-v11.11';
const SHELL_CACHE = `${SW_VERSION}-shell`;

// Static asset paths to precache on install. Next.js fingerprints
// /_next/static chunks so they can't be precached by name; those land
// in the cache lazily via the cache-first runtime handler.
const SHELL_ASSETS = [
  '/',
  '/offline.html',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_ASSETS).catch((e) => {
        // Don't fail install if a single asset is missing -- the
        // navigation handler will still serve cached HTML on subsequent
        // visits and runtime cache-first will pick up the rest.
        console.warn('[SW] precache partial failure', e);
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(SW_VERSION))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Cross-origin: don't intercept (twelvedata.com, gcp2.net, gold-api,
  // Google fonts, etc.) -- they have their own cache headers and we don't
  // want to take responsibility for them in the SW.
  if (url.origin !== self.location.origin) return;

  // /api/* routes pass through. v11.12 will add last-good fallback.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation -> HTML document. Network-first so deploys land
  // immediately when online; cache fallback when offline; offline.html
  // as a last resort if there's no cached navigation response.
  if (req.mode === 'navigate') {
    event.respondWith(navigationStrategy(req));
    return;
  }

  // Static asset paths: cache-first.
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/data/') ||
    /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|css|js|json|webmanifest)$/i.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Anything else: pass through to the network.
});

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit   = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Don't cache non-OK or opaque responses; they pollute the cache
    // and cause weird "loaded from cache but broken" behaviour.
    if (res && res.ok && res.status === 200) {
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function navigationStrategy(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    const root = await cache.match('/');
    if (root) return root;
    const offline = await cache.match('/offline.html');
    if (offline) return offline;
    return new Response('Offline', { status: 503 });
  }
}
