// Service worker: guarda todos os arquivos do app no primeiro acesso, para uso off-line.
const VERSION = 'ab7a2816e176';
const CACHE = 'pdfapp-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const list = await (await fetch('precache.json', { cache: 'no-store' })).json();
    const c = await caches.open(CACHE);
    await c.addAll(['./', ...list]);
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('pdfapp-')) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(e.request); } catch (err) { return (await caches.match('./')) || Response.error(); }
  })());
});
