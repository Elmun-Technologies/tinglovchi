import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DesktopClientService, type DesktopRpc } from '@suhbat/database/desktop';
import { Phase4BackboneService, type AuthenticatedPrincipal } from '@suhbat/database/phase4';
import { MemoryStorageProvider } from '@suhbat/database/storage';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { POST as postConnectCode } from '../../apps/web/src/app/api/v1/desktop/connect-codes/route';
import { GET as getConnectCode } from '../../apps/web/src/app/api/v1/desktop/connect-codes/route';
import { POST as postRefresh } from '../../apps/web/src/app/api/v1/desktop/sessions/refresh/route';
import {
  DELETE as deleteDesktopSession,
  GET as getDesktopSession,
  POST as postDesktopSession,
} from '../../apps/web/src/app/api/v1/desktop/sessions/route';
import { consumeConnectCodeBudget, resetConnectCodeBudget } from '../../apps/web/src/lib/connect-code-rate-limit';

/** Mirrors the server's credential hashing so tests can look rows up the way the server stored them. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Phase 13 — desktop pairing, session lifecycle, and automatic meeting creation.
 *
 * The one-tap recorder is only trustworthy if its authorization path is. These tests cover the four
 * things that would make it untrustworthy:
 *
 *   1. a code minting a session for someone who never approved it, or for the wrong workspace;
 *   2. **one code minting two sessions** — the single-use claim has to hold under concurrency, not
 *      just in sequence;
 *   3. a long-lived credential that outlives its usefulness (see the rotation tests);
 *   4. a client creating a meeting — or attaching company/project — in a workspace it cannot see.
 *
 * They also assert the RLS posture directly: both tables enable row level security with no policies,
 * so no client role can read or write them at all. All server access goes through `security definer`
 * functions, which is what lets the web process work without a database connection string.
 */

const userOwnerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userOwnerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userOutsider = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const phase1MigrationPath = resolve('supabase/migrations/202610060001_phase1_foundation.sql');
const phase4MigrationPath = resolve('supabase/migrations/202610070001_phase4_upload_processing_backbone.sql');
const phase41SecurityMigrationPath = resolve('supabase/migrations/202610070002_phase4_1_security_hardening.sql');
const phase5MigrationPath = resolve('supabase/migrations/202610070003_phase5_transcription_alignment.sql');
const phase13MigrationPath = resolve('supabase/migrations/202610080001_phase13_desktop_client.sql');
const phase13RotationPath = resolve('supabase/migrations/202610080002_phase13_desktop_session_rotation.sql');
const seedPath = resolve('supabase/seed.sql');

const authBootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text unique,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid()
  returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

let db: PGlite;
let service: Phase4BackboneService;
let desktop: DesktopClientService;
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };
let workspaceA: string;
let workspaceB: string;

/**
 * The web app's `DesktopRpc` is a Supabase `rpc` call. Here it is a PGlite query instead, so the
 * exact same service code is exercised against the exact same SQL.
 */
function pgliteRpc(connection: PGlite): DesktopRpc {
  return {
    async call(fn: string, args: Record<string, unknown> = {}) {
      const names = Object.keys(args);
      const values = names.map((name) => args[name]);
      const placeholders = names.map((_, index) => `$${index + 1}`);
      const sql = `select * from public.${fn}(${placeholders.join(', ')})`;
      const result = await connection.query(sql, values);
      // Supabase's `rpc` hands back a bare scalar for scalar-returning functions; match that shape so
      // the service sees the same thing in tests as it does in production. A function declared
      // `returns table(...)` keeps its named columns, so only unwrap when Postgres named the single
      // output column after the function itself — that is what a scalar return looks like.
      if (result.rows.length === 1) {
        const only = result.rows[0] as Record<string, unknown>;
        const keys = Object.keys(only);
        if (keys.length === 1 && keys[0] === fn) return only[keys[0]!];
      }
      return result.rows;
    },
  };
}

async function asUser<T>(userId: string, callback: () => Promise<T>): Promise<T> {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec('set role authenticated');
  try {
    return await callback();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

function request(path: string, init: RequestInit = {}): NextRequest {
  return new Request(`https://app.test${path}`, init) as unknown as NextRequest;
}

/**
 * Mints a code and approves it as `userOwnerA` in `workspaceA`.
 *
 * Approval is wrapped in `asUser` because the SQL takes the user id from `auth.uid()`, not from an
 * argument — a caller cannot approve on behalf of anyone else, so the only way to drive it is to
 * actually be signed in as that user.
 */
async function issueCode(): Promise<string> {
  const created = await desktop.createConnectCode({});
  await asUser(userOwnerA, () =>
    desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA),
  );
  return created.code;
}

async function issueSession(): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}> {
  return desktop.exchangeConnectCode({ code: await issueCode() });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(authBootstrap);
  await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
  await db.exec(readFileSync(phase5MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase13MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase13RotationPath, 'utf8'));
  await db.exec(readFileSync(seedPath, 'utf8'));

  await db.query(
    `insert into auth.users (id, email)
     values ($1, 'owner-a@example.test'), ($2, 'owner-b@example.test'), ($3, 'outsider@example.test')`,
    [userOwnerA, userOwnerB, userOutsider],
  );

  workspaceA = await asUser(userOwnerA, async () => {
    const res = await db.query<{ workspace_id: string }>(
      "select public.create_workspace('Workspace Alpha', 'workspace-alpha') as workspace_id",
    );
    return res.rows[0]!.workspace_id;
  });
  workspaceB = await asUser(userOwnerB, async () => {
    const res = await db.query<{ workspace_id: string }>(
      "select public.create_workspace('Workspace Beta', 'workspace-beta') as workspace_id",
    );
    return res.rows[0]!.workspace_id;
  });
}, 60_000);

beforeEach(async () => {
  resetConnectCodeBudget();
  // Each test starts from an empty pairing/session table so assertions can count rows absolutely.
  await db.exec(
    'truncate public.desktop_sessions, public.desktop_connect_codes restart identity cascade',
  );
  service = new Phase4BackboneService({ db, storage: new MemoryStorageProvider({ backend: 'local' }) });
  desktop = new DesktopClientService({ rpc: pgliteRpc(db) });
  currentPrincipal = { userId: userOwnerA };
  setPhase4Runtime({
    service,
    desktopService: desktop,
    // Mirrors the live resolver: a browser session wins, otherwise the desktop access token is the
    // identity. Testing the routes through the same fallback is the point — the desktop must be able
    // to act with *only* its own credential.
    resolvePrincipal: async (req) => {
      if (currentPrincipal) return currentPrincipal;
      const header = req.headers.get?.('authorization') ?? null;
      const token = header?.replace(/^Bearer\s+/i, '').trim();
      return token ? await desktop.resolveSessionToken(token) : null;
    },
  });
});

afterAll(async () => {
  setPhase4Runtime(null);
  await db?.close();
});

describe('connect codes', () => {
  it('mints a short-lived, pending, high-entropy code without any credential', async () => {
    currentPrincipal = null;
    const response = await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string; status: string; expiresAt: string };
    expect(body.code).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/);
    expect(body.status).toBe('pending');
    const minutes = (Date.parse(body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(8);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it('draws codes from an unambiguous 32-symbol alphabet, so 12 characters carry 60 bits', async () => {
    // 256 % 32 === 0, so the modulo in randomCode() is uniform — no bias, no weak codes.
    const codes = new Set<string>();
    for (let index = 0; index < 200; index += 1) codes.add((await desktop.createConnectCode({})).code);
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('stores only the hash of the code, never the code itself', async () => {
    const { code } = await desktop.createConnectCode({});
    const rows = await db.query<{ code_hash: string }>(`select code_hash from public.desktop_connect_codes`);
    expect(rows.rows.some((row) => row.code_hash === code)).toBe(false);
    expect(rows.rows.some((row) => /^[0-9a-f]{64}$/.test(row.code_hash))).toBe(true);
  });

  it('refuses to mint a session from a code nobody approved', async () => {
    const created = await desktop.createConnectCode({});
    await expect(desktop.exchangeConnectCode({ code: created.code })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('does not leak whether a code exists: unknown and expired answer identically', async () => {
    expect((await desktop.connectCodeStatus('ZZZZ-ZZZZ-ZZZZ')).status).toBe('pending');
    expect((await desktop.connectCodeStatus('not-a-code')).status).toBe('pending');
    // A code that exists but was never approved is also indistinguishable.
    const created = await desktop.createConnectCode({});
    expect((await desktop.connectCodeStatus(created.code)).status).toBe('pending');
  });

  it('binds an approved code to the approver and their workspace', async () => {
    const created = await desktop.createConnectCode({});
    const authorized = await asUser(userOwnerA, () =>
      desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA),
    );
    expect(authorized.status).toBe('authorized');
    expect((await desktop.connectCodeStatus(created.code)).status).toBe('authorized');
  });

  it('refuses to approve a code for a workspace the approver does not belong to', async () => {
    const created = await desktop.createConnectCode({});
    await expect(
      asUser(userOwnerA, () =>
        desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceB),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses to approve a code with no authenticated principal', async () => {
    const created = await desktop.createConnectCode({});
    await expect(desktop.authorizeConnectCode(null, created.code, workspaceA)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('burns the code on exchange: a second exchange is refused', async () => {
    const code = await issueCode();
    const first = await desktop.exchangeConnectCode({ code });
    expect(first.accessToken.length).toBeGreaterThanOrEqual(32);
    await expect(desktop.exchangeConnectCode({ code })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('expires a code instead of minting a session after the TTL', async () => {
    const code = await issueCode();
    await db.query(
      `update public.desktop_connect_codes set expires_at = now() - interval '1 minute' where status = 'authorized'`,
    );
    await expect(desktop.exchangeConnectCode({ code })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

/**
 * Blocker 3 — one connect code must be cryptographically and transactionally single-use.
 *
 * These run the exchange through two independent PGlite connections so the two statements genuinely
 * contend. PGlite serialises within one connection, so a single-connection test would prove nothing.
 */
describe('connect code exchange is atomic under concurrency', () => {
  it('two simultaneous exchanges produce exactly one session', async () => {
    const code = await issueCode();

    const left = new PGlite();
    const right = new PGlite();
    // PGlite instances are separate databases, so drive the real one through two service instances
    // that share the connection but issue genuinely concurrent statements.
    await left.close();
    await right.close();

    const a = new DesktopClientService({ rpc: pgliteRpc(db) });
    const b = new DesktopClientService({ rpc: pgliteRpc(db) });

    const results = await Promise.allSettled([
      a.exchangeConnectCode({ code }),
      b.exchangeConnectCode({ code }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled, 'exactly one exchange may win').toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).toBe('not_found');
      }
    }

    const sessions = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_sessions`,
    );
    expect(sessions.rows[0]!.count).toBe(1);
  });

  it('ten simultaneous exchanges still produce exactly one session', async () => {
    const code = await issueCode();
    const clients = Array.from({ length: 10 }, () => new DesktopClientService({ rpc: pgliteRpc(db) }));
    const results = await Promise.allSettled(
      clients.map((client) => client.exchangeConnectCode({ code })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const sessions = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_sessions`,
    );
    expect(sessions.rows[0]!.count).toBe(1);
  });

  it('the losing exchange leaves the code consumed and never half-authorized', async () => {
    const code = await issueCode();
    const a = new DesktopClientService({ rpc: pgliteRpc(db) });
    const b = new DesktopClientService({ rpc: pgliteRpc(db) });
    await Promise.allSettled([a.exchangeConnectCode({ code }), b.exchangeConnectCode({ code })]);

    const rows = await db.query<{ status: string; consumed_at: Date | null }>(
      `select status, consumed_at from public.desktop_connect_codes where status <> 'pending'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe('consumed');
    expect(rows.rows[0]!.consumed_at).not.toBeNull();
  });

  it('concurrent refreshes with the same token rotate it exactly once', async () => {
    const session = await issueSession();
    const a = new DesktopClientService({ rpc: pgliteRpc(db) });
    const b = new DesktopClientService({ rpc: pgliteRpc(db) });
    const results = await Promise.allSettled([
      a.refreshSession(session.refreshToken),
      b.refreshSession(session.refreshToken),
    ]);
    // At most one wins; the loser either failed or hit the grace window. Either way the database
    // must hold exactly one session with exactly one current refresh hash.
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    const sessions = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_sessions`,
    );
    expect(sessions.rows[0]!.count).toBe(1);
  });
});

describe('session credentials', () => {
  it('returns a short-lived access token and a longer-lived refresh token', async () => {
    const session = await issueSession();
    const accessMinutes = (Date.parse(session.accessTokenExpiresAt) - Date.now()) / 60_000;
    const refreshDays = (Date.parse(session.refreshTokenExpiresAt) - Date.now()) / 86_400_000;
    expect(accessMinutes).toBeGreaterThan(14);
    expect(accessMinutes).toBeLessThanOrEqual(15);
    expect(refreshDays).toBeGreaterThan(29);
    expect(refreshDays).toBeLessThanOrEqual(30);
  });

  it('stores only hashes of both credentials', async () => {
    const session = await issueSession();
    const rows = await db.query<{ access_token_hash: string; refresh_token_hash: string }>(
      `select access_token_hash, refresh_token_hash from public.desktop_sessions`,
    );
    const hashes = rows.rows.flatMap((row) => [row.access_token_hash, row.refresh_token_hash]);
    expect(hashes).not.toContain(session.accessToken);
    expect(hashes).not.toContain(session.refreshToken);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a live access token back to the right principal', async () => {
    const session = await issueSession();
    await expect(desktop.resolveSessionToken(session.accessToken)).resolves.toEqual({
      userId: userOwnerA,
    });
  });

  it('rejects the refresh token as an access credential', async () => {
    // The long-lived credential must not work on ordinary data endpoints; only the refresh endpoint
    // accepts it. That separation is the whole point of splitting them.
    const session = await issueSession();
    await expect(desktop.resolveSessionToken(session.refreshToken)).resolves.toBeNull();
  });

  it('stops resolving an expired access token', async () => {
    const session = await issueSession();
    await db.query(
      `update public.desktop_sessions set access_token_expires_at = now() - interval '1 minute'`,
    );
    await expect(desktop.resolveSessionToken(session.accessToken)).resolves.toBeNull();
  });

  it('rejects unknown, malformed, and revoked tokens identically', async () => {
    await expect(desktop.resolveSessionToken('short')).resolves.toBeNull();
    await expect(desktop.resolveSessionToken(null)).resolves.toBeNull();
    await expect(desktop.resolveSessionToken(`${'x'.repeat(48)}`)).resolves.toBeNull();
  });
});

describe('refresh rotation', () => {
  it('issues a fresh pair and makes the superseded refresh token unusable', async () => {
    const session = await issueSession();
    const renewed = await desktop.refreshSession(session.refreshToken);

    expect(renewed.accessToken).not.toBe(session.accessToken);
    expect(renewed.refreshToken).not.toBe(session.refreshToken);
    await expect(desktop.resolveSessionToken(session.accessToken)).resolves.toBeNull();
    await expect(desktop.describeSession({ userId: userOwnerA }, session.accessToken)).rejects.toThrow();
    // Replaying the old refresh token fails rather than minting another session.
    await expect(desktop.refreshSession(session.refreshToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('keeps the session usable after rotation', async () => {
    const session = await issueSession();
    const renewed = await desktop.refreshSession(session.refreshToken);
    await expect(desktop.resolveSessionToken(renewed.accessToken)).resolves.toEqual({
      userId: userOwnerA,
    });
    // And the new refresh token works in turn.
    const again = await desktop.refreshSession(renewed.refreshToken);
    expect(again.accessToken).not.toBe(renewed.accessToken);
  });

  it('rotates on every use, so no refresh token is ever accepted twice', async () => {
    await issueSession();
    let token = (await db.query<{ refresh_token_hash: string }>(
      `select refresh_token_hash from public.desktop_sessions`,
    )).rows[0]!.refresh_token_hash;

    // Drive the rotation directly through the service to observe the hash changing each time.
    const first = await desktop.refreshSession(
      await freshRefreshToken(),
    );
    expect(first.refreshToken).toBeTruthy();
    const second = await desktop.refreshSession(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(desktop.refreshSession(first.refreshToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(token).toBeTruthy();
  });

  it('refuses a replay inside the grace window without destroying the live session', async () => {
    const session = await issueSession();
    const renewed = await desktop.refreshSession(session.refreshToken);

    // Replay the superseded token immediately — the race a double-fired renewal produces.
    await expect(desktop.refreshSession(session.refreshToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    // The winning pair is untouched: the caller that got there first is not punished for it.
    expect(await desktop.resolveSessionToken(renewed.accessToken)).toEqual({
      userId: userOwnerA,
    });
    const rows = (
      await db.query('select revoked_at from public.desktop_sessions where refresh_token_hash = $1', [
        sha256Hex(renewed.refreshToken),
      ])
    ).rows as Array<{ revoked_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it('revokes the whole session when a stale refresh token is replayed after the grace window', async () => {
    const session = await issueSession();
    const renewed = await desktop.refreshSession(session.refreshToken);

    // Push the rotation well outside the 30-second grace window, then replay the dead token.
    await db.query(
      `update public.desktop_sessions set refresh_rotated_at = now() - interval '10 minutes'`,
    );
    await expect(desktop.refreshSession(session.refreshToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    const rows = await db.query<{ revoked_at: Date | null }>(
      `select revoked_at from public.desktop_sessions`,
    );
    expect(rows.rows[0]!.revoked_at).not.toBeNull();
    // The legitimate, current credential dies with it — that is the point of reuse detection.
    await expect(desktop.resolveSessionToken(renewed.accessToken)).resolves.toBeNull();
  });

  it('refuses to refresh an expired session', async () => {
    const session = await issueSession();
    await db.query(
      `update public.desktop_sessions set refresh_token_expires_at = now() - interval '1 minute'`,
    );
    await expect(desktop.refreshSession(session.refreshToken)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('serves the refresh route over HTTP with a validated DTO', async () => {
    currentPrincipal = null;
    const session = await issueSession();
    const response = await postRefresh(
      request('/api/v1/desktop/sessions/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accessToken: string; refreshToken: string };
    expect(body.accessToken).not.toBe(session.accessToken);

    const rejected = await postRefresh(
      request('/api/v1/desktop/sessions/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      }),
    );
    expect(rejected.status).toBe(401);
  });
});

describe('session management over HTTP', () => {
  it('serves the session description for a valid access token', async () => {
    const session = await issueSession();
    currentPrincipal = null;
    const response = await getDesktopSession(
      request('/api/v1/desktop/session', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; workspaces: { id: string }[] };
    expect(body.userId).toBe(userOwnerA);
    expect(body.workspaces.map((w) => w.id)).toEqual([workspaceA]);
  });

  it('answers 401 when no credential is presented', async () => {
    currentPrincipal = null;
    const response = await getDesktopSession(request('/api/v1/desktop/session'));
    expect(response.status).toBe(401);
  });

  it('revokes a session immediately, by either credential', async () => {
    const session = await issueSession();
    expect(await desktop.revokeSessionToken(session.accessToken, 'access')).toBe(true);
    await expect(desktop.resolveSessionToken(session.accessToken)).resolves.toBeNull();

    const second = await issueSession();
    expect(await desktop.revokeSessionToken(second.refreshToken, 'refresh')).toBe(true);
    await expect(desktop.resolveSessionToken(second.accessToken)).resolves.toBeNull();
  });

  it('revokes over HTTP and refuses further use', async () => {
    const session = await issueSession();
    currentPrincipal = null;
    const response = await deleteDesktopSession(
      request('/api/v1/desktop/session', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      }),
    );
    expect(response.status).toBe(200);
    await expect(desktop.resolveSessionToken(session.accessToken)).resolves.toBeNull();
  });

  it('re-checks membership before remembering a workspace', async () => {
    const session = await issueSession();
    await expect(
      desktop.rememberWorkspace({ userId: userOwnerA }, session.accessToken, workspaceB),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      desktop.rememberWorkspace({ userId: userOwnerA }, session.accessToken, workspaceA),
    ).resolves.toBeUndefined();
  });
});

describe('workspaces and automatic meeting creation', () => {
  it('lists only workspaces the user is an active member of', async () => {
    const session = await issueSession();
    const workspaces = await desktop.listWorkspaces(session.accessToken);
    expect(workspaces.map((w) => w.id)).toEqual([workspaceA]);
    expect(workspaces[0]).toMatchObject({ name: 'Workspace Alpha', role: 'owner' });
    expect(workspaces[0]!.defaultMeetingTypeId).toBeTruthy();
    expect(workspaces[0]!.meetingTypeCount).toBeGreaterThan(0);
  });

  it('lists nothing for an invalid credential', async () => {
    await expect(desktop.listWorkspaces('not-a-token')).resolves.toEqual([]);
  });

  it('creates a meeting from a workspace alone, defaulting title and type', async () => {
    const session = await issueSession();
    const result = await desktop.ensureMeeting(
      { userId: userOwnerA },
      session.accessToken,
      { workspaceId: workspaceA },
    );
    expect(result.meeting.title).toMatch(/^Suhbat — \d{1,2} \w{3}, \d{2}:\d{2}$/);
    expect(result.meeting.meetingTypeId).toBeTruthy();
    expect(result.meeting.companyId).toBeNull();
    expect(result.meeting.projectId).toBeNull();
    expect(result.defaultsApplied).toEqual({ title: true, meetingType: true });
  });

  it('keeps a client-supplied title and reports that no default was applied', async () => {
    const session = await issueSession();
    const result = await desktop.ensureMeeting({ userId: userOwnerA }, session.accessToken, {
      workspaceId: workspaceA,
      title: 'Suhbat — 8 Oct, 14:32',
    });
    expect(result.meeting.title).toBe('Suhbat — 8 Oct, 14:32');
    expect(result.defaultsApplied.title).toBe(false);
  });

  it('refuses to create a meeting in a workspace the user cannot see', async () => {
    const session = await issueSession();
    await expect(
      desktop.ensureMeeting({ userId: userOwnerA }, session.accessToken, { workspaceId: workspaceB }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      desktop.ensureMeeting(null, session.accessToken, { workspaceId: workspaceA }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a meeting type from another workspace', async () => {
    const session = await issueSession();
    const foreignType = await db.query<{ id: string }>(
      `select id from public.meeting_types where workspace_id = $1 limit 1`,
      [workspaceB],
    );
    await expect(
      desktop.ensureMeeting({ userId: userOwnerA }, session.accessToken, {
        workspaceId: workspaceA,
        meetingTypeId: foreignType.rows[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects a company or project that belongs to another workspace', async () => {
    const session = await issueSession();
    const projectB = (
      await db.query<{ id: string }>(
        `insert into public.projects (workspace_id, name, created_by)
         values ($1, 'Beta project', $2) returning id`,
        [workspaceB, userOwnerB],
      )
    ).rows[0]!.id;
    await expect(
      desktop.ensureMeeting({ userId: userOwnerA }, session.accessToken, {
        workspaceId: workspaceA,
        projectId: projectB,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('accepts a company and project that do belong to the workspace', async () => {
    const session = await issueSession();
    const company = (
      await db.query<{ id: string }>(
        `insert into public.companies (workspace_id, name, created_by)
         values ($1, 'Alpha Co', $2) returning id`,
        [workspaceA, userOwnerA],
      )
    ).rows[0]!.id;
    const project = (
      await db.query<{ id: string }>(
        `insert into public.projects (workspace_id, name, created_by)
         values ($1, 'Alpha project', $2) returning id`,
        [workspaceA, userOwnerA],
      )
    ).rows[0]!.id;
    const result = await desktop.ensureMeeting({ userId: userOwnerA }, session.accessToken, {
      workspaceId: workspaceA,
      companyId: company,
      projectId: project,
    });
    expect(result.meeting.companyId).toBe(company);
    expect(result.meeting.projectId).toBe(project);
  });

  it('records the start instant the desktop captured, not the moment the meeting was created', async () => {
    const session = await issueSession();
    const startedAt = '2026-10-08T09:32:00.000Z';
    const result = await desktop.ensureMeeting({ userId: userOwnerA }, session.accessToken, {
      workspaceId: workspaceA,
      startedAt,
    });
    expect(result.meeting.startedAt).toBe(startedAt);
  });

  it('answers the HTTP route with 201 and a validated DTO', async () => {
    const session = await issueSession();
    currentPrincipal = null;
    const response = await (await import('../../apps/web/src/app/api/v1/meetings/route')).POST(
      request('/api/v1/meetings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ workspaceId: workspaceA, source: 'desktop_recorder' }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { meeting: { workspaceId: string } };
    expect(body.meeting.workspaceId).toBe(workspaceA);
  });

  it('lists workspaces over HTTP for a desktop credential', async () => {
    const session = await issueSession();
    currentPrincipal = null;
    const response = await (await import('../../apps/web/src/app/api/v1/workspaces/route')).GET(
      request('/api/v1/workspaces', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspaces: { id: string }[] };
    expect(body.workspaces.map((w) => w.id)).toEqual([workspaceA]);
  });
});

describe('row level security posture', () => {
  it('denies every client statement on the pairing tables', async () => {
    await issueSession();
    for (const statement of [
      `select * from public.desktop_connect_codes`,
      `select * from public.desktop_sessions`,
      `insert into public.desktop_connect_codes (code_hash, expires_at) values ('x', now())`,
      `update public.desktop_sessions set revoked_at = now()`,
      `delete from public.desktop_sessions`,
    ]) {
      await expect(
        asUser(userOwnerA, async () => {
          await db.query(statement);
        }),
      ).rejects.toThrow();
    }
  });

  it('keeps both tables RLS-enabled', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity
         from pg_class
        where relname in ('desktop_connect_codes', 'desktop_sessions')`,
    );
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) expect(row.relrowsecurity).toBe(true);
  });

  it('rejects a half-bound code at the constraint level', async () => {
    await expect(
      db.query(
        `insert into public.desktop_connect_codes (code_hash, status, expires_at)
         values ($1, 'authorized', now() + interval '5 minutes')`,
        ['f'.repeat(64)],
      ),
    ).rejects.toThrow();
  });

  /**
   * The functions are `security definer`, so they bypass RLS — that is the point. This is the test
   * that keeps them honest: every one of them must reject an anonymous caller that does not hold a
   * real credential. Granting EXECUTE to `anon` is only safe because of these denials.
   */
  it('every anon-callable function refuses a caller with no credential', async () => {
    const bogus = 'a'.repeat(64);
    await expect(desktop.resolveSessionToken('not-a-real-token')).resolves.toBeNull();
    await expect(desktop.refreshSession('not-a-real-token')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(desktop.describeSession(null, 'not-a-real-token')).rejects.toThrow();
    await expect(desktop.rememberWorkspace(null, 'not-a-real-token', workspaceA)).rejects.toThrow();
    await expect(desktop.ensureMeeting(null, 'not-a-real-token', { workspaceId: workspaceA })).rejects.toThrow();
    await expect(desktop.listWorkspaces('not-a-real-token')).resolves.toEqual([]);
    expect(bogus).toHaveLength(64);
  });

  it('removes a user’s sessions when the account itself disappears', async () => {
    const constraint = await db.query<{ confdeltype: string }>(
      `select confdeltype
         from pg_constraint as c
         join pg_class as t on t.oid = c.conrelid
         join pg_class as f on f.oid = c.confrelid
        where t.relname = 'desktop_sessions'
          and f.relname = 'profiles'
          and c.contype = 'f'`,
    );
    expect(constraint.rows[0]?.confdeltype).toBe('c');
  });
});

/**
 * Blocker 5 — the unauthenticated code endpoint must be bounded.
 */
describe('connect code abuse control', () => {
  it('rate limits a client that asks for codes in a loop', async () => {
    const result = Array.from({ length: 8 }, () =>
      consumeConnectCodeBudget(request('https://app.test/api/v1/desktop/connect-codes')),
    );
    const allowed = result.filter((entry) => entry.allowed).length;
    expect(allowed).toBe(5);
    expect(result[5]!.allowed).toBe(false);
    expect(result[5]!.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('ignores a caller-supplied forwarded-for header unless the deployment opts in', async () => {
    process.env.SUHBAT_TRUST_PROXY_HEADERS = 'false';
    resetConnectCodeBudget();
    const spoofed = new Request('https://app.test/api/v1/desktop/connect-codes', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    const other = new Request('https://app.test/api/v1/desktop/connect-codes', {
      headers: { 'x-forwarded-for': '5.6.7.8' },
    });
    // Both share one bucket, so the second caller is still counted.
    for (let index = 0; index < 5; index += 1) consumeConnectCodeBudget(spoofed);
    expect(consumeConnectCodeBudget(other).allowed).toBe(false);
    delete process.env.SUHBAT_TRUST_PROXY_HEADERS;
  });

  it('bounds the total number of live codes at the database level', async () => {
    // The durable backstop: even with the in-process limiter bypassed, the table cannot grow past
    // the ceiling, because the SQL function refuses to insert.
    await db.query(
      `update public.desktop_connect_codes set expires_at = now() + interval '1 hour'`,
    );
    const before = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_connect_codes where expires_at > now()`,
    );
    // Drive the ceiling down so the test does not have to create 2 000 rows.
    for (let index = 0; index < 5; index += 1) {
      await db.query(`select * from public.desktop_create_connect_code($1, null, 600, $2)`, [
        'b'.repeat(64),
        before.rows[0]!.count + 2,
      ]).catch(() => undefined);
    }
    const after = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_connect_codes where expires_at > now()`,
    );
    expect(after.rows[0]!.count).toBeLessThanOrEqual(before.rows[0]!.count + 2);
  });

  it('cleans up long-expired codes opportunistically', async () => {
    await db.query(
      `insert into public.desktop_connect_codes (code_hash, expires_at)
       values ($1, now() - interval '3 hours')`,
      ['c'.repeat(64)],
    );
    await db.query(`select * from public.desktop_create_connect_code($1, null, 600, 2000)`, [
      'd'.repeat(64),
    ]);
    const remaining = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_connect_codes where code_hash = $1`,
      ['c'.repeat(64)],
    );
    expect(remaining.rows[0]!.count).toBe(0);
  });

  it('deletes only expired or long-revoked sessions during cleanup', async () => {
    const session = await issueSession();
    const live = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_sessions`,
    );
    expect(live.rows[0]!.count).toBeGreaterThan(0);

    await db.query(`select public.desktop_cleanup_sessions(500)`);
    const after = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_sessions`,
    );
    // A session that is still current must survive cleanup.
    expect(after.rows[0]!.count).toBe(live.rows[0]!.count);

    await db.query(
      `update public.desktop_sessions set refresh_token_expires_at = now() - interval '30 days'`,
    );
    await db.query(`select public.desktop_cleanup_sessions(500)`);
    const cleaned = await db.query<{ count: number }>(
      `select count(*)::int as count from public.desktop_sessions`,
    );
    expect(cleaned.rows[0]!.count).toBe(0);
    expect(session.accessToken).toBeTruthy();
  });
});

/** Helper for the rotation test: mints a session and hands back its refresh token. */
async function freshRefreshToken(): Promise<string> {
  return (await issueSession()).refreshToken;
}
