const CACHE = 'seens-radio-v3';
const STATIC = ['/', '/app.js', '/styles/main.css', '/styles/player.css',
  '/components/radio-player.js', '/components/radio-profile.js', '/components/radio-settings.js',
  '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept: API, WebSocket, YouTube, external URLs
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/stream') ||
      url.origin !== self.location.origin) return;

  // TTS audio — serve from network only, no caching
  // (audio requests are range requests / 206, which cannot be cached)
  if (url.pathname.startsWith('/tts/')) return;

  // Static assets — cache first
  e.respondWith(caches.match(e.request).then(cached => cached ?? fetch(e.request)));
});
