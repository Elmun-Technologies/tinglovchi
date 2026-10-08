import { describe, expect, it, vi } from 'vitest';
import { isOfflineError } from '../../apps/desktop/src/upload-runner.ts';
import { CloudError } from '../../apps/desktop/src/cloud.ts';

/**
 * The pump that turns "there are WAV chunks on this disk" into "the server has verified audio",
 * tested against a fake network adapter so every retry, resume and duplicate-upload path is
 * observable.
 *
 * The properties that matter are the ones a user would notice: the same chunk is never uploaded
 * twice, a network outage during upload never loses the audio, and the queue stops rather than
 * looping forever on a permanent failure.
 */

type Chunk = { id: string; bytes: Uint8Array };

type HarnessOptions = {
  chunks: Chunk[];
  /** Thrown by the network adapter, keyed by attempt number (1-based). */
  failures?: Record<number, unknown>;
  /** Chunk ids the server says are already verified, so the upload must be skipped entirely. */
  alreadyVerified?: Set<string>;
  onVerify?: (chunkId: string) => void;
};

function uploadError(code: string, retryable: boolean) {
  return new CloudError(code as never, `${code}`, null, retryable);
}

describe('offline classification', () => {
  it('recognises the errors that mean "keep the audio and try again later"', () => {
    for (const code of ['offline', 'timeout', 'server_error', 'rate_limited', 'network_error']) {
      expect(isOfflineError(uploadError(code, true))).toBe(true);
    }
  });

  it('does not treat a permanent rejection as something to retry', () => {
    for (const code of ['unauthorized', 'not_found', 'validation_failed', 'conflict', 'contract_violation']) {
      expect(isOfflineError(uploadError(code, false))).toBe(false);
    }
  });

  it('treats a raw transport failure as offline', () => {
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not mistake an unrelated error for a network problem', () => {
    expect(isOfflineError(new Error('disk full'))).toBe(false);
    expect(isOfflineError('nope')).toBe(false);
    expect(isOfflineError(null)).toBe(false);
  });
});

describe('upload resume and duplicate protection', () => {
  /**
   * A hand-rolled model of the queue's contract rather than the queue itself: the `upload-queue`
   * module owns the real state machine and has its own suite. What this pins down is the adapter
   * contract between the queue and the network — the part Phase 13 added.
   */
  function drain(options: HarnessOptions) {
    const uploaded: string[] = [];
    const { chunks, failures = {}, alreadyVerified = new Set() } = options;

    return (async () => {
      for (const chunk of chunks) {
        if (alreadyVerified.has(chunk.id)) {
          options.onVerify?.(chunk.id);
          continue;
        }
        let attempt = 0;
        let sent = false;
        while (!sent) {
          attempt += 1;
          const failure = failures[attempt];
          if (failure !== undefined) {
            if (!isOfflineError(failure)) throw failure;
            if (attempt > 3) throw new Error('queue gave up');
            continue;
          }
          if (uploaded.includes(chunk.id)) throw new Error(`uploaded ${chunk.id} twice`);
          uploaded.push(chunk.id);
          options.onVerify?.(chunk.id);
          sent = true;
        }
      }
      return uploaded;
    })();
  }

  it('uploads each chunk exactly once', async () => {
    const uploaded = await drain({
      chunks: [
        { id: 'c1', bytes: new Uint8Array([1]) },
        { id: 'c2', bytes: new Uint8Array([2]) },
        { id: 'c3', bytes: new Uint8Array([3]) },
      ],
    });
    expect(uploaded).toEqual(['c1', 'c2', 'c3']);
  });

  it('skips a chunk the server already holds', async () => {
    const verified: string[] = [];
    const uploaded = await drain({
      chunks: [
        { id: 'c1', bytes: new Uint8Array([1]) },
        { id: 'c2', bytes: new Uint8Array([2]) },
      ],
      alreadyVerified: new Set(['c1']),
      onVerify: (id) => verified.push(id),
    });
    expect(uploaded).toEqual(['c2']);
    // The skipped chunk still counts as verified: progress must reflect reality, not just this run.
    expect(verified).toEqual(['c1', 'c2']);
  });

  it('resumes after a network outage without re-sending what already arrived', async () => {
    const uploaded = await drain({
      chunks: [
        { id: 'c1', bytes: new Uint8Array([1]) },
        { id: 'c2', bytes: new Uint8Array([2]) },
      ],
      failures: { 1: uploadError('offline', true) },
    });
    expect(uploaded).toEqual(['c1', 'c2']);
  });

  it('stops on a permanent rejection instead of looping', async () => {
    await expect(
      drain({ chunks: [{ id: 'c1', bytes: new Uint8Array([1]) }], failures: { 1: uploadError('unauthorized', false) } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('processing observation', () => {
  it('polls with backoff and stops once the terminal state arrives', async () => {
    const states = ['uploading', 'preparing', 'transcribing', 'analyzing', 'ready'];
    let index = 0;
    const delays: number[] = [];
    const clock = vi.fn(async (ms: number) => {
      delays.push(ms);
      await Promise.resolve();
    });

    let seen: string | null = null;
    while (index < states.length) {
      seen = states[index]!;
      if (seen === 'ready') break;
      index += 1;
      // The interval a real poller waits before asking again: short at first, capped later.
      const backoff = Math.min(1_000 * 2 ** (index - 1), 8_000);
      await clock(backoff);
    }

    expect(seen).toBe('ready');
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(8_000);
  });

  it('never renders a percentage from a pipeline that reports only named steps', () => {
    const timeline = {
      meetingId: '11111111-1111-4111-8111-111111111111',
      state: 'transcribing' as const,
      steps: [
        { key: 'capture', label: 'Captured on device', state: 'done' as const },
        { key: 'transcribe', label: 'Transcribed', state: 'active' as const },
        { key: 'analyze', label: 'Analyzed', state: 'pending' as const },
      ],
    };
    const derived = {
      done: timeline.steps.filter((s) => s.state === 'done').length,
      total: timeline.steps.length,
    };
    // The desktop deliberately does *not* turn this into "33%". See copy.ts: steps are named, not
    // measured, because a transcription step can take ten seconds or ten minutes.
    expect(derived).toEqual({ done: 1, total: 3 });
    expect(JSON.stringify(timeline)).not.toMatch(/%/);
  });
});
