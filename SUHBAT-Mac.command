#!/bin/bash
# SUHBAT — macOS / Linux uchun ishga tushirish (ikki marta bosing).
cd "$(dirname "$0")/apps/local" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js o'rnatilmagan."
  echo "  https://nodejs.org saytidan \"LTS\" versiyasini o'rnating va shu faylni qayta ishga tushiring."
  echo
  command -v open >/dev/null 2>&1 && open "https://nodejs.org/"
  read -r -p "  Yopish uchun Enter bosing..."
  exit 1
fi

if [ ! -f "node_modules/@anthropic-ai/sdk/package.json" ]; then
  echo
  echo "  Birinchi ishga tushirish: kerakli fayllar yuklanmoqda (1-2 daqiqa, internet kerak)..."
  echo
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo
    echo "  Yuklab bo'lmadi. Internetni tekshirib, qayta urinib ko'ring."
    read -r -p "  Yopish uchun Enter bosing..."
    exit 1
  fi
fi

echo
echo "  SUHBAT ishga tushmoqda. Bu oynani YOPMANG — suhbat tugaguncha ochiq tursin."
echo
node server.mjs
echo
read -r -p "  Dastur to'xtadi. Yopish uchun Enter bosing..."
