// Kullanıcılar, yönetici, oturum çerezi ve şifre özeti (Python sürümüyle aynı biçimler)
import { hex, esit, b64UrlKodla, b64UrlCoz } from './ortak.js';
import * as depo from './depo.js';

export const SESSION_DAYS = 30;
export const COOKIE = 'rota_oturum';
const YENI_TUR = 20000; // yeni şifre özetleri: Workers ücretsiz planındaki işlem süresi sınırına uygun
const enc = new TextEncoder();

export function kullanicilariAyir(metin = '') {
  const users = {};
  for (const parca of metin.replace(/;/g, ',').split(',')) {
    const i = parca.indexOf(':');
    if (i < 0) continue;
    const ad = parca.slice(0, i).trim().toLowerCase(), sifre = parca.slice(i + 1);
    if (ad && sifre) users[ad] = sifre;
  }
  return users;
}

export const ortamKullanicilari = env => kullanicilariAyir(env.ROTA_KULLANICILAR || '');
export const girisAcik = env => Object.keys(ortamKullanicilari(env)).length > 0 || !!env.ROTA_SIFRE;

export function yoneticiler(env) {
  const users = Object.keys(ortamKullanicilari(env));
  const ortam = new Set(String(env.ROTA_YONETICI || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  if (ortam.size) return ortam;
  const varsayilan = ['aytac', 'aytaç'].filter(x => users.includes(x));
  return new Set(varsayilan.length ? varsayilan : users.slice(0, 1));
}
// tek şifreli eski kurulumda (kullanıcı listesi yok) herkes yöneticidir
export const yoneticiMi = (env, ad) => !Object.keys(ortamKullanicilari(env)).length || yoneticiler(env).has(ad || '');

// Yöneticinin eklediği kullanıcılar (30 sn önbellek)
let dbOnbellek = { t: 0, v: {} };
export async function dbKullanicilari(env, taze = false) {
  if (taze || Date.now() - dbOnbellek.t > 30000) {
    try { dbOnbellek = { t: Date.now(), v: await depo.kullanicilariListele(env) }; } catch { /* son bilinen liste */ }
  }
  return dbOnbellek.v;
}

async function surum(env, ad) {
  if (ortamKullanicilari(env)[ad]) return '';
  const k = (await dbKullanicilari(env))[ad];
  return k ? k.sifre.slice(-8) : null;
}

async function gizli(env) {
  const metin = env.ROTA_GIZLI || hex(await crypto.subtle.digest('SHA-256', enc.encode('rota|' + (env.ROTA_KULLANICILAR || '') + '|' + (env.ROTA_SIFRE || ''))));
  return crypto.subtle.importKey('raw', enc.encode(metin), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
const imza = async (env, govde) => hex(await crypto.subtle.sign('HMAC', await gizli(env), enc.encode(govde)));

export async function jetonYap(env, ad, simdi = Date.now() / 1000) {
  let govde = `${ad}|${Math.floor(simdi + SESSION_DAYS * 86400)}`;
  const v = Object.keys(ortamKullanicilari(env)).length ? await surum(env, ad) : '';
  if (v) govde += '|' + v;
  return b64UrlKodla(`${govde}|${await imza(env, govde)}`);
}

export async function jetonOku(env, jeton, simdi = Date.now() / 1000) {
  try {
    const metin = b64UrlCoz(jeton), i = metin.lastIndexOf('|');
    const govde = metin.slice(0, i), sig = metin.slice(i + 1);
    if (!esit(sig, await imza(env, govde))) return null;
    const p = govde.split('|');
    const [ad, exp, v] = p.length <= 3 ? [p[0], p[1], p[2] || ''] : [p.slice(0, -2).join('|'), p[p.length - 2], p[p.length - 1]];
    if (!(+exp >= simdi)) return null;
    if (Object.keys(ortamKullanicilari(env)).length && (await surum(env, ad)) !== v) return null; // silinmiş / şifresi değişmiş
    return ad;
  } catch { return null; }
}

async function pbkdf2(sifre, tuz, tur) {
  const anahtar = await crypto.subtle.importKey('raw', enc.encode(sifre), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(tuz), iterations: tur }, anahtar, 256));
}
export async function sifreOzeti(sifre, tur = YENI_TUR) {
  const tuz = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${tur}$${tuz}$${await pbkdf2(sifre, tuz, tur)}`;
}
export async function sifreDogru(sifre, kayit) {
  try {
    const [, tur, tuz, ozet] = String(kayit).split('$');
    return esit(await pbkdf2(sifre, tuz, +tur), ozet);
  } catch { return false; }
}

export async function girisKontrol(env, ad, sifre) {
  ad = String(ad || '').trim().toLowerCase();
  const users = ortamKullanicilari(env);
  if (Object.keys(users).length) {
    if (users[ad]) return esit(sifre, users[ad]);
    const k = (await dbKullanicilari(env, true))[ad];
    if (!k || !(await sifreDogru(sifre, k.sifre))) return false;
    // eski (yüksek turlu) özet: işlem süresi sınırı için yeni özetle değiştir
    if (+k.sifre.split('$')[1] > YENI_TUR) { await depo.kullaniciKaydet(env, ad, await sifreOzeti(sifre)); await dbKullanicilari(env, true); }
    return true;
  }
  return !!env.ROTA_SIFRE && !!ad && esit(sifre, env.ROTA_SIFRE);
}

export function cerez(request, deger, sure) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${deger}; Path=/; Max-Age=${sure}; HttpOnly; SameSite=Lax${secure}`;
}

export async function oturumKullanicisi(env, request) {
  if (!girisAcik(env)) return 'yerel';
  for (const parca of (request.headers.get('Cookie') || '').split(';')) {
    const i = parca.indexOf('='), k = parca.slice(0, i).trim(), v = parca.slice(i + 1).trim();
    if (k === COOKIE && v) return jetonOku(env, v);
  }
  return null;
}

// 5 hatalı denemede 5 dk kilit (Worker örneği başına)
const HATALAR = new Map();
export function kilitliMi(ip) { const [, bitis] = HATALAR.get(ip) || [0, 0]; return bitis > Date.now(); }
export function hataSay(ip) {
  const [sayi] = HATALAR.get(ip) || [0, 0];
  const yeni = sayi + 1;
  HATALAR.set(ip, yeni >= 5 ? [0, Date.now() + 300000] : [yeni, 0]);
  return yeni >= 5;
}
export const hataSil = ip => HATALAR.delete(ip);
