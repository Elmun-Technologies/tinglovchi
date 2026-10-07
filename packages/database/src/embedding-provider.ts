import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_OPENAI_EMBEDDING_DIMENSIONS,
} from '@suhbat/contracts';

export class EmbeddingProviderError extends Error {
  readonly code:
    | 'provider_not_configured'
    | 'provider_unavailable'
    | 'provider_Invalid_response'
    | 'embeddings_failed';
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(params: {
    code:
      | 'provider_not_configured'
      | 'provider_unavailable'
      | 'provider_Invalid_response'
      | 'embeddings_failed';
    message: string;
    retryable: boolean;
    detail?: string;
  }) {
    super(params.message);
    this.name = 'EmbeddingProviderError';
    this.code = params.code;
    this.retryable = params.retryable;
    if (params.detail !== undefined) {
      this.detail = params.detail;
    }
  }
}

export type EmbedTextsRequest = {
  workspaceId: string;
  meetingId?: string;
  embeddingRunId?: string;
  texts: string[];
  model?: string;
};

export type EmbedTextsResponse = {
  provider: string;
  model: string;
  dimensions: number;
  embeddings: number[][];
  tokenUsageMetadata: {
    prompt_tokens: number;
    total_tokens: number;
  };
};

export interface EmbeddingProvider {
  readonly providerName: string;
  readonly defaultModel: string;
  readonly dimensions: number;
  isConfigured(): boolean;
  embedTexts(request: EmbedTextsRequest): Promise<EmbedTextsResponse>;
}

const MULTILINGUAL_CONCEPT_AXES: ReadonlyArray<RegExp> = [
  // 0: Budget / pricing / cost ($)
  /\b(budget|byudjet|бюджет|\$5,?000|\$10,?000|cost|narx|цена|koliya|mablag)\b/iu,
  // 1: Revenue / forecast / growth (%)
  /\b(revenue|forecast|o'sish|osish|growth|выручк|прогноз|18%|q4)\b/iu,
  // 2: Conversion / metrics / KPI
  /\b(conversion|konversiya|конверси|57%|metric|ko'rsatkich|kpi)\b/iu,
  // 3: Tasks / action items / deadlines / owners
  /\b(task|vazifa|topshiriq|задач|action|mas'ul|ответствен|deadline|muddat|srok)\b/iu,
  // 4: Decisions / agreements / approvals
  /\b(decision|qaror|kelishdik|tasdiq|решен|договорились|agreed|confirmed|tentative|balki)\b/iu,
  // 5: Questions / unresolved / open issues
  /\b(question|savol|вопрос|unresolved|ochiq|open|tushunarsiz|aniqlashtirish)\b/iu,
  // 6: Objections / pushback / SLA concerns
  /\b(objection|e'tiroz|возражен|concern|xavotir|sla|pushback)\b/iu,
  // 7: Risks / blockers / customs / delays
  /\b(risk|xavf|риск|bojxona|customs|тамож|sertifikat|certificate|kechikish|delay|blocker)\b/iu,
  // 8: Commitments / promises / enterprise support
  /\b(commitment|va'da|мажбурият|обязательств|onboarding|dedicated|support|kanal|channel)\b/iu,
  // 9: Ideas / proposals / warehouse inventory
  /\b(idea|g'oya|taklif|идея|предложен|ombor|warehouse|склад|zaxira|захира|ikki barobar)\b/iu,
  // 10: Logistics / delivery / supply chain
  /\b(logistik|logistics|логистик|поставк|yetkazib|delivery|schedule|график)\b/iu,
  // 11: Geography — Samarqand & Tashkent
  /\b(samarqand|samarkand|самарканд|toshkent|tashkent|ташкент|regional|hududiy)\b/iu,
  // 12: Engineering / API / webhooks / retry
  /\b(engineering|muhandis|api|webhook|retry|staging|integration|integratsiya|network)\b/iu,
  // 13: Team / headcount / staffing
  /\b(team|jamoa|команд|team size|6|xodim|staff)\b/iu,
  // 14: QA / release / mobile / desktop / sprint
  /\b(qa|sign-off|sprint|release|mobile|desktop|синхронно|sinxron)\b/iu,
  // 15: Days of week / schedule milestones
  /\b(thursday|payshanba|четверг|friday|juma|пятниц|wednesday|chorshanba|среда|16:00|soat o'n olti)\b/iu,
];

function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Computes a deterministic, L2-normalized embedding vector of `dimensions` length.
 * Combines 16 multilingual semantic concept axes with hashed token & character 3-gram features.
 */
export function computeDeterministicEmbedding(
  text: string,
  dimensions = DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const normalized = text
    .toLowerCase()
    .replace(/['’`ʻʼ]/g, "'")
    .trim();

  const conceptCount = Math.min(MULTILINGUAL_CONCEPT_AXES.length, Math.floor(dimensions / 2));
  for (let i = 0; i < conceptCount; i += 1) {
    const regex = MULTILINGUAL_CONCEPT_AXES[i]!;
    if (regex.test(normalized)) {
      vec[i] = 2.5;
    }
  }

  const hashBucketCount = dimensions - conceptCount;
  const tokens = normalized.split(/[^\p{L}\p{N}$%]+/u).filter((t) => t.length >= 2);
  for (const token of tokens) {
    const tokenHash = fnv1aHash(`tok:${token}`);
    const bucket = conceptCount + (tokenHash % hashBucketCount);
    const sign = (tokenHash & 0x10000) !== 0 ? 1 : -1;
    vec[bucket] = (vec[bucket] ?? 0) + sign * 1.0;

    if (token.length >= 3) {
      for (let i = 0; i <= token.length - 3; i += 1) {
        const trigram = token.slice(i, i + 3);
        const triHash = fnv1aHash(`tri:${trigram}`);
        const triBucket = conceptCount + (triHash % hashBucketCount);
        const triSign = (triHash & 0x20000) !== 0 ? 0.35 : -0.35;
        vec[triBucket] = (vec[triBucket] ?? 0) + triSign;
      }
    }
  }

  let normSq = 0;
  for (let i = 0; i < dimensions; i += 1) {
    normSq += vec[i]! * vec[i]!;
  }
  if (normSq <= 0) {
    vec[0] = 1;
    return vec;
  }
  const norm = Math.sqrt(normSq);
  for (let i = 0; i < dimensions; i += 1) {
    vec[i] = Number((vec[i]! / norm).toFixed(8));
  }
  return vec;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = 'fake';
  readonly defaultModel = 'fake-multilingual-embedding-v1';
  readonly dimensions: number;

  private readonly callLog: EmbedTextsRequest[] = [];
  private readonly injectedFailures = new Map<
    string,
    { code: EmbeddingProviderError['code']; message: string; retryable: boolean }
  >();

  constructor(options?: { dimensions?: number }) {
    this.dimensions = options?.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;
  }

  isConfigured(): boolean {
    return true;
  }

  getCallLog(): ReadonlyArray<EmbedTextsRequest> {
    return this.callLog;
  }

  clearCallLog(): void {
    this.callLog.length = 0;
  }

  injectFailureForMeeting(
    meetingId: string,
    failure: { code: EmbeddingProviderError['code']; message: string; retryable: boolean },
  ): void {
    this.injectedFailures.set(meetingId, failure);
  }

  clearFailureForMeeting(meetingId: string): void {
    this.injectedFailures.delete(meetingId);
  }

  async embedTexts(request: EmbedTextsRequest): Promise<EmbedTextsResponse> {
    this.callLog.push(request);

    if (request.meetingId) {
      const failure = this.injectedFailures.get(request.meetingId);
      if (failure) {
        throw new EmbeddingProviderError({
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        });
      }
    }

    const embeddings = request.texts.map((t) => computeDeterministicEmbedding(t, this.dimensions));
    const totalChars = request.texts.reduce((sum, t) => sum + t.length, 0);
    const approxTokens = Math.max(1, Math.ceil(totalChars / 4));

    return {
      provider: this.providerName,
      model: request.model ?? this.defaultModel,
      dimensions: this.dimensions,
      embeddings,
      tokenUsageMetadata: {
        prompt_tokens: approxTokens,
        total_tokens: approxTokens,
      },
    };
  }
}

export type OpenAIEmbeddingProviderOptions = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  defaultModel?: string | undefined;
  dimensions?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = 'openai';
  readonly defaultModel: string;
  readonly dimensions: number;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options?.apiKey?.trim() || undefined;
    this.baseUrl = (options?.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultModel = options?.defaultModel ?? 'text-embedding-3-small';
    this.dimensions = options?.dimensions ?? DEFAULT_OPENAI_EMBEDDING_DIMENSIONS;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 0);
  }

  async embedTexts(request: EmbedTextsRequest): Promise<EmbedTextsResponse> {
    if (!this.isConfigured() || !this.apiKey) {
      throw new EmbeddingProviderError({
        code: 'provider_not_configured',
        message:
          'OpenAI embedding provider is not configured. Set OPENAI_API_KEY and EMBEDDING_PROVIDER=openai.',
        retryable: false,
      });
    }

    const model = request.model ?? this.defaultModel;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: request.texts,
          dimensions: this.dimensions,
        }),
      });
    } catch (cause) {
      throw new EmbeddingProviderError({
        code: 'provider_unavailable',
        message: 'Failed to reach OpenAI embeddings endpoint.',
        retryable: true,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingProviderError({
        code: retryable ? 'provider_unavailable' : 'embeddings_failed',
        message: `OpenAI embeddings request failed with HTTP ${response.status}.`,
        retryable,
      });
    }

    const json = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    if (!Array.isArray(json.data) || json.data.length !== request.texts.length) {
      throw new EmbeddingProviderError({
        code: 'provider_Invalid_response',
        message: 'OpenAI embeddings response did not match requested batch length.',
        retryable: false,
      });
    }

    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((item) => {
      if (!Array.isArray(item.embedding) || item.embedding.length !== this.dimensions) {
        throw new EmbeddingProviderError({
          code: 'provider_Invalid_response',
          message: `OpenAI embedding vector dimension mismatch (expected ${this.dimensions}).`,
          retryable: false,
        });
      }
      return item.embedding;
    });

    return {
      provider: this.providerName,
      model,
      dimensions: this.dimensions,
      embeddings,
      tokenUsageMetadata: {
        prompt_tokens: json.usage?.prompt_tokens ?? 0,
        total_tokens: json.usage?.total_tokens ?? 0,
      },
    };
  }
}

export function createEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const isProd = env.NODE_ENV === 'production';
  const rawMode =
    env.SUHBAT_EMBEDDING_PROVIDER ?? env.EMBEDDING_PROVIDER ?? (isProd ? 'openai' : 'fake');
  const mode = rawMode.trim().toLowerCase();
  if (mode === 'fake') {
    if (isProd) {
      throw new EmbeddingProviderError({
        code: 'provider_not_configured',
        message: 'FakeEmbeddingProvider is not permitted in production.',
        retryable: false,
      });
    }
    return new FakeEmbeddingProvider();
  }
  if (mode === 'openai') {
    if (!env.OPENAI_API_KEY?.trim()) {
      throw new EmbeddingProviderError({
        code: 'provider_not_configured',
        message:
          'OpenAI embedding provider requires OPENAI_API_KEY when SUHBAT_EMBEDDING_PROVIDER/EMBEDDING_PROVIDER=openai.',
        retryable: false,
      });
    }
    return new OpenAIEmbeddingProvider({
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      defaultModel: env.OPENAI_EMBEDDING_MODEL,
    });
  }
  throw new EmbeddingProviderError({
    code: 'provider_not_configured',
    message: `Unsupported SUHBAT_EMBEDDING_PROVIDER="${mode}". Expected "fake" or "openai".`,
    retryable: false,
  });
}
