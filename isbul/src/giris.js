// Tek şifreyle giriş (ISBUL_SIFRE). Oturum çerezi 30 gün, şifre değişince geçersiz olur.
import { hex, esit } from './ortak.js';

const enc = new TextEncoder(), GUN = 30, COOKIE = 'isbul_oturum';
async function anahtar(env) {
  const gizli = (env.ISBUL_GIZLI || '') + '|' + (env.ISBUL_SIFRE || '');
  return crypto.subtle.importKey('raw', enc.encode(gizli), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
export const imza = async (env, metin) => hex(await crypto.subtle.sign('HMAC', await anahtar(env), enc.encode(metin)));

export const sifreDogru = (env, sifre) => !!env.ISBUL_SIFRE && esit(sifre, env.ISBUL_SIFRE);
export async function cerez(env, request, cikis = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  if (cikis) return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
  const bitis = Math.floor(Date.now() / 1000) + GUN * 86400;
  return `${COOKIE}=${bitis}.${await imza(env, 'oturum|' + bitis)}; Path=/; Max-Age=${GUN * 86400}; HttpOnly; SameSite=Lax${secure}`;
}
export async function oturumVar(env, request) {
  for (const parca of (request.headers.get('Cookie') || '').split(';')) {
    const [k, v] = parca.trim().split('=');
    if (k !== COOKIE || !v) continue;
    const [bitis, sig] = v.split('.');
    if (+bitis > Date.now() / 1000 && esit(sig || '', await imza(env, 'oturum|' + bitis))) return true;
  }
  return false;
}
// 5 hatalı denemede 5 dk kilit
const HATALAR = new Map();
export const kilitli = ip => (HATALAR.get(ip)?.[1] || 0) > Date.now();
export function hataSay(ip) { const n = (HATALAR.get(ip)?.[0] || 0) + 1; HATALAR.set(ip, n >= 5 ? [0, Date.now() + 300000] : [n, 0]); }
