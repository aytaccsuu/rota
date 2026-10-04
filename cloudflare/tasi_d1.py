"""Neon (Render) verilerini doğrudan Cloudflare D1'e taşır. Cloudflare şifresi gerekmez (wrangler oturumu kullanılır).

En kolayı: cloudflare klasöründeki "VERILERI_TASI.bat" dosyasına çift tıklayın, Neon adresini yapıştırıp Enter'a basın.
Kayıt numaraları korunur (evrak bağlantıları bozulmaz). Tekrar çalıştırılırsa kayıtlar üzerine yazılır, çoğalmaz.
"""
import os
import subprocess
import sys
import tempfile

KLASOR = os.path.dirname(os.path.abspath(__file__))
PARCA = 40000  # bayt: D1'de tek SQL ifadesi en çok 100 KB olabilir; büyük veriler parça parça eklenir


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def parcali_metin(tablo, kosul, alan, metin):
    """Uzun metni ilk satırdan sonra || ile parça parça ekleyen ifadeler."""
    out = []
    for i in range(PARCA, len(metin), PARCA):
        out.append("UPDATE %s SET %s = %s || %s WHERE %s;" % (tablo, alan, alan, q(metin[i:i + PARCA]), kosul))
    return out


def sql_uret(v):
    """v: {planlar, rutlar, yakitlar, kullanicilar, ayarlar, konumlar, evraklar(id,kul,tarih,ad,mime,bytes)} → SQL satırları."""
    s = []
    for kul, veri in v["planlar"]:
        s.append("INSERT OR REPLACE INTO planlar (kullanici, veri) VALUES (%s, %s);" % (q(kul), q(veri[:PARCA])))
        s += parcali_metin("planlar", "kullanici = %s" % q(kul), "veri", veri)
    for kul, tarih, veri in v["rutlar"]:
        s.append("INSERT OR REPLACE INTO rutlar (kullanici, tarih, veri) VALUES (%s, %s, %s);" % (q(kul), q(tarih), q(veri[:PARCA])))
        s += parcali_metin("rutlar", "kullanici = %s AND tarih = %s" % (q(kul), q(tarih)), "veri", veri)
    for i, kul, tarih, litre, tutar, km, notu in v["yakitlar"]:
        s.append("INSERT OR REPLACE INTO yakitlar (id, kullanici, tarih, litre, tutar, km, notu) VALUES (%s);"
                 % ", ".join(q(x) for x in (i, kul, tarih, None if litre is None else float(litre), float(tutar), km, notu)))
    for ad, sifre in v["kullanicilar"]:
        s.append("INSERT OR REPLACE INTO kullanicilar (ad, sifre) VALUES (%s, %s);" % (q(ad), q(sifre)))
    for anahtar, deger in v["ayarlar"]:
        s.append("INSERT OR REPLACE INTO ayarlar (anahtar, deger) VALUES (%s, %s);" % (q(anahtar), q(deger)))
    for r in v["konumlar"]:
        s.append("INSERT OR REPLACE INTO konumlar (anahtar, lat, lon, kaynak, dogruluk, adres, kullanici, sayac) VALUES (%s);" % ", ".join(q(x) for x in r))
    for i, kul, tarih, ad, mime, veri in v["evraklar"]:
        h = veri.hex()
        s.append("INSERT OR REPLACE INTO evraklar (id, kullanici, tarih, ad, mime, veri, r2) VALUES (%s, %s, %s, %s, %s, X'%s', 0);"
                 % (q(i), q(kul), q(tarih), q(ad), q(mime), h[:PARCA * 2]))
        for j in range(PARCA * 2, len(h), PARCA * 2):
            # || metin birleştirir; sonucu yeniden BLOB'a çevirmek baytları korur (sıfır baytlar dahil)
            s.append("UPDATE evraklar SET veri = CAST(veri || X'%s' AS BLOB) WHERE id = %s;" % (h[j:j + PARCA * 2], q(i)))
    return s


def neon_oku(url):
    import psycopg
    v = {}
    with psycopg.connect(url, connect_timeout=30) as conn, conn.cursor() as cur:
        def t(sql):
            try:
                cur.execute(sql)
                return cur.fetchall()
            except psycopg.errors.UndefinedTable:
                conn.rollback()
                return []
        v["planlar"] = t("SELECT kullanici, veri::text FROM planlar")
        v["rutlar"] = t("SELECT kullanici, to_char(tarih,'YYYY-MM-DD'), veri::text FROM rutlar ORDER BY tarih")
        v["yakitlar"] = t("SELECT id, kullanici, to_char(tarih,'YYYY-MM-DD'), litre, tutar, km, notu FROM yakitlar ORDER BY id")
        v["kullanicilar"] = t("SELECT ad, sifre FROM kullanicilar")
        v["ayarlar"] = t("SELECT anahtar, deger::text FROM ayarlar WHERE anahtar NOT LIKE 'gemini_kota:%'")
        v["konumlar"] = t("SELECT anahtar, lat, lon, kaynak, dogruluk, adres, kullanici, sayac FROM konumlar")
        v["evraklar"] = [(i, k, ta, a, m, bytes(d)) for i, k, ta, a, m, d in t("SELECT id, kullanici, to_char(tarih,'YYYY-MM-DD'), ad, mime, veri FROM evraklar ORDER BY id")]
    return v


def uygula(satirlar, uzak=True):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("\n".join(satirlar) + "\n")
        yol = f.name
    try:
        komut = 'npx wrangler d1 execute rota-plani %s --file="%s" -y' % ("--remote" if uzak else "--local", yol)
        r = subprocess.run(komut, cwd=KLASOR, shell=True, text=True, capture_output=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            sys.exit("Cloudflare'e yazılamadı:\n" + (r.stderr or r.stdout)[-1500:])
    finally:
        os.remove(yol)


def main():
    url = os.environ.get("DATABASE_URL", "").strip().strip('"')
    if not url.startswith("postgres"):
        sys.exit("Neon adresi (postgresql://...) gerekli.")
    print("Neon okunuyor…")
    v = neon_oku(url)
    print("Bulunan: %d plan, %d günlük kayıt, %d yakıt, %d kullanıcı, %d ayar, %d konum, %d evrak"
          % tuple(len(v[k]) for k in ("planlar", "rutlar", "yakitlar", "kullanicilar", "ayarlar", "konumlar", "evraklar")))
    satirlar = sql_uret(v)
    print("Cloudflare'e yazılıyor (%d işlem)…" % len(satirlar))
    for i in range(0, len(satirlar), 2000):
        uygula(satirlar[i:i + 2000], uzak="--yerel" not in sys.argv)
    print("TAMAMLANDI. Bu pencereyi kapatabilirsiniz.")


if __name__ == "__main__":
    main()
