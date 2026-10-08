# Desktop Authentication and the Web Trust Boundary

This note records the security decisions behind the desktop recorder's connection to SUHBAT. It is
normative: if a change contradicts it, the change is wrong until this document is updated too.

Two rules anchor everything below, both taken from
[`production-readiness.md`](production-readiness.md):

| Secret | Web / API | Worker |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Yes |
| `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY` | **No (Forbidden in Web)** | Yes |

---

## 1. Where the privileged credential lives

**Nowhere in the web process.**

The web app reaches PostgreSQL through exactly one object: the Supabase server client built from the
**anon key**, carrying either the browser's session cookie or a desktop session token. Every
statement that process issues is therefore subject to row-level security under the caller's own
identity.

The database URL and the service-role key are read only by:

- `packages/database/src/worker-cli.ts` — the migration runner and the job worker, invoked as
  `validateProductionEnvironment(env, { role: 'worker', throwOnError: true })`.
- `packages/database/src/worker-executor.ts` — the executor those tools use. Its factory is
  `getWorkerExecutor(request)` with **no default role**: a caller must write `role: 'worker'`, and
  any other value throws `Only the worker runtime may create a privileged database executor`. In
  production it additionally refuses when `SUHBAT_RUNTIME_ROLE` says `web`. When no database URL is
  configured it returns `null` rather than throwing, so absence stays non-fatal.
- `packages/database/src/production-env.ts` — the fail-closed audit. Since this pass it also checks
  the *reverse* direction: `role: 'web'` **fails** when `SUPABASE_DB_URL` or
  `SUPABASE_SERVICE_ROLE_KEY` is present, so a misconfigured deployment is caught at boot instead of
  silently running with an owner credential.

`tests/security/web-trust-boundary.test.ts` asserts all of this statically: no file under `apps/web`
names either variable outside a comment, imports `worker-executor`, or requires `pg`.

### What replaced the direct connection

`packages/database/src/desktop-client.ts` used to take a `SqlExecutor` and run raw SQL with the
application's connection — which, in the API process, meant it ran as the database owner and RLS did
not apply. It now takes a `DesktopRpc` with one method, `call(functionName, args)`, and every
statement goes through a `security definer` function created in
`supabase/migrations/202610080002_phase13_desktop_session_rotation.sql`.

Each of those functions:

- pins `set search_path = ''`, so name resolution cannot be hijacked;
- is `security definer`, so it can touch tables that RLS otherwise hides;
- takes the caller's identity from `auth.uid()` (or, for desktop calls, from the session token) and
  authorises against it explicitly — a `security definer` function is a deliberate, narrow hole in
  RLS, so each one re-checks membership itself;
- has its implicit `grant ... to public` revoked, then granted only to `anon` and `authenticated`.

`apps/web/src/lib/desktop-rpc.ts` wraps the client in an **allow-list**. Naming any function outside
that list throws `non-allowlisted desktop function` before the call is made. The web process cannot
invent a call, and a test asserts every name in the list exists in the migration, is
`security definer`, pins its `search_path`, and revokes the default grant.

### Consequence for the recording endpoints

Phase 4's `SqlExecutor` needs privileges RLS does not grant, so the web process cannot build it.
`resolveApiContext`'s live path throws a precise `503` saying the pipeline requires the privileged
worker service, rather than quietly connecting as the owner. Recording endpoints become live by
running this API as the worker service (`SUHBAT_RUNTIME_ROLE=worker`, `SUPABASE_DB_URL` set); they
stay fully exercisable in tests through `setPhase4Runtime`, which is how the integration suite
drives them.

---

## 2. The desktop session lifecycle

### The old model (removed)

One opaque 192-bit bearer token persisted for 90 days, used directly as the `Authorization` header on
every request. It was stored as a SHA-256 hash, which is the right instinct, but a single credential
that long-lived and that widely accepted is the whole session — anyone who reads it has 90 days of
access, and there is no way to rotate it.

### The new model

Two opaque credentials, minted together, with different jobs.

| | Access token | Refresh token |
| --- | --- | --- |
| Entropy | 256 bits, base64url | 256 bits, base64url |
| Lifetime | **15 minutes** | **30 days** |
| Sent to | every ordinary endpoint | `POST /api/v1/desktop/sessions/refresh` **only** |
| Stored as | `sha256` hex | `sha256` hex |
| Lifetime columns | `desktop_sessions.access_token_hash` / `_expires_at` | `desktop_sessions.refresh_token_hash` / `_expires_at` |

Neither is ever stored in plaintext. A database read yields hashes only.

### Rotation

`refresh` is a single atomic statement. One `update ... where access_token_hash = ... and
refresh_token_hash = ... and revoked_at is null ... returning id` claims the row and writes the new
hashes in the same statement, so two simultaneous refreshes cannot both win — the loser's `returning`
is empty and it gets `invalid_grant`. This is the same contention pattern that makes the connect-code
exchange safe (section 3).

Each rotation records `previous_refresh_token_hash` and `refresh_rotated_at`. A replayed refresh
token cannot be honoured idempotently — only its hash is stored, so the server has no way to hand
back the pair it already issued. What it can do is decide how seriously to take the replay, and that
is what the **30-second grace window** is for:

- **Inside the window**, the replay is refused without revoking anything. The likely cause is a
  legitimate race — two renewals fired at once, one won, and the loser is now presenting a token
  that was valid a moment ago. The winning caller holds a live pair, so failing this one request is
  harmless.
- **Outside the window**, the replay is treated as theft: the entire session is revoked, including
  the live access token. Two parties hold credentials for the same session and at least one of them
  is not the user, so the session is worthless and is retired.

The window is short because it is a concession to races, not to attackers. It is set in SQL
(`interval '30 seconds'` in `desktop_refresh_session`), not in application config, so no client can
widen it.

`POST /api/v1/desktop/sessions/revoke` accepts either credential and revokes the session
immediately. An expired-but-unrevoked refresh token cannot be refreshed.

### What the desktop app does

- **Boot:** if `accessTokenNeedsRefresh(stored)` — no access token, or it expires within 60 seconds
  — refresh first, then call `describeSession()`. A `401`/`404` from `describeSession` triggers
  exactly one refresh and one retry before the app concludes it is signed out.
- **Steady state:** a 30-second timer refreshes only when the access token actually needs it and no
  upload is in flight (`uploadingRef.current`), so a renewal can never swap credentials underneath a
  signed-URL upload.
- **Renewal failure:** credentials are dropped, the session is *not* declared signed out, and the UI
  is told `session_expired`. In `flow.ts`, that action moves to `signed_out` **only when no recording
  is live** (`phase ∉ {starting, recording, paused, stopping}`); during a recording it just raises
  the notice. An auth event must never steal the Stop button.
- **Local data:** `clearCredentials()` removes credentials only. Workspace choice, consent, and any
  in-progress or queued recording are untouched. Nothing local is deleted until the upload rules say
  it is safe.

### Renderer persistence — and what it is not

`apps/desktop/src/session-store.ts` persists credentials to `localStorage` today. **This is not
secure storage.** It is temporary staging behind a small interface (`readCredentials`,
`writeCredentials`, `clearCredentials`) so it can be replaced without touching callers. The intended
destination is the OS keychain — macOS Keychain via the Security framework, Windows Credential
Manager via `wincred` — which is the follow-up this abstraction exists for. Do not describe the
renderer's store as secure, and do not rely on it being anything more than convenience.

---

## 3. Atomic connect-code exchange

`POST /api/v1/desktop/sessions` (the code exchange) used to read the code row, check it, then insert
a session and update the code — three statements with a window between them. Two exchanges arriving
together could both read `authorized` and both mint a session.

It is now one statement:

```sql
with claimed as (
  update public.desktop_connect_codes
     set status = 'consumed', consumed_at = now()
   where code_hash = p_code_hash
     and status = 'authorized'
     and expires_at > now()
  returning workspace_id, user_id
)
insert into public.desktop_sessions (...)
select ... from claimed
returning ...;
```

Postgres takes a row lock in the `update`, so the second concurrent `update` blocks, then re-checks
`status = 'authorized'`, finds `consumed`, matches zero rows, and the `insert` inserts nothing. The
caller sees `not_found` — indistinguishable, deliberately, from a code that never existed.

`tests/rls/phase13-desktop-client.test.ts` fires 2 and then 10 exchanges concurrently and asserts
exactly one session exists afterwards, that the losers get `not_found`, and that the code is left
`consumed` and never half-authorized. It applies the same check to refreshes.

**Honest limitation:** PGlite is single-connection, so those statements are serialised rather than
genuinely parallel. What the test proves is that no interleaving admits two winners — the second
statement always observes the first's committed state. That is precisely the property a
read-then-write lacks and exactly what `update ... returning` guarantees, but it is not a substitute
for a multi-connection load test on real Postgres before launch.

---

## 4. Abuse control on the unauthenticated endpoints

`POST /api/v1/desktop/connect-codes` takes no credentials and inserts a row, so it is the obvious
place to pound on.

**Rate limit.** `apps/web/src/lib/connect-code-rate-limit.ts`: 5 attempts per 60 seconds per client
IP, returning `429` with `retryAfterSeconds`. Client IP comes from `x-forwarded-for` /
`x-real-ip` **only when `SUHBAT_TRUST_PROXY_HEADERS=true`**; otherwise it falls back to a single
bucket. Without that flag a caller cannot forge its way out of the limit, and with it the operator is
explicitly asserting a proxy rewrites those headers. The limiter is in-process and therefore
approximate across instances — it is a speed bump, not a quota.

**Bounded growth.** The durable ceiling lives in SQL, not in process memory:
`desktop_create_connect_code` refuses to mint beyond a live-code limit (default 2000) and
opportunistically deletes expired and consumed rows on each call. Codes expire in **10 minutes**, and
expiry is enforced at every read, so a code that outlives its TTL is inert even if cleanup has not
run.

**Non-enumeration.** Every unknown-, expired-, and already-used-code outcome returns the identical
`not_found`. `GET /api/v1/desktop/connect-codes?code=…` returns `pending` for anything it will not
confirm, so it cannot be used to probe for valid codes.

**Entropy.** A code is 12 characters drawn from a 32-symbol alphabet (Crockford base32 minus `I`,
`L`, `O`, `U`), grouped as `XXXX-XXXX-XXXX` so a human can read it back without confusing glyphs.
That is **60 bits** from `crypto.randomBytes`. The selection is `byte % 32`, and since 256 is an
exact multiple of 32, the mapping is uniform — no modulo bias to correct. Only the SHA-256 hash is
stored.

60 bits is chosen against the rest of the controls: a 10-minute TTL, a 5-per-minute rate limit, and a
2000-code ceiling. Guessing is not the cheapest attack available, so spending more characters on
entropy would cost the user typing for no real gain. If the TTL or the rate limit is ever relaxed,
raise this with it.

---

## 5. Runtime resolution split by capability

`apps/web/src/lib/api-v1-runtime.ts` now exposes three resolvers:

| Resolver | Builds | Used by |
| --- | --- | --- |
| `resolveDesktopContext` | a `DesktopClientService` only | `POST /desktop/connect-codes`, `POST /desktop/sessions`, `/sessions/refresh`, `/session/workspace`, `POST /meetings`, `GET /workspaces` |
| `resolvePipelineContext` | storage + transcription + intelligence + embedding + Telegram + automation | recording upload and processing endpoints |
| `resolveApiContext` | everything, for routes that predate the split | remaining Phase 4–9 routes |

Pairing, refreshing, and listing workspaces therefore work with **no** AssemblyAI, OpenAI, R2,
Telegram, or automation configuration present. A test asserts the body of `resolveDesktopContext`
contains none of those constructors, and that each desktop route calls `resolveDesktopContext` and
neither of the other two.

---

## 6. Rust: unverified

**No Rust in this repository has ever been compiled.** There is no Rust toolchain in the development
sandbox, and crates.io is unreachable from it, so `cargo fmt`, `cargo clippy`, `cargo test`, and
`cargo tauri build` have never been run against any file below.

This pass changed **no Rust at all** — the diff against `4221df1` touches only TypeScript, SQL, and
tests. That is deliberate: with no way to compile a change, adding speculative native architecture
would be unverifiable by construction.

The existing native code stands as written and unverified:

| File | What it claims to do |
| --- | --- |
| `apps/desktop/crates/recorder-core/src/manifest.rs` | on-disk session manifest: chunk inventory, checksums, state |
| `apps/desktop/crates/recorder-core/src/session.rs` | canonical timeline across start / pause / resume / stop |
| `apps/desktop/crates/recorder-core/src/recovery.rs` | crash-relaunch reconciliation of on-disk chunks |
| `apps/desktop/crates/capture-macos/**` | AVFoundation / ScreenCaptureKit capture bridge |
| `apps/desktop/crates/capture-windows/**` | WASAPI capture bridge |
| `apps/desktop/src-tauri/src/commands.rs` | typed Tauri command surface for the React UI |
| `apps/desktop/src-tauri/src/state.rs` | process-local recording state |
| `apps/desktop/src-tauri/src/lib.rs` | Tauri application setup and plugin registration |

What *has* been checked is structural, by TypeScript tests that read the Rust sources as text:
`tests/desktop/rust-structure.test.ts` (11 assertions on declarations, naming, and the absence of
network/SQL dependencies) and `tests/desktop/recorder-offline-boundary.test.ts` (no HTTP client, no
SQL, no Supabase dependency in the workspace). Those prove what the files say, not that they compile.

Run [`docs/mac-recorder-acceptance.md`](mac-recorder-acceptance.md) end to end on the M1 Mac before
treating any of this as working software. Its gates G1–G3 are the first-ever Rust execution.

---

## 7. Verification

```
npm run typecheck                              # tsc --noEmit, whole workspace
npm test                                       # 557 tests, 41 files
npm run build                                  # Next.js web build
npm run build --workspace @suhbat/desktop      # Vite renderer bundle
```

The suites that pin this document down:

| Suite | Covers |
| --- | --- |
| `tests/security/web-trust-boundary.test.ts` | sections 1, 5 — no privileged credential reachable from `apps/web`; RPC allow-list; capability split |
| `tests/rls/phase13-desktop-client.test.ts` | sections 2, 3, 4 — rotation, atomic exchange, refresh contention, abuse control, RLS posture |
| `tests/desktop/cloud-client.test.ts` | the client sends the refresh token only to `/refresh` and never in a URL |
| `tests/desktop/rust-structure.test.ts` | section 6 — structural checks only |
