-- ===========================================================================
-- Phase 13.3 — Durable replay protection for Web -> Recording API requests
-- ===========================================================================
--
-- The Web gateway signs every request it forwards to the Recording API, and the signature binds a
-- one-use nonce. Until now that nonce was recorded in a process-local Map.
--
-- That is sufficient for exactly one topology: one Recording API process. The moment there are two
-- machines — which is the whole point of running a service — the same signed request can be replayed
-- to a *different* machine inside the timestamp window, and that machine has never seen the nonce.
-- The signature is still valid, the timestamp is still fresh, and the write happens twice.
--
-- So the nonce ledger moves into PostgreSQL, which every Recording API machine already shares. The
-- claim is a single INSERT ... ON CONFLICT DO NOTHING ... RETURNING: whichever machine gets there
-- first wins, and the loser inserts nothing and is rejected. No read-then-write, no advisory lock,
-- no window.
--
-- Deliberately not Redis: Postgres is already a dependency of this service, already durable, and
-- already the thing every machine can see. Adding a second stateful system to hold one table would
-- be another thing to secure, monitor, and fail over, for no gain.
--
-- ===========================================================================
-- WHO MAY CALL THESE FUNCTIONS
-- ===========================================================================
--
-- These are internal Recording API primitives. They are **not** public Supabase RPCs.
--
-- In Supabase, a `create function` is implicitly executable by PUBLIC, which means every caller
-- holding the anon key — i.e. anyone with the project URL — could invoke it. Consider what that
-- would mean here:
--
--   * `internal_claim_service_nonce` lets a caller burn an arbitrary nonce. An attacker who can
--     guess or observe the nonce the Web gateway is about to use can pre-burn it, and the legitimate
--     request is then rejected as a replay. That is a denial of service against the recording
--     pipeline, available to anyone on the internet, with no secret required.
--   * `internal_purge_expired_service_nonces` lets a caller repeatedly force a delete scan. Driving
--     it in a loop is a cheap way to put load on the ledger table.
--
-- Neither takes any identity, authorises nothing, and neither is ever needed by a client. So the
-- implicit PUBLIC grant is revoked, and **nothing is granted to `anon` or `authenticated`**. The
-- grant is not merely absent — it is explicitly revoked, because revocation is what protects
-- against a later `alter default privileges` or a well-meaning follow-up migration reintroducing it.
--
-- The Recording API connects directly with `SUPABASE_DB_URL` as the database owner. The owner needs
-- no EXECUTE grant to call a function it owns, so **no client-role grant is required at all** for
-- the shipped deployment.
--
-- For an operator who prefers a least-privilege role over connecting as owner, one named private
-- server role is supported: `suhbat_recording_api`. It is granted conditionally — the migration does
-- not fail if the role has not been created — and it is a *server* role, never a Supabase client
-- role. Creating it is out of scope here; the grant exists so the option is documented and
-- one `create role` away.
--
-- `service_role` is revoked explicitly too. It is a server credential rather than an anon-key
-- credential, but it is still a Supabase *client* role, and this function has no client use case.
-- ===========================================================================

create table if not exists public.internal_service_nonces (
  id uuid primary key default gen_random_uuid(),
  key_id text not null,
  nonce text not null,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  constraint internal_service_nonces_key_id_nonce_key unique (key_id, nonce),
  constraint internal_service_nonces_key_id_not_blank check (pg_catalog.btrim(key_id) <> ''),
  constraint internal_service_nonces_nonce_format check (nonce ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint internal_service_nonces_expires_after_created check (expires_at >= created_at)
);

comment on table public.internal_service_nonces is
  'One-use nonces for signed Web -> Recording API requests. Shared across every Recording API '
  'machine so a replay cannot be aimed at a machine that has not seen it yet. Written only by the '
  'Recording API through internal_claim_service_nonce(); no client role has any privilege on it.';

-- Cleanup scans expired rows in expiry order, so this index is what keeps the purge a bounded
-- index scan rather than a sequential one.
create index if not exists internal_service_nonces_expires_at_idx
  on public.internal_service_nonces (expires_at);

alter table public.internal_service_nonces enable row level security;

-- No policies, by design. Nothing here is readable or writable by a user session; the Recording API
-- reaches it through the functions below.

-- ---------------------------------------------------------------------------
-- Atomic claim
-- ---------------------------------------------------------------------------

/**
 * Claims `p_nonce` for `p_key_id`. Returns true when this caller won, false when it was already
 * used.
 *
 * One statement, so there is no window between "have I seen this?" and "now I have": the unique
 * constraint is the arbiter and `on conflict do nothing` makes losing an ordinary outcome rather
 * than an error.
 *
 * The retention window is **hard-coded**. It is not a parameter, because a parameter would let
 * whoever can call this function decide how long a nonce stays burned — and the one thing a replay
 * guard must never offer its caller is control over its own lifetime. 120 seconds is twice the
 * request timestamp window, which is exactly as long as a nonce needs to be remembered: after that
 * the request would be rejected as stale anyway.
 *
 * Returns false (rather than raising) for a malformed input: this is called on the hot path of
 * every request, and a bad nonce is a rejected request, not a server fault.
 */
create or replace function public.internal_claim_service_nonce(
  p_key_id text,
  p_nonce text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- How long a claimed nonce stays on record. Not caller-controllable: see the comment above.
  k_retention_seconds constant integer := 120;
  v_inserted uuid;
begin
  if p_key_id is null or pg_catalog.btrim(p_key_id) = '' then
    return false;
  end if;
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{8,128}$' then
    return false;
  end if;

  insert into public.internal_service_nonces (key_id, nonce, expires_at)
  values (
    pg_catalog.btrim(p_key_id),
    p_nonce,
    pg_catalog.now() + (k_retention_seconds * interval '1 second')
  )
  on conflict (key_id, nonce) do nothing
  returning id
  into v_inserted;

  return v_inserted is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bounded cleanup
-- ---------------------------------------------------------------------------

/**
 * Deletes at most `p_max_rows` expired nonce rows and reports how many went.
 *
 * Bounded on purpose. An unbounded delete on a table that has somehow grown enormous would hold a
 * lock for the duration and stall every request behind it; a bounded one makes progress every call
 * and catches up over subsequent calls. The caller drives it opportunistically, and because the
 * ledger only ever needs to hold two minutes' worth of nonces, falling behind is not a correctness
 * problem — it is just a few wasted rows.
 *
 * `p_max_rows` is clamped to [1, 1000]. It is a housekeeping knob on an internal-only function, not
 * a security boundary, but clamping keeps a caller from asking for a scan large enough to matter.
 */
create or replace function public.internal_purge_expired_service_nonces(
  p_max_rows integer default 1000
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_limit integer;
begin
  v_limit := greatest(least(coalesce(p_max_rows, 1000), 1000), 1);

  -- Selecting the doomed ids in a subquery (rather than `delete ... using`) keeps the row limit
  -- unambiguous: the LIMIT applies to the scan, and `row_count` then reports exactly what was
  -- deleted.
  delete from public.internal_service_nonces
   where id in (
     select id
       from public.internal_service_nonces
      where expires_at <= pg_catalog.now()
      order by expires_at asc
      limit v_limit
   );

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: internal-only. Read the block comment at the top of this file.
-- ---------------------------------------------------------------------------

-- 1. Strip the implicit PUBLIC grant that every `create function` carries. Without this, anyone
--    holding the anon key could call both functions.
revoke all on function public.internal_claim_service_nonce(text, text) from public;
revoke all on function public.internal_purge_expired_service_nonces(integer) from public;

-- 2. Revoke the Supabase client roles explicitly, and do not grant them back. Revoking rather than
--    merely omitting a grant means a later `alter default privileges`, or a well-meaning follow-up
--    migration, cannot silently reopen this surface.
--
--    These roles are created by Supabase and by the local auth bootstrap, so revoke them
--    unconditionally — the statements are no-ops if the role has no grant. (`service_role` is a
--    server credential, but it is still a Supabase *client* role and has no use for an internal
--    primitive.)
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute format(
        'revoke all on function public.internal_claim_service_nonce(text, text) from %I',
        v_role
      );
      execute format(
        'revoke all on function public.internal_purge_expired_service_nonces(integer) from %I',
        v_role
      );
    end if;
  end loop;
end;
$$;

-- 3. The one role that *is* allowed: a dedicated private server role, for operators who would
--    rather not connect as the database owner. Granted conditionally so this migration applies
--    cleanly whether or not that role has been created. The shipped deployment connects as owner
--    and needs no grant at all.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'suhbat_recording_api') then
    execute 'grant execute on function public.internal_claim_service_nonce(text, text) to suhbat_recording_api';
    execute 'grant execute on function public.internal_purge_expired_service_nonces(integer) to suhbat_recording_api';
  end if;
end;
$$;
