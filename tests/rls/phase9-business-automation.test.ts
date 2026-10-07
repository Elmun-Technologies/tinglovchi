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
import { Phase8TelegramService } from '@suhbat/database/phase8';
import { Phase9AutomationService, Phase9AutomationWorker } from '@suhbat/database/phase9';
import { MemoryStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';
import { FakeMeetingIntelligenceProvider } from '@suhbat/database/intelligence-provider';
import { FakeEmbeddingProvider } from '@suhbat/database/embedding-provider';
import { FakeTelegramBotProvider } from '@suhbat/database/telegram-provider';
import { FakeBusinessAutomationProvider } from '@suhbat/database/automation-provider';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { createLiveRepositories } from '../../apps/web/src/lib/live-repositories';
import {
  GET as getWorkspaceConnectorsRoute,
  PUT as putWorkspaceConnectorRoute,
} from '../../apps/web/src/app/api/v1/workspaces/[workspaceId]/automations/connectors/route';
import {
  GET as getMeetingAutomationsRoute,
  POST as postPrepareAutomationRoute,
} from '../../apps/web/src/app/api/v1/meetings/[meetingId]/automations/route';
import {
  DELETE as deleteCancelAutomationRoute,
  POST as postConfirmAutomationRoute,
} from '../../apps/web/src/app/api/v1/meetings/[meetingId]/automations/[actionId]/confirm/route';
import {
  GET as getMeetingExportsRoute,
  POST as postCreateMeetingExportRoute,
} from '../../apps/web/src/app/api/v1/meetings/[meetingId]/exports/route';

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
const phase9MigrationPath = resolve(
  'supabase/migrations/202610070007_phase9_business_automation.sql',
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
let fakeAutomationProvider: FakeBusinessAutomationProvider;
let phase4Service: Phase4BackboneService;
let phase5Service: Phase5TranscriptionService;
let phase6Service: Phase6IntelligenceService;
let phase7Service: Phase7KnowledgeService;
let phase8Service: Phase8TelegramService;
let phase9Service: Phase9AutomationService;
let phase9Worker: Phase9AutomationWorker;
let emittedEvents: StructuredObservabilityEvent[] = [];
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;
let companyA1: string;
let projectA1: string;
let readyMeetingId: string;

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

async function runFullMeetingPipeline(params: {
  userId?: string;
  meetingId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<void> {
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

  const bytes0 = new TextEncoder().encode(`phase9-chunk-0-${params.sessionId}`);
  const bytes1 = new TextEncoder().encode(`phase9-chunk-1-${params.sessionId}`);

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

  await phase9Worker.runUntilIdle(`worker-p9-${params.sessionId}`);
}

describe('Phase 9 Business Automation, User-Confirmed Outbound Actions, Auditable Idempotency & Exports', () => {
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
    await db.exec(readFileSync(phase9MigrationPath, 'utf8'));
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
        `select public.create_workspace('Workspace Alpha', 'workspace-alpha-p9') as id`,
      );
      return res.rows[0]!.id;
    });

    workspaceB = await asUser(userOwnerB, async () => {
      const res = await db.query<{ id: string }>(
        `select public.create_workspace('Workspace Beta', 'workspace-beta-p9') as id`,
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
         values ($1, 'Samarkand Agro Export', 'Agricultural export & cold storage', auth.uid())
         returning id`,
        [workspaceA],
      ),
    );
    companyA1 = compRes.rows[0]!.id;

    const projRes = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.projects (workspace_id, company_id, name, description, created_by)
         values ($1, $2, '2026 Harvest CRM Integration', 'CRM & contract rollout', auth.uid())
         returning id`,
        [workspaceA, companyA1],
      ),
    );
    projectA1 = projRes.rows[0]!.id;

    storage = new MemoryStorageProvider();
    fakeTranscriptionProvider = new FakeTranscriptionProvider();
    fakeIntelligenceProvider = new FakeMeetingIntelligenceProvider();
    fakeEmbeddingProvider = new FakeEmbeddingProvider();
    fakeTelegramProvider = new FakeTelegramBotProvider();
    fakeAutomationProvider = new FakeBusinessAutomationProvider();

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
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase9Service = new Phase9AutomationService({
      db,
      phase8: phase8Service,
      automationProvider: fakeAutomationProvider,
      appUrl: 'https://app.suhbat.ai',
      onEvent: (ev) => emittedEvents.push(ev),
    });
    phase9Worker = new Phase9AutomationWorker(phase9Service);

    setPhase4Runtime({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      phase8Service,
      phase9Service,
      transcriptionProvider: fakeTranscriptionProvider,
      intelligenceProvider: fakeIntelligenceProvider,
      embeddingProvider: fakeEmbeddingProvider,
      telegramProvider: fakeTelegramProvider,
      automationProvider: fakeAutomationProvider,
      resolvePrincipal: async () => currentPrincipal,
    });

    readyMeetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      projectId: projectA1,
      title: 'Samarkand Agro Export Q4 Deal Review',
    });

    await runFullMeetingPipeline({
      userId: userOwnerA,
      meetingId: readyMeetingId,
      workspaceId: workspaceA,
      sessionId: '99999999-9999-4999-8999-000000000001',
    });
  });

  beforeEach(() => {
    emittedEvents = [];
    currentPrincipal = { userId: userOwnerA };
    fakeAutomationProvider.clearExecutedActions();
    fakeAutomationProvider.clearFailureForConnector('amocrm');
    fakeAutomationProvider.clearFailureForConnector('google_docs');
  });

  afterAll(async () => {
    setPhase4Runtime(null);
    await db.close();
  });

  it('restricts connector configuration to workspace owners/admins and reflects connected cards in liveRepositories.settings.get', async () => {
    // 1. Active member cannot configure connectors (403)
    currentPrincipal = { userId: userMemberA };
    const memberPutRes = await putWorkspaceConnectorRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/workspaces/${workspaceA}/automations/connectors`,
        {
          method: 'PUT',
          body: {
            connectorType: 'amocrm',
            label: 'Samarkand amoCRM',
            endpointUrl: 'https://crm.suhbat.example/webhook',
          },
        },
      ),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(memberPutRes.status).toBe(403);

    // 2. Owner configures amoCRM and Google Docs connectors
    currentPrincipal = { userId: userOwnerA };
    const ownerPutCrmRes = await putWorkspaceConnectorRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/workspaces/${workspaceA}/automations/connectors`,
        {
          method: 'PUT',
          body: {
            connectorType: 'amocrm',
            label: 'Samarkand Sales amoCRM',
            endpointUrl: 'https://crm.suhbat.example/webhook',
          },
        },
      ),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(ownerPutCrmRes.status).toBe(200);

    const ownerPutDocsRes = await putWorkspaceConnectorRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/workspaces/${workspaceA}/automations/connectors`,
        {
          method: 'PUT',
          body: {
            connectorType: 'google_docs',
            label: 'Executive Briefs Drive Folder',
            endpointUrl: 'https://docs.suhbat.example/publish',
          },
        },
      ),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(ownerPutDocsRes.status).toBe(200);

    // 3. Active member can list configured connectors
    currentPrincipal = { userId: userMemberA };
    const listRes = await getWorkspaceConnectorsRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/workspaces/${workspaceA}/automations/connectors`,
      ),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      connectors: Array<{ connectorType: string; status: string }>;
    };
    expect(listBody.connectors).toHaveLength(2);

    // 4. Live repositories settings.get reflects connected amoCRM and Google Docs cards
    const liveRepos = createLiveRepositories({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      phase8Service,
      phase9Service,
      principal: { userId: userOwnerA },
    });
    const settings = await liveRepos.settings.get(workspaceA);
    const crmCard = settings.integrations.find((i) => i.key === 'amocrm');
    const docsCard = settings.integrations.find((i) => i.key === 'google_docs');
    expect(crmCard?.state).toBe('connected');
    expect(docsCard?.state).toBe('connected');
  });

  it('enforces two-step explicit user confirmation, SQL confirmation constraint, and auditable idempotency for outbound business actions', async () => {
    // 1. Prepare CRM sync action -> status is pending_confirmation, 0 external calls executed
    const prepRes = await postPrepareAutomationRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations`, {
        method: 'POST',
        body: {
          connectorType: 'amocrm',
          actionType: 'sync_crm_tasks',
          idempotencyKey: 'idem-crm-sync-tasks-001',
        },
      }),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(prepRes.status).toBe(201);
    const prepBody = (await prepRes.json()) as {
      action: {
        id: string;
        status: string;
        payloadSha256: string;
        evidenceSegmentIds: string[];
        payloadPreview: { openTasks: unknown[]; evidence: unknown[] };
      };
      confirmationToken: string;
      idempotentReused: boolean;
    };
    expect(prepBody.action.status).toBe('pending_confirmation');
    expect(prepBody.idempotentReused).toBe(false);
    expect(prepBody.confirmationToken).toMatch(/^confirm_[a-f0-9]{40}$/);
    expect(prepBody.action.evidenceSegmentIds.length).toBeGreaterThan(0);
    expect(fakeAutomationProvider.getExecutedActions()).toHaveLength(0);

    // 2. Repeating prepare with the same idempotencyKey and identical payload returns 200 idempotentReused: true
    const repeatPrepRes = await postPrepareAutomationRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations`, {
        method: 'POST',
        body: {
          connectorType: 'amocrm',
          actionType: 'sync_crm_tasks',
          idempotencyKey: 'idem-crm-sync-tasks-001',
        },
      }),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(repeatPrepRes.status).toBe(200);
    const repeatPrepBody = (await repeatPrepRes.json()) as { idempotentReused: boolean };
    expect(repeatPrepBody.idempotentReused).toBe(true);

    // 3. Repeating prepare with the same idempotencyKey but different actionType (different payload) fails with 409 conflict
    const conflictPrepRes = await postPrepareAutomationRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations`, {
        method: 'POST',
        body: {
          connectorType: 'amocrm',
          actionType: 'sync_crm_summary',
          idempotencyKey: 'idem-crm-sync-tasks-001',
        },
      }),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(conflictPrepRes.status).toBe(409);

    // 4. SQL constraint blocks setting status='confirmed' or 'succeeded' without confirmed_by and confirmed_at
    await expect(
      db.query(
        `update public.business_automation_actions
            set status = 'succeeded'
          where id = $1`,
        [prepBody.action.id],
      ),
    ).rejects.toThrow();

    // 5. Wrong confirmation token fails closed with 403 and executes 0 external calls
    const wrongConfirmRes = await postConfirmAutomationRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations/${prepBody.action.id}/confirm`,
        {
          method: 'POST',
          body: {
            confirmed: true,
            confirmationToken: 'confirm_0000000000000000000000000000000000000000',
          },
        },
      ),
      {
        params: Promise.resolve({
          meetingId: readyMeetingId,
          actionId: prepBody.action.id,
        }),
      },
    );
    expect(wrongConfirmRes.status).toBe(403);
    expect(fakeAutomationProvider.getExecutedActions()).toHaveLength(0);

    // 6. Valid confirmation token with confirmed: true executes the external action once and records audit fields
    const validConfirmRes = await postConfirmAutomationRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations/${prepBody.action.id}/confirm`,
        {
          method: 'POST',
          body: {
            confirmed: true,
            confirmationToken: prepBody.confirmationToken,
          },
        },
      ),
      {
        params: Promise.resolve({
          meetingId: readyMeetingId,
          actionId: prepBody.action.id,
        }),
      },
    );
    expect(validConfirmRes.status).toBe(200);
    const validConfirmBody = (await validConfirmRes.json()) as {
      action: {
        status: string;
        confirmedBy: string | null;
        confirmedAt: string | null;
        externalReferenceId: string | null;
      };
      idempotentReused: boolean;
    };
    expect(validConfirmBody.action.status).toBe('succeeded');
    expect(validConfirmBody.action.confirmedBy).toBe(userOwnerA);
    expect(validConfirmBody.action.confirmedAt).toBeTruthy();
    expect(validConfirmBody.action.externalReferenceId).toBe('ext_amocrm_1');
    expect(validConfirmBody.idempotentReused).toBe(false);
    expect(fakeAutomationProvider.getExecutedActions()).toHaveLength(1);

    // 7. Replaying confirmation returns idempotentReused: true without a second external call
    const replayConfirmRes = await postConfirmAutomationRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations/${prepBody.action.id}/confirm`,
        {
          method: 'POST',
          body: {
            confirmed: true,
            confirmationToken: prepBody.confirmationToken,
          },
        },
      ),
      {
        params: Promise.resolve({
          meetingId: readyMeetingId,
          actionId: prepBody.action.id,
        }),
      },
    );
    expect(replayConfirmRes.status).toBe(200);
    const replayConfirmBody = (await replayConfirmRes.json()) as { idempotentReused: boolean };
    expect(replayConfirmBody.idempotentReused).toBe(true);
    expect(fakeAutomationProvider.getExecutedActions()).toHaveLength(1);
  });

  it('isolates queued automation job failures from meeting readiness and supports cancelling pending actions', async () => {
    // 1. Prepare and cancel an action -> cannot be confirmed afterwards
    const toCancel = await phase9Service.prepareAutomationAction(
      { userId: userOwnerA },
      readyMeetingId,
      {
        connectorType: 'google_docs',
        actionType: 'publish_google_doc',
        idempotencyKey: 'idem-cancel-google-doc-001',
      },
    );
    const cancelRes = await deleteCancelAutomationRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations/${toCancel.action.id}/confirm`,
        { method: 'DELETE' },
      ),
      {
        params: Promise.resolve({
          meetingId: readyMeetingId,
          actionId: toCancel.action.id,
        }),
      },
    );
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as { action: { status: string } };
    expect(cancelBody.action.status).toBe('cancelled');

    const confirmCancelledRes = await postConfirmAutomationRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations/${toCancel.action.id}/confirm`,
        {
          method: 'POST',
          body: {
            confirmed: true,
            confirmationToken: toCancel.confirmationToken!,
          },
        },
      ),
      {
        params: Promise.resolve({
          meetingId: readyMeetingId,
          actionId: toCancel.action.id,
        }),
      },
    );
    expect(confirmCancelledRes.status).toBe(409);

    // 2. Prepare and confirm an action with executeImmediately: false while google_docs connector is failing
    fakeAutomationProvider.injectFailureForConnector('google_docs', {
      code: 'provider_unavailable',
      message: 'Google Docs API 503 Unavailable',
      retryable: true,
    });

    const queuedPrep = await phase9Service.prepareAutomationAction(
      { userId: userOwnerA },
      readyMeetingId,
      {
        connectorType: 'google_docs',
        actionType: 'publish_google_doc',
        idempotencyKey: 'idem-queued-google-doc-fail-002',
      },
    );
    const queuedConf = await phase9Service.confirmAutomationAction(
      { userId: userOwnerA },
      readyMeetingId,
      queuedPrep.action.id,
      {
        confirmed: true,
        confirmationToken: queuedPrep.confirmationToken!,
        executeImmediately: false,
      },
    );
    expect(queuedConf.action.status).toBe('confirmed');

    // Run worker -> executes execute_automation_action job
    await phase9Worker.runUntilIdle('worker-p9-automation-fail');

    // Verify meeting remains 'ready' even though the external automation failed
    const mRes = await db.query<{ status: string; processing_status: string }>(
      `select status::text as status, processing_status::text as processing_status
         from public.meetings
        where id = $1`,
      [readyMeetingId],
    );
    expect(mRes.rows[0]).toEqual({
      status: 'ready',
      processing_status: 'ready',
    });

    const listRes = await getMeetingAutomationsRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations`),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      actions: Array<{ id: string; status: string; errorCode: string | null }>;
    };
    const failedAction = listBody.actions.find((a) => a.id === queuedPrep.action.id)!;
    expect(failedAction.status).toBe('failed');
    expect(failedAction.errorCode).toBe('provider_unavailable');
  });

  it('creates auditable meeting exports (md, csv, json), enforces RLS isolation, and blocks direct client writes', async () => {
    // 1. Export meeting in Markdown and JSON via POST /api/v1/meetings/{meetingId}/exports
    const mdExportRes = await postCreateMeetingExportRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/exports`, {
        method: 'POST',
        body: { format: 'md', includeTranscript: true },
      }),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(mdExportRes.status).toBe(201);
    const mdExportBody = (await mdExportRes.json()) as {
      exportRecord: { id: string; exportFormat: string; contentSha256: string };
      filename: string;
      content: string;
    };
    expect(mdExportBody.exportRecord.exportFormat).toBe('md');
    expect(mdExportBody.content).toContain('# Samarkand Agro Export Q4 Deal Review');
    expect(mdExportBody.content).toContain('## Transcript');

    const jsonExportRes = await postCreateMeetingExportRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/exports`, {
        method: 'POST',
        body: { format: 'json', includeTranscript: false },
      }),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(jsonExportRes.status).toBe(201);

    const exportsListRes = await getMeetingExportsRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/exports`),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(exportsListRes.status).toBe(200);
    const exportsListBody = (await exportsListRes.json()) as { exports: unknown[] };
    expect(exportsListBody.exports).toHaveLength(2);
    expect(emittedEvents.some((e) => e.event === 'meeting_exported')).toBe(true);

    // 2. Cross-workspace isolation: Workspace B owner is denied on all Phase 9 routes for Workspace A
    currentPrincipal = { userId: userOwnerB };
    const crossListRes = await getMeetingAutomationsRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/automations`),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(crossListRes.status).toBe(403);

    const crossExportRes = await postCreateMeetingExportRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${readyMeetingId}/exports`, {
        method: 'POST',
        body: { format: 'csv' },
      }),
      { params: Promise.resolve({ meetingId: readyMeetingId }) },
    );
    expect(crossExportRes.status).toBe(403);

    // 3. RLS blocks Workspace B owner and outsider from reading Workspace A connectors, actions, or exports
    const wsBActions = await asUser(userOwnerB, async () =>
      db.query(`select id from public.business_automation_actions where workspace_id = $1`, [
        workspaceA,
      ]),
    );
    expect(wsBActions.rows).toHaveLength(0);

    const outsiderExports = await asUser(userOutsider, async () =>
      db.query(`select id from public.meeting_exports where workspace_id = $1`, [workspaceA]),
    );
    expect(outsiderExports.rows).toHaveLength(0);

    // 4. Direct authenticated client INSERT into business_automation_actions or meeting_exports is rejected
    await expect(
      asUser(userOwnerA, async () =>
        db.query(
          `insert into public.meeting_exports (
            workspace_id, meeting_id, export_format, filename, byte_size, content_sha256, exported_by
          ) values ($1, $2, 'md', 'test.md', 10, $3, $4)`,
          [workspaceA, readyMeetingId, 'a'.repeat(64), userOwnerA],
        ),
      ),
    ).rejects.toThrow();

    // 5. Composite FK rejects cross-workspace mismatch on meeting_exports
    await expect(
      db.query(
        `insert into public.meeting_exports (
          workspace_id, meeting_id, export_format, filename, byte_size, content_sha256, exported_by
        ) values ($1, $2, 'md', 'test.md', 10, $3, $4)`,
        [workspaceB, readyMeetingId, 'a'.repeat(64), userOwnerA],
      ),
    ).rejects.toThrow();
  });
});
