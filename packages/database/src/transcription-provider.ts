import {
  providerTranscriptionResultSchema,
  type DetectedSegmentLanguage,
  type ProviderTranscriptSegment,
  type ProviderTranscriptWord,
  type ProviderTranscriptionResult,
  type TranscriptionAssetPiece,
} from '@suhbat/contracts';

export class TranscriptionProviderError extends Error {
  readonly code:
    | 'provider_not_configured'
    | 'provider_unavailable'
    | 'provider_invalid_response'
    | 'provider_transcription_failed';
  readonly retryable: boolean;

  constructor(code: TranscriptionProviderError['code'], message: string, retryable = false) {
    super(message);
    this.name = 'TranscriptionProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type TranscriptionAssetInput = {
  assetId: string;
  workspaceId: string;
  meetingId: string;
  recordingId: string;
  assetVersion: number;
  storageKey: string;
  signedAudioUrl?: string;
  assetDurationMs: number;
  sampleRateHz: number;
  channels: number;
  timelineMap: readonly TranscriptionAssetPiece[];
  requestedLanguages?: readonly string[];
};

export interface TranscriptionProvider {
  readonly providerName: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  transcribe(input: TranscriptionAssetInput): Promise<ProviderTranscriptionResult>;
}

type FakeUtteranceTemplate = {
  speakerLabel: 'speaker_0' | 'speaker_1' | 'speaker_2';
  language: DetectedSegmentLanguage;
  confidence: number;
  text: string;
};

const DEFAULT_MULTILINGUAL_TEMPLATES: readonly FakeUtteranceTemplate[] = [
  {
    speakerLabel: 'speaker_0',
    language: 'uz',
    confidence: 0.96,
    text: 'Assalomu alaykum barchaga, bugungi mahsulot va eksport uchrashuvimizni boshlaymiz.',
  },
  {
    speakerLabel: 'speaker_1',
    language: 'mixed',
    confidence: 0.93,
    text: "Bizning Q4 revenue forecast bo'yicha по договору 18 фоиз o'sish kutilmoqda, lekin logistika SLA bo'yicha savollar bor.",
  },
  {
    speakerLabel: 'speaker_2',
    language: 'ru',
    confidence: 0.95,
    text: 'Давайте отдельно зафиксируем график поставок по Ташкенту и Самарканду до пятницы.',
  },
  {
    speakerLabel: 'speaker_0',
    language: 'en',
    confidence: 0.97,
    text: 'Agreed, the engineering team will finalize the API integration and share the staging report by Thursday.',
  },
  {
    speakerLabel: 'speaker_1',
    language: 'uz',
    confidence: 0.94,
    text: "Bojxona hujjatlari va sertifikatlar chorshanba kuni soat o'n oltigacha tayyor bo'lishi shart.",
  },
  {
    speakerLabel: 'speaker_2',
    language: 'mixed',
    confidence: 0.91,
    text: 'По клиентскому onboarding jarayonida enterprise mijozlar uchun dedicated support channel ochamiz.',
  },
  {
    speakerLabel: 'speaker_0',
    language: 'ru',
    confidence: 0.95,
    text: 'Финансовый отдел подтвердил лимит бюджета на четвертый квартал без дополнительных задержек.',
  },
  {
    speakerLabel: 'speaker_1',
    language: 'en',
    confidence: 0.96,
    text: 'We also verified the webhook retry policy so transient network drops never duplicate orders.',
  },
  {
    speakerLabel: 'speaker_2',
    language: 'uz',
    confidence: 0.92,
    text: "Samarqand omboridagi захира hajmini yana ikki barobar ko'paytirish bo'yicha taklif kiritildi.",
  },
  {
    speakerLabel: 'speaker_0',
    language: 'mixed',
    confidence: 0.94,
    text: 'Keyingi sprintda mobile va desktop release-larni синхронно chiqaramiz, QA sign-off juma kuni.',
  },
  {
    speakerLabel: 'speaker_1',
    language: 'ru',
    confidence: 0.93,
    text: 'Отлично, тогда протокол встречи и список ответственных отправим сразу после звонка.',
  },
  {
    speakerLabel: 'speaker_2',
    language: 'uz',
    confidence: 0.97,
    text: "Hammaga rahmat, keyingi haftada natijalarni ko'rib chiqamiz.",
  },
];

function buildDeterministicWordsForSegment(params: {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  speakerLabel: string;
}): ProviderTranscriptWord[] {
  const tokens = params.text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const totalSpan = Math.max(1, params.endMs - params.startMs);
  return tokens.map((token, idx) => {
    const wordStart = params.startMs + Math.floor((idx * totalSpan) / tokens.length);
    const wordEnd =
      idx === tokens.length - 1
        ? params.endMs
        : Math.max(
            wordStart,
            params.startMs + Math.floor(((idx + 1) * totalSpan) / tokens.length) - 1,
          );
    return {
      text: token,
      startMs: wordStart,
      endMs: Math.max(wordStart, wordEnd),
      confidence: params.confidence,
      speakerLabel: params.speakerLabel,
    };
  });
}

/**
 * Deterministic `FakeTranscriptionProvider` for tests and local/dev verification.
 *
 * Features:
 * - Multiple speakers (`speaker_0`, `speaker_1`, `speaker_2`)
 * - Uzbek (`uz`), Russian (`ru`), English (`en`), and mixed code-switching (`mixed`) segments
 * - Word-level and segment-level timestamps & confidence values
 * - Distributes segments deterministically inside the prepared asset's `timelineMap` pieces
 *   so pause gaps and multi-source/multi-chunk boundaries are respected
 * - Supports custom per-recording/per-meeting fixtures and failure injection for tests
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly providerName = 'fake';
  readonly defaultModel = 'fake-multilingual-diarized-v1';

  private readonly customResults = new Map<string, ProviderTranscriptionResult>();
  private readonly injectedFailures = new Map<
    string,
    { code: TranscriptionProviderError['code']; message: string; retryable: boolean }
  >();
  private callLog: TranscriptionAssetInput[] = [];

  isConfigured(): boolean {
    return true;
  }

  getCallLog(): readonly TranscriptionAssetInput[] {
    return this.callLog;
  }

  setCustomResultForRecording(recordingId: string, result: ProviderTranscriptionResult): void {
    this.customResults.set(recordingId, providerTranscriptionResultSchema.parse(result));
  }

  clearCustomResultForRecording(recordingId: string): void {
    this.customResults.delete(recordingId);
  }

  injectFailureForRecording(
    recordingId: string,
    failure: {
      code?: TranscriptionProviderError['code'];
      message: string;
      retryable?: boolean;
    },
  ): void {
    this.injectedFailures.set(recordingId, {
      code: failure.code ?? 'provider_unavailable',
      message: failure.message,
      retryable: failure.retryable ?? true,
    });
  }

  clearFailureForRecording(recordingId: string): void {
    this.injectedFailures.delete(recordingId);
  }

  async transcribe(input: TranscriptionAssetInput): Promise<ProviderTranscriptionResult> {
    this.callLog.push(input);

    const failure = this.injectedFailures.get(input.recordingId);
    if (failure) {
      throw new TranscriptionProviderError(failure.code, failure.message, failure.retryable);
    }

    const custom = this.customResults.get(input.recordingId);
    if (custom) {
      return custom;
    }

    const pieces = input.timelineMap;
    if (pieces.length === 0 || input.assetDurationMs <= 0) {
      throw new TranscriptionProviderError(
        'provider_invalid_response',
        'Prepared transcription asset has empty timelineMap or non-positive duration.',
        false,
      );
    }

    const segments: ProviderTranscriptSegment[] = [];
    const totalTemplates = DEFAULT_MULTILINGUAL_TEMPLATES.length;

    // Distribute all 12 multilingual utterances proportionally across the asset's timeline pieces
    // so every piece gets realistic coverage without ever crossing a pause/discontinuity boundary.
    const basePerPiece = Math.floor(totalTemplates / pieces.length);
    const remainder = totalTemplates % pieces.length;
    let templateCursor = 0;

    for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
      const piece = pieces[pIdx]!;
      const pieceSpanMs = piece.assetEndMs - piece.assetStartMs;
      const countForPiece =
        pieces.length <= totalTemplates
          ? basePerPiece + (pIdx < remainder ? 1 : 0)
          : pIdx < totalTemplates
            ? 1
            : 0;

      if (countForPiece <= 0 || pieceSpanMs <= 0) continue;

      const slotSpanMs = Math.floor(pieceSpanMs / countForPiece);
      for (let sIdx = 0; sIdx < countForPiece; sIdx++) {
        const template =
          DEFAULT_MULTILINGUAL_TEMPLATES[templateCursor % DEFAULT_MULTILINGUAL_TEMPLATES.length]!;
        const slotStart = piece.assetStartMs + sIdx * slotSpanMs;
        const rawSlotEnd =
          sIdx === countForPiece - 1
            ? piece.assetEndMs
            : piece.assetStartMs + (sIdx + 1) * slotSpanMs;
        // Leave a small natural inter-utterance pause inside the slot when slotSpanMs >= 200ms
        const pausePad = slotSpanMs >= 400 ? 60 : slotSpanMs >= 100 ? 10 : 0;
        const segStart = slotStart;
        const segEnd = Math.max(segStart + 1, rawSlotEnd - pausePad);

        const words = buildDeterministicWordsForSegment({
          text: template.text,
          startMs: segStart,
          endMs: segEnd,
          confidence: template.confidence,
          speakerLabel: template.speakerLabel,
        });

        segments.push({
          providerSegmentKey: `seg_${String(templateCursor).padStart(4, '0')}`,
          speakerLabel: template.speakerLabel,
          startMs: segStart,
          endMs: segEnd,
          text: template.text,
          confidence: template.confidence,
          detectedLanguage: template.language,
          words,
          providerMetadata: {
            piece_index: piece.pieceIndex,
            source_kind: piece.sourceKind,
          },
        });
        templateCursor += 1;
      }
    }

    return providerTranscriptionResultSchema.parse({
      provider: this.providerName,
      providerModel: this.defaultModel,
      providerJobId: `fake-job-${input.recordingId}-v${input.assetVersion}`,
      detectedLanguages: ['uz', 'ru', 'en', 'mixed'],
      durationMs: input.assetDurationMs,
      segments,
      providerMetadata: {
        deterministic_fixture: true,
        asset_version: input.assetVersion,
        piece_count: pieces.length,
      },
    });
  }
}

export type AssemblyAIProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
};

type RawAssemblyAIWord = {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
  speaker?: unknown;
};

type RawAssemblyAIUtterance = {
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
  confidence?: unknown;
  language_code?: unknown;
  words?: unknown;
};

type RawAssemblyAITranscript = {
  id?: unknown;
  status?: unknown;
  audio_duration?: unknown;
  language_code?: unknown;
  language_codes?: unknown;
  utterances?: unknown;
  words?: unknown;
  text?: unknown;
  error?: unknown;
};

function mapAssemblyAISpeakerLabel(rawSpeaker: unknown): string {
  if (typeof rawSpeaker !== 'string' || !rawSpeaker.trim()) {
    return 'speaker_0';
  }
  const trimmed = rawSpeaker.trim();
  if (/^speaker_[0-9]+$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  // AssemblyAI commonly uses "A", "B", "C", ... or "0", "1", "2"
  if (/^[A-Z]$/i.test(trimmed)) {
    const idx = trimmed.toUpperCase().charCodeAt(0) - 65;
    return `speaker_${idx}`;
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return `speaker_${trimmed}`;
  }
  return `speaker_${trimmed.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}`;
}

function detectLanguageFromTextOrCode(rawLang: unknown, text: string): DetectedSegmentLanguage {
  if (typeof rawLang === 'string') {
    const code = rawLang.trim().toLowerCase();
    if (code.startsWith('uz')) return 'uz';
    if (code.startsWith('ru')) return 'ru';
    if (code.startsWith('en')) return 'en';
    if (code === 'mixed') return 'mixed';
  }
  const hasCyrillic = /[а-яёўқғҳ]/i.test(text);
  const hasLatin = /[a-z]/i.test(text);
  const hasUzbekLatinMarkers =
    /\b(bo'yicha|uchun|bilan|va|lekin|shart|rahmat|assalomu|alaykum)\b|o'|g'/i.test(text);
  if (hasCyrillic && hasLatin) {
    return 'mixed';
  }
  if (hasUzbekLatinMarkers) {
    return 'uz';
  }
  if (hasCyrillic) {
    return 'ru';
  }
  if (hasLatin) {
    return 'en';
  }
  return 'unknown';
}

/**
 * Normalizes an AssemblyAI transcript payload into Suhbat's provider-neutral `ProviderTranscriptionResult`.
 * Never leaks raw AssemblyAI response objects or signed audio URLs into domain code.
 */
export function normalizeAssemblyAITranscriptResponse(
  rawPayload: unknown,
  options: { model?: string } = {},
): ProviderTranscriptionResult {
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new TranscriptionProviderError(
      'provider_invalid_response',
      'AssemblyAI response payload is not an object.',
      false,
    );
  }
  const raw = rawPayload as RawAssemblyAITranscript;
  const providerJobId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  if (!providerJobId) {
    throw new TranscriptionProviderError(
      'provider_invalid_response',
      'AssemblyAI response is missing transcript id.',
      false,
    );
  }

  if (raw.status === 'error') {
    const errMsg =
      typeof raw.error === 'string' && raw.error.trim()
        ? raw.error.trim()
        : 'AssemblyAI reported transcription status=error.';
    throw new TranscriptionProviderError('provider_transcription_failed', errMsg, false);
  }

  const rawUtterances = Array.isArray(raw.utterances)
    ? (raw.utterances as RawAssemblyAIUtterance[])
    : [];

  const speakerOrder = new Map<string, string>();
  const resolveCanonicalSpeaker = (rawSpeaker: unknown): string => {
    const candidate = mapAssemblyAISpeakerLabel(rawSpeaker);
    if (/^speaker_[0-9]+$/.test(candidate)) {
      return candidate;
    }
    const existing = speakerOrder.get(candidate);
    if (existing) return existing;
    const assigned = `speaker_${speakerOrder.size}`;
    speakerOrder.set(candidate, assigned);
    return assigned;
  };

  const segments: ProviderTranscriptSegment[] = [];
  const detectedLangSet = new Set<DetectedSegmentLanguage>();

  if (rawUtterances.length > 0) {
    for (let i = 0; i < rawUtterances.length; i++) {
      const utt = rawUtterances[i]!;
      const text = typeof utt.text === 'string' ? utt.text.trim() : '';
      if (!text) continue;

      const startMs = typeof utt.start === 'number' ? Math.trunc(utt.start) : Number.NaN;
      const endMs = typeof utt.end === 'number' ? Math.trunc(utt.end) : Number.NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new TranscriptionProviderError(
          'provider_invalid_response',
          `AssemblyAI utterance ${i} has non-numeric start/end timestamps.`,
          false,
        );
      }

      const speakerLabel = resolveCanonicalSpeaker(utt.speaker);
      const confidence =
        typeof utt.confidence === 'number' && utt.confidence >= 0 && utt.confidence <= 1
          ? utt.confidence
          : null;
      const detectedLanguage = detectLanguageFromTextOrCode(
        utt.language_code ?? raw.language_code,
        text,
      );
      if (detectedLanguage !== 'unknown') {
        detectedLangSet.add(detectedLanguage);
      }

      const rawWords = Array.isArray(utt.words) ? (utt.words as RawAssemblyAIWord[]) : [];
      const words: ProviderTranscriptWord[] = [];
      for (const rw of rawWords) {
        if (
          typeof rw.text === 'string' &&
          rw.text.trim() &&
          typeof rw.start === 'number' &&
          typeof rw.end === 'number'
        ) {
          words.push({
            text: rw.text.trim(),
            startMs: Math.trunc(rw.start),
            endMs: Math.trunc(rw.end),
            confidence:
              typeof rw.confidence === 'number' && rw.confidence >= 0 && rw.confidence <= 1
                ? rw.confidence
                : null,
            speakerLabel: rw.speaker ? resolveCanonicalSpeaker(rw.speaker) : speakerLabel,
          });
        }
      }

      segments.push({
        providerSegmentKey: `aai_utt_${String(i).padStart(4, '0')}`,
        speakerLabel,
        startMs,
        endMs,
        text,
        confidence,
        detectedLanguage,
        words,
        providerMetadata: {
          utterance_index: i,
        },
      });
    }
  } else if (typeof raw.text === 'string' && raw.text.trim() && Array.isArray(raw.words)) {
    const rawWords = raw.words as RawAssemblyAIWord[];
    if (rawWords.length > 0) {
      const firstWord = rawWords[0]!;
      const lastWord = rawWords[rawWords.length - 1]!;
      const startMs = typeof firstWord.start === 'number' ? Math.trunc(firstWord.start) : 0;
      const endMs = typeof lastWord.end === 'number' ? Math.trunc(lastWord.end) : startMs + 1;
      const text = raw.text.trim();
      const detectedLanguage = detectLanguageFromTextOrCode(raw.language_code, text);
      if (detectedLanguage !== 'unknown') {
        detectedLangSet.add(detectedLanguage);
      }
      segments.push({
        providerSegmentKey: 'aai_utt_0000',
        speakerLabel: 'speaker_0',
        startMs,
        endMs,
        text,
        confidence: null,
        detectedLanguage,
        words: [],
        providerMetadata: {
          utterance_index: 0,
        },
      });
    }
  }

  const durationMs =
    typeof raw.audio_duration === 'number' && raw.audio_duration > 0
      ? Math.round(raw.audio_duration * 1000)
      : null;

  return providerTranscriptionResultSchema.parse({
    provider: 'assemblyai',
    providerModel: options.model ?? 'universal-2',
    providerJobId,
    detectedLanguages: [...detectedLangSet],
    durationMs,
    segments,
    providerMetadata: {
      utterance_count: segments.length,
    },
  });
}

/**
 * Production-shaped AssemblyAI transcription provider adapter.
 *
 * - Compiles without credentials.
 * - Remains disabled unless explicitly configured with `apiKey`.
 * - Fails clearly with `provider_not_configured` when invoked without configuration.
 * - Normalizes AssemblyAI responses into Suhbat's provider-neutral contract.
 * - Never logs or exposes API keys or signed audio URLs.
 */
export class AssemblyAITranscriptionProvider implements TranscriptionProvider {
  readonly providerName = 'assemblyai';
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AssemblyAIProviderConfig = {}, options: { fetchImpl?: typeof fetch } = {}) {
    this.apiKey = (config.apiKey ?? '').trim();
    this.baseUrl = (config.baseUrl?.trim() || 'https://api.assemblyai.com').replace(/\/+$/, '');
    this.defaultModel = config.model?.trim() || 'universal-2';
    this.pollIntervalMs = Math.max(config.pollIntervalMs ?? 1500, 10);
    this.maxPollAttempts = Math.max(config.maxPollAttempts ?? 60, 1);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(input: TranscriptionAssetInput): Promise<ProviderTranscriptionResult> {
    if (!this.isConfigured()) {
      throw new TranscriptionProviderError(
        'provider_not_configured',
        'AssemblyAI transcription provider is not configured: ASSEMBLYAI_API_KEY is missing.',
        false,
      );
    }

    if (!input.signedAudioUrl) {
      throw new TranscriptionProviderError(
        'provider_invalid_response',
        'AssemblyAI transcription provider requires a signed private audio read URL.',
        false,
      );
    }

    const parsedBase = new URL(this.baseUrl);
    if (parsedBase.protocol !== 'https:') {
      throw new TranscriptionProviderError(
        'provider_not_configured',
        'AssemblyAI baseUrl must use HTTPS.',
        false,
      );
    }

    let createResponse: Response;
    try {
      createResponse = await this.fetchImpl(`${this.baseUrl}/v2/transcript`, {
        method: 'POST',
        headers: {
          authorization: this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          audio_url: input.signedAudioUrl,
          speech_model: this.defaultModel,
          speaker_labels: true,
          language_detection: true,
        }),
      });
    } catch {
      throw new TranscriptionProviderError(
        'provider_unavailable',
        'AssemblyAI transcript submission failed due to a network transport error.',
        true,
      );
    }

    if (!createResponse.ok) {
      const retryable = createResponse.status >= 500 || createResponse.status === 429;
      throw new TranscriptionProviderError(
        'provider_unavailable',
        `AssemblyAI transcript submission failed with HTTP ${createResponse.status}.`,
        retryable,
      );
    }

    const createdPayload = (await createResponse.json()) as RawAssemblyAITranscript;
    const transcriptId = typeof createdPayload?.id === 'string' ? createdPayload.id.trim() : '';
    if (!transcriptId) {
      throw new TranscriptionProviderError(
        'provider_invalid_response',
        'AssemblyAI submission did not return a transcript id.',
        false,
      );
    }

    if (createdPayload.status === 'completed') {
      return normalizeAssemblyAITranscriptResponse(createdPayload, {
        model: this.defaultModel,
      });
    }

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      let pollResponse: Response;
      try {
        pollResponse = await this.fetchImpl(
          `${this.baseUrl}/v2/transcript/${encodeURIComponent(transcriptId)}`,
          {
            method: 'GET',
            headers: {
              authorization: this.apiKey,
            },
          },
        );
      } catch {
        throw new TranscriptionProviderError(
          'provider_unavailable',
          'AssemblyAI transcript polling failed due to a network transport error.',
          true,
        );
      }

      if (!pollResponse.ok) {
        const retryable = pollResponse.status >= 500 || pollResponse.status === 429;
        throw new TranscriptionProviderError(
          'provider_unavailable',
          `AssemblyAI transcript polling failed with HTTP ${pollResponse.status}.`,
          retryable,
        );
      }

      const pollPayload = (await pollResponse.json()) as RawAssemblyAITranscript;
      if (pollPayload.status === 'completed' || pollPayload.status === 'error') {
        return normalizeAssemblyAITranscriptResponse(pollPayload, {
          model: this.defaultModel,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new TranscriptionProviderError(
      'provider_unavailable',
      `AssemblyAI transcript ${transcriptId} timed out after ${this.maxPollAttempts} polling attempts.`,
      true,
    );
  }
}

/**
 * Resolves a `TranscriptionProvider` from environment variables.
 * Never silently falls back from `'assemblyai'` to `'fake'`.
 */
export function createTranscriptionProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): TranscriptionProvider {
  const providerChoice = (env.TRANSCRIPTION_PROVIDER ?? '').trim().toLowerCase();
  const isProd = env.NODE_ENV === 'production';

  if (providerChoice === 'assemblyai' || (isProd && !providerChoice)) {
    if (isProd && !env.ASSEMBLYAI_API_KEY?.trim()) {
      throw new TranscriptionProviderError(
        'provider_not_configured',
        'AssemblyAITranscriptionProvider requires ASSEMBLYAI_API_KEY in production.',
        false,
      );
    }
    return new AssemblyAITranscriptionProvider({
      apiKey: env.ASSEMBLYAI_API_KEY,
      baseUrl: env.ASSEMBLYAI_BASE_URL,
      model: env.ASSEMBLYAI_MODEL ?? env.ASSEMBLYAI_TRANSCRIPTION_MODEL,
    });
  }

  if (providerChoice === 'fake' && !isProd) {
    return new FakeTranscriptionProvider();
  }

  if (providerChoice === 'fake' && isProd) {
    throw new TranscriptionProviderError(
      'provider_not_configured',
      'FakeTranscriptionProvider is not permitted in production.',
      false,
    );
  }

  // When no provider is configured in non-production, return an unconfigured AssemblyAI provider
  // so accidental live invocation fails closed with `provider_not_configured` rather than silently using fake data.
  return new AssemblyAITranscriptionProvider({
    apiKey: env.ASSEMBLYAI_API_KEY,
  });
}
