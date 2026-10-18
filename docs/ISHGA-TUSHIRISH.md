# Suhbat AI — ishga tushirish (eng arzon yo‘l)

Bu qo‘llanma loyihaning asosiy qismini — **«bitta tugma bosiladi → butun suhbat yoziladi → oxirida tahlil»**
oqimini ishga tushirish uchun. Admin panel, Supabase, worker yoki desktop ilova kerak emas.

## Bu nima qiladi

1. Telefon yoki kompyuter brauzerida `https://<sizning-manzilingiz>/yoz` ochiladi (bosh sahifa ham shu yerga
   olib boradi).
2. Uchrashuv turini tanlang (kompyuterda): **«Xonada»** — faqat mikrofon; **«Onlayn qo‘ng‘iroq»** — mikrofon
   va Zoom/Meet/Telegram qo‘ng‘irog‘ining ovozi (naushnikda bo‘lsangiz ham yoziladi). Tahlil tilini tanlang:
   o‘zbekcha, ruscha yoki inglizcha.
3. Uchrashuvdan oldin katta **«Boshlash»** tugmasi bir marta bosiladi. Telefon stol ustiga qo‘yiladi.
   Ekran o‘chmaydi, yozuv har 5 soniyada qurilmaning o‘zida ham saqlanadi — internet uzilsa yoki brauzer
   yopilib qolsa ham yo‘qolmaydi. Qo‘ng‘iroq kelib mikrofon band bo‘lsa, shu paytgacha yozilgani yuboriladi.
4. **«Tugatish»** bosiladi. Audio 4 MB’lik bo‘laklarda yuboriladi (internet uzilsa faqat uzilgan bo‘lak
   qayta yuboriladi). Bir necha daqiqada tayyor:
   - **Xulosa**, asosiy fikrlar, nimalar haqida gaplashildi;
   - **Kim qancha gapirdi** va umumiy davomiylik;
   - **Qarorlar** (kelishilgan / faqat taklif), **vazifalar** (kim, qachongacha), keyingi qadamlar, ochiq
     savollar, risklar;
   - har bir mavzu, qaror va vazifa yonida **▶ 05:31** tugmasi — bossangiz audio aynan shu joydan o‘ynaydi
     (AI o‘ylab topmaganini o‘zingiz tekshirasiz);
   - **Mijoz brifi**, **Mind map**, **Roadmap**, **Prezentatsiya** (PowerPoint yuklab olish), **Transkript**;
   - «Xulosani nusxalash» — Telegram yoki CRM’ga tashlash uchun tayyor matn.
5. «Barcha suhbatlar» sahifasida hamma suhbatlar va **shu oy tannarxi** ko‘rinadi.

## Narx: bir soatlik suhbat qancha turadi

Standart sozlama eng arzon variantda: transkripsiya — AssemblyAI, tahlil — Claude Haiku 5.5.

| Suhbat     | Transkripsiya (AssemblyAI) | Tahlil (Haiku 5.5) | Jami       |
| ---------- | -------------------------- | ------------------ | ---------- |
| 1 soat     | ~$0.23                     | ~$0.01             | **~$0.24** |
| 6 soat     | ~$1.38                     | ~$0.17             | **~$1.55** |
| 50 soat/oy | ~$11.5                     | ~$0.5              | **~$12**   |

- **AssemblyAI yangi hisobga $50 bepul kredit beradi — taxminan 185 soatlik suhbat bepul.**
- Server: Oracle Cloud «Always Free» — **0 so‘m** (pastda), yoki Fly.io ~$5–8/oy.
- Tahlil chuqurroq bo‘lishi kerak bo‘lsa: `ANTHROPIC_MODEL=claude-sonnet-5-5` (soatiga ~$0.25 qo‘shiladi) yoki
  `claude-opus-5-5` (~$0.50). Avval Haiku’da sinab ko‘ring — ko‘p hollarda yetarli.
- Har bir suhbatning aniq tannarxi suhbat sahifasi pastida va «Barcha suhbatlar»da ko‘rsatiladi.
- Narxlar provayderlarning ochiq narxlari bo‘yicha taxmin; ular o‘zgarishi mumkin.

## Siz qiladigan ishlar (A dan Z gacha)

### 1-qadam. Kalitlarni olish (≈15 daqiqa)

| Nima                                        | Qayerda                                                       | Narxi                                 |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| **AssemblyAI API kaliti** (nutq → matn)     | assemblyai.com → Sign up → Dashboard → API Keys               | $50 bepul kredit, karta shart emas    |
| **Anthropic API kaliti** (tahlil)           | console.anthropic.com → Sign up → Billing’ga $5 → API Keys    | $5 ≈ Haiku’da 500 soatlik tahlil      |
| **Kirish kodi** — jamoangiz biladigan parol | o‘zingiz o‘ylab topasiz (kamida 12 belgi)                     | —                                     |
| **Manzil (domen)**                          | duckdns.org → Google bilan kiring → masalan `agentlik-suhbat` | bepul (`agentlik-suhbat.duckdns.org`) |

Muqobil transkripsiya: ElevenLabs (`TRANSCRIPTION_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`) — narxi deyarli
bir xil (~$0.22/soat). 3–5 ta haqiqiy o‘zbekcha suhbatni ikkalasida sinab, kamroq xato qilganini qoldiring.

### 2-qadam. Serverni tanlash

**A. Bepul server — Oracle Cloud Always Free (tavsiya, 0 so‘m)**

1. cloud.oracle.com → «Start for free». Karta faqat tekshirish uchun so‘raladi, pul yechilmaydi.
2. Compute → Instances → Create: **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**, 2 OCPU, 12 GB RAM.
   SSH kalitini yuklab oling. (Ba’zan «Out of capacity» chiqadi — boshqa vaqtda yoki boshqa zonada urinib
   ko‘ring.)
3. Networking → VCN → Security List → Ingress rules: **80** va **443** portlarini oching (0.0.0.0/0, TCP).
4. Serverning IP manzilini DuckDNS’dagi domeningizga yozing.
5. Serverga kiring (`ssh ubuntu@<IP>`) va quyidagilarni bajaring:

```bash
# Oracle Ubuntu tasvirida 80/443 ichki firewall’da yopiq — ochamiz
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker

# Loyiha (repo private bo‘lsa: GitHub → Settings → Developer settings → Fine-grained token, faqat shu repo)
git clone https://github.com/Elmun-Technologies/tinglovchi.git
cd tinglovchi/deploy/simple
cp .env.example .env
nano .env        # DOMAIN, SUHBAT_ACCESS_CODE, ANTHROPIC_API_KEY, ASSEMBLYAI_API_KEY ni to‘ldiring

docker compose up -d --build     # birinchi marta ~5–10 daqiqa
```

6. Telefonda `https://<domeningiz>/yoz` ni oching → kirish kodini kiriting → brauzer menyusidan **«Bosh ekranga
   qo‘shish»**. Tayyor.

Yangilash: `cd tinglovchi && git pull && cd deploy/simple && docker compose up -d --build`.
Zaxira nusxa: `deploy/simple/backup.sh` (cron’ga har kecha qo‘yish mumkin — fayl ichida yozilgan).

**B. Eng oddiy — Fly.io (~$5–8/oy)**

Loyihada `fly.toml` tayyor (`tinglovchi-staging-web`):

```bash
fly volumes create suhbat_data --region fra --size 10 -a tinglovchi-staging-web
fly secrets set -a tinglovchi-staging-web \
  ANTHROPIC_API_KEY=sk-ant-... ASSEMBLYAI_API_KEY=... SUHBAT_ACCESS_CODE=jamoa-kodi
fly deploy
```

Yoki GitHub → Actions → **Fly Deploy** → Run workflow (repo secret’ida `FLY_API_TOKEN` bo‘lsin).
Manzil: `https://tinglovchi-staging-web.fly.dev/yoz`.

**C. O‘zbekistondagi hosting** — shaxsiy ma’lumotlar talabi bo‘yicha (pastda) kerak bo‘lsa: istalgan Ubuntu
VPS’da A variantidagi 5-qadamni bajaring.

### 3-qadam. Sinash (birinchi hafta)

1. 3–5 ta haqiqiy suhbatni yozing (bittasi 1+ soatlik, bittasi o‘zbek-rus aralash bo‘lsin).
2. Har bir qaror/vazifa yonidagi ▶ tugmasini bosib, to‘g‘ri yozilganini tekshiring.
3. Sifat yetmasa: avval `TRANSCRIPTION_PROVIDER=elevenlabs` ni sinang (xato ko‘pincha transkripsiyada),
   keyin `ANTHROPIC_MODEL=claude-sonnet-5-5`. `.env` ni o‘zgartirib `docker compose up -d` qiling.

### 4-qadam. Huquqiy tomoni (sotishdan oldin)

- Shartnomaga band: «uchrashuvlar xizmat sifati uchun yozib olinadi va AI yordamida tahlil qilinadi».
- Uchrashuv boshida ogohlantiring. Ilova yashirin yozmaydi: ekranda qizil tugma va taymer, telefonda mikrofon
  belgisi ko‘rinadi.
- Ovoz AssemblyAI (AQSh) va Anthropic (AQSh) serverlarida qayta ishlanadi. 2026-yil martdagi o‘zgarishdan keyin
  O‘zbekistonda majburiy lokalizatsiya asosan biometrik ma’lumotlarga tegishli; ovoz yozuvi qaysi toifaga
  kirishini advokat bilan tasdiqlang.

## Kompyuterda sinab ko‘rish (dasturchilar uchun)

```bash
npm ci
SUHBAT_FAKE_AI=1 npm run dev        # kalitlarsiz, soxta transkript va tahlil bilan
```

So‘ng http://localhost:3000/yoz ni oching.

## Cheklovlar (hozirgi holat)

- **Telefonda ekran ochiq turishi kerak.** iPhone’da ekran qulflansa yoki boshqa ilovaga o‘tilsa yozuv
  to‘xtaydi; Android’da odatda davom etadi, lekin kafolat yo‘q. Uzun uchrashuvda telefonni zaryadga qo‘ying.
- **«Onlayn qo‘ng‘iroq» rejimi faqat kompyuter brauzerida** (Chrome/Edge). Windows’da butun kompyuter ovozi,
  Mac’da bitta brauzer tabi (masalan Google Meet) ovozi yoziladi. Zoom ilovasi uchun Mac’da — Zoom’ni
  brauzerda oching.
- **Bitta umumiy kirish kodi** — har xodimga alohida login yo‘q; hamma bir xil ro‘yxatni ko‘radi.
- **Bitta server** — kichik va o‘rta jamoa uchun yetarli.
- **O‘zbek-rus aralash nutq** — transkripsiya butun fayl uchun bitta tilni aniqlaydi; aralash suhbatlarda
  sifatni sinab ko‘ring.

## Keyinchalik mustahkamlash uchun

1. Har xodimga alohida login va «kim yozgan» (Supabase Auth loyihada bor).
2. Mijoz kartasi — bitta mijoz bilan barcha suhbatlar va to‘ldirilib boradigan brif.
3. Tayyor bo‘lganda Telegram’ga avtomatik xulosa.
4. Oldin yozilgan audio/video faylni yuklab tahlil qilish.
5. Mobil ilova — ekran qulflangan holda ham yozish.
6. Lug‘at — brend va mahsulot nomlarini transkripsiyaga oldindan berish.

## Kod qayerda

| Fayl                                      | Vazifasi                                                            |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `apps/web/src/app/yoz/recorder.tsx`       | Tugma, rejim va til tanlash, taymer, pauza, qurilmada saqlash       |
| `apps/web/src/lib/quick/upload-client.ts` | Bo‘laklab, uzilishdan keyin davom ettirib yuborish                  |
| `apps/web/src/app/yoz/[id]/*`             | Natija: xulosa, ▶ dalillar, mind map, roadmap, slaydlar, transkript |
| `apps/web/src/lib/quick/transcribe.ts`    | AssemblyAI / ElevenLabs                                             |
| `apps/web/src/lib/quick/analyze.ts`       | Claude tahlili, prompt, tannarx hisobi                              |
| `apps/web/src/lib/quick/pipeline.ts`      | Transkripsiya → tahlil bosqichlari, qayta urinish                   |
| `apps/web/src/lib/quick/store.ts`         | Diskda saqlash, bo‘laklarni yig‘ish                                 |
| `deploy/simple/`                          | Bepul/arzon serverga o‘rnatish (Docker + avtomatik HTTPS), zaxira   |
| `tests/unit/quick-flow.test.ts`           | Testlar                                                             |
