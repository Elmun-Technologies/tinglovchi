import 'server-only';
import { AnalysisError, analyzeTranscript } from './analyze';
import { readAudio, readSession, updateSession } from './store';
import { TranscriptionError, transcribe, transcriptionCostPerHourUsd } from './transcribe';
import type { Session, SpeakerStat, Transcript } from './types';

/**
 * Runs a session from uploaded audio to a finished analysis, in the web process itself.
 *
 * The progress lives in `session.json`, so a restart loses nothing: the next status request for an unfinished
 * session (`ensureProcessing`) picks it up where it stopped, and a saved provider job id is polled instead of
 * transcribed again.
 */

const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

const inFlight = new Set<string>();

export function speakerStats(transcript: Transcript): SpeakerStat[] {
  const bySpeaker = new Map<string, { talkMs: number; turns: number }>();
  for (const utterance of transcript.utterances) {
    const entry = bySpeaker.get(utterance.speaker) ?? { talkMs: 0, turns: 0 };
    entry.talkMs += Math.max(0, utterance.endMs - utterance.startMs);
    entry.turns += 1;
    bySpeaker.set(utterance.speaker, entry);
  }
  const total = [...bySpeaker.values()].reduce((sum, entry) => sum + entry.talkMs, 0);
  return [...bySpeaker.entries()]
    .map(([speaker, entry]) => ({
      speaker,
      talkMs: entry.talkMs,
      turns: entry.turns,
      share: total > 0 ? entry.talkMs / total : 0,
    }))
    .sort((a, b) => b.talkMs - a.talkMs);
}

export function isUnfinished(session: Session): boolean {
  return (
    session.status === 'uploaded' ||
    session.status === 'transcribing' ||
    session.status === 'analyzing'
  );
}

/** Starts processing in the background unless this process is already working on the session. */
export function ensureProcessing(session: Session): void {
  if (!isUnfinished(session) || inFlight.has(session.id)) return;
  inFlight.add(session.id);
  void run(session.id).finally(() => inFlight.delete(session.id));
}

/** Puts a failed session back in the queue, keeping whatever finished before the failure. */
export async function retrySession(id: string): Promise<Session | null> {
  const session = await readSession(id);
  if (!session || session.status !== 'failed') return session;
  const restarted = await updateSession(id, (current) => ({
    status: current.transcript ? 'analyzing' : 'uploaded',
    error: null,
    attempts: 0,
  }));
  ensureProcessing(restarted);
  return restarted;
}

async function run(id: string): Promise<void> {
  await advance(id);
  // Only a run that did work reports its outcome, so reopening a finished session never re-sends it.
  const finished = await readSession(id);
  if (finished && !isUnfinished(finished)) {
    // Imported lazily: the Telegram module itself starts processing for sessions it receives.
    const { notifySessionFinished } = await import('./telegram');
    await notifySessionFinished(finished);
  }
}

async function advance(id: string): Promise<void> {
  for (;;) {
    const session = await readSession(id);
    if (!session || !isUnfinished(session)) return;
    try {
      await step(session);
    } catch (cause) {
      const retryable =
        cause instanceof TranscriptionError || cause instanceof AnalysisError
          ? cause.retryable
          : true;
      const message = cause instanceof Error ? cause.message : String(cause);
      const failed = await updateSession(id, (current) => ({
        attempts: current.attempts + 1,
        error: message,
      }));
      console.error(`[suhbat] session ${id} step failed (attempt ${failed.attempts}): ${message}`);
      if (!retryable || failed.attempts >= MAX_AUTOMATIC_ATTEMPTS) {
        await updateSession(id, () => ({ status: 'failed' }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function step(session: Session): Promise<void> {
  if (session.status === 'uploaded' || session.status === 'transcribing') {
    if (session.status === 'uploaded') {
      await updateSession(session.id, () => ({ status: 'transcribing' }));
    }
    const audio = await readAudio(session);
    const transcript = await transcribe(audio, session.audioMimeType, {
      resumeJobId: session.providerJobId,
      onSubmitted: async (jobId) => {
        await updateSession(session.id, () => ({ providerJobId: jobId }));
      },
    });
    if (transcript.durationMs === 0) transcript.durationMs = session.recordedMs;
    const audioSeconds = transcript.durationMs / 1000;
    const perHour = transcriptionCostPerHourUsd(transcript.provider);
    await updateSession(session.id, (current) => ({
      transcript,
      // An uploaded file's length is only known once it has been transcribed.
      recordedMs: current.recordedMs || transcript.durationMs,
      usage: {
        audioSeconds,
        transcriptionProvider: transcript.provider,
        transcriptionCostUsd: perHour === null ? null : (audioSeconds / 3600) * perHour,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        analysisCostUsd: null,
      },
      speakerStats: speakerStats(transcript),
      status: 'analyzing',
      attempts: 0,
      error: null,
    }));
    return;
  }

  if (session.status === 'analyzing') {
    if (!session.transcript) {
      await updateSession(session.id, () => ({ status: 'uploaded' }));
      return;
    }
    const result = await analyzeTranscript(
      session.transcript,
      session.speakerStats,
      session.language,
    );
    await updateSession(session.id, (current) => ({
      analysis: result.analysis,
      title: current.title || result.analysis.title,
      usage: {
        audioSeconds: current.usage?.audioSeconds ?? current.transcript!.durationMs / 1000,
        transcriptionProvider: current.usage?.transcriptionProvider ?? current.transcript!.provider,
        transcriptionCostUsd: current.usage?.transcriptionCostUsd ?? null,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        analysisCostUsd: result.costUsd,
      },
      status: 'ready',
      attempts: 0,
      error: null,
    }));
  }
}
