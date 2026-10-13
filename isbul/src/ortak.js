// Ortak yardımcılar: yanıtlar, hatalar, istek gövdesi
export class HttpHata extends Error {
  constructor(status, mesaj, code = 'invalid_request') { super(mesaj); this.status = status; this.code = code; }
}
export const yanit = (status, data, basliklar = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...basliklar },
});
export const bos = (status = 204) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
export const yonlendir = (yer, cerez) => new Response(null, { status: 303, headers: { Location: yer, 'Cache-Control': 'no-store', ...(cerez ? { 'Set-Cookie': cerez } : {}) } });
export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const esit = (a, b) => { // sabit süreli karşılaştırma
  a = String(a); b = String(b);
  let fark = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) fark |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return fark === 0;
};
export async function govde(request, sinir) {
  const metin = await request.text();
  if (metin.length > sinir) throw new HttpHata(400, 'İstek çok büyük.');
  if (!metin) return {};
  try { return JSON.parse(metin); } catch { throw new HttpHata(400, 'Geçersiz istek.'); }
}
