// İş Bul — Cloudflare Worker: firmaları bulur, sitelerinden mail adresini çıkarır, onayınızla teklif maili gönderir.
import { connect } from 'cloudflare:sockets';
import { HttpHata, yanit, yonlendir } from './ortak.js';
import * as G from './giris.js';
import { isbulGet, isbulPost, retSayfasi, filoSayfasi, zamanliGorev, googleAnahtari } from './isbul.js';

const girisSayfasi = hata => new Response(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>İş Bul · Giriş</title>
<style>:root{--bg:#f6f8f7;--card:#fff;--ink:#17302b;--line:#dfe7e3;--pri:#13795b}@media(prefers-color-scheme:dark){:root{--bg:#0d1412;--card:#15201d;--ink:#e8f0ed;--line:#26342f;--pri:#3ccf98}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;width:min(360px,100%);box-sizing:border-box}h1{margin:0 0 14px;font-size:22px}
input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;font:inherit;margin-top:8px}input{border:1px solid var(--line);background:var(--bg);color:var(--ink)}button{border:0;background:var(--pri);color:#fff;font-weight:700}p{color:#c33}</style></head>
<body><form method="post" action="/giris"><h1>İş Bul</h1>${hata ? `<p>${hata}</p>` : ''}<input type="password" name="sifre" placeholder="Şifre" autofocus required><button>Giriş</button></form></body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url), yol = url.pathname;
    try {
      // firmaların "listeden çık" bağlantısı ve ekibin tanıtım sayfası girişsiz açılır
      if (yol === '/ret') return await retSayfasi(env, request, url);
      if (yol === '/filo') return await filoSayfasi(env);
      if (!env.ISBUL_SIFRE) return new Response('Kurulum tamamlanmadı: Cloudflare panelinde ISBUL_SIFRE gizli ayarını girin.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      if (yol === '/giris') {
        if (request.method !== 'POST') return girisSayfasi(url.searchParams.get('hata') ? 'Şifre hatalı ya da çok deneme yapıldı.' : '');
        const ip = request.headers.get('CF-Connecting-IP') || 'yerel';
        const sifre = new URLSearchParams((await request.text()).slice(0, 2000)).get('sifre') || '';
        if (G.kilitli(ip) || !G.sifreDogru(env, sifre)) { G.hataSay(ip); return yonlendir('/giris?hata=1'); }
        return yonlendir('/', await G.cerez(env, request));
      }
      if (yol === '/cikis') return yonlendir('/giris', await G.cerez(env, request, true));
      if (!(await G.oturumVar(env, request))) return yol.startsWith('/api/') ? yanit(401, { error: 'Oturum süresi doldu, sayfayı yenileyip giriş yapın.', code: 'login' }) : yonlendir('/giris');
      if (yol === '/' || yol === '/index.html') {
        const r = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      const gkey = await googleAnahtari(env);
      const r = request.method === 'POST' ? await isbulPost(env, request, url, gkey, connect) : await isbulGet(env, url, gkey);
      return r || new Response('Not Found', { status: 404 });
    } catch (e) {
      if (e instanceof HttpHata) return yanit(e.status, { error: e.message, code: e.code });
      console.error(e);
      return yanit(502, { error: 'Sunucu hatası.', code: 'storage' });
    }
  },
  // Her sabah: takip taslakları, yeni firma araması, sitelerden mail adresi (gönderim sizin onayınızla yapılır)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(googleAnahtari(env).then(k => zamanliGorev(env, k)).catch(e => console.error('zamanlı görev', e)));
  },
};
