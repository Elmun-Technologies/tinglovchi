import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTranscriptionResult } from '@suhbat/contracts';
import {
  Phase4BackboneService,
  type AuthenticatedPrincipal,
  type StructuredObservabilityEvent,
} from '@suhbat/database/phase4';
import { Phase5TranscriptionService, Phase5TranscriptionWorker } from '@suhbat/database/phase5';
import { Phase6IntelligenceService, Phase6IntelligenceWorker } from '@suhbat/database/phase6';
import { Phase7KnowledgeService, Phase7KnowledgeWorker } from '@suhbat/database/phase7';
import { MemoryStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';
import { FakeMeetingIntelligenceProvider } from '@suhbat/database/intelligence-provider';
import { FakeEmbeddingProvider } from '@suhbat/database/embedding-provider';
import { resolveEvidence } from '@suhbat/product';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { createLiveRepositories } from '../../apps/web/src/lib/live-repositories';
import { GET as getMeetingKnowledgeRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/knowledge/route';
import { POST as postReindexKnowledgeRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/knowledge/reindex/route';
import { POST as postAskWorkspaceQuestionRoute } from '../../apps/web/src/app/api/v1/workspaces/[workspaceId]/ask/route';
import { DELETE as deleteRecordingRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/route';

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
let phase4Service: Phase4BackboneService;
let phase5Service: Phase5TranscriptionService;
let phase6Service: Phase6IntelligenceService;
let phase7Service: Phase7KnowledgeService;
let phase5Worker: Phase5TranscriptionWorker;
let phase6Worker: Phase6IntelligenceWorker;
let phase7Worker: Phase7KnowledgeWorker;
let emittedEvents: StructuredObservabilityEvent[] = [];
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;
let companyA1: string;
let companyA2: string;
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

function makeNextRequest(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  const parsedUrl = new URL(url, 'http://localhost:3000');
  const req = new Request(parsedUrl.toString(), {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return Object.assign(req, { nextUrl: parsedUrl }) as unknown as NextRequest;
}

async function runFullMeetingPipelineToKnowledge(params: {
  userId?: string;
  meetingId: string;
  workspaceId: string;
  sessionId: string;
  customTranscriptionResult?: ProviderTranscriptionResult;
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
        clockEpochId: `epoch-${params.sessionId}`,
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

  const { source } = await phase4Service.registerSource({ userId: actorId }, recording.id, {
    sourceKind: 'microphone',
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    expectedChunkCount: 2,
  });

  const bytes0 = new TextEncoder().encode(`phase7-chunk-0-${params.sessionId}`);
  const bytes1 = new TextEncoder().encode(`phase7-chunk-1-${params.sessionId}`);

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

  // Execute Phase 5 (transcribe_recording + align_transcript)
  await phase5Worker.runUntilIdle(`worker-p5-${params.sessionId}`);
  // Execute Phase 6 (analyze_meeting + finalize_analysis -> enqueues generate_embeddings)
  await phase6Worker.runUntilIdle(`worker-p6-${params.sessionId}`);
  // Execute Phase 7 (generate_embeddings + index_knowledge)
  await phase7Worker.runUntilIdle(`worker-p7-${params.sessionId}`);

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

describe('Phase 7 PGlite: Company Memory, Knowledge Indexing & Ask AI (RAG)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(authBootstrap);
    await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
    await db.exec(readFileSync(phase5MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase6MigrationPath, 'utf8'));
    await db.exec(readFileSync(phase7MigrationPath, 'utf8'));
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
        `select public.create_workspace('Workspace Alpha', 'workspace-alpha-p7') as id`,
      );
      return res.rows[0]!.id;
    });

    workspaceB = await asUser(userOwnerB, async () => {
      const res = await db.query<{ id: string }>(
        `select public.create_workspace('Workspace Beta', 'workspace-beta-p7') as id`,
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

    const comp1Res = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.companies (workspace_id, name, description, created_by)
         values ($1, 'Foodera Logistics', 'Regional food delivery and logistics partner', auth.uid())
         returning id`,
        [workspaceA],
      ),
    );
    companyA1 = comp1Res.rows[0]!.id;

    const comp2Res = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.companies (workspace_id, name, description, created_by)
         values ($1, 'Nomad Education', 'EdTech language and IELTS platform', auth.uid())
         returning id`,
        [workspaceA],
      ),
    );
    companyA2 = comp2Res.rows[0]!.id;

    const proj1Res = await asUser(userOwnerA, async () =>
      db.query<{ id: string }>(
        `insert into public.projects (workspace_id, company_id, name, description, created_by)
         values ($1, $2, 'Foodera Q4 Rollout', 'Q4 marketing and logistics expansion', auth.uid())
         returning id`,
        [workspaceA, companyA1],
      ),
    );
    projectA1 = proj1Res.rows[0]!.id;

    storage = new MemoryStorageProvider();
    fakeTranscriptionProvider = new FakeTranscriptionProvider();
    fakeIntelligenceProvider = new FakeMeetingIntelligenceProvider();
    fakeEmbeddingProvider = new FakeEmbeddingProvider();

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

    phase5Worker = new Phase5TranscriptionWorker(phase5Service);
    phase6Worker = new Phase6IntelligenceWorker(phase6Service);
    phase7Worker = new Phase7KnowledgeWorker(phase7Service);

    setPhase4Runtime({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      transcriptionProvider: fakeTranscriptionProvider,
      intelligenceProvider: fakeIntelligenceProvider,
      embeddingProvider: fakeEmbeddingProvider,
      resolvePrincipal: async () => currentPrincipal,
    });
  });

  beforeEach(() => {
    emittedEvents = [];
    currentPrincipal = { userId: userOwnerA };
    fakeEmbeddingProvider.clearCallLog();
  });

  afterAll(async () => {
    setPhase4Runtime(null);
    await db.close();
  });

  it('evaluates public.cosine_similarity accurately in SQL', async () => {
    const identical = await db.query<{ sim: number }>(
      `select public.cosine_similarity(array[0.6, 0.8]::double precision[], array[0.6, 0.8]::double precision[]) as sim`,
    );
    expect(Number(identical.rows[0]!.sim)).toBeCloseTo(1.0, 6);

    const orthogonal = await db.query<{ sim: number }>(
      `select public.cosine_similarity(array[1.0, 0.0]::double precision[], array[0.0, 1.0]::double precision[]) as sim`,
    );
    expect(Number(orthogonal.rows[0]!.sim)).toBeCloseTo(0.0, 6);

    const mismatched = await db.query<{ sim: number }>(
      `select public.cosine_similarity(array[1.0, 0.0]::double precision[], array[1.0]::double precision[]) as sim`,
    );
    expect(Number(mismatched.rows[0]!.sim)).toBe(0);
  });

  it('completes the full Phase 4 → 5 → 6 → 7 pipeline, indexes canonical knowledge chunks, and serves GET /api/v1/meetings/:id/knowledge', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      projectId: projectA1,
      title: 'Foodera Q4 Growth & Customs Sync',
    });

    const { embeddingRunId, analysisRunId, transcriptionRunId } =
      await runFullMeetingPipelineToKnowledge({
        meetingId,
        workspaceId: workspaceA,
        sessionId: '77777777-0001-4777-8777-777777777001',
      });

    // Verify GET /api/v1/meetings/:id/knowledge
    const res = await getMeetingKnowledgeRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/knowledge`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.meetingId).toBe(meetingId);
    expect(body.workspaceId).toBe(workspaceA);
    expect(body.meetingStatus).toBe('ready');
    expect(body.currentEmbeddingRunId).toBe(embeddingRunId);
    expect(body.latestEmbeddingRunId).toBe(embeddingRunId);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].status).toBe('completed');
    expect(body.runs[0].analysisRunId).toBe(analysisRunId);
    expect(body.runs[0].transcriptionRunId).toBe(transcriptionRunId);
    expect(body.chunks.length).toBeGreaterThanOrEqual(8);

    // Verify chunk types include summary, topic, decision, action_item, fact, question, commitment, risk, transcript
    const chunkTypes = new Set(body.chunks.map((c: { chunkType: string }) => c.chunkType));
    expect(chunkTypes.has('summary')).toBe(true);
    expect(chunkTypes.has('topic')).toBe(true);
    expect(chunkTypes.has('decision')).toBe(true);
    expect(chunkTypes.has('action_item')).toBe(true);
    expect(chunkTypes.has('fact')).toBe(true);
    expect(chunkTypes.has('transcript')).toBe(true);

    // Every chunk must link to at least one canonical transcript segment in the same meeting & transcription run
    for (const chunk of body.chunks) {
      expect(chunk.transcriptSources.length).toBeGreaterThan(0);
      expect(chunk.companyId).toBe(companyA1);
      expect(chunk.projectId).toBe(projectA1);
      expect(chunk.workspaceId).toBe(workspaceA);
      expect(chunk.meetingId).toBe(meetingId);
      expect(chunk.transcriptionRunId).toBe(transcriptionRunId);
      for (const ts of chunk.transcriptSources) {
        expect(ts.knowledgeChunkId).toBe(chunk.id);
        expect(ts.transcriptSegmentId).toBeTruthy();
      }
    }

    // Verify processing events were recorded
    const eventTypes = new Set(emittedEvents.map((e) => e.event));
    expect(eventTypes.has('embeddings_started')).toBe(true);
    expect(eventTypes.has('embeddings_completed')).toBe(true);
    expect(eventTypes.has('knowledge_indexed')).toBe(true);
  });

  it('enforces embedding_runs immutability trigger and composite FK constraints on knowledge chunk source tables', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      title: 'Foodera Immutability & FK Check',
    });

    const { embeddingRunId } = await runFullMeetingPipelineToKnowledge({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '77777777-0002-4777-8777-777777777002',
    });

    // Completed embedding_run cannot be mutated or deleted
    await expect(
      db.query(`update public.embedding_runs set chunk_count = 999 where id = $1`, [
        embeddingRunId,
      ]),
    ).rejects.toThrow(/immutable/i);

    await expect(
      db.query(`delete from public.embedding_runs where id = $1`, [embeddingRunId]),
    ).rejects.toThrow(/immutable/i);

    // Composite FK on knowledge_chunk_transcript_sources blocks cross-meeting / cross-workspace segment linkage
    const chunkRes = await db.query<{ id: string; transcription_run_id: string }>(
      `select id, transcription_run_id from public.knowledge_chunks where embedding_run_id = $1 limit 1`,
      [embeddingRunId],
    );
    const chunk = chunkRes.rows[0]!;
    const bogusSegmentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    await expect(
      db.query(
        `insert into public.knowledge_chunk_transcript_sources (
          workspace_id, meeting_id, transcription_run_id, knowledge_chunk_id, transcript_segment_id, sequence_no
        ) values ($1, $2, $3, $4, $5, 99)`,
        [workspaceA, meetingId, chunk.transcription_run_id, chunk.id, bogusSegmentId],
      ),
    ).rejects.toThrow();
  });

  it('enforces RLS and revokes direct client writes on Phase 7 tables', async () => {
    const meetingRes = await db.query<{ id: string }>(
      `select id from public.meetings where workspace_id = $1 and current_embedding_run_id is not null limit 1`,
      [workspaceA],
    );
    const meetingId = meetingRes.rows[0]!.id;

    // Authenticated member of Workspace A can read Workspace A's embedding_runs, knowledge_chunks, sources, and ask_ai_queries
    const memberChunks = await asUser(userMemberA, async () =>
      db.query<{ id: string }>(`select id from public.knowledge_chunks where meeting_id = $1`, [
        meetingId,
      ]),
    );
    expect(memberChunks.rows.length).toBeGreaterThan(0);

    // Authenticated member of Workspace A CANNOT insert/update/delete knowledge_chunks directly
    await expect(
      asUser(userMemberA, async () =>
        db.query(`delete from public.knowledge_chunks where meeting_id = $1`, [meetingId]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(userMemberA, async () =>
        db.query(`delete from public.embedding_runs where meeting_id = $1`, [meetingId]),
      ),
    ).rejects.toThrow(/permission denied/i);

    // Workspace B owner and outsider see 0 rows in Workspace A's Phase 7 tables
    for (const attacker of [userOwnerB, userOutsider]) {
      const leakRuns = await asUser(attacker, async () =>
        db.query(`select id from public.embedding_runs where workspace_id = $1`, [workspaceA]),
      );
      expect(leakRuns.rows).toHaveLength(0);

      const leakChunks = await asUser(attacker, async () =>
        db.query(`select id from public.knowledge_chunks where workspace_id = $1`, [workspaceA]),
      );
      expect(leakChunks.rows).toHaveLength(0);

      const leakSources = await asUser(attacker, async () =>
        db.query(
          `select id from public.knowledge_chunk_transcript_sources where workspace_id = $1`,
          [workspaceA],
        ),
      );
      expect(leakSources.rows).toHaveLength(0);

      const leakItemSources = await asUser(attacker, async () =>
        db.query(`select id from public.knowledge_chunk_item_sources where workspace_id = $1`, [
          workspaceA,
        ]),
      );
      expect(leakItemSources.rows).toHaveLength(0);

      const leakQueries = await asUser(attacker, async () =>
        db.query(`select id from public.ask_ai_queries where workspace_id = $1`, [workspaceA]),
      );
      expect(leakQueries.rows).toHaveLength(0);
    }
  });

  it('supports knowledge reindexing (run_number = 2), preserves historical runs, and fences stale workers', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      title: 'Foodera Reindex & Fencing Sync',
    });

    const { embeddingRunId: run1Id } = await runFullMeetingPipelineToKnowledge({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '77777777-0003-4777-8777-777777777003',
    });

    // Trigger reindex via POST /api/v1/meetings/:id/knowledge/reindex
    const reindexRes = await postReindexKnowledgeRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/knowledge/reindex`, {
        method: 'POST',
        body: { reason: 'Updated embedding index test' },
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(reindexRes.status).toBe(200);
    const reindexBody = await reindexRes.json();
    expect(reindexBody.idempotentReused).toBe(false);
    expect(reindexBody.job.jobType).toBe('generate_embeddings');

    // Calling reindex again while job is queued idempotently reuses the active job
    const duplicateReindexRes = await postReindexKnowledgeRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/knowledge/reindex`, {
        method: 'POST',
        body: { reason: 'Duplicate request' },
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(duplicateReindexRes.status).toBe(200);
    const duplicateBody = await duplicateReindexRes.json();
    expect(duplicateBody.idempotentReused).toBe(true);
    expect(duplicateBody.job.id).toBe(reindexBody.job.id);

    // Test stale worker fencing: worker-1 claims generate_embeddings with short lease, worker-2 steals after expiry
    const t0 = new Date(Date.now() + 10_000);
    const claimed1 = await phase7Worker.claimNextJob('worker-stale-p7', {
      now: t0,
      leaseSeconds: 10,
    });
    expect(claimed1).not.toBeNull();
    expect(claimed1!.id).toBe(reindexBody.job.id);

    let claimed2: Awaited<ReturnType<typeof phase7Worker.claimNextJob>> = null;
    await expect(
      phase7Worker.executeClaimedGenerateEmbeddingsJob('worker-stale-p7', claimed1!, {
        now: t0,
        afterEmbeddingProviderResponseHook: async () => {
          const tExpired = new Date(t0.getTime() + 25_000);
          claimed2 = await phase7Worker.claimNextJob('worker-fresh-p7', {
            now: tExpired,
            leaseSeconds: 120,
          });
          expect(claimed2).not.toBeNull();
          expect(claimed2!.fencingToken).toBeGreaterThan(claimed1!.fencingToken);
        },
      }),
    ).rejects.toThrow(/fencing/i);

    // Fresh worker finishes generate_embeddings and index_knowledge
    const tFresh = new Date(t0.getTime() + 30_000);
    await phase7Worker.executeClaimedGenerateEmbeddingsJob('worker-fresh-p7', claimed2!, {
      now: tFresh,
    });
    await phase7Worker.runUntilIdle('worker-fresh-p7', { now: tFresh });

    const statusRes = await getMeetingKnowledgeRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/knowledge`),
      { params: Promise.resolve({ meetingId }) },
    );
    const statusBody = await statusRes.json();

    expect(statusBody.runs).toHaveLength(2);
    const run1 = statusBody.runs.find((r: { runNumber: number }) => r.runNumber === 1);
    const run2 = statusBody.runs.find((r: { runNumber: number }) => r.runNumber === 2);
    expect(run1.id).toBe(run1Id);
    expect(run1.status).toBe('completed');
    expect(run2.status).toBe('completed');
    expect(statusBody.currentEmbeddingRunId).toBe(run2.id);
    expect(statusBody.latestEmbeddingRunId).toBe(run2.id);

    // Chunks for both historical run 1 and current run 2 exist in DB, while GET /knowledge returns current run's chunks
    const dbChunkRuns = await db.query<{ embedding_run_id: string; cnt: string }>(
      `select embedding_run_id, count(*)::text as cnt
         from public.knowledge_chunks
        where meeting_id = $1
        group by embedding_run_id`,
      [meetingId],
    );
    expect(dbChunkRuns.rows).toHaveLength(2);
  });

  it('preserves meeting ready status and previous current_embedding_run_id when an embedding provider run fails', async () => {
    const meetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      title: 'Foodera Embedding Failure Resilience',
    });

    const { embeddingRunId: initialRunId } = await runFullMeetingPipelineToKnowledge({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '77777777-0004-4777-8777-777777777004',
    });

    fakeEmbeddingProvider.injectFailureForMeeting(meetingId, {
      code: 'provider_unavailable',
      message: 'Simulated embedding provider outage',
      retryable: false,
    });

    try {
      await phase7Service.reindexMeetingKnowledge({ userId: userOwnerA }, meetingId, {
        reason: 'Test failure handling',
      });
      await phase7Worker.runUntilIdle('worker-p7-fail');
    } finally {
      fakeEmbeddingProvider.clearFailureForMeeting(meetingId);
    }

    const status = await phase7Service.getMeetingKnowledgeStatus({ userId: userOwnerA }, meetingId);
    expect(status.meetingStatus).toBe('ready');
    expect(status.currentEmbeddingRunId).toBe(initialRunId);
    expect(status.runs).toHaveLength(2);
    const failedRun = status.runs.find((r) => r.runNumber === 2)!;
    expect(failedRun.status).toBe('failed');
    expect(failedRun.errorCode).toBe('provider_unavailable');
  });

  it('answers workspace, company, and project scoped questions via POST /api/v1/workspaces/:id/ask and createLiveRepositories with canonical citations', async () => {
    // Create a second meeting under Company A2 (Nomad Education) to test company/project scoping
    const nomadMeetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA2,
      title: 'Nomad Education Teacher Onboarding Review',
    });

    await runFullMeetingPipelineToKnowledge({
      meetingId: nomadMeetingId,
      workspaceId: workspaceA,
      sessionId: '77777777-0005-4777-8777-777777777005',
      customTranscriptionResult: {
        provider: 'fake',
        providerModel: 'fake-multilingual-v1',
        providerJobId: 'job-nomad-1',
        detectedLanguages: ['uz', 'en'],
        durationMs: 30_000,
        segments: [
          {
            providerSegmentKey: 'nomad-seg-0',
            speakerLabel: 'speaker_0',
            startMs: 1000,
            endMs: 12000,
            text: 'Nomad Education landing sahifasiga 12 ta IELTS mentor profilini juma kunigacha joylashtiramiz.',
            detectedLanguage: 'uz',
            confidence: 0.96,
            words: [],
            providerMetadata: {},
          },
          {
            providerSegmentKey: 'nomad-seg-1',
            speakerLabel: 'speaker_1',
            startMs: 13000,
            endMs: 25000,
            text: 'Student conversion rate reached 18 percent in September and target is 24 percent.',
            detectedLanguage: 'en',
            confidence: 0.95,
            words: [],
            providerMetadata: {},
          },
        ],
        providerMetadata: {},
      },
    });

    // 1. Ask about Foodera budget/customs scoped to Company A1 via POST /api/v1/workspaces/:id/ask
    const askFooderaRes = await postAskWorkspaceQuestionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/ask`, {
        method: 'POST',
        body: {
          question: 'Byudjet va bojxona kechikishi haqida qanday qaror va xavflar bor?',
          companyId: companyA1,
        },
      }),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(askFooderaRes.status).toBe(200);
    const askFooderaBody = await askFooderaRes.json();

    expect(askFooderaBody.workspaceId).toBe(workspaceA);
    expect(askFooderaBody.companyId).toBe(companyA1);
    expect(askFooderaBody.adapter).toBe('rag_pipeline');
    expect(askFooderaBody.citations.length).toBeGreaterThan(0);

    // Every citation must belong to Company A1 meetings, never Nomad Education (Company A2)
    for (const citation of askFooderaBody.citations) {
      expect(citation.meetingId).not.toBe(nomadMeetingId);
      expect(citation.segmentIds.length).toBeGreaterThan(0);
      expect(citation.endMs).toBeGreaterThanOrEqual(citation.startMs);
    }

    // 2. Ask about IELTS mentor profiles scoped to Company A2 (Nomad Education)
    const askNomadRes = await postAskWorkspaceQuestionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/ask`, {
        method: 'POST',
        body: {
          question: 'IELTS mentor profili va conversion rate haqida nima deyildi?',
          companyId: companyA2,
        },
      }),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(askNomadRes.status).toBe(200);
    const askNomadBody = await askNomadRes.json();
    expect(askNomadBody.citations.length).toBeGreaterThan(0);
    for (const citation of askNomadBody.citations) {
      expect(citation.meetingId).toBe(nomadMeetingId);
    }

    // 3. Verify live ProductRepositories (askAi.ask, askAi.suggestions, search.search, search.recent)
    const liveRepos = createLiveRepositories({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      principal: { userId: userOwnerA },
    });

    const suggestions = await liveRepos.askAi.suggestions(workspaceA);
    expect(suggestions.length).toBeGreaterThan(0);

    const productAsk = await liveRepos.askAi.ask(
      workspaceA,
      'Byudjet va Google PMax haqida qanday qaror qabul qilindi?',
    );
    expect(productAsk.adapter).toBe('rag_pipeline');
    expect(productAsk.citations.length).toBeGreaterThan(0);

    // Verify every citation's segmentIds resolve against liveRepos.transcripts.forMeeting
    const firstCitation = productAsk.citations[0]!;
    const citedTranscript = await liveRepos.transcripts.forMeeting(firstCitation.meetingId);
    const resolution = resolveEvidence(
      {
        meetingId: firstCitation.meetingId,
        meetingTitle: firstCitation.meetingTitle,
        occurredAt: firstCitation.occurredAt,
        startMs: firstCitation.startMs,
        endMs: firstCitation.endMs,
        segmentIds: firstCitation.segmentIds,
        speakerPersonIds: [],
      },
      citedTranscript.segments,
      firstCitation.meetingId,
    );
    expect(resolution.missingSegmentIds).toEqual([]);
    expect(resolution.resolved.length).toBeGreaterThan(0);

    // Verify search.search finds meetings/chunks by transcript content ("IELTS")
    const searchHits = await liveRepos.search.search(workspaceA, 'IELTS');
    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits.some((h) => h.id === nomadMeetingId)).toBe(true);

    const recentHits = await liveRepos.search.recent(workspaceA);
    expect(recentHits.length).toBeGreaterThan(0);
  });

  it('blocks cross-workspace access to knowledge and Ask AI endpoints and never leaks across workspaces', async () => {
    const meetingRes = await db.query<{ id: string }>(
      `select id from public.meetings where workspace_id = $1 and current_embedding_run_id is not null limit 1`,
      [workspaceA],
    );
    const meetingAId = meetingRes.rows[0]!.id;

    // Workspace B owner cannot read Workspace A meeting knowledge
    currentPrincipal = { userId: userOwnerB };
    const forbiddenGet = await getMeetingKnowledgeRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingAId}/knowledge`),
      { params: Promise.resolve({ meetingId: meetingAId }) },
    );
    expect(forbiddenGet.status).toBe(403);

    // Workspace B owner cannot reindex Workspace A meeting knowledge
    const forbiddenReindex = await postReindexKnowledgeRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingAId}/knowledge/reindex`, {
        method: 'POST',
        body: {},
      }),
      { params: Promise.resolve({ meetingId: meetingAId }) },
    );
    expect(forbiddenReindex.status).toBe(403);

    // Workspace B owner cannot query Workspace A Ask AI
    const forbiddenAsk = await postAskWorkspaceQuestionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceA}/ask`, {
        method: 'POST',
        body: { question: 'What is Foodera budget?' },
      }),
      { params: Promise.resolve({ workspaceId: workspaceA }) },
    );
    expect(forbiddenAsk.status).toBe(403);

    // When Workspace B owner queries their OWN Workspace B, zero chunks from Workspace A are ever returned
    const wsBAskRes = await postAskWorkspaceQuestionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceB}/ask`, {
        method: 'POST',
        body: { question: 'Byudjet va Foodera IELTS haqida nima bor?' },
      }),
      { params: Promise.resolve({ workspaceId: workspaceB }) },
    );
    expect(wsBAskRes.status).toBe(200);
    const wsBAskBody = await wsBAskRes.json();
    expect(wsBAskBody.citations).toEqual([]);
    expect(wsBAskBody.retrievedChunkIds).toEqual([]);

    // Passing Workspace A's companyId while querying Workspace B is rejected with 403
    const crossCompanyAsk = await postAskWorkspaceQuestionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/workspaces/${workspaceB}/ask`, {
        method: 'POST',
        body: { question: 'Foodera?', companyId: companyA1 },
      }),
      { params: Promise.resolve({ workspaceId: workspaceB }) },
    );
    expect(crossCompanyAsk.status).toBe(403);
  });

  it('immediately suppresses tombstoned/deleted meetings from Ask AI, search, and purges knowledge_chunks cleanly', async () => {
    currentPrincipal = { userId: userOwnerA };
    const disposableMeetingId = await createMeetingInWorkspace({
      userId: userOwnerA,
      workspaceId: workspaceA,
      meetingTypeId: meetingTypeA,
      companyId: companyA1,
      title: 'Confidential Q4 Acquisition Sync',
    });

    const { recordingId } = await runFullMeetingPipelineToKnowledge({
      meetingId: disposableMeetingId,
      workspaceId: workspaceA,
      sessionId: '77777777-0006-4777-8777-777777777006',
      customTranscriptionResult: {
        provider: 'fake',
        providerModel: 'fake-multilingual-v1',
        providerJobId: 'job-zirconia-1',
        detectedLanguages: ['en'],
        durationMs: 30_000,
        segments: [
          {
            providerSegmentKey: 'zirc-seg-0',
            speakerLabel: 'speaker_0',
            startMs: 1000,
            endMs: 14000,
            text: 'Project Zirconia acquisition valuation is fixed at 42 million dollars.',
            detectedLanguage: 'en',
            confidence: 0.98,
            words: [],
            providerMetadata: {},
          },
        ],
        providerMetadata: {},
      },
    });

    // Before deletion: Ask AI and search find "Zirconia" via indexed knowledge_chunks
    const beforeAsk = await phase7Service.askWorkspaceQuestion({ userId: userOwnerA }, workspaceA, {
      question: 'What is the Project Zirconia acquisition valuation?',
    });
    expect(beforeAsk.citations.some((c) => c.meetingId === disposableMeetingId)).toBe(true);

    const liveRepos = createLiveRepositories({
      service: phase4Service,
      phase5Service,
      phase6Service,
      phase7Service,
      principal: { userId: userOwnerA },
    });
    const beforeSearch = await liveRepos.search.search(workspaceA, 'Zirconia');
    expect(beforeSearch.some((h) => h.id === disposableMeetingId)).toBe(true);

    // Part A: Tombstone the meeting (deleted_at set, purge_pending) BEFORE chunks are purged:
    // Ask AI and search must immediately suppress the tombstoned meeting.
    await db.query(
      `update public.meetings
          set deleted_at = now(),
              purge_status = 'purge_pending'
        where id = $1`,
      [disposableMeetingId],
    );

    const tombstonedAsk = await phase7Service.askWorkspaceQuestion(
      { userId: userOwnerA },
      workspaceA,
      { question: 'What is the Project Zirconia acquisition valuation?' },
    );
    expect(tombstonedAsk.citations.some((c) => c.meetingId === disposableMeetingId)).toBe(false);

    const tombstonedSearch = await liveRepos.search.search(workspaceA, 'Zirconia');
    expect(tombstonedSearch.some((h) => h.id === disposableMeetingId)).toBe(false);

    // Restore meeting active state to test DELETE /api/v1/recordings/:id full purge
    await db.query(
      `update public.meetings
          set deleted_at = null,
              purge_status = 'active'
        where id = $1`,
      [disposableMeetingId],
    );

    // Part B: Delete the recording via DELETE /api/v1/recordings/:id
    const delRes = await deleteRecordingRoute(
      makeNextRequest(`http://localhost:3000/api/v1/recordings/${recordingId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ recordingId }) },
    );
    expect(delRes.status).toBe(200);

    // Verify knowledge_chunks for the deleted recording's meeting were purged and current_embedding_run_id was cleared
    const remainingChunks = await db.query<{ id: string }>(
      `select id from public.knowledge_chunks where meeting_id = $1`,
      [disposableMeetingId],
    );
    expect(remainingChunks.rows).toHaveLength(0);

    const meetingRow = await db.query<{
      current_embedding_run_id: string | null;
      status: string;
    }>(`select current_embedding_run_id, status from public.meetings where id = $1`, [
      disposableMeetingId,
    ]);
    expect(meetingRow.rows[0]!.current_embedding_run_id).toBeNull();
    expect(meetingRow.rows[0]!.status).toBe('draft');

    const recRow = await db.query<{ status: string; deleted_at: string | null }>(
      `select status, deleted_at from public.recordings where id = $1`,
      [recordingId],
    );
    expect(recRow.rows[0]!.status).toBe('deleted');
    expect(recRow.rows[0]!.deleted_at).not.toBeNull();

    // After recording deletion: Ask AI and search return zero references to Zirconia
    const afterAsk = await phase7Service.askWorkspaceQuestion({ userId: userOwnerA }, workspaceA, {
      question: 'What is the Project Zirconia acquisition valuation?',
    });
    expect(afterAsk.citations.some((c) => c.meetingId === disposableMeetingId)).toBe(false);

    const afterSearch = await liveRepos.search.search(workspaceA, 'Zirconia');
    expect(afterSearch.some((h) => h.id === disposableMeetingId)).toBe(false);
  });
});
