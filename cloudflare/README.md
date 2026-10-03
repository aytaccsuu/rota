# Rota Planı — Cloudflare sürümü

Render/Python sürümüyle (`../sunucu.py`) aynı uç noktaları sunan Cloudflare Worker. Arayüz aynıdır (`../index.html`, `../giris.html` derleme sırasında `public/` altına kopyalanır).

- **Workers**: sunucu (uyumaz)
- **D1**: veritabanı (`migrations/`)
- **R2** (isteğe bağlı): evrak görselleri; yoksa görseller D1'de tutulur
- **Workers AI**: Gemini kotası dolduğunda evrak okuma ve adres düzeltme yedeği

## Yerel çalıştırma
```
npm install
npm run db:local
npm run dev            # http://127.0.0.1:8787  (.dev.vars: ROTA_KULLANICILAR=aytac:...,baran:...)
python test_sozlesme.py
```

## Yayına alma (bir kez)
```
npx wrangler login
npx wrangler d1 create rota-plani      # çıkan database_id → wrangler.toml
npm run db:remote
npm run deploy
```
Gizli ayarlar Cloudflare panelinde (Workers → rota-plani → Settings → Variables and Secrets) "Secret" olarak girilir:
`ROTA_KULLANICILAR`, `ROTA_GIZLI`, `YANDEX_MAPS_JS_KEY`, `YANDEX_GEOCODER_API_KEY`, `TOMTOM_API_KEY`, `MAPTILER_API_KEY`, `GEOAPIFY_API_KEY`, `GEMINI_API_KEY`, `ORS_API_KEY`.
Düz ayarlar: `DEPO_KOORDINAT`, `EV_KOORDINAT`, `ROTA_YONETICI` (varsayılan aytac).

## Neon'dan taşıma
`TASIMA_ACIK=1` ayarını aç → `python tasi_neon.py` (DATABASE_URL ve CF_URL ile) → ayarı kapat.
