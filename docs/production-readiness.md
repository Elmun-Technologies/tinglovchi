# SUHBAT AI — Production Readiness & Release Checklist

This document is the authoritative production release, deployment, operational verification, and incident recovery checklist for **SUHBAT AI** (`suhbat-ai`).

---

## 1. Environment Checklist

Before starting the Web/API server or the Unified Worker in production (`NODE_ENV=production`), audit and populate all mandatory variables from `.env.example` into your secret manager (never commit populated `.env` files to Git):

| Category          | Variable                                                                 | Required in Web/API       | Required in Worker    | Production Rule                                                                              |
| ----------------- | ------------------------------------------------------------------------ | ------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| **Deployment**    | `NODE_ENV`                                                               | Yes (`production`)        | Yes (`production`)    | Enables fail-closed provider & error-redaction guards.                                       |
| **Deployment**    | `APP_URL`                                                                | Yes (`https://...`)       | Yes (`https://...`)   | Must be an explicit HTTPS origin without path/query/hash.                                    |
| **Deployment**    | `SUHBAT_DATA_MODE`                                                       | Yes (`live`)              | N/A                   | Rejects `demo` fixture mode in production (`validateProductionEnvironment`).                 |
| **Supabase**      | `NEXT_PUBLIC_SUPABASE_URL`                                               | Yes (`https://...`)       | Yes (`https://...`)   | Hosted Supabase project HTTPS URL.                                                           |
| **Supabase**      | `NEXT_PUBLIC_SUPABASE_ANON_KEY`                                          | Yes                       | Yes                   | Public anon key only; RLS enforces tenant isolation.                                         |
| **Supabase**      | `SUPABASE_DB_URL` / `SUPABASE_SERVICE_ROLE_KEY`                          | **No (Forbidden in Web)** | Yes                   | Isolated to the background worker / migration runner only.                                   |
| **Storage/R2**    | `STORAGE_PROVIDER`                                                       | Yes (`r2`)                | Yes (`r2`)            | `local` and `memory` providers are rejected in production.                                   |
| **Storage/R2**    | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Yes                       | Yes                   | Dedicated private Cloudflare R2 bucket credentials (no public access).                       |
| **Transcription** | `TRANSCRIPTION_PROVIDER`                                                 | N/A                       | Yes (`assemblyai`)    | `fake` provider is rejected in production.                                                   |
| **Transcription** | `ASSEMBLYAI_API_KEY`                                                     | **No**                    | Yes                   | Server/worker secret for AssemblyAI Universal-2 diarized transcription.                      |
| **AI Provider**   | `SUHBAT_INTELLIGENCE_PROVIDER`                                           | N/A                       | Yes (`openai`)        | `fake` provider is rejected in production.                                                   |
| **AI Provider**   | `SUHBAT_EMBEDDING_PROVIDER`                                              | Yes (`openai`)            | Yes (`openai`)        | Used by Worker for indexing and by Web/API for Ask AI query embeddings.                      |
| **AI Provider**   | `OPENAI_API_KEY`                                                         | Yes (server-only)         | Yes                   | Server/worker secret for OpenAI structured intelligence & embeddings.                        |
| **Telegram**      | `SUHBAT_TELEGRAM_PROVIDER`                                               | Optional (`telegram`)     | Optional (`telegram`) | `fake` is rejected in production; requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`. |
| **Automation**    | `SUHBAT_AUTOMATION_PROVIDER`                                             | Optional (`webhook`)      | Optional (`webhook`)  | `fake` is rejected in production; requires `AUTOMATION_WEBHOOK_SECRET`.                      |
| **Observability** | `LOG_LEVEL`, `SENTRY_DSN`                                                | Recommended               | Recommended           | Structured JSON logs redact all URLs, tokens, keys, and audio bytes.                         |

Run the programmatic fail-closed audit before deployment:

- Web/API validation: `validateProductionEnvironment(process.env, { role: 'web', throwOnError: true })`
- Worker validation: `validateProductionEnvironment(process.env, { role: 'worker', throwOnError: true })`

---

## 2. Provider Checklist

### 2.1 Supabase (PostgreSQL + Auth)

- [ ] Hosted Supabase project provisioned in target region.
- [ ] Email/password authentication enabled; PKCE callback URL allowlisted to `${APP_URL}/auth/callback`.
- [ ] Direct PostgreSQL connection string (`SUPABASE_DB_URL`) configured with TLS (`sslmode=require`) for the isolated worker service.
- [ ] Verify `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the only Supabase key present in the Web/API deployment environment.

### 2.2 Cloudflare R2 (Private Object Storage)

- [ ] Dedicated private bucket created (`R2_BUCKET`); public bucket access and `r2.dev` public domain disabled.
- [ ] Scoped R2 API token created with Object Read & Write permissions limited to `R2_BUCKET`.
- [ ] Verify presigned `PUT` (with `x-amz-checksum-sha256` and `x-amz-meta-sha256`), `HEAD` (`x-amz-checksum-mode: ENABLED`), `GET`, and `DELETE` operations against the private bucket.
- [ ] Confirm object keys strictly follow canonical layout:
  - `workspace/{workspaceId}/meetings/{meetingId}/recordings/{recordingId}/sources/{sourceId}/chunks/{seq}.{ext}`
  - `workspace/{workspaceId}/meetings/{meetingId}/recordings/{recordingId}/transcription-assets/v{version}.{ext}`

### 2.3 AssemblyAI (Transcription)

- [ ] Production API key (`ASSEMBLYAI_API_KEY`) provisioned and funded.
- [ ] Verify speaker diarization, word/segment timestamps, and multilingual code-switching (`uz`, `ru`, `en`) on representative audio samples.

### 2.4 OpenAI (Meeting Intelligence & Embeddings)

- [ ] Production API key (`OPENAI_API_KEY`) provisioned with access to `OPENAI_INTELLIGENCE_MODEL` (`gpt-4.1-mini` or `gpt-4.1`) and `OPENAI_EMBEDDING_MODEL` (`text-embedding-3-small`, `dimensions: 64`).
- [ ] Confirm strict JSON Schema structured output enforcement and evidence segment ID validation (`sourceSegmentIds` resolved against `public.transcript_segments`).

### 2.5 Telegram & Business Automation

- [ ] Telegram bot created via `@BotFather`; webhook registered to `${APP_URL}/api/v1/telegram/webhook` with `secret_token` matching `TELEGRAM_WEBHOOK_SECRET`.
- [ ] `AUTOMATION_WEBHOOK_SECRET` configured for HMAC-SHA256 signing of outbound human-confirmed business automation payloads.

---

## 3. Migration Checklist & Non-Destructive Safeguards

All SQL migrations are forward-only and must be applied in strict chronological order:

1. `supabase/migrations/202610060001_phase1_foundation.sql`
2. `supabase/migrations/202610070001_phase4_upload_processing_backbone.sql`
3. `supabase/migrations/202610070002_phase4_1_security_hardening.sql`
4. `supabase/migrations/202610070003_phase5_transcription_alignment.sql`
5. `supabase/migrations/202610070004_phase6_meeting_intelligence.sql`
6. `supabase/migrations/202610070005_phase7_company_memory_ask_ai.sql`
7. `supabase/migrations/202610070006_phase8_telegram_companion_notifications.sql`
8. `supabase/migrations/202610070007_phase9_business_automation.sql`
9. `supabase/seed.sql` (system meeting-type templates only; idempotent `ON CONFLICT DO NOTHING`)

**Migration Safeguards:**

- **Never run `supabase db reset` against staging or production.**
- Take a point-in-time PostgreSQL snapshot before applying new migrations.
- Verify RLS is enabled on all 27 public tables (`rowsecurity = true` in `pg_tables`) and direct `INSERT`/`UPDATE`/`DELETE` privileges for `anon` and `authenticated` remain revoked on all pipeline/artifact tables.

---

## 4. Security Checklist

- [ ] **Zero Secrets in Frontend Bundles:** Run `validateProductionEnvironment` and inspect `.next/static` and `apps/desktop/dist` to confirm no `SUPABASE_SERVICE_ROLE_KEY`, `R2_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `ASSEMBLYAI_API_KEY`, or `TELEGRAM_BOT_TOKEN` appears in client bundles.
- [ ] **RLS & Tenant Isolation:** All user-facing reads/writes execute under user JWT (`authenticated` role) or explicit workspace membership verification. Cross-workspace composite foreign keys prevent cross-tenant linking.
- [ ] **Request & Upload Size Limits:**
  - `/api/v1` JSON metadata endpoints enforce `MAX_API_JSON_BODY_BYTES = 256 KiB` (`HTTP 413` on oversized JSON).
  - Signed chunk upload authorizations enforce `MAX_CHUNK_UPLOAD_BYTE_SIZE = 512 MiB` and bind exact byte size + SHA-256 digest.
- [ ] **Production Error Sanitization:** `handleApiError` omits raw `error.detail` stack/connection strings when `NODE_ENV=production`.
- [ ] **Telegram Webhook Verification:** Constant-time `timingSafeEqual` verification of `X-Telegram-Bot-Api-Secret-Token` and per-link sliding-window rate limiting (`telegram_bot_rate_limits`).
- [ ] **Human Confirmation Gate for Automations:** External business actions (`google_calendar`, `crm_hubspot`, `crm_bitrix24`, `webhook_n8n`) cannot execute without a valid single-use SHA-256 confirmation token from `confirmAutomationAction`.

---

## 5. Physical Recorder Acceptance Checklists

### 5.1 Physical macOS Recorder (`docs/mac-recorder-acceptance.md`)

Mandatory before macOS desktop production sign-off:

- [ ] Compile Rust workspace on physical Apple Silicon / Intel Mac (`cargo test --workspace --manifest-path apps/desktop/src-tauri/Cargo.toml`).
- [ ] Execute Tests A–I in `docs/mac-recorder-acceptance.md`:
  - [ ] Test A: Microphone + system audio permissions (grant, deny, Settings deep link, no repeated prompt spam).
  - [ ] Test B: Mic-only, system-audio-only, and simultaneous dual-source capture (`onset_delta.py` drift check).
  - [ ] Test C: Pause/resume gap accounting (`t = 0` never resets; pause gaps recorded accurately).
  - [ ] Test D: Mid-session device change & device loss handling (refusal to silently substitute device mid-capture).
  - [ ] Test E: Crash/force-quit recovery (`manifest.json` atomic revisioning and startup recovery scan).
  - [ ] Test F: Offline recording -> network restoration -> chunk upload queue retry -> server verification & finalization.
  - [ ] Test G: Long recording (30–120 min) CPU, memory, and file descriptor stability.

### 5.2 Physical Windows Recorder (`docs/windows-recorder-acceptance.md`)

Mandatory before Windows desktop production sign-off:

- [ ] Compile Rust workspace on physical Windows 10 (19041+) / Windows 11 machine with MSVC toolchain.
- [ ] Execute Tests A–I in `docs/windows-recorder-acceptance.md` (WASAPI `eCapture` + `AUDCLNT_STREAMFLAGS_LOOPBACK`, silent loopback keepalive during output silence, `IMMNotificationClient` device loss, and Windows privacy settings deep links).

---

## 6. Deployment & Exact Startup Commands

### 6.1 Build Artifacts

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run build --workspace @suhbat/desktop
```

### 6.2 Start Web / API Server (`apps/web`)

Runs the Next.js 16 production server serving the web application, `/api/v1/*` endpoints, and `GET /api/v1/health`:

```sh
NODE_ENV=production SUHBAT_DATA_MODE=live npm run start --workspace @suhbat/web
```

### 6.3 Start Unified Background Worker (`@suhbat/database/worker-cli`)

Runs `MeetingProcessingWorkerRuntime` as an independent long-running process (separate from browser/HTTP request lifecycles) with `FOR UPDATE SKIP LOCKED` job claiming, lease heartbeats, fencing tokens, deletion ledger reconciliation, and graceful `SIGINT`/`SIGTERM` shutdown:

```sh
# Programmatic daemon entrypoint (@suhbat/database/worker-cli):
# Calls validateProductionEnvironment(process.env, { role: 'worker' }) and runs MeetingProcessingWorkerRuntime.runPollingLoop()
```

Multiple worker replicas (`WORKER_ID=suhbat-worker-01`, `suhbat-worker-02`, ...) can be run concurrently across containers/VMs; PostgreSQL `claim_next_processing_job` (`FOR UPDATE SKIP LOCKED`) and monotonic `fencing_token` guards prevent duplicate execution.

---

## 7. Rollback Plan & Backup / Recovery Notes

### 7.1 Application Rollback

- **Web/API & Worker:** Both services are stateless with respect to local disk (all durable state lives in PostgreSQL and private R2 object storage). Roll back by redeploying the previous container image / release tag.
- **In-Flight Worker Jobs:** On worker stop/redeploy, `SIGINT`/`SIGTERM` triggers `runtime.stop()` so active jobs finish their current step cleanly. Any interrupted job whose lease expires (`lease_expires_at <= now()`) is automatically reclaimed by the next worker with an incremented `fencing_token`.

### 7.2 Database & Storage Backup / Recovery

- **PostgreSQL (Supabase):** Enable automated daily backups and Point-in-Time Recovery (PITR). All completed `transcription_runs`, `analysis_runs`, `embedding_runs`, and terminal `business_automation_actions` are immutable (protected by database triggers).
- **Cloudflare R2:** Raw recording chunks (`recording_chunks`) and prepared transcription assets (`transcription_assets`) are immutable once verified. Deletions are tracked through `public.object_deletion_ledger` and reconciled asynchronously by `runtime.reconcilePendingDeletions()` until every storage object is confirmed deleted.

---

## 8. Monitoring & Health Check Checklist

- **Health Endpoint (`GET /api/v1/health`):**
  - Returns HTTP `200` when `overallStatus` is `healthy` or `degraded`, and HTTP `503` when `overallStatus` is `unavailable` (database or object storage unreachable).
  - Monitors `webApi`, `database` (latency & table count), `worker` (active running jobs, expired leases, latest heartbeat), `queue` (`queued`, `retryable_failed`, `dead_lettered`, `deletionReconciliationBacklog`), and `storage` (backend probe latency).
- **Observability Metrics (`ObservabilityCollector` / `runtime.getMetricsSnapshot()`):**
  - Alert when `deadLetterJobs > 0`.
  - Alert when `worker.expiredLeaseJobs > 0` for more than 2 consecutive intervals.
  - Alert when `deletionReconciliationBacklog.totalBacklog > 10`.
  - Alert when `transcriptionFailureRate.failureRate > 0.05` or `analysisFailureRate.failureRate > 0.05`.
  - Verify structured logs never contain `[REDACTED]` bypasses for URLs, tokens, API keys, or audio buffers.

---

## 9. Known Limitations & Remaining Live Validation Gates

1. **Gate 1 — Physical Hardware Validation Pending (`MEDIA GATE BLOCKED` on Physical Devices):**
   - Server-side binary WAV media assembly (`suhbat-wav-assembler/1.0.0`), disk-backed chunk persistence (`LocalDiskStorageProvider`), duration/header/sample-count validation, pause/discontinuity mapping, multi-source audio preservation, and sample-level chunk lineage verification (`resolveCanonicalSegmentAudioSlice`) are implemented and verified in `tests/rls/phase12-1-real-media-gate.test.ts`.
   - Native desktop recorder bridges (`apps/desktop/crates/capture-macos` and `apps/desktop/crates/capture-windows`) have undergone static C/Objective-C/C++/Rust FFI audits (fixing chunk-rotation tick advancement, realized hardware format propagation, macOS Objective-C/ScreenCaptureKit API call sites, and Windows WASAPI packet QPC timestamping), **but neither crate has been compiled or executed on physical macOS or Windows hardware** because the sandboxed Linux environment has no `rustc`/`cargo`, Apple SDK, or Windows SDK.
2. **Gate 2 — Live Cloud Credentials Pending:**
   - All live provider adapters (`R2StorageProvider`, `AssemblyAITranscriptionProvider`, `OpenAIMeetingIntelligenceProvider`, `OpenAIEmbeddingProvider`, `HttpTelegramBotProvider`, `HttpBusinessAutomationProvider`) enforce fail-closed configuration, HTTPS transport validation, SSRF host guards on outbound webhooks, constant-time secret comparison, HMAC-SHA256 webhook signing, and retryable network-transport error classification without secret leakage.
   - However, live execution against hosted Supabase, Cloudflare R2, AssemblyAI, OpenAI, and Telegram Bot API accounts with real production credentials remains an external staging/production gate.
3. **Browser E2E (Playwright):** The Playwright suite (`tests/e2e/phase1-workspace.spec.ts`) requires a live local/hosted Supabase Auth instance and installed Chromium binaries (`npx playwright install chromium`), which are not provisioned in the offline sandbox.
