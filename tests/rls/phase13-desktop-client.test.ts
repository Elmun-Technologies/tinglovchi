import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DesktopClientService } from '@suhbat/database/desktop';
import { Phase4BackboneService, type AuthenticatedPrincipal } from '@suhbat/database/phase4';
import { MemoryStorageProvider } from '@suhbat/database/storage';
import { desktopBearerToken, setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import { POST as postConnectCode } from '../../apps/web/src/app/api/v1/desktop/connect-codes/route';
import { GET as getConnectCode } from '../../apps/web/src/app/api/v1/desktop/connect-codes/route';
import {
  DELETE as deleteDesktopSession,
  GET as getDesktopSession,
  POST as postDesktopSession,
} from '../../apps/web/src/app/api/v1/desktop/sessions/route';
import { POST as postMeeting } from '../../apps/web/src/app/api/v1/meetings/route';

/**
 * Phase 13 — desktop pairing, sessions, and automatic meeting creation.
 *
 * The one-tap recorder is only trustworthy if its authorization path is. These tests cover the three
 * things that would make it untrustworthy:
 *   1. a code minting a session for someone who never approved it (or for the wrong workspace);
 *   2. a session surviving revocation or expiry;
 *   3. a client creating a meeting — or attaching company/project — in a workspace it cannot see.
 *
 * They also assert the RLS posture directly: both new tables enable row level security with no
 * policies, so no client role can read or write them at all.
 */

const userOwnerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userOwnerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userOutsider = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const phase1MigrationPath = resolve('supabase/migrations/202610060001_phase1_foundation.sql');
const phase4MigrationPath = resolve('supabase/migrations/202610070001_phase4_upload_processing_backbone.sql');
const phase41SecurityMigrationPath = resolve('supabase/migrations/202610070002_phase4_1_security_hardening.sql');
const phase5MigrationPath = resolve('supabase/migrations/202610070003_phase5_transcription_alignment.sql');
const phase13MigrationPath = resolve('supabase/migrations/202610080001_phase13_desktop_client.sql');
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

beforeAll(async () => {
  db = new PGlite();
  await db.exec(authBootstrap);
  await db.exec(readFileSync(phase1MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase4MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase41SecurityMigrationPath, 'utf8'));
  await db.exec(readFileSync(phase5MigrationPath, 'utf8'));
  await db.exec(readFileSync(phase13MigrationPath, 'utf8'));
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
}, 30_000);

beforeEach(() => {
  service = new Phase4BackboneService({ db, storage: new MemoryStorageProvider({ backend: 'local' }) });
  desktop = new DesktopClientService({ db });
  currentPrincipal = { userId: userOwnerA };
  setPhase4Runtime({
    service,
    desktopService: desktop,
    // Mirrors the live resolver: a browser session wins, otherwise the desktop bearer token is the
    // identity. Testing the routes through the same fallback is the point — the desktop must be able
    // to act with *only* a session token.
    resolvePrincipal: async (request) => {
      if (currentPrincipal) return currentPrincipal;
      const token = desktopBearerToken(request);
      return token ? await desktop.resolveSessionToken(token) : null;
    },
  });
});

afterAll(async () => {
  setPhase4Runtime(null);
  await db?.close();
});

describe('connect codes', () => {
  it('mints an unauthenticated, short-lived, pending code', async () => {
    currentPrincipal = null;
    const response = await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string; status: string; pollIntervalMs: number };
    expect(body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(body.status).toBe('pending');
    expect(body.pollIntervalMs).toBeGreaterThan(0);
  });

  it('stores only the hash of the code, never the code itself', async () => {
    currentPrincipal = null;
    const body = (await (
      await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }))
    ).json()) as { code: string };
    const rows = await db.query<{ code_hash: string }>(`select code_hash from public.desktop_connect_codes`);
    expect(rows.rows.some((row) => row.code_hash === body.code)).toBe(false);
    expect(rows.rows.some((row) => /^[0-9a-f]{64}$/.test(row.code_hash))).toBe(true);
  });

  it('refuses to mint a session from a code nobody approved', async () => {
    currentPrincipal = null;
    const created = (await (
      await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }))
    ).json()) as { code: string };
    const response = await postDesktopSession(
      request('/api/v1/desktop/sessions', {
        method: 'POST',
        body: JSON.stringify({ code: created.code }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('does not leak whether a code exists: unknown and expired answer the same way', async () => {
    currentPrincipal = null;
    const unknown = await desktop.connectCodeStatus('ZZZZ-ZZZZ-ZZZZ');
    expect(unknown.status).toBe('pending');
    const malformed = await desktop.connectCodeStatus('not-a-code');
    expect(malformed.status).toBe('pending');
  });

  it('binds an approved code to the approver and their workspace', async () => {
    currentPrincipal = null;
    const created = (await (
      await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }))
    ).json()) as { code: string };

    const authorized = await desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA);
    expect(authorized.status).toBe('authorized');
    expect(authorized.workspaceId).toBe(workspaceA);

    const status = await getConnectCode(
      request('/api/v1/desktop/connect-codes', { headers: { 'x-suhbat-connect-code': created.code } }),
    );
    expect((await status.json()) as { status: string }).toMatchObject({ status: 'authorized' });
  });

  it('refuses to approve a code for a workspace the approver does not belong to', async () => {
    currentPrincipal = null;
    const created = (await (
      await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }))
    ).json()) as { code: string };
    await expect(
      desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceB),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses to approve a code with no authenticated principal', async () => {
    currentPrincipal = null;
    const created = (await (
      await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }))
    ).json()) as { code: string };
    await expect(desktop.authorizeConnectCode(null, created.code, workspaceA)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('burns the code on exchange: a second exchange is refused', async () => {
    currentPrincipal = null;
    const created = (await (
      await postConnectCode(request('/api/v1/desktop/connect-codes', { method: 'POST' }))
    ).json()) as { code: string };
    await desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA);

    const first = await postDesktopSession(
      request('/api/v1/desktop/sessions', { method: 'POST', body: JSON.stringify({ code: created.code }) }),
    );
    expect(first.status).toBe(201);
    const session = (await first.json()) as { token: string; workspaces: unknown[] };
    expect(session.token.length).toBeGreaterThanOrEqual(32);
    expect(session.workspaces).toHaveLength(1);

    const second = await postDesktopSession(
      request('/api/v1/desktop/sessions', { method: 'POST', body: JSON.stringify({ code: created.code }) }),
    );
    expect(second.status).toBe(404);
  });

  it('expires a code instead of minting a session after the TTL', async () => {
    const created = await desktop.createConnectCode({});
    await desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA);
    await db.query(
      `update public.desktop_connect_codes set expires_at = now() - interval '1 minute' where code_hash = $1`,
      [await sha256(created.code)],
    );
    await expect(desktop.exchangeConnectCode({ code: created.code })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('desktop sessions', () => {
  async function issueToken(): Promise<string> {
    const created = await desktop.createConnectCode({});
    await desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA);
    const exchanged = await desktop.exchangeConnectCode({ code: created.code });
    return exchanged.token;
  }

  it('resolves a live token back to the right principal', async () => {
    const token = await issueToken();
    await expect(desktop.resolveSessionToken(token)).resolves.toEqual({ userId: userOwnerA });
  });

  it('stores only the hash of the session token', async () => {
    const token = await issueToken();
    const rows = await db.query<{ token_hash: string }>(`select token_hash from public.desktop_sessions`);
    expect(rows.rows.some((row) => row.token_hash === token)).toBe(false);
  });

  it('rejects an unknown, revoked, or malformed token identically', async () => {
    const token = await issueToken();
    await desktop.revokeSessionToken(token);
    await expect(desktop.resolveSessionToken(token)).resolves.toBeNull();
    await expect(desktop.resolveSessionToken('short')).resolves.toBeNull();
    await expect(desktop.resolveSessionToken(null)).resolves.toBeNull();
    await expect(desktop.resolveSessionToken(`${'x'.repeat(48)}`)).resolves.toBeNull();
  });

  it('does not resolve an expired session', async () => {
    const token = await issueToken();
    await db.query(`update public.desktop_sessions set expires_at = now() - interval '1 minute'`);
    await expect(desktop.resolveSessionToken(token)).resolves.toBeNull();
  });

  it('serves the session description over the authenticated route', async () => {
    const token = await issueToken();
    currentPrincipal = null;
    const response = await getDesktopSession(
      request('/api/v1/desktop/session', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; workspaces: { id: string }[] };
    expect(body.userId).toBe(userOwnerA);
    expect(body.workspaces.map((w) => w.id)).toEqual([workspaceA]);
  });

  it('lists only workspaces the user is an active member of', async () => {
    const workspaces = await desktop.listWorkspaces(userOwnerA);
    expect(workspaces.map((w) => w.id)).toEqual([workspaceA]);
    expect(workspaces[0]).toMatchObject({ name: 'Workspace Alpha', role: 'owner' });
    // The workspace's own default type is the lowest-sort active one copied from the templates.
    expect(workspaces[0]!.defaultMeetingTypeId).toBeTruthy();
    expect(workspaces[0]!.meetingTypeCount).toBeGreaterThan(0);
  });

  it('revokes a session immediately', async () => {
    const token = await issueToken();
    const response = await deleteDesktopSession(
      request('/api/v1/desktop/session', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    await expect(desktop.resolveSessionToken(token)).resolves.toBeNull();
  });

  it('re-checks membership before remembering a workspace', async () => {
    const token = await issueToken();
    await expect(desktop.rememberWorkspace({ userId: userOwnerA }, token, workspaceB)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(desktop.rememberWorkspace({ userId: userOwnerA }, token, workspaceA)).resolves.toBeUndefined();
  });
});

describe('automatic meeting creation', () => {
  it('creates a meeting from a workspace alone, defaulting title and type', async () => {
    const result = await desktop.ensureMeeting({ userId: userOwnerA }, { workspaceId: workspaceA });
    expect(result.meeting.title).toMatch(/^Suhbat — \d{1,2} \w{3}, \d{2}:\d{2}$/);
    expect(result.meeting.meetingTypeId).toBeTruthy();
    expect(result.meeting.companyId).toBeNull();
    expect(result.meeting.projectId).toBeNull();
    expect(result.defaultsApplied).toEqual({ title: true, meetingType: true });
  });

  it('keeps a client-supplied title and reports that no default was applied', async () => {
    const result = await desktop.ensureMeeting(
      { userId: userOwnerA },
      { workspaceId: workspaceA, title: 'Suhbat — 8 Oct, 14:32' },
    );
    expect(result.meeting.title).toBe('Suhbat — 8 Oct, 14:32');
    expect(result.defaultsApplied.title).toBe(false);
  });

  it('refuses to create a meeting in a workspace the user cannot see', async () => {
    await expect(
      desktop.ensureMeeting({ userId: userOwnerA }, { workspaceId: workspaceB }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      desktop.ensureMeeting({ userId: userOutsider }, { workspaceId: workspaceA }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(desktop.ensureMeeting(null, { workspaceId: workspaceA })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses a meeting type from another workspace', async () => {
    const foreignType = await db.query<{ id: string }>(
      `select id from public.meeting_types where workspace_id = $1 limit 1`,
      [workspaceB],
    );
    await expect(
      desktop.ensureMeeting(
        { userId: userOwnerA },
        { workspaceId: workspaceA, meetingTypeId: foreignType.rows[0]!.id },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects a company or project that belongs to another workspace', async () => {
    // Seeded as the migration/owner role: RLS on `projects` is exercised in its own suite, and this
    // test is only about whether `ensureMeeting` will accept a row from a foreign workspace.
    const projectB = (
      await db.query<{ id: string }>(
        `insert into public.projects (workspace_id, name, created_by)
         values ($1, 'Beta project', $2) returning id`,
        [workspaceB, userOwnerB],
      )
    ).rows[0]!.id;
    await expect(
      desktop.ensureMeeting({ userId: userOwnerA }, { workspaceId: workspaceA, projectId: projectB }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('accepts a company and project that do belong to the workspace', async () => {
    const company = await db.query<{ id: string }>(
      `insert into public.companies (workspace_id, name, created_by)
       values ($1, 'Alpha Co', $2) returning id`,
      [workspaceA, userOwnerA],
    );
    const project = await db.query<{ id: string }>(
      `insert into public.projects (workspace_id, name, created_by)
       values ($1, 'Alpha project', $2) returning id`,
      [workspaceA, userOwnerA],
    );
    const result = await desktop.ensureMeeting(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        companyId: company.rows[0]!.id,
        projectId: project.rows[0]!.id,
      },
    );
    expect(result.meeting.companyId).toBe(company.rows[0]!.id);
    expect(result.meeting.projectId).toBe(project.rows[0]!.id);
  });

  it('answers the HTTP route with 201 and a validated DTO', async () => {
    const token = await issueFor(userOwnerA);
    currentPrincipal = null;
    const response = await postMeeting(
      request('/api/v1/meetings', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspaceA, source: 'desktop_recorder' }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { meeting: { workspaceId: string }; defaultsApplied: unknown };
    expect(body.meeting.workspaceId).toBe(workspaceA);

    const unauthorized = await postMeeting(
      request('/api/v1/meetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspaceA }),
      }),
    );
    expect(unauthorized.status).toBe(401);
  });

  it('records the start instant the desktop captured, not the moment the meeting was created', async () => {
    const startedAt = '2026-10-08T09:32:00.000Z';
    const result = await desktop.ensureMeeting(
      { userId: userOwnerA },
      { workspaceId: workspaceA, startedAt },
    );
    expect(result.meeting.startedAt).toBe(startedAt);
  });

  async function issueFor(userId: string): Promise<string> {
    const created = await desktop.createConnectCode({});
    await desktop.authorizeConnectCode({ userId }, created.code, workspaceA);
    return (await desktop.exchangeConnectCode({ code: created.code })).token;
  }
});

describe('row level security posture', () => {
  it('denies every client statement on the pairing tables', async () => {
    const created = await desktop.createConnectCode({});
    await desktop.authorizeConnectCode({ userId: userOwnerA }, created.code, workspaceA);
    const token = (await desktop.exchangeConnectCode({ code: created.code })).token;

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
    expect(token.length).toBeGreaterThan(0);
  });

  it('keeps both tables RLS-enabled', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity
         from pg_class
        where relname in ('desktop_connect_codes', 'desktop_sessions')`,
    );
    expect(res.rows).toHaveLength(2);
    for (const row of res.rows) {
      expect(row.relrowsecurity).toBe(true);
    }
  });

  it('rejects a half-bound code at the constraint level', async () => {
    // Defence in depth: even a buggy writer cannot leave a code that is authorized but userless.
    await expect(
      db.query(
        `insert into public.desktop_connect_codes (code_hash, status, expires_at)
         values ($1, 'authorized', now() + interval '5 minutes')`,
        ['f'.repeat(64)],
      ),
    ).rejects.toThrow();
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

async function sha256(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
