-- Phase 13 (revised) — desktop session credentials: short-lived access + rotating refresh.
--
-- Why this migration exists
-- -------------------------
-- The first cut of Phase 13 issued a single opaque bearer token valid for 90 days and used it for
-- every API call. That is one long-lived credential doing two different jobs, and it is wrong:
-- a leaked token is valid for a quarter of a year, and the only remedy is revoking the whole session
-- (which signs the user out of the device).
--
-- This migration replaces it with the split model:
--
--   access token   ~15 minutes, sent on every request, cheap to lose.
--   refresh token  ~30 days, sent only to /desktop/sessions/refresh, rotates on every use.
--
-- Both are opaque random strings. Only SHA-256 hashes are stored, and the hashes are computed in the
-- application tier (never in SQL), so the plaintext credential exists in exactly two places: the
-- desktop's temporary store, and the request that carries it.
--
-- Trust boundary
-- -------------
-- The web process holds no direct PostgreSQL connection. Every operation here is reached through a
-- narrowly scoped `security definer` function over the Supabase client, which is the pattern this
-- repository already uses for `public.create_workspace(text, text)`. The functions do their own
-- authorization: they never trust a caller-supplied user id.
--
--   desktop (no Supabase JWT)  -> anon key + credential as an argument -> definer fn verifies hash
--   browser (/desktop/connect) -> user JWT                             -> definer fn uses auth.uid()
--
-- Functions callable by `anon` are exactly the ones the desktop must reach before it has a session.
-- Each of them requires a secret the caller can only have obtained from us, so the grant is not an
-- authorization bypass: it is the authorization check.

-- ---------------------------------------------------------------------------
-- 1. Sessions: replace the single long-lived token with an access/refresh pair.
-- ---------------------------------------------------------------------------

alter table public.desktop_sessions
  drop column token_hash,
  drop column expires_at,
  add column access_token_hash text,
  add column access_token_expires_at timestamptz,
  add column refresh_token_hash text,
  add column previous_refresh_token_hash text,
  add column refresh_token_expires_at timestamptz,
  add column refresh_rotated_at timestamptz,
  add column refresh_count integer not null default 0;

-- A session created before this migration has no credential any more; it cannot be resurrected
-- because the plaintext token was never stored. Revoking those rows keeps `not null` satisfiable
-- without inventing a token for them.
update public.desktop_sessions
   set revoked_at = coalesce(revoked_at, pg_catalog.now()),
       access_token_hash = 'revoked-by-migration-202610080002',
       refresh_token_hash = 'revoked-by-migration-202610080002',
       access_token_expires_at = pg_catalog.now(),
       refresh_token_expires_at = pg_catalog.now()
 where access_token_hash is null;

alter table public.desktop_sessions
  alter column access_token_hash set not null,
  alter column refresh_token_hash set not null,
  alter column access_token_expires_at set not null,
  alter column refresh_token_expires_at set not null;

-- Hash lookup is the hot path: every authenticated desktop request resolves through it.
create unique index desktop_sessions_access_hash_idx
  on public.desktop_sessions (access_token_hash);
create unique index desktop_sessions_refresh_hash_idx
  on public.desktop_sessions (refresh_token_hash);

-- Reuse detection: a rotated-away refresh token that is replayed must be findable.
create index desktop_sessions_previous_refresh_idx
  on public.desktop_sessions (previous_refresh_token_hash)
  where previous_refresh_token_hash is not null;

alter table public.desktop_sessions
  add constraint desktop_sessions_access_hash_check
  check (access_token_hash ~ '^[0-9a-f]{64}$'),
  add constraint desktop_sessions_refresh_hash_check
  check (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  add constraint desktop_sessions_previous_hash_check
  check (previous_refresh_token_hash is null or previous_refresh_token_hash ~ '^[0-9a-f]{64}$'),
  add constraint desktop_sessions_hash_distinct_check
  check (
    access_token_hash <> refresh_token_hash
    and access_token_hash <> coalesce(previous_refresh_token_hash, '')
    and refresh_token_hash <> coalesce(previous_refresh_token_hash, '')
  );

drop index if exists public.desktop_sessions_expiry_idx;
create index desktop_sessions_refresh_expiry_idx
  on public.desktop_sessions (refresh_token_expires_at);

comment on table public.desktop_sessions is
  'Desktop recorder sessions. Stores SHA-256 hashes of a short-lived access token and a rotating refresh token; the plaintext of either is never persisted.';

-- ---------------------------------------------------------------------------
-- 2. Internal helper: resolve a valid access token to its user.
-- ---------------------------------------------------------------------------

create function public.desktop_current_user(p_access_token_hash text)
returns uuid
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select s.user_id
    into v_user_id
    from public.desktop_sessions as s
   where s.access_token_hash = p_access_token_hash
     and s.revoked_at is null
     and s.access_token_expires_at > pg_catalog.now()
     and s.refresh_token_expires_at > pg_catalog.now()
   limit 1;

  return v_user_id;
end;
$$;

revoke all on function public.desktop_current_user(text) from public;

-- ---------------------------------------------------------------------------
-- 3. Connect codes.
-- ---------------------------------------------------------------------------

-- The application tier generates the code from a CSPRNG and passes only its SHA-256, so SQL never
-- handles (or logs) the plaintext. `p_ttl_seconds` and the live-code ceiling bound how many rows an
-- anonymous caller can create.
create function public.desktop_create_connect_code(
  p_code_hash text,
  p_client_label text,
  p_ttl_seconds integer,
  p_max_live_codes integer default 2000
)
returns table (expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ttl integer := greatest(coalesce(p_ttl_seconds, 600), 60);
  v_live integer;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 connect code hash is required.' using errcode = '22023';
  end if;

  -- Bound abuse: refuse once too many unexpired codes are outstanding. Without this an anonymous
  -- caller can grow this table without limit.
  select pg_catalog.count(*)
    into v_live
    from public.desktop_connect_codes as c
   where c.expires_at > pg_catalog.now();

  if v_live >= greatest(coalesce(p_max_live_codes, 2000), 1) then
    raise exception 'Too many pairing codes are outstanding. Try again shortly.' using errcode = 'P0001';
  end if;

  -- Opportunistic bounded cleanup, piggybacked on the write path so no extra grant is needed.
  delete from public.desktop_connect_codes as c
   where c.expires_at < pg_catalog.now() - interval '1 hour'
     and c.id in (
       select c2.id from public.desktop_connect_codes as c2
        where c2.expires_at < pg_catalog.now() - interval '1 hour'
        limit 500
     );

  return query
    insert into public.desktop_connect_codes (code_hash, client_label, expires_at)
    values (
      p_code_hash,
      case when p_client_label is null then null else pg_catalog.left(p_client_label, 80) end,
      pg_catalog.now() + (v_ttl * interval '1 second')
    )
    returning public.desktop_connect_codes.expires_at;
end;
$$;

revoke all on function public.desktop_create_connect_code(text, text, integer, integer) from public;
grant execute on function public.desktop_create_connect_code(text, text, integer, integer) to anon, authenticated;

-- Deliberately answers 'pending' for codes that do not exist or have expired, so a caller cannot
-- probe for the codes of other devices. The desktop stops polling on its own deadline.
create function public.desktop_connect_code_status(p_code_hash text)
returns table (status text)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    return query select 'pending'::text;
    return;
  end if;

  return query
    select coalesce(
      (select c.status
         from public.desktop_connect_codes as c
        where c.code_hash = p_code_hash
          and c.status in ('authorized', 'consumed')
        limit 1),
      'pending'::text
    );
end;
$$;

revoke all on function public.desktop_connect_code_status(text) from public;
grant execute on function public.desktop_connect_code_status(text) to anon, authenticated;

-- Approval runs in the browser with the user's real Supabase session, so the user id comes from the
-- JWT and can never be supplied by the caller.
create function public.desktop_authorize_connect_code(p_code_hash text, p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_rows integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 connect code hash is required.' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from public.workspace_members as wm
     where wm.workspace_id = p_workspace_id
       and wm.user_id = v_user_id
       and wm.membership_status = 'active'
  ) then
    raise exception 'You are not an active member of that workspace.' using errcode = '42501';
  end if;

  update public.desktop_connect_codes as c
     set status = 'authorized',
         user_id = v_user_id,
         workspace_id = p_workspace_id,
         authorized_at = pg_catalog.now()
   where c.code_hash = p_code_hash
     and c.status = 'pending'
     and c.expires_at > pg_catalog.now();

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That pairing code is no longer available.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.desktop_authorize_connect_code(text, uuid) from public;
grant execute on function public.desktop_authorize_connect_code(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Exchange — one code mints at most one session, at the database level.
-- ---------------------------------------------------------------------------
--
-- The whole claim is a single statement: `UPDATE ... WHERE status = 'authorized' ... RETURNING`
-- feeding an `INSERT ... SELECT`. Two concurrent exchanges for the same code cannot both win — the
-- second blocks on the row lock, then re-evaluates `status` against the committed row and matches
-- nothing, so it inserts nothing. There is no window in which two sessions can be minted, which a
-- read-then-write sequence (SELECT, INSERT, UPDATE) cannot guarantee.

create function public.desktop_exchange_connect_code(
  p_code_hash text,
  p_access_token_hash text,
  p_refresh_token_hash text,
  p_access_ttl_seconds integer,
  p_refresh_ttl_seconds integer,
  p_client_label text
)
returns table (
  session_id uuid,
  user_id uuid,
  workspace_id uuid,
  user_email text,
  refresh_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access_ttl integer := greatest(coalesce(p_access_ttl_seconds, 900), 60);
  v_refresh_ttl integer := greatest(coalesce(p_refresh_ttl_seconds, 2592000), 3600);
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$'
     or p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$'
     or p_refresh_token_hash is null or p_refresh_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 code hash and token hashes are required.' using errcode = '22023';
  end if;

  return query
    with claimed as (
      update public.desktop_connect_codes as c
         set status = 'consumed',
             consumed_at = pg_catalog.now()
       where c.code_hash = p_code_hash
         and c.status = 'authorized'
         and c.expires_at > pg_catalog.now()
      returning c.user_id, c.workspace_id, c.client_label
    )
    insert into public.desktop_sessions (
      user_id,
      last_workspace_id,
      client_label,
      access_token_hash,
      access_token_expires_at,
      refresh_token_hash,
      refresh_token_expires_at,
      refresh_rotated_at,
      refresh_count
    )
    select
      claimed.user_id,
      claimed.workspace_id,
      coalesce(pg_catalog.left(p_client_label, 80), claimed.client_label),
      p_access_token_hash,
      pg_catalog.now() + (v_access_ttl * interval '1 second'),
      p_refresh_token_hash,
      pg_catalog.now() + (v_refresh_ttl * interval '1 second'),
      pg_catalog.now(),
      0
      from claimed
    returning
      public.desktop_sessions.id,
      public.desktop_sessions.user_id,
      public.desktop_sessions.last_workspace_id,
      (select u.email from auth.users as u where u.id = public.desktop_sessions.user_id),
      public.desktop_sessions.refresh_token_expires_at;
end;
$$;

revoke all on function public.desktop_exchange_connect_code(text, text, text, integer, integer, text) from public;
grant execute on function public.desktop_exchange_connect_code(text, text, text, integer, integer, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Refresh — rotate, and make the superseded credential unusable.
-- ---------------------------------------------------------------------------

create function public.desktop_refresh_session(
  p_refresh_token_hash text,
  p_new_access_token_hash text,
  p_new_refresh_token_hash text,
  p_access_ttl_seconds integer,
  p_refresh_ttl_seconds integer
)
returns table (
  session_id uuid,
  user_id uuid,
  workspace_id uuid,
  refresh_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access_ttl integer := greatest(coalesce(p_access_ttl_seconds, 900), 60);
  v_refresh_ttl integer := greatest(coalesce(p_refresh_ttl_seconds, 2592000), 3600);
  v_stale uuid;
begin
  if p_refresh_token_hash is null or p_refresh_token_hash !~ '^[0-9a-f]{64}$'
     or p_new_access_token_hash is null or p_new_access_token_hash !~ '^[0-9a-f]{64}$'
     or p_new_refresh_token_hash is null or p_new_refresh_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'SHA-256 token hashes are required.' using errcode = '22023';
  end if;

  --
  -- Reuse detection. A refresh token that has already been rotated away is replayed in exactly two
  -- situations: a legitimate client retrying a response it never received, or someone replaying a
  -- credential they captured. Inside a short grace window the first is far more likely, so the
  -- request simply fails; outside it, treat the replay as theft and kill the whole session.
  --
  select s.id
    into v_stale
    from public.desktop_sessions as s
   where s.previous_refresh_token_hash = p_refresh_token_hash
     and s.revoked_at is null
   limit 1;

  if v_stale is not null then
    if exists (
      select 1 from public.desktop_sessions as s
       where s.id = v_stale
         and s.refresh_rotated_at > pg_catalog.now() - interval '30 seconds'
    ) then
      return;
    end if;

    update public.desktop_sessions as s
       set revoked_at = pg_catalog.now()
     where s.id = v_stale;
    return;
  end if;

  return query
    update public.desktop_sessions as s
       set access_token_hash = p_new_access_token_hash,
           access_token_expires_at = pg_catalog.now() + (v_access_ttl * interval '1 second'),
           previous_refresh_token_hash = s.refresh_token_hash,
           refresh_token_hash = p_new_refresh_token_hash,
           refresh_token_expires_at = pg_catalog.now() + (v_refresh_ttl * interval '1 second'),
           refresh_rotated_at = pg_catalog.now(),
           refresh_count = s.refresh_count + 1,
           last_used_at = pg_catalog.now()
     where s.refresh_token_hash = p_refresh_token_hash
       and s.revoked_at is null
       and s.refresh_token_expires_at > pg_catalog.now()
    returning
      s.id,
      s.user_id,
      s.last_workspace_id,
      s.refresh_token_expires_at;
end;
$$;

revoke all on function public.desktop_refresh_session(text, text, text, integer, integer) from public;
grant execute on function public.desktop_refresh_session(text, text, text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Session context, revocation, workspace memory.
-- ---------------------------------------------------------------------------

create function public.desktop_session_context(p_access_token_hash text)
returns table (
  session_id uuid,
  user_id uuid,
  workspace_id uuid,
  user_email text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
    select s.id,
           s.user_id,
           s.last_workspace_id,
           (select u.email from auth.users as u where u.id = s.user_id),
           s.access_token_expires_at,
           s.refresh_token_expires_at
      from public.desktop_sessions as s
     where s.access_token_hash = p_access_token_hash
       and s.revoked_at is null
       and s.refresh_token_expires_at > pg_catalog.now()
     limit 1;
end;
$$;

revoke all on function public.desktop_session_context(text) from public;
grant execute on function public.desktop_session_context(text) to anon, authenticated;

-- Logging out takes either credential: the access token you have, or the refresh token you kept.
create function public.desktop_revoke_session(
  p_access_token_hash text,
  p_refresh_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.desktop_sessions as s
     set revoked_at = pg_catalog.now()
   where s.revoked_at is null
     and (
       (p_access_token_hash ~ '^[0-9a-f]{64}$' and s.access_token_hash = p_access_token_hash)
       or (p_refresh_token_hash ~ '^[0-9a-f]{64}$' and s.refresh_token_hash = p_refresh_token_hash)
     );

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.desktop_revoke_session(text, text) from public;
grant execute on function public.desktop_revoke_session(text, text) to anon, authenticated;

create function public.desktop_remember_workspace(p_access_token_hash text, p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.desktop_current_user(p_access_token_hash);
  v_rows integer;
begin
  if v_user_id is null then
    raise exception 'That desktop session is no longer valid.' using errcode = '28001';
  end if;
  if not exists (
    select 1
      from public.workspace_members as wm
     where wm.workspace_id = p_workspace_id
       and wm.user_id = v_user_id
       and wm.membership_status = 'active'
  ) then
    raise exception 'You are not an active member of that workspace.' using errcode = '42501';
  end if;

  update public.desktop_sessions as s
     set last_workspace_id = p_workspace_id
   where s.access_token_hash = p_access_token_hash;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That desktop session is no longer valid.' using errcode = '28001';
  end if;
end;
$$;

revoke all on function public.desktop_remember_workspace(text, uuid) from public;
grant execute on function public.desktop_remember_workspace(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Workspaces and automatic meeting creation for the recorder.
-- ---------------------------------------------------------------------------

create function public.desktop_list_workspaces(p_access_token_hash text)
returns table (
  workspace_id uuid,
  name text,
  role text,
  default_meeting_type_id uuid,
  default_meeting_type_label text,
  meeting_type_count integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  -- Either a desktop access token (no JWT) or the caller's own Supabase session. A caller can never
  -- name a user: the id always comes from a credential we verified, never from an argument.
  v_user_id uuid := coalesce(public.desktop_current_user(p_access_token_hash), (select auth.uid()));
begin
  if v_user_id is null then
    return;
  end if;

  return query
    select w.id,
           w.name,
           m.role::text,
           t.id,
           t.display_name,
           coalesce(tc.count, 0)::integer
      from public.workspace_members as m
      join public.workspaces as w on w.id = m.workspace_id
      left join lateral (
        select mt.id, mt.display_name
          from public.meeting_types as mt
         where mt.workspace_id = w.id
           and mt.is_active
         order by mt.sort_order asc, mt.created_at asc
         limit 1
      ) as t on true
      left join lateral (
        select pg_catalog.count(*) as count
          from public.meeting_types as mt2
         where mt2.workspace_id = w.id
           and mt2.is_active
      ) as tc on true
     where m.user_id = v_user_id
       and m.membership_status = 'active'
     order by w.name asc;
end;
$$;

revoke all on function public.desktop_list_workspaces(text) from public;
grant execute on function public.desktop_list_workspaces(text) to anon, authenticated;

create function public.desktop_ensure_meeting(
  p_access_token_hash text,
  p_workspace_id uuid,
  p_title text,
  p_meeting_type_id uuid,
  p_company_id uuid,
  p_project_id uuid,
  p_started_at timestamptz
)
returns table (
  meeting_id uuid,
  workspace_id uuid,
  title text,
  status text,
  meeting_type_id uuid,
  meeting_type_label text,
  company_id uuid,
  project_id uuid,
  created_by uuid,
  started_at timestamptz,
  created_at timestamptz,
  defaults_title boolean,
  defaults_meeting_type boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Either a desktop access token (no JWT) or the caller's own Supabase session.
  v_user_id uuid := coalesce(public.desktop_current_user(p_access_token_hash), (select auth.uid()));
  v_type_id uuid;
  v_type_label text;
  v_title text;
  v_default_title boolean;
  v_started_at timestamptz := coalesce(p_started_at, pg_catalog.now());
begin
  if v_user_id is null then
    raise exception 'That desktop session is no longer valid.' using errcode = '28001';
  end if;

  if not exists (
    select 1
      from public.workspace_members as wm
     where wm.workspace_id = p_workspace_id
       and wm.user_id = v_user_id
       and wm.membership_status = 'active'
  ) then
    raise exception 'You are not an active member of that workspace.' using errcode = '42501';
  end if;

  -- Composite foreign keys on public.meetings already forbid cross-workspace company/project links.
  -- This check turns that into a clear error before the insert instead of a constraint violation.
  if p_company_id is not null
     and not exists (
       select 1 from public.companies as c
        where c.id = p_company_id and c.workspace_id = p_workspace_id
     ) then
    raise exception 'That company does not belong to this workspace.' using errcode = '22023';
  end if;
  if p_project_id is not null
     and not exists (
       select 1 from public.projects as pj
        where pj.id = p_project_id and pj.workspace_id = p_workspace_id
     ) then
    raise exception 'That project does not belong to this workspace.' using errcode = '22023';
  end if;

  select mt.id, mt.display_name
    into v_type_id, v_type_label
    from public.meeting_types as mt
   where mt.workspace_id = p_workspace_id
     and mt.is_active
     and (p_meeting_type_id is null or mt.id = p_meeting_type_id)
   order by mt.sort_order asc, mt.created_at asc
   limit 1;

  if v_type_id is null then
    if p_meeting_type_id is null then
      raise exception 'This workspace has no active meeting type. Add one in workspace settings.' using errcode = '22023';
    end if;
    raise exception 'That meeting type does not belong to this workspace.' using errcode = '22023';
  end if;

  v_default_title := p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) < 2;
  if v_default_title then
    v_title := 'Suhbat — ' || pg_catalog.to_char(v_started_at, 'FMDD Mon, HH24:MI');
  else
    v_title := pg_catalog.left(pg_catalog.btrim(p_title), 180);
  end if;

  return query
    insert into public.meetings (
      workspace_id, meeting_type_id, title, created_by, started_at, company_id, project_id
    )
    values (
      p_workspace_id, v_type_id, v_title, v_user_id, v_started_at, p_company_id, p_project_id
    )
    returning
      public.meetings.id,
      public.meetings.workspace_id,
      public.meetings.title,
      public.meetings.status::text,
      public.meetings.meeting_type_id,
      v_type_label,
      public.meetings.company_id,
      public.meetings.project_id,
      public.meetings.created_by,
      public.meetings.started_at,
      public.meetings.created_at,
      v_default_title,
      p_meeting_type_id is null;
end;
$$;

revoke all on function public.desktop_ensure_meeting(text, uuid, text, uuid, uuid, uuid, timestamptz) from public;
grant execute on function public.desktop_ensure_meeting(text, uuid, text, uuid, uuid, uuid, timestamptz) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Bounded retention.
-- ---------------------------------------------------------------------------
--
-- Expired and revoked credentials are dead weight and a disclosure risk if the table is ever read.
-- The worker should call this on a schedule; `p_max_rows` keeps any single call short so it cannot
-- hold locks long enough to matter.

create function public.desktop_cleanup_sessions(p_max_rows integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  with doomed as (
    select s.id
      from public.desktop_sessions as s
     where s.refresh_token_expires_at < pg_catalog.now() - interval '7 days'
        or (s.revoked_at is not null and s.revoked_at < pg_catalog.now() - interval '30 days')
     order by s.refresh_token_expires_at asc
     limit greatest(coalesce(p_max_rows, 500), 1)
  )
  delete from public.desktop_sessions as s
   where s.id in (select doomed.id from doomed);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.desktop_cleanup_sessions(integer) from public;
grant execute on function public.desktop_cleanup_sessions(integer) to authenticated;
