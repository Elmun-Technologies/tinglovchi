@echo off
chcp 65001 >nul
title SUHBAT
cd /d "%~dp0apps\local"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js o'rnatilmagan.
  echo  Hozir ochiladigan saytdan "LTS" versiyasini yuklab o'rnating,
  echo  so'ng shu faylni qayta ishga tushiring.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\sdk\package.json" (
  echo.
  echo  Birinchi ishga tushirish: kerakli fayllar yuklanmoqda ^(1-2 daqiqa, internet kerak^)...
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  Yuklab bo'lmadi. Internetni tekshirib, qayta urinib ko'ring.
    pause
    exit /b 1
  )
)

echo.
echo  SUHBAT ishga tushmoqda. Bu oynani YOPMANG - suhbat tugaguncha ochiq tursin.
echo.
node server.mjs
echo.
echo  Dastur to'xtadi.
pause
