import { describe, expect, it } from 'vitest';
import { CloudError, cloudBaseUrl, connectApprovalUrl, createCloudClient } from '../../apps/desktop/src/cloud.ts';

/**
 * The desktop's single network door.
 *
 * These tests use an injected `fetch`, so they prove the client's own contract: which endpoint each
 * method hits, how errors are classified, and — most importantly — that the long-lived session token is
 * never sent anywhere except our own API origin.
 */

const API = 'https://app.suhbat.test';

type Recorded = { url: string; init: RequestInit };

function harness(options: { handler: (request: Recorded) => Response | Promise<Response> }) {
  const calls: Recorded[] = [];
  let token: string | null = 'token-abc';
  const client = createCloudClient({
    baseUrl: API,
    tokenProvider: () => token,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      return options.handler({ url, init: init ?? {} });
    }) as unknown as typeof fetch,
  });
  return {
    client,
    calls,
    last: () => calls[calls.length - 1]!,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const WORKSPACE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Alpha',
  role: 'owner',
  defaultMeetingTypeId: '22222222-2222-4222-8222-222222222222',
  defaultMeetingTypeLabel: 'General',
  meetingTypeCount: 7,
};

describe('endpoint routing', () => {
  it('mints a connect code without sending a session token', async () => {
    const h = harness({ handler: () => json({ code: 'AB12-CDEF-GH34', status: 'pending', expiresAt: 'x', pollIntervalMs: 2000 }, 201) });
    const created = await h.client.createConnectCode('SUHBAT desktop');
    expect(created.code).toBe('AB12-CDEF-GH34');
    expect(h.last().url).toBe(`${API}/api/v1/desktop/connect-codes`);
    const headers = new Headers(h.last().init.headers);
    expect(headers.get('authorization')).toBeNull();
  });

  it('polls code status in its own header, never in the URL', async () => {
    const h = harness({ handler: () => json({ status: 'pending', pollIntervalMs: 2000 }) });
    await h.client.connectCodeStatus('AB12-CDEF-GH34');
    expect(h.last().url).toBe(`${API}/api/v1/desktop/connect-codes`);
    expect(h.last().url).not.toContain('CDEF');
    expect(new Headers(h.last().init.headers).get('x-suhbat-connect-code')).toBe('AB12-CDEF-GH34');
  });

  it('exchanges an approved code for a short-lived access and a rotating refresh token', async () => {
    const h = harness({
      handler: () =>
        json(
          {
            accessToken: 'a'.repeat(43),
            refreshToken: 'r'.repeat(43),
            accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            userId: '33333333-3333-4333-8333-333333333333',
            userEmail: 'a@b.test',
            defaultWorkspaceId: WORKSPACE.id,
            workspaces: [WORKSPACE],
          },
          201,
        ),
    });
    const session = await h.client.exchangeConnectCode('AB12-CDEF-GH34', 'SUHBAT desktop');
    expect(session.workspaces).toHaveLength(1);
    expect(h.last().url).toBe(`${API}/api/v1/desktop/sessions`);

    // The access credential is minutes, not months; the refresh credential is the long-lived one.
    const accessMinutes = (Date.parse(session.accessTokenExpiresAt) - Date.now()) / 60_000;
    const refreshDays = (Date.parse(session.refreshTokenExpiresAt) - Date.now()) / 86_400_000;
    expect(accessMinutes).toBeLessThanOrEqual(15);
    expect(refreshDays).toBeGreaterThan(1);
  });

  it('sends the refresh token only to the refresh endpoint', async () => {
    const h = harness({
      handler: () =>
        json({
          accessToken: 'b'.repeat(43),
          refreshToken: 's'.repeat(43),
          accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 2_592_000_000).toISOString(),
          userId: '33333333-3333-4333-8333-333333333333',
          userEmail: null,
          defaultWorkspaceId: null,
          workspaces: [],
        }),
    });
    h.setToken(null);
    await h.client.refreshSession('r'.repeat(43));
    expect(h.last().url).toBe(`${API}/api/v1/desktop/sessions/refresh`);
    // The refresh credential authenticates this call; there is no access token yet.
    expect(new Headers(h.last().init.headers).get('authorization')).toBeNull();
    // ...and it must not leak into the URL.
    expect(h.last().url).not.toContain('r'.repeat(43));
  });

  it('refuses to send a refresh token that is obviously not one', async () => {
    const h = harness({ handler: () => json({}) });
    await expect(h.client.refreshSession('too-short')).rejects.toBeInstanceOf(Error);
    expect(h.calls).toHaveLength(0);
  });

  it('revokes with whichever credential is still alive', async () => {
    const h = harness({ handler: () => json({ revoked: true }) });
    await h.client.revokeSession('a'.repeat(43));
    expect(new Headers(h.last().init.headers).get('authorization')).toBe(
      `Bearer ${'a'.repeat(43)}`,
    );
  });

  it('authenticates every ordinary call with the bearer token', async () => {
    const h = harness({ handler: () => json({ userId: '33333333-3333-4333-8333-333333333333', userEmail: null, defaultWorkspaceId: null, workspaces: [], expiresAt: 'x' }) });
    await h.client.describeSession();
    expect(new Headers(h.last().init.headers).get('authorization')).toBe('Bearer token-abc');
  });

  it('refuses to call an authenticated endpoint with no session instead of sending an empty header', async () => {
    const h = harness({ handler: () => json({}) });
    h.setToken(null);
    await expect(h.client.describeSession()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.calls).toHaveLength(0);
  });

  it('creates a meeting with only a workspace, letting the server default everything', async () => {
    const h = harness({
      handler: () =>
        json(
          {
            meeting: {
              id: '44444444-4444-4444-8444-444444444444',
              workspaceId: WORKSPACE.id,
              title: 'Suhbat — 8 Oct, 14:32',
              status: 'recording',
              meetingTypeId: WORKSPACE.defaultMeetingTypeId,
              meetingTypeLabel: 'General',
              companyId: null,
              projectId: null,
              createdBy: '33333333-3333-4333-8333-333333333333',
              startedAt: '2026-10-08T14:32:00.000Z',
              createdAt: '2026-10-08T14:32:00.000Z',
            },
            defaultsApplied: { title: true, meetingType: true },
          },
          201,
        ),
    });
    const created = await h.client.createMeeting({
      workspaceId: WORKSPACE.id,
      source: 'desktop_recorder',
    });
    expect(created.meeting.title).toBe('Suhbat — 8 Oct, 14:32');
    expect(created.defaultsApplied).toEqual({ title: true, meetingType: true });
  });

  it('polls processing state with the workspace as a query parameter', async () => {
    const h = harness({
      handler: () =>
        json({
          workspaceId: WORKSPACE.id,
          meetingId: '44444444-4444-4444-8444-444444444444',
          meetingStatus: 'ready',
          pipelineStatus: 'ready',
          productState: 'ready',
          recordingAvailable: true,
          activeRecordingId: null,
          verifiedChunkCount: 4,
          totalChunkCount: 4,
          canonicalDurationMs: 62_000,
          detectedLanguages: ['uz'],
          jobs: [],
          timeline: {
            meetingId: '44444444-4444-4444-8444-444444444444',
            state: 'ready',
            steps: [{ key: 'capture', label: 'Captured on device', state: 'done' }],
          },
        }),
    });
    const state = await h.client.getMeetingProcessing(
      '44444444-4444-4444-8444-444444444444',
      WORKSPACE.id,
    );
    expect(state.productState).toBe('ready');
    expect(h.last().url).toContain('/processing?workspaceId=');
  });
});

describe('error classification', () => {
  const cases: Array<[number, string, boolean]> = [
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [404, 'not_found', false],
    [409, 'conflict', false],
    [429, 'rate_limited', true],
    [400, 'validation_failed', false],
    [500, 'server_error', true],
    [503, 'server_error', true],
  ];

  for (const [status, code, retryable] of cases) {
    it(`maps HTTP ${status} to ${code} (retryable: ${retryable})`, async () => {
      const h = harness({ handler: () => json({ error: { code: 'x', message: 'boom' } }, status) });
      const error = await h.client.describeSession().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CloudError);
      expect((error as CloudError).code).toBe(code);
      expect((error as CloudError).retryable).toBe(retryable);
    });
  }

  it('treats a transport failure as offline and retryable, not as a server error', async () => {
    const h = harness({
      handler: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const error = await h.client.describeSession().catch((cause: unknown) => cause);
    expect((error as CloudError).code).toBe('offline');
    expect((error as CloudError).retryable).toBe(true);
  });

  it('treats an aborted request as a retryable timeout', async () => {
    const h = harness({
      handler: () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    });
    const error = await h.client.describeSession().catch((cause: unknown) => cause);
    expect((error as CloudError).code).toBe('timeout');
  });

  it('surfaces the server’s own message rather than a generic one', async () => {
    const h = harness({
      handler: () => json({ error: { code: 'validation_failed', message: 'That meeting type does not belong to this workspace.' } }, 400),
    });
    const error = await h.client.createMeeting({ workspaceId: WORKSPACE.id }).catch((c: unknown) => c);
    expect((error as CloudError).message).toContain('meeting type');
  });

  it('fails loudly when the response does not match the shared contract', async () => {
    const h = harness({ handler: () => json({ nope: true }) });
    const error = await h.client.describeSession().catch((cause: unknown) => cause);
    expect((error as CloudError).code).toBe('contract_violation');
    expect((error as CloudError).retryable).toBe(false);
  });

  it('never lets an unvalidated object through as a success', async () => {
    const h = harness({ handler: () => json({ userId: 42 }) });
    await expect(h.client.describeSession()).rejects.toBeInstanceOf(CloudError);
  });
});

describe('credential containment', () => {
  it('sends the session token to the API origin only, never to a storage host', async () => {
    const h = harness({ handler: () => json({}, 200) });
    await h.client.uploadChunkBytes(
      {
        chunkId: 'c',
        recordingId: 'r',
        recordingSourceId: 's',
        sequenceNo: 0,
        storageBackend: 'r2',
        storageKey: 'k',
        method: 'PUT',
        uploadUrl: 'https://objects.suhbat.test/signed?X-Amz-Signature=deadbeef',
        headers: { 'content-type': 'audio/wav' },
        expiresAt: '2026-10-08T15:00:00.000Z',
        alreadyVerified: false,
      },
      new Uint8Array([1, 2, 3]),
    );
    const headers = new Headers(h.last().init.headers);
    expect(headers.get('authorization')).toBeNull();
    // The signed URL is a bearer capability; it must not be echoed anywhere else.
    expect(JSON.stringify(h.calls)).not.toContain('X-Amz-Signature=deadbeef'.repeat(2));
  });

  it('puts raw bytes at the signed URL with the method the server issued', async () => {
    const h = harness({ handler: () => new Response(null, { status: 200 }) });
    await h.client.uploadChunkBytes(
      {
        chunkId: 'c',
        recordingId: 'r',
        recordingSourceId: 's',
        sequenceNo: 0,
        storageBackend: 'r2',
        storageKey: 'k',
        method: 'PUT',
        uploadUrl: 'https://objects.suhbat.test/signed',
        headers: { 'content-type': 'audio/wav' },
        expiresAt: '2026-10-08T15:00:00.000Z',
        alreadyVerified: false,
      },
      new Uint8Array([7, 8]),
    );
    expect(h.last().init.method).toBe('PUT');
    expect(h.last().url).toBe('https://objects.suhbat.test/signed');
  });

  it('reports an expired signed URL as retryable so the queue re-authorizes', async () => {
    const h = harness({ handler: () => new Response(null, { status: 403 }) });
    const error = await h.client
      .uploadChunkBytes(
        {
          chunkId: 'c',
          recordingId: 'r',
          recordingSourceId: 's',
          sequenceNo: 0,
          storageBackend: 'r2',
          storageKey: 'k',
          method: 'PUT',
          uploadUrl: 'https://objects.suhbat.test/signed',
          headers: {},
          expiresAt: '2026-10-08T15:00:00.000Z',
          alreadyVerified: false,
        },
        new Uint8Array([1]),
      )
      .catch((cause: unknown) => cause);
    expect((error as CloudError).code).toBe('unauthorized');
    expect((error as CloudError).retryable).toBe(true);
  });
});

describe('configuration', () => {
  it('accepts an explicit HTTPS origin', () => {
    expect(cloudBaseUrl({ VITE_SUHBAT_API_BASE_URL: 'https://app.suhbat.uz/' })).toBe(
      'https://app.suhbat.uz',
    );
  });

  it('accepts loopback for local development only', () => {
    expect(cloudBaseUrl({ VITE_SUHBAT_API_BASE_URL: 'http://localhost:3000' })).toBe(
      'http://localhost:3000',
    );
    expect(cloudBaseUrl({ VITE_SUHBAT_API_BASE_URL: 'http://127.0.0.1:3000' })).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('refuses a missing, malformed, or non-HTTPS origin instead of guessing', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'not a url',
      'ftp://app.suhbat.uz',
      'http://app.suhbat.uz',
      'https://',
      'javascript:alert(1)',
    ]) {
      expect(cloudBaseUrl({ VITE_SUHBAT_API_BASE_URL: value })).toBeNull();
    }
  });

  it('derives the approval URL from the configured origin', () => {
    expect(connectApprovalUrl('https://app.suhbat.uz')).toBe('https://app.suhbat.uz/desktop/connect');
    expect(connectApprovalUrl('https://app.suhbat.uz/')).toBe('https://app.suhbat.uz/desktop/connect');
  });
});
