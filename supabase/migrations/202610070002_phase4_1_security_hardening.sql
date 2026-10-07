-- SUHBAT AI — Phase 4.1 Security Hardening Migration
-- Forward-only migration that enforces the server-mediated /api/v1 write boundary on all Phase 4
-- recording, chunk, processing-job, event, and deletion-ledger tables.
--
-- Security posture:
-- 1. Authenticated clients have zero direct INSERT, UPDATE, DELETE, or TRUNCATE privileges on
--    recordings, recording_sources, recording_chunks, processing_jobs, processing_events, and
--    object_deletion_ledger. All recording/source/chunk registration, upload verification,
--    finalization, job lifecycle transitions, and deletion mutations must go through /api/v1
--    server endpoints or the privileged background worker.
-- 2. Workspace-scoped SELECT isolation for active workspace members is preserved on recordings,
--    recording_sources, recording_chunks, processing_jobs, and processing_events;
--    object_deletion_ledger SELECT is restricted to active workspace owners/admins.
-- 3. Direct draft creation on public.meetings remains restricted to unrecorded draft state
--    (status = 'draft', processing_status = 'idle', purge_status = 'active', active_recording_id is null).

-- Remove direct client INSERT RLS policies introduced in 202610070001.
drop policy if exists recordings_insert_member on public.recordings;
drop policy if exists recording_sources_insert_member on public.recording_sources;
drop policy if exists recording_chunks_insert_pending_member on public.recording_chunks;

-- Tighten object_deletion_ledger SELECT policy to active workspace owners/admins only.
drop policy if exists object_deletion_ledger_select_member on public.object_deletion_ledger;
create policy object_deletion_ledger_select_manager
  on public.object_deletion_ledger for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = object_deletion_ledger.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  );

-- Ensure direct client draft creation on public.meetings cannot spoof Phase 4 pipeline columns.
drop policy if exists meetings_insert_draft_member on public.meetings;
create policy meetings_insert_draft_member
  on public.meetings for insert to authenticated
  with check (
    status = 'draft'
    and processing_status = 'idle'
    and purge_status = 'active'
    and deleted_at is null
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meetings.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Revoke all direct write privileges from anon and authenticated on all Phase 4 backbone tables.
revoke all on
  public.recordings,
  public.recording_sources,
  public.recording_chunks,
  public.processing_jobs,
  public.processing_events,
  public.object_deletion_ledger
  from public, anon, authenticated;

-- Re-grant only workspace-isolated SELECT to authenticated (enforced by RLS).
grant select on
  public.recordings,
  public.recording_sources,
  public.recording_chunks,
  public.processing_jobs,
  public.processing_events,
  public.object_deletion_ledger
  to authenticated;

-- Ensure worker claiming RPC remains inaccessible to anon and authenticated roles.
revoke all on function public.claim_next_processing_job(text, integer, timestamptz)
  from public, anon, authenticated;

comment on table public.recordings is
  'Server-mediated recording sessions. Authenticated clients have workspace-scoped SELECT only; all writes go through /api/v1/recordings.';
comment on table public.recording_sources is
  'Server-mediated recording audio sources. Authenticated clients have workspace-scoped SELECT only; all writes go through /api/v1/recordings/{id}/sources.';
comment on table public.recording_chunks is
  'Server-mediated recording chunks. Authenticated clients have workspace-scoped SELECT only; registration and verification go through /api/v1/recordings/{id}/chunks.';
comment on table public.processing_jobs is
  'Durable background jobs. Authenticated clients have workspace-scoped SELECT only; creation and lease transitions are server/worker-only.';
comment on table public.processing_events is
  'Append-only processing lifecycle events. Authenticated clients have workspace-scoped SELECT only; writes are server/worker-only.';
comment on table public.object_deletion_ledger is
  'Private storage deletion reconciliation ledger. Readable by workspace owners/admins only; all writes are server/worker-only.';
