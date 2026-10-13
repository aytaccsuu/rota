-- İş bulma: firma listesi, teklif e-postaları, gönderim kaydı
CREATE TABLE IF NOT EXISTS firmalar (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anahtar      TEXT NOT NULL UNIQUE,          -- tekrar eklenmesin: alan adı ya da Google/OSM kimliği
  ad           TEXT NOT NULL,
  sektor       TEXT NOT NULL DEFAULT '',
  il           TEXT NOT NULL DEFAULT '',
  ilce         TEXT NOT NULL DEFAULT '',
  adres        TEXT NOT NULL DEFAULT '',
  telefon      TEXT NOT NULL DEFAULT '',
  web          TEXT NOT NULL DEFAULT '',
  eposta       TEXT NOT NULL DEFAULT '',
  kaynak       TEXT NOT NULL DEFAULT '',
  -- arama: e-posta aranacak · eposta_yok · hazir: onay bekliyor · gonderildi · takip_hazir · takip_gonderildi
  -- cevap · olumlu · olumsuz · red: listeden çıktı · iptal: gönderilmeyecek · hata
  durum        TEXT NOT NULL DEFAULT 'arama',
  konu         TEXT NOT NULL DEFAULT '',
  metin        TEXT NOT NULL DEFAULT '',
  takip_sayisi INTEGER NOT NULL DEFAULT 0,
  ilk_gonderim TEXT,
  son_gonderim TEXT,
  notu         TEXT NOT NULL DEFAULT '',
  hata         TEXT NOT NULL DEFAULT '',
  olusturma    TEXT NOT NULL DEFAULT (datetime('now')),
  guncelleme   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS firmalar_durum ON firmalar (durum);
CREATE INDEX IF NOT EXISTS firmalar_eposta ON firmalar (eposta);
CREATE TABLE IF NOT EXISTS gonderimler (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  firma_id  INTEGER NOT NULL,
  eposta    TEXT NOT NULL,
  tur       TEXT NOT NULL,                     -- ilk · takip
  konu      TEXT NOT NULL,
  zaman     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS gonderimler_zaman ON gonderimler (zaman);
-- "Listeden çıkar" diyen adresler: bir daha hiçbir firma kaydından mail gitmez
CREATE TABLE IF NOT EXISTS engelli_epostalar (
  eposta    TEXT PRIMARY KEY,
  zaman     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ayarlar (
  anahtar    TEXT PRIMARY KEY,
  deger      TEXT NOT NULL,
  guncelleme TEXT NOT NULL DEFAULT (datetime('now'))
);
