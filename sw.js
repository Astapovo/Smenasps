// Service Worker — СменаПульс (SmenaPulse) v1.0 (Offline-First PWA)
const CACHE_NAME = 'smenapulse-v1.0-cache';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/favicon.ico',
  './SmenaPulse_Master_Database.json'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.hostname.includes('script.google.com') || url.hostname.includes('google.com') || url.hostname.includes('googleusercontent.com') || url.protocol === 'chrome-extension:') {
    event.respondWith(fetch(req));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('./index.html').then((c) => c || fetch(req).catch(() => caches.match('./index.html'))));
    return;
  }
  event.respondWith(caches.match(req).then((c) => c || fetch(req)));
});
