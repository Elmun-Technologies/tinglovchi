import { describe, expect, it } from 'vitest';
import {
  createTelegramLinkTokenRequestSchema,
  processingEventTypeSchema,
  processingJobTypeSchema,
  telegramBotMessageUpdateSchema,
  updateTelegramPreferencesRequestSchema,
} from '@suhbat/contracts';
import {
  FakeTelegramBotProvider,
  HttpTelegramBotProvider,
  TelegramProviderError,
  constantTimeSecretEquals,
  createTelegramBotProviderFromEnv,
} from '@suhbat/database/telegram-provider';

describe('Phase 8 Telegram contracts & provider unit tests', () => {
  it('validates processingJobTypeSchema and processingEventTypeSchema for Phase 8', () => {
    expect(processingJobTypeSchema.parse('send_telegram_notifications')).toBe(
      'send_telegram_notifications',
    );
    expect(processingEventTypeSchema.parse('telegram_link_token_created')).toBe(
      'telegram_link_token_created',
    );
    expect(processingEventTypeSchema.parse('telegram_account_linked')).toBe(
      'telegram_account_linked',
    );
    expect(processingEventTypeSchema.parse('telegram_account_unlinked')).toBe(
      'telegram_account_unlinked',
    );
    expect(processingEventTypeSchema.parse('telegram_notification_sent')).toBe(
      'telegram_notification_sent',
    );
    expect(processingEventTypeSchema.parse('telegram_notification_failed')).toBe(
      'telegram_notification_failed',
    );
    expect(processingEventTypeSchema.parse('telegram_rate_limited')).toBe('telegram_rate_limited');
  });

  it('validates Telegram link token, preferences, and bot update schemas', () => {
    const tokenReq = createTelegramLinkTokenRequestSchema.parse({});
    expect(tokenReq.expiresInSeconds).toBeUndefined();

    expect(() => createTelegramLinkTokenRequestSchema.parse({ expiresInSeconds: 10 })).toThrow();

    const prefs = updateTelegramPreferencesRequestSchema.parse({
      preferredLanguage: 'uz',
      notifyOnMeetingReady: false,
    });
    expect(prefs.preferredLanguage).toBe('uz');
    expect(prefs.notifyOnMeetingReady).toBe(false);

    const update = telegramBotMessageUpdateSchema.parse({
      updateId: 101,
      message: {
        messageId: 501,
        date: 1_790_000_000,
        chat: { id: '88001122', type: 'private' },
        from: {
          id: '88001122',
          username: 'jamshid_uz',
          firstName: 'Jamshid',
          languageCode: 'uz',
        },
        text: '/start tglink_abc123',
      },
    });
    expect(update.message.chat.id).toBe('88001122');
    expect(update.message.text).toBe('/start tglink_abc123');
  });

  it('FakeTelegramBotProvider records sent messages, verifies webhook secrets, and simulates failures', async () => {
    const provider = new FakeTelegramBotProvider({
      botUsername: 'suhbat_test_bot',
      webhookSecret: 'secret-token-xyz',
    });

    expect(provider.verifyWebhookSecret('secret-token-xyz')).toBe(true);
    // incorrect same-length secret
    expect(provider.verifyWebhookSecret('secret-token-xy0')).toBe(false);
    // shorter secret
    expect(provider.verifyWebhookSecret('secret-token')).toBe(false);
    // longer secret
    expect(provider.verifyWebhookSecret('secret-token-xyz-extra')).toBe(false);
    // empty / whitespace / null / undefined secrets
    expect(provider.verifyWebhookSecret('')).toBe(false);
    expect(provider.verifyWebhookSecret('   ')).toBe(false);
    expect(provider.verifyWebhookSecret(null)).toBe(false);
    expect(provider.verifyWebhookSecret(undefined)).toBe(false);

    expect(constantTimeSecretEquals('secret-token-xyz', 'secret-token-xyz')).toBe(true);
    expect(constantTimeSecretEquals('secret-token-xy0', 'secret-token-xyz')).toBe(false);
    expect(constantTimeSecretEquals('short', 'secret-token-xyz')).toBe(false);
    expect(constantTimeSecretEquals('secret-token-xyz-longer', 'secret-token-xyz')).toBe(false);
    expect(constantTimeSecretEquals('', 'secret-token-xyz')).toBe(false);
    expect(constantTimeSecretEquals('secret-token-xyz', '')).toBe(false);
    expect(constantTimeSecretEquals('', '')).toBe(false);

    const sent = await provider.sendMessage({
      chatId: '998877',
      text: 'Meeting ready: Tashkent Logistics Kickoff',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      meetingId: '50000000-0000-4000-8000-000000000001',
      deepLinks: [
        'https://app.suhbat.ai/w/10000000-0000-4000-8000-000000000001/meetings/50000000-0000-4000-8000-000000000001',
      ],
    });

    expect(sent.providerMessageId).toBe('tg_fake_msg_1');
    expect(provider.getSentMessages()).toHaveLength(1);
    expect(provider.getSentMessages()[0]?.chatId).toBe('998877');

    provider.injectFailureForChat('998877', {
      code: 'provider_unavailable',
      message: 'Telegram chat unreachable',
      retryable: true,
    });
    await expect(
      provider.sendMessage({
        chatId: '998877',
        text: 'Second notification',
      }),
    ).rejects.toBeInstanceOf(TelegramProviderError);
  });

  it('HttpTelegramBotProvider fails fast without botToken and maps HTTP 429/403 accurately', async () => {
    const unconfiguredProvider = new HttpTelegramBotProvider({
      botToken: '',
    });
    expect(unconfiguredProvider.isConfigured()).toBe(false);
    await expect(
      unconfiguredProvider.sendMessage({
        chatId: '12345',
        text: 'Hello',
      }),
    ).rejects.toBeInstanceOf(TelegramProviderError);

    expect(() =>
      createTelegramBotProviderFromEnv({
        SUHBAT_TELEGRAM_PROVIDER: 'telegram',
      }),
    ).toThrow(TelegramProviderError);

    const rateLimitedProvider = new HttpTelegramBotProvider({
      botToken: '123456:TEST_TOKEN',
      webhookSecret: 'wh_secret',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }), {
          status: 429,
        }),
    });

    await expect(
      rateLimitedProvider.sendMessage({
        chatId: '12345',
        text: 'Hello',
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });

    const blockedProvider = new HttpTelegramBotProvider({
      botToken: '123456:TEST_TOKEN',
      webhookSecret: 'wh_secret',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), {
          status: 403,
        }),
    });

    await expect(
      blockedProvider.sendMessage({
        chatId: '12345',
        text: 'Hello',
      }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
    });
  });
});
