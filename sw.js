// SSA Companion SW v12 — optimised caching + Background Sync
// ─────────────────────────────────────────────────────────────────────
const CACHE_APP   = 'ssa-app-v13';   // versioned app shell + static assets
const CACHE_TILES = 'ssa-tiles-v1';  // map tiles (separate, survives app updates)
const MAX_TILES   = 500;             // cap tile cache to ~50 MB
const BASE        = '/tes';

// Static assets to precache on install.
// Pinned versions — no opaque redirects, no version drift.
const PRECACHE = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

// ── INSTALL: precache static shell ───────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_APP)
      .then(c => c.addAll(PRECACHE).catch(err => console.warn('[SW] precache partial fail', err)))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: delete old caches, claim clients ────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_APP && k !== CACHE_TILES)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: per-resource strategies ───────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // only intercept GET

  const url = new URL(e.request.url);

  // ── Supabase: always network-only, offline JSON fallback ────────────
  if (url.hostname.includes('supabase.co')) {
    e.respondWith(
      fetch(e.request, { signal: AbortSignal.timeout(10000) })
        .catch(() => new Response(
          JSON.stringify({ error: 'offline', data: null }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // ── Geocoding / routing: network-only, short timeout ─────────────────
  if (
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('router.project-osrm.org') ||
    url.hostname.includes('locationiq.com')
  ) {
    e.respondWith(
      fetch(e.request, { signal: AbortSignal.timeout(8000) })
        .catch(() => new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  // ── Map tiles: cache-first, background refresh, size-limited ─────────
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('arcgisonline.com')
  ) {
    e.respondWith(
      caches.open(CACHE_TILES).then(tileCache =>
        tileCache.match(e.request).then(cached => {
          const network = fetch(e.request)
            .then(resp => {
              if (resp && resp.status === 200) {
                tileCache.put(e.request, resp.clone());
                // Trim tile cache to MAX_TILES entries
                tileCache.keys().then(keys => {
                  if (keys.length > MAX_TILES) {
                    keys.slice(0, keys.length - MAX_TILES).forEach(k => tileCache.delete(k));
                  }
                });
              }
              return resp;
            })
            .catch(() => cached || new Response('', { status: 503 }));
          return cached || network;
        })
      )
    );
    return;
  }

  // ── App shell (navigation): network-first, cache fallback ────────────
  const isAppShell = (
    e.request.mode === 'navigate' ||
    url.pathname === BASE + '/' ||
    url.pathname === BASE + '/index.html'
  );
  if (isAppShell) {
    e.respondWith(
      fetch(e.request, { signal: AbortSignal.timeout(5000) })
        .then(resp => {
          if (resp && resp.status === 200) {
            caches.open(CACHE_APP).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        })
        .catch(() =>
          caches.match(e.request)
            .then(c => c || caches.match(BASE + '/index.html'))
        )
    );
    return;
  }

  // ── Static assets (JS, CSS, fonts): stale-while-revalidate ───────────
  // Serve from cache immediately, update cache in background.
  e.respondWith(
    caches.open(CACHE_APP).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request)
          .then(resp => {
            if (resp && resp.status === 200) cache.put(e.request, resp.clone());
            return resp;
          })
          .catch(() => cached || new Response('', { status: 503 }));
        return cached || network; // serve cached instantly, update behind the scenes
      })
    )
  );
});

// ── BACKGROUND SYNC: flush offline queue when connection returns ──────
self.addEventListener('sync', e => {
  if (e.tag === 'ssa-sync') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'BG_SYNC' }))
      )
    );
  }
});

// ── MESSAGES from app ─────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
