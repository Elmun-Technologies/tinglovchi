# SUHBAT’ni Hetzner serveriga o‘rnatish

Bu yo‘riqnoma **istalgan dasturchi** uchun: Linux, SSH va Docker’ni bilsa yetadi. Taxminan **20–30 daqiqa**.

---

## 0. Avval: serverga qo‘yish shartmi?

SUHBAT ikki xil ishlaydi. Ikkalasi ham bir xil kod.

|                         | **Lokal** (noutbukda)                           | **Server** (Hetzner)                                           |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Qanday ochiladi         | `SUHBAT-Windows.bat` / `SUHBAT-Mac.command`     | `https://suhbat.firma.uz` — istalgan kompyuter yoki telefondan |
| Parol                   | yo‘q (faqat shu kompyuter)                      | bor (jamoa paroli)                                             |
| Suhbat paytida internet | **shart emas** — audio noutbuk diskiga yoziladi | **kerak** — audio serverga yuboriladi                          |
| Yozuvlar qayerda        | o‘sha noutbukda                                 | serverda — butun jamoa ko‘radi                                 |
| STOP’dan keyin noutbuk  | tahlil tugaguncha yoqiq tursin                  | yopsa bo‘ladi — tahlil serverda davom etadi                    |

**Tavsiya:** mijoz ofisida internet ishonchsiz bo‘lsa — **lokal**. Jamoa hammasi bir joyda ko‘rishi kerak bo‘lsa —
**server**. Ikkalasini birga ishlatish ham mumkin.

> ⚠️ Server rejimida internet uzilsa, yozuv to‘xtamaydi: audio brauzer xotirasida turadi va internet qaytishi bilan
> yuboriladi. Lekin shu paytda **brauzer tabini yopsangiz, yuborilmagan qism yo‘qoladi.**

---

## 1. Nima kerak

1. **Hetzner Cloud server** — Ubuntu 24.04 (yoki 22.04). Eng kichigi yetadi: **CX22** (2 vCPU, 4 GB RAM, 40 GB disk).
   Og‘ir hisob-kitob serverda emas (ElevenLabs va Claude’da) bo‘ladi, shuning uchun kuchli server shart emas.
2. **Domen yoki subdomen**, masalan `suhbat.firma.uz`. Mikrofon brauzerda faqat **HTTPS** sahifada ishlaydi,
   HTTPS uchun esa domen kerak (IP manzil bilan ishlamaydi).
3. **ElevenLabs** va **Anthropic** API kalitlari ([ULASH.md](ULASH.md) ga qarang).
4. Shu GitHub repozitoriyga kirish huquqi (repo yopiq bo‘lsa).

## 2. DNS

Domen panelida **A-yozuv** qo‘shing:

```
suhbat.firma.uz   A   <server IP manzili>
```

Tekshirish (bir necha daqiqadan keyin):

```bash
dig +short suhbat.firma.uz
```

Server IP manzili chiqishi kerak.

## 3. Serverni tayyorlash

```bash
ssh root@<server IP>
```

Docker o‘rnatish (rasmiy skript):

```bash
curl -fsSL https://get.docker.com | sh
```

Faervol: faqat SSH, 80 va 443 ochiq bo‘lsin.

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

Hetzner Cloud Console’da alohida **Firewall** ulangan bo‘lsa, unda ham 80 va 443 portlarini oching.

## 4. Kodni yuklab olish

Repo yopiq bo‘lsa, avval GitHub’da [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
yoki shaxsiy token sozlang.

```bash
git clone https://github.com/Elmun-Technologies/tinglovchi.git /opt/tinglovchi
```

SUHBAT kodi hozircha `claude/nice-hopper-1dfpx9` branchida. U `main`ga qo‘shilmagan bo‘lsa:

```bash
git -C /opt/tinglovchi checkout claude/nice-hopper-1dfpx9
```

## 5. Sozlash

```bash
cd /opt/tinglovchi/apps/local/deploy
```

```bash
cp .env.example .env && chmod 600 .env && nano .env
```

To‘ldiring:

| O‘zgaruvchi          | Nima yoziladi                                                                     |
| -------------------- | --------------------------------------------------------------------------------- |
| `SUHBAT_DOMAIN`      | `suhbat.firma.uz` — `https://` siz                                                |
| `SUHBAT_PASSWORD`    | jamoa paroli, **kamida 10 belgi** (masalan, `openssl rand -base64 18` chiqargani) |
| `ANTHROPIC_API_KEY`  | Claude kaliti (yoki bo‘sh qoldirib, sayt ichidagi ⚙ Sozlamalar’dan kiriting)      |
| `ELEVENLABS_API_KEY` | ElevenLabs kaliti (yoki ⚙ Sozlamalar’dan)                                         |

## 6. Ishga tushirish

```bash
docker compose up -d --build
```

Birinchi marta 1–3 daqiqa oladi. Holatni tekshirish:

```bash
docker compose ps
```

`suhbat` qatorida **healthy** bo‘lishi kerak. Caddy HTTPS sertifikatini (Let’s Encrypt) o‘zi oladi:

```bash
docker compose logs caddy | grep -i certificate
```

`certificate obtained successfully` chiqsa — tayyor.

## 7. Tekshirish

1. Brauzerda `https://suhbat.firma.uz` → kirish sahifasi chiqadi → parolni kiriting.
2. **⚙ Sozlamalar → «Saqlash va tekshirish»** → ikkala qator yashil ✓ bo‘lishi kerak.
3. **START** → 1–2 daqiqa gapiring → **STOP** → prezentatsiya chiqishini kuting.

---

## Kundalik ishlar

**Yangilash** (kodga o‘zgarish kirganda):

```bash
cd /opt/tinglovchi && git pull && cd apps/local/deploy && docker compose up -d --build
```

Yozuvlar yo‘qolmaydi — ular alohida Docker volume’da (`suhbat_suhbat-data`) turadi.

**Loglar:**

```bash
docker compose logs -f --tail=100 suhbat
```

**Parolni almashtirish:** `.env` dagi `SUHBAT_PASSWORD` ni o‘zgartiring, so‘ng:

```bash
docker compose up -d
```

Hamma qayta kiradi (eski sessiyalar bekor bo‘ladi).

**Zaxira nusxa (backup)** — hamma yozuvlar, transkriptlar va prezentatsiyalar:

```bash
docker run --rm -v suhbat_suhbat-data:/data -v /root:/backup alpine tar czf /backup/suhbat-$(date +%F).tgz -C /data .
```

Tiklash:

```bash
docker run --rm -v suhbat_suhbat-data:/data -v /root:/backup alpine tar xzf /backup/suhbat-YYYY-MM-DD.tgz -C /data
```

Qo‘shimcha himoya uchun Hetzner Console’da serverga **Backups** (kunlik avtomatik nusxa) ni yoqib qo‘ying.

**Disk:** 1 soat audio ≈ 20 MB. 40 GB diskka ~1500 soatdan ortiq suhbat sig‘adi. Bo‘sh joyni tekshirish:

```bash
df -h /
```

---

## Muammolar

| Belgi                                   | Sababi va yechimi                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sayt ochilmaydi / sertifikat xatosi     | DNS hali yangilanmagan yoki 80/443 port yopiq. `dig +short <domen>` va faervolni tekshiring, `docker compose logs caddy`.   |
| `suhbat` konteyneri qayta-qayta o‘chadi | `docker compose logs suhbat` — odatda `SUHBAT_PASSWORD` 10 belgidan qisqa yoki `SUHBAT_DOMAIN` yo‘q.                        |
| «Ruxsat yo‘q» (403)                     | Saytni `.env` dagi domendan boshqa manzil bilan ochyapsiz (masalan, `www.` bilan yoki IP orqali). Aynan shu domenni oching. |
| Mikrofon so‘ralmaydi                    | Sahifa HTTPS emas. Faqat `https://` manzil bilan oching.                                                                    |
| «Juda ko‘p urinish»                     | 15 daqiqada 10 marta noto‘g‘ri parol — 15 daqiqa kuting.                                                                    |
| Tahlil «Xato» bilan tugadi              | Sayt ichida xato matni yoziladi (kalit, balans yoki internet). Tuzatib, **Qayta urinish** ni bosing — audio joyida.         |

## Xavfsizlik bo‘yicha eslatma

- Ilova porti (4780) tashqariga ochilmagan, faqat Caddy orqali (HTTPS) kiriladi.
- Parol bilan kirish, 30 kunlik `HttpOnly` + `Secure` cookie, noto‘g‘ri parolga cheklov, begona domen va saytlardan
  kelgan so‘rovlar rad etiladi.
- API kalitlari serverda `.env` (`chmod 600`) yoki `/data/sozlamalar.json` faylida saqlanadi va brauzerga hech qachon
  qaytarilmaydi.
- Audio ElevenLabs’ga, transkript matni Anthropic’ga yuboriladi — boshqa hech qayerga emas.

## Fayllar

```
apps/local/
  Dockerfile               ← ilova obrazi (Node 22, faqat 1 ta tashqi kutubxona)
  deploy/
    docker-compose.yml     ← ilova + Caddy (HTTPS)
    Caddyfile              ← domen → ilova, 2 GB gacha fayl yuklash
    .env.example           ← sozlamalar namunasi
```
