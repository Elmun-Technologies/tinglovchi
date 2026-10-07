-- SUHBAT AI — Phase 7: Company Memory, Knowledge Chunks, Embeddings & Ask AI (RAG)
-- Forward-only migration building on 202610070004_phase6_meeting_intelligence.sql.
-- Adds historical embedding runs, versioned knowledge chunks with normalized transcript/item
-- source joins, in-database cosine similarity ranking, auditable Ask AI queries, and
-- workspace-scoped RLS policies.

create type public.embedding_run_status as enum (
  'queued',
  'running',
  'completed',
  'failed',
  'superseded'
);

create type public.knowledge_chunk_type as enum (
  'transcript',
  'summary',
  'topic',
  'decision',
  'action_item',
  'fact',
  'question',
  'idea',
  'objection',
  'commitment',
  'risk'
);

-- Extend processing_jobs and processing_events check constraints for Phase 7 stages and events.
alter table public.processing_jobs
  drop constraint if exists processing_jobs_job_type_check,
  add constraint processing_jobs_job_type_check check (
    job_type in (
      'prepare_recording',
      'assemble_recording',
      'transcribe_meeting',
      'normalize_transcript',
      'finalize_transcript',
      'analyze_meeting',
      'normalize_intelligence',
      'finalize_analysis',
      'generate_embeddings',
      'index_knowledge'
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
      'speaker_mapping_updated',
      'analysis_started',
      'analysis_window_processed',
      'analysis_completed',
      'analysis_failed',
      'intelligence_normalized',
      'intelligence_evidence_quarantined',
      'analysis_finalized',
      'analysis_retried',
      'embeddings_started',
      'embeddings_completed',
      'embeddings_failed',
      'knowledge_indexed',
      'knowledge_reindexed',
      'ask_ai_queried'
    )
  );

-- Pure SQL cosine similarity function over double precision[] vectors so vector similarity
-- executes natively inside PostgreSQL (compatible with both Supabase PostgreSQL and PGlite)
-- after workspace/company/project/tombstone predicates are applied.
create or replace function public.cosine_similarity(
  p_vec_a double precision[],
  p_vec_b double precision[]
)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $$
declare
  v_len_a integer := coalesce(pg_catalog.array_length(p_vec_a, 1), 0);
  v_len_b integer := coalesce(pg_catalog.array_length(p_vec_b, 1), 0);
  v_dot double precision := 0.0;
  v_norm_a double precision := 0.0;
  v_norm_b double precision := 0.0;
  v_i integer;
begin
  if v_len_a = 0 or v_len_a <> v_len_b then
    return 0.0;
  end if;

  for v_i in 1..v_len_a loop
    v_dot := v_dot + (p_vec_a[v_i] * p_vec_b[v_i]);
    v_norm_a := v_norm_a + (p_vec_a[v_i] * p_vec_a[v_i]);
    v_norm_b := v_norm_b + (p_vec_b[v_i] * p_vec_b[v_i]);
  end loop;

  if v_norm_a <= 0.0 or v_norm_b <= 0.0 then
    return 0.0;
  end if;

  return v_dot / (pg_catalog.sqrt(v_norm_a) * pg_catalog.sqrt(v_norm_b));
end;
$$;

-- Historical embedding / knowledge-indexing runs. Terminal runs are immutable.
create table public.embedding_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  transcription_run_id uuid not null,
  analysis_run_id uuid not null,
  run_number integer not null default 1 check (run_number >= 1),
  provider text not null check (char_length(pg_catalog.btrim(provider)) between 2 and 64),
  model text not null check (char_length(pg_catalog.btrim(model)) between 1 and 120),
  dimensions integer not null check (dimensions between 8 and 4096),
  chunking_version text not null check (
    char_length(pg_catalog.btrim(chunking_version)) between 1 and 64
  ),
  status public.embedding_run_status not null default 'queued',
  chunk_count integer not null default 0 check (chunk_count >= 0),
  transcript_source_count integer not null default 0 check (transcript_source_count >= 0),
  item_source_count integer not null default 0 check (item_source_count >= 0),
  started_at timestamptz,
  provider_completed_at timestamptz,
  completed_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 80),
  error_message text check (error_message is null or char_length(error_message) <= 600),
  failure_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(failure_metadata) = 'object'
  ),
  token_usage_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(token_usage_metadata) = 'object'
  ),
  raw_provider_response jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(raw_provider_response) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint embedding_runs_id_meeting_workspace_unique
    unique (id, meeting_id, workspace_id),
  constraint embedding_runs_meeting_run_number_unique
    unique (meeting_id, run_number),
  constraint embedding_runs_recording_meeting_workspace_fkey
    foreign key (recording_id, meeting_id, workspace_id)
    references public.recordings (id, meeting_id, workspace_id) on delete cascade,
  constraint embedding_runs_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint embedding_runs_analysis_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint embedding_runs_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index embedding_runs_workspace_meeting_created_idx
  on public.embedding_runs (workspace_id, meeting_id, run_number desc, created_at desc);

create trigger embedding_runs_set_updated_at
  before update on public.embedding_runs
  for each row execute function public.set_updated_at();

create function public.prevent_completed_embedding_run_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('completed', 'failed', 'superseded') then
    raise exception 'Completed embedding_runs rows are immutable (% is historical and cannot be modified)', old.id
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger embedding_runs_immutable_when_terminal
  before update or delete on public.embedding_runs
  for each row execute function public.prevent_completed_embedding_run_mutation();

alter table public.meetings
  add column current_embedding_run_id uuid,
  add column latest_embedding_run_id uuid,
  add constraint meetings_current_embedding_run_fkey
    foreign key (current_embedding_run_id, id, workspace_id)
    references public.embedding_runs (id, meeting_id, workspace_id) on delete restrict,
  add constraint meetings_latest_embedding_run_fkey
    foreign key (latest_embedding_run_id, id, workspace_id)
    references public.embedding_runs (id, meeting_id, workspace_id) on delete restrict;

-- Versioned knowledge chunks with workspace/company/project/meeting hierarchy and fixed-dimension embeddings.
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  company_id uuid,
  project_id uuid,
  meeting_id uuid not null,
  embedding_run_id uuid not null,
  transcription_run_id uuid not null,
  analysis_run_id uuid not null,
  sequence_no integer not null check (sequence_no >= 0),
  chunk_key text not null check (char_length(pg_catalog.btrim(chunk_key)) between 1 and 160),
  chunk_type public.knowledge_chunk_type not null,
  title text not null check (char_length(pg_catalog.btrim(title)) between 1 and 500),
  canonical_text text not null check (
    char_length(pg_catalog.btrim(canonical_text)) between 1 and 16000
  ),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms >= start_ms),
  speaker_labels text[] not null default '{}'::text[],
  participant_ids uuid[] not null default '{}'::uuid[],
  tags text[] not null default '{}'::text[],
  source_version text not null check (
    char_length(pg_catalog.btrim(source_version)) between 1 and 64
  ),
  embedding_provider text not null check (
    char_length(pg_catalog.btrim(embedding_provider)) between 2 and 64
  ),
  embedding_model text not null check (
    char_length(pg_catalog.btrim(embedding_model)) between 1 and 120
  ),
  embedding_dimensions integer not null check (embedding_dimensions between 8 and 4096),
  embedding double precision[] not null check (
    pg_catalog.cardinality(embedding) = embedding_dimensions
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint knowledge_chunks_run_chunk_key_unique
    unique (embedding_run_id, chunk_key),
  constraint knowledge_chunks_run_sequence_unique
    unique (embedding_run_id, sequence_no),
  constraint knowledge_chunks_id_run_meeting_workspace_unique
    unique (id, embedding_run_id, meeting_id, workspace_id),
  constraint knowledge_chunks_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete set null,
  constraint knowledge_chunks_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete set null,
  constraint knowledge_chunks_embedding_run_meeting_workspace_fkey
    foreign key (embedding_run_id, meeting_id, workspace_id)
    references public.embedding_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunks_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunks_analysis_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunks_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index knowledge_chunks_workspace_scope_idx
  on public.knowledge_chunks (workspace_id, company_id, project_id, meeting_id, chunk_type);
create index knowledge_chunks_meeting_run_order_idx
  on public.knowledge_chunks (meeting_id, embedding_run_id, sequence_no asc);

create trigger knowledge_chunks_set_updated_at
  before update on public.knowledge_chunks
  for each row execute function public.set_updated_at();

-- Normalized join from knowledge_chunks to canonical transcript_segments (docs/database.md §133).
create table public.knowledge_chunk_transcript_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  embedding_run_id uuid not null,
  transcription_run_id uuid not null,
  knowledge_chunk_id uuid not null,
  transcript_segment_id uuid not null,
  sequence_no integer not null default 0 check (sequence_no >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  constraint knowledge_chunk_transcript_sources_unique
    unique (knowledge_chunk_id, transcript_segment_id),
  constraint knowledge_chunk_transcript_sources_chunk_fkey
    foreign key (knowledge_chunk_id, embedding_run_id, meeting_id, workspace_id)
    references public.knowledge_chunks (id, embedding_run_id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunk_transcript_sources_segment_fkey
    foreign key (transcript_segment_id, transcription_run_id, meeting_id, workspace_id)
    references public.transcript_segments (id, transcription_run_id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunk_transcript_sources_meeting_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index knowledge_chunk_transcript_sources_chunk_idx
  on public.knowledge_chunk_transcript_sources (knowledge_chunk_id, sequence_no asc);
create index knowledge_chunk_transcript_sources_segment_idx
  on public.knowledge_chunk_transcript_sources (workspace_id, meeting_id, transcript_segment_id);

-- Normalized join from knowledge_chunks to typed intelligence items (docs/database.md §133).
create table public.knowledge_chunk_item_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  embedding_run_id uuid not null,
  analysis_run_id uuid not null,
  knowledge_chunk_id uuid not null,
  entity_type public.intelligence_entity_type not null,
  entity_id uuid not null,
  sequence_no integer not null default 0 check (sequence_no >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  constraint knowledge_chunk_item_sources_unique
    unique (knowledge_chunk_id, entity_type, entity_id),
  constraint knowledge_chunk_item_sources_chunk_fkey
    foreign key (knowledge_chunk_id, embedding_run_id, meeting_id, workspace_id)
    references public.knowledge_chunks (id, embedding_run_id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunk_item_sources_analysis_run_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint knowledge_chunk_item_sources_meeting_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index knowledge_chunk_item_sources_chunk_idx
  on public.knowledge_chunk_item_sources (knowledge_chunk_id, sequence_no asc);
create index knowledge_chunk_item_sources_entity_idx
  on public.knowledge_chunk_item_sources (workspace_id, meeting_id, entity_type, entity_id);

-- Auditable Ask AI query log (workspace/company/project/meeting scoped).
create table public.ask_ai_queries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  company_id uuid,
  project_id uuid,
  meeting_id uuid,
  asked_by uuid not null references public.profiles (id) on delete restrict,
  question text not null check (char_length(pg_catalog.btrim(question)) between 1 and 2000),
  adapter text not null check (adapter in ('rag_pipeline', 'demo_fixtures')),
  provider text not null check (char_length(pg_catalog.btrim(provider)) between 2 and 64),
  model text not null check (char_length(pg_catalog.btrim(model)) between 1 and 120),
  retrieved_chunk_ids uuid[] not null default '{}'::uuid[],
  citation_count integer not null default 0 check (citation_count >= 0),
  answer_payload jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(answer_payload) = 'object'
  ),
  created_at timestamptz not null default pg_catalog.now(),
  constraint ask_ai_queries_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete set null,
  constraint ask_ai_queries_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete set null,
  constraint ask_ai_queries_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete set null
);

create index ask_ai_queries_workspace_created_idx
  on public.ask_ai_queries (workspace_id, created_at desc);

-- Update claim_next_processing_job so Phase 7 embedding/indexing jobs preserve the meeting's 'ready' status.
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

    if v_job.job_type not in ('generate_embeddings', 'index_knowledge') then
      update public.meetings
         set status = case
               when v_job.job_type in ('transcribe_meeting', 'normalize_transcript', 'finalize_transcript')
                 then 'transcription_failed'::public.meeting_status
               when v_job.job_type in ('analyze_meeting', 'normalize_intelligence', 'finalize_analysis')
                 then 'analysis_failed'::public.meeting_status
               else 'failed'::public.meeting_status
             end,
             processing_status = case
               when v_job.job_type in ('transcribe_meeting', 'normalize_transcript', 'finalize_transcript')
                 then 'transcription_failed'::public.meeting_processing_status
               when v_job.job_type in ('analyze_meeting', 'normalize_intelligence', 'finalize_analysis')
                 then 'analysis_failed'::public.meeting_processing_status
               else 'failed'::public.meeting_processing_status
             end
       where id = v_job.meeting_id
         and workspace_id = v_job.workspace_id;
    end if;

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

  if v_job.job_type not in ('generate_embeddings', 'index_knowledge') then
    update public.meetings
       set status = case
             when v_job.job_type = 'transcribe_meeting'
               then 'transcribing'::public.meeting_status
             when v_job.job_type in ('normalize_transcript', 'finalize_transcript')
               then 'normalizing_transcript'::public.meeting_status
             when v_job.job_type = 'analyze_meeting'
               then 'analyzing'::public.meeting_status
             when v_job.job_type in ('normalize_intelligence', 'finalize_analysis')
               then 'normalizing_analysis'::public.meeting_status
             else 'processing'::public.meeting_status
           end,
           processing_status = case
             when v_job.job_type = 'transcribe_meeting'
               then 'transcribing'::public.meeting_processing_status
             when v_job.job_type in ('normalize_transcript', 'finalize_transcript')
               then 'normalizing_transcript'::public.meeting_processing_status
             when v_job.job_type = 'analyze_meeting'
               then 'analyzing'::public.meeting_processing_status
             when v_job.job_type in ('normalize_intelligence', 'finalize_analysis')
               then 'normalizing_analysis'::public.meeting_processing_status
             else 'preparing'::public.meeting_processing_status
           end
     where id = v_job.meeting_id
       and workspace_id = v_job.workspace_id;
  end if;

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
      'attempt', v_job.attempt
    ),
    p_now
  );

  return next v_job;
end;
$$;

-- Audit triggers for embedding runs and Ask AI queries.
create trigger embedding_runs_audit_insert
  after insert on public.embedding_runs
  for each row execute function public.write_workspace_audit_log();

create trigger ask_ai_queries_audit_insert
  after insert on public.ask_ai_queries
  for each row execute function public.write_workspace_audit_log();

-- Enable Row-Level Security on all Phase 7 tables.
alter table public.embedding_runs enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_chunk_transcript_sources enable row level security;
alter table public.knowledge_chunk_item_sources enable row level security;
alter table public.ask_ai_queries enable row level security;

-- Workspace-scoped SELECT policies for active workspace members.
create policy embedding_runs_select_member
  on public.embedding_runs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = embedding_runs.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy knowledge_chunks_select_member
  on public.knowledge_chunks
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = knowledge_chunks.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy knowledge_chunk_transcript_sources_select_member
  on public.knowledge_chunk_transcript_sources
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = knowledge_chunk_transcript_sources.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy knowledge_chunk_item_sources_select_member
  on public.knowledge_chunk_item_sources
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = knowledge_chunk_item_sources.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy ask_ai_queries_select_member
  on public.ask_ai_queries
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = ask_ai_queries.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Enforce Phase 4.1 server-mediated security posture: zero direct client writes on Phase 7 tables.
revoke all on
  public.embedding_runs,
  public.knowledge_chunks,
  public.knowledge_chunk_transcript_sources,
  public.knowledge_chunk_item_sources,
  public.ask_ai_queries
  from public, anon, authenticated;

grant select on
  public.embedding_runs,
  public.knowledge_chunks,
  public.knowledge_chunk_transcript_sources,
  public.knowledge_chunk_item_sources,
  public.ask_ai_queries
  to authenticated;

grant usage on type
  public.embedding_run_status,
  public.knowledge_chunk_type
  to authenticated;

revoke all on function public.claim_next_processing_job(text, integer, timestamptz)
  from public, anon, authenticated;
revoke all on function public.prevent_completed_embedding_run_mutation()
  from public, anon;
grant execute on function public.prevent_completed_embedding_run_mutation()
  to authenticated;
grant execute on function public.cosine_similarity(double precision[], double precision[])
  to authenticated;
