import { describe, expect, it } from 'vitest';
import type {
  ChunkRecord,
  ChunkUploadAuthorizationDto,
  CreateRecordingRequestInput,
  FinalizeRecordingResponse,
  RecorderManifest,
  RecordingChunkDto,
  RecordingDetailResponse,
  RecordingDto,
  RecordingSourceDto,
  RegisterRecordingChunkRequestInput,
  RegisterRecordingSourceRequestInput,
  VerifyChunkUploadResponse,
} from '@suhbat/contracts';
import { computeSha256Hex } from '@suhbat/database/storage';
import {
  DesktopRecordingUploadQueue,
  UploadTransportError,
  type DesktopUploadNetworkAdapter,
  type LocalChunkByteSource,
} from '../../apps/desktop/src/upload-queue';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const meetingId = '22222222-2222-4222-8222-222222222222';
const recordingId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const micSourceId = '55555555-5555-4555-8555-555555555555';

function makeChunkBytes(tag: string, size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (tag.charCodeAt(i % tag.length) + i * 11) & 0xff;
  }
  return bytes;
}

function makeChunkRecord(
  sequenceNo: number,
  bytes: Uint8Array,
  state: ChunkRecord['state'] = 'finalized',
): ChunkRecord {
  const startMs = sequenceNo * 30_000;
  const endMs = startMs + 30_000;
  return {
    chunkId: `88888888-8888-4888-8888-${String(sequenceNo).padStart(12, '0')}`,
    recordingId,
    recordingSourceId: micSourceId,
    sourceKind: 'microphone',
    sequenceNo,
    idempotencyKey: `${recordingId}:${micSourceId}:${sequenceNo}`,
    state,
    localFile: `chunks/microphone/${String(sequenceNo).padStart(6, '0')}.wav`,
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    sourceFirstSampleIndex: sequenceNo * 1_440_000,
    sampleCount: 1_440_000,
    encoderDelaySamples: 0,
    encoderPaddingSamples: 0,
    segmentIndex: 0,
    firstSampleMonotonicTicks: String(1_000_000 + sequenceNo * 30_000_000_000),
    meetingStartMs: startMs,
    meetingEndMs: endMs,
    durationMs: 30_000,
    byteSize: bytes.byteLength,
    checksum:
      state === 'finalizing'
        ? null
        : {
            algorithm: 'sha256',
            value: computeSha256Hex(bytes),
          },
    finalizedAt: state === 'finalizing' ? null : '2026-10-07T09:00:30.000Z',
    uploadState: 'pending',
    verificationState: 'pending',
    verifiedAt: null,
    storageKey: null,
  };
}

function makeManifest(
  chunks: ChunkRecord[],
  state: RecorderManifest['state'] = 'stopped',
): RecorderManifest {
  return {
    schemaVersion: 1,
    revision: 3,
    workspaceId,
    meetingId,
    recordingId,
    sessionId,
    state,
    startedAt: '2026-10-07T09:00:00.000Z',
    stoppedAt: state === 'stopped' ? '2026-10-07T09:01:00.000Z' : null,
    timeline: {
      clock: 'platform_monotonic_continuous',
      clockEpochId: 'boot-epoch-1',
      originTicks: '1000000',
      originWallClockUtc: '2026-10-07T09:00:00.000Z',
      tickFrequencyHz: 1_000_000_000,
    },
    activeIntervals: [],
    pauseIntervals: [],
    consent: {
      acknowledgedAt: '2026-10-07T08:59:55.000Z',
      policyVersion: 'v1',
      participantNoticeShown: true,
    },
    storage: {
      layoutVersion: 1,
      directoryName: 'session-test',
      localOnly: true,
      encryption: 'os_account_and_disk_protection',
    },
    sources: [
      {
        recordingSourceId: micSourceId,
        kind: 'microphone',
        role: 'original',
        state: 'active',
        codec: 'pcm_s16le',
        container: 'wav',
        format: 'wav_pcm_s16le',
        sampleRateHz: 48_000,
        channels: 1,
        deviceUid: 'sim-mic',
        deviceName: 'Simulated Mic',
        startedAtTicks: '1000000',
        endedAtTicks: '60001000000',
        firstSampleIndex: 0,
        lastSampleIndexExclusive: chunks.length * 1_440_000,
        firstSampleMeetingMs: 0,
        lastSampleMeetingMs: chunks.length * 30_000,
        droppedSampleCount: 0,
        sampleMap: [],
      },
    ],
    chunks,
    markers: [],
    notes: [],
    lastUpdatedAt: '2026-10-07T09:01:00.000Z',
  };
}

class FakeServerAndStorage implements DesktopUploadNetworkAdapter, LocalChunkByteSource {
  readonly diskFiles = new Map<string, Uint8Array>();
  readonly storedObjects = new Map<string, Uint8Array>();
  readonly chunksByKey = new Map<string, RecordingChunkDto>();
  readonly sourcesById = new Map<string, RecordingSourceDto>();
  recording: RecordingDto | null = null;
  online = true;
  nextUploadFault: UploadTransportError | null = null;
  authUrlLifetimeMs = 900_000;
  currentWallTimeMs = 1_700_000_000_000;
  uploadPutCalls = 0;
  authCalls = 0;

  async readChunkBytes(localFile: string): Promise<Uint8Array> {
    const bytes = this.diskFiles.get(localFile);
    if (!bytes) throw new Error(`Missing local disk file: ${localFile}`);
    return bytes;
  }

  hasLocalFile(localFile: string): boolean {
    return this.diskFiles.has(localFile);
  }

  private assertOnline() {
    if (!this.online) {
      throw new UploadTransportError('offline', 'Network interface is offline.', true);
    }
  }

  async createRecording(
    input: CreateRecordingRequestInput,
  ): Promise<{ recording: RecordingDto; idempotentReused: boolean }> {
    this.assertOnline();
    if (this.recording) {
      return { recording: this.recording, idempotentReused: true };
    }
    const created: RecordingDto = {
      id: input.recordingId ?? recordingId,
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      status: 'uploading',
      timeline: {
        clock: input.timeline.clock ?? 'platform_monotonic_continuous',
        clockEpochId: input.timeline.clockEpochId,
        originTicks: input.timeline.originTicks,
        originWallClockUtc: input.timeline.originWallClockUtc,
        tickFrequencyHz: input.timeline.tickFrequencyHz,
      },
      consent: {
        acknowledgedAt: input.consent.acknowledgedAt,
        policyVersion: input.consent.policyVersion ?? 'v1',
      },
      canonicalDurationMs: null,
      activeCaptureMs: null,
      startedAt: input.startedAt ?? new Date(this.currentWallTimeMs).toISOString(),
      stoppedAt: null,
      finalizedAt: null,
      manifestRevision: input.manifestRevision ?? 1,
      createdBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: new Date(this.currentWallTimeMs).toISOString(),
      updatedAt: new Date(this.currentWallTimeMs).toISOString(),
    };
    this.recording = created;
    return { recording: created, idempotentReused: false };
  }

  async registerSource(
    _recId: string,
    input: RegisterRecordingSourceRequestInput,
  ): Promise<{ source: RecordingSourceDto; idempotentReused: boolean }> {
    this.assertOnline();
    const id = input.sourceId ?? micSourceId;
    const existing = this.sourcesById.get(id);
    if (existing) return { source: existing, idempotentReused: true };
    const dto: RecordingSourceDto = {
      id,
      workspaceId,
      meetingId,
      recordingId,
      sourceKind: input.sourceKind,
      sourceRole: input.sourceRole ?? 'original',
      isRequired: input.isRequired ?? true,
      codec: input.codec,
      container: input.container,
      sampleRateHz: input.sampleRateHz,
      channels: input.channels,
      deviceUid: input.deviceUid ?? null,
      deviceName: input.deviceName ?? null,
      startedAtTicks: input.startedAtTicks ?? '1000',
      endedAtTicks: input.endedAtTicks ?? null,
      firstSampleIndex: input.firstSampleIndex ?? 0,
      lastSampleIndexExclusive: input.lastSampleIndexExclusive ?? 0,
      firstSampleMeetingMs: input.firstSampleMeetingMs ?? 0,
      lastSampleMeetingMs: input.lastSampleMeetingMs ?? 0,
      droppedSampleCount: input.droppedSampleCount ?? 0,
      expectedChunkCount: input.expectedChunkCount ?? null,
      createdAt: new Date(this.currentWallTimeMs).toISOString(),
      updatedAt: new Date(this.currentWallTimeMs).toISOString(),
    };
    this.sourcesById.set(id, dto);
    return { source: dto, idempotentReused: false };
  }

  async registerChunk(
    _recId: string,
    input: RegisterRecordingChunkRequestInput,
  ): Promise<{ chunk: RecordingChunkDto; idempotentReused: boolean }> {
    this.assertOnline();
    const key =
      input.idempotencyKey ?? `${recordingId}:${input.recordingSourceId}:${input.sequenceNo}`;
    const existing = this.chunksByKey.get(key);
    if (existing) {
      if (existing.checksum.value !== input.checksum.value) {
        throw new UploadTransportError(
          'chunk_conflict',
          'Chunk checksum conflicts with existing registered chunk.',
          false,
        );
      }
      return { chunk: existing, idempotentReused: true };
    }
    const id = input.chunkId ?? crypto.randomUUID();
    const storageKey = `workspace/${workspaceId}/meetings/${meetingId}/recordings/${recordingId}/sources/${input.recordingSourceId}/chunks/${String(input.sequenceNo).padStart(6, '0')}.wav`;
    const dto: RecordingChunkDto = {
      id,
      workspaceId,
      meetingId,
      recordingId,
      recordingSourceId: input.recordingSourceId,
      clientChunkId: input.clientChunkId ?? id,
      idempotencyKey: key,
      sequenceNo: input.sequenceNo,
      meetingStartMs: input.meetingStartMs,
      meetingEndMs: input.meetingEndMs,
      durationMs: input.durationMs ?? input.meetingEndMs - input.meetingStartMs,
      sampleStart: input.sampleStart,
      sampleEnd: input.sampleEnd,
      firstSampleMonotonicTicks: input.firstSampleMonotonicTicks ?? '0',
      byteSize: input.byteSize,
      checksum: input.checksum,
      storageBackend: 'local',
      storageKey,
      uploadState: 'pending',
      verificationState: 'pending',
      codec: input.codec,
      container: input.container,
      sampleRateHz: input.sampleRateHz,
      channels: input.channels,
      encoderDelaySamples: input.encoderDelaySamples ?? 0,
      encoderPaddingSamples: input.encoderPaddingSamples ?? 0,
      verifiedByteSize: null,
      verifiedSha256: null,
      verificationMethod: null,
      verificationErrorCode: null,
      createdAt: new Date(this.currentWallTimeMs).toISOString(),
      updatedAt: new Date(this.currentWallTimeMs).toISOString(),
      uploadedAt: null,
      verifiedAt: null,
    };
    this.chunksByKey.set(key, dto);
    return { chunk: dto, idempotentReused: false };
  }

  async authorizeChunkUpload(
    _recId: string,
    chunkId: string,
  ): Promise<ChunkUploadAuthorizationDto> {
    this.assertOnline();
    this.authCalls += 1;
    const chunk = [...this.chunksByKey.values()].find((c) => c.id === chunkId);
    if (!chunk) throw new Error('Chunk not found');
    const expiresAt = new Date(this.currentWallTimeMs + this.authUrlLifetimeMs).toISOString();
    return {
      chunkId: chunk.id,
      recordingId: chunk.recordingId,
      recordingSourceId: chunk.recordingSourceId,
      sequenceNo: chunk.sequenceNo,
      storageBackend: 'local',
      storageKey: chunk.storageKey,
      method: 'PUT',
      uploadUrl: `mem-storage://upload/${chunk.id}?exp=${Date.parse(expiresAt)}`,
      headers: { 'content-type': 'audio/wav' },
      expiresAt,
      alreadyVerified: chunk.verificationState === 'verified',
    };
  }

  async uploadChunkBytesToStorage(
    authorization: ChunkUploadAuthorizationDto,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<void> {
    this.assertOnline();
    this.uploadPutCalls += 1;
    if (this.nextUploadFault) {
      const fault = this.nextUploadFault;
      this.nextUploadFault = null;
      throw fault;
    }
    if (nowMs >= Date.parse(authorization.expiresAt)) {
      throw new UploadTransportError(
        'upload_url_expired',
        'Presigned upload URL has expired.',
        true,
      );
    }
    this.storedObjects.set(authorization.storageKey, new Uint8Array(bytes));
  }

  async verifyChunkUpload(_recId: string, chunkId: string): Promise<VerifyChunkUploadResponse> {
    this.assertOnline();
    const chunk = [...this.chunksByKey.values()].find((c) => c.id === chunkId);
    if (!chunk) throw new Error('Chunk not found');
    const stored = this.storedObjects.get(chunk.storageKey);
    if (!stored) {
      return {
        verified: false,
        chunk,
        verification: {
          method: null,
          verifiedByteSize: null,
          verifiedSha256: null,
          failureReason: 'object_missing',
          failureDetail: 'Missing object',
        },
      };
    }
    const sha = computeSha256Hex(stored);
    chunk.verificationState = 'verified';
    chunk.uploadState = 'verified';
    chunk.verifiedByteSize = stored.byteLength;
    chunk.verifiedSha256 = sha;
    chunk.verifiedAt = new Date(this.currentWallTimeMs).toISOString();
    return {
      verified: true,
      chunk,
      verification: {
        method: 'computed_stream_sha256',
        verifiedByteSize: stored.byteLength,
        verifiedSha256: sha,
        failureReason: null,
        failureDetail: null,
      },
    };
  }

  async finalizeRecording(): Promise<FinalizeRecordingResponse> {
    this.assertOnline();
    if (!this.recording) throw new Error('No recording');
    this.recording.status = 'finalized';
    return {
      status: 'finalized',
      recording: this.recording,
      job: {
        id: '99999999-9999-4999-8999-999999999999',
        workspaceId,
        meetingId,
        recordingId,
        jobType: 'prepare_recording',
        generation: 1,
        idempotencyKey: `prepare_recording:${recordingId}:v1`,
        status: 'queued',
        attempt: 0,
        maxAttempts: 5,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        fencingToken: 0,
        scheduledAt: new Date(this.currentWallTimeMs).toISOString(),
        startedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        errorMetadata: {},
        payload: {},
        resultMetadata: {},
        createdAt: new Date(this.currentWallTimeMs).toISOString(),
        updatedAt: new Date(this.currentWallTimeMs).toISOString(),
      },
      idempotentReused: false,
    };
  }

  async getRecording(): Promise<RecordingDetailResponse | null> {
    this.assertOnline();
    if (!this.recording) return null;
    return {
      recording: this.recording,
      sources: [...this.sourcesById.values()],
      chunks: [...this.chunksByKey.values()],
      jobs: [],
    };
  }
}

describe('Phase 4 — Desktop Upload Queue & Offline/Retry Resilience', () => {
  it('supports offline startup and network loss without blocking capture or losing local chunk files', async () => {
    const fake = new FakeServerAndStorage();
    fake.online = false; // Start completely offline

    const bytes0 = makeChunkBytes('offline-chunk-0', 256);
    const bytes1 = makeChunkBytes('offline-chunk-1', 256);
    const chunk0 = makeChunkRecord(0, bytes0);
    const chunk1 = makeChunkRecord(1, bytes1);
    fake.diskFiles.set(chunk0.localFile, bytes0);
    fake.diskFiles.set(chunk1.localFile, bytes1);

    const queue = new DesktopRecordingUploadQueue({
      adapter: fake,
      localFiles: fake,
      baseBackoffMs: 1_000,
    });

    // Capture continues while offline; chunks are enqueued synchronously
    queue.bindManifest(makeManifest([chunk0], 'recording'));
    queue.enqueueFinalizedChunk(chunk1);

    const t0 = fake.currentWallTimeMs;
    const snapOffline = await queue.processQueue(t0);
    expect(snapOffline.counts.failedRetryable).toBe(2);
    expect(snapOffline.counts.verified).toBe(0);
    // Local files are strictly retained even when upload fails
    expect(snapOffline.items.every((i) => i.localFileRetained)).toBe(true);
    expect(fake.hasLocalFile(chunk0.localFile)).toBe(true);
    expect(fake.hasLocalFile(chunk1.localFile)).toBe(true);

    // Network comes back online after backoff window; recording stops and finalizes
    fake.online = true;
    queue.bindManifest(makeManifest([chunk0, chunk1], 'stopped'));
    const snapOnline = await queue.processQueue(t0 + 2_000);
    expect(snapOnline.counts.verified).toBe(2);
    expect(snapOnline.counts.failedRetryable).toBe(0);

    const fin = await queue.tryFinalizeRecording();
    expect(fin?.status).toBe('finalized');
    expect(queue.snapshot().finalizedOnServer).toBe(true);
  });

  it('automatically refreshes an expired signed URL and completes chunk verification', async () => {
    const fake = new FakeServerAndStorage();
    fake.authUrlLifetimeMs = 5_000; // Signed URL expires in 5s

    const bytes0 = makeChunkBytes('expiring-url-chunk', 256);
    const chunk0 = makeChunkRecord(0, bytes0);
    fake.diskFiles.set(chunk0.localFile, bytes0);

    const queue = new DesktopRecordingUploadQueue({
      adapter: fake,
      localFiles: fake,
    });
    queue.bindManifest(makeManifest([chunk0], 'stopped'));

    // First attempt fails during PUT with network_loss AFTER obtaining signed URL
    fake.nextUploadFault = new UploadTransportError('timeout', 'Upload socket timed out.', true);
    const t0 = fake.currentWallTimeMs;
    const snapAfterTimeout = await queue.processQueue(t0);
    expect(snapAfterTimeout.counts.failedRetryable).toBe(1);
    expect(fake.authCalls).toBe(1);

    // Advance clock past signed URL expiration (t0 + 10s) and retry -> queue refreshes signed URL automatically
    fake.currentWallTimeMs = t0 + 10_000;
    const snapAfterRefresh = await queue.processQueue(fake.currentWallTimeMs);
    expect(snapAfterRefresh.counts.verified).toBe(1);
    expect(fake.authCalls).toBe(2);
  });

  it('reconciles with server after restart so already-verified chunks are not re-uploaded', async () => {
    const fake = new FakeServerAndStorage();
    const bytes0 = makeChunkBytes('reconcile-chunk-0', 256);
    const bytes1 = makeChunkBytes('reconcile-chunk-1', 256);
    const chunk0 = makeChunkRecord(0, bytes0);
    const chunk1 = makeChunkRecord(1, bytes1);
    fake.diskFiles.set(chunk0.localFile, bytes0);
    fake.diskFiles.set(chunk1.localFile, bytes1);

    // First queue instance uploads chunk 0
    const queueBeforeRestart = new DesktopRecordingUploadQueue({
      adapter: fake,
      localFiles: fake,
    });
    queueBeforeRestart.bindManifest(makeManifest([chunk0], 'recording'));
    await queueBeforeRestart.processQueue(fake.currentWallTimeMs);
    expect(fake.uploadPutCalls).toBe(1);

    // Simulate desktop/server restart: new queue instance binds manifest with chunk 0 and chunk 1
    const queueAfterRestart = new DesktopRecordingUploadQueue({
      adapter: fake,
      localFiles: fake,
    });
    queueAfterRestart.bindManifest(makeManifest([chunk0, chunk1], 'stopped'));
    await queueAfterRestart.reconcileWithServer();

    // Chunk 0 is already marked verified from server reconciliation; only chunk 1 is uploaded
    const snap = await queueAfterRestart.processQueue(fake.currentWallTimeMs);
    expect(snap.counts.verified).toBe(2);
    expect(fake.uploadPutCalls).toBe(2); // Only 1 additional PUT for chunk 1
  });

  it('transitions non-retryable chunk_conflict errors to failed_terminal while preserving the local file', async () => {
    const fake = new FakeServerAndStorage();
    const bytes0 = makeChunkBytes('original-bytes', 256);
    const conflictingBytes = makeChunkBytes('conflicting-bytes', 256);
    const chunk0 = makeChunkRecord(0, bytes0);
    const conflictingChunk0 = makeChunkRecord(0, conflictingBytes);

    // Pre-register chunk0 on server with original checksum
    await fake.createRecording({
      recordingId,
      workspaceId,
      meetingId,
      sessionId,
      timeline: {
        clock: 'platform_monotonic_continuous',
        clockEpochId: 'boot-1',
        originTicks: '1000',
        originWallClockUtc: '2026-10-07T09:00:00.000Z',
        tickFrequencyHz: 1_000_000_000,
      },
      consent: { acknowledgedAt: '2026-10-07T08:59:55.000Z', policyVersion: 'v1' },
    });
    await fake.registerSource(recordingId, {
      sourceId: micSourceId,
      sourceKind: 'microphone',
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });
    await fake.registerChunk(recordingId, {
      chunkId: chunk0.chunkId,
      recordingSourceId: micSourceId,
      sequenceNo: 0,
      meetingStartMs: 0,
      meetingEndMs: 30_000,
      sampleStart: 0,
      sampleEnd: 1_440_000,
      byteSize: bytes0.byteLength,
      checksum: chunk0.checksum!,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 48_000,
      channels: 1,
    });

    // Queue attempts to upload conflictingChunk0 for sequence 0
    fake.diskFiles.set(conflictingChunk0.localFile, conflictingBytes);
    const queue = new DesktopRecordingUploadQueue({
      adapter: fake,
      localFiles: fake,
    });
    queue.bindManifest(makeManifest([conflictingChunk0], 'stopped'));

    const snap = await queue.processQueue(fake.currentWallTimeMs);
    expect(snap.counts.failedTerminal).toBe(1);
    expect(snap.items[0]?.uploadState).toBe('failed_terminal');
    expect(snap.items[0]?.lastErrorCode).toBe('chunk_conflict');
    expect(snap.items[0]?.localFileRetained).toBe(true);
    expect(fake.hasLocalFile(conflictingChunk0.localFile)).toBe(true);
  });
});
