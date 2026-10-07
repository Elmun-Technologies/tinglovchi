# SUHBAT AI

**SUHBAT AI** (`suhbat-ai`) is a company meeting-memory platform: it organizes conversations by workspace, company, and project, then evolves them into evidence-linked organizational knowledge. The product name is configurable through `NEXT_PUBLIC_APP_NAME`; it is not a domain identifier.

## Current status — Phase 1 foundation

Implemented in this phase:

- npm-workspace monorepo with a Next.js 16/React/TypeScript web application and shared contracts, database, shared, and UI packages.
- Supabase Auth sign-up/sign-in/session refresh, profile provisioning, workspace creation/selection, and a workspace-scoped company/project/meeting-draft flow.
- Versioned Supabase migration with RLS, tenant-safe composite foreign keys, first-owner provisioning, default meeting types, and minimal append-only audit events. Active owners/admins manage companies and projects; active members have read access and can create meeting drafts.
- PGlite-backed tests that apply the migration and exercise actual PostgreSQL RLS policies and constraints with isolated owner, admin, and member users.

A real Supabase project is required to authenticate through the web UI. No credentials or demo/customer data are committed. Upload, transcription, AI analysis, embeddings, and later product phases are **not implemented**.

## Phase 2 — local-first macOS recorder (implemented; real-Mac validation pending)

`apps/desktop` is the Tauri 2 + React/TypeScript + Rust desktop recorder. It captures the microphone and the
Mac's own system audio as two independent, separately recoverable sources with a shared canonical timeline,
writes ~30 s chunks plus an atomic versioned `manifest.json` under the app's own data directory, and works
with no network at all: no database access, no Supabase dependency, no upload, no transcription.

- Capture engine: `apps/desktop/crates/recorder-core` (timeline, manifest, writer, recovery, permissions,
  levels, disk preflight). macOS-only ScreenCaptureKit/AVAudioEngine code is isolated in
  `apps/desktop/crates/capture-macos` behind a compile-time platform gate; every other platform returns
  `platform_unsupported`.
- Renderer: `apps/desktop/src`, which reaches Rust only through the typed command bridge in `src/bridge.ts`.
- Run the Rust tests and build on a Mac:
  `cargo test --workspace --manifest-path apps/desktop/src-tauri/Cargo.toml` and `npm run desktop:build`.
- **Acceptance requires a physical Mac.** The environment this code was written in has no Rust toolchain
  and no Apple SDK, so nothing in the Rust tree has been compiled or executed; the required on-Mac
  procedure, metrics tables, and the list of unverified build gates are in
  [docs/mac-recorder-acceptance.md](docs/mac-recorder-acceptance.md).

## Product surface — typed demo data (`packages/product`, `packages/ui`)

The product screens (dashboard, meetings, meeting tabs, transcript, topics, decisions, tasks, facts, questions,
ideas, companies, projects, knowledge, Ask AI, search, settings) render through repository interfaces in
`@suhbat/product`. No page imports a fixture, a database client or a provider: `apps/web/src/lib/repositories.ts`
is the single point that selects an adapter. In live mode the dashboard adapter reads through the signed-in
user's Supabase session (PostgREST + RLS) from `apps/web/src/lib/supabase-live-repositories.ts`; the SQL adapter
in `apps/web/src/lib/live-repositories.ts` serves the worker/API runtime, which needs a PostgreSQL executor.

- `SUHBAT_DATA_MODE=demo` (the default) serves `@suhbat/product/demo` — versioned, cross-referenced fixtures
  (meetings with transcripts, speakers, topics, decisions, tasks, citations). The fixtures are checked for
  referential integrity at first use and by tests, so a citation that points at `seg_foodera_marketing_028`
  resolves to a real transcript line.
- `SUHBAT_DATA_MODE=live` connects workspace hierarchy, recording sessions, verified chunk status,
  meeting processing state (`draft -> recording -> uploading -> preparing -> ready_for_transcription -> transcribing -> normalizing_transcript -> transcript_ready -> ready_for_analysis -> analyzing -> normalizing_analysis -> analysis_ready -> ready | transcription_failed | analysis_failed | failed`),
  canonical transcript segments, speaker-to-participant mappings, structured AI meeting intelligence
  (executive summary, topics, decisions, action items/tasks, facts, questions, ideas, objections, commitments,
  risks, company intelligence, and workspace knowledge entries with canonical transcript evidence), and
  hybrid semantic + lexical Ask AI RAG retrieval (`@suhbat/database/phase7`) to the
  Phase 4–9 PostgreSQL/API backbone (`apps/web/src/lib/live-repositories.ts`), never silently falling back to demo data.
- Demo mode is read-only where a write path does not exist: forms either call a real adapter method or state
  plainly that nothing was saved. Advancing a processing step or ticking a task mutates in-memory demo state
  only, and the copy says so.
- No provider is connected. Ask AI is a deterministic, fixture-backed retriever (`retrieve`) with source cards
  linking to transcript evidence; no model is called, and no API key is read by any of these screens.

## Phase 4 — upload, storage & processing backbone

Implemented in Phase 4:

- Forward-only SQL migration (`supabase/migrations/202610070001_phase4_upload_processing_backbone.sql`) adding
  `recordings`, `recording_sources`, `recording_chunks`, `processing_jobs`, `processing_events`, and
  `object_deletion_ledger` with composite workspace/meeting/recording foreign keys, RLS policies, and
  `public.claim_next_processing_job` (`FOR UPDATE SKIP LOCKED`).
- Private object storage abstraction (`@suhbat/database/storage`) with canonical UUID-based keys
  (`workspace/{workspaceId}/meetings/{meetingId}/recordings/{recordingId}/sources/{sourceId}/chunks/{sequence}.{ext}`),
  deterministic `MemoryStorageProvider` for local/test execution, and optional `R2StorageProvider` (AWS SigV4).
- Versioned `/api/v1` endpoints (`apps/web/src/app/api/v1/...`) and shared Zod schemas (`@suhbat/contracts`)
  for recording registration, source registration, idempotent chunk registration, short-lived upload
  authorization, server-side SHA-256/size verification, recording finalization, processing status, and safe
  deletion with object storage reconciliation.
- Concurrency-safe worker (`Phase4RecordingWorker` in `@suhbat/database/phase4`) with leases, heartbeats,
  monotonic fencing tokens, bounded exponential backoff, dead-lettering, and the `prepare_recording` handler.
- Non-blocking, offline-tolerant desktop upload queue (`apps/desktop/src/upload-queue.ts`).

## Phase 5 — transcription & canonical alignment pipeline

Implemented in Phase 5:

- Forward-only SQL migration (`supabase/migrations/202610070003_phase5_transcription_alignment.sql`) building on
  `202610070002_phase4_1_security_hardening.sql` to add `transcription_assets`, `transcription_runs` (with a
  completed-run immutability trigger), `meeting_participants`, `meeting_speakers`, `transcript_segments`,
  composite foreign keys, workspace-scoped `SELECT` RLS policies, and server-mediated write enforcement.
- Canonical transcription asset preparation and piecewise `asset_time -> meeting_time -> original_source_sample`
  timeline alignment (`@suhbat/database/transcription-alignment`), handling pause gaps, multi-chunk ordering,
  degraded secondary sources, and invalid/out-of-range timestamp quarantine without silent clamping.
- Provider-neutral `TranscriptionProvider` abstraction (`@suhbat/database/transcription-provider`) with a
  deterministic multilingual `FakeTranscriptionProvider` (Uzbek/Russian/English code-switching, speaker
  diarization, pause-gap awareness, 12-segment fixtures) and an explicit `AssemblyAITranscriptionProvider`
  adapter that remains disabled unless configured and never silently falls back to fake mode.
- Durable worker pipeline (`Phase5TranscriptionWorker` in `@suhbat/database/phase5`) executing
  `prepare_recording -> transcribe_meeting -> normalize_transcript -> finalize_transcript` with lease/fencing
  protection, crash-after-provider recovery, duplicate callback idempotency, and safe retry.
- Versioned `/api/v1/meetings/{meetingId}/{transcription,transcript,speakers,transcription/retry}` route
  handlers and live `ProductRepositories.transcripts` integration (windowing, speaker filter, search,
  evidence-ready canonical segment IDs, and persistent speaker-to-participant mapping).

## Phase 6 — AI meeting intelligence

Implemented in Phase 6:

- Forward-only SQL migration (`supabase/migrations/202610070004_phase6_meeting_intelligence.sql`) building on
  `202610070003_phase5_transcription_alignment.sql` to add `analysis_runs` (with terminal-run immutability
  trigger), `meeting_summaries`, `meeting_topics`, `meeting_decisions`, `meeting_action_items`, `meeting_facts`,
  `meeting_questions`, `meeting_ideas`, `meeting_objections`, `meeting_commitments`, `meeting_risks`, and
  `intelligence_evidence` (with a composite foreign key enforcing same-segment, same-transcription-run,
  same-meeting, and same-workspace integrity), plus workspace-scoped `SELECT` RLS policies and revoked direct
  client writes.
- Provider-neutral `MeetingIntelligenceProvider` abstraction (`@suhbat/database/intelligence-provider`) with
  centralized prompt/schema/pipeline versions, strict JSON Schema output validation (`sourceSegmentIds` only —
  never LLM-invented timestamps), a deterministic evidence-linked `FakeMeetingIntelligenceProvider`, and an
  explicit `OpenAIMeetingIntelligenceProvider` that remains disabled unless configured and never silently falls
  back to fake mode.
- Bounded transcript windowing, cross-window candidate consolidation, semantic decision guardrails
  (`proposed` / `tentative` vs `confirmed`), strict `owner` / `due_date` null discipline, and canonical
  `transcript_segments` evidence validation/quarantine (`@suhbat/database/intelligence-pipeline`).
- Durable worker pipeline (`Phase6IntelligenceWorker` in `@suhbat/database/phase6`) executing
  `transcript_ready -> analyze_meeting -> normalize_intelligence -> finalize_analysis` with lease/fencing
  protection, crash-after-provider recovery, idempotent retries, and historical run preservation, promoting a
  meeting to product-level `ready` only after `finalize_analysis` succeeds.
- Versioned `/api/v1/meetings/{meetingId}/{analysis,intelligence,analysis/retry}` route handlers and full live
  `ProductRepositories` integration across Overview, Topics, Decisions, Tasks, Facts, Questions, Ideas,
  Commitments, Company Intelligence, and Knowledge views.

## Phase 7 — company memory, knowledge indexing & Ask AI (RAG)

Implemented in Phase 7:

- Forward-only SQL migration (`supabase/migrations/202610070005_phase7_company_memory_ask_ai.sql`) adding
  `embedding_runs` (with terminal-run immutability trigger), `knowledge_chunks` (with composite foreign keys to
  `meeting_summaries`, `meeting_topics`, `meeting_decisions`, `meeting_action_items`, `meeting_facts`,
  `meeting_questions`, `meeting_ideas`, `meeting_objections`, `meeting_commitments`, `meeting_risks`, and
  `transcript_segments`), `public.cosine_similarity(double precision[], double precision[])`, and workspace-scoped
  `SELECT` RLS policies.
- Provider-neutral `EmbeddingProvider` abstraction (`@suhbat/database/embedding-provider`) with a deterministic
  multilingual 64-d `FakeEmbeddingProvider` and an explicit `OpenAIEmbeddingProvider` that never silently falls
  back to fake mode.
- Canonical knowledge chunk synthesis (`@suhbat/database/knowledge-pipeline`), hybrid semantic + lexical Ask AI
  retrieval with canonical transcript citations (`@suhbat/database/phase7`), durable `generate_embeddings`
  worker stage, and versioned `/api/v1/meetings/{meetingId}/knowledge{/reindex}` and
  `/api/v1/workspaces/{workspaceId}/ask` endpoints.

## Phase 8 — Telegram companion & notifications

Implemented in Phase 8:

- Forward-only SQL migration (`supabase/migrations/202610070006_phase8_telegram_companion_notifications.sql`)
  adding `telegram_account_links`, `telegram_link_tokens`, `telegram_notification_deliveries`, and
  `telegram_bot_rate_limits` with workspace-scoped RLS policies and audit triggers.
- Provider-neutral `TelegramBotProvider` (`@suhbat/database/telegram-provider`), single-use SHA-256 link tokens,
  inbound webhook secret verification, per-link sliding-window rate limiting, and active workspace membership
  re-verification on every command (`/start`, `/status`, `/recent`, `/tasks`, `/summary`, `/ask`, `/unlink`,
  `/help`) in `@suhbat/database/phase8`.
- Durable `send_telegram_notifications` worker stage isolated from meeting readiness, plus `/api/v1/workspaces/{workspaceId}/telegram{/link-token}` and `/api/v1/telegram/webhook` endpoints.

## Phase 9 — business automation & integrations

Implemented in Phase 9:

- Forward-only SQL migration (`supabase/migrations/202610070007_phase9_business_automation.sql`) adding
  `workspace_automation_connectors`, `automation_actions` (with terminal immutability trigger), and
  `meeting_exports` with workspace-scoped RLS policies and audit triggers.
- Provider-neutral `BusinessAutomationProvider` (`@suhbat/database/automation-provider`) supporting
  `google_calendar`, `crm_hubspot`, `crm_bitrix24`, `webhook_n8n`, and `document_export`, with deterministic
  `FakeBusinessAutomationProvider` and `LiveWebhookAutomationProvider`.
- Two-step explicit human confirmation workflow (`prepareAutomationAction` -> `confirmAutomationAction`) in
  `@suhbat/database/phase9` enforcing SHA-256 single-use confirmation tokens and `(workspace_id, meeting_id, connector_type, action_type, idempotency_key)` deduplication before any external side effect is queued or executed.
- Durable `execute_automation_action` worker stage and `/api/v1/workspaces/{workspaceId}/automations/connectors`,
  `/api/v1/meetings/{meetingId}/automations{/[actionId]/confirm}`, and `/api/v1/meetings/{meetingId}/exports` routes.

## Phase 10 — local-first Windows recorder (implemented; real-Windows validation pending)

Implemented in Phase 10:

- Native Windows audio capture crate (`apps/desktop/crates/capture-windows`) implementing
  `recorder_core::capture::CaptureBackend` and `CaptureStream` behind `#[cfg(target_os = "windows")]` without
  changing any cross-platform command or domain contract in `recorder-core` or `apps/desktop/src-tauri/src/commands.rs`.
- WASAPI event-driven capture (`eCapture` for microphone, `eRender` + `AUDCLNT_STREAMFLAGS_LOOPBACK` for system
  audio), `QueryPerformanceCounter`/`QueryPerformanceFrequency` nanosecond hardware timestamps matching
  `recorder_core::clock::SystemClock`, 20 ms silent loopback keepalive blocks during output silence,
  `IMMNotificationClient` endpoint loss/default-device-switch detection, and Windows `CapabilityAccessManager`
  microphone privacy detection with `ms-settings:privacy-microphone` / `ms-settings:sound` repair deep links.
- See [docs/windows-recorder-acceptance.md](docs/windows-recorder-acceptance.md) for the physical Windows 10/11
  hardware acceptance protocol.

## Unified durable worker runtime (`@suhbat/database/worker`)

- `MeetingProcessingWorkerRuntime` (`packages/database/src/worker-runtime.ts`) orchestrates all durable job
  stages (`prepare_recording`, `transcribe_meeting`, `normalize_transcript`, `finalize_transcript`,
  `analyze_meeting`, `normalize_intelligence`, `finalize_analysis`, `generate_embeddings`,
  `send_telegram_notifications`, and `execute_automation_action`) plus `object_deletion_ledger` storage
  reconciliation (`reconcilePendingDeletions`, `drainQueue`, `runPollingLoop`).

Open a workspace by pointing a browser at `/w/ws_suhbat_demo` after `npm run dev`. A link to the same demo
workspace is also offered on the setup screen when Supabase is not configured.

## Local development

Requirements: Node.js 22.12+ (22.x) and npm 10+. For a local Supabase instance, install the Supabase CLI and Docker separately.

```sh
npm install
cp .env.example apps/web/.env.local
# Start local Supabase, then copy the public URL and anon key from `supabase status` into apps/web/.env.local.
supabase start
supabase db reset
npm run dev
```

Set `APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `apps/web/.env.local`. `APP_URL` is the canonical origin for signup confirmation and callback redirects; local development may use `http://localhost:3000`, while staging/production require an explicit HTTPS origin (a production server refuses to start otherwise). The web client uses the public anon key with RLS; it does not require `SUPABASE_SERVICE_ROLE_KEY`. If Supabase is not configured, the auth and workspace screens show setup instructions rather than pretending to be backed by a database. The product screens under `/w/[workspaceId]` run on the typed demo adapter described below, which is labelled as demo data on every page. The local Supabase config disables email confirmation for development only; configure the exact canonical Auth redirect URL and confirmation policy separately for a hosted project.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run format:check
npm run build
npm audit --audit-level=moderate
npm run desktop:build   # renderer only (vite); the Rust workspace needs a Mac toolchain, see docs/mac-recorder-acceptance.md
```

A gated Playwright browser journey is available for the real local Supabase Auth/workspace flow. After configuring local Supabase and `apps/web/.env.local`, install Chromium once with `npx playwright install chromium`, then run `E2E_LOCAL_AUTH=true npm run test:e2e`. It creates synthetic local users and records; reset local data afterward with `supabase db reset`. The test is not intended for a hosted/customer project.

The RLS suite uses PGlite and does not require Docker. It validates PostgreSQL policy/constraint behavior with a test implementation of `auth.uid()`; it does **not** replace a live Supabase Auth/PostgREST integration test.

## Architecture documents

- [Architecture and package boundaries](docs/architecture.md)
- [Database model and ERD](docs/database.md)
- [Recording and recovery design](docs/recording.md)
- [Transcription, AI, and processing pipeline](docs/ai-pipeline.md)
- [Security and threat model](docs/security.md)
- [Phased roadmap](docs/roadmap.md)
- [macOS recorder acceptance protocol](docs/mac-recorder-acceptance.md)
- [Windows recorder acceptance protocol](docs/windows-recorder-acceptance.md)
- [Production readiness & release checklist](docs/production-readiness.md)
- [Environment variable template](.env.example)
