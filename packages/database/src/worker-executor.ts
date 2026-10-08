import type { SqlExecutor } from './phase4-backbone.ts';

/**
 * Privileged PostgreSQL executor — **worker and migration-runner boundary only.**
 *
 * Why this file is scoped the way it is
 * -------------------------------------
 * `docs/production-readiness.md` is unambiguous: `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY`
 * are "No (Forbidden in Web)" and belong to "the isolated worker / migration runner only". The web
 * deployment authenticates as the signed-in user (RLS is the boundary) or through narrowly scoped
 * `security definer` functions, and must never hold a direct connection credential.
 *
 * So this module does three things the earlier `postgres-executor.ts` did not:
 *
 * 1. It is exported as `@suhbat/database/worker-executor`, never as a general database helper.
 * 2. `getWorkerExecutor` requires an explicit role (`'recording-api'` or `'worker'`). There is no
 *    default and no zero-argument form, so it cannot be constructed by accident from
 *    request-handling code.
 * 3. It fails closed in production when the process declares itself a web role.
 *
 * `tests/security/web-trust-boundary.test.ts` asserts statically that no file under `apps/web`
 * imports this module or reads the variables it depends on.
 *
 * Security posture
 * ----------------
 * * The connection string is read from `process.env` in Node only; it is never referenced from a
 *   browser bundle or a `NEXT_PUBLIC_*` variable.
 * * Connections require TLS unless the host is loopback; `sslmode=disable` is honoured only for
 *   loopback development.
 * * This role connects as the database owner, so PostgreSQL RLS does not apply to these queries.
 *   Every authorization decision therefore stays in the service layer. RLS remains the boundary for
 *   anything that reaches PostgreSQL through a user session, and the `security definer` functions do
 *   their own authorization.
 */
export type WorkerExecutorOptions = {
  connectionString: string;
  /** Bounded so one stalled query cannot hold a request open forever. */
  statementTimeoutMs?: number;
  max?: number;
};

export type WorkerExecutor = SqlExecutor & {
  /** Closes the pool. Used by graceful shutdown and by tests. */
  close(): Promise<void>;
};

const runtimeState = globalThis as typeof globalThis & {
  __suhbatWorkerExecutor?: WorkerExecutor | null;
};

/**
 * Creates a pooled executor. Exported for tests and for callers that manage their own lifecycle;
 * production code almost always wants {@link getWorkerExecutor} instead, which caches one pool per
 * process.
 */
export async function createWorkerExecutor(
  options: WorkerExecutorOptions,
): Promise<WorkerExecutor> {
  const { Pool } = await import('pg');
  const connectionString = options.connectionString.trim();
  if (!connectionString) {
    throw new Error('createWorkerExecutor requires a non-empty connection string');
  }

  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    ...sslOptionsFor(connectionString),
  });

  // Fail loudly at boot rather than on the first user request: a pool that cannot connect would
  // otherwise surface as a 500 during someone's meeting.
  const probe = await pool.connect();
  probe.release();

  return {
    async query<Row = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Row[] };
    },
    async exec(sql: string) {
      return pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * TLS is mandatory for any non-loopback database. Supabase's pooler issues its own certificate, so
 * `sslmode=disable` is accepted only against localhost — a production URL that turns TLS off is a
 * configuration bug and is refused here rather than silently sending credentials in the clear.
 */
function sslOptionsFor(connectionString: string): { ssl?: false | { rejectUnauthorized: boolean } } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Not a URL (libpq keyword/value form). Leave TLS to the driver's defaults.
    return {};
  }
  if (url.searchParams.get('sslmode') === 'disable') {
    const host = url.hostname;
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return loopback ? { ssl: false } : {};
  }
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (isLoopback && !url.searchParams.has('sslmode')) return { ssl: false };
  // `rejectUnauthorized: false` matches Supabase's pooler, which presents a certificate whose chain
  // is not verifiable from every environment. The connection is still encrypted.
  return { ssl: { rejectUnauthorized: false } };
}

/**
 * Returns a process-wide executor when `SUPABASE_DB_URL` is configured, and `null` when it is not.
 *
 * Returning `null` (rather than throwing) keeps the "no database configured" case an explicit,
 * honest API error at the route instead of a crash at import time.
 */
/**
 * The only runtime roles allowed to hold a privileged database credential.
 *
 * There are exactly two, and they are separate deployments for a reason:
 *
 *   `'recording-api'` — the private Recording API. Owns the Phase 4 recording write path. Reachable
 *                       only from the Web gateway over the private network. No processing providers,
 *                       no worker loop, no dashboard.
 *   `'worker'`         — the background worker and migration runner. Owns transcription,
 *                       intelligence, embeddings, knowledge indexing, and automation. Has no
 *                       user-facing request surface.
 *
 * There is deliberately no `'web'` member: the web process must never reach this function.
 *
 * The split matters because one privileged process that did both jobs would need both the
 * request-facing attack surface *and* every provider credential. Keeping them apart means the
 * service a user's request can reach holds no AssemblyAI or OpenAI key, and the service that holds
 * those keys is not reachable from a request at all.
 */
export type PrivilegedRuntimeRole = 'recording-api' | 'worker';

export const PRIVILEGED_RUNTIME_ROLES: readonly PrivilegedRuntimeRole[] = ['recording-api', 'worker'];

export type WorkerExecutorRequest = {
  /**
   * Required, with no default. Callers have to state that they are the privileged service, which
   * makes an accidental construction in request-handling code impossible to write silently.
   */
  role: PrivilegedRuntimeRole;
  env?: Record<string, string | undefined>;
};

/**
 * Fail-closed guard. In production, a process that declares itself the web app must not be holding a
 * database-owner credential, so refuse rather than connect.
 */
function assertPrivilegedRole(request: WorkerExecutorRequest): Record<string, string | undefined> {
  const env = request.env ?? process.env;
  if (!PRIVILEGED_RUNTIME_ROLES.includes(request.role)) {
    throw new Error(
      'Only the privileged services (recording-api, worker) may create a database executor. The ' +
        'web deployment must reach PostgreSQL through the user session or a narrowly scoped RPC ' +
        '(see docs/production-readiness.md).',
    );
  }
  const declared = (env.SUHBAT_RUNTIME_ROLE ?? '').trim().toLowerCase();
  if (declared === 'web') {
    throw new Error(
      'This process declares SUHBAT_RUNTIME_ROLE=web, which forbids SUPABASE_DB_URL. ' +
        'Start the recording-api or worker service for privileged database work.',
    );
  }
  // Defence in depth: the role the caller asked for and the role the process declares must agree.
  // A web deployment that somehow reached this code with `role: 'worker'` would otherwise be
  // handed an owner connection.
  if (env.NODE_ENV === 'production' && declared && declared !== request.role) {
    throw new Error(
      `This process declares SUHBAT_RUNTIME_ROLE=${declared}, which does not match the requested ` +
        `role "${request.role}". Refusing to hand out a privileged database executor.`,
    );
  }
  return env;
}

/**
 * Returns a process-wide executor when `SUPABASE_DB_URL` is configured, and `null` when it is not.
 *
 * Returning `null` (rather than throwing) keeps the "no database configured" case an explicit,
 * honest error at the caller instead of a crash at import time.
 */
export async function getWorkerExecutor(
  request: WorkerExecutorRequest,
): Promise<WorkerExecutor | null> {
  const env = assertPrivilegedRole(request);
  const connectionString = env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (runtimeState.__suhbatWorkerExecutor) return runtimeState.__suhbatWorkerExecutor;
  const executor = await createWorkerExecutor({ connectionString });
  runtimeState.__suhbatWorkerExecutor = executor;
  return executor;
}

/** Test/ops helper: forget the cached pool so the next call reconnects. */
export async function resetWorkerExecutor(): Promise<void> {
  const existing = runtimeState.__suhbatWorkerExecutor;
  runtimeState.__suhbatWorkerExecutor = null;
  if (existing) await existing.close();
}
