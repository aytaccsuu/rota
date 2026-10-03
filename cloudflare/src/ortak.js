// Ortak yardımcılar: yanıtlar, hatalar, doğrulama
export class HttpHata extends Error {
  constructor(status, mesaj, code = 'invalid_request') { super(mesaj); this.status = status; this.code = code; }
}

export const yanit = (status, data, basliklar = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...basliklar },
});
export const bos = (status = 204, basliklar = {}) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...basliklar } });
export const yonlendir = (yer, cerez) => new Response(null, {
  status: 303, headers: { Location: yer, 'Cache-Control': 'no-store', ...(cerez ? { 'Set-Cookie': cerez } : {}) },
});

// Python sürümündeki depo._safe ile aynı: kayıt anahtarı (Türkçe harfler "_" olur)
export const safe = u => (String(u || 'yerel').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40)) || 'yerel';

export const GUN = /^\d{4}-\d{2}-\d{2}$/;
export const AY = /^\d{4}-\d{2}$/;

// İstek gövdesini boyut sınırıyla JSON olarak okur
export async function govde(request, sinir) {
  const uzunluk = +request.headers.get('Content-Length') || 0;
  if (uzunluk > sinir) throw new HttpHata(400, 'İstek çok büyük.');
  const metin = await request.text();
  if (!metin || metin.length > sinir) throw new HttpHata(400, 'Geçersiz istek.');
  try { return JSON.parse(metin); } catch { throw new HttpHata(400, 'Geçersiz istek.'); }
}

export const sayi = (v, alt, ust) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < alt || n > ust) throw new HttpHata(400, 'Geçersiz sayı.');
  return n;
};

export function noktaListesi(pts, enCok = 150) {
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > enCok) throw new HttpHata(400, 'Geçersiz nokta listesi.');
  return pts.map(p => {
    const la = Number(p?.[0]), lo = Number(p?.[1]);
    if (!(la >= 35 && la <= 43 && lo >= 25 && lo <= 45)) throw new HttpHata(400, 'Geçersiz nokta listesi.');
    return [la, lo];
  });
}

export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const esit = (a, b) => { // sabit süreli karşılaştırma
  a = String(a); b = String(b);
  let fark = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) fark |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return fark === 0;
};
export function b64UrlKodla(metin) {
  const bayt = new TextEncoder().encode(metin);
  let s = ''; for (const b of bayt) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}
export function b64UrlCoz(metin) {
  const s = atob(String(metin).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, c => c.charCodeAt(0)));
}
export function b64Bayt(b64) {
  const s = atob(b64);
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

// 15 dakikalık bellek önbelleği (Worker örneği yaşadıkça)
const onbellek = new Map();
export function onbellekAl(anahtar, sure = 15 * 60 * 1000) {
  const k = onbellek.get(anahtar);
  return k && Date.now() - k[0] < sure ? k[1] : null;
}
export function onbellekKoy(anahtar, deger) {
  onbellek.set(anahtar, [Date.now(), deger]);
  if (onbellek.size > 60) for (const k of [...onbellek.keys()].slice(0, 15)) onbellek.delete(k);
}
