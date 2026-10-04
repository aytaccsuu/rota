"""Cloudflare sürümü sözleşme testi: Python sürümüyle aynı uç noktaların aynı davranmasını doğrular.

Çalıştırma (yerel):  cd cloudflare && npm run db:local && npx wrangler dev --local --port 8787
                     python test_sozlesme.py            (CF_URL=http://127.0.0.1:8787 varsayılan)
.dev.vars içinde:    ROTA_KULLANICILAR=aytac:Deneme-1234,baran:Deneme-5678
"""
import base64
import json
import os
import random
import unittest
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ.get("CF_URL", "http://127.0.0.1:8787")
EK = str(random.randint(10000, 99999))  # yerel veritabanı testler arasında temizlenmez; benzersiz adlar


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def req(method, path, body=None, cookie=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    r = urllib.request.Request(URL + path, data=data, method=method, headers={"Content-Type": ctype, **({"Cookie": cookie} if cookie else {})})
    try:
        resp = opener.open(r, timeout=30)
    except urllib.error.HTTPError as e:
        resp = e
    payload = resp.read()
    try:
        parsed = json.loads(payload) if payload else None
    except ValueError:
        parsed = payload
    return resp.status, parsed, resp.headers


def login(ad, sifre):
    status, _, h = req("POST", "/giris", raw=urllib.parse.urlencode({"kullanici": ad, "sifre": sifre}).encode(), ctype="application/x-www-form-urlencoded")
    c = (h.get("Set-Cookie") or "").split(";")[0]
    return c if status == 303 and c.startswith("rota_oturum=") and len(c) > 15 else None


class Sozlesme(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.aytac = login("aytac", "Deneme-1234")
        cls.baran = login("baran", "Deneme-5678")
        assert cls.aytac and cls.baran, "giriş yapılamadı (wrangler dev çalışıyor mu, .dev.vars doğru mu?)"

    def test_giris_ve_oturum(self):
        self.assertIsNone(login("aytac", "yanlis"))
        self.assertEqual(req("GET", "/api/plan")[0], 401)
        s, _, h = req("GET", "/")
        self.assertEqual((s, h.get("Location")), (303, "/giris"))
        s, body, _ = req("GET", "/", cookie=self.aytac)
        self.assertEqual(s, 200)
        self.assertIn(b"Rota", body if isinstance(body, bytes) else json.dumps(body).encode())
        a = req("GET", "/ayarlar", cookie=self.aytac)[1]
        self.assertEqual((a["user"], a["isAdmin"], a["authOn"]), ("aytac", True, True))
        self.assertFalse(req("GET", "/ayarlar", cookie=self.baran)[1]["isAdmin"])

    def test_plan_kisiye_ozel(self):
        self.assertEqual(req("POST", "/api/plan", {"plan": {"v": 1, "stops": [{"id": 1}]}}, self.aytac)[0], 204)
        self.assertEqual(json.loads(req("GET", "/api/plan", cookie=self.aytac)[1]["plan"])["stops"][0]["id"], 1)
        self.assertIsNone(req("GET", "/api/plan", cookie=self.baran)[1]["plan"])
        self.assertEqual(req("POST", "/api/plan", {"plan": "metin"}, self.aytac)[0], 400)
        self.assertEqual(req("POST", "/api/plan", {"plan": None}, self.aytac)[0], 204)
        self.assertIsNone(req("GET", "/api/plan", cookie=self.aytac)[1]["plan"])

    def test_fiyat_rut_yakit_evrak(self):
        f = {"anadolu": [{"nokta": 20, "tl": 5000}, {"nokta": 18, "tl": 5000}], "avrupa1": [{"nokta": 18, "tl": 5800}, {"nokta": 16, "tl": 5800}],
             "avrupa2": [{"nokta": 18, "tl": 6100}, {"nokta": 16, "tl": 6100}], "ekstraNokta": 150, "kdv": 20, "kmUcret": 12}
        self.assertEqual(req("POST", "/api/fiyat", {"fiyat": f}, self.baran)[0], 403)
        self.assertEqual(req("POST", "/api/fiyat", {"fiyat": f}, self.aytac)[0], 204)
        self.assertEqual(req("GET", "/api/fiyat", cookie=self.baran)[1]["fiyat"]["kmUcret"], 12)
        ay = "2031-0%d" % random.randint(1, 9)
        self.assertEqual(req("POST", "/api/rut", {"tarih": ay + "-01", "rut": {"durum": "calisti", "hammaliye": 100}}, self.aytac)[0], 204)
        self.assertEqual(req("POST", "/api/rut", {"tarih": ay + "-01", "rut": {"durum": "calisti", "hammaliye": 250}}, self.aytac)[0], 204)
        self.assertEqual(req("POST", "/api/rut", {"tarih": ay + "-02", "rut": {"durum": "gidilmedi"}}, self.aytac)[0], 204)
        rutlar = req("GET", "/api/rutlar?ay=" + ay, cookie=self.aytac)[1]["rutlar"]
        self.assertEqual([(r["tarih"], r.get("hammaliye"), r["durum"]) for r in rutlar], [(ay + "-01", 250, "calisti"), (ay + "-02", None, "gidilmedi")])
        self.assertEqual(req("GET", "/api/rutlar?ay=" + ay, cookie=self.baran)[1]["rutlar"], [])
        self.assertEqual(req("POST", "/api/rut", {"tarih": "01.10.2026", "rut": {}}, self.aytac)[0], 400)
        yid = req("POST", "/api/yakit", {"tarih": ay + "-01", "tutar": 2500}, self.aytac)[1]["id"]
        req("POST", "/api/yakit", {"id": yid, "tarih": ay + "-01", "tutar": 2600}, self.aytac)
        self.assertEqual([y["tutar"] for y in req("GET", "/api/yakitlar?ay=" + ay, cookie=self.aytac)[1]["yakitlar"]], [2600])
        self.assertEqual(req("POST", "/api/yakit", {"tarih": ay + "-01", "tutar": -5}, self.aytac)[0], 400)
        req("POST", "/api/yakit-sil", {"id": yid}, self.baran)
        self.assertEqual(len(req("GET", "/api/yakitlar?ay=" + ay, cookie=self.aytac)[1]["yakitlar"]), 1, "başkası silemez")
        req("POST", "/api/yakit-sil", {"id": yid}, self.aytac)
        self.assertEqual(req("GET", "/api/yakitlar?ay=" + ay, cookie=self.aytac)[1]["yakitlar"], [])
        eid = req("POST", "/api/evrak", {"tarih": ay + "-01", "ad": "e.jpg", "mime": "image/jpeg", "data": base64.b64encode(b"JPEGDATA").decode()}, self.aytac)[1]["id"]
        s, body, h = req("GET", "/api/evrak/%d" % eid, cookie=self.aytac)
        self.assertEqual((s, h.get("Content-Type"), body), (200, "image/jpeg", b"JPEGDATA"))
        self.assertEqual(req("GET", "/api/evrak/%d" % eid, cookie=self.baran)[0], 404)
        self.assertEqual(req("POST", "/api/rut", {"tarih": ay + "-01", "rut": None, "evraklar": "sil"}, self.aytac)[0], 204)
        self.assertEqual(req("GET", "/api/evrak/%d" % eid, cookie=self.aytac)[0], 404)

    def test_yonetici_kullanici_ve_ozet(self):
        ad = "veli" + EK
        self.assertEqual(req("POST", "/api/kullanici", {"ad": ad, "sifre": "Gizli-123"}, self.baran)[0], 403)
        self.assertEqual(req("POST", "/ayarlar", {"tomtomKey": "x"}, self.baran)[0], 403)
        self.assertEqual(req("POST", "/api/kullanici", {"ad": ad, "sifre": "Gizli-123"}, self.aytac)[0], 200)
        veli = login(ad, "Gizli-123")
        self.assertTrue(veli)
        self.assertEqual(req("POST", "/api/kullanici", {"ad": "baran", "sifre": "Gizli-123"}, self.aytac)[0], 400)
        req("POST", "/ayarlar", {"home": {"lat": 41.1, "lon": 29.1}}, veli)
        self.assertEqual(req("GET", "/ayarlar", cookie=veli)[1]["home"], {"lat": 41.1, "lon": 29.1})
        self.assertNotEqual(req("GET", "/ayarlar", cookie=self.baran)[1].get("home"), {"lat": 41.1, "lon": 29.1})
        self.assertEqual(req("POST", "/api/kullanici", {"ad": ad, "sifre": "Yeni-4567"}, self.aytac)[0], 200)
        self.assertEqual(req("GET", "/api/plan", cookie=veli)[0], 401, "şifre değişince eski oturum düşer")
        self.assertIn(ad, [u["ad"] for u in req("GET", "/api/yonetim/ozet?ay=2026-09", cookie=self.aytac)[1]["kullanicilar"]])
        self.assertEqual(req("GET", "/api/yonetim/ozet?ay=2026-09", cookie=self.baran)[0], 403)
        imp = {"kullanici": ad, "rutlar": [{"tarih": "2026-09-01", "rut": {"durum": "calisti", "nokta": 19}}], "yakitlar": [{"tarih": "2026-09-02", "tutar": 1500}]}
        self.assertEqual(req("POST", "/api/yonetim/aktar", imp, self.aytac)[1], {"kullanici": ad, "rut": 1, "yakit": 1})
        self.assertEqual(req("POST", "/api/yonetim/aktar", imp, self.aytac)[1]["yakit"], 0)
        self.assertEqual(req("POST", "/api/kullanici-sil", {"ad": ad, "veriler": True}, self.aytac)[0], 200)
        self.assertIsNone(login(ad, "Yeni-4567"))

    def test_konum_hafizasi_ve_tercih(self):
        k = "adres|test|" + EK + "|bahce|334"
        self.assertEqual(req("POST", "/api/konum-bul", {"anahtarlar": [k]}, self.aytac)[1], {"konumlar": {}})
        self.assertTrue(req("POST", "/api/konum-kaydet", {"anahtar": k, "lat": 40.95, "lon": 29.09, "kaynak": "arama"}, self.aytac)[1]["yazildi"])
        self.assertTrue(req("POST", "/api/konum-kaydet", {"anahtar": k, "lat": 40.951, "lon": 29.091, "kaynak": "elle"}, self.baran)[1]["yazildi"])
        self.assertFalse(req("POST", "/api/konum-kaydet", {"anahtar": k, "lat": 40.9, "lon": 29.0, "kaynak": "gps", "dogruluk": 9}, self.aytac)[1]["yazildi"])
        got = req("POST", "/api/konum-bul", {"anahtarlar": [k]}, self.baran)[1]["konumlar"][k]
        self.assertEqual((got["lat"], got["kaynak"], got["sayac"]), (40.951, "elle", 3))
        self.assertEqual(req("POST", "/api/konum-kaydet", {"anahtar": k, "lat": 39.9, "lon": 32.8, "kaynak": "elle"}, self.aytac)[0], 400)
        self.assertEqual(req("POST", "/ayarlar", {"tercihler": {"arama": True, "cikisDk": 60}}, self.baran)[0], 204)
        self.assertEqual(req("GET", "/ayarlar", cookie=self.baran)[1]["tercihler"], {"arama": True, "cikisDk": 60})

    def test_tasima(self):
        u = "tasi" + EK
        self.assertEqual(req("POST", "/api/yonetim/tasima", {"rutlar": []}, self.baran)[0], 403)
        eid = req("POST", "/api/yonetim/tasima-evrak", {"kullanici": u, "tarih": "2026-09-01", "ad": "e.jpg", "mime": "image/jpeg", "data": base64.b64encode(b"X" * 300000).decode()}, self.aytac)[1]["id"]
        body = {"rutlar": [{"kullanici": u, "tarih": "2026-09-01", "veri": {"durum": "calisti", "nokta": 20, "evraklar": [{"id": eid}]}}],
                "yakitlar": [{"kullanici": u, "tarih": "2026-09-02", "litre": None, "tutar": 1234.5, "km": None, "notu": ""}],
                "kullanicilar": [{"ad": u, "sifre": "pbkdf2$1000$abcd$" + "0" * 64}],
                "konumlar": [{"anahtar": "adres|" + u, "lat": 41.0, "lon": 29.0, "kaynak": "gps", "dogruluk": 5, "adres": "x", "kullanici": u, "sayac": 4}]}
        self.assertEqual(req("POST", "/api/yonetim/tasima", body, self.aytac)[1], {"rutlar": 1, "yakitlar": 1, "kullanicilar": 1, "konumlar": 1})
        req("POST", "/api/yonetim/tasima", body, self.aytac)  # ikinci kez: yakıt çoğalmaz
        oz = {x["ad"]: x for x in req("GET", "/api/yonetim/ozet?ay=2026-09", cookie=self.aytac)[1]["kullanicilar"]}[u]
        self.assertEqual((len(oz["rutlar"]), [y["tutar"] for y in oz["yakitlar"]]), (1, [1234.5]))
        self.assertEqual(req("POST", "/api/konum-bul", {"anahtarlar": ["adres|" + u]}, self.aytac)[1]["konumlar"]["adres|" + u]["sayac"], 4)
        req("POST", "/api/kullanici-sil", {"ad": u, "veriler": True}, self.aytac)

    def test_dogrulamalar(self):
        self.assertEqual(req("POST", "/api/trafik-matris", {"points": [[1, 2]]}, self.aytac)[0], 400)
        self.assertEqual(req("POST", "/api/yol-matris", {"points": [[41, 29], [41.01, 29.01]]}, self.aytac)[0], 503, "anahtar yokken yedek yok")
        self.assertEqual(req("GET", "/api/location-search?provider=yok&q=abc", cookie=self.aytac)[0], 400)
        self.assertEqual(req("POST", "/api/adres-denetle", {"items": []}, self.aytac)[0], 400)
        self.assertEqual(req("POST", "/api/adres-denetle", {"items": [{"x": 1}]}, self.aytac)[0], 400)
        self.assertEqual(req("GET", "/api/location-search?provider=tomtom&q=Kadikoy", cookie=self.aytac)[0], 503)


if __name__ == "__main__":
    unittest.main(verbosity=1)
