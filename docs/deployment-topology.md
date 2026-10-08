# Deployment Topology — Three Runtime Roles

SUHBAT deploys as **three separate services**. They do not share a process, and they do not share a
credential. This document is the reference for what each one is, what it may hold, and how they talk.

```
                             ┌──────────────────────────────────────────┐
   Desktop app               │  Fly private network (6PN / .flycast)    │
   (one public base URL)     │                                          │
        │                    │   ┌────────────────┐   ┌─────────────┐  │
        │  https://app.…     │   │ Recording API  │   │   Worker    │  │
        ▼                    │   │ role=          │   │ role=worker │  │
   ┌──────────────┐  signed  │   │ recording-api  │   │             │  │
   │  Web (public)│─────────►│   │                │   │ no request  │  │
   │  role=web   │  HMAC     │   │ SUPABASE_DB_URL│   │ surface     │  │
   │              │          │   │ + R2 only      │   │ + providers │  │
   │  no DB URL   │          │   └───────┬────────┘   └──────┬──────┘  │
   │  no providers│          │           │                   │         │
   └──────┬───────┘          │           │                   │         │
          │                  └───────────┼───────────────────┼─────────┘
          │                              │                   │
          │  Supabase Auth + RLS         ▼                   ▼
          └──────────────────────►  PostgreSQL          AssemblyAI
                                    (RLS on)            OpenAI / R2
```

---

## 1. Role 1 — Web (public)

`SUHBAT_RUNTIME_ROLE=web`

**What it is:** the public Next.js application. The dashboard, Supabase Auth, the `/desktop/connect`
approval page, the desktop connect-code and session endpoints, the transcript/results UI, and the
gateway that forwards recording requests.

**Rules:**

- **No `SUPABASE_DB_URL`.** Validation fails the deployment if it is present, and the privileged
  executor refuses to construct a connection in any process that declares this role.
- **No `SUPABASE_SERVICE_ROLE_KEY`.** Same reason, same enforcement.
- **Does not instantiate a `SqlExecutor`.** There is no code path from `apps/web` to one.
- All user-facing database access goes through Supabase with the caller's session, so RLS applies.
- What it *does* need that is new: `SUHBAT_RECORDING_API_URL` and `SUHBAT_INTERNAL_API_SECRET`.

**Files:** `apps/web/**`, plus `apps/web/src/lib/recording-gateway.ts` (the forwarding seam).

---

## 2. Role 2 — Recording API (private, privileged)

`SUHBAT_RUNTIME_ROLE=recording-api`

**What it is:** a small Node HTTP service that owns the minimum set of Phase 4 operations the
desktop recorder needs.

| Operation | Route |
| --- | --- |
| Register a recording | `POST /api/v1/recordings` |
| Read / delete a recording | `GET` \| `DELETE /api/v1/recordings/:id` |
| Register a source | `POST /api/v1/recordings/:id/sources` |
| Register a chunk | `POST /api/v1/recordings/:id/chunks` |
| Authorize a signed upload | `POST /api/v1/recordings/:id/chunks/:chunkId/upload` |
| Verify an upload | `POST /api/v1/recordings/:id/chunks/:chunkId/verify` |
| Finalize | `POST /api/v1/recordings/:id/finalize` |

**Rules:**

- May hold `SUPABASE_DB_URL`. It must: these statements bypass RLS, so authorization lives in the
  service layer.
- **No dashboard.** It serves no HTML and no UI bundle.
- **No generic database or admin API.** There is no query route and no route that accepts a
  workspace id without proving membership against the database first.
- **Re-checks authorization itself.** See §4.
- **Does not trust identity headers.** The only identity input is the signed user id.
- **Does not run AssemblyAI or OpenAI.** Validation *rejects* a `recording-api` environment carrying
  `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, or `AUTOMATION_WEBHOOK_SECRET`.
- **Does not run the worker loop.** It has no job claim, no queue polling, no processing route.

**Files:** `apps/recording-api/**` (new workspace package `@suhbat/recording-api`).

---

## 3. Role 3 — Worker (private, privileged)

`SUHBAT_RUNTIME_ROLE=worker`

**What it is:** the background processing service. Claim jobs, run transcription, run meeting
intelligence, build embeddings, index knowledge, fire automations and notifications, reconcile
storage.

**Rules:**

- May hold `SUPABASE_DB_URL`.
- Holds every provider credential: AssemblyAI, OpenAI, Telegram, automation webhook.
- **No public dashboard responsibilities.** No user-facing routes at all.
- **No user-facing recorder HTTP surface.** It is not in the request path.

**Files:** `packages/database/src/worker-cli.ts`, `worker-runtime.ts`, `phase5`–`phase9`.

---

## 4. Web → Recording API trust

The Recording API is privileged, so it must be able to tell a real forwarded request from an
attacker who found the hostname.

### The mechanism

HMAC-SHA256 over a canonical string, using a secret held only by the two services
(`SUHBAT_INTERNAL_API_SECRET`, or `SUHBAT_INTERNAL_API_SECRETS` for rotation).

```
canonical = "v1\n" + METHOD + "\n" + path-with-query + "\n" + timestamp + "\n"
          + nonce + "\n" + sha256(body) + "\n" + userId
signature = HMAC-SHA256(secret, canonical)
```

Sent as headers:

| Header | Value |
| --- | --- |
| `x-suhbat-service-signature` | `v1=<64 hex>` |
| `x-suhbat-service-timestamp` | Unix milliseconds |
| `x-suhbat-service-nonce` | 16 random bytes, hex |
| `x-suhbat-service-key-id` | which key was used (default `primary`) |
| `x-suhbat-user-id` | the user the Web gateway authenticated |

### Why each piece is there

- **Method, path, body digest, user id** are in the signature, so none can be altered in flight. In
  particular the user id cannot be swapped: re-signing is impossible without the secret, and the
  gateway is the only thing that has it.
- **Timestamp** bounds replay to ±60 s. A captured request stops working almost immediately.
- **Nonce** makes two otherwise-identical requests distinguishable, so a legitimate retry is not
  mistaken for a replay, and a genuine replay is caught even inside the timestamp window.
- **Comparison is constant-time**, so a wrong signature does not leak how much of it was right.
- **The nonce ledger is durable and shared** — see below.

### What the gateway does

1. Authenticates the caller **in the web process** — Supabase browser session or desktop session
   token — and collapses it to a `userId`.
2. Builds the outbound request from scratch. **No client header is copied.** That is what stops a
   client smuggling `x-suhbat-user-id`, and it also stops the desktop's `Authorization` token being
   replayed to a service that has no use for it.
3. Signs, forwards over the private network, and returns the response unchanged.

### Durable replay ledger

The nonce ledger lives in **PostgreSQL** (`public.internal_service_nonces`, added in
`supabase/migrations/202610080003_internal_service_nonce.sql`), not in process memory.

A process-local ledger protects exactly one machine. Run two — which is the point of running a
service — and the same signed request can be aimed at the *other* machine inside the timestamp
window: the signature is still valid, the timestamp is still fresh, the nonce is unheard of there,
and the write happens twice. The ledger has to be somewhere every machine can see, and Postgres is
already that place. Redis would be a second stateful system to secure, observe, and fail over, for
one table.

- **Table:** `key_id`, `nonce`, `created_at`, `expires_at`, with `unique (key_id, nonce)` and
  RLS enabled (no policies — it is written only through `security definer` functions).
- **Claim** is one statement: `insert ... on conflict (key_id, nonce) do nothing returning id`.
  The unique constraint is the arbiter; whichever machine arrives first gets an id back, every
  later arrival gets nothing. No read-then-write, no advisory lock, no window.
- **Namespaced by key id**, so a nonce minted under the outgoing key during a rotation cannot be
  blocked by, or collide with, one minted under the incoming key.
- **Bounded growth:** rows carry `expires_at` and are swept opportunistically by
  `internal_purge_expired_service_nonces(max_rows)`, which deletes at most `max_rows` per call.
  Bounded on purpose — an unbounded delete on a table that somehow grew enormous would hold a lock
  and stall every request behind it. A bounded purge always makes progress and catches up on later
  calls.

### Verification order — and why the order is the property

1. parse the service-auth headers
2. validate the timestamp window
3. verify the HMAC
4. **only then** atomically claim the nonce
5. a duplicate nonce means the request was already used → `401`
6. only now route and execute the recording operation

Step 4 coming *after* step 3 is what makes this safe. Claiming the nonce first would let any caller
who can reach the service pre-burn nonces: send one unsigned request bearing nonce `X`, and the
legitimate request the gateway later signs with `X` is rejected as a replay — a denial of service
requiring no secret at all. So the ledger only ever records a nonce that arrived attached to a
signature this service verified. Nothing an unauthenticated caller sends can consume anything.

A rejected request — including one refused on authorization grounds — does **not** refund its nonce.
Replaying a request that was denied returns a replay rejection, not a second pass through
authorization, so a refused request is never a reusable credential.

**Failure posture:** if the ledger is unreachable, `consume` reports the nonce as used and the
request is refused. A replay guard that fails open is worse than no guard, because it looks like
one; an outage becomes 401s rather than silent duplicate writes.

### What the Recording API does

1. Verifies the signature **before routing**. An unauthenticated request gets the same `401` whether
   or not the route exists, so it cannot enumerate the API.
2. Treats the signed user id as the only identity input.
3. Re-derives authorization from the database:
   - `createRecording` — the client's `workspaceId` and `meetingId` are *claims*. Confirm active
     membership in the workspace, and that the meeting lives in it, before writing anything.
   - Recording-scoped operations — load the recording row, take the workspace **from the row**, and
     confirm membership against that. A `workspaceId` from the client is used only to produce a
     sharper error, never as the authority.
4. Answers `404` — not `403` — when a recording exists but the caller may not see it. Telling a
   caller "that exists but is not yours" is a free enumeration oracle.

### Log hygiene

`redactHeaders()` (in `packages/database/src/internal-service-auth.ts`) replaces these with
`[redacted]` before anything is written: `authorization`, `cookie`, `set-cookie`,
`x-suhbat-service-signature`, `x-suhbat-user-id`, `x-suhbat-connect-code`.

Desktop access tokens, refresh tokens, and presigned R2 URLs never reach a log line. A signed URL is
a bearer credential for the object it points at; a session token is a bearer credential for the
account. The gateway also discards the upstream error message's URL, so a connection failure does not
leak the internal hostname.

---

## 5. Public desktop topology

The desktop build knows **exactly one** origin: `VITE_SUHBAT_API_BASE_URL`, which points at the
public Web app. It never learns the Recording API hostname — not as a build variable, not as a
runtime response, not anywhere.

```
Desktop ──► public Web origin ──► (Web gateway, private network) ──► Recording API ──► Postgres / R2
                                                                          ▲
Worker ──────────────────────────────────────────────────────────────────┘ (jobs)
```

`tests/security/three-role-deployment.test.ts` enforces this statically: the only `VITE_*` variable
anywhere under `apps/desktop/src` is `VITE_SUHBAT_API_BASE_URL`, and no file there contains
`.internal`, `.flycast`, or the string `recording-api`.

---

## 6. Fly.io staging topology

Fly's private network (6PN) gives every app in the same organisation a DNS name that resolves only
inside that network. The Recording API uses that, and is not exposed to the internet at all.

### Service discovery

| App | DNS | Reachable from |
| --- | --- | --- |
| `suhbat-web-stg` | `suhbat-web-stg.fly.dev` | internet |
| `suhbat-recording-api-stg` | `suhbat-recording-api-stg.flycast` (private) or `suhbat-recording-api-stg.internal` | org-internal only |
| `suhbat-worker-stg` | `suhbat-worker-stg.internal` | org-internal only |

Two options, with a recommendation:

- **`.flycast` (recommended).** Create a Flycast private address for the Recording API. It is a
  stable name that survives machine restarts and works across regions:
  ```
  fly ips allocate-v6 --private --app suhbat-recording-api-stg
  # → allocates a Flycast address, e.g. suhbat-recording-api-stg.flycast
  ```
- **`.internal`.** The default 6PN name. Simpler and free, but resolves to current machine IPs and is
  less forgiving during rolling deploys.

Use the `.flycast` address in `SUHBAT_RECORDING_API_URL`. Production validation accepts either
`.internal` or `.flycast` and **rejects a public hostname** — the service must not be reachable from
the internet.

### Network shape

- `suhbat-web-stg` — public. Handles `443` → `3000`. The only app with a public IP.
- `suhbat-recording-api-stg` — **no public IP.** Delete the shared IPv4; keep only the private
  Flycast address. Scale to at least 2 machines in `ams`/`iad` for availability.
- `suhbat-worker-stg` — **no public IP, no services block, no HTTP port.** It makes outbound
  connections only. Suspend/stop it when idle is not appropriate: it must poll continuously.

---

## 7. Exact Fly apps that should exist

### Staging

| App | Role | Public? | Notes |
| --- | --- | --- | --- |
| `suhbat-web-stg` | `web` | yes | Next.js. Public URL `https://suhbat-web-stg.fly.dev` |
| `suhbat-recording-api-stg` | `recording-api` | **no** | Private Flycast only |
| `suhbat-worker-stg` | `worker` | **no** | No services block |

### Production

| App | Role | Public? | Notes |
| --- | --- | --- | --- |
| `suhbat-web` | `web` | yes | `https://app.suhbat.uz` |
| `suhbat-recording-api` | `recording-api` | **no** | Private Flycast only |
| `suhbat-worker` | `worker` | **no** | No services block |

Plus, shared across both environments:

- **Postgres:** Supabase project (not a Fly Postgres app). Connection string goes to the two
  privileged services only.
- **Object storage:** Cloudflare R2 bucket, private, no public access, no `r2.dev` domain.
- **Secrets store:** Fly secrets per app (see §9).

Do **not** create a single `suhbat` app that runs all three. That is precisely the deployment shape
this split removes.

---

## 8. Environment variables by role

### Web — `SUHBAT_RUNTIME_ROLE=web`

```
# required
NODE_ENV=production
SUHBAT_RUNTIME_ROLE=web
APP_URL=https://app.suhbat.uz
SUHBAT_DATA_MODE=live
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUHBAT_RECORDING_API_URL=http://suhbat-recording-api.flycast:8080
SUHBAT_INTERNAL_API_SECRET=<32-byte random, shared with recording-api>
VITE_SUHBAT_API_BASE_URL=https://app.suhbat.uz     # build-time, for the desktop bundle

# FORBIDDEN — validation fails the deployment if present
# SUPABASE_DB_URL
# SUPABASE_SERVICE_ROLE_KEY

# not needed and not set
# STORAGE_PROVIDER / R2_*      (the Recording API signs object URLs, not the web)
# ASSEMBLYAI_API_KEY           (no processing happens here)
# OPENAI_API_KEY               (no intelligence happens here)
```

### Recording API — `SUHBAT_RUNTIME_ROLE=recording-api`

```
# required
NODE_ENV=production
SUHBAT_RUNTIME_ROLE=recording-api
SUPABASE_DB_URL=postgresql://…?sslmode=require
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=…
R2_BUCKET=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
SUHBAT_INTERNAL_API_SECRET=<same value as web>
PORT=8080
HOST=0.0.0.0

# FORBIDDEN — validation fails the deployment if present
# ASSEMBLYAI_API_KEY
# OPENAI_API_KEY
# TELEGRAM_BOT_TOKEN
# AUTOMATION_WEBHOOK_SECRET
# NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY   (browser credentials; not a browser)
```

### Worker — `SUHBAT_RUNTIME_ROLE=worker`

```
# required
NODE_ENV=production
SUHBAT_RUNTIME_ROLE=worker
SUPABASE_DB_URL=postgresql://…?sslmode=require
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=…  R2_BUCKET=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
TRANSCRIPTION_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=…
SUHBAT_INTELLIGENCE_PROVIDER=openai
SUHBAT_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=…

# operational
WORKER_ID=suhbat-worker-01
WORKER_CONCURRENCY=4
WORKER_POLL_INTERVAL_MS=1000
PROCESSING_MAX_ATTEMPTS=5
PROCESSING_LEASE_SECONDS=300
SUHBAT_AUTOMATION_PROVIDER=webhook
AUTOMATION_WEBHOOK_SECRET=…        # only if the webhook automation provider is enabled

# FORBIDDEN
# NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
```

---

## 9. Deploy commands

Run from the repository root. `<app>` is the Fly app name from §7.

### One-time setup

```bash
# Create the apps (no deploy yet).
fly apps create suhbat-web-stg
fly apps create suhbat-recording-api-stg
fly apps create suhbat-worker-stg

# Give the Recording API a private address, then remove its public IP.
fly ips allocate-v6 --private --app suhbat-recording-api-stg
fly ips list --app suhbat-recording-api-stg      # note the .flycast address
fly ips release <public-ipv4> --app suhbat-recording-api-stg

# The worker needs no address at all.
fly ips release <public-ipv4> --app suhbat-worker-stg

# Generate the shared internal secret and set it on BOTH services.
openssl rand -hex 32
fly secrets set SUHBAT_INTERNAL_API_SECRET=<value> --app suhbat-web-stg
fly secrets set SUHBAT_INTERNAL_API_SECRET=<value> --app suhbat-recording-api-stg
```

### Staging

```bash
# 1. Recording API first — the web deployment validates against it.
fly deploy --config deploy/fly.recording-api.toml --app suhbat-recording-api-stg \
  --env SUHBAT_RUNTIME_ROLE=recording-api

# 2. Web.
fly deploy --config deploy/fly.web.toml --app suhbat-web-stg \
  --build-arg VITE_SUHBAT_API_BASE_URL=https://suhbat-web-stg.fly.dev

# 3. Worker.
fly deploy --config deploy/fly.worker.toml --app suhbat-worker-stg
```

### Production

```bash
fly deploy --config deploy/fly.recording-api.toml --app suhbat-recording-api
fly deploy --config deploy/fly.web.toml --app suhbat-web \
  --build-arg VITE_SUHBAT_API_BASE_URL=https://app.suhbat.uz
fly deploy --config deploy/fly.worker.toml --app suhbat-worker
```

### Migrations

Migrations are forward-only SQL in `supabase/migrations/` and are applied with the Supabase CLI
against the project's database — **not** by any of the three Fly apps. Run them from CI or a
developer machine that holds the database credential, before deploying code that expects them:

```bash
# Never against production without a point-in-time snapshot first. Never `supabase db reset`.
supabase db push --project-ref <project-ref>
```

Afterwards verify RLS is still on for every public table:

```bash
supabase db execute --project-ref <project-ref> \
  --command "select count(*) filter (where not rowsecurity) as without_rls from pg_tables where schemaname='public'"
# expect: 0
```

### Verification after each deploy

```bash
# Web must refuse to hold a database credential.
fly ssh console --app suhbat-web-stg -C "printenv SUPABASE_DB_URL"   # expect: empty

# Recording API must be unreachable from the internet.
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 https://suhbat-recording-api-stg.fly.dev/health
# expect: 000 (connection refused) — it has no public address

# From inside the org's network it should answer 401 to an unsigned request.
fly ssh console --app suhbat-web-stg \
  -C "curl -s -o /dev/null -w '%{http_code}\n' http://suhbat-recording-api-stg.flycast:8080/api/v1/recordings"
# expect: 401

# Worker logs should show job polling and no HTTP requests.
fly logs --app suhbat-worker-stg
```

---

## 10. Verification in this repository

```
npm run typecheck
npm test
npm run build
npm run build --workspace @suhbat/desktop
```

`tests/security/three-role-deployment.test.ts` covers the boundary end to end: a real HTTP server
running the real Recording API router, driven through the real signing code, over a real socket,
against PGlite. It asserts that unsigned, mis-signed, stale, replayed and retargeted requests are all
refused; that a forged identity header cannot change the principal; that authorization is re-checked
against the database; that neither AssemblyAI nor OpenAI is imported or called; that the worker can
still build the full pipeline; and that the desktop knows one origin.
