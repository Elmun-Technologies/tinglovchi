-- Phase 4: Upload, private storage metadata, verified recording chunks, and durable processing backbone.
-- Forward-only migration building on 202610060001_phase1_foundation.sql.
-- Does not introduce transcription, AI analysis, embeddings, or Telegram tables.

alter type public.meeting_status add value if not exists 'recording';
alter type public.meeting_status add value if not exists 'uploading';
alter type public.meeting_status add value if not exists 'processing';
alter type public.meeting_status add value if not exists 'ready_for_transcription';
alter type public.meeting_status add value if not exists 'failed';
alter type public.meeting_status add value if not exists 'archived';

create type public.meeting_processing_status as enum (
  'idle',
  'recording',
  'uploading',
  'uploaded',
  'preparing',
  'ready_for_transcription',
  'failed'
);

create type public.recording_status as enum (
  'registered',
  'recording',
  'paused',
  'uploading',
  'finalizing',
  'finalized',
  'failed',
  'interrupted',
  'deleted'
);

create type public.recording_source_kind as enum (
  'microphone',
  'system_audio',
  'mixed_rendered'
);

create type public.recording_source_role as enum (
  'original',
  'derived'
);

create type public.chunk_upload_state as enum (
  'pending',
  'authorizing',
  'uploading',
  'uploaded',
  'verifying',
  'verified',
  'failed_retryable',
  'failed_terminal'
);

create type public.chunk_verification_state as enum (
  'pending',
  'verifying',
  'verified',
  'rejected'
);

create type public.processing_job_status as enum (
  'queued',
  'running',
  'retryable_failed',
  'succeeded',
  'dead_lettered',
  'cancelled'
);

-- Extend meetings with composite workspace uniqueness and Phase 4 processing/timeline columns.
alter table public.meetings
  add constraint meetings_id_workspace_unique unique (id, workspace_id),
  add column processing_status public.meeting_processing_status not null default 'idle',
  add column started_at timestamptz,
  add column ended_at timestamptz,
  add column timeline_origin_at timestamptz,
  add column timeline_duration_ms integer check (timeline_duration_ms is null or timeline_duration_ms >= 0),
  add column active_capture_duration_ms integer check (active_capture_duration_ms is null or active_capture_duration_ms >= 0),
  add column deleted_at timestamptz,
  add column purge_status text not null default 'active' check (
    purge_status in ('active', 'tombstoned', 'purge_pending', 'purged')
  );

create index meetings_workspace_processing_status_idx
  on public.meetings (workspace_id, processing_status, updated_at desc);

create table public.recordings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  session_id uuid not null,
  status public.recording_status not null default 'registered',
  clock_kind text not null default 'platform_monotonic_continuous' check (
    clock_kind = 'platform_monotonic_continuous'
  ),
  clock_epoch_id text not null check (char_length(pg_catalog.btrim(clock_epoch_id)) between 1 and 64),
  origin_ticks text not null check (origin_ticks ~ '^(0|[1-9][0-9]*)$'),
  origin_wall_clock_utc timestamptz not null,
  tick_frequency_hz bigint not null check (tick_frequency_hz between 1 and 1000000000),
  canonical_duration_ms integer check (canonical_duration_ms is null or canonical_duration_ms >= 0),
  active_capture_ms integer check (active_capture_ms is null or active_capture_ms >= 0),
  started_at timestamptz not null default pg_catalog.now(),
  stopped_at timestamptz,
  finalized_at timestamptz,
  consent_acknowledged_at timestamptz not null,
  consent_policy_version text not null default 'v1' check (
    char_length(pg_catalog.btrim(consent_policy_version)) between 1 and 32
  ),
  manifest_revision integer not null default 1 check (manifest_revision >= 1),
  timeline_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(timeline_metadata) = 'object'
  ),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  deleted_at timestamptz,
  constraint recordings_id_workspace_unique unique (id, workspace_id),
  constraint recordings_id_meeting_workspace_unique unique (id, meeting_id, workspace_id),
  constraint recordings_meeting_session_unique unique (meeting_id, session_id),
  constraint recordings_finalized_check check (
    (status = 'finalized' and finalized_at is not null) or (status <> 'finalized')
  ),
  constraint recordings_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete restrict
);

create index recordings_workspace_meeting_idx
  on public.recordings (workspace_id, meeting_id, created_at desc);
create index recordings_workspace_status_idx
  on public.recordings (workspace_id, status, updated_at desc);

create trigger recordings_set_updated_at
  before update on public.recordings
  for each row execute function public.set_updated_at();

create table public.recording_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  source_kind public.recording_source_kind not null,
  source_role public.recording_source_role not null default 'original',
  is_required boolean not null default true,
  device_uid text check (device_uid is null or char_length(device_uid) <= 128),
  device_name text check (device_name is null or char_length(device_name) <= 160),
  started_at_ticks text check (started_at_ticks is null or started_at_ticks ~ '^(0|[1-9][0-9]*)$'),
  ended_at_ticks text check (ended_at_ticks is null or ended_at_ticks ~ '^(0|[1-9][0-9]*)$'),
  first_sample_index bigint not null default 0 check (first_sample_index >= 0),
  last_sample_index_exclusive bigint check (
    last_sample_index_exclusive is null or last_sample_index_exclusive >= first_sample_index
  ),
  first_sample_meeting_ms integer not null default 0 check (first_sample_meeting_ms >= 0),
  last_sample_meeting_ms integer check (
    last_sample_meeting_ms is null or last_sample_meeting_ms >= first_sample_meeting_ms
  ),
  dropped_sample_count bigint not null default 0 check (dropped_sample_count >= 0),
  expected_chunk_count integer check (expected_chunk_count is null or expected_chunk_count >= 0),
  capture_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(capture_metadata) = 'object'
  ),
  codec text not null check (char_length(pg_catalog.btrim(codec)) between 1 and 64),
  container text not null check (char_length(pg_catalog.btrim(container)) between 1 and 32),
  sample_rate_hz integer not null check (sample_rate_hz between 1 and 1000000000),
  channels smallint not null check (channels between 1 and 32),
  format_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(format_metadata) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint recording_sources_id_recording_workspace_unique unique (id, recording_id, workspace_id),
  constraint recording_sources_recording_kind_role_unique unique (recording_id, source_kind, source_role),
  constraint recording_sources_recording_meeting_workspace_fkey
    foreign key (recording_id, meeting_id, workspace_id)
    references public.recordings (id, meeting_id, workspace_id) on delete cascade
);

create index recording_sources_workspace_recording_idx
  on public.recording_sources (workspace_id, recording_id, source_kind);

create trigger recording_sources_set_updated_at
  before update on public.recording_sources
  for each row execute function public.set_updated_at();

create table public.recording_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  recording_source_id uuid not null,
  client_chunk_id uuid not null,
  idempotency_key text not null check (char_length(pg_catalog.btrim(idempotency_key)) between 1 and 256),
  sequence_no integer not null check (sequence_no >= 0),
  meeting_start_ms integer not null check (meeting_start_ms >= 0),
  meeting_end_ms integer not null check (meeting_end_ms > meeting_start_ms),
  duration_ms integer not null check (duration_ms > 0),
  sample_start bigint not null check (sample_start >= 0),
  sample_end bigint not null check (sample_end > sample_start),
  first_sample_monotonic_ticks text not null default '0' check (
    first_sample_monotonic_ticks ~ '^(0|[1-9][0-9]*)$'
  ),
  byte_size bigint not null check (byte_size > 0),
  checksum_algorithm text not null default 'sha256' check (checksum_algorithm = 'sha256'),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_backend text not null check (storage_backend in ('local', 'memory', 'r2', 's3')),
  storage_key text not null check (
    char_length(pg_catalog.btrim(storage_key)) between 16 and 512
    and storage_key ~ '^workspace/[0-9a-f-]+/meetings/[0-9a-f-]+/recordings/[0-9a-f-]+/sources/[0-9a-f-]+/chunks/[0-9]+\.[a-z0-9]+$'
  ),
  upload_state public.chunk_upload_state not null default 'pending',
  verification_state public.chunk_verification_state not null default 'pending',
  codec text not null check (char_length(pg_catalog.btrim(codec)) between 1 and 64),
  container text not null check (char_length(pg_catalog.btrim(container)) between 1 and 32),
  sample_rate_hz integer not null check (sample_rate_hz between 1 and 1000000000),
  channels smallint not null check (channels between 1 and 32),
  encoder_delay_samples integer not null default 0 check (encoder_delay_samples >= 0),
  encoder_padding_samples integer not null default 0 check (encoder_padding_samples >= 0),
  verified_byte_size bigint check (verified_byte_size is null or verified_byte_size > 0),
  verified_sha256 text check (verified_sha256 is null or verified_sha256 ~ '^[0-9a-f]{64}$'),
  verification_method text check (verification_method is null or char_length(verification_method) <= 64),
  verification_error_code text check (
    verification_error_code is null or char_length(verification_error_code) <= 80
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  uploaded_at timestamptz,
  verified_at timestamptz,
  constraint recording_chunks_source_sequence_unique unique (recording_source_id, sequence_no),
  constraint recording_chunks_recording_idempotency_unique unique (recording_id, idempotency_key),
  constraint recording_chunks_recording_client_chunk_unique unique (recording_id, client_chunk_id),
  constraint recording_chunks_storage_backend_key_unique unique (storage_backend, storage_key),
  constraint recording_chunks_verified_integrity_check check (
    (
      verification_state = 'verified'
      and verified_at is not null
      and verified_byte_size = byte_size
      and verified_sha256 = checksum_sha256
    )
    or (verification_state <> 'verified')
  ),
  constraint recording_chunks_source_recording_workspace_fkey
    foreign key (recording_source_id, recording_id, workspace_id)
    references public.recording_sources (id, recording_id, workspace_id) on delete cascade,
  constraint recording_chunks_recording_meeting_workspace_fkey
    foreign key (recording_id, meeting_id, workspace_id)
    references public.recordings (id, meeting_id, workspace_id) on delete cascade
);

create index recording_chunks_workspace_recording_seq_idx
  on public.recording_chunks (workspace_id, recording_id, recording_source_id, sequence_no);
create index recording_chunks_unverified_idx
  on public.recording_chunks (recording_id, verification_state)
  where verification_state <> 'verified';

create trigger recording_chunks_set_updated_at
  before update on public.recording_chunks
  for each row execute function public.set_updated_at();

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  job_type text not null default 'prepare_recording' check (
    job_type in ('prepare_recording', 'assemble_recording')
  ),
  generation integer not null default 1 check (generation >= 1),
  idempotency_key text not null unique check (char_length(pg_catalog.btrim(idempotency_key)) between 1 and 256),
  status public.processing_job_status not null default 'queued',
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_owner text check (lease_owner is null or char_length(pg_catalog.btrim(lease_owner)) between 1 and 128),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  scheduled_at timestamptz not null default pg_catalog.now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  error_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(error_metadata) = 'object'
  ),
  payload jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(payload) = 'object'),
  result_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(result_metadata) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint processing_jobs_id_workspace_unique unique (id, workspace_id),
  constraint processing_jobs_meeting_recording_type_gen_unique
    unique (meeting_id, recording_id, job_type, generation),
  constraint processing_jobs_running_lease_check check (
    (status = 'running' and lease_owner is not null and lease_expires_at is not null and fencing_token > 0)
    or (status <> 'running')
  ),
  constraint processing_jobs_recording_meeting_workspace_fkey
    foreign key (recording_id, meeting_id, workspace_id)
    references public.recordings (id, meeting_id, workspace_id) on delete cascade,
  constraint processing_jobs_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete restrict
);

create unique index processing_jobs_active_stage_unique_idx
  on public.processing_jobs (meeting_id, job_type, generation)
  where status in ('queued', 'running', 'retryable_failed');
create index processing_jobs_claimable_idx
  on public.processing_jobs (status, scheduled_at, created_at)
  where status in ('queued', 'retryable_failed');
create index processing_jobs_expired_leases_idx
  on public.processing_jobs (status, lease_expires_at)
  where status = 'running';

create trigger processing_jobs_set_updated_at
  before update on public.processing_jobs
  for each row execute function public.set_updated_at();

create table public.processing_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid,
  recording_source_id uuid,
  recording_chunk_id uuid,
  processing_job_id uuid,
  sequence_no integer check (sequence_no is null or sequence_no >= 0),
  event_type text not null check (
    event_type in (
      'recording_created',
      'source_registered',
      'chunk_registered',
      'upload_authorized',
      'chunk_uploaded',
      'chunk_verified',
      'chunk_verification_failed',
      'recording_finalized',
      'recording_finalize_incomplete',
      'job_created',
      'job_claimed',
      'job_heartbeat',
      'job_retry_scheduled',
      'job_reclaimed',
      'job_succeeded',
      'job_failed',
      'job_dead_lettered',
      'job_cancelled',
      'recording_deletion_requested',
      'object_deleted',
      'object_delete_reconciliation_required',
      'recording_deletion_completed'
    )
  ),
  actor_id uuid references public.profiles (id) on delete set null,
  fencing_token bigint,
  metadata jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  constraint processing_events_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete restrict
);

create index processing_events_workspace_meeting_created_idx
  on public.processing_events (workspace_id, meeting_id, created_at asc);
create index processing_events_recording_created_idx
  on public.processing_events (recording_id, created_at asc);
create index processing_events_job_created_idx
  on public.processing_events (processing_job_id, created_at asc);

create table public.object_deletion_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  recording_chunk_id uuid,
  storage_backend text not null check (storage_backend in ('local', 'memory', 'r2', 's3')),
  storage_key text not null check (char_length(pg_catalog.btrim(storage_key)) between 16 and 512),
  expected_byte_size bigint not null check (expected_byte_size > 0),
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (
    status in ('pending', 'deleted', 'reconciliation_required')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 500),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint object_deletion_ledger_backend_key_unique unique (storage_backend, storage_key),
  constraint object_deletion_ledger_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete restrict
);

create index object_deletion_ledger_workspace_status_idx
  on public.object_deletion_ledger (workspace_id, status, updated_at desc);

create trigger object_deletion_ledger_set_updated_at
  before update on public.object_deletion_ledger
  for each row execute function public.set_updated_at();

-- Concurrency-safe worker claiming with FOR UPDATE SKIP LOCKED and expired-lease reclamation.
create function public.claim_next_processing_job(
  p_worker_id text,
  p_lease_seconds integer default 300,
  p_now timestamptz default pg_catalog.now()
)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.processing_jobs;
  v_was_reclaimed boolean := false;
  v_lease_seconds integer := greatest(coalesce(p_lease_seconds, 300), 5);
begin
  if p_worker_id is null or char_length(pg_catalog.btrim(p_worker_id)) = 0 then
    raise exception 'Worker ID is required to claim a processing job' using errcode = '22023';
  end if;

  -- Dead-letter any running jobs whose lease expired and have already exhausted max_attempts.
  for v_job in
    select *
      from public.processing_jobs as pj
     where pj.status = 'running'
       and pj.lease_expires_at <= p_now
       and pj.attempt >= pj.max_attempts
     for update skip locked
  loop
    update public.processing_jobs
       set status = 'dead_lettered',
           lease_owner = null,
           lease_expires_at = null,
           completed_at = p_now,
           error_code = coalesce(error_code, 'lease_expired_max_attempts'),
           error_message = coalesce(error_message, 'Worker lease expired after maximum attempts')
     where id = v_job.id;

    update public.meetings
       set status = 'failed',
           processing_status = 'failed'
     where id = v_job.meeting_id
       and workspace_id = v_job.workspace_id;

    insert into public.processing_events (
      workspace_id, meeting_id, recording_id, processing_job_id, event_type, fencing_token, metadata, created_at
    )
    values (
      v_job.workspace_id,
      v_job.meeting_id,
      v_job.recording_id,
      v_job.id,
      'job_dead_lettered',
      v_job.fencing_token,
      pg_catalog.jsonb_build_object(
        'reason', 'lease_expired_max_attempts',
        'attempt', v_job.attempt,
        'max_attempts', v_job.max_attempts
      ),
      p_now
    );
  end loop;

  select *
    into v_job
    from public.processing_jobs as pj
   where (
           pj.status in ('queued', 'retryable_failed')
           and pj.scheduled_at <= p_now
           and pj.attempt < pj.max_attempts
         )
      or (
           pj.status = 'running'
           and pj.lease_expires_at <= p_now
           and pj.attempt < pj.max_attempts
         )
   order by pj.scheduled_at asc, pj.created_at asc
   for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  v_was_reclaimed := (v_job.status = 'running');

  update public.processing_jobs
     set status = 'running',
         attempt = v_job.attempt + 1,
         lease_owner = pg_catalog.btrim(p_worker_id),
         lease_expires_at = p_now + pg_catalog.make_interval(secs => v_lease_seconds),
         heartbeat_at = p_now,
         fencing_token = v_job.fencing_token + 1,
         started_at = coalesce(v_job.started_at, p_now)
   where id = v_job.id
   returning * into v_job;

  update public.meetings
     set status = 'processing',
         processing_status = 'preparing'
   where id = v_job.meeting_id
     and workspace_id = v_job.workspace_id;

  if v_was_reclaimed then
    insert into public.processing_events (
      workspace_id, meeting_id, recording_id, processing_job_id, event_type, fencing_token, metadata, created_at
    )
    values (
      v_job.workspace_id,
      v_job.meeting_id,
      v_job.recording_id,
      v_job.id,
      'job_reclaimed',
      v_job.fencing_token,
      pg_catalog.jsonb_build_object(
        'lease_owner', v_job.lease_owner,
        'attempt', v_job.attempt
      ),
      p_now
    );
  end if;

  insert into public.processing_events (
    workspace_id, meeting_id, recording_id, processing_job_id, event_type, fencing_token, metadata, created_at
  )
  values (
    v_job.workspace_id,
    v_job.meeting_id,
    v_job.recording_id,
    v_job.id,
    'job_claimed',
    v_job.fencing_token,
    pg_catalog.jsonb_build_object(
      'lease_owner', v_job.lease_owner,
      'attempt', v_job.attempt,
      'reclaimed', v_was_reclaimed
    ),
    p_now
  );

  return next v_job;
end;
$$;

-- Audit triggers on recordings and processing_jobs.
create trigger recordings_audit_insert
  after insert on public.recordings
  for each row execute function public.write_workspace_audit_log();
create trigger processing_jobs_audit_insert
  after insert on public.processing_jobs
  for each row execute function public.write_workspace_audit_log();

-- Row Level Security on all new Phase 4 tables.
alter table public.recordings enable row level security;
alter table public.recording_sources enable row level security;
alter table public.recording_chunks enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.processing_events enable row level security;
alter table public.object_deletion_ledger enable row level security;

create policy recordings_select_member
  on public.recordings for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = recordings.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy recordings_insert_member
  on public.recordings for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and status in ('registered', 'recording')
    and exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = recordings.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy recording_sources_select_member
  on public.recording_sources for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = recording_sources.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy recording_sources_insert_member
  on public.recording_sources for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = recording_sources.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy recording_chunks_select_member
  on public.recording_chunks for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = recording_chunks.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Authenticated clients can only register chunks in unverified pending state; verification is server-only.
create policy recording_chunks_insert_pending_member
  on public.recording_chunks for insert to authenticated
  with check (
    upload_state = 'pending'
    and verification_state = 'pending'
    and verified_at is null
    and exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = recording_chunks.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy processing_jobs_select_member
  on public.processing_jobs for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = processing_jobs.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy processing_events_select_member
  on public.processing_events for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = processing_events.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy object_deletion_ledger_select_member
  on public.object_deletion_ledger for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = object_deletion_ledger.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Minimize direct table grants; worker claiming function is restricted from anon/authenticated.
revoke all on public.recordings, public.recording_sources, public.recording_chunks,
  public.processing_jobs, public.processing_events, public.object_deletion_ledger
  from anon, authenticated;

grant select on public.recordings, public.recording_sources, public.recording_chunks,
  public.processing_jobs, public.processing_events, public.object_deletion_ledger
  to authenticated;

grant insert (
  id, workspace_id, meeting_id, session_id, status, clock_kind, clock_epoch_id,
  origin_ticks, origin_wall_clock_utc, tick_frequency_hz, canonical_duration_ms,
  active_capture_ms, started_at, consent_acknowledged_at, consent_policy_version,
  manifest_revision, timeline_metadata, created_by
) on public.recordings to authenticated;

grant insert (
  id, workspace_id, meeting_id, recording_id, source_kind, source_role, is_required,
  device_uid, device_name, started_at_ticks, ended_at_ticks, first_sample_index,
  last_sample_index_exclusive, first_sample_meeting_ms, last_sample_meeting_ms,
  dropped_sample_count, expected_chunk_count, capture_metadata, codec, container,
  sample_rate_hz, channels, format_metadata
) on public.recording_sources to authenticated;

grant insert (
  id, workspace_id, meeting_id, recording_id, recording_source_id, client_chunk_id,
  idempotency_key, sequence_no, meeting_start_ms, meeting_end_ms, duration_ms,
  sample_start, sample_end, first_sample_monotonic_ticks, byte_size, checksum_algorithm,
  checksum_sha256, storage_backend, storage_key, upload_state, verification_state,
  codec, container, sample_rate_hz, channels, encoder_delay_samples, encoder_padding_samples
) on public.recording_chunks to authenticated;

grant usage on type
  public.meeting_processing_status,
  public.recording_status,
  public.recording_source_kind,
  public.recording_source_role,
  public.chunk_upload_state,
  public.chunk_verification_state,
  public.processing_job_status
  to authenticated;

revoke all on function public.claim_next_processing_job(text, integer, timestamptz) from public, anon, authenticated;
