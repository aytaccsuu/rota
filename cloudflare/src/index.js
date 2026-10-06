// Rota Planı — Cloudflare Worker. Render/Python sürümüyle (sunucu.py) aynı uç noktalar ve yanıtlar.
import { HttpHata, yanit, bos, yonlendir, safe, GUN, AY, govde, sayi, noktaListesi, b64Bayt } from './ortak.js';
import * as G from './giris.js';
import * as depo from './depo.js';
import { PROVIDERS, anahtar as servisAnahtari, adresAra, googleAra, matris, rota, yolMatrisi, cikisSaati, ServisHatasi } from './servisler.js';
import { evrakOku, adresDuzelt, adresDenetle, OkumaHatasi } from './okuma.js';

const ANAHTAR_ALANLARI = ['ykey', 'gkey', 'geminiKey', 'orsKey', ...Object.values(PROVIDERS).map(p => p[1])];

function ortamNoktasi(metin) {
  const [a, b] = String(metin || '').replace(/;/g, ',').split(',').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && (a || b) ? { lat: a, lon: b } : null;
}
// Yöneticinin arayüzden girdiği anahtarlar (D1) + ortak depo/ev varsayılanları (ortam değişkeni)
async function ayarlar(env) {
  let kayit = {};
  try { kayit = JSON.parse(await depo.ayarOku(env, 'anahtarlar') || '{}'); } catch { kayit = {}; }
  return { ...kayit, depot: ortamNoktasi(env.DEPO_KOORDINAT), home: ortamNoktasi(env.EV_KOORDINAT) };
}
const geminiAnahtari = (env, a) => env.GEMINI_API_KEY || a.geminiKey || '';
const orsAnahtari = (env, a) => env.ORS_API_KEY || a.orsKey || '';
const googleAnahtari = (env, a) => env.GOOGLE_MAPS_API_KEY || a.gkey || '';

async function kullaniciNoktalari(env, user, ortak) {
  let kendi = {};
  try { kendi = JSON.parse(await depo.ayarOku(env, 'noktalar:' + safe(user)) || '{}'); } catch { kendi = {}; }
  return { depot: kendi.depot || ortak.depot, home: kendi.home || (G.yoneticiMi(env, user) ? ortak.home : null) };
}

async function kullaniciListesi(env) {
  const users = Object.keys(G.ortamKullanicilari(env)), yon = G.yoneticiler(env), db = await G.dbKullanicilari(env, true);
  return users.map(ad => ({ ad, sabit: true, yonetici: yon.has(ad) }))
    .concat(Object.entries(db).filter(([ad]) => !users.includes(ad)).map(([ad, v]) => ({ ad, sabit: false, yonetici: yon.has(ad), olusturma: v.olusturma })));
}

const ADMIN = (env, user) => { if (!G.yoneticiMi(env, user)) throw new HttpHata(403, 'Bu işlem yalnızca yönetici içindir.', 'forbidden'); };
const KULLANICI_ADI = /^[a-zçğıöşü][a-z0-9çğıöşü._-]{1,31}$/;

async function statik(env, request, yol) {
  const r = await env.ASSETS.fetch(new Request(new URL(yol, request.url), { headers: request.headers }));
  const h = new Headers(r.headers); h.set('Cache-Control', 'no-store');
  return new Response(r.body, { status: r.status, headers: h });
}

// ---------- GET ----------
async function get(env, request, url, user) {
  const yol = url.pathname, q = url.searchParams;
  if (yol === '/' || yol === '/index.html') return statik(env, request, '/');
  if (yol === '/ayarlar') {
    const a = await ayarlar(env), admin = G.yoneticiMi(env, user);
    const providers = Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, !!servisAnahtari(env, a, p)]));
    const hints = admin ? Object.fromEntries(Object.keys(PROVIDERS).filter(p => servisAnahtari(env, a, p)).map(p => [p, servisAnahtari(env, a, p).slice(-4)])) : {};
    const gem = geminiAnahtari(env, a), ors = orsAnahtari(env, a);
    let tercihler = {};
    try { tercihler = JSON.parse(await depo.ayarOku(env, 'tercih:' + safe(user)) || '{}'); } catch { tercihler = {}; }
    return yanit(200, {
      ...(await kullaniciNoktalari(env, user, a)), ykey: env.YANDEX_MAPS_JS_KEY || a.ykey || '',
      isAdmin: admin, providers, hints, googleConfigured: !!googleAnahtari(env, a),
      ocrConfigured: !!gem, ocrHint: gem && admin ? gem.slice(-4) : '', orsConfigured: !!ors, orsHint: ors && admin ? ors.slice(-4) : '',
      user, authOn: G.girisAcik(env), tercihler,
    });
  }
  if (yol === '/api/plan') return yanit(200, { plan: await depo.planOku(env, user), backend: 'd1' });
  if (yol === '/api/fiyat') return yanit(200, { fiyat: JSON.parse(await depo.ayarOku(env, 'fiyat') || 'null') });
  if (yol === '/api/yakit-fiyat') {
    // Güncel akaryakıt fiyatı (Opet'in herkese açık fiyat servisi), 3 saat önbellekte
    const yaka = q.get('yaka') === 'avrupa' ? 'avrupa' : 'anadolu', kod = yaka === 'avrupa' ? 934 : 34, ak = 'yakitfiyat:' + kod;
    try { const c = JSON.parse(await depo.ayarOku(env, ak) || 'null'); if (c && Date.now() - c.zaman < 3 * 3600 * 1000) return yanit(200, c); } catch { /* yenisi alınır */ }
    try {
      const r = await fetch(`https://api.opet.com.tr/api/fuelprices/prices?ProvinceCode=${kod}&IncludeAllProducts=true`, { headers: { Accept: 'application/json', 'User-Agent': 'rota-plani/1.0' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('opet ' + r.status);
      const motorin = [], benzin = [];
      for (const d of await r.json()) for (const p of d.prices || []) {
        const a = Number(p.amount), k = String(p.productShortName || '');
        if (a > 10 && a < 1000) { if (k.startsWith('MT')) motorin.push(a); else if (k === 'KURS') benzin.push(a); }
      }
      if (!motorin.length) throw new Error('motorin yok');
      const sonuc = { motorin: Math.min(...motorin), benzin: benzin.length ? Math.min(...benzin) : null, yaka, kaynak: 'Opet', zaman: Date.now() };
      await depo.ayarYaz(env, ak, JSON.stringify(sonuc));
      return yanit(200, sonuc);
    } catch { return yanit(502, { error: 'Güncel yakıt fiyatı alınamadı.', code: 'upstream' }); }
  }
  if (yol === '/api/rutlar' || yol === '/api/yakitlar') {
    const ay = q.get('ay') || '';
    if (!AY.test(ay)) throw new HttpHata(400, 'Ay YYYY-AA biçiminde olmalı.');
    return yol === '/api/rutlar' ? yanit(200, { rutlar: await depo.rutlariListele(env, user, ay) }) : yanit(200, { yakitlar: await depo.yakitlariListele(env, user, ay) });
  }
  if (yol.startsWith('/api/evrak/')) {
    const id = parseInt(yol.split('/').pop(), 10);
    const item = Number.isFinite(id) ? await depo.evrakOku(env, user, id) : null;
    if (!item) return yanit(404, { error: 'Evrak bulunamadı.', code: 'not_found' });
    return new Response(item[1], { headers: { 'Content-Type': item[0], 'Cache-Control': 'no-store' } });
  }
  if (yol === '/api/kullanicilar') { ADMIN(env, user); return yanit(200, { kullanicilar: await kullaniciListesi(env) }); }
  if (yol === '/api/yonetim/ozet') {
    ADMIN(env, user);
    const ay = q.get('ay') || '';
    if (!AY.test(ay)) throw new HttpHata(400, 'Ay YYYY-AA biçiminde olmalı.');
    const rows = [];
    for (const u of await kullaniciListesi(env)) rows.push({ ad: u.ad, rutlar: await depo.rutlariListele(env, u.ad, ay), yakitlar: await depo.yakitlariListele(env, u.ad, ay) });
    return yanit(200, { ay, kullanicilar: rows });
  }
  if (yol === '/api/location-search') {
    const p = q.get('provider') || '', sorgu = (q.get('q') || '').trim(), mode = q.get('mode') || 'address';
    if (!PROVIDERS[p] || sorgu.length < 3 || sorgu.length > 500 || !['address', 'place', 'reverse'].includes(mode)) throw new HttpHata(400, 'Geçersiz servis veya adres.');
    const key = servisAnahtari(env, await ayarlar(env), p);
    if (!key) return yanit(503, { error: 'Bu servis için Ayarlar’dan API anahtarı ekleyin.', code: 'missing_key' });
    try { return yanit(200, { candidates: await adresAra(p, sorgu, key, mode) }); }
    catch (e) {
      if (e instanceof ServisHatasi) {
        const code = [401, 403].includes(e.status) ? 'auth' : e.status === 429 ? 'quota' : 'upstream';
        const mesaj = { auth: 'Anahtar reddedildi. Anahtarın doğruluğunu, bu API için etkinliğini ve IP/domain kısıtlarını kontrol edin.', quota: 'Servis sorgu kotası veya hız sınırı aşıldı.', upstream: 'Konum servisi geçici olarak hata verdi.' }[code];
        return yanit(502, { error: mesaj, code, status: e.status });
      }
      if (e?.name === 'TimeoutError' || e instanceof TypeError) return yanit(502, { error: 'Servise ulaşılamadı veya zaman aşımı oluştu. Tekrar deneyin.', code: 'network' });
      return yanit(502, { error: 'Servisin yanıtı anlaşılamadı.', code: 'response' });
    }
  }
  if (yol === '/api/google-search') {
    const sorgu = (q.get('q') || '').trim();
    if (sorgu.length < 3 || sorgu.length > 500) return yanit(400, { error: 'Geçerli bir adres girin.' });
    const key = googleAnahtari(env, await ayarlar(env));
    if (!key) return yanit(503, { error: 'Otomatik Google araması için Ayarlar’dan Places API (New) anahtarı ekleyin. Google Haritalar’da açarak elle de teyit edebilirsiniz.' });
    try { return yanit(200, { places: await googleAra(sorgu, key) }); }
    catch (e) { return yanit(502, e instanceof ServisHatasi ? { error: 'Google araması reddedildi. Anahtarı, Places API (New) iznini ve kotayı kontrol edin.', status: e.status } : { error: 'Google aramasına ulaşılamadı. Tekrar deneyin veya Google Haritalar’da açın.' }); }
  }
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

// ---------- POST ----------
async function post(env, request, url, user) {
  const yol = url.pathname;
  if (yol === '/ayarlar') return ayarKaydet(env, request, user);
  if (yol === '/api/plan') {
    const b = await govde(request, 3 * 1024 * 1024);
    if (b.plan !== null && (typeof b.plan !== 'object' || Array.isArray(b.plan))) throw new HttpHata(400, 'Geçersiz plan.');
    await depo.planYaz(env, user, b.plan === null ? null : JSON.stringify(b.plan));
    return bos();
  }
  if (yol === '/api/fiyat') {
    ADMIN(env, user);
    const f = (await govde(request, 256 * 1024)).fiyat;
    const bolge = ['anadolu', 'avrupa1', 'avrupa2'];
    if (!f || typeof f !== 'object' || !bolge.every(b => Array.isArray(f[b]) && f[b].length === 2)) throw new HttpHata(400, 'Geçersiz kayıt.');
    for (const b of bolge) for (const row of f[b]) if (!(+row.nokta > 0 && +row.nokta <= 1000 && +row.tl >= 0 && +row.tl <= 1e6)) throw new HttpHata(400, 'Geçersiz kayıt.');
    if (!(+(f.ekstraNokta ?? 150) >= 0 && +(f.ekstraNokta ?? 150) <= 1e5 && +(f.kdv ?? 20) >= 0 && +(f.kdv ?? 20) <= 100)) throw new HttpHata(400, 'Geçersiz kayıt.');
    await depo.ayarYaz(env, 'fiyat', JSON.stringify(f));
    return bos();
  }
  if (yol === '/api/rut') {
    const b = await govde(request, 256 * 1024), tarih = String(b.tarih || ''), rut = b.rut;
    if (!GUN.test(tarih) || (rut !== null && (typeof rut !== 'object' || Array.isArray(rut)))) throw new HttpHata(400, 'Geçersiz kayıt.');
    await depo.rutYaz(env, user, tarih, rut === null ? null : JSON.stringify(rut));
    if (rut === null && b.evraklar === 'sil') await depo.evraklariSil(env, user, tarih);
    return bos();
  }
  if (yol === '/api/evrak') {
    const b = await govde(request, 6 * 1024 * 1024);
    const tarih = String(b.tarih || ''), ad = String(b.ad || 'evrak').slice(0, 200), mime = String(b.mime || '');
    const izinli = ['image/jpeg', 'image/png', 'image/webp', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
    if (!GUN.test(tarih) || !izinli.includes(mime)) throw new HttpHata(400, 'Geçersiz evrak.');
    let bayt; try { bayt = b64Bayt(String(b.data || '')); } catch { throw new HttpHata(400, 'Geçersiz evrak.'); }
    if (!(bayt.byteLength > 0 && bayt.byteLength <= 4 * 1024 * 1024)) throw new HttpHata(400, 'Geçersiz evrak.');
    return yanit(200, { id: await depo.evrakYaz(env, user, tarih, ad, mime, bayt) });
  }
  if (yol === '/api/yakit' || yol === '/api/yakit-sil') {
    const b = await govde(request, 16 * 1024);
    if (yol === '/api/yakit-sil') { await depo.yakitSil(env, user, parseInt(b.id, 10)); return bos(); }
    const item = { tarih: String(b.tarih || ''), litre: sayi(b.litre, 0, 5000), tutar: sayi(b.tutar, 0, 1e6), km: b.km === '' || b.km == null ? null : Math.trunc(sayi(b.km, 0, 1e7)), notu: String(b.notu || '').slice(0, 200) };
    if (b.id) item.id = parseInt(b.id, 10);
    if (!GUN.test(item.tarih) || item.tutar === null) throw new HttpHata(400, 'Geçersiz yakıt kaydı.');
    return yanit(200, { id: await depo.yakitYaz(env, user, item) });
  }
  if (yol === '/api/kullanici' || yol === '/api/kullanici-sil') return kullaniciYonet(env, request, user, yol.endsWith('sil'));
  if (yol === '/api/yonetim/aktar') return kayitAktar(env, request, user);
  if (yol === '/api/yonetim/tasima' || yol === '/api/yonetim/tasima-evrak') return tasima(env, request, user, yol.endsWith('evrak'));
  if (yol === '/api/konum-bul' || yol === '/api/konum-kaydet') {
    const b = await govde(request, 128 * 1024);
    if (yol === '/api/konum-bul') {
      const keys = b.anahtarlar;
      if (!Array.isArray(keys) || keys.length > 500 || !keys.every(k => typeof k === 'string' && k.length >= 3 && k.length <= 300)) throw new HttpHata(400, 'Geçersiz konum.');
      return yanit(200, { konumlar: await depo.konumBul(env, keys) });
    }
    const key = String(b.anahtar || ''), kaynak = String(b.kaynak || ''), lat = Number(b.lat), lon = Number(b.lon);
    const dogruluk = b.dogruluk === null || b.dogruluk === undefined || b.dogruluk === '' ? null : Number(b.dogruluk);
    if (key.length < 3 || key.length > 300 || !['arama', 'elle', 'gps'].includes(kaynak) || !(lat >= 40.3 && lat <= 41.8 && lon >= 27.9 && lon <= 30)) throw new HttpHata(400, 'Geçersiz konum.');
    if (kaynak === 'gps' && !(dogruluk !== null && dogruluk <= 100)) throw new HttpHata(400, 'Geçersiz konum.');
    return yanit(200, { yazildi: await depo.konumKaydet(env, key, lat, lon, kaynak, String(b.adres || ''), user, dogruluk) });
  }
  if (yol === '/api/trafik-matris' || yol === '/api/trafik-rota') {
    const b = await govde(request, 256 * 1024), pts = noktaListesi(b.points);
    let cikis; try { cikis = cikisSaati(b.departAt); } catch { throw new HttpHata(400, 'Geçersiz nokta listesi.'); }
    const key = servisAnahtari(env, await ayarlar(env), 'tomtom');
    if (!key) return yanit(503, { error: 'Trafik için TomTom anahtarı gerekli.', code: 'missing_key' });
    try {
      const r = yol.endsWith('matris') ? await matris(pts, key, { trafik: true, cikis }) : await rota(pts, key, cikis);
      return yanit(200, { ...r, departAt: cikis });
    } catch (e) {
      const code = [401, 403].includes(e.status) ? 'auth' : e.status === 429 ? 'quota' : 'upstream';
      return yanit(502, { error: { auth: 'TomTom anahtarı trafik/rota hizmetine izin vermiyor.', quota: 'TomTom günlük ücretsiz kotası doldu; trafiksiz hesaplanıyor.', upstream: 'TomTom trafik servisi geçici olarak hata verdi.' }[code], code });
    }
  }
  if (yol === '/api/yol-matris') {
    const pts = noktaListesi((await govde(request, 256 * 1024)).points), a = await ayarlar(env);
    try { return yanit(200, await yolMatrisi(pts, servisAnahtari(env, a, 'tomtom'), orsAnahtari(env, a))); }
    catch (e) { return yanit(503, { error: e.message, code: 'unavailable' }); }
  }
  if (yol === '/api/ocr') {
    const b = await govde(request, 12 * 1024 * 1024), image = b.image, mime = b.mime || 'image/jpeg';
    if (typeof image !== 'string' || image.length < 100 || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new HttpHata(400, 'Geçersiz fotoğraf.');
    const ozet = 'ocr2:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image)))].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
    const onceki = await depo.ayarOku(env, ozet).catch(() => null);
    if (onceki) return yanit(200, { ...JSON.parse(onceki), onbellek: true });
    try {
      const sonuc = await evrakOku(env, image, mime, geminiAnahtari(env, await ayarlar(env)));
      await depo.ayarYaz(env, ozet, JSON.stringify(sonuc)).catch(() => {});
      await env.DB.prepare("DELETE FROM ayarlar WHERE anahtar LIKE 'ocr:%' AND guncelleme < datetime('now', '-2 days')").run().catch(() => {});
      return yanit(200, sonuc);
    }
    catch (e) { if (e instanceof OkumaHatasi) return yanit(e.code === 'missing_key' ? 503 : 502, { error: e.message, code: e.code }); return yanit(502, { error: 'Gemini’ye ulaşılamadı veya zaman aşımı oluştu.', code: 'network' }); }
  }
  if (yol === '/api/adres-denetle') {
    const items = (await govde(request, 512 * 1024)).items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 150) throw new HttpHata(400, 'Geçersiz durak listesi.');
    const temiz = items.map(i => JSON.parse(JSON.stringify(i, (k, v) => typeof v === 'string' ? v.slice(0, 300) : v)));
    if (temiz.some(i => !i || i.id === undefined)) throw new HttpHata(400, 'Geçersiz durak listesi.');
    try { return yanit(200, await adresDenetle(env, temiz, geminiAnahtari(env, await ayarlar(env)))); }
    catch (e) { return yanit(e.code === 'missing_key' ? 503 : 502, { error: e.message, code: e.code || 'upstream' }); }
  }
  if (yol === '/api/adres-duzelt') {
    const items = (await govde(request, 512 * 1024)).items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 150) throw new HttpHata(400, 'Geçersiz adres listesi.');
    const temiz = items.map(i => { if (!i || i.id === undefined || i.adres === undefined) throw new HttpHata(400, 'Geçersiz adres listesi.'); return { id: String(i.id).slice(0, 20), adres: String(i.adres).slice(0, 500), ilce: String(i.ilce || '').slice(0, 40) }; });
    try { return yanit(200, { items: await adresDuzelt(env, temiz, geminiAnahtari(env, await ayarlar(env))) }); }
    catch (e) { if (e instanceof OkumaHatasi) return yanit(e.code === 'missing_key' ? 503 : 502, { error: e.message, code: e.code }); return yanit(502, { error: 'Gemini’ye ulaşılamadı.', code: 'network' }); }
  }
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

async function ayarKaydet(env, request, user) {
  const yeni = await govde(request, 16384);
  if (!yeni || typeof yeni !== 'object' || Array.isArray(yeni)) throw new HttpHata(400, 'Ayar kaydedilemedi.');
  if (Object.keys(yeni).some(k => ANAHTAR_ALANLARI.includes(k)) && !G.yoneticiMi(env, user)) return yanit(403, { error: 'API anahtarlarını yalnızca yönetici değiştirebilir.', code: 'forbidden' });
  if ('tercihler' in yeni) {
    const t = yeni.tercihler;
    if (!t || typeof t !== 'object' || JSON.stringify(t).length > 2000 || !Object.values(t).every(v => ['boolean', 'number', 'string'].includes(typeof v))) throw new HttpHata(400, 'Ayar kaydedilemedi.');
    const k = 'tercih:' + safe(user), eski = JSON.parse(await depo.ayarOku(env, k) || '{}');
    await depo.ayarYaz(env, k, JSON.stringify({ ...eski, ...t }));
  }
  const noktalar = Object.fromEntries(['depot', 'home'].filter(k => k in yeni).map(k => [k, yeni[k]]));
  if (Object.keys(noktalar).length) {
    for (const v of Object.values(noktalar)) if (v !== null && !(v && Number(v.lat) >= -90 && Number(v.lat) <= 90 && Number(v.lon) >= -180 && Number(v.lon) <= 180)) throw new HttpHata(400, 'Ayar kaydedilemedi.');
    const k = 'noktalar:' + safe(user), eski = JSON.parse(await depo.ayarOku(env, k) || '{}');
    for (const [ad, v] of Object.entries(noktalar)) eski[ad] = v ? { lat: Number(v.lat), lon: Number(v.lon) } : null;
    await depo.ayarYaz(env, k, JSON.stringify(eski));
  }
  const anahtarlar = Object.fromEntries(Object.entries(yeni).filter(([k]) => ANAHTAR_ALANLARI.includes(k)));
  if (Object.keys(anahtarlar).length) {
    if (Object.values(anahtarlar).some(v => typeof v !== 'string' || v.length > 4096)) throw new HttpHata(400, 'Ayar kaydedilemedi.');
    const eski = JSON.parse(await depo.ayarOku(env, 'anahtarlar') || '{}');
    for (const [k, v] of Object.entries(anahtarlar)) eski[k] = v.trim();
    await depo.ayarYaz(env, 'anahtarlar', JSON.stringify(eski));
  }
  return bos();
}

async function kullaniciYonet(env, request, user, sil) {
  if (!G.yoneticiMi(env, user) || !Object.keys(G.ortamKullanicilari(env)).length) return yanit(403, { error: 'Bu işlem yalnızca yönetici içindir.', code: 'forbidden' });
  const b = await govde(request, 4096), ad = String(b.ad || '').trim().toLowerCase();
  if (!KULLANICI_ADI.test(ad)) return yanit(400, { error: 'Kullanıcı adı 2–32 karakter olmalı; harfle başlamalı, yalnızca harf, rakam, nokta, - ve _ içermeli.', code: 'invalid_name' });
  const ortam = G.ortamKullanicilari(env);
  if (ortam[ad]) return yanit(400, { error: 'Bu kullanıcı Cloudflare ayarında (ROTA_KULLANICILAR) tanımlı; oradan değiştirilir.', code: 'fixed_user' });
  const mevcut = await G.dbKullanicilari(env, true);
  if (sil) {
    if (!mevcut[ad]) return yanit(404, { error: 'Kullanıcı bulunamadı.', code: 'not_found' });
    await depo.kullaniciSil(env, ad, !!b.veriler);
  } else {
    const pw = String(b.sifre || '');
    if (pw.length < 6 || pw.length > 128) return yanit(400, { error: 'Şifre en az 6 karakter olmalı.', code: 'weak_password' });
    if (!mevcut[ad] && [...Object.keys(ortam), ...Object.keys(mevcut)].some(n => safe(n) === safe(ad))) return yanit(400, { error: 'Bu ad mevcut bir kullanıcıya çok benziyor; farklı bir ad seçin.', code: 'name_clash' });
    await depo.kullaniciKaydet(env, ad, await G.sifreOzeti(pw));
  }
  await G.dbKullanicilari(env, true);
  return yanit(200, { kullanicilar: await kullaniciListesi(env) });
}

async function kayitAktar(env, request, user) {
  ADMIN(env, user);
  const b = await govde(request, 2 * 1024 * 1024), ad = String(b.kullanici || '').trim().toLowerCase();
  if (!(G.ortamKullanicilari(env)[ad] || KULLANICI_ADI.test(ad))) throw new HttpHata(400, 'Geçersiz aktarım.');
  const rutlar = (b.rutlar || []).map(r => [String(r.tarih), r.rut]), yakitlar = (b.yakitlar || []).map(y => [String(y.tarih), Number(y.tutar)]);
  if (rutlar.some(([t, r]) => !GUN.test(t) || !r || typeof r !== 'object') || yakitlar.some(([t, v]) => !GUN.test(t) || !(v > 0 && v <= 1e6))) throw new HttpHata(400, 'Geçersiz aktarım.');
  for (const [t, r] of rutlar) await depo.rutYaz(env, ad, t, JSON.stringify(r));
  const bilinen = {}; let eklenen = 0;
  for (const [t, v] of yakitlar) {
    const ay = t.slice(0, 7);
    bilinen[ay] ??= new Set((await depo.yakitlariListele(env, ad, ay)).map(y => y.tarih + '|' + Math.round(y.tutar * 100)));
    const k = t + '|' + Math.round(v * 100);
    if (!bilinen[ay].has(k)) { await depo.yakitYaz(env, ad, { tarih: t, tutar: v, notu: 'aktarım' }); bilinen[ay].add(k); eklenen++; }
  }
  return yanit(200, { kullanici: ad, rut: rutlar.length, yakit: eklenen });
}

// Render/Neon'dan taşıma (yalnızca yönetici ve TASIMA_ACIK=1 iken). Kayıtlar olduğu gibi yazılır (aynı anahtar → üzerine yazar).
async function tasima(env, request, user, evrak) {
  ADMIN(env, user);
  if (env.TASIMA_ACIK !== '1') return yanit(403, { error: 'Taşıma kapalı (TASIMA_ACIK=1 değil).', code: 'forbidden' });
  const b = await govde(request, 20 * 1024 * 1024);
  if (evrak) { // {kullanici (kayıt anahtarı), tarih, ad, mime, data} → {id}
    const u = String(b.kullanici || ''), tarih = String(b.tarih || '');
    if (!u || !GUN.test(tarih)) throw new HttpHata(400, 'Geçersiz evrak.');
    return yanit(200, { id: await depo.evrakYaz(env, u, tarih, String(b.ad || 'evrak'), String(b.mime || 'image/jpeg'), b64Bayt(String(b.data || ''))) });
  }
  const say = {};
  const ekle = async (ad, liste, fn) => { if (!Array.isArray(liste)) return; for (const r of liste) await fn(r); say[ad] = liste.length; };
  // kullanici alanları Neon'daki kayıt anahtarıdır (zaten sadeleştirilmiş); safe() aynı sonucu verir
  await ekle('planlar', b.planlar, r => depo.planYaz(env, r.kullanici, typeof r.veri === 'string' ? r.veri : JSON.stringify(r.veri)));
  await ekle('rutlar', b.rutlar, r => depo.rutYaz(env, r.kullanici, r.tarih, typeof r.veri === 'string' ? r.veri : JSON.stringify(r.veri)));
  await ekle('yakitlar', b.yakitlar, async r => { // tekrar çalıştırılırsa aynı kayıt iki kez eklenmesin
    const var_ = await env.DB.prepare('SELECT 1 FROM yakitlar WHERE kullanici=? AND tarih=? AND tutar=? LIMIT 1').bind(safe(r.kullanici), r.tarih, r.tutar).first();
    if (!var_) await depo.yakitYaz(env, r.kullanici, { tarih: r.tarih, litre: r.litre, tutar: r.tutar, km: r.km, notu: r.notu });
  });
  await ekle('kullanicilar', b.kullanicilar, r => depo.kullaniciKaydet(env, r.ad, r.sifre));
  await ekle('ayarlar', b.ayarlar, r => depo.ayarYaz(env, r.anahtar, typeof r.deger === 'string' ? r.deger : JSON.stringify(r.deger)));
  await ekle('konumlar', b.konumlar, r => env.DB.prepare(`INSERT INTO konumlar (anahtar, lat, lon, kaynak, dogruluk, adres, kullanici, sayac) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (anahtar) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, kaynak=excluded.kaynak, dogruluk=excluded.dogruluk, adres=excluded.adres, kullanici=excluded.kullanici, sayac=excluded.sayac`)
    .bind(r.anahtar, r.lat, r.lon, r.kaynak, r.dogruluk ?? null, r.adres || '', r.kullanici || '', r.sayac || 1).run());
  await G.dbKullanicilari(env, true);
  return yanit(200, say);
}

async function girisYap(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'yerel';
  const form = new URLSearchParams((await request.text()).slice(0, 4096));
  if (G.kilitliMi(ip)) return yonlendir('/giris?hata=kilit');
  const ad = form.get('kullanici') || '', sifre = form.get('sifre') || '';
  if (await G.girisKontrol(env, ad, sifre)) {
    G.hataSil(ip);
    return yonlendir('/', G.cerez(request, await G.jetonYap(env, ad.trim().toLowerCase()), G.SESSION_DAYS * 86400));
  }
  return yonlendir('/giris?hata=' + (G.hataSay(ip) ? 'kilit' : '1'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), yol = url.pathname;
    // Kullanıcılar tanımlanmadan yayında hiçbir şey açılmaz (yalnızca yerel geliştirmede YEREL_ACIK=1 ile girişsiz çalışır)
    if (!G.girisAcik(env) && env.YEREL_ACIK !== '1') return new Response('Kurulum tamamlanmadı: Cloudflare panelinde ROTA_KULLANICILAR gizli ayarını girin.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    try {
      if (yol === '/giris') {
        if (request.method === 'POST') return girisYap(env, request);
        if (G.girisAcik(env) && await G.oturumKullanicisi(env, request)) return yonlendir('/');
        return statik(env, request, '/giris');
      }
      if (yol === '/cikis') return yonlendir('/giris?durum=cikis', G.cerez(request, '', 0));
      const user = await G.oturumKullanicisi(env, request);
      if (!user) {
        if (request.method === 'GET' && (yol === '/' || yol === '/index.html')) return yonlendir('/giris');
        return yanit(401, { error: 'Oturum süresi doldu, tekrar giriş yapın.', code: 'login' });
      }
      if (request.method === 'GET' || request.method === 'HEAD') return await get(env, request, url, user);
      if (request.method === 'POST') return await post(env, request, url, user);
      return new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
      if (e instanceof HttpHata) return yanit(e.status, { error: e.message, code: e.code });
      console.error(e);
      return yanit(502, { error: 'Sunucu hatası (veritabanı).', code: 'storage' });
    }
  },
};
