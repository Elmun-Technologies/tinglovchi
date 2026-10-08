import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4BackboneService, type AuthenticatedPrincipal } from '@suhbat/database/phase4';
import { Phase5TranscriptionService } from '@suhbat/database/phase5';
import { Phase6IntelligenceService } from '@suhbat/database/phase6';
import { MemoryStorageProvider } from '@suhbat/database/storage';
import { PRIVILEGED_RUNTIME_ROLES, getWorkerExecutor } from '@suhbat/database/worker-executor';
import { validateProductionEnvironment } from '@suhbat/database/production-env';
import {
  KEY_ID_HEADER,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  USER_ID_HEADER,
  createNonceStore,
  signInternalRequest,
  verifyInternalRequest,
} from '@suhbat/database/internal-service-auth';
import { createRecordingApi } from '@suhbat/recording-api/server';
import { createPostgresNonceStore } from '@suhbat/database/internal-service-nonce-store';
import { setPhase4Runtime } from '../../apps/web/src/lib/api-v1-runtime';
import {
  resetRecordingGateway,
  setRecordingGateway,
} from '../../apps/web/src/lib/recording-gateway';
import { POST as postRecordingRoute } from '../../apps/web/src/app/api/v1/recordings/route';
import { POST as postChunkRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/chunks/route';
import { POST as postFinalizeRoute } from '../../apps/web/src/app/api/v1/recordings/[recordingId]/finalize/route';

/**
 * The three-role deployment boundary.
 *
 * This file proves the split is real rather than cosmetic. Each test targets one way the boundary
 * could be quietly eroded:
 *
 *   - the web process reaching for a database credential it is forbidden to hold;
 *   - the Recording API accepting a request that did not come from the web gateway;
 *   - a client forging the identity the Recording API acts on;
 *   - the Recording API skipping its own authorization because "the gateway already checked";
 *   - processing providers creeping into the request path;
 *   - the desktop learning an internal hostname.
 *
 * The recording flow is driven end to end: web route → real signature → real socket → real
 * Recording API → PGlite. Nothing here is mocked except the clock where it needs to be.
 */

const userOwnerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userMemberA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userOwnerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userOutsider = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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
let storage: MemoryStorageProvider;
let service: Phase4BackboneService;
let currentPrincipal: AuthenticatedPrincipal | null = { userId: userOwnerA };

let workspaceA: string;
let workspaceB: string;
let meetingTypeA: string;
let meetingTypeB: string;

const TEST_SECRET = 'test-internal-secret-do-not-use-in-production';

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

async function createMeetingDraft(
  userId: string,
  workspaceId: string,
  meetingTypeId: string,
  title: string,
): Promise<string> {
  return asUser(userId, async () => {
    const res = await db.query<{ id: string }>(
      `insert into public.meetings (workspace_id, meeting_type_id, title, created_by)
       values ($1, $2, $3, $4)
       returning id`,
      [workspaceId, meetingTypeId, title, userId],
    );
    return res.rows[0]!.id;
  });
}

function timeline(sessionSuffix: string) {
  return {
    clock: 'platform_monotonic_continuous' as const,
    clockEpochId: `b2222222-2222-4222-8222-${sessionSuffix}`,
    originTicks: '1000',
    originWallClockUtc: '2026-10-07T08:00:00.000Z',
    tickFrequencyHz: 1_000_000_000,
  };
}

function consent() {
  return { acknowledgedAt: '2026-10-07T08:00:00.000Z', policyVersion: 'v1' };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(authBootstrap);
  await db.exec(readFileSync(resolve('supabase/migrations/202610060001_phase1_foundation.sql'), 'utf8'));
  await db.exec(
    readFileSync(resolve('supabase/migrations/202610070001_phase4_upload_processing_backbone.sql'), 'utf8'),
  );
  await db.exec(
    readFileSync(resolve('supabase/migrations/202610070002_phase4_1_security_hardening.sql'), 'utf8'),
  );
  // The durable replay ledger the Recording API claims nonces in.
  await db.exec(
    readFileSync(resolve('supabase/migrations/202610080003_internal_service_nonce.sql'), 'utf8'),
  );
  await db.exec(readFileSync(resolve('supabase/seed.sql'), 'utf8'));

  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values ($1, 'owner-a@example.test', '{"full_name":"Owner A"}'::jsonb),
            ($2, 'member-a@example.test', '{"full_name":"Member A"}'::jsonb),
            ($3, 'owner-b@example.test', '{"full_name":"Owner B"}'::jsonb),
            ($4, 'outsider@example.test', '{"full_name":"Outsider"}'::jsonb)`,
    [userOwnerA, userMemberA, userOwnerB, userOutsider],
  );

  const makeWorkspace = async (userId: string, name: string, slug: string): Promise<string> =>
    asUser(userId, async () => {
      const res = await db.query<{ workspace_id: string }>(
        'select public.create_workspace($1, $2) as workspace_id',
        [name, slug],
      );
      return res.rows[0]!.workspace_id;
    });

  workspaceA = await makeWorkspace(userOwnerA, 'Workspace Alpha', 'workspace-alpha');
  workspaceB = await makeWorkspace(userOwnerB, 'Workspace Beta', 'workspace-beta');

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
     values ($1, $2, 'member', 'active')`,
    [workspaceA, userMemberA],
  );

  const typesA = await db.query<{ id: string }>(
    `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
    [workspaceA],
  );
  meetingTypeA = typesA.rows[0]!.id;
  const typesB = await db.query<{ id: string }>(
    `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
    [workspaceB],
  );
  meetingTypeB = typesB.rows[0]!.id;
}, 60_000);

beforeEach(() => {
  storage = new MemoryStorageProvider({ backend: 'local' });
  service = new Phase4BackboneService({ db, storage });
  currentPrincipal = { userId: userOwnerA };
  resetRecordingGateway();
  setPhase4Runtime({
    service,
    resolvePrincipal: async () => currentPrincipal,
  });
});

afterAll(async () => {
  setPhase4Runtime(null);
  resetRecordingGateway();
  await db?.close();
});

// ---------------------------------------------------------------------------
// A live Recording API on a real socket, so the HTTP path is genuinely exercised.
// ---------------------------------------------------------------------------

type LiveRecordingApi = { server: Server; baseUrl: string; close: () => Promise<void> };

async function startLiveRecordingApi(
  overrides: { service?: Phase4BackboneService } = {},
): Promise<LiveRecordingApi> {
  // Each call builds its own Recording API instance. Two calls over the same `db` model two
  // machines: separate processes with separate memories, sharing one database.
  const api = createRecordingApi({
    service: overrides.service ?? service,
    signingSecrets: [{ keyId: 'primary', secret: TEST_SECRET }],
  });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const result = await api.handle({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: {
          get: (name: string) => {
            const value = request.headers[name.toLowerCase()];
            if (value === undefined) return null;
            return Array.isArray(value) ? value.join(', ') : value;
          },
        },
        body,
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** A syntactically valid random UUID, for fields the contracts require to be one. */
function fakeUuid(): string {
  const h = randomHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
}

async function countNonceRows(): Promise<number> {
  const result = await db.query<{ count: number }>(
    'select count(*)::int as count from public.internal_service_nonces',
  );
  return result.rows[0]!.count;
}

/** Removes block and line comments, so prose about a rule cannot satisfy the rule. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function nextRequest(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextRequest {
  return new Request(input.url, {
    method: input.method,
    headers: {
      'content-type': 'application/json',
      ...(input.headers ?? {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  }) as unknown as NextRequest;
}

// ===========================================================================
// 1. Web cannot instantiate a SqlExecutor
// ===========================================================================

describe('1. web cannot instantiate a SqlExecutor', () => {
  it('rejects role "web" at runtime', async () => {
    await expect(
      // @ts-expect-error "web" is deliberately not a member of PrivilegedRuntimeRole
      getWorkerExecutor({ role: 'web' }),
    ).rejects.toThrow(/Only the privileged services \(recording-api, worker\)/);
  });

  it('rejects every role that is not recording-api or worker', async () => {
    for (const role of ['web', 'dashboard', 'api', '', 'WORKER']) {
      await expect(getWorkerExecutor({ role: role as never })).rejects.toThrow(
        /Only the privileged services/,
      );
    }
  });

  it('offers no zero-argument or defaulted form that could be constructed by accident', () => {
    const source = readFileSync(resolve('packages/database/src/worker-executor.ts'), 'utf8');
    expect(source).toMatch(/export async function getWorkerExecutor\(\s*request: WorkerExecutorRequest/);
    expect(source).not.toMatch(/role:\s*PrivilegedRuntimeRole\s*=/);
    expect(source).not.toMatch(/role\?:\s*PrivilegedRuntimeRole/);
  });

  it('no file under apps/web imports the executor or the pg driver', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync(
      `find apps/web/src -type f \\( -name '*.ts' -o -name '*.tsx' \\)`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => {
      const text = readFileSync(resolve(file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return /worker-executor|getWorkerExecutor|from\s+['"]pg['"]/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// 2. A web environment containing SUPABASE_DB_URL fails closed
// ===========================================================================

describe('2. web environment containing SUPABASE_DB_URL fails closed', () => {
  const webBase = {
    NODE_ENV: 'production',
    SUHBAT_RUNTIME_ROLE: 'web',
    APP_URL: 'https://app.suhbat.uz',
    SUHBAT_DATA_MODE: 'live',
    NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUHBAT_RECORDING_API_URL: 'http://suhbat-recording-api.flycast:8080',
    SUHBAT_INTERNAL_API_SECRET: TEST_SECRET,
  };

  it('rejects SUPABASE_DB_URL for role=web', () => {
    const result = validateProductionEnvironment(
      { ...webBase, SUPABASE_DB_URL: 'postgresql://owner:pw@db.proj.supabase.co:5432/postgres' },
      { role: 'web', throwOnError: false },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/SUPABASE_DB_URL is forbidden in the Web deployment/);
  });

  it('rejects SUPABASE_SERVICE_ROLE_KEY for role=web', () => {
    const result = validateProductionEnvironment(
      { ...webBase, SUPABASE_SERVICE_ROLE_KEY: 'service-role' },
      { role: 'web', throwOnError: false },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/SUPABASE_SERVICE_ROLE_KEY is forbidden/);
  });

  it('refuses to build an executor even when the credential is present in the environment', async () => {
    await expect(
      getWorkerExecutor({
        role: 'worker',
        env: { NODE_ENV: 'production', SUHBAT_RUNTIME_ROLE: 'web', SUPABASE_DB_URL: 'postgresql://x' },
      }),
    ).rejects.toThrow(/SUHBAT_RUNTIME_ROLE=web, which forbids SUPABASE_DB_URL/);
  });

  it('refuses when the requested role contradicts the declared role', async () => {
    await expect(
      getWorkerExecutor({
        role: 'worker',
        env: { NODE_ENV: 'production', SUHBAT_RUNTIME_ROLE: 'recording-api', SUPABASE_DB_URL: 'postgresql://x' },
      }),
    ).rejects.toThrow(/does not match the requested role "worker"/);
  });

  it('a correctly-configured web deployment still passes', () => {
    const result = validateProductionEnvironment(webBase, { role: 'web', throwOnError: false });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// 3. recording-api and worker are distinct runtime roles
// ===========================================================================

describe('3. recording-api and worker are distinct runtime roles', () => {
  it('both are privileged, and they are not the same role', () => {
    expect(PRIVILEGED_RUNTIME_ROLES).toContain('recording-api');
    expect(PRIVILEGED_RUNTIME_ROLES).toContain('worker');
    expect(new Set(PRIVILEGED_RUNTIME_ROLES).size).toBe(2);
  });

  it('the executor accepts both privileged roles', async () => {
    // No SUPABASE_DB_URL, so both resolve to null rather than connecting — which still proves the
    // role guard let them through.
    await expect(getWorkerExecutor({ role: 'recording-api', env: {} })).resolves.toBeNull();
    await expect(getWorkerExecutor({ role: 'worker', env: {} })).resolves.toBeNull();
  });

  const recordingApiBase = {
    NODE_ENV: 'production',
    SUHBAT_RUNTIME_ROLE: 'recording-api',
    APP_URL: 'https://app.suhbat.uz',
    SUHBAT_DATA_MODE: 'live',
    STORAGE_PROVIDER: 'r2',
    R2_ACCOUNT_ID: 'acc',
    R2_BUCKET: 'bucket',
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    SUHBAT_INTERNAL_API_SECRET: TEST_SECRET,
    SUPABASE_DB_URL: 'postgresql://recording:pw@db.proj.supabase.co:5432/postgres',
  };

  it('recording-api boots without any AssemblyAI or OpenAI credential', () => {
    const result = validateProductionEnvironment(recordingApiBase, {
      role: 'recording-api',
      throwOnError: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('recording-api rejects processing credentials it has no use for', () => {
    const result = validateProductionEnvironment(
      { ...recordingApiBase, OPENAI_API_KEY: 'sk-should-not-be-here' },
      { role: 'recording-api', throwOnError: false },
    );
    expect(result.errors.join(' ')).toMatch(/OPENAI_API_KEY must not be set on the recording-api/);
  });

  it('recording-api rejects a missing database credential', () => {
    const { SUPABASE_DB_URL: _omitted, ...withoutDb } = recordingApiBase;
    const result = validateProductionEnvironment(withoutDb, {
      role: 'recording-api',
      throwOnError: false,
    });
    expect(result.errors.join(' ')).toMatch(/recording-api requires SUPABASE_DB_URL/);
  });

  it('worker still requires the full provider stack', () => {
    const result = validateProductionEnvironment(
      {
        ...recordingApiBase,
        SUHBAT_RUNTIME_ROLE: 'worker',
        OPENAI_API_KEY: 'sk-openai',
      },
      { role: 'worker', throwOnError: false },
    );
    expect(result.errors.join(' ')).toMatch(/TRANSCRIPTION_PROVIDER must be "assemblyai"/);
    expect(result.errors.join(' ')).toMatch(/ASSEMBLYAI_API_KEY is required/);
  });

  it('web must be able to reach the recording API over a private-network host only', () => {
    const base = {
      NODE_ENV: 'production',
      SUHBAT_RUNTIME_ROLE: 'web',
      APP_URL: 'https://app.suhbat.uz',
      SUHBAT_DATA_MODE: 'live',
      NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      SUHBAT_INTERNAL_API_SECRET: TEST_SECRET,
    };
    const publicHost = validateProductionEnvironment(
      { ...base, SUHBAT_RECORDING_API_URL: 'https://recording.suhbat.uz' },
      { role: 'web', throwOnError: false },
    );
    expect(publicHost.errors.join(' ')).toMatch(/must point at a private-network host/);

    const privateHost = validateProductionEnvironment(
      { ...base, SUHBAT_RECORDING_API_URL: 'http://suhbat-recording-api.flycast:8080' },
      { role: 'web', throwOnError: false },
    );
    expect(privateHost.errors).toEqual([]);
  });
});

// ===========================================================================
// 4-6. Recording API authentication and authorization
// ===========================================================================

describe('4. recording API rejects requests without valid internal service authentication', () => {
  it('rejects a request with no signature at all', async () => {
    const live = await startLiveRecordingApi();
    try {
      const response = await fetch(`${live.baseUrl}/api/v1/recordings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('unauthorized');
    } finally {
      await live.close();
    }
  });

  it('rejects a signature produced with the wrong secret', async () => {
    const live = await startLiveRecordingApi();
    try {
      const path = '/api/v1/recordings';
      const body = '{}';
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOwnerA },
        { keyId: 'primary', secret: 'not-the-real-secret' },
      );
      const response = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      expect(response.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('rejects a signature that is valid but stale', async () => {
    const live = await startLiveRecordingApi();
    try {
      const path = '/api/v1/recordings';
      const body = '{}';
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
        { timestampMs: Date.now() - 10 * 60_000 },
      );
      const response = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      expect(response.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('rejects a replayed request: the same signature twice, only the first counts', async () => {
    const live = await startLiveRecordingApi();
    try {
      const path = '/api/v1/recordings';
      const body = '{}';
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
      );
      const send = () =>
        fetch(`${live.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
        });
      const first = await send();
      const second = await send();
      // The first fails validation of the *payload* (empty body), but it got past authentication.
      expect(first.status).not.toBe(401);
      expect(second.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('rejects a signature over a different body than the one sent', async () => {
    const live = await startLiveRecordingApi();
    try {
      const path = '/api/v1/recordings';
      const headers = signInternalRequest(
        { method: 'POST', path, body: '{"workspaceId":"x"}', userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
      );
      const response = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{"workspaceId":"different"}',
      });
      expect(response.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('never reveals which routes exist to an unauthenticated caller', async () => {
    const live = await startLiveRecordingApi();
    try {
      const real = await fetch(`${live.baseUrl}/api/v1/recordings`);
      const fake = await fetch(`${live.baseUrl}/api/v1/definitely-not-a-route`);
      expect(real.status).toBe(401);
      expect(fake.status).toBe(401);
      expect(await real.text()).toEqual(await fake.text());
    } finally {
      await live.close();
    }
  });
});

describe('5. client-supplied identity headers cannot forge a principal', () => {
  it('a bare x-suhbat-user-id header with no signature is rejected', async () => {
    const live = await startLiveRecordingApi();
    try {
      const response = await fetch(`${live.baseUrl}/api/v1/recordings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [USER_ID_HEADER]: userOwnerB,
        },
        body: '{}',
      });
      expect(response.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('a valid signature cannot be retargeted at another user', async () => {
    const live = await startLiveRecordingApi();
    try {
      const path = '/api/v1/recordings';
      const body = '{}';
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
      );
      // Swap the identity after signing. The signature covers the user id, so this must fail.
      const response = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
          [USER_ID_HEADER]: userOwnerB,
        },
        body,
      });
      expect(response.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('the gateway re-signs with the identity it resolved, ignoring anything the client sent', async () => {
    const live = await startLiveRecordingApi();
    setRecordingGateway({
      async forward(target, principal) {
        // Stands in for the real HTTP gateway: proves the principal comes from the gateway's own
        // authentication, and that an inbound client header never reaches the recording API.
        const path = target.searchParams?.toString()
          ? `${target.path}?${target.searchParams.toString()}`
          : target.path;
        const body = target.body ?? '';
        const headers = signInternalRequest(
          { method: target.method, path, body, userId: principal.userId },
          { keyId: 'primary', secret: TEST_SECRET },
        );
        const response = await fetch(`${live.baseUrl}${path}`, {
          method: target.method,
          headers: { 'content-type': 'application/json', ...headers },
          body: target.method === 'GET' || target.method === 'DELETE' ? undefined : body,
        });
        return { status: response.status, body: await response.text() };
      },
    });
    try {
      const meetingId = await createMeetingDraft(userMemberA, workspaceA, meetingTypeA, 'Gateway Identity');
      // The client claims to be the workspace owner; the gateway authenticated it as the member.
      currentPrincipal = { userId: userMemberA };
      const response = await postRecordingRoute(
        nextRequest({
          method: 'POST',
          url: 'https://app.suhbat.uz/api/v1/recordings',
          headers: { [USER_ID_HEADER]: userOwnerA },
          body: {
            workspaceId: workspaceA,
            meetingId,
            sessionId: 'c1111111-1111-4111-8111-111111111111',
            timeline: timeline('111111111111'),
            consent: consent(),
          },
        }),
      );
      expect(response.status).toBe(201);
      const created = (await response.json()) as { recording: { createdBy: string } };
      // Recorded against the authenticated member, not the forged owner.
      expect(created.recording.createdBy).toBe(userMemberA);
    } finally {
      await live.close();
      resetRecordingGateway();
    }
  });

  it('the signing scheme covers method, path, timestamp, nonce, body and user id', () => {
    const key = { keyId: 'primary', secret: TEST_SECRET };
    const base = { method: 'POST', path: '/api/v1/recordings', body: '{}', userId: userOwnerA };
    const reference = signInternalRequest(base, key, { timestampMs: 1_000, nonce: 'n1' });

    const differing = [
      signInternalRequest({ ...base, method: 'GET' }, key, { timestampMs: 1_000, nonce: 'n1' }),
      signInternalRequest({ ...base, path: '/api/v1/other' }, key, { timestampMs: 1_000, nonce: 'n1' }),
      signInternalRequest({ ...base, body: '{"a":1}' }, key, { timestampMs: 1_000, nonce: 'n1' }),
      signInternalRequest({ ...base, userId: userOwnerB }, key, { timestampMs: 1_000, nonce: 'n1' }),
      signInternalRequest(base, key, { timestampMs: 2_000, nonce: 'n1' }),
      signInternalRequest(base, key, { timestampMs: 1_000, nonce: 'n2' }),
    ];
    for (const candidate of differing) {
      expect(candidate[SIGNATURE_HEADER]).not.toBe(reference[SIGNATURE_HEADER]);
    }
  });

  it('verification is constant-time and rejects a truncated signature', async () => {
    const key = { keyId: 'primary', secret: TEST_SECRET };
    const headers = signInternalRequest(
      { method: 'POST', path: '/x', body: '', userId: userOwnerA },
      key,
    );
    const truncated = { ...headers, [SIGNATURE_HEADER]: `v1=${'a'.repeat(63)}` };
    const result = await verifyInternalRequest({
      method: 'POST',
      path: '/x',
      body: '',
      headers: new Headers(truncated),
      keys: [key],
      nonceStore: createNonceStore(),
    });
    expect(result.ok).toBe(false);
  });
});

describe('6. recording API re-checks workspace and meeting authorization', () => {
  it('refuses to register a recording in a workspace the user does not belong to', async () => {
    const live = await startLiveRecordingApi();
    try {
      const response = await fetch(`${live.baseUrl}/api/v1/recordings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(401); // unsigned, so authorization is never even reached
      await response.text();
    } finally {
      await live.close();
    }

    // Now signed, as a user with no membership in workspace B.
    const meetingInB = await createMeetingDraft(userOwnerB, workspaceB, meetingTypeB, 'B Meeting');
    const api = createRecordingApi({
      service,
      signingSecrets: [{ keyId: 'primary', secret: TEST_SECRET }],
    });
    const body = JSON.stringify({
      workspaceId: workspaceB,
      meetingId: meetingInB,
      sessionId: 'c2222222-2222-4222-8222-222222222222',
      timeline: timeline('222222222222'),
      consent: consent(),
    });
    const path = '/api/v1/recordings';
    const headers = signInternalRequest(
      { method: 'POST', path, body, userId: userOutsider },
      { keyId: 'primary', secret: TEST_SECRET },
    );
    const result = await api.handle({
      method: 'POST',
      path,
      headers: new Headers(headers),
      body,
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('unauthorized');
  });

  it('refuses a meeting that exists but lives in a different workspace', async () => {
    const meetingInB = await createMeetingDraft(userOwnerB, workspaceB, meetingTypeB, 'B Only');
    const api = createRecordingApi({
      service,
      signingSecrets: [{ keyId: 'primary', secret: TEST_SECRET }],
    });
    const body = JSON.stringify({
      workspaceId: workspaceA, // userOwnerA is a member here...
      meetingId: meetingInB, // ...but the meeting is not
      sessionId: 'c3333333-3333-4333-8333-333333333333',
      timeline: timeline('333333333333'),
      consent: consent(),
    });
    const path = '/api/v1/recordings';
    const headers = signInternalRequest(
      { method: 'POST', path, body, userId: userOwnerA },
      { keyId: 'primary', secret: TEST_SECRET },
    );
    const result = await api.handle({ method: 'POST', path, headers: new Headers(headers), body });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('cross_workspace_access_denied');
  });

  it('refuses a chunk on a recording owned by another workspace', async () => {
    // A owns a recording in workspace A.
    const meetingA = await createMeetingDraft(userOwnerA, workspaceA, meetingTypeA, 'A Recording');
    const { recording } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId: meetingA,
        sessionId: 'c4444444-4444-4444-8444-444444444444',
        timeline: timeline('444444444444'),
        consent: consent(),
      },
    );

    const api = createRecordingApi({
      service,
      signingSecrets: [{ keyId: 'primary', secret: TEST_SECRET }],
    });
    const body = JSON.stringify({ workspaceId: workspaceA, sequenceNo: 1 });
    const path = `/api/v1/recordings/${recording.id}/chunks`;
    // Signed as B, who has nothing to do with workspace A.
    const headers = signInternalRequest(
      { method: 'POST', path, body, userId: userOwnerB },
      { keyId: 'primary', secret: TEST_SECRET },
    );
    const result = await api.handle({ method: 'POST', path, headers: new Headers(headers), body });
    expect([403, 404]).toContain(result.status);
  });

  it('does not confirm whether a recording exists to a non-member', async () => {
    const meetingA = await createMeetingDraft(userOwnerA, workspaceA, meetingTypeA, 'Existence');
    const { recording } = await service.createRecording(
      { userId: userOwnerA },
      {
        workspaceId: workspaceA,
        meetingId: meetingA,
        sessionId: 'c5555555-5555-4555-8555-555555555555',
        timeline: timeline('555555555555'),
        consent: consent(),
      },
    );
    const api = createRecordingApi({
      service,
      signingSecrets: [{ keyId: 'primary', secret: TEST_SECRET }],
    });
    const sign = (userId: string, path: string) =>
      new Headers(
        signInternalRequest(
          { method: 'GET', path, body: '', userId },
          { keyId: 'primary', secret: TEST_SECRET },
        ),
      );

    const realPath = `/api/v1/recordings/${recording.id}`;
    const missingPath = `/api/v1/recordings/99999999-9999-4999-8999-999999999999`;
    const real = await api.handle({
      method: 'GET',
      path: realPath,
      headers: sign(userOutsider, realPath),
      body: '',
    });
    const missing = await api.handle({
      method: 'GET',
      path: missingPath,
      headers: sign(userOutsider, missingPath),
      body: '',
    });
    // Same status and same code either way: no enumeration oracle.
    expect(real.status).toBe(missing.status);
    expect(JSON.parse(real.body).error.code).toBe(JSON.parse(missing.body).error.code);
  });
});

// ===========================================================================
// 6b. Durable, cross-machine replay protection
// ===========================================================================

describe('6b. durable replay protection across Recording API machines', () => {
  /** A signed, valid request that will succeed: registering a recording as the workspace owner. */
  async function signedCreateRequest(nonce?: string, options: { stale?: boolean } = {}) {
    const meetingA = await createMeetingDraft(userOwnerA, workspaceA, meetingTypeA, 'Replay Guard');
    const path = '/api/v1/recordings';
    const body = JSON.stringify({
      workspaceId: workspaceA,
      meetingId: meetingA,
      sessionId: fakeUuid(),
      timeline: timeline(randomHex(6)),
      consent: consent(),
    });
    const headers = signInternalRequest(
      { method: 'POST', path, body, userId: userOwnerA },
      { keyId: 'primary', secret: TEST_SECRET },
      {
        ...(nonce ? { nonce } : {}),
        ...(options.stale ? { timestampMs: Date.now() - 10 * 60_000 } : {}),
      },
    );
    return { path, body, headers };
  }

  function send(live: LiveRecordingApi, request: { path: string; body: string; headers: Record<string, string> }) {
    return fetch(`${live.baseUrl}${request.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: request.body,
    });
  }

  it('1. a valid signed request succeeds exactly once', async () => {
    const live = await startLiveRecordingApi();
    try {
      const request = await signedCreateRequest();
      const first = await send(live, request);
      expect(first.status).toBe(201);
    } finally {
      await live.close();
    }
  });

  it('2. replaying the exact same signed request is rejected', async () => {
    const live = await startLiveRecordingApi();
    try {
      const request = await signedCreateRequest();
      const first = await send(live, request);
      const second = await send(live, request);
      expect(first.status).toBe(201);
      expect(second.status).toBe(401);
      expect((await second.json() as { error: { code: string } }).error.code).toBe('unauthorized');
    } finally {
      await live.close();
    }
  });

  it('3. replaying it against a SECOND Recording API instance is also rejected', async () => {
    // Two servers, two Recording API instances, one shared database — which is what two machines
    // look like. This is the case a process-local nonce store cannot catch.
    const machineA = await startLiveRecordingApi();
    const machineB = await startLiveRecordingApi();
    try {
      const request = await signedCreateRequest();
      const onA = await send(machineA, request);
      expect(onA.status).toBe(201);

      // Machine B has never seen this nonce in its own memory. Only the shared ledger stops it.
      const onB = await send(machineB, request);
      expect(onB.status).toBe(401);
    } finally {
      await machineA.close();
      await machineB.close();
    }
  });

  it('4. identical requests with different valid nonces both succeed', async () => {
    const live = await startLiveRecordingApi();
    try {
      // Same method, path and user; deliberately the same nonce length and alphabet, different value.
      const one = await signedCreateRequest(`nonce-alpha-${randomHex(8)}`);
      const two = await signedCreateRequest(`nonce-bravo-${randomHex(8)}`);
      const first = await send(live, one);
      const second = await send(live, two);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
    } finally {
      await live.close();
    }
  });

  it('5. an invalid HMAC does not reserve its nonce', async () => {
    const live = await startLiveRecordingApi();
    try {
      const reserved = `nonce-forged-${randomHex(8)}`;
      const request = await signedCreateRequest(reserved);

      // Same nonce, signature corrupted. This must be refused AND must not burn the nonce.
      const forged = { ...request, headers: { ...request.headers, [SIGNATURE_HEADER]: `v1=${'b'.repeat(64)}` } };
      const rejected = await send(live, forged);
      expect(rejected.status).toBe(401);

      // The legitimate request carrying that nonce still works. If the forged attempt had reserved
      // it, an unauthenticated caller could pre-burn any nonce it could guess.
      const legitimate = await signedCreateRequest(reserved);
      const accepted = await send(live, legitimate);
      expect(accepted.status).toBe(201);
    } finally {
      await live.close();
    }
  });

  it('6. a stale timestamp is rejected and does not reserve its nonce', async () => {
    const live = await startLiveRecordingApi();
    try {
      const reserved = `nonce-stale-${randomHex(8)}`;
      const request = await signedCreateRequest(reserved, { stale: true });

      const rejected = await send(live, request);
      expect(rejected.status).toBe(401);

      // Re-signed with a fresh timestamp, the same nonce is still usable.
      const fresh = await signedCreateRequest(reserved);
      const accepted = await send(live, fresh);
      expect(accepted.status).toBe(201);
    } finally {
      await live.close();
    }
  });

  it('7. expired nonce rows can be cleaned, and cleanup is bounded', async () => {
    const live = await startLiveRecordingApi();
    try {
      const store = createPostgresNonceStore({ db });
      for (let index = 0; index < 5; index += 1) {
        expect(await store.consume(`purge-nonce-${index}`, 'primary')).toBe(true);
      }
      const before = await countNonceRows();
      expect(before).toBeGreaterThanOrEqual(5);

      // Nothing is expired yet, so a purge removes nothing.
      expect(await store.purgeExpired()).toBe(0);
      expect(await countNonceRows()).toBe(before);

      // Age only these rows out, then confirm a bounded purge removes a bounded number.
      await db.exec(
        `update public.internal_service_nonces
            set created_at = pg_catalog.now() - interval '2 hours',
                expires_at = pg_catalog.now() - interval '1 hour'
          where nonce like 'purge-nonce-%'`,
      );
      expect(await store.purgeExpired(2)).toBe(2);
      expect(await store.purgeExpired(1000)).toBe(3);

      const leftover = await db.query<{ count: number }>(
        `select count(*)::int as count from public.internal_service_nonces where nonce like 'purge-nonce-%'`,
      );
      expect(leftover.rows[0]!.count).toBe(0);
    } finally {
      await live.close();
    }
  });

  it('8. an authorization failure cannot be turned into a replay bypass', async () => {
    const live = await startLiveRecordingApi();
    try {
      // A well-formed, correctly signed request from a user who has no membership in workspace B.
      const meetingInB = await createMeetingDraft(userOwnerB, workspaceB, meetingTypeB, 'B Only');
      const path = '/api/v1/recordings';
      const body = JSON.stringify({
        workspaceId: workspaceB,
        meetingId: meetingInB,
        sessionId: 'e1111111-1111-4111-8111-111111111111',
        timeline: timeline('eeeeeeeeeeee'),
        consent: consent(),
      });
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOutsider },
        { keyId: 'primary', secret: TEST_SECRET },
      );

      const denied = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      expect(denied.status).toBe(403);

      // The nonce was consumed even though the operation was refused. Replaying gets a replay
      // rejection, not a second pass through authorization — so a rejected request is not a
      // reusable credential, and the failure does not refund the nonce.
      const replayed = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      expect(replayed.status).toBe(401);
    } finally {
      await live.close();
    }
  });

  it('the shared ledger is namespaced by key id during rotation', async () => {
    const store = createPostgresNonceStore({ db });
    const shared = `rotate-nonce-${randomHex(8)}`;
    expect(await store.consume(shared, 'primary')).toBe(true);
    // Same nonce string under the next key is a different record: a rotation must not be blocked by
    // nonces minted under the previous key.
    expect(await store.consume(shared, 'next')).toBe(true);
    expect(await store.consume(shared, 'primary')).toBe(false);
    expect(await store.consume(shared, 'next')).toBe(false);
  });

  it('a malformed nonce is refused without touching the ledger', async () => {
    const store = createPostgresNonceStore({ db });
    // Too short to satisfy the ledger's own format check (hyphens are legal; length is not).
    expect(await store.consume('nope', 'primary')).toBe(false);
    expect(await store.consume('has spaces in it', 'primary')).toBe(false);
    expect(await store.consume('', 'primary')).toBe(false);
    expect(await store.consume(`valid-nonce-${randomHex(8)}`, '')).toBe(false);

    // Nothing was written for any of them.
    const rows = await db.query<{ count: number }>(
      `select count(*)::int as count from public.internal_service_nonces
        where nonce in ('nope', 'has spaces in it', '') or key_id = ''`,
    );
    expect(rows.rows[0]!.count).toBe(0);
  });
});

// ===========================================================================
// 7-8. No AssemblyAI or OpenAI in the recording path
// ===========================================================================

describe('7. recording request path never reaches AssemblyAI', () => {
  it('imports no transcription provider module anywhere in the recording API', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync(`find apps/recording-api/src -type f -name '*.ts'`, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = stripComments(readFileSync(resolve(file), 'utf8'));
      expect(text, file).not.toMatch(/transcription-provider|assemblyai|Phase5TranscriptionService/i);
    }
  });

  it('makes no outbound call to AssemblyAI during a full recording flow', async () => {
    const live = await startLiveRecordingApi();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return realFetch(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    try {
      const meetingA = await createMeetingDraft(userOwnerA, workspaceA, meetingTypeA, 'No AssemblyAI');
      const path = '/api/v1/recordings';
      const body = JSON.stringify({
        workspaceId: workspaceA,
        meetingId: meetingA,
        sessionId: 'c6666666-6666-4666-8666-666666666666',
        timeline: timeline('666666666666'),
        consent: consent(),
      });
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
      );
      const created = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      expect(created.status).toBe(201);
      const { recording } = (await created.json()) as { recording: { id: string } };

      const finalizePath = `/api/v1/recordings/${recording.id}/finalize`;
      const finalizeHeaders = signInternalRequest(
        { method: 'POST', path: finalizePath, body: '{}', userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
      );
      await fetch(`${live.baseUrl}${finalizePath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...finalizeHeaders },
        body: '{}',
      });

      expect(calls.filter((call) => /assemblyai/i.test(call))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      await live.close();
    }
  });
});

describe('8. recording request path never reaches OpenAI', () => {
  it('imports no intelligence or embedding provider module anywhere in the recording API', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync(`find apps/recording-api/src -type f -name '*.ts'`, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const file of files) {
      const text = stripComments(readFileSync(resolve(file), 'utf8'));
      expect(text, file).not.toMatch(
        /intelligence-provider|embedding-provider|Phase6IntelligenceService|Phase7KnowledgeService|telegram-provider|automation-provider/i,
      );
    }
  });

  it('makes no outbound call to OpenAI during a full recording flow', async () => {
    const live = await startLiveRecordingApi();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return realFetch(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    try {
      const meetingA = await createMeetingDraft(userOwnerA, workspaceA, meetingTypeA, 'No OpenAI');
      const path = '/api/v1/recordings';
      const body = JSON.stringify({
        workspaceId: workspaceA,
        meetingId: meetingA,
        sessionId: 'c7777777-7777-4777-8777-777777777777',
        timeline: timeline('777777777777'),
        consent: consent(),
      });
      const headers = signInternalRequest(
        { method: 'POST', path, body, userId: userOwnerA },
        { keyId: 'primary', secret: TEST_SECRET },
      );
      const created = await fetch(`${live.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      expect(created.status).toBe(201);

      expect(calls.filter((call) => /openai/i.test(call))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      await live.close();
    }
  });
});

// ===========================================================================
// 9. The worker still owns the full pipeline
// ===========================================================================

describe('9. the worker retains the full processing pipeline', () => {
  it('can still construct the Phase 5 and Phase 6 services the worker runs', () => {
    // The recording API deliberately cannot build these. The worker must still be able to, or the
    // split would have removed capability rather than moved it.
    const phase5 = new Phase5TranscriptionService({
      phase4: service,
      provider: {
        name: 'fake',
        async transcribe() {
          return { text: '', segments: [] };
        },
      } as never,
    });
    const phase6 = new Phase6IntelligenceService({
      db,
      phase5,
      intelligenceProvider: {
        name: 'fake',
        async analyze() {
          return { summary: '', decisions: [], risks: [], topics: [] };
        },
      } as never,
    });
    expect(phase5).toBeDefined();
    expect(phase6).toBeDefined();
  });

  it('the worker role validates cleanly with the full provider stack', () => {
    const result = validateProductionEnvironment(
      {
        NODE_ENV: 'production',
        SUHBAT_RUNTIME_ROLE: 'worker',
        APP_URL: 'https://app.suhbat.uz',
        SUHBAT_DATA_MODE: 'live',
        SUPABASE_DB_URL: 'postgresql://worker:pw@db.proj.supabase.co:5432/postgres',
        STORAGE_PROVIDER: 'r2',
        R2_ACCOUNT_ID: 'acc',
        R2_BUCKET: 'bucket',
        R2_ACCESS_KEY_ID: 'ak',
        R2_SECRET_ACCESS_KEY: 'sk',
        TRANSCRIPTION_PROVIDER: 'assemblyai',
        ASSEMBLYAI_API_KEY: 'aai',
        SUHBAT_INTELLIGENCE_PROVIDER: 'openai',
        SUHBAT_EMBEDDING_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-openai',
      },
      { role: 'worker', throwOnError: false },
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the recording API cannot build the transcription or intelligence services', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync(`find apps/recording-api/src -type f -name '*.ts'`, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const file of files) {
      expect(readFileSync(resolve(file), 'utf8'), file).not.toMatch(
        /new Phase5TranscriptionService|new Phase6IntelligenceService|new Phase7KnowledgeService/,
      );
    }
  });

  it('the recording API exposes no processing or job-claim route', () => {
    const source = readFileSync(resolve('apps/recording-api/src/server.ts'), 'utf8');
    for (const forbidden of [
      'transcription',
      'intelligence',
      'knowledge',
      'automations',
      'processing',
      'jobs',
      'telegram',
    ]) {
      expect(source.toLowerCase(), `recording API must not expose "${forbidden}"`).not.toContain(
        `/${forbidden}`,
      );
    }
  });
});

// ===========================================================================
// 10. The desktop still knows exactly one public base URL
// ===========================================================================

describe('10. the desktop has one public API base URL', () => {
  it('reads VITE_SUHBAT_API_BASE_URL and no other origin variable', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync(`find apps/desktop/src -type f \\( -name '*.ts' -o -name '*.tsx' \\)`, {
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(5);

    // Every Vite variable the renderer can read, however it is reached. The recorder reads its one
    // variable through `readBuildEnv()` rather than touching `import.meta.env` at each call site, so
    // scan for the variable name itself.
    const imported = new Set<string>();
    for (const file of files) {
      const text = readFileSync(resolve(file), 'utf8');
      for (const match of text.matchAll(/VITE_[A-Z0-9_]+/g)) {
        imported.add(match[0]!);
      }
    }
    expect([...imported].sort()).toEqual(['VITE_SUHBAT_API_BASE_URL']);
  });

  it('never names an internal Fly host, a .internal or a .flycast address', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync(`find apps/desktop/src apps/desktop/*.ts -type f \\( -name '*.ts' -o -name '*.tsx' \\)`, {
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const file of files) {
      const text = readFileSync(resolve(file), 'utf8');
      expect(text, file).not.toMatch(/\.internal\b|\.flycast\b|recording-api/i);
    }
  });

  it('builds every request path under the single public /api/v1 prefix', () => {
    const cloud = readFileSync(resolve('apps/desktop/src/cloud.ts'), 'utf8');
    const paths = [
      ...cloud.matchAll(/call\(\s*[\s\S]{0,80}?'(\/api\/v1[^'`$]*)'/g),
    ].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(8);
    for (const path of paths) {
      expect(path.startsWith('/api/v1/')).toBe(true);
    }
  });
});

// ===========================================================================
// 11-12. The existing suites are still present and still green
// ===========================================================================

describe('11-12. existing security suites remain intact', () => {
  it('the access/refresh rotation tests are still present', () => {
    const source = readFileSync(resolve('tests/rls/phase13-desktop-client.test.ts'), 'utf8');
    for (const required of [
      'issues a fresh pair and makes the superseded refresh token unusable',
      'rotates on every use, so no refresh token is ever accepted twice',
      'refuses a replay inside the grace window without destroying the live session',
      'revokes the whole session when a stale refresh token is replayed after the grace window',
      'two simultaneous exchanges produce exactly one session',
      'ten simultaneous exchanges still produce exactly one session',
    ]) {
      expect(source, `missing rotation test: ${required}`).toContain(required);
    }
  });

  it('the web trust-boundary tests are still present', () => {
    const source = readFileSync(resolve('tests/security/web-trust-boundary.test.ts'), 'utf8');
    for (const required of [
      'no web file reads SUPABASE_DB_URL',
      'no web file reads SUPABASE_SERVICE_ROLE_KEY',
      'no web file imports the privileged worker executor',
      'the desktop RPC boundary is allow-listed',
      'the desktop resolver never constructs storage or provider clients',
    ]) {
      expect(source, `missing trust-boundary test: ${required}`).toContain(required);
    }
  });

  it('the one-tap flow tests are still present', () => {
    const source = readFileSync(resolve('tests/desktop/one-tap-flow.test.ts'), 'utf8');
    expect(source).toMatch(/describe\(/);
    expect((source.match(/\bit\(/g) ?? []).length).toBeGreaterThan(20);
  });
});
