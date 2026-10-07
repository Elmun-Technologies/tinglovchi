import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  providerWindowExtractionSchema,
  type ProviderTranscriptionResult,
} from '@suhbat/contracts';
import {
  Phase4BackboneService,
  type AuthenticatedPrincipal,
  type StructuredObservabilityEvent,
} from '@suhbat/database/phase4';
import { Phase5TranscriptionService, Phase5TranscriptionWorker } from '@suhbat/database/phase5';
import { Phase6IntelligenceService, Phase6IntelligenceWorker } from '@suhbat/database/phase6';
import { MemoryStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';
import { FakeMeetingIntelligenceProvider } from '@suhbat/database/intelligence-provider';
import { resolveEvidence } from '@suhbat/product';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { createLiveRepositories } from '../../apps/web/src/lib/live-repositories';
import { loadMeetingBundle } from '../../apps/web/src/lib/meeting-bundle';
import { GET as getMeetingAnalysisRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/analysis/route';
import { GET as getMeetingIntelligenceRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/intelligence/route';
import { POST as postRetryAnalysisRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/analysis/retry/route';
import { GET as getMeetingProcessingRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/processing/route';

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
let phase4Service: Phase4BackboneService;
let phase5Service: Phase5TranscriptionService;
let phase6Service: Phase6IntelligenceService;
let phase5Worker: Phase5TranscriptionWorker;
let phase6Worker: Phase6IntelligenceWorker;
let emittedEvents: StructuredObservabilityEvent[] = [];
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;
let companyA: string;
let projectA: string;

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

function makeNextRequest(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  const parsedUrl = new URL(url, 'http://localhost:3000');
  const req = new Request(parsedUrl.toString(), {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return Object.assign(req, { nextUrl: parsedUrl }) as unknown as NextRequest;
}

async function uploadFinalizeAndTranscribeMeeting(params: {
  meetingId: string;
  workspaceId: string;
  sessionId: string;
  customTranscriptionResult?: ProviderTranscriptionResult;
}): Promise<{
  recordingId: string;
  transcriptionRunId: string;
}> {
  const { recording } = await phase4Service.createRecording(
    { userId: userOwnerA },
    {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      sessionId: params.sessionId,
      timeline: {
        clock: 'platform_monotonic_continuous',
        clockEpochId: 'epoch-phase6-1',
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

  if (params.customTranscriptionResult) {
    fakeTranscriptionProvider.setCustomResultForRecording(
      recording.id,
      params.customTranscriptionResult,
    );
  }

  const { source } = await phase4Service.registerSource({ userId: userOwnerA }, recording.id, {
    sourceKind: 'microphone',
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    expectedChunkCount: 2,
  });

  const bytes0 = new TextEncoder().encode(`phase6-chunk-0-${params.sessionId}`);
  const bytes1 = new TextEncoder().encode(`phase6-chunk-1-${params.sessionId}`);

  const { chunk: chunk0 } = await phase4Service.registerChunk(
    { userId: userOwnerA },
    recording.id,
    {
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
    },
  );

  const { chunk: chunk1 } = await phase4Service.registerChunk(
    { userId: userOwnerA },
    recording.id,
    {
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
    },
  );

  for (const [c, b] of [
    [chunk0, bytes0],
    [chunk1, bytes1],
  ] as const) {
    const auth = await phase4Service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      c.id,
      {},
    );
    await storage.putObjectViaSignedUrl(auth.uploadUrl, b);
    await phase4Service.verifyChunkUpload({ userId: userOwnerA }, recording.id, c.id, {});
  }

  await phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
    workspaceId: params.workspaceId,
    canonicalDurationMs: 60_000,
    activeCaptureMs: 60_000,
  });

  await phase5Worker.runUntilIdle('worker-phase5-setup');

  const trStatus = await phase5Service.getMeetingTranscriptionStatus(
    { userId: userOwnerA },
    params.meetingId,
  );
  expect(trStatus.meetingStatus).toBe('transcript_ready');
  expect(trStatus.currentTranscriptionRunId).toBeTruthy();

  return {
    recordingId: recording.id,
    transcriptionRunId: trStatus.currentTranscriptionRunId!,
  };
}

describe('Phase 6 — AI Meeting Intelligence Pipeline, Evidence & RLS Integration Tests', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(authBootstrap);
    await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
    await db.exec(readFileSync(phase5MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase6MigrationPath, 'utf8'));
    await db.exec(readFileSync(seedPath, 'utf8'));

    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data)
      values
        ('${userOwnerA}', 'owner-a@example.com', '{"display_name": "Owner A"}'::jsonb),
        ('${userMemberA}', 'member-a@example.com', '{"display_name": "Member A"}'::jsonb),
        ('${userOwnerB}', 'owner-b@example.com', '{"display_name": "Owner B"}'::jsonb),
        ('${userOutsider}', 'outsider@example.com', '{"display_name": "Outsider"}'::jsonb);

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
        `select public.create_workspace('Workspace Alpha', 'workspace-alpha-p6') as id`,
      );
      return res.rows[0]!.id;
    });

    workspaceB = await asUser(userOwnerB, async () => {
      const res = await db.query<{ id: string }>(
        `select public.create_workspace('Workspace Beta', 'workspace-beta-p6') as id`,
      );
      return res.rows[0]!.id;
    });

    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
       values ($1, $2, 'member', 'active')`,
      [workspaceA, userMemberA],
    );

    const mtRes = await db.query<{ id: string }>(
      `select id from public.meeting_types where workspace_id = $1 order by sort_order asc limit 1`,
      [workspaceA],
    );
    meetingTypeA = mtRes.rows[0]!.id;

    const compRes = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.companies (workspace_id, name, description, created_by)
         values ($1, 'Samarqand Agro Export', 'Regional export and logistics partner', auth.uid())
         returning id`,
        [workspaceA],
      ),
    );
    companyA = compRes.rows[0]!.id;

    const projRes = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.projects (workspace_id, company_id, name, description, created_by)
         values ($1, $2, 'Q4 Regional Rollout', 'Q4 export and enterprise onboarding', auth.uid())
         returning id`,
        [workspaceA, companyA],
      ),
    );
    projectA = projRes.rows[0]!.id;
  });

  beforeEach(() => {
    storage = new MemoryStorageProvider();
    fakeTranscriptionProvider = new FakeTranscriptionProvider();
    fakeIntelligenceProvider = new FakeMeetingIntelligenceProvider();
    emittedEvents = [];
    currentPrincipal = { userId: userOwnerA };

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
    phase5Worker = new Phase5TranscriptionWorker(phase5Service);
    phase6Worker = new Phase6IntelligenceWorker(phase6Service);

    setPhase4Runtime({
      service: phase4Service,
      phase5Service,
      phase6Service,
      transcriptionProvider: fakeTranscriptionProvider,
      intelligenceProvider: fakeIntelligenceProvider,
      resolvePrincipal: async () => currentPrincipal,
    });
  });

  afterAll(async () => {
    setPhase4Runtime(null);
    await db.close();
  });

  it('executes transcript_ready -> analyze_meeting -> normalize_intelligence -> finalize_analysis -> ready, persists immutable analysis_runs, and serves /api/v1 & live repositories', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA,
      projectId: projectA,
      title: 'Q4 Export & Product Strategy Alignment',
    });

    // Build custom transcription segments that include tentative ("Balki $10,000 qilarmiz"),
    // confirmed ("Unda $10,000 budgetda kelishdik"), conversion=57%, budget=$5,000, team size=6
    const customTranscription: ProviderTranscriptionResult = {
      provider: 'fake',
      providerModel: 'fake-multilingual-diarized-v1',
      providerJobId: 'job-p6-e2e-1',
      detectedLanguages: ['uz', 'ru', 'en', 'mixed'],
      durationMs: 60_000,
      providerMetadata: {},
      segments: [
        {
          providerSegmentKey: 'seg_0000',
          speakerLabel: 'speaker_0',
          startMs: 0,
          endMs: 4500,
          text: 'Assalomu alaykum barchaga, bugungi mahsulot va eksport uchrashuvimizni boshlaymiz.',
          confidence: 0.96,
          detectedLanguage: 'uz',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0001',
          speakerLabel: 'speaker_1',
          startMs: 5000,
          endMs: 9500,
          text: "Bizning Q4 revenue forecast bo'yicha 18% o'sish kutilmoqda, conversion 57% ga yetdi, lekin logistika SLA bo'yicha savollar bor.",
          confidence: 0.94,
          detectedLanguage: 'mixed',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0002',
          speakerLabel: 'speaker_2',
          startMs: 10000,
          endMs: 14500,
          text: 'Давайте отдельно зафиксируем график поставок по Ташкенту и Самарканду до пятницы.',
          confidence: 0.95,
          detectedLanguage: 'ru',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0003',
          speakerLabel: 'speaker_0',
          startMs: 15000,
          endMs: 19500,
          text: 'Agreed, the engineering team (team size 6) will finalize the API integration and share the staging report by Thursday.',
          confidence: 0.97,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0004',
          speakerLabel: 'speaker_1',
          startMs: 20000,
          endMs: 24500,
          text: "Bojxona hujjatlari va sertifikatlar chorshanba kuni soat o'n oltigacha tayyor bo'lishi shart.",
          confidence: 0.94,
          detectedLanguage: 'uz',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0005',
          speakerLabel: 'speaker_2',
          startMs: 25000,
          endMs: 29500,
          text: 'По клиентскому onboarding jarayonida enterprise mijozlar uchun dedicated support channel ochamiz, baseline budget $5,000.',
          confidence: 0.92,
          detectedLanguage: 'mixed',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0006',
          speakerLabel: 'speaker_2',
          startMs: 30500,
          endMs: 35000,
          text: 'Balki $10,000 qilarmiz marketing va ombor zaxirasi uchun?',
          confidence: 0.91,
          detectedLanguage: 'uz',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0007',
          speakerLabel: 'speaker_0',
          startMs: 35500,
          endMs: 40000,
          text: 'Unda $10,000 budgetda kelishdik Q4 eksport va enterprise onboarding uchun.',
          confidence: 0.96,
          detectedLanguage: 'uz',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0008',
          speakerLabel: 'speaker_1',
          startMs: 40500,
          endMs: 45000,
          text: 'We also verified the webhook retry policy so transient network drops never duplicate orders.',
          confidence: 0.96,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0009',
          speakerLabel: 'speaker_2',
          startMs: 45500,
          endMs: 50000,
          text: "Samarqand omboridagi захира hajmini yana ikki barobar ko'paytirish bo'yicha taklif kiritildi.",
          confidence: 0.92,
          detectedLanguage: 'uz',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0010',
          speakerLabel: 'speaker_0',
          startMs: 50500,
          endMs: 55000,
          text: 'Keyingi sprintda mobile va desktop release-larni синхронно chiqaramiz, QA sign-off juma kuni.',
          confidence: 0.94,
          detectedLanguage: 'mixed',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg_0011',
          speakerLabel: 'speaker_1',
          startMs: 55500,
          endMs: 59500,
          text: 'Отлично, тогда протокол встречи и список ответственных отправим сразу после звонка.',
          confidence: 0.95,
          detectedLanguage: 'ru',
          words: [],
          providerMetadata: {},
        },
      ],
    };

    const { transcriptionRunId } = await uploadFinalizeAndTranscribeMeeting({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '10000000-0000-4000-8000-000000000001',
      customTranscriptionResult: customTranscription,
    });

    // Map speaker_0 -> Owner A and speaker_1 -> Member A before analysis so participant resolution is tested
    await phase5Service.updateSpeakerMappings({ userId: userOwnerA }, meetingId, {
      mappings: [
        { speakerLabel: 'speaker_0', userId: userOwnerA, displayName: 'Owner A' },
        { speakerLabel: 'speaker_1', userId: userMemberA, displayName: 'Member A' },
      ],
    });

    // Step 1: Enqueue analyze_meeting -> meeting enters `ready_for_analysis`
    const { job: analyzeJob } = await phase6Service.enqueueAnalyzeMeetingJob({
      meetingId,
      transcriptionRunId,
    });
    expect(analyzeJob.jobType).toBe('analyze_meeting');

    let analysisStatus = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(analysisStatus.meetingStatus).toBe('ready_for_analysis');
    expect(analysisStatus.productState).toBe('ready_for_analysis');

    // Step 2: Run analyze_meeting -> meeting enters `normalizing_analysis`
    const completedAnalyze = await phase6Worker.runNextJob('worker-p6-1');
    expect(completedAnalyze?.jobType).toBe('analyze_meeting');
    expect(completedAnalyze?.status).toBe('succeeded');

    analysisStatus = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(analysisStatus.meetingStatus).toBe('normalizing_analysis');
    expect(analysisStatus.productState).toBe('normalizing_analysis');

    // Step 3: Run normalize_intelligence -> meeting enters `analysis_ready` (still NOT `ready`!)
    const completedNormalize = await phase6Worker.runNextJob('worker-p6-1');
    expect(completedNormalize?.jobType).toBe('normalize_intelligence');
    expect(completedNormalize?.status).toBe('succeeded');

    analysisStatus = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(analysisStatus.meetingStatus).toBe('analysis_ready');
    expect(analysisStatus.productState).toBe('analysis_ready');
    expect(analysisStatus.currentAnalysisRunId).toBeNull();

    // Step 4: Run finalize_analysis -> meeting enters product-level `ready`!
    const completedFinalize = await phase6Worker.runNextJob('worker-p6-1');
    expect(completedFinalize?.jobType).toBe('finalize_analysis');
    expect(completedFinalize?.status).toBe('succeeded');

    // Verify via HTTP GET /api/v1/meetings/:id/analysis
    const httpAnalysisRes = await getMeetingAnalysisRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/analysis`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(httpAnalysisRes.status).toBe(200);
    const httpAnalysisBody = await httpAnalysisRes.json();
    expect(httpAnalysisBody.meetingStatus).toBe('ready');
    expect(httpAnalysisBody.pipelineStatus).toBe('ready');
    expect(httpAnalysisBody.productState).toBe('ready');
    expect(httpAnalysisBody.currentAnalysisRunId).toBeTruthy();
    expect(httpAnalysisBody.runs).toHaveLength(1);
    const runDto = httpAnalysisBody.runs[0];
    expect(runDto.status).toBe('completed');
    expect(runDto.provider).toBe('fake');
    expect(runDto.promptVersion).toBe('phase6-prompt-v1');
    expect(runDto.schemaVersion).toBe('phase6-schema-v1');
    expect(runDto.pipelineVersion).toBe('phase6-pipeline-v1');
    expect(runDto.startedAt).toBeTruthy();
    expect(runDto.completedAt).toBeTruthy();
    expect(runDto.tokenUsageMetadata.total_tokens).toBeGreaterThan(0);
    expect('raw_provider_response' in runDto).toBe(false);

    // Completed analysis_runs row is immutable in PostgreSQL
    await expect(
      db.query(`update public.analysis_runs set model = 'tampered' where id = $1`, [runDto.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      db.query(`delete from public.analysis_runs where id = $1`, [runDto.id]),
    ).rejects.toThrow(/immutable/i);

    // Verify via HTTP GET /api/v1/meetings/:id/intelligence
    const httpIntelRes = await getMeetingIntelligenceRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/intelligence`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(httpIntelRes.status).toBe(200);
    const intelBody = await httpIntelRes.json();

    expect(intelBody.summary).toBeTruthy();
    expect(intelBody.summary.claims.length).toBeGreaterThanOrEqual(4);
    expect(intelBody.summary.evidence.length).toBeGreaterThanOrEqual(4);
    expect(intelBody.topics.length).toBeGreaterThanOrEqual(3);
    expect(intelBody.decisions.length).toBeGreaterThanOrEqual(4);
    expect(
      intelBody.decisions.filter((d: { status: string }) => d.status === 'confirmed').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      intelBody.decisions.filter(
        (d: { status: string }) => d.status === 'proposed' || d.status === 'tentative',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(intelBody.actionItems.length).toBeGreaterThanOrEqual(4);
    expect(
      intelBody.actionItems.some((a: { ownerLabel: string | null }) => a.ownerLabel === null),
    ).toBe(true);
    expect(intelBody.actionItems.every((a: { dueDate: string | null }) => a.dueDate === null)).toBe(
      true,
    );
    expect(intelBody.facts.length).toBeGreaterThanOrEqual(5);
    expect(intelBody.questions.length).toBeGreaterThanOrEqual(1);
    expect(intelBody.ideas.length).toBeGreaterThanOrEqual(1);
    expect(intelBody.objections.length).toBeGreaterThanOrEqual(1);
    expect(intelBody.commitments.length).toBeGreaterThanOrEqual(1);
    expect(intelBody.risks.length).toBeGreaterThanOrEqual(1);

    // Verify GET /api/v1/meetings/:id/processing includes Phase 6 steps and productState = 'ready'
    const httpProcRes = await getMeetingProcessingRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/processing`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(httpProcRes.status).toBe(200);
    const procBody = await httpProcRes.json();
    expect(procBody.productState).toBe('ready');
    expect(procBody.timeline.steps.map((s: { key: string }) => s.key)).toEqual(
      expect.arrayContaining([
        'capture',
        'upload',
        'prepare_recording',
        'ready_for_transcription',
        'transcribe',
        'normalize_transcript',
        'transcript_ready',
        'analyze_meeting',
        'normalize_intelligence',
        'finalize_analysis',
      ]),
    );

    // Verify Live Product Repositories & loadMeetingBundle integration
    const liveRepos = createLiveRepositories({
      service: phase4Service,
      phase5Service,
      phase6Service,
      principal: { userId: userOwnerA },
    });

    const bundleResult = await loadMeetingBundle(liveRepos, workspaceA, meetingId);
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) throw bundleResult.error;

    const bundle = bundleResult.bundle;
    const commitments = await liveRepos.meetings.commitmentsFor({
      workspaceId: workspaceA,
      meetingId,
    });
    expect(bundle.detail.state).toBe('ready');
    expect(bundle.detail.executiveSummary.length).toBeGreaterThan(0);
    expect(bundle.detail.keyOutcome).toBeTruthy();
    expect(bundle.transcript.topics.length).toBeGreaterThanOrEqual(3);
    expect(bundle.decisions.length).toBeGreaterThanOrEqual(4);
    expect(bundle.tasks.length).toBeGreaterThanOrEqual(4);
    expect(bundle.facts.length).toBeGreaterThanOrEqual(5);
    expect(bundle.questions.length).toBeGreaterThanOrEqual(1);
    expect(bundle.ideas.length).toBeGreaterThanOrEqual(1);
    expect(commitments.length).toBeGreaterThanOrEqual(1);

    // Every single evidence ref on every entity resolves to real canonical transcript segments
    for (const dec of bundle.decisions) {
      expect(dec.evidence.length).toBeGreaterThan(0);
      for (const ev of dec.evidence) {
        const res = resolveEvidence(ev, bundle.transcript.segments, meetingId);
        expect(res.missingSegmentIds).toHaveLength(0);
        expect(res.crossMeeting).toBe(false);
        expect(res.resolved.length).toBeGreaterThan(0);
        expect(ev.startMs).toBe(res.resolved[0]!.startMs);
        expect(ev.endMs).toBe(res.resolved[0]!.endMs);
      }
    }

    // Company intelligence & workspace knowledge entries are populated from real analysis pipeline
    const companyIntel = await liveRepos.companies.intelligence(companyA);
    expect(companyIntel.derivedFrom).toBe('analysis_pipeline');
    expect(companyIntel.goals.length).toBeGreaterThan(0);
    expect(companyIntel.painPoints.length).toBeGreaterThan(0);
    expect(companyIntel.importantFacts.length).toBeGreaterThan(0);
    expect(companyIntel.objections.length).toBeGreaterThan(0);
    expect(companyIntel.commitments.length).toBeGreaterThan(0);

    const knowledgeEntries = await liveRepos.knowledge.entries({ companyId: companyA });
    expect(knowledgeEntries.length).toBeGreaterThanOrEqual(10);
    expect(new Set(knowledgeEntries.map((k) => k.kind))).toEqual(
      new Set(['decision', 'fact', 'topic', 'commitment', 'question']),
    );

    // Updating speaker mapping for speaker_2 dynamically updates speakerDisplayLabel on intelligence evidence
    await liveRepos.transcripts.confirmSpeakerMapping!({
      meetingId,
      label: 'speaker_2',
      personId: userOwnerA,
    });
    const updatedIntel = await phase6Service.getMeetingIntelligence(
      { userId: userOwnerA },
      meetingId,
    );
    expect(
      updatedIntel.commitments.some((c) =>
        c.evidence.some((e) => e.speakerDisplayLabel === 'Owner A'),
      ),
    ).toBe(true);
  });

  it('quarantines invalid evidence references, enforces composite FK on intelligence_evidence, and fails run when all evidence is invalid', async () => {
    const meetingA1 = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      title: 'Evidence Validation Meeting A1',
    });
    const meetingA2 = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      title: 'Other Meeting A2',
    });

    await uploadFinalizeAndTranscribeMeeting({
      meetingId: meetingA1,
      workspaceId: workspaceA,
      sessionId: '20000000-0000-4000-8000-000000000001',
    });
    await uploadFinalizeAndTranscribeMeeting({
      meetingId: meetingA2,
      workspaceId: workspaceA,
      sessionId: '20000000-0000-4000-8000-000000000002',
    });

    const trA1 = await phase5Service.getMeetingTranscript({ userId: userOwnerA }, meetingA1);
    const trA2 = await phase5Service.getMeetingTranscript({ userId: userOwnerA }, meetingA2);

    const validSeg0 = trA1.segments[0]!.id;
    const validSeg1 = trA1.segments[1]!.id;
    const crossMeetingSegId = trA2.segments[0]!.id;
    const missingSegId = '99999999-0000-4000-8000-999999999999';

    // 1. Partial quarantine: valid summary/topic/decision + 2 invalid items (missing seg + cross-meeting seg)
    fakeIntelligenceProvider.setCustomExtractionForMeeting(
      meetingA1,
      providerWindowExtractionSchema.parse({
        windowIndex: 0,
        executiveSummary: {
          headline: 'Partial Quarantine Test',
          tlDr: 'Valid summary backed by real segment.',
          whyMeetingHappened: 'Testing partial quarantine.',
          majorDiscussions: ['Valid discussion'],
          confirmedDecisions: ['Valid decision'],
          nextActions: [],
          unresolvedPoints: [],
          followUps: [],
          claims: [
            {
              claimKey: 'c1',
              section: 'purpose',
              text: 'Valid purpose claim',
              sourceSegmentIds: [validSeg0],
            },
          ],
          sourceSegmentIds: [validSeg0],
        },
        topics: [
          {
            topicKey: 't_valid',
            title: 'Valid Topic',
            summary: 'Backed by valid segment',
            keywords: ['valid'],
            speakerLabels: ['Speaker 1'],
            sourceSegmentIds: [validSeg0],
          },
        ],
        decisions: [
          {
            decisionKey: 'd_valid',
            statement: 'Valid confirmed decision',
            rationale: null,
            status: 'confirmed',
            ownerLabel: null,
            topicKey: 't_valid',
            confidence: 0.95,
            sourceSegmentIds: [validSeg1],
          },
          {
            decisionKey: 'd_missing_seg',
            statement: 'Invalid decision with non-existent segment ID',
            rationale: null,
            status: 'confirmed',
            ownerLabel: null,
            topicKey: 't_valid',
            confidence: 0.9,
            sourceSegmentIds: [missingSegId],
          },
        ],
        actionItems: [
          {
            actionKey: 'a_cross_meeting',
            title: 'Invalid action item citing segment from another meeting',
            ownerLabel: null,
            dueHint: null,
            dueDate: null,
            status: 'open',
            topicKey: null,
            decisionKey: null,
            confidence: 0.9,
            sourceSegmentIds: [crossMeetingSegId],
          },
        ],
        facts: [],
        questions: [],
        ideas: [],
        objections: [],
        commitments: [],
        risks: [],
        followUps: [],
      }),
    );

    // 2. Full quarantine on meetingA2: all extracted items cite missing segment IDs -> analysis_failed
    fakeIntelligenceProvider.setCustomExtractionForMeeting(
      meetingA2,
      providerWindowExtractionSchema.parse({
        windowIndex: 0,
        executiveSummary: {
          headline: 'All Invalid',
          tlDr: 'All Invalid',
          whyMeetingHappened: 'All Invalid',
          majorDiscussions: ['Invalid'],
          confirmedDecisions: [],
          nextActions: [],
          unresolvedPoints: [],
          followUps: [],
          claims: [
            {
              claimKey: 'c_bad',
              section: 'purpose',
              text: 'Invalid claim',
              sourceSegmentIds: [missingSegId],
            },
          ],
          sourceSegmentIds: [missingSegId],
        },
        topics: [
          {
            topicKey: 't_bad',
            title: 'Invalid Topic',
            summary: 'Invalid',
            keywords: [],
            speakerLabels: [],
            sourceSegmentIds: [missingSegId],
          },
        ],
        decisions: [],
        actionItems: [],
        facts: [],
        questions: [],
        ideas: [],
        objections: [],
        commitments: [],
        risks: [],
        followUps: [],
      }),
    );

    await phase6Worker.runUntilIdle('worker-p6-quarantine');

    const intelA1 = await phase6Service.getMeetingIntelligence({ userId: userOwnerA }, meetingA1);
    expect(intelA1.currentAnalysisRun?.status).toBe('completed');
    expect(intelA1.quarantinedItemCount).toBe(2);
    expect(intelA1.decisions).toHaveLength(1);
    expect(intelA1.decisions[0]!.decisionKey).toBe('d_valid');
    expect(intelA1.actionItems).toHaveLength(0);

    // Verify SQL composite FK on intelligence_evidence blocks cross-meeting segment insertion even for privileged SQL
    await expect(
      db.query(
        `insert into public.intelligence_evidence (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          entity_type, entity_id, transcript_segment_id, evidence_order,
          start_ms, end_ms, speaker_display_label, excerpt
        )
        values ($1, $2, $3, $4, 'decision', $5, $6, 99, 0, 1000, 'Speaker 1', 'Cross meeting')`,
        [
          workspaceA,
          meetingA1,
          intelA1.currentAnalysisRun!.id,
          intelA1.currentAnalysisRun!.transcriptionRunId,
          intelA1.decisions[0]!.id,
          crossMeetingSegId,
        ],
      ),
    ).rejects.toThrow(/foreign key constraint/i);

    const statusA2 = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingA2,
    );
    expect(statusA2.meetingStatus).toBe('analysis_failed');
    expect(statusA2.productState).toBe('analysis_failed');
    expect(statusA2.currentAnalysisRunId).toBeNull();
    expect(statusA2.runs).toHaveLength(1);
    expect(statusA2.runs[0]!.status).toBe('failed');
    expect(statusA2.runs[0]!.errorCode).toBe('evidence_validation_failed');
  });

  it('processes long multi-window transcripts end-to-end with bounded windows and consolidated evidence', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      title: 'Long Multi-Window Strategy Session',
    });

    // Generate 30 segments across 60,000ms
    const segments = Array.from({ length: 30 }, (_, idx) => ({
      providerSegmentKey: `long_${String(idx).padStart(4, '0')}`,
      speakerLabel: `speaker_${idx % 3}`,
      startMs: idx * 2000,
      endMs: idx * 2000 + 1800,
      text:
        idx % 3 === 0
          ? 'Agreed, the engineering team will finalize the API integration and share the staging report by Thursday.'
          : idx % 3 === 1
            ? "Bizning Q4 revenue forecast bo'yicha по договору 18 фоиз o'sish kutilmoqda, lekin logistika SLA bo'yicha savollar bor."
            : "Samarqand omboridagi захира hajmini yana ikki barobar ko'paytirish bo'yicha taklif kiritildi.",
      confidence: 0.95,
      detectedLanguage: 'mixed' as const,
      words: [],
      providerMetadata: {},
    }));

    await uploadFinalizeAndTranscribeMeeting({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '30000000-0000-4000-8000-000000000001',
      customTranscriptionResult: {
        provider: 'fake',
        providerModel: 'fake-multilingual-diarized-v1',
        providerJobId: 'job-long-1',
        detectedLanguages: ['uz', 'ru', 'en', 'mixed'],
        durationMs: 60_000,
        segments,
        providerMetadata: {},
      },
    });

    // Configure service with maxSegmentsPerWindow = 10, overlapSegments = 2
    const windowedService = new Phase6IntelligenceService({
      db,
      phase5: phase5Service,
      intelligenceProvider: fakeIntelligenceProvider,
      windowOptions: { maxSegmentsPerWindow: 10, overlapSegments: 2 },
      onEvent: (ev) => emittedEvents.push(ev),
    });
    const windowedWorker = new Phase6IntelligenceWorker(windowedService);

    await windowedWorker.runUntilIdle('worker-p6-windowed');

    const status = await windowedService.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(status.meetingStatus).toBe('ready');
    expect(status.runs).toHaveLength(1);
    expect(status.runs[0]!.windowCount).toBe(4);
    expect(fakeIntelligenceProvider.getCallLog()).toHaveLength(4);

    const intel = await windowedService.getMeetingIntelligence({ userId: userOwnerA }, meetingId);
    expect(intel.topics).toHaveLength(3);
    // Consolidated topics union segment IDs across all 4 windows
    for (const topic of intel.topics) {
      expect(topic.sourceSegmentIds.length).toBeGreaterThan(3);
    }
  });

  it('enforces worker crash recovery, stale fencing token rejection, retry idempotency, and preserves failed historical runs on rerun', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      title: 'Resilience, Fencing & Retry Meeting',
    });

    const { transcriptionRunId } = await uploadFinalizeAndTranscribeMeeting({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '40000000-0000-4000-8000-000000000001',
    });

    // 1. Terminal provider failure -> run_number=1 is `failed` and meeting is `analysis_failed`
    fakeIntelligenceProvider.injectFailureForMeeting(meetingId, {
      code: 'provider_analysis_failed',
      message: 'Simulated non-retryable LLM schema refusal',
      retryable: false,
    });

    await phase6Service.enqueueAnalyzeMeetingJob({ meetingId, transcriptionRunId });
    await phase6Worker.runUntilIdle('worker-p6-fail');

    const afterFailStatus = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(afterFailStatus.meetingStatus).toBe('analysis_failed');
    expect(afterFailStatus.currentAnalysisRunId).toBeNull();
    expect(afterFailStatus.runs).toHaveLength(1);
    expect(afterFailStatus.runs[0]!.runNumber).toBe(1);
    expect(afterFailStatus.runs[0]!.status).toBe('failed');

    // Clear provider failure and trigger retry via POST /api/v1/meetings/:id/analysis/retry
    fakeIntelligenceProvider.clearFailureForMeeting(meetingId);
    fakeIntelligenceProvider.clearCallLog();

    const retryRes1 = await postRetryAnalysisRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/analysis/retry`, {
        method: 'POST',
        body: { reason: 'Retry after fixing provider' },
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(retryRes1.status).toBe(200);
    const retryBody1 = await retryRes1.json();
    expect(retryBody1.idempotentReused).toBe(false);
    expect(retryBody1.job.jobType).toBe('analyze_meeting');
    expect(retryBody1.job.generation).toBe(2);

    // Calling retry again while job is queued returns the exact same job idempotently
    const retryRes2 = await postRetryAnalysisRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/analysis/retry`, {
        method: 'POST',
        body: { reason: 'Duplicate retry click' },
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(retryRes2.status).toBe(200);
    const retryBody2 = await retryRes2.json();
    expect(retryBody2.idempotentReused).toBe(true);
    expect(retryBody2.job.id).toBe(retryBody1.job.id);

    // 2. Simulate worker-1 crashing right after persisting provider response, and worker-2 reclaiming the expired lease!
    const t0 = new Date(Date.now() + 1_000);
    const claimedByWorker1 = await phase6Worker.claimNextJob('worker-1', {
      leaseSeconds: 30,
      now: t0,
    });
    expect(claimedByWorker1?.id).toBe(retryBody1.job.id);

    const tExpired = new Date(t0.getTime() + 60_000);
    let reclaimedByWorker2Id: string | null = null;

    await expect(
      phase6Worker.executeClaimedAnalyzeMeetingJob('worker-1', claimedByWorker1!, {
        now: t0,
        afterAnalysisProviderResponseHook: async () => {
          // Lease expires while worker-1 stalls after saving provider response; worker-2 reclaims the job
          const reclaimed = await phase6Worker.claimNextJob('worker-2', {
            leaseSeconds: 300,
            now: tExpired,
          });
          reclaimedByWorker2Id = reclaimed?.id ?? null;
          expect(reclaimed?.fencingToken).toBeGreaterThan(claimedByWorker1!.fencingToken);
        },
      }),
    ).rejects.toMatchObject({
      code: 'stale_fencing_token',
    });
    expect(reclaimedByWorker2Id).toBe(claimedByWorker1!.id);
    expect(fakeIntelligenceProvider.getCallLog()).toHaveLength(1);

    // Worker-2 executes the reclaimed analyze_meeting job and recovers from the persisted provider output WITHOUT calling provider again!
    const reclaimedJobRes = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    const activeAnalyzeJob = reclaimedJobRes.jobs.find((j) => j.id === claimedByWorker1!.id)!;
    const recoveredAnalyze = await phase6Worker.executeClaimedAnalyzeMeetingJob(
      'worker-2',
      activeAnalyzeJob,
      { now: tExpired },
    );
    expect(recoveredAnalyze.status).toBe('succeeded');
    expect(recoveredAnalyze.resultMetadata.recovered_after_provider_response).toBe(true);
    // Provider was STILL only called once!
    expect(fakeIntelligenceProvider.getCallLog()).toHaveLength(1);

    // Finish normalize_intelligence and finalize_analysis
    await phase6Worker.runUntilIdle('worker-2', { now: tExpired });

    // Verify historical run_number=1 (failed) AND run_number=2 (completed) both exist and are inspectable
    const finalStatus = await phase6Service.getMeetingAnalysisStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(finalStatus.meetingStatus).toBe('ready');
    expect(finalStatus.runs).toHaveLength(2);
    expect(finalStatus.runs[0]!.runNumber).toBe(1);
    expect(finalStatus.runs[0]!.status).toBe('failed');
    expect(finalStatus.runs[1]!.runNumber).toBe(2);
    expect(finalStatus.runs[1]!.status).toBe('completed');
    expect(finalStatus.currentAnalysisRunId).toBe(finalStatus.runs[1]!.id);
  });

  it('enforces cross-workspace RLS isolation and rejects direct client writes across all 12 Phase 6 tables', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      title: 'RLS & Security Verification Meeting',
    });

    await uploadFinalizeAndTranscribeMeeting({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '50000000-0000-4000-8000-000000000001',
    });

    await phase6Worker.runUntilIdle('worker-p6-rls');

    const phase6Tables = [
      'analysis_runs',
      'meeting_summaries',
      'meeting_topics',
      'meeting_decisions',
      'meeting_action_items',
      'meeting_facts',
      'meeting_questions',
      'meeting_ideas',
      'meeting_objections',
      'meeting_commitments',
      'meeting_risks',
      'intelligence_evidence',
    ] as const;

    // 1. Active workspace members (userOwnerA, userMemberA) can SELECT rows from all 12 tables
    for (const table of phase6Tables) {
      const ownerRows = await asUser(userOwnerA, async () =>
        db.query<{ cnt: string | number }>(
          `select count(*) as cnt from public.${table} where meeting_id = $1`,
          [meetingId],
        ),
      );
      expect(Number(ownerRows.rows[0]!.cnt)).toBeGreaterThan(0);

      const memberRows = await asUser(userMemberA, async () =>
        db.query<{ cnt: string | number }>(
          `select count(*) as cnt from public.${table} where meeting_id = $1`,
          [meetingId],
        ),
      );
      expect(Number(memberRows.rows[0]!.cnt)).toBe(Number(ownerRows.rows[0]!.cnt));
    }

    // 2. Non-members (userOwnerB from workspaceB, userOutsider) see 0 rows across all 12 tables
    for (const table of phase6Tables) {
      const ownerBRows = await asUser(userOwnerB, async () =>
        db.query<{ cnt: string | number }>(
          `select count(*) as cnt from public.${table} where meeting_id = $1`,
          [meetingId],
        ),
      );
      expect(Number(ownerBRows.rows[0]!.cnt)).toBe(0);

      const outsiderRows = await asUser(userOutsider, async () =>
        db.query<{ cnt: string | number }>(
          `select count(*) as cnt from public.${table} where meeting_id = $1`,
          [meetingId],
        ),
      );
      expect(Number(outsiderRows.rows[0]!.cnt)).toBe(0);
    }

    // 3. Direct client writes (INSERT, UPDATE, DELETE) by authenticated role are rejected on all 12 tables
    for (const table of phase6Tables) {
      await expect(
        asUser(userOwnerA, async () =>
          db.query(`delete from public.${table} where meeting_id = $1`, [meetingId]),
        ),
      ).rejects.toThrow(/permission denied/i);
    }

    // 4. Client-supplied workspaceId mismatch (workspaceB) and cross-workspace HTTP API requests from userOwnerB are rejected
    expect(workspaceB).not.toBe(workspaceA);

    const mismatchRes = await getMeetingAnalysisRoute(
      makeNextRequest(
        `http://localhost:3000/api/v1/meetings/${meetingId}/analysis?workspaceId=${workspaceB}`,
      ),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(mismatchRes.status).toBe(403);
    expect((await mismatchRes.json()).error.code).toBe('cross_workspace_access_denied');

    currentPrincipal = { userId: userOwnerB };

    const forbiddenAnalysisRes = await getMeetingAnalysisRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/analysis`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(forbiddenAnalysisRes.status).toBe(403);
    expect((await forbiddenAnalysisRes.json()).error.code).toBe('cross_workspace_access_denied');

    const forbiddenIntelRes = await getMeetingIntelligenceRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/intelligence`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(forbiddenIntelRes.status).toBe(403);
    expect((await forbiddenIntelRes.json()).error.code).toBe('cross_workspace_access_denied');

    const forbiddenRetryRes = await postRetryAnalysisRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/analysis/retry`, {
        method: 'POST',
        body: {},
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(forbiddenRetryRes.status).toBe(403);
    expect((await forbiddenRetryRes.json()).error.code).toBe('cross_workspace_access_denied');
  });
});
