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
import {
  createBusinessAutomationProviderFromEnv,
  type BusinessAutomationProvider,
} from '@suhbat/database/automation-provider';

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
    const principal = await configured.resolvePrincipal(request);
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
      principal,
    };
  }

  // Default live path: derive identity strictly from authenticated Supabase session.
  const { createSupabaseServerClient } = await import('@suhbat/database/server');
  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const principal = !authError && authData.user ? { userId: authData.user.id } : null;

  throw new Phase4ServiceError(
    503,
    'internal_error',
    principal
      ? 'Phase 4/5/6 PostgreSQL runtime is not connected in this environment.'
      : 'Authenticated session is required.',
  );
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
