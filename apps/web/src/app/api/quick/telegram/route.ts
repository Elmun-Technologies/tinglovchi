import type { NextRequest } from 'next/server';
import { error, json } from '../../../../lib/quick/http';
import {
  handleUpdate,
  telegramConfigured,
  webhookSecretMatches,
  type TelegramUpdate,
} from '../../../../lib/quick/telegram';

/**
 * Telegram webhook. Telegram signs every delivery with the secret given at registration; anything without it
 * is rejected. The update is handled after the response, since downloading a recording can take a while
 * and Telegram re-sends updates that are not acknowledged quickly.
 */
export async function POST(request: NextRequest) {
  if (!telegramConfigured()) return error(404, 'Telegram bot is not configured.');
  if (!webhookSecretMatches(request.headers.get('x-telegram-bot-api-secret-token'))) {
    return error(401, 'Bad webhook secret.');
  }
  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  if (update) {
    void handleUpdate(update).catch((cause) => {
      console.error('[suhbat] telegram update failed:', cause);
    });
  }
  return json({ ok: true });
}
