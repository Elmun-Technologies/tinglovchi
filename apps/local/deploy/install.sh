#!/usr/bin/env bash
# SUHBAT — serverga (masalan, Hetzner) bitta buyruq bilan o'rnatish.
#
#   curl -fsSL https://raw.githubusercontent.com/Elmun-Technologies/tinglovchi/main/apps/local/deploy/install.sh | sudo bash
#
# Domen bo'lmasa ham ishlaydi: <server-ip>.sslip.io manzili va bepul HTTPS sertifikat ishlatiladi.
# O'z domeningiz bilan:   ... | sudo SUHBAT_DOMAIN=suhbat.firma.uz bash
# Qayta ishga tushirish xavfsiz: kodni yangilaydi, parol va kalitlar saqlanib qoladi.
#
# Ixtiyoriy muhit o'zgaruvchilari:
#   SUHBAT_DOMAIN     sayt domeni (standart: <ip>.sslip.io yoki oldingi o'rnatishdagisi)
#   SUHBAT_PASSWORD   jamoa paroli, kamida 10 belgi (standart: avtomatik yaratiladi)
#   SUHBAT_BRANCH     git branch (standart: main)
#   SUHBAT_DIR        o'rnatish papkasi (standart: /opt/tinglovchi)
#   SUHBAT_REPO       git repozitoriy (standart: GitHub'dagi Elmun-Technologies/tinglovchi)
#   SUHBAT_PUBLIC_IP  server IP manzili (avtomatik aniqlanmasa)
#   SUHBAT_COMPOSE_OVERRIDE  qo'shimcha docker compose fayli (sinov uchun)
# Parametr: --dry-run — hech narsani o'zgartirmasdan nima qilishini ko'rsatadi.
set -euo pipefail

REPO="${SUHBAT_REPO:-https://github.com/Elmun-Technologies/tinglovchi.git}"
BRANCH="${SUHBAT_BRANCH:-main}"
DIR="${SUHBAT_DIR:-/opt/tinglovchi}"
DEPLOY="$DIR/apps/local/deploy"
ENV_FILE="$DEPLOY/.env"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" 2>/dev/null || true
      exit 0
      ;;
    *)
      echo "Noma'lum parametr: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31m[x] %s\033[0m\n' "$*" >&2
  exit 1
}
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# --- 0. Root huquqi -------------------------------------------------------------
if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" = 0 ]; then
  if [ -f "${BASH_SOURCE[0]:-}" ] && command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
  fi
  die "Root huquqi kerak. Buyruqni shunday ishga tushiring:  curl -fsSL <manzil> | sudo bash"
fi

[ "$DRY_RUN" = 1 ] && say "SINOV (dry-run): hech narsa o'zgartirilmaydi"

# --- 1. Kerakli dasturlar ------------------------------------------------------------
say "1/6  Kerakli dasturlar tekshirilmoqda"
need_pkgs=()
command -v git >/dev/null 2>&1 || need_pkgs+=(git)
command -v curl >/dev/null 2>&1 || need_pkgs+=(curl)
command -v openssl >/dev/null 2>&1 || need_pkgs+=(openssl)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  command -v apt-get >/dev/null 2>&1 || die "Quyidagilarni o'rnating: ${need_pkgs[*]}"
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need_pkgs[@]}"
fi

if command -v docker >/dev/null 2>&1; then
  echo "    Docker bor: $(docker --version)"
else
  echo "    Docker o'rnatilmoqda (rasmiy skript, 1–2 daqiqa)…"
  if [ "$DRY_RUN" = 1 ]; then
    echo "    [dry-run] curl -fsSL https://get.docker.com | sh"
  else
    curl -fsSL https://get.docker.com | sh
  fi
fi
if [ "$DRY_RUN" = 0 ]; then
  docker compose version >/dev/null 2>&1 || die "'docker compose' ishlamayapti. Docker'ni qayta o'rnating."
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

# --- 2. Kod ---------------------------------------------------------------------------
say "2/6  Kod yuklanmoqda ($BRANCH) → $DIR"
if [ -d "$DIR/.git" ]; then
  run git -C "$DIR" fetch --quiet origin "$BRANCH"
  run git -C "$DIR" checkout --quiet "$BRANCH"
  run git -C "$DIR" pull --quiet --ff-only origin "$BRANCH"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR papkasi bo'sh emas va git repozitoriy emas. Boshqa papka tanlang: SUHBAT_DIR=/opt/suhbat"
else
  run git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi
if [ "$DRY_RUN" = 0 ] && [ ! -f "$DEPLOY/docker-compose.yml" ]; then
  die "$DEPLOY/docker-compose.yml topilmadi — branch to'g'rimi? (SUHBAT_BRANCH=$BRANCH)"
fi

# --- 3. Manzil (domen) -----------------------------------------------------------------
say "3/6  Sayt manzili aniqlanmoqda"
env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
is_ipv4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

PUBLIC_IP="${SUHBAT_PUBLIC_IP:-}"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP="$(curl -4 -fsS --max-time 3 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || true)"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP="$(curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
is_ipv4 "$PUBLIC_IP" || PUBLIC_IP=""

DOMAIN="${SUHBAT_DOMAIN:-$(env_get SUHBAT_DOMAIN)}"
if [ -z "$DOMAIN" ]; then
  [ -n "$PUBLIC_IP" ] || die "Server IP manzilini aniqlab bo'lmadi. Domenni bering: ... | sudo SUHBAT_DOMAIN=suhbat.firma.uz bash"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  echo "    Domen berilmagan — bepul manzil ishlatiladi: $DOMAIN"
fi
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
echo "    Sayt: https://$DOMAIN"
if [ -n "$PUBLIC_IP" ] && [[ "$DOMAIN" != *.sslip.io ]] && [ "$DOMAIN" != localhost ]; then
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  if [ -z "$RESOLVED" ]; then
    warn "$DOMAIN DNS'da topilmadi. Domen panelida A-yozuv qo'shing: $DOMAIN → $PUBLIC_IP"
  elif [ "$RESOLVED" != "$PUBLIC_IP" ]; then
    warn "$DOMAIN → $RESOLVED, lekin bu server $PUBLIC_IP. A-yozuvni $PUBLIC_IP ga o'zgartiring, aks holda HTTPS sertifikat olinmaydi."
  fi
fi

# --- 4. Sozlamalar (.env) ---------------------------------------------------------------
say "4/6  Sozlamalar yozilmoqda ($ENV_FILE)"
PASSWORD="$(env_get SUHBAT_PASSWORD)"
if [ -n "${SUHBAT_PASSWORD:-}" ]; then
  [ "${#SUHBAT_PASSWORD}" -ge 10 ] || die "SUHBAT_PASSWORD kamida 10 belgi bo'lishi kerak."
  PASSWORD="$SUHBAT_PASSWORD"
fi
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)"
  echo "    Yangi jamoa paroli yaratildi."
else
  echo "    Parol saqlanib qoldi."
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "    [dry-run] .env: SUHBAT_DOMAIN=$DOMAIN, SUHBAT_PASSWORD=<${#PASSWORD} belgi>, qolgan qatorlar saqlanadi"
else
  tmp="$(mktemp "$DEPLOY/.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    echo "# install.sh tomonidan yozilgan. Qo'lda o'zgartirsangiz: docker compose up -d"
    echo "SUHBAT_DOMAIN=$DOMAIN"
    echo "SUHBAT_PASSWORD=$PASSWORD"
    # Oldingi qatorlar (API kalitlari va boshqa sozlamalar) saqlanadi.
    if [ -f "$ENV_FILE" ]; then
      grep -vE '^(SUHBAT_DOMAIN|SUHBAT_PASSWORD)=|^# install\.sh' "$ENV_FILE" || true
    fi
  } >"$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# --- 5. Faervol --------------------------------------------------------------------------
say "5/6  Faervol"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  run ufw allow OpenSSH >/dev/null
  run ufw allow 80/tcp >/dev/null
  run ufw allow 443/tcp >/dev/null
  run ufw allow 443/udp >/dev/null
  echo "    ufw: 80 va 443 portlar ochildi."
else
  echo "    ufw yoqilmagan — o'zgartirish kerak emas."
fi
echo "    Eslatma: Hetzner Cloud Console'da serverga Firewall ulangan bo'lsa, unda ham 80 va 443 portlarini oching."

# --- 6. Ishga tushirish ------------------------------------------------------------------
say "6/6  SUHBAT ishga tushirilmoqda (birinchi marta 2–4 daqiqa)"
compose=(docker compose -f "$DEPLOY/docker-compose.yml")
[ -n "${SUHBAT_COMPOSE_OVERRIDE:-}" ] && compose+=(-f "$SUHBAT_COMPOSE_OVERRIDE")
compose+=(--project-directory "$DEPLOY")
run "${compose[@]}" up -d --build --remove-orphans

if [ "$DRY_RUN" = 0 ]; then
  printf '%s' '    Ilova ishga tushishi kutilmoqda'
  status=""
  for _ in $(seq 1 60); do
    cid="$("${compose[@]}" ps -q suhbat 2>/dev/null || true)"
    status="$([ -n "$cid" ] && docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    [ "$status" = healthy ] && break
    printf '.'
    sleep 3
  done
  echo
  [ "$status" = healthy ] || die "Ilova ishga tushmadi (holat: ${status:-yo‘q}). Sababini ko'ring: cd $DEPLOY && docker compose logs --tail=50 suhbat"

  printf '    HTTPS sertifikat va sayt tekshirilmoqda'
  curl_opts=(-fsS --max-time 10 -o /dev/null --noproxy "$DOMAIN")
  [ "$DOMAIN" = localhost ] && curl_opts+=(-k)
  site_ok=0
  for _ in $(seq 1 40); do
    if curl "${curl_opts[@]}" "https://$DOMAIN/style.css" 2>/dev/null; then
      site_ok=1
      break
    fi
    printf '.'
    sleep 3
  done
  echo
  if [ "$site_ok" = 0 ]; then
    warn "Sayt hali HTTPS orqali javob bermayapti. Sabablari: DNS hali yangilanmagan yoki 80/443 port yopiq."
    warn "Tekshiring: cd $DEPLOY && docker compose logs --tail=50 caddy"
  fi
fi

line='────────────────────────────────────────────────────────────'
printf '\n%s\n' "$line"
if [ "$DRY_RUN" = 1 ]; then
  echo "  SINOV tugadi — hech narsa o'zgartirilmadi."
else
  echo "  SUHBAT tayyor!"
fi
echo
echo "  Sayt:    https://$DOMAIN"
echo "  Parol:   $PASSWORD"
echo
echo "  Keyingi qadam: saytga kiring → ⚙ Sozlamalar → ElevenLabs va Anthropic"
echo "  kalitlarini kiriting → «Saqlash va tekshirish» (ikkalasi ham ✓ bo'lsin)."
echo
echo "  Yangilash:  shu buyruqni qayta ishga tushiring (parol va kalitlar saqlanadi)."
echo "  Loglar:     cd $DEPLOY && docker compose logs -f suhbat"
echo "  Sozlamalar: $ENV_FILE"
printf '%s\n' "$line"
