// Rota Planı çevrimdışı katmanı: uygulama ve son okunan veriler cihazda saklanır, internet yokken bunlar gösterilir.
// Yazma istekleri (POST) buradan geçmez; uygulama onları bekleyen kayıtlar kuyruğunda tutup internet gelince gönderir.
const SURUM = 'rota-v2';
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SURUM).then(c => c.add('/').catch(() => {})));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== SURUM).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});

// Önce internet (en fazla birkaç saniye beklenir), olmazsa cihazdaki son kopya
async function onceInternet(req, anahtar, sure) {
  const c = await caches.open(SURUM);
  try {
    const r = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('zaman aşımı')), sure))]);
    if (r.ok && !r.redirected && r.type === 'basic') c.put(anahtar || req, r.clone());
    return r;
  } catch (e) {
    const eski = await c.match(anahtar || req);
    if (eski) return eski;
    throw e;
  }
}
async function onceCihaz(req) {
  const c = await caches.open(SURUM), eski = await c.match(req);
  if (eski) return eski;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone());  // <script> istekleri "opaque" gelir; onlar da saklanır
  return r;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (u.pathname === '/cikis') { e.respondWith(caches.delete(SURUM).then(() => fetch(req))); return; }  // çıkışta başkasının verisi kalmasın
    if (req.mode === 'navigate' && (u.pathname === '/' || u.pathname === '/index.html')) { e.respondWith(onceInternet(req, '/', 6000)); return; }
    if (u.pathname === '/ayarlar' || u.pathname.startsWith('/api/')) { e.respondWith(onceInternet(req, null, 8000)); return; }
    return;
  }
  if (CDN.test(req.url)) e.respondWith(onceCihaz(req));
});
