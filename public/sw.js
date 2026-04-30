// GCP Pro service worker -- v11.13.
// v11.11 added static-asset cache + offline shell.
// v11.12 added last-good-response fallback for same-origin /api/* GET.
// v11.13 wires the update-toast handshake: removes the in-install
// skipWaiting() so a new SW lands in the waiting state on every
// deploy, and adds a message listener that activates on demand when
// the client posts { type: 'SKIP_WAITING' }. PWARegister surfaces
// the prompt and reloads the page on controllerchange.
//
// Bump SW_VERSION on every shipped change to invalidate the previous
// cache. The activate handler purges any cache key that doesn't start
// with the current SW_VERSION. Skipping this bump is what blocks
// installed PWAs from picking up new bundles -- always bump in lockstep
// with APP_VERSION.

const SW_VERSION  = 'gcppro-v11.16.4';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const API_CACHE   = `${SW_VERSION}-api`;

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
  // v11.13: deliberately NOT calling skipWaiting() here. New SWs sit in
  // the waiting state until the client postMessages SKIP_WAITING
  // (triggered by the user clicking REFRESH on the update toast). This
  // prevents silent activations during an active session.
});

self.addEventListener('message', (event) => {
  // The client (PWARegister) calls this when the user clicks REFRESH on
  // the toast. skipWaiting() promotes the waiting SW to active; the
  // browser then fires controllerchange on the client, which reloads.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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

  // Same-origin /api/* GET: network-first with last-good fallback.
  // POST / PUT / DELETE were already filtered by the GET-only check
  // at the top of the handler, so /api/gcp-state (POST) passes through
  // unchanged.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(apiNetworkFirst(req));
    return;
  }

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

async function apiNetworkFirst(req) {
  // Network-first: always attempt the live request, only fall back to
  // cache when fetch itself throws (offline, DNS failure, TLS error).
  // Non-OK responses (5xx / 4xx) propagate to the client untouched so
  // server-side errors remain visible -- spec was explicit on "do not
  // cache failed responses". v11.12 priority is fallback correctness
  // when offline; freshness gating via TTL is left to v11.13+ if ever
  // needed.
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.status === 200) {
      // Clone before consuming -- both the client and the cache need
      // a usable body stream.
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // No cache, no network -- mirror the static-asset offline path.
    return new Response(null, { status: 504, statusText: 'Offline' });
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
