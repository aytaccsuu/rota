@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ROTA PLANI - Render (Neon) verilerini Cloudflare ortamina tasima
echo  =========================================================
echo.
echo  Gerekli paket kuruluyor...
python -m pip install -q "psycopg[binary]"
echo.
echo  Neon baglanti adresini (postgresql://...) yapistirin ve Enter tusuna basin.
echo  (Yapistirmak icin pencereye sag tiklayin.)
echo.
set /p "DATABASE_URL=Adres: "
echo.
python tasi_d1.py
echo.
pause
