"""ANAHTARLAR.txt dosyasındaki bütün anahtarları Cloudflare'e gizli ayar (secret) olarak yükler.

En kolayı: ANAHTARLARI_YUKLE.bat dosyasına çift tıklayın.
ANAHTARLAR.txt yoksa bilgisayardaki ../ayarlar.json'dan alınır. Boş satırlar yüklenmez.
Değerler doğrudan wrangler'a verilir; ekrana yazılmaz.
"""
import json
import os
import secrets
import subprocess
import sys

KLASOR = os.path.dirname(os.path.abspath(__file__))
DOSYA = os.path.join(KLASOR, "ANAHTARLAR.txt")
AYAR = os.path.join(KLASOR, "..", "ayarlar.json")
SIRA = ["ROTA_KULLANICILAR", "ROTA_GIZLI", "TOMTOM_API_KEY", "YANDEX_GEOCODER_API_KEY", "YANDEX_MAPS_JS_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
        "MAPTILER_API_KEY", "GEOAPIFY_API_KEY", "ORS_API_KEY", "GOOGLE_MAPS_API_KEY", "DEPO_KOORDINAT", "EV_KOORDINAT"]
JSON_ALAN = {"tomtomKey": "TOMTOM_API_KEY", "ygeokey": "YANDEX_GEOCODER_API_KEY", "ykey": "YANDEX_MAPS_JS_KEY", "geminiKey": "GEMINI_API_KEY", "groqKey": "GROQ_API_KEY",
             "maptilerKey": "MAPTILER_API_KEY", "geoapifyKey": "GEOAPIFY_API_KEY", "orsKey": "ORS_API_KEY", "gkey": "GOOGLE_MAPS_API_KEY"}


def dosyadan():
    degerler = {}
    for satir in open(DOSYA, encoding="utf-8-sig"):
        satir = satir.strip()
        if not satir or satir.startswith("#") or "=" not in satir:
            continue
        ad, deger = satir.split("=", 1)
        degerler[ad.strip()] = deger.strip()
    return degerler


def jsondan():
    ayar = json.load(open(AYAR, encoding="utf-8")) if os.path.exists(AYAR) else {}
    d = {ad: ayar[alan].strip() for alan, ad in JSON_ALAN.items() if isinstance(ayar.get(alan), str) and ayar[alan].strip()}
    for alan, ad in (("depot", "DEPO_KOORDINAT"), ("home", "EV_KOORDINAT")):
        if isinstance(ayar.get(alan), dict) and "lat" in ayar[alan]:
            d[ad] = "%s, %s" % (ayar[alan]["lat"], ayar[alan]["lon"])
    return d


def koy(ad, deger):
    r = subprocess.run("npx wrangler secret put " + ad, input=deger, text=True, cwd=KLASOR, shell=True,
                       capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode == 0:
        print("  ✓ " + ad)
        return True
    cikti = r.stderr or r.stdout
    son = [x for x in cikti.splitlines() if x.strip()]
    print("  ✗ " + ad + "  → " + (son[-1] if son else "hata"))
    if "already in use" in cikti:
        print("     (Bu ad panelde Text olarak girilmiş: Cloudflare panelinden o satırı silip bu dosyayı yeniden çalıştırın.)")
    return False


def main():
    if os.path.exists(DOSYA):
        degerler, kaynak = dosyadan(), "ANAHTARLAR.txt"
    else:
        degerler, kaynak = jsondan(), "ayarlar.json (ANAHTARLAR.txt bulunamadı)"
    print("Kaynak: " + kaynak)
    if degerler.get("ROTA_KULLANICILAR") and not degerler.get("ROTA_GIZLI"):
        degerler["ROTA_GIZLI"] = secrets.token_urlsafe(40)
    yuklenecek = [ad for ad in SIRA if degerler.get(ad)] + [ad for ad in degerler if ad not in SIRA and degerler[ad]]
    if not yuklenecek:
        sys.exit("Yüklenecek değer yok.")
    print("Cloudflare'e yükleniyor (%d ayar)…" % len(yuklenecek))
    sonuc = [koy(ad, degerler[ad]) for ad in yuklenecek]
    print()
    print("Bitti: %d yüklendi, %d hata." % (sum(sonuc), len(sonuc) - sum(sonuc)))


if __name__ == "__main__":
    main()
