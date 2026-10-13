// İş Bul: firma bulma → e-posta bulma → teklif taslağı → yönetici onayıyla gönderim → takip maili.
// Uç noktalar giriş yapmış kullanıcıya açıktır; /ret (listeden çıkma) ve /filo (tanıtım sayfası) herkese açıktır.
import { HttpHata, yanit, bos, govde } from './ortak.js';
import * as depo from './depo.js';
import { imza } from './giris.js';
import { smtpGonder, mesajOlustur, epostaGecerli, EpostaHatasi } from './eposta.js';
import { ILLER, ILCELER, SEKTORLER, aramaListesi, googleFirmaAra, osmFirmaAra, siteEpostasi, firmaAnahtari, taslakYap, yasalNot, FirmaHatasi } from './firmabul.js';

const DURUMLAR = ['arama', 'eposta_yok', 'hazir', 'gonderildi', 'takip_hazir', 'takip_gonderildi', 'cevap', 'olumlu', 'olumsuz', 'red', 'iptal', 'hata'];
const ELLE_DURUM = ['hazir', 'cevap', 'olumlu', 'olumsuz', 'iptal', 'eposta_yok', 'gonderildi'];
const VARSAYILAN = { iller: ['İstanbul', 'Kocaeli', 'Tekirdağ'], sektorler: Object.keys(SEKTORLER), otomatik: true, gunlukLimit: 40, takipGun: 5, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpKullanici: '' };
const FILO_ALAN = ['ad', 'unvan', 'yetkili', 'telefon', 'eposta', 'web', 'adres', 'bolgeler', 'hizmetler'];

const json = async (env, k, v = {}) => { try { return { ...v, ...JSON.parse(await depo.ayarOku(env, k) || '{}') }; } catch { return { ...v }; } };
export const firmaAyari = env => json(env, 'firmaAyar', VARSAYILAN);
export const filoBilgisi = env => json(env, 'filo', { ad: '', aracSayisi: 45, bolgeler: 'İstanbul, Kocaeli ve Tekirdağ', depolama: false });
const anahtarlar = async env => { try { return JSON.parse(await depo.ayarOku(env, 'anahtarlar') || '{}'); } catch { return {}; } };
const smtpSifresi = async env => env.SMTP_SIFRE || (await anahtarlar(env)).smtpSifre || '';
export const googleAnahtari = async env => env.GOOGLE_MAPS_API_KEY || (await anahtarlar(env)).gkey || '';

const tek = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const hepsi = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results || [];
const calistir = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).run();
const bugunGonderilen = async env => (await tek(env, "SELECT COUNT(*) AS n FROM gonderimler WHERE date(zaman, '+3 hours') = date('now', '+3 hours')")).n;
const trTarih = t => t ? new Date(t.replace(' ', 'T') + 'Z').toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '';

async function retJetonu(env, id) { return (await imza(env, 'ret:' + id)).slice(0, 20); }
async function retAdresi(env, kok, id) { return `${kok}/ret?f=${id}&t=${await retJetonu(env, id)}`; }

// ---------- firma kaydı ----------
async function firmaEkle(env, f, il, ilce, sektor, filo) {
  const anahtar = firmaAnahtari(f);
  if (!anahtar) return false;
  let durum = f.eposta ? 'hazir' : f.web ? 'arama' : 'eposta_yok', t = { konu: '', metin: '' };
  if (f.eposta && await engelliMi(env, f.eposta)) durum = 'red';
  if (durum === 'hazir') t = taslakYap({ ...f, sektor }, filo);
  const r = await calistir(env, `INSERT OR IGNORE INTO firmalar (anahtar, ad, sektor, il, ilce, adres, telefon, web, eposta, kaynak, durum, konu, metin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, anahtar, f.ad.slice(0, 200), sektor, il, ilce, f.adres.slice(0, 300), f.telefon.slice(0, 40), f.web.slice(0, 300), f.eposta, f.kaynak, durum, t.konu, t.metin);
  return (r.meta?.changes || 0) > 0;
}
const engelliMi = async (env, e) => !!(await tek(env, 'SELECT 1 FROM engelli_epostalar WHERE eposta = ?', String(e).toLowerCase()));

export async function firmaAra(env, { il, ilce = '', sektor, arama = '', kaynak = 'google', sayfa = '' }, gkey) {
  if (!ILLER.includes(il) || !SEKTORLER[sektor] || (ilce && !(ILCELER[il] || []).includes(ilce) && !/^[\p{L} .-]{2,40}$/u.test(ilce))) throw new HttpHata(400, 'Geçersiz il, ilçe veya sektör.');
  const filo = await filoBilgisi(env);
  let liste = [], sonraki = '';
  if (kaynak === 'osm') liste = await osmFirmaAra(il, sektor);
  else {
    if (!gkey) throw new HttpHata(503, 'Google ile arama için Ayarlar → API anahtarlarına Google Places (New) anahtarı ekleyin. Ücretsiz arama için "OpenStreetMap" seçin.', 'missing_key');
    const sorgu = `${arama || SEKTORLER[sektor].aramalar[0]} ${ilce ? ilce + ' ' : ''}${il}`;
    ({ firmalar: liste, sonraki } = await googleFirmaAra(sorgu, gkey, sayfa));
  }
  let eklenen = 0;
  for (const f of liste) if (await firmaEkle(env, f, il, ilce, sektor, filo)) eklenen++;
  return { bulunan: liste.length, eklenen, sonraki };
}

// Sitesi olup e-postası bilinmeyen firmaların sitelerini tarar (Worker istek sınırı için tek seferde az sayıda)
export async function epostaTara(env, adet = 8) {
  const filo = await filoBilgisi(env);
  const rows = await hepsi(env, "SELECT * FROM firmalar WHERE durum = 'arama' ORDER BY id LIMIT ?", adet);
  let bulunan = 0;
  for (const f of rows) {
    let e = '';
    try { e = await siteEpostasi(f.web); } catch { e = ''; }
    if (e && await engelliMi(env, e)) { await calistir(env, "UPDATE firmalar SET eposta=?, durum='red', guncelleme=datetime('now') WHERE id=?", e, f.id); continue; }
    if (e) {
      const t = taslakYap(f, filo); bulunan++;
      await calistir(env, "UPDATE firmalar SET eposta=?, durum='hazir', konu=?, metin=?, guncelleme=datetime('now') WHERE id=?", e, t.konu, t.metin, f.id);
    } else await calistir(env, "UPDATE firmalar SET durum='eposta_yok', guncelleme=datetime('now') WHERE id=?", f.id);
  }
  const kalan = (await tek(env, "SELECT COUNT(*) AS n FROM firmalar WHERE durum = 'arama'")).n;
  return { islenen: rows.length, bulunan, kalan };
}

// İlk maile süresi içinde cevap gelmeyenler için takip taslağı (yalnızca bir kez)
export async function takipHazirla(env) {
  const ayar = await firmaAyari(env), filo = await filoBilgisi(env);
  const gun = Math.max(2, Math.min(30, +ayar.takipGun || 5));
  const rows = await hepsi(env, `SELECT * FROM firmalar WHERE durum = 'gonderildi' AND takip_sayisi = 0 AND son_gonderim < datetime('now', ?) LIMIT 200`, `-${gun} days`);
  for (const f of rows) {
    const t = taslakYap(f, filo, 'takip', trTarih(f.ilk_gonderim));
    await calistir(env, "UPDATE firmalar SET durum='takip_hazir', konu=?, metin=?, guncelleme=datetime('now') WHERE id=?", t.konu, t.metin, f.id);
  }
  return rows.length;
}

// ---------- gönderim ----------
async function gonder(env, baglan, kok, idler) {
  const ayar = await firmaAyari(env), filo = await filoBilgisi(env), sifre = await smtpSifresi(env);
  if (!ayar.smtpKullanici || !sifre) throw new HttpHata(503, 'Önce İş Bul → Ayarlar bölümünde gönderen mail adresini ve uygulama şifresini girin.', 'missing_key');
  if (!filo.ad || !filo.telefon) throw new HttpHata(400, 'Önce İş Bul → Ayarlar bölümünde ekip/firma adı ve telefonu girin (mailin altında yer alır).');
  const limit = Math.max(1, Math.min(200, +ayar.gunlukLimit || 40));
  let kalan = limit - await bugunGonderilen(env);
  const sonuc = { gonderilen: 0, hatalar: [], kalan: 0 };
  const alan = ayar.smtpKullanici.split('@')[1] || 'rota-plani';
  for (const id of idler.slice(0, 5)) { // tek istekte en çok 5 (arayüz kalanlar için tekrar çağırır)
    if (kalan <= 0) { sonuc.hatalar.push({ id, hata: `Bugünkü gönderim sınırı (${limit}) doldu; yarın devam edin.` }); break; }
    const f = await tek(env, 'SELECT * FROM firmalar WHERE id = ?', id);
    if (!f || !['hazir', 'takip_hazir'].includes(f.durum)) continue;
    const takip = f.durum === 'takip_hazir';
    if (!epostaGecerli(f.eposta)) { sonuc.hatalar.push({ id, hata: 'E-posta adresi geçersiz.' }); continue; }
    if (await engelliMi(env, f.eposta)) { await calistir(env, "UPDATE firmalar SET durum='red' WHERE id=?", id); continue; }
    if (!takip && await tek(env, "SELECT 1 FROM gonderimler WHERE eposta = ? AND firma_id != ? AND tur = 'ilk'", f.eposta, id)) {
      await calistir(env, "UPDATE firmalar SET durum='iptal', hata='Bu adrese başka bir kayıttan zaten mail gitti.' WHERE id=?", id); continue;
    }
    const ret = await retAdresi(env, kok, id);
    const veri = mesajOlustur({
      gonderen: ayar.smtpKullanici, gonderenAd: filo.ad, alici: f.eposta, konu: f.konu, metin: f.metin + yasalNot(filo, ret),
      cevapAdresi: filo.eposta && epostaGecerli(filo.eposta) ? filo.eposta : ayar.smtpKullanici, retUrl: ret,
      // ilk mailin kimliği sabit: takip maili ona bağlanır (alıcıda aynı yazışmada görünür)
      mesajId: takip ? `isbul-${id}-takip-${Date.now()}@${alan}` : `isbul-${id}-ilk@${alan}`, oncekiId: takip ? `isbul-${id}-ilk@${alan}` : '',
    });
    try {
      await smtpGonder({ host: ayar.smtpHost, port: ayar.smtpPort, kullanici: ayar.smtpKullanici, sifre }, { gonderen: ayar.smtpKullanici, alici: f.eposta, veri }, baglan);
    } catch (e) {
      const mesaj = e instanceof EpostaHatasi ? e.message : 'Mail sunucusuna bağlanılamadı.';
      if (e instanceof EpostaHatasi && e.alici) await calistir(env, "UPDATE firmalar SET durum='hata', hata=?, guncelleme=datetime('now') WHERE id=?", mesaj, id);
      sonuc.hatalar.push({ id, hata: mesaj });
      if (!(e instanceof EpostaHatasi && e.alici)) break; // giriş/bağlantı hatası: diğerleri de gitmez
      continue;
    }
    await env.DB.batch([
      env.DB.prepare('INSERT INTO gonderimler (firma_id, eposta, tur, konu) VALUES (?,?,?,?)').bind(id, f.eposta, takip ? 'takip' : 'ilk', f.konu),
      env.DB.prepare(`UPDATE firmalar SET durum=?, takip_sayisi=takip_sayisi+?, ilk_gonderim=COALESCE(ilk_gonderim, datetime('now')), son_gonderim=datetime('now'), hata='', guncelleme=datetime('now') WHERE id=?`)
        .bind(takip ? 'takip_gonderildi' : 'gonderildi', takip ? 1 : 0, id),
    ]);
    sonuc.gonderilen++; kalan--;
  }
  sonuc.kalan = Math.max(0, kalan);
  return sonuc;
}

// ---------- uç noktalar (yönetici) ----------
const temizMetin = (v, n) => String(v ?? '').replace(/\r/g, '').slice(0, n);
async function kokKaydet(env, url) { // zamanlı görevin bağlantı verebilmesi için sitenin adresi
  const ayar = await firmaAyari(env);
  if (ayar.siteAdresi !== url.origin && /^https:\/\//.test(url.origin)) await depo.ayarYaz(env, 'firmaAyar', JSON.stringify({ ...ayar, siteAdresi: url.origin }));
}

export async function isbulGet(env, url, gkey) {
  const yol = url.pathname, q = url.searchParams;
  if (yol === '/api/isbul/durum') {
    await kokKaydet(env, url);
    const ayar = await firmaAyari(env), sifre = await smtpSifresi(env);
    const sayac = Object.fromEntries((await hepsi(env, 'SELECT durum, COUNT(*) AS n FROM firmalar GROUP BY durum')).map(r => [r.durum, r.n]));
    return yanit(200, {
      ayar: { ...ayar, smtpSifreVar: !!sifre, smtpIpucu: sifre ? sifre.slice(-3) : '' }, filo: await filoBilgisi(env), googleHazir: !!gkey, googleIpucu: gkey ? gkey.slice(-4) : '',
      sayac, bugun: await bugunGonderilen(env), iller: ILLER, ilceler: ILCELER, sektorler: Object.fromEntries(Object.entries(SEKTORLER).map(([k, v]) => [k, { ad: v.ad, aramalar: v.aramalar, osm: !!v.osm.length }])),
      imlec: +(await depo.ayarOku(env, 'firmaImlec') || 0), toplamArama: aramaListesi(ayar.iller, ayar.sektorler).length,
    });
  }
  if (yol === '/api/isbul/firmalar') {
    const durum = q.get('durum') || '', ara = (q.get('q') || '').trim().slice(0, 80), sayfa = Math.max(0, parseInt(q.get('sayfa') || '0', 10) || 0);
    const kosul = [], p = [];
    if (durum === 'gonderilenler') kosul.push("durum IN ('gonderildi','takip_gonderildi')");
    else if (durum === 'cevaplar') kosul.push("durum IN ('cevap','olumlu','olumsuz')");
    else if (DURUMLAR.includes(durum)) { kosul.push('durum = ?'); p.push(durum); }
    if (ara) { kosul.push('(ad LIKE ? OR eposta LIKE ? OR il LIKE ? OR ilce LIKE ?)'); p.push(...Array(4).fill('%' + ara + '%')); }
    const where = kosul.length ? 'WHERE ' + kosul.join(' AND ') : '';
    const rows = await hepsi(env, `SELECT id, ad, sektor, il, ilce, adres, telefon, web, eposta, kaynak, durum, konu, metin, takip_sayisi, ilk_gonderim, son_gonderim, notu, hata, olusturma FROM firmalar ${where} ORDER BY guncelleme DESC, id DESC LIMIT 50 OFFSET ?`, ...p, sayfa * 50);
    const toplam = (await tek(env, `SELECT COUNT(*) AS n FROM firmalar ${where}`, ...p)).n;
    return yanit(200, { firmalar: rows, toplam });
  }
  if (yol === '/api/isbul/csv') {
    const rows = await hepsi(env, 'SELECT ad, sektor, il, ilce, telefon, web, eposta, durum, ilk_gonderim, son_gonderim, notu FROM firmalar ORDER BY id');
    const h = ['ad', 'sektor', 'il', 'ilce', 'telefon', 'web', 'eposta', 'durum', 'ilk_gonderim', 'son_gonderim', 'notu'];
    const kac = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return new Response('﻿' + [h.join(';'), ...rows.map(r => h.map(k => kac(r[k])).join(';'))].join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="firmalar.csv"', 'Cache-Control': 'no-store' } });
  }
  return null;
}

export async function isbulPost(env, request, url, gkey, baglan) {
  const yol = url.pathname;
  if (!yol.startsWith('/api/isbul/')) return null;
  await kokKaydet(env, url);
  const b = await govde(request, 64 * 1024);
  if (yol === '/api/isbul/ayar') {
    if (b.ayar) {
      const a = b.ayar, eski = await firmaAyari(env);
      const yeni = {
        ...eski,
        iller: Array.isArray(a.iller) ? a.iller.filter(i => ILLER.includes(i)) : eski.iller,
        sektorler: Array.isArray(a.sektorler) ? a.sektorler.filter(s => SEKTORLER[s]) : eski.sektorler,
        otomatik: a.otomatik === undefined ? eski.otomatik : !!a.otomatik,
        gunlukLimit: Math.max(1, Math.min(200, parseInt(a.gunlukLimit ?? eski.gunlukLimit, 10) || 40)),
        takipGun: Math.max(2, Math.min(30, parseInt(a.takipGun ?? eski.takipGun, 10) || 5)),
        smtpHost: /^[a-z0-9.-]{3,100}$/i.test(a.smtpHost || '') ? a.smtpHost : eski.smtpHost,
        smtpPort: [465, 587].includes(+a.smtpPort) ? +a.smtpPort : eski.smtpPort,
        smtpKullanici: a.smtpKullanici === undefined ? eski.smtpKullanici : epostaGecerli(a.smtpKullanici) || a.smtpKullanici === '' ? String(a.smtpKullanici).trim().toLowerCase() : (() => { throw new HttpHata(400, 'Gönderen mail adresi geçersiz.'); })(),
      };
      if (JSON.stringify(yeni.iller) !== JSON.stringify(eski.iller) || JSON.stringify(yeni.sektorler) !== JSON.stringify(eski.sektorler)) await depo.ayarYaz(env, 'firmaImlec', '0');
      await depo.ayarYaz(env, 'firmaAyar', JSON.stringify(yeni));
    }
    if (b.filo) {
      const f = { ...(await filoBilgisi(env)) };
      for (const k of FILO_ALAN) if (k in b.filo) f[k] = temizMetin(b.filo[k], k === 'hizmetler' ? 1500 : 200).trim();
      if ('aracSayisi' in b.filo) f.aracSayisi = Math.max(0, Math.min(10000, parseInt(b.filo.aracSayisi, 10) || 0));
      if ('depolama' in b.filo) f.depolama = !!b.filo.depolama;
      if (f.eposta && !epostaGecerli(f.eposta)) throw new HttpHata(400, 'Cevap mail adresi geçersiz.');
      await depo.ayarYaz(env, 'filo', JSON.stringify(f));
    }
    if (typeof b.smtpSifre === 'string' || typeof b.googleKey === 'string') {
      const k = await anahtarlar(env);
      if (typeof b.smtpSifre === 'string') k.smtpSifre = b.smtpSifre.replace(/\s+/g, '').slice(0, 200); // Gmail uygulama şifresi boşluklu gösterilir
      if (typeof b.googleKey === 'string') k.gkey = b.googleKey.trim().slice(0, 200);
      await depo.ayarYaz(env, 'anahtarlar', JSON.stringify(k));
    }
    return bos();
  }
  if (yol === '/api/isbul/ara') {
    try { return yanit(200, await firmaAra(env, { il: String(b.il || ''), ilce: String(b.ilce || ''), sektor: String(b.sektor || ''), arama: temizMetin(b.arama, 80), kaynak: b.kaynak === 'osm' ? 'osm' : 'google', sayfa: temizMetin(b.sayfa, 1000) }, gkey)); }
    catch (e) { if (e instanceof FirmaHatasi) return yanit(502, { error: e.message, code: 'upstream' }); if (e instanceof HttpHata) throw e; return yanit(502, { error: 'Arama servisine ulaşılamadı; tekrar deneyin.', code: 'network' }); }
  }
  if (yol === '/api/isbul/eposta-tara') return yanit(200, await epostaTara(env, 8));
  if (yol === '/api/isbul/takip-hazirla') return yanit(200, { hazirlanan: await takipHazirla(env) });
  if (yol === '/api/isbul/gonder') {
    const idler = Array.isArray(b.idler) ? b.idler.map(x => parseInt(x, 10)).filter(Number.isFinite) : [];
    if (!idler.length) throw new HttpHata(400, 'Gönderilecek firma seçin.');
    return yanit(200, await gonder(env, baglan, url.origin, idler));
  }
  if (yol === '/api/isbul/deneme') { // kendi adresine örnek mail: ayarların doğru olduğunu gösterir
    const ayar = await firmaAyari(env), filo = await filoBilgisi(env), sifre = await smtpSifresi(env);
    if (!ayar.smtpKullanici || !sifre) throw new HttpHata(400, 'Önce gönderen mail adresini ve uygulama şifresini kaydedin.');
    const ornek = taslakYap({ ad: 'Örnek Firma A.Ş.', sektor: 'toptan' }, filo);
    const veri = mesajOlustur({ gonderen: ayar.smtpKullanici, gonderenAd: filo.ad || 'Deneme', alici: ayar.smtpKullanici, konu: '[Deneme] ' + ornek.konu, metin: ornek.metin + yasalNot(filo, url.origin + '/ret?ornek=1'), mesajId: `deneme-${Date.now()}@${ayar.smtpKullanici.split('@')[1]}` });
    try { await smtpGonder({ host: ayar.smtpHost, port: ayar.smtpPort, kullanici: ayar.smtpKullanici, sifre }, { gonderen: ayar.smtpKullanici, alici: ayar.smtpKullanici, veri }, baglan); }
    catch (e) { return yanit(502, { error: e instanceof EpostaHatasi ? e.message : 'Mail sunucusuna bağlanılamadı.', code: 'smtp' }); }
    return yanit(200, { gonderildi: ayar.smtpKullanici });
  }
  if (yol === '/api/isbul/firma') { // düzenleme: e-posta, taslak, durum, not
    const id = parseInt(b.id, 10), f = Number.isFinite(id) ? await tek(env, 'SELECT * FROM firmalar WHERE id = ?', id) : null;
    if (!f) throw new HttpHata(404, 'Firma bulunamadı.', 'not_found');
    if (b.sil) { await calistir(env, 'DELETE FROM firmalar WHERE id = ?', id); return bos(); }
    const yeni = { ...f };
    if ('eposta' in b) {
      const e = String(b.eposta || '').trim().toLowerCase();
      if (e && !epostaGecerli(e)) throw new HttpHata(400, 'E-posta adresi geçersiz.');
      yeni.eposta = e;
      if (e && ['arama', 'eposta_yok', 'hata'].includes(f.durum)) { Object.assign(yeni, taslakYap(f, await filoBilgisi(env))); yeni.durum = 'hazir'; yeni.hata = ''; }
    }
    if ('konu' in b) yeni.konu = temizMetin(b.konu, 200).replace(/\n/g, ' ');
    if ('metin' in b) yeni.metin = temizMetin(b.metin, 8000);
    if ('notu' in b) yeni.notu = temizMetin(b.notu, 1000);
    if ('durum' in b) {
      if (!ELLE_DURUM.includes(b.durum)) throw new HttpHata(400, 'Geçersiz durum.');
      if (b.durum === 'hazir' && !yeni.eposta) throw new HttpHata(400, 'Önce e-posta adresi girin.');
      if (b.durum === 'hazir' && f.takip_sayisi === 0 && f.ilk_gonderim) yeni.durum = 'takip_hazir';
      else yeni.durum = b.durum;
    }
    if (b.yeniTaslak) Object.assign(yeni, taslakYap(f, await filoBilgisi(env), f.ilk_gonderim ? 'takip' : 'ilk', trTarih(f.ilk_gonderim)));
    await calistir(env, "UPDATE firmalar SET eposta=?, konu=?, metin=?, notu=?, durum=?, hata=?, guncelleme=datetime('now') WHERE id=?", yeni.eposta, yeni.konu, yeni.metin, yeni.notu, yeni.durum, yeni.hata, id);
    return yanit(200, { firma: await tek(env, 'SELECT * FROM firmalar WHERE id = ?', id) });
  }
  if (yol === '/api/isbul/firma-ekle') { // elle: tanıdık firma, kartvizit…
    const f = { kimlik: 'elle:' + Date.now(), ad: temizMetin(b.ad, 200).trim(), web: temizMetin(b.web, 300).trim(), telefon: temizMetin(b.telefon, 40).trim(), eposta: String(b.eposta || '').trim().toLowerCase(), adres: '', kaynak: 'Elle' };
    const il = ILLER.includes(b.il) ? b.il : '', sektor = SEKTORLER[b.sektor] ? b.sektor : 'toptan';
    if (f.ad.length < 2 || (f.eposta && !epostaGecerli(f.eposta))) throw new HttpHata(400, 'Firma adı ve geçerli bir e-posta girin.');
    if (f.eposta && await tek(env, 'SELECT 1 FROM firmalar WHERE eposta = ?', f.eposta)) throw new HttpHata(400, 'Bu e-posta zaten listede.');
    const eklendi = await firmaEkle(env, f, il, '', sektor, await filoBilgisi(env));
    if (!eklendi) throw new HttpHata(400, 'Bu firma (aynı web sitesi) zaten listede.');
    return bos();
  }
  return null;
}

// ---------- zamanlı görev (her sabah) ----------
export async function zamanliGorev(env, gkey) {
  const ayar = await firmaAyari(env);
  if (!ayar.otomatik) return { kapali: true };
  const ozet = { takip: await takipHazirla(env), arama: [], eposta: null };
  const liste = aramaListesi(ayar.iller, ayar.sektorler);
  if (liste.length) {
    let imlec = +(await depo.ayarOku(env, 'firmaImlec') || 0);
    if (gkey) {
      for (let i = 0; i < 4; i++) { // günde 4 Google araması (~120/ay; ücretsiz kotanın altında)
        const a = liste[imlec % liste.length]; imlec++;
        try { ozet.arama.push({ ...a, ...(await firmaAra(env, { ...a, kaynak: 'google' }, gkey)) }); } catch (e) { ozet.arama.push({ ...a, hata: e.message }); break; }
      }
    } else { // Google anahtarı yoksa OpenStreetMap: her gün bir il × sektör
      const ciftler = [...new Set(liste.filter(a => SEKTORLER[a.sektor].osm.length).map(a => a.il + '|' + a.sektor))];
      if (ciftler.length) {
        const [il, sektor] = ciftler[imlec % ciftler.length].split('|'); imlec++;
        try { ozet.arama.push({ il, sektor, ...(await firmaAra(env, { il, sektor, kaynak: 'osm' }, '')) }); } catch (e) { ozet.arama.push({ il, sektor, hata: e.message }); }
      }
    }
    await depo.ayarYaz(env, 'firmaImlec', String(imlec));
  }
  ozet.eposta = await epostaTara(env, 6);
  await depo.ayarYaz(env, 'firmaSonGorev', JSON.stringify({ zaman: new Date().toISOString(), ...ozet })).catch(() => {});
  return ozet;
}

// ---------- herkese açık sayfalar ----------
const kac = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sayfa = (baslik, icerik) => new Response(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${kac(baslik)}</title>
<style>:root{--bg:#f6f8f7;--card:#fff;--ink:#17302b;--mute:#5d6f6a;--pri:#13795b;--line:#dfe7e3}@media(prefers-color-scheme:dark){:root{--bg:#0d1412;--card:#15201d;--ink:#e8f0ed;--mute:#9db1aa;--pri:#3ccf98;--line:#26342f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:16px}h1{font-size:28px;line-height:1.25;margin:0 0 8px}h2{font-size:18px;margin:0 0 10px}
p{margin:0 0 10px}.mute{color:var(--mute)}ul{margin:0;padding-left:20px}li{margin:4px 0}.btn{display:inline-block;background:var(--pri);color:#fff;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tiles div{border:1px solid var(--line);border-radius:12px;padding:12px}.tiles b{display:block;font-size:22px}</style></head><body><main>${icerik}</main></body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });

export async function retSayfasi(env, request, url) {
  const id = parseInt(url.searchParams.get('f') || '', 10), t = url.searchParams.get('t') || '';
  if (url.searchParams.get('ornek')) return sayfa('Listeden çık', '<div class="card"><h1>Deneme bağlantısı</h1><p>Gerçek maillerde bu bağlantı alıcıyı listeden çıkarır.</p></div>');
  const gecerli = Number.isFinite(id) && t.length === 20 && t === await retJetonu(env, id);
  const f = gecerli ? await tek(env, 'SELECT id, ad, eposta FROM firmalar WHERE id = ?', id) : null;
  if (!f) return sayfa('Listeden çık', '<div class="card"><h1>Bağlantı geçersiz</h1><p class="mute">Bu maile "ÇIKAR" yazarak cevap verirseniz sizi listeden elle çıkarırız.</p></div>');
  if (request.method === 'POST') {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO engelli_epostalar (eposta) VALUES (?)').bind(f.eposta.toLowerCase()),
      env.DB.prepare("UPDATE firmalar SET durum='red', guncelleme=datetime('now') WHERE eposta = ?").bind(f.eposta.toLowerCase()),
    ]);
    return sayfa('Listeden çıkarıldınız', `<div class="card"><h1>Listeden çıkarıldınız</h1><p>${kac(f.eposta)} adresine bir daha mail göndermeyeceğiz. Rahatsızlık için özür dileriz.</p></div>`);
  }
  // GET'te işlem yapılmaz: mail güvenlik tarayıcıları bağlantıyı açınca kişi istemeden çıkarılmasın
  return sayfa('Listeden çık', `<div class="card"><h1>Listeden çık</h1><p>${kac(f.eposta)} adresine tanıtım maili gönderilmesin mi?</p><form method="post"><button class="btn">Evet, listeden çıkar</button></form></div>`);
}

export async function filoSayfasi(env) {
  const f = await filoBilgisi(env);
  if (!f.ad) return sayfa('Tanıtım sayfası', '<div class="card"><h1>Sayfa hazırlanıyor</h1></div>');
  const hizmet = (f.hizmetler || 'Günlük / haftalık düzenli dağıtım rotaları\nAynı gün teslimat ve acil sevkiyat\nDepodan yükleme, rota planlama, teslim takibi ve teslim fotoğrafı\nSize özel araç ve şoför (aylık sabit çalışma)' + (f.depolama ? '\nDepolama ve sipariş hazırlama' : '')).split('\n').map(x => x.trim()).filter(Boolean);
  const tel = String(f.telefon || '').replace(/[^\d+]/g, '');
  return sayfa(f.ad, `<div class="card"><h1>${kac(f.ad)}</h1><p class="mute">${kac(f.bolgeler || '')} bölgesinde kamyonetle dağıtım, sevkiyat ve teslimat</p>
<div class="tiles">${+f.aracSayisi ? `<div><b>${+f.aracSayisi}</b>kamyonet</div>` : ''}<div><b>Aynı gün</b>teslimat</div><div><b>Rota</b>planlı dağıtım</div></div></div>
<div class="card"><h2>Hizmetlerimiz</h2><ul>${hizmet.map(h => `<li>${kac(h)}</li>`).join('')}</ul></div>
<div class="card"><h2>İletişim</h2>${f.yetkili ? `<p>${kac(f.yetkili)}</p>` : ''}${tel ? `<p><a class="btn" href="tel:${kac(tel)}">Ara: ${kac(f.telefon)}</a></p>` : ''}${f.eposta ? `<p><a href="mailto:${kac(f.eposta)}">${kac(f.eposta)}</a></p>` : ''}${f.adres ? `<p class="mute">${kac(f.adres)}</p>` : ''}${f.unvan ? `<p class="mute">${kac(f.unvan)}</p>` : ''}</div>`);
}
