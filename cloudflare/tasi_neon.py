"""Render/Neon (PostgreSQL) verilerini Cloudflare sürümüne taşır.

Kullanım (bilgisayarda, bir kez):
  1. Cloudflare'de TASIMA_ACIK=1 ayarını aç (wrangler.toml [vars] veya panelden), yayına al.
  2. Terminalde:
       set DATABASE_URL=postgresql://...        (Render'daki Neon bağlantı adresi)
       set CF_URL=https://rota-plani.<hesap>.workers.dev
       python tasi_neon.py
     Yönetici kullanıcı adı ve şifresi sorulur (ekrana yazılmaz).
  3. Bitince TASIMA_ACIK ayarını kaldır.

Evrak görselleri tek tek yüklenir; günlük kayıtlardaki ve planlardaki evrak numaraları yeni numaralarla güncellenir.
Tekrar çalıştırılırsa plan/kayıt/ayar/konum üzerine yazılır, yakıt iki kez eklenmez; evraklar yeniden yüklenir (ilk taşımada çalıştırın).
"""
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    import psycopg
except ImportError:
    sys.exit("psycopg gerekli:  pip install psycopg[binary]")

DB_URL = os.environ.get("DATABASE_URL") or sys.exit("DATABASE_URL tanımlı değil")
CF = (os.environ.get("CF_URL") or sys.exit("CF_URL tanımlı değil")).rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def giris():
    ad = os.environ.get("CF_KULLANICI") or input("Cloudflare yönetici kullanıcı adı: ").strip()
    sifre = os.environ.get("CF_SIFRE") or getpass.getpass("Şifre: ")
    r = urllib.request.Request(CF + "/giris", data=urllib.parse.urlencode({"kullanici": ad, "sifre": sifre}).encode(), method="POST",
                               headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        resp = opener.open(r, timeout=30)
    except urllib.error.HTTPError as e:
        resp = e
    cerez = (resp.headers.get("Set-Cookie") or "").split(";")[0]
    if not cerez.startswith("rota_oturum=") or len(cerez) < 16:
        sys.exit("Giriş başarısız.")
    return cerez


def gonder(cerez, yol, govde):
    r = urllib.request.Request(CF + yol, data=json.dumps(govde, ensure_ascii=False).encode(), method="POST",
                               headers={"Content-Type": "application/json", "Cookie": cerez})
    try:
        with opener.open(r, timeout=120) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit("%s → %s %s" % (yol, e.code, e.read()[:300]))


def evrak_numaralarini_degistir(veri, harita):
    """Kayıttaki/plandaki evraklar listesinde eski numaraları yenileriyle değiştirir."""
    if isinstance(veri, dict) and isinstance(veri.get("evraklar"), list):
        veri["evraklar"] = [{**e, "id": harita.get(e.get("id"), e.get("id"))} if isinstance(e, dict) else e for e in veri["evraklar"]]
    return veri


def main():
    cerez = giris()
    with psycopg.connect(DB_URL, connect_timeout=20) as conn, conn.cursor() as cur:
        def tablo(sql):
            try:
                cur.execute(sql)
                return cur.fetchall()
            except psycopg.errors.UndefinedTable:
                conn.rollback()
                return []
        planlar = tablo("SELECT kullanici, veri::text FROM planlar")
        rutlar = tablo("SELECT kullanici, to_char(tarih,'YYYY-MM-DD'), veri::text FROM rutlar ORDER BY tarih")
        yakitlar = tablo("SELECT kullanici, to_char(tarih,'YYYY-MM-DD'), litre, tutar, km, notu FROM yakitlar ORDER BY tarih, id")
        kullanicilar = tablo("SELECT ad, sifre FROM kullanicilar")
        ayarlar = tablo("SELECT anahtar, deger::text FROM ayarlar WHERE anahtar NOT LIKE 'gemini_kota:%'")
        konumlar = tablo("SELECT anahtar, lat, lon, kaynak, dogruluk, adres, kullanici, sayac FROM konumlar")
        evraklar = tablo("SELECT id, kullanici, to_char(tarih,'YYYY-MM-DD'), ad, mime FROM evraklar ORDER BY id")
        print("Neon: %d plan, %d günlük kayıt, %d yakıt, %d kullanıcı, %d ayar, %d konum, %d evrak"
              % (len(planlar), len(rutlar), len(yakitlar), len(kullanicilar), len(ayarlar), len(konumlar), len(evraklar)))

        harita = {}
        for i, (eid, kul, tarih, ad, mime) in enumerate(evraklar, 1):
            cur.execute("SELECT veri FROM evraklar WHERE id = %s", (eid,))
            veri = bytes(cur.fetchone()[0])
            harita[eid] = gonder(cerez, "/api/yonetim/tasima-evrak", {"kullanici": kul, "tarih": tarih, "ad": ad, "mime": mime,
                                                                     "data": base64.b64encode(veri).decode()})["id"]
            print("\r  evrak %d/%d" % (i, len(evraklar)), end="", flush=True)
        if evraklar:
            print()

    rut_list = [{"kullanici": k, "tarih": t, "veri": evrak_numaralarini_degistir(json.loads(v), harita)} for k, t, v in rutlar]
    plan_list = [{"kullanici": k, "veri": evrak_numaralarini_degistir(json.loads(v), harita)} for k, v in planlar]
    sonuc = {}
    for i in range(0, max(len(rut_list), 1), 100):  # büyük istekleri parçala
        for k, v in gonder(cerez, "/api/yonetim/tasima", {"rutlar": rut_list[i:i + 100]}).items():
            sonuc[k] = sonuc.get(k, 0) + v
    for p in plan_list:
        gonder(cerez, "/api/yonetim/tasima", {"planlar": [p]})
    sonuc["planlar"] = len(plan_list)
    sonuc.update(gonder(cerez, "/api/yonetim/tasima", {
        "yakitlar": [{"kullanici": k, "tarih": t, "litre": float(l) if l is not None else None, "tutar": float(tu), "km": km, "notu": n} for k, t, l, tu, km, n in yakitlar],
        "kullanicilar": [{"ad": a, "sifre": s} for a, s in kullanicilar],
        "ayarlar": [{"anahtar": a, "deger": d} for a, d in ayarlar],
        "konumlar": [{"anahtar": a, "lat": la, "lon": lo, "kaynak": ka, "dogruluk": do, "adres": ad, "kullanici": ku, "sayac": sa} for a, la, lo, ka, do, ad, ku, sa in konumlar],
    }))
    sonuc["evraklar"] = len(harita)
    print("Cloudflare'e yazıldı:", json.dumps(sonuc, ensure_ascii=False))


if __name__ == "__main__":
    main()
