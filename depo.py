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
