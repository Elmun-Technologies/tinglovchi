import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type {
  RecordingChunkDto,
  RecordingDto,
  RecordingSourceDto,
  TranscriptionAssetPiece,
} from '@suhbat/contracts';
import { Phase4BackboneService } from '@suhbat/database/phase4';
import { Phase5TranscriptionService, Phase5TranscriptionWorker } from '@suhbat/database/phase5';
import { LocalDiskStorageProvider, computeSha256Hex } from '@suhbat/database/storage';
import {
  WAV_MEDIA_ENGINE_VERSION,
  assembleCanonicalWavFromChunks,
  createPcm16WavBuffer,
  parseWavPcm16,
  prepareCanonicalTranscriptionAssetPlan,
  resolveCanonicalSegmentAudioSlice,
} from '@suhbat/database/transcription-alignment';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';

const migrationPaths = [
  resolve('supabase/migrations/202610060001_phase1_foundation.sql'),
  resolve('supabase/migrations/202610070001_phase4_upload_processing_backbone.sql'),
  resolve('supabase/migrations/202610070002_phase4_1_security_hardening.sql'),
  resolve('supabase/migrations/202610070003_phase5_transcription_alignment.sql'),
  resolve('supabase/migrations/202610070004_phase6_meeting_intelligence.sql'),
  resolve('supabase/migrations/202610070005_phase7_company_memory_ask_ai.sql'),
  resolve('supabase/migrations/202610070006_phase8_telegram_companion_notifications.sql'),
  resolve('supabase/migrations/202610070007_phase9_business_automation.sql'),
];
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

describe('Phase 12.1 — Real Media and Recorder Acceptance Gate', () => {
  let db: PGlite;
  let tempStorageDir: string;
  let diskStorage: LocalDiskStorageProvider;

  const userOwner = '11111111-1111-4111-8111-111111111111';
  let workspaceId = '';
  let companyId = '';
  let projectId = '';
  let meetingTypeId = '';

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(authBootstrap);
    for (const path of migrationPaths) {
      await db.exec(readFileSync(path, 'utf8'));
    }
    await db.exec(readFileSync(seedPath, 'utf8'));

    tempStorageDir = mkdtempSync(join(tmpdir(), 'suhbat-phase12-1-media-'));
    diskStorage = new LocalDiskStorageProvider({
      rootDir: tempStorageDir,
      signingSecret: 'phase12-1-disk-secret-key-0123456789',
    });

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, 'owner@acme.uz', '{"full_name":"Owner Acme"}'::jsonb)`,
      [userOwner],
    );

    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userOwner]);
    await db.exec('set role authenticated');
    const wsRes = await db.query<{ id: string }>(
      `select public.create_workspace('Acme Media Gate', 'acme-media-gate') as id`,
    );
    workspaceId = wsRes.rows[0]!.id;

    const compRes = await db.query<{ id: string }>(
      `insert into public.companies (workspace_id, name, created_by)
       values ($1, 'Acme Media Corp', $2) returning id`,
      [workspaceId, userOwner],
    );
    companyId = compRes.rows[0]!.id;

    const projRes = await db.query<{ id: string }>(
      `insert into public.projects (workspace_id, company_id, name, created_by)
       values ($1, $2, 'Recorder Acceptance Gate', $3) returning id`,
      [workspaceId, companyId, userOwner],
    );
    projectId = projRes.rows[0]!.id;

    const mtRes = await db.query<{ id: string }>(
      `select id from public.meeting_types where workspace_id = $1 and key = 'client_sales'`,
      [workspaceId],
    );
    meetingTypeId = mtRes.rows[0]!.id;
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    if (tempStorageDir) {
      rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  async function createDraftMeeting(title: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into public.meetings (
         workspace_id, company_id, project_id, meeting_type_id, title,
         status, processing_status, created_by
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'draft', 'idle', $6::uuid
       ) returning id`,
      [workspaceId, companyId, projectId, meetingTypeId, title, userOwner],
    );
    return res.rows[0]!.id;
  }

  it('1. Rejects invalid or inconsistent WAV duration metadata and never stretches or truncates audio', () => {
    const mockRecording: RecordingDto = {
      id: '10000000-0000-4000-8000-000000000001',
      workspaceId: '20000000-0000-4000-8000-000000000001',
      meetingId: '30000000-0000-4000-8000-000000000001',
      sessionId: '40000000-0000-4000-8000-000000000001',
      status: 'finalized',
      timeline: {
        clock: 'platform_monotonic_continuous',
        clockEpochId: '50000000-0000-4000-8000-000000000001',
        originTicks: '1000',
        originWallClockUtc: '2026-10-07T10:00:00.000Z',
        tickFrequencyHz: 1_000_000_000,
      },
      consent: {
        acknowledgedAt: '2026-10-07T10:00:00.000Z',
        policyVersion: 'v1',
      },
      canonicalDurationMs: 30000,
      activeCaptureMs: 30000,
      startedAt: '2026-10-07T10:00:00.000Z',
      stoppedAt: '2026-10-07T10:00:30.000Z',
      finalizedAt: '2026-10-07T10:00:30.000Z',
      manifestRevision: 1,
      createdBy: userOwner,
      createdAt: '2026-10-07T10:00:00.000Z',
      updatedAt: '2026-10-07T10:00:30.000Z',
    };

    const mockSource: RecordingSourceDto = {
      id: '60000000-0000-4000-8000-000000000001',
      workspaceId: mockRecording.workspaceId,
      meetingId: mockRecording.meetingId,
      recordingId: mockRecording.id,
      sourceKind: 'microphone',
      sourceRole: 'original',
      deviceUid: 'BuiltInMicrophoneDevice',
      deviceName: 'MacBook Pro Microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16000,
      channels: 1,
      isRequired: true,
      expectedChunkCount: 1,
      startedAtTicks: '1000',
      endedAtTicks: '30000001000',
      firstSampleIndex: 0,
      firstSampleMeetingMs: 0,
      lastSampleMeetingMs: 30000,
      lastSampleIndexExclusive: 480000,
      droppedSampleCount: 0,
      createdAt: '2026-10-07T10:00:00.000Z',
      updatedAt: '2026-10-07T10:00:30.000Z',
    };

    const validChunkMeta: RecordingChunkDto = {
      id: '70000000-0000-4000-8000-000000000001',
      workspaceId: mockRecording.workspaceId,
      meetingId: mockRecording.meetingId,
      recordingId: mockRecording.id,
      recordingSourceId: mockSource.id,
      clientChunkId: '80000000-0000-4000-8000-000000000001',
      sequenceNo: 0,
      idempotencyKey: 'idem-0',
      storageBackend: 'local',
      storageKey:
        'workspace/20000000-0000-4000-8000-000000000001/meetings/30000000-0000-4000-8000-000000000001/recordings/10000000-0000-4000-8000-000000000001/sources/60000000-0000-4000-8000-000000000001/chunks/000000.wav',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 30000,
      meetingStartMs: 0,
      meetingEndMs: 30000,
      sampleStart: 0,
      sampleEnd: 480000,
      firstSampleMonotonicTicks: '1000',
      byteSize: 960044,
      checksum: {
        algorithm: 'sha256',
        value: 'a'.repeat(64),
      },
      encoderDelaySamples: 0,
      encoderPaddingSamples: 0,
      uploadState: 'verified',
      verificationState: 'verified',
      verifiedByteSize: 960044,
      verifiedSha256: 'a'.repeat(64),
      verificationMethod: 'digest_computed_from_bytes',
      verificationErrorCode: null,
      uploadedAt: '2026-10-07T10:00:30.000Z',
      verifiedAt: '2026-10-07T10:00:30.000Z',
      createdAt: '2026-10-07T10:00:00.000Z',
      updatedAt: '2026-10-07T10:00:30.000Z',
    };

    // Case A: WAV buffer has only 500ms (8,000 frames), while chunk metadata claims 30,000ms (480,000 frames)
    const shortWav = createPcm16WavBuffer({
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 500,
      frequencyHz: 440,
    });
    expect(() =>
      prepareCanonicalTranscriptionAssetPlan({
        recording: mockRecording,
        sources: [mockSource],
        chunks: [validChunkMeta],
        chunkBytesById: new Map([[validChunkMeta.id, shortWav]]),
      }),
    ).toThrow(
      /WAV PCM frame count \(8000 frames, 500ms\) disagrees with chunk sample range \[0, 480000\)/,
    );

    // Case B: Chunk metadata durationMs (15,000ms) disagrees with sampleStart..sampleEnd (480,000 frames = 30,000ms)
    expect(() =>
      prepareCanonicalTranscriptionAssetPlan({
        recording: mockRecording,
        sources: [mockSource],
        chunks: [{ ...validChunkMeta, durationMs: 15000 }],
      }),
    ).toThrow(/declares durationMs=15000ms, which disagrees with PCM sample duration/);

    // Case C: Chunk meeting span [0..20,000ms] disagrees with sampleStart..sampleEnd (480,000 frames = 30,000ms)
    expect(() =>
      prepareCanonicalTranscriptionAssetPlan({
        recording: mockRecording,
        sources: [mockSource],
        chunks: [{ ...validChunkMeta, meetingEndMs: 20000 }],
      }),
    ).toThrow(/meeting span \[0, 20000\) \(20000ms\) disagrees with PCM sample duration/);

    // Case D: WAV header sample rate (48,000 Hz) disagrees with piece sampleRateHz (16,000 Hz)
    const wrongRateWav = createPcm16WavBuffer({
      sampleRateHz: 48000,
      channels: 1,
      durationMs: 10000,
      frequencyHz: 440,
    });
    expect(() =>
      prepareCanonicalTranscriptionAssetPlan({
        recording: mockRecording,
        sources: [mockSource],
        chunks: [validChunkMeta],
        chunkBytesById: new Map([[validChunkMeta.id, wrongRateWav]]),
      }),
    ).toThrow(
      /WAV header sampleRateHz \(48000\) disagrees with chunk metadata sampleRateHz \(16000\)/,
    );

    // Case E: Truncated RIFF payload starting with "RIFF" fails closed instead of falling back to JSON manifest
    const corruptedRiff = new Uint8Array(shortWav.slice(0, 100));
    const view = new DataView(
      corruptedRiff.buffer,
      corruptedRiff.byteOffset,
      corruptedRiff.byteLength,
    );
    view.setUint32(4, 999999, true); // claims 999,999 bytes in RIFF header
    expect(() =>
      prepareCanonicalTranscriptionAssetPlan({
        recording: mockRecording,
        sources: [mockSource],
        chunks: [validChunkMeta],
        chunkBytesById: new Map([[validChunkMeta.id, corruptedRiff]]),
      }),
    ).toThrow(/RIFF chunk size .* exceeds buffer byte length/);
  });

  it('2. Real 30-second 48 kHz recorder WAV on disk preserves 1,440,000 frames in canonical WAV, resamples accurately to 16 kHz (480,000 frames), and preserves sample-accurate chunk lineage', async () => {
    const phase4 = new Phase4BackboneService({ db, storage: diskStorage });
    const fakeProvider = new FakeTranscriptionProvider();
    const phase5Service = new Phase5TranscriptionService({
      phase4,
      provider: fakeProvider,
    });
    const phase5Worker = new Phase5TranscriptionWorker(phase5Service);

    const meetingId = await createDraftMeeting('30-Second Real 48kHz Recorder Acceptance');
    const { recording } = await phase4.createRecording(
      { userId: userOwner },
      {
        workspaceId,
        meetingId,
        sessionId: 'a1000000-0000-4000-8000-000000000030',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'a2000000-0000-4000-8000-000000000030',
          originTicks: '5000000000',
          originWallClockUtc: '2026-10-07T12:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T12:00:00.000Z',
          policyVersion: 'v1',
        },
      },
    );

    fakeProvider.setCustomResultForRecording(recording.id, {
      provider: 'fake',
      providerModel: 'fake-multilingual-diarized-v1',
      providerJobId: 'job-30s-48k',
      detectedLanguages: ['uz'],
      durationMs: 30000,
      segments: [
        {
          providerSegmentKey: 'seg-0',
          speakerLabel: 'speaker_0',
          startMs: 1000,
          endMs: 9000,
          text: 'First ten seconds at 440 Hz tone.',
          detectedLanguage: 'uz',
          confidence: 0.96,
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg-1',
          speakerLabel: 'speaker_1',
          startMs: 11000,
          endMs: 19000,
          text: 'Middle ten seconds at 660 Hz tone.',
          detectedLanguage: 'uz',
          confidence: 0.95,
          words: [],
          providerMetadata: {},
        },
        {
          providerSegmentKey: 'seg-2',
          speakerLabel: 'speaker_0',
          startMs: 21000,
          endMs: 29000,
          text: 'Final ten seconds at 880 Hz tone.',
          detectedLanguage: 'uz',
          confidence: 0.97,
          words: [],
          providerMetadata: {},
        },
      ],
      providerMetadata: {},
    });

    const { source } = await phase4.registerSource({ userId: userOwner }, recording.id, {
      workspaceId,
      sourceKind: 'microphone',
      sourceRole: 'original',
      deviceUid: 'BuiltInMicrophoneDevice',
      deviceName: 'MacBook Pro Microphone',
      isRequired: true,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48000,
      channels: 1,
      expectedChunkCount: 1,
    });

    // Real 30-second 48,000 Hz mono PCM16le WAV (1,440,000 frames = 2,880,044 bytes) with 3 distinct tone bands
    const wav30s48k = createPcm16WavBuffer({
      sampleRateHz: 48000,
      channels: 1,
      toneSegments: [
        { durationMs: 10000, frequencyHz: 440, amplitude: 0.5 },
        { durationMs: 10000, frequencyHz: 660, amplitude: 0.5 },
        { durationMs: 10000, frequencyHz: 880, amplitude: 0.5 },
      ],
    });
    const parsedSourceHeader = parseWavPcm16(wav30s48k);
    expect(parsedSourceHeader.sampleRateHz).toBe(48000);
    expect(parsedSourceHeader.channels).toBe(1);
    expect(parsedSourceHeader.bitsPerSample).toBe(16);
    expect(parsedSourceHeader.frameCount).toBe(1_440_000);
    expect(parsedSourceHeader.dataByteLength).toBe(2_880_000);
    expect(parsedSourceHeader.durationMs).toBe(30000);

    const originalSha256 = computeSha256Hex(wav30s48k);
    const { chunk } = await phase4.registerChunk({ userId: userOwner }, recording.id, {
      workspaceId,
      recordingSourceId: source.id,
      clientChunkId: 'a3000000-0000-4000-8000-000000000030',
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      firstSampleMonotonicTicks: '5000000000',
      byteSize: wav30s48k.byteLength,
      checksum: { algorithm: 'sha256', value: originalSha256 },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48000,
      channels: 1,
    });

    const uploadAuth = await phase4.authorizeChunkUpload(
      { userId: userOwner },
      recording.id,
      chunk.id,
      { workspaceId, contentType: 'audio/wav' },
    );
    await diskStorage.putObjectViaSignedUrl(uploadAuth.uploadUrl, wav30s48k);
    await phase4.verifyChunkUpload({ userId: userOwner }, recording.id, chunk.id, { workspaceId });

    const finalized = await phase4.finalizeRecording({ userId: userOwner }, recording.id, {
      workspaceId,
      canonicalDurationMs: 30000,
      activeCaptureMs: 30000,
      expectedSources: [{ recordingSourceId: source.id, expectedChunkCount: 1 }],
    });
    expect(finalized.status).toBe('finalized');

    // Run all 4 Phase 5 jobs (prepare_recording -> transcribe_meeting -> normalize_transcript -> finalize_transcript)
    for (let step = 0; step < 4; step++) {
      const outcome = await phase5Worker.runNextJob('media-gate-worker-30s', {
        now: new Date(Date.now() + (step + 1) * 1000),
      });
      expect(outcome?.status).toBe('succeeded');
    }

    // 1. Original chunk on disk is untouched and byte-for-byte identical
    const diskOriginalPath = join(tempStorageDir, chunk.storageKey);
    const diskOriginalBytes = new Uint8Array(readFileSync(diskOriginalPath));
    expect(computeSha256Hex(diskOriginalBytes)).toBe(originalSha256);

    // 2. Canonical transcription asset on disk is a valid 48,000 Hz mono WAV with 1,440,000 frames (30,000 ms)
    const assetRows = await db.query<{
      storage_key: string;
      sample_rate_hz: number;
      channels: number;
      asset_duration_ms: number;
      canonical_duration_ms: number;
      active_capture_ms: number;
      byte_size: string | number;
      checksum_sha256: string;
      timeline_map: TranscriptionAssetPiece[];
      preparation_metadata: {
        binary_mux_performed: boolean;
        media_engine: string;
        wav_frames_assembled: number;
        wav_data_bytes: number;
      };
    }>(`select * from public.transcription_assets where recording_id = $1`, [recording.id]);
    const asset = assetRows.rows[0]!;
    expect(asset.preparation_metadata.binary_mux_performed).toBe(true);
    expect(asset.preparation_metadata.media_engine).toBe(WAV_MEDIA_ENGINE_VERSION);
    expect(asset.preparation_metadata.wav_frames_assembled).toBe(1_440_000);
    expect(asset.preparation_metadata.wav_data_bytes).toBe(2_880_000);
    expect(asset.sample_rate_hz).toBe(48000);
    expect(asset.channels).toBe(1);
    expect(asset.asset_duration_ms).toBe(30000);
    expect(asset.canonical_duration_ms).toBe(30000);
    expect(asset.active_capture_ms).toBe(30000);

    const diskCanonicalBytes = new Uint8Array(
      readFileSync(join(tempStorageDir, asset.storage_key)),
    );
    const canonicalHeader = parseWavPcm16(diskCanonicalBytes);
    expect(canonicalHeader.sampleRateHz).toBe(48000);
    expect(canonicalHeader.channels).toBe(1);
    expect(canonicalHeader.frameCount).toBe(1_440_000);
    expect(canonicalHeader.durationMs).toBe(30000);
    expect(computeSha256Hex(diskCanonicalBytes)).toBe(asset.checksum_sha256);

    // Also verify 48 kHz -> 16 kHz resampling on the real 30s chunk produces exactly 480,000 frames (960,000 PCM bytes, 30,000 ms)
    const resampled16k = assembleCanonicalWavFromChunks({
      targetSampleRateHz: 16000,
      targetChannels: 1,
      pieces: [{ piece: asset.timeline_map[0]!, chunkBytes: diskOriginalBytes }],
    });
    expect(resampled16k.totalFrames).toBe(480_000);
    expect(resampled16k.dataByteLength).toBe(960_000);
    expect(resampled16k.header.sampleRateHz).toBe(16000);
    expect(resampled16k.header.durationMs).toBe(30000);

    // 3. Verify aligned transcript segments identify the exact original chunk and 48 kHz sample range
    const segs = await db.query<{
      sequence_no: number;
      start_ms: number;
      end_ms: number;
      source_recording_source_id: string;
      source_recording_chunk_id: string;
      source_sample_start: string | number;
      source_sample_end: string | number;
      alignment_metadata: {
        provider_start_ms: number;
        provider_end_ms: number;
        spans_pause_boundary: boolean;
      };
    }>(
      `select sequence_no, start_ms, end_ms, source_recording_source_id, source_recording_chunk_id,
              source_sample_start, source_sample_end, alignment_metadata
         from public.transcript_segments
        where meeting_id = $1
        order by sequence_no asc`,
      [meetingId],
    );
    expect(segs.rows).toHaveLength(3);

    const expectedRanges = [
      { startMs: 1000, endMs: 9000, sampleStart: 48_000, sampleEnd: 432_000, freqHz: 440 },
      { startMs: 11000, endMs: 19000, sampleStart: 528_000, sampleEnd: 912_000, freqHz: 660 },
      { startMs: 21000, endMs: 29000, sampleStart: 1_008_000, sampleEnd: 1_392_000, freqHz: 880 },
    ];

    for (let i = 0; i < expectedRanges.length; i++) {
      const row = segs.rows[i]!;
      const exp = expectedRanges[i]!;
      expect(row.start_ms).toBe(exp.startMs);
      expect(row.end_ms).toBe(exp.endMs);
      expect(row.source_recording_chunk_id).toBe(chunk.id);
      expect(Number(row.source_sample_start)).toBe(exp.sampleStart);
      expect(Number(row.source_sample_end)).toBe(exp.sampleEnd);

      const slice = resolveCanonicalSegmentAudioSlice({
        segment: {
          startMs: row.start_ms,
          endMs: row.end_ms,
          sourceRecordingSourceId: row.source_recording_source_id,
          sourceRecordingChunkId: row.source_recording_chunk_id,
          sourceSampleStart: Number(row.source_sample_start),
          sourceSampleEnd: Number(row.source_sample_end),
        },
        chunk,
        chunkWavBytes: diskOriginalBytes,
      });

      expect(slice.frameCount).toBe(exp.sampleEnd - exp.sampleStart);
      expect(slice.durationMs).toBe(8000);
      expect(slice.rmsAmplitude).toBeGreaterThan(0.2);
      expect(Math.abs(slice.estimatedFrequencyHz - exp.freqHz)).toBeLessThan(2);
    }
  });

  it('3. Multi-chunk recording with pause/resume discontinuity preserves pause gap in canonical timeline and maps speech to exact chunk samples', async () => {
    const phase4 = new Phase4BackboneService({ db, storage: diskStorage });
    const fakeProvider = new FakeTranscriptionProvider();
    const phase5Service = new Phase5TranscriptionService({
      phase4,
      provider: fakeProvider,
    });
    const phase5Worker = new Phase5TranscriptionWorker(phase5Service);

    const meetingId = await createDraftMeeting('Multi-Chunk Pause/Resume Acceptance');
    const { recording } = await phase4.createRecording(
      { userId: userOwner },
      {
        workspaceId,
        meetingId,
        sessionId: 'b1000000-0000-4000-8000-000000000060',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'b2000000-0000-4000-8000-000000000060',
          originTicks: '1000000000',
          originWallClockUtc: '2026-10-07T12:10:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T12:10:00.000Z',
          policyVersion: 'v1',
        },
      },
    );

    fakeProvider.setCustomResultForRecording(recording.id, {
      provider: 'fake',
      providerModel: 'fake-multilingual-diarized-v1',
      providerJobId: 'job-pause-60s',
      detectedLanguages: ['uz'],
      durationMs: 60000,
      segments: [
        // Pre-pause speech in Piece 0 (asset 5,000..15,000 ms -> canonical 5,000..15,000 ms)
        {
          providerSegmentKey: 'seg-pre-pause',
          speakerLabel: 'speaker_0',
          startMs: 5000,
          endMs: 15000,
          text: 'Before the fifteen second pause.',
          detectedLanguage: 'uz',
          confidence: 0.98,
          words: [],
          providerMetadata: {},
        },
        // Boundary-straddling segment (asset 29,000..31,000 ms -> canonical 29,000..46,000 ms)
        {
          providerSegmentKey: 'seg-straddle',
          speakerLabel: 'speaker_0',
          startMs: 29000,
          endMs: 31000,
          text: 'Pausing right now and resuming.',
          detectedLanguage: 'uz',
          confidence: 0.91,
          words: [],
          providerMetadata: {},
        },
        // Post-pause speech in Piece 1 (asset 35,000..45,000 ms -> canonical 50,000..60,000 ms)
        {
          providerSegmentKey: 'seg-post-pause',
          speakerLabel: 'speaker_1',
          startMs: 35000,
          endMs: 45000,
          text: 'After the fifteen second pause.',
          detectedLanguage: 'uz',
          confidence: 0.97,
          words: [],
          providerMetadata: {},
        },
      ],
      providerMetadata: {},
    });

    const { source } = await phase4.registerSource({ userId: userOwner }, recording.id, {
      workspaceId,
      sourceKind: 'microphone',
      sourceRole: 'original',
      isRequired: true,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16000,
      channels: 1,
      expectedChunkCount: 2,
    });

    // Chunk 0: 30s (0..30,000 ms, samples 0..480,000) at 440 Hz
    const wavChunk0 = createPcm16WavBuffer({
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 30000,
      frequencyHz: 440,
      amplitude: 15000,
    });
    // Chunk 1: 30s after a 15,000 ms pause (45,000..75,000 ms, samples 480,000..960,000) at 880 Hz
    const wavChunk1 = createPcm16WavBuffer({
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 30000,
      frequencyHz: 880,
      amplitude: 15000,
    });

    const { chunk: c0 } = await phase4.registerChunk({ userId: userOwner }, recording.id, {
      workspaceId,
      recordingSourceId: source.id,
      clientChunkId: 'b3000000-0000-4000-8000-000000000000',
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30000,
      sampleStart: 0,
      sampleEnd: 480000,
      firstSampleMonotonicTicks: '1000000000',
      byteSize: wavChunk0.byteLength,
      checksum: { algorithm: 'sha256', value: computeSha256Hex(wavChunk0) },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16000,
      channels: 1,
    });

    const { chunk: c1 } = await phase4.registerChunk({ userId: userOwner }, recording.id, {
      workspaceId,
      recordingSourceId: source.id,
      clientChunkId: 'b3000000-0000-4000-8000-000000000001',
      sequenceNo: 1,
      meetingStartMs: 45000,
      meetingEndMs: 75000,
      sampleStart: 480000,
      sampleEnd: 960000,
      firstSampleMonotonicTicks: '46000000000',
      byteSize: wavChunk1.byteLength,
      checksum: { algorithm: 'sha256', value: computeSha256Hex(wavChunk1) },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16000,
      channels: 1,
    });

    for (const [chunkDto, wavBytes] of [
      [c0, wavChunk0],
      [c1, wavChunk1],
    ] as const) {
      const auth = await phase4.authorizeChunkUpload(
        { userId: userOwner },
        recording.id,
        chunkDto.id,
        { workspaceId, contentType: 'audio/wav' },
      );
      await diskStorage.putObjectViaSignedUrl(auth.uploadUrl, wavBytes);
      await phase4.verifyChunkUpload({ userId: userOwner }, recording.id, chunkDto.id, {
        workspaceId,
      });
    }

    await phase4.finalizeRecording({ userId: userOwner }, recording.id, {
      workspaceId,
      canonicalDurationMs: 75000,
      activeCaptureMs: 60000,
      expectedSources: [{ recordingSourceId: source.id, expectedChunkCount: 2 }],
    });

    for (let step = 0; step < 4; step++) {
      const outcome = await phase5Worker.runNextJob('media-gate-worker-pause', {
        now: new Date(Date.now() + (step + 10) * 1000),
      });
      expect(outcome?.status).toBe('succeeded');
    }

    const runRows = await db.query<{
      segment_count: number;
      quarantined_segment_count: number;
    }>(
      `select segment_count, quarantined_segment_count from public.transcription_runs where recording_id = $1`,
      [recording.id],
    );
    expect(runRows.rows[0]?.segment_count).toBe(2);
    expect(runRows.rows[0]?.quarantined_segment_count).toBe(1);

    const segs = await db.query<{
      sequence_no: number;
      start_ms: number;
      end_ms: number;
      source_recording_source_id: string;
      source_recording_chunk_id: string;
      source_sample_start: string | number;
      source_sample_end: string | number;
      alignment_metadata: {
        discontinuity_crossed: boolean;
      };
    }>(
      `select sequence_no, start_ms, end_ms, source_recording_source_id, source_recording_chunk_id,
              source_sample_start, source_sample_end, alignment_metadata
         from public.transcript_segments
        where meeting_id = $1
        order by sequence_no asc`,
      [meetingId],
    );
    // Boundary-straddling segment (29,000..31,000 ms across the pause boundary) was safely quarantined;
    // the 2 valid segments (pre-pause and post-pause) are canonically aligned.
    expect(segs.rows).toHaveLength(2);

    // Segment 0: pre-pause in Chunk 0 (5,000..15,000 ms, samples 80,000..240,000, 440 Hz)
    const seg0 = segs.rows[0]!;
    expect(seg0.start_ms).toBe(5000);
    expect(seg0.end_ms).toBe(15000);
    expect(seg0.source_recording_chunk_id).toBe(c0.id);
    expect(Number(seg0.source_sample_start)).toBe(80_000);
    expect(Number(seg0.source_sample_end)).toBe(240_000);
    expect(seg0.alignment_metadata.discontinuity_crossed).toBe(false);

    const slice0 = resolveCanonicalSegmentAudioSlice({
      segment: {
        startMs: seg0.start_ms,
        endMs: seg0.end_ms,
        sourceRecordingSourceId: seg0.source_recording_source_id,
        sourceRecordingChunkId: seg0.source_recording_chunk_id,
        sourceSampleStart: Number(seg0.source_sample_start),
        sourceSampleEnd: Number(seg0.source_sample_end),
      },
      chunk: c0,
      chunkWavBytes: wavChunk0,
    });
    expect(slice0.chunkRelativeFrameStart).toBe(80_000);
    expect(slice0.chunkRelativeFrameEnd).toBe(240_000);
    expect(Math.abs(slice0.estimatedFrequencyHz - 440)).toBeLessThan(2);

    // Segment 1: post-pause in Chunk 1 (asset 35,000..45,000 ms -> canonical 50,000..60,000 ms, samples 560,000..720,000, 880 Hz)
    const seg2 = segs.rows[1]!;
    expect(seg2.start_ms).toBe(50000);
    expect(seg2.end_ms).toBe(60000);
    expect(seg2.source_recording_chunk_id).toBe(c1.id);
    expect(Number(seg2.source_sample_start)).toBe(560_000);
    expect(Number(seg2.source_sample_end)).toBe(720_000);
    expect(seg2.alignment_metadata.discontinuity_crossed).toBe(false);

    const slice2 = resolveCanonicalSegmentAudioSlice({
      segment: {
        startMs: seg2.start_ms,
        endMs: seg2.end_ms,
        sourceRecordingSourceId: seg2.source_recording_source_id,
        sourceRecordingChunkId: seg2.source_recording_chunk_id,
        sourceSampleStart: Number(seg2.source_sample_start),
        sourceSampleEnd: Number(seg2.source_sample_end),
      },
      chunk: c1,
      chunkWavBytes: wavChunk1,
    });
    expect(slice2.chunkRelativeFrameStart).toBe(80_000);
    expect(slice2.chunkRelativeFrameEnd).toBe(240_000);
    expect(Math.abs(slice2.estimatedFrequencyHz - 880)).toBeLessThan(2);
  });

  it('4. Two-source recording keeps microphone (48kHz mono) and system_audio (48kHz stereo) on independent sample maps and never silently treats them as sample-synchronized', async () => {
    const phase4 = new Phase4BackboneService({ db, storage: diskStorage });
    const meetingId = await createDraftMeeting('Two-Source Independent Clocks Acceptance');
    const { recording } = await phase4.createRecording(
      { userId: userOwner },
      {
        workspaceId,
        meetingId,
        sessionId: 'c1000000-0000-4000-8000-000000000010',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'c2000000-0000-4000-8000-000000000010',
          originTicks: '1000000000',
          originWallClockUtc: '2026-10-07T12:20:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T12:20:00.000Z',
          policyVersion: 'v1',
        },
      },
    );

    const { source: micSource } = await phase4.registerSource({ userId: userOwner }, recording.id, {
      workspaceId,
      sourceKind: 'microphone',
      sourceRole: 'original',
      isRequired: true,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48000,
      channels: 1,
      expectedChunkCount: 1,
    });

    const { source: sysSource } = await phase4.registerSource({ userId: userOwner }, recording.id, {
      workspaceId,
      sourceKind: 'system_audio',
      sourceRole: 'original',
      isRequired: false,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48000,
      channels: 2,
      expectedChunkCount: 1,
    });

    // Microphone: 10s at 48 kHz mono (480,000 frames), starting at t = 0 ms (tick 1,000,000,000)
    const micWav = createPcm16WavBuffer({
      sampleRateHz: 48000,
      channels: 1,
      durationMs: 10000,
      frequencyHz: 440,
    });
    // System audio: 10s at 48 kHz stereo (480,000 stereo frames = 1,920,044 bytes), starting 250 ms later (tick 1,250,000,000)
    const sysWav = createPcm16WavBuffer({
      sampleRateHz: 48000,
      channels: 2,
      durationMs: 10000,
      frequencyHz: 660,
    });

    const { chunk: micChunk } = await phase4.registerChunk({ userId: userOwner }, recording.id, {
      workspaceId,
      recordingSourceId: micSource.id,
      clientChunkId: 'c3000000-0000-4000-8000-000000000001',
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 10000,
      sampleStart: 0,
      sampleEnd: 480000,
      firstSampleMonotonicTicks: '1000000000',
      byteSize: micWav.byteLength,
      checksum: { algorithm: 'sha256', value: computeSha256Hex(micWav) },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48000,
      channels: 1,
    });

    const { chunk: sysChunk } = await phase4.registerChunk({ userId: userOwner }, recording.id, {
      workspaceId,
      recordingSourceId: sysSource.id,
      clientChunkId: 'c3000000-0000-4000-8000-000000000002',
      sequenceNo: 0,
      meetingStartMs: 250,
      meetingEndMs: 10250,
      sampleStart: 0,
      sampleEnd: 480000,
      firstSampleMonotonicTicks: '1250000000',
      byteSize: sysWav.byteLength,
      checksum: { algorithm: 'sha256', value: computeSha256Hex(sysWav) },
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48000,
      channels: 2,
    });

    // Verify independent storage keys, source IDs, channel counts, and monotonic start ticks
    expect(micChunk.recordingSourceId).not.toBe(sysChunk.recordingSourceId);
    expect(micChunk.storageKey).not.toBe(sysChunk.storageKey);
    expect(micChunk.channels).toBe(1);
    expect(sysChunk.channels).toBe(2);
    expect(micChunk.firstSampleMonotonicTicks).toBe('1000000000');
    expect(sysChunk.firstSampleMonotonicTicks).toBe('1250000000');

    // Also verify stereo 48kHz -> mono 16kHz downmix + resample produces exact expected frame count (160,000 frames = 10,000 ms)
    const sysOnlyAssembled = assembleCanonicalWavFromChunks({
      targetSampleRateHz: 16000,
      targetChannels: 1,
      pieces: [
        {
          piece: {
            pieceIndex: 0,
            recordingSourceId: sysSource.id,
            sourceKind: 'system_audio',
            recordingChunkId: sysChunk.id,
            chunkSequenceNo: 0,
            sampleRateHz: 48000,
            channels: 2,
            sourceSampleStart: 0,
            sourceSampleEnd: 480000,
            assetStartMs: 0,
            assetEndMs: 10000,
            meetingStartMs: 250,
            meetingEndMs: 10250,
            gapBeforeAssetMs: 0,
            gapBeforeMeetingMs: 250,
            discontinuityReason: 'late_source_join',
          },
          chunkBytes: sysWav,
        },
      ],
    });
    expect(sysOnlyAssembled.totalFrames).toBe(160_000);
    expect(sysOnlyAssembled.dataByteLength).toBe(320_000);
    const sysAssembledHdr = parseWavPcm16(sysOnlyAssembled.wavBytes);
    expect(sysAssembledHdr.sampleRateHz).toBe(16000);
    expect(sysAssembledHdr.channels).toBe(1);
    expect(sysAssembledHdr.durationMs).toBe(10000);
  });
});
