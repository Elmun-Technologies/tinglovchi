import 'server-only';
import type { Transcript, Utterance } from './types';

/**
 * Speech-to-text for the one-button flow. Two real providers, picked by `TRANSCRIPTION_PROVIDER`:
 *
 * - `assemblyai` (default) — `ASSEMBLYAI_API_KEY`. Async job: upload, submit, poll.
 * - `elevenlabs` — `ELEVENLABS_API_KEY`. One synchronous request (Scribe).
 *
 * Both are asked for speaker diarization and automatic language detection, which is what a mixed
 * Uzbek/Russian meeting needs. `SUHBAT_FAKE_AI=1` swaps in a canned transcript for local UI work; it is
 * refused in production so a missing key can never quietly produce invented conversations.
 */

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export type TranscribeOptions = {
  /** A provider job id saved from an earlier attempt; polled instead of paying for a new transcript. */
  resumeJobId: string | null;
  /** Called as soon as the provider accepts the job, so the id survives a process restart. */
  onSubmitted: (jobId: string) => Promise<void>;
};

export type TranscriptionProviderName = 'assemblyai' | 'elevenlabs' | 'fake';

export function fakeAiEnabled(): boolean {
  if (process.env.SUHBAT_FAKE_AI !== '1') return false;
  if (process.env.NODE_ENV === 'production') {
    throw new TranscriptionError('SUHBAT_FAKE_AI=1 is not allowed in production.', false);
  }
  return true;
}

export function transcriptionProviderName(): TranscriptionProviderName {
  if (fakeAiEnabled()) return 'fake';
  const name = (process.env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase() || 'assemblyai') as string;
  if (name === 'assemblyai' || name === 'elevenlabs') return name;
  throw new TranscriptionError(
    `TRANSCRIPTION_PROVIDER must be "assemblyai" or "elevenlabs", got "${name}".`,
    false,
  );
}

/** Which keys are missing for the configured provider; empty when transcription can run. */
export function missingTranscriptionConfig(): string[] {
  const name = transcriptionProviderName();
  if (name === 'assemblyai' && !process.env.ASSEMBLYAI_API_KEY?.trim())
    return ['ASSEMBLYAI_API_KEY'];
  if (name === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY?.trim())
    return ['ELEVENLABS_API_KEY'];
  return [];
}

export async function transcribe(
  audio: Buffer,
  mimeType: string,
  options: TranscribeOptions,
): Promise<Transcript> {
  const name = transcriptionProviderName();
  if (name === 'fake') return fakeTranscript();
  if (name === 'elevenlabs') return transcribeWithElevenLabs(audio, mimeType);
  return transcribeWithAssemblyAI(audio, options);
}

/**
 * List price per audio hour, used only to estimate what a conversation cost: AssemblyAI's base model plus
 * speaker labels, and ElevenLabs Scribe. New AssemblyAI accounts start with free credit.
 */
export function transcriptionCostPerHourUsd(provider: string): number | null {
  if (provider === 'assemblyai') return 0.23;
  if (provider === 'elevenlabs') return 0.22;
  if (provider === 'fake') return 0;
  return null;
}

/* ------------------------------------------------------------------ helpers */

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new TranscriptionError(`Transcription request failed: ${reason}`, true);
  }
}

async function failOnHttpError(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const body = (await response.text().catch(() => '')).slice(0, 300);
  throw new TranscriptionError(
    `${what} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`,
    response.status === 429 || response.status >= 500,
  );
}

/** Joins consecutive words from the same speaker into utterances. */
export function groupWords(
  words: Array<{ speaker: string; startMs: number; endMs: number; text: string }>,
): Utterance[] {
  const utterances: Utterance[] = [];
  for (const word of words) {
    const last = utterances.at(-1);
    // A long silence starts a new line even for the same speaker, so the transcript stays readable.
    if (last && last.speaker === word.speaker && word.startMs - last.endMs < 2_000) {
      last.text = `${last.text} ${word.text}`.replace(/\s+/g, ' ');
      last.endMs = Math.max(last.endMs, word.endMs);
    } else {
      utterances.push({ ...word, text: word.text.trim() });
    }
  }
  return utterances.filter((utterance) => utterance.text.length > 0);
}

/* --------------------------------------------------------------- AssemblyAI */

type AssemblyAITranscript = {
  id?: string;
  status?: string;
  error?: string;
  language_code?: string;
  audio_duration?: number;
  utterances?: Array<{ speaker?: string; start?: number; end?: number; text?: string }> | null;
};

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com';
const ASSEMBLYAI_POLL_MS = 5_000;
// Long meetings queue and process for a while; 90 minutes covers multi-hour recordings.
const ASSEMBLYAI_MAX_WAIT_MS = 90 * 60_000;

async function transcribeWithAssemblyAI(
  audio: Buffer,
  options: TranscribeOptions,
): Promise<Transcript> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) throw new TranscriptionError('ASSEMBLYAI_API_KEY is not set.', false);

  let jobId = options.resumeJobId;
  if (!jobId) {
    const upload = await request(
      `${ASSEMBLYAI_BASE}/v2/upload`,
      {
        method: 'POST',
        headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(audio),
      },
      10 * 60_000,
    );
    await failOnHttpError(upload, 'AssemblyAI upload');
    const { upload_url: uploadUrl } = (await upload.json()) as { upload_url?: string };
    if (!uploadUrl) throw new TranscriptionError('AssemblyAI upload returned no URL.', true);

    const speechModel = process.env.ASSEMBLYAI_SPEECH_MODEL?.trim();
    const submit = await request(
      `${ASSEMBLYAI_BASE}/v2/transcript`,
      {
        method: 'POST',
        headers: { authorization: apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          audio_url: uploadUrl,
          speaker_labels: true,
          language_detection: true,
          ...(speechModel ? { speech_model: speechModel } : {}),
        }),
      },
      60_000,
    );
    await failOnHttpError(submit, 'AssemblyAI submit');
    const created = (await submit.json()) as AssemblyAITranscript;
    if (!created.id) throw new TranscriptionError('AssemblyAI returned no transcript id.', true);
    jobId = created.id;
    await options.onSubmitted(jobId);
  }

  const deadline = Date.now() + ASSEMBLYAI_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const poll = await request(
      `${ASSEMBLYAI_BASE}/v2/transcript/${encodeURIComponent(jobId)}`,
      { headers: { authorization: apiKey } },
      60_000,
    );
    await failOnHttpError(poll, 'AssemblyAI poll');
    const payload = (await poll.json()) as AssemblyAITranscript;
    if (payload.status === 'error') {
      throw new TranscriptionError(`AssemblyAI: ${payload.error ?? 'transcription failed'}`, false);
    }
    if (payload.status === 'completed') {
      const utterances = (payload.utterances ?? []).map((utterance) => ({
        speaker: utterance.speaker ?? 'A',
        startMs: utterance.start ?? 0,
        endMs: utterance.end ?? utterance.start ?? 0,
        text: (utterance.text ?? '').trim(),
      }));
      return {
        provider: 'assemblyai',
        languageCode: payload.language_code ?? null,
        durationMs: Math.round((payload.audio_duration ?? 0) * 1000),
        utterances: utterances.filter((utterance) => utterance.text.length > 0),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, ASSEMBLYAI_POLL_MS));
  }
  throw new TranscriptionError(`AssemblyAI transcript ${jobId} is still processing.`, true);
}

/* --------------------------------------------------------------- ElevenLabs */

type ElevenLabsResponse = {
  language_code?: string;
  words?: Array<{
    text?: string;
    start?: number;
    end?: number;
    type?: string;
    speaker_id?: string;
  }>;
};

async function transcribeWithElevenLabs(audio: Buffer, mimeType: string): Promise<Transcript> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) throw new TranscriptionError('ELEVENLABS_API_KEY is not set.', false);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'audio');
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL?.trim() || 'scribe_v1');
  form.append('diarize', 'true');
  form.append('tag_audio_events', 'false');

  const response = await request(
    'https://api.elevenlabs.io/v1/speech-to-text',
    { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
    60 * 60_000,
  );
  await failOnHttpError(response, 'ElevenLabs transcription');
  const payload = (await response.json()) as ElevenLabsResponse;

  const words = (payload.words ?? [])
    .filter((word) => word.type === 'word' && word.text)
    .map((word) => ({
      speaker: speakerLetter(word.speaker_id),
      startMs: Math.round((word.start ?? 0) * 1000),
      endMs: Math.round((word.end ?? word.start ?? 0) * 1000),
      text: word.text!,
    }));
  const utterances = groupWords(words);
  return {
    provider: 'elevenlabs',
    languageCode: payload.language_code ?? null,
    durationMs: utterances.at(-1)?.endMs ?? 0,
    utterances,
  };
}

/** `speaker_0` → `A`, so both providers label speakers the same way. */
export function speakerLetter(speakerId: string | undefined): string {
  const index = Number(/(\d+)$/.exec(speakerId ?? '')?.[1] ?? 0);
  return index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}`;
}

/* --------------------------------------------------------------------- fake */

function fakeTranscript(): Transcript {
  const lines: Array<[string, string]> = [
    ['A', 'Assalomu alaykum, bugun yangi kampaniya bo‘yicha gaplashamiz.'],
    ['B', 'Va alaykum assalom. Bizga Instagram va Telegram orqali sotuvni oshirish kerak.'],
    ['A', 'Byudjet qancha va qachongacha natija kutyapsiz?'],
    ['B', 'Oyiga taxminan 20 million so‘m, birinchi natijani bir oyda ko‘rmoqchimiz.'],
    ['A', 'Unda birinchi haftada kontent-reja va target sozlamalarini tayyorlaymiz.'],
    ['B', 'Yaxshi, juma kunigacha taklifni yuboring.'],
  ];
  let cursor = 0;
  const utterances = lines.map(([speaker, text]) => {
    const durationMs = text.length * 70;
    const utterance = { speaker, startMs: cursor, endMs: cursor + durationMs, text };
    cursor += durationMs + 400;
    return utterance;
  });
  return { provider: 'fake', languageCode: 'uz', durationMs: cursor, utterances };
}
