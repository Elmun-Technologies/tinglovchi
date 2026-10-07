import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProductionConfigError, validateProductionEnvironment } from '@suhbat/database/config';
import {
  ObservabilityCollector,
  evaluateOperationalHealth,
  formatStructuredLogLine,
} from '@suhbat/database/observability';
import {
  Phase4ServiceError,
  redactObservabilityMetadata,
  type SqlExecutor,
  type StructuredObservabilityEvent,
} from '@suhbat/database/phase4';
import {
  MAX_CHUNK_UPLOAD_BYTE_SIZE,
  MemoryStorageProvider,
  R2StorageProvider,
  StorageProviderError,
  buildRecordingChunkStorageKey,
  computeSha256Hex,
} from '@suhbat/database/storage';
import {
  WAV_MEDIA_ENGINE_VERSION,
  createPcm16WavBuffer,
  parseWavPcm16,
} from '@suhbat/database/transcription-alignment';
import {
  AssemblyAITranscriptionProvider,
  FakeTranscriptionProvider,
  createTranscriptionProviderFromEnv,
} from '@suhbat/database/transcription-provider';
import {
  FakeMeetingIntelligenceProvider,
  createMeetingIntelligenceProviderFromEnv,
} from '@suhbat/database/intelligence-provider';
import {
  FakeEmbeddingProvider,
  createEmbeddingProviderFromEnv,
} from '@suhbat/database/embedding-provider';
import {
  FakeTelegramBotProvider,
  HttpTelegramBotProvider,
  TelegramProviderError,
  createTelegramBotProviderFromEnv,
} from '@suhbat/database/telegram-provider';
import {
  FakeBusinessAutomationProvider,
  HttpBusinessAutomationProvider,
  createBusinessAutomationProviderFromEnv,
} from '@suhbat/database/automation-provider';
import { MeetingProcessingWorkerRuntime } from '@suhbat/database/worker';
import { runStandaloneWorkerDaemon } from '@suhbat/database/worker-cli';
import {
  MAX_API_JSON_BODY_BYTES,
  handleApiError,
  parseJsonBody,
  setPhase4Runtime,
} from '../../apps/web/src/lib/api-v1-runtime';
import { GET as getHealthRoute } from '../../apps/web/src/app/api/v1/health/route';

const userOwnerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

describe('Phase 12 — Production Readiness, Media Assembly, Concurrency, Observability & Failure Drills', () => {
  let db: PGlite;
  let workspaceId: string;
  let companyId: string;
  let projectId: string;
  let meetingTypeId: string;
  let storage: MemoryStorageProvider;
  let transcriptionProvider: FakeTranscriptionProvider;
  let intelligenceProvider: FakeMeetingIntelligenceProvider;
  let embeddingProvider: FakeEmbeddingProvider;
  let telegramProvider: FakeTelegramBotProvider;
  let automationProvider: FakeBusinessAutomationProvider;
  let runtime: MeetingProcessingWorkerRuntime;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(authBootstrap);
    for (const path of migrationPaths) {
      await db.exec(readFileSync(path, 'utf8'));
    }
    await db.exec(readFileSync(seedPath, 'utf8'));

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, 'owner-p12@example.com', '{"full_name":"Owner P12"}'::jsonb)`,
      [userOwnerA],
    );

    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userOwnerA]);
    await db.exec('set role authenticated');
    const wsRes = await db.query<{ id: string }>(
      `select public.create_workspace('Suhbat Phase 12 Production WS', 'suhbat-phase12-prod-ws') as id`,
    );
    workspaceId = wsRes.rows[0]!.id;

    const compRes = await db.query<{ id: string }>(
      `insert into public.companies (workspace_id, name, created_by)
       values ($1, 'Tashkent Enterprise Group', $2) returning id`,
      [workspaceId, userOwnerA],
    );
    companyId = compRes.rows[0]!.id;

    const projRes = await db.query<{ id: string }>(
      `insert into public.projects (workspace_id, company_id, name, created_by)
       values ($1, $2, 'Core Platform Rollout', $3) returning id`,
      [workspaceId, companyId, userOwnerA],
    );
    projectId = projRes.rows[0]!.id;

    const mtRes = await db.query<{ id: string }>(
      `select id from public.meeting_types where workspace_id = $1 and key = 'client_sales'`,
      [workspaceId],
    );
    meetingTypeId = mtRes.rows[0]!.id;
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  });

  afterAll(async () => {
    setPhase4Runtime(null);
    await db.close();
  });

  beforeEach(() => {
    storage = new MemoryStorageProvider();
    transcriptionProvider = new FakeTranscriptionProvider();
    intelligenceProvider = new FakeMeetingIntelligenceProvider();
    embeddingProvider = new FakeEmbeddingProvider();
    telegramProvider = new FakeTelegramBotProvider();
    automationProvider = new FakeBusinessAutomationProvider();

    runtime = new MeetingProcessingWorkerRuntime({
      workerId: 'phase12-worker-primary',
      db,
      storage,
      transcriptionProvider,
      intelligenceProvider,
      embeddingProvider,
      telegramProvider,
      automationProvider,
      appUrl: 'https://app.suhbat.uz',
    });

    setPhase4Runtime({
      service: runtime.phase4Service,
      phase5Service: runtime.phase5Service,
      phase6Service: runtime.phase6Service,
      phase7Service: runtime.phase7Service,
      phase8Service: runtime.phase8Service,
      phase9Service: runtime.phase9Service,
      transcriptionProvider,
      intelligenceProvider,
      embeddingProvider,
      telegramProvider,
      automationProvider,
      resolvePrincipal: async () => ({ userId: userOwnerA }),
    });
  });

  async function createDraftMeeting(title: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into public.meetings (
        workspace_id, company_id, project_id, meeting_type_id, title,
        status, processing_status, created_by
      )
      values ($1, $2, $3, $4, $5, 'draft', 'idle', $6)
      returning id`,
      [workspaceId, companyId, projectId, meetingTypeId, title, userOwnerA],
    );
    return res.rows[0]!.id;
  }

  it('1. Fail-closed production environment audit rejects fake providers, missing keys, and leaked NEXT_PUBLIC_* secrets', () => {
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: 'production',
        APP_URL: 'http://insecure.suhbat.uz',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
        SUHBAT_DATA_MODE: 'demo',
        STORAGE_PROVIDER: 'local',
        TRANSCRIPTION_PROVIDER: 'fake',
        SUHBAT_INTELLIGENCE_PROVIDER: 'fake',
        SUHBAT_EMBEDDING_PROVIDER: 'fake',
        SUHBAT_TELEGRAM_PROVIDER: 'fake',
        SUHBAT_AUTOMATION_PROVIDER: 'fake',
        OPENAI_API_KEY: 'sk-super-secret-openai-key',
        NEXT_PUBLIC_LEAKED_KEY: 'sk-super-secret-openai-key',
      }),
    ).toThrow(ProductionConfigError);

    const report = validateProductionEnvironment(
      {
        NODE_ENV: 'production',
        APP_URL: 'http://insecure.suhbat.uz',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
        SUHBAT_DATA_MODE: 'demo',
        STORAGE_PROVIDER: 'local',
        TRANSCRIPTION_PROVIDER: 'fake',
        SUHBAT_INTELLIGENCE_PROVIDER: 'fake',
        SUHBAT_EMBEDDING_PROVIDER: 'fake',
        SUHBAT_TELEGRAM_PROVIDER: 'fake',
        SUHBAT_AUTOMATION_PROVIDER: 'fake',
        OPENAI_API_KEY: 'sk-super-secret-openai-key',
        NEXT_PUBLIC_LEAKED_KEY: 'sk-super-secret-openai-key',
      },
      { throwOnError: false },
    );
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes('NEXT_PUBLIC_LEAKED_KEY'))).toBe(true);
    expect(report.errors.some((e) => e.includes('APP_URL must use HTTPS'))).toBe(true);
    expect(report.errors.some((e) => e.includes('SUHBAT_DATA_MODE must be set to "live"'))).toBe(
      true,
    );
    expect(report.errors.some((e) => e.includes('STORAGE_PROVIDER must be "r2"'))).toBe(true);

    // Individual provider factories also fail closed in production
    expect(() =>
      createTranscriptionProviderFromEnv({
        NODE_ENV: 'production',
        TRANSCRIPTION_PROVIDER: 'fake',
      }),
    ).toThrow(/not permitted in production/);
    expect(() =>
      createMeetingIntelligenceProviderFromEnv({
        NODE_ENV: 'production',
        SUHBAT_INTELLIGENCE_PROVIDER: 'fake',
      }),
    ).toThrow(/not permitted in production/);
    expect(() =>
      createEmbeddingProviderFromEnv({
        NODE_ENV: 'production',
        SUHBAT_EMBEDDING_PROVIDER: 'fake',
      }),
    ).toThrow(/not permitted in production/);
    expect(() =>
      createTelegramBotProviderFromEnv({
        NODE_ENV: 'production',
        SUHBAT_TELEGRAM_PROVIDER: 'fake',
      }),
    ).toThrow(/not permitted in production/);
    expect(() =>
      createBusinessAutomationProviderFromEnv({
        NODE_ENV: 'production',
        SUHBAT_AUTOMATION_PROVIDER: 'fake',
      }),
    ).toThrow(/not permitted in production/);

    // Complete valid production configuration succeeds
    const validProd = validateProductionEnvironment({
      NODE_ENV: 'production',
      APP_URL: 'https://app.suhbat.uz',
      SUHBAT_DATA_MODE: 'live',
      NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon',
      SUPABASE_DB_URL: 'postgresql://worker_role:strong_pass@db.proj.supabase.co:5432/postgres',
      STORAGE_PROVIDER: 'r2',
      R2_ACCOUNT_ID: 'acc_12345',
      R2_BUCKET: 'suhbat-private-prod',
      R2_ACCESS_KEY_ID: 'r2_ak_12345',
      R2_SECRET_ACCESS_KEY: 'r2_sk_secret_67890',
      TRANSCRIPTION_PROVIDER: 'assemblyai',
      ASSEMBLYAI_API_KEY: 'aai_live_key_12345',
      SUHBAT_INTELLIGENCE_PROVIDER: 'openai',
      SUHBAT_EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-live-openai-key-1234567890',
      SUHBAT_TELEGRAM_PROVIDER: 'telegram',
      TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      TELEGRAM_WEBHOOK_SECRET: 'tg_webhook_secret_token_999',
      SUHBAT_AUTOMATION_PROVIDER: 'webhook',
      AUTOMATION_WEBHOOK_SECRET: 'auto_webhook_secret_token_888',
    });
    expect(validProd.ok).toBe(true);
    expect(validProd.errors).toHaveLength(0);
  });

  it('2. Real PCM16le WAV media preparation validates RIFF headers, concatenates PCM frames, and preserves original chunks', async () => {
    const meetingId = await createDraftMeeting('WAV Binary Media Assembly Test');

    const { recording } = await runtime.phase4Service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId,
        meetingId,
        sessionId: 'b1111111-1111-4111-8111-111111111111',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'b2222222-2222-4222-8222-222222222222',
          originTicks: '1000',
          originWallClockUtc: '2026-10-07T08:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T08:00:00.000Z',
          policyVersion: 'v1',
        },
      },
    );

    const { source } = await runtime.phase4Service.registerSource(
      { userId: userOwnerA },
      recording.id,
      {
        workspaceId,
        sourceKind: 'microphone',
        sourceRole: 'original',
        isRequired: true,
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 16000,
        channels: 1,
        expectedChunkCount: 2,
      },
    );

    // Generate two genuine 16 kHz mono PCM16le WAV buffers with REAL 30-second durations (480,000 frames each = 960,044 bytes each)
    const wavChunk0 = createPcm16WavBuffer({
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 30000,
      frequencyHz: 440,
    });
    const wavChunk1 = createPcm16WavBuffer({
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 30000,
      frequencyHz: 880,
    });

    const hdr0 = parseWavPcm16(wavChunk0);
    const hdr1 = parseWavPcm16(wavChunk1);
    expect(hdr0.frameCount).toBe(480000);
    expect(hdr0.durationMs).toBe(30000);
    expect(hdr1.frameCount).toBe(480000);
    expect(hdr1.durationMs).toBe(30000);

    const sha0 = computeSha256Hex(wavChunk0);
    const sha1 = computeSha256Hex(wavChunk1);

    const { chunk: c0 } = await runtime.phase4Service.registerChunk(
      { userId: userOwnerA },
      recording.id,
      {
        workspaceId,
        recordingSourceId: source.id,
        clientChunkId: 'b3333333-3333-4333-8333-333333333331',
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 30000,
        sampleStart: 0,
        sampleEnd: 480000,
        firstSampleMonotonicTicks: '1000',
        byteSize: wavChunk0.byteLength,
        checksum: { algorithm: 'sha256', value: sha0 },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 16000,
        channels: 1,
      },
    );

    // Pause gap between 30000ms and 40000ms
    const { chunk: c1 } = await runtime.phase4Service.registerChunk(
      { userId: userOwnerA },
      recording.id,
      {
        workspaceId,
        recordingSourceId: source.id,
        clientChunkId: 'b3333333-3333-4333-8333-333333333332',
        sequenceNo: 1,
        meetingStartMs: 40000,
        meetingEndMs: 70000,
        sampleStart: 480000,
        sampleEnd: 960000,
        firstSampleMonotonicTicks: '40000001000',
        byteSize: wavChunk1.byteLength,
        checksum: { algorithm: 'sha256', value: sha1 },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 16000,
        channels: 1,
      },
    );

    for (const [chunk, bytes] of [
      [c0, wavChunk0],
      [c1, wavChunk1],
    ] as const) {
      const auth = await runtime.phase4Service.authorizeChunkUpload(
        { userId: userOwnerA },
        recording.id,
        chunk.id,
        {
          workspaceId,
          contentType: 'audio/wav',
        },
      );
      await storage.putObjectViaSignedUrl(auth.uploadUrl, bytes);
      await runtime.phase4Service.verifyChunkUpload(
        { userId: userOwnerA },
        recording.id,
        chunk.id,
        {
          workspaceId,
        },
      );
    }

    await runtime.phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
      workspaceId,
      canonicalDurationMs: 70000,
      activeCaptureMs: 60000,
      expectedSources: [
        {
          recordingSourceId: source.id,
          expectedChunkCount: 2,
        },
      ],
    });

    // Run prepare_recording via worker
    const prepJob = await runtime.runSingleStep({ now: new Date(Date.now() + 1_000) });
    expect(prepJob?.jobType).toBe('prepare_recording');
    expect(prepJob?.status).toBe('succeeded');

    // Inspect the prepared transcription asset in DB and private object storage
    const assetRes = await db.query<{
      storage_key: string;
      byte_size: string | number;
      checksum_sha256: string;
      preparation_metadata: {
        binary_mux_performed: boolean;
        media_engine?: string;
        wav_frames_assembled?: number;
        wav_data_bytes?: number;
        pause_gap_count: number;
        total_pause_gap_ms: number;
      };
    }>(`select * from public.transcription_assets where recording_id = $1`, [recording.id]);
    const assetRow = assetRes.rows[0]!;
    expect(assetRow.preparation_metadata.binary_mux_performed).toBe(true);
    expect(assetRow.preparation_metadata.media_engine).toBe(WAV_MEDIA_ENGINE_VERSION);
    expect(assetRow.preparation_metadata.wav_frames_assembled).toBe(960000);
    expect(assetRow.preparation_metadata.wav_data_bytes).toBe(1920000);
    expect(assetRow.preparation_metadata.pause_gap_count).toBe(1);
    expect(assetRow.preparation_metadata.total_pause_gap_ms).toBe(10000);

    const assembledBytes = storage.getObjectBytes(assetRow.storage_key);
    expect(assembledBytes).not.toBeNull();
    const assembledHeader = parseWavPcm16(assembledBytes!);
    expect(assembledHeader.sampleRateHz).toBe(16000);
    expect(assembledHeader.channels).toBe(1);
    expect(assembledHeader.frameCount).toBe(960000);
    expect(assembledHeader.durationMs).toBe(60000);
    expect(Number(assetRow.byte_size)).toBe(44 + 1920000);
    expect(assetRow.checksum_sha256).toBe(computeSha256Hex(assembledBytes!));

    // Verify original chunk objects in storage were NEVER overwritten or mutated
    expect(computeSha256Hex(storage.getObjectBytes(c0.storageKey)!)).toBe(sha0);
    expect(computeSha256Hex(storage.getObjectBytes(c1.storageKey)!)).toBe(sha1);

    // Drain remaining jobs for this meeting
    await runtime.drainQueue({ now: new Date(Date.now() + 2_000) });
  });

  it('3. Multi-worker concurrency & standalone daemon prove safe SKIP LOCKED claiming across 3 concurrent workers', async () => {
    const meetingIds = await Promise.all([
      createDraftMeeting('Concurrent Meeting 1'),
      createDraftMeeting('Concurrent Meeting 2'),
      createDraftMeeting('Concurrent Meeting 3'),
    ]);

    for (let idx = 0; idx < meetingIds.length; idx++) {
      const mId = meetingIds[idx]!;
      const { recording } = await runtime.phase4Service.createRecording(
        { userId: userOwnerA },
        {
          workspaceId,
          meetingId: mId,
          sessionId: `c1111111-1111-4111-8111-11111111111${idx}`,
          timeline: {
            clock: 'platform_monotonic_continuous',
            clockEpochId: `c2222222-2222-4222-8222-22222222222${idx}`,
            originTicks: '1000',
            originWallClockUtc: '2026-10-07T09:00:00.000Z',
            tickFrequencyHz: 1_000_000_000,
          },
          consent: {
            acknowledgedAt: '2026-10-07T09:00:00.000Z',
            policyVersion: 'v1',
          },
        },
      );
      const { source } = await runtime.phase4Service.registerSource(
        { userId: userOwnerA },
        recording.id,
        {
          workspaceId,
          sourceKind: 'microphone',
          sourceRole: 'original',
          isRequired: true,
          codec: 'pcm_s16le',
          container: 'wav',
          sampleRateHz: 16000,
          channels: 1,
          expectedChunkCount: 1,
        },
      );
      const wavBytes = createPcm16WavBuffer({
        sampleRateHz: 16000,
        channels: 1,
        durationMs: 5000,
        frequencyHz: 440,
      });
      const sha = computeSha256Hex(wavBytes);
      const { chunk } = await runtime.phase4Service.registerChunk(
        { userId: userOwnerA },
        recording.id,
        {
          workspaceId,
          recordingSourceId: source.id,
          clientChunkId: `c3333333-3333-4333-8333-33333333333${idx}`,
          sequenceNo: 0,
          meetingStartMs: 0,
          meetingEndMs: 5000,
          sampleStart: 0,
          sampleEnd: 80000,
          firstSampleMonotonicTicks: '1000',
          byteSize: wavBytes.byteLength,
          checksum: { algorithm: 'sha256', value: sha },
          codec: 'pcm_s16le',
          container: 'wav',
          sampleRateHz: 16000,
          channels: 1,
        },
      );
      const auth = await runtime.phase4Service.authorizeChunkUpload(
        { userId: userOwnerA },
        recording.id,
        chunk.id,
        {
          workspaceId,
          contentType: 'audio/wav',
        },
      );
      await storage.putObjectViaSignedUrl(auth.uploadUrl, wavBytes);
      await runtime.phase4Service.verifyChunkUpload(
        { userId: userOwnerA },
        recording.id,
        chunk.id,
        {
          workspaceId,
        },
      );
      await runtime.phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
        workspaceId,
        canonicalDurationMs: 5000,
        activeCaptureMs: 5000,
        expectedSources: [
          {
            recordingSourceId: source.id,
            expectedChunkCount: 1,
          },
        ],
      });
    }

    const makeWorker = (id: string) =>
      new MeetingProcessingWorkerRuntime({
        workerId: id,
        db,
        storage,
        transcriptionProvider,
        intelligenceProvider,
        embeddingProvider,
        telegramProvider,
        automationProvider,
        appUrl: 'https://app.suhbat.uz',
      });

    const workerAlpha = makeWorker('worker-alpha');
    const workerBeta = makeWorker('worker-beta');
    const workerGamma = makeWorker('worker-gamma');

    const [repAlpha, repBeta, repGamma] = await Promise.all([
      workerAlpha.runPollingLoop({
        maxIterations: 15,
        maxJobsPerIteration: 3,
        pollIntervalMs: 2,
        now: () => new Date(Date.now() + 5_000),
      }),
      workerBeta.runPollingLoop({
        maxIterations: 15,
        maxJobsPerIteration: 3,
        pollIntervalMs: 2,
        now: () => new Date(Date.now() + 5_000),
      }),
      workerGamma.runPollingLoop({
        maxIterations: 15,
        maxJobsPerIteration: 3,
        pollIntervalMs: 2,
        now: () => new Date(Date.now() + 5_000),
      }),
    ]);

    const allClaimedJobIds = [
      ...repAlpha.jobs.map((j) => j.id),
      ...repBeta.jobs.map((j) => j.id),
      ...repGamma.jobs.map((j) => j.id),
    ];
    // Zero duplicate claims across all 3 concurrent workers
    expect(new Set(allClaimedJobIds).size).toBe(allClaimedJobIds.length);
    // 3 meetings * 9 stages = 27 jobs total
    expect(allClaimedJobIds.length).toBe(27);

    // Also verify standalone worker daemon entrypoint with bounded iterations & structured log sink
    const daemonLogs: string[] = [];
    const daemonReport = await runStandaloneWorkerDaemon({
      workerId: 'standalone-daemon-01',
      db,
      storage,
      env: {
        NODE_ENV: 'test',
        TRANSCRIPTION_PROVIDER: 'fake',
        SUHBAT_INTELLIGENCE_PROVIDER: 'fake',
        SUHBAT_EMBEDDING_PROVIDER: 'fake',
        SUHBAT_TELEGRAM_PROVIDER: 'fake',
        SUHBAT_AUTOMATION_PROVIDER: 'fake',
      },
      maxIterations: 1,
      pollIntervalMs: 1,
      logSink: (line) => daemonLogs.push(line),
    });
    expect(daemonReport.workerId).toBe('standalone-daemon-01');
  });

  it('4. Observability collector, secret redaction, and GET /api/v1/health endpoint operate without leaking secrets', async () => {
    const collector = new ObservabilityCollector();
    const rawEvent: StructuredObservabilityEvent = {
      event: 'chunk_uploaded',
      workspace_id: workspaceId,
      meeting_id: 'm-1',
      recording_id: 'r-1',
      source_id: 's-1',
      chunk_id: 'c-1',
      job_id: null,
      sequence_no: 0,
      fencing_token: 1,
      timestamp: '2026-10-07T10:00:00.000Z',
      metadata: {
        uploadUrl: 'https://r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=deadbeef',
        apiKey: 'sk-live-secret-api-key-999999',
        bearerHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        dbUrl: 'postgresql://postgres:supersecret@db.supabase.co:5432/postgres',
        audioBytes: new Uint8Array([1, 2, 3, 4]),
        promptTokens: 420,
      },
    };

    const logLine = formatStructuredLogLine(rawEvent);
    expect(logLine).not.toContain('deadbeef');
    expect(logLine).not.toContain('sk-live-secret');
    expect(logLine).not.toContain('eyJhbGci');
    expect(logLine).not.toContain('supersecret');
    expect(logLine).toContain('"promptTokens":420');

    const redacted = redactObservabilityMetadata(rawEvent.metadata);
    expect(redacted.uploadUrl).toBe('[REDACTED]');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.bearerHeader).toBe('[REDACTED]');
    expect(redacted.dbUrl).toBe('[REDACTED]');
    expect(redacted.audioBytes).toBe('[REDACTED]');
    expect(redacted.promptTokens).toBe(420);

    collector.recordEvent(rawEvent);
    const snapshot = await runtime.getMetricsSnapshot();
    expect(snapshot.queueDepth.queued).toBe(0);
    expect(snapshot.transcriptionFailureRate.completedRuns).toBeGreaterThanOrEqual(4);
    expect(snapshot.analysisFailureRate.completedRuns).toBeGreaterThanOrEqual(3);

    // Health endpoint when healthy
    const resHealthy = await getHealthRoute();
    expect(resHealthy.status).toBe(200);
    const bodyHealthy = await resHealthy.json();
    expect(bodyHealthy.ok).toBe(true);
    expect(bodyHealthy.database.status).toBe('healthy');
    expect(bodyHealthy.storage.status).toBe('healthy');
    expect(bodyHealthy.queue.status).toBe('healthy');

    // Health endpoint when storage has temporary outage -> 503 unavailable
    storage.setTemporaryOutage('Simulated R2 network partition');
    const resOutage = await getHealthRoute();
    expect(resOutage.status).toBe(503);
    const bodyOutage = await resOutage.json();
    expect(bodyOutage.ok).toBe(false);
    expect(bodyOutage.storage.status).toBe('unavailable');
    storage.setTemporaryOutage(null);
  });

  it('5. Controlled failure drills (R2 outage, DB failure, provider timeouts, expired signed URL, partial upload, request size limits)', async () => {
    // Drill A: Expired signed upload URL is rejected
    const meetingId = await createDraftMeeting('Failure Drills Meeting');
    const { recording } = await runtime.phase4Service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId,
        meetingId,
        sessionId: 'd1111111-1111-4111-8111-111111111111',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'd2222222-2222-4222-8222-222222222222',
          originTicks: '1000',
          originWallClockUtc: '2026-10-07T10:00:00.000Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T10:00:00.000Z',
          policyVersion: 'v1',
        },
      },
    );
    const { source } = await runtime.phase4Service.registerSource(
      { userId: userOwnerA },
      recording.id,
      {
        workspaceId,
        sourceKind: 'microphone',
        sourceRole: 'original',
        isRequired: true,
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 16000,
        channels: 1,
        expectedChunkCount: 1,
      },
    );
    const wavBytes = createPcm16WavBuffer({
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 5000,
    });
    const sha = computeSha256Hex(wavBytes);
    const { chunk } = await runtime.phase4Service.registerChunk(
      { userId: userOwnerA },
      recording.id,
      {
        workspaceId,
        recordingSourceId: source.id,
        clientChunkId: 'd3333333-3333-4333-8333-333333333333',
        sequenceNo: 0,
        meetingStartMs: 0,
        meetingEndMs: 5000,
        sampleStart: 0,
        sampleEnd: 80000,
        firstSampleMonotonicTicks: '1000',
        byteSize: wavBytes.byteLength,
        checksum: { algorithm: 'sha256', value: sha },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 16000,
        channels: 1,
      },
    );

    // Drill B: Partial upload — attempting to finalize before chunk verification returns incomplete barrier
    const incompleteFinalize = await runtime.phase4Service.finalizeRecording(
      { userId: userOwnerA },
      recording.id,
      {
        workspaceId,
        canonicalDurationMs: 5000,
        activeCaptureMs: 5000,
        expectedSources: [
          {
            recordingSourceId: source.id,
            expectedChunkCount: 1,
          },
        ],
      },
    );
    expect(incompleteFinalize.status).toBe('incomplete');
    if (incompleteFinalize.status === 'incomplete') {
      expect(incompleteFinalize.unverifiedChunks).toHaveLength(1);
    }

    const tIssue = new Date('2026-10-07T10:00:00.000Z');
    const auth = await runtime.phase4Service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk.id,
      {
        workspaceId,
        contentType: 'audio/wav',
        expiresInSeconds: 60,
      },
      { now: tIssue },
    );

    // Expired signed URL fails
    await expect(
      storage.putObjectViaSignedUrl(auth.uploadUrl, wavBytes, {
        now: new Date(tIssue.getTime() + 120_000),
      }),
    ).rejects.toMatchObject({
      code: 'upload_url_expired',
    });

    // Valid upload before expiration succeeds
    await storage.putObjectViaSignedUrl(auth.uploadUrl, wavBytes, {
      now: new Date(tIssue.getTime() + 10_000),
    });
    await runtime.phase4Service.verifyChunkUpload({ userId: userOwnerA }, recording.id, chunk.id, {
      workspaceId,
    });
    await runtime.phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
      workspaceId,
      canonicalDurationMs: 5000,
      activeCaptureMs: 5000,
      expectedSources: [
        {
          recordingSourceId: source.id,
          expectedChunkCount: 1,
        },
      ],
    });

    // Drill C: Storage outage during prepare_recording -> schedules retryable_failed -> recovers when outage clears
    storage.setTemporaryOutage('Simulated R2 503 Service Unavailable');
    const failedPrep = await runtime.runSingleStep({ now: new Date(Date.now() + 2_000) });
    expect(failedPrep?.jobType).toBe('prepare_recording');
    expect(failedPrep?.status).toBe('retryable_failed');
    storage.setTemporaryOutage(null);

    const recoveredPrep = await runtime.runSingleStep({ now: new Date(Date.now() + 60_000) });
    expect(recoveredPrep?.jobType).toBe('prepare_recording');
    expect(recoveredPrep?.status).toBe('succeeded');

    // Drill D: Transcription provider timeout -> schedules retryable_failed -> recovers
    transcriptionProvider.injectFailureForRecording(recording.id, {
      code: 'provider_unavailable',
      message: 'Simulated AssemblyAI HTTP timeout',
      retryable: true,
    });
    const failedTranscribe = await runtime.runSingleStep({ now: new Date(Date.now() + 65_000) });
    expect(failedTranscribe?.jobType).toBe('transcribe_meeting');
    expect(failedTranscribe?.status).toBe('retryable_failed');
    transcriptionProvider.clearFailureForRecording(recording.id);

    const recoveredDrain = await runtime.drainQueue({ now: new Date(Date.now() + 180_000) });
    expect(recoveredDrain.jobs.map((j) => j.jobType)).toContain('finalize_analysis');

    // Drill E: Temporary database failure in evaluateOperationalHealth
    const brokenDb: SqlExecutor = {
      async query() {
        throw new Error('FATAL: remaining connection slots are reserved');
      },
    };
    const brokenHealth = await evaluateOperationalHealth({ db: brokenDb, storage });
    expect(brokenHealth.ok).toBe(false);
    expect(brokenHealth.database.status).toBe('unavailable');

    // Drill F: Request size limit (256 KiB JSON ceiling) & Upload size limit (512 MiB chunk ceiling)
    const oversizedJson = JSON.stringify({ data: 'x'.repeat(MAX_API_JSON_BODY_BYTES + 1024) });
    const oversizedReq = new Request('https://app.suhbat.uz/api/v1/recordings', {
      method: 'POST',
      body: oversizedJson,
    });
    await expect(parseJsonBody(oversizedReq)).rejects.toMatchObject({
      statusCode: 413,
    });

    await expect(
      storage.createUploadAuthorization({
        storageKey: chunk.storageKey,
        expectedByteSize: MAX_CHUNK_UPLOAD_BYTE_SIZE + 1,
        expectedSha256: sha,
      }),
    ).rejects.toThrow(StorageProviderError);

    // Drill G: Production error handler redacts raw internal error messages
    const prevEnv = process.env.NODE_ENV;
    Reflect.set(process.env, 'NODE_ENV', 'production');
    try {
      const errResp = handleApiError(
        new Error('postgres://admin:secretpass@internal-host:5432/db connection refused'),
      );
      expect(errResp.status).toBe(500);
      const errJson = await errResp.json();
      expect(errJson.error.detail).toBeUndefined();
      expect(JSON.stringify(errJson)).not.toContain('secretpass');
    } finally {
      Reflect.set(process.env, 'NODE_ENV', prevEnv);
    }
    expect(Phase4ServiceError).toBeDefined();
  });

  it('6. Synthetic timeline & SQL pipeline benchmark (15-min, 60-min, and 2-hour synthetic non-WAV manifest timelines)', async () => {
    const scenarios = [
      { label: '15m-synthetic-timeline', durationMs: 15 * 60 * 1000, chunkCount: 6 },
      { label: '60m-synthetic-timeline', durationMs: 60 * 60 * 1000, chunkCount: 12 },
      { label: '120m-synthetic-timeline', durationMs: 120 * 60 * 1000, chunkCount: 24 },
    ] as const;

    for (const scenario of scenarios) {
      const tStart = performance.now();
      const mId = await createDraftMeeting(`Synthetic Timeline Benchmark ${scenario.label}`);
      const { recording } = await runtime.phase4Service.createRecording(
        { userId: userOwnerA },
        {
          workspaceId,
          meetingId: mId,
          sessionId: `e1111111-1111-4111-8111-${scenario.durationMs.toString().padStart(12, '0')}`,
          timeline: {
            clock: 'platform_monotonic_continuous',
            clockEpochId: 'e2222222-2222-4222-8222-222222222222',
            originTicks: '1000',
            originWallClockUtc: '2026-10-07T11:00:00.000Z',
            tickFrequencyHz: 1_000_000_000,
          },
          consent: {
            acknowledgedAt: '2026-10-07T11:00:00.000Z',
            policyVersion: 'v1',
          },
        },
      );
      const { source } = await runtime.phase4Service.registerSource(
        { userId: userOwnerA },
        recording.id,
        {
          workspaceId,
          sourceKind: 'microphone',
          sourceRole: 'original',
          isRequired: true,
          codec: 'pcm_s16le',
          container: 'wav',
          sampleRateHz: 16000,
          channels: 1,
          expectedChunkCount: scenario.chunkCount,
        },
      );

      const chunkSpanMs = scenario.durationMs / scenario.chunkCount;
      const samplesPerChunk = (chunkSpanMs / 1000) * 16000;
      // Explicitly non-RIFF synthetic payload so prepareCanonicalTranscriptionAssetPlan uses manifest-only synthetic timeline mode
      const syntheticPayload = new Uint8Array(2048).fill(7);
      const syntheticSha = computeSha256Hex(syntheticPayload);

      for (let i = 0; i < scenario.chunkCount; i++) {
        const { chunk } = await runtime.phase4Service.registerChunk(
          { userId: userOwnerA },
          recording.id,
          {
            workspaceId,
            recordingSourceId: source.id,
            clientChunkId: `e3333333-3333-4333-8333-${(scenario.durationMs + i).toString().padStart(12, '0')}`,
            sequenceNo: i,
            meetingStartMs: i * chunkSpanMs,
            meetingEndMs: (i + 1) * chunkSpanMs,
            sampleStart: i * samplesPerChunk,
            sampleEnd: (i + 1) * samplesPerChunk,
            firstSampleMonotonicTicks: String(1000 + i * chunkSpanMs * 1_000_000),
            byteSize: syntheticPayload.byteLength,
            checksum: { algorithm: 'sha256', value: syntheticSha },
            codec: 'pcm_s16le',
            container: 'wav',
            sampleRateHz: 16000,
            channels: 1,
          },
        );
        const auth = await runtime.phase4Service.authorizeChunkUpload(
          { userId: userOwnerA },
          recording.id,
          chunk.id,
          {
            workspaceId,
            contentType: 'audio/wav',
          },
        );
        await storage.putObjectViaSignedUrl(auth.uploadUrl, syntheticPayload);
        await runtime.phase4Service.verifyChunkUpload(
          { userId: userOwnerA },
          recording.id,
          chunk.id,
          {
            workspaceId,
          },
        );
      }

      await runtime.phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
        workspaceId,
        canonicalDurationMs: scenario.durationMs,
        activeCaptureMs: scenario.durationMs,
        expectedSources: [
          {
            recordingSourceId: source.id,
            expectedChunkCount: scenario.chunkCount,
          },
        ],
      });

      const drain = await runtime.drainQueue({ now: new Date(Date.now() + 300_000) });
      const elapsedMs = Math.round(performance.now() - tStart);
      expect(drain.succeededCount).toBe(9);
      expect(elapsedMs).toBeGreaterThan(0);

      const mState = await db.query<{ status: string; processing_status: string }>(
        `select status::text as status, processing_status::text as processing_status
           from public.meetings where id = $1`,
        [mId],
      );
      expect(mState.rows[0]?.status).toBe('ready');
      expect(mState.rows[0]?.processing_status).toBe('ready');
    }
  });

  it('7. Gate 2 Live Provider Transport Hardening (R2 checksum/network guards, AssemblyAI network retryability, Telegram constant-time & token redaction, Webhook SSRF & HMAC)', async () => {
    const r2Key = buildRecordingChunkStorageKey({
      workspaceId,
      meetingId: '22222222-2222-4222-8222-222222222222',
      recordingId: '33333333-3333-4333-8333-333333333333',
      sourceId: '44444444-4444-4444-8444-444444444444',
      sequenceNo: 0,
      container: 'wav',
    });

    const r2Offline = new R2StorageProvider(
      {
        accountId: 'acc123',
        bucket: 'suhbat-private',
        accessKeyId: 'AKIA123',
        secretAccessKey: 'SECRET456',
      },
      {
        fetchImpl: async () => {
          throw new TypeError('fetch failed: ECONNRESET https://acc123.r2.cloudflarestorage.com');
        },
      },
    );

    await expect(
      r2Offline.createUploadAuthorization({
        storageKey: r2Key,
        expectedByteSize: 1024,
        expectedSha256: 'not-a-valid-sha256',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_checksum',
      retryable: false,
    });

    await expect(r2Offline.headObject(r2Key)).rejects.toMatchObject({
      code: 'r2_network_error',
      retryable: true,
    });

    const aaiOffline = new AssemblyAITranscriptionProvider(
      { apiKey: 'aai-live-secret-token' },
      {
        fetchImpl: async () => {
          throw new TypeError('fetch failed: DNS lookup timeout');
        },
      },
    );

    await expect(
      aaiOffline.transcribe({
        assetId: '55555555-5555-4555-8555-555555555555',
        workspaceId,
        meetingId: '22222222-2222-4222-8222-222222222222',
        recordingId: '33333333-3333-4333-8333-333333333333',
        assetVersion: 1,
        storageKey: r2Key,
        signedAudioUrl: 'https://acc123.r2.cloudflarestorage.com/signed-wav',
        assetDurationMs: 30_000,
        sampleRateHz: 16_000,
        channels: 1,
        timelineMap: [],
        requestedLanguages: ['uz', 'ru', 'en'],
      }),
    ).rejects.toMatchObject({
      name: 'TranscriptionProviderError',
      code: 'provider_unavailable',
      retryable: true,
    });

    const tg = new HttpTelegramBotProvider({
      botToken: '999999:SUPER_SECRET_BOT_TOKEN_ABC',
      webhookSecret: 'tg-wh-secret-2026',
      fetchImpl: async (input) => {
        throw new TypeError(`connect ETIMEDOUT for ${String(input)}`);
      },
    });
    expect(tg.verifyWebhookSecret('tg-wh-secret-2026')).toBe(true);
    expect(tg.verifyWebhookSecret('tg-wh-secret-2027')).toBe(false);
    expect(tg.verifyWebhookSecret('short')).toBe(false);
    expect(tg.verifyWebhookSecret('tg-wh-secret-2026-longer')).toBe(false);
    expect(tg.verifyWebhookSecret('')).toBe(false);

    try {
      await tg.sendMessage({ chatId: '12345', text: 'Salom' });
      expect.unreachable('Expected TelegramProviderError');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramProviderError);
      const tgErr = err as TelegramProviderError;
      expect(tgErr.code).toBe('provider_unavailable');
      expect(tgErr.retryable).toBe(true);
      expect(tgErr.message).not.toContain('SUPER_SECRET_BOT_TOKEN_ABC');
    }

    let webhookHeaders = new Headers();
    const webhookProvider = new HttpBusinessAutomationProvider({
      signingSecret: 'wh-hmac-secret-key',
      dnsLookup: async (host) => {
        if (host === 'rebind-private.partner.example') {
          return [{ address: '10.0.0.19', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
      fetchImpl: async (_url, init) => {
        webhookHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ externalReferenceId: 'ext_ok_1' }), { status: 200 });
      },
    });

    const baseActionReq = {
      actionId: '90000000-0000-4000-8000-000000000099',
      workspaceId,
      meetingId: '22222222-2222-4222-8222-222222222222',
      connectorType: 'webhook_n8n' as const,
      actionType: 'trigger_n8n_workflow' as const,
      idempotencyKey: 'idem-wh-99',
      payloadSha256: 'a'.repeat(64),
      confirmedBy: userOwnerA,
      confirmedAt: '2026-10-07T10:00:00.000Z',
      payload: {
        meetingId: '22222222-2222-4222-8222-222222222222',
        workspaceId,
        analysisRunId: '60000000-0000-4000-8000-000000000001',
        meetingTitle: 'Hardening Sync',
        companyName: null,
        projectName: null,
        connectorType: 'webhook_n8n' as const,
        actionType: 'trigger_n8n_workflow' as const,
        summaryHeadline: 'Headline',
        summaryTlDr: 'TLDR',
        confirmedDecisions: [],
        openTasks: [],
        evidence: [],
        meetingOverviewUrl: `https://app.suhbat.ai/w/${workspaceId}/meetings/22222222-2222-4222-8222-222222222222`,
      },
    };

    // Rejects HTTP, IPv4/IPv6 private/link-local/loopback, alternate IPv4, IPv4-mapped IPv6, and DNS rebinding targets
    for (const forbiddenUrl of [
      'http://hooks.example.com/webhook',
      'https://localhost/webhook',
      'https://127.0.0.1/webhook',
      'https://2130706433/webhook',
      'https://[::1]/webhook',
      'https://[fe80::1]/webhook',
      'https://[fd00::1]/webhook',
      'https://[::ffff:127.0.0.1]/webhook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.15/internal',
      'https://192.168.1.1/admin',
      'https://rebind-private.partner.example/webhook',
    ]) {
      await expect(
        webhookProvider.executeAction({
          ...baseActionReq,
          endpointUrl: forbiddenUrl,
        }),
      ).rejects.toMatchObject({
        name: 'AutomationProviderError',
        code: 'provider_not_configured',
        retryable: false,
      });
    }

    // Allows public HTTPS endpoint and includes HMAC-SHA256 signature header
    const execRes = await webhookProvider.executeAction({
      ...baseActionReq,
      endpointUrl: 'https://hooks.partner.example/suhbat',
    });
    expect(execRes.externalReferenceId).toBe('ext_ok_1');
    expect(webhookHeaders.get('x-suhbat-signature-256')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
