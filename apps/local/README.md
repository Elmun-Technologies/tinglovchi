# SUHBAT Lokal

Bitta **START** tugmasi: suhbat to‘liq yozib olinadi, tugagach — prezentatsiya ko‘rinishidagi tahlil chiqadi.
Hammasi sizning kompyuteringizda ishlaydi, server kerak emas.

```
START → suhbat (3–5 soat bo‘lsa ham) → STOP → bir necha daqiqa → PREZENTATSIYA
```

## Natijada nima chiqadi

Har bir suhbat uchun slaydlar (strelkalar bilan varaqlanadi, «PDF» tugmasi bilan PDF qilib saqlanadi):

| Slayd                        | Mazmuni                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| Suhbatdan nima anglashildi   | Qisqa xulosa va eng muhim 4–8 ta fikr                                    |
| Suhbat raqamlarda            | Nechta talab, vazifa, qaror, risk; aytilgan byudjet, sana, hajmlar       |
| Ishtirokchilar               | Kim «biz» tomonda, kim mijoz tomonda                                     |
| **Mind map**                 | Suhbat mavzulari xaritasi                                                |
| Nimalar muhokama qilindi     | Har bir mavzu bo‘yicha qisqacha                                          |
| **Talablar**                 | Kim tarafdan qanday talab qo‘yildi, muhimligi (P1/P2/P3)                 |
| **Kim nimani yuboradi**      | Kim → kimga → nimani → qachongacha                                       |
| **Kim nimani ko‘rib beradi** | Kim nimani tekshirishi/tasdiqlashi kerak                                 |
| **Vazifalar**                | Muhimlik bo‘yicha tartiblangan, egasi va muddati bilan; odamlar kesimida |
| Qarorlar, ochiq savollar     | Nimaga kelishildi, nima ochiq qoldi                                      |
| Risklar                      | Nimaga e’tibor berish kerak va nima qilish kerak                         |
| **Road map**                 | Bosqichlar va vaqt oralig‘i                                              |
| Keyingi qadamlar             | Yaqin 1–2 haftada qilinadigan ishlar                                     |

Qo‘shimcha: to‘liq **transkript** (vaqt belgilari bilan) va Telegram/pochtaga yopishtirish uchun **matnli xulosa**.

Namuna prezentatsiyani dastur ichida ko‘rish mumkin: **Suhbatlar → Namuna prezentatsiya**.

## Ishga tushirish

1. [Node.js](https://nodejs.org) (LTS) o‘rnatilgan bo‘lishi kerak — bir marta.
2. Loyiha papkasining boshidagi faylni ikki marta bosing:
   - Windows: **`SUHBAT-Windows.bat`**
   - macOS: **`SUHBAT-Mac.command`**
3. Qora oyna ochiladi (yopmang) va brauzerda `http://localhost:4780` sahifasi chiqadi.
4. Birinchi safar: **⚙ Sozlamalar** → ikkita kalitni kiriting → **Saqlash va tekshirish**. Ikkalasi yashil ✓ bo‘lsa — tayyor.

Terminaldan: `npm run local` (loyiha ildizidan) yoki `cd apps/local && npm install && npm start`.

## Foydalanish

- Suhbatdoshlardan ruxsat oling → **START**. Brauzer mikrofonga ruxsat so‘rasa — «Ruxsat berish».
- Suhbat davomida hech narsa qilish shart emas. Ekranda vaqt va ovoz darajasi ko‘rinib turadi.
- **Pauza** — yozilmasligi kerak bo‘lgan qism uchun.
- Tugagach **STOP** → tahlil boshlanadi → **Prezentatsiyani ochish**.
- Oldingi suhbatlar: yuqoridagi **Suhbatlar** tugmasi. U yerda tayyor audio faylni (telefon diktofoni va h.k.) ham tahlilga yuklash mumkin.

### Uzun suhbat (3–5 soat) uchun muhim

- Noutbukni **zaryadga ulang**, qopqog‘ini **yopmang**. Dastur ekranni o‘chirmaslikka harakat qiladi, lekin
  kompyuter «uyqu»ga ketsa yozuv to‘xtaydi.
- Brauzer oynasini va qora oynani yopmang (boshqa oynaga o‘tish mumkin).
- Katta xonada noutbuk mikrofoni uzoqdagi odamni yomon eshitadi — iloji bo‘lsa stol o‘rtasiga qo‘yiladigan
  tashqi mikrofon / spikerfon ishlating. Transkripsiya sifati to‘g‘ridan-to‘g‘ri ovoz sifatiga bog‘liq.
- Internet suhbat paytida shart emas: audio diskka yoziladi, tahlil internet bo‘lganda qilinadi.

## Ishonchlilik

- Audio **har 5 soniyada** diskka yoziladi. Brauzer yoki kompyuter o‘chib qolsa ham shu paytgacha yozilgani
  saqlanadi — dasturni qayta ochsangiz «Saqlangan qismni tahlil qilish» tugmasi chiqadi.
- Yozuv har 20 daqiqada alohida faylga bo‘linadi va suhbat davom etayotganda transkripsiya qilinib boradi,
  shuning uchun STOP’dan keyin kutish qisqa bo‘ladi.
- Tahlil paytida internet uzilsa yoki xizmat xato bersa — **Qayta urinish** tugmasi; bajarilgan qismlar
  qaytadan qilinmaydi (ortiqcha pul sarflanmaydi).
- Mikrofon uzilsa (quloqchin chiqarilsa) — dastur boshqa mikrofonga o‘zi o‘tadi yoki ogohlantiradi.

## Ma’lumotlar qayerda

Hammasi uy papkangizdagi **`Suhbat-AI`** papkasida (Sozlamalar oynasida to‘liq yo‘li ko‘rsatiladi):

```
Suhbat-AI/
  sozlamalar.json                  ← kalitlar va sozlamalar (faqat shu kompyuterda)
  suhbatlar/2026-11-24_15-30_ab12cd/
    audio/seg-001.webm …           ← asl audio (har 20 daqiqa — bitta fayl)
    transcript.txt                 ← transkript
    analysis.json                  ← tahlil (tuzilgan ma’lumot)
    presentation.html              ← prezentatsiya (internetisiz ochiladi, yuborish mumkin)
    xulosa.md                      ← matnli xulosa
```

`presentation.html` — mustaqil fayl: uni mijozga yoki jamoaga shundayligicha yuborish mumkin.

## Maxfiylik

- Dastur faqat sizning kompyuteringizda ishlaydi (`127.0.0.1`), tashqaridan unga kirib bo‘lmaydi.
- Tahlil uchun audio **ElevenLabs**ga, transkript matni **Anthropic (Claude)**ga yuboriladi — boshqa hech
  qayerga. Shuning uchun yozib olishdan oldin suhbatdoshlar roziligini oling.
- Kalitlar `sozlamalar.json` faylida saqlanadi va brauzerga qaytarilmaydi.

## Muammo bo‘lsa

| Holat                                     | Nima qilish kerak                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| «Mikrofonga ruxsat berilmadi»             | Manzil satridagi qulf belgisi → Mikrofon → Ruxsat berish. Sahifani yangilang.           |
| «Mikrofondan ovoz kelmayapti»             | Windows/macOS ovoz sozlamalarida to‘g‘ri mikrofon tanlanganini tekshiring.              |
| Sozlamalarda qizil ✕                      | Yonidagi matn sababni aytadi: kalit noto‘g‘ri, balans yo‘q yoki internet yo‘q.          |
| «Dastur bilan aloqa yo‘q»                 | Qora oyna yopilgan. Ishga tushirish faylini qayta bosing — yozilganlar saqlangan.       |
| Tahlil «Xato» bilan tugadi                | **Qayta urinish**. Audio joyida, hech narsa yo‘qolmaydi.                                |
| macOS «noma’lum dasturchi» deb ochmayapti | Faylni o‘ng tugma bilan bosing → **Open** → **Open**.                                   |
| Ismlar yoki atamalar noto‘g‘ri yozilgan   | Sozlamalarda «Jamoa a’zolari»ni to‘ldiring — tahlil ismlarni shunga qarab to‘g‘rilaydi. |

## Texnik ma’lumot

- `server.mjs` — Node.js’ning o‘zidagi HTTP server (framework yo‘q). Bitta tashqi kutubxona: `@anthropic-ai/sdk`.
- `public/` — sahifa: `MediaRecorder` (Opus, 48 kbit/s ≈ 20 MB/soat), bo‘laklarni ketma-ket yuklash navbati.
- `lib/stt.mjs` — ElevenLabs Scribe (spikerlarni ajratish bilan). `lib/analyze.mjs` — Claude (`claude-opus-5-5`,
  tuzilgan JSON javob; 10+ soatlik suhbatlar uchun qismlab o‘qish). `lib/presentation.mjs` — slaydlar, mind map (SVG).
- Sinov rejimi (kalitlarsiz, namuna ma’lumot bilan): `SUHBAT_DEMO=1 npm start`.
- Testlar: `npm test` (16 ta: to‘liq oqim, uzilishdan tiklanish, xavfsizlik, soxta ElevenLabs/Claude serverlari bilan
  haqiqiy zanjir).
- Sozlash uchun muhit o‘zgaruvchilari: `.env.example` ga qarang.
