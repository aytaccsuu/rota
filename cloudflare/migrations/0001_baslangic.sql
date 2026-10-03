-- Rota Planı D1 şeması (PostgreSQL sürümünün SQLite karşılığı)
CREATE TABLE IF NOT EXISTS planlar (
  kullanici  TEXT PRIMARY KEY,
  veri       TEXT NOT NULL,
  guncelleme TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ayarlar (
  anahtar    TEXT PRIMARY KEY,
  deger      TEXT NOT NULL,
  guncelleme TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rutlar (
  kullanici  TEXT NOT NULL,
  tarih      TEXT NOT NULL,
  veri       TEXT NOT NULL,
  guncelleme TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kullanici, tarih)
);
CREATE TABLE IF NOT EXISTS evraklar (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kullanici  TEXT NOT NULL,
  tarih      TEXT NOT NULL,
  ad         TEXT NOT NULL,
  mime       TEXT NOT NULL,
  veri       BLOB,
  r2         INTEGER NOT NULL DEFAULT 0,
  olusturma  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS evraklar_kullanici_tarih ON evraklar (kullanici, tarih);
CREATE TABLE IF NOT EXISTS yakitlar (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kullanici  TEXT NOT NULL,
  tarih      TEXT NOT NULL,
  litre      REAL,
  tutar      REAL NOT NULL,
  km         INTEGER,
  notu       TEXT,
  olusturma  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS yakitlar_kullanici_tarih ON yakitlar (kullanici, tarih);
CREATE TABLE IF NOT EXISTS kullanicilar (
  ad         TEXT PRIMARY KEY,
  sifre      TEXT NOT NULL,
  olusturma  TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS konumlar (
  anahtar    TEXT PRIMARY KEY,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  kaynak     TEXT NOT NULL,
  dogruluk   REAL,
  adres      TEXT,
  kullanici  TEXT,
  sayac      INTEGER NOT NULL DEFAULT 1,
  guncelleme TEXT NOT NULL DEFAULT (datetime('now'))
);
