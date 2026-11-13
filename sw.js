// SmenaSps v1.3.8 — resilient offline-first service worker
const APP_VERSION = '1.3.8';
const CACHE_NAME = `smenasps-${APP_VERSION}-cache`;
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './version.json',
  './SmenaSps_DEMO_DATA.json',
  './SmenaSps_Master_Database.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/favicon.ico'
];

async function fetchWithTimeout(request, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // The app shell is critical: don't report a successful install without it.
    await cache.add(new Request('./index.html', { cache: 'reload' }));
    // The remaining assets are useful but non-critical; missing optional icons
    // or metadata must not prevent the offline app shell from being installed.
    await Promise.allSettled(
      CORE_ASSETS.filter((asset) => asset !== './index.html')
        .map((asset) => cache.add(new Request(asset, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => key.startsWith('smenasps-') && key !== CACHE_NAME
      ? caches.delete(key) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.action === 'skipWaiting' || data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/version.json') || url.pathname === '/version.json') {
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request, 2500);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./version.json', response.clone()).catch(() => {});
          return response;
        }
      } catch (_) {}
      return (await caches.match('./version.json')) || Response.error();
    })());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request, 3000);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', response.clone()).catch(() => {});
          return response;
        }
      } catch (_) {}
      return (await caches.match('./index.html')) ||
        (await caches.match('./')) ||
        new Response('SmenaSps: стартовая страница пока не сохранена для офлайн-режима. Откройте приложение при стабильном подключении и повторите запуск.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      // Stale-while-revalidate: return cached data immediately; refresh quietly.
      fetch(request).then((response) => {
        if (response && response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      }).catch(() => {});
      return cached;
    }
    try {
      const response = await fetchWithTimeout(request, 4000);
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_) {
      return Response.error();
    }
  })());
});
