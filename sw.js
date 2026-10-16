// Service worker for Play! Tower.
// 1. Adds the cross-origin isolation headers the emulator needs (SharedArrayBuffer for its
//    threads). GitHub Pages cannot send custom headers, so the worker adds them.
// 2. Keeps the emulator core and game covers in a cache so they load instantly and offline.

const CORE_CACHE = 'tower-core-v1';
const SHELL_CACHE = 'tower-shell-v1';
const COVER_CACHE = 'tower-covers-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, SHELL_CACHE, COVER_CACHE]);
    for (const key of await caches.keys()) {
      if (key.startsWith('tower-') && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type !== 'opaque') {
    // Core files are versioned with ?v=, so drop the copies of older versions.
    const path = new URL(request.url).pathname;
    for (const old of await cache.keys()) {
      if (new URL(old.url).pathname === path && old.url !== request.url) await cache.delete(old);
    }
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    // Covers are requested in CORS mode, so they can be cached and drawn to canvas.
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/xlenore/ps2-covers/') && request.mode === 'cors') {
      event.respondWith(cacheFirst(request, COVER_CACHE).catch(() => fetch(request)));
    }
    return;
  }

  const isCore = url.pathname.includes('/core/');
  // Game programs and data packs are stored in the library (IndexedDB) once installed,
  // so they are not copied into the cache as well.
  const isGameFile = url.pathname.includes('/games/');
  event.respondWith((async () => {
    const response = isGameFile ? await fetch(request)
      : isCore ? await cacheFirst(request, CORE_CACHE) : await networkFirst(request, SHELL_CACHE);
    return isolate(response);
  })());
});
