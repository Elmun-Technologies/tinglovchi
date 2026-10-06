-- Phase 1 foundation: Auth profiles, workspaces, companies, projects, meeting drafts and RLS.
-- Apply through Supabase migrations. Do not run this against a production database without review.

-- membership_role and membership_status are core identity-domain vocabularies, not future-phase
-- scaffolding. Phase 1 provisions only an active owner and grants no client membership writes, so
-- invited/suspended states are reserved rows that RLS already constrains.
create type public.membership_role as enum ('owner', 'admin', 'member');
create type public.membership_status as enum ('invited', 'active', 'suspended');
-- Phase 1 creates drafts only. Capture and processing lifecycle states belong to later migrations.
create type public.meeting_status as enum ('draft');

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 120),
  locale text not null default 'en' check (char_length(locale) between 2 and 16),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  v_display_name := nullif(
    pg_catalog.left(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), 120),
    ''
  );

  insert into public.profiles (id, display_name)
  values (new.id, v_display_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(pg_catalog.btrim(name)) between 2 and 80),
  slug text not null unique check (
    char_length(slug) between 1 and 64
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.membership_role not null,
  membership_status public.membership_status not null default 'active',
  joined_at timestamptz not null default pg_catalog.now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_status_idx
  on public.workspace_members (user_id, membership_status, workspace_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) between 1 and 80),
  target_type text not null check (char_length(target_type) between 1 and 64),
  target_id uuid not null,
  request_id text check (request_id is null or char_length(request_id) <= 128),
  metadata jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default pg_catalog.now()
);

create index audit_logs_workspace_created_idx
  on public.audit_logs (workspace_id, created_at desc);

-- System defaults are seeded here and copied into each new workspace. They are not tenant data.
create table public.meeting_type_templates (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  display_name text not null check (char_length(pg_catalog.btrim(display_name)) between 1 and 80),
  sort_order smallint not null default 0,
  is_active boolean not null default true
);

insert into public.meeting_type_templates (key, display_name, sort_order)
values
  ('general', 'General', 10),
  ('client_sales', 'Client sales', 20),
  ('marketing', 'Marketing', 30),
  ('internal', 'Internal', 40),
  ('brainstorm', 'Brainstorm', 50),
  ('project_planning', 'Project planning', 60),
  ('interview', 'Interview', 70);

-- archived_at is part of the core company/project entity (context must survive reorganization) and
-- is settable only by owners/admins; Phase 1 does not expose an archive control in the UI.
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  name text not null check (char_length(pg_catalog.btrim(name)) between 2 and 120),
  description text check (description is null or char_length(description) <= 1000),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz,
  constraint companies_id_workspace_unique unique (id, workspace_id)
);

create index companies_workspace_name_idx on public.companies (workspace_id, name);
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  company_id uuid,
  name text not null check (char_length(pg_catalog.btrim(name)) between 2 and 120),
  description text check (description is null or char_length(description) <= 1000),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz,
  constraint projects_id_workspace_unique unique (id, workspace_id),
  constraint projects_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete restrict
);

create index projects_workspace_name_idx on public.projects (workspace_id, name);
create index projects_workspace_company_idx on public.projects (workspace_id, company_id);
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- Meeting types stay per-workspace text keys (UNIQUE(workspace_id, key)) rather than a PostgreSQL
-- enum so later phases can add workspace-custom types without a schema change. Phase 1 intentionally
-- omits the future analysis_profile_key: no analysis behavior exists yet.
create table public.meeting_types (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  display_name text not null check (char_length(pg_catalog.btrim(display_name)) between 1 and 80),
  template_key text references public.meeting_type_templates (key) on delete restrict,
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_types_workspace_key_unique unique (workspace_id, key),
  constraint meeting_types_id_workspace_unique unique (id, workspace_id)
);

create index meeting_types_workspace_active_order_idx
  on public.meeting_types (workspace_id, is_active, sort_order);
create trigger meeting_types_set_updated_at
  before update on public.meeting_types
  for each row execute function public.set_updated_at();

-- Phase 1 meetings are canonical draft records: hierarchy placement, title, type, status, and
-- authorship. Capture/processing fields (started_at, ended_at, duration, languages, pipeline and
-- transcription/analysis statuses, run pointers) are deliberately absent; they arrive with the
-- migration that implements their owning phase and can backfill from real behavior.
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  company_id uuid,
  project_id uuid,
  meeting_type_id uuid not null,
  title text not null check (char_length(pg_catalog.btrim(title)) between 2 and 180),
  status public.meeting_status not null default 'draft',
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meetings_company_workspace_fkey
    foreign key (company_id, workspace_id)
    references public.companies (id, workspace_id) on delete restrict,
  constraint meetings_project_workspace_fkey
    foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete restrict,
  constraint meetings_type_workspace_fkey
    foreign key (meeting_type_id, workspace_id)
    references public.meeting_types (id, workspace_id) on delete restrict
);

create index meetings_workspace_created_idx
  on public.meetings (workspace_id, created_at desc);
create index meetings_workspace_status_updated_idx
  on public.meetings (workspace_id, status, updated_at desc);
create index meetings_workspace_company_date_idx
  on public.meetings (workspace_id, company_id, created_at desc);
create index meetings_workspace_project_date_idx
  on public.meetings (workspace_id, project_id, created_at desc);

create trigger meetings_set_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

create function public.validate_meeting_project_company()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project_company_id uuid;
begin
  if new.project_id is null then
    return new;
  end if;

  select p.company_id
    into v_project_company_id
    from public.projects as p
   where p.id = new.project_id
     and p.workspace_id = new.workspace_id;

  if found
     and v_project_company_id is not null
     and new.company_id is distinct from v_project_company_id then
    raise exception 'Meeting company must match the selected project company'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger meetings_validate_project_company
  before insert or update of project_id, company_id, workspace_id on public.meetings
  for each row execute function public.validate_meeting_project_company();

-- Successful critical writes are audited without copying names, descriptions, or meeting titles.
create function public.write_workspace_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := pg_catalog.to_jsonb(new);
  v_workspace_id uuid;
  v_target_id uuid;
  v_actor_id uuid := auth.uid();
  v_metadata jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'workspaces' then
    v_workspace_id := (v_row ->> 'id')::uuid;
    v_target_id := (v_row ->> 'id')::uuid;
    v_actor_id := coalesce(v_actor_id, (v_row ->> 'created_by')::uuid);
  else
    v_workspace_id := (v_row ->> 'workspace_id')::uuid;
    v_target_id := coalesce((v_row ->> 'id')::uuid, (v_row ->> 'user_id')::uuid);
  end if;

  if tg_table_name = 'workspace_members' then
    v_metadata := pg_catalog.jsonb_build_object('role', v_row ->> 'role');
  end if;

  insert into public.audit_logs (workspace_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_workspace_id,
    v_actor_id,
    pg_catalog.lower(tg_table_name) || '.' || pg_catalog.lower(tg_op),
    tg_table_name,
    v_target_id,
    v_metadata
  );

  return new;
end;
$$;

create trigger workspaces_audit_insert
  after insert on public.workspaces
  for each row execute function public.write_workspace_audit_log();
create trigger workspace_members_audit_insert
  after insert on public.workspace_members
  for each row execute function public.write_workspace_audit_log();
create trigger companies_audit_write
  after insert or update on public.companies
  for each row execute function public.write_workspace_audit_log();
create trigger projects_audit_write
  after insert or update on public.projects
  for each row execute function public.write_workspace_audit_log();
create trigger meetings_audit_insert
  after insert on public.meetings
  for each row execute function public.write_workspace_audit_log();

-- Authenticated users can create a workspace only through this atomic, narrowly scoped function.
-- It creates the first owner and copies current system meeting-type templates in one transaction.
create function public.create_workspace(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_slug text;
  v_base_slug text;
  v_rows integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_name is null or char_length(pg_catalog.btrim(p_name)) not between 2 and 80 then
    raise exception 'Workspace name must be between 2 and 80 characters' using errcode = '22023';
  end if;

  if p_slug is null
     or char_length(p_slug) > 64
     or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'Workspace slug is invalid' using errcode = '22023';
  end if;

  v_base_slug := pg_catalog.rtrim(pg_catalog.left(p_slug, 48), '-');
  if v_base_slug = '' then
    v_base_slug := 'workspace';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_base_slug));
  v_slug := v_base_slug;
  while exists (select 1 from public.workspaces as w where w.slug = v_slug) loop
    v_slug := v_base_slug || '-' || pg_catalog.substr(gen_random_uuid()::text, 1, 8);
  end loop;

  insert into public.workspaces (name, slug, created_by)
  values (pg_catalog.btrim(p_name), v_slug, v_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role, membership_status)
  values (v_workspace_id, v_user_id, 'owner', 'active');

  insert into public.meeting_types (
    workspace_id, key, display_name, template_key, sort_order, is_active
  )
  select
    v_workspace_id, t.key, t.display_name, t.key, t.sort_order, true
  from public.meeting_type_templates as t
  where t.is_active
  order by t.sort_order;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'No active meeting type templates are configured' using errcode = '55000';
  end if;

  return v_workspace_id;
end;
$$;

revoke all on function public.create_workspace(text, text) from public;
grant execute on function public.create_workspace(text, text) to authenticated;

-- Trigger functions run only as part of table writes; they are never a client-callable API.
-- Restrict them to the role that performs those writes so anonymous requests cannot execute them.
-- public.handle_new_user() is intentionally left at its default grant because the Supabase Auth
-- admin role must execute it from the auth.users trigger, and it accepts no caller input.
revoke execute on function public.set_updated_at(), public.validate_meeting_project_company(),
  public.write_workspace_audit_log() from public, anon;
grant execute on function public.set_updated_at(), public.validate_meeting_project_company(),
  public.write_workspace_audit_log() to authenticated;
-- A later privileged-worker phase must grant execute on these trigger functions to its own
-- dedicated database role before that role writes to the tables below, or own the writes through
-- a narrowly scoped RPC. No privileged worker role exists in Phase 1.

-- RLS is the authorization boundary for all public tenant tables. No service-role client is used here.
alter table public.profiles enable row level security;
alter table public.audit_logs enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.meeting_type_templates enable row level security;
alter table public.companies enable row level security;
alter table public.projects enable row level security;
alter table public.meeting_types enable row level security;
alter table public.meetings enable row level security;

create policy profiles_select_self
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_self
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy workspaces_select_member
  on public.workspaces for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- A user sees only their own membership rows. Workspace creation/owner assignment is RPC-only.
create policy workspace_members_select_self
  on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));

create policy companies_select_member
  on public.companies for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = companies.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );
create policy companies_insert_manager
  on public.companies for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = companies.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  );
create policy companies_update_manager
  on public.companies for update to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = companies.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = companies.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  );

create policy projects_select_member
  on public.projects for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = projects.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );
create policy projects_insert_manager
  on public.projects for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = projects.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  );
create policy projects_update_manager
  on public.projects for update to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = projects.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = projects.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
        and wm.role in ('owner', 'admin')
    )
  );

create policy meeting_types_select_member
  on public.meeting_types for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meeting_types.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

create policy meetings_select_member
  on public.meetings for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meetings.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );
create policy meetings_insert_draft_member
  on public.meetings for insert to authenticated
  with check (
    status = 'draft'
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.workspace_members as wm
      where wm.workspace_id = meetings.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.membership_status = 'active'
    )
  );

-- Minimize grants as well as relying on RLS. Workspace membership changes are not client-writable.
revoke all on public.profiles, public.audit_logs, public.workspaces, public.workspace_members,
  public.meeting_type_templates, public.companies, public.projects,
  public.meeting_types, public.meetings from anon, authenticated;

grant select on public.profiles, public.workspaces, public.workspace_members,
  public.companies, public.projects, public.meeting_types, public.meetings to authenticated;
grant update (display_name, locale, timezone) on public.profiles to authenticated;
grant insert (workspace_id, name, description, created_by) on public.companies to authenticated;
grant update (name, description, archived_at) on public.companies to authenticated;
grant insert (workspace_id, company_id, name, description, created_by) on public.projects to authenticated;
grant update (name, description, archived_at) on public.projects to authenticated;
grant insert (
  workspace_id, company_id, project_id, meeting_type_id, title, status, created_by
) on public.meetings to authenticated;

grant usage on type public.membership_role, public.membership_status, public.meeting_status
  to authenticated;

grant usage on schema public to authenticated;
revoke all on public.meeting_type_templates from anon, authenticated;

comment on table public.workspace_members is
  'Membership rows are readable by their own user only; creation and role management are privileged operations.';
comment on table public.audit_logs is
  'Append-only, minimal metadata for successful critical Phase 1 writes; no client read/write policy is granted.';
comment on table public.meeting_type_templates is
  'Non-tenant system defaults copied into each workspace by create_workspace; not client-accessible.';
comment on function public.create_workspace(text, text) is
  'Atomically creates a workspace, its initial owner membership, and copied default meeting types.';
