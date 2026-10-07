-- SUHBAT AI — Phase 8: Telegram Companion Adapter, Account Linking & Processing-Ready Notifications
-- Forward-only migration building on 202610070005_phase7_company_memory_ask_ai.sql.
-- Adds single-use hashed Telegram account link tokens, workspace-scoped Telegram account links
-- with sliding-window rate-limit state, durable processing-ready notification deliveries,
-- notification-failure isolation in claim_next_processing_job, audit triggers, and RLS policies.

create type public.telegram_link_token_status as enum (
  'pending',
  'redeemed',
  'expired',
  'revoked'
);

create type public.telegram_account_link_status as enum (
  'active',
  'unlinked',
  'suspended'
);

create type public.telegram_notification_status as enum (
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped'
);

-- Extend processing_jobs and processing_events check constraints for Phase 8 stages and events.
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
      'index_knowledge',
      'send_telegram_notifications'
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
      'ask_ai_queried',
      'telegram_link_token_created',
      'telegram_account_linked',
      'telegram_account_unlinked',
      'telegram_notification_queued',
      'telegram_notification_sent',
      'telegram_notification_failed',
      'telegram_bot_command_handled',
      'telegram_rate_limited'
    )
  );

-- Short-lived, single-use account-linking tokens. Only the SHA-256 digest of the token is stored.
create table public.telegram_link_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  status public.telegram_link_token_status not null default 'pending',
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_telegram_user_id text check (
    redeemed_telegram_user_id is null
    or char_length(pg_catalog.btrim(redeemed_telegram_user_id)) between 1 and 64
  ),
  redeemed_telegram_chat_id text check (
    redeemed_telegram_chat_id is null
    or char_length(pg_catalog.btrim(redeemed_telegram_chat_id)) between 1 and 64
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint telegram_link_tokens_expiry_check check (expires_at > created_at)
);

create index telegram_link_tokens_workspace_user_idx
  on public.telegram_link_tokens (workspace_id, user_id, status, created_at desc);

create trigger telegram_link_tokens_set_updated_at
  before update on public.telegram_link_tokens
  for each row execute function public.set_updated_at();

-- Workspace-scoped Telegram account bindings. Telegram remains a companion client adapter
-- authorized strictly through active workspace membership.
create table public.telegram_account_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  telegram_user_id text not null check (
    char_length(pg_catalog.btrim(telegram_user_id)) between 1 and 64
  ),
  telegram_chat_id text not null check (
    char_length(pg_catalog.btrim(telegram_chat_id)) between 1 and 64
  ),
  telegram_username text check (
    telegram_username is null
    or char_length(pg_catalog.btrim(telegram_username)) between 1 and 120
  ),
  telegram_display_name text check (
    telegram_display_name is null
    or char_length(pg_catalog.btrim(telegram_display_name)) between 1 and 160
  ),
  preferred_language text not null default 'uz' check (
    preferred_language in ('uz', 'ru', 'en')
  ),
  notify_on_meeting_ready boolean not null default true,
  status public.telegram_account_link_status not null default 'active',
  rate_limit_window_started_at timestamptz not null default pg_catalog.now(),
  rate_limit_count integer not null default 0 check (rate_limit_count >= 0),
  last_command_at timestamptz,
  linked_at timestamptz not null default pg_catalog.now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint telegram_account_links_workspace_user_unique
    unique (workspace_id, user_id),
  constraint telegram_account_links_id_workspace_unique
    unique (id, workspace_id)
);

-- A Telegram chat can be actively linked to at most one workspace user at a time for unambiguous bot routing,
-- or scoped per workspace; partial unique index on active chat_id ensures deterministic command routing.
create unique index telegram_account_links_active_chat_unique_idx
  on public.telegram_account_links (telegram_chat_id)
  where status = 'active';

create index telegram_account_links_workspace_status_idx
  on public.telegram_account_links (workspace_id, status, notify_on_meeting_ready);

create trigger telegram_account_links_set_updated_at
  before update on public.telegram_account_links
  for each row execute function public.set_updated_at();

-- Durable notification delivery outbox / ledger for processing-ready notifications.
-- Failures here are isolated and never mark a meeting as failed.
create table public.telegram_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  meeting_id uuid not null,
  analysis_run_id uuid not null,
  telegram_account_link_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  notification_type text not null default 'meeting_ready' check (
    notification_type in ('meeting_ready')
  ),
  idempotency_key text not null unique check (
    char_length(pg_catalog.btrim(idempotency_key)) between 8 and 200
  ),
  status public.telegram_notification_status not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  deep_link_url text not null check (
    char_length(pg_catalog.btrim(deep_link_url)) between 8 and 1000
  ),
  payload_metadata jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(payload_metadata) = 'object'
  ),
  provider_message_id text check (
    provider_message_id is null or char_length(provider_message_id) <= 120
  ),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  error_message text check (error_message is null or char_length(error_message) <= 600),
  sent_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint telegram_notification_deliveries_meeting_workspace_fkey
    foreign key (meeting_id, workspace_id)
    references public.meetings (id, workspace_id) on delete cascade,
  constraint telegram_notification_deliveries_analysis_run_meeting_workspace_fkey
    foreign key (analysis_run_id, meeting_id, workspace_id)
    references public.analysis_runs (id, meeting_id, workspace_id) on delete cascade,
  constraint telegram_notification_deliveries_link_workspace_fkey
    foreign key (telegram_account_link_id, workspace_id)
    references public.telegram_account_links (id, workspace_id) on delete cascade
);

create index telegram_notification_deliveries_workspace_meeting_idx
  on public.telegram_notification_deliveries (workspace_id, meeting_id, status, created_at desc);

create trigger telegram_notification_deliveries_set_updated_at
  before update on public.telegram_notification_deliveries
  for each row execute function public.set_updated_at();

-- Update claim_next_processing_job so Phase 7 and Phase 8 post-ready jobs
-- ('generate_embeddings', 'index_knowledge', 'send_telegram_notifications')
-- preserve the meeting's 'ready' status even on claim or dead-letter.
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

    if v_job.job_type not in ('generate_embeddings', 'index_knowledge', 'send_telegram_notifications') then
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

  if v_job.job_type not in ('generate_embeddings', 'index_knowledge', 'send_telegram_notifications') then
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
    case when v_was_reclaimed then 'job_reclaimed' else 'job_claimed' end,
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

-- Audit triggers for Telegram link lifecycle
create trigger telegram_account_links_audit_insert
  after insert on public.telegram_account_links
  for each row execute function public.write_workspace_audit_log('telegram_account_link.created', 'telegram_account_link');

create trigger telegram_account_links_audit_update
  after update on public.telegram_account_links
  for each row execute function public.write_workspace_audit_log('telegram_account_link.updated', 'telegram_account_link');

-- Row-Level Security (RLS) & privilege boundaries for Phase 8 tables
alter table public.telegram_link_tokens enable row level security;
alter table public.telegram_account_links enable row level security;
alter table public.telegram_notification_deliveries enable row level security;

revoke all on table public.telegram_link_tokens from public, anon, authenticated;
revoke all on table public.telegram_account_links from public, anon, authenticated;
revoke all on table public.telegram_notification_deliveries from public, anon, authenticated;

grant select on table public.telegram_link_tokens to authenticated;
grant select on table public.telegram_account_links to authenticated;
grant select on table public.telegram_notification_deliveries to authenticated;

-- Users can only read their own link tokens in workspaces where they are active members.
create policy telegram_link_tokens_select_own_active_member
  on public.telegram_link_tokens
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
        from public.workspace_members as wm
       where wm.workspace_id = telegram_link_tokens.workspace_id
         and wm.user_id = (select auth.uid())
         and wm.membership_status = 'active'
    )
  );

-- Active workspace members can read their own Telegram link (and workspace owners/admins can inspect workspace links).
create policy telegram_account_links_select_workspace_member
  on public.telegram_account_links
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.workspace_members as wm
       where wm.workspace_id = telegram_account_links.workspace_id
         and wm.user_id = (select auth.uid())
         and wm.membership_status = 'active'
         and (
           telegram_account_links.user_id = (select auth.uid())
           or wm.role in ('owner', 'admin')
         )
    )
  );

-- Active workspace members can read their own notification deliveries (and owners/admins can inspect workspace deliveries).
create policy telegram_notification_deliveries_select_workspace_member
  on public.telegram_notification_deliveries
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.workspace_members as wm
       where wm.workspace_id = telegram_notification_deliveries.workspace_id
         and wm.user_id = (select auth.uid())
         and wm.membership_status = 'active'
         and (
           telegram_notification_deliveries.user_id = (select auth.uid())
           or wm.role in ('owner', 'admin')
         )
    )
  );
