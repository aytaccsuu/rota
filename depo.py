"""Kalıcı veri: kullanıcının günlük planı (duraklar, konumlar, sıra, teslim edilenler).

DATABASE_URL tanımlıysa PostgreSQL'de (ör. Neon ücretsiz planı) saklanır; değilse "planlar/" klasöründe.
Render'ın ücretsiz sunucusunda dosyalar kalıcı değildir; yayında DATABASE_URL tanımlanmalıdır.
Yeni özellikler için tablolar SCHEMA listesine eklenir; sunucu ilk bağlantıda eksik tabloları oluşturur.
"""
import json
import os
import re
import threading

KLASOR = os.path.dirname(os.path.abspath(__file__))
PLAN_DIR = os.path.join(KLASOR, "planlar")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS planlar (
        kullanici  TEXT PRIMARY KEY,
        veri       JSONB NOT NULL,
        guncelleme TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    # Ortak ayarlar (ör. "fiyat": bölge/ilçe fiyat tablosu) — bütün kullanıcılar aynı değeri görür
    """CREATE TABLE IF NOT EXISTS ayarlar (
        anahtar    TEXT PRIMARY KEY,
        deger      JSONB NOT NULL,
        guncelleme TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    # Günlük rut kayıtları (hakediş): kullanıcı başına günde bir kayıt
    """CREATE TABLE IF NOT EXISTS rutlar (
        kullanici  TEXT NOT NULL,
        tarih      DATE NOT NULL,
        veri       JSONB NOT NULL,
        guncelleme TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kullanici, tarih)
    )""",
    # Yüklenen evrak fotoğrafları/dosyaları (geçmişte görmek için; sıkıştırılmış)
    """CREATE TABLE IF NOT EXISTS evraklar (
        id         BIGSERIAL PRIMARY KEY,
        kullanici  TEXT NOT NULL,
        tarih      DATE NOT NULL,
        ad         TEXT NOT NULL,
        mime       TEXT NOT NULL,
        veri       BYTEA NOT NULL,
        olusturma  TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    "CREATE INDEX IF NOT EXISTS evraklar_kullanici_tarih ON evraklar (kullanici, tarih)",
    # Yakıt alımları (günde birden fazla olabilir)
    """CREATE TABLE IF NOT EXISTS yakitlar (
        id         BIGSERIAL PRIMARY KEY,
        kullanici  TEXT NOT NULL,
        tarih      DATE NOT NULL,
        litre      NUMERIC(10,2),
        tutar      NUMERIC(12,2) NOT NULL,
        km         INTEGER,
        notu       TEXT,
        olusturma  TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    "CREATE INDEX IF NOT EXISTS yakitlar_kullanici_tarih ON yakitlar (kullanici, tarih)",
]

_ready = False
_lock = threading.Lock()


def _url():
    return os.environ.get("DATABASE_URL", "").strip()


def backend():
    return "postgres" if _url() else "dosya"


def _safe(user):
    return re.sub(r"[^a-z0-9_-]", "_", (user or "yerel").casefold())[:40] or "yerel"


def _connect():
    """PostgreSQL bağlantısı; ilk seferde tabloları oluşturur. Hatalar OSError olarak yükseltilir."""
    global _ready
    try:
        import psycopg
    except ImportError as error:
        raise OSError("PostgreSQL sürücüsü (psycopg) kurulu değil") from error
    try:
        conn = psycopg.connect(_url(), connect_timeout=15, autocommit=True)
        if not _ready:
            with _lock:
                if not _ready:
                    with conn.cursor() as cur:
                        for statement in SCHEMA:
                            cur.execute(statement)
                    _ready = True
        return conn
    except psycopg.Error as error:
        raise OSError("veritabanına bağlanılamadı: %s" % type(error).__name__) from error


def _run(sql, params=(), fetch=False):
    import psycopg
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone() if fetch else None
    except psycopg.Error as error:
        raise OSError("veritabanı hatası: %s" % type(error).__name__) from error
    finally:
        conn.close()


def load(user):
    """Kullanıcının kayıtlı planını JSON metni olarak döndürür; yoksa None."""
    if _url():
        row = _run("SELECT veri::text FROM planlar WHERE kullanici = %s", (_safe(user),), fetch=True)
        return row[0] if row else None
    path = os.path.join(PLAN_DIR, _safe(user) + ".json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def save(user, text):
    """Planı kaydeder (text JSON metni); text None ise planı siler."""
    if text is not None:
        json.loads(text)  # geçerli JSON değilse ValueError
    if _url():
        if text is None:
            _run("DELETE FROM planlar WHERE kullanici = %s", (_safe(user),))
        else:
            _run("""INSERT INTO planlar (kullanici, veri, guncelleme) VALUES (%s, %s::jsonb, now())
                    ON CONFLICT (kullanici) DO UPDATE SET veri = EXCLUDED.veri, guncelleme = now()""", (_safe(user), text))
        return
    os.makedirs(PLAN_DIR, exist_ok=True)
    path = os.path.join(PLAN_DIR, _safe(user) + ".json")
    if text is None:
        if os.path.exists(path):
            os.remove(path)
        return
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ---------- ortak ayarlar ----------
def _file(name):
    os.makedirs(PLAN_DIR, exist_ok=True)
    return os.path.join(PLAN_DIR, name)


def get_setting(key):
    """Ayarı JSON metni olarak döndürür; yoksa None."""
    if _url():
        row = _run("SELECT deger::text FROM ayarlar WHERE anahtar = %s", (key,), fetch=True)
        return row[0] if row else None
    path = _file("_ayar_" + _safe(key) + ".json")
    return open(path, encoding="utf-8").read() if os.path.exists(path) else None


def set_setting(key, text):
    json.loads(text)
    if _url():
        _run("""INSERT INTO ayarlar (anahtar, deger, guncelleme) VALUES (%s, %s::jsonb, now())
                ON CONFLICT (anahtar) DO UPDATE SET deger = EXCLUDED.deger, guncelleme = now()""", (key, text))
        return
    with open(_file("_ayar_" + _safe(key) + ".json"), "w", encoding="utf-8") as f:
        f.write(text)


# ---------- günlük rut kayıtları ----------
def save_rut(user, tarih, text):
    """Kullanıcının o günkü rut kaydını yazar (aynı gün tekrar yazılırsa güncellenir); text None ise siler."""
    if text is not None:
        json.loads(text)
    if _url():
        if text is None:
            _run("DELETE FROM rutlar WHERE kullanici = %s AND tarih = %s", (_safe(user), tarih))
        else:
            _run("""INSERT INTO rutlar (kullanici, tarih, veri, guncelleme) VALUES (%s, %s, %s::jsonb, now())
                    ON CONFLICT (kullanici, tarih) DO UPDATE SET veri = EXCLUDED.veri, guncelleme = now()""", (_safe(user), tarih, text))
        return
    path = _file("_rutlar_" + _safe(user) + ".json")
    data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    if text is None:
        data.pop(tarih, None)
    else:
        data[tarih] = json.loads(text)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def _fetchall(sql, params):
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except Exception as error:
        raise OSError("veritabanı hatası: %s" % type(error).__name__) from error
    finally:
        conn.close()


def list_rutlar(user, ay):
    """Ayın kayıtları ("2026-10"): [{"tarih": "2026-10-01", ...veri}], tarihe göre."""
    if _url():
        rows = _fetchall("""SELECT to_char(tarih, 'YYYY-MM-DD'), veri::text FROM rutlar
                            WHERE kullanici = %s AND to_char(tarih, 'YYYY-MM') = %s ORDER BY tarih""", (_safe(user), ay))
        return [{"tarih": t, **json.loads(v)} for t, v in rows]
    path = _file("_rutlar_" + _safe(user) + ".json")
    data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    return [{"tarih": t, **v} for t, v in sorted(data.items()) if t.startswith(ay)]


# ---------- yakıt ----------
def save_yakit(user, item):
    """item: {id?, tarih, litre, tutar, km, notu}. id varsa günceller. Kimliği döndürür."""
    u = _safe(user)
    if _url():
        if item.get("id"):
            _run("""UPDATE yakitlar SET tarih=%s, litre=%s, tutar=%s, km=%s, notu=%s WHERE id=%s AND kullanici=%s""",
                 (item["tarih"], item.get("litre"), item["tutar"], item.get("km"), item.get("notu"), int(item["id"]), u))
            return int(item["id"])
        rows = _fetchall("""INSERT INTO yakitlar (kullanici, tarih, litre, tutar, km, notu) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
                         (u, item["tarih"], item.get("litre"), item["tutar"], item.get("km"), item.get("notu")))
        return rows[0][0]
    path = _file("_yakit_" + u + ".json")
    data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    if item.get("id"):
        data = [{**d, **item} if d["id"] == int(item["id"]) else d for d in data]
        new_id = int(item["id"])
    else:
        new_id = max([d["id"] for d in data] or [0]) + 1
        data.append({**item, "id": new_id})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return new_id


def delete_yakit(user, yakit_id):
    u = _safe(user)
    if _url():
        _run("DELETE FROM yakitlar WHERE id=%s AND kullanici=%s", (int(yakit_id), u))
        return
    path = _file("_yakit_" + u + ".json")
    data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    with open(path, "w", encoding="utf-8") as f:
        json.dump([d for d in data if d["id"] != int(yakit_id)], f, ensure_ascii=False)


def list_yakitlar(user, ay):
    u = _safe(user)
    if _url():
        rows = _fetchall("""SELECT id, to_char(tarih,'YYYY-MM-DD'), litre, tutar, km, notu FROM yakitlar
                            WHERE kullanici=%s AND to_char(tarih,'YYYY-MM')=%s ORDER BY tarih, id""", (u, ay))
        return [{"id": r[0], "tarih": r[1], "litre": float(r[2]) if r[2] is not None else None, "tutar": float(r[3]),
                 "km": r[4], "notu": r[5]} for r in rows]
    path = _file("_yakit_" + u + ".json")
    data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    return sorted([d for d in data if d["tarih"].startswith(ay)], key=lambda d: (d["tarih"], d["id"]))


# ---------- evrak dosyaları ----------
def save_evrak(user, tarih, ad, mime, data):
    """Evrakı saklar, kimliğini (int) döndürür."""
    if _url():
        conn = _connect()
        try:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO evraklar (kullanici, tarih, ad, mime, veri) VALUES (%s, %s, %s, %s, %s) RETURNING id",
                            (_safe(user), tarih, ad[:200], mime, data))
                return cur.fetchone()[0]
        except Exception as error:
            raise OSError("veritabanı hatası: %s" % type(error).__name__) from error
        finally:
            conn.close()
    index_path = _file("_evrak_" + _safe(user) + ".json")
    index = json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else []
    new_id = max([e["id"] for e in index] or [0]) + 1
    with open(_file("_evrak_%s_%d.bin" % (_safe(user), new_id)), "wb") as f:
        f.write(data)
    index.append({"id": new_id, "tarih": tarih, "ad": ad[:200], "mime": mime})
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    return new_id


def delete_evraklar(user, tarih):
    """O günün bütün evraklarını siler (rota silinince)."""
    if _url():
        _run("DELETE FROM evraklar WHERE kullanici = %s AND tarih = %s", (_safe(user), tarih))
        return
    index_path = _file("_evrak_" + _safe(user) + ".json")
    index = json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else []
    for e in index:
        if e["tarih"] == tarih:
            path = _file("_evrak_%s_%d.bin" % (_safe(user), e["id"]))
            if os.path.exists(path):
                os.remove(path)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump([e for e in index if e["tarih"] != tarih], f, ensure_ascii=False)


def load_evrak(user, evrak_id):
    """(mime, bytes) — yalnızca kendi evrakı; yoksa None."""
    if _url():
        row = _run("SELECT mime, veri FROM evraklar WHERE id = %s AND kullanici = %s", (int(evrak_id), _safe(user)), fetch=True)
        return (row[0], bytes(row[1])) if row else None
    index_path = _file("_evrak_" + _safe(user) + ".json")
    index = json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else []
    item = next((e for e in index if e["id"] == int(evrak_id)), None)
    path = _file("_evrak_%s_%d.bin" % (_safe(user), int(evrak_id)))
    if not item or not os.path.exists(path):
        return None
    return item["mime"], open(path, "rb").read()
