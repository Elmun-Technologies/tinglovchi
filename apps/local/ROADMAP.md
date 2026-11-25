# ROADMAP — SUHBAT’ni qanday kuchaytirish

Bu hujjat loyihani **boshqa muhitda / boshqa agent yoki dasturchi bilan** davom ettirish uchun. Avval
[HANDOFF.md](HANDOFF.md) ni o‘qing (nima qayerda, nima tasdiqlangan), keyin shu hujjatni.
Har bir band: **nima → nega → qanday → qabul mezoni**. Hajm: **S** (≤½ kun), **M** (1–2 kun), **L** (3+ kun).

Maxfiy ma’lumot (kalit, parol, server IP) bu hujjatda yo‘q va hech qachon bo‘lmasligi kerak.

---

## 0. Boshlash (har bir yangi muhit uchun, 15 daqiqa)

```bash
git clone https://github.com/Elmun-Technologies/tinglovchi.git && cd tinglovchi/apps/local
npm ci && npm test            # 21 ta test o'tishi kerak
SUHBAT_DEMO=1 SUHBAT_NO_OPEN=1 node server.mjs   # kalitsiz sinov: http://localhost:4780
```

Ildizda: `npm run lint && npm run typecheck && npm run format:check`.
Ish tartibi: `main` dan branch → kichik PR → testlar o‘tadi → `main`. Foydalanuvchi bilan o‘zbek tilida gaplashing,
mayda narsalarni so‘ramang; faqat kalit, parol va **mahsulot qarorlari** bo‘yicha so‘rang.

Hozirgi holat (qisqa): kod `main`da, Coolify’da (Docker, `/data` volume) ishlayapti, haqiqiy kalitlar bilan oqim
ishlagan. **Hali yo‘q:** akkauntlar/rollar, mijozlar bo‘yicha guruhlash, tahrir qilish, Telegram, zaxira nusxa,
o‘zbekcha sifat o‘lchovi.

---

## P0 — Barqarorlik va ishonch (birinchi navbatda, ~1 hafta)

Maqsad: haqiqiy mijoz suhbatida **hech narsa yo‘qolmasin va hech narsa jimgina buzilmasin**.

| #   | Nima                                               | Hajm | Qanday                                                                                                                                                                                                                                                                                | Qabul mezoni                                                                           |
| --- | -------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0.1 | Claude so‘rovi uchun xavfsizlik yo‘li              | S    | `lib/analyze.mjs` → `askClaude`: oddiy rejimda `BadRequestError` bo‘lsa, parametrlarsiz (`thinking`, `betas`, `fallbacks`, `effort` siz) so‘rovni qayta yuboring.                                                                                                                     | Mock server qo‘shimcha parametrlarni rad etsa ham tahlil chiqadi (yangi test).         |
| 0.2 | ElevenLabs API’ni rasmiy hujjat bilan solishtirish | S    | `lib/stt.mjs`: endpoint, `model_id` (`scribe_v1`/`scribe_v2`), `diarize`, `timestamps_granularity`, `language_code`, javob maydonlari (`words[].type`, `speaker_id`). Hozirgi kod taxmin asosida; haqiqiy kalit bilan ishlagani ma’lum, lekin hujjatdagi yangi imkoniyatlarni oling.  | Hujjatdagi har bir parametr kodda izohli; ishlatilmaydiganlari sababi bilan yozilgan.  |
| 0.3 | Haqiqiy suhbatlardan **oltin to‘plam**             | M    | 3–5 haqiqiy (ruxsat bilan) yoki sahnalashtirilgan 5–10 daqiqalik yozuv + qo‘lda to‘g‘rilangan transkript + kutilgan vazifalar ro‘yxati. `test/golden/` ga (audio **repoga qo‘shilmaydi** — `.gitignore` da, alohida saqlang). Skript: `npm run eval` → WER va vazifa-topish aniqligi. | Skript raqam chiqaradi; har o‘zgarishdan keyin raqam yomonlashmaganini ko‘rish mumkin. |
| 0.4 | Bo‘sh/ovozsiz yozuvni **yozish paytida** aniqlash  | S    | `public/app.js` allaqachon ovoz darajasini o‘lchaydi (`rec.analyser`). 45 soniya jimlik → banner bor; qo‘shing: START’dan 20 soniyadan keyin ham ovoz bo‘lmasa — katta ogohlantirish va mikrofon tanlash. Serverda `retryable:false` xatoda «Qayta urinish» tugmasini yashiring.      | Mikrofon o‘chiq holda START bosilsa, foydalanuvchi 30 soniyada bilib oladi.            |
| 0.5 | Zaxira nusxa (backup)                              | S    | Coolify: `/data` volume uchun jadvalli backup (S3 yoki boshqa serverga). Kamida kunlik. Tiklash tartibini `HETZNER.md`/yangi `OPS.md` ga yozing va **bir marta sinab ko‘ring**.                                                                                                       | Volume o‘chirilsa ham, kechagi suhbatlar tiklanadi (sinalgan).                         |
| 0.6 | Kuzatuv: `/api/health` va xato jurnali             | S    | `server.mjs`: `GET /api/health` (kirishsiz, faqat `{ok:true,disk:%,processing:N}`); xatolarni `DATA_DIR/errors.log` ga yozing (aylantirib). Disk 85% dan oshsa Sozlamalarda ogohlantirish.                                                                                            | Coolify health check shu manzilga ulanadi; disk to‘lishi oldindan ko‘rinadi.           |
| 0.7 | **Narx ko‘rinishi**                                | S    | `analysis._usage` allaqachon saqlanadi. ElevenLabs uchun audio davomiyligi. Meeting kartasida taxminiy narx (sozlanadigan tariflar `sozlamalar.json`).                                                                                                                                | Har suhbat yonida «≈ $X» ko‘rinadi.                                                    |
| 0.8 | Rozilik va maxfiylik matni                         | S    | START oldidan bir marta: «Suhbat yozilmoqda va tahlil uchun ElevenLabs va Anthropic’ga yuboriladi» + suhbatdoshlar roziligi tasdiqlanadi (checkbox, `meeting.json` ga yoziladi). Mijozga beriladigan qisqa rozilik shabloni `docs/` ga. **Yuridik tekshiruvni yurist qilsin.**        | Rozilik belgisisiz START ishlamaydi (sozlamadan o‘chirish mumkin).                     |

---

## P1 — Natija sifati (eng katta ta’sir, ~2 hafta)

Prezentatsiya sifati asosan **kontekst** va **ishonch** (dalil) ga bog‘liq.

| #    | Nima                                             | Hajm | Qanday                                                                                                                                                                                                                                                                          | Qabul mezoni                                                                                                      |
| ---- | ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1.1  | **START oldidan kontekst formasi**               | M    | Ixtiyoriy: mijoz nomi, suhbat turi, kun tartibi, qatnashchilar (ism + tomon + lavozim). `POST /api/meetings` ga `context` qo‘shing, `contextBlock()` (analyze.mjs) ga uzating. Bu ismlarni to‘g‘ri chiqarishning eng arzon yo‘li.                                               | Kontekst bilan va kontekstsiz tahlilni oltin to‘plamda solishtirganda ismlar xatosi kamayadi.                     |
| 1.2  | **Spikerlarni nomlash** (Q1/S1 → «Aziz aka»)     | M    | Prezentatsiyadan oldin «Kim kim?» ekrani: har spiker uchun 2–3 ta namuna replika ko‘rsatiladi, foydalanuvchi ism va tomonni tanlaydi (`meeting.speakers`). Tahlil shu xaritani oladi; «Qayta tahlil» tugmasi (transkriptni qayta ElevenLabs’ga **yubormasdan**).                | Ismlarni qo‘lda belgilash 1 daqiqadan kam; qayta tahlilda STT qayta to‘lanmaydi.                                  |
| 1.3  | **Dalil (evidence) va audio’ga o‘tish**          | M    | Sxemaga har vazifa/qaror/talab uchun `quote` (transkriptdan so‘zma-so‘z parcha) qo‘shing; serverda parchaning transkriptda borligini tekshiring (yo‘q bo‘lsa — belgilab qo‘ying). Slaydda vaqt belgisi bosilsa, audio shu joydan ijro etiladi (`/m/<id>/audio/<seg>` + `#t=` ). | Har vazifa yonida «qayerda aytilgan» havolasi; to‘qilgan vazifalar kamayadi.                                      |
| 1.3a | Sxemani kichraytirish (agar qat’iy format kerak) | S    | `grammar too large` sababi — sxema katta. Enum’larni olib tashlang yoki bo‘limlarni 2–3 so‘rovga bo‘ling; `SUHBAT_STRUCTURED_OUTPUT=1` bilan sinang.                                                                                                                            | Qat’iy sxema rejimi haqiqiy API’da xatosiz ishlaydi yoki o‘chirilgani izohlangan.                                 |
| 1.4  | **Suhbat turlari shablonlari**                   | M    | `meeting_type` bo‘yicha prompt va slaydlar: _mijoz brifi_ (byudjet, KPI, auditoriya, kanallar, muddatlar), _byudjet muhokamasi_, _ichki retro_, _sotuv qo‘ng‘irog‘i_. Reklama agentligi uchun brif shabloni birinchi.                                                           | Brif suhbatida «Brif kartasi» slaydi to‘ldiriladi, yetishmagan maydonlar «aniqlashtirish kerak» deb ko‘rsatiladi. |
| 1.5  | **Tahrirlash**                                   | M    | Tahlil natijasini UI’da tahrirlash (vazifa egasi/muddati/muhimligi, o‘chirish, qo‘shish) → `analysis.json` yangilanadi → prezentatsiya qayta quriladi (`renderOutputs`).                                                                                                        | Prezentatsiyani mijozga yuborishdan oldin 2 daqiqada tuzatish mumkin.                                             |
| 1.6  | **Eksport**                                      | M    | Server tomonida PDF (Playwright/Chromium, `@page 1600x900`), PPTX (`pptxgenjs`) — mijoz ko‘pincha PowerPoint so‘raydi. Read-only **ulashish havolasi** (tasodifiy token, muddati bilan).                                                                                        | «PDF», «PPTX», «Havola» tugmalari; havola muddati tugagach ochilmaydi.                                            |
| 1.7  | O‘zbek/rus tilida natija tanlovi                 | S    | `settings.outputLanguage` → promptdagi «O‘zbek tilida» qoidasi parametrga aylanadi; slayd sarlavhalari (`presentation.mjs`) lug‘atga chiqariladi.                                                                                                                               | Rus tilidagi prezentatsiya ham chiqadi.                                                                           |
| 1.8  | **Uzun suhbat (4–6 soat) sinovi**                | M    | Hozir ≈1.4M belgigacha bitta so‘rov, undan oshsa qismlab o‘qiladi (`MAX_SINGLE_PASS_CHARS`). 4 soatlik haqiqiy yozuvda vaqt, narx va sifatni o‘lchang; kerak bo‘lsa har 30 daqiqalik bo‘lim xulosasi + yakuniy «reduce».                                                        | 4 soatlik suhbat 15 daqiqadan kam, narxi ma’lum, sifati oltin to‘plam bilan solishtirilgan.                       |

---

## P2 — Jamoa va mijozlar bilan ishlash (~2–3 hafta)

**Mahsulot qarori kerak:** «A» yo‘li (tavsiya) — SUHBAT’ning o‘ziga qo‘shish. «B» — eski `apps/web` (Next.js, Supabase)
ni qayta qurish; u ancha katta va hozir demo ma’lumot bilan. Boshlashdan oldin egasidan so‘rang.

| #   | Nima                                  | Hajm | Qanday                                                                                                                                                                                                                                                                                                                 | Qabul mezoni                                                                            |
| --- | ------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 2.1 | **Ma’lumotlar bazasiga o‘tish**       | M    | Fayllar (`meeting.json`) o‘rniga SQLite (`node:sqlite` Node ≥22.5 yoki `better-sqlite3`). Audio diskda qoladi. Migratsiya skripti eski papkalarni o‘qiydi. `lib/store.mjs` interfeysi saqlansin, shunda boshqa modullar o‘zgarmaydi.                                                                                   | Eski suhbatlar yo‘qolmaydi; qidiruv va filtr tez ishlaydi.                              |
| 2.2 | **Akkauntlar va rollar**              | L    | Hozir bitta umumiy parol. Foydalanuvchilar (email/login + parol hash: `crypto.scrypt`), rollar: `admin` (hammasini ko‘radi, kalitlar, foydalanuvchilar), `member` (o‘z va unga ulashilgan suhbatlar). Birinchi ishga tushirishda admin yaratish. Eski `SUHBAT_PASSWORD` rejimi «bitta jamoa» sifatida qolsin.          | Xodim faqat o‘z mijozlarini ko‘radi; admin hammasini; kim nima qilgani jurnalda.        |
| 2.3 | **Mijozlar (kompaniyalar)**           | M    | `clients` jadvali; suhbat mijozga bog‘lanadi (START oldida tanlash/yaratish). **Mijoz kartasi**: barcha suhbatlar tarixi, ochiq vazifalar, kelishilgan qarorlar, byudjet/KPI o‘zgarishi.                                                                                                                               | Bir mijozning 5 suhbati bitta sahifada, ochiq vazifalar jamlangan.                      |
| 2.4 | **Vazifalar — alohida obyekt**        | M    | Vazifa: holat (ochiq/jarayonda/bajarildi), egasi, muddat, manba suhbat. «Mening vazifalarim» sahifasi; muddati o‘tganlar qizil.                                                                                                                                                                                        | Prezentatsiyadagi vazifa belgilanib, keyingi suhbatda «avvalgi vazifalar» ko‘rsatiladi. |
| 2.5 | **Suhbatlar bo‘yicha savol-javob**    | L    | «Foodera byudjeti haqida nima kelishgandik?» — mijoz bo‘yicha barcha transkriptlar ustida qidiruv + Claude javobi, har javobda manba (suhbat, vaqt). Boshlash: transkript bo‘laklarini SQLite FTS5 bilan qidirish; keyin embedding. (Eski `apps/web` da shunga o‘xshash g‘oya bor — kodni nusxalamang, g‘oyani oling.) | Savol berilsa, javob + manbaga havola chiqadi.                                          |
| 2.6 | **Audit jurnali va saqlash muddati**  | S    | Kim kirdi/ko‘rdi/o‘chirdi. Sozlama: audio N kundan keyin avtomatik o‘chiriladi (transkript va prezentatsiya qoladi) — maxfiylik va disk uchun.                                                                                                                                                                         | Audio 90 kundan keyin o‘chadi (sozlanadi).                                              |
| 2.7 | UI’ni to‘liq QClay uslubida yakunlash | M    | `style.css` allaqachon asos. Suhbatlar ro‘yxatini «drawer»dan to‘liq sahifaga o‘tkazish (qidiruv, mijoz bo‘yicha filtr), mobil moslashuv.                                                                                                                                                                              | Telefonda ham qulay; 100+ suhbatda tez.                                                 |

---

## P3 — Yozib olish kanallari va integratsiyalar

| #   | Nima                             | Hajm | Qanday                                                                                                                                                                                                                                                  | Qabul mezoni                                                  |
| --- | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 3.1 | **Telegram: «tayyor» xabari**    | S    | Eng foydali kichik narsa. Bot tokeni + chat ID `sozlamalar.json`/env’da. Tahlil tugagach: sarlavha, 3 qatorli xulosa, P1 vazifalar, prezentatsiya havolasi. (`apps/web` da Telegram bot kodi bor — g‘oyasini oling.)                                    | Suhbat tugagach 1–5 daqiqada Telegram’ga xabar keladi.        |
| 3.2 | **Telegram: audio yuborish**     | M    | Botga ovozli/audio fayl yuborilsa, tahlil boshlanadi, tayyor bo‘lgach havola qaytadi. 20 MB (Telegram bot API chegarasi) dan katta fayllar uchun saytga yuklash havolasi.                                                                               | Telefon diktofonidagi yozuv Telegram orqali tahlilga tushadi. |
| 3.3 | **PWA / telefon**                | S    | `manifest.webmanifest` + service worker (faqat shell). Telefonda «Ilova sifatida o‘rnatish». iOS Safari’da ekran uyquga ketsa yozuv to‘xtaydi — buni UI’da ochiq ayting va Wake Lock’ni tekshiring.                                                     | Android Chrome’da o‘rnatiladi va 1 soat yozadi (ekran yoniq). |
| 3.4 | **Zoom/Meet/Teams yozuvlari**    | L    | Variantlar: (a) Zoom cloud-yozuv faylini yuklash (oson, 1 kun); (b) bot-xizmat (Recall.ai kabi) — pullik, tez; (c) `apps/desktop` (Tauri) bilan tizim ovozini yozish — murakkab, Mac/Windows sinovi shart. Avval (a), keyin egasi bilan (b)/(c) qarori. | Zoom yozuvi faylini tashlab, shu oqimdan prezentatsiya olish. |
| 3.5 | **CRM/Task tizimlariga eksport** | M    | O‘zbekiston bozori uchun: Bitrix24, amoCRM; umumiy: Notion, Trello, Google Calendar. Vazifalar «Yuborish» tugmasi bilan **inson tasdig‘idan keyin** yaratiladi (avtomatik emas). (`apps/web` Phase 9 da shunga o‘xshash tasdiq oqimi g‘oyasi bor.)      | Bitta tugma bilan P1 vazifalar CRM’da paydo bo‘ladi.          |

---

## P4 — Sifat o‘lchovi, narx, masshtab

| #   | Nima                                      | Hajm | Qanday                                                                                                                                                                                                                                                        | Qabul mezoni                                                        |
| --- | ----------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 4.1 | **STT provayderlarini solishtirish (uz)** | M    | `lib/stt.mjs` ni provayder interfeysiga aylantiring (`transcribeFile → {language, words}`). Oltin to‘plamda WER o‘lchang: ElevenLabs Scribe, Whisper large-v3 (o‘zingiz hostingda/API), Gemini audio, mahalliy o‘zbek STT xizmatlari. Eng yaxshisini tanlang. | Jadval: provayder × WER × narx/soat × tezlik. Tanlov asoslangan.    |
| 4.2 | Mahalliy (on-prem) rejim                  | L    | Maxfiy mijozlar uchun: audio tashqariga chiqmasligi kerak bo‘lsa — mahalliy Whisper + mahalliy LLM. Faqat egasi so‘rasa. Sifat tushishi haqida ogohlantirish.                                                                                                 | Internetsiz tahlil ishlaydi (sifati kamroq, belgilangan).           |
| 4.3 | **Navbat va ishchi jarayon**              | M    | Hozir tahlil server jarayoni ichida. Ko‘p foydalanuvchida: alohida worker, bir vaqtda N ta tahlil, qayta urinish, o‘lik navbat. (Eski `packages/database/worker-*` g‘oyasi.) Faqat yuk oshganda kerak.                                                        | 5 suhbat bir vaqtda tugagach, hammasi navbat bilan tahlil qilinadi. |
| 4.4 | Obyekt xotira (S3/R2)                     | M    | Audio diskdan S3-mos xotiraga; `storage` interfeysi. Disk to‘lib qolish xavfini yo‘qotadi.                                                                                                                                                                    | Server diski almashsa ham audio yo‘qolmaydi.                        |
| 4.5 | Narxni kamaytirish                        | S    | Uzun rejimda qism qaydlari uchun arzonroq model (`claude-haiku-5-5`/`claude-sonnet-5-5`); `effort` ni o‘lchab tanlash (oltin to‘plamda `medium` vs `high`).                                                                                                   | Sifat tushmagan holda narx X% kamaygan (o‘lchangan).                |
| 4.6 | CI                                        | S    | GitHub Actions: `apps/local` testlari, lint, prettier har PR’da. Hozir repoda faqat qo‘lda Fly deploy bor.                                                                                                                                                    | PR’da yashil/qizil belgi chiqadi.                                   |

---

## Tavsiya etilgan tartib

1. **1-hafta:** 0.1, 0.2, 0.4, 0.5, 0.6, 3.1 (Telegram xabari) — ishonch + darrov sezilarli foyda.
2. **2-hafta:** 0.3 (oltin to‘plam), 1.1, 1.2 — sifatni o‘lchab, ismlar muammosini hal qilish.
3. **3–4-hafta:** 1.3, 1.5, 1.6 — mijozga yuborishga tayyor prezentatsiya (dalil, tahrir, PPTX/PDF).
4. **Qaror nuqtasi:** P2 — A yoki B (egasidan so‘rang). Keyin 2.1 → 2.2 → 2.3 → 2.4.
5. Keyin: 1.4 (brif shabloni), 3.2, 3.4(a), 2.5.
6. P4 — yuk yoki talab paydo bo‘lganda; 4.1 (STT solishtirish) esa 0.3 dan keyin istalgan paytda.

## Har bir ishda amal qilinadigan qoidalar

- Har o‘zgarishga test (`apps/local/test/`). Tashqi API’lar mock serverga qarshi sinaladi (`test/live-path.test.mjs` namuna).
- `ANALYSIS_SCHEMA` ↔ `normalizeAnalysis` ↔ `presentation.mjs` ↔ `demo.mjs` ↔ testlar bir-biriga mos (yangi maydon qo‘shsangiz, hammasini yangilang).
- Prezentatsiya o‘zgarganda skrinshot bilan tekshiring (Playwright; `SUHBAT_DEMO=1`), matn kesilib qolmasligini ko‘ring.
- Server rejimi xavfsizligini buzmang: parolsiz tashqi ochilmaydi, Host/Origin tekshiruvi, kalitlar brauzerga qaytmaydi.
- Redeploy’dan oldin: hech kim yozmayotganini tekshiring (yozuv ketayotganda server qayta ishga tushsa, o‘sha yozuv uziladi).
- Foydalanuvchi ma’lumotlari (audio, transkript) loglarga, issue va commit’larga tushmasin.
- Yangi model/API imkoniyatlari bilan ishlaganda **rasmiy hujjatni** o‘qing; taxminga tayanmang (STT’da shunday bo‘lgan).

## Ochiq savollar (egasidan)

1. P2: A (SUHBAT’ga qo‘shish) yoki B (`apps/web` ni qayta qurish)?
2. Mijozlar kim: faqat reklama agentligi brifi, yoki turli suhbatlar (sotuv, ichki)?
3. Maxfiylik: audio chet el xizmatlariga (ElevenLabs, Anthropic) yuborilishi barcha mijozlar uchun maqbulmi? Yo‘q bo‘lsa — 4.2.
4. Zoom/Meet kerakmi, yoki asosan yuzma-yuz uchrashuvlar?
5. Tarif: ichki foydalanishmi yoki keyinchalik boshqa agentliklarga sotiladimi? (Sotilsa — akkauntlar, to‘lov, ko‘p tenantlik P2 ga kiradi.)
