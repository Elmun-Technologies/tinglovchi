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
  'Recording API through internal_claim_service_nonce().';

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
 * `p_ttl_seconds` controls how long the claim is remembered. It defaults to 120 seconds — twice the
 * request timestamp window, which is exactly as long as a nonce needs to be remembered: after that
 * the request would be rejected as stale anyway.
 *
 * Returns false (rather than raising) for a malformed input: this is called on the hot path of
 * every request, and a bad nonce is a rejected request, not a server fault.
 */
create or replace function public.internal_claim_service_nonce(
  p_key_id text,
  p_nonce text,
  p_ttl_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
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
    pg_catalog.now() + (greatest(coalesce(p_ttl_seconds, 120), 1) * interval '1 second')
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
 * `p_max_rows` is clamped to [1, 50000] so a caller cannot ask for an unbounded scan.
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
  v_limit := greatest(least(coalesce(p_max_rows, 1000), 50000), 1);

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
-- Privileges
-- ---------------------------------------------------------------------------

grant execute on function public.internal_claim_service_nonce(text, text, integer)
  to anon, authenticated;
grant execute on function public.internal_purge_expired_service_nonces(integer)
  to anon, authenticated;

-- The Recording API connects as the database owner and needs no grant; service_role is covered for
-- deployments that route server work through it.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.internal_claim_service_nonce(text, text, integer) to service_role';
    execute 'grant execute on function public.internal_purge_expired_service_nonces(integer) to service_role';
  end if;
end;
$$;
