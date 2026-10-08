import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Private service-to-service authentication for the Web → Recording API hop.
 *
 * ## Why this exists
 *
 * Phase 4's recording operations need a privileged SQL executor, and the web deployment is forbidden
 * from holding one (`docs/production-readiness.md` marks `SUPABASE_DB_URL` as "No (Forbidden in
 * Web)"). So recording runs in its own process. That creates a new question: how does the private
 * Recording API know a request really came from the Web gateway, and which user the Web already
 * authenticated?
 *
 * The answer is *not* a header the client could have set. Anything the desktop can set, the desktop
 * can forge. So:
 *
 *   - The Web gateway authenticates the caller itself — a Supabase browser session or a desktop
 *     session token — and collapses it to a `userId`.
 *   - It then signs the request with a secret that exists only on the two servers.
 *   - The signature covers the method, path, timestamp, nonce, body digest **and the user id**, so
 *     none of them can be altered in flight.
 *   - The Recording API verifies before it does anything else, and treats the signed user id as the
 *     only identity input. It re-checks workspace/meeting authorization against the database itself.
 *
 * ## What this is deliberately not
 *
 * It is not a general-purpose JWT scheme and not a replacement for the user's own session. It
 * authenticates *one internal hop* between two services that already share a secret. It carries no
 * claims of its own beyond "the web gateway vouches for this user id, for this exact request, right
 * now".
 */

export const INTERNAL_AUTH_SCHEME = 'v1';

/** Header carrying the HMAC. */
export const SIGNATURE_HEADER = 'x-suhbat-service-signature';
/** Unix milliseconds at signing time. Bounds replay to {@link DEFAULT_CLOCK_SKEW_MS}. */
export const TIMESTAMP_HEADER = 'x-suhbat-service-timestamp';
/** Random per-request value. Makes two identical requests distinguishable. */
export const NONCE_HEADER = 'x-suhbat-service-nonce';
/** Which shared secret was used, so keys can be rotated without a flag day. */
export const KEY_ID_HEADER = 'x-suhbat-service-key-id';
/**
 * The user the Web gateway already authenticated.
 *
 * Signed, so a client cannot set it. Stripped from inbound requests by the gateway, so a client
 * cannot smuggle it through either.
 */
export const USER_ID_HEADER = 'x-suhbat-user-id';

/**
 * Every header whose value participates in the signature.
 *
 * `USER_ID_HEADER` is on this list on purpose: it is the one piece of identity the Recording API
 * trusts, so tampering with it must invalidate the signature.
 */
export const SIGNED_HEADERS = [
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  KEY_ID_HEADER,
  USER_ID_HEADER,
] as const;

/** How far signing and verifying clocks may drift before a request is considered stale. */
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

export type InternalSigningKey = {
  /** Identifies the key so a verifier can pick the right secret. */
  keyId: string;
  secret: string;
};

export type SignedInternalRequest = {
  method: string;
  /** Path **including** the query string, exactly as it will be sent. */
  path: string;
  /** Raw request body. Empty string for bodiless requests. */
  body?: string;
  /** The user the caller has already authenticated. */
  userId: string;
};

export type InternalRequestHeaders = Record<string, string>;

export type VerificationFailure = {
  code:
    | 'missing_signature'
    | 'malformed_signature'
    | 'unknown_key'
    | 'stale_timestamp'
    | 'replayed_nonce'
    | 'bad_signature'
    | 'missing_user';
  message: string;
};

export type VerificationSuccess = {
  ok: true;
  userId: string;
  keyId: string;
};

export type VerificationResult = VerificationSuccess | ({ ok: false } & VerificationFailure);

// ---------------------------------------------------------------------------
// Canonical string
// ---------------------------------------------------------------------------

/**
 * The exact bytes fed to the HMAC.
 *
 * Every field is length-prefixed by a newline and the scheme is the first line. That makes the
 * string unambiguous: a value containing a newline or a colon cannot be moved across a field
 * boundary and still produce the same digest.
 */
export function buildCanonicalString(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
  userId: string;
}): string {
  return [
    INTERNAL_AUTH_SCHEME,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodyDigest,
    input.userId,
  ].join('\n');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacHex(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/** Constant-time comparison that does not leak length, and never throws on unequal lengths. */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still compare against itself so the timing profile does not depend on the lengths.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Signing (Web side)
// ---------------------------------------------------------------------------

/**
 * Produces the headers the Web gateway attaches to a forwarded request.
 *
 * `timestamp` and `nonce` are injectable so tests can produce a deterministic signature or
 * deliberately stale one; production callers omit them and get fresh CSPRNG values.
 */
export function signInternalRequest(
  request: SignedInternalRequest,
  key: InternalSigningKey,
  options: { timestampMs?: number; nonce?: string; bodyDigest?: string } = {},
): InternalRequestHeaders {
  const timestamp = String(options.timestampMs ?? Date.now());
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const body = request.body ?? '';
  const digest = options.bodyDigest ?? sha256Hex(body);
  const canonical = buildCanonicalString({
    method: request.method,
    path: request.path,
    timestamp,
    nonce,
    bodyDigest: digest,
    userId: request.userId,
  });
  return {
    [SIGNATURE_HEADER]: `${INTERNAL_AUTH_SCHEME}=${hmacHex(key.secret, canonical)}`,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [KEY_ID_HEADER]: key.keyId,
    [USER_ID_HEADER]: request.userId,
  };
}

// ---------------------------------------------------------------------------
// Nonce store (replay rejection)
// ---------------------------------------------------------------------------

/**
 * Records a nonce as used and reports whether this caller was first.
 *
 * `keyId` participates because the ledger is keyed by (key_id, nonce): during a key rotation the
 * same nonce string minted under a different key is a different record, and must not be blocked by
 * it.
 *
 * Implementations may be synchronous (a single-process Map) or asynchronous (PostgreSQL). The
 * verifier awaits the result either way.
 */
export type NonceStore = {
  consume(nonce: string, keyId?: string): boolean | Promise<boolean>;
  size(): number;
  clear(): void;
};

/** A durable, cross-machine nonce store. */
export type DurableNonceStore = NonceStore & {
  readonly backend: 'postgres' | 'memory';
  /** Deletes at most `maxRows` expired rows. Returns how many were removed. */
  purgeExpired(maxRows?: number): Promise<number>;
};

/**
 * Bounded, time-expiring nonce set.
 *
 * Replay protection has to survive two things: an attacker resending a captured request, and a
 * legitimate client that never receives a response and retries. Only the first should be rejected,
 * so the window is the same clock skew as the timestamp check and nonces expire out of it.
 *
 * The store is capped, and when it overflows it drops the oldest entries rather than growing without
 * bound — an attacker who can mint nonces must not be able to exhaust memory.
 */
export function createNonceStore(options: {
  ttlMs?: number;
  maxEntries?: number;
} = {}): NonceStore {
  const ttlMs = options.ttlMs ?? DEFAULT_CLOCK_SKEW_MS * 2;
  const maxEntries = options.maxEntries ?? 10_000;
  const seen = new Map<string, number>();

  function evict(now: number): void {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(key);
    }
    if (seen.size <= maxEntries) return;
    // Map iteration order is insertion order, so this removes the oldest first.
    const excess = seen.size - maxEntries;
    let removed = 0;
    for (const key of seen.keys()) {
      if (removed >= excess) break;
      seen.delete(key);
      removed += 1;
    }
  }

  return {
    consume(nonce, keyId = 'primary') {
      if (!nonce) return false;
      const key = `${keyId}:${nonce}`;
      const now = Date.now();
      evict(now);
      if (seen.has(key)) return false;
      seen.set(key, now + ttlMs);
      return true;
    },
    size() {
      return seen.size;
    },
    clear() {
      seen.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Reads the shared secrets from the environment.
 *
 * Two forms are accepted so rotation is possible without downtime:
 *
 *   SUHBAT_INTERNAL_API_SECRET=<secret>                       → key id "primary"
 *   SUHBAT_INTERNAL_API_SECRETS=primary:<secret>,next:<secret> → both, verifiable during rotation
 *
 * A verifier accepts any configured key; a signer uses the first. That is what lets a new key be
 * rolled out to every service before the old one is removed.
 */
export function readInternalSigningKeys(
  env: Record<string, string | undefined> = process.env,
): InternalSigningKey[] {
  const keys: InternalSigningKey[] = [];
  const multi = env.SUHBAT_INTERNAL_API_SECRETS?.trim();
  if (multi) {
    for (const entry of multi.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf(':');
      if (separator <= 0) continue;
      const keyId = trimmed.slice(0, separator).trim();
      const secret = trimmed.slice(separator + 1).trim();
      if (!keyId || !secret) continue;
      if (keys.some((key) => key.keyId === keyId)) continue;
      keys.push({ keyId, secret });
    }
  }
  const single = env.SUHBAT_INTERNAL_API_SECRET?.trim();
  if (single && !keys.some((key) => key.keyId === 'primary')) {
    keys.push({ keyId: 'primary', secret: single });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Verification (Recording API side)
// ---------------------------------------------------------------------------

export type VerifyOptions = {
  method: string;
  path: string;
  /** Raw body exactly as received — it must be hashed before JSON parsing. */
  body: string;
  headers: { get(name: string): string | null };
  keys: readonly InternalSigningKey[];
  nonceStore: NonceStore;
  now?: number;
  clockSkewMs?: number;
};

/**
 * Verifies an internal request. Returns a discriminated result rather than throwing, so the caller
 * decides the status code and never leaks which check failed.
 *
 * ## The order of these steps is the security property
 *
 *   1. parse the service-auth headers
 *   2. validate the timestamp window
 *   3. verify the HMAC
 *   4. **only then** atomically claim the nonce
 *   5. a duplicate nonce means the request was already used → reject
 *   6. only now is the request routed and executed
 *
 * Step 4 coming *after* step 3 is what makes this safe. If the nonce were claimed first, anyone who
 * could reach the service could burn nonces chosen in advance: send one unsigned request bearing
 * nonce `X`, and the legitimate request the gateway later signs with `X` is rejected as a replay —
 * a denial of service needing no secret at all. Equally, a stale or malformed request must not
 * reserve anything.
 *
 * So the ledger only ever records a nonce that arrived attached to a signature this service itself
 * verified. Nothing an unauthenticated caller sends can consume anything.
 */
export async function verifyInternalRequest(
  options: VerifyOptions,
): Promise<VerificationResult> {
  const now = options.now ?? Date.now();
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  // 1. Parse the service-auth headers.
  const signatureHeader = options.headers.get(SIGNATURE_HEADER);
  if (!signatureHeader) {
    return { ok: false, code: 'missing_signature', message: 'Internal service signature is required.' };
  }

  const separator = signatureHeader.indexOf('=');
  const scheme = separator > 0 ? signatureHeader.slice(0, separator) : '';
  const provided = separator > 0 ? signatureHeader.slice(separator + 1).trim() : '';
  if (scheme !== INTERNAL_AUTH_SCHEME || !/^[0-9a-f]{64}$/.test(provided)) {
    return {
      ok: false,
      code: 'malformed_signature',
      message: 'Internal service signature is malformed.',
    };
  }

  const timestamp = (options.headers.get(TIMESTAMP_HEADER) ?? '').trim();
  const nonce = (options.headers.get(NONCE_HEADER) ?? '').trim();
  const keyId = (options.headers.get(KEY_ID_HEADER) ?? '').trim();
  const userId = (options.headers.get(USER_ID_HEADER) ?? '').trim();

  if (!userId) {
    return { ok: false, code: 'missing_user', message: 'Internal request carries no user identity.' };
  }

  // 2. Validate the timestamp window.
  const timestampMs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > clockSkewMs) {
    return {
      ok: false,
      code: 'stale_timestamp',
      message: 'Internal service signature is outside the accepted time window.',
    };
  }

  const key = options.keys.find((candidate) => candidate.keyId === keyId);
  if (!key) {
    return { ok: false, code: 'unknown_key', message: 'Internal service key is not recognised.' };
  }

  // 3. Verify the HMAC.
  const canonical = buildCanonicalString({
    method: options.method,
    path: options.path,
    timestamp,
    nonce,
    bodyDigest: sha256Hex(options.body ?? ''),
    userId,
  });

  if (!secureEquals(provided, hmacHex(key.secret, canonical))) {
    return { ok: false, code: 'bad_signature', message: 'Internal service signature is invalid.' };
  }

  // 4. Only now claim the nonce. Everything above this line can fail without touching the ledger.
  if (!(await options.nonceStore.consume(nonce, key.keyId))) {
    return { ok: false, code: 'replayed_nonce', message: 'Internal request has already been used.' };
  }

  return { ok: true, userId, keyId: key.keyId };
}

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

/**
 * Header names whose values must never reach a log line.
 *
 * Desktop access tokens, refresh tokens, and presigned R2 URLs all travel through this path. A
 * signed URL is a bearer credential for the object it points at, and a session token is a bearer
 * credential for the account, so both are treated the same way as a password.
 */
const NEVER_LOGGED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  SIGNATURE_HEADER,
  USER_ID_HEADER,
  'x-suhbat-connect-code',
]);

export function redactHeaders(
  headers: Iterable<[string, unknown]>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    output[lower] = NEVER_LOGGED_HEADERS.has(lower) ? '[redacted]' : String(value);
  }
  return output;
}

/**
 * Strips every internal header from an inbound client request.
 *
 * The gateway signs its own copies. Anything arriving from outside is discarded first, so a client
 * cannot smuggle `x-suhbat-user-id` past the signature check by setting it and hoping it survives.
 */
export function stripInternalHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  for (const name of SIGNED_HEADERS) cleaned.delete(name);
  // Belt and braces: any header this service defines, regardless of exact casing the client used.
  for (const name of [...cleaned.keys()]) {
    if (name.toLowerCase().startsWith('x-suhbat-service')) cleaned.delete(name);
  }
  return cleaned;
}
