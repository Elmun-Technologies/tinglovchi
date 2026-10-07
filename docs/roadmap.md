# Roadmap and phase gates

**Current worktree state:** Phases 0 through 10 and the Unified Durable Worker Runtime (`@suhbat/database/worker`) are implemented on `arena/111d1d7b-tinglovchi`:

- **Phase 1:** Auth and workspace foundation (`supabase/migrations/202610060001_phase1_foundation.sql`).
- **Phase 2:** Local-first macOS recorder (`apps/desktop/crates/recorder-core`, `apps/desktop/crates/capture-macos`, `docs/mac-recorder-acceptance.md`).
- **Phase 3 (Product Experience v1):** Complete product experience, repositories, and typed demo/live data boundary (`packages/product`, `packages/ui`, `apps/web`).
- **Phase 4 & 4.1:** Upload, storage & processing backbone and security hardening (`supabase/migrations/202610070001_phase4_upload_processing_backbone.sql`, `202610070002_phase4_1_security_hardening.sql`, `@suhbat/database/phase4`, `@suhbat/database/storage`).
- **Phase 5:** Transcription & canonical alignment pipeline (`supabase/migrations/202610070003_phase5_transcription_alignment.sql`, `@suhbat/database/phase5`, `@suhbat/database/transcription-alignment`).
- **Phase 6:** AI meeting intelligence pipeline & evidence validation (`supabase/migrations/202610070004_phase6_meeting_intelligence.sql`, `@suhbat/database/phase6`, `@suhbat/database/intelligence-pipeline`).
- **Phase 7:** Company memory, knowledge indexing & Ask AI RAG (`supabase/migrations/202610070005_phase7_company_memory_ask_ai.sql`, `@suhbat/database/phase7`, `@suhbat/database/knowledge-pipeline`).
- **Phase 8:** Telegram companion & notifications (`supabase/migrations/202610070006_phase8_telegram_companion_notifications.sql`, `@suhbat/database/phase8`).
- **Phase 9:** Business automation & human-confirmed integrations (`supabase/migrations/202610070007_phase9_business_automation.sql`, `@suhbat/database/phase9`).
- **Phase 10:** Local-first Windows WASAPI recorder (`apps/desktop/crates/capture-windows`, `docs/windows-recorder-acceptance.md`).
- **Unified Durable Worker Runtime:** End-to-end job orchestration across Phases 4–9 and storage deletion ledger reconciliation (`@suhbat/database/worker`, `packages/database/src/worker-runtime.ts`).

## Phase 0 — Discovery and foundation (complete)

Repository/environment discovery; preserved the existing README; documented architecture/package boundaries, normalized database model and Mermaid ERD, recording/recovery, transcription/AI schemas and pipeline, API boundaries, security/threat model, environment variables, and staged plan. No Phase 1 work was included in that phase report.

## Phase 0.1 — Architecture contract hardening (documentation-only)

This pass makes the following cross-document contracts explicit without adding application code, migrations, auth, workers, or dependencies:

1. `recording.md` is authoritative for the single monotonic meeting timeline, pause gaps, concurrent source alignment, sample/chunk maps, and exact playback resolution; `ai-pipeline.md` maps provider-local timestamps back to it.
2. `database.md` defines `Meeting → Recording → Recording Source → Recording Chunk`, the canonical source/sequence uniqueness and idempotency barriers, separate upload/verification states, and server-only durability acknowledgement.
3. `ai-pipeline.md` defines PostgreSQL job states, `FOR UPDATE SKIP LOCKED` lease claims, heartbeat/expiry, fencing, attempts/backoff, dead-letter recovery, and at-least-once effects.
4. `security.md` assigns user JWT/RLS to browser, desktop, and user-facing Next/API operations; any service-role access is isolated to a narrow, auditable worker runtime.
5. Analysis outputs are immutable run-versioned records with current/latest pointers; evidence rows resolve to transcript segments in the exact input run, and all displayed times derive from canonical segments/sample maps.
6. Configurable workspace `meeting_types` are reference rows, not a PostgreSQL enum; built-in defaults and future custom types coexist.
7. A versioned authenticated `/api/v1` DTO boundary keeps desktop operations independent of PostgreSQL/Supabase table layout.
8. Meeting tombstones immediately suppress retrieval; a durable deletion ledger reconciles relational, vector, object-storage, provider, and derived-file purge failures.

Each detailed contract has one authoritative section and the other documents cross-reference it. This pass does not alter the already-present Phase 1 artifacts or authorize Phase 2.

## Phase 1 — Auth and workspace foundation (implemented; live-provider acceptance pending)

### Implemented scope

1. Created npm workspaces for `apps/web`, `packages/contracts`, `packages/database`, `packages/shared`, and `packages/ui`, with strict TypeScript, ESLint, Prettier, Vitest, and production build scripts.
2. Added environment validation for the public Supabase URL/anon key; local HTTP is limited to loopback. The web application does not use a service-role key. The canonical server-only `APP_URL` is validated by `apps/web/src/instrumentation.ts` at server startup and again whenever an authenticated server client is created; staging/production require an explicit HTTPS origin.
3. Added `supabase/migrations/202610060001_phase1_foundation.sql` for profiles, workspaces, membership, companies, projects, meeting types, meeting drafts, and minimal audit logs. Added composite workspace foreign keys, indexes, updated-at triggers, first-owner provisioning, and RLS policies. Only active owners/admins may create/update companies and projects; all active roles may create draft meetings. Future pipeline states/columns and AI analysis-profile references are not in this migration.
4. Added Supabase SSR email/password sign-up/sign-in/sign-out, PKCE callback, session-refresh proxy, and auth-user profile provisioning. Signup confirmation and callback redirects both derive their destination from the validated canonical `APP_URL`; incoming `Host`, forwarded-host, and request-origin values are never redirect destinations.
5. Added a responsive workspace shell to list/create workspaces, create companies and projects, and create meeting drafts using workspace-scoped data. Company/project forms are shown only to active owners/admins, mirroring the RLS write policy; active members keep read access and can still create meeting drafts. No fake meeting/AI/recording content is shown.
6. Seeded only the built-in meeting-type templates (system configuration); no fictitious users, customers, or business facts are seeded.
7. Added PGlite tests that apply the migration and test owner/admin/member write permissions, RLS isolation, nested reads, forged workspace writes, cross-workspace foreign keys, project/company consistency, draft-only lifecycle and Phase 1 schema scope, owner/default-type creation, audit visibility, and input/config validation. Added unit tests for canonical `APP_URL` rules and for callback redirects that must not follow the request host. Added a gated Playwright journey for sign-up, workspace/company/project/meeting creation, and a second user’s access denial.

### Verification status

The implementation, unit tests, PGlite policy tests, lint, typecheck, formatting check, dependency audit, and production build are run for this phase; the hardening pass re-ran all of them after the fixes. PGlite validates PostgreSQL policy/constraint behavior with a test `auth.uid()` implementation. It does not emulate Supabase Auth, PostgREST, dashboard settings, email delivery, or hosted migrations.

A real Supabase project and credentials were not available in the execution environment. Therefore **live user authentication and the browser flow from sign-in through workspace/company/project/meeting creation have not been verified**. The Playwright journey is authored but was not executed because Supabase Auth is unavailable and browser binaries are not provisioned. The local Supabase CLI/Docker path is documented, but Supabase CLI, Docker, and PostgreSQL are absent on the inspected host. This is an outstanding acceptance gate rather than a hidden success claim.

### Explicit exclusions

No macOS capture, local chunking, storage uploads, transcription, AI analysis, embeddings, Ask AI, Telegram, CRM/calendar integration, Windows recorder, or production branding. No Phase 2 work has started.

## Recommended Phase 2 — macOS recorder prototype (proposed; not authorized)

Build the Tauri/Rust session state machine and native microphone + system audio capture. Implement permission/device states, explicit consent, independent local chunks, typed atomic manifest, safe pause/resume/stop, manual markers/notes, and crash recovery. Validate Opus/Ogg or another codec on real Macs. No web meeting-intelligence expansion. Acceptance covers source capture, permission denial, pause/resume, multiple chunks, app restart/recovery, and a usable sample recording; report platform-specific failures.

## Phase 3 — Upload and processing backbone

Implement private object storage adapter, signed/idempotent chunk uploads, checksum/size verification, retries and resume reconciliation, finalization barriers, durable jobs/leases/events, processing state machine, and deletion hooks. Prove an offline 10+ minute capture can continue, reconnect, and finalize without missing/duplicated chunks; processing starts only after server verification.

## Phase 4 — Transcription

Implement normalized provider interface and AssemblyAI adapter; persist speaker-aware timestamped segments, languages/confidence, provider run metadata, and stable speaker-to-participant mapping. Build transcript search/filter/rendering with performance tests. Preserve mixed language and source audio.

## Phase 5 — Meeting intelligence

Implement centralized OpenAI Responses adapter, strict structured outputs, versioned prompts/schemas, bounded multilingual extraction, and evidence validation. Persist summaries/claims, topics, and typed decisions/tasks/facts/ideas/questions/objections/commitments/risks/follow-ups. Acceptance tests cover uncertainty, tentative vs confirmed decisions, unknown owners/deadlines, invalid source IDs, and click-through evidence.

## Phase 6 — Complete meeting experience

Build polished meeting detail/overview, transcript, topic and typed-intelligence sections, evidence navigation, and audio playback/synchronization if ready. Virtualize long transcripts and test large meetings. No unsupported data or decorative metrics.

## Phase 7 — Company memory and Ask AI

Create versioned knowledge chunks/embeddings, pgvector indexes, and workspace/company/project-scoped retrieval. Ask AI answers cite meeting/date/timestamp/segment; test isolation adversarially. Relational records remain source of truth and vector results never bypass authorization.

## Phase 8 — Telegram

Add optional account linking, processing-ready notifications, concise summary/tasks, and authenticated web deep links. Telegram remains a client adapter, not the system backend. Add rate limits, authorization, and notification-failure isolation.

## Phase 9 — Business automation

Prioritize integrations only after product rules and user confirmation: calendar/docs/PDF/CRM/n8n. Never create/update external business records without explicit action/confirmation and auditable idempotency.

## Phase 10 — Windows recorder

Add Windows-native system-audio implementation behind the existing cross-platform desktop command/domain APIs. Keep native capture code platform-specific and run Windows hardware permission/audio tests.

## Future — Screen context and proposal generation

Screen snapshots/context mode and sales proposal briefs are outside the initial MVP. If approved later, use explicit consent, user-visible controls, selective snapshots rather than default continuous HD video, and evidence links for every generated proposal field.

## Phase discipline

At each phase: scope only its deliverables; add tests before claiming acceptance; run lint, typecheck, tests, migration checks, and relevant builds; document architecture changes and risks; report platform/vendor limitations; stop for approval. Phase 1 does not authorize Phase 2.

## Phase 2 — Local-first macOS recorder (implemented; real-Mac acceptance pending)

### Implemented scope

1. Added the `apps/desktop` workspace (Tauri 2 + React/TypeScript renderer, Rust core) to the npm workspaces, with `@suhbat/contracts` and `@suhbat/shared` reused rather than duplicated. The desktop package added no new npm dependencies; the renderer uses esbuild JSX and `window.__TAURI__` instead of `@tauri-apps/api`.
2. Implemented the recorder in `apps/desktop/crates/recorder-core`: the single canonical monotonic timeline with `t = 0` at `ready → recording` (never reset, wall UTC as metadata only), the explicit state machine `idle → permission_check → ready → recording ⇄ paused → finalizing → stopped` plus `permission_blocked | device_unavailable | failed` with rejected invalid transitions, per-source capture state, pause gaps, bounded block queues with drop accounting, level meters, WAV/PCM chunk writing, sha256-after-freeze checksums, atomic versioned manifest revisioning, disk pre-flight and `ENOSPC` handling, and a startup recovery scan that exposes recoverable and unrecoverable state without ever auto-discarding artifacts.
3. Chose s16le PCM in WAV per ~30 s chunk (mic mono, system stereo) over the Opus-in-Ogg candidate that `recording.md` §4 recorded as unverified, with the measured rationale and the codec benchmark gate documented in `docs/mac-recorder-acceptance.md` §3.2.
4. Isolated macOS-only capture in `apps/desktop/crates/capture-macos` behind `#[cfg(target_os = "macos")]` and an Objective-C shim compiled by `build.rs`; availability is checked at compile time (`__has_include`) and at run time (`@available`, class lookup), with permission preflight, no re-prompting per process, active-device identification, refusal to substitute a device mid-capture, self-process audio exclusion where the OS supports it, and `platform_unsupported` everywhere else (Windows remains a later phase).
5. Added the typed renderer/native contract in `packages/contracts` (14 commands, 7 event tags, statuses, chunk/source/manifest/recovery payloads, typed errors) with no envelopes, and a UI in `apps/desktop/src` that shows duration plus canonical-vs-captured gap, per-source health, level meters, markers, timestamped notes, chunk state, recovery panel, and honest disabled controls when the bridge or persistence is unavailable.
6. Added cross-language verification: `tests/fixtures/recorder-timeline-vectors.json` is asserted by both Vitest and Rust tests; `tests/desktop/recorder-contract.test.ts` compares the Rust serde declarations to the zod schemas; `tests/desktop/rust-structure.test.ts` checks module/path/FFI/command coherence; `tests/desktop/recorder-offline-boundary.test.ts` enforces the no-cloud, no-DB, no-server, no-upload boundary statically.
7. Documented the acceptance protocol (tests A–I with metric tables) in `docs/mac-recorder-acceptance.md` plus its measurement helper `tools/mac-acceptance/onset_delta.py`, validated against a synthetic session with a known offset.

### Verification status

TypeScript, Vitest (91 desktop tests plus the existing suites), lint, typecheck, formatting check, dependency audit, and the renderer production build were run and pass in the implementation environment. Rust was **not** compiled or tested and the Objective-C shim was **not** syntax-checked, because the environment has no Rust toolchain, no Apple SDK, and no reachable crates.io; ScreenCaptureKit, AVAudioEngine, CoreAudio device churn, TCC prompts, real files on a real volume, and all resource metrics therefore remain unverified. This is an outstanding acceptance gate, not a claim of success.

### Explicit exclusions

No uploads, object storage, transcription, provider integrations (including AssemblyAI/OpenAI), AI analysis, embeddings, Telegram, CRM/calendar work, Windows capture, production workers, commercial proposal generation, `/api/v1` server, or Phase 3 behavior of any kind. The desktop app contains no network client and no database dependency, and recordings stay local with no local web server; app-level Keychain encryption remains a documented future boundary as `recording.md` §7 requires.
