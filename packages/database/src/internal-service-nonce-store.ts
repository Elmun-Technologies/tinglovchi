import type { SqlExecutor } from './phase4-backbone.ts';
import { createNonceStore, type DurableNonceStore } from './internal-service-auth.ts';

/**
 * How long a claimed nonce stays on record, in seconds.
 *
 * Mirrors `k_retention_seconds` in `internal_claim_service_nonce`. It is fixed in SQL, not passed
 * in, so nothing downstream can extend or shorten the window; this constant exists only so the
 * documentation in one place can point at the other.
 */
export const SERVICE_NONCE_RETENTION_SECONDS = 120;

/**
 * Durable, cross-machine replay protection for Web → Recording API requests.
 *
 * ## Why this exists
 *
 * The signature binds a one-use nonce, but a nonce recorded only in this process's memory protects
 * exactly one machine. Run two — which is the entire point of running a service — and the same
 * signed request can be replayed at the *other* machine inside the timestamp window: the signature
 * is still valid, the timestamp is still fresh, the nonce is unheard of there, and the write happens
 * twice.
 *
 * So the ledger lives in PostgreSQL, which every Recording API machine already shares and which is
 * already durable, already backed up, and already monitored. Adding Redis to hold one table would be
 * a second stateful system to secure, observe, and fail over, for no gain.
 *
 * ## The claim is one statement
 *
 * `insert ... on conflict (key_id, nonce) do nothing returning id`. The unique constraint is the
 * arbiter and the database does the atomicity: whichever machine arrives first inserts a row and
 * gets an id back; every later arrival inserts nothing and gets nothing. There is no SELECT before
 * the INSERT, no advisory lock, and therefore no window.
 *
 * ## Failure posture
 *
 * A replay guard that fails *open* is worse than no guard, because it looks like one. If the
 * database is unreachable, `consume` reports the nonce as already used — the request is rejected as
 * a replay rather than executed unguarded. That turns an outage into 401s instead of silent
 * duplicate writes, which is the correct direction to be wrong in.
 */

export type PostgresNonceStoreOptions = {
  /** The privileged executor the Recording API writes through. */
  db: SqlExecutor;
  /**
   * How many successful claims between opportunistic cleanups.
   *
   * Note there is deliberately no TTL option: retention is fixed inside
   * `internal_claim_service_nonce`. A replay guard that lets its caller choose how long a nonce
   * stays burned is not a replay guard.
   */
  purgeEveryClaims?: number;
  /** Hard ceiling on rows removed per cleanup, so a purge can never hold a lock for long. */
  purgeMaxRows?: number;
  now?: () => number;
  /** Called when the ledger is unreachable. Never receives the nonce itself. */
  onError?: (cause: unknown) => void;
};

export function createPostgresNonceStore(
  options: PostgresNonceStoreOptions,
): DurableNonceStore {
  const db = options.db;
  const purgeEveryClaims = Math.max(1, options.purgeEveryClaims ?? 100);
  const purgeMaxRows = Math.max(1, options.purgeMaxRows ?? 1_000);
  const now = options.now ?? (() => Date.now());
  const onError = options.onError ?? (() => {});

  let claimsSincePurge = 0;

  async function purgeExpired(maxRows = purgeMaxRows): Promise<number> {
    const result = await db.query<{ purged: number | string }>(
      `select public.internal_purge_expired_service_nonces($1) as purged`,
      [maxRows],
    );
    const purged = Number(result.rows[0]?.purged ?? 0);
    return Number.isFinite(purged) ? purged : 0;
  }

  return {
    backend: 'postgres',

    async consume(nonce: string, keyId = 'primary'): Promise<boolean> {
      if (!nonce) return false;
      try {
        // No TTL argument: retention is fixed inside the function.
        const result = await db.query<{ claimed: boolean }>(
          `select public.internal_claim_service_nonce($1, $2) as claimed`,
          [keyId, nonce],
        );
        // A NULL or missing row means the ledger did not answer; treat that as "already used".
        const claimed = result.rows[0]?.claimed === true;

        if (claimed) {
          claimsSincePurge += 1;
          if (claimsSincePurge >= purgeEveryClaims) {
            claimsSincePurge = 0;
            try {
              await purgeExpired();
            } catch (cause) {
              // Cleanup is housekeeping. Failing to sweep a few dead rows must never fail a
              // request that has already been authorised.
              onError(cause);
            }
          }
        }
        return claimed;
      } catch (cause) {
        // Fail closed: report it as a replay so the request is refused rather than executed with no
        // replay protection at all.
        onError(cause);
        return false;
      }
    },

    purgeExpired,

    size() {
      // Not meaningful for a durable store — the ledger is shared and its size is "however many
      // nonces are inside the window across every machine". Callers that need a count should query
      // the table.
      return -1;
    },

    clear() {
      // Deliberately a no-op. Wiping the ledger would un-burn every nonce in the window and reopen
      // every replay this guard exists to stop; tests should age rows out with
      // `purgeExpired` or use the in-memory store instead.
    },
  };
}

/**
 * Picks the right ledger for the deployment.
 *
 * A single-process deployment — the in-process gateway the integration suite drives — has no second
 * machine, so PostgreSQL would be pure overhead: it uses the in-memory store and behaves identically.
 * A real Recording API deployment always uses the durable store.
 */
export function createServiceNonceStore(
  options: PostgresNonceStoreOptions | { backend: 'memory' },
): DurableNonceStore {
  if ('backend' in options && options.backend === 'memory') {
    const memory = createNonceStore();
    return {
      backend: 'memory',
      consume: (nonce, keyId) => memory.consume(nonce, keyId),
      purgeExpired: async () => 0, // A memory store self-evicts; there is nothing to sweep.

      size: () => memory.size(),
      clear: () => memory.clear(),
    };
  }
  return createPostgresNonceStore(options as PostgresNonceStoreOptions);
}
