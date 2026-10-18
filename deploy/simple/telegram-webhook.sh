#!/usr/bin/env bash
# Points the Telegram bot at this server. Run once after the first `docker compose up -d`, and again if the
# domain or the bot token changes. Reads DOMAIN and TELEGRAM_BOT_TOKEN from .env.
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
source .env
set +a
: "${DOMAIN:?DOMAIN is not set in .env}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set in .env}"
# Same derivation as webhookSecret() in apps/web/src/lib/quick/telegram.ts.
secret=$(printf '%s' 'suhbat-telegram-webhook' | openssl dgst -sha256 -hmac "$TELEGRAM_BOT_TOKEN" | awk '{print $NF}')
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://${DOMAIN}/api/quick/telegram" \
  --data-urlencode "secret_token=${secret}" \
  --data-urlencode 'allowed_updates=["message"]'
echo
echo "Bot connected to https://${DOMAIN}. Open it in Telegram and send the access code."
