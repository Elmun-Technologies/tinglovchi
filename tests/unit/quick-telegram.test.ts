import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { handleUpdate, webhookSecretMatches } =
  await import('../../apps/web/src/lib/quick/telegram');
const { listSessions, readSession } = await import('../../apps/web/src/lib/quick/store');

type Sent = { method: string; body: Record<string, unknown> | FormData };

let dataDir: string;
let sent: Sent[];

function stubTelegram() {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3, 4]));
      const method = url.split('/').pop()!;
      const body =
        init?.body instanceof FormData
          ? init.body
          : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      sent.push({ method, body });
      if (method === 'getFile')
        return Response.json({ ok: true, result: { file_path: 'voice/1.oga' } });
      return Response.json({ ok: true, result: {} });
    }),
  );
}

const texts = () =>
  sent
    .filter((entry) => entry.method === 'sendMessage')
    .map((entry) => String((entry.body as Record<string, unknown>).text));

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'suhbat-telegram-'));
  vi.stubEnv('SUHBAT_DATA_DIR', dataDir);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:abc');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'hook-secret');
  vi.stubEnv('SUHBAT_ACCESS_CODE', 'jamoa-kodi');
  vi.stubEnv('APP_URL', 'https://suhbat.example.com');
  vi.stubEnv('SUHBAT_FAKE_AI', '1');
  stubTelegram();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
});

const chat = { id: 777 };

describe('telegram bot', () => {
  it('accepts only updates that carry the webhook secret', () => {
    expect(webhookSecretMatches('hook-secret')).toBe(true);
    expect(webhookSecretMatches('wrong')).toBe(false);
    expect(webhookSecretMatches(null)).toBe(false);
  });

  it('lets a chat in only with the access code and ignores recordings before that', async () => {
    await handleUpdate({ message: { chat, voice: { file_id: 'f1', duration: 3 } } });
    await handleUpdate({ message: { chat, text: '/start noto‘g‘ri' } });
    expect(await listSessions()).toEqual([]);
    expect(texts().at(-1)).toMatch(/Kod noto‘g‘ri/);

    await handleUpdate({ message: { chat, text: '/start jamoa-kodi' } });
    expect(texts().at(-1)).toMatch(/Kirdingiz/);
  });

  it('turns a voice message into an analysis and sends back the summary, mind map and slides', async () => {
    await handleUpdate({ message: { chat, text: 'jamoa-kodi' } });
    await handleUpdate({ message: { chat, text: '/til ru' } });
    await handleUpdate({
      message: {
        chat,
        caption: 'Do‘stlar bilan suhbat',
        voice: { file_id: 'voice-1', duration: 42, mime_type: 'audio/ogg', file_size: 4 },
      },
    });

    const [summary] = await waitFor(listSessions, (sessions) => sessions.length === 1);
    const session = await waitFor(
      () => readSession(summary!.id),
      (current) => current?.status === 'ready',
    );
    expect(session).toMatchObject({
      source: 'telegram',
      telegramChatId: 777,
      language: 'ru',
      title: 'Do‘stlar bilan suhbat',
      audioMimeType: 'audio/ogg',
      recordedMs: 42_000,
    });

    await waitFor(
      async () => sent.map((entry) => entry.method),
      (methods) => methods.includes('sendDocument'),
    );
    const result = texts().find((text) => text.includes('To‘liq natija'))!;
    expect(result).toContain('Mind map');
    expect(result).toContain(`https://suhbat.example.com/yoz/${session!.id}`);

    const document = sent.find((entry) => entry.method === 'sendDocument')!.body as FormData;
    expect(document.get('chat_id')).toBe('777');
    const file = document.get('document') as File;
    expect(file.name).toBe('Do‘stlar bilan suhbat.pptx');
    // A real .pptx is a zip archive.
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    expect([...head]).toEqual([0x50, 0x4b]);
  });

  it('points files over the bot download limit to the website', async () => {
    await handleUpdate({ message: { chat, text: 'jamoa-kodi' } });
    await handleUpdate({
      message: {
        chat,
        audio: { file_id: 'big', mime_type: 'audio/mp4', file_size: 50 * 1024 * 1024 },
      },
    });
    expect(texts().at(-1)).toMatch(/20 MB dan katta[\s\S]*https:\/\/suhbat\.example\.com\/yoz/);
    expect(await listSessions()).toEqual([]);
  });

  it('refuses files that are not audio or video', async () => {
    await handleUpdate({ message: { chat, text: 'jamoa-kodi' } });
    await handleUpdate({
      message: { chat, document: { file_id: 'pdf', mime_type: 'application/pdf', file_size: 10 } },
    });
    expect(texts().at(-1)).toMatch(/audio yoki video emas/);
  });
});

describe('telegram webhook secret', () => {
  it('derives the secret from the bot token when none is set, matching the deploy workflow', async () => {
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    const { webhookSecret } = await import('../../apps/web/src/lib/quick/telegram');
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', '123:abc')
      .update('suhbat-telegram-webhook')
      .digest('hex');
    expect(webhookSecret()).toBe(expected);
    expect(webhookSecretMatches(expected)).toBe(true);
  });
});
