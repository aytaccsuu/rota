// İş Bul birim testleri (ağ gerekmez):  node test_isbul.mjs
import assert from 'node:assert/strict';
import { smtpGonder, mesajOlustur, baslikKodla, epostaGecerli, EpostaHatasi } from './src/eposta.js';
import { epostalariCikar, enIyiEposta, kendiSitesi, firmaAnahtari, aramaListesi, taslakYap, yasalNot, siteEpostasi, ILLER } from './src/firmabul.js';

let gecen = 0;
const test = async (ad, fn) => { await fn(); gecen++; console.log('✓', ad); };

// Sahte SMTP sunucusu: istemcinin yazdığı komutlara sırayla yanıt verir
function sahteSunucu(yanitlar, { tls = true } = {}) {
  const yazilan = [], kuyruk = [], enc = new TextEncoder(), dec = new TextDecoder();
  let bekleyen = null, kapali = false, i = 0;
  const ver = () => {
    if (i >= yanitlar.length) return;
    const v = enc.encode(yanitlar[i++]);
    if (bekleyen) { const b = bekleyen; bekleyen = null; b({ value: v, done: false }); } else kuyruk.push(v);
  };
  const soket = () => ({
    readable: { getReader: () => ({ read: () => kuyruk.length ? Promise.resolve({ value: kuyruk.shift(), done: false }) : kapali ? Promise.resolve({ done: true }) : new Promise(r => { bekleyen = r; }), releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async b => { yazilan.push(dec.decode(b)); ver(); }, releaseLock() {} }) },
    startTls: () => soket(),
    close() { kapali = true; },
  });
  return { baglan: (adres, secenek) => { assert.equal(secenek.secureTransport, tls ? 'on' : 'starttls'); ver(); return soket(); }, yazilan };
}

await test('SMTP 465: giriş, alıcı, veri, bitiş', async () => {
  const s = sahteSunucu(['220 smtp.gmail.com ESMTP\r\n', '250-smtp.gmail.com\r\n250-AUTH PLAIN\r\n250 SMTPUTF8\r\n', '235 2.7.0 Accepted\r\n', '250 OK\r\n', '250 OK\r\n', '354 Go ahead\r\n', '250 2.0.0 OK queued\r\n', '221 bye\r\n']);
  const veri = mesajOlustur({ gonderen: 'filo@gmail.com', gonderenAd: 'Kamyonet Ekibi', alici: 'info@firma.com.tr', konu: 'Dağıtım desteği', metin: 'Merhaba\n.nokta satırı\nŞğÜ', mesajId: 'x@gmail.com' });
  const r = await smtpGonder({ host: 'smtp.gmail.com', port: 465, kullanici: 'filo@gmail.com', sifre: 'abcd efgh' }, { gonderen: 'filo@gmail.com', alici: 'info@firma.com.tr', veri }, s.baglan);
  assert.match(r, /queued/);
  assert.equal(s.yazilan[0], 'EHLO rota-plani\r\n');
  assert.equal(s.yazilan[1], 'AUTH PLAIN ' + Buffer.from('\0filo@gmail.com\0abcd efgh').toString('base64') + '\r\n');
  assert.equal(s.yazilan[2], 'MAIL FROM:<filo@gmail.com>\r\n');
  assert.equal(s.yazilan[3], 'RCPT TO:<info@firma.com.tr>\r\n');
  assert.ok(s.yazilan[5].endsWith('\r\n.\r\n'));
});

await test('SMTP 587: STARTTLS sonrası yeniden EHLO', async () => {
  const s = sahteSunucu(['220 hi\r\n', '250 ok\r\n', '220 ready\r\n', '250 ok\r\n', '235 ok\r\n', '250 ok\r\n', '250 ok\r\n', '354 go\r\n', '250 ok\r\n', '221\r\n'], { tls: false });
  await smtpGonder({ host: 'smtp.x', port: 587, kullanici: 'a@b.co', sifre: 'p' }, { gonderen: 'a@b.co', alici: 'c@d.co', veri: 'X' }, s.baglan);
  assert.deepEqual(s.yazilan.slice(0, 3), ['EHLO rota-plani\r\n', 'STARTTLS\r\n', 'EHLO rota-plani\r\n']);
});

await test('SMTP: yanlış şifre anlaşılır hata, alıcı reddi ayrı işaretlenir', async () => {
  const s = sahteSunucu(['220 hi\r\n', '250 ok\r\n', '535-5.7.8 Username and Password not accepted\r\n535 5.7.8 more\r\n']);
  await assert.rejects(smtpGonder({ host: 'h', port: 465, kullanici: 'a@b.co', sifre: 'p' }, { gonderen: 'a@b.co', alici: 'c@d.co', veri: 'X' }, s.baglan), e => e instanceof EpostaHatasi && /uygulama şifresi/.test(e.message) && !e.alici);
  const s2 = sahteSunucu(['220 hi\r\n', '250 ok\r\n', '235 ok\r\n', '250 ok\r\n', '550 5.1.1 no such user\r\n']);
  await assert.rejects(smtpGonder({ host: 'h', port: 465, kullanici: 'a@b.co', sifre: 'p' }, { gonderen: 'a@b.co', alici: 'c@d.co', veri: 'X' }, s2.baglan), e => e.alici === true);
});

await test('MIME: Türkçe konu kodlanır, gövde base64, ret başlıkları', () => {
  assert.equal(baslikKodla('Hello'), 'Hello');
  const k = baslikKodla('Çok uzun bir Türkçe konu satırı: dağıtım, sevkiyat ve depolama hizmetleri');
  assert.ok(k.split('\r\n ').every(p => p.length <= 75 && /^=\?UTF-8\?B\?/.test(p)));
  const cozulen = k.split('\r\n ').map(p => Buffer.from(p.slice(10, -2), 'base64').toString()).join('');
  assert.equal(cozulen, 'Çok uzun bir Türkçe konu satırı: dağıtım, sevkiyat ve depolama hizmetleri');
  const m = mesajOlustur({ gonderen: 'a@b.co', alici: 'c@d.co', konu: 'Konu', metin: 'Satır 1\nSatır 2', mesajId: 'id@b.co', oncekiId: 'ilk@b.co', retUrl: 'https://x/ret?f=1&t=2', cevapAdresi: 'r@b.co' });
  assert.match(m, /^In-Reply-To: <ilk@b\.co>$/m);
  assert.match(m, /^Reply-To: <r@b\.co>$/m);
  assert.match(m, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  const govde = m.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(govde, 'base64').toString(), 'Satır 1\r\nSatır 2');
});

await test('Siteden e-posta: Cloudflare gizlemesi, [at], sahte adresler elenir', () => {
  const k = 0x42, e = 'satis@ornekfirma.com.tr';
  const cf = k.toString(16) + [...e].map(c => (c.charCodeAt(0) ^ k).toString(16).padStart(2, '0')).join('');
  const html = `<a href="/cdn-cgi/l/email-protection" data-cfemail="${cf}">[email&#160;protected]</a> info [at] ornekfirma.com.tr
    logo@2x.png noreply@ornekfirma.com.tr 3f2a9b8c7d6e5f4a3b2c1d0e9f8a7b6c@sentry.io user@example.com ik@ornekfirma.com.tr`;
  const l = epostalariCikar(html);
  assert.ok(l.includes(e) && l.includes('info@ornekfirma.com.tr') && l.includes('ik@ornekfirma.com.tr'));
  assert.ok(!l.some(x => /png|noreply|sentry|example/.test(x)));
  assert.equal(enIyiEposta(['ik@ornekfirma.com.tr', 'ahmet@gmail.com', 'info@ornekfirma.com.tr'], 'https://www.ornekfirma.com.tr'), 'info@ornekfirma.com.tr');
});

await test('Firma kimliği: kendi sitesi alan adıyla, sosyal medya sitesi sayılmaz', () => {
  assert.equal(firmaAnahtari({ web: 'https://www.abc.com.tr/tr', kimlik: 'g:1' }), 'web:abc.com.tr');
  assert.equal(firmaAnahtari({ web: 'https://instagram.com/abc', kimlik: 'g:1' }), 'g:1');
  assert.equal(kendiSitesi('https://www.trendyol.com/magaza/x'), false);
  assert.equal(ILLER.length, 81);
});

await test('Arama listesi: aktif illerde ilçe ilçe, diğerlerinde il geneli', () => {
  const l = aramaListesi(['Kocaeli', 'Bursa', 'Olmayanİl'], ['lojistik']);
  assert.equal(l.length, 12 * 4 + 4);
  assert.deepEqual(l[0], { il: 'Kocaeli', ilce: 'Başiskele', sektor: 'lojistik', arama: 'lojistik firması' });
  assert.equal(l.at(-1).ilce, '');
});

await test('Teklif ve takip metni; yasal not', () => {
  const filo = { ad: 'Marmara Kamyonet', yetkili: 'Aytaç', telefon: '0555 000 00 00', eposta: 'teklif@x.com', aracSayisi: 45, bolgeler: 'İstanbul, Kocaeli ve Tekirdağ', depolama: true };
  const t = taslakYap({ ad: 'ABC Gıda', sektor: 'toptan' }, filo);
  assert.match(t.konu, /ABC Gıda/);
  assert.match(t.metin, /45 kamyonetlik/);
  assert.match(t.metin, /Bayilerinize/);
  assert.match(t.metin, /depolama/);
  assert.match(t.metin, /0555 000 00 00 numarasını/);
  const tk = taslakYap({ ad: 'ABC Gıda', sektor: 'toptan', konu: t.konu }, filo, 'takip', '01.10.2026');
  assert.equal(tk.konu, 'Ynt: ' + t.konu);
  assert.match(tk.metin, /01\.10\.2026 tarihinde/);
  assert.match(yasalNot(filo, 'https://x/ret'), /https:\/\/x\/ret/);
  assert.ok(epostaGecerli('info@firma.com.tr') && !epostaGecerli('a b@c.com') && !epostaGecerli('x@y'));
});

await test('Site taraması: ana sayfada yoksa iletişim sayfasına bakar', async () => {
  const sayfalar = { 'https://abc.com.tr/': '<a href="/tr/iletisim">İletişim</a>', 'https://abc.com.tr/tr/iletisim': '<p>Mail: satis@abc.com.tr</p>' };
  const eski = globalThis.fetch, istenen = [];
  globalThis.fetch = async u => { istenen.push(u); return new Response(sayfalar[u] || '', { status: sayfalar[u] ? 200 : 404, headers: { 'content-type': 'text/html' } }); };
  try { assert.equal(await siteEpostasi('abc.com.tr'), 'satis@abc.com.tr'); assert.equal(istenen.length, 2); }
  finally { globalThis.fetch = eski; }
});

console.log(`\n${gecen} test geçti`);
