import { z } from 'zod';

const uuidSchema = () =>
  z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'expected a lowercase UUID',
    );

const countSchema = z.number().int().nonnegative();

export const telegramLinkTokenStatusSchema = z.enum(['pending', 'redeemed', 'expired', 'revoked']);
export type TelegramLinkTokenStatus = z.infer<typeof telegramLinkTokenStatusSchema>;

export const telegramAccountLinkStatusSchema = z.enum(['active', 'unlinked', 'suspended']);
export type TelegramAccountLinkStatus = z.infer<typeof telegramAccountLinkStatusSchema>;

export const telegramNotificationStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped',
]);
export type TelegramNotificationStatus = z.infer<typeof telegramNotificationStatusSchema>;

export const telegramPreferredLanguageSchema = z.enum(['uz', 'ru', 'en']);
export type TelegramPreferredLanguage = z.infer<typeof telegramPreferredLanguageSchema>;

export const telegramLinkTokenDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  userId: uuidSchema(),
  status: telegramLinkTokenStatusSchema,
  expiresAt: z.string().datetime(),
  redeemedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type TelegramLinkTokenDto = z.infer<typeof telegramLinkTokenDtoSchema>;

export const createTelegramLinkTokenRequestSchema = z.object({
  expiresInSeconds: z.number().int().min(60).max(3600).optional(),
});
export type CreateTelegramLinkTokenRequestInput = z.input<
  typeof createTelegramLinkTokenRequestSchema
>;

export const createTelegramLinkTokenResponseSchema = z.object({
  tokenRecord: telegramLinkTokenDtoSchema,
  rawToken: z.string().min(24).max(160),
  botDeepLinkUrl: z.string().url(),
});
export type CreateTelegramLinkTokenResponse = z.infer<typeof createTelegramLinkTokenResponseSchema>;

export const telegramAccountLinkDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  userId: uuidSchema(),
  telegramUserId: z.string().min(1).max(64),
  telegramChatId: z.string().min(1).max(64),
  telegramUsername: z.string().min(1).max(120).nullable(),
  telegramDisplayName: z.string().min(1).max(160).nullable(),
  preferredLanguage: telegramPreferredLanguageSchema,
  notifyOnMeetingReady: z.boolean(),
  status: telegramAccountLinkStatusSchema,
  linkedAt: z.string().datetime(),
  unlinkedAt: z.string().datetime().nullable(),
  lastCommandAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TelegramAccountLinkDto = z.infer<typeof telegramAccountLinkDtoSchema>;

export const updateTelegramPreferencesRequestSchema = z.object({
  preferredLanguage: telegramPreferredLanguageSchema.optional(),
  notifyOnMeetingReady: z.boolean().optional(),
});
export type UpdateTelegramPreferencesRequestInput = z.input<
  typeof updateTelegramPreferencesRequestSchema
>;

export const telegramNotificationDeliveryDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  telegramAccountLinkId: uuidSchema(),
  userId: uuidSchema(),
  notificationType: z.literal('meeting_ready'),
  idempotencyKey: z.string().min(8).max(200),
  status: telegramNotificationStatusSchema,
  attemptCount: countSchema,
  maxAttempts: z.number().int().min(1).max(10),
  deepLinkUrl: z.string().url(),
  payloadMetadata: z.record(z.string(), z.unknown()),
  providerMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TelegramNotificationDeliveryDto = z.infer<typeof telegramNotificationDeliveryDtoSchema>;

export const workspaceTelegramStatusResponseSchema = z.object({
  workspaceId: uuidSchema(),
  botUsername: z.string().min(1),
  currentUserLink: telegramAccountLinkDtoSchema.nullable(),
  activeWorkspaceLinkCount: countSchema,
  recentDeliveries: z.array(telegramNotificationDeliveryDtoSchema),
});
export type WorkspaceTelegramStatusResponse = z.infer<typeof workspaceTelegramStatusResponseSchema>;

export const telegramBotMessageUpdateSchema = z.object({
  updateId: z.number().int().nonnegative(),
  message: z.object({
    messageId: z.number().int().nonnegative(),
    date: z.number().int().nonnegative().optional(),
    text: z.string().trim().min(1).max(2000),
    chat: z.object({
      id: z.string().trim().min(1).max(64),
      type: z.enum(['private', 'group', 'supergroup', 'channel']).default('private'),
    }),
    from: z.object({
      id: z.string().trim().min(1).max(64),
      username: z.string().trim().min(1).max(120).optional(),
      firstName: z.string().trim().min(1).max(120).optional(),
      lastName: z.string().trim().min(1).max(120).optional(),
      languageCode: z.string().trim().min(2).max(16).optional(),
    }),
  }),
});
export type TelegramBotMessageUpdateInput = z.input<typeof telegramBotMessageUpdateSchema>;

export const telegramBotCommandResponseSchema = z.object({
  ok: z.boolean(),
  command: z.enum([
    'start',
    'status',
    'recent',
    'tasks',
    'summary',
    'ask',
    'unlink',
    'help',
    'rate_limited',
    'unauthorized',
  ]),
  chatId: z.string().min(1).max(64),
  replyText: z.string().min(1),
  deepLinks: z.array(z.string().url()),
  providerMessageId: z.string().nullable(),
});
export type TelegramBotCommandResponse = z.infer<typeof telegramBotCommandResponseSchema>;
