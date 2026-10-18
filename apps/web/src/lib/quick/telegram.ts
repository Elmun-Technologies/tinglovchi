import 'server-only';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDeck, writePptx } from './deck';
import { ensureProcessing } from './pipeline';
import { audioExtension, createSession, dataDir } from './store';
import { summaryAsText } from './summary-text';
import type { AnalysisLanguage, Session } from './types';

/**
 * Telegram bot for the one-button flow: send it a voice message, an audio file (a phone dictaphone
 * recording) or a video, and it replies with the summary, the mind map, a link to the full result and the
 * presentation as a .pptx file.
 *
 * Configuration: TELEGRAM_BOT_TOKEN (from @BotFather). Every update must carry the webhook secret
 * (`webhookSecret()`). A chat is let in by sending the team's
 * SUHBAT_ACCESS_CODE once. TELEGRAM_TEAM_CHAT_ID optionally also receives results of web recordings.
 */

// Telegram lets bots download files up to 20 MB; larger ones must come through the website.
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const MAX_CODE_ATTEMPTS = 10;
const MESSAGE_LIMIT = 4000;

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

/**
 * The secret Telegram must send with every update. Derived from the bot token unless set explicitly, so the
 * owner has one value less to manage; the deploy workflow registers the webhook with the same derivation.
 */
export function webhookSecret(): string | null {
  const explicit = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  return createHmac('sha256', token).update('suhbat-telegram-webhook').digest('hex');
}

export function webhookSecretMatches(header: string | null): boolean {
  const expected = webhookSecret();
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function appUrl(): string {
  return (process.env.APP_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ Bot API */

async function call<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    ...(body instanceof FormData
      ? { body }
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description ?? response.status}`);
  return payload.result as T;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const trimmed = text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
  await call('sendMessage', {
    chat_id: chatId,
    text: trimmed,
    link_preview_options: { is_disabled: true },
  });
}

async function sendDocument(
  chatId: number,
  bytes: Buffer,
  fileName: string,
  caption: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('document', new Blob([new Uint8Array(bytes)]), fileName);
  await call('sendDocument', form);
}

async function downloadFile(fileId: string): Promise<Uint8Array> {
  const file = await call<{ file_path?: string }>('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('Telegram returned no file path.');
  const token = process.env.TELEGRAM_BOT_TOKEN!.trim();
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

/* --------------------------------------------------------------- chat state */

type ChatState = { authorized: boolean; failedAttempts: number; language: AnalysisLanguage };
type ChatStore = Record<string, ChatState>;

function chatsPath(): string {
  return join(dataDir(), 'telegram', 'chats.json');
}

let chatsLock: Promise<unknown> = Promise.resolve();

async function readChats(): Promise<ChatStore> {
  try {
    return JSON.parse(await readFile(chatsPath(), 'utf8')) as ChatStore;
  } catch {
    return {};
  }
}

async function updateChat(
  chatId: number,
  patch: (state: ChatState) => ChatState,
): Promise<ChatState> {
  const run = async () => {
    const chats = await readChats();
    const next = patch(chats[chatId] ?? { authorized: false, failedAttempts: 0, language: 'uz' });
    chats[chatId] = next;
    await mkdir(join(dataDir(), 'telegram'), { recursive: true });
    const temporary = `${chatsPath()}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(chats, null, 2));
    await rename(temporary, chatsPath());
    return next;
  };
  const result = chatsLock.catch(() => undefined).then(run);
  chatsLock = result;
  return result;
}

async function chatState(chatId: number): Promise<ChatState> {
  return (await readChats())[chatId] ?? { authorized: false, failedAttempts: 0, language: 'uz' };
}

function codeMatches(submitted: string): boolean {
  const code = process.env.SUHBAT_ACCESS_CODE?.trim();
  if (!code) return false;
  const a = Buffer.from(submitted.trim());
  const b = Buffer.from(code);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ updates */

type TelegramFile = {
  file_id: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
};

export type TelegramUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
    caption?: string;
    voice?: TelegramFile;
    audio?: TelegramFile;
    document?: TelegramFile;
    video?: TelegramFile;
    video_note?: TelegramFile;
  };
};

const HELP = [
  'Suhbatni yuboring — tahlil qilib beraman:',
  '🎙 ovozli xabar yozing yoki',
  '📎 telefon diktofonidagi audio faylni (m4a, mp3, ogg…) yoki videoni yuboring.',
  '',
  'Natijada: xulosa, qarorlar, vazifalar, mind map, roadmap va PowerPoint prezentatsiya.',
  '',
  'Uzun yozuvlar uchun: telefonning o‘z «Diktofon» ilovasida yozing (ekran qulflansa ham yozadi), keyin faylni shu yerga yuboring. 20 MB dan katta fayllarni saytga yuklang:',
].join('\n');

const LANGUAGE_NAMES: Record<AnalysisLanguage, string> = {
  uz: 'o‘zbekcha',
  ru: 'ruscha',
  en: 'inglizcha',
};

function helpText(language: AnalysisLanguage): string {
  return `${HELP}\n${appUrl()}/yoz\n\nTahlil tili: ${LANGUAGE_NAMES[language]}. O‘zgartirish: /til uz, /til ru yoki /til en`;
}

function recordingIn(message: NonNullable<TelegramUpdate['message']>): {
  file: TelegramFile;
  mimeType: string;
} | null {
  if (message.voice)
    return { file: message.voice, mimeType: message.voice.mime_type || 'audio/ogg' };
  if (message.audio)
    return { file: message.audio, mimeType: message.audio.mime_type || 'audio/mpeg' };
  if (message.video)
    return { file: message.video, mimeType: message.video.mime_type || 'video/mp4' };
  if (message.video_note) return { file: message.video_note, mimeType: 'video/mp4' };
  if (message.document) {
    return { file: message.document, mimeType: message.document.mime_type || '' };
  }
  return null;
}

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const state = await chatState(chatId);
  const text = message.text?.trim() ?? '';

  if (!state.authorized) {
    if (state.failedAttempts >= MAX_CODE_ATTEMPTS) return;
    const submitted = text.replace(/^\/start\s*/, '');
    if (!submitted) {
      await sendMessage(chatId, 'Assalomu alaykum! Kirish uchun jamoangiz kirish kodini yuboring.');
      return;
    }
    if (codeMatches(submitted)) {
      await updateChat(chatId, (current) => ({ ...current, authorized: true, failedAttempts: 0 }));
      await sendMessage(chatId, `✅ Kirdingiz.\n\n${helpText(state.language)}`);
    } else {
      await updateChat(chatId, (current) => ({
        ...current,
        failedAttempts: current.failedAttempts + 1,
      }));
      await sendMessage(chatId, 'Kod noto‘g‘ri. Qayta yuboring.');
    }
    return;
  }

  const languageCommand = /^\/til(?:@\w+)?\s+(uz|ru|en)\b/i.exec(text);
  if (languageCommand) {
    const language = languageCommand[1]!.toLowerCase() as AnalysisLanguage;
    await updateChat(chatId, (current) => ({ ...current, language }));
    await sendMessage(chatId, `Tahlil tili: ${LANGUAGE_NAMES[language]}.`);
    return;
  }

  const recording = recordingIn(message);
  if (!recording) {
    await sendMessage(chatId, helpText(state.language));
    return;
  }
  if (!audioExtension(recording.mimeType)) {
    await sendMessage(
      chatId,
      'Bu fayl audio yoki video emas. Ovozli xabar yoki audio fayl yuboring.',
    );
    return;
  }
  if ((recording.file.file_size ?? 0) > BOT_DOWNLOAD_LIMIT) {
    await sendMessage(
      chatId,
      `Fayl 20 MB dan katta — Telegram botlarga bunday faylni bermaydi. Uni saytga yuklang:\n${appUrl()}/yoz`,
    );
    return;
  }

  await sendMessage(chatId, '⏳ Qabul qilindi. Tahlil tayyor bo‘lganda shu yerga yuboraman.');
  try {
    const audio = await downloadFile(recording.file.file_id);
    const session = await createSession({
      audio,
      mimeType: recording.mimeType,
      recordedMs: (recording.file.duration ?? 0) * 1000,
      title: message.caption?.trim().slice(0, 200) || null,
      language: state.language,
      captureMode: 'file',
      source: 'telegram',
      telegramChatId: chatId,
    });
    ensureProcessing(session);
  } catch (cause) {
    console.error('[suhbat] telegram intake failed:', cause);
    await sendMessage(chatId, '❌ Faylni olib bo‘lmadi. Qayta yuboring yoki saytga yuklang.');
  }
}

/* ------------------------------------------------------------------ results */

function mindMapText(session: Session): string {
  const map = session.analysis?.mindMap;
  if (!map || map.branches.length === 0) return '';
  const lines = map.branches.map(
    (branch) =>
      `• ${branch.title}${branch.children.length > 0 ? `: ${branch.children.join(', ')}` : ''}`,
  );
  return `🧠 Mind map — ${map.center}\n${lines.join('\n')}`;
}

async function deliver(chatId: number, session: Session): Promise<void> {
  const link = `${appUrl()}/yoz/${session.id}`;
  if (session.status === 'failed') {
    await sendMessage(
      chatId,
      `❌ Tahlil tugallanmadi: ${session.error ?? 'noma’lum xato'}\nAudio saqlangan, saytda qayta urinish mumkin:\n${link}`,
    );
    return;
  }
  if (!session.analysis) return;
  const parts = [summaryAsText(session), mindMapText(session), `🔗 To‘liq natija: ${link}`];
  await sendMessage(chatId, parts.filter(Boolean).join('\n\n'));
  const deck = buildDeck(session, session.analysis);
  const bytes = await writePptx(deck, 'buffer');
  const name = (session.title ?? session.analysis.title).replace(/[\\/:*?"<>|]+/g, ' ').trim();
  await sendDocument(chatId, bytes, `${name || 'suhbat'}.pptx`, '📊 Prezentatsiya');
}

/**
 * Sends a finished (or failed) session to the chat it came from, and a web recording's result to the team
 * chat when one is configured. Delivery problems are logged, never thrown: the analysis itself is saved.
 */
export async function notifySessionFinished(session: Session): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return;
  const targets = new Set<number>();
  if (session.telegramChatId !== null) targets.add(session.telegramChatId);
  const team = Number(process.env.TELEGRAM_TEAM_CHAT_ID?.trim());
  if (session.source === 'web' && Number.isInteger(team) && team !== 0) targets.add(team);
  for (const chatId of targets) {
    try {
      await deliver(chatId, session);
    } catch (cause) {
      console.error(`[suhbat] telegram delivery to ${chatId} failed:`, cause);
    }
  }
}
