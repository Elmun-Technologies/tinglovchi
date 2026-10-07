import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeBusinessAutomationProvider } from '@suhbat/database/automation-provider';
import { FakeEmbeddingProvider } from '@suhbat/database/embedding-provider';
import { FakeMeetingIntelligenceProvider } from '@suhbat/database/intelligence-provider';
import { computeSha256Hex, MemoryStorageProvider } from '@suhbat/database/storage';
import { FakeTelegramBotProvider } from '@suhbat/database/telegram-provider';
import { FakeTranscriptionProvider } from '@suhbat/database/transcription-provider';
import { MeetingProcessingWorkerRuntime } from '@suhbat/database/worker';

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
    email text unique not null,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

describe('Phase 11 Unified Durable Worker Runtime & Full Pipeline E2E', () => {
  let db: PGlite;
  let storage: MemoryStorageProvider;
  let transcriptionProvider: FakeTranscriptionProvider;
  let intelligenceProvider: FakeMeetingIntelligenceProvider;
  let embeddingProvider: FakeEmbeddingProvider;
  let telegramProvider: FakeTelegramBotProvider;
  let automationProvider: FakeBusinessAutomationProvider;
  let runtime: MeetingProcessingWorkerRuntime;

  let workspaceId: string;
  let companyId: string;
  let projectId: string;
  let meetingTypeId: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(authBootstrap);
    for (const path of migrationPaths) {
      await db.exec(readFileSync(path, 'utf8'));
    }
    await db.exec(readFileSync(seedPath, 'utf8'));

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, 'owner-a@example.com', '{"full_name":"Owner A"}'::jsonb)`,
      [userOwnerA],
    );

    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userOwnerA]);
    await db.exec('set role authenticated');
    const wsRes = await db.query<{ id: string }>(
      `select public.create_workspace('Suhbat Unified Worker WS', 'suhbat-unified-worker-ws') as id`,
    );
    workspaceId = wsRes.rows[0]!.id;

    const compRes = await db.query<{ id: string }>(
      `insert into public.companies (workspace_id, name, created_by)
       values ($1, 'Samarkand Logistics Corp', $2) returning id`,
      [workspaceId, userOwnerA],
    );
    companyId = compRes.rows[0]!.id;

    const projRes = await db.query<{ id: string }>(
      `insert into public.projects (workspace_id, company_id, name, created_by)
       values ($1, $2, 'Fleet Modernization 2026', $3) returning id`,
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
      workerId: 'unified-worker-01',
      db,
      storage,
      transcriptionProvider,
      intelligenceProvider,
      embeddingProvider,
      telegramProvider,
      automationProvider,
      appUrl: 'https://app.suhbat.ai',
    });
  });

  it('drains the entire Phase 4 → 5 → 6 → 7 → 8 → 9 pipeline in a single drainQueue call and reconciles storage deletion failures', async () => {
    // 1. Link Telegram account for Owner A so Phase 8 notifications are enqueued after analysis finalizes
    const linkToken = await runtime.phase8Service.createLinkToken(
      { userId: userOwnerA },
      workspaceId,
      {},
    );
    await runtime.phase8Service.handleBotUpdate('fake-telegram-webhook-secret', {
      updateId: 9001,
      message: {
        messageId: 1,
        date: 1791367200,
        from: { id: '880011', firstName: 'Owner', username: 'owner_a_uz' },
        chat: { id: '880011', type: 'private' },
        text: `/start ${linkToken.rawToken}`,
      },
    });

    // 2. Create meeting & finalize recording
    const mtgRes = await db.query<{ id: string }>(
      `insert into public.meetings (workspace_id, company_id, project_id, meeting_type_id, title, created_by)
       values ($1, $2, $3, $4, 'Samarkand Fleet Contract Finalization', $5) returning id`,
      [workspaceId, companyId, projectId, meetingTypeId, userOwnerA],
    );
    const meetingId = mtgRes.rows[0]!.id;

    const { recording } = await runtime.phase4Service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId,
        meetingId,
        sessionId: 'b1000000-0000-4000-8000-000000000001',
        startedAt: '2026-10-07T09:00:00Z',
        timeline: {
          clock: 'platform_monotonic_continuous',
          clockEpochId: 'boot-unified-1',
          originTicks: '1000000000',
          originWallClockUtc: '2026-10-07T09:00:00Z',
          tickFrequencyHz: 1_000_000_000,
        },
        consent: {
          acknowledgedAt: '2026-10-07T08:59:55Z',
          policyVersion: 'v1',
        },
      },
    );

    const { source } = await runtime.phase4Service.registerSource(
      { userId: userOwnerA },
      recording.id,
      {
        sourceKind: 'microphone',
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48000,
        channels: 1,
        expectedChunkCount: 1,
      },
    );

    const bytes = new Uint8Array(2048);
    bytes.fill(11);
    const sha256 = computeSha256Hex(bytes);

    const { chunk } = await runtime.phase4Service.registerChunk(
      { userId: userOwnerA },
      recording.id,
      {
        recordingSourceId: source.id,
        sequenceNo: 0,
        idempotencyKey: `${recording.id}:${source.id}:0`,
        meetingStartMs: 0,
        meetingEndMs: 30000,
        durationMs: 30000,
        sampleStart: 0,
        sampleEnd: 1440000,
        byteSize: bytes.byteLength,
        checksum: { algorithm: 'sha256', value: sha256 },
        codec: 'pcm_s16le',
        container: 'wav',
        sampleRateHz: 48000,
        channels: 1,
      },
    );

    const uploadAuth = await runtime.phase4Service.authorizeChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk.id,
      {},
    );
    await storage.putObjectViaSignedUrl(uploadAuth.uploadUrl, bytes);
    await runtime.phase4Service.verifyChunkUpload(
      { userId: userOwnerA },
      recording.id,
      chunk.id,
      {},
    );
    await runtime.phase4Service.finalizeRecording({ userId: userOwnerA }, recording.id, {
      workspaceId,
      stoppedAt: '2026-10-07T09:00:30Z',
      canonicalDurationMs: 30000,
      activeCaptureMs: 30000,
      manifestRevision: 2,
    });

    // 3. Drain the queue via MeetingProcessingWorkerRuntime!
    const drain1 = await runtime.drainQueue({
      now: new Date(Date.now() + 2_000),
    });

    expect(drain1.jobs.map((j) => j.jobType)).toEqual([
      'prepare_recording',
      'transcribe_meeting',
      'normalize_transcript',
      'finalize_transcript',
      'analyze_meeting',
      'normalize_intelligence',
      'finalize_analysis',
      'generate_embeddings',
      'index_knowledge',
      'send_telegram_notifications',
    ]);
    expect(drain1.succeededCount).toBe(10);
    expect(telegramProvider.getSentMessages().length).toBeGreaterThanOrEqual(1);

    // 4. Prepare and confirm a queued Phase 9 business automation action, then run runPollingLoop!
    const prepared = await runtime.phase9Service.prepareAutomationAction(
      { userId: userOwnerA },
      meetingId,
      {
        connectorType: 'webhook_n8n',
        actionType: 'trigger_n8n_workflow',
        idempotencyKey: 'unified-worker-n8n-001',
      },
    );
    await runtime.phase9Service.confirmAutomationAction(
      { userId: userOwnerA },
      meetingId,
      prepared.action.id,
      {
        confirmed: true,
        confirmationToken: prepared.confirmationToken!,
        executeImmediately: false,
      },
    );

    const pollReport = await runtime.runPollingLoop({
      maxIterations: 2,
      pollIntervalMs: 5,
      now: () => new Date(Date.now() + 5_000),
    });
    expect(pollReport.jobs.map((j) => j.jobType)).toContain('execute_automation_action');
    expect(automationProvider.getExecutedActions()).toHaveLength(1);

    // 5. Simulate a transient storage delete failure during deleteRecording, then reconcile via runtime.reconcilePendingDeletions!
    storage.failDeleteForKey(chunk.storageKey, 'Simulated transient S3 delete outage');
    const delAttempt = await runtime.phase4Service.deleteRecording(
      { userId: userOwnerA },
      recording.id,
    );
    expect(delAttempt.status).toBe('reconciliation_required');
    expect(delAttempt.reconciliationPendingCount).toBe(1);

    storage.clearDeleteFailureForKey(chunk.storageKey);
    const reconciled = await runtime.reconcilePendingDeletions();
    expect(reconciled.scannedCount).toBe(1);
    expect(reconciled.deletedCount).toBe(1);
    expect(reconciled.finalizedRecordingsCount).toBe(1);
  });
});
