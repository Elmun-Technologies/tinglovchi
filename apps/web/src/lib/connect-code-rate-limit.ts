/**
 * Bounded abuse control for `POST /api/v1/desktop/connect-codes`.
 *
 * That endpoint is unauthenticated and writes rows, so it needs a ceiling. This is deliberately not a
 * distributed rate limiter: it is a per-process, memory-bounded sliding window that keeps one
 * misbehaving client from filling the pairing table. The database holds the durable backstop —
 * `desktop_create_connect_code` refuses once too many unexpired codes exist, and cleans up expired
 * ones as it goes — so a multi-instance deployment is still bounded even though each instance counts
 * separately.
 *
 * Why in-memory and not Redis
 * ---------------------------
 * Adding a Redis dependency to satisfy this would introduce a new piece of infrastructure and a new
 * failure mode for a limit that only needs to be approximately right. The durable guarantees live in
 * SQL where they cannot be bypassed by restarting a process.
 */

const WINDOW_MS = 60_000;
/** Per client address, per window. Generous for real use (a lost code and a retry), useless for spam. */
const MAX_PER_WINDOW = 5;
/** Per process, per window. One NAT'd office or one noisy bot cannot starve everyone. */
const MAX_PER_WINDOW_GLOBAL = 300;
/** The map is capped so a rotating source address cannot grow it without bound. */
const MAX_TRACKED_KEYS = 10_000;

type Budget = { allowed: boolean; retryAfterSeconds?: number };

type Window = { count: number; resetAt: number };

const state = globalThis as typeof globalThis & {
  __suhbatConnectCodeWindows?: Map<string, Window>;
  __suhbatConnectCodeGlobal?: Window;
};

function windows(): Map<string, Window> {
  if (!state.__suhbatConnectCodeWindows) state.__suhbatConnectCodeWindows = new Map();
  return state.__suhbatConnectCodeWindows;
}

function globalWindow(): Window {
  if (!state.__suhbatConnectCodeGlobal) {
    state.__suhbatConnectCodeGlobal = { count: 0, resetAt: Date.now() + WINDOW_MS };
  }
  return state.__suhbatConnectCodeGlobal;
}

function take(window: Window, limit: number): Budget {
  const now = Date.now();
  if (now >= window.resetAt) {
    window.count = 0;
    window.resetAt = now + WINDOW_MS;
  }
  if (window.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
  }
  window.count += 1;
  return { allowed: true };
}

/**
 * The client key is the connecting address, not a caller-supplied header.
 *
 * We do not trust `x-forwarded-for` because any client can set it. `x-real-ip` is only honoured when
 * the deployment explicitly opts in via `SUHBAT_TRUST_PROXY_HEADERS`, which is off by default —
 * behind a proxy that sets it correctly this gives per-client limits; otherwise every caller shares
 * one bucket and the global ceiling is what protects the table.
 */
export function clientKey(request: Request): string {
  if ((process.env.SUHBAT_TRUST_PROXY_HEADERS ?? '').trim().toLowerCase() === 'true') {
    const forwarded = request.headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;
    const real = request.headers.get('x-real-ip')?.trim();
    if (real) return real;
  }
  return 'shared';
}

export function consumeConnectCodeBudget(request: Request): Budget {
  const now = Date.now();
  const map = windows();

  // Drop expired entries first, then hard-cap the map so it cannot become a memory leak.
  for (const [key, window] of map) {
    if (now >= window.resetAt) map.delete(key);
  }
  while (map.size > MAX_TRACKED_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }

  const global = take(globalWindow(), MAX_PER_WINDOW_GLOBAL);
  if (!global.allowed) return global;

  const key = clientKey(request);
  const existing = map.get(key) ?? { count: 0, resetAt: now + WINDOW_MS };
  const result = take(existing, MAX_PER_WINDOW);
  map.set(key, existing);
  return result;
}

/** Test/ops helper: forget every window. */
export function resetConnectCodeBudget(): void {
  state.__suhbatConnectCodeWindows = new Map();
  state.__suhbatConnectCodeGlobal = { count: 0, resetAt: Date.now() + WINDOW_MS };
}

export const CONNECT_CODE_RATE_LIMIT = {
  windowMs: WINDOW_MS,
  maxPerWindow: MAX_PER_WINDOW,
  maxPerWindowGlobal: MAX_PER_WINDOW_GLOBAL,
} as const;
