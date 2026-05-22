// Read Aloud PWA — offline shell + Web Share Target handler.
// Pre-caches the static assets on install and serves cache-first thereafter.
// Bump VERSION to invalidate older caches on the next activation.
// Vendor/ libraries (pdf.js, mammoth) are intentionally NOT pre-cached —
// they're lazy-loaded and picked up by runtime caching the first time.

const VERSION = 'v3';
const STATIC = 'read-aloud-static-' + VERSION;
const SHARE_PENDING = 'share-pending';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== STATIC && k !== SHARE_PENDING)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// --- Web Share Target -----------------------------------------------------
// Manifest declares action: "share/", method: POST. We stash the file in a
// dedicated cache and redirect (303) to ./?share=1 so the main page can pick
// it up. Filename + MIME ride along on the query string since Cache stores
// only Request/Response pairs.
async function handleShare(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || typeof file.name !== 'string') {
      return Response.redirect('./', 303);
    }
    const cache = await caches.open(SHARE_PENDING);
    await cache.put(
      new Request('shared-file'),
      new Response(file, {
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      })
    );
    const params = new URLSearchParams({
      share: '1',
      name: file.name,
      type: file.type || '',
    });
    return Response.redirect('./?' + params.toString(), 303);
  } catch (_) {
    return Response.redirect('./', 303);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Web Share Target endpoint (POST). Any path ending in /share/ qualifies so
  // the same SW works under any subpath deployment.
  if (event.request.method === 'POST' && url.pathname.endsWith('/share/')) {
    event.respondWith(handleShare(event.request));
    return;
  }

  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(STATIC).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      }).catch(() => cached || Response.error());
    })
  );
});
