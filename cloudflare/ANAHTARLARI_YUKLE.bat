@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ROTA PLANI - API anahtarlarini Cloudflare ortamina yukleme
echo  ==========================================================
echo  Anahtarlar bilgisayardaki ayarlar.json dosyasindan alinir.
echo.
python anahtarlari_yukle.py
echo.
pause
