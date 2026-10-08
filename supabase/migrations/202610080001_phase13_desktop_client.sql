-- Phase 13 — Desktop client: one-time connect codes and long-lived desktop sessions.
--
-- Why these tables exist
-- ----------------------
-- The one-tap recorder must authenticate once and then keep working for months without a login
-- prompt. It also must never hold a Supabase service-role key, an object-storage secret, or a
-- provider credential. So the desktop gets its own opaque bearer credential:
--
--   1. The desktop asks for a short-lived, single-use *connect code* (public endpoint, like the
--      device-authorization grant). Only its SHA-256 is stored.
--   2. The user approves it in a real browser session they already have (`/desktop/connect`).
--      Approval binds the code to that user and a workspace.
--   3. The desktop exchanges the approved code once for an opaque *session token*. Only the
--      SHA-256 of that token is stored, so a database leak cannot be replayed against the API.
--
-- Security posture
-- ----------------
-- * Row Level Security is enabled with **no policies**: neither `anon` nor `authenticated` may read
--   or write these rows from a client. All access goes through `@suhbat/database/desktop`, which
--   runs server-side. `tests/rls/phase13-desktop-client.test.ts` asserts that denial.
-- * Codes expire quickly (10 minutes) and burn on use. Session tokens expire (90 days) and are
--   individually revocable.
-- * No column stores an email, a device name, a transcript, or any meeting content. `client_label`
--   is a bounded, user-supplied string shown back to them so they can tell their own devices apart.

create table public.desktop_connect_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  status text not null default 'pending',
  user_id uuid references public.profiles (id) on delete cascade,
  workspace_id uuid,
  client_label text check (client_label is null or char_length(client_label) <= 80),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  authorized_at timestamptz,
  consumed_at timestamptz
);

create index desktop_connect_codes_status_expiry_idx
  on public.desktop_connect_codes (status, expires_at);

alter table public.desktop_connect_codes
  add constraint desktop_connect_codes_status_check
  check (status in ('pending', 'authorized', 'consumed', 'expired'));

-- A code is either pending (nobody approved it yet) or fully bound to a user. Half-bound rows are
-- impossible, so the exchange step can never mint a session for the wrong principal.
alter table public.desktop_connect_codes
  add constraint desktop_connect_codes_bound_check
  check (
    (status = 'pending' and user_id is null and authorized_at is null)
    or (status in ('authorized', 'consumed', 'expired') and user_id is not null)
  );

alter table public.desktop_connect_codes
  add constraint desktop_connect_codes_consumed_check
  check ((status = 'consumed') = (consumed_at is not null));

create table public.desktop_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Last workspace the recorder used, so the next start does not ask again.
  last_workspace_id uuid,
  client_label text check (client_label is null or char_length(client_label) <= 80),
  created_at timestamptz not null default pg_catalog.now(),
  last_used_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index desktop_sessions_user_active_idx
  on public.desktop_sessions (user_id, revoked_at, expires_at);

create index desktop_sessions_expiry_idx
  on public.desktop_sessions (expires_at);

comment on table public.desktop_connect_codes is
  'Single-use, short-lived desktop pairing codes. Only the code hash is stored; RLS denies all client access.';

comment on table public.desktop_sessions is
  'Opaque bearer sessions for the desktop recorder. Only the token hash is stored; RLS denies all client access.';

-- Enable RLS and grant nothing. With no policy, every client-role statement is denied while the
-- server runtime (which connects as the owner) keeps working. That is the intended boundary.
alter table public.desktop_connect_codes enable row level security;
alter table public.desktop_sessions enable row level security;

revoke all on public.desktop_connect_codes from anon, authenticated;
revoke all on public.desktop_sessions from anon, authenticated;
