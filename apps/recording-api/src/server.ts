import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  Phase4BackboneService,
  Phase4ServiceError,
  type AuthenticatedPrincipal,
  type SqlExecutor,
} from '@suhbat/database/phase4';
import type { StorageProvider } from '@suhbat/database/storage';
import {
  readInternalSigningKeys,
  verifyInternalRequest,
  type DurableNonceStore,
} from '@suhbat/database/internal-service-auth';
import { createServiceNonceStore } from '@suhbat/database/internal-service-nonce-store';
import {
  assertAuthorizedRecording,
  assertMeetingInWorkspace,
  assertActiveWorkspaceMembership,
} from './authorization';

/**
 * The privileged Recording API.
 *
 * ## What this service is
 *
 * A private HTTP process that owns the minimum set of Phase 4 operations the desktop recorder
 * needs: register a recording, attach sources and chunks, hand out a signed upload URL, verify the
 * upload landed, and finalize. Nothing else.
 *
 * It is privileged — it holds `SUPABASE_DB_URL` and issues statements RLS does not constrain — and
 * that is exactly why it is small and why it is not public. It has no dashboard, no processing
 * provider, and no worker loop. It answers one caller: the Web gateway, over a signature only those
 * two services can produce.
 *
 * ## What it deliberately does not do
 *
 * - It never runs the background queue, and never calls AssemblyAI or OpenAI. Transcription and
 *   intelligence belong to the worker; importing them here would put provider credentials in the
 *   request path for no reason.
 * - It never exposes a generic database or admin surface. There is no "run this query" route and no
 *   route that accepts a workspace id without proving membership against the database first.
 * - It never derives identity from a client header. The only identity input is the signed user id,
 *   and even that is re-checked against `workspace_members` before anything is written.
 */

export type RecordingApiOptions = {
  service: Phase4BackboneService;
  /**
   * Replay ledger. Defaults to the durable PostgreSQL store backed by `service.db`, which is what
   * makes replay protection hold across machines.
   *
   * Pass `{ backend: 'memory' }` only for a single-process deployment, where there is no second
   * machine to replay against and PostgreSQL would be pure overhead.
   */
  nonceStore?: DurableNonceStore | { backend: 'memory' };
  /** Overridable so tests can pin the clock. */
  now?: () => number;
  /** Structured, redacted logging. Defaults to a no-op so nothing sensitive is written by accident. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Mounted path prefix, if the service is served behind a proxy that rewrites paths. */
  signingSecrets?: ReadonlyArray<{ keyId: string; secret: string }>;
};

export type RecordingApi = {
  /** Handles one request. Returns the status code. Safe to call from tests without a socket. */
  handle(request: RecordingApiRequest): Promise<RecordingApiResponse>;
  /** The executor this service writes through, exposed so the host can close it on shutdown. */
  readonly db: SqlExecutor;
};

export type RecordingApiRequest = {
  method: string;
  /** Path including query string, exactly as the caller signed it. */
  path: string;
  headers: { get(name: string): string | null };
  body: string;
};

export type RecordingApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Route table. Each entry maps a method + path template to one Phase 4 operation. */
type Route = {
  method: 'GET' | 'POST' | 'DELETE';
  pattern: RegExp;
  handler: (context: RouteContext, params: string[]) => Promise<unknown>;
  /** Status returned on success; handlers may override (201 vs 200, 409 for an unfinished finalize). */
  status: number;
};

type RouteContext = {
  principal: AuthenticatedPrincipal;
  service: Phase4BackboneService;
  db: SqlExecutor;
  body: () => unknown;
  query: URLSearchParams;
};

function json(value: unknown, status = 200): never {
  throw new HttpResult(status, JSON.stringify(value));
}

class HttpResult extends Error {
  constructor(
    readonly status: number,
    readonly payload: string,
  ) {
    super('http result');
    this.name = 'HttpResult';
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ROUTES: Route[] = [
  {
    method: 'POST',
    pattern: /^\/api\/v1\/recordings$/,
    status: 201,
    handler: async (context) => {
      const input = context.body() as { workspaceId?: string; meetingId?: string };
      const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId : '';
      const meetingId = typeof input?.meetingId === 'string' ? input.meetingId : '';
      // The client's workspaceId and meetingId are claims, not facts. Prove both before writing.
      await assertActiveWorkspaceMembership(context.db, context.principal.userId, workspaceId);
      await assertMeetingInWorkspace(context.db, context.principal.userId, workspaceId, meetingId);
      const result = await context.service.createRecording(context.principal, context.body() as never);
      return json(result, result.idempotentReused ? 200 : 201);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v1\/recordings\/([^/]+)$/,
    status: 200,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
        context.query.get('workspaceId') ?? undefined,
      );
      // Pass the workspace we derived, so the service cross-checks against the same value.
      return json(
        await context.service.getRecording(
          context.principal,
          target.recordingId,
          target.workspaceId,
        ),
        200,
      );
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/v1\/recordings\/([^/]+)$/,
    status: 200,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
        context.query.get('workspaceId') ?? undefined,
      );
      const result = await context.service.deleteRecording(
        context.principal,
        target.recordingId,
        target.workspaceId,
      );
      return json(result, result.status === 'deleted' ? 200 : 202);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/recordings\/([^/]+)\/sources$/,
    status: 201,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
      );
      const result = await context.service.registerSource(
        context.principal,
        target.recordingId,
        context.body() as never,
      );
      return json(result, result.idempotentReused ? 200 : 201);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/recordings\/([^/]+)\/chunks$/,
    status: 201,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
      );
      const result = await context.service.registerChunk(
        context.principal,
        target.recordingId,
        context.body() as never,
      );
      return json(result, result.idempotentReused ? 200 : 201);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/recordings\/([^/]+)\/chunks\/([^/]+)\/upload$/,
    status: 200,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
      );
      return json(
        await context.service.authorizeChunkUpload(
          context.principal,
          target.recordingId,
          decode(params[1]!),
          context.body() as never,
        ),
        200,
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/recordings\/([^/]+)\/chunks\/([^/]+)\/verify$/,
    status: 200,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
      );
      const result = await context.service.verifyChunkUpload(
        context.principal,
        target.recordingId,
        decode(params[1]!),
        context.body() as never,
      );
      return json(result, result.verified ? 200 : 422);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/recordings\/([^/]+)\/finalize$/,
    status: 200,
    handler: async (context, params) => {
      const target = await assertAuthorizedRecording(
        context.db,
        context.principal.userId,
        decode(params[0]!),
      );
      const result = await context.service.finalizeRecording(
        context.principal,
        target.recordingId,
        context.body() as never,
      );
      return json(result, result.status === 'finalized' ? 200 : 409);
    },
  },
];

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export function createRecordingApi(options: RecordingApiOptions): RecordingApi {
  const service = options.service;
  const db = service.db;
  const nonceStore = options.nonceStore
    ? options.nonceStore.backend === 'memory'
      ? createServiceNonceStore({ backend: 'memory' })
      : options.nonceStore
    : createServiceNonceStore({
        db,
        // Twice the clock skew: a nonce must stay on record for as long as its request could still
        // arrive and be considered fresh.
        onError: () => onEvent({ event: 'recording_api.nonce_store_error' }),
      });
  const keys = options.signingSecrets ?? readInternalSigningKeys(process.env);
  const onEvent = options.onEvent ?? (() => {});

  if (keys.length === 0) {
    // Fail at construction, not on the first request. A recording service that cannot authenticate
    // its caller must never start accepting traffic.
    throw new Error(
      'Recording API requires SUHBAT_INTERNAL_API_SECRET (or SUHBAT_INTERNAL_API_SECRETS). ' +
        'Without it the service cannot tell the Web gateway from an attacker.',
    );
  }

  function log(event: Record<string, unknown>): void {
    // Never includes headers, bodies, or identifiers beyond a route name and outcome.
    onEvent(event);
  }

  async function handle(request: RecordingApiRequest): Promise<RecordingApiResponse> {
    const pathname = request.path.split('?')[0] ?? '/';
    const query = new URLSearchParams(request.path.includes('?') ? request.path.split('?')[1] : '');

    //
    // 1. Authenticate the *service* call before anything else.
    //
    // This runs before routing, so an unauthenticated request cannot learn which paths exist: every
    // rejected request gets the same 401 regardless of whether the route is real.
    //
    const verification = await verifyInternalRequest({
      method: request.method,
      path: request.path,
      body: request.body,
      headers: request.headers,
      keys,
      nonceStore,
      ...(options.now ? { now: options.now() } : {}),
    });

    if (!verification.ok) {
      log({ event: 'recording_api.rejected', reason: verification.code, route: pathname });
      return {
        status: 401,
        headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
        body: JSON.stringify({
          error: { code: 'unauthorized', message: 'Internal service authentication failed.' },
        }),
      };
    }

    const principal: AuthenticatedPrincipal = { userId: verification.userId };

    try {
      const route = matchRoute(request.method, pathname);
      if (!route) {
        return notFound();
      }

      let parsedBody: unknown;
      const context: RouteContext = {
        principal,
        service,
        db,
        query,
        body: () => {
          if (parsedBody === undefined) {
            if (!request.body.trim()) {
              parsedBody = {};
            } else {
              try {
                parsedBody = JSON.parse(request.body) as unknown;
              } catch {
                throw new Phase4ServiceError(400, 'validation_failed', 'Malformed JSON request body.');
              }
            }
          }
          return parsedBody;
        },
      };

      await route.handler(context, extractParams(route.pattern, pathname));
      // Handlers always return via json(), which throws HttpResult. Reaching here is a bug.
      throw new Phase4ServiceError(500, 'internal_error', 'Route produced no response.');
    } catch (cause) {
      if (cause instanceof HttpResult) {
        return {
          status: cause.status,
          headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
          body: cause.payload,
        };
      }
      if (cause instanceof Phase4ServiceError) {
        log({ event: 'recording_api.error', code: cause.code, status: cause.statusCode, route: pathname });
        return {
          status: cause.statusCode,
          headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
          body: JSON.stringify({
            error: {
              code: cause.code,
              message: cause.message,
              ...(cause.detail ? { detail: cause.detail } : {}),
            },
          }),
        };
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      log({ event: 'recording_api.unexpected', route: pathname });
      return {
        status: 500,
        headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
        body: JSON.stringify({
          error: {
            code: 'internal_error',
            message: 'An unexpected server error occurred.',
            ...(process.env.NODE_ENV === 'production' ? {} : { detail }),
          },
        }),
      };
    }
  }

  return { handle, db };
}

function matchRoute(method: string, pathname: string): Route | null {
  const upper = method.toUpperCase();
  for (const route of ROUTES) {
    if (route.method !== upper) continue;
    if (route.pattern.test(pathname)) return route;
  }
  return null;
}

function extractParams(pattern: RegExp, pathname: string): string[] {
  const match = pattern.exec(pathname);
  return match ? match.slice(1) : [];
}

function notFound(): RecordingApiResponse {
  return {
    status: 404,
    headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
    body: JSON.stringify({ error: { code: 'not_found', message: 'Route was not found.' } }),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap helpers
// ---------------------------------------------------------------------------

/** Builds the service from the environment. Used by `index.ts`; tests inject instead. */
export async function createRecordingApiFromEnv(env: Record<string, string | undefined> = process.env) {
  const { getWorkerExecutor } = await import('@suhbat/database/worker-executor');
  const { createStorageProviderFromEnv } = await import('@suhbat/database/storage');

  const db = await getWorkerExecutor({ role: 'recording-api', env });
  if (!db) {
    throw new Error(
      'recording-api requires SUPABASE_DB_URL. The Recording API is the privileged service that ' +
        'owns Phase 4 writes; it cannot start without a database connection.',
    );
  }

  const storage: StorageProvider = createStorageProviderFromEnv(env);
  const service = new Phase4BackboneService({ db, storage });
  return createRecordingApi({ service, signingSecrets: readInternalSigningKeys(env) });
}

export type { IncomingHttpHeaders, IncomingMessage, ServerResponse };
