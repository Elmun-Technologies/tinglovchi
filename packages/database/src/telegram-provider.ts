import { timingSafeEqual } from 'node:crypto';

export type TelegramSendMessageRequest = {
  chatId: string;
  text: string;
  workspaceId?: string;
  meetingId?: string;
  deepLinks?: string[];
};

/**
 * Constant-time webhook secret comparison.
 *
 * - Converts expected and supplied values to UTF-8 buffers.
 * - Rejects empty secrets (`byteLength === 0`).
 * - Compares buffer byte lengths first and returns `false` immediately on mismatch
 *   so `timingSafeEqual` never throws `RangeError [ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH]`.
 */
export function constantTimeSecretEquals(
  supplied: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const bufSupplied = Buffer.from(supplied.trim(), 'utf8');
  const bufExpected = Buffer.from(expected.trim(), 'utf8');
  if (bufSupplied.byteLength === 0 || bufExpected.byteLength === 0) {
    return false;
  }
  if (bufSupplied.byteLength !== bufExpected.byteLength) {
    return false;
  }
  return timingSafeEqual(bufSupplied, bufExpected);
}

export type TelegramSendMessageResponse = {
  provider: string;
  providerMessageId: string;
  sentAt: string;
};

export type TelegramProviderErrorCode =
  'provider_not_configured' | 'provider_unavailable' | 'provider_invalid_response' | 'rate_limited';

export class TelegramProviderError extends Error {
  readonly code: TelegramProviderErrorCode;
  readonly retryable: boolean;

  constructor(params: { code: TelegramProviderErrorCode; message: string; retryable: boolean }) {
    super(params.message);
    this.name = 'TelegramProviderError';
    this.code = params.code;
    this.retryable = params.retryable;
  }
}

export interface TelegramBotProvider {
  readonly providerName: string;
  readonly botUsername: string;
  isConfigured(): boolean;
  verifyWebhookSecret(headerSecret: string | null | undefined): boolean;
  sendMessage(request: TelegramSendMessageRequest): Promise<TelegramSendMessageResponse>;
}

export class FakeTelegramBotProvider implements TelegramBotProvider {
  readonly providerName = 'fake';
  readonly botUsername: string;
  private readonly webhookSecret: string;
  private messageCounter = 0;
  private readonly sentMessages: Array<
    TelegramSendMessageRequest & { providerMessageId: string; sentAt: string }
  > = [];
  private readonly injectedFailuresByChat = new Map<
    string,
    { code: TelegramProviderErrorCode; message: string; retryable: boolean }
  >();
  private readonly injectedFailuresByMeeting = new Map<
    string,
    { code: TelegramProviderErrorCode; message: string; retryable: boolean }
  >();

  constructor(options?: { botUsername?: string; webhookSecret?: string }) {
    this.botUsername = options?.botUsername ?? 'suhbat_ai_bot';
    this.webhookSecret = options?.webhookSecret ?? 'fake-telegram-webhook-secret';
  }

  isConfigured(): boolean {
    return true;
  }

  verifyWebhookSecret(headerSecret: string | null | undefined): boolean {
    return constantTimeSecretEquals(headerSecret, this.webhookSecret);
  }

  getSentMessages(): ReadonlyArray<
    TelegramSendMessageRequest & { providerMessageId: string; sentAt: string }
  > {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages.length = 0;
  }

  injectFailureForChat(
    chatId: string,
    failure: { code: TelegramProviderErrorCode; message: string; retryable: boolean },
  ): void {
    this.injectedFailuresByChat.set(chatId, failure);
  }

  clearFailureForChat(chatId: string): void {
    this.injectedFailuresByChat.delete(chatId);
  }

  injectFailureForMeeting(
    meetingId: string,
    failure: { code: TelegramProviderErrorCode; message: string; retryable: boolean },
  ): void {
    this.injectedFailuresByMeeting.set(meetingId, failure);
  }

  clearFailureForMeeting(meetingId: string): void {
    this.injectedFailuresByMeeting.delete(meetingId);
  }

  async sendMessage(request: TelegramSendMessageRequest): Promise<TelegramSendMessageResponse> {
    const chatFailure = this.injectedFailuresByChat.get(request.chatId);
    if (chatFailure) {
      throw new TelegramProviderError(chatFailure);
    }
    if (request.meetingId) {
      const meetingFailure = this.injectedFailuresByMeeting.get(request.meetingId);
      if (meetingFailure) {
        throw new TelegramProviderError(meetingFailure);
      }
    }

    this.messageCounter += 1;
    const providerMessageId = `tg_fake_msg_${this.messageCounter}`;
    const sentAt = new Date().toISOString();
    this.sentMessages.push({
      ...request,
      providerMessageId,
      sentAt,
    });

    return {
      provider: this.providerName,
      providerMessageId,
      sentAt,
    };
  }
}

export type HttpTelegramBotProviderOptions = {
  botToken?: string | undefined;
  botUsername?: string | undefined;
  webhookSecret?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export class HttpTelegramBotProvider implements TelegramBotProvider {
  readonly providerName = 'telegram_bot_api';
  readonly botUsername: string;
  private readonly botToken: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: HttpTelegramBotProviderOptions) {
    this.botToken = options?.botToken?.trim() || undefined;
    this.botUsername = options?.botUsername?.trim() || 'suhbat_ai_bot';
    this.webhookSecret = options?.webhookSecret?.trim() || undefined;
    this.baseUrl = (options?.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.botToken && this.webhookSecret);
  }

  verifyWebhookSecret(headerSecret: string | null | undefined): boolean {
    return constantTimeSecretEquals(headerSecret, this.webhookSecret);
  }

  async sendMessage(request: TelegramSendMessageRequest): Promise<TelegramSendMessageResponse> {
    if (!this.botToken || !this.webhookSecret) {
      throw new TelegramProviderError({
        code: 'provider_not_configured',
        message:
          'Telegram Bot API provider is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.',
        retryable: false,
      });
    }

    let parsedBase: URL;
    try {
      parsedBase = new URL(this.baseUrl);
    } catch {
      throw new TelegramProviderError({
        code: 'provider_not_configured',
        message: 'Telegram Bot API baseUrl is invalid.',
        retryable: false,
      });
    }
    if (parsedBase.protocol !== 'https:') {
      throw new TelegramProviderError({
        code: 'provider_not_configured',
        message: 'Telegram Bot API baseUrl must use HTTPS.',
        retryable: false,
      });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: request.chatId,
          text: request.text,
          disable_web_page_preview: true,
        }),
      });
    } catch {
      throw new TelegramProviderError({
        code: 'provider_unavailable',
        message: 'Telegram Bot API request failed due to a network transport error.',
        retryable: true,
      });
    }

    if (response.status === 429) {
      throw new TelegramProviderError({
        code: 'rate_limited',
        message: 'Telegram Bot API rate limit exceeded.',
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new TelegramProviderError({
        code: 'provider_unavailable',
        message: `Telegram Bot API returned HTTP ${response.status}.`,
        retryable: response.status >= 500,
      });
    }

    const json = (await response.json()) as {
      ok?: boolean;
      result?: { message_id?: number | string };
    };

    if (!json.ok || json.result?.message_id === undefined) {
      throw new TelegramProviderError({
        code: 'provider_invalid_response',
        message: 'Telegram Bot API response did not contain result.message_id.',
        retryable: false,
      });
    }

    return {
      provider: this.providerName,
      providerMessageId: String(json.result.message_id),
      sentAt: new Date().toISOString(),
    };
  }
}

export function createTelegramBotProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): TelegramBotProvider {
  const isProd = env.NODE_ENV === 'production';
  const rawMode =
    env.SUHBAT_TELEGRAM_PROVIDER ?? env.TELEGRAM_PROVIDER ?? (isProd ? 'telegram' : 'fake');
  const mode = rawMode.trim().toLowerCase();

  if (mode === 'fake') {
    if (isProd) {
      throw new TelegramProviderError({
        code: 'provider_not_configured',
        message: 'FakeTelegramBotProvider is not permitted in production.',
        retryable: false,
      });
    }
    return new FakeTelegramBotProvider({
      ...(env.TELEGRAM_BOT_USERNAME ? { botUsername: env.TELEGRAM_BOT_USERNAME } : {}),
      ...(env.TELEGRAM_WEBHOOK_SECRET ? { webhookSecret: env.TELEGRAM_WEBHOOK_SECRET } : {}),
    });
  }

  if (mode === 'telegram' || mode === 'telegram_bot_api' || mode === 'live') {
    if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
      throw new TelegramProviderError({
        code: 'provider_not_configured',
        message:
          'Live Telegram provider requires TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET when SUHBAT_TELEGRAM_PROVIDER=telegram.',
        retryable: false,
      });
    }
    return new HttpTelegramBotProvider({
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUsername: env.TELEGRAM_BOT_USERNAME,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      baseUrl: env.TELEGRAM_API_BASE_URL,
    });
  }

  throw new TelegramProviderError({
    code: 'provider_not_configured',
    message: `Unsupported SUHBAT_TELEGRAM_PROVIDER="${mode}". Expected "fake" or "telegram".`,
    retryable: false,
  });
}
