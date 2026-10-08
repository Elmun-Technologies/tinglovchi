import { validateProductionEnvironment } from './production-env.ts';
import { runStandaloneWorkerDaemon } from './worker-cli.ts';
import { getWorkerExecutor } from './worker-executor.ts';
import { createStorageProviderFromEnv } from './storage.ts';

/**
 * Runnable entrypoint for the **worker** role.
 *
 * This is the background processing service and nothing else. It claims jobs, runs transcription,
 * runs meeting intelligence, builds embeddings, indexes knowledge, fires automations, and reconciles
 * storage. It holds `SUPABASE_DB_URL` and every provider credential.
 *
 * It has no HTTP surface at all — no request from a user ever reaches this process. That is the
 * point: the component holding the AssemblyAI and OpenAI keys should not be reachable from the
 * internet, and the component that is reachable from the internet should not hold them.
 *
 * Run with:
 *
 *   SUHBAT_RUNTIME_ROLE=worker node --import tsx packages/database/src/worker-daemon.ts
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const role = (env.SUHBAT_RUNTIME_ROLE ?? '').trim().toLowerCase();
  if (role !== 'worker') {
    throw new Error(
      `This process must run with SUHBAT_RUNTIME_ROLE=worker (got "${role || 'unset'}"). ` +
        'The web app and the recording-api are separate deployments.',
    );
  }

  // Fail closed at boot rather than on the first job.
  validateProductionEnvironment(env, { role: 'worker', throwOnError: true });

  const db = await getWorkerExecutor({ role: 'worker', env });
  if (!db) {
    throw new Error('worker requires SUPABASE_DB_URL.');
  }

  const report = await runStandaloneWorkerDaemon({
    db,
    storage: createStorageProviderFromEnv(env),
    env,
  });

  process.stdout.write(
    `${JSON.stringify({
      event: 'worker.daemon_exited',
      workerId: report.workerId,
      claimed: report.claimedCount,
      succeeded: report.succeededCount,
      retryableFailed: report.retryableFailedCount,
      deadLettered: report.deadLetteredCount,
      reconciledDeletions: report.reconciledDeletions,
    })}\n`,
  );
}

// Only run when invoked directly, so tests can import `main` without starting the loop.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${JSON.stringify({ event: 'worker.fatal', message })}\n`);
    process.exit(1);
  });
}
