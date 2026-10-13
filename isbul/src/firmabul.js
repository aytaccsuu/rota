// İş bulma: firma arama (Google Places, OpenStreetMap), web sitesinden e-posta bulma, teklif metni.
import { epostaGecerli } from './eposta.js';

export const ILLER = ['Adana', 'Adıyaman', 'Afyonkarahisar', 'Ağrı', 'Aksaray', 'Amasya', 'Ankara', 'Antalya', 'Ardahan', 'Artvin', 'Aydın', 'Balıkesir', 'Bartın', 'Batman', 'Bayburt', 'Bilecik', 'Bingöl', 'Bitlis', 'Bolu', 'Burdur', 'Bursa', 'Çanakkale', 'Çankırı', 'Çorum', 'Denizli', 'Diyarbakır', 'Düzce', 'Edirne', 'Elazığ', 'Erzincan', 'Erzurum', 'Eskişehir', 'Gaziantep', 'Giresun', 'Gümüşhane', 'Hakkari', 'Hatay', 'Iğdır', 'Isparta', 'İstanbul', 'İzmir', 'Kahramanmaraş', 'Karabük', 'Karaman', 'Kars', 'Kastamonu', 'Kayseri', 'Kilis', 'Kırıkkale', 'Kırklareli', 'Kırşehir', 'Kocaeli', 'Konya', 'Kütahya', 'Malatya', 'Manisa', 'Mardin', 'Mersin', 'Muğla', 'Muş', 'Nevşehir', 'Niğde', 'Ordu', 'Osmaniye', 'Rize', 'Sakarya', 'Samsun', 'Şanlıurfa', 'Siirt', 'Sinop', 'Şırnak', 'Sivas', 'Tekirdağ', 'Tokat', 'Trabzon', 'Tunceli', 'Uşak', 'Van', 'Yalova', 'Yozgat', 'Zonguldak'];

// Aktif çalışılan illerde arama ilçe ilçe yapılır (Google tek aramada en çok 60 firma döndürür)
export const ILCELER = {
  'İstanbul': ['Arnavutköy', 'Ataşehir', 'Avcılar', 'Bağcılar', 'Bahçelievler', 'Bakırköy', 'Başakşehir', 'Bayrampaşa', 'Beşiktaş', 'Beykoz', 'Beylikdüzü', 'Beyoğlu', 'Büyükçekmece', 'Çatalca', 'Çekmeköy', 'Esenler', 'Esenyurt', 'Eyüpsultan', 'Fatih', 'Gaziosmanpaşa', 'Güngören', 'Kadıköy', 'Kağıthane', 'Kartal', 'Küçükçekmece', 'Maltepe', 'Pendik', 'Sancaktepe', 'Sarıyer', 'Silivri', 'Sultanbeyli', 'Sultangazi', 'Şile', 'Şişli', 'Tuzla', 'Ümraniye', 'Üsküdar', 'Zeytinburnu'],
  'Kocaeli': ['Başiskele', 'Çayırova', 'Darıca', 'Derince', 'Dilovası', 'Gebze', 'Gölcük', 'İzmit', 'Kandıra', 'Karamürsel', 'Kartepe', 'Körfez'],
  'Tekirdağ': ['Çerkezköy', 'Çorlu', 'Ergene', 'Hayrabolu', 'Kapaklı', 'Malkara', 'Marmaraereğlisi', 'Muratlı', 'Saray', 'Süleymanpaşa', 'Şarköy'],
};

export const SEKTORLER = {
  eticaret: {
    ad: 'E-ticaret / online satıcı',
    aramalar: ['e-ticaret firması', 'online satış deposu', 'e-ticaret deposu'],
    osm: [],
    cumle: 'E-ticaret siparişlerinizi deponuzdan alıp aynı gün ya da ertesi gün müşterilerinize teslim edebiliriz. Kargo firmalarına göre daha hızlı, ürüne özenli çalışıyor; iade ve değişim ürünlerini de topluyoruz.',
  },
  toptan: {
    ad: 'Toptancı / dağıtıcı',
    aramalar: ['gıda toptancısı', 'içecek dağıtım firması', 'temizlik malzemeleri toptan', 'ambalaj toptan', 'kırtasiye toptan', 'yapı malzemeleri toptan'],
    osm: ['["shop"="wholesale"]'],
    cumle: 'Bayilerinize, marketlere ve işletmelere yaptığınız dağıtımı düzenli rotalarla, her gün aynı araç ve şoförle üstlenebiliriz.',
  },
  uretici: {
    ad: 'Üretici / fabrika',
    aramalar: ['gıda üretim firması', 'tekstil üretim firması', 'ambalaj fabrikası', 'kozmetik üretici', 'plastik imalat'],
    osm: ['["man_made"="works"]', '["industrial"="factory"]'],
    cumle: 'Fabrikanızdan bayilerinize, depolara ve müşterilerinize ürün sevkiyatını düzenli ya da sipariş bazlı yapabiliriz.',
  },
  mobilya: {
    ad: 'Mobilya / beyaz eşya / mağaza',
    aramalar: ['mobilya mağazası', 'beyaz eşya bayi', 'yatak mağazası', 'elektronik mağazası', 'yapı market'],
    osm: ['["shop"~"^(furniture|appliance|bed|kitchen|electronics|doityourself)$"]'],
    cumle: 'Mağazanızdan müşterilerinizin adresine teslimatı, gerekirse kat çıkarmayla, özenle yapabiliriz.',
  },
  lojistik: {
    ad: 'Lojistik / depo / kargo',
    aramalar: ['lojistik firması', 'depolama hizmetleri', 'nakliye firması', 'kargo şubesi'],
    osm: ['["office"="logistics"]', '["office"="moving_company"]', '["industrial"="warehouse"]'],
    cumle: 'Yoğun dönemlerde ya da sürekli olarak taşeron kamyonet ve şoför ihtiyacınızı karşılayabiliriz; ekibimiz rota planlama ve teslim takibiyle çalışıyor.',
  },
};

// Otomatik taramanın sıradaki aramaları: il × ilçe × sektör araması (imleç döndükçe hepsi gezilir)
export function aramaListesi(iller, sektorler) {
  const out = [];
  for (const il of iller.filter(i => ILLER.includes(i))) {
    for (const ilce of ILCELER[il] || ['']) {
      for (const s of sektorler.filter(s => SEKTORLER[s])) for (const a of SEKTORLER[s].aramalar) out.push({ il, ilce, sektor: s, arama: a });
    }
  }
  return out;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
export class FirmaHatasi extends Error { constructor(status, mesaj) { super(mesaj); this.status = status; } }

export function alanAdi(web) {
  try { return new URL(/^https?:\/\//i.test(web) ? web : 'https://' + web).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
// Sosyal medya / pazar yeri sayfası firmanın kendi sitesi değildir
const YABANCI_SITE = /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|tiktok|trendyol|hepsiburada|n11|sahibinden|google|sites\.google|wa|whatsapp|linktr|business\.site)\.(com|me|ee|com\.tr)$/;
export const kendiSitesi = web => { const d = alanAdi(web); return !!d && !YABANCI_SITE.test(d); };

export function firmaAnahtari(f) {
  const d = f.web && kendiSitesi(f.web) ? alanAdi(f.web) : '';
  return d ? 'web:' + d : f.kimlik;
}

// ---------- Google Places (New) Text Search ----------
export async function googleFirmaAra(sorgu, key, sayfa = '') {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.businessStatus,nextPageToken' },
    body: JSON.stringify({ textQuery: sorgu, languageCode: 'tr', regionCode: 'TR', pageSize: 20, ...(sayfa ? { pageToken: sayfa } : {}) }),
  });
  if (!r.ok) throw new FirmaHatasi(r.status, [401, 403].includes(r.status) ? 'Google anahtarı reddedildi: Places API (New) açık ve faturalandırma etkin olmalı.' : r.status === 429 ? 'Google arama kotası doldu.' : 'Google araması hata verdi.');
  const j = await r.json();
  const firmalar = (j.places || []).filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY').map(p => ({
    kimlik: 'g:' + p.id, ad: p.displayName?.text || '', adres: p.formattedAddress || '', telefon: p.nationalPhoneNumber || '', web: p.websiteUri || '', eposta: '', kaynak: 'Google',
  })).filter(f => f.ad);
  return { firmalar, sonraki: j.nextPageToken || '' };
}

// ---------- OpenStreetMap (ücretsiz): e-postası ya da sitesi kayıtlı işletmeler ----------
export async function osmFirmaAra(il, sektor) {
  const filtreler = SEKTORLER[sektor]?.osm || [];
  if (!filtreler.length) return [];
  const parca = filtreler.flatMap(f => ['email', 'contact:email', 'website', 'contact:website'].map(t => `nwr(area.a)${f}["${t}"];`)).join('');
  const q = `[out:json][timeout:25];area["name"="${il.replace(/"/g, '')}"]["boundary"="administrative"]["admin_level"="4"]->.a;(${parca});out tags 150;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RotaPlan/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new FirmaHatasi(r.status, 'OpenStreetMap araması şu an yanıt vermiyor.');
  return ((await r.json()).elements || []).map(e => {
    const t = e.tags || {};
    const eposta = String(t.email || t['contact:email'] || '').split(/[;,\s]/)[0].toLowerCase();
    return {
      kimlik: `osm:${e.type}/${e.id}`, ad: t.name || t.brand || '', telefon: t.phone || t['contact:phone'] || '', web: t.website || t['contact:website'] || '',
      adres: [t['addr:street'], t['addr:housenumber'], t['addr:district'] || t['addr:suburb'], t['addr:city']].filter(Boolean).join(' '),
      eposta: epostaGecerli(eposta) ? eposta : '', kaynak: 'OpenStreetMap',
    };
  }).filter(f => f.ad);
}

// ---------- web sitesinden e-posta ----------
const SAHTE_ALAN = /(^|\.)(example\.(com|org)|domain\.com|email\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|godaddy\.com|yourdomain\.com|sitename\.com|mail\.com\.tr|ornek\.com|firma\.com|siteadi\.com)$/;
const DOSYA_UZANTI = /\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?|ttf|pdf|mp4)$/i;
function cfCoz(hexMetin) { // Cloudflare e-posta gizleme (data-cfemail)
  try { const k = parseInt(hexMetin.slice(0, 2), 16); let s = ''; for (let i = 2; i < hexMetin.length; i += 2) s += String.fromCharCode(parseInt(hexMetin.slice(i, i + 2), 16) ^ k); return s; } catch { return ''; }
}
export function epostalariCikar(html) {
  let m = String(html).slice(0, 600000);
  const cf = [...m.matchAll(/data-cfemail="([0-9a-f]{6,})"/gi)].map(x => cfCoz(x[1]));
  cf.push(...[...m.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]{6,})/gi)].map(x => cfCoz(x[1])));
  m = m.replace(/&#0*64;|&#x0*40;|%40|&commat;/gi, '@').replace(/\s*[[(]\s*(at|et)\s*[\])]\s*/gi, '@').replace(/\s*[[(]\s*(dot|nokta)\s*[\])]\s*/gi, '.');
  const bul = [...m.matchAll(/[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi)].map(x => x[0]);
  const out = new Set();
  for (let e of [...cf, ...bul]) {
    e = e.toLowerCase().replace(/^(mailto:|u003e|x3e)/, '').replace(/\.+$/, '');
    const [yerel, alan] = e.split('@');
    if (!alan || DOSYA_UZANTI.test(e) || SAHTE_ALAN.test(alan) || /^(no-?reply|noreply|donotreply|mailer-daemon|postmaster|abuse|webmaster|user|name|isim|adiniz|email|eposta|your|test)$/.test(yerel) || /^[0-9a-f]{24,}$/.test(yerel) || !epostaGecerli(e)) continue;
    out.add(e);
  }
  return [...out];
}
// Aynı alan adındaki ve satış/iletişim adresleri öne alınır; İK, KVKK, muhasebe geriye
export function enIyiEposta(liste, web) {
  const d = alanAdi(web || '');
  const puan = e => {
    const [yerel, alan] = e.split('@'); let p = 0;
    if (d && (alan === d || alan.endsWith('.' + d) || d.endsWith('.' + alan))) p += 4;
    if (/^(info|bilgi|iletisim|contact|satis|sales|siparis|lojistik|operasyon|depo|sevkiyat|merhaba|hello)\b/.test(yerel)) p += 3;
    if (/^(ik|hr|insankaynaklari|kariyer|career|cv|is|jobs|kvkk|privacy|gizlilik|muhasebe|finans|fatura|destek|support)\b/.test(yerel)) p -= 3;
    return p;
  };
  return [...liste].sort((a, b) => puan(b) - puan(a))[0] || '';
}
async function sayfaAl(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'tr' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!r.ok || !/html|text/i.test(r.headers.get('content-type') || 'text/html')) return '';
  return (await r.text()).slice(0, 600000);
}
// En çok 4 sayfa: ana sayfa, ana sayfadaki iletişim bağlantıları, /iletisim, /contact
export async function siteEpostasi(web, enCok = 4) {
  if (!kendiSitesi(web)) return '';
  const kok = new URL(/^https?:\/\//i.test(web) ? web : 'https://' + web);
  const adaylar = [kok.href], gezilen = new Set(); let bulunan = [];
  for (let i = 0; i < adaylar.length && gezilen.size < enCok; i++) {
    const u = adaylar[i]; if (gezilen.has(u)) continue; gezilen.add(u);
    let html = ''; try { html = await sayfaAl(u); } catch { if (i === 0) return ''; continue; }
    bulunan = epostalariCikar(html);
    if (bulunan.length) break;
    if (i === 0) {
      for (const x of html.matchAll(/href="([^"#]*(?:iletisim|iletişim|contact|bize-ulasin|bize-ulaşın|ulasim|kurumsal|hakkimizda|about)[^"#]*)"/gi)) {
        try { const v = new URL(x[1], u); if (v.hostname === new URL(u).hostname || alanAdi(v.href) === alanAdi(u)) adaylar.push(v.href); } catch { /* geçersiz bağlantı */ }
      }
      for (const p of ['/iletisim', '/contact', '/iletisim.html']) adaylar.push(new URL(p, kok).href);
    }
  }
  return enIyiEposta(bulunan, web);
}

// ---------- teklif metni ----------
const ad = f => String(f.ad || '').replace(/\s+/g, ' ').trim();
export function taslakYap(firma, filo, tur = 'ilk', oncekiTarih = '') {
  const s = SEKTORLER[firma.sektor] || SEKTORLER.toptan;
  const bolge = filo.bolgeler || 'İstanbul, Kocaeli ve Tekirdağ';
  const arac = +filo.aracSayisi ? `${+filo.aracSayisi} kamyonetlik` : 'geniş bir kamyonet';
  const imza = [filo.yetkili, filo.ad, [filo.telefon, filo.eposta].filter(Boolean).join(' · '), filo.web].filter(Boolean).join('\n');
  if (tur === 'takip') {
    return {
      konu: 'Ynt: ' + (firma.konu || `${ad(firma)} için dağıtım ve sevkiyat desteği`).replace(/^(Ynt|Re):\s*/i, ''),
      metin: `Merhaba,

${oncekiTarih ? oncekiTarih + ' tarihinde' : 'Geçen hafta'} ${ad(firma)} için kamyonetle dağıtım ve sevkiyat desteğimizle ilgili bir mail göndermiştik.

Gündeminizde böyle bir ihtiyaç varsa, müsait olduğunuz bir gün ve saati yazmanız yeterli; kısa bir görüşmeyle size özel fiyat çıkaralım. Şu an ihtiyacınız yoksa da bildirmeniz yeterli, tekrar yazmayız.

İyi çalışmalar,
${imza}`,
    };
  }
  return {
    konu: `${ad(firma)} için dağıtım ve sevkiyat desteği`,
    metin: `Merhaba ${ad(firma)} ekibi,

Biz ${bolge} bölgesinde çalışan, ${arac} bir dağıtım ekibiyiz. ${s.cumle}

Sunabileceklerimiz:
• Günlük ya da haftalık düzenli dağıtım rotaları (bayi, mağaza, müşteri adresi)
• Aynı gün teslimat ve acil sevkiyat
• Depodan yükleme, rota planlama, teslim takibi ve teslim fotoğrafı${filo.depolama ? '\n• İhtiyaç olursa depolama ve sipariş hazırlama' : ''}
• Size özel araç ve şoför (aylık sabit çalışma)

Fiyatı sefer, teslimat noktası ya da aylık sabit olarak çıkarabiliyoruz. Uygunsanız 10 dakikalık bir görüşmede ihtiyacınızı dinleyip size özel teklif hazırlayalım. Bu maile cevap vermeniz${filo.telefon ? ' ya da ' + filo.telefon + ' numarasını aramanız' : ''} yeterli.

Saygılarımızla,
${imza}`,
  };
}
// Yasal not (6563 sayılı Kanun: gönderen kimliği ve ret yolu) gönderim anında eklenir
export function yasalNot(filo, retUrl) {
  const kim = [filo.unvan || filo.ad, filo.adres, filo.telefon].filter(Boolean).join(' · ');
  return `\n\n--\nBu ileti ${kim ? kim + ' tarafından ' : ''}işletmenize ticari tanıtım amacıyla gönderilmiştir. Almak istemiyorsanız: ${retUrl}\n(ya da bu maile "ÇIKAR" yazarak cevap verin; bir daha yazmayız.)`;
}
