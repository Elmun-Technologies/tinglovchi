# Keyingi bosqich uchun Claude Code prompti

Quyidagi matnni to‘liq nusxalab, shu repozitoriyada ochilgan Claude Code’ga bering.

---

```text
Sen "Suhbat AI" loyihasini (github.com/Elmun-Technologies/tinglovchi) "yaxshi ishlaydigan prototip"dan
"odamlar har kuni ishlatadigan, sotsa bo‘ladigan mahsulot" darajasiga olib chiqadigan bosh muhandissan.
Ishni boshidan oxirigacha o‘zing bajar: rejala, kod yoz, sina, commit qil. Faqat haqiqatan mening
qarorim kerak bo‘lgan joyda (pul to‘lanadigan yangi xizmat, ma’lumotni o‘chirish, arxitekturani
tubdan o‘zgartirish) to‘xtab so‘ra.

## 1. Mahsulot nima va kim uchun

- Bitta tugma: suhbat (do‘stona suhbat, mijoz bilan uchrashuv, ichki yig‘ilish) boshida bosiladi,
  butun suhbat yoziladi; oxirida aniq tahlil, mind map, roadmap va prezentatsiya tayyor bo‘ladi.
- Kiritish yo‘llari: sayt (`/yoz`, telefon va kompyuter brauzeri), tayyor audio/video fayl yuklash,
  Telegram bot (ovozli xabar, diktofon fayli).
- Foydalanuvchilar: O‘zbekistondagi kichik jamoalar, marketing agentliklari, do‘stlar guruhi.
  Interfeys tili — o‘zbekcha (lotin), suhbatlar o‘zbek/rus/ingliz aralash bo‘lishi mumkin.
- Narx muhim: o‘xshash xitoy qurilmasi ~$39. Shuning uchun 1 soatlik suhbat tannarxi ~$0.25 dan
  oshmasligi kerak (hozir: AssemblyAI ~$0.23 + Claude Haiku 5.5 ~$0.01). Har bir yangi xarajatni
  hisoblab, hujjatga yoz.

## 2. Avval o‘qi (kod yozishdan oldin)

1. `docs/ISHGA-TUSHIRISH.md` — mahsulot qanday ishlaydi, qanday deploy qilinadi.
2. `docs/audit-2026-10.md` — topilgan xatolar, eski dashboard holati, ochiq muammolar.
3. Asosiy kod: `apps/web/src/lib/quick/*` (store, pipeline, transcribe, analyze, telegram, deck,
   upload-client, local-recordings), `apps/web/src/app/yoz/**`, `apps/web/src/app/api/quick/**`,
   `tests/unit/quick-*.test.ts`, `deploy/simple/`, `.github/workflows/fly-deploy.yml`.
4. Eski dashboard (`apps/web/src/app/w/**`, `packages/*`) — faqat ma’lumot uchun; unga tegma,
   faqat quyida aytilgan joydan tashqari.

Keyin `docs/PLAN-v2.md` ga qisqa reja yoz: har bir bosqich, qaysi fayllar o‘zgaradi, qanday
tekshiriladi, qancha xarajat qo‘shadi. Rejani yozib bo‘lgach, kutmasdan ishni boshla.

## 3. Ish tartibi va sifat qoidalari (har bir bosqichda majburiy)

- Branch: `claude/nice-franklin-ywwx6y` (yoki men aytgan boshqa branch). Kichik, mantiqiy
  commit’lar; commit xabari nima va NIMA UCHUN o‘zgarganini aytsin.
- Har bir o‘zgarishdan keyin: `npm run lint`, `npm run typecheck`, `npx vitest run`,
  `npx prettier --check .`, kerak bo‘lsa `npm run build`. Hammasi yashil bo‘lmaguncha push qilma.
- Har bir yangi funksiya uchun test yoz (unit + kerak bo‘lsa Playwright). Brauzerda haqiqatan
  ishlatib ko‘r: `SUHBAT_FAKE_AI=1 npm run dev`, Chromium `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream` bilan; telefon (390px) va kompyuter kengligida, yorug‘ va qorong‘i
  rejimda skrinshot ol va o‘zing ko‘rib chiq.
- Kalitlar (ANTHROPIC_API_KEY, ASSEMBLYAI_API_KEY va h.k.) muhitda bo‘lsa — haqiqiy so‘rov bilan
  ham sina; bo‘lmasa, buni hisobotda ochiq ayt. Hech qachon kalitni kodga, logga yoki commit’ga yozma.
- AI hech narsani o‘ylab topmasin: har bir xulosa, qaror, vazifa transkriptdagi aniq qatorga
  (refs) bog‘langan bo‘lsin; bog‘lanmaganini ko‘rsatma yoki «tasdiqlanmagan» deb belgila.
- Mavjud yaxshi narsalarni buzma: bo‘lak-bo‘lak yuklash, IndexedDB’da saqlash, uzilishdan keyin
  davom etish, kirish kodi, webhook secret, tannarx hisobi, ▶ dalil tugmalari.
- Yangi pullik xizmat yoki qimmatroq model qo‘shishdan oldin so‘ra. Bepul/arzon variantni afzal ko‘r.
- UI matnlari o‘zbekcha, sodda, aniq; xato xabari nima bo‘lganini va nima qilishni aytsin.
- Model ID’lari: `claude-haiku-5-5` (standart, arzon), `claude-sonnet-5-5`, `claude-opus-5-5`.
  Anthropic SDK’ni to‘g‘ri ishlat (structured output, streaming, xatolarni turiga qarab ushlash).

## 4. Bosqichlar (shu tartibda; har birining «tayyor» mezoni bor)

### 0-bosqich. O‘lchov asosi — sifatni raqam bilan ko‘rish
- `evals/` papkasi: 12–15 ta sinov transkripti (o‘zbekcha, ruscha, aralash; do‘stona suhbat,
  mijoz brifi, ichki yig‘ilish; 5 daqiqadan 3 soatgacha). Har biriga «oltin» kutilma: qaysi
  qarorlar/vazifalar/raqamlar albatta chiqishi kerak, nima chiqmasligi kerak.
- `npm run eval` skripti: tahlilni ishga tushiradi va o‘lchaydi — qamrov (kutilgan bandlar
  topildimi), o‘ylab topish (refs’ga mos kelmagan da’volar), refs to‘g‘riligi, til (javob so‘ralgan
  tilda), tannarx va vaqt. Natijani jadval qilib `evals/RESULTS.md` ga yozadi.
- Haiku 5.5 va Sonnet 5.5 ni shu to‘plamda solishtir; xulosani yoz (qaysi biri standart bo‘lishi
  kerak va nega). Kalit bo‘lmasa — skriptni tayyorla, qanday ishlatishni yoz.
- Tayyor: bitta buyruq bilan sifat va narx jadvali chiqadi.

### 1-bosqich. Tahlil sifati
- Suhbat turlari (shablonlar): «Do‘stona suhbat», «Mijoz uchrashuvi / brif», «Ichki yig‘ilish»,
  «Intervyu». Tur avtomatik aniqlanadi, foydalanuvchi o‘zgartira oladi; har bir tur o‘z bo‘limlarini
  chiqaradi (masalan, do‘stona suhbatda «kelishuvlar, kim nima qiladi, pul hisob-kitobi, esda
  qoladigan gaplar»; brifda mijoz brifi).
- Bo‘limlarga ajratish (chapters): suhbat 3–12 qismga bo‘linadi, har biriga sarlavha, vaqt
  oralig‘i, 1–2 gaplik mazmun; transkript va pleyerda shu bo‘limlar ko‘rinadi.
- Ikki bosqichli tekshiruv: tahlildan keyin har bir qaror/vazifa/raqam uchun refs’dagi matn uni
  rostdan tasdiqlaydimi — arzon model bilan tekshir; tasdiqlanmaganini olib tashla yoki belgila.
- Uzun suhbatlar (3–6 soat): kontekst limitiga yaqinlashsa, bo‘lib tahlil qilib (map), keyin
  birlashtir (reduce); xulosa butun suhbatni qamrasin, faqat boshini emas. Eval’da 3 soatlik
  namuna bilan isbotla.
- Spikerlar: ismni suhbatdan aniqlash + foydalanuvchi qo‘lda nom berishi (A → «Aziz»), saqlanadi
  va qayta tahlilsiz hamma joyda yangilanadi.
- «Qayta tahlil qilish» tugmasi (boshqa til / boshqa tur / kuchliroq model bilan) — transkript
  qayta pullik bo‘lmasin.
- Lug‘at: brend va ism ro‘yxati (sozlamada) AssemblyAI’ga `word_boost`/keyterms sifatida
  yuboriladi; aralash o‘zbek-rus nutqi uchun provayderning code-switching imkoniyatini tekshir va
  eval bilan solishtir.
- Tayyor: eval’da qamrov oshgan, o‘ylab topish 0 ga yaqin, uzun suhbat to‘liq qamralgan.

### 2-bosqich. Natijalar — «vau» darajasi
- Mind map: haqiqiy diagramma (SVG, avtomatik joylashuv, shoxlar egri chiziq bilan, zoom/pan
  telefonda ham), PNG/SVG yuklab olish; Telegram’ga rasm sifatida ham yuboriladi.
- Prezentatsiya: chiroyli shablon (muqova, bo‘lim slaydlari, «kim qancha gapirdi» diagrammasi,
  mind map rasm sifatida, roadmap vaqt chizig‘i), har slaydda spiker izohlari (notes) — .pptx va
  PDF. Haqiqiy PowerPoint/Google Slides’da ochilishini tekshir.
- Bir sahifalik hisobot (PDF/DOCX): xulosa, qarorlar, vazifalar jadvali — Telegram’ga ham.
- Ulashish havolasi: har suhbat uchun faqat-o‘qish havolasi (imzolangan token, muddati bor,
  bekor qilinadi) — do‘stlar kirish kodisiz natijani ko‘ra oladi; audio/transkriptni ko‘rsatish
  ixtiyoriy.
- Tayyor: namuna suhbatdan chiqqan mind map, pptx va PDF’ni skrinshot qilib hisobotga qo‘sh.

### 3-bosqich. Foydalanish qulayligi (UX)
- PWA: manifest, ikonka, «Bosh ekranga qo‘shish», offline qobiq; telefonda ilovadek ochilsin.
- Yozish ekrani: ovoz darajasi aniq ko‘rinsin, «ovoz juda past» ogohlantirishi, uzun yozuvda
  zaryad haqida maslahat, iPhone’da ekran qulflansa yozuv to‘xtashi haqida aniq ogohlantirish va
  «Diktofonda yozib, keyin yuklang» yo‘li.
- Natija tayyor bo‘lganda brauzer bildirishnomasi (ruxsat bilan) va Telegram xabari.
- Tarix: qidiruv (sarlavha va transkript bo‘yicha), filtr (sana, tur), nomini o‘zgartirish,
  o‘chirish (tasdiqlash bilan), «barcha suhbatlardan savol berish» — sodda RAG: transkriptlardan
  izlab, Claude javob beradi, manbaga havola bilan.
- Interfeys tillari: o‘zbekcha (lotin) asosiy, ruscha va inglizcha; matnlar bitta lug‘at faylida.
- Telegram: `/royxat` (oxirgi suhbatlar), `/savol <matn>` (suhbatlar bo‘yicha savol), natija
  xabarida tugmalar (inline keyboard): «Mind map», «Prezentatsiya», «Saytda ochish».
- Tayyor: yangi foydalanuvchi 1 daqiqada birinchi yozuvini qiladi; Lighthouse (mobil)
  accessibility ≥ 95.

### 4-bosqich. Ishonchlilik, xavfsizlik, ishga tushirish
- Foydalanuvchilar: umumiy kod o‘rniga oddiy hisoblar (Telegram orqali kirish yoki email havola),
  har kim o‘z suhbatlarini ko‘radi, jamoa ichida ulashish. Mavjud ma’lumotni yo‘qotmasdan ko‘chir.
  Arxitekturani tanlashdan oldin 2 variantni narx/murakkablik bilan solishtirib menga ko‘rsat.
- Limitlar: foydalanuvchi/oy bo‘yicha soat limiti, tannarx paneli, limitga yetganda aniq xabar.
- Ishonchlilik: server qayta ishga tushsa ishlar davom etadi (allaqachon bor — test bilan
  mustahkamla), tashqi so‘rovlarda timeout va qayta urinish, eskirgan yuklashlar tozalanadi,
  har kecha zaxira nusxa.
- CI: GitHub Actions — lint, typecheck, unit test, build, Playwright e2e (fake AI bilan) har PR’da.
- Kuzatuv: tuzilgan loglar (session id, bosqich, vaqt, tannarx), xatolar uchun bepul variant.
- Xavfsizlik ko‘rigi: kirish nazorati, fayl yo‘llari, yuklash hajmi, webhook, ulashish tokenlari,
  rate limit; topilganini tuzat va `docs/security.md` ni yangila.
- Deploy: `fly-deploy.yml` bilan haqiqiy deploy (kalitlar GitHub secrets’da bo‘lsa), so‘ng
  ishlab turgan saytda smoke test: yozish → tahlil → Telegram natija.
- Tayyor: CI yashil, deploy ishlaydi, xavfsizlik ko‘rigi hujjatlangan.

### 5-bosqich (vaqt qolsa). Eski dashboard bilan birlashtirish
- `/yoz` natijalarini dashboard o‘qiydigan Supabase jadvallariga yozish rejasini tayyorla
  (arzon yo‘l, `docs/audit-2026-10.md` 6-bo‘limiga qara). Faqat reja — bajarishdan oldin so‘ra.

## 5. Nima qilma

- Eski `/w/**` dashboard, `packages/database` ichidagi eski pipeline, desktop ilovani o‘zgartirma
  (5-bosqichdagi rejadan tashqari).
- Testni o‘chirish yoki o‘tkazib yuborish bilan «yashil» qilma. Xatoni yashirma — tuzat yoki ayt.
- Suhbatni yashirin yozadigan funksiya qo‘shma: yozish doim ko‘rinib tursin.
- Kalitlarni chatga, kodga, logga yozma. Ma’lumotni so‘ramasdan o‘chirma.

## 6. Yakuniy hisobot (o‘zbek tilida, menga)

Har bosqich oxirida va ish tugaganda qisqa hisobot ber:
1. Nima qilindi (foydalanuvchi ko‘zi bilan, 5–10 band) va skrinshotlar.
2. Eval natijalari: sifat va 1 soatlik suhbat tannarxi — avval va keyin.
3. Nima qilinmadi yoki chala qoldi va nega.
4. Men nima qilishim kerak (kalit, ruxsat, qaror) — aniq ro‘yxat.
5. Qanday sinab ko‘raman: 3–5 qadamli yo‘riqnoma.
```
