"""Yerel rota uygulaması ve Google Places adres arama aracısı."""
import base64
import hmac
import http.server
import json
import os
import socketserver
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from providers import PROVIDERS, SSL_CONTEXT, key_for, provider_search
from evrak_okuma import OkumaHatasi, normalize_addresses, read_document

KLASOR = os.path.dirname(os.path.abspath(__file__))
AYAR = os.path.join(KLASOR, "ayarlar.json")
PORT = int(os.environ.get("PORT") or os.environ.get("ROTA_PORT", 8080))
HOST = os.environ.get("ROTA_HOST", "127.0.0.1")  # yayında: 0.0.0.0
SIFRE = os.environ.get("ROTA_SIFRE", "")  # doluysa site şifreyle korunur
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

    def authorized(self):
        if not SIFRE:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                _, _, given = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                if hmac.compare_digest(given.encode(), SIFRE.encode()):
                    return True
            except (ValueError, UnicodeDecodeError):
                pass
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Rota", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def do_HEAD(self):
        if not self.authorized():
            return
        super().do_HEAD()

    def do_GET(self):
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
            return self.reply(200, {**data, "providers": configured, "hints": hints, "googleConfigured": bool(os.environ.get("GOOGLE_MAPS_API_KEY") or key), "ocrConfigured": bool(gem), "ocrHint": gem[-4:] if gem else ""})
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
        if not self.authorized():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/ocr":
            return self.ocr()
        if path == "/api/adres-duzelt":
            return self.fix_addresses()
        if path != "/ayarlar":
            return self.send_error(404)
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size < 0 or size > 16384:
                return self.reply(400, {"error": "Geçersiz istek."})
            new = json.loads(self.rfile.read(size))
            if not isinstance(new, dict):
                raise ValueError()
            with LOCK:
                old = read_settings()
                fields = {'ykey', 'gkey', 'geminiKey'} | {spec[1] for spec in PROVIDERS.values()}
                if any(not isinstance(v, str) or len(v) > 4096 for k, v in new.items() if k in fields):
                    raise ValueError()
                old.update({k: v.strip() if k in fields else v for k, v in new.items() if k in fields | {'depot', 'home'}})
                temporary = AYAR + ".tmp"
                with open(temporary, "w", encoding="utf-8") as f:
                    json.dump(old, f, ensure_ascii=False, indent=2)
                os.replace(temporary, AYAR)
            self.send_response(204)
            self.end_headers()
        except (ValueError, OSError):
            self.reply(400, {"error": "Ayar kaydedilemedi."})

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
