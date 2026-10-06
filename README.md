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
is the single point that selects an adapter, and the Supabase/API adapter is the seam that is still missing.

- `SUHBAT_DATA_MODE=demo` (the default) serves `@suhbat/product/demo` — versioned, cross-referenced fixtures
  (meetings with transcripts, speakers, topics, decisions, tasks, citations). The fixtures are checked for
  referential integrity at first use and by tests, so a citation that points at `seg_foodera_marketing_028`
  resolves to a real transcript line.
- `SUHBAT_DATA_MODE=live` keeps the same routes and renders explicit "data source is not reachable" states,
  because the Supabase adapter for these records is not implemented. Nothing falls back to demo data silently.
- Demo mode is read-only where a write path does not exist: forms either call a real adapter method or state
  plainly that nothing was saved. Advancing a processing step or ticking a task mutates in-memory demo state
  only, and the copy says so.
- No provider is connected. Ask AI is a deterministic, fixture-backed retriever (`retrieve`) with source cards
  linking to transcript evidence; no model is called, and no API key is read by any of these screens.

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
- [Environment variable template](.env.example)
