import {
  redactObservabilityMetadata,
  type SqlExecutor,
  type StructuredObservabilityEvent,
} from './phase4-backbone';
import type { StorageProvider } from './storage';

export type ObservabilityMetricsSnapshot = {
  jobLatencyMs: {
    count: number;
    totalMs: number;
    avgMs: number;
    maxMs: number;
  };
  queueDepth: {
    queued: number;
    running: number;
    retryableFailed: number;
    totalRunnable: number;
  };
  retryCount: number;
  deadLetterJobs: number;
  providerLatencyMs: {
    transcriptionAvgMs: number;
    intelligenceAvgMs: number;
    embeddingAvgMs: number;
    totalCalls: number;
  };
  providerErrors: {
    total: number;
    byStage: Record<string, number>;
  };
  chunkUploadFailureRate: {
    verifiedCount: number;
    failedCount: number;
    failureRate: number;
  };
  transcriptionFailureRate: {
    completedRuns: number;
    failedRuns: number;
    failureRate: number;
  };
  analysisFailureRate: {
    completedRuns: number;
    failedRuns: number;
    failureRate: number;
  };
  deletionReconciliationBacklog: {
    pendingCount: number;
    reconciliationRequiredCount: number;
    totalBacklog: number;
  };
  capturedAt: string;
};

export type ComponentHealthStatus =
  'healthy' | 'degraded' | 'unavailable' | 'idle' | 'not_configured';

export type OperationalHealthReport = {
  ok: boolean;
  overallStatus: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
  webApi: {
    status: 'healthy';
    dataMode: string;
    nodeEnv: string;
    uptimeSeconds: number;
  };
  database: {
    status: ComponentHealthStatus;
    latencyMs: number | null;
    migrationCount: number | null;
  };
  worker: {
    status: ComponentHealthStatus;
    activeRunningJobs: number;
    expiredLeaseJobs: number;
    latestHeartbeatAt: string | null;
  };
  queue: {
    status: ComponentHealthStatus;
    queuedJobs: number;
    retryableFailedJobs: number;
    deadLetteredJobs: number;
    deletionReconciliationBacklog: number;
  };
  storage: {
    status: ComponentHealthStatus;
    backend: string | null;
    latencyMs: number | null;
  };
};

const CANONICAL_STORAGE_PROBE_KEY =
  'workspace/00000000-0000-4000-8000-000000000000/meetings/00000000-0000-4000-8000-000000000000/recordings/00000000-0000-4000-8000-000000000000/sources/00000000-0000-4000-8000-000000000000/chunks/000000.wav';

/**
 * Formats a production-safe structured JSON log line with strict secret/token/signed-URL/audio-byte redaction.
 */
export function formatStructuredLogLine(
  event: StructuredObservabilityEvent,
  extra?: Record<string, unknown>,
): string {
  const safeMetadata = redactObservabilityMetadata({
    ...event.metadata,
    ...(extra ?? {}),
  });
  return JSON.stringify({
    level:
      event.event.includes('failed') ||
      event.event.includes('dead_lettered') ||
      event.event.includes('reconciliation_required')
        ? 'warn'
        : 'info',
    service: 'suhbat-ai',
    event: event.event,
    workspace_id: event.workspace_id,
    meeting_id: event.meeting_id,
    recording_id: event.recording_id,
    source_id: event.source_id,
    chunk_id: event.chunk_id,
    job_id: event.job_id,
    sequence_no: event.sequence_no,
    fencing_token: event.fencing_token,
    metadata: safeMetadata,
    timestamp: event.timestamp,
  });
}

/**
 * Production-safe observability collector tracking job latency, queue depth, retries, dead-letter jobs,
 * provider latency/errors, chunk upload failures, transcription/analysis failure rates, and deletion reconciliation backlog.
 */
export class ObservabilityCollector {
  private readonly jobClaimStartedAtMs = new Map<string, number>();
  private readonly jobLatenciesMs: number[] = [];
  private readonly providerLatencies = {
    transcription: [] as number[],
    intelligence: [] as number[],
    embedding: [] as number[],
  };
  private readonly providerErrorsByStage: Record<string, number> = {};
  private retryEventsCount = 0;
  private deadLetterEventsCount = 0;
  private chunkVerifiedEventsCount = 0;
  private chunkFailedEventsCount = 0;
  private readonly structuredLogs: string[] = [];
  private readonly sink?: (jsonLine: string) => void;

  constructor(options: { sink?: (jsonLine: string) => void } = {}) {
    this.sink = options.sink;
  }

  recordEvent(event: StructuredObservabilityEvent): void {
    const line = formatStructuredLogLine(event);
    this.structuredLogs.push(line);
    if (this.structuredLogs.length > 2000) {
      this.structuredLogs.shift();
    }
    this.sink?.(line);

    const tsMs = Date.parse(event.timestamp) || Date.now();
    if (event.event === 'job_claimed' && event.job_id) {
      this.jobClaimStartedAtMs.set(event.job_id, tsMs);
    } else if (
      (event.event === 'job_succeeded' ||
        event.event === 'job_failed' ||
        event.event === 'job_dead_lettered') &&
      event.job_id
    ) {
      const startedMs = this.jobClaimStartedAtMs.get(event.job_id);
      const explicitLatency =
        typeof event.metadata.latency_ms === 'number'
          ? event.metadata.latency_ms
          : typeof event.metadata.duration_ms === 'number'
            ? event.metadata.duration_ms
            : null;
      const computedMs =
        explicitLatency !== null
          ? Math.max(0, explicitLatency)
          : startedMs !== undefined
            ? Math.max(0, tsMs - startedMs)
            : 0;
      this.jobLatenciesMs.push(computedMs);
      this.jobClaimStartedAtMs.delete(event.job_id);
    }

    if (event.event === 'job_retry_scheduled') {
      this.retryEventsCount += 1;
    }
    if (event.event === 'job_dead_lettered') {
      this.deadLetterEventsCount += 1;
    }
    if (event.event === 'chunk_verified') {
      this.chunkVerifiedEventsCount += 1;
    }
    if (event.event === 'chunk_verification_failed') {
      this.chunkFailedEventsCount += 1;
    }

    const providerLatency =
      typeof event.metadata.provider_latency_ms === 'number'
        ? event.metadata.provider_latency_ms
        : typeof event.metadata.latency_ms === 'number'
          ? event.metadata.latency_ms
          : null;

    if (event.event === 'transcription_completed' && providerLatency !== null) {
      this.providerLatencies.transcription.push(providerLatency);
    } else if (event.event === 'analysis_completed' && providerLatency !== null) {
      this.providerLatencies.intelligence.push(providerLatency);
    } else if (event.event === 'embeddings_completed' && providerLatency !== null) {
      this.providerLatencies.embedding.push(providerLatency);
    }

    if (
      event.event === 'transcription_failed' ||
      event.event === 'analysis_failed' ||
      event.event === 'embeddings_failed' ||
      event.event === 'telegram_notification_failed' ||
      event.event === 'automation_action_failed'
    ) {
      this.providerErrorsByStage[event.event] = (this.providerErrorsByStage[event.event] ?? 0) + 1;
    }
  }

  recordProviderLatency(
    stage: 'transcription' | 'intelligence' | 'embedding',
    latencyMs: number,
  ): void {
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.providerLatencies[stage].push(latencyMs);
    }
  }

  getStructuredLogs(): readonly string[] {
    return this.structuredLogs;
  }

  async collectSnapshot(
    db?: SqlExecutor | null,
    now: Date = new Date(),
  ): Promise<ObservabilityMetricsSnapshot> {
    let queued = 0;
    let running = 0;
    let retryableFailed = 0;
    let dbRetries = 0;
    let dbDeadLetter = 0;
    let dbVerifiedChunks = 0;
    let dbFailedChunks = 0;
    let trCompleted = 0;
    let trFailed = 0;
    let anCompleted = 0;
    let anFailed = 0;
    let delPending = 0;
    let delReconciliationRequired = 0;

    if (db) {
      const jobsRes = await db.query<{
        status: string;
        cnt: string | number;
        retries: string | number;
      }>(
        `select status::text as status,
                count(*) as cnt,
                coalesce(sum(greatest(attempt - 1, 0)), 0) as retries
           from public.processing_jobs
          group by status`,
      );
      for (const row of jobsRes.rows) {
        const cnt = Number(row.cnt ?? 0);
        dbRetries += Number(row.retries ?? 0);
        if (row.status === 'queued') queued += cnt;
        else if (row.status === 'running') running += cnt;
        else if (row.status === 'retryable_failed') retryableFailed += cnt;
        else if (row.status === 'dead_lettered') dbDeadLetter += cnt;
      }

      const chunksRes = await db.query<{
        verification_state: string;
        cnt: string | number;
      }>(
        `select verification_state::text as verification_state,
                count(*) as cnt
           from public.recording_chunks
          group by verification_state`,
      );
      for (const row of chunksRes.rows) {
        const cnt = Number(row.cnt ?? 0);
        if (row.verification_state === 'verified') dbVerifiedChunks += cnt;
        else if (row.verification_state === 'failed') dbFailedChunks += cnt;
      }

      const trReg = await db.query<{ reg: string | null }>(
        `select to_regclass('public.transcription_runs')::text as reg`,
      );
      if (trReg.rows[0]?.reg) {
        const trRes = await db.query<{
          status: string;
          cnt: string | number;
          avg_ms: string | number | null;
        }>(
          `select status::text as status,
                  count(*) as cnt,
                  avg(extract(epoch from (completed_at - started_at)) * 1000) as avg_ms
             from public.transcription_runs
            group by status`,
        );
        for (const row of trRes.rows) {
          const cnt = Number(row.cnt ?? 0);
          if (row.status === 'completed') {
            trCompleted += cnt;
            if (
              this.providerLatencies.transcription.length === 0 &&
              row.avg_ms !== null &&
              Number.isFinite(Number(row.avg_ms))
            ) {
              this.providerLatencies.transcription.push(
                Math.max(0, Math.round(Number(row.avg_ms))),
              );
            }
          } else if (row.status === 'failed') {
            trFailed += cnt;
          }
        }
      }

      const anReg = await db.query<{ reg: string | null }>(
        `select to_regclass('public.analysis_runs')::text as reg`,
      );
      if (anReg.rows[0]?.reg) {
        const anRes = await db.query<{
          status: string;
          cnt: string | number;
          avg_ms: string | number | null;
        }>(
          `select status::text as status,
                  count(*) as cnt,
                  avg(extract(epoch from (completed_at - started_at)) * 1000) as avg_ms
             from public.analysis_runs
            group by status`,
        );
        for (const row of anRes.rows) {
          const cnt = Number(row.cnt ?? 0);
          if (row.status === 'completed') {
            anCompleted += cnt;
            if (
              this.providerLatencies.intelligence.length === 0 &&
              row.avg_ms !== null &&
              Number.isFinite(Number(row.avg_ms))
            ) {
              this.providerLatencies.intelligence.push(Math.max(0, Math.round(Number(row.avg_ms))));
            }
          } else if (row.status === 'failed') {
            anFailed += cnt;
          }
        }
      }

      const ledgerRes = await db.query<{
        status: string;
        cnt: string | number;
      }>(
        `select status::text as status,
                count(*) as cnt
           from public.object_deletion_ledger
          where status in ('pending', 'reconciliation_required')
          group by status`,
      );
      for (const row of ledgerRes.rows) {
        const cnt = Number(row.cnt ?? 0);
        if (row.status === 'pending') delPending += cnt;
        else if (row.status === 'reconciliation_required') delReconciliationRequired += cnt;
      }
    }

    const totalLatencies = this.jobLatenciesMs.reduce((a, b) => a + b, 0);
    const jobCount = this.jobLatenciesMs.length;
    const avgJobLatencyMs = jobCount > 0 ? Math.round(totalLatencies / jobCount) : 0;
    const maxJobLatencyMs = jobCount > 0 ? Math.max(...this.jobLatenciesMs) : 0;

    const avgOf = (arr: readonly number[]): number =>
      arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    const verifiedCount = Math.max(dbVerifiedChunks, this.chunkVerifiedEventsCount);
    const failedChunkCount = Math.max(dbFailedChunks, this.chunkFailedEventsCount);
    const totalChunkAttempts = verifiedCount + failedChunkCount;

    const totalTrRuns = trCompleted + trFailed;
    const totalAnRuns = anCompleted + anFailed;

    const totalProviderErrors = Object.values(this.providerErrorsByStage).reduce(
      (a, b) => a + b,
      0,
    );

    return {
      jobLatencyMs: {
        count: jobCount,
        totalMs: totalLatencies,
        avgMs: avgJobLatencyMs,
        maxMs: maxJobLatencyMs,
      },
      queueDepth: {
        queued,
        running,
        retryableFailed,
        totalRunnable: queued + retryableFailed,
      },
      retryCount: Math.max(dbRetries, this.retryEventsCount),
      deadLetterJobs: Math.max(dbDeadLetter, this.deadLetterEventsCount),
      providerLatencyMs: {
        transcriptionAvgMs: avgOf(this.providerLatencies.transcription),
        intelligenceAvgMs: avgOf(this.providerLatencies.intelligence),
        embeddingAvgMs: avgOf(this.providerLatencies.embedding),
        totalCalls:
          this.providerLatencies.transcription.length +
          this.providerLatencies.intelligence.length +
          this.providerLatencies.embedding.length,
      },
      providerErrors: {
        total: totalProviderErrors,
        byStage: { ...this.providerErrorsByStage },
      },
      chunkUploadFailureRate: {
        verifiedCount,
        failedCount: failedChunkCount,
        failureRate:
          totalChunkAttempts > 0 ? Number((failedChunkCount / totalChunkAttempts).toFixed(4)) : 0,
      },
      transcriptionFailureRate: {
        completedRuns: trCompleted,
        failedRuns: trFailed,
        failureRate: totalTrRuns > 0 ? Number((trFailed / totalTrRuns).toFixed(4)) : 0,
      },
      analysisFailureRate: {
        completedRuns: anCompleted,
        failedRuns: anFailed,
        failureRate: totalAnRuns > 0 ? Number((anFailed / totalAnRuns).toFixed(4)) : 0,
      },
      deletionReconciliationBacklog: {
        pendingCount: delPending,
        reconciliationRequiredCount: delReconciliationRequired,
        totalBacklog: delPending + delReconciliationRequired,
      },
      capturedAt: now.toISOString(),
    };
  }
}

/**
 * Evaluates operational health across Web/API, Database, Worker, Queue, and Object Storage
 * without exposing any secrets, tokens, or connection strings.
 */
export async function evaluateOperationalHealth(
  params: {
    db?: SqlExecutor | null;
    storage?: StorageProvider | null;
    dataMode?: string;
    nodeEnv?: string;
    now?: Date;
  } = {},
): Promise<OperationalHealthReport> {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const dataMode = params.dataMode ?? process.env.SUHBAT_DATA_MODE ?? 'demo';
  const nodeEnv = params.nodeEnv ?? process.env.NODE_ENV ?? 'development';

  let dbStatus: ComponentHealthStatus = 'not_configured';
  let dbLatencyMs: number | null = null;
  let migrationCount: number | null = null;

  let workerStatus: ComponentHealthStatus = 'not_configured';
  let activeRunningJobs = 0;
  let expiredLeaseJobs = 0;
  let latestHeartbeatAt: string | null = null;

  let queueStatus: ComponentHealthStatus = 'not_configured';
  let queuedJobs = 0;
  let retryableFailedJobs = 0;
  let deadLetteredJobs = 0;
  let deletionReconciliationBacklog = 0;

  if (params.db) {
    const t0 = Date.now();
    try {
      await params.db.query('select 1 as ok');
      dbLatencyMs = Math.max(0, Date.now() - t0);
      dbStatus = 'healthy';

      const tablesRes = await params.db.query<{ cnt: string | number }>(
        `select count(*) as cnt
           from information_schema.tables
          where table_schema = 'public'`,
      );
      migrationCount = Number(tablesRes.rows[0]?.cnt ?? 0);

      const workerRes = await params.db.query<{
        active_running: string | number;
        expired_running: string | number;
        latest_hb: string | null;
      }>(
        `select count(*) filter (where status = 'running' and lease_expires_at > $1::timestamptz) as active_running,
                count(*) filter (where status = 'running' and lease_expires_at <= $1::timestamptz) as expired_running,
                max(heartbeat_at)::text as latest_hb
           from public.processing_jobs`,
        [nowIso],
      );
      activeRunningJobs = Number(workerRes.rows[0]?.active_running ?? 0);
      expiredLeaseJobs = Number(workerRes.rows[0]?.expired_running ?? 0);
      latestHeartbeatAt = workerRes.rows[0]?.latest_hb ?? null;
      workerStatus = expiredLeaseJobs > 0 ? 'degraded' : activeRunningJobs > 0 ? 'healthy' : 'idle';

      const qRes = await params.db.query<{
        queued: string | number;
        retryable_failed: string | number;
        dead_lettered: string | number;
      }>(
        `select count(*) filter (where status = 'queued') as queued,
                count(*) filter (where status = 'retryable_failed') as retryable_failed,
                count(*) filter (where status = 'dead_lettered') as dead_lettered
           from public.processing_jobs`,
      );
      queuedJobs = Number(qRes.rows[0]?.queued ?? 0);
      retryableFailedJobs = Number(qRes.rows[0]?.retryable_failed ?? 0);
      deadLetteredJobs = Number(qRes.rows[0]?.dead_lettered ?? 0);

      const delRes = await params.db.query<{ cnt: string | number }>(
        `select count(*) as cnt
           from public.object_deletion_ledger
          where status in ('pending', 'reconciliation_required')`,
      );
      deletionReconciliationBacklog = Number(delRes.rows[0]?.cnt ?? 0);

      queueStatus =
        deadLetteredJobs > 0 || deletionReconciliationBacklog > 10 ? 'degraded' : 'healthy';
    } catch {
      dbStatus = 'unavailable';
      workerStatus = 'unavailable';
      queueStatus = 'unavailable';
    }
  }

  let storageStatus: ComponentHealthStatus = 'not_configured';
  let storageBackend: string | null = null;
  let storageLatencyMs: number | null = null;

  if (params.storage) {
    storageBackend = params.storage.backend;
    const t0 = Date.now();
    try {
      await params.storage.headObject(CANONICAL_STORAGE_PROBE_KEY);
      storageLatencyMs = Math.max(0, Date.now() - t0);
      storageStatus = 'healthy';
    } catch {
      storageStatus = 'unavailable';
    }
  }

  const anyUnavailable = dbStatus === 'unavailable' || storageStatus === 'unavailable';
  const anyDegraded = workerStatus === 'degraded' || queueStatus === 'degraded';

  const overallStatus: OperationalHealthReport['overallStatus'] = anyUnavailable
    ? 'unavailable'
    : anyDegraded
      ? 'degraded'
      : 'healthy';

  return {
    ok: overallStatus !== 'unavailable',
    overallStatus,
    checkedAt: nowIso,
    webApi: {
      status: 'healthy',
      dataMode,
      nodeEnv,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    database: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
      migrationCount,
    },
    worker: {
      status: workerStatus,
      activeRunningJobs,
      expiredLeaseJobs,
      latestHeartbeatAt,
    },
    queue: {
      status: queueStatus,
      queuedJobs,
      retryableFailedJobs,
      deadLetteredJobs,
      deletionReconciliationBacklog,
    },
    storage: {
      status: storageStatus,
      backend: storageBackend,
      latencyMs: storageLatencyMs,
    },
  };
}
