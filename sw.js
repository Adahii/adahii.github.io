// Basic service worker — caches app shell so it works offline
const CACHE = 'poker-tracker-v1';
const FILES = ['./', './index.html', './app.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache Apps Script requests
  if (url.hostname.includes('script.google.com')) return;
  // Network-first for our app files, falling back to cache when offline
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
