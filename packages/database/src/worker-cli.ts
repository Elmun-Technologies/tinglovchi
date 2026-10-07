import { validateProductionEnvironment } from './config.ts';
import { formatStructuredLogLine } from './observability.ts';
import type { SqlExecutor, StructuredObservabilityEvent } from './phase4-backbone.ts';
import { createStorageProviderFromEnv, type StorageProvider } from './storage.ts';
import { MeetingProcessingWorkerRuntime, type WorkerDrainReport } from './worker-runtime.ts';

export type StandaloneWorkerDaemonOptions = {
  workerId?: string;
  db: SqlExecutor;
  storage?: StorageProvider;
  env?: Record<string, string | undefined>;
  pollIntervalMs?: number;
  maxIterations?: number;
  maxJobsPerIteration?: number;
  logSink?: (jsonLine: string) => void;
};

/**
 * Boots `MeetingProcessingWorkerRuntime` as an independent long-running worker service
 * with fail-closed production validation, structured JSON logging, and graceful SIGINT/SIGTERM shutdown.
 */
export async function runStandaloneWorkerDaemon(
  options: StandaloneWorkerDaemonOptions,
): Promise<WorkerDrainReport> {
  const env = options.env ?? process.env;
  if (env.NODE_ENV === 'production') {
    validateProductionEnvironment(env, { role: 'worker', throwOnError: true });
  }

  const workerId =
    options.workerId?.trim() || env.WORKER_ID?.trim() || `suhbat-worker-${process.pid}`;
  const storage = options.storage ?? createStorageProviderFromEnv(env);
  const pollIntervalMs =
    options.pollIntervalMs ??
    (env.WORKER_POLL_INTERVAL_MS ? Number.parseInt(env.WORKER_POLL_INTERVAL_MS, 10) : 1000);
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const maxJobsPerIteration = options.maxJobsPerIteration ?? 25;
  const logSink =
    options.logSink ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  const controller = new AbortController();
  const runtime = new MeetingProcessingWorkerRuntime({
    workerId,
    db: options.db,
    storage,
    env,
    appUrl: env.APP_URL,
    onEvent: (event: StructuredObservabilityEvent) => {
      logSink(formatStructuredLogLine(event, { worker_id: workerId }));
    },
  });

  const handleSignal = () => {
    runtime.stop();
    controller.abort();
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    return await runtime.runPollingLoop({
      maxIterations,
      maxJobsPerIteration,
      pollIntervalMs,
      reconcileDeletions: true,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }
}
