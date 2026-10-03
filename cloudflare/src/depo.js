// D1 (SQLite) veri katmanı — Python depo.py ile aynı davranış
import { safe } from './ortak.js';

const tek = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const hepsi = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results || [];
const calistir = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).run();

// ---------- plan ----------
export async function planOku(env, u) {
  const r = await tek(env, 'SELECT veri FROM planlar WHERE kullanici = ?', safe(u));
  return r ? r.veri : null;
}
export async function planYaz(env, u, metin) {
  if (metin === null) return calistir(env, 'DELETE FROM planlar WHERE kullanici = ?', safe(u));
  JSON.parse(metin);
  return calistir(env, `INSERT INTO planlar (kullanici, veri, guncelleme) VALUES (?, ?, datetime('now'))
    ON CONFLICT (kullanici) DO UPDATE SET veri = excluded.veri, guncelleme = excluded.guncelleme`, safe(u), metin);
}

// ---------- ortak ayarlar ----------
export async function ayarOku(env, k) {
  const r = await tek(env, 'SELECT deger FROM ayarlar WHERE anahtar = ?', k);
  return r ? r.deger : null;
}
export async function ayarYaz(env, k, metin) {
  JSON.parse(metin);
  return calistir(env, `INSERT INTO ayarlar (anahtar, deger, guncelleme) VALUES (?, ?, datetime('now'))
    ON CONFLICT (anahtar) DO UPDATE SET deger = excluded.deger, guncelleme = excluded.guncelleme`, k, metin);
}

// ---------- günlük rut kayıtları ----------
export async function rutYaz(env, u, tarih, metin) {
  if (metin === null) return calistir(env, 'DELETE FROM rutlar WHERE kullanici = ? AND tarih = ?', safe(u), tarih);
  JSON.parse(metin);
  return calistir(env, `INSERT INTO rutlar (kullanici, tarih, veri, guncelleme) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (kullanici, tarih) DO UPDATE SET veri = excluded.veri, guncelleme = excluded.guncelleme`, safe(u), tarih, metin);
}
export async function rutlariListele(env, u, ay) {
  const rows = await hepsi(env, 'SELECT tarih, veri FROM rutlar WHERE kullanici = ? AND tarih LIKE ? ORDER BY tarih', safe(u), ay + '-%');
  return rows.map(r => ({ tarih: r.tarih, ...JSON.parse(r.veri) }));
}

// ---------- yakıt ----------
export async function yakitYaz(env, u, item) {
  if (item.id) {
    await calistir(env, 'UPDATE yakitlar SET tarih=?, litre=?, tutar=?, km=?, notu=? WHERE id=? AND kullanici=?',
      item.tarih, item.litre ?? null, item.tutar, item.km ?? null, item.notu ?? null, item.id, safe(u));
    return item.id;
  }
  const r = await tek(env, 'INSERT INTO yakitlar (kullanici, tarih, litre, tutar, km, notu) VALUES (?,?,?,?,?,?) RETURNING id',
    safe(u), item.tarih, item.litre ?? null, item.tutar, item.km ?? null, item.notu ?? null);
  return r.id;
}
export const yakitSil = (env, u, id) => calistir(env, 'DELETE FROM yakitlar WHERE id=? AND kullanici=?', id, safe(u));
export async function yakitlariListele(env, u, ay) {
  const rows = await hepsi(env, 'SELECT id, tarih, litre, tutar, km, notu FROM yakitlar WHERE kullanici=? AND tarih LIKE ? ORDER BY tarih, id', safe(u), ay + '-%');
  return rows.map(r => ({ id: r.id, tarih: r.tarih, litre: r.litre, tutar: r.tutar, km: r.km, notu: r.notu }));
}

// ---------- evrak dosyaları (R2 varsa orada, yoksa D1'de) ----------
export async function evrakYaz(env, u, tarih, ad, mime, bayt) {
  if (env.EVRAK) {
    const r = await tek(env, 'INSERT INTO evraklar (kullanici, tarih, ad, mime, veri, r2) VALUES (?,?,?,?,NULL,1) RETURNING id', safe(u), tarih, ad.slice(0, 200), mime);
    await env.EVRAK.put(`evrak/${r.id}`, bayt, { httpMetadata: { contentType: mime } });
    return r.id;
  }
  if (bayt.byteLength > 1900000) throw new Error('D1 satır sınırı: dosya çok büyük');
  const tampon = bayt.buffer.slice(bayt.byteOffset, bayt.byteOffset + bayt.byteLength); // D1: BLOB için ArrayBuffer
  const r = await tek(env, 'INSERT INTO evraklar (kullanici, tarih, ad, mime, veri, r2) VALUES (?,?,?,?,?,0) RETURNING id', safe(u), tarih, ad.slice(0, 200), mime, tampon);
  return r.id;
}
export async function evrakOku(env, u, id) {
  const r = await tek(env, 'SELECT id, mime, veri, r2 FROM evraklar WHERE id = ? AND kullanici = ?', id, safe(u));
  if (!r) return null;
  if (r.r2) {
    const nesne = env.EVRAK ? await env.EVRAK.get(`evrak/${r.id}`) : null;
    return nesne ? [r.mime, await nesne.arrayBuffer()] : null;
  }
  return r.veri ? [r.mime, new Uint8Array(r.veri)] : null;
}
export async function evraklariSil(env, u, tarih) {
  const rows = await hepsi(env, 'SELECT id, r2 FROM evraklar WHERE kullanici = ? AND tarih = ?', safe(u), tarih);
  if (env.EVRAK) for (const r of rows.filter(r => r.r2)) await env.EVRAK.delete(`evrak/${r.id}`);
  await calistir(env, 'DELETE FROM evraklar WHERE kullanici = ? AND tarih = ?', safe(u), tarih);
}

// ---------- kullanıcılar ----------
export async function kullanicilariListele(env) {
  const rows = await hepsi(env, 'SELECT ad, sifre, olusturma FROM kullanicilar ORDER BY ad');
  return Object.fromEntries(rows.map(r => [r.ad, { sifre: r.sifre, olusturma: String(r.olusturma || '').slice(0, 10) }]));
}
export const kullaniciKaydet = (env, ad, ozet) => calistir(env,
  'INSERT INTO kullanicilar (ad, sifre) VALUES (?, ?) ON CONFLICT (ad) DO UPDATE SET sifre = excluded.sifre', ad, ozet);
export async function kullaniciSil(env, ad, verileriyle) {
  const u = safe(ad);
  await calistir(env, 'DELETE FROM kullanicilar WHERE ad = ?', ad);
  if (!verileriyle) return;
  if (env.EVRAK) {
    const rows = await hepsi(env, 'SELECT id FROM evraklar WHERE kullanici = ? AND r2 = 1', u);
    for (const r of rows) await env.EVRAK.delete(`evrak/${r.id}`);
  }
  await env.DB.batch(['planlar', 'rutlar', 'evraklar', 'yakitlar'].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE kullanici = ?`).bind(u))
    .concat([env.DB.prepare('DELETE FROM ayarlar WHERE anahtar IN (?, ?)').bind('noktalar:' + u, 'tercih:' + u)]));
}

// ---------- konum hafızası ----------
// arama hiçbir zaman ezmez; elle her zaman ezer; gps aramayı ve önceki gps'i ezer
const ezer = (yeni, eski) => !eski || yeni === 'elle' || (yeni === 'gps' && (eski === 'arama' || eski === 'gps'));

export async function konumBul(env, anahtarlar) {
  anahtarlar = [...new Set(anahtarlar.filter(a => typeof a === 'string'))].slice(0, 500);
  const out = {};
  for (let i = 0; i < anahtarlar.length; i += 90) { // D1: sorgu başına en çok 100 parametre
    const parca = anahtarlar.slice(i, i + 90);
    const rows = await hepsi(env, `SELECT anahtar, lat, lon, kaynak, dogruluk, sayac FROM konumlar WHERE anahtar IN (${parca.map(() => '?').join(',')})`, ...parca);
    for (const r of rows) out[r.anahtar] = { lat: r.lat, lon: r.lon, kaynak: r.kaynak, dogruluk: r.dogruluk, sayac: r.sayac };
  }
  return out;
}
export async function konumKaydet(env, anahtar, lat, lon, kaynak, adres, kullanici, dogruluk) {
  const eski = await tek(env, 'SELECT kaynak FROM konumlar WHERE anahtar = ?', anahtar);
  const yaz = ezer(kaynak, eski && eski.kaynak);
  if (yaz) {
    await calistir(env, `INSERT INTO konumlar (anahtar, lat, lon, kaynak, dogruluk, adres, kullanici, sayac, guncelleme)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT (anahtar) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, kaynak = excluded.kaynak, dogruluk = excluded.dogruluk,
      adres = excluded.adres, kullanici = excluded.kullanici, sayac = konumlar.sayac + 1, guncelleme = excluded.guncelleme`,
      anahtar, lat, lon, kaynak, dogruluk ?? null, String(adres || '').slice(0, 300), safe(kullanici));
  } else {
    await calistir(env, 'UPDATE konumlar SET sayac = sayac + 1 WHERE anahtar = ?', anahtar);
  }
  return yaz;
}
