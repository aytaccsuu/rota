// Evrak fotoğrafı okuma ve adres düzeltme: önce Google Gemini, kotası/erişimi yoksa Cloudflare Workers AI
import * as depo from './depo.js';

const MODELLER = env => String(env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map(x => x.trim()).filter(Boolean);
const URL_ = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const AI_GORSEL = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.2-11b-vision-instruct'];
const AI_METIN = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class OkumaHatasi extends Error { constructor(mesaj, code = 'upstream') { super(mesaj); this.code = code; } }

export const PROMPT = `Bu fotoğraf bir kargo dağıtım evrakı (tablo). Fotoğraf yan dönmüş, eğik veya katlanmış olabilir.
Tablodaki HER teslimat satırını oku ve şemaya göre döndür.

Kurallar:
- Metni kağıtta yazdığı gibi aktar; tahmin etme, uydurma, düzeltme yapma. Okunamayan kısmı boş bırak.
- Bir hücre birden fazla satıra yayılmışsa (ör. uzun adres veya "Esra Kutsal / (2 parça teslim olsun)") satırları doğru sırayla tek metinde birleştir.
- Alıcı hücresinde parantez içindeki notları (ör. "2 parça teslim olsun") "not" alanına koy; "alici" sadece kişi/mağaza adı olsun.
- Mağaza kodu (ör. "TUR.Ist.GS.mll.METROGARDEN.I") alıcı adıdır, aynen yaz.
- "adres" sütununun tamamını al: mahalle, sokak/cadde, apartman, no, kat, daire dahil.
- Kalemle sonradan yazılmış sıra numaralarını, imzaları ve başlık satırını alma.
- "GERİ ALIM" yazan satırlarda geri_alim true olsun.
- Aynı satırı iki kez yazma.
- Yanıtı yalnızca JSON olarak ver, açıklama yazma.`;

const SATIR = { type: 'object', properties: { musteri: { type: 'string' }, siparis_no: { type: 'string' }, alici: { type: 'string' }, not: { type: 'string' }, adet: { type: 'string' }, ilce: { type: 'string' }, adres: { type: 'string' }, geri_alim: { type: 'boolean' } }, required: ['musteri', 'siparis_no', 'alici', 'not', 'adet', 'ilce', 'adres', 'geri_alim'] };
export const SCHEMA = { type: 'object', properties: { rows: { type: 'array', items: SATIR } }, required: ['rows'] };

export const DUZELT_PROMPT = `Aşağıda İstanbul'daki teslimat adresleri var (fotoğraftan okunmuş, yazım hataları olabilir).
Her adres için şemaya göre alanları doldur.

Kurallar:
- Yalnızca BARİZ okuma/yazım hatalarını düzelt: "Solak"→"Sokak", "lat 9"→"kat 9", "Dalre"→"Daire",
  bilinen sokak/mahalle adındaki tek harf hataları (ör. "Tünelc Sok."→"Tünek Sokak"). Emin değilsen olduğu gibi bırak.
- Adreste olmayan sokak, numara veya mahalle UYDURMA. Yoksa boş bırak.
- sokak: kapı numarasının ait olduğu yol, tam adıyla ("Tepegöz Sokak", "Bağdat Caddesi"). Adreste birden çok yol varsa
  (ör. "Çetin Emeç Bulvarı Su yanı Sokak ... No:7") numaradan hemen önce yazılan yolu seç ("Su Yanı Sokak").
- sokak_adaylari: sokak adı okunurken bozulmuş olabilirse (ör. "Tünelc Sok.") en olası doğru yazımlar, en fazla 3
  ("Tünek Sokak"). Adreste başka bir yol daha yazıyorsa onu da ekle. Emin olduğun adlarda boş liste.
- mahalle: sadece adı ("Göztepe"), "Mahallesi" yazma. Adreste birden çok mahalle geçiyorsa sokağın bağlı olduğunu seç.
- kapi_no: bina kapı numarası, yazıldığı gibi ("49/21", "4-6", "12A"). "No:334", "No 334", "no334", "N:334", "Nu 334",
  "numara 334" ya da "No" yazılmadan sokaktan hemen sonra gelen "334" hepsi kapı numarasıdır → "334". Daire/kat numarası kapı no değildir.
- daire, kat: varsa.
- bina: apartman/site/plaza/AVM adı varsa ("Utku Apt.", "Kozzy AVM").
- duzeltmeler: yaptığın her düzeltmeyi "eski → yeni" biçiminde yaz; düzeltme yoksa boş liste.
- Yanıtı yalnızca JSON olarak ver, açıklama yazma.
`;
const KALEM = { type: 'object', properties: { id: { type: 'string' }, mahalle: { type: 'string' }, sokak: { type: 'string' }, sokak_adaylari: { type: 'array', items: { type: 'string' } }, kapi_no: { type: 'string' }, daire: { type: 'string' }, kat: { type: 'string' }, bina: { type: 'string' }, ilce: { type: 'string' }, duzeltmeler: { type: 'array', items: { type: 'string' } } }, required: ['id', 'mahalle', 'sokak', 'sokak_adaylari', 'kapi_no', 'daire', 'kat', 'bina', 'ilce', 'duzeltmeler'] };
export const DUZELT_SCHEMA = { type: 'object', properties: { items: { type: 'array', items: KALEM } }, required: ['items'] };

function* metinler(node) {
  if (Array.isArray(node)) { for (const v of node) yield* metinler(v); return; }
  if (node && typeof node === 'object') {
    if (typeof node.text === 'string' && (node.type ?? 'text') === 'text' && !node.thought) yield node.text;
    for (const [k, v] of Object.entries(node)) if (k !== 'text') yield* metinler(v);
  }
}

export function gevsekJson(metin, anahtar) {
  if (metin && typeof metin === 'object') return listeAl(metin, anahtar);
  let t = String(metin || '').trim();
  if (t.startsWith('```')) { t = t.includes('\n') ? t.split('\n').slice(1).join('\n') : t.slice(3); t = t.slice(0, t.lastIndexOf('```') >= 0 ? t.lastIndexOf('```') : undefined); }
  // açıklama eklenmişse ilk { / [ ile son } / ] arası
  const ilk = Math.min(...['{', '['].map(c => t.indexOf(c)).filter(i => i >= 0));
  const son = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (Number.isFinite(ilk) && son > ilk) t = t.slice(ilk, son + 1);
  return listeAl(JSON.parse(t), anahtar);
}
function listeAl(data, anahtar) {
  if (data && !Array.isArray(data) && typeof data === 'object') data = data[anahtar] || Object.values(data).find(Array.isArray);
  if (!Array.isArray(data)) throw new Error('liste yok');
  return data;
}

// Bugün kotası dolan Gemini modelleri atlanır (gereksiz bekleme olmasın)
const bugun = () => new Date().toISOString().slice(0, 10);
async function doluModeller(env) { try { return new Set(JSON.parse(await depo.ayarOku(env, 'gemini_kota:' + bugun()) || '[]')); } catch { return new Set(); } }
async function doluIsaretle(env, model) { try { const s = await doluModeller(env); s.add(model); await depo.ayarYaz(env, 'gemini_kota:' + bugun(), JSON.stringify([...s])); } catch { /* yok say */ } }

async function geminiPost(body, key) {
  for (let deneme = 0; deneme < 2; deneme++) {
    const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (r.ok) return r.json();
    if (![500, 502, 503, 504].includes(r.status) || deneme === 1) { const e = new Error('gemini ' + r.status); e.status = r.status; throw e; }
    await new Promise(res => setTimeout(res, 2000));
  }
}

async function uret(env, parts, schema, key) {
  let son = null;
  const dolu = await doluModeller(env);
  for (const model of MODELLER(env).filter(m => !dolu.has(m))) {
    const body = { model, input: parts, response_format: { type: 'text', mime_type: 'application/json', schema }, generation_config: { thinking_level: 'low' } };
    try {
      let data;
      try { data = await geminiPost(body, key); } catch (e) { if (e.status !== 400) throw e; delete body.generation_config; data = await geminiPost(body, key); }
      return [...metinler(data.steps || data.outputs || data)].join('');
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new OkumaHatasi('Gemini anahtarı reddedildi. Anahtarı kontrol edin.', 'auth');
      if (e.status === 429) await doluIsaretle(env, model);
      son = e;
    }
  }
  if (!son || son.status === 429) throw new OkumaHatasi('Gemini ücretsiz kullanım sınırı bütün modellerde doldu.', 'quota');
  throw new OkumaHatasi(`Gemini şu an yanıt vermiyor (${son.status || son.name}).`);
}

const ALIAS = { siparis_no: ['siparis_no', 'siparis_numarasi', 'siparisNo', 'siparis'], geri_alim: ['geri_alim', 'geriAlim'] };
const alan = (r, k) => { for (const a of ALIAS[k] || [k]) if (r[a] !== undefined && r[a] !== null && r[a] !== '') return r[a]; return ''; };
function satirlariTemizle(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = Object.fromEntries(['musteri', 'siparis_no', 'alici', 'not', 'adet', 'ilce', 'adres'].map(k => [k, String(alan(r, k) ?? '').trim()]));
    row.geri_alim = [true, 'true', 'True', 'evet'].includes(alan(r, 'geri_alim'));
    if (row.adres.length >= 6) out.push(row);
  }
  return out;
}

// Workers AI: görselden tablo okuma (Gemini yedeği)
async function aiOku(env, b64, mime) {
  const talimat = PROMPT + '\nYanıt biçimi: {"rows":[{"musteri":"","siparis_no":"","alici":"","not":"","adet":"","ilce":"","adres":"","geri_alim":false}]}';
  let son = null;
  for (const model of AI_GORSEL) {
    try {
      let r;
      if (model.includes('llama-4')) {
        r = await env.AI.run(model, { messages: [{ role: 'user', content: [{ type: 'text', text: talimat }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }], max_tokens: 6000 });
      } else {
        const image = [...Uint8Array.from(atob(b64), c => c.charCodeAt(0))];
        try { r = await env.AI.run(model, { prompt: talimat, image, max_tokens: 4000 }); }
        catch (e) { if (!/agree/i.test(String(e?.message))) throw e; await env.AI.run(model, { prompt: 'agree' }); r = await env.AI.run(model, { prompt: talimat, image, max_tokens: 4000 }); }
      }
      return satirlariTemizle(gevsekJson(r.response ?? r, 'rows'));
    } catch (e) { son = e; }
  }
  throw new OkumaHatasi('Yedek okuyucu (Workers AI) da okuyamadı: ' + (son?.message || 'hata'));
}

export async function evrakOku(env, b64, mime, key) {
  let geminiHata = null;
  if (key) {
    try {
      const metin = await uret(env, [{ type: 'text', text: PROMPT }, { type: 'image', data: b64, mime_type: mime, resolution: 'ultra_high' }], SCHEMA, key);
      return { rows: satirlariTemizle(gevsekJson(metin, 'rows')), kaynak: 'Gemini' };
    } catch (e) {
      if (e instanceof OkumaHatasi && e.code === 'auth') throw e;
      geminiHata = e;
    }
  }
  if (env.AI) return { rows: await aiOku(env, b64, mime), kaynak: 'Workers AI', not: geminiHata ? 'Gemini kullanılamadı; yedek okuyucu kullanıldı.' : undefined };
  if (geminiHata) throw geminiHata instanceof OkumaHatasi ? geminiHata : new OkumaHatasi('Gemini yanıtı anlaşılamadı.', 'response');
  throw new OkumaHatasi('Fotoğraf okuma için Ayarlar’dan Gemini anahtarı ekleyin.', 'missing_key');
}

function kalemleriTemizle(out, ids) {
  const clean = [];
  for (const r of out) {
    if (!r || typeof r !== 'object' || !ids.has(String(r.id))) continue;
    const row = Object.fromEntries(['id', 'mahalle', 'sokak', 'kapi_no', 'daire', 'kat', 'bina', 'ilce'].map(k => [k, String(r[k] ?? '').trim()]));
    row.duzeltmeler = (r.duzeltmeler || []).filter(Boolean).map(String).slice(0, 10);
    row.sokak_adaylari = (r.sokak_adaylari || []).filter(Boolean).map(x => String(x).trim()).slice(0, 3);
    clean.push(row);
  }
  return clean;
}

export async function adresDuzelt(env, items, key) {
  const liste = items.map(i => `[${i.id}] ${i.adres} (ilçe: ${i.ilce || ''})`).join('\n');
  const ids = new Set(items.map(i => String(i.id)));
  let geminiHata = null;
  if (key) {
    try { return kalemleriTemizle(gevsekJson(await uret(env, [{ type: 'text', text: DUZELT_PROMPT + '\nAdresler:\n' + liste }], DUZELT_SCHEMA, key), 'items'), ids); }
    catch (e) { if (e instanceof OkumaHatasi && e.code === 'auth') throw e; geminiHata = e; }
  }
  if (env.AI) {
    try {
      const r = await env.AI.run(AI_METIN, { messages: [{ role: 'system', content: DUZELT_PROMPT }, { role: 'user', content: 'Adresler:\n' + liste }], response_format: { type: 'json_schema', json_schema: DUZELT_SCHEMA }, max_tokens: 4000 });
      return kalemleriTemizle(gevsekJson(r.response ?? r, 'items'), ids);
    } catch (e) { throw new OkumaHatasi('Adres düzeltme yapılamadı: ' + (e?.message || 'hata')); }
  }
  if (geminiHata) throw geminiHata instanceof OkumaHatasi ? geminiHata : new OkumaHatasi('Gemini yanıtı anlaşılamadı.', 'response');
  throw new OkumaHatasi('Adres düzeltme için Gemini anahtarı gerekli.', 'missing_key');
}
