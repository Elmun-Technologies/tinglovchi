-- Phase 9: Business Automation, User-Confirmed Outbound Actions, Auditable Idempotency & Meeting Exports
-- Forward-only migration building on Phases 1–8 without modifying prior migrations.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'automation_connector_type') then
    create type public.automation_connector_type as enum (
      'webhook_n8n',
      'amocrm',
      'google_docs',
      'google_calendar',
      'meeting_export'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'automation_connector_status') then
    create type public.automation_connector_status as enum (
      'active',
      'disabled'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'automation_action_type') then
    create type public.automation_action_type as enum (
      'export_meeting_report',
      'sync_crm_summary',
      'sync_crm_tasks',
      'publish_google_doc',
      'schedule_calendar_followup',
      'trigger_n8n_workflow'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'automation_action_status') then
    create type public.automation_action_status as enum (
      'pending_confirmation',
      'confirmed',
      'executing',
      'succeeded',
      'failed',
      'cancelled'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'meeting_export_format') then
    create type public.meeting_export_format as enum (
      'md',
      'txt',
      'csv',
      'json'
    );
  end if;
end
$$;

-- 1. Workspace automation connectors (configured by workspace owners/admins)
create table if not exists public.workspace_automation_connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connector_type public.automation_connector_type not null,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  status public.automation_connector_status not null default 'active',
  endpoint_url text null check (endpoint_url is null or endpoint_url ~ '^https?://'),
  config_metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, workspace_id),
  unique (workspace_id, connector_type)
);

create index if not exists workspace_automation_connectors_workspace_idx
  on public.workspace_automation_connectors (workspace_id, status);

-- 2. Business automation actions ledger (strict user-confirmation barrier + idempotency key)
create table if not exists public.business_automation_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  connector_id uuid null,
  connector_type public.automation_connector_type not null,
  action_type public.automation_action_type not null,
  status public.automation_action_status not null default 'pending_confirmation',
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 8 and 200),
  confirmation_token_sha256 text not null check (confirmation_token_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_preview jsonb not null default '{}'::jsonb,
  evidence_segment_ids uuid[] not null default '{}'::uuid[],
  requested_by uuid not null references public.profiles (id) on delete restrict,
  confirmed_by uuid null references public.profiles (id) on delete restrict,
  confirmed_at timestamptz null,
  executed_at timestamptz null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  external_reference_id text null check (external_reference_id is null or char_length(btrim(external_reference_id)) between 1 and 200),
  external_url text null check (external_url is null or external_url ~ '^https?://'),
  error_code text null check (error_code is null or char_length(btrim(error_code)) between 1 and 120),
  error_message text null check (error_message is null or char_length(btrim(error_message)) between 1 and 500),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, workspace_id),
  unique (workspace_id, idempotency_key),
  constraint business_automation_actions_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id)
    on delete cascade,
  constraint business_automation_actions_analysis_run_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id)
    on delete restrict,
  constraint business_automation_actions_connector_fkey
    foreign key (connector_id, workspace_id)
    references public.workspace_automation_connectors (id, workspace_id)
    on delete set null (connector_id),
  -- Hard SQL invariant: no action may be confirmed, executing, or succeeded without explicit user confirmation
  constraint business_automation_actions_confirmation_required_check
    check (
      status in ('pending_confirmation', 'cancelled')
      or (confirmed_by is not null and confirmed_at is not null)
    )
);

create index if not exists business_automation_actions_workspace_meeting_idx
  on public.business_automation_actions (workspace_id, meeting_id, created_at desc);

-- 3. Auditable meeting exports ledger
create table if not exists public.meeting_exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  meeting_id uuid not null,
  analysis_run_id uuid null,
  export_format public.meeting_export_format not null,
  include_transcript boolean not null default false,
  filename text not null check (char_length(btrim(filename)) between 1 and 200),
  byte_size integer not null check (byte_size >= 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  exported_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, workspace_id),
  constraint meeting_exports_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id)
    on delete cascade
);

create index if not exists meeting_exports_workspace_meeting_idx
  on public.meeting_exports (workspace_id, meeting_id, created_at desc);

-- 4. Extend processing_jobs job_type check constraint for 'execute_automation_action'
alter table public.processing_jobs
  drop constraint if exists processing_jobs_job_type_check;

alter table public.processing_jobs
  add constraint processing_jobs_job_type_check
  check (
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
      'index_knowledge',
      'send_telegram_notifications',
      'execute_automation_action'
    )
  );

-- 5. Update claim_next_processing_job so 'execute_automation_action' preserves 'ready' meeting status
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

    if v_job.job_type not in (
      'generate_embeddings',
      'index_knowledge',
      'send_telegram_notifications',
      'execute_automation_action'
    ) then
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

  if v_job.job_type not in (
    'generate_embeddings',
    'index_knowledge',
    'send_telegram_notifications',
    'execute_automation_action'
  ) then
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

  insert into public.processing_events (
    workspace_id, meeting_id, recording_id, processing_job_id, event_type, fencing_token, metadata, created_at
  )
  values (
    v_job.workspace_id,
    v_job.meeting_id,
    v_job.recording_id,
    v_job.id,
    case when v_was_reclaimed then 'lease_reclaimed' else 'job_claimed' end,
    v_job.fencing_token,
    pg_catalog.jsonb_build_object(
      'worker_id', pg_catalog.btrim(p_worker_id),
      'job_type', v_job.job_type,
      'attempt', v_job.attempt,
      'lease_expires_at', v_job.lease_expires_at
    ),
    p_now
  );

  return next v_job;
end;
$$;

revoke all on function public.claim_next_processing_job(text, integer, timestamptz) from public, anon, authenticated;

-- 6. Updated-at and audit triggers
drop trigger if exists set_workspace_automation_connectors_updated_at on public.workspace_automation_connectors;
create trigger set_workspace_automation_connectors_updated_at
  before update on public.workspace_automation_connectors
  for each row execute function public.set_updated_at();

drop trigger if exists set_business_automation_actions_updated_at on public.business_automation_actions;
create trigger set_business_automation_actions_updated_at
  before update on public.business_automation_actions
  for each row execute function public.set_updated_at();

drop trigger if exists audit_workspace_automation_connectors on public.workspace_automation_connectors;
create trigger audit_workspace_automation_connectors
  after insert or update on public.workspace_automation_connectors
  for each row execute function public.write_workspace_audit_log();

drop trigger if exists audit_business_automation_actions on public.business_automation_actions;
create trigger audit_business_automation_actions
  after insert or update on public.business_automation_actions
  for each row execute function public.write_workspace_audit_log();

drop trigger if exists audit_meeting_exports on public.meeting_exports;
create trigger audit_meeting_exports
  after insert on public.meeting_exports
  for each row execute function public.write_workspace_audit_log();

-- 7. Row-Level Security (RLS) & privilege boundaries
alter table public.workspace_automation_connectors enable row level security;
alter table public.business_automation_actions enable row level security;
alter table public.meeting_exports enable row level security;

revoke all on public.workspace_automation_connectors from public, anon, authenticated;
revoke all on public.business_automation_actions from public, anon, authenticated;
revoke all on public.meeting_exports from public, anon, authenticated;

grant select on public.workspace_automation_connectors to authenticated;
grant select on public.business_automation_actions to authenticated;
grant select on public.meeting_exports to authenticated;

drop policy if exists workspace_automation_connectors_select_member on public.workspace_automation_connectors;
create policy workspace_automation_connectors_select_member
  on public.workspace_automation_connectors
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.workspace_members as wm
       where wm.workspace_id = workspace_automation_connectors.workspace_id
         and wm.user_id = (select auth.uid())
         and wm.membership_status = 'active'
    )
  );

drop policy if exists business_automation_actions_select_member on public.business_automation_actions;
create policy business_automation_actions_select_member
  on public.business_automation_actions
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.workspace_members as wm
       where wm.workspace_id = business_automation_actions.workspace_id
         and wm.user_id = (select auth.uid())
         and wm.membership_status = 'active'
    )
  );

drop policy if exists meeting_exports_select_member on public.meeting_exports;
create policy meeting_exports_select_member
  on public.meeting_exports
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.workspace_members as wm
       where wm.workspace_id = meeting_exports.workspace_id
         and wm.user_id = (select auth.uid())
         and wm.membership_status = 'active'
    )
  );
