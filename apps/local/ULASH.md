# Sizdan nima kerak (ulash ro‘yxati)

Kod tayyor va sinovdan o‘tgan. Quyidagilar faqat **sizning hisoblaringiz va kompyuteringiz** bilan bog‘liq —
shularni ulasangiz, ishlaydi. Tartib bilan, har biri 1–5 daqiqa.

> **Ikki yo‘l bor.** Shu kompyuterda ishlatish uchun quyidagi 1–5-qadamlar yetadi.
> Hetzner serveriga qo‘yish uchun 1-qadam o‘rniga **[HETZNER.md](HETZNER.md)** ni dasturchiga bering
> (unga yana domen kerak bo‘ladi), 2–5-qadamlar o‘zgarmaydi.

## 1. Kompyuterga Node.js (bir marta)

- https://nodejs.org → **LTS** versiyani yuklab o‘rnating. Boshqa hech narsa kerak emas.

## 2. ElevenLabs kaliti — nutqni matnga aylantirish

1. https://elevenlabs.io da hisob oching / kiring.
2. Profil → **API Keys** → yangi kalit yarating. Ruxsatlarda **Speech to Text** yoqilgan bo‘lsin.
3. Hisobda yetarli balans / tarif bo‘lsin (1 soat suhbat ≈ 1 soat audio hisobida).
4. Kalitni **SUHBAT → ⚙ Sozlamalar → ElevenLabs API kaliti** ga qo‘ying.

## 3. Anthropic (Claude) kaliti — tahlil

1. https://console.anthropic.com → **API Keys** → yangi kalit.
2. **Billing** bo‘limida balans to‘ldiring (3–5 soatlik suhbat tahlili odatda bir necha dollar).
3. Kalitni **Sozlamalar → Anthropic (Claude) API kaliti** ga qo‘ying.

> Ikkala kalitni kiritgach **«Saqlash va tekshirish»** ni bosing — ikkalasi yashil ✓ bo‘lishi kerak.
> Qizil ✕ bo‘lsa, yonida sababi yoziladi.

## 4. Birinchi haqiqiy sinov (10 daqiqa)

1. `SUHBAT-Windows.bat` (yoki Mac’da `SUHBAT-Mac.command`) ni ishga tushiring.
2. **START** → 2–3 daqiqa o‘zbekcha gaplashing (ikki kishi bo‘lsa yaxshi) → **STOP**.
3. Prezentatsiya chiqishini kuting va ichidagi ismlar, vazifalar to‘g‘ri chiqqanini tekshiring.
4. Muammo bo‘lsa — menga shu sinovning natijasini (xato matni yoki skrinshot) yuboring.

## 5. Sozlamalarda to‘ldiring (tahlil sifati uchun)

- **Kompaniyangiz nomi** va **jamoa a’zolari** (ism va lavozim) — shunda «biz» tomonni to‘g‘ri ajratadi.

## Keyinroq (hozir shart emas)

- Zoom / Google Meet / Telegram integratsiyasi — alohida bosqich.
- Mijozga yuborish uchun domen/hosting kerak bo‘lsa — hozircha `presentation.html` faylini to‘g‘ridan-to‘g‘ri yuborasiz.
