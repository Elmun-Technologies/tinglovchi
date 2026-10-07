-- SUHBAT AI — Phase 5: Transcription & Canonical Alignment Pipeline
-- Forward-only migration building on 202610070002_phase4_1_security_hardening.sql.
-- Adds canonical transcription input assets, historical transcription runs, speaker diarization
-- identities & participant mappings, and canonical meeting-aligned transcript segments.
-- Does not add OpenAI analysis, summaries, decisions/tasks/facts tables, embeddings, or Telegram.

alter type public.meeting_status add value if not exists 'transcribing';
alter type public.meeting_status add value if not exists 'normalizing_transcript';
alter type public.meeting_status add value if not exists 'transcript_ready';
alter type public.meeting_status add value if not exists 'transcription_failed';

alter type public.meeting_processing_status add value if not exists 'transcribing';
alter type public.meeting_processing_status add value if not exists 'normalizing_transcript';
alter type public.meeting_processing_status add value if not exists 'transcript_ready';
alter type public.meeting_processing_status add value if not exists 'transcription_failed';

create type public.transcription_asset_status as enum (
  'preparing',
  'ready',
  'failed',
  'deleted'
);

create type public.transcription_run_status as enum (
  'queued',
  'running',
  'normalizing',
  'completed',
  'failed',
  'superseded'
);

-- Extend processing_jobs and processing_events check constraints for Phase 5 stages and events.
alter table public.processing_jobs
  drop constraint if exists processing_jobs_job_type_check,
  add constraint processing_jobs_job_type_check check (
    job_type in (
      'prepare_recording',
      'assemble_recording',
      'transcribe_meeting',
      'normalize_transcript',
      'finalize_transcript'
    )
  );

alter table public.processing_events
  drop constraint if exists processing_events_event_type_check,
  add constraint processing_events_event_type_check check (
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
      'recording_deletion_completed',
      'transcription_asset_prepared',
      'transcription_started',
      'transcription_completed',
      'transcription_failed',
      'transcript_normalized',
      'transcript_finalized',
      'speaker_mapping_updated'
    )
  );

-- Canonical transcription input assets and persisted piecewise asset -> meeting timeline maps.
create table public.transcription_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  asset_version integer not null default 1 check (asset_version >= 1),
  asset_role text not null default 'canonical_transcription_input' check (
    asset_role in ('canonical_transcription_input')
  ),
  status public.transcription_asset_status not null default 'ready',
  storage_backend text not null default 'local' check (
    storage_backend in ('local', 'memory', 'r2', 's3', 'manifest_virtual')
  ),
  storage_key text not null check (
    char_length(pg_catalog.btrim(storage_key)) between 16 and 512
  ),
  container text not null check (container in ('wav', 'ogg', 'opus', 'flac', 'm4a')),
  codec text not null check (char_length(pg_catalog.btrim(codec)) between 1 and 64),
  sample_rate_hz integer not null check (sample_rate_hz between 8000 and 192000),
  channels smallint not null check (channels between 1 and 32),
  byte_size bigint not null check (byte_size > 0),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  asset_duration_ms integer not null check (asset_duration_ms > 0),
  canonical_duration_ms integer not null check (canonical_duration_ms > 0),
  active_capture_ms integer not null check (active_capture_ms > 0),
  timeline_map jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(timeline_map) = 'array'
  ),
  source_lineage jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(source_lineage) = 'array'
  ),
  preparation_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(preparation_metadata) = 'object'
  ),
  prepared_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint transcription_assets_id_recording_meeting_workspace_unique
    unique (id, recording_id, meeting_id, workspace_id),
  constraint transcription_assets_recording_asset_version_unique
    unique (recording_id, asset_version),
  constraint transcription_assets_recording_meeting_workspace_fkey
    foreign key (recording_id, meeting_id, workspace_id)
    references public.recordings (id, meeting_id, workspace_id) on delete cascade,
  constraint transcription_assets_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index transcription_assets_workspace_meeting_idx
  on public.transcription_assets (workspace_id, meeting_id, asset_version desc);

create trigger transcription_assets_set_updated_at
  before update on public.transcription_assets
  for each row execute function public.set_updated_at();

-- Historical transcription runs. Completed runs (completed / failed / superseded) are immutable.
create table public.transcription_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  transcription_asset_id uuid not null,
  asset_version integer not null default 1 check (asset_version >= 1),
  run_number integer not null default 1 check (run_number >= 1),
  provider text not null check (char_length(pg_catalog.btrim(provider)) between 2 and 64),
  provider_model text not null check (
    char_length(pg_catalog.btrim(provider_model)) between 1 and 120
  ),
  provider_job_id text check (
    provider_job_id is null or char_length(pg_catalog.btrim(provider_job_id)) between 1 and 200
  ),
  status public.transcription_run_status not null default 'queued',
  normalization_version integer not null default 1 check (normalization_version >= 1),
  requested_languages text[] not null default array['uz', 'ru', 'en']::text[],
  detected_languages text[] not null default '{}'::text[],
  diarization_enabled boolean not null default true,
  segment_count integer not null default 0 check (segment_count >= 0),
  quarantined_segment_count integer not null default 0 check (quarantined_segment_count >= 0),
  speaker_count integer not null default 0 check (speaker_count >= 0),
  word_count integer not null default 0 check (word_count >= 0),
  confidence_avg double precision check (
    confidence_avg is null or (confidence_avg >= 0.0 and confidence_avg <= 1.0)
  ),
  started_at timestamptz,
  provider_completed_at timestamptz,
  completed_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  error_message text check (error_message is null or char_length(error_message) <= 600),
  failure_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(failure_metadata) = 'object'
  ),
  provider_summary_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(provider_summary_metadata) = 'object'
  ),
  raw_provider_response jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(raw_provider_response) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint transcription_runs_id_meeting_workspace_unique
    unique (id, meeting_id, workspace_id),
  constraint transcription_runs_recording_run_number_unique
    unique (recording_id, run_number),
  constraint transcription_runs_asset_recording_meeting_workspace_fkey
    foreign key (transcription_asset_id, recording_id, meeting_id, workspace_id)
    references public.transcription_assets (id, recording_id, meeting_id, workspace_id) on delete cascade,
  constraint transcription_runs_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index transcription_runs_workspace_meeting_created_idx
  on public.transcription_runs (workspace_id, meeting_id, run_number desc, created_at desc);

create trigger transcription_runs_set_updated_at
  before update on public.transcription_runs
  for each row execute function public.set_updated_at();

-- Prevent mutating, overwriting, or deleting a completed (completed / failed / superseded) transcription run.
create function public.prevent_completed_transcription_run_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('completed', 'failed', 'superseded') then
    raise exception 'Completed transcription_runs rows are immutable (% is historical and cannot be modified)', old.id
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger transcription_runs_immutable_when_terminal
  before update or delete on public.transcription_runs
  for each row execute function public.prevent_completed_transcription_run_mutation();

-- Extend meetings with pointers to current accepted and latest transcription runs plus detected languages.
alter table public.meetings
  add column current_transcription_run_id uuid,
  add column latest_transcription_run_id uuid,
  add column detected_languages text[] not null default '{}'::text[],
  add constraint meetings_current_transcription_run_fkey
    foreign key (current_transcription_run_id, id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete restrict,
  add constraint meetings_latest_transcription_run_fkey
    foreign key (latest_transcription_run_id, id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete restrict;

-- Meeting participants roster (attendees eligible for speaker mapping).
create table public.meeting_participants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  user_id uuid references public.profiles (id) on delete set null,
  display_name text not null check (char_length(pg_catalog.btrim(display_name)) between 1 and 160),
  role_label text check (role_label is null or char_length(pg_catalog.btrim(role_label)) <= 120),
  email text check (email is null or char_length(pg_catalog.btrim(email)) <= 240),
  is_external boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_participants_id_meeting_workspace_unique
    unique (id, meeting_id, workspace_id),
  constraint meeting_participants_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create unique index meeting_participants_meeting_user_unique_idx
  on public.meeting_participants (meeting_id, user_id)
  where user_id is not null;

create index meeting_participants_workspace_meeting_idx
  on public.meeting_participants (workspace_id, meeting_id, sort_order asc, created_at asc);

create trigger meeting_participants_set_updated_at
  before update on public.meeting_participants
  for each row execute function public.set_updated_at();

-- Diarization speaker identities per transcription run, separable from participant mapping so speaker
-- assignment never rewrites transcript segment text.
create table public.meeting_speakers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  transcription_run_id uuid not null,
  provider_speaker_label text not null check (provider_speaker_label ~ '^speaker_[0-9]+$'),
  display_label text not null check (char_length(pg_catalog.btrim(display_label)) between 1 and 160),
  participant_id uuid,
  mapped_by uuid references public.profiles (id) on delete set null,
  mapped_at timestamptz,
  segment_count integer not null default 0 check (segment_count >= 0),
  speaking_duration_ms integer not null default 0 check (speaking_duration_ms >= 0),
  confidence_avg double precision check (
    confidence_avg is null or (confidence_avg >= 0.0 and confidence_avg <= 1.0)
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_speakers_run_provider_speaker_unique
    unique (transcription_run_id, provider_speaker_label),
  constraint meeting_speakers_id_run_meeting_workspace_unique
    unique (id, transcription_run_id, meeting_id, workspace_id),
  constraint meeting_speakers_participant_meeting_workspace_fkey
    foreign key (participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_speakers_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_speakers_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_speakers_workspace_meeting_idx
  on public.meeting_speakers (workspace_id, meeting_id, transcription_run_id, provider_speaker_label asc);

create trigger meeting_speakers_set_updated_at
  before update on public.meeting_speakers
  for each row execute function public.set_updated_at();

-- Canonical meeting-aligned transcript segments.
create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  transcription_run_id uuid not null,
  transcription_asset_id uuid not null,
  sequence_no integer not null check (sequence_no >= 0),
  provider_segment_key text not null check (
    char_length(pg_catalog.btrim(provider_segment_key)) between 1 and 128
  ),
  speaker_id uuid not null,
  provider_speaker_label text not null check (provider_speaker_label ~ '^speaker_[0-9]+$'),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms > start_ms),
  duration_ms integer not null check (duration_ms = end_ms - start_ms),
  asset_start_ms integer not null check (asset_start_ms >= 0),
  asset_end_ms integer not null check (asset_end_ms > asset_start_ms),
  source_recording_source_id uuid,
  source_recording_chunk_id uuid,
  source_sample_start bigint check (source_sample_start is null or source_sample_start >= 0),
  source_sample_end bigint check (
    source_sample_end is null or source_sample_end > source_sample_start
  ),
  text text not null check (char_length(pg_catalog.btrim(text)) between 1 and 16000),
  language text not null check (language in ('uz', 'ru', 'en', 'mixed', 'unknown')),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  word_count integer not null default 0 check (word_count >= 0),
  words jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(words) = 'array'
  ),
  alignment_status text not null default 'canonical' check (
    alignment_status in ('canonical', 'quarantined')
  ),
  alignment_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(alignment_metadata) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  constraint transcript_segments_run_sequence_unique
    unique (transcription_run_id, sequence_no),
  constraint transcript_segments_run_provider_key_unique
    unique (transcription_run_id, provider_segment_key),
  constraint transcript_segments_id_meeting_workspace_unique
    unique (id, meeting_id, workspace_id),
  constraint transcript_segments_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint transcript_segments_speaker_run_meeting_workspace_fkey
    foreign key (speaker_id, transcription_run_id, meeting_id, workspace_id)
    references public.meeting_speakers (id, transcription_run_id, meeting_id, workspace_id) on delete cascade,
  constraint transcript_segments_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index transcript_segments_meeting_run_order_idx
  on public.transcript_segments (meeting_id, transcription_run_id, sequence_no asc);
create index transcript_segments_meeting_start_ms_idx
  on public.transcript_segments (meeting_id, start_ms asc, sequence_no asc);
create index transcript_segments_workspace_meeting_speaker_idx
  on public.transcript_segments (workspace_id, meeting_id, provider_speaker_label);

-- Update claim_next_processing_job so meeting status reflects the claimed Phase 4 or Phase 5 job stage.
create or replace function public.claim_next_processing_job(
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
       set status = case
             when v_job.job_type in ('transcribe_meeting', 'normalize_transcript', 'finalize_transcript')
               then 'transcription_failed'::public.meeting_status
             else 'failed'::public.meeting_status
           end,
           processing_status = case
             when v_job.job_type in ('transcribe_meeting', 'normalize_transcript', 'finalize_transcript')
               then 'transcription_failed'::public.meeting_processing_status
             else 'failed'::public.meeting_processing_status
           end
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
        'job_type', v_job.job_type,
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
     set status = case
           when v_job.job_type = 'transcribe_meeting'
             then 'transcribing'::public.meeting_status
           when v_job.job_type in ('normalize_transcript', 'finalize_transcript')
             then 'normalizing_transcript'::public.meeting_status
           else 'processing'::public.meeting_status
         end,
         processing_status = case
           when v_job.job_type = 'transcribe_meeting'
             then 'transcribing'::public.meeting_processing_status
           when v_job.job_type in ('normalize_transcript', 'finalize_transcript')
             then 'normalizing_transcript'::public.meeting_processing_status
           else 'preparing'::public.meeting_processing_status
         end
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
        'job_type', v_job.job_type,
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
      'job_type', v_job.job_type,
      'attempt', v_job.attempt,
      'reclaimed', v_was_reclaimed
    ),
    p_now
  );

  return next v_job;
end;
$$;

-- Audit trigger for transcription runs.
create trigger transcription_runs_audit_insert
  after insert on public.transcription_runs
  for each row execute function public.write_workspace_audit_log();

-- Enable Row Level Security on all Phase 5 tables.
alter table public.transcription_assets enable row level security;
alter table public.transcription_runs enable row level security;
alter table public.meeting_participants enable row level security;
alter table public.meeting_speakers enable row level security;
alter table public.transcript_segments enable row level security;

create policy transcription_assets_select_member
  on public.transcription_assets for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = transcription_assets.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy transcription_runs_select_member
  on public.transcription_runs for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = transcription_runs.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_participants_select_member
  on public.meeting_participants for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_participants.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_speakers_select_member
  on public.meeting_speakers for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_speakers.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy transcript_segments_select_member
  on public.transcript_segments for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = transcript_segments.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Enforce Phase 4.1 server-mediated security posture: zero direct client writes on Phase 5 tables.
revoke all on
  public.transcription_assets,
  public.transcription_runs,
  public.meeting_participants,
  public.meeting_speakers,
  public.transcript_segments
  from public, anon, authenticated;

grant select on
  public.transcription_assets,
  public.transcription_runs,
  public.meeting_participants,
  public.meeting_speakers,
  public.transcript_segments
  to authenticated;

grant usage on type
  public.transcription_asset_status,
  public.transcription_run_status
  to authenticated;

revoke all on function public.claim_next_processing_job(text, integer, timestamptz)
  from public, anon, authenticated;
revoke all on function public.prevent_completed_transcription_run_mutation()
  from public, anon;
grant execute on function public.prevent_completed_transcription_run_mutation()
  to authenticated;
