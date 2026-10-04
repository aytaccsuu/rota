"""Bilgisayardaki ayarlar.json anahtarlarını ve kullanıcı listesini Cloudflare'e gizli ayar (secret) olarak yükler.

Çalıştırma (proje klasöründe):   python cloudflare/anahtarlari_yukle.py
- API anahtarları ../ayarlar.json'dan okunur (ekrana yazılmaz).
- ROTA_KULLANICILAR sorulur: "aytac:şifre, baran:şifre, esat:şifre" (yazarken görünmez).
- ROTA_GIZLI (oturum imzası) rastgele üretilir.
- Depo koordinatı ayarlar.json'da varsa DEPO_KOORDINAT olarak girilir.
Değerler doğrudan wrangler'a verilir; hiçbir dosyaya ya da ekrana yazılmaz.
"""
import getpass
import json
import os
import secrets
import subprocess
import sys

KLASOR = os.path.dirname(os.path.abspath(__file__))
AYAR = os.path.join(KLASOR, "..", "ayarlar.json")
ESLEME = {  # ayarlar.json alanı → Cloudflare gizli ayar adı
    "tomtomKey": "TOMTOM_API_KEY",
    "ygeokey": "YANDEX_GEOCODER_API_KEY",
    "ykey": "YANDEX_MAPS_JS_KEY",
    "geminiKey": "GEMINI_API_KEY",
    "maptilerKey": "MAPTILER_API_KEY",
    "geoapifyKey": "GEOAPIFY_API_KEY",
    "orsKey": "ORS_API_KEY",
    "gkey": "GOOGLE_MAPS_API_KEY",
}


def koy(ad, deger):
    r = subprocess.run("npx wrangler secret put " + ad, input=deger, text=True, cwd=KLASOR, shell=True, capture_output=True)
    print(("  ✓ " if r.returncode == 0 else "  ✗ ") + ad + ("" if r.returncode == 0 else "  → " + (r.stderr or r.stdout).strip().splitlines()[-1]))
    return r.returncode == 0


def main():
    ayar = json.load(open(AYAR, encoding="utf-8")) if os.path.exists(AYAR) else {}
    print("Kullanıcı listesi (ör. aytac:123456, baran:123456, esat:123456).")
    print("Panelde zaten girdiyseniz boş bırakıp Enter'a basın.")
    kullanicilar = getpass.getpass("Kullanıcılar (yazarken görünmez): ").strip()
    if kullanicilar and ":" not in kullanicilar:
        sys.exit("Biçim: ad:şifre, ad:şifre")
    print("Cloudflare'e yükleniyor…")
    ok = True
    if kullanicilar:
        ok = koy("ROTA_KULLANICILAR", kullanicilar) and koy("ROTA_GIZLI", secrets.token_urlsafe(40))
    for alan, ad in ESLEME.items():
        if isinstance(ayar.get(alan), str) and ayar[alan].strip():
            ok = koy(ad, ayar[alan].strip()) and ok
    depo = ayar.get("depot")
    if isinstance(depo, dict) and "lat" in depo:
        ok = koy("DEPO_KOORDINAT", "%s, %s" % (depo["lat"], depo["lon"])) and ok
    ev = ayar.get("home")  # ortak varsayılan; yalnızca yöneticiye gösterilir, diğerleri kendi evini girer
    if isinstance(ev, dict) and "lat" in ev:
        ok = koy("EV_KOORDINAT", "%s, %s" % (ev["lat"], ev["lon"])) and ok
    print("Bitti." if ok else "Bazı ayarlar yüklenemedi (yukarıya bakın).")


if __name__ == "__main__":
    main()
