"""TomTom ile canlı trafikli süre tablosu (matris) ve trafikli rota.

Ücretsiz planda: senkron matris en fazla 200 hücre, günde 2500 istek (hücre sayısına göre sayılır).
Aynı noktalar için sonuç 15 dakika saklanır; adres düzeltip yeniden hesaplamak kota harcamaz.
"""
import json
import threading
import time
import urllib.parse
import urllib.request

from providers import SSL_CONTEXT

CACHE_SECONDS = 15 * 60
MAX_CELLS = 200  # ücretsiz planda senkron matris sınırı
_cache = {}
_lock = threading.Lock()


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60, context=SSL_CONTEXT) as response:
        return json.load(response)


def _get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "RotaPlan/1.0"}), timeout=60, context=SSL_CONTEXT) as response:
        return json.load(response)


def depart_at(text, now=None):
    """İstemcinin gönderdiği çıkış saatini doğrular: en az 10 dk, en fazla 24 saat sonrası; 15 dakikaya yuvarlanmış UTC metni döner.
    Geçmiş/yakın saatler için None (canlı trafik kullanılır)."""
    import datetime
    if not text:
        return None
    t = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError("saat dilimi yok")
    t = t.astimezone(datetime.timezone.utc)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    delta = (t - now).total_seconds()
    if delta < 600:
        return None
    if delta > 24 * 3600:
        raise ValueError("çıkış saati çok ileri")
    t = t.replace(second=0, microsecond=0) + datetime.timedelta(minutes=(15 - t.minute % 15) % 15)  # önbellek isabeti için 15 dk'ya yukarı yuvarla
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _key(kind, points):
    return kind + "|" + ";".join("%.5f,%.5f" % (p[0], p[1]) for p in points)


def _cached(kind, points):
    with _lock:
        hit = _cache.get(_key(kind, points))
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    return None


def _store(kind, points, value):
    with _lock:
        _cache[_key(kind, points)] = (time.time(), value)
        if len(_cache) > 50:  # eski kayıtları at
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:10]:
                _cache.pop(k, None)


def blocks(n, max_cells=MAX_CELLS):
    """n×n matrisi ≤ max_cells hücrelik (origin aralığı, hedef aralığı) parçalarına böler."""
    dest = min(n, max_cells)
    orig = max(1, max_cells // dest)
    return [((o, min(o + orig, n)), (d, min(d + dest, n))) for o in range(0, n, orig) for d in range(0, n, dest)]


def matrix(points, key, traffic=True, depart=None):
    """points: [[lat, lon], ...] → {dur, dist, delay} (saniye / metre).
    traffic=True: canlı trafik, şimdiki kalkış saati. depart="2026-10-05T06:30:00Z": o saatin tahmini trafiği.
    traffic=False: trafikten bağımsız yol süreleri (yedek)."""
    kind = ("m@" + depart if depart else "m") if traffic else "m0"
    hit = _cached(kind, points)
    if hit:
        return {**hit, "cached": True}
    n = len(points)
    dur = [[0.0] * n for _ in range(n)]
    dist = [[0.0] * n for _ in range(n)]
    delay = [[0.0] * n for _ in range(n)]
    pt = lambda p: {"point": {"latitude": p[0], "longitude": p[1]}}
    for (o0, o1), (d0, d1) in blocks(n):
        data = _post("https://api.tomtom.com/routing/matrix/2?key=" + key, {
            "origins": [pt(p) for p in points[o0:o1]], "destinations": [pt(p) for p in points[d0:d1]],
            "options": {"departAt": depart, "traffic": "historical", "travelMode": "car", "routeType": "fastest"} if traffic and depart
            else {"departAt": "now", "traffic": "live", "travelMode": "car", "routeType": "fastest"} if traffic
            else {"departAt": "any", "traffic": "historical", "travelMode": "car", "routeType": "fastest"}})
        for cell in data.get("data", []):
            i, j = o0 + cell["originIndex"], d0 + cell["destinationIndex"]
            s = cell.get("routeSummary")
            if not s:
                raise ValueError("matris hücresi eksik: %d→%d" % (i, j))
            dur[i][j], dist[i][j], delay[i][j] = s["travelTimeInSeconds"], s["lengthInMeters"], s.get("trafficDelayInSeconds", 0)
    for i in range(n):
        dur[i][i] = dist[i][i] = delay[i][i] = 0
    result = {"dur": dur, "dist": dist, "delay": delay, "at": time.time()}
    _store(kind, points, result)
    return {**result, "cached": False}


ORS_MAX = 59  # openrouteservice ücretsiz planı: istek başına en fazla 3500 hücre (59×59)


def ors_matrix(points, key):
    """openrouteservice (ücretsiz anahtar) ile trafiksiz süre/mesafe tablosu."""
    hit = _cached("o", points)
    if hit:
        return hit
    if len(points) > ORS_MAX:
        raise ValueError("openrouteservice en fazla %d nokta" % ORS_MAX)
    req = urllib.request.Request("https://api.openrouteservice.org/v2/matrix/driving-car",
                                 data=json.dumps({"locations": [[p[1], p[0]] for p in points], "metrics": ["distance", "duration"], "units": "m"}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": key, "User-Agent": "RotaPlan/1.0"})
    with urllib.request.urlopen(req, timeout=60, context=SSL_CONTEXT) as response:
        data = json.load(response)
    dur, dist = data.get("durations"), data.get("distances")
    n = len(points)
    if not (isinstance(dur, list) and isinstance(dist, list) and len(dur) == n and len(dist) == n
            and all(isinstance(r, list) and len(r) == n and all(isinstance(x, (int, float)) for x in r) for r in dur + dist)):
        raise ValueError("openrouteservice yanıtı eksik (yola bağlanamayan nokta olabilir)")
    result = {"dur": dur, "dist": dist, "at": time.time()}
    _store("o", points, result)
    return result


def road_matrix(points, tomtom_key="", ors_key=""):
    """Trafiksiz yol tablosu için yedek zinciri: TomTom (trafiksiz) → openrouteservice. Hangisi kullanıldıysa 'kaynak' döner."""
    errors = []
    if tomtom_key:
        try:
            return {**matrix(points, tomtom_key, traffic=False), "kaynak": "TomTom"}
        except Exception as error:  # kota, ağ, yanıt hatası → sıradaki servis
            errors.append("TomTom: %s" % _why(error))
    if ors_key:
        try:
            return {**ors_matrix(points, ors_key), "kaynak": "openrouteservice"}
        except Exception as error:
            errors.append("openrouteservice: %s" % _why(error))
    raise LookupError("; ".join(errors) or "yol servisi anahtarı yok")


def _why(error):
    code = getattr(error, "code", None)
    return {401: "anahtar reddedildi", 403: "anahtar reddedildi", 429: "kota doldu"}.get(code, "hata %s" % code if code else type(error).__name__)


def route(points, key, depart=None):
    """Sıralı noktalar için trafikli rota: her bacağın süresi/mesafesi/gecikmesi ve çizgi. depart verilirse o saatin tahmini trafiği."""
    kind = "r@" + depart if depart else "r"
    hit = _cached(kind, points)
    if hit:
        return hit
    locs = ":".join("%.6f,%.6f" % (p[0], p[1]) for p in points)
    data = _get("https://api.tomtom.com/routing/1/calculateRoute/%s/json?key=%s&traffic=true&departAt=%s&travelMode=car&routeType=fastest" % (locs, key, urllib.parse.quote(depart or "now")))
    r = data["routes"][0]
    legs = [{"d": l["summary"]["lengthInMeters"], "t": l["summary"]["travelTimeInSeconds"], "delay": l["summary"].get("trafficDelayInSeconds", 0)} for l in r["legs"]]
    line = [[p["latitude"], p["longitude"]] for l in r["legs"] for p in l.get("points", [])]
    if len(legs) != len(points) - 1:
        raise ValueError("bacak sayısı tutmuyor")
    result = {"legs": legs, "line": line[::max(1, len(line) // 2000)]}
    _store(kind, points, result)
    return result
