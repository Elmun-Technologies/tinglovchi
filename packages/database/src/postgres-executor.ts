import type { SqlExecutor } from './phase4-backbone.ts';

/**
 * Live PostgreSQL executor for the Next.js `/api/v1` surface.
 *
 * Why this file exists
 * --------------------
 * Phases 4–9 implemented the whole recording → transcription → intelligence pipeline against a
 * `SqlExecutor`, but nothing in the web app ever *connected* one: `resolveApiContext` threw
 * `503 … PostgreSQL runtime is not connected in this environment` on the live path, so every
 * `/api/v1` route — including the ones the one-tap recorder depends on — was reachable only from
 * tests that called `setPhase4Runtime` themselves.
 *
 * This module closes that gap. It is deliberately the *only* place a PostgreSQL driver is imported,
 * so the rest of `packages/database` stays driver-agnostic and PGlite-testable.
 *
 * Security posture
 * ----------------
 * * `SUPABASE_DB_URL` is a server-only credential. It is read from `process.env` in Node only and is
 *   never referenced from a browser bundle or a `NEXT_PUBLIC_*` variable.
 * * Connections require TLS unless the host is loopback; `sslmode=disable` is honoured only for
 *   loopback development.
 * * The app connects as the database owner, which means PostgreSQL RLS does not apply to these
 *   queries. Every authorization decision therefore stays in the service layer
 *   (`assertActiveWorkspaceMembership`, `loadAuthorizedMeeting`). RLS remains the second boundary for
 *   anything that reaches PostgreSQL through a user session.
 */
export type PostgresExecutorOptions = {
  connectionString: string;
  /** Bounded so one stalled query cannot hold a request open forever. */
  statementTimeoutMs?: number;
  max?: number;
};

export type PostgresExecutor = SqlExecutor & {
  /** Closes the pool. Used by graceful shutdown and by tests. */
  close(): Promise<void>;
};

const runtimeState = globalThis as typeof globalThis & {
  __suhbatPostgresExecutor?: PostgresExecutor | null;
};

/**
 * Creates a pooled executor. Exported for tests and for callers that manage their own lifecycle;
 * production code almost always wants {@link getPostgresExecutor} instead, which caches one pool per
 * process.
 */
export async function createPostgresExecutor(
  options: PostgresExecutorOptions,
): Promise<PostgresExecutor> {
  const { Pool } = await import('pg');
  const connectionString = options.connectionString.trim();
  if (!connectionString) {
    throw new Error('createPostgresExecutor requires a non-empty connection string');
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
export async function getPostgresExecutor(
  env: Record<string, string | undefined> = process.env,
): Promise<PostgresExecutor | null> {
  const connectionString = env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (runtimeState.__suhbatPostgresExecutor) return runtimeState.__suhbatPostgresExecutor;
  const executor = await createPostgresExecutor({ connectionString });
  runtimeState.__suhbatPostgresExecutor = executor;
  return executor;
}

/** Test/ops helper: forget the cached pool so the next call reconnects. */
export async function resetPostgresExecutor(): Promise<void> {
  const existing = runtimeState.__suhbatPostgresExecutor;
  runtimeState.__suhbatPostgresExecutor = null;
  if (existing) await existing.close();
}
