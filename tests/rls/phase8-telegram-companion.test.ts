import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Phase4BackboneService,
  type AuthenticatedPrincipal,
  type StructuredObservabilityEvent,
} from '@suhbat/database/phase4';
import { Phase5TranscriptionService } from '@suhbat/database/phase5';
import { Phase6IntelligenceService } from '@suhbat/database/phase6';
import { Phase7KnowledgeService } from '@suhbat/database/phase7';
import { Phase8TelegramService, Phase8TelegramWorker } from '@suhbat/database/phase8';
import { MemoryStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';
import { FakeMeetingIntelligenceProvider } from '@suhbat/database/intelligence-provider';
import { FakeEmbeddingProvider } from '@suhbat/database/embedding-provider';
import { FakeTelegramBotProvider } from '@suhbat/database/telegram-provider';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { createLiveRepositories } from '../../apps/web/src/lib/live-repositories';
import {
  DELETE as deleteWorkspaceTelegramRoute,
  GET as getWorkspaceTelegramRoute,
  PATCH as patchWorkspaceTelegramRoute,
} from '../../apps/web/src/app/api/v1/workspaces/[workspaceId]/telegram/route';
import { POST as postCreateTelegramLinkTokenRoute } from '../../apps/web/src/app/api/v1/workspaces/[workspaceId]/telegram/link-token/route';
import { POST as postTelegramWebhookRoute } from '../../apps/web/src/app/api/v1/telegram/webhook/route';

const userOwnerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userMemberA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userOwnerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userOutsider = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const phase1MigrationPath = resolve('supabase/migrations/202610060001_phase1_foundation.sql');
const phase4MigrationPath = resolve(
  'supabase/migrations/202610070001_phase4_upload_processing_backbone.sql',
);
const phase41SecurityMigrationPath = resolve(
  'supabase/migrations/202610070002_phase4_1_security_hardening.sql',
);
const phase5MigrationPath = resolve(
  'supabase/migrations/202610070003_phase5_transcription_alignment.sql',
);
const phase6MigrationPath = resolve(
  'supabase/migrations/202610070004_phase6_meeting_intelligence.sql',
);
const phase7MigrationPath = resolve(
  'supabase/migrations/202610070005_phase7_company_memory_ask_ai.sql',
);
const phase8MigrationPath = resolve(
  'supabase/migrations/202610070006_phase8_telegram_companion_notifications.sql',
);
const seedPath = resolve('supabase/seed.sql');

const authBootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text unique,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid()
  returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

let db: PGlite;
let storage: MemoryStorageProvider;
let fakeTranscriptionProvider: FakeTranscriptionProvider;
let fakeIntelligenceProvider: FakeMeetingIntelligenceProvider;
let fakeEmbeddingProvider: FakeEmbeddingProvider;
let fakeTelegramProvider: FakeTelegramBotProvider;
let phase4Service: Phase4BackboneService;
let phase5Service: Phase5TranscriptionService;
let phase6Service: Phase6IntelligenceService;
let phase7Service: Phase7KnowledgeService;
let phase8Service: Phase8TelegramService;
let phase8Worker: Phase8TelegramWorker;
let emittedEvents: StructuredObservabilityEvent[] = [];
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;
let companyA1: string;
let projectA1: string;

async function asUser<T>(userId: string, callback: () => Promise<T>): Promise<T> {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec('set role authenticated');
  try {
    return await callback();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createMeetingInWorkspace(params: {
  userId: string;
  workspaceId: string;
  meetingTypeId: string;
  title: string;
  companyId?: string;
  projectId?: string;
}): Promise<string> {
  const res = await asUser(params.userId, async () =>
    db.query<{ id: string }>(
      `insert into public.meetings (workspace_id, meeting_type_id, company_id, project_id, title, created_by)
       values ($1, $2, $3, $4, $5, auth.uid())
       returning id`,
      [
        params.workspaceId,
        params.meetingTypeId,
        params.companyId ?? null,
        params.projectId ?? null,
        params.title,
      ],
    ),
  );
  return res.rows[0]!.id;
}

function makeNextRequest(
  url: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): NextRequest {
  const parsedUrl = new URL(url, 'http://localhost:3000');
  const headers: Record<string, string> = {
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(init?.headers ?? {}),
  };
  const req = new Request(parsedUrl.toString(), {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return Object.assign(req, { nextUrl: parsedUrl }) as unknown as NextRequest;
}

async function runFullMeetingPipelineToTelegram(params: {
  userId?: string;
  meetingId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<{
  recordingId: string;
  transcriptionRunId: string;
  analysisRunId: string;
  embeddingRunId: string;
}> {
  const actorId = params.userId ?? userOwnerA;
  const { recording } = await phase4Service.createRecording(
    { userId: actorId },
    {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      sessionId: params.sessionId,
      timeline: {
        clock: 'platform_monotonic_continuous',
        clockEpochId: params.sessionId,
        originTicks: '1000000000',
        originWallClockUtc: '2026-10-07T09:00:00.000Z',
        tickFrequencyHz: 1_000_000_000,
      },
      consent: {
        acknowledgedAt: '2026-10-07T09:00:00.000Z',
        policyVersion: 'v1',
      },
    },
  );

  const { source } = await phase4Service.registerSource({ userId: actorId }, recording.id, {
    sourceKind: 'microphone',
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    expectedChunkCount: 2,
  });

  const bytes0 = new TextEncoder().encode(`phase8-chunk-0-${params.sessionId}`);
  const bytes1 = new TextEncoder().encode(`phase8-chunk-1-${params.sessionId}`);

  const { chunk: chunk0 } = await phase4Service.registerChunk({ userId: actorId }, recording.id, {
    recordingSourceId: source.id,
    sequenceNo: 0,
    meetingStartMs: 0,
    meetingEndMs: 30_000,
    sampleStart: 0,
    sampleEnd: 1_440_000,
    byteSize: bytes0.byteLength,
    checksum: { algorithm: 'sha256', value: computeSha256Hex(bytes0) },
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
  });
  const { chunk: chunk1 } = await phase4Service.registerChunk({ userId: actorId }, recording.id, {
    recordingSourceId: source.id,
    sequenceNo: 1,
    meetingStartMs: 30_000,
    meetingEndMs: 60_000,
    sampleStart: 1_440_000,
    sampleEnd: 2_880_000,
    byteSize: bytes1.byteLength,
    checksum: { algorithm: 'sha256', value: computeSha256Hex(bytes1) },
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
  });

  for (const [c, b] of [
    [chunk0, bytes0],
    [chunk1, bytes1],
  ] as const) {
    const auth = await phase4Service.authorizeChunkUpload(
      { userId: actorId },
      recording.id,
      c.id,
      {},
    );
    await storage.putObjectViaSignedUrl(auth.uploadUrl, b);
    await phase4Service.verifyChunkUpload({ userId: actorId }, recording.id, c.id, {});
  }

  await phase4Service.finalizeRecording({ userId: actorId }, recording.id, {
    workspaceId: params.workspaceId,
    canonicalDurationMs: 60_000,
    activeCaptureMs: 60_000,
  });

  // Execute all stages through Phase 8 (prepare -> transcribe -> align -> analyze -> finalize -> embeddings -> index -> telegram notifications)
  await phase8Worker.runUntilIdle(`worker-p8-${params.sessionId}`);

  const mRes = await db.query<{
    current_transcription_run_id: string | null;
    current_analysis_run_id: string | null;
    current_embedding_run_id: string | null;
  }>(
    `select current_transcription_run_id, current_analysis_run_id, current_embedding_run_id
       from public.meetings
      where id = $1`,
    [params.meetingId],
  );
  const row = mRes.rows[0]!;
  expect(row.current_transcription_run_id).toBeTruthy();
  expect(row.current_analysis_run_id).toBeTruthy();
  expect(row.current_embedding_run_id).toBeTruthy();

  return {
    recordingId: recording.id,
    transcriptionRunId: row.current_transcription_run_id!,
    analysisRunId: row.current_analysis_run_id!,
    embeddingRunId: row.current_embedding_run_id!,
  };
}

describe('Phase 8 Telegram Companion, Account Linking, Notifications & RLS', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(authBootstrap);
    await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
    await db.exec(readFileSync(phase5MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase6MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase7MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase8MigrationPath, 'utf8'));
    await db.exec(readFileSync(seedPath, 'utf8'));

    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data)
      values
        ('${userOwnerA}', 'owner-a@example.com', '{"display_name": "Owner A"}'::jsonb),
        ('${userMemberA}', 'member-a@example.com', '{"display_name": "Member A"}'::jsonb),
        ('${userOwnerB}', 'owner-b@example.com', '{"display_name": "Owner B"}'::jsonb),
        ('${userOutsider}', 'outsider@example.com', '{"display_name": "Outsider"}'::jsonb)
      on conflict (id) do nothing;

      insert into public.profiles (id, display_name)
      values
        ('${userOwnerA}', 'Owner A'),
        ('${userMemberA}', 'Member A'),
        ('${userOwnerB}', 'Owner B'),
        ('${userOutsider}', 'Outsider')
      on conflict (id) do update set display_name = excluded.display_name;
    `);

    workspaceA = await asUser(userOwnerA, async () => {
      const res = await db.query<{ id: string }>(
        `select public.create_workspace('Workspace Alpha', 'workspace-alpha-p8') as id`,
      );
      return res.rows[0]!.id;
    });

    workspaceB = await asUser(userOwnerB, async () => {
      const res = await db.query<{ id: string }>(
        `select public.create_workspace('Workspace Beta', 'workspace-beta-p8') as id`,
      );
      return res.rows[0]!.id;
    });

    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
       values ($1, $2, 'member', 'active')`,
      [workspaceA, userMemberA],
    );

    const mtARes = await db.query<{ id: string }>(
      `select id from public.meeting_types where workspace_id = $1 order by sort_order asc limit 1`,
      [workspaceA],
    );
    meetingTypeA = mtARes.rows[0]!.id;

    const compRes = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.companies (workspace_id, name, description, created_by)
         values ($1, 'Tashkent Cold Chain', 'Temperature-controlled logistics client', auth.uid())
         returning id`,
        [workspaceA],
      ),
    );
    companyA1 = compRes.rows[0]!.id;

    const projRes = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.projects (workspace_id, company_id, name, description, created_by)
         values ($1, $2, 'Q4 Fleet Expansion', 'Reefer fleet rollout', auth.uid())
         returning id`,
        [workspaceA, companyA1],
      ),
    );
    projectA1 = projRes.rows[0]!.id;

    storage = new MemoryStorageProvider();
    fakeTranscriptionProvider = new FakeTranscriptionProvider();
    fakeIntelligenceProvider = new FakeMeetingIntelligenceProvider();
    fakeEmbeddingProvider = new FakeEmbeddingProvider();
    fakeTelegramProvider = new FakeTelegramBotProvider({
      botUsername: 'suhbat_companion_bot',
      webhookSecret: 'phase8-webhook-secret',
    });

    phase4Service = new Phase4BackboneService({
      db,
      storage,
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase5Service = new Phase5TranscriptionService({
      phase4: phase4Service,
      provider: fakeTranscriptionProvider,
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase6Service = new Phase6IntelligenceService({
      db,
      phase5: phase5Service,
      intelligenceProvider: fakeIntelligenceProvider,
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase7Service = new Phase7KnowledgeService({
      db,
      phase6: phase6Service,
      embeddingProvider: fakeEmbeddingProvider,
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase8Service = new Phase8TelegramService({
      db,
      phase7: phase7Service,
      telegramProvider: fakeTelegramProvider,
      appUrl: 'https://app.suhbat.ai',
      maxCommandsPerWindow: 4,
      rateLimitWindowSeconds: 60,
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase8Worker = new Phase8TelegramWorker(phase8Service);

    setPhase4Runtime({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      phase8Service,
      transcriptionProvider: fakeTranscriptionProvider,
      intelligenceProvider: fakeIntelligenceProvider,
      embeddingProvider: fakeEmbeddingProvider,
      telegramProvider: fakeTelegramProvider,
      resolvePrincipal: async () => currentPrincipal,
    });
  });

  beforeEach(async () => {
    emittedEvents = [];
    currentPrincipal = { userId: userOwnerA };
    fakeTelegramProvider.clearSentMessages();
    fakeTelegramProvider.clearFailureForChat('770022');
    await db.query(
      `update public.workspace_members
          set membership_status = 'active'
        where workspace_id = $1 and user_id = $2`,
      [workspaceA, userMemberA],
    );
  });

  afterAll(async () => {
    setPhase4Runtime(null);
    await db.close();
  });

  it('links an authenticated workspace user via a single-use SHA-256 hashed token and rejects token replay or expiry', async () => {
    // 1. Create single-use link token via POST /api/v1/workspaces/{workspaceId}/telegram/link-token
    const createReq = makeNextRequest(
      `http://localhost:3000/api/v1/workspaces/${workspaceA}/telegram/link-token`,
      {
        method: 'POST',
        body: { expiresInSeconds: 600 },
      },
    );
    const createRes = await postCreateTelegramLinkTokenRoute(createReq, {
      params: Promise.resolve({ workspaceId: workspaceA }),
    });
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as {
      tokenRecord: { id: string; status: string };
      rawToken: string;
      botDeepLinkUrl: string;
    };
    expect(createdBody.rawToken).toMatch(/^tglink_[a-f0-9]{48}$/);
    expect(createdBody.botDeepLinkUrl).toBe(
      `https://t.me/suhbat_companion_bot?start=${createdBody.rawToken}`,
    );

    // Verify the database never stores the raw token, only its SHA-256 hex digest
    const dbTokenRow = await db.query<{ token_sha256: string }>(
      `select token_sha256 from public.telegram_link_tokens where id = $1`,
      [createdBody.tokenRecord.id],
    );
    expect(dbTokenRow.rows[0]!.token_sha256).not.toBe(createdBody.rawToken);
    expect(dbTokenRow.rows[0]!.token_sha256).toBe(
      computeSha256Hex(new TextEncoder().encode(createdBody.rawToken)),
    );

    // 2. Redeem token via POST /api/v1/telegram/webhook (/start <rawToken>)
    const startReq = makeNextRequest('http://localhost:3000/api/v1/telegram/webhook', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'phase8-webhook-secret',
      },
      body: {
        updateId: 1001,
        message: {
          messageId: 1,
          date: 1_790_000_000,
          chat: { id: '770011', type: 'private' },
          from: {
            id: '770011',
            username: 'aziz_owner',
            firstName: 'Aziz',
            lastName: 'Karimov',
            languageCode: 'uz',
          },
          text: `/start ${createdBody.rawToken}`,
        },
      },
    });
    const startRes = await postTelegramWebhookRoute(startReq);
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as {
      ok: boolean;
      command: string;
      deepLinks: string[];
    };
    expect(startBody.ok).toBe(true);
    expect(startBody.command).toBe('start');
    expect(startBody.deepLinks).toContain(`https://app.suhbat.ai/w/${workspaceA}`);
    expect(emittedEvents.some((e) => e.event === 'telegram_account_linked')).toBe(true);

    // 3. Replaying the same single-use token must fail closed
    const replayRes = await postTelegramWebhookRoute(
      makeNextRequest('http://localhost:3000/api/v1/telegram/webhook', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'phase8-webhook-secret',
        },
        body: {
          updateId: 1002,
          message: {
            messageId: 2,
            date: 1_790_000_010,
            chat: { id: '999999', type: 'private' },
            from: { id: '999999', username: 'attacker' },
            text: `/start ${createdBody.rawToken}`,
          },
        },
      }),
    );
    const replayBody = (await replayRes.json()) as { ok: boolean; command: string };
    expect(replayBody.ok).toBe(false);
    expect(replayBody.command).toBe('unauthorized');

    // 4. Verify status via GET /api/v1/workspaces/{workspaceId}/telegram and liveRepositories.settings.get
    const statusRes = await getWorkspaceTelegramRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/telegram`),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      currentUserLink: { status: string; telegramUsername: string | null } | null;
      activeWorkspaceLinkCount: number;
    };
    expect(statusBody.currentUserLink?.status).toBe('active');
    expect(statusBody.currentUserLink?.telegramUsername).toBe('aziz_owner');
    expect(statusBody.activeWorkspaceLinkCount).toBe(1);

    const liveRepos = createLiveRepositories({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      phase8Service,
      principal: { userId: userOwnerA },
    });
    const settingsSnapshot = await liveRepos.settings.get(workspaceA);
    const tgCard = settingsSnapshot.integrations.find((i) => i.key === 'telegram');
    expect(tgCard?.state).toBe('connected');
    expect(tgCard?.detail).toContain('@aziz_owner');
  });

  it('delivers processing-ready notifications with canonical APP_URL deep links and isolates notification failures from meeting readiness', async () => {
    // Link userMemberA to chat '770022' as well so we have 2 opted-in active members in workspaceA
    const memberToken = await phase8Service.createLinkToken(
      { userId: userMemberA },
      workspaceA,
      {},
    );
    await phase8Service.handleBotUpdate('phase8-webhook-secret', {
      updateId: 2001,
      message: {
        messageId: 10,
        date: 1_790_000_100,
        chat: { id: '770022', type: 'private' },
        from: {
          id: '770022',
          username: 'dilshod_member',
          firstName: 'Dilshod',
          languageCode: 'ru',
        },
        text: `/start ${memberToken.rawToken}`,
      },
    });
    fakeTelegramProvider.clearSentMessages();

    // Simulate Telegram delivery failure for chat '770022' while '770011' succeeds
    fakeTelegramProvider.injectFailureForChat('770022', {
      code: 'provider_unavailable',
      message: 'Telegram chat unreachable',
      retryable: true,
    });

    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      projectId: projectA1,
      title: 'Cold Chain Customs & Reefer Dispatch Review',
    });

    await runFullMeetingPipelineToTelegram({
      userId: userOwnerA,
      meetingId,
      workspaceId: workspaceA,
      sessionId: '88888888-8888-4888-8888-000000000001',
    });

    // 1. Verify meeting remains 'ready' despite chat '770022' failing
    const mRes = await db.query<{ status: string; processing_status: string }>(
      `select status::text as status, processing_status::text as processing_status
         from public.meetings
        where id = $1`,
      [meetingId],
    );
    expect(mRes.rows[0]).toEqual({
      status: 'ready',
      processing_status: 'ready',
    });

    // 2. Verify chat '770011' received the concise notification with canonical APP_URL deep links
    expect(fakeTelegramProvider.getSentMessages()).toHaveLength(1);
    const sentMsg = fakeTelegramProvider.getSentMessages()[0]!;
    expect(sentMsg.chatId).toBe('770011');
    expect(sentMsg.text).toContain('Cold Chain Customs & Reefer Dispatch Review');
    expect(sentMsg.text).toContain('Confirmed decisions:');
    expect(sentMsg.text).toContain('Open tasks:');
    expect(sentMsg.deepLinks).toEqual([
      `https://app.suhbat.ai/w/${workspaceA}/meetings/${meetingId}`,
      `https://app.suhbat.ai/w/${workspaceA}/meetings/${meetingId}/decisions`,
      `https://app.suhbat.ai/w/${workspaceA}/meetings/${meetingId}/tasks`,
      `https://app.suhbat.ai/w/${workspaceA}/meetings/${meetingId}/transcript`,
    ]);

    // 3. Verify durable delivery records in public.telegram_notification_deliveries
    const deliveriesRes = await db.query<{
      user_id: string;
      status: string;
      error_code: string | null;
      deep_link_url: string;
    }>(
      `select user_id, status::text as status, error_code, deep_link_url
         from public.telegram_notification_deliveries
        where meeting_id = $1
        order by created_at asc`,
      [meetingId],
    );
    expect(deliveriesRes.rows).toHaveLength(2);
    const ownerDelivery = deliveriesRes.rows.find((d) => d.user_id === userOwnerA)!;
    const memberDelivery = deliveriesRes.rows.find((d) => d.user_id === userMemberA)!;
    expect(ownerDelivery.status).toBe('sent');
    expect(ownerDelivery.deep_link_url).toBe(
      `https://app.suhbat.ai/w/${workspaceA}/meetings/${meetingId}`,
    );
    expect(memberDelivery.status).toBe('failed');
    expect(memberDelivery.error_code).toBe('provider_unavailable');
    expect(emittedEvents.some((e) => e.event === 'telegram_notification_sent')).toBe(true);
    expect(emittedEvents.some((e) => e.event === 'telegram_notification_failed')).toBe(true);
  });

  it('serves /recent, /tasks, /summary, and /ask bot commands with web deep links, enforces rate limits, and revokes access when workspace membership is suspended', async () => {
    const baseTime = new Date(Date.now() + 120_000);

    // 1. Invalid webhook secret must be rejected with 401
    const badSecretRes = await postTelegramWebhookRoute(
      makeNextRequest('http://localhost:3000/api/v1/telegram/webhook', {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': 'wrong-secret',
        },
        body: {
          updateId: 3000,
          message: {
            messageId: 20,
            date: 1_790_000_200,
            chat: { id: '770011', type: 'private' },
            from: { id: '770011' },
            text: '/recent',
          },
        },
      }),
    );
    expect(badSecretRes.status).toBe(401);

    // 2. /recent command returns ready meetings with canonical web links
    const recentOut = await phase8Service.handleBotUpdate(
      'phase8-webhook-secret',
      {
        updateId: 3001,
        message: {
          messageId: 21,
          date: 1_790_000_201,
          chat: { id: '770011', type: 'private' },
          from: { id: '770011' },
          text: '/recent',
        },
      },
      { now: baseTime },
    );
    expect(recentOut.ok).toBe(true);
    expect(recentOut.command).toBe('recent');
    expect(recentOut.replyText).toContain('Cold Chain Customs & Reefer Dispatch Review');
    expect(recentOut.deepLinks[0]).toMatch(
      new RegExp(`^https://app\\.suhbat\\.ai/w/${workspaceA}/meetings/`),
    );

    // 3. /tasks command returns open tasks with deep links
    const tasksOut = await phase8Service.handleBotUpdate(
      'phase8-webhook-secret',
      {
        updateId: 3002,
        message: {
          messageId: 22,
          date: 1_790_000_202,
          chat: { id: '770011', type: 'private' },
          from: { id: '770011' },
          text: '/tasks',
        },
      },
      { now: new Date(baseTime.getTime() + 1000) },
    );
    expect(tasksOut.ok).toBe(true);
    expect(tasksOut.command).toBe('tasks');
    expect(tasksOut.deepLinks).toContain(`https://app.suhbat.ai/w/${workspaceA}/tasks`);

    // 4. /summary command returns executive brief and links
    const summaryOut = await phase8Service.handleBotUpdate(
      'phase8-webhook-secret',
      {
        updateId: 3003,
        message: {
          messageId: 23,
          date: 1_790_000_203,
          chat: { id: '770011', type: 'private' },
          from: { id: '770011' },
          text: '/summary',
        },
      },
      { now: new Date(baseTime.getTime() + 2000) },
    );
    expect(summaryOut.ok).toBe(true);
    expect(summaryOut.command).toBe('summary');
    expect(summaryOut.replyText).toContain('Decisions:');

    // 5. /ask <question> delegates to Phase7KnowledgeService.askWorkspaceQuestion with transcript citations
    const askOut = await phase8Service.handleBotUpdate(
      'phase8-webhook-secret',
      {
        updateId: 3004,
        message: {
          messageId: 24,
          date: 1_790_000_204,
          chat: { id: '770011', type: 'private' },
          from: { id: '770011' },
          text: '/ask What was decided about the pilot budget and timeline?',
        },
      },
      { now: new Date(baseTime.getTime() + 3000) },
    );
    expect(askOut.ok).toBe(true);
    expect(askOut.command).toBe('ask');
    expect(askOut.deepLinks.length).toBeGreaterThan(0);

    // 6. 5th command within the same 60s window exceeds maxCommandsPerWindow (4) -> rate_limited
    const rateLimitedOut = await phase8Service.handleBotUpdate(
      'phase8-webhook-secret',
      {
        updateId: 3005,
        message: {
          messageId: 25,
          date: 1_790_000_205,
          chat: { id: '770011', type: 'private' },
          from: { id: '770011' },
          text: '/status',
        },
      },
      { now: new Date(baseTime.getTime() + 4000) },
    );
    expect(rateLimitedOut.ok).toBe(false);
    expect(rateLimitedOut.command).toBe('rate_limited');
    expect(emittedEvents.some((e) => e.event === 'telegram_rate_limited')).toBe(true);

    // 7. Suspend userMemberA's workspace membership -> next bot command from chat '770022' must fail closed and suspend the link
    await db.query(
      `update public.workspace_members
          set membership_status = 'suspended'
        where workspace_id = $1 and user_id = $2`,
      [workspaceA, userMemberA],
    );

    const suspendedOut = await phase8Service.handleBotUpdate(
      'phase8-webhook-secret',
      {
        updateId: 3006,
        message: {
          messageId: 26,
          date: 1_790_000_210,
          chat: { id: '770022', type: 'private' },
          from: { id: '770022' },
          text: '/recent',
        },
      },
      { now: new Date(baseTime.getTime() + 10_000) },
    );
    expect(suspendedOut.ok).toBe(false);
    expect(suspendedOut.command).toBe('unauthorized');

    const suspendedLinkRow = await db.query<{ status: string }>(
      `select status::text as status
         from public.telegram_account_links
        where workspace_id = $1 and user_id = $2`,
      [workspaceA, userMemberA],
    );
    expect(suspendedLinkRow.rows[0]?.status).toBe('suspended');
  });

  it('enforces RLS isolation, blocks direct authenticated writes, and enforces composite foreign keys on telegram_notification_deliveries', async () => {
    // 1. Workspace B owner cannot view Workspace A Telegram status via API
    currentPrincipal = { userId: userOwnerB };
    const crossWsRes = await getWorkspaceTelegramRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/telegram`),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(crossWsRes.status).toBe(403);

    // 2. Workspace B owner and outsider see 0 rows in Workspace A via RLS
    const wsBLinks = await asUser(userOwnerB, async () =>
      db.query(`select id from public.telegram_account_links where workspace_id = $1`, [
        workspaceA,
      ]),
    );
    expect(wsBLinks.rows).toHaveLength(0);

    const outsiderDeliveries = await asUser(userOutsider, async () =>
      db.query(`select id from public.telegram_notification_deliveries where workspace_id = $1`, [
        workspaceA,
      ]),
    );
    expect(outsiderDeliveries.rows).toHaveLength(0);

    // 3. Direct authenticated client INSERT into telegram_account_links is rejected
    await expect(
      asUser(userOwnerA, async () =>
        db.query(
          `insert into public.telegram_account_links (
            workspace_id, user_id, telegram_user_id, telegram_chat_id
          ) values ($1, $2, '123', '123')`,
          [workspaceA, userOwnerA],
        ),
      ),
    ).rejects.toThrow();

    // 4. Composite foreign key on telegram_notification_deliveries rejects cross-workspace mismatch
    const linkRow = await db.query<{ id: string }>(
      `select id from public.telegram_account_links where workspace_id = $1 and user_id = $2`,
      [workspaceA, userOwnerA],
    );
    const meetingRow = await db.query<{ id: string; current_analysis_run_id: string }>(
      `select id, current_analysis_run_id
         from public.meetings
        where workspace_id = $1
          and current_analysis_run_id is not null
        limit 1`,
      [workspaceA],
    );

    await expect(
      db.query(
        `insert into public.telegram_notification_deliveries (
          workspace_id, meeting_id, analysis_run_id, telegram_account_link_id,
          user_id, notification_type, idempotency_key, status, deep_link_url
        ) values ($1, $2, $3, $4, $5, 'meeting_ready', 'bad-cross-ws-key', 'queued', 'https://app.suhbat.ai')`,
        [
          workspaceB, // Mismatched workspace!
          meetingRow.rows[0]!.id,
          meetingRow.rows[0]!.current_analysis_run_id,
          linkRow.rows[0]!.id,
          userOwnerA,
        ],
      ),
    ).rejects.toThrow();

    // 5. Preferences PATCH and DELETE unlink routes work for authenticated Workspace A owner
    currentPrincipal = { userId: userOwnerA };
    const patchRes = await patchWorkspaceTelegramRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/telegram`, {
        method: 'PATCH',
        body: {
          preferredLanguage: 'en',
          notifyOnMeetingReady: false,
        },
      }),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      link: { preferredLanguage: string; notifyOnMeetingReady: boolean };
    };
    expect(patchBody.link.preferredLanguage).toBe('en');
    expect(patchBody.link.notifyOnMeetingReady).toBe(false);

    const deleteRes = await deleteWorkspaceTelegramRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/telegram`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { link: { status: string } };
    expect(deleteBody.link.status).toBe('unlinked');
  });
});
