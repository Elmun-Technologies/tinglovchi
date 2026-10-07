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
import { Phase5TranscriptionService, Phase5TranscriptionWorker } from '@suhbat/database/phase5';
import { MemoryStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';
import { routes } from '@suhbat/product';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { createLiveRepositories } from '../../apps/web/src/lib/live-repositories';
import { loadMeetingBundle } from '../../apps/web/src/lib/meeting-bundle';
import { GET as getMeetingTranscriptionRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/transcription/route';
import { GET as getMeetingTranscriptRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/transcript/route';
import { POST as postMeetingSpeakersRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/speakers/route';
import { POST as postRetryTranscriptionRoute } from '../../apps/web/src/app/api/v1/meetings/[meetingId]/transcription/retry/route';

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
let fakeProvider: FakeTranscriptionProvider;
let phase4Service: Phase4BackboneService;
let phase5Service: Phase5TranscriptionService;
let worker: Phase5TranscriptionWorker;
let emittedEvents: StructuredObservabilityEvent[] = [];
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;

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

async function createMeetingInWorkspace(
  userId: string,
  workspaceId: string,
  meetingTypeId: string,
  title: string,
): Promise<string> {
  const res = await asUser(userId, async () =>
    db.query<{ id: string }>(
      `insert into public.meetings (workspace_id, meeting_type_id, title, created_by)
       values ($1, $2, $3, auth.uid())
       returning id`,
      [workspaceId, meetingTypeId, title],
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

async function uploadAndFinalizeVerifiedRecording(params: {
  meetingId: string;
  workspaceId: string;
  sessionId: string;
  withPauseGap?: boolean;
}): Promise<{
  recordingId: string;
  sourceId: string;
  chunkIds: string[];
}> {
  const { recording } = await phase4Service.createRecording(
    { userId: userOwnerA },
    {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      sessionId: params.sessionId,
      timeline: {
        clock: 'platform_monotonic_continuous',
        clockEpochId: 'epoch-phase5-1',
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

  const { source } = await phase4Service.registerSource({ userId: userOwnerA }, recording.id, {
    sourceKind: 'microphone',
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    expectedChunkCount: 2,
  });

  const bytes0 = new TextEncoder().encode(`phase5-chunk-0-${params.sessionId}`);
  const bytes1 = new TextEncoder().encode(`phase5-chunk-1-${params.sessionId}`);

  const chunk0Start = 0;
  const chunk0End = 20_000;
  const chunk1Start = params.withPauseGap ? 35_000 : 20_000;
  const chunk1End = params.withPauseGap ? 55_000 : 40_000;

  const { chunk: chunk0 } = await phase4Service.registerChunk(
    { userId: userOwnerA },
    recording.id,
    {
      recordingSourceId: source.id,
      sequenceNo: 0,
      meetingStartMs: chunk0Start,
      meetingEndMs: chunk0End,
      sampleStart: 0,
      sampleEnd: 960_000,
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
      meetingStartMs: chunk1Start,
      meetingEndMs: chunk1End,
      sampleStart: 960_000,
      sampleEnd: 1_920_000,
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
    const verified = await phase4Service.verifyChunkUpload(
      { userId: userOwnerA },
      recording.id,
      c.id,
      {},
    );
    expect(verified.verified).toBe(true);
  }

  const finalized = await phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
    canonicalDurationMs: chunk1End,
    activeCaptureMs: 40_000,
  });
  expect(finalized.status).toBe('finalized');

  return {
    recordingId: recording.id,
    sourceId: source.id,
    chunkIds: [chunk0.id, chunk1.id],
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(authBootstrap);
  await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
  await db.exec(readFileSync(phase5MigrationPath, 'utf8'));
  await db.exec(readFileSync(seedPath, 'utf8'));

  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values
       ($1, 'owner-a@suhbat.test', '{"full_name": "Aziza Karimova"}'::jsonb),
       ($2, 'member-a@suhbat.test', '{"full_name": "Timur Rakhimov"}'::jsonb),
       ($3, 'owner-b@suhbat.test', '{"full_name": "Owner B"}'::jsonb),
       ($4, 'outsider@suhbat.test', '{"full_name": "Outsider"}'::jsonb)`,
    [userOwnerA, userMemberA, userOwnerB, userOutsider],
  );

  workspaceA = await asUser(userOwnerA, async () => {
    const res = await db.query<{ workspace_id: string }>(
      `select public.create_workspace('Suhbat Workspace A', 'suhbat-ws-a') as workspace_id`,
    );
    return res.rows[0]!.workspace_id;
  });

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
     values ($1, $2, 'member', 'active')`,
    [workspaceA, userMemberA],
  );

  workspaceB = await asUser(userOwnerB, async () => {
    const res = await db.query<{ workspace_id: string }>(
      `select public.create_workspace('Suhbat Workspace B', 'suhbat-ws-b') as workspace_id`,
    );
    return res.rows[0]!.workspace_id;
  });

  const mtARes = await db.query<{ id: string }>(
    `select id from public.meeting_types where workspace_id = $1 order by sort_order asc limit 1`,
    [workspaceA],
  );
  meetingTypeA = mtARes.rows[0]!.id;
});

beforeEach(() => {
  storage = new MemoryStorageProvider({ backend: 'memory' });
  fakeProvider = new FakeTranscriptionProvider();
  emittedEvents = [];
  phase4Service = new Phase4BackboneService({
    db,
    storage,
    onEvent: (event) => emittedEvents.push(event),
  });
  phase5Service = new Phase5TranscriptionService({
    phase4: phase4Service,
    provider: fakeProvider,
  });
  worker = new Phase5TranscriptionWorker(phase5Service);
  currentPrincipal = { userId: userOwnerA };
  setPhase4Runtime({
    service: phase4Service,
    phase5Service,
    transcriptionProvider: fakeProvider,
    resolvePrincipal: async () => currentPrincipal,
  });
});

afterAll(async () => {
  setPhase4Runtime(null);
  await db.close();
});

describe('Phase 5 — Verification Gate, Full Pipeline Execution & Canonical Alignment', () => {
  it('refuses transcription asset preparation when recording is not finalized or chunks are unverified', async () => {
    const meetingId = await createMeetingInWorkspace(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Unverified Recording Gate Test',
    );
    const { recording } = await phase4Service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId,
        sessionId: '10000000-0000-4000-8000-000000000001',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'epoch-1',
          originTicks: '1000',
          originWallClockUtc: '2026-10-07T09:00:00.000Z',
          tickFrequencyHz: 1_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T09:00:00.000Z',
          policyVersion: 'v1',
        },
      },
    );

    await expect(
      phase5Service.prepareTranscriptionAssetForRecording(recording.id),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_state',
    });

    await expect(
      phase5Service.retryTranscription({ userId: userOwnerA }, meetingId),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'invalid_state',
    });
  });

  it('executes prepare_recording -> transcribe_meeting -> normalize_transcript -> finalize_transcript with pause-gap alignment, multilingual segments, and speaker diarization', async () => {
    const meetingId = await createMeetingInWorkspace(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Q4 Export & Logistics Alignment (Pause Gap)',
    );

    const { recordingId, chunkIds } = await uploadAndFinalizeVerifiedRecording({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '20000000-0000-4000-8000-000000000002',
      withPauseGap: true,
    });

    // Run all 4 stages sequentially and inspect intermediate states
    const job1 = await worker.runNextJob('worker-p5-1');
    expect(job1?.jobType).toBe('prepare_recording');
    expect(job1?.status).toBe('succeeded');

    const statusAfterPrepare = await phase5Service.getMeetingTranscriptionStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(statusAfterPrepare.meetingStatus).toBe('ready_for_transcription');
    expect(statusAfterPrepare.currentAsset).not.toBeNull();
    expect(statusAfterPrepare.currentAsset?.assetDurationMs).toBe(40_000);
    expect(statusAfterPrepare.currentAsset?.canonicalDurationMs).toBe(55_000);
    expect(statusAfterPrepare.currentAsset?.timelineMap).toHaveLength(2);
    expect(statusAfterPrepare.currentAsset?.timelineMap[1]?.discontinuityReason).toBe('pause_gap');
    expect(statusAfterPrepare.currentAsset?.timelineMap[1]?.gapBeforeMeetingMs).toBe(15_000);

    const job2 = await worker.runNextJob('worker-p5-1');
    expect(job2?.jobType).toBe('transcribe_meeting');
    expect(job2?.status).toBe('succeeded');

    const statusAfterTranscribe = await phase5Service.getMeetingTranscriptionStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(statusAfterTranscribe.meetingStatus).toBe('normalizing_transcript');
    expect(statusAfterTranscribe.runs).toHaveLength(1);
    expect(statusAfterTranscribe.runs[0]?.status).toBe('normalizing');

    const job3 = await worker.runNextJob('worker-p5-1');
    expect(job3?.jobType).toBe('normalize_transcript');
    expect(job3?.status).toBe('succeeded');

    const job4 = await worker.runNextJob('worker-p5-1');
    expect(job4?.jobType).toBe('finalize_transcript');
    expect(job4?.status).toBe('succeeded');

    // Verify meeting is now `transcript_ready` (and NOT `ready` because Phase 6 AI analysis has not run)
    const statusFinal = await phase5Service.getMeetingTranscriptionStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(statusFinal.meetingStatus).toBe('transcript_ready');
    expect(statusFinal.pipelineStatus).toBe('transcript_ready');
    expect(statusFinal.productState).toBe('transcript_ready');
    expect(statusFinal.productState).not.toBe('ready');
    expect(statusFinal.currentTranscriptionRunId).toBe(statusFinal.runs[0]?.id);
    expect(statusFinal.runs[0]?.status).toBe('completed');
    expect(statusFinal.speakers.map((s) => s.providerSpeakerLabel)).toEqual([
      'speaker_0',
      'speaker_1',
      'speaker_2',
    ]);

    // Verify completed `transcription_runs` row is immutable via PostgreSQL trigger
    await expect(
      db.query(`update public.transcription_runs set provider = 'tampered' where id = $1`, [
        statusFinal.currentTranscriptionRunId,
      ]),
    ).rejects.toThrowError(/Completed transcription_runs rows are immutable/);

    await expect(
      db.query(`delete from public.transcription_runs where id = $1`, [
        statusFinal.currentTranscriptionRunId,
      ]),
    ).rejects.toThrowError(/Completed transcription_runs rows are immutable/);

    // Verify canonical transcript segments via GET /api/v1/meetings/{meetingId}/transcript
    const getTranscriptRes = await getMeetingTranscriptRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/transcript`),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(getTranscriptRes.status).toBe(200);
    const transcriptBody = await getTranscriptRes.json();
    expect(transcriptBody.totalSegments).toBe(12);
    expect(transcriptBody.segments).toHaveLength(12);

    // First 6 segments are in chunk 0 [0..20_000], next 6 segments are in chunk 1 [35_000..55_000] after the 15s pause gap!
    const firstHalf = transcriptBody.segments.slice(0, 6);
    const secondHalf = transcriptBody.segments.slice(6, 12);
    for (const seg of firstHalf) {
      expect(seg.startMs).toBeGreaterThanOrEqual(0);
      expect(seg.endMs).toBeLessThanOrEqual(20_000);
      expect(seg.sourceRecordingChunkId).toBe(chunkIds[0]);
    }
    for (const seg of secondHalf) {
      // Asset time was [20_000..40_000], mapped to canonical meeting time [35_000..55_000]
      expect(seg.assetStartMs).toBeGreaterThanOrEqual(20_000);
      expect(seg.startMs).toBe(seg.assetStartMs + 15_000);
      expect(seg.endMs).toBe(seg.assetEndMs + 15_000);
      expect(seg.sourceRecordingChunkId).toBe(chunkIds[1]);
    }

    // Verify multilingual / code-switching segments are preserved verbatim without translation
    const langs = new Set(transcriptBody.segments.map((s: { language: string }) => s.language));
    expect(langs.has('uz')).toBe(true);
    expect(langs.has('ru')).toBe(true);
    expect(langs.has('en')).toBe(true);
    expect(langs.has('mixed')).toBe(true);
    expect(transcriptBody.segments[1].text).toContain('по договору 18 фоиз');

    // Verify original recording chunks were never altered
    const recDetail = await phase4Service.getRecording(
      { userId: userOwnerA },
      recordingId,
      workspaceA,
    );
    expect(recDetail.chunks).toHaveLength(2);
    expect(recDetail.chunks[0]?.verificationState).toBe('verified');
    expect(recDetail.chunks[1]?.verificationState).toBe('verified');
  });
});

describe('Phase 5 — Speaker Mapping & Live Product Repository Integration', () => {
  it('maps diarized speakers to meeting participants without mutating segment text and serves windowed/filtered transcript reads', async () => {
    const meetingId = await createMeetingInWorkspace(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Speaker Mapping & Windowing Verification',
    );

    await uploadAndFinalizeVerifiedRecording({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '30000000-0000-4000-8000-000000000003',
      withPauseGap: false,
    });

    await worker.runUntilIdle('worker-p5-map');

    const beforeTranscript = await phase5Service.getMeetingTranscript(
      { userId: userOwnerA },
      meetingId,
    );
    const originalTexts = beforeTranscript.segments.map((s) => s.text);
    expect(beforeTranscript.speakers.every((s) => s.participantId === null)).toBe(true);

    // Map `speaker_0` to workspace owner (userOwnerA) and `speaker_1` to workspace member (userMemberA) via API route
    const mapRes = await postMeetingSpeakersRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/speakers`, {
        method: 'POST',
        body: {
          workspaceId: workspaceA,
          mappings: [
            {
              speakerLabel: 'speaker_0',
              participantId: userOwnerA,
              displayName: 'Aziza Karimova',
              roleLabel: 'Product Lead',
            },
            {
              speakerLabel: 'speaker_1',
              participantId: userMemberA,
              displayName: 'Timur Rakhimov',
              roleLabel: 'Operations Director',
            },
          ],
        },
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(mapRes.status).toBe(200);
    const mapBody = await mapRes.json();
    expect(mapBody.participants).toHaveLength(2);

    const azizaParticipant = mapBody.participants.find(
      (p: { userId: string }) => p.userId === userOwnerA,
    );
    const timurParticipant = mapBody.participants.find(
      (p: { userId: string }) => p.userId === userMemberA,
    );
    expect(azizaParticipant).toBeDefined();
    expect(timurParticipant).toBeDefined();

    // Verify transcript text was NOT rewritten
    const afterTranscript = await phase5Service.getMeetingTranscript(
      { userId: userOwnerA },
      meetingId,
    );
    expect(afterTranscript.segments.map((s) => s.text)).toEqual(originalTexts);
    expect(
      afterTranscript.segments
        .filter((s) => s.providerSpeakerLabel === 'speaker_0')
        .every(
          (s) =>
            s.participantId === azizaParticipant.id && s.speakerDisplayLabel === 'Aziza Karimova',
        ),
    ).toBe(true);

    // Verify Live ProductRepositories (`transcripts.forMeeting`, `transcripts.window`, `transcripts.segmentsByIds`, `transcripts.confirmSpeakerMapping`)
    const liveRepos = createLiveRepositories({
      service: phase4Service,
      phase5Service,
      principal: { userId: userOwnerA },
    });

    const bundleResult = await loadMeetingBundle(liveRepos, workspaceA, meetingId);
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) return;

    expect(bundleResult.bundle.detail.state).toBe('transcript_ready');
    expect(bundleResult.bundle.detail.unmappedSpeakers).toEqual(['speaker_2']);
    expect(bundleResult.bundle.transcript.segments).toHaveLength(12);
    expect(bundleResult.bundle.transcript.participants).toHaveLength(2);

    // Windowing: page 1 (span: 5, offset: 0) and page 2 (span: 5, offset: 5)
    const win1 = await liveRepos.transcripts.window({
      meetingId,
      offset: 0,
      span: 5,
    });
    expect(win1.segments).toHaveLength(5);
    expect(win1.totalCount).toBe(12);
    expect(win1.filteredCount).toBe(12);
    expect(win1.hasPrevious).toBe(false);
    expect(win1.hasNext).toBe(true);

    const win2 = await liveRepos.transcripts.window({
      meetingId,
      offset: 5,
      span: 5,
    });
    expect(win2.segments).toHaveLength(5);
    expect(win2.hasPrevious).toBe(true);
    expect(win2.hasNext).toBe(true);
    expect(win2.segments[0]?.index).toBe(5);

    // Filter by mapped speaker personId
    const azizaWin = await liveRepos.transcripts.window({
      meetingId,
      speaker: azizaParticipant.id,
    });
    expect(azizaWin.filteredCount).toBe(4);
    expect(azizaWin.segments.every((s) => s.speakerPersonId === azizaParticipant.id)).toBe(true);

    // Filter by unmapped diarization label (`label:speaker_2`)
    const unmappedWin = await liveRepos.transcripts.window({
      meetingId,
      speaker: 'label:speaker_2',
    });
    expect(unmappedWin.filteredCount).toBe(4);
    expect(unmappedWin.segments.every((s) => s.speakerLabel === 'speaker_2')).toBe(true);

    // Search query across multilingual text
    const searchWin = await liveRepos.transcripts.window({
      meetingId,
      query: 'Самарканду',
    });
    expect(searchWin.filteredCount).toBe(1);
    expect(searchWin.segments[0]?.text).toContain('Самарканду');

    // Evidence-style segment ID resolution & canonical URL helper
    const targetSeg = bundleResult.bundle.transcript.segments[3]!;
    const resolvedSegs = await liveRepos.transcripts.segmentsByIds(meetingId, [targetSeg.id]);
    expect(resolvedSegs).toHaveLength(1);
    expect(resolvedSegs[0]?.id).toBe(targetSeg.id);

    const deepLinkHref = routes.evidence({
      workspaceId: workspaceA,
      meetingId,
      segmentId: targetSeg.id,
      startMs: targetSeg.startMs,
    });
    expect(deepLinkHref).toContain(`seg=${targetSeg.id}`);
    expect(deepLinkHref).toContain(`t=${targetSeg.startMs}`);
    expect(deepLinkHref).toContain(`#${targetSeg.id}`);

    // Map remaining `speaker_2` through `liveRepos.transcripts.confirmSpeakerMapping`
    const updatedMappings = await liveRepos.transcripts.confirmSpeakerMapping!({
      meetingId,
      label: 'speaker_2',
      personId: userMemberA,
    });
    expect(updatedMappings.every((m) => m.confirmed && m.personId !== null)).toBe(true);

    const refreshedDetail = await liveRepos.meetings.detail(meetingId);
    expect(refreshedDetail.unmappedSpeakers).toHaveLength(0);
  });
});

describe('Phase 5 — Invalid Timestamps, Failures, Safe Retry, Crash Recovery & Stale Fencing', () => {
  it('quarantines invalid/out-of-range provider timestamps and fails run when all segments are invalid without silent clamping', async () => {
    const meetingId = await createMeetingInWorkspace(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Invalid Provider Timestamps Test',
    );

    const { recordingId } = await uploadAndFinalizeVerifiedRecording({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '40000000-0000-4000-8000-000000000004',
    });

    // Inject a custom provider result where every segment has invalid timestamps (-500ms and 999_000ms)
    fakeProvider.setCustomResultForRecording(recordingId, {
      provider: 'fake',
      providerModel: 'fake-multilingual-diarized-v1',
      providerJobId: 'fake-invalid-ts-job',
      detectedLanguages: ['uz'],
      durationMs: 40_000,
      segments: [
        {
          providerSegmentKey: 'bad_neg',
          speakerLabel: 'speaker_0',
          startMs: -500,
          endMs: 2_000,
          text: 'Negative timestamp must not be clamped to 0.',
          confidence: 0.9,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'bad_overflow',
          speakerLabel: 'speaker_1',
          startMs: 38_000,
          endMs: 95_000,
          text: 'Out of range timestamp must not be clamped to 40_000.',
          confidence: 0.9,
          detectedLanguage: 'en',
          words: [],
          providerMetadata: {},
        },
      ],
      providerMetadata: {},
    });

    await worker.runUntilIdle('worker-p5-invalid');

    const status = await phase5Service.getMeetingTranscriptionStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(status.meetingStatus).toBe('transcription_failed');
    expect(status.productState).toBe('transcription_failed');
    expect(status.runs).toHaveLength(1);
    expect(status.runs[0]?.status).toBe('failed');
    expect(status.runs[0]?.errorCode).toBe('timestamp_alignment_failed');
    expect(status.runs[0]?.quarantinedSegmentCount).toBe(2);

    // Zero canonical segments persisted
    const transcript = await phase5Service.getMeetingTranscript({ userId: userOwnerA }, meetingId);
    expect(transcript.segments).toHaveLength(0);

    // Clear custom bad result and trigger safe retry via POST /api/v1/meetings/{meetingId}/transcription/retry
    fakeProvider.clearCustomResultForRecording(recordingId);

    const retryRes = await postRetryTranscriptionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingId}/transcription/retry`, {
        method: 'POST',
        body: { workspaceId: workspaceA, reason: 'Provider timestamp bug fixed' },
      }),
      { params: Promise.resolve({ meetingId }) },
    );
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.job.jobType).toBe('transcribe_meeting');
    expect(retryBody.job.generation).toBe(2);

    await worker.runUntilIdle('worker-p5-retry');

    const statusAfterRetry = await phase5Service.getMeetingTranscriptionStatus(
      { userId: userOwnerA },
      meetingId,
    );
    expect(statusAfterRetry.meetingStatus).toBe('transcript_ready');
    // Historical failed run #1 is preserved alongside completed run #2!
    expect(statusAfterRetry.runs).toHaveLength(2);
    const run1 = statusAfterRetry.runs.find((r) => r.runNumber === 1);
    const run2 = statusAfterRetry.runs.find((r) => r.runNumber === 2);
    expect(run1?.status).toBe('failed');
    expect(run2?.status).toBe('completed');
    expect(statusAfterRetry.currentTranscriptionRunId).toBe(run2?.id);

    const recoveredTranscript = await phase5Service.getMeetingTranscript(
      { userId: userOwnerA },
      meetingId,
    );
    expect(recoveredTranscript.segments).toHaveLength(12);
  });

  it('recovers cleanly from worker crash after provider response, blocks stale worker fencing tokens, and handles duplicate callbacks idempotently', async () => {
    const meetingId = await createMeetingInWorkspace(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Crash Recovery & Fencing Test',
    );

    await uploadAndFinalizeVerifiedRecording({
      meetingId,
      workspaceId: workspaceA,
      sessionId: '50000000-0000-4000-8000-000000000005',
    });

    const t0 = new Date(Date.now() + 1_000);
    // 1. Run prepare_recording
    const prepJob = await worker.runNextJob('worker-1', { now: t0, leaseSeconds: 30 });
    expect(prepJob?.jobType).toBe('prepare_recording');

    // 2. Worker 1 claims transcribe_meeting, receives provider response, and then crashes before completing!
    const claimedTranscribeW1 = await worker.claimNextJob('worker-1', {
      now: t0,
      leaseSeconds: 30,
    });
    expect(claimedTranscribeW1?.jobType).toBe('transcribe_meeting');
    expect(claimedTranscribeW1?.fencingToken).toBe(1);

    let persistedRunId = '';
    await expect(
      worker.executeClaimedTranscribeMeetingJob('worker-1', claimedTranscribeW1!, {
        now: t0,
        afterProviderResponseHook: async ({ transcriptionRunId }) => {
          persistedRunId = transcriptionRunId;
          throw new Error('Simulated worker-1 crash immediately after provider response');
        },
      }),
    ).rejects.toThrowError(/Simulated worker-1 crash/);
    expect(persistedRunId).not.toBe('');
    expect(fakeProvider.getCallLog()).toHaveLength(1);

    // 3. After lease expires at t0 + 35s, Worker 2 reclaims transcribe_meeting (fencingToken = 2)
    const tExpired = new Date(t0.getTime() + 35_000);
    const claimedTranscribeW2 = await worker.claimNextJob('worker-2', {
      now: tExpired,
      leaseSeconds: 60,
    });
    expect(claimedTranscribeW2?.id).toBe(claimedTranscribeW1?.id);
    expect(claimedTranscribeW2?.fencingToken).toBe(2);

    // 4. Stale Worker 1 tries to complete or fail the job with old fencingToken = 1 -> rejected!
    await expect(
      worker.executeClaimedTranscribeMeetingJob('worker-1', claimedTranscribeW1!, {
        now: tExpired,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'stale_fencing_token',
    });

    // 5. Worker 2 executes transcribe_meeting and recovers from the already-persisted provider response
    // without calling the external provider a second time!
    const completedTranscribeW2 = await worker.executeClaimedTranscribeMeetingJob(
      'worker-2',
      claimedTranscribeW2!,
      { now: tExpired },
    );
    expect(completedTranscribeW2.status).toBe('succeeded');
    expect(completedTranscribeW2.resultMetadata.recovered_after_provider_response).toBe(true);
    expect(fakeProvider.getCallLog()).toHaveLength(1);

    // 6. Deliver duplicate provider callback for the same run -> idempotent reuse
    const storedRunRes = await db.query<{ raw_provider_response: unknown }>(
      `select raw_provider_response from public.transcription_runs where id = $1`,
      [persistedRunId],
    );
    const dupCallback = await phase5Service.ingestProviderCallbackResult({
      transcriptionRunId: persistedRunId,
      result: storedRunRes.rows[0]!.raw_provider_response as never,
      now: tExpired,
    });
    expect(dupCallback.idempotentReused).toBe(true);

    // 7. Run normalize_transcript and finalize_transcript to completion
    await worker.runUntilIdle('worker-2', { now: tExpired });

    const transcript = await phase5Service.getMeetingTranscript({ userId: userOwnerA }, meetingId);
    expect(transcript.segments).toHaveLength(12);
    // Ensure no duplicate sequence numbers or segment keys exist
    const seqSet = new Set(transcript.segments.map((s) => s.sequenceNo));
    expect(seqSet.size).toBe(12);
  });
});

describe('Phase 5 — Cross-Workspace Isolation & Server-Mediated Write Security', () => {
  it('enforces RLS workspace isolation and blocks direct authenticated client writes on all Phase 5 tables', async () => {
    expect(workspaceB).not.toBe(workspaceA);
    const meetingA = await createMeetingInWorkspace(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Workspace A Confidential Transcript',
    );
    await uploadAndFinalizeVerifiedRecording({
      meetingId: meetingA,
      workspaceId: workspaceA,
      sessionId: '60000000-0000-4000-8000-000000000006',
    });
    await worker.runUntilIdle('worker-rls');

    // Workspace A member can read via API and via RLS SELECT
    currentPrincipal = { userId: userMemberA };
    const memberReadRes = await getMeetingTranscriptRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingA}/transcript`),
      { params: Promise.resolve({ meetingId: meetingA }) },
    );
    expect(memberReadRes.status).toBe(200);

    // Workspace B owner is denied on all Phase 5 API routes for Meeting A
    currentPrincipal = { userId: userOwnerB };
    const crossStatusRes = await getMeetingTranscriptionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingA}/transcription`),
      { params: Promise.resolve({ meetingId: meetingA }) },
    );
    expect(crossStatusRes.status).toBe(403);

    const crossTranscriptRes = await getMeetingTranscriptRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingA}/transcript`),
      { params: Promise.resolve({ meetingId: meetingA }) },
    );
    expect(crossTranscriptRes.status).toBe(403);

    const crossSpeakerRes = await postMeetingSpeakersRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingA}/speakers`, {
        method: 'POST',
        body: {
          mappings: [{ speakerLabel: 'speaker_0', displayName: 'Attacker' }],
        },
      }),
      { params: Promise.resolve({ meetingId: meetingA }) },
    );
    expect(crossSpeakerRes.status).toBe(403);

    const crossRetryRes = await postRetryTranscriptionRoute(
      makeNextRequest(`http://localhost:3000/api/v1/meetings/${meetingA}/transcription/retry`, {
        method: 'POST',
        body: {},
      }),
      { params: Promise.resolve({ meetingId: meetingA }) },
    );
    expect(crossRetryRes.status).toBe(403);

    // Workspace B owner sees 0 rows via direct PostgreSQL RLS SELECT on all 5 Phase 5 tables
    await asUser(userOwnerB, async () => {
      for (const table of [
        'transcription_assets',
        'transcription_runs',
        'meeting_participants',
        'meeting_speakers',
        'transcript_segments',
      ]) {
        const res = await db.query<{ cnt: string }>(
          `select count(*) as cnt from public.${table} where meeting_id = $1`,
          [meetingA],
        );
        expect(Number(res.rows[0]?.cnt)).toBe(0);
      }
    });

    // Even Workspace A owner cannot directly INSERT/UPDATE/DELETE Phase 5 tables from the `authenticated` role
    await asUser(userOwnerA, async () => {
      await expect(
        db.query(`update public.transcript_segments set text = 'forged' where meeting_id = $1`, [
          meetingA,
        ]),
      ).rejects.toThrowError(/permission denied/);

      await expect(
        db.query(
          `update public.meeting_speakers set display_label = 'forged' where meeting_id = $1`,
          [meetingA],
        ),
      ).rejects.toThrowError(/permission denied/);

      await expect(
        db.query(`delete from public.transcript_segments where meeting_id = $1`, [meetingA]),
      ).rejects.toThrowError(/permission denied/);
    });
  });
});
