# HANDOFF — SUHBAT (apps/local)

Bu hujjat loyihani **noldan tushuntirmasdan** davom ettirish uchun. Avval shuni o‘qing, keyin kodga o‘ting.
Hujjatda hech qanday maxfiy ma’lumot (kalit, parol, server IP) yo‘q — ular alohida beriladi.

## 1. Mahsulot nima

Mijoz bilan 3–5 soatlik oflayn suhbatda **bitta START** bosiladi → butun suhbat yoziladi → **STOP** → bir necha
daqiqadan keyin prezentatsiya chiqadi: nima anglashildi, mind map, kim tarafdan qanday talab, kim kimga nimani
yuboradi, kim nimani ko‘rib beradi, P1/P2/P3 vazifalar va mas’ullar, qarorlar, ochiq savollar, risklar, road map.

Ekran yozilmaydi — **faqat ovoz**. Til asosan o‘zbekcha (rus/ingliz so‘zlari aralash). Dizayn — QClay uslubida
(Outfit shrifti, yumaloq kartalar, qora/ko‘k/sariq).

## 2. Qayerda nima

Hamma narsa `apps/local/` ichida (Node.js 22, framework yo‘q, bitta tashqi kutubxona: `@anthropic-ai/sdk`).

| Fayl                              | Vazifasi                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `server.mjs`                      | HTTP server, API, ikki rejim (lokal / server), kirish himoyasi                          |
| `lib/store.mjs`                   | Diskdagi ma’lumotlar (`DATA_DIR`): sozlamalar, suhbatlar                                |
| `lib/pipeline.mjs`                | Zanjir: audio bo‘laklar → transkript → tahlil → prezentatsiya; qayta urinish, tiklanish |
| `lib/stt.mjs`                     | ElevenLabs Scribe (transkripsiya, spikerlarni ajratish) + kalit tekshiruvi              |
| `lib/analyze.mjs`                 | Claude tahlili (qat’iy JSON sxema, zaxira yo‘l, uzun suhbat uchun qismlab o‘qish)       |
| `lib/presentation.mjs`            | HTML prezentatsiya (slaydlar, mind map SVG, QClay CSS, shrift ichiga joylangan)         |
| `lib/auth.mjs`                    | Server rejimida parol bilan kirish, imzolangan cookie, urinishlarni cheklash            |
| `lib/demo.mjs`                    | Namuna ma’lumot (`SUHBAT_DEMO=1` — kalitsiz sinov)                                      |
| `public/app.js`, `index.html`     | Brauzer: yozish (`MediaRecorder`), yuklash navbati, holat ko‘rsatish                    |
| `Dockerfile`, `deploy/`           | Server uchun konteyner; `docker-compose.yml` + Caddy (HTTPS) — **faqat bo‘sh serverda** |
| `HETZNER.md`, `deploy/install.sh` | Bo‘sh Hetzner serveriga bitta buyruq bilan o‘rnatish (`install.sh` — qarang §6)         |
| `README.md`, `ULASH.md`           | Foydalanuvchi qo‘llanmasi; kalitlar va birinchi sinov ro‘yxati                          |

## 3. Qanday ishlaydi (muhim qarorlar)

- **Yozuv yo‘qolmasligi:** brauzer audioni har 5 soniyada serverga yuboradi, server diskka `appendFile` qiladi.
  Har 20 daqiqada yangi mustaqil fayl (`seg-001.webm`, …). Yuklash navbati ketma-ket, xatoda qayta uriniladi.
  Server o‘chib yonsa — `recover()` holatni `interrupted` qiladi, yozilgani saqlanadi.
- **Transkripsiya** bo‘lak yopilishi bilan (suhbat davomida) boshlanadi; natija `audio/seg-NNN.json`.
  Qayta urinishda bajarilgan bo‘laklar qayta to‘lanmaydi.
- **Tahlil** STOP’dan keyin: butun transkript bitta so‘rovda (juda uzun bo‘lsa — avval qismlab qaydlar).
  Model `claude-opus-5-5`, `thinking: adaptive`, `output_config.format` = JSON sxema,
  `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Sxema rad etilsa — oddiy so‘rov + JSON ajratish.
  Natija `normalizeAnalysis()` dan o‘tadi (buzuq maydonlar xavfsiz qiymatga aylanadi).
- **Kalitlar:** `⚙ Sozlamalar` yoki muhit o‘zgaruvchisi (`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, ular ustun).
  Brauzerga hech qachon qaytarilmaydi. `sozlamalar.json` — `0600`.
- **Ikki rejim:** `SUHBAT_PUBLIC_URL` berilmasa — lokal (`127.0.0.1`, parolsiz). Berilsa — server rejimi:
  `SUHBAT_PASSWORD` (≥10 belgi) majburiy, faqat shu domen qabul qilinadi (Host/Origin tekshiruvi), cookie
  `HttpOnly`+`Secure`. Parolsiz tashqi tarmoqqa ochilishdan **bosh tortadi**.
- **Proksi ortida** (Coolify/Caddy) `SUHBAT_TRUST_PROXY=1` kerak — aks holda parol urinishlari hamma uchun bitta
  IP hisoblanadi.

## 4. Muhit o‘zgaruvchilari

| O‘zgaruvchi                                                          | Ma’nosi                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `SUHBAT_PUBLIC_URL`                                                  | `https://domen` — server rejimini yoqadi                             |
| `SUHBAT_PASSWORD`                                                    | Jamoa paroli, ≥10 belgi (server rejimida majburiy)                   |
| `SUHBAT_TRUST_PROXY`                                                 | `1` — `X-Forwarded-For` ga ishonish (proksi ortida shart)            |
| `SUHBAT_DATA_DIR`                                                    | Ma’lumotlar papkasi (konteynerda `/data`; **volume** bo‘lishi shart) |
| `SUHBAT_HOST` / `SUHBAT_PORT`                                        | Standart `127.0.0.1` (server rejimida `0.0.0.0`) / `4780`            |
| `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`                            | Ixtiyoriy; Sozlamalar’dagidan ustun                                  |
| `SUHBAT_DEMO=1`                                                      | Kalitsiz sinov, namuna ma’lumot                                      |
| `SUHBAT_CLAUDE_MODEL`, `ELEVENLABS_STT_MODEL`, `ELEVENLABS_BASE_URL` | Model/endpoint almashtirish                                          |

## 5. Holat (nima tasdiqlangan, nima yo‘q)

**Tasdiqlangan:**

- `cd apps/local && npm ci && npm test` → 20 ta test o‘tadi (to‘liq oqim, uzilishdan tiklanish, xavfsizlik,
  soxta ElevenLabs/Claude serverlariga qarshi haqiqiy zanjir, server rejimi).
- Root: `npm run lint`, `npm run typecheck`, `npx vitest run` (623 ta) — toza.
- Chromium (soxta mikrofon) bilan START → pauza → STOP → prezentatsiya → PDF.
- Docker + Caddy + HTTPS + parol bilan to‘plam ishga tushirilgan, qayta ishga tushganda ma’lumot saqlanadi.

**HALI TASDIQLANMAGAN — birinchi ish shu:**

1. **Haqiqiy ElevenLabs va Anthropic kalitlari bilan bir marta ham ishlatilmagan** (dasturlash muhitida kalit va
   tashqi tarmoq yo‘q edi). Taxminlar: ElevenLabs endpoint `POST /v1/speech-to-text`, `model_id`
   `scribe_v1` → `scribe_v2` zaxira, javobda `words[].{text,start,end,type,speaker_id}`, `language_code`.
   **Rasmiy hujjat bilan solishtiring.** `Anthropic` SDK 1.x kalitni `Authorization: Bearer` bilan yuboradi.
2. **O‘zbekcha nutq sifati** va spiker ajratish — faqat haqiqiy suhbatda bilinadi. Tahlil promti
   (`lib/analyze.mjs` → `SYSTEM`) ni shu natijaga qarab sozlang.
3. Haqiqiy serverda (Coolify/Hetzner) ishga tushirish — hali qilinmagan.

**Birinchi sinov (10 daqiqa):** Sozlamalar → ikkala kalit → «Saqlash va tekshirish» (ikkalasi ✓) → START →
2–3 daqiqa o‘zbekcha, ikki kishi → STOP → prezentatsiyada ismlar, vazifalar, muddatlar to‘g‘rimi?

## 6. Joylashtirish (deploy)

- **Lokal (noutbuk):** `SUHBAT-Windows.bat` / `SUHBAT-Mac.command`. Node.js 20+ kerak. Mijoz ofisida internet
  ishonchsiz bo‘lsa — eng ishonchli yo‘l (audio diskka yoziladi, internet faqat tahlil uchun).
- **Coolify (tavsiya — serverda boshqa saytlar bor bo‘lsa):** Caddy kerak emas, HTTPS’ni Coolify beradi.
  Public Repository `Elmun-Technologies/tinglovchi`, branch `main`, Build Pack **Dockerfile**,
  Base Directory `/apps/local`, Dockerfile `/Dockerfile`, port `4780`. Doimiy volume → `/data`.
  Env: `SUHBAT_PUBLIC_URL=https://<domen>`, `SUHBAT_TRUST_PROXY=1`, `SUHBAT_PASSWORD=…`.
  Domen bo‘lmasa `<ip-chiziqcha>.sslip.io` ishlaydi.
- **Bo‘sh Hetzner serveri:** `deploy/docker-compose.yml` (Caddy bilan) yoki `deploy/install.sh`.
  ⚠️ **`install.sh` va Caddy 80/443 portlarini egallaydi — Coolify/boshqa veb-server turgan mashinada ISHLATMANG.**
  `install.sh` `main` ga qo‘shilganmi — `git ls-tree origin/main apps/local/deploy` bilan tekshiring (u alohida
  commit’da, `claude/nice-hopper-1dfpx9` branchida bo‘lishi mumkin).
- Katta tayyor audio fayl yuklash (yuzlab MB) proksi vaqt chegarasiga tushishi mumkin; START bilan yozish
  kichik bo‘laklar yuborgani uchun muammo emas.

## 7. Ma’lum cheklovlar va tuzoqlar

- Server rejimida suhbat paytida internet kerak; uzilsa audio brauzer xotirasida kutadi, **tabni yopsangiz yo‘qoladi**.
- Bitta umumiy parol: foydalanuvchi akkauntlari, rollar, «kim nimani ko‘radi», audit jurnali **yo‘q**.
- Bir vaqtda bitta jarayon (bitta server nusxasi); navbat/ko‘p nusxa uchun mo‘ljallanmagan.
- QClay shrifti pullik — o‘rniga bepul **Outfit** (`public/fonts/`, SIL OFL).
- `apps/web` (Next.js dashboard) — alohida, eski mahsulot, **demo ma’lumot bilan**, SUHBAT Lokal’ga ulanmagan.
  Haqiqiy ishlashi uchun Supabase va worker kerak. Dev serverni ishga tushirsa `apps/web/AGENTS.md` va
  `CLAUDE.md` avtomatik yaratiladi — ularni commit qilmang.
- Sandbox/korporativ proksi ortida `docker build` ichida `npm ci` `SELF_SIGNED_CERT_IN_CHAIN` beradi — bu
  loyiha xatosi emas, tarmoq sozlamasi; haqiqiy fayllarga o‘zgartirish kiritmang.
- Yangi API maydoni qo‘shsangiz: `ANALYSIS_SCHEMA` (analyze.mjs) ↔ `normalizeAnalysis` ↔ `presentation.mjs`
  ↔ `demo.mjs` ↔ `test/unit.test.mjs` bir-biriga mos bo‘lishi shart (test buni tekshiradi).

## 8. Keyingi ishlar (tartib bilan)

1. Haqiqiy kalitlar bilan birinchi sinov (§5), xatolarni tuzatish.
2. Joylashtirish (Coolify) va jamoa bilan sinov.
3. Haqiqiy suhbatlar asosida tahlil promti va slaydlarni sozlash.
4. **Qaror kerak** (mahsulot egasidan):
   - **A (tavsiya):** SUHBAT Lokal’ga foydalanuvchi akkauntlari, rollar, mijoz bo‘yicha papkalar, audit — QClay uslubida.
   - **B:** `apps/web` ni QClay uslubida qayta qurib, SUHBAT Lokal bilan ulash (Supabase kerak — ancha katta).
5. Keyin: Zoom/Meet/Telegram integratsiyalari.

## 9. Qanday ishlash

- Branch: `main`dan oling; PR orqali qo‘shing. Commit xabarlari inglizcha, qisqa.
- Tekshiruv: `cd apps/local && npm test`; ildizda `npm run lint && npm run typecheck && npm run format:check`.
- Brauzer oqimini sinash (kalitsiz): `SUHBAT_DEMO=1 SUHBAT_NO_OPEN=1 node apps/local/server.mjs`, so‘ng
  `http://localhost:4780` (Chrome `--use-fake-device-for-media-stream` bilan mikrofonsiz ham yozadi).
- Foydalanuvchi bilan muloqot — o‘zbek tilida; foydalanuvchi matni (UI, slaydlar, xatolar) ham o‘zbekcha.
- **Kalit va parollarni hech qachon chatga, issue’ga yoki commit’ga yozmang.**
