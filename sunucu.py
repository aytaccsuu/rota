"""Yerel rota uygulaması ve Google Places adres arama aracısı."""
import base64
import hashlib
import time
import hmac
import http.server
import json
import os
import re
import socketserver
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from providers import PROVIDERS, SSL_CONTEXT, key_for, provider_search
from evrak_okuma import OkumaHatasi, normalize_addresses, read_document
import trafik
import depo

KLASOR = os.path.dirname(os.path.abspath(__file__))
AYAR = os.path.join(KLASOR, "ayarlar.json")
PORT = int(os.environ.get("PORT") or os.environ.get("ROTA_PORT", 8080))
HOST = os.environ.get("ROTA_HOST", "127.0.0.1")  # yayında: 0.0.0.0
SIFRE = os.environ.get("ROTA_SIFRE", "")  # eski ayar: tek şifre, kullanıcı adı serbest


def parse_users(text):
    """ROTA_KULLANICILAR="mesut:sifre1, ali:sifre2" → {"mesut": "sifre1", ...}"""
    users = {}
    for part in text.replace(";", ",").split(","):
        name, sep, pw = part.strip().partition(":")
        if sep and name.strip() and pw:
            users[name.strip().casefold()] = pw
    return users


USERS = parse_users(os.environ.get("ROTA_KULLANICILAR", ""))
SESSION_DAYS = 30
COOKIE = "rota_oturum"
# Oturum imzası: ROTA_GIZLI yoksa kullanıcı ayarından türetilir (sunucu uyuyup uyansa da oturum bozulmaz;
# şifre değişince eski oturumlar geçersiz olur).
SECRET = (os.environ.get("ROTA_GIZLI") or hashlib.sha256(("rota|" + os.environ.get("ROTA_KULLANICILAR", "") + "|" + SIFRE).encode()).hexdigest()).encode()
FAILS = {}  # ip → [hatalı deneme sayısı, kilit bitişi]
LOGIN_PAGE = os.path.join(KLASOR, "giris.html")


# Yönetici: ROTA_YONETICI (virgülle birden fazla) tanımlı değilse ROTA_KULLANICILAR'daki "aytac" hesabı;
# o da yoksa listedeki ilk kullanıcı. Yönetici; kullanıcı ekler/siler, API anahtarlarını ve fiyat tablosunu değiştirir.
VARSAYILAN_YONETICI = ("aytac", "aytaç")


def admins():
    env = {n.strip().casefold() for n in os.environ.get("ROTA_YONETICI", "").split(",") if n.strip()}
    return env or {n for n in VARSAYILAN_YONETICI if n in USERS} or set(list(USERS)[:1])
USER_NAME = re.compile(r"[a-zçğıöşü][a-z0-9çğıöşü._-]{1,31}")
_db_users = {"t": 0, "v": {}}


def auth_enabled():
    return bool(USERS or SIFRE)


def db_users(fresh=False):
    """Yöneticinin eklediği kullanıcılar (30 sn önbellek); veritabanına ulaşılamazsa son bilinen liste."""
    if fresh or time.time() - _db_users["t"] > 30:
        try:
            _db_users["v"], _db_users["t"] = depo.list_users(), time.time()
        except (OSError, ValueError):
            pass
    return _db_users["v"]


def is_admin(name):
    return not USERS or (name or "") in admins()  # tek şifreli eski kurulumda herkes yönetici


def hash_password(pw, salt=None):
    salt = salt or os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200000).hex()
    return "pbkdf2$200000$%s$%s" % (salt, digest)


def verify_password(pw, stored):
    try:
        _, rounds, salt, digest = stored.split("$")
        good = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), int(rounds)).hex()
        return hmac.compare_digest(good, digest)
    except (ValueError, AttributeError):
        return False


def user_version(name):
    """Oturum sürümü: yönetici şifreyi değiştirince eski oturumlar geçersiz olur. None → kullanıcı yok."""
    if name in USERS:
        return ""
    item = db_users().get(name)
    return item["sifre"][-8:] if item else None


def check_login(name, pw):
    name = (name or "").strip().casefold()
    if USERS:
        expected = USERS.get(name)
        if expected:
            return hmac.compare_digest(pw.encode(), expected.encode())
        item = db_users(fresh=True).get(name)
        return bool(item) and verify_password(pw, item["sifre"])
    return bool(SIFRE) and bool(name) and hmac.compare_digest(pw.encode(), SIFRE.encode())


def make_token(name, now=None):
    exp = int((now or time.time()) + SESSION_DAYS * 86400)
    body = "%s|%d" % (name, exp)
    version = user_version(name) if USERS else ""
    if version:
        body += "|" + version
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(("%s|%s" % (body, sig)).encode()).decode()


def read_token(token, now=None):
    try:
        body, sig = base64.urlsafe_b64decode(token.encode()).decode().rsplit("|", 1)
        good = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, good):
            return None
        parts = body.split("|")
        name, exp, version = (parts + [""])[:3] if len(parts) <= 3 else ("|".join(parts[:-2]), parts[-2], parts[-1])
        if int(exp) < (now or time.time()):
            return None
        if USERS and user_version(name) != version:
            return None  # kullanıcı silinmiş ya da şifresi değişmiş
        return name
    except (ValueError, UnicodeDecodeError):
        return None
LOCK = threading.Lock()


def env_point(name):
    """'41.0123, 29.1234' biçimindeki ortam değişkenini konuma çevirir."""
    try:
        lat, lon = (float(x) for x in os.environ.get(name, "").replace(";", ",").split(",")[:2])
        return {"lat": lat, "lon": lon}
    except ValueError:
        return None


def gemini_key(settings):
    return os.environ.get("GEMINI_API_KEY") or settings.get("geminiKey", "")


def read_settings():
    data = {}
    if os.path.exists(AYAR):
        with open(AYAR, encoding="utf-8") as f:
            data = json.load(f)
    # Ücretsiz sunucularda dosyalar kalıcı değil: sabit ayarlar ortam değişkenlerinden de okunur
    for field, env in (("depot", "DEPO_KOORDINAT"), ("home", "EV_KOORDINAT")):
        if not data.get(field) and env_point(env):
            data[field] = env_point(env)
    if not data.get("ykey") and os.environ.get("YANDEX_MAPS_JS_KEY"):
        data["ykey"] = os.environ["YANDEX_MAPS_JS_KEY"]
    return data


def google_search(query, key):
    payload = {"textQuery": query, "languageCode": "tr", "regionCode": "TR", "pageSize": 5,
               "locationBias": {"rectangle": {"low": {"latitude": 40.7, "longitude": 27.9},
                                                "high": {"latitude": 41.6, "longitude": 29.95}}}}
    request = urllib.request.Request(
        "https://places.googleapis.com/v1/places:searchText",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": key,
                 "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.googleMapsUri,places.types"})
    with urllib.request.urlopen(request, timeout=15, context=SSL_CONTEXT) as response:
        return json.load(response).get("places", [])


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=KLASOR, **kwargs)

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def session_user(self):
        if not auth_enabled():
            return "yerel"
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE and v:
                return read_token(v)
        return None

    def authorized(self):
        """Oturum yoksa: sayfa isteğine giriş ekranı, diğer isteklere 401 döner."""
        self.user = self.session_user()
        if self.user:
            return True
        self.drain_body()  # gövde okunmadan yanıt verilirse bağlantı yarıda kesilir
        path = urllib.parse.urlsplit(self.path).path
        if self.command == "GET" and path in ("/", "/index.html"):
            self.redirect("/giris")
        else:
            self.reply(401, {"error": "Oturum süresi doldu, tekrar giriş yapın.", "code": "login"})
        return False

    def drain_body(self):
        try:
            size = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            size = 0
        left = min(max(size, 0), 16 * 1024 * 1024)
        while left > 0:
            chunk = self.rfile.read(min(left, 65536))
            if not chunk:
                break
            left -= len(chunk)
        if size > 16 * 1024 * 1024:
            self.close_connection = True

    def redirect(self, location, cookie=None):
        self.send_response(303)
        self.send_header("Location", location)
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def cookie(self, value, max_age):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "") == "https" else ""
        return "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax%s" % (COOKIE, value, max_age, secure)

    def login_page(self):
        with open(LOGIN_PAGE, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        return (self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0])

    def login(self):
        ip, now = self.client_ip(), time.time()
        # Form her durumda okunur: okunmadan yanıt verilirse bağlantı yarıda kesilir
        try:
            size = int(self.headers.get("Content-Length", 0))
            form = urllib.parse.parse_qs(self.rfile.read(min(max(size, 0), 4096)).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            form = {}
        fails, until = FAILS.get(ip, [0, 0])
        if until > now:
            return self.redirect("/giris?hata=kilit")
        name, pw = form.get("kullanici", [""])[0], form.get("sifre", [""])[0]
        if check_login(name, pw):
            FAILS.pop(ip, None)
            key = name.strip().casefold()
            return self.redirect("/", self.cookie(make_token(key), SESSION_DAYS * 86400))
        fails += 1
        FAILS[ip] = [0, now + 300] if fails >= 5 else [fails, 0]  # 5 hatalı denemede 5 dk kilit
        return self.redirect("/giris?hata=" + ("kilit" if fails >= 5 else "1"))

    def do_HEAD(self):
        self.user = self.session_user()
        if not self.user:
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_HEAD()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/giris":
            if auth_enabled() and self.session_user():
                return self.redirect("/")
            return self.login_page()
        if path == "/cikis":
            return self.redirect("/giris?durum=cikis", self.cookie("", 0))
        if not self.authorized():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/ayarlar":
            with LOCK:
                data = read_settings()
            key = data.pop("gkey", "")
            gem = gemini_key(data)
            data.pop("geminiKey", None)
            configured = {p: bool(key_for(p, data)) for p in PROVIDERS}
            # anahtarın kendisi değil, yalnızca son 4 karakteri: kaydın yapıldığı ekranda görülsün
            hints = {p: key_for(p, data)[-4:] for p in PROVIDERS if key_for(p, data)}
            for _, field, _ in PROVIDERS.values():
                data.pop(field, None)
            data.update(self.user_points(data))
            admin = is_admin(self.user)
            if not admin:
                hints = {}  # anahtar ipuçları yalnızca yöneticiye (Yandex harita anahtarı tarayıcıda harita için zorunlu)
            return self.reply(200, {**data, "isAdmin": admin, "providers": configured, "hints": hints, "googleConfigured": bool(os.environ.get("GOOGLE_MAPS_API_KEY") or key), "ocrConfigured": bool(gem), "ocrHint": gem[-4:] if gem and admin else "", "user": self.user, "authOn": auth_enabled()})
        if path == "/api/kullanicilar":
            if not is_admin(self.user):
                return self.reply(403, {"error": "Bu işlem yalnızca yönetici içindir.", "code": "forbidden"})
            try:
                return self.reply(200, {"kullanicilar": self.user_list()})
            except (OSError, ValueError):
                return self.reply(502, {"error": "Kullanıcılar okunamadı (veritabanı).", "code": "storage"})
        if path == "/api/plan":
            try:
                return self.reply(200, {"plan": depo.load(self.user), "backend": depo.backend()})
            except (OSError, ValueError):
                return self.reply(502, {"error": "Kayıtlı plan okunamadı (veritabanı).", "code": "storage"})
        if path.startswith("/api/evrak/"):
            try:
                item = depo.load_evrak(self.user, int(path.rsplit("/", 1)[1]))
            except (OSError, ValueError):
                item = None
            if not item:
                return self.reply(404, {"error": "Evrak bulunamadı.", "code": "not_found"})
            self.send_response(200)
            self.send_header("Content-Type", item[0])
            self.send_header("Content-Length", str(len(item[1])))
            self.end_headers()
            return self.wfile.write(item[1])
        if path == "/api/fiyat":
            try:
                return self.reply(200, {"fiyat": json.loads(depo.get_setting("fiyat") or "null")})
            except (OSError, ValueError):
                return self.reply(502, {"error": "Fiyat tablosu okunamadı (veritabanı).", "code": "storage"})
        if path in ("/api/rutlar", "/api/yakitlar"):
            ay = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("ay", [""])[0]
            if not re.fullmatch(r"\d{4}-\d{2}", ay):
                return self.reply(400, {"error": "Ay YYYY-AA biçiminde olmalı.", "code": "invalid_request"})
            try:
                if path == "/api/rutlar":
                    return self.reply(200, {"rutlar": depo.list_rutlar(self.user, ay)})
                return self.reply(200, {"yakitlar": depo.list_yakitlar(self.user, ay)})
            except (OSError, ValueError):
                return self.reply(502, {"error": "Kayıtlar okunamadı (veritabanı).", "code": "storage"})
        if path == "/api/location-search":
            args = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            provider = args.get('provider', [''])[0]
            query = args.get('q', [''])[0].strip()
            mode = args.get('mode', ['address'])[0]
            if provider not in PROVIDERS or not 3 <= len(query) <= 500 or mode not in ('address', 'place'):
                return self.reply(400, {'error': 'Geçersiz servis veya adres.', 'code': 'invalid_request'})
            with LOCK:
                key = key_for(provider, read_settings())
            if not key:
                return self.reply(503, {'error': 'Bu servis için Ayarlar’dan API anahtarı ekleyin.', 'code': 'missing_key'})
            try:
                return self.reply(200, {'candidates': provider_search(provider, query, key, mode)})
            except urllib.error.HTTPError as error:
                code = 'auth' if error.code in (401, 403) else 'quota' if error.code == 429 else 'upstream'
                message = {'auth': 'Anahtar reddedildi. Anahtarın doğruluğunu, bu API için etkinliğini ve IP/domain kısıtlarını kontrol edin.', 'quota': 'Servis sorgu kotası veya hız sınırı aşıldı.', 'upstream': 'Konum servisi geçici olarak hata verdi.'}[code]
                return self.reply(502, {'error': message, 'code': code, 'status': error.code})
            except (urllib.error.URLError, TimeoutError):
                return self.reply(502, {'error': 'Servise ulaşılamadı veya zaman aşımı oluştu. Tekrar deneyin.', 'code': 'network'})
            except (ValueError, KeyError, TypeError):
                return self.reply(502, {'error': 'Servisin yanıtı anlaşılamadı.', 'code': 'response'})
        if path == "/api/google-search":
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0].strip()
            if not 3 <= len(query) <= 500:
                return self.reply(400, {"error": "Geçerli bir adres girin."})
            with LOCK:
                key = os.environ.get("GOOGLE_MAPS_API_KEY") or read_settings().get("gkey")
            if not key:
                return self.reply(503, {"error": "Otomatik Google araması için Ayarlar’dan Places API (New) anahtarı ekleyin. Google Haritalar’da açarak elle de teyit edebilirsiniz."})
            try:
                return self.reply(200, {"places": google_search(query, key)})
            except urllib.error.HTTPError as error:
                return self.reply(502, {"error": "Google araması reddedildi. Anahtarı, Places API (New) iznini ve kotayı kontrol edin.", "status": error.code})
            except (urllib.error.URLError, TimeoutError, ValueError):
                return self.reply(502, {"error": "Google aramasına ulaşılamadı. Tekrar deneyin veya Google Haritalar’da açın."})
        if path not in ("/", "/index.html"):
            return self.send_error(404)
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path == "/giris":
            return self.login()
        if not self.authorized():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/ocr":
            return self.ocr()
        if path == "/api/adres-duzelt":
            return self.fix_addresses()
        if path == "/api/plan":
            return self.save_plan()
        if path in ("/api/kullanici", "/api/kullanici-sil"):
            return self.manage_user(path.endswith("sil"))
        if path == "/api/yonetim/aktar":
            return self.import_records()
        if path == "/api/fiyat" and not is_admin(self.user):
            self.drain_body()
            return self.reply(403, {"error": "Fiyat tablosunu yalnızca yönetici değiştirebilir.", "code": "forbidden"})
        if path in ("/api/fiyat", "/api/rut"):
            return self.save_record(path)
        if path == "/api/evrak":
            return self.save_evrak()
        if path in ("/api/yakit", "/api/yakit-sil"):
            return self.save_fuel(path.endswith("sil"))
        if path in ("/api/trafik-matris", "/api/trafik-rota"):
            return self.traffic(path.endswith("matris"))
        if path != "/ayarlar":
            return self.send_error(404)
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size < 0 or size > 16384:
                return self.reply(400, {"error": "Geçersiz istek."})
            new = json.loads(self.rfile.read(size))
            if not isinstance(new, dict):
                raise ValueError()
            fields = {'ykey', 'gkey', 'geminiKey'} | {spec[1] for spec in PROVIDERS.values()}
            if any(k in fields for k in new) and not is_admin(self.user):
                return self.reply(403, {"error": "API anahtarlarını yalnızca yönetici değiştirebilir.", "code": "forbidden"})
            points = {k: new.pop(k) for k in ("depot", "home") if k in new}
            if points and auth_enabled():
                for v in points.values():
                    if v is not None and not (isinstance(v, dict) and -90 <= float(v.get("lat")) <= 90 and -180 <= float(v.get("lon")) <= 180):
                        raise ValueError()
                key = "noktalar:" + depo._safe(self.user)
                saved = json.loads(depo.get_setting(key) or "{}")
                saved.update({k: ({"lat": float(v["lat"]), "lon": float(v["lon"])} if v else None) for k, v in points.items()})
                depo.set_setting(key, json.dumps(saved))
            elif points:
                new.update(points)
            with LOCK:
                old = read_settings()
                if any(not isinstance(v, str) or len(v) > 4096 for k, v in new.items() if k in fields):
                    raise ValueError()
                old.update({k: v.strip() if k in fields else v for k, v in new.items() if k in fields | {'depot', 'home'}})
                temporary = AYAR + ".tmp"
                with open(temporary, "w", encoding="utf-8") as f:
                    json.dump(old, f, ensure_ascii=False, indent=2)
                os.replace(temporary, AYAR)
            self.send_response(204)
            self.end_headers()
        except (ValueError, OSError, TypeError):
            self.reply(400, {"error": "Ayar kaydedilemedi."})

    def user_points(self, shared):
        """Depo ve ev kullanıcıya özeldir. Kaydı yoksa: depo ortak varsayılandan, ev yalnızca yöneticiye varsayılandan gelir."""
        if not auth_enabled():
            return {}
        try:
            own = json.loads(depo.get_setting("noktalar:" + depo._safe(self.user)) or "{}")
        except (OSError, ValueError):
            own = {}
        return {"depot": own.get("depot") or shared.get("depot"),
                "home": own.get("home") or (shared.get("home") if is_admin(self.user) else None)}

    def user_list(self):
        rows = [{"ad": n, "sabit": True, "yonetici": n in admins()} for n in USERS]
        rows += [{"ad": n, "sabit": False, "yonetici": n in admins(), "olusturma": v.get("olusturma")}
                 for n, v in db_users(fresh=True).items() if n not in USERS]
        return rows

    def import_records(self):
        """Yönetici: başka bir kullanıcının hesabına günlük kayıt ve yakıt aktarır (ör. RutPro dışa aktarımı).
        {kullanici, rutlar:[{tarih, rut}], yakitlar:[{tarih, tutar}]} — aynı günün kaydı güncellenir, aynı tarih+tutarlı yakıt tekrar eklenmez."""
        if not is_admin(self.user):
            self.drain_body()
            return self.reply(403, {"error": "Bu işlem yalnızca yönetici içindir.", "code": "forbidden"})
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 2 * 1024 * 1024:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            name = str(body.get("kullanici", "")).strip().casefold()
            if not (name in USERS or USER_NAME.fullmatch(name)):
                raise ValueError()
            day = re.compile(r"\d{4}-\d{2}-\d{2}")
            rutlar = [(str(r["tarih"]), r["rut"]) for r in body.get("rutlar", [])]
            yakitlar = [(str(y["tarih"]), float(y["tutar"])) for y in body.get("yakitlar", [])]
            if any(not day.fullmatch(t) or not isinstance(r, dict) for t, r in rutlar) or any(not day.fullmatch(t) or not 0 < v <= 1000000 for t, v in yakitlar):
                raise ValueError()
            for t, r in rutlar:
                depo.save_rut(name, t, json.dumps(r, ensure_ascii=False))
            known, added = {}, 0
            for t, v in yakitlar:
                ay = t[:7]
                if ay not in known:
                    known[ay] = {(y["tarih"], round(float(y["tutar"]), 2)) for y in depo.list_yakitlar(name, ay)}
                if (t, round(v, 2)) not in known[ay]:
                    depo.save_yakit(name, {"tarih": t, "tutar": v, "litre": None, "km": None, "notu": "aktarım"})
                    known[ay].add((t, round(v, 2)))
                    added += 1
        except (ValueError, TypeError, KeyError, AttributeError):
            return self.reply(400, {"error": "Geçersiz aktarım.", "code": "invalid_request"})
        except OSError:
            return self.reply(502, {"error": "Kaydedilemedi (veritabanı).", "code": "storage"})
        return self.reply(200, {"kullanici": name, "rut": len(rutlar), "yakit": added})

    def manage_user(self, delete):
        """Yönetici: POST /api/kullanici {ad, sifre} ekler/şifre değiştirir; /api/kullanici-sil {ad, veriler} siler."""
        if not is_admin(self.user) or not USERS:
            self.drain_body()
            return self.reply(403, {"error": "Bu işlem yalnızca yönetici içindir.", "code": "forbidden"})
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 4096:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            name = str(body.get("ad", "")).strip().casefold()
            if not USER_NAME.fullmatch(name):
                return self.reply(400, {"error": "Kullanıcı adı 2–32 karakter olmalı; harfle başlamalı, yalnızca harf, rakam, nokta, - ve _ içermeli.", "code": "invalid_name"})
            if name in USERS:
                return self.reply(400, {"error": "Bu kullanıcı Render ayarında (ROTA_KULLANICILAR) tanımlı; oradan değiştirilir.", "code": "fixed_user"})
            existing = db_users(fresh=True)
            if delete:
                if name not in existing:
                    return self.reply(404, {"error": "Kullanıcı bulunamadı.", "code": "not_found"})
                depo.delete_user(name, bool(body.get("veriler")))
            else:
                pw = str(body.get("sifre", ""))
                if len(pw) < 6 or len(pw) > 128:
                    return self.reply(400, {"error": "Şifre en az 6 karakter olmalı.", "code": "weak_password"})
                # verileri ayrı tutmak için kayıt anahtarı (Türkçe harfler sadeleşir) başka kullanıcıyla çakışmamalı
                if name not in existing and any(depo._safe(n) == depo._safe(name) for n in list(USERS) + list(existing)):
                    return self.reply(400, {"error": "Bu ad mevcut bir kullanıcıya çok benziyor; farklı bir ad seçin.", "code": "name_clash"})
                depo.save_user(name, hash_password(pw))
            db_users(fresh=True)
        except (ValueError, TypeError, AttributeError):
            return self.reply(400, {"error": "Geçersiz istek.", "code": "invalid_request"})
        except OSError:
            return self.reply(502, {"error": "Kaydedilemedi (veritabanı).", "code": "storage"})
        return self.reply(200, {"kullanicilar": self.user_list()})

    def ocr(self):
        """Evrak fotoğrafını (base64) Gemini ile okuyup satırları döndürür."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 12 * 1024 * 1024:
                return self.reply(400, {"error": "Fotoğraf çok büyük veya boş.", "code": "invalid_request"})
            body = json.loads(self.rfile.read(size))
            image, mime = body.get("image", ""), body.get("mime", "image/jpeg")
            if not isinstance(image, str) or len(image) < 100 or mime not in ("image/jpeg", "image/png", "image/webp"):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            return self.reply(400, {"error": "Geçersiz fotoğraf.", "code": "invalid_request"})
        with LOCK:
            key = gemini_key(read_settings())
        if not key:
            return self.reply(503, {"error": "Fotoğraf okuma için Ayarlar’dan Gemini anahtarı ekleyin.", "code": "missing_key"})
        try:
            return self.reply(200, {"rows": read_document(image, mime, key)})
        except OkumaHatasi as error:
            return self.reply(502, {"error": str(error), "code": error.code})
        except (urllib.error.URLError, TimeoutError):
            return self.reply(502, {"error": "Gemini’ye ulaşılamadı veya zaman aşımı oluştu.", "code": "network"})

    def save_fuel(self, delete):
        """POST /api/yakit {id?, tarih, litre, tutar, km, notu} → {id};  POST /api/yakit-sil {id}."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 16 * 1024:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            if delete:
                depo.delete_yakit(self.user, int(body["id"]))
                self.send_response(204)
                self.end_headers()
                return
            num = lambda v, lo, hi: None if v in (None, "") else (float(v) if lo <= float(v) <= hi else (_ for _ in ()).throw(ValueError()))
            item = {"tarih": str(body["tarih"]), "litre": num(body.get("litre"), 0, 5000), "tutar": num(body["tutar"], 0, 1000000),
                    "km": None if body.get("km") in (None, "") else int(num(body.get("km"), 0, 10000000)), "notu": str(body.get("notu") or "")[:200]}
            if body.get("id"):
                item["id"] = int(body["id"])
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item["tarih"]) or item["tutar"] is None:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            return self.reply(400, {"error": "Geçersiz yakıt kaydı.", "code": "invalid_request"})
        except OSError:
            return self.reply(502, {"error": "Silinemedi (veritabanı).", "code": "storage"})
        try:
            return self.reply(200, {"id": depo.save_yakit(self.user, item)})
        except OSError:
            return self.reply(502, {"error": "Yakıt kaydedilemedi (veritabanı).", "code": "storage"})

    def save_evrak(self):
        """POST /api/evrak {tarih, ad, mime, data(base64)} → {id}. Fotoğraf sayfada sıkıştırılıp gönderilir."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 6 * 1024 * 1024:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            tarih, ad, mime = str(body["tarih"]), str(body.get("ad", "evrak"))[:200], str(body["mime"])
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", tarih) or mime not in ("image/jpeg", "image/png", "image/webp", "text/csv",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"):
                raise ValueError()
            data = base64.b64decode(body["data"], validate=True)
            if not 0 < len(data) <= 4 * 1024 * 1024:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            return self.reply(400, {"error": "Geçersiz evrak.", "code": "invalid_request"})
        try:
            return self.reply(200, {"id": depo.save_evrak(self.user, tarih, ad, mime, data)})
        except OSError:
            return self.reply(502, {"error": "Evrak kaydedilemedi (veritabanı).", "code": "storage"})

    def save_record(self, path):
        """POST /api/fiyat {fiyat:{...}} ortak fiyat tablosu; POST /api/rut {tarih, rut:{...}|null, evraklar?:"sil"} günlük kayıt."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 256 * 1024:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            if path == "/api/fiyat":
                fiyat = body.get("fiyat")
                if not isinstance(fiyat, dict) or not all(isinstance(fiyat.get(b), list) and len(fiyat[b]) == 2 for b in ("anadolu", "avrupa1", "avrupa2")):
                    raise ValueError()
                for b in ("anadolu", "avrupa1", "avrupa2"):
                    for row in fiyat[b]:
                        if not (0 < float(row["nokta"]) <= 1000 and 0 <= float(row["tl"]) <= 1000000):
                            raise ValueError()
                if not (0 <= float(fiyat.get("ekstraNokta", 150)) <= 100000 and 0 <= float(fiyat.get("kdv", 20)) <= 100):
                    raise ValueError()
                depo.set_setting("fiyat", json.dumps(fiyat, ensure_ascii=False))
            else:
                tarih, rut = str(body.get("tarih", "")), body.get("rut")
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", tarih) or (rut is not None and not isinstance(rut, dict)):
                    raise ValueError()
                depo.save_rut(self.user, tarih, None if rut is None else json.dumps(rut, ensure_ascii=False))
                if rut is None and body.get("evraklar") == "sil":
                    depo.delete_evraklar(self.user, tarih)
        except (ValueError, TypeError, KeyError, AttributeError):
            return self.reply(400, {"error": "Geçersiz kayıt.", "code": "invalid_request"})
        except OSError:
            return self.reply(502, {"error": "Kaydedilemedi (veritabanı).", "code": "storage"})
        self.send_response(204)
        self.end_headers()

    def save_plan(self):
        """Kullanıcının planını kaydeder; {"plan": null} planı siler."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 3 * 1024 * 1024:
                raise ValueError()
            body = json.loads(self.rfile.read(size))
            plan = body.get("plan")
            if plan is not None and not isinstance(plan, dict):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            return self.reply(400, {"error": "Geçersiz plan.", "code": "invalid_request"})
        try:
            depo.save(self.user, None if plan is None else json.dumps(plan, ensure_ascii=False, separators=(",", ":")))
        except (OSError, ValueError):
            return self.reply(502, {"error": "Plan kaydedilemedi (veritabanı).", "code": "storage"})
        self.send_response(204)
        self.end_headers()

    def traffic(self, is_matrix):
        """TomTom canlı trafik: süre tablosu (sıralama için) ya da sıralı rota (varış saatleri için)."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 256 * 1024:
                raise ValueError()
            pts = json.loads(self.rfile.read(size)).get("points")
            if not isinstance(pts, list) or not 2 <= len(pts) <= (150 if is_matrix else 150):
                raise ValueError()
            pts = [[float(p[0]), float(p[1])] for p in pts]
            if not all(35 <= la <= 43 and 25 <= lo <= 45 for la, lo in pts):
                raise ValueError()
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            return self.reply(400, {"error": "Geçersiz nokta listesi.", "code": "invalid_request"})
        with LOCK:
            key = key_for("tomtom", read_settings())
        if not key:
            return self.reply(503, {"error": "Trafik için TomTom anahtarı gerekli.", "code": "missing_key"})
        try:
            return self.reply(200, trafik.matrix(pts, key) if is_matrix else trafik.route(pts, key))
        except urllib.error.HTTPError as error:
            code = "auth" if error.code in (401, 403) else "quota" if error.code == 429 else "upstream"
            msg = {"auth": "TomTom anahtarı trafik/rota hizmetine izin vermiyor.", "quota": "TomTom günlük ücretsiz kotası doldu; trafiksiz hesaplanıyor.",
                   "upstream": "TomTom trafik servisi geçici olarak hata verdi."}[code]
            return self.reply(502, {"error": msg, "code": code, "status": error.code})
        except (urllib.error.URLError, TimeoutError):
            return self.reply(502, {"error": "TomTom’a ulaşılamadı.", "code": "network"})
        except (ValueError, KeyError, TypeError, IndexError):
            return self.reply(502, {"error": "TomTom yanıtı anlaşılamadı.", "code": "response"})

    def fix_addresses(self):
        """Adres listesini Gemini ile düzeltir (yazım hataları, sokak/no ayrımı)."""
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 512 * 1024:
                raise ValueError()
            items = json.loads(self.rfile.read(size)).get("items")
            if not isinstance(items, list) or not 1 <= len(items) <= 150:
                raise ValueError()
            items = [{"id": str(i["id"])[:20], "adres": str(i["adres"])[:500], "ilce": str(i.get("ilce", ""))[:40]} for i in items]
        except (ValueError, TypeError, KeyError, AttributeError):
            return self.reply(400, {"error": "Geçersiz adres listesi.", "code": "invalid_request"})
        with LOCK:
            key = gemini_key(read_settings())
        if not key:
            return self.reply(503, {"error": "Adres düzeltme için Gemini anahtarı gerekli.", "code": "missing_key"})
        try:
            return self.reply(200, {"items": normalize_addresses(items, key)})
        except OkumaHatasi as error:
            return self.reply(502, {"error": str(error), "code": error.code})
        except (urllib.error.URLError, TimeoutError):
            return self.reply(502, {"error": "Gemini’ye ulaşılamadı.", "code": "network"})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    try:
        server = socketserver.ThreadingTCPServer((HOST, PORT), Handler)
    except OSError:
        if HOST != "127.0.0.1":
            raise
        webbrowser.open(f"http://localhost:{PORT}/index.html")
        return
    print(f"Rota Oluşturucu çalışıyor: http://localhost:{PORT}")
    if not os.environ.get("ROTA_NOBROWSER") and HOST == "127.0.0.1":
        webbrowser.open(f"http://localhost:{PORT}/index.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
