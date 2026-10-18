import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => cookieJar.set(name, value),
  }),
}));

const { createSession, listSessions, readSession, updateSession } =
  await import('../../apps/web/src/lib/quick/store');
const { ensureProcessing, retrySession, speakerStats } =
  await import('../../apps/web/src/lib/quick/pipeline');
const { groupWords, speakerLetter, transcribe } =
  await import('../../apps/web/src/lib/quick/transcribe');
const { transcriptForPrompt } = await import('../../apps/web/src/lib/quick/analyze');
const { accessState, grantAccess } = await import('../../apps/web/src/lib/quick/access');
const { formatDuration, formatTimestamp } = await import('../../apps/web/src/lib/quick/format');

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'suhbat-quick-'));
  vi.stubEnv('SUHBAT_DATA_DIR', dataDir);
  cookieJar.clear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
});

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

const audio = new Uint8Array([1, 2, 3, 4]);

describe('one-button flow pipeline', () => {
  it('takes an uploaded recording to a finished analysis', async () => {
    vi.stubEnv('SUHBAT_FAKE_AI', '1');
    const session = await createSession({
      audio,
      mimeType: 'audio/webm;codecs=opus',
      recordedMs: 61_000,
      title: null,
    });
    expect(session.status).toBe('uploaded');
    expect(session.audioMimeType).toBe('audio/webm');

    ensureProcessing(session);
    const done = await waitFor(
      () => readSession(session.id),
      (current) => current?.status === 'ready' || current?.status === 'failed',
    );

    expect(done?.status).toBe('ready');
    expect(done?.transcript?.utterances.length).toBeGreaterThan(0);
    expect(done?.speakerStats.map((stat) => stat.speaker).sort()).toEqual(['A', 'B']);
    expect(done?.analysis?.slides.length).toBeGreaterThan(0);
    // The model's title fills in only when the user gave none.
    expect(done?.title).toBe(done?.analysis?.title);
    expect((await listSessions()).map((entry) => entry.id)).toEqual([session.id]);
  });

  it('rejects an unknown audio type and an invalid id', async () => {
    await expect(
      createSession({ audio, mimeType: 'video/quicktime', recordedMs: 0, title: null }),
    ).rejects.toThrow(/Unsupported audio type/);
    expect(await readSession('../../etc/passwd')).toBeNull();
  });

  it('marks a non-retryable failure as failed and resumes from the saved transcript on retry', async () => {
    vi.stubEnv('TRANSCRIPTION_PROVIDER', 'assemblyai');
    vi.stubEnv('ASSEMBLYAI_API_KEY', '');
    const session = await createSession({
      audio,
      mimeType: 'audio/webm',
      recordedMs: 0,
      title: 'X',
    });
    ensureProcessing(session);
    const failed = await waitFor(
      () => readSession(session.id),
      (current) => current?.status === 'failed',
    );
    expect(failed?.error).toMatch(/ASSEMBLYAI_API_KEY/);

    // Pretend transcription had finished: a retry must go straight to analysis.
    await updateSession(session.id, () => ({
      transcript: { provider: 'test', languageCode: 'uz', durationMs: 1000, utterances: [] },
    }));
    vi.stubEnv('SUHBAT_FAKE_AI', '1');
    const restarted = await retrySession(session.id);
    expect(restarted?.status).toBe('analyzing');
    const ready = await waitFor(
      () => readSession(session.id),
      (current) => current?.status === 'ready',
    );
    expect(ready?.title).toBe('X');
  });
});

describe('AssemblyAI transcription', () => {
  it('uploads, submits with diarization, saves the job id and maps utterances', async () => {
    vi.stubEnv('TRANSCRIPTION_PROVIDER', 'assemblyai');
    vi.stubEnv('ASSEMBLYAI_API_KEY', 'key');
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body });
        if (url.endsWith('/v2/upload')) return Response.json({ upload_url: 'https://cdn/u' });
        if (url.endsWith('/v2/transcript')) return Response.json({ id: 'job-1', status: 'queued' });
        return Response.json({
          id: 'job-1',
          status: 'completed',
          language_code: 'uz',
          audio_duration: 12.5,
          utterances: [
            { speaker: 'A', start: 0, end: 4000, text: ' Salom ' },
            { speaker: 'B', start: 4200, end: 9000, text: 'Assalomu alaykum' },
          ],
        });
      }),
    );
    const submitted: string[] = [];
    const transcript = await transcribe(Buffer.from(audio), 'audio/webm', {
      resumeJobId: null,
      onSubmitted: async (jobId) => {
        submitted.push(jobId);
      },
    });

    expect(submitted).toEqual(['job-1']);
    const submitBody = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(submitBody).toMatchObject({
      audio_url: 'https://cdn/u',
      speaker_labels: true,
      language_detection: true,
    });
    expect(transcript).toEqual({
      provider: 'assemblyai',
      languageCode: 'uz',
      durationMs: 12_500,
      utterances: [
        { speaker: 'A', startMs: 0, endMs: 4000, text: 'Salom' },
        { speaker: 'B', startMs: 4200, endMs: 9000, text: 'Assalomu alaykum' },
      ],
    });
  });

  it('polls a saved job instead of paying for a new transcript', async () => {
    vi.stubEnv('ASSEMBLYAI_API_KEY', 'key');
    const fetchMock = vi.fn(async () =>
      Response.json({ status: 'completed', audio_duration: 1, utterances: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await transcribe(Buffer.from(audio), 'audio/webm', {
      resumeJobId: 'job-9',
      onSubmitted: async () => undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/v2\/transcript\/job-9$/);
  });

  it('reports a provider error as non-retryable and a 5xx as retryable', async () => {
    vi.stubEnv('ASSEMBLYAI_API_KEY', 'key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'error', error: 'bad audio' })),
    );
    await expect(
      transcribe(Buffer.from(audio), 'audio/webm', {
        resumeJobId: 'j',
        onSubmitted: async () => {},
      }),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/bad audio/) });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    await expect(
      transcribe(Buffer.from(audio), 'audio/webm', {
        resumeJobId: 'j',
        onSubmitted: async () => {},
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('transcript helpers', () => {
  it('groups words into utterances per speaker and splits on long silence', () => {
    expect(
      groupWords([
        { speaker: 'A', startMs: 0, endMs: 300, text: 'Salom' },
        { speaker: 'A', startMs: 350, endMs: 700, text: 'dunyo' },
        { speaker: 'B', startMs: 900, endMs: 1200, text: 'Ha' },
        { speaker: 'B', startMs: 5000, endMs: 5400, text: 'Yana' },
      ]),
    ).toEqual([
      { speaker: 'A', startMs: 0, endMs: 700, text: 'Salom dunyo' },
      { speaker: 'B', startMs: 900, endMs: 1200, text: 'Ha' },
      { speaker: 'B', startMs: 5000, endMs: 5400, text: 'Yana' },
    ]);
  });

  it('labels diarized speakers with letters', () => {
    expect(speakerLetter('speaker_0')).toBe('A');
    expect(speakerLetter('speaker_2')).toBe('C');
    expect(speakerLetter(undefined)).toBe('A');
  });

  it('computes talk time and share per speaker', () => {
    const stats = speakerStats({
      provider: 't',
      languageCode: null,
      durationMs: 10_000,
      utterances: [
        { speaker: 'A', startMs: 0, endMs: 3000, text: 'a' },
        { speaker: 'B', startMs: 3000, endMs: 4000, text: 'b' },
        { speaker: 'A', startMs: 4000, endMs: 5000, text: 'c' },
      ],
    });
    expect(stats).toEqual([
      { speaker: 'A', talkMs: 4000, turns: 2, share: 0.8 },
      { speaker: 'B', talkMs: 1000, turns: 1, share: 0.2 },
    ]);
  });

  it('formats the prompt transcript with timestamps and speakers', () => {
    const transcript = {
      provider: 't',
      languageCode: 'uz',
      durationMs: 3_725_000,
      utterances: [{ speaker: 'A', startMs: 3_600_000, endMs: 3_610_000, text: 'Xayr' }],
    };
    const prompt = transcriptForPrompt(transcript, speakerStats(transcript));
    expect(prompt).toContain('Davomiyligi: 1:02:05');
    expect(prompt).toContain('[1:00:00] A: Xayr');
    expect(prompt).toContain('A (100%)');
  });

  it('formats durations in Uzbek', () => {
    expect(formatTimestamp(65_000)).toBe('01:05');
    expect(formatDuration(40_000)).toBe('40 soniya');
    expect(formatDuration(65 * 60_000)).toBe('1 soat 5 daqiqa');
  });
});

describe('access code', () => {
  it('is open in development without a code and closed in production', async () => {
    vi.stubEnv('SUHBAT_ACCESS_CODE', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(await accessState()).toBe('open');
    vi.stubEnv('NODE_ENV', 'production');
    expect(await accessState()).toBe('not_configured');
  });

  it('grants access only for the right code and stores no plain code in the cookie', async () => {
    vi.stubEnv('SUHBAT_ACCESS_CODE', 'maxfiy-kod');
    expect(await accessState()).toBe('required');
    expect(await grantAccess('xato')).toBe(false);
    expect(await accessState()).toBe('required');
    expect(await grantAccess('maxfiy-kod')).toBe(true);
    expect(await accessState()).toBe('granted');
    expect([...cookieJar.values()].join()).not.toContain('maxfiy-kod');
  });

  it('refuses the fake AI mode in production', async () => {
    vi.stubEnv('SUHBAT_FAKE_AI', '1');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      transcribe(Buffer.from(audio), 'audio/webm', {
        resumeJobId: null,
        onSubmitted: async () => {},
      }),
    ).rejects.toThrow(/not allowed in production/);
  });
});
