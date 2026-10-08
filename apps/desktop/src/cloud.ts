/**
 * The one and only network module in the renderer.
 *
 * Why it is isolated
 * ------------------
 * `tests/desktop/cloud-boundary.test.ts` fails the build if any other renderer file calls `fetch`,
 * builds an absolute URL, imports a Supabase client, or reads a provider-shaped environment variable.
 * That is what makes the guarantee "the renderer cannot leak a secret it never holds" checkable
 * rather than aspirational: there is exactly one file to audit, and it holds an opaque user-issued
 * session token and nothing else.
 *
 * What this module must never contain
 * -----------------------------------
 * * An OpenAI, AssemblyAI, R2, or Supabase service-role credential. Those live only on the server and
 *   in the worker. Uploads go to a *short-lived signed URL the server hands us*, and that URL never
 *   leaves this function.
 * * A fabricated state. Every value returned here is parsed with the shared Zod contract first; a
 *   response that does not match is a `contract_violation` error, never a silently coerced object.
 */

import {
  type ChunkUploadAuthorizationDto,
  type CreateMeetingRequestInput,
  type CreateMeetingResponse,
  type CreateRecordingRequestInput,
  type DesktopConnectCodeResponse,
  type DesktopSessionInfoResponse,
  type DesktopSessionResponse,
  type DesktopWorkspaceListResponse,
  type FinalizeRecordingRequestInput,
  type FinalizeRecordingResponse,
  type MeetingProcessingResponse,
  type RecordingChunkDto,
  type RecordingDetailResponse,
  type RecordingDto,
  type RecordingSourceDto,
  type RegisterRecordingChunkRequestInput,
  type RegisterRecordingSourceRequestInput,
  type VerifyChunkUploadResponse,
  createMeetingResponseSchema,
  createRecordingRequestSchema,
  desktopConnectCodeResponseSchema,
  desktopSessionInfoResponseSchema,
  desktopSessionResponseSchema,
  desktopWorkspaceListResponseSchema,
  finalizeRecordingRequestSchema,
  finalizeRecordingResponseSchema,
  meetingProcessingResponseSchema,
  recordingChunkDtoSchema,
  recordingDetailResponseSchema,
  recordingDtoSchema,
  recordingSourceDtoSchema,
  registerRecordingChunkRequestSchema,
  registerRecordingSourceRequestSchema,
  verifyChunkUploadResponseSchema,
} from '@suhbat/contracts';
import { z } from 'zod';

export type CloudErrorCode =
  | 'not_configured'
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'contract_violation';

export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: CloudErrorCode, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class CloudContractError extends CloudError {
  constructor(what: string, cause: unknown) {
    super(
      'contract_violation',
      `${what} did not match the shared contract: ${cause instanceof Error ? cause.message : String(cause)}`,
      null,
      false,
    );
    this.name = 'CloudContractError';
  }
}

export type CloudTokenProvider = () => string | null;

export type CloudClientOptions = {
  /** HTTPS origin of the SUHBAT web app, e.g. `https://app.suhbat.uz`. No default, ever. */
  baseUrl: string;
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  tokenProvider: CloudTokenProvider;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

/** Status codes that mean "try the exact same request again later and it may work". */
function codeForStatus(status: number): CloudErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413 || status === 422) return 'validation_failed';
  return 'server_error';
}

function retryableFor(code: CloudErrorCode, status: number): boolean {
  if (code === 'unauthorized' || code === 'validation_failed' || code === 'not_found') return false;
  if (code === 'conflict') return false;
  return status >= 500 || status === 429;
}

export type CloudClient = Awaited<ReturnType<typeof createCloudClient>>;

export function createCloudClient(options: CloudClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    what: string,
    path: string,
    init: RequestInit & { schema: z.ZodType<T>; timeoutMs?: number; authenticated?: boolean },
  ): Promise<T> {
    const { schema, timeoutMs: callTimeout, authenticated = true, ...request } = init;
    const headers = new Headers(request.headers);
    headers.set('accept', 'application/json');
    if (request.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const token = options.tokenProvider();
    if (authenticated) {
      if (!token) {
        throw new CloudError('unauthorized', 'No desktop session is active.', null, false);
      }
      headers.set('authorization', `Bearer ${token}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeout ?? timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { ...request, headers, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new CloudError('timeout', `${what} timed out.`, null, true);
      }
      // No network at all. This is an expected state while recording offline, not an exception to
      // surface as a failure: the caller keeps the recording locally and retries later.
      throw new CloudError(
        'offline',
        cause instanceof Error ? cause.message : `${what} could not reach the server.`,
        null,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      const code = codeForStatus(response.status);
      throw new CloudError(code, messageFromErrorBody(text) ?? `${what} failed.`, response.status, retryableFor(code, response.status));
    }
    if (!text.trim()) {
      throw new CloudError('server_error', `${what} returned an empty response.`, response.status, true);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CloudError('server_error', `${what} returned a response that was not JSON.`, response.status, true);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CloudContractError(what, parsed.error);
    return parsed.data;
  }

  return {
    /** `POST /api/v1/desktop/connect-codes`. Unauthenticated: this is how a session begins. */
    createConnectCode: (clientLabel?: string) =>
      call('connect code', '/api/v1/desktop/connect-codes', {
        method: 'POST',
        body: JSON.stringify(clientLabel ? { clientLabel } : {}),
        schema: desktopConnectCodeResponseSchema,
        authenticated: false,
      }) as Promise<DesktopConnectCodeResponse>,

    /** `GET /api/v1/desktop/connect-codes` — is my code approved yet? */
    connectCodeStatus: (code: string) =>
      call('connect code status', '/api/v1/desktop/connect-codes', {
        method: 'GET',
        headers: { 'x-suhbat-connect-code': code },
        schema: z.object({
          status: z.enum(['pending', 'authorized', 'consumed']),
          pollIntervalMs: z.number().int().nonnegative(),
        }),
        authenticated: false,
      }),

    /** `POST /api/v1/desktop/sessions` — trade an approved code for a bearer session. */
    exchangeConnectCode: (code: string, clientLabel?: string) =>
      call('desktop session', '/api/v1/desktop/sessions', {
        method: 'POST',
        body: JSON.stringify(clientLabel ? { code, clientLabel } : { code }),
        schema: desktopSessionResponseSchema,
        authenticated: false,
      }) as Promise<DesktopSessionResponse>,

    describeSession: () =>
      call('session', '/api/v1/desktop/session', {
        method: 'GET',
        schema: desktopSessionInfoResponseSchema,
      }) as Promise<DesktopSessionInfoResponse>,

    revokeSession: () =>
      call('sign out', '/api/v1/desktop/session', {
        method: 'DELETE',
        schema: z.object({ revoked: z.literal(true), hadSession: z.boolean().optional() }),
      }),

    rememberWorkspace: (workspaceId: string) =>
      call('workspace selection', '/api/v1/desktop/session/workspace', {
        method: 'POST',
        body: JSON.stringify({ workspaceId }),
        schema: z.object({ ok: z.literal(true) }),
      }),

    /** `GET /api/v1/workspaces` — refresh the switcher; membership is re-read server-side. */
    listWorkspaces: () =>
      call('workspace list', '/api/v1/workspaces', {
        method: 'GET',
        schema: desktopWorkspaceListResponseSchema,
      }).then((value) => value.workspaces) as Promise<DesktopWorkspaceListResponse['workspaces']>,

    /** `POST /api/v1/meetings` — automatic meeting context; nothing here is required but the workspace. */
    createMeeting: (input: CreateMeetingRequestInput) =>
      call('meeting', '/api/v1/meetings', {
        method: 'POST',
        body: JSON.stringify(input),
        schema: createMeetingResponseSchema,
      }) as Promise<CreateMeetingResponse>,

    getMeetingProcessing: (meetingId: string, workspaceId?: string) =>
      call('processing state', `/api/v1/meetings/${meetingId}/processing${workspaceId ? `?workspaceId=${workspaceId}` : ''}`, {
        method: 'GET',
        schema: meetingProcessingResponseSchema,
      }) as Promise<MeetingProcessingResponse>,

    createRecording: (input: CreateRecordingRequestInput) =>
      call('recording', '/api/v1/recordings', {
        method: 'POST',
        body: JSON.stringify(createRecordingRequestSchema.parse(input)),
        schema: z.object({ recording: recordingDtoSchema, idempotentReused: z.boolean() }),
      }) as Promise<{ recording: RecordingDto; idempotentReused: boolean }>,

    registerSource: (recordingId: string, input: RegisterRecordingSourceRequestInput) =>
      call('recording source', `/api/v1/recordings/${recordingId}/sources`, {
        method: 'POST',
        body: JSON.stringify(registerRecordingSourceRequestSchema.parse(input)),
        schema: z.object({ source: recordingSourceDtoSchema, idempotentReused: z.boolean() }),
      }) as Promise<{ source: RecordingSourceDto; idempotentReused: boolean }>,

    registerChunk: (recordingId: string, input: RegisterRecordingChunkRequestInput) =>
      call('chunk', `/api/v1/recordings/${recordingId}/chunks`, {
        method: 'POST',
        body: JSON.stringify(registerRecordingChunkRequestSchema.parse(input)),
        schema: z.object({ chunk: recordingChunkDtoSchema, idempotentReused: z.boolean() }),
      }) as Promise<{ chunk: RecordingChunkDto; idempotentReused: boolean }>,

    authorizeChunkUpload: (recordingId: string, chunkId: string) =>
      call('upload authorization', `/api/v1/recordings/${recordingId}/chunks/${chunkId}/upload`, {
        method: 'POST',
        body: JSON.stringify({}),
        schema: z.object({
          authorization: z.custom<ChunkUploadAuthorizationDto>(),
        }),
      }).then((value) => value.authorization) as Promise<ChunkUploadAuthorizationDto>,

    verifyChunkUpload: (recordingId: string, chunkId: string) =>
      call('chunk verification', `/api/v1/recordings/${recordingId}/chunks/${chunkId}/verify`, {
        method: 'POST',
        body: JSON.stringify({}),
        schema: verifyChunkUploadResponseSchema,
      }) as Promise<VerifyChunkUploadResponse>,

    finalizeRecording: (recordingId: string, input: FinalizeRecordingRequestInput) =>
      call('recording finalization', `/api/v1/recordings/${recordingId}/finalize`, {
        method: 'POST',
        body: JSON.stringify(finalizeRecordingRequestSchema.parse(input)),
        schema: finalizeRecordingResponseSchema,
      }) as Promise<FinalizeRecordingResponse>,

    getRecording: (recordingId: string) =>
      call('recording', `/api/v1/recordings/${recordingId}`, {
        method: 'GET',
        schema: recordingDetailResponseSchema,
      }) as Promise<RecordingDetailResponse>,

    /**
     * Puts chunk bytes straight at the signed URL the server issued.
     *
     * Deliberately the only request that does not go through `call`: the target is a storage host, not
     * our API, so it must not carry the session token. A signed URL is a bearer capability — sending
     * our long-lived session to a storage endpoint would leak it into that host's logs.
     */
    uploadChunkBytes: async (authorization: ChunkUploadAuthorizationDto, bytes: Uint8Array): Promise<void> => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(authorization.headers)) {
        headers.set(name, value);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(authorization.uploadUrl, {
          method: authorization.method,
          headers,
          body: bytes as unknown as BodyInit,
          signal: controller.signal,
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'AbortError') {
          throw new CloudError('timeout', 'The audio upload timed out.', null, true);
        }
        throw new CloudError(
          'offline',
          cause instanceof Error ? cause.message : 'The audio upload could not reach storage.',
          null,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // 403 from a signed URL almost always means it expired in flight; the caller re-authorizes.
        const code: CloudErrorCode = response.status === 403 || response.status === 401 ? 'unauthorized' : 'server_error';
        throw new CloudError(code, `Storage rejected the upload (${response.status}).`, response.status, true);
      }
    },
  };
}

function messageFromErrorBody(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

/**
 * Reads the API origin from the build environment.
 *
 * There is no fallback URL on purpose. A baked-in default would silently send someone's meeting audio
 * to whoever happened to own that domain, so an unconfigured build reports `not_configured` and the
 * recorder stays local rather than guessing.
 */
/** Hosts a plain-HTTP origin is tolerated on: local development against the Next.js dev server. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'] as const;

export function cloudBaseUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.VITE_SUHBAT_API_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return `${url.protocol}//${url.host}`;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname as (typeof LOOPBACK_HOSTS)[number])) {
    return `${url.protocol}//${url.host}`;
  }
  return null;
}

/**
 * Reads the Vite build environment without pulling in `vite/client` types.
 *
 * The renderer is only ever allowed to read this one variable, and `cloudBaseUrl` refuses any value
 * that is not an explicit HTTPS origin (or loopback for development), so a mistyped or hostile value
 * degrades to "not configured" instead of silently pointing the recorder at the wrong server.
 */
export function readBuildEnv(): Record<string, string | undefined> {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return { VITE_SUHBAT_API_BASE_URL: meta.env?.VITE_SUHBAT_API_BASE_URL };
}

/** The URL a user opens to approve a pairing code. Derived from the API origin, never hardcoded. */
export function connectApprovalUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/desktop/connect`;
}
