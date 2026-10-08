import { NextResponse, type NextRequest } from 'next/server';
import {
  Phase4BackboneService,
  Phase4ServiceError,
  type AuthenticatedPrincipal,
} from '@suhbat/database/phase4';
import { Phase5TranscriptionService } from '@suhbat/database/phase5';
import { Phase6IntelligenceService } from '@suhbat/database/phase6';
import { Phase7KnowledgeService } from '@suhbat/database/phase7';
import { Phase8TelegramService } from '@suhbat/database/phase8';
import { Phase9AutomationService } from '@suhbat/database/phase9';
import {
  createTranscriptionProviderFromEnv,
  type TranscriptionProvider,
} from '@suhbat/database/transcription-provider';
import {
  createMeetingIntelligenceProviderFromEnv,
  type MeetingIntelligenceProvider,
} from '@suhbat/database/intelligence-provider';
import {
  createEmbeddingProviderFromEnv,
  type EmbeddingProvider,
} from '@suhbat/database/embedding-provider';
import {
  createTelegramBotProviderFromEnv,
  type TelegramBotProvider,
} from '@suhbat/database/telegram-provider';
import { DesktopClientService } from '@suhbat/database/desktop';
import {
  createBusinessAutomationProviderFromEnv,
  type BusinessAutomationProvider,
} from '@suhbat/database/automation-provider';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDesktopRpc } from './desktop-rpc';

export type Phase4RuntimeResolver = {
  service: Phase4BackboneService;
  phase5Service?: Phase5TranscriptionService;
  phase6Service?: Phase6IntelligenceService;
  phase7Service?: Phase7KnowledgeService;
  phase8Service?: Phase8TelegramService;
  phase9Service?: Phase9AutomationService;
  transcriptionProvider?: TranscriptionProvider;
  intelligenceProvider?: MeetingIntelligenceProvider;
  embeddingProvider?: EmbeddingProvider;
  telegramProvider?: TelegramBotProvider;
  automationProvider?: BusinessAutomationProvider;
  desktopService?: DesktopClientService;
  resolvePrincipal: (request: Request | NextRequest) => Promise<AuthenticatedPrincipal | null>;
};

const runtimeState = globalThis as typeof globalThis & {
  __suhbatPhase4Runtime?: Phase4RuntimeResolver | null;
};

/**
 * Registers an explicit Phase 4/5/6/7/8/9 runtime (used by PGlite integration tests and server bootstrap).
 * Never falls back to demo fixtures.
 */
export function setPhase4Runtime(runtime: Phase4RuntimeResolver | null): void {
  runtimeState.__suhbatPhase4Runtime = runtime;
}

export function getPhase4Runtime(): Phase4RuntimeResolver | null {
  return runtimeState.__suhbatPhase4Runtime ?? null;
}

// ---------------------------------------------------------------------------
// Capability-scoped resolution
// ---------------------------------------------------------------------------
//
// `resolveApiContext` used to build the entire world for every request: an object-storage provider,
// a transcription provider, an intelligence provider, an embedding provider, a Telegram bot, and an
// automation client. That meant signing in from the desktop app required a working AssemblyAI key, a
// working OpenAI key, and a configured R2 bucket. It also meant one code path decided the
// dependencies of every endpoint.
//
// These three resolvers exist so each group of endpoints declares only what it uses:
//
//   resolveDesktopContext  — pairing, session, workspace discovery, meeting creation.
//                            Needs a Supabase client. Needs no provider and no storage.
//   resolvePipelineContext — recording upload, verification, finalization, processing.
//                            Needs storage and the whole provider stack, and a privileged executor.
//   resolveApiContext      — unchanged full context, for endpoints that predate the split.
//
// The desktop pairing flow runs entirely on `resolveDesktopContext`, so a missing
// `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, or R2 bucket cannot stop someone from signing in.

let supabaseClientPromise: Promise<SupabaseClient> | null = null;

/**
 * Resolves lazily and caches the Supabase client.
 *
 * Imported dynamically because `@suhbat/database/server` pulls in `next/headers` and `server-only`,
 * neither of which may be evaluated at module scope in a non-request context (including tests).
 */
async function supabaseClient(): Promise<SupabaseClient> {
  if (!supabaseClientPromise) {
    supabaseClientPromise = (async () => {
      const { createSupabaseServerClient } = await import('@suhbat/database/server');
      return (await createSupabaseServerClient()) as unknown as SupabaseClient;
    })();
  }
  return supabaseClientPromise;
}

function buildDesktopService(client: SupabaseClient): DesktopClientService {
  return new DesktopClientService({ rpc: createDesktopRpc(client) });
}

export type DesktopContext = {
  desktopService: DesktopClientService;
  principal: AuthenticatedPrincipal | null;
};

/**
 * Everything the desktop needs to sign in and start a meeting — and nothing else.
 *
 * No storage provider, no transcription provider, no intelligence provider, no embedding provider,
 * no Telegram bot, no automation client, and no direct database connection.
 */
export async function resolveDesktopContext(
  request: Request | NextRequest,
): Promise<DesktopContext> {
  // When a runtime is injected (integration tests, or a host that supplies its own service) use it
  // as-is and never touch Supabase. That keeps this path usable without a configured Supabase
  // project, which is what makes the pairing endpoints independently testable.
  const configured = getPhase4Runtime();
  if (configured?.desktopService) {
    return {
      desktopService: configured.desktopService,
      principal: await configured.resolvePrincipal(request),
    };
  }

  const client = await supabaseClient();
  const desktopService = buildDesktopService(client);
  let principal: AuthenticatedPrincipal | null = null;

  try {
    const { data: authData, error: authError } = await client.auth.getUser();
    if (!authError && authData.user) principal = { userId: authData.user.id };
  } catch {
    // No usable browser session (this is a desktop call). Fall through to the desktop credential.
  }
  if (!principal) {
    const token = desktopBearerToken(request);
    if (token) principal = await desktopService.resolveSessionToken(token);
  }

  return { desktopService, principal };
}

/**
 * Recording upload, verification, finalization, and processing.
 *
 * These endpoints write to the recording pipeline and are the ones that genuinely need a privileged
 * SQL executor. The web deployment does not have one — `docs/production-readiness.md` forbids
 * `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Web — so unless an explicit runtime has been
 * injected (integration tests, or a deployment that deliberately runs this process as the privileged
 * service) they answer 503 with that stated plainly instead of trying to connect.
 *
 * The desktop's own sign-in, workspace, and meeting endpoints do not come through here, so recording
 * being unavailable in a given deployment never prevents authentication.
 */
export async function resolvePipelineContext(request: Request | NextRequest): Promise<{
  service: Phase4BackboneService;
  phase5Service: Phase5TranscriptionService;
  phase6Service: Phase6IntelligenceService;
  phase7Service: Phase7KnowledgeService;
  phase8Service: Phase8TelegramService;
  phase9Service: Phase9AutomationService;
  principal: AuthenticatedPrincipal | null;
}> {
  const configured = getPhase4Runtime();
  if (configured) {
    const phase5Service =
      configured.phase5Service ??
      new Phase5TranscriptionService({
        phase4: configured.service,
        provider: configured.transcriptionProvider ?? createTranscriptionProviderFromEnv(),
      });
    const phase6Service =
      configured.phase6Service ??
      new Phase6IntelligenceService({
        db: configured.service.db,
        phase5: phase5Service,
        intelligenceProvider:
          configured.intelligenceProvider ?? createMeetingIntelligenceProviderFromEnv(),
      });
    const phase7Service =
      configured.phase7Service ??
      new Phase7KnowledgeService({
        db: configured.service.db,
        phase6: phase6Service,
        embeddingProvider: configured.embeddingProvider ?? createEmbeddingProviderFromEnv(),
      });
    const phase8Service =
      configured.phase8Service ??
      new Phase8TelegramService({
        db: configured.service.db,
        phase7: phase7Service,
        telegramProvider: configured.telegramProvider ?? createTelegramBotProviderFromEnv(),
      });
    const phase9Service =
      configured.phase9Service ??
      new Phase9AutomationService({
        db: configured.service.db,
        phase8: phase8Service,
        automationProvider:
          configured.automationProvider ?? createBusinessAutomationProviderFromEnv(),
      });
    return {
      service: configured.service,
      phase5Service,
      phase6Service,
      phase7Service,
      phase8Service,
      phase9Service,
      principal: await configured.resolvePrincipal(request),
    };
  }

  throw new Phase4ServiceError(
    503,
    'internal_error',
    'The recording pipeline needs the privileged worker service, which holds the database ' +
      'credential. This web process intentionally does not (see docs/production-readiness.md). ' +
      'Run it as the privileged worker service, or inject a pipeline runtime.',
  );
}

export async function resolveApiContext(request: Request | NextRequest): Promise<{
  service: Phase4BackboneService;
  phase5Service: Phase5TranscriptionService;
  phase6Service: Phase6IntelligenceService;
  phase7Service: Phase7KnowledgeService;
  phase8Service: Phase8TelegramService;
  phase9Service: Phase9AutomationService;
  principal: AuthenticatedPrincipal | null;
}> {
  const configured = getPhase4Runtime();
  if (configured) {
    const phase5Service =
      configured.phase5Service ??
      new Phase5TranscriptionService({
        phase4: configured.service,
        provider: configured.transcriptionProvider ?? createTranscriptionProviderFromEnv(),
      });
    const phase6Service =
      configured.phase6Service ??
      new Phase6IntelligenceService({
        db: configured.service.db,
        phase5: phase5Service,
        intelligenceProvider:
          configured.intelligenceProvider ?? createMeetingIntelligenceProviderFromEnv(),
      });
    const phase7Service =
      configured.phase7Service ??
      new Phase7KnowledgeService({
        db: configured.service.db,
        phase6: phase6Service,
        embeddingProvider: configured.embeddingProvider ?? createEmbeddingProviderFromEnv(),
      });
    const phase8Service =
      configured.phase8Service ??
      new Phase8TelegramService({
        db: configured.service.db,
        phase7: phase7Service,
        telegramProvider: configured.telegramProvider ?? createTelegramBotProviderFromEnv(),
      });
    const phase9Service =
      configured.phase9Service ??
      new Phase9AutomationService({
        db: configured.service.db,
        phase8: phase8Service,
        automationProvider:
          configured.automationProvider ?? createBusinessAutomationProviderFromEnv(),
      });
    return {
      service: configured.service,
      phase5Service,
      phase6Service,
      phase7Service,
      phase8Service,
      phase9Service,
      principal: await configured.resolvePrincipal(request),
    };
  }

  //
  // Default live path.
  //
  // Identity comes from *either* the browser's Supabase session (the web dashboard and the
  // `/desktop/connect` approval page) or a server-issued desktop session token. Both collapse to the
  // same `AuthenticatedPrincipal`, so every downstream check is identical for both clients.
  //
  // Recording endpoints, however, need Phase 4's privileged SQL executor, and this process does not
  // have one — `docs/production-readiness.md` forbids the database credential in the Web deployment.
  // Rather than quietly connecting as the owner, the pipeline routes say so and stop. It stays fully
  // exercisable through `setPhase4Runtime`, which is how the integration tests drive it, and it
  // becomes live by running this API as the privileged worker service.
  //
  throw new Phase4ServiceError(
    503,
    'internal_error',
    'The recording pipeline requires the privileged worker service, which is the only component ' +
      'that holds the database credential. This web process deliberately does not ' +
      '(see docs/production-readiness.md).',
  );
}

/**
 * The raw `Authorization: Bearer <opaque desktop session token>` value, if present.
 *
 * Desktop sessions are server-issued and stored only as a SHA-256, so this string is the one and only
 * copy of the credential; it is never logged and never placed in a query parameter (which would leak
 * into proxy and browser history).
 */
export function desktopBearerToken(request: Request | NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length >= 32 && token.length <= 512 ? token : null;
}

/**
 * The pairing code supplied by the desktop while it polls for approval. Kept in its own header
 * rather than `Authorization` so a short, unauthenticated code is never mistaken for a real session
 * credential by middleware, logs, or a proxy.
 */
export function desktopConnectCodeHeader(request: Request | NextRequest): string | null {
  const header = request.headers.get('x-suhbat-connect-code');
  const code = header?.trim();
  return code && code.length <= 32 ? code : null;
}

export const MAX_API_JSON_BODY_BYTES = 256 * 1024; // 256 KiB metadata payload ceiling

export async function parseJsonBody(
  request: Request | NextRequest,
  options: { allowEmpty?: boolean; maxBytes?: number } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_API_JSON_BODY_BYTES;
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Phase4ServiceError(
        413,
        'validation_failed',
        `Request JSON body exceeds maximum allowed size (${maxBytes} bytes).`,
      );
    }
  }

  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Phase4ServiceError(
      413,
      'validation_failed',
      `Request JSON body exceeds maximum allowed size (${maxBytes} bytes).`,
    );
  }
  if (!text.trim()) {
    if (options.allowEmpty) return {};
    throw new Phase4ServiceError(400, 'validation_failed', 'Request JSON body is required.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Phase4ServiceError(400, 'validation_failed', 'Malformed JSON request body.');
  }
}

export function handleApiError(cause: unknown): NextResponse {
  if (cause instanceof Phase4ServiceError) {
    return NextResponse.json(
      {
        error: {
          code: cause.code,
          message: cause.message,
          ...(cause.detail ? { detail: cause.detail } : {}),
        },
      },
      { status: cause.statusCode },
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const isProd = process.env.NODE_ENV === 'production';
  return NextResponse.json(
    {
      error: {
        code: 'internal_error',
        message: 'An unexpected server error occurred.',
        ...(!isProd ? { detail } : {}),
      },
    },
    { status: 500 },
  );
}
