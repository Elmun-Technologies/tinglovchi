import { NextResponse, type NextRequest } from 'next/server';
import {
  Phase4BackboneService,
  Phase4ServiceError,
  type AuthenticatedPrincipal,
} from '@suhbat/database/phase4';
import {
  signInternalRequest,
  readInternalSigningKeys,
  type InternalSigningKey,
} from '@suhbat/database/internal-service-auth';
import { resolveDesktopContext } from './api-v1-runtime';

/**
 * The Web gateway for privileged recording operations.
 *
 * ## The shape of the problem
 *
 * The desktop recorder needs to register recordings, register chunks, and get signed upload URLs.
 * Those are Phase 4 writes, and Phase 4 needs a SQL executor the web deployment is forbidden from
 * holding. So the work happens in a separate private service, and the desktop still talks to exactly
 * one public origin.
 *
 * That makes this file the seam. Its whole job is:
 *
 *   1. Authenticate the caller here, in the web process, against the Supabase session or the desktop
 *      session token. Nothing downstream trusts an identity the client supplied.
 *   2. Forward the *validated* request to the Recording API over the private network, signed with a
 *      secret only these two services hold.
 *   3. Return the response unchanged.
 *
 * The desktop never learns the internal hostname, and the Recording API never sees an
 * unauthenticated request.
 */

export type RecordingTarget = {
  /** Absolute path on the Recording API, without a query string. */
  path: string;
  method: string;
  /** Raw request body. Empty for bodiless requests. Must match what was signed. */
  body?: string;
  searchParams?: URLSearchParams;
};

export type RecordingGateway = {
  forward(
    target: RecordingTarget,
    principal: AuthenticatedPrincipal,
  ): Promise<{ status: number; body: string }>;
};

export type RecordingContext = {
  principal: AuthenticatedPrincipal;
  forward(target: RecordingTarget): Promise<NextResponse>;
};

const runtimeState = globalThis as typeof globalThis & {
  __suhbatRecordingGateway?: RecordingGateway | null;
  /** Held only so `resetRecordingGateway` can drop it; nothing reads it. */
  __suhbatRecordingApi?: unknown;
};

/**
 * Installs an explicit gateway. Used by tests that want to point the web routes at a real Recording
 * API instance — in-process or over a socket — without touching global fetch.
 */
export function setRecordingGateway(gateway: RecordingGateway | null): void {
  runtimeState.__suhbatRecordingGateway = gateway;
}

export function getRecordingGateway(): RecordingGateway | null {
  return runtimeState.__suhbatRecordingGateway ?? null;
}

// ---------------------------------------------------------------------------
// Gateway implementations
// ---------------------------------------------------------------------------

/**
 * Production gateway: signs the request and forwards it over the private network.
 *
 * Note what is *not* copied: every header from the inbound request. Building the outbound header set
 * from scratch is what stops a client smuggling `x-suhbat-user-id` past the signature, and it also
 * stops the desktop's `Authorization` token being replayed to the Recording API — that service has no
 * use for it and no business holding it.
 */
function createHttpGateway(options: {
  baseUrl: string;
  keys: readonly InternalSigningKey[];
}): RecordingGateway {
  return {
    async forward(target, principal) {
      const path = target.searchParams?.toString()
        ? `${target.path}?${target.searchParams.toString()}`
        : target.path;
      const body = target.body ?? '';
      const key = options.keys[0];
      if (!key) {
        throw new Phase4ServiceError(
          503,
          'internal_error',
          'Web is not configured to authenticate requests to the Recording API.',
        );
      }
      const signatureHeaders = signInternalRequest(
        { method: target.method, path, body, userId: principal.userId },
        key,
      );

      let upstream: Response;
      try {
        upstream = await fetch(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
          method: target.method,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            accept: 'application/json',
            ...signatureHeaders,
          },
          body: target.method === 'GET' || target.method === 'DELETE' ? undefined : body,
          // Never follow a redirect: a redirect from the private service could carry the signed
          // headers somewhere else entirely.
          redirect: 'manual',
          cache: 'no-store',
        });
      } catch (cause) {
        // The upstream URL and any token are deliberately absent from this message.
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Phase4ServiceError(
          503,
          'internal_error',
          'The recording service is unavailable.',
          detail,
        );
      }

      const text = await upstream.text();
      return { status: upstream.status, body: text };
    },
  };
}

/**
 * In-process gateway: runs the real Recording API router against an injected service, with no socket.
 *
 * This is how the integration suite drives the recording routes. It is not a shortcut around the
 * security model — it performs the same signing and the same verification, and runs the same
 * authorization re-checks. Only the transport is missing. That is deliberate: the trust mechanism
 * should be exercised on every test run, not only in a deployment.
 */
async function createInProcessGateway(
  service: Phase4BackboneService,
): Promise<RecordingGateway> {
  // Imported dynamically and only on the test/injected path. A production web deployment must never
  // need this module — its recording work happens in the Recording API process — and keeping the
  // import lazy means it is never even loaded there.
  const { createRecordingApi } = await import('@suhbat/recording-api/server');
  const secret = process.env.SUHBAT_INTERNAL_API_SECRET?.trim() || 'in-process-recording-gateway';
  const key: InternalSigningKey = { keyId: 'in-process', secret };
  // A memory ledger is correct here, not a shortcut: this gateway runs the Recording API router in
  // the same process as the caller, so there is no second machine that could be replayed against.
  // A real deployment — one process per host, several hosts — always gets the durable store.
  const api = createRecordingApi({
    service,
    signingSecrets: [key],
    nonceStore: { backend: 'memory' },
  });
  runtimeState.__suhbatRecordingApi = api;
  let counter = 0;

  return {
    async forward(target, principal) {
      const path = target.searchParams?.toString()
        ? `${target.path}?${target.searchParams.toString()}`
        : target.path;
      const body = target.body ?? '';
      counter += 1;
      // A fresh nonce per call, exactly as the HTTP path produces.
      const headers = signInternalRequest(
        { method: target.method, path, body, userId: principal.userId },
        key,
        { nonce: `in-process-${Date.now()}-${counter}` },
      );
      return api.handle({
        method: target.method,
        path,
        // A fresh Headers object containing only the gateway's own headers. Nothing from the client
        // is carried across, which is the same property the HTTP path has by construction.
        headers: new Headers(headers),
        body,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Authenticates the caller in this process, then returns a forwarder.
 *
 * Identity is resolved from the browser's Supabase session or the desktop's session token — both of
 * which are verified here — and the resulting user id is the only identity the Recording API will
 * see.
 */
export async function resolveRecordingContext(
  request: Request | NextRequest,
): Promise<RecordingContext> {
  const { getPhase4Runtime } = await import('./api-v1-runtime');
  const configured = getPhase4Runtime();

  let principal: AuthenticatedPrincipal | null;
  if (configured) {
    principal = await configured.resolvePrincipal(request);
  } else {
    ({ principal } = await resolveDesktopContext(request));
  }

  if (!principal?.userId) {
    throw new Phase4ServiceError(
      401,
      'unauthenticated',
      'Authenticated user session is required.',
    );
  }

  const gateway =
    getRecordingGateway() ??
    (configured?.service ? await createInProcessGateway(configured.service) : null) ??
    defaultHttpGateway();

  return {
    principal,
    async forward(target: RecordingTarget): Promise<NextResponse> {
      const result = await gateway.forward(target, principal!);
      // Pass the upstream body through untouched. Inserting `NextResponse.json` here would re-serialise
      // it and could silently alter a payload the recording API already validated.
      return new NextResponse(result.body, {
        status: result.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    },
  };
}

let cachedHttpGateway: RecordingGateway | null = null;

function defaultHttpGateway(): RecordingGateway {
  if (cachedHttpGateway) return cachedHttpGateway;
  const baseUrl = process.env.SUHBAT_RECORDING_API_URL?.trim();
  if (!baseUrl) {
    throw new Phase4ServiceError(
      503,
      'internal_error',
      'SUHBAT_RECORDING_API_URL is not configured, so recording requests cannot be forwarded. ' +
        'Point it at the private Recording API (see docs/deployment-topology.md).',
    );
  }
  const keys = readInternalSigningKeys(process.env);
  if (keys.length === 0) {
    throw new Phase4ServiceError(
      503,
      'internal_error',
      'SUHBAT_INTERNAL_API_SECRET is not configured, so this deployment cannot authenticate to the ' +
        'Recording API.',
    );
  }
  cachedHttpGateway = createHttpGateway({ baseUrl, keys });
  return cachedHttpGateway;
}

/** Test helper: forget cached gateways so environment changes take effect. */
export function resetRecordingGateway(): void {
  cachedHttpGateway = null;
  runtimeState.__suhbatRecordingGateway = null;
  runtimeState.__suhbatRecordingApi = null;
}
