// Teklif e-postası gönderimi: SMTP (Gmail, Yandex, Outlook, Zoho… uygulama şifresiyle) ve MIME ileti oluşturma.
// Bağlantı fonksiyonu dışarıdan verilir (Worker'da cloudflare:sockets connect), böylece Node'da sahte soketle sınanır.
const enc = new TextEncoder(), dec = new TextDecoder();

export class EpostaHatasi extends Error {
  constructor(kod, mesaj, alici = false) { super(mesaj); this.kod = kod; this.alici = alici; }
}

function b64(metin) {
  let s = ''; for (const b of enc.encode(metin)) s += String.fromCharCode(b);
  return btoa(s);
}
// Başlıkta Türkçe karakter: =?UTF-8?B?…?= parçaları (her biri 75 karakteri aşmasın)
export function baslikKodla(metin) {
  metin = String(metin).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(metin)) return metin;
  const parcalar = []; let p = '';
  for (const c of metin) { if (enc.encode(p + c).length > 42) { parcalar.push(p); p = ''; } p += c; }
  if (p) parcalar.push(p);
  return parcalar.map(x => `=?UTF-8?B?${b64(x)}?=`).join('\r\n ');
}
const adres = a => String(a || '').trim().replace(/[\r\n<>]/g, '');
export const epostaGecerli = a => /^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(String(a || '')) && String(a).length <= 254;

export function mesajOlustur({ gonderen, gonderenAd, alici, konu, metin, cevapAdresi, retUrl, mesajId, oncekiId, tarih = new Date() }) {
  const satirlar = [
    `From: ${gonderenAd ? baslikKodla(gonderenAd) + ' ' : ''}<${adres(gonderen)}>`,
    `To: <${adres(alici)}>`,
    `Subject: ${baslikKodla(konu)}`,
    `Date: ${tarih.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${mesajId}>`,
    ...(oncekiId ? [`In-Reply-To: <${oncekiId}>`, `References: <${oncekiId}>`] : []),
    ...(cevapAdresi && cevapAdresi !== gonderen ? [`Reply-To: <${adres(cevapAdresi)}>`] : []),
    ...(retUrl ? [`List-Unsubscribe: <${retUrl}>, <mailto:${adres(cevapAdresi || gonderen)}?subject=CIKAR>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const govde = b64(String(metin).replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return satirlar.join('\r\n') + '\r\n\r\n' + govde;
}

// Çok satırlı SMTP yanıtlarını okur: "250-..." devam eder, "250 ..." biter
function okuyucu(soket) {
  const r = soket.readable.getReader(); let tampon = '';
  return {
    async yanit() {
      for (;;) {
        const satirlar = tampon.split('\r\n');
        for (let i = 0; i < satirlar.length - 1; i++) {
          if (/^\d{3} /.test(satirlar[i]) || /^\d{3}$/.test(satirlar[i])) {
            const metin = satirlar.slice(0, i + 1).join('\n');
            tampon = satirlar.slice(i + 1).join('\r\n');
            return { kod: +satirlar[i].slice(0, 3), metin };
          }
        }
        const { value, done } = await r.read();
        if (done) throw new EpostaHatasi('baglanti', 'Mail sunucusu bağlantıyı kapattı.');
        tampon += dec.decode(value, { stream: true });
      }
    },
    birak() { r.releaseLock(); },
  };
}

const HATA = {
  535: 'Mail girişi reddedildi: kullanıcı adı veya uygulama şifresi hatalı (Gmail\'de normal şifre değil, 16 haneli "uygulama şifresi" gerekir).',
  534: 'Mail girişi reddedildi: hesapta "uygulama şifresi" açılmalı (Google hesabı → Güvenlik → 2 adımlı doğrulama → Uygulama şifreleri).',
  530: 'Mail sunucusu giriş istiyor; kullanıcı adı/şifreyi kontrol edin.',
  421: 'Mail sunucusu şu an meşgul ya da günlük sınır doldu; daha sonra tekrar deneyin.',
  452: 'Mail hesabının gönderim sınırı doldu; yarın tekrar deneyin.',
  454: 'Mail sunucusu geçici olarak girişe izin vermiyor; biraz sonra tekrar deneyin.',
};

// ayar: {host, port, kullanici, sifre}; ileti: {gonderen, alici, veri}; baglan: (adres, secenek) => soket
export async function smtpGonder(ayar, ileti, baglan, sure = 25000) {
  let soket, zamanlayici;
  const zamanAsimi = new Promise((_, red) => { zamanlayici = setTimeout(() => red(new EpostaHatasi('zaman', 'Mail sunucusu zamanında yanıt vermedi.')), sure); });
  const is = (async () => {
    const port = +ayar.port || 465, tls = port === 465;
    soket = baglan({ hostname: ayar.host, port }, { secureTransport: tls ? 'on' : 'starttls', allowHalfOpen: false });
    let oku = okuyucu(soket), yaz = soket.writable.getWriter();
    const gonder = s => yaz.write(enc.encode(s + '\r\n'));
    const bekle = async (izinli, asama) => {
      const y = await oku.yanit();
      if (!izinli.includes(y.kod)) {
        const alici = asama === 'alici' && y.kod >= 500;
        throw new EpostaHatasi(String(y.kod), alici ? 'Alıcı adresi mail sunucusunca reddedildi (adres yok ya da kapalı).' : HATA[y.kod] || `Mail sunucusu hata verdi (${asama}: ${y.metin.slice(0, 160)})`, alici);
      }
      return y;
    };
    await bekle([220], 'karşılama');
    await gonder('EHLO rota-plani'); await bekle([250], 'EHLO');
    if (!tls) {
      await gonder('STARTTLS'); await bekle([220], 'STARTTLS');
      oku.birak(); yaz.releaseLock();
      soket = soket.startTls();
      oku = okuyucu(soket); yaz = soket.writable.getWriter();
      await gonder('EHLO rota-plani'); await bekle([250], 'EHLO');
    }
    await gonder('AUTH PLAIN ' + b64('\0' + ayar.kullanici + '\0' + ayar.sifre)); await bekle([235], 'giriş');
    await gonder(`MAIL FROM:<${adres(ileti.gonderen)}>`); await bekle([250], 'gönderen');
    await gonder(`RCPT TO:<${adres(ileti.alici)}>`); await bekle([250, 251], 'alici');
    await gonder('DATA'); await bekle([354], 'DATA');
    // satır başındaki nokta ikilenir (base64 gövdede olmaz ama başlıklar için güvenli)
    await yaz.write(enc.encode(ileti.veri.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n'));
    const y = await bekle([250], 'gönderim');
    await gonder('QUIT').catch(() => {});
    return y.metin;
  })();
  try { return await Promise.race([is, zamanAsimi]); }
  finally { clearTimeout(zamanlayici); try { soket?.close(); } catch { /* kapalı */ } }
}
