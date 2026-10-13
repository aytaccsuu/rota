// D1 ayar tablosu (JSON metin değerleri)
export async function ayarOku(env, k) {
  const r = await env.DB.prepare('SELECT deger FROM ayarlar WHERE anahtar = ?').bind(k).first();
  return r ? r.deger : null;
}
export async function ayarYaz(env, k, metin) {
  JSON.parse(metin);
  return env.DB.prepare(`INSERT INTO ayarlar (anahtar, deger, guncelleme) VALUES (?, ?, datetime('now'))
    ON CONFLICT (anahtar) DO UPDATE SET deger = excluded.deger, guncelleme = excluded.guncelleme`).bind(k, metin).run();
}
