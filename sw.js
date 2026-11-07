// Service Worker — SmenaSps v1.1.0 (Offline-First PWA + Auto-Update Support)
const APP_VERSION = '1.1.0';
const CACHE_NAME = 'smenasps-v1.1.0-cache';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './version.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/favicon.ico',
  './SmenaSps_Master_Database.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});

// Обработка команды мгновенного обновления из окна Справки (?)
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.action === 'skipWaiting' || data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;

  // Запросы к Google Apps Script и GitHub API всегда идут напрямую в сеть без кэширования
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('google.com') ||
    url.hostname.includes('googleusercontent.com') ||
    url.hostname.includes('api.github.com') ||
    url.hostname.includes('raw.githubusercontent.com') ||
    url.protocol === 'chrome-extension:'
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // Для version.json всегда используем стратегию Network-First (чтобы сразу видеть выход новой версии)
  if (url.pathname.endsWith('/version.json') || url.pathname === 'version.json') {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('./version.json', clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./version.json'))
    );
    return;
  }

  // Для навигации по странице (index.html) используем Network-First с быстрым откатом к офлайн-кэшу
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put('./index.html', clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Для остальных статических ресурсов — Cache-First с фоновым обновлением (Stale-While-Revalidate)
  event.respondWith(
    caches.match(req).then((cached) => {
      const netFetch = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || netFetch;
    })
  );
});
