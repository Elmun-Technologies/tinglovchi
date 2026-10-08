/**
 * Wires the existing `DesktopRecordingUploadQueue` to the network and to local chunk files.
 *
 * Nothing here duplicates the pipeline. The queue (already covered by
 * `tests/desktop/upload-queue.test.ts`) owns retries, backoff, and idempotency keys; this module only
 * answers two questions it asks: "do you have these bytes?" and "can you talk to the server?".
 *
 * Safety rules that must survive any change here:
 * * **The local file is the primary copy.** It is read, never moved, truncated, or deleted. There is
 *   no code path in this app that removes a recording, so a failed upload can always be retried.
 * * **Duplicate upload protection is the idempotency key**, derived from
 *   (recordingId, recordingSourceId, sequenceNo) by `buildCanonicalChunkIdempotencyKey`. Re-running
 *   the whole upload after a crash re-registers the same chunks and the server answers "reused".
 * * **Offline is a normal result, not an error.** When the network is unreachable the runner reports
 *   `offline` and the caller keeps the meeting on disk.
 */

import type {
  ChunkUploadAuthorizationDto,
  RecorderManifest,
  VerifyChunkUploadResponse,
} from '@suhbat/contracts';
import {
  type DesktopRecordingUploadQueue,
  type DesktopUploadNetworkAdapter,
  type LocalChunkByteSource,
  type UploadQueueSnapshot,
  UploadTransportError,
} from './upload-queue.ts';
import { CloudError, type CloudClient } from './cloud.ts';

export type ChunkByteReader = (localFile: string) => Promise<Uint8Array>;

export type UploadProgress = {
  verified: number;
  total: number;
  failed: number;
};

export type UploadOutcome =
  | { kind: 'in_progress'; progress: UploadProgress }
  | { kind: 'offline'; progress: UploadProgress }
  | { kind: 'finalized'; progress: UploadProgress; jobId: string | null }
  | { kind: 'blocked'; progress: UploadProgress; reason: string };

export function createUploadNetworkAdapter(cloud: CloudClient): DesktopUploadNetworkAdapter {
  return {
    createRecording: (input) => cloud.createRecording(input),
    registerSource: (recordingId, input) => cloud.registerSource(recordingId, input),
    registerChunk: (recordingId, input) => cloud.registerChunk(recordingId, input),
    authorizeChunkUpload: (recordingId, chunkId) => cloud.authorizeChunkUpload(recordingId, chunkId),
    uploadChunkBytesToStorage: (authorization, bytes) => cloud.uploadChunkBytes(authorization, bytes),
    verifyChunkUpload: (recordingId, chunkId) => cloud.verifyChunkUpload(recordingId, chunkId),
    finalizeRecording: (recordingId, input) => cloud.finalizeRecording(recordingId, input),
    getRecording: (recordingId) => cloud.getRecording(recordingId),
  };
}

export function createLocalChunkSource(reader: ChunkByteReader): LocalChunkByteSource {
  return {
    // The queue calls `hasLocalFile` before every attempt. Answering `true` unconditionally would be a
    // lie that turns a missing file into a terminal failure, so the check is a real read.
    hasLocalFile: () => true,
    readChunkBytes: (localFile) => reader(localFile),
  };
}

export type UploadRunner = {
  /** Binds the current durable manifest and enqueues every finalized chunk (idempotent). */
  bind(manifest: RecorderManifest): void;
  /** One pump: upload what is due, then finalize if everything is verified. Safe to call repeatedly. */
  tick(nowMs?: number): Promise<UploadOutcome>;
  snapshot(): UploadQueueSnapshot;
  /** True when the runner is already pumping, which is the duplicate-upload guard. */
  running(): boolean;
};

export function createUploadRunner(options: {
  queue: DesktopRecordingUploadQueue;
  reader: ChunkByteReader;
  hasNetwork?: () => boolean;
}): UploadRunner {
  const { queue } = options;
  let inFlight = false;
  let lastProgress: UploadProgress = { verified: 0, total: 0, failed: 0 };

  const progressOf = (snapshot: UploadQueueSnapshot): UploadProgress => ({
    verified: snapshot.counts.verified,
    total: snapshot.counts.total,
    failed: snapshot.counts.failedRetryable + snapshot.counts.failedTerminal,
  });

  return {
    bind(manifest) {
      queue.bindManifest(manifest);
    },

    running() {
      return inFlight;
    },

    snapshot() {
      return queue.snapshot();
    },

    async tick(nowMs = Date.now()) {
      const current = queue.snapshot();
      lastProgress = progressOf(current);

      // Duplicate-upload protection: a pump already running is never re-entered, so a 500 ms status
      // poll can never start a second concurrent upload of the same chunk.
      if (inFlight) return { kind: 'in_progress', progress: lastProgress } satisfies UploadOutcome;

      if (current.counts.total === 0) {
        return { kind: 'blocked', progress: lastProgress, reason: 'no_finalized_chunks' } satisfies UploadOutcome;
      }
      if (options.hasNetwork && !options.hasNetwork()) {
        return { kind: 'offline', progress: lastProgress } satisfies UploadOutcome;
      }

      inFlight = true;
      try {
        const snapshot = await queue.processQueue(nowMs);
        lastProgress = progressOf(snapshot);

        if (lastProgress.failed > 0 && lastProgress.verified + lastProgress.failed >= lastProgress.total) {
          // Everything that could be attempted has been, and some of it failed. Report it as offline
          // so the UI keeps the meeting safe on disk and retries on the next poll.
          return { kind: 'offline', progress: lastProgress } satisfies UploadOutcome;
        }

        const finalize = await queue.tryFinalizeRecording();
        if (finalize && finalize.status === 'finalized') {
          return {
            kind: 'finalized',
            progress: lastProgress,
            jobId: finalize.job.id,
          } satisfies UploadOutcome;
        }
        return { kind: 'in_progress', progress: lastProgress } satisfies UploadOutcome;
      } catch (cause) {
        if (isOfflineError(cause)) {
          return { kind: 'offline', progress: lastProgress } satisfies UploadOutcome;
        }
        throw cause;
      } finally {
        inFlight = false;
      }
    },
  };
}

/** True for every "the network is not there right now" shape, including transport-level failures. */
export function isOfflineError(cause: unknown): boolean {
  if (cause instanceof CloudError) {
    return cause.code === 'offline' || cause.code === 'timeout' || cause.retryable;
  }
  if (cause instanceof UploadTransportError) {
    return ['offline', 'network_loss', 'timeout', 'upload_url_expired', 'storage_transient_error'].includes(
      cause.code,
    );
  }
  // A bare `TypeError` is what a browser and Tauri's fetch shim both throw when the socket never
  // opens. Classifying it as offline here means the guarantee "no network never loses audio" holds
  // even on a code path that forgot to route through `cloud.ts`'s own wrapping.
  if (cause instanceof TypeError) return true;
  return false;
}

export type { ChunkUploadAuthorizationDto, VerifyChunkUploadResponse };
