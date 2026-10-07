import { randomBytes } from 'node:crypto';
import {
  createTelegramLinkTokenRequestSchema,
  telegramBotMessageUpdateSchema,
  updateTelegramPreferencesRequestSchema,
  type CreateTelegramLinkTokenRequestInput,
  type CreateTelegramLinkTokenResponse,
  type ProcessingJobDto,
  type TelegramAccountLinkDto,
  type TelegramAccountLinkStatus,
  type TelegramBotCommandResponse,
  type TelegramBotMessageUpdateInput,
  type TelegramLinkTokenDto,
  type TelegramLinkTokenStatus,
  type TelegramNotificationDeliveryDto,
  type TelegramNotificationStatus,
  type TelegramPreferredLanguage,
  type UpdateTelegramPreferencesRequestInput,
  type WorkspaceTelegramStatusResponse,
} from '@suhbat/contracts';
import { getCanonicalAppUrl } from './config';
import {
  Phase4ServiceError,
  type AuthenticatedPrincipal,
  type ClaimJobOptions,
  type SqlExecutor,
  type StructuredObservabilityEvent,
} from './phase4-backbone';
import { Phase7KnowledgeService, Phase7KnowledgeWorker } from './phase7-knowledge';
import { computeSha256Hex } from './storage';
import { TelegramProviderError, type TelegramBotProvider } from './telegram-provider';

type DbTelegramLinkTokenRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  token_sha256: string;
  status: TelegramLinkTokenStatus;
  expires_at: string | Date;
  redeemed_at: string | Date | null;
  redeemed_telegram_user_id: string | null;
  redeemed_telegram_chat_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type DbTelegramAccountLinkRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  telegram_display_name: string | null;
  preferred_language: TelegramPreferredLanguage;
  notify_on_meeting_ready: boolean;
  status: TelegramAccountLinkStatus;
  rate_limit_window_started_at: string | Date;
  rate_limit_count: number;
  last_command_at: string | Date | null;
  linked_at: string | Date;
  unlinked_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type DbTelegramDeliveryRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  telegram_account_link_id: string;
  user_id: string;
  notification_type: 'meeting_ready';
  idempotency_key: string;
  status: TelegramNotificationStatus;
  attempt_count: number;
  max_attempts: number;
  deep_link_url: string;
  payload_metadata: Record<string, unknown> | null;
  provider_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  sent_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function toIsoString(val: string | Date): string {
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? String(val) : parsed.toISOString();
}

function toNullableIsoString(val: string | Date | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  return toIsoString(val);
}

function mapLinkTokenRow(row: DbTelegramLinkTokenRow): TelegramLinkTokenDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    status: row.status,
    expiresAt: toIsoString(row.expires_at),
    redeemedAt: toNullableIsoString(row.redeemed_at),
    createdAt: toIsoString(row.created_at),
  };
}

function mapAccountLinkRow(row: DbTelegramAccountLinkRow): TelegramAccountLinkDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    telegramUsername: row.telegram_username,
    telegramDisplayName: row.telegram_display_name,
    preferredLanguage: row.preferred_language,
    notifyOnMeetingReady: row.notify_on_meeting_ready,
    status: row.status,
    linkedAt: toIsoString(row.linked_at),
    unlinkedAt: toNullableIsoString(row.unlinked_at),
    lastCommandAt: toNullableIsoString(row.last_command_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapDeliveryRow(row: DbTelegramDeliveryRow): TelegramNotificationDeliveryDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    analysisRunId: row.analysis_run_id,
    telegramAccountLinkId: row.telegram_account_link_id,
    userId: row.user_id,
    notificationType: row.notification_type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    deepLinkUrl: row.deep_link_url,
    payloadMetadata: row.payload_metadata ?? {},
    providerMessageId: row.provider_message_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    sentAt: toNullableIsoString(row.sent_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

type DbJobPhase8Row = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  job_type: ProcessingJobDto['jobType'];
  generation: number;
  idempotency_key: string;
  status: ProcessingJobDto['status'];
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  heartbeat_at: string | Date | null;
  fencing_token: number | string;
  scheduled_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  error_code: string | null;
  error_message: string | null;
  error_metadata: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  result_metadata: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function mapJobPhase8Row(row: DbJobPhase8Row): ProcessingJobDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    jobType: row.job_type,
    generation: Number(row.generation),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toNullableIsoString(row.lease_expires_at),
    heartbeatAt: toNullableIsoString(row.heartbeat_at),
    fencingToken: Number(row.fencing_token),
    scheduledAt: toIsoString(row.scheduled_at),
    startedAt: toNullableIsoString(row.started_at),
    completedAt: toNullableIsoString(row.completed_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorMetadata: row.error_metadata ?? {},
    payload: row.payload ?? {},
    resultMetadata: row.result_metadata ?? {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function computeTokenSha256(rawToken: string): string {
  return computeSha256Hex(new TextEncoder().encode(rawToken.trim()));
}

export type Phase8TelegramServiceOptions = {
  db: SqlExecutor;
  phase7: Phase7KnowledgeService;
  telegramProvider: TelegramBotProvider;
  appUrl?: string;
  maxCommandsPerWindow?: number;
  rateLimitWindowSeconds?: number;
  onEvent?: (event: StructuredObservabilityEvent) => void;
};

function resolveDefaultAppUrl(): string {
  try {
    return String(getCanonicalAppUrl()).replace(/\/+$/, '');
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      throw err;
    }
    return 'http://localhost:3000';
  }
}

export class Phase8TelegramService {
  readonly db: SqlExecutor;
  readonly phase7: Phase7KnowledgeService;
  readonly telegramProvider: TelegramBotProvider;
  readonly appUrl: string;
  readonly maxCommandsPerWindow: number;
  readonly rateLimitWindowSeconds: number;
  private readonly onEvent?: ((event: StructuredObservabilityEvent) => void) | undefined;

  constructor(options: Phase8TelegramServiceOptions) {
    this.db = options.db;
    this.phase7 = options.phase7;
    this.telegramProvider = options.telegramProvider;
    this.appUrl = (options.appUrl ?? resolveDefaultAppUrl()).replace(/\/+$/, '');
    this.maxCommandsPerWindow = options.maxCommandsPerWindow ?? 10;
    this.rateLimitWindowSeconds = options.rateLimitWindowSeconds ?? 60;
    this.onEvent = options.onEvent;
  }

  private emitObservability(event: StructuredObservabilityEvent): void {
    this.onEvent?.(event);
  }

  private requirePrincipal(principal: AuthenticatedPrincipal | null): AuthenticatedPrincipal {
    if (!principal || !principal.userId) {
      throw new Phase4ServiceError(
        401,
        'unauthenticated',
        'Authenticated user session is required.',
      );
    }
    return principal;
  }

  private async requireActiveMembership(workspaceId: string, userId: string): Promise<void> {
    const res = await this.db.query<{ role: string }>(
      `select role
         from public.workspace_members
        where workspace_id = $1
          and user_id = $2
          and membership_status = 'active'`,
      [workspaceId, userId],
    );
    if (!res.rows[0]) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Caller does not have an active membership in the target workspace.',
      );
    }
  }

  buildMeetingDeepLink(
    workspaceId: string,
    meetingId: string,
    tab?: 'decisions' | 'tasks' | 'transcript' | 'facts' | 'questions',
  ): string {
    if (!tab) {
      return `${this.appUrl}/w/${workspaceId}/meetings/${meetingId}`;
    }
    return `${this.appUrl}/w/${workspaceId}/meetings/${meetingId}/${tab}`;
  }

  async createLinkToken(
    principal: AuthenticatedPrincipal | null,
    workspaceId: string,
    rawInput: CreateTelegramLinkTokenRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<CreateTelegramLinkTokenResponse> {
    const auth = this.requirePrincipal(principal);
    await this.requireActiveMembership(workspaceId, auth.userId);

    const parsed = createTelegramLinkTokenRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid Telegram link token request.',
      );
    }

    const now = options.now ?? new Date();
    const expiresInSeconds = parsed.data.expiresInSeconds ?? 900;
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);

    // Revoke any earlier pending tokens for this user in this workspace
    await this.db.query(
      `update public.telegram_link_tokens
          set status = 'revoked'
        where workspace_id = $1
          and user_id = $2
          and status = 'pending'`,
      [workspaceId, auth.userId],
    );

    const rawToken = `tglink_${randomBytes(24).toString('hex')}`;
    const tokenSha256 = computeTokenSha256(rawToken);

    const insertRes = await this.db.query<DbTelegramLinkTokenRow>(
      `insert into public.telegram_link_tokens (
        workspace_id, user_id, token_sha256, status, expires_at, created_at
      )
      values ($1, $2, $3, 'pending', $4, $5)
      returning *`,
      [workspaceId, auth.userId, tokenSha256, expiresAt.toISOString(), now.toISOString()],
    );
    const tokenRow = insertRes.rows[0]!;

    this.emitObservability({
      event: 'telegram_link_token_created',
      workspace_id: workspaceId,
      meeting_id: '',
      recording_id: null,
      source_id: null,
      chunk_id: null,
      job_id: null,
      sequence_no: null,
      fencing_token: null,
      timestamp: now.toISOString(),
      metadata: {
        actor_id: auth.userId,
        token_id: tokenRow.id,
        expires_at: expiresAt.toISOString(),
      },
    });

    const botDeepLinkUrl = `https://t.me/${this.telegramProvider.botUsername}?start=${rawToken}`;
    return {
      tokenRecord: mapLinkTokenRow(tokenRow),
      rawToken,
      botDeepLinkUrl,
    };
  }

  async getWorkspaceTelegramStatus(
    principal: AuthenticatedPrincipal | null,
    workspaceId: string,
  ): Promise<WorkspaceTelegramStatusResponse> {
    const auth = this.requirePrincipal(principal);
    await this.requireActiveMembership(workspaceId, auth.userId);

    const [ownLinkRes, countRes, deliveriesRes] = await Promise.all([
      this.db.query<DbTelegramAccountLinkRow>(
        `select *
           from public.telegram_account_links
          where workspace_id = $1
            and user_id = $2`,
        [workspaceId, auth.userId],
      ),
      this.db.query<{ cnt: string }>(
        `select count(*)::text as cnt
           from public.telegram_account_links tal
           join public.workspace_members wm
             on wm.workspace_id = tal.workspace_id
            and wm.user_id = tal.user_id
          where tal.workspace_id = $1
            and tal.status = 'active'
            and wm.membership_status = 'active'`,
        [workspaceId],
      ),
      this.db.query<DbTelegramDeliveryRow>(
        `select *
           from public.telegram_notification_deliveries
          where workspace_id = $1
            and user_id = $2
          order by created_at desc
          limit 20`,
        [workspaceId, auth.userId],
      ),
    ]);

    return {
      workspaceId,
      botUsername: this.telegramProvider.botUsername,
      currentUserLink: ownLinkRes.rows[0] ? mapAccountLinkRow(ownLinkRes.rows[0]) : null,
      activeWorkspaceLinkCount: Number.parseInt(countRes.rows[0]?.cnt ?? '0', 10),
      recentDeliveries: deliveriesRes.rows.map(mapDeliveryRow),
    };
  }

  async updatePreferences(
    principal: AuthenticatedPrincipal | null,
    workspaceId: string,
    rawInput: UpdateTelegramPreferencesRequestInput,
  ): Promise<TelegramAccountLinkDto> {
    const auth = this.requirePrincipal(principal);
    await this.requireActiveMembership(workspaceId, auth.userId);

    const parsed = updateTelegramPreferencesRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid Telegram preferences input.',
      );
    }

    const existingRes = await this.db.query<DbTelegramAccountLinkRow>(
      `select *
         from public.telegram_account_links
        where workspace_id = $1
          and user_id = $2
          and status = 'active'`,
      [workspaceId, auth.userId],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new Phase4ServiceError(
        404,
        'not_found',
        'No active Telegram account link exists for this user in the workspace.',
      );
    }

    const updatedRes = await this.db.query<DbTelegramAccountLinkRow>(
      `update public.telegram_account_links
          set preferred_language = coalesce($3, preferred_language),
              notify_on_meeting_ready = coalesce($4, notify_on_meeting_ready)
        where id = $1
          and workspace_id = $2
        returning *`,
      [
        existing.id,
        workspaceId,
        parsed.data.preferredLanguage ?? null,
        parsed.data.notifyOnMeetingReady ?? null,
      ],
    );

    return mapAccountLinkRow(updatedRes.rows[0]!);
  }

  async unlinkAccount(
    principal: AuthenticatedPrincipal | null,
    workspaceId: string,
    options: { now?: Date } = {},
  ): Promise<TelegramAccountLinkDto> {
    const auth = this.requirePrincipal(principal);
    await this.requireActiveMembership(workspaceId, auth.userId);
    const nowIso = (options.now ?? new Date()).toISOString();

    const existingRes = await this.db.query<DbTelegramAccountLinkRow>(
      `select *
         from public.telegram_account_links
        where workspace_id = $1
          and user_id = $2`,
      [workspaceId, auth.userId],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new Phase4ServiceError(
        404,
        'not_found',
        'No Telegram account link exists for this user in the workspace.',
      );
    }

    const updatedRes = await this.db.query<DbTelegramAccountLinkRow>(
      `update public.telegram_account_links
          set status = 'unlinked',
              unlinked_at = $3
        where id = $1
          and workspace_id = $2
        returning *`,
      [existing.id, workspaceId, nowIso],
    );

    this.emitObservability({
      event: 'telegram_account_unlinked',
      workspace_id: workspaceId,
      meeting_id: '',
      recording_id: null,
      source_id: null,
      chunk_id: null,
      job_id: null,
      sequence_no: null,
      fencing_token: null,
      timestamp: nowIso,
      metadata: {
        actor_id: auth.userId,
        link_id: existing.id,
      },
    });

    return mapAccountLinkRow(updatedRes.rows[0]!);
  }

  /**
   * Enqueues `send_telegram_notifications` idempotently for a ready meeting.
   */
  async enqueueMeetingReadyNotifications(
    meetingId: string,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto | null> {
    const nowIso = (options.now ?? new Date()).toISOString();

    const meetingRes = await this.db.query<{
      id: string;
      workspace_id: string;
      status: string;
      deleted_at: string | null;
      purge_status: string;
      current_analysis_run_id: string | null;
    }>(
      `select id, workspace_id, status, deleted_at, purge_status, current_analysis_run_id
         from public.meetings
        where id = $1`,
      [meetingId],
    );
    const meeting = meetingRes.rows[0];
    if (
      !meeting ||
      meeting.deleted_at !== null ||
      meeting.purge_status !== 'active' ||
      meeting.status !== 'ready' ||
      !meeting.current_analysis_run_id
    ) {
      return null;
    }

    const analysisRunRes = await this.db.query<{
      id: string;
      recording_id: string;
      run_number: number;
    }>(
      `select id, recording_id, run_number
         from public.analysis_runs
        where id = $1
          and meeting_id = $2
          and workspace_id = $3`,
      [meeting.current_analysis_run_id, meeting.id, meeting.workspace_id],
    );
    const analysisRun = analysisRunRes.rows[0];
    if (!analysisRun) return null;

    const jobIdempotencyKey = `send_telegram_notifications:${meeting.id}:analysis:${analysisRun.id}`;
    await this.db.query(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation, status,
        attempt, max_attempts, idempotency_key, scheduled_at, payload
      )
      values ($1, $2, $3, 'send_telegram_notifications', $4, 'queued', 0, 3, $5, $6, $7::jsonb)
      on conflict do nothing`,
      [
        meeting.workspace_id,
        meeting.id,
        analysisRun.recording_id,
        analysisRun.run_number,
        jobIdempotencyKey,
        nowIso,
        JSON.stringify({
          analysis_run_id: analysisRun.id,
        }),
      ],
    );

    const jobRes = await this.db.query<DbJobPhase8Row>(
      `select *
         from public.processing_jobs
        where meeting_id = $1
          and job_type = 'send_telegram_notifications'
          and generation = $2
        order by created_at desc
        limit 1`,
      [meeting.id, analysisRun.run_number],
    );
    return jobRes.rows[0] ? mapJobPhase8Row(jobRes.rows[0]) : null;
  }

  /**
   * Processes an incoming Telegram Bot webhook update.
   * - Validates webhook secret header
   * - Enforces per-link sliding-window rate limits
   * - Re-verifies active workspace membership on every command
   * - Dispatches `/start <token>`, `/status`, `/recent`, `/tasks`, `/summary`, `/ask`, `/unlink`, `/help`
   */
  async handleBotUpdate(
    webhookSecretHeader: string | null | undefined,
    rawUpdate: TelegramBotMessageUpdateInput,
    options: { now?: Date } = {},
  ): Promise<TelegramBotCommandResponse> {
    if (!this.telegramProvider.verifyWebhookSecret(webhookSecretHeader)) {
      throw new Phase4ServiceError(
        401,
        'unauthenticated',
        'Invalid or missing Telegram webhook secret token.',
      );
    }

    const parsed = telegramBotMessageUpdateSchema.safeParse(rawUpdate);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid Telegram update payload.',
      );
    }

    const update = parsed.data;
    const chatId = update.message.chat.id;
    const telegramUserId = update.message.from.id;
    const text = update.message.text.trim();
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    // 1. Handle /start <token> account linking redemption
    if (/^\/start(?:\s+|$)/i.test(text)) {
      const arg = text.replace(/^\/start\s*/i, '').trim();
      if (!arg) {
        const replyText =
          'SUHBAT AI Telegram Companion. Generate a single-use link token in Workspace Settings → Integrations in the web app to connect your account.';
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
          deepLinks: [this.appUrl],
        });
        return {
          ok: true,
          command: 'start',
          chatId,
          replyText,
          deepLinks: [this.appUrl],
          providerMessageId: sent.providerMessageId,
        };
      }

      const tokenSha256 = computeTokenSha256(arg);
      const tokenRes = await this.db.query<DbTelegramLinkTokenRow>(
        `select *
           from public.telegram_link_tokens
          where token_sha256 = $1`,
        [tokenSha256],
      );
      const tokenRow = tokenRes.rows[0];
      if (!tokenRow || tokenRow.status !== 'pending') {
        const replyText =
          'This Telegram link token is invalid or has already been used. Please generate a fresh link token from Workspace Settings.';
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
        });
        return {
          ok: false,
          command: 'unauthorized',
          chatId,
          replyText,
          deepLinks: [],
          providerMessageId: sent.providerMessageId,
        };
      }

      const expiresAtMs = new Date(tokenRow.expires_at).getTime();
      if (expiresAtMs <= now.getTime()) {
        await this.db.query(
          `update public.telegram_link_tokens set status = 'expired' where id = $1`,
          [tokenRow.id],
        );
        const replyText =
          'This Telegram link token has expired. Please generate a fresh link token from Workspace Settings.';
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
        });
        return {
          ok: false,
          command: 'unauthorized',
          chatId,
          replyText,
          deepLinks: [],
          providerMessageId: sent.providerMessageId,
        };
      }

      // Verify user still has an active membership in the token's workspace
      const memberRes = await this.db.query<{ workspace_name: string }>(
        `select w.name as workspace_name
           from public.workspace_members wm
           join public.workspaces w on w.id = wm.workspace_id
          where wm.workspace_id = $1
            and wm.user_id = $2
            and wm.membership_status = 'active'`,
        [tokenRow.workspace_id, tokenRow.user_id],
      );
      const memberRow = memberRes.rows[0];
      if (!memberRow) {
        await this.db.query(
          `update public.telegram_link_tokens set status = 'revoked' where id = $1`,
          [tokenRow.id],
        );
        const replyText = 'Account link refused: your workspace membership is no longer active.';
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
        });
        return {
          ok: false,
          command: 'unauthorized',
          chatId,
          replyText,
          deepLinks: [],
          providerMessageId: sent.providerMessageId,
        };
      }

      // Mark token redeemed
      await this.db.query(
        `update public.telegram_link_tokens
            set status = 'redeemed',
                redeemed_at = $2,
                redeemed_telegram_user_id = $3,
                redeemed_telegram_chat_id = $4
          where id = $1`,
        [tokenRow.id, nowIso, telegramUserId, chatId],
      );

      // Unlink any other active link bound to this telegram_chat_id
      await this.db.query(
        `update public.telegram_account_links
            set status = 'unlinked',
                unlinked_at = $2
          where telegram_chat_id = $1
            and status = 'active'
            and not (workspace_id = $3 and user_id = $4)`,
        [chatId, nowIso, tokenRow.workspace_id, tokenRow.user_id],
      );

      const displayName =
        [update.message.from.firstName, update.message.from.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() || null;
      const langCode = update.message.from.languageCode?.toLowerCase();
      const prefLang: TelegramPreferredLanguage =
        langCode === 'ru' ? 'ru' : langCode === 'en' ? 'en' : 'uz';

      const linkRes = await this.db.query<DbTelegramAccountLinkRow>(
        `insert into public.telegram_account_links (
          workspace_id, user_id, telegram_user_id, telegram_chat_id,
          telegram_username, telegram_display_name, preferred_language,
          notify_on_meeting_ready, status, rate_limit_window_started_at,
          rate_limit_count, last_command_at, linked_at, unlinked_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, true, 'active', $8, 1, $8, $8, null)
        on conflict (workspace_id, user_id) do update
          set telegram_user_id = excluded.telegram_user_id,
              telegram_chat_id = excluded.telegram_chat_id,
              telegram_username = excluded.telegram_username,
              telegram_display_name = excluded.telegram_display_name,
              status = 'active',
              linked_at = excluded.linked_at,
              unlinked_at = null,
              last_command_at = excluded.last_command_at
        returning *`,
        [
          tokenRow.workspace_id,
          tokenRow.user_id,
          telegramUserId,
          chatId,
          update.message.from.username ?? null,
          displayName,
          prefLang,
          nowIso,
        ],
      );
      const linkRow = linkRes.rows[0]!;

      this.emitObservability({
        event: 'telegram_account_linked',
        workspace_id: tokenRow.workspace_id,
        meeting_id: '',
        recording_id: null,
        source_id: null,
        chunk_id: null,
        job_id: null,
        sequence_no: null,
        fencing_token: null,
        timestamp: nowIso,
        metadata: {
          actor_id: tokenRow.user_id,
          link_id: linkRow.id,
          token_id: tokenRow.id,
        },
      });

      const wsLink = `${this.appUrl}/w/${tokenRow.workspace_id}`;
      const replyText = `Linked to workspace "${memberRow.workspace_name}". You will receive concise meeting-ready notifications here.\nWeb workspace: ${wsLink}`;
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: tokenRow.workspace_id,
        deepLinks: [wsLink],
      });

      return {
        ok: true,
        command: 'start',
        chatId,
        replyText,
        deepLinks: [wsLink],
        providerMessageId: sent.providerMessageId,
      };
    }

    // 2. For all other commands, resolve the active link for this chat + telegram user
    const linkRes = await this.db.query<DbTelegramAccountLinkRow>(
      `select *
         from public.telegram_account_links
        where telegram_chat_id = $1
          and telegram_user_id = $2
          and status = 'active'`,
      [chatId, telegramUserId],
    );
    const link = linkRes.rows[0];
    if (!link) {
      const replyText =
        'Your Telegram chat is not linked to an active SUHBAT AI workspace. Open Workspace Settings → Integrations in the web app to connect.';
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
      });
      return {
        ok: false,
        command: 'unauthorized',
        chatId,
        replyText,
        deepLinks: [],
        providerMessageId: sent.providerMessageId,
      };
    }

    // 3. Re-verify active workspace membership on every command (fail closed if removed or suspended)
    const activeMemberRes = await this.db.query<{ workspace_name: string; role: string }>(
      `select w.name as workspace_name, wm.role::text as role
         from public.workspace_members wm
         join public.workspaces w on w.id = wm.workspace_id
        where wm.workspace_id = $1
          and wm.user_id = $2
          and wm.membership_status = 'active'`,
      [link.workspace_id, link.user_id],
    );
    const activeMember = activeMemberRes.rows[0];
    if (!activeMember) {
      await this.db.query(
        `update public.telegram_account_links
            set status = 'suspended',
                unlinked_at = $2
          where id = $1`,
        [link.id, nowIso],
      );
      const replyText =
        'Access denied: your membership in the linked workspace is no longer active.';
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
      });
      return {
        ok: false,
        command: 'unauthorized',
        chatId,
        replyText,
        deepLinks: [],
        providerMessageId: sent.providerMessageId,
      };
    }

    // 4. Sliding-window rate limit check per linked account
    const windowStartMs = new Date(link.rate_limit_window_started_at).getTime();
    const elapsedSeconds = (now.getTime() - windowStartMs) / 1000;
    let nextWindowStartIso = toIsoString(link.rate_limit_window_started_at);
    let nextCount = Number(link.rate_limit_count) + 1;

    if (elapsedSeconds >= this.rateLimitWindowSeconds) {
      nextWindowStartIso = nowIso;
      nextCount = 1;
    }

    await this.db.query(
      `update public.telegram_account_links
          set rate_limit_window_started_at = $2,
              rate_limit_count = $3,
              last_command_at = $4
        where id = $1`,
      [link.id, nextWindowStartIso, nextCount, nowIso],
    );

    if (nextCount > this.maxCommandsPerWindow) {
      this.emitObservability({
        event: 'telegram_rate_limited',
        workspace_id: link.workspace_id,
        meeting_id: '',
        recording_id: null,
        source_id: null,
        chunk_id: null,
        job_id: null,
        sequence_no: null,
        fencing_token: null,
        timestamp: nowIso,
        metadata: {
          actor_id: link.user_id,
          link_id: link.id,
          rate_limit_count: nextCount,
          max_commands_per_window: this.maxCommandsPerWindow,
        },
      });
      const replyText = `Rate limit reached (${this.maxCommandsPerWindow} commands per ${this.rateLimitWindowSeconds}s). Please wait before sending another command.`;
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
      });
      return {
        ok: false,
        command: 'rate_limited',
        chatId,
        replyText,
        deepLinks: [],
        providerMessageId: sent.providerMessageId,
      };
    }

    const principal: AuthenticatedPrincipal = { userId: link.user_id };
    const wsUrl = `${this.appUrl}/w/${link.workspace_id}`;

    // 5. Dispatch commands
    if (/^\/unlink(?:\s+|$)/i.test(text)) {
      await this.unlinkAccount(principal, link.workspace_id, { now });
      const replyText = `Unlinked from workspace "${activeMember.workspace_name}". You will no longer receive notifications here.`;
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
      });
      return {
        ok: true,
        command: 'unlink',
        chatId,
        replyText,
        deepLinks: [],
        providerMessageId: sent.providerMessageId,
      };
    }

    if (/^\/status(?:\s+|$)/i.test(text)) {
      const replyText = `Workspace: ${activeMember.workspace_name} (${activeMember.role})\nNotifications: ${link.notify_on_meeting_ready ? 'enabled' : 'disabled'}\nDashboard: ${wsUrl}`;
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
        deepLinks: [wsUrl],
      });
      return {
        ok: true,
        command: 'status',
        chatId,
        replyText,
        deepLinks: [wsUrl],
        providerMessageId: sent.providerMessageId,
      };
    }

    if (/^\/recent(?:\s+|$)/i.test(text)) {
      const meetingsRes = await this.db.query<{
        id: string;
        title: string;
        company_name: string | null;
      }>(
        `select m.id, m.title, c.name as company_name
           from public.meetings m
           left join public.companies c
             on c.id = m.company_id and c.workspace_id = m.workspace_id
          where m.workspace_id = $1
            and m.deleted_at is null
            and m.purge_status = 'active'
            and m.status = 'ready'
          order by m.created_at desc
          limit 5`,
        [link.workspace_id],
      );

      if (meetingsRes.rows.length === 0) {
        const replyText = `No ready meetings in ${activeMember.workspace_name} yet.\nDashboard: ${wsUrl}`;
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
          workspaceId: link.workspace_id,
          deepLinks: [wsUrl],
        });
        return {
          ok: true,
          command: 'recent',
          chatId,
          replyText,
          deepLinks: [wsUrl],
          providerMessageId: sent.providerMessageId,
        };
      }

      const deepLinks: string[] = [];
      const lines = [`Recent ready meetings in ${activeMember.workspace_name}:`];
      for (const m of meetingsRes.rows) {
        const url = this.buildMeetingDeepLink(link.workspace_id, m.id);
        deepLinks.push(url);
        lines.push(`• ${m.title}${m.company_name ? ` (${m.company_name})` : ''}\n  ${url}`);
      }

      const replyText = lines.join('\n');
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
        deepLinks,
      });
      return {
        ok: true,
        command: 'recent',
        chatId,
        replyText,
        deepLinks,
        providerMessageId: sent.providerMessageId,
      };
    }

    if (/^\/tasks(?:\s+|$)/i.test(text)) {
      const tasksRes = await this.db.query<{
        id: string;
        meeting_id: string;
        meeting_title: string;
        title: string;
        owner_label: string | null;
        due_date: string | null;
      }>(
        `select ai.id,
                ai.meeting_id,
                m.title as meeting_title,
                ai.title,
                ai.owner_label,
                ai.due_date::text as due_date
           from public.meeting_action_items ai
           join public.meetings m
             on m.id = ai.meeting_id
            and m.workspace_id = ai.workspace_id
          where ai.workspace_id = $1
            and m.deleted_at is null
            and m.purge_status = 'active'
            and m.status = 'ready'
            and ai.analysis_run_id = m.current_analysis_run_id
            and ai.status in ('open', 'in_progress')
          order by ai.due_date asc nulls last, ai.sequence_no asc
          limit 6`,
        [link.workspace_id],
      );

      const tasksDashboardUrl = `${this.appUrl}/w/${link.workspace_id}/tasks`;
      if (tasksRes.rows.length === 0) {
        const replyText = `No open tasks in ${activeMember.workspace_name}.\nTasks: ${tasksDashboardUrl}`;
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
          workspaceId: link.workspace_id,
          deepLinks: [tasksDashboardUrl],
        });
        return {
          ok: true,
          command: 'tasks',
          chatId,
          replyText,
          deepLinks: [tasksDashboardUrl],
          providerMessageId: sent.providerMessageId,
        };
      }

      const deepLinks: string[] = [tasksDashboardUrl];
      const lines = [`Open tasks in ${activeMember.workspace_name}:`];
      for (const t of tasksRes.rows) {
        const url = this.buildMeetingDeepLink(link.workspace_id, t.meeting_id, 'tasks');
        if (!deepLinks.includes(url)) deepLinks.push(url);
        lines.push(
          `• ${t.title} — ${t.owner_label ?? 'Unassigned'}${t.due_date ? ` (due ${t.due_date})` : ''}\n  ${url}`,
        );
      }

      const replyText = lines.join('\n');
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
        deepLinks,
      });
      return {
        ok: true,
        command: 'tasks',
        chatId,
        replyText,
        deepLinks,
        providerMessageId: sent.providerMessageId,
      };
    }

    if (/^\/summary(?:\s+|$)/i.test(text)) {
      const targetMeetingId = text.replace(/^\/summary\s*/i, '').trim();
      let resolvedMeetingId = targetMeetingId;

      if (!resolvedMeetingId) {
        const latestRes = await this.db.query<{ id: string }>(
          `select id
             from public.meetings
            where workspace_id = $1
              and deleted_at is null
              and purge_status = 'active'
              and status = 'ready'
            order by created_at desc
            limit 1`,
          [link.workspace_id],
        );
        resolvedMeetingId = latestRes.rows[0]?.id ?? '';
      }

      if (!resolvedMeetingId) {
        const replyText = `No ready meeting found in ${activeMember.workspace_name}.`;
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
          workspaceId: link.workspace_id,
        });
        return {
          ok: true,
          command: 'summary',
          chatId,
          replyText,
          deepLinks: [],
          providerMessageId: sent.providerMessageId,
        };
      }

      const intel = await this.phase7.phase6.getMeetingIntelligence(
        principal,
        resolvedMeetingId,
        link.workspace_id,
      );
      const mRes = await this.db.query<{ title: string }>(
        `select title from public.meetings where id = $1 and workspace_id = $2`,
        [resolvedMeetingId, link.workspace_id],
      );
      const title = mRes.rows[0]?.title ?? 'Meeting';
      const overviewUrl = this.buildMeetingDeepLink(link.workspace_id, resolvedMeetingId);
      const tasksUrl = this.buildMeetingDeepLink(link.workspace_id, resolvedMeetingId, 'tasks');
      const deepLinks = [overviewUrl, tasksUrl];

      const lines = [
        `${title}`,
        intel.summary?.tlDr ?? 'Summary ready.',
        `Decisions: ${intel.decisions.length} | Open tasks: ${intel.actionItems.filter((a) => a.status === 'open' || a.status === 'in_progress').length}`,
        `Overview: ${overviewUrl}`,
        `Tasks: ${tasksUrl}`,
      ];
      const replyText = lines.join('\n');
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
        meetingId: resolvedMeetingId,
        deepLinks,
      });

      return {
        ok: true,
        command: 'summary',
        chatId,
        replyText,
        deepLinks,
        providerMessageId: sent.providerMessageId,
      };
    }

    if (/^\/ask(?:\s+|$)/i.test(text)) {
      const question = text.replace(/^\/ask\s*/i, '').trim();
      if (!question) {
        const replyText = 'Usage: /ask <your question about meetings, decisions, or tasks>';
        const sent = await this.telegramProvider.sendMessage({
          chatId,
          text: replyText,
          workspaceId: link.workspace_id,
        });
        return {
          ok: true,
          command: 'ask',
          chatId,
          replyText,
          deepLinks: [],
          providerMessageId: sent.providerMessageId,
        };
      }

      const askRes = await this.phase7.askWorkspaceQuestion(principal, link.workspace_id, {
        question,
        limit: 3,
      });

      const deepLinks: string[] = [];
      for (const cit of askRes.citations) {
        const url = `${this.appUrl}/w/${link.workspace_id}/meetings/${cit.meetingId}/transcript?seg=${cit.segmentIds[0] ?? ''}&t=${cit.startMs}#${cit.segmentIds[0] ?? ''}`;
        if (!deepLinks.includes(url)) deepLinks.push(url);
      }
      if (deepLinks.length === 0) {
        deepLinks.push(`${this.appUrl}/w/${link.workspace_id}/ask`);
      }

      const lines = [
        ...askRes.answer.slice(0, 4),
        ...(deepLinks.length > 0 ? [`Sources:\n${deepLinks.map((u) => `• ${u}`).join('\n')}`] : []),
      ];
      const replyText = lines.join('\n\n');
      const sent = await this.telegramProvider.sendMessage({
        chatId,
        text: replyText,
        workspaceId: link.workspace_id,
        deepLinks,
      });

      return {
        ok: true,
        command: 'ask',
        chatId,
        replyText,
        deepLinks,
        providerMessageId: sent.providerMessageId,
      };
    }

    // Default /help response
    const replyText = [
      `SUHBAT AI Telegram Companion (${activeMember.workspace_name})`,
      '/recent — Recent ready meetings with web links',
      '/tasks — Open action items with web links',
      '/summary — Latest meeting executive brief & tasks',
      '/ask <question> — Retrieval-backed answer with transcript citations',
      '/status — Connection status',
      '/unlink — Disconnect Telegram',
      `Web app: ${wsUrl}`,
    ].join('\n');
    const sent = await this.telegramProvider.sendMessage({
      chatId,
      text: replyText,
      workspaceId: link.workspace_id,
      deepLinks: [wsUrl],
    });

    return {
      ok: true,
      command: 'help',
      chatId,
      replyText,
      deepLinks: [wsUrl],
      providerMessageId: sent.providerMessageId,
    };
  }
}

export class Phase8TelegramWorker {
  readonly service: Phase8TelegramService;
  readonly phase7Worker: Phase7KnowledgeWorker;

  constructor(service: Phase8TelegramService) {
    this.service = service;
    this.phase7Worker = new Phase7KnowledgeWorker(service.phase7);
  }

  private get db(): SqlExecutor {
    return this.service.db;
  }

  async claimNextJob(
    workerId: string,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    return this.phase7Worker.claimNextJob(workerId, options);
  }

  /**
   * Executes a claimed `send_telegram_notifications` job.
   * Notification failures are isolated: even if Telegram Bot API fails for one or all recipients,
   * the meeting remains `ready` and the failure is recorded in `telegram_notification_deliveries`.
   */
  async executeClaimedSendTelegramNotificationsJob(
    workerId: string,
    job: ProcessingJobDto,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto> {
    if (job.jobType !== 'send_telegram_notifications') {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        `Expected send_telegram_notifications job, got ${job.jobType}.`,
      );
    }

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const meetingRes = await this.db.query<{
      id: string;
      workspace_id: string;
      title: string;
      company_name: string | null;
      project_name: string | null;
      status: string;
      deleted_at: string | null;
      purge_status: string;
      current_analysis_run_id: string | null;
      created_by: string;
    }>(
      `select m.id,
              m.workspace_id,
              m.title,
              c.name as company_name,
              p.name as project_name,
              m.status,
              m.deleted_at,
              m.purge_status,
              m.current_analysis_run_id,
              m.created_by
         from public.meetings m
         left join public.companies c
           on c.id = m.company_id and c.workspace_id = m.workspace_id
         left join public.projects p
           on p.id = m.project_id and p.workspace_id = m.workspace_id
        where m.id = $1
          and m.workspace_id = $2`,
      [job.meetingId, job.workspaceId],
    );
    const meeting = meetingRes.rows[0];

    // If the meeting was tombstoned/deleted or is not ready, complete the notification job cleanly as skipped
    if (
      !meeting ||
      meeting.deleted_at !== null ||
      meeting.purge_status !== 'active' ||
      meeting.status !== 'ready' ||
      !meeting.current_analysis_run_id
    ) {
      return this.phase7Worker.phase6Worker.phase5Worker.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          now,
          metadata: {
            skipped: true,
            reason: 'meeting_not_active_or_ready',
          },
        },
      );
    }

    await this.phase7Worker.phase6Worker.phase5Worker.phase4Worker.heartbeatJob(
      workerId,
      job.id,
      job.fencingToken,
      { now },
    );

    // Find all active opted-in Telegram account links whose user is an active member of this workspace
    const linksRes = await this.db.query<DbTelegramAccountLinkRow>(
      `select tal.*
         from public.telegram_account_links tal
         join public.workspace_members wm
           on wm.workspace_id = tal.workspace_id
          and wm.user_id = tal.user_id
        where tal.workspace_id = $1
          and tal.status = 'active'
          and tal.notify_on_meeting_ready = true
          and wm.membership_status = 'active'
        order by tal.created_at asc`,
      [meeting.workspace_id],
    );

    if (linksRes.rows.length === 0) {
      return this.phase7Worker.phase6Worker.phase5Worker.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          now,
          metadata: {
            sent_count: 0,
            failed_count: 0,
          },
        },
      );
    }

    const intel = await this.service.phase7.phase6.getMeetingIntelligence(
      { userId: meeting.created_by },
      meeting.id,
      meeting.workspace_id,
    );

    const overviewUrl = this.service.buildMeetingDeepLink(meeting.workspace_id, meeting.id);
    const decisionsUrl = this.service.buildMeetingDeepLink(
      meeting.workspace_id,
      meeting.id,
      'decisions',
    );
    const tasksUrl = this.service.buildMeetingDeepLink(meeting.workspace_id, meeting.id, 'tasks');
    const transcriptUrl = this.service.buildMeetingDeepLink(
      meeting.workspace_id,
      meeting.id,
      'transcript',
    );

    const confirmedDecisionsCount = intel.decisions.filter((d) => d.status === 'confirmed').length;
    const openTasks = intel.actionItems.filter(
      (a) => a.status === 'open' || a.status === 'in_progress',
    );

    const contextLabel = [meeting.company_name, meeting.project_name].filter(Boolean).join(' · ');
    const taskLines = openTasks
      .slice(0, 3)
      .map(
        (t) =>
          `• ${t.title} (${t.ownerLabel ?? 'Unassigned'}${t.dueDate ? `, due ${t.dueDate}` : ''})`,
      );

    const messageText = [
      `Meeting ready: ${meeting.title}${contextLabel ? ` (${contextLabel})` : ''}`,
      intel.summary?.tlDr ?? intel.summary?.headline ?? 'Structured analysis is ready.',
      `Confirmed decisions: ${confirmedDecisionsCount} | Open tasks: ${openTasks.length}`,
      ...(taskLines.length > 0 ? ['Top tasks:', ...taskLines] : []),
      `Overview: ${overviewUrl}`,
      `Decisions: ${decisionsUrl}`,
      `Tasks: ${tasksUrl}`,
      `Transcript: ${transcriptUrl}`,
    ].join('\n');

    let sentCount = 0;
    let failedCount = 0;

    for (const link of linksRes.rows) {
      const idempotencyKey = `tg_notify:meeting_ready:${meeting.id}:run:${meeting.current_analysis_run_id}:link:${link.id}`;

      const deliveryUpsertRes = await this.db.query<DbTelegramDeliveryRow>(
        `insert into public.telegram_notification_deliveries (
          workspace_id, meeting_id, analysis_run_id, telegram_account_link_id,
          user_id, notification_type, idempotency_key, status, attempt_count,
          max_attempts, deep_link_url, payload_metadata, created_at
        )
        values ($1, $2, $3, $4, $5, 'meeting_ready', $6, 'sending', 1, 3, $7, $8::jsonb, $9)
        on conflict (idempotency_key) do update
          set attempt_count = public.telegram_notification_deliveries.attempt_count + 1,
              status = case
                when public.telegram_notification_deliveries.status = 'sent' then 'sent'::public.telegram_notification_status
                else 'sending'::public.telegram_notification_status
              end
        returning *`,
        [
          meeting.workspace_id,
          meeting.id,
          meeting.current_analysis_run_id,
          link.id,
          link.user_id,
          idempotencyKey,
          overviewUrl,
          JSON.stringify({
            confirmed_decisions_count: confirmedDecisionsCount,
            open_tasks_count: openTasks.length,
          }),
          nowIso,
        ],
      );
      const delivery = deliveryUpsertRes.rows[0]!;
      if (delivery.status === 'sent') {
        sentCount += 1;
        continue;
      }

      try {
        const sent = await this.service.telegramProvider.sendMessage({
          chatId: link.telegram_chat_id,
          text: messageText,
          workspaceId: meeting.workspace_id,
          meetingId: meeting.id,
          deepLinks: [overviewUrl, decisionsUrl, tasksUrl, transcriptUrl],
        });

        await this.db.query(
          `update public.telegram_notification_deliveries
              set status = 'sent',
                  provider_message_id = $2,
                  sent_at = $3,
                  error_code = null,
                  error_message = null
            where id = $1`,
          [delivery.id, sent.providerMessageId, sent.sentAt],
        );

        await this.service.phase7.phase6.phase5.phase4.recordProcessingEvent({
          workspaceId: meeting.workspace_id,
          meetingId: meeting.id,
          processingJobId: job.id,
          eventType: 'telegram_notification_sent',
          fencingToken: job.fencingToken,
          metadata: {
            delivery_id: delivery.id,
            link_id: link.id,
            provider_message_id: sent.providerMessageId,
          },
        });
        sentCount += 1;
      } catch (cause) {
        failedCount += 1;
        const errCode =
          cause instanceof TelegramProviderError ? cause.code : 'telegram_delivery_failed';
        const errMsg = cause instanceof Error ? cause.message : String(cause);

        await this.db.query(
          `update public.telegram_notification_deliveries
              set status = 'failed',
                  error_code = $2,
                  error_message = $3
            where id = $1`,
          [delivery.id, errCode.slice(0, 80), errMsg.slice(0, 500)],
        );

        await this.service.phase7.phase6.phase5.phase4.recordProcessingEvent({
          workspaceId: meeting.workspace_id,
          meetingId: meeting.id,
          processingJobId: job.id,
          eventType: 'telegram_notification_failed',
          fencingToken: job.fencingToken,
          metadata: {
            delivery_id: delivery.id,
            link_id: link.id,
            error_code: errCode,
          },
        });
      }
    }

    // Complete the job so the meeting remains 'ready' even if individual Telegram deliveries failed
    return this.phase7Worker.phase6Worker.phase5Worker.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        now,
        metadata: {
          sent_count: sentCount,
          failed_count: failedCount,
        },
      },
    );
  }

  async ensureStageTransitionJobsEnqueued(options: { now?: Date } = {}): Promise<void> {
    await this.phase7Worker.phase6Worker.enqueuePendingTranscriptReadyMeetings({
      now: options.now,
    });

    // 1. Ensure ready meetings without current_embedding_run_id have generate_embeddings queued
    const readyForEmbeddingsRes = await this.db.query<{
      id: string;
      current_analysis_run_id: string | null;
    }>(
      `select id, current_analysis_run_id
         from public.meetings
        where status = 'ready'
          and deleted_at is null
          and purge_status = 'active'
          and current_analysis_run_id is not null
          and current_embedding_run_id is null
        order by updated_at asc`,
    );
    for (const m of readyForEmbeddingsRes.rows) {
      if (m.current_analysis_run_id) {
        await this.service.phase7.enqueueGenerateEmbeddingsJob({
          meetingId: m.id,
          analysisRunId: m.current_analysis_run_id,
        });
      }
    }

    // 2. Ensure ready meetings in workspaces with active opted-in Telegram links have send_telegram_notifications queued
    const readyForTelegramRes = await this.db.query<{ id: string }>(
      `select distinct m.id
         from public.meetings m
         join public.telegram_account_links tal
           on tal.workspace_id = m.workspace_id
         join public.workspace_members wm
           on wm.workspace_id = tal.workspace_id
          and wm.user_id = tal.user_id
        where m.status = 'ready'
          and m.deleted_at is null
          and m.purge_status = 'active'
          and m.current_analysis_run_id is not null
          and tal.status = 'active'
          and tal.notify_on_meeting_ready = true
          and wm.membership_status = 'active'
          and not exists (
            select 1
              from public.processing_jobs pj
             where pj.meeting_id = m.id
               and pj.job_type = 'send_telegram_notifications'
               and pj.idempotency_key = ('send_telegram_notifications:' || m.id || ':analysis:' || m.current_analysis_run_id)
          )`,
    );
    for (const m of readyForTelegramRes.rows) {
      await this.service.enqueueMeetingReadyNotifications(m.id, options);
    }
  }

  async runNextJob(
    workerId: string,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto | null> {
    await this.ensureStageTransitionJobsEnqueued(options);

    const job = await this.claimNextJob(workerId, options);
    if (!job) return null;

    if (job.jobType === 'send_telegram_notifications') {
      return this.executeClaimedSendTelegramNotificationsJob(workerId, job, options);
    }
    if (job.jobType === 'generate_embeddings') {
      return this.phase7Worker.executeClaimedGenerateEmbeddingsJob(workerId, job, options);
    }
    if (job.jobType === 'index_knowledge') {
      return this.phase7Worker.executeClaimedIndexKnowledgeJob(workerId, job, options);
    }
    return this.phase7Worker.phase6Worker.executeClaimedJob(workerId, job, options);
  }

  async runUntilIdle(
    workerId: string,
    options: { now?: Date; maxJobs?: number } = {},
  ): Promise<ProcessingJobDto[]> {
    const processed: ProcessingJobDto[] = [];
    const maxJobs = options.maxJobs ?? 50;
    while (processed.length < maxJobs) {
      const result = await this.runNextJob(workerId, options);
      if (!result) break;
      processed.push(result);
    }
    return processed;
  }
}
