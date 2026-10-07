-- SUHBAT AI — Phase 6: AI Meeting Intelligence
-- Forward-only migration building on 202610070003_phase5_transcription_alignment.sql.
-- Adds historical analysis runs, structured meeting intelligence entities (summaries, topics,
-- decisions, action items, facts, questions, ideas, objections, commitments, risks), and
-- canonical transcript-segment-linked intelligence evidence.
-- Does not add embeddings/pgvector, Ask AI RAG backend, Telegram, or commercial proposals.

alter type public.meeting_status add value if not exists 'ready_for_analysis';
alter type public.meeting_status add value if not exists 'analyzing';
alter type public.meeting_status add value if not exists 'normalizing_analysis';
alter type public.meeting_status add value if not exists 'analysis_ready';
alter type public.meeting_status add value if not exists 'analysis_failed';
alter type public.meeting_status add value if not exists 'ready';

alter type public.meeting_processing_status add value if not exists 'ready_for_analysis';
alter type public.meeting_processing_status add value if not exists 'analyzing';
alter type public.meeting_processing_status add value if not exists 'normalizing_analysis';
alter type public.meeting_processing_status add value if not exists 'analysis_ready';
alter type public.meeting_processing_status add value if not exists 'analysis_failed';
alter type public.meeting_processing_status add value if not exists 'ready';

create type public.analysis_run_status as enum (
  'queued',
  'running',
  'normalizing',
  'completed',
  'failed',
  'superseded'
);

create type public.decision_status as enum (
  'proposed',
  'tentative',
  'confirmed',
  'rejected',
  'superseded'
);

create type public.action_item_status as enum (
  'open',
  'in_progress',
  'blocked',
  'done',
  'completed',
  'cancelled'
);

create type public.fact_category as enum (
  'budget',
  'metric',
  'target',
  'timeline',
  'team',
  'tooling',
  'commercial',
  'technical',
  'legal',
  'operations',
  'constraint',
  'preference',
  'general'
);

create type public.question_status as enum (
  'open',
  'answered',
  'deferred'
);

create type public.idea_status as enum (
  'captured',
  'exploring',
  'accepted',
  'parked',
  'rejected',
  'new',
  'considering',
  'adopted',
  'dropped'
);

create type public.objection_status as enum (
  'open',
  'addressed',
  'mitigated',
  'unresolved'
);

create type public.commitment_status as enum (
  'pending',
  'kept',
  'at_risk',
  'broken',
  'met',
  'missed'
);

create type public.risk_severity as enum (
  'low',
  'medium',
  'high',
  'critical'
);

create type public.risk_status as enum (
  'open',
  'mitigating',
  'mitigated',
  'resolved',
  'accepted'
);

create type public.intelligence_entity_type as enum (
  'summary',
  'summary_claim',
  'topic',
  'decision',
  'action_item',
  'fact',
  'question',
  'idea',
  'objection',
  'commitment',
  'risk',
  'follow_up'
);

-- Extend processing_jobs and processing_events check constraints for Phase 6 stages and events.
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
      'finalize_analysis'
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
      'analysis_retried'
    )
  );

-- Add composite unique key on transcript_segments including transcription_run_id so intelligence_evidence
-- can enforce same-meeting, same-workspace, AND same-transcription-run integrity at the database level.
alter table public.transcript_segments
  add constraint transcript_segments_id_run_meeting_workspace_unique
    unique (id, transcription_run_id, meeting_id, workspace_id);

-- Historical AI analysis runs. Terminal runs (completed / failed / superseded) are immutable.
create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  recording_id uuid not null,
  transcription_run_id uuid not null,
  run_number integer not null default 1 check (run_number >= 1),
  provider text not null check (char_length(pg_catalog.btrim(provider)) between 2 and 64),
  model text not null check (char_length(pg_catalog.btrim(model)) between 1 and 120),
  prompt_version text not null check (
    char_length(pg_catalog.btrim(prompt_version)) between 1 and 64
  ),
  schema_version text not null check (
    char_length(pg_catalog.btrim(schema_version)) between 1 and 64
  ),
  pipeline_version text not null check (
    char_length(pg_catalog.btrim(pipeline_version)) between 1 and 64
  ),
  status public.analysis_run_status not null default 'queued',
  window_count integer not null default 1 check (window_count >= 1),
  topic_count integer not null default 0 check (topic_count >= 0),
  decision_count integer not null default 0 check (decision_count >= 0),
  action_item_count integer not null default 0 check (action_item_count >= 0),
  fact_count integer not null default 0 check (fact_count >= 0),
  question_count integer not null default 0 check (question_count >= 0),
  idea_count integer not null default 0 check (idea_count >= 0),
  objection_count integer not null default 0 check (objection_count >= 0),
  commitment_count integer not null default 0 check (commitment_count >= 0),
  risk_count integer not null default 0 check (risk_count >= 0),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  quarantined_item_count integer not null default 0 check (quarantined_item_count >= 0),
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
  constraint analysis_runs_id_meeting_workspace_unique
    unique (id, meeting_id, workspace_id),
  constraint analysis_runs_meeting_run_number_unique
    unique (meeting_id, run_number),
  constraint analysis_runs_recording_meeting_workspace_fkey
    foreign key (recording_id, meeting_id, workspace_id)
    references public.recordings (id, meeting_id, workspace_id) on delete cascade,
  constraint analysis_runs_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint analysis_runs_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index analysis_runs_workspace_meeting_created_idx
  on public.analysis_runs (workspace_id, meeting_id, run_number desc, created_at desc);

create trigger analysis_runs_set_updated_at
  before update on public.analysis_runs
  for each row execute function public.set_updated_at();

-- Prevent mutating, overwriting, or deleting a terminal (completed / failed / superseded) analysis run.
create function public.prevent_completed_analysis_run_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('completed', 'failed', 'superseded') then
    raise exception 'Completed analysis_runs rows are immutable (% is historical and cannot be modified)', old.id
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger analysis_runs_immutable_when_terminal
  before update or delete on public.analysis_runs
  for each row execute function public.prevent_completed_analysis_run_mutation();

-- Extend meetings with pointers to current accepted and latest analysis runs.
alter table public.meetings
  add column current_analysis_run_id uuid,
  add column latest_analysis_run_id uuid,
  add constraint meetings_current_analysis_run_fkey
    foreign key (current_analysis_run_id, id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete restrict,
  add constraint meetings_latest_analysis_run_fkey
    foreign key (latest_analysis_run_id, id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete restrict;

-- Structured executive summary per analysis run.
create table public.meeting_summaries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  headline text not null check (char_length(pg_catalog.btrim(headline)) between 1 and 500),
  tl_dr text not null check (char_length(pg_catalog.btrim(tl_dr)) between 1 and 4000),
  why_meeting_happened text not null check (
    char_length(pg_catalog.btrim(why_meeting_happened)) between 1 and 4000
  ),
  major_discussions jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(major_discussions) = 'array'
  ),
  confirmed_decisions jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(confirmed_decisions) = 'array'
  ),
  next_actions jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(next_actions) = 'array'
  ),
  unresolved_points jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(unresolved_points) = 'array'
  ),
  follow_ups jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(follow_ups) = 'array'
  ),
  claims jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(claims) = 'array'
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_summaries_analysis_run_unique
    unique (analysis_run_id),
  constraint meeting_summaries_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_summaries_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_summaries_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_summaries_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_summaries_workspace_meeting_idx
  on public.meeting_summaries (workspace_id, meeting_id, analysis_run_id);

create trigger meeting_summaries_set_updated_at
  before update on public.meeting_summaries
  for each row execute function public.set_updated_at();

-- Structured meeting topics per analysis run.
create table public.meeting_topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  parent_topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  topic_key text not null check (char_length(pg_catalog.btrim(topic_key)) between 1 and 120),
  title text not null check (char_length(pg_catalog.btrim(title)) between 1 and 400),
  summary text not null check (char_length(pg_catalog.btrim(summary)) between 1 and 4000),
  keywords text[] not null default '{}'::text[],
  participant_ids uuid[] not null default '{}'::uuid[],
  speaker_labels text[] not null default '{}'::text[],
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms >= start_ms),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_topics_run_topic_key_unique
    unique (analysis_run_id, topic_key),
  constraint meeting_topics_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_topics_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_topics_parent_run_meeting_workspace_fkey
    foreign key (parent_topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_topics_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_topics_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_topics_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_topics_workspace_meeting_run_idx
  on public.meeting_topics (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_topics_set_updated_at
  before update on public.meeting_topics
  for each row execute function public.set_updated_at();

-- Structured meeting decisions per analysis run.
create table public.meeting_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  decision_key text not null check (
    char_length(pg_catalog.btrim(decision_key)) between 1 and 120
  ),
  statement text not null check (char_length(pg_catalog.btrim(statement)) between 1 and 2000),
  rationale text check (
    rationale is null or char_length(pg_catalog.btrim(rationale)) between 1 and 4000
  ),
  status public.decision_status not null,
  owner_participant_id uuid,
  owner_label text check (
    owner_label is null or char_length(pg_catalog.btrim(owner_label)) between 1 and 160
  ),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_decisions_run_decision_key_unique
    unique (analysis_run_id, decision_key),
  constraint meeting_decisions_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_decisions_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_decisions_owner_meeting_workspace_fkey
    foreign key (owner_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_decisions_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_decisions_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_decisions_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_decisions_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_decisions_workspace_meeting_run_idx
  on public.meeting_decisions (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_decisions_set_updated_at
  before update on public.meeting_decisions
  for each row execute function public.set_updated_at();

-- Structured meeting action items / tasks per analysis run.
create table public.meeting_action_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  decision_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  action_key text not null check (char_length(pg_catalog.btrim(action_key)) between 1 and 120),
  title text not null check (char_length(pg_catalog.btrim(title)) between 1 and 500),
  owner_participant_id uuid,
  owner_label text check (
    owner_label is null or char_length(pg_catalog.btrim(owner_label)) between 1 and 160
  ),
  due_hint text check (
    due_hint is null or char_length(pg_catalog.btrim(due_hint)) between 1 and 200
  ),
  due_date date,
  status public.action_item_status not null default 'open',
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_action_items_run_action_key_unique
    unique (analysis_run_id, action_key),
  constraint meeting_action_items_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_action_items_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_action_items_owner_meeting_workspace_fkey
    foreign key (owner_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_action_items_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_action_items_decision_run_meeting_workspace_fkey
    foreign key (decision_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_decisions (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_action_items_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_action_items_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_action_items_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_action_items_workspace_meeting_run_idx
  on public.meeting_action_items (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_action_items_set_updated_at
  before update on public.meeting_action_items
  for each row execute function public.set_updated_at();

-- Structured meeting facts per analysis run.
create table public.meeting_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  fact_key text not null check (char_length(pg_catalog.btrim(fact_key)) between 1 and 120),
  category public.fact_category not null,
  label text not null check (char_length(pg_catalog.btrim(label)) between 1 and 400),
  value_text text not null check (
    char_length(pg_catalog.btrim(value_text)) between 1 and 400
  ),
  unit text check (unit is null or char_length(pg_catalog.btrim(unit)) between 1 and 80),
  numeric_value double precision,
  speaker_participant_id uuid,
  speaker_label text check (
    speaker_label is null or char_length(pg_catalog.btrim(speaker_label)) between 1 and 160
  ),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_facts_run_fact_key_unique
    unique (analysis_run_id, fact_key),
  constraint meeting_facts_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_facts_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_facts_speaker_meeting_workspace_fkey
    foreign key (speaker_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_facts_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_facts_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_facts_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_facts_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_facts_workspace_meeting_run_idx
  on public.meeting_facts (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_facts_set_updated_at
  before update on public.meeting_facts
  for each row execute function public.set_updated_at();

-- Structured meeting questions per analysis run.
create table public.meeting_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  question_key text not null check (
    char_length(pg_catalog.btrim(question_key)) between 1 and 120
  ),
  question text not null check (
    char_length(pg_catalog.btrim(question)) between 1 and 2000
  ),
  status public.question_status not null default 'open',
  asked_by_participant_id uuid,
  asked_by_label text check (
    asked_by_label is null or char_length(pg_catalog.btrim(asked_by_label)) between 1 and 160
  ),
  owner_participant_id uuid,
  owner_label text check (
    owner_label is null or char_length(pg_catalog.btrim(owner_label)) between 1 and 160
  ),
  answer_summary text check (
    answer_summary is null or char_length(pg_catalog.btrim(answer_summary)) between 1 and 2000
  ),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_questions_run_question_key_unique
    unique (analysis_run_id, question_key),
  constraint meeting_questions_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_questions_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_questions_asked_by_meeting_workspace_fkey
    foreign key (asked_by_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_questions_owner_meeting_workspace_fkey
    foreign key (owner_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_questions_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_questions_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_questions_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_questions_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_questions_workspace_meeting_run_idx
  on public.meeting_questions (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_questions_set_updated_at
  before update on public.meeting_questions
  for each row execute function public.set_updated_at();

-- Structured meeting ideas per analysis run.
create table public.meeting_ideas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  idea_key text not null check (char_length(pg_catalog.btrim(idea_key)) between 1 and 120),
  idea text not null check (char_length(pg_catalog.btrim(idea)) between 1 and 2000),
  notes text check (
    notes is null or char_length(pg_catalog.btrim(notes)) between 1 and 2000
  ),
  status public.idea_status not null default 'new',
  proposed_by_participant_id uuid,
  proposed_by_label text check (
    proposed_by_label is null or char_length(pg_catalog.btrim(proposed_by_label)) between 1 and 160
  ),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_ideas_run_idea_key_unique
    unique (analysis_run_id, idea_key),
  constraint meeting_ideas_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_ideas_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_ideas_proposed_by_meeting_workspace_fkey
    foreign key (proposed_by_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_ideas_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_ideas_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_ideas_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_ideas_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_ideas_workspace_meeting_run_idx
  on public.meeting_ideas (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_ideas_set_updated_at
  before update on public.meeting_ideas
  for each row execute function public.set_updated_at();

-- Structured meeting objections per analysis run.
create table public.meeting_objections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  objection_key text not null check (
    char_length(pg_catalog.btrim(objection_key)) between 1 and 120
  ),
  summary text not null check (char_length(pg_catalog.btrim(summary)) between 1 and 2000),
  status public.objection_status not null default 'open',
  raised_by_participant_id uuid,
  raised_by_label text check (
    raised_by_label is null or char_length(pg_catalog.btrim(raised_by_label)) between 1 and 160
  ),
  response_summary text check (
    response_summary is null or char_length(pg_catalog.btrim(response_summary)) between 1 and 2000
  ),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_objections_run_objection_key_unique
    unique (analysis_run_id, objection_key),
  constraint meeting_objections_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_objections_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_objections_raised_by_meeting_workspace_fkey
    foreign key (raised_by_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_objections_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_objections_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_objections_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_objections_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_objections_workspace_meeting_run_idx
  on public.meeting_objections (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_objections_set_updated_at
  before update on public.meeting_objections
  for each row execute function public.set_updated_at();

-- Structured meeting commitments per analysis run.
create table public.meeting_commitments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  commitment_key text not null check (
    char_length(pg_catalog.btrim(commitment_key)) between 1 and 120
  ),
  commitment text not null check (
    char_length(pg_catalog.btrim(commitment)) between 1 and 2000
  ),
  owner_participant_id uuid,
  owner_label text check (
    owner_label is null or char_length(pg_catalog.btrim(owner_label)) between 1 and 160
  ),
  counterparty_label text check (
    counterparty_label is null
    or char_length(pg_catalog.btrim(counterparty_label)) between 1 and 160
  ),
  due_label text check (
    due_label is null or char_length(pg_catalog.btrim(due_label)) between 1 and 200
  ),
  status public.commitment_status not null default 'pending',
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_commitments_run_commitment_key_unique
    unique (analysis_run_id, commitment_key),
  constraint meeting_commitments_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_commitments_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_commitments_owner_meeting_workspace_fkey
    foreign key (owner_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_commitments_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_commitments_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_commitments_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_commitments_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_commitments_workspace_meeting_run_idx
  on public.meeting_commitments (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_commitments_set_updated_at
  before update on public.meeting_commitments
  for each row execute function public.set_updated_at();

-- Structured meeting risks per analysis run.
create table public.meeting_risks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  topic_id uuid,
  sequence_no integer not null check (sequence_no >= 0),
  risk_key text not null check (char_length(pg_catalog.btrim(risk_key)) between 1 and 120),
  title text not null check (char_length(pg_catalog.btrim(title)) between 1 and 500),
  detail text check (
    detail is null or char_length(pg_catalog.btrim(detail)) between 1 and 2000
  ),
  severity public.risk_severity not null default 'medium',
  status public.risk_status not null default 'open',
  mitigation text check (
    mitigation is null or char_length(pg_catalog.btrim(mitigation)) between 1 and 2000
  ),
  owner_participant_id uuid,
  owner_label text check (
    owner_label is null or char_length(pg_catalog.btrim(owner_label)) between 1 and 160
  ),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  source_segment_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_risks_run_risk_key_unique
    unique (analysis_run_id, risk_key),
  constraint meeting_risks_run_sequence_unique
    unique (analysis_run_id, sequence_no),
  constraint meeting_risks_id_run_meeting_workspace_unique
    unique (id, analysis_run_id, meeting_id, workspace_id),
  constraint meeting_risks_owner_meeting_workspace_fkey
    foreign key (owner_participant_id, meeting_id, workspace_id)
    references public.meeting_participants (id, meeting_id, workspace_id) on delete set null,
  constraint meeting_risks_topic_run_meeting_workspace_fkey
    foreign key (topic_id, analysis_run_id, meeting_id, workspace_id)
    references public.meeting_topics (id, analysis_run_id, meeting_id, workspace_id) on delete set null,
  constraint meeting_risks_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_risks_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint meeting_risks_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index meeting_risks_workspace_meeting_run_idx
  on public.meeting_risks (workspace_id, meeting_id, analysis_run_id, sequence_no asc);

create trigger meeting_risks_set_updated_at
  before update on public.meeting_risks
  for each row execute function public.set_updated_at();

-- Canonical evidence linking every intelligence entity to persisted transcript_segments in the
-- exact same workspace, meeting, and transcription run. Timestamps are derived strictly from
-- canonical transcript_segments, never from LLM-generated numbers.
create table public.intelligence_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  transcription_run_id uuid not null,
  entity_type public.intelligence_entity_type not null,
  entity_id uuid not null,
  transcript_segment_id uuid not null,
  evidence_order integer not null default 0 check (evidence_order >= 0),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms > start_ms),
  speaker_display_label text not null check (
    char_length(pg_catalog.btrim(speaker_display_label)) between 1 and 160
  ),
  excerpt text not null check (char_length(pg_catalog.btrim(excerpt)) between 1 and 4000),
  confidence double precision check (
    confidence is null or (confidence >= 0.0 and confidence <= 1.0)
  ),
  created_at timestamptz not null default pg_catalog.now(),
  constraint intelligence_evidence_run_entity_segment_unique
    unique (analysis_run_id, entity_type, entity_id, transcript_segment_id),
  constraint intelligence_evidence_analysis_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint intelligence_evidence_transcription_run_meeting_workspace_fkey
    foreign key (transcription_run_id, meeting_id, workspace_id)
    references public.transcription_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint intelligence_evidence_segment_run_meeting_workspace_fkey
    foreign key (transcript_segment_id, transcription_run_id, meeting_id, workspace_id)
    references public.transcript_segments (id, transcription_run_id, meeting_id, workspace_id) on delete cascade,
  constraint intelligence_evidence_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade
);

create index intelligence_evidence_run_entity_idx
  on public.intelligence_evidence (analysis_run_id, entity_type, entity_id, evidence_order asc);
create index intelligence_evidence_workspace_meeting_segment_idx
  on public.intelligence_evidence (workspace_id, meeting_id, transcript_segment_id);

-- Update claim_next_processing_job so meeting status reflects Phase 4, Phase 5, and Phase 6 job stages.
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

-- Audit trigger for analysis runs.
create trigger analysis_runs_audit_insert
  after insert on public.analysis_runs
  for each row execute function public.write_workspace_audit_log();

-- Enable Row-Level Security on all Phase 6 tables.
alter table public.analysis_runs enable row level security;
alter table public.meeting_summaries enable row level security;
alter table public.meeting_topics enable row level security;
alter table public.meeting_decisions enable row level security;
alter table public.meeting_action_items enable row level security;
alter table public.meeting_facts enable row level security;
alter table public.meeting_questions enable row level security;
alter table public.meeting_ideas enable row level security;
alter table public.meeting_objections enable row level security;
alter table public.meeting_commitments enable row level security;
alter table public.meeting_risks enable row level security;
alter table public.intelligence_evidence enable row level security;

-- Workspace-scoped SELECT policies for active workspace members.
-- Direct client INSERT/UPDATE/DELETE policies are intentionally omitted: all writes are
-- performed exclusively by trusted server/worker services after authorization and evidence validation.
create policy analysis_runs_select_member
  on public.analysis_runs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = analysis_runs.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_summaries_select_member
  on public.meeting_summaries
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_summaries.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_topics_select_member
  on public.meeting_topics
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_topics.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_decisions_select_member
  on public.meeting_decisions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_decisions.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_action_items_select_member
  on public.meeting_action_items
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_action_items.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_facts_select_member
  on public.meeting_facts
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_facts.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_questions_select_member
  on public.meeting_questions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_questions.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_ideas_select_member
  on public.meeting_ideas
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_ideas.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_objections_select_member
  on public.meeting_objections
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_objections.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_commitments_select_member
  on public.meeting_commitments
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_commitments.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meeting_risks_select_member
  on public.meeting_risks
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_risks.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy intelligence_evidence_select_member
  on public.intelligence_evidence
  for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = intelligence_evidence.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Enforce Phase 4.1 server-mediated security posture: zero direct client writes on Phase 6 tables.
revoke all on
  public.analysis_runs,
  public.meeting_summaries,
  public.meeting_topics,
  public.meeting_decisions,
  public.meeting_action_items,
  public.meeting_facts,
  public.meeting_questions,
  public.meeting_ideas,
  public.meeting_objections,
  public.meeting_commitments,
  public.meeting_risks,
  public.intelligence_evidence
  from public, anon, authenticated;

grant select on
  public.analysis_runs,
  public.meeting_summaries,
  public.meeting_topics,
  public.meeting_decisions,
  public.meeting_action_items,
  public.meeting_facts,
  public.meeting_questions,
  public.meeting_ideas,
  public.meeting_objections,
  public.meeting_commitments,
  public.meeting_risks,
  public.intelligence_evidence
  to authenticated;

grant usage on type
  public.analysis_run_status,
  public.decision_status,
  public.action_item_status,
  public.fact_category,
  public.question_status,
  public.idea_status,
  public.objection_status,
  public.commitment_status,
  public.risk_severity,
  public.risk_status,
  public.intelligence_entity_type
  to authenticated;

revoke all on function public.claim_next_processing_job(text, integer, timestamptz)
  from public, anon, authenticated;
revoke all on function public.prevent_completed_analysis_run_mutation()
  from public, anon;
grant execute on function public.prevent_completed_analysis_run_mutation()
  to authenticated;
