import type { ProcessingJobDto } from '@suhbat/contracts';
import {
  createBusinessAutomationProviderFromEnv,
  type BusinessAutomationProvider,
} from './automation-provider.ts';
import { createEmbeddingProviderFromEnv, type EmbeddingProvider } from './embedding-provider.ts';
import {
  createMeetingIntelligenceProviderFromEnv,
  type MeetingIntelligenceProvider,
} from './intelligence-provider.ts';
import {
  evaluateOperationalHealth,
  ObservabilityCollector,
  type ObservabilityMetricsSnapshot,
  type OperationalHealthReport,
} from './observability.ts';
import {
  Phase4BackboneService,
  type ObservabilitySink,
  type SqlExecutor,
  type StructuredObservabilityEvent,
} from './phase4-backbone.ts';
import { Phase5TranscriptionService } from './phase5-transcription.ts';
import { Phase6IntelligenceService } from './phase6-intelligence.ts';
import { Phase7KnowledgeService } from './phase7-knowledge.ts';
import { Phase8TelegramService } from './phase8-telegram.ts';
import { Phase9AutomationService, Phase9AutomationWorker } from './phase9-automation.ts';
import type { StorageProvider } from './storage.ts';
import { createTelegramBotProviderFromEnv, type TelegramBotProvider } from './telegram-provider.ts';
import {
  createTranscriptionProviderFromEnv,
  type TranscriptionProvider,
} from './transcription-provider.ts';

export type WorkerDrainReport = {
  workerId: string;
  claimedCount: number;
  succeededCount: number;
  retryableFailedCount: number;
  deadLetteredCount: number;
  reconciledDeletions: number;
  jobs: ProcessingJobDto[];
};

export type ReconcileDeletionsReport = {
  scannedCount: number;
  deletedCount: number;
  failedCount: number;
  finalizedRecordingsCount: number;
};

export type WorkerPollingOptions = {
  maxIterations?: number;
  maxJobsPerIteration?: number;
  pollIntervalMs?: number;
  reconcileDeletions?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
};

export type MeetingProcessingWorkerRuntimeOptions = {
  workerId?: string;
  db: SqlExecutor;
  storage: StorageProvider;
  env?: Record<string, string | undefined>;
  transcriptionProvider?: TranscriptionProvider;
  intelligenceProvider?: MeetingIntelligenceProvider;
  embeddingProvider?: EmbeddingProvider;
  telegramProvider?: TelegramBotProvider;
  automationProvider?: BusinessAutomationProvider;
  appUrl?: string;
  onEvent?: ObservabilitySink;
};

/**
 * Unified Durable Meeting Processing Worker Runtime (`workers/meeting-processing` / `@suhbat/database/worker`).
 *
 * Orchestrates all durable PostgreSQL job stages across Phases 4–9:
 *  - `prepare_recording`
 *  - `transcribe_meeting`
 *  - `normalize_transcript`
 *  - `finalize_transcript`
 *  - `analyze_meeting`
 *  - `normalize_intelligence`
 *  - `finalize_analysis`
 *  - `generate_embeddings`
 *  - `index_knowledge`
 *  - `send_telegram_notifications`
 *  - `execute_automation_action`
 * Plus background reconciliation of `public.object_deletion_ledger` entries.
 */
export class MeetingProcessingWorkerRuntime {
  readonly workerId: string;
  readonly db: SqlExecutor;
  readonly storage: StorageProvider;
  readonly observability: ObservabilityCollector;
  readonly phase4Service: Phase4BackboneService;
  readonly phase5Service: Phase5TranscriptionService;
  readonly phase6Service: Phase6IntelligenceService;
  readonly phase7Service: Phase7KnowledgeService;
  readonly phase8Service: Phase8TelegramService;
  readonly phase9Service: Phase9AutomationService;
  readonly worker: Phase9AutomationWorker;

  private stopRequested = false;

  constructor(options: MeetingProcessingWorkerRuntimeOptions) {
    this.workerId = options.workerId?.trim() || 'suhbat-worker-1';
    this.db = options.db;
    this.storage = options.storage;
    this.observability = new ObservabilityCollector();

    const combinedSink: ObservabilitySink = (event: StructuredObservabilityEvent) => {
      this.observability.recordEvent(event);
      options.onEvent?.(event);
    };

    const env = options.env ?? process.env;
    const transcriptionProvider =
      options.transcriptionProvider ?? createTranscriptionProviderFromEnv(env);
    const intelligenceProvider =
      options.intelligenceProvider ?? createMeetingIntelligenceProviderFromEnv(env);
    const embeddingProvider = options.embeddingProvider ?? createEmbeddingProviderFromEnv(env);
    const telegramProvider = options.telegramProvider ?? createTelegramBotProviderFromEnv(env);
    const automationProvider =
      options.automationProvider ?? createBusinessAutomationProviderFromEnv(env);

    this.phase4Service = new Phase4BackboneService({
      db: options.db,
      storage: options.storage,
      onEvent: combinedSink,
    });
    this.phase5Service = new Phase5TranscriptionService({
      phase4: this.phase4Service,
      provider: transcriptionProvider,
      onEvent: combinedSink,
    });
    this.phase6Service = new Phase6IntelligenceService({
      db: options.db,
      phase5: this.phase5Service,
      intelligenceProvider,
      onEvent: combinedSink,
    });
    this.phase7Service = new Phase7KnowledgeService({
      db: options.db,
      phase6: this.phase6Service,
      embeddingProvider,
      onEvent: combinedSink,
    });
    this.phase8Service = new Phase8TelegramService({
      db: options.db,
      phase7: this.phase7Service,
      telegramProvider,
      appUrl: options.appUrl,
      onEvent: combinedSink,
    });
    this.phase9Service = new Phase9AutomationService({
      db: options.db,
      phase8: this.phase8Service,
      automationProvider,
      appUrl: options.appUrl,
      onEvent: combinedSink,
    });
    this.worker = new Phase9AutomationWorker(this.phase9Service);
  }

  stop(): void {
    this.stopRequested = true;
  }

  async getMetricsSnapshot(now?: Date): Promise<ObservabilityMetricsSnapshot> {
    return this.observability.collectSnapshot(this.db, now);
  }

  async getHealthReport(now?: Date): Promise<OperationalHealthReport> {
    return evaluateOperationalHealth({
      db: this.db,
      storage: this.storage,
      now,
    });
  }

  /**
   * Claims and executes a single eligible job across all pipeline stages.
   */
  async runSingleStep(options: { now?: Date } = {}): Promise<ProcessingJobDto | null> {
    return this.worker.runNextJob(this.workerId, {
      now: options.now,
    });
  }

  /**
   * Reconciles pending or retryable storage object deletions from `public.object_deletion_ledger`.
   */
  async reconcilePendingDeletions(
    options: { limit?: number; now?: Date } = {},
  ): Promise<ReconcileDeletionsReport> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));

    const pendingRes = await this.db.query<{
      id: string;
      workspace_id: string;
      meeting_id: string;
      recording_id: string;
      recording_chunk_id: string | null;
      storage_backend: string;
      storage_key: string;
    }>(
      `select id, workspace_id, meeting_id, recording_id, recording_chunk_id, storage_backend, storage_key
         from public.object_deletion_ledger
        where status in ('pending', 'reconciliation_required')
        order by created_at asc
        limit $1`,
      [limit],
    );

    let deletedCount = 0;
    let failedCount = 0;
    const touchedRecordings = new Map<string, { workspaceId: string; meetingId: string }>();

    for (const entry of pendingRes.rows) {
      touchedRecordings.set(entry.recording_id, {
        workspaceId: entry.workspace_id,
        meetingId: entry.meeting_id,
      });
      try {
        await this.storage.deleteObject(entry.storage_key);
        await this.db.query(
          `update public.object_deletion_ledger
              set status = 'deleted',
                  attempt_count = attempt_count + 1,
                  completed_at = $2,
                  last_error_code = null,
                  last_error_message = null
            where id = $1`,
          [entry.id, nowIso],
        );
        deletedCount += 1;
      } catch (cause) {
        failedCount += 1;
        const errCode =
          cause && typeof cause === 'object' && 'code' in cause
            ? String((cause as { code: unknown }).code)
            : 'storage_delete_failed';
        const errMsg = cause instanceof Error ? cause.message : String(cause);
        await this.db.query(
          `update public.object_deletion_ledger
              set status = 'reconciliation_required',
                  attempt_count = attempt_count + 1,
                  last_error_code = $2,
                  last_error_message = $3
            where id = $1`,
          [entry.id, errCode.slice(0, 80), errMsg.slice(0, 500)],
        );
      }
    }

    let finalizedRecordingsCount = 0;
    for (const [recordingId, meta] of touchedRecordings.entries()) {
      const remainingRes = await this.db.query<{ count: string | number }>(
        `select count(*) as count
           from public.object_deletion_ledger
          where recording_id = $1
            and status <> 'deleted'`,
        [recordingId],
      );
      const remaining = Number(remainingRes.rows[0]?.count ?? 0);
      if (remaining === 0) {
        const kcReg = await this.db.query<{ reg: string | null }>(
          `select to_regclass('public.knowledge_chunks')::text as reg`,
        );
        if (kcReg.rows[0]?.reg) {
          await this.db.query(`delete from public.knowledge_chunks where meeting_id = $1`, [
            meta.meetingId,
          ]);
          await this.db.query(
            `update public.meetings
                set current_embedding_run_id = null,
                    current_analysis_run_id = null,
                    current_transcription_run_id = null
              where id = $1
                and workspace_id = $2`,
            [meta.meetingId, meta.workspaceId],
          );
        }
        await this.db.query(`delete from public.recording_chunks where recording_id = $1`, [
          recordingId,
        ]);
        await this.db.query(`delete from public.recording_sources where recording_id = $1`, [
          recordingId,
        ]);
        await this.db.query(
          `update public.recordings
              set status = 'deleted',
                  deleted_at = $2
            where id = $1`,
          [recordingId, nowIso],
        );
        await this.db.query(
          `update public.meetings
              set status = 'draft',
                  processing_status = 'idle',
                  purge_status = 'active'
            where id = $1
              and workspace_id = $2`,
          [meta.meetingId, meta.workspaceId],
        );
        finalizedRecordingsCount += 1;
      }
    }

    return {
      scannedCount: pendingRes.rows.length,
      deletedCount,
      failedCount,
      finalizedRecordingsCount,
    };
  }

  /**
   * Drains up to `maxJobs` ready jobs in sequence and optionally reconciles pending storage deletions.
   */
  async drainQueue(
    options: {
      maxJobs?: number;
      now?: Date;
      reconcileDeletions?: boolean;
    } = {},
  ): Promise<WorkerDrainReport> {
    const maxJobs = Math.max(1, Math.min(options.maxJobs ?? 50, 500));
    const jobs: ProcessingJobDto[] = [];
    let succeededCount = 0;
    let retryableFailedCount = 0;
    let deadLetteredCount = 0;

    for (let i = 0; i < maxJobs; i += 1) {
      if (this.stopRequested) break;
      const executed = await this.runSingleStep({
        now: options.now,
      });
      if (!executed) break;
      jobs.push(executed);
      if (executed.status === 'succeeded') succeededCount += 1;
      else if (executed.status === 'retryable_failed') retryableFailedCount += 1;
      else if (executed.status === 'dead_lettered') deadLetteredCount += 1;
    }

    let reconciledDeletions = 0;
    if (options.reconcileDeletions ?? true) {
      const delReport = await this.reconcilePendingDeletions({ now: options.now });
      reconciledDeletions = delReport.deletedCount;
    }

    return {
      workerId: this.workerId,
      claimedCount: jobs.length,
      succeededCount,
      retryableFailedCount,
      deadLetteredCount,
      reconciledDeletions,
      jobs,
    };
  }

  /**
   * Runs a bounded or continuous worker polling loop until `stop()` / `signal.aborted` or `maxIterations`.
   */
  async runPollingLoop(options: WorkerPollingOptions = {}): Promise<WorkerDrainReport> {
    this.stopRequested = false;
    const maxIterations = options.maxIterations ?? 10;
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 50);
    const aggregate: WorkerDrainReport = {
      workerId: this.workerId,
      claimedCount: 0,
      succeededCount: 0,
      retryableFailedCount: 0,
      deadLetteredCount: 0,
      reconciledDeletions: 0,
      jobs: [],
    };

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (this.stopRequested || options.signal?.aborted) {
        break;
      }
      const now = options.now ? options.now() : new Date();
      const batch = await this.drainQueue({
        maxJobs: options.maxJobsPerIteration ?? 25,
        now,
        reconcileDeletions: options.reconcileDeletions ?? true,
      });
      aggregate.claimedCount += batch.claimedCount;
      aggregate.succeededCount += batch.succeededCount;
      aggregate.retryableFailedCount += batch.retryableFailedCount;
      aggregate.deadLetteredCount += batch.deadLetteredCount;
      aggregate.reconciledDeletions += batch.reconciledDeletions;
      aggregate.jobs.push(...batch.jobs);

      if (this.stopRequested || options.signal?.aborted) {
        break;
      }
      if (batch.claimedCount === 0 && pollIntervalMs > 0 && iteration + 1 < maxIterations) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    return aggregate;
  }
}
