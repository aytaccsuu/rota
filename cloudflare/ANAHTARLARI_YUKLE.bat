@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ROTA PLANI - Butun API anahtarlarini Cloudflare ortamina yukleme
echo  ===============================================================
echo  Degerler ANAHTARLAR.txt dosyasindan alinir (once kontrol edin).
echo.
python anahtarlari_yukle.py
echo.
pause
