import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Phase4BackboneService,
  Phase4RecordingWorker,
  type AuthenticatedPrincipal,
  type StructuredObservabilityEvent,
} from '@suhbat/database/phase4';
import { MemoryStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { createLiveRepositories } from '../../apps/web/src/lib/live-repositories';
import { loadMeetingBundle } from '../../apps/web/src/lib/meeting-bundle';
import { POST as postRecordingRoute } from '../../apps/web/src/app/api/v1/recordings/route';
import {
  GET as getRecordingRoute,
  DELETE as deleteRecordingRoute,
} from '../../apps/web/src/app/api/v1/recordings/[recordingId]/route';
import { POST as postSourceRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/sources/route';
import { POST as postChunkRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/chunks/route';
import { POST as postChunkUploadRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/chunks/[chunkId]/upload/route';
import { POST as postChunkVerifyRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/chunks/[chunkId]/verify/route';
import { POST as postFinalizeRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/finalize/route';
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
let service: Phase4BackboneService;
let worker: Phase4RecordingWorker;
let emittedEvents: StructuredObservabilityEvent[] = [];
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;
let meetingTypeB: string;

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

async function createWorkspaceAs(userId: string, name: string, slug: string): Promise<string> {
  return asUser(userId, async () => {
    const res = await db.query<{ workspace_id: string }>(
      'select public.create_workspace($1, $2) as workspace_id',
      [name, slug],
    );
    return res.rows[0]!.workspace_id;
  });
}

async function createMeetingDraft(
  userId: string,
  workspaceId: string,
  meetingTypeId: string,
  title: string,
): Promise<string> {
  return asUser(userId, async () => {
    const res = await db.query<{ id: string }>(
      `insert into public.meetings (workspace_id, meeting_type_id, title, created_by)
       values ($1, $2, $3, $4)
       returning id`,
      [workspaceId, meetingTypeId, title, userId],
    );
    return res.rows[0]!.id;
  });
}

function makeAudioBytes(seed: string, length = 256): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (seed.charCodeAt(i % seed.length) + i * 17) & 0xff;
  }
  return out;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(authBootstrap);
  await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
  await db.exec(readFileSync(seedPath, 'utf8'));

  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values ($1, 'owner-a@example.test', '{"full_name":"Owner A"}'::jsonb),
            ($2, 'member-a@example.test', '{"full_name":"Member A"}'::jsonb),
            ($3, 'owner-b@example.test', '{"full_name":"Owner B"}'::jsonb),
            ($4, 'outsider@example.test', '{"full_name":"Outsider"}'::jsonb)`,
    [userOwnerA, userMemberA, userOwnerB, userOutsider],
  );

  workspaceA = await createWorkspaceAs(userOwnerA, 'Workspace Alpha', 'workspace-alpha');
  workspaceB = await createWorkspaceAs(userOwnerB, 'Workspace Beta', 'workspace-beta');

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
     values ($1, $2, 'member', 'active')`,
    [workspaceA, userMemberA],
  );

  const typeResA = await db.query<{ id: string }>(
    `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
    [workspaceA],
  );
  meetingTypeA = typeResA.rows[0]!.id;

  const typeResB = await db.query<{ id: string }>(
    `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
    [workspaceB],
  );
  meetingTypeB = typeResB.rows[0]!.id;
}, 30_000);

beforeEach(() => {
  emittedEvents = [];
  storage = new MemoryStorageProvider({ backend: 'local' });
  service = new Phase4BackboneService({
    db,
    storage,
    onEvent: (event) => emittedEvents.push(event),
  });
  worker = new Phase4RecordingWorker(service);
  currentPrincipal = { userId: userOwnerA };
  setPhase4Runtime({
    service,
    resolvePrincipal: async () => currentPrincipal,
  });
});

afterAll(async () => {
  setPhase4Runtime(null);
  await db?.close();
});

describe('Phase 4 — Authorization & Cross-Workspace Isolation', () => {
  it('allows an active workspace member to register a recording in their own workspace', async () => {
    const meetingId = await createMeetingDraft(
      userMemberA,
      workspaceA,
      meetingTypeA,
      'Member A Meeting',
    );
    const result = await service.createRecording(
      { userId: userMemberA },
      {
        workspaceId: workspaceA,
        meetingId,
        sessionId: '11111111-1111-4111-8111-111111111111',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-epoch-1',
          originTicks: '1000000',
          originWallClockUtc: '2026-10-07T09:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T08:59:55.000Z',
          policyVersion: 'v1',
        },
      },
    );

    expect(result.idempotentReused).toBe(false);
    expect(result.recording.workspaceId).toBe(workspaceA);
    expect(result.recording.meetingId).toBe(meetingId);
    expect(result.recording.createdBy).toBe(userMemberA);
  });

  it('rejects unauthenticated requests and outsider users with no active workspace membership', async () => {
    const meetingId = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Protected Meeting',
    );

    await expect(
      service.createRecording(null, {
        workspaceId: workspaceA,
        meetingId,
        sessionId: '11111111-1111-4111-8111-111111111112',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-1',
          originTicks: '500',
          originWallClockUtc: '2026-10-07T09:00:00.000Z',
          tickFrequencyHz: 1_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'unauthenticated' });

    await expect(
      service.createRecording(
        { userId: userOutsider },
        {
          workspaceId: workspaceA,
          meetingId,
          sessionId: '11111111-1111-4111-8111-111111111113',
          timeline: {
            clock: 'platform_monotonic_continuous',
            clockEpochId: 'boot-1',
            originTicks: '500',
            originWallClockUtc: '2026-10-07T09:00:00.000Z',
            tickFrequencyHz: 1_000_000,
          },
          consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'unauthorized' });
  });

  it('rejects forged workspace IDs and cross-workspace meeting/recording/source/chunk references', async () => {
    const meetingA = await createMeetingDraft(userOwnerA, workspaceA, meetingTypeA, 'Alpha Mtg');
    const meetingB = await createMeetingDraft(userOwnerB, workspaceB, meetingTypeB, 'Beta Mtg');

    // User A tries to register recording on Meeting B while passing forged workspaceA
    await expect(
      service.createRecording(
        { userId: userOwnerA },
        {
          workspaceId: workspaceA,
          meetingId: meetingB,
          sessionId: '11111111-1111-4111-8111-111111111114',
          timeline: {
            clock: 'platform_monotonic_continuous',
            clockEpochId: 'boot-1',
            originTicks: '500',
            originWallClockUtc: '2026-10-07T09:00:00.000Z',
            tickFrequencyHz: 1_000_000,
          },
          consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'cross_workspace_access_denied' });

    // User B tries to register recording on Meeting B while passing forged workspaceA
    await expect(
      service.createRecording(
        { userId: userOwnerB },
        {
          workspaceId: workspaceA,
          meetingId: meetingB,
          sessionId: '11111111-1111-4111-8111-111111111115',
          timeline: {
            clock: 'platform_monotonic_continuous',
            clockEpochId: 'boot-1',
            originTicks: '500',
            originWallClockUtc: '2026-10-07T09:00:00.000Z',
            tickFrequencyHz: 1_000_000,
          },
          consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'unauthorized' });

    // Create legitimate recordings in Workspace A and Workspace B
    const { recording: recA } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId: meetingA,
        sessionId: '11111111-1111-4111-8111-111111111116',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-a',
          originTicks: '100',
          originWallClockUtc: '2026-10-07T09:00:00.000Z',
          tickFrequencyHz: 1_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
      },
    );
    const { source: srcA } = await service.registerSource({ userId: userOwnerA }, recA.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    const { recording: recB } = await service.createRecording(
      { userId: userOwnerB },
      {
        workspaceId: workspaceB,
        meetingId: meetingB,
        sessionId: '22222222-2222-4222-8222-222222222221',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-b',
          originTicks: '200',
          originWallClockUtc: '2026-10-07T09:00:00.000Z',
          tickFrequencyHz: 1_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
      },
    );
    const { source: srcB } = await service.registerSource({ userId: userOwnerB }, recB.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    // User B tries to register a source on Recording A
    await expect(
      service.registerSource({ userId: userOwnerB }, recA.id, {
        sourceKind: 'system_audio',
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 2,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'unauthorized' });

    // User A tries to register a chunk on Recording A referencing Source B (cross-workspace source ID)
    const audio = makeAudioBytes('cross-ws');
    await expect(
      service.registerChunk({ userId: userOwnerA }, recA.id, {
        recordingSourceId: srcB.id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 30_000,
        sampleStart: 0,
        sampleEnd: 1_440_000,
        byteSize: audio.byteLength,
        checksum: { algorithm: 'sha256', value: computeSha256Hex(audio) },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'cross_workspace_access_denied' });

    // Register chunk on Recording A, then User A tries to authorize/verify it through Recording B
    const { chunk: chunkA } = await service.registerChunk({ userId: userOwnerA }, recA.id, {
      recordingSourceId: srcA.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: audio.byteLength,
      checksum: { algorithm: 'sha256', value: computeSha256Hex(audio) },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    await expect(
      service.authorizeChunkUpload({ userId: userOwnerB }, recB.id, chunkA.id, {}),
    ).rejects.toMatchObject({ statusCode: 403, code: 'cross_workspace_access_denied' });

    await expect(
      service.verifyChunkUpload({ userId: userOwnerB }, recB.id, chunkA.id, {}),
    ).rejects.toMatchObject({ statusCode: 403, code: 'cross_workspace_access_denied' });

    // Enforces RLS at the PostgreSQL boundary as well
    await asUser(userOwnerB, async () => {
      const rows = await db.query('select id from public.recordings where id = $1', [recA.id]);
      expect(rows.rows).toHaveLength(0);
      const chunks = await db.query('select id from public.recording_chunks where id = $1', [
        chunkA.id,
      ]);
      expect(chunks.rows).toHaveLength(0);
    });

    // Client SQL cannot insert a pre-verified chunk directly
    await asUser(userOwnerA, async () => {
      await expect(
        db.query(
          `insert into public.recording_chunks (
            workspace_id, meeting_id, recording_id, recording_source_id,
            client_chunk_id, idempotency_key, sequence_no, meeting_start_ms, meeting_end_ms,
            duration_ms, sample_start, sample_end, byte_size, checksum_sha256,
            storage_backend, storage_key, upload_state, verification_state,
            verified_byte_size, verified_sha256, verified_at,
            codec, container, sample_rate_hz, channels
          ) values (
            $1, $2, $3, $4,
            '33333333-3333-4333-8333-333333333333', 'forged-key', 99, 30000, 60000,
            30000, 1440000, 2880000, 128, $5,
            'local', $6, 'verified', 'verified',
            128, $5, now(),
            'pcm_s16le', 'wav', 48000, 1
          )`,
          [
            workspaceA,
            meetingA,
            recA.id,
            srcA.id,
            computeSha256Hex(audio),
            `workspace/${workspaceA}/meetings/${meetingA}/recordings/${recA.id}/sources/${srcA.id}/chunks/000099.wav`,
          ],
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);
    });
  });

  it('blocks direct authenticated client INSERT/UPDATE/DELETE on all Phase 4 backbone tables while preserving workspace SELECT isolation', async () => {
    const meetingA = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Phase 4.1 Hardening Meeting',
    );
    const { recording: recA } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId: meetingA,
        sessionId: '12121212-1212-4212-8212-121212121212',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-41',
          originTicks: '100',
          originWallClockUtc: '2026-10-07T09:00:00.000Z',
          tickFrequencyHz: 1_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
      },
    );
    const { source: srcA } = await service.registerSource({ userId: userOwnerA }, recA.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    const audio = makeAudioBytes('hardening-chunk');
    const sha = computeSha256Hex(audio);
    const { chunk: chunkA } = await service.registerChunk({ userId: userOwnerA }, recA.id, {
      recordingSourceId: srcA.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: audio.byteLength,
      checksum: { algorithm: 'sha256', value: sha },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    await asUser(userOwnerA, async () => {
      // 1. Direct INSERT on recordings is denied even for workspace owner
      await expect(
        db.query(
          `insert into public.recordings (
            workspace_id, meeting_id, session_id, status, clock_epoch_id,
            origin_ticks, origin_wall_clock_utc, tick_frequency_hz,
            consent_acknowledged_at, consent_policy_version, created_by
          ) values ($1, $2, '13131313-1313-4313-8313-131313131313', 'registered', 'e1', 100, now(), 1000, now(), 'v1', $3)`,
          [workspaceA, meetingA, userOwnerA],
        ),
      ).rejects.toThrow(/permission denied/i);

      // 2. Direct UPDATE / DELETE on recordings is denied
      await expect(
        db.query(`update public.recordings set status = 'finalized' where id = $1`, [recA.id]),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(`delete from public.recordings where id = $1`, [recA.id]),
      ).rejects.toThrow(/permission denied/i);

      // 3. Direct INSERT / UPDATE / DELETE on recording_sources is denied
      await expect(
        db.query(
          `insert into public.recording_sources (
            workspace_id, meeting_id, recording_id, source_kind, source_role, codec, container, sample_rate_hz, channels
          ) values ($1, $2, $3, 'system_audio', 'original', 'pcm_s16le', 'wav', 48000, 2)`,
          [workspaceA, meetingA, recA.id],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(`update public.recording_sources set expected_chunk_count = 1 where id = $1`, [
          srcA.id,
        ]),
      ).rejects.toThrow(/permission denied/i);

      // 4. Direct INSERT (even pending!) / UPDATE / DELETE on recording_chunks is denied
      await expect(
        db.query(
          `insert into public.recording_chunks (
            workspace_id, meeting_id, recording_id, recording_source_id,
            client_chunk_id, idempotency_key, sequence_no, meeting_start_ms, meeting_end_ms,
            duration_ms, sample_start, sample_end, byte_size, checksum_sha256,
            storage_backend, storage_key, upload_state, verification_state,
            codec, container, sample_rate_hz, channels
          ) values (
            $1, $2, $3, $4,
            '34343434-3434-4434-8434-343434343434', 'direct-pending', 1, 30000, 60000,
            30000, 1440000, 2880000, 256, $5,
            'local', $6, 'pending', 'pending',
            'pcm_s16le', 'wav', 48000, 1
          )`,
          [
            workspaceA,
            meetingA,
            recA.id,
            srcA.id,
            sha,
            `workspace/${workspaceA}/meetings/${meetingA}/recordings/${recA.id}/sources/${srcA.id}/chunks/000001.wav`,
          ],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(
          `update public.recording_chunks set verification_state = 'verified' where id = $1`,
          [chunkA.id],
        ),
      ).rejects.toThrow(/permission denied/i);

      // 5. Direct INSERT / UPDATE on processing_jobs, processing_events, object_deletion_ledger is denied
      await expect(
        db.query(
          `insert into public.processing_jobs (
            workspace_id, meeting_id, recording_id, job_type, idempotency_key
          ) values ($1, $2, $3, 'prepare_recording', 'forged-job')`,
          [workspaceA, meetingA, recA.id],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(
          `insert into public.processing_events (
            workspace_id, meeting_id, recording_id, event_type
          ) values ($1, $2, $3, 'recording_finalized')`,
          [workspaceA, meetingA, recA.id],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(
          `insert into public.object_deletion_ledger (
            workspace_id, meeting_id, recording_id, storage_backend, storage_key, expected_byte_size, expected_sha256
          ) values ($1, $2, $3, 'local', 'workspace/forged/key/000000.wav', 128, $4)`,
          [workspaceA, meetingA, recA.id, sha],
        ),
      ).rejects.toThrow(/permission denied/i);

      // 6. Direct invocation of worker claiming RPC is denied to authenticated role
      await expect(
        db.query(`select * from public.claim_next_processing_job('client-spoof', 60, now())`),
      ).rejects.toThrow(/permission denied/i);

      // 7. Workspace-isolated SELECT still succeeds for active workspace members
      const ownRecs = await db.query('select id from public.recordings where id = $1', [recA.id]);
      expect(ownRecs.rows).toHaveLength(1);
      const ownSources = await db.query('select id from public.recording_sources where id = $1', [
        srcA.id,
      ]);
      expect(ownSources.rows).toHaveLength(1);
      const ownChunks = await db.query('select id from public.recording_chunks where id = $1', [
        chunkA.id,
      ]);
      expect(ownChunks.rows).toHaveLength(1);
    });

    // Cross-workspace user still sees 0 rows via SELECT
    await asUser(userOwnerB, async () => {
      const otherRecs = await db.query('select id from public.recordings where id = $1', [recA.id]);
      expect(otherRecs.rows).toHaveLength(0);
    });
  });
});

describe('Phase 4 — Chunk Uniqueness & Idempotency', () => {
  it('returns the same canonical chunk on identical retry and rejects conflicting checksum, size, timing, or sample range', async () => {
    const meetingId = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Idempotency Meeting',
    );
    const { recording } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId,
        sessionId: '44444444-4444-4444-8444-444444444444',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-idem',
          originTicks: '1000',
          originWallClockUtc: '2026-10-07T10:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T09:59:50.000Z', policyVersion: 'v1' },
      },
    );
    const { source } = await service.registerSource({ userId: userOwnerA }, recording.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    const bytes0 = makeAudioBytes('chunk-0-bytes', 512);
    const sha0 = computeSha256Hex(bytes0);
    const first = await service.registerChunk({ userId: userOwnerA }, recording.id, {
      recordingSourceId: source.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: bytes0.byteLength,
      checksum: { algorithm: 'sha256', value: sha0 },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    expect(first.idempotentReused).toBe(false);

    // Identical retry returns the exact same canonical chunk
    const retry = await service.registerChunk({ userId: userOwnerA }, recording.id, {
      chunkId: first.chunk.id,
      clientChunkId: first.chunk.clientChunkId,
      recordingSourceId: source.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: bytes0.byteLength,
      checksum: { algorithm: 'sha256', value: sha0 },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    expect(retry.idempotentReused).toBe(true);
    expect(retry.chunk.id).toBe(first.chunk.id);
    expect(retry.chunk.storageKey).toBe(first.chunk.storageKey);

    // Conflicting checksum rejected
    const differentSha = computeSha256Hex(makeAudioBytes('different-content', 512));
    await expect(
      service.registerChunk({ userId: userOwnerA }, recording.id, {
        recordingSourceId: source.id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 30_000,
        sampleStart: 0,
        sampleEnd: 1_440_000,
        byteSize: bytes0.byteLength,
        checksum: { algorithm: 'sha256', value: differentSha },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_conflict' });

    // Conflicting byte size rejected
    await expect(
      service.registerChunk({ userId: userOwnerA }, recording.id, {
        recordingSourceId: source.id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 30_000,
        sampleStart: 0,
        sampleEnd: 1_440_000,
        byteSize: bytes0.byteLength + 64,
        checksum: { algorithm: 'sha256', value: sha0 },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_conflict' });

    // Conflicting canonical timing rejected
    await expect(
      service.registerChunk({ userId: userOwnerA }, recording.id, {
        recordingSourceId: source.id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 25_000,
        sampleStart: 0,
        sampleEnd: 1_440_000,
        byteSize: bytes0.byteLength,
        checksum: { algorithm: 'sha256', value: sha0 },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_conflict' });

    // Conflicting sample range rejected
    await expect(
      service.registerChunk({ userId: userOwnerA }, recording.id, {
        recordingSourceId: source.id,
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 30_000,
        sampleStart: 0,
        sampleEnd: 960_000,
        byteSize: bytes0.byteLength,
        checksum: { algorithm: 'sha256', value: sha0 },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_conflict' });

    // Overlapping sequence 1 timing/sample range with sequence 0 rejected
    await expect(
      service.registerChunk({ userId: userOwnerA }, recording.id, {
        recordingSourceId: source.id,
        sequenceNo: 1,
        meetingStartMs: 15_000,
        meetingEndMs: 45_000,
        sampleStart: 720_000,
        sampleEnd: 2_160_000,
        byteSize: bytes0.byteLength,
        checksum: { algorithm: 'sha256', value: differentSha },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'chunk_conflict' });
  });
});

describe('Phase 4 — Upload Verification & Finalization Barriers', () => {
  it('treats uploaded-but-unverified chunks as non-durable and rejects missing object, wrong byte size, and wrong checksum before accepting valid bytes', async () => {
    const meetingId = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Verification Meeting',
    );
    const { recording } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId,
        sessionId: '55555555-5555-4555-8555-555555555555',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-ver',
          originTicks: '2000',
          originWallClockUtc: '2026-10-07T10:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T09:59:50.000Z', policyVersion: 'v1' },
      },
    );
    const { source } = await service.registerSource({ userId: userOwnerA }, recording.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
      expectedChunkCount: 2,
    });

    const bytes0 = makeAudioBytes('chunk-0-valid', 300);
    const sha0 = computeSha256Hex(bytes0);
    const { chunk: chunk0 } = await service.registerChunk({ userId: userOwnerA }, recording.id, {
      recordingSourceId: source.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: bytes0.byteLength,
      checksum: { algorithm: 'sha256', value: sha0 },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    const auth0 = await service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk0.id,
      {},
    );
    expect(auth0.storageKey).not.toContain('Verification Meeting');

    // 1. Missing object in storage -> verification rejected
    const missingCheck = await service.verifyChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk0.id,
      {},
    );
    expect(missingCheck.verified).toBe(false);
    expect(missingCheck.verification.failureReason).toBe('object_missing');
    expect(missingCheck.chunk.verificationState).toBe('pending');
    expect(missingCheck.chunk.uploadState).toBe('failed_retryable');

    // 2. Wrong byte size in storage -> verification rejected
    storage.storeObjectBytes(chunk0.storageKey, makeAudioBytes('short', 120));
    const wrongSizeCheck = await service.verifyChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk0.id,
      {},
    );
    expect(wrongSizeCheck.verified).toBe(false);
    expect(wrongSizeCheck.verification.failureReason).toBe('size_mismatch');
    expect(wrongSizeCheck.chunk.verificationState).toBe('rejected');

    // 3. Wrong checksum (same byte size, tampered bytes) -> verification rejected
    storage.storeObjectBytes(chunk0.storageKey, makeAudioBytes('tampered-bytes', 300));
    const wrongChecksumCheck = await service.verifyChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk0.id,
      {},
    );
    expect(wrongChecksumCheck.verified).toBe(false);
    expect(wrongChecksumCheck.verification.failureReason).toBe('checksum_mismatch');
    expect(wrongChecksumCheck.chunk.verificationState).toBe('rejected');

    // 4. Correct object uploaded via signed URL -> becomes verified
    await storage.putObjectViaSignedUrl(auth0.uploadUrl, bytes0);
    const validCheck = await service.verifyChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk0.id,
      {},
    );
    expect(validCheck.verified).toBe(true);
    expect(validCheck.chunk.verificationState).toBe('verified');
    expect(validCheck.chunk.uploadState).toBe('verified');
    expect(validCheck.chunk.verifiedByteSize).toBe(bytes0.byteLength);
    expect(validCheck.chunk.verifiedSha256).toBe(sha0);

    // 5. Missing chunk 1 prevents finalization and creates NO processing job
    const incompleteMissing = await service.finalizeRecording(
      { userId: userOwnerA },
      recording.id,
      {
        expectedSources: [{ recordingSourceId: source.id, expectedChunkCount: 2 }],
      },
    );
    expect(incompleteMissing.status).toBe('incomplete');
    if (incompleteMissing.status === 'incomplete') {
      expect(incompleteMissing.missingChunks).toEqual([
        { recordingSourceId: source.id, sequenceNo: 1 },
      ]);
    }

    // 6. Register chunk 1 and upload bytes to storage, but do NOT verify -> unverified chunk prevents finalize
    const bytes1 = makeAudioBytes('chunk-1-valid', 300);
    const sha1 = computeSha256Hex(bytes1);
    const { chunk: chunk1 } = await service.registerChunk({ userId: userOwnerA }, recording.id, {
      recordingSourceId: source.id,
      sequenceNo: 1,
      meetingStartMs: 30_000,
      meetingEndMs: 60_000,
      sampleStart: 1_440_000,
      sampleEnd: 2_880_000,
      byteSize: bytes1.byteLength,
      checksum: { algorithm: 'sha256', value: sha1 },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    const auth1 = await service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk1.id,
      {},
    );
    await storage.putObjectViaSignedUrl(auth1.uploadUrl, bytes1);

    const incompleteUnverified = await service.finalizeRecording(
      { userId: userOwnerA },
      recording.id,
      {
        expectedSources: [{ recordingSourceId: source.id, expectedChunkCount: 2 }],
      },
    );
    expect(incompleteUnverified.status).toBe('incomplete');
    if (incompleteUnverified.status === 'incomplete') {
      expect(incompleteUnverified.unverifiedChunks).toHaveLength(1);
      expect(incompleteUnverified.unverifiedChunks[0]?.chunkId).toBe(chunk1.id);
    }

    const jobsBeforeVerify = await db.query(
      'select id from public.processing_jobs where recording_id = $1',
      [recording.id],
    );
    expect(jobsBeforeVerify.rows).toHaveLength(0);

    // 7. Verify chunk 1 -> finalize succeeds and creates exactly one canonical job
    await service.verifyChunkUpload({ userId: userOwnerA }, recording.id, chunk1.id, {});
    const finalized = await service.finalizeRecording({ userId: userOwnerA }, recording.id, {
      canonicalDurationMs: 60_000,
      activeCaptureMs: 60_000,
      expectedSources: [{ recordingSourceId: source.id, expectedChunkCount: 2 }],
    });
    expect(finalized.status).toBe('finalized');
    if (finalized.status !== 'finalized') throw new Error('expected finalized');
    expect(finalized.idempotentReused).toBe(false);
    expect(finalized.job.jobType).toBe('prepare_recording');
    expect(finalized.job.status).toBe('queued');

    // 8. Repeated finalize is idempotent and does NOT create a duplicate processing job
    const finalizedRetry = await service.finalizeRecording({ userId: userOwnerA }, recording.id, {
      canonicalDurationMs: 60_000,
      activeCaptureMs: 60_000,
    });
    expect(finalizedRetry.status).toBe('finalized');
    if (finalizedRetry.status !== 'finalized') throw new Error('expected finalized');
    expect(finalizedRetry.idempotentReused).toBe(true);
    expect(finalizedRetry.job.id).toBe(finalized.job.id);

    const allJobs = await db.query(
      'select id from public.processing_jobs where recording_id = $1',
      [recording.id],
    );
    expect(allJobs.rows).toHaveLength(1);
  });
});

describe('Phase 4 — Worker Claiming, Leases, Fencing Tokens, Retries & Dead-Lettering', () => {
  async function createFinalizedRecordingWithJob(maxAttempts = 3): Promise<{
    meetingId: string;
    recordingId: string;
    jobId: string;
  }> {
    // Clear any leftover active jobs from previous tests so worker claims target this recording
    await db.query(
      `update public.processing_jobs set status = 'cancelled' where status in ('queued', 'running', 'retryable_failed')`,
    );

    const meetingId = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Worker Meeting',
    );
    const { recording } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId,
        sessionId: crypto.randomUUID(),
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-worker',
          originTicks: '5000',
          originWallClockUtc: '2026-10-07T11:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T10:59:50.000Z', policyVersion: 'v1' },
      },
    );
    const { source } = await service.registerSource({ userId: userOwnerA }, recording.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
      expectedChunkCount: 1,
    });
    const bytes = makeAudioBytes('worker-chunk', 256);
    const sha = computeSha256Hex(bytes);
    const { chunk } = await service.registerChunk({ userId: userOwnerA }, recording.id, {
      recordingSourceId: source.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: bytes.byteLength,
      checksum: { algorithm: 'sha256', value: sha },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    const auth = await service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk.id,
      {},
    );
    await storage.putObjectViaSignedUrl(auth.uploadUrl, bytes);
    await service.verifyChunkUpload({ userId: userOwnerA }, recording.id, chunk.id, {});
    const fin = await service.finalizeRecording({ userId: userOwnerA }, recording.id, {});
    if (fin.status !== 'finalized') throw new Error('expected finalized');

    await db.query(`update public.processing_jobs set max_attempts = $2 where id = $1`, [
      fin.job.id,
      maxAttempts,
    ]);

    return { meetingId, recordingId: recording.id, jobId: fin.job.id };
  }

  it('prevents two workers from claiming the same running job, reclaims expired leases, and rejects stale fencing tokens', async () => {
    const { jobId } = await createFinalizedRecordingWithJob(3);
    const t0 = new Date(Date.now() + 60_000);

    // Worker 1 claims the job
    const claim1 = await worker.claimNextJob('worker-1', { leaseSeconds: 60, now: t0 });
    expect(claim1).not.toBeNull();
    expect(claim1?.id).toBe(jobId);
    expect(claim1?.leaseOwner).toBe('worker-1');
    expect(claim1?.fencingToken).toBe(1);
    expect(claim1?.attempt).toBe(1);

    // Worker 2 attempts to claim while Worker 1's lease is active -> returns null
    const competingClaim = await worker.claimNextJob('worker-2', {
      leaseSeconds: 60,
      now: new Date(t0.getTime() + 10_000),
    });
    expect(competingClaim).toBeNull();

    // Lease expires at t0 + 61s -> Worker 2 reclaims the job and increments fencing token to 2
    const tExpired = new Date(t0.getTime() + 61_000);
    const claim2 = await worker.claimNextJob('worker-2', {
      leaseSeconds: 60,
      now: tExpired,
    });
    expect(claim2).not.toBeNull();
    expect(claim2?.id).toBe(jobId);
    expect(claim2?.leaseOwner).toBe('worker-2');
    expect(claim2?.fencingToken).toBe(2);
    expect(claim2?.attempt).toBe(2);

    // Stale Worker 1 (fencingToken = 1) tries to heartbeat, fail, or commit -> rejected!
    await expect(
      worker.heartbeatJob('worker-1', jobId, 1, { now: new Date(tExpired.getTime() + 1_000) }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'stale_fencing_token' });

    await expect(
      worker.completeJob(
        'worker-1',
        jobId,
        1,
        { stale: true },
        { now: new Date(tExpired.getTime() + 1_000) },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'stale_fencing_token' });

    await expect(
      worker.failJob('worker-1', jobId, 1, {
        code: 'stale_error',
        message: 'Stale worker failure',
        retryable: true,
        now: new Date(tExpired.getTime() + 1_000),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'stale_fencing_token' });

    // Current owner Worker 2 (fencingToken = 2) succeeds
    const completed = await worker.executeClaimedPrepareRecordingJob('worker-2', claim2!, {
      now: new Date(tExpired.getTime() + 2_000),
    });
    expect(completed.status).toBe('succeeded');
    expect(completed.fencingToken).toBe(2);
  });

  it('increments attempt on retryable failures and moves job to dead_lettered when retry budget is exhausted', async () => {
    const { meetingId, jobId } = await createFinalizedRecordingWithJob(2);
    const t0 = new Date(Date.now() + 60_000);

    // Attempt 1 fails with retryable error
    const claim1 = await worker.claimNextJob('worker-a', { leaseSeconds: 60, now: t0 });
    expect(claim1?.attempt).toBe(1);
    const retryFailed = await worker.failJob('worker-a', jobId, claim1!.fencingToken, {
      code: 'storage_transient',
      message: 'Temporary storage timeout',
      retryable: true,
      backoffSeconds: 10,
      now: t0,
    });
    expect(retryFailed.status).toBe('retryable_failed');
    expect(retryFailed.attempt).toBe(1);

    // Before backoff expires (t0 + 5s), job is not claimed
    const tooEarly = await worker.claimNextJob('worker-b', {
      leaseSeconds: 60,
      now: new Date(t0.getTime() + 5_000),
    });
    expect(tooEarly).toBeNull();

    // After backoff (t0 + 11s), Worker B claims attempt 2
    const tRetry = new Date(t0.getTime() + 11_000);
    const claim2 = await worker.claimNextJob('worker-b', { leaseSeconds: 60, now: tRetry });
    expect(claim2?.id).toBe(jobId);
    expect(claim2?.attempt).toBe(2);
    expect(claim2?.fencingToken).toBe(2);

    // Attempt 2 fails (reaching max_attempts = 2) -> dead_lettered
    const deadLettered = await worker.failJob('worker-b', jobId, claim2!.fencingToken, {
      code: 'storage_transient',
      message: 'Storage still unavailable',
      retryable: true,
      now: tRetry,
    });
    expect(deadLettered.status).toBe('dead_lettered');
    expect(deadLettered.completedAt).not.toBeNull();

    // Meeting processing state reflects the terminal failure
    const processing = await service.getMeetingProcessing({ userId: userOwnerA }, meetingId);
    expect(processing.productState).toBe('failed');
    expect(processing.timeline.state).toBe('failed');
    expect(processing.timeline.error?.code).toBe('storage_transient');
  });
});

describe('Phase 4 — Safe Deletion & Object Storage Reconciliation', () => {
  it('deletes verified objects and relational records cleanly, and records reconciliation_required if storage deletion fails', async () => {
    const meetingId = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Deletion Meeting',
    );
    const { recording } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId,
        sessionId: '66666666-6666-4666-8666-666666666666',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-del',
          originTicks: '9000',
          originWallClockUtc: '2026-10-07T14:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: { acknowledgedAt: '2026-10-07T13:59:50.000Z', policyVersion: 'v1' },
      },
    );
    const { source } = await service.registerSource({ userId: userOwnerA }, recording.id, {
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    const bytes = makeAudioBytes('delete-me', 256);
    const { chunk } = await service.registerChunk({ userId: userOwnerA }, recording.id, {
      recordingSourceId: source.id,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: bytes.byteLength,
      checksum: { algorithm: 'sha256', value: computeSha256Hex(bytes) },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    const auth = await service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk.id,
      {},
    );
    await storage.putObjectViaSignedUrl(auth.uploadUrl, bytes);
    await service.verifyChunkUpload({ userId: userOwnerA }, recording.id, chunk.id, {});
    await service.finalizeRecording({ userId: userOwnerA }, recording.id, {});

    // Simulate object storage failure on first delete attempt
    storage.failDeleteForKey(chunk.storageKey, 'R2 bucket temporarily unreachable');
    const failedDel = await service.deleteRecording({ userId: userOwnerA }, recording.id);
    expect(failedDel.status).toBe('reconciliation_required');
    expect(failedDel.reconciliationPendingCount).toBe(1);
    expect(failedDel.deletedObjectCount).toBe(0);
    expect(failedDel.ledger[0]?.status).toBe('reconciliation_required');
    expect(storage.hasObject(chunk.storageKey)).toBe(true);

    // Clear storage failure and retry deletion -> completes and removes object + relational rows
    storage.clearDeleteFailureForKey(chunk.storageKey);
    const completedDel = await service.deleteRecording({ userId: userOwnerA }, recording.id);
    expect(completedDel.status).toBe('deleted');
    expect(completedDel.reconciliationPendingCount).toBe(0);
    expect(completedDel.deletedObjectCount).toBe(1);
    expect(completedDel.ledger[0]?.status).toBe('deleted');
    expect(storage.hasObject(chunk.storageKey)).toBe(false);

    const remainingChunks = await db.query(
      'select id from public.recording_chunks where recording_id = $1',
      [recording.id],
    );
    expect(remainingChunks.rows).toHaveLength(0);
  });
});

describe('Phase 4 — End-to-End 14-Step Flow via /api/v1 Routes & Live Product Repository', () => {
  it('executes steps 1–14 through /api/v1 HTTP route handlers and reads live state through ProductRepositories', async () => {
    await db.query(
      `update public.processing_jobs set status = 'cancelled' where status in ('queued', 'running', 'retryable_failed')`,
    );

    // 1. Authenticated user owns/accesses workspaceA; 2. Meeting exists
    const meetingId = await createMeetingDraft(
      userOwnerA,
      workspaceA,
      meetingTypeA,
      'Q4 Architecture Sync',
    );
    const liveRepos = createLiveRepositories({
      service,
      principal: { userId: userOwnerA },
    });

    // Initially draft
    const initialBundle = await loadMeetingBundle(liveRepos, workspaceA, meetingId);
    expect(initialBundle.ok).toBe(true);
    if (!initialBundle.ok) throw new Error('expected bundle');
    expect(initialBundle.bundle.detail.state).toBe('draft');

    // 3. Recorder session is registered via POST /api/v1/recordings
    const createRecReq = new Request('http://localhost:3000/api/v1/recordings', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspaceA,
        meetingId,
        sessionId: '77777777-7777-4777-8777-777777777777',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-e2e',
          originTicks: '100000',
          originWallClockUtc: '2026-10-07T15:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T14:59:55.000Z',
          policyVersion: 'v1',
        },
      }),
    });
    const createRecRes = await postRecordingRoute(createRecReq as unknown as NextRequest);
    expect(createRecRes.status).toBe(201);
    const { recording } = (await createRecRes.json()) as { recording: { id: string } };

    // 4. Microphone & system_audio sources are registered via POST /api/v1/recordings/{recordingId}/sources
    const micSourceRes = await postSourceRoute(
      new Request(`http://localhost:3000/api/v1/recordings/${recording.id}/sources`, {
        method: 'POST',
        body: JSON.stringify({
          sourceKind: 'microphone',
          codec: 'pcm_s16le',
          container: 'wav',
          sampleRateHz: 48_000,
          channels: 1,
          expectedChunkCount: 1,
        }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ recordingId: recording.id }) },
    );
    expect(micSourceRes.status).toBe(201);
    const { source: micSource } = (await micSourceRes.json()) as { source: { id: string } };

    const sysSourceRes = await postSourceRoute(
      new Request(`http://localhost:3000/api/v1/recordings/${recording.id}/sources`, {
        method: 'POST',
        body: JSON.stringify({
          sourceKind: 'system_audio',
          codec: 'pcm_s16le',
          container: 'wav',
          sampleRateHz: 48_000,
          channels: 2,
          expectedChunkCount: 1,
        }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ recordingId: recording.id }) },
    );
    expect(sysSourceRes.status).toBe(201);
    const { source: sysSource } = (await sysSourceRes.json()) as { source: { id: string } };

    // 5, 6, 7, 8, 9. Register chunks, authorize uploads, upload bytes to private storage, verify chunks
    for (const [source, channels, label] of [
      [micSource, 1, 'mic-chunk-0'],
      [sysSource, 2, 'sys-chunk-0'],
    ] as const) {
      const bytes = makeAudioBytes(label, 384);
      const sha = computeSha256Hex(bytes);

      const chunkRes = await postChunkRoute(
        new Request(`http://localhost:3000/api/v1/recordings/${recording.id}/chunks`, {
          method: 'POST',
          body: JSON.stringify({
            recordingSourceId: source.id,
            sequenceNo: 0,
            meetingStartMs: 0,
            meetingEndMs: 30_000,
            sampleStart: 0,
            sampleEnd: 1_440_000,
            byteSize: bytes.byteLength,
            checksum: { algorithm: 'sha256', value: sha },
            codec: 'pcm_s16le',
            container: 'wav',
            sampleRateHz: 48_000,
            channels,
          }),
        }) as unknown as NextRequest,
        { params: Promise.resolve({ recordingId: recording.id }) },
      );
      expect(chunkRes.status).toBe(201);
      const { chunk } = (await chunkRes.json()) as { chunk: { id: string } };

      const uploadAuthRes = await postChunkUploadRoute(
        new Request(
          `http://localhost:3000/api/v1/recordings/${recording.id}/chunks/${chunk.id}/upload`,
          { method: 'POST', body: JSON.stringify({}) },
        ) as unknown as NextRequest,
        { params: Promise.resolve({ recordingId: recording.id, chunkId: chunk.id }) },
      );
      expect(uploadAuthRes.status).toBe(200);
      const uploadAuth = (await uploadAuthRes.json()) as { uploadUrl: string };

      await storage.putObjectViaSignedUrl(uploadAuth.uploadUrl, bytes);

      const verifyRes = await postChunkVerifyRoute(
        new Request(
          `http://localhost:3000/api/v1/recordings/${recording.id}/chunks/${chunk.id}/verify`,
          { method: 'POST', body: JSON.stringify({}) },
        ) as unknown as NextRequest,
        { params: Promise.resolve({ recordingId: recording.id, chunkId: chunk.id }) },
      );
      expect(verifyRes.status).toBe(200);
      const verifyBody = (await verifyRes.json()) as { verified: boolean };
      expect(verifyBody.verified).toBe(true);
    }

    // While uploading/before finalize, live UI state is `uploading`
    const uploadingBundle = await loadMeetingBundle(liveRepos, workspaceA, meetingId);
    expect(uploadingBundle.ok).toBe(true);
    if (!uploadingBundle.ok) throw new Error('expected bundle');
    expect(uploadingBundle.bundle.detail.state).toBe('uploading');

    // 10, 11, 12. Finalize recording session via POST /api/v1/recordings/{recordingId}/finalize
    const finalizeRes = await postFinalizeRoute(
      new Request(`http://localhost:3000/api/v1/recordings/${recording.id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          canonicalDurationMs: 30_000,
          activeCaptureMs: 30_000,
        }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ recordingId: recording.id }) },
    );
    expect(finalizeRes.status).toBe(200);
    const finalizeBody = (await finalizeRes.json()) as {
      status: string;
      job: { id: string; jobType: string; status: string };
    };
    expect(finalizeBody.status).toBe('finalized');
    expect(finalizeBody.job.jobType).toBe('prepare_recording');

    // Inspect recording via GET /api/v1/recordings/{recordingId}
    const getRecRes = await getRecordingRoute(
      new Request(
        `http://localhost:3000/api/v1/recordings/${recording.id}`,
      ) as unknown as NextRequest,
      { params: Promise.resolve({ recordingId: recording.id }) },
    );
    expect(getRecRes.status).toBe(200);

    // Before worker runs, meeting state is `preparing`
    const preparingBundle = await loadMeetingBundle(liveRepos, workspaceA, meetingId);
    expect(preparingBundle.ok).toBe(true);
    if (!preparingBundle.ok) throw new Error('expected bundle');
    expect(preparingBundle.bundle.detail.state).toBe('preparing');
    expect(preparingBundle.bundle.detail.recording.available).toBe(true);
    expect(preparingBundle.bundle.detail.recording.source).toBe('object_storage');

    // 13. Worker claims and completes `prepare_recording` job
    const completedJob = await worker.runNextPrepareRecordingJob('worker-e2e');
    expect(completedJob?.status).toBe('succeeded');

    // 14. Product UI reads the state through GET /api/v1/meetings/{meetingId}/processing and live repository boundary
    const procRes = await getMeetingProcessingRoute(
      new Request(
        `http://localhost:3000/api/v1/meetings/${meetingId}/processing`,
      ) as unknown as NextRequest,
      { params: Promise.resolve({ meetingId }) },
    );
    expect(procRes.status).toBe(200);
    const procBody = (await procRes.json()) as { productState: string };
    expect(procBody.productState).toBe('ready_for_transcription');

    const readyForSttBundle = await loadMeetingBundle(liveRepos, workspaceA, meetingId);
    expect(readyForSttBundle.ok).toBe(true);
    if (!readyForSttBundle.ok) throw new Error('expected bundle');
    // Crucial: state is `ready_for_transcription`, NEVER `ready`!
    expect(readyForSttBundle.bundle.detail.state).toBe('ready_for_transcription');
    expect(readyForSttBundle.bundle.detail.state).not.toBe('ready');
    expect(readyForSttBundle.bundle.processing?.state).toBe('ready_for_transcription');

    // Unsupported live features (like Ask AI) explicitly reject with provider_unavailable and never fall back to demo
    await expect(liveRepos.askAi.ask(workspaceA, 'What happened?')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });

    // Verify DELETE /api/v1/recordings/{recordingId} route works too
    const delRes = await deleteRecordingRoute(
      new Request(`http://localhost:3000/api/v1/recordings/${recording.id}`, {
        method: 'DELETE',
      }) as unknown as NextRequest,
      { params: Promise.resolve({ recordingId: recording.id }) },
    );
    expect(delRes.status).toBe(200);

    // Check processing events recorded all key lifecycle transitions
    const events = await service.listProcessingEvents(meetingId);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('recording_created');
    expect(eventTypes).toContain('source_registered');
    expect(eventTypes).toContain('chunk_registered');
    expect(eventTypes).toContain('upload_authorized');
    expect(eventTypes).toContain('chunk_uploaded');
    expect(eventTypes).toContain('chunk_verified');
    expect(eventTypes).toContain('recording_finalized');
    expect(eventTypes).toContain('job_created');
    expect(eventTypes).toContain('job_claimed');
    expect(eventTypes).toContain('job_succeeded');
    expect(eventTypes).toContain('recording_deletion_requested');
    expect(eventTypes).toContain('object_deleted');
    expect(eventTypes).toContain('recording_deletion_completed');
  });
});
