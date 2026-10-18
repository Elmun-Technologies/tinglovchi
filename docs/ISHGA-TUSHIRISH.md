# Suhbat AI — bitta tugmali yozib olishni ishga tushirish

Bu qo‘llanma loyihaning asosiy qismini — **«bitta tugma bosiladi → butun suhbat yoziladi → oxirida tahlil»**
oqimini ishga tushirish uchun. Admin panel, Supabase, worker yoki desktop ilova kerak emas.

## Bu nima qiladi

1. Telefon yoki kompyuter brauzerida `https://<sizning-domeningiz>/yoz` ochiladi.
2. Uchrashuvdan oldin katta **«Boshlash»** tugmasi bir marta bosiladi. Telefon stol ustiga qo‘yiladi.
   Ekran o‘chib qolmaydi, yozuv har 5 soniyada telefonning o‘zida ham saqlanib boradi (internet uzilsa yoki
   brauzer yopilib qolsa ham yo‘qolmaydi).
3. Uchrashuv tugagach **«Tugatish»** bosiladi. Audio serverga yuboriladi va bir necha daqiqada tayyor bo‘ladi:
   - **Xulosa** — umumiy xulosa, asosiy fikrlar, nimalar haqida gaplashildi;
   - **Kim qancha gapirdi** — har bir ishtirokchining vaqti va ulushi, umumiy davomiylik;
   - **Qarorlar** (kelishilgan / faqat taklif), **vazifalar** (kim, qachongacha), **keyingi qadamlar**,
     **ochiq savollar**, **risklar**;
   - **Mijoz brifi** — kompaniya, mahsulot, maqsad, auditoriya, byudjet, KPI, kanallar, muddatlar;
   - **Mind map**, **Roadmap**;
   - **Prezentatsiya** — slaydlar ko‘rinishi va **PowerPoint (.pptx) yuklab olish**;
   - **Transkript** — vaqtni bossangiz audio shu joydan boshlanadi;
   - «Xulosani nusxalash» — Telegram yoki CRM’ga tashlash uchun tayyor matn.
4. Barcha suhbatlar «Barcha suhbatlar» sahifasida saqlanib turadi.

## Sizdan nima kerak (ulash kerak bo‘lgan narsalar)

| Nima                                                  | Qayerdan olinadi                                 | Server o‘zgaruvchisi                                       |
| ----------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| **Anthropic API kaliti** (tahlil uchun Claude)        | https://console.anthropic.com → API Keys         | `ANTHROPIC_API_KEY`                                        |
| **AssemblyAI API kaliti** (nutqni matnga aylantirish) | https://www.assemblyai.com → Dashboard → API key | `ASSEMBLYAI_API_KEY`                                       |
| yoki **ElevenLabs API kaliti** (muqobil)              | https://elevenlabs.io → Profile → API keys       | `ELEVENLABS_API_KEY` + `TRANSCRIPTION_PROVIDER=elevenlabs` |
| **Kirish kodi** — jamoangiz biladigan maxfiy so‘z     | o‘zingiz o‘ylab topasiz                          | `SUHBAT_ACCESS_CODE`                                       |

Kirish kodi majburiy: yozuvlar mijozlar bilan maxfiy suhbatlar, kod bo‘lmasa server hech narsani
ko‘rsatmaydi. Har bir qurilmada kod bir marta kiritiladi (90 kun eslab qoladi).

**Qaysi transkripsiya xizmati?** Ikkalasi ham o‘zbek tilini va spikerlarni ajratishni qo‘llab-quvvatlaydi.
O‘zingizning 2–3 ta haqiqiy suhbatingizni ikkalasida sinab, qaysi biri kamroq xato qilsa, o‘shani qoldiring
(`TRANSCRIPTION_PROVIDER` bilan almashtiriladi).

**Taxminiy narx** (1 soatlik suhbat uchun): transkripsiya ≈ $0.2–0.4, Claude tahlili ≈ $0.2–0.5.
Aniq narxlarni xizmatlarning o‘z saytidan tekshiring.

## Fly.io’ga joylash (repo’da tayyor sozlangan)

Loyihada `fly.toml` allaqachon bor (`tinglovchi-staging-web` ilovasi). Bir martalik qadamlar:

```bash
# 1. Yozuvlar saqlanadigan doimiy disk (bir marta)
fly volumes create suhbat_data --region fra --size 10 -a tinglovchi-staging-web

# 2. Kalitlar (maxfiy, repo’ga yozilmaydi)
fly secrets set -a tinglovchi-staging-web \
  ANTHROPIC_API_KEY=sk-ant-... \
  ASSEMBLYAI_API_KEY=... \
  SUHBAT_ACCESS_CODE=jamoa-kodi

# 3. Joylash
fly deploy
```

Yoki GitHub’da **Actions → Fly Deploy → Run workflow** (repo secret’ida `FLY_API_TOKEN` bo‘lishi kerak).

Keyin telefonda `https://tinglovchi-staging-web.fly.dev/yoz` ni oching → kodni kiriting → brauzer menyusidan
**«Bosh ekranga qo‘shish»** — ilova kabi ochiladi.

> Diqqat: mikrofon faqat **HTTPS** orqali ishlaydi (Fly buni avtomatik beradi).

## Kompyuterda sinab ko‘rish

```bash
npm ci
# Kalitlarsiz, soxta transkript va tahlil bilan (faqat interfeysni ko‘rish uchun):
SUHBAT_FAKE_AI=1 npm run dev
# Haqiqiy kalitlar bilan:
ANTHROPIC_API_KEY=... ASSEMBLYAI_API_KEY=... npm run dev
```

So‘ng http://localhost:3000/yoz ni oching.

## Muhim cheklovlar (hozirgi holat)

- **Bitta server.** Yozuvlar serverning diskida (`/data`) saqlanadi, tahlil web jarayonning o‘zida
  bajariladi. Kichik jamoa uchun yetarli. Server qayta ishga tushsa, tugallanmagan tahlil suhbat sahifasi
  ochilganda davom etadi (transkripsiya uchun qayta pul to‘lanmaydi).
- **Bitta umumiy kod.** Har bir xodim alohida login qilmaydi; hamma bir xil suhbatlar ro‘yxatini ko‘radi.
- **Faqat mikrofon.** Brauzer jonli uchrashuvni yozadi. Zoom/Meet’dagi suhbatni yozish uchun telefonni
  kompyuter karnayi yoniga qo‘ying (yoki keyinroq desktop ilova — `apps/desktop`).
- **Transkript avtomatik**, ayrim so‘zlar xato bo‘lishi mumkin; tahlil shuni hisobga olib yoziladi.

## Keyinchalik mustahkamlash uchun

1. **Har xodimga alohida login** va «kim yozgan» — Supabase Auth allaqachon loyihada bor, `/yoz`ni unga ulash
   mumkin.
2. **Mijoz kartasi** — bitta mijoz bilan bo‘lgan barcha suhbatlar bir joyda, mijoz brifi har yangi suhbatda
   to‘ldirilib boradi.
3. **Telegram’ga avtomatik yuborish** — tahlil tayyor bo‘lganda xulosa va vazifalar jamoa chatiga tushadi.
4. **Fayl yuklash** — oldin yozilgan audio/video faylni ham tahlil qilish.
5. **Ko‘p server** — yozuvlarni obyekt xotirada (R2/S3), tahlilni alohida worker’da bajarish
   (`packages/database` dagi pipeline’ga ko‘chirish).
6. **Lug‘at** — brend va mahsulot nomlarini transkripsiyaga oldindan berish, tanilish sifatini oshirish uchun.

## Kod qayerda

| Fayl                                   | Vazifasi                                                         |
| -------------------------------------- | ---------------------------------------------------------------- |
| `apps/web/src/app/yoz/recorder.tsx`    | Yozish tugmasi, taymer, pauza, telefonda saqlash, yuborish       |
| `apps/web/src/app/yoz/[id]/*`          | Natija sahifasi: xulosa, mind map, roadmap, slaydlar, transkript |
| `apps/web/src/lib/quick/transcribe.ts` | AssemblyAI / ElevenLabs                                          |
| `apps/web/src/lib/quick/analyze.ts`    | Claude tahlili va prompt                                         |
| `apps/web/src/lib/quick/pipeline.ts`   | Yuklash → transkripsiya → tahlil bosqichlari, qayta urinish      |
| `apps/web/src/lib/quick/store.ts`      | Diskda saqlash                                                   |
| `tests/unit/quick-flow.test.ts`        | Testlar                                                          |
