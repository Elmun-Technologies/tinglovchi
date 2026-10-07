import type {
  ChunkRecord,
  ChunkUploadAuthorizationDto,
  ChunkUploadState,
  ChunkVerificationState,
  CreateRecordingRequestInput,
  FinalizeRecordingRequestInput,
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
import { buildCanonicalChunkIdempotencyKey } from '@suhbat/contracts';

/**
 * Desktop upload queue and network-adapter contract (Phase 4).
 *
 * The recorder's capture hot path stays strictly local-first: finalized chunks are written to disk first,
 * then handed to this queue. Network outages, timeouts, expired signed URLs, or server restarts never block
 * capture and never delete or truncate a local source file.
 */

export type UploadFaultCode =
  | 'offline'
  | 'network_loss'
  | 'timeout'
  | 'upload_url_expired'
  | 'storage_transient_error'
  | 'verification_failed'
  | 'chunk_conflict'
  | 'unauthorized'
  | 'server_error';

export class UploadTransportError extends Error {
  readonly code: UploadFaultCode;
  readonly retryable: boolean;

  constructor(code: UploadFaultCode, message: string, retryable = true) {
    super(message);
    this.name = 'UploadTransportError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DesktopUploadNetworkAdapter {
  createRecording(
    input: CreateRecordingRequestInput,
  ): Promise<{ recording: RecordingDto; idempotentReused: boolean }>;
  registerSource(
    recordingId: string,
    input: RegisterRecordingSourceRequestInput,
  ): Promise<{ source: RecordingSourceDto; idempotentReused: boolean }>;
  registerChunk(
    recordingId: string,
    input: RegisterRecordingChunkRequestInput,
  ): Promise<{ chunk: RecordingChunkDto; idempotentReused: boolean }>;
  authorizeChunkUpload(recordingId: string, chunkId: string): Promise<ChunkUploadAuthorizationDto>;
  uploadChunkBytesToStorage(
    authorization: ChunkUploadAuthorizationDto,
    bytes: Uint8Array,
    nowMs: number,
  ): Promise<void>;
  verifyChunkUpload(recordingId: string, chunkId: string): Promise<VerifyChunkUploadResponse>;
  finalizeRecording(
    recordingId: string,
    input: FinalizeRecordingRequestInput,
  ): Promise<FinalizeRecordingResponse>;
  getRecording(recordingId: string): Promise<RecordingDetailResponse | null>;
}

export interface LocalChunkByteSource {
  readChunkBytes(localFile: string): Promise<Uint8Array>;
  hasLocalFile(localFile: string): boolean;
}

export type QueuedChunkUploadItem = {
  clientChunkId: string;
  serverChunkId: string | null;
  recordingId: string;
  recordingSourceId: string;
  sourceKind: ChunkRecord['sourceKind'];
  sequenceNo: number;
  idempotencyKey: string;
  localFile: string;
  /** True throughout the upload lifecycle: an upload failure never deletes the local file. */
  localFileRetained: true;
  meetingStartMs: number;
  meetingEndMs: number;
  durationMs: number;
  sampleStart: number;
  sampleEnd: number;
  firstSampleMonotonicTicks: string;
  byteSize: number;
  checksum: { algorithm: 'sha256'; value: string };
  codec: string;
  container: 'wav' | 'ogg' | 'opus' | 'flac' | 'm4a';
  sampleRateHz: number;
  channels: number;
  encoderDelaySamples: number;
  encoderPaddingSamples: number;
  uploadState: ChunkUploadState;
  verificationState: ChunkVerificationState;
  attemptCount: number;
  nextRetryAtMs: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  uploadAuthorization: ChunkUploadAuthorizationDto | null;
  verifiedAt: string | null;
};

export type UploadQueueSnapshot = {
  recordingId: string | null;
  sessionRegistered: boolean;
  registeredSourceIds: string[];
  finalizedOnServer: boolean;
  processingJobId: string | null;
  items: QueuedChunkUploadItem[];
  counts: {
    total: number;
    pending: number;
    inFlight: number;
    verified: number;
    failedRetryable: number;
    failedTerminal: number;
  };
};

export type DesktopUploadQueueOptions = {
  adapter: DesktopUploadNetworkAdapter;
  localFiles: LocalChunkByteSource;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
};

export class DesktopRecordingUploadQueue {
  private readonly adapter: DesktopUploadNetworkAdapter;
  private readonly localFiles: LocalChunkByteSource;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;

  private manifest: RecorderManifest | null = null;
  private sessionRegistered = false;
  private readonly registeredSourceIds = new Set<string>();
  private readonly itemsByKey = new Map<string, QueuedChunkUploadItem>();
  private finalizedOnServer = false;
  private processingJobId: string | null = null;

  constructor(options: DesktopUploadQueueOptions) {
    this.adapter = options.adapter;
    this.localFiles = options.localFiles;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  /**
   * Binds or updates the local recorder manifest without blocking capture.
   */
  bindManifest(manifest: RecorderManifest): void {
    this.manifest = manifest;
    for (const chunk of manifest.chunks) {
      if (chunk.state === 'finalized' || chunk.state === 'reconciled_from_disk') {
        this.enqueueFinalizedChunk(chunk);
      }
    }
  }

  /**
   * Non-blocking handoff from local chunk finalization to the upload queue.
   * Ignores unfinalized (`finalizing`) chunks that do not yet have a frozen SHA-256 digest.
   */
  enqueueFinalizedChunk(chunk: ChunkRecord): QueuedChunkUploadItem | null {
    if (!chunk.checksum) return null;

    const idempotencyKey = buildCanonicalChunkIdempotencyKey(
      chunk.recordingId,
      chunk.recordingSourceId,
      chunk.sequenceNo,
    );
    const existing = this.itemsByKey.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    const item: QueuedChunkUploadItem = {
      clientChunkId: chunk.chunkId,
      serverChunkId: null,
      recordingId: chunk.recordingId,
      recordingSourceId: chunk.recordingSourceId,
      sourceKind: chunk.sourceKind,
      sequenceNo: chunk.sequenceNo,
      idempotencyKey,
      localFile: chunk.localFile,
      localFileRetained: true,
      meetingStartMs: chunk.meetingStartMs,
      meetingEndMs: chunk.meetingEndMs,
      durationMs: chunk.durationMs,
      sampleStart: chunk.sourceFirstSampleIndex,
      sampleEnd: chunk.sourceFirstSampleIndex + chunk.sampleCount,
      firstSampleMonotonicTicks: chunk.firstSampleMonotonicTicks,
      byteSize: chunk.byteSize,
      checksum: chunk.checksum,
      codec: chunk.codec,
      container: chunk.container,
      sampleRateHz: chunk.sampleRateHz,
      channels: chunk.channels,
      encoderDelaySamples: chunk.encoderDelaySamples,
      encoderPaddingSamples: chunk.encoderPaddingSamples,
      uploadState: 'pending',
      verificationState: 'pending',
      attemptCount: 0,
      nextRetryAtMs: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      uploadAuthorization: null,
      verifiedAt: null,
    };

    this.itemsByKey.set(idempotencyKey, item);
    return item;
  }

  snapshot(): UploadQueueSnapshot {
    const items = [...this.itemsByKey.values()].sort(
      (a, b) =>
        a.recordingSourceId.localeCompare(b.recordingSourceId) || a.sequenceNo - b.sequenceNo,
    );
    return {
      recordingId: this.manifest?.recordingId ?? items[0]?.recordingId ?? null,
      sessionRegistered: this.sessionRegistered,
      registeredSourceIds: [...this.registeredSourceIds].sort(),
      finalizedOnServer: this.finalizedOnServer,
      processingJobId: this.processingJobId,
      items: items.map((item) => ({ ...item })),
      counts: {
        total: items.length,
        pending: items.filter((i) => i.uploadState === 'pending').length,
        inFlight: items.filter((i) =>
          ['authorizing', 'uploading', 'uploaded', 'verifying'].includes(i.uploadState),
        ).length,
        verified: items.filter((i) => i.verificationState === 'verified').length,
        failedRetryable: items.filter((i) => i.uploadState === 'failed_retryable').length,
        failedTerminal: items.filter((i) => i.uploadState === 'failed_terminal').length,
      },
    };
  }

  /**
   * Reconciles local queue state with the server after an app/server restart or network reconnect.
   */
  async reconcileWithServer(): Promise<void> {
    const recordingId = this.manifest?.recordingId;
    if (!recordingId) return;

    const remote = await this.adapter.getRecording(recordingId);
    if (!remote) {
      this.sessionRegistered = false;
      this.registeredSourceIds.clear();
      return;
    }

    this.sessionRegistered = true;
    for (const source of remote.sources) {
      this.registeredSourceIds.add(source.id);
    }
    for (const remoteChunk of remote.chunks) {
      const item = this.itemsByKey.get(remoteChunk.idempotencyKey);
      if (!item) continue;
      item.serverChunkId = remoteChunk.id;
      if (remoteChunk.verificationState === 'verified') {
        item.uploadState = 'verified';
        item.verificationState = 'verified';
        item.verifiedAt = remoteChunk.verifiedAt;
        item.lastErrorCode = null;
        item.lastErrorMessage = null;
      }
    }
    if (remote.recording.status === 'finalized') {
      this.finalizedOnServer = true;
      this.processingJobId = remote.jobs[0]?.id ?? null;
    }
  }

  private computeNextRetryAtMs(nowMs: number, attemptCount: number): number {
    const delay = Math.min(
      this.baseBackoffMs * Math.pow(2, Math.max(0, attemptCount - 1)),
      this.maxBackoffMs,
    );
    return nowMs + delay;
  }

  private async ensureSessionAndSourcesRegistered(): Promise<void> {
    if (!this.manifest) {
      throw new UploadTransportError(
        'offline',
        'No recorder manifest bound to upload queue.',
        true,
      );
    }
    if (!this.manifest.workspaceId || !this.manifest.meetingId) {
      throw new UploadTransportError(
        'offline',
        'Manifest is not linked to a workspaceId and meetingId yet.',
        true,
      );
    }

    if (!this.sessionRegistered) {
      await this.adapter.createRecording({
        recordingId: this.manifest.recordingId,
        workspaceId: this.manifest.workspaceId,
        meetingId: this.manifest.meetingId,
        sessionId: this.manifest.sessionId,
        timeline: this.manifest.timeline,
        consent: {
          acknowledgedAt: this.manifest.consent.acknowledgedAt,
          policyVersion: this.manifest.consent.policyVersion,
        },
        startedAt: this.manifest.startedAt,
        manifestRevision: this.manifest.revision,
      });
      this.sessionRegistered = true;
    }

    for (const source of this.manifest.sources) {
      if (this.registeredSourceIds.has(source.recordingSourceId)) continue;
      const sourceChunks = [...this.itemsByKey.values()].filter(
        (c) => c.recordingSourceId === source.recordingSourceId,
      );
      await this.adapter.registerSource(this.manifest.recordingId, {
        sourceId: source.recordingSourceId,
        workspaceId: this.manifest.workspaceId,
        sourceKind: source.kind,
        sourceRole: source.role,
        isRequired: true,
        codec: source.codec,
        container: source.container,
        sampleRateHz: source.sampleRateHz,
        channels: source.channels,
        deviceUid: source.deviceUid,
        deviceName: source.deviceName,
        startedAtTicks: source.startedAtTicks,
        endedAtTicks: source.endedAtTicks,
        firstSampleIndex: source.firstSampleIndex,
        lastSampleIndexExclusive: source.lastSampleIndexExclusive,
        firstSampleMeetingMs: source.firstSampleMeetingMs,
        lastSampleMeetingMs: source.lastSampleMeetingMs,
        droppedSampleCount: source.droppedSampleCount,
        expectedChunkCount: this.manifest.state === 'stopped' ? sourceChunks.length : undefined,
      });
      this.registeredSourceIds.add(source.recordingSourceId);
    }
  }

  private isAuthorizationExpired(auth: ChunkUploadAuthorizationDto | null, nowMs: number): boolean {
    if (!auth) return true;
    const expiresMs = Date.parse(auth.expiresAt);
    return !Number.isFinite(expiresMs) || nowMs >= expiresMs;
  }

  private async processSingleChunk(item: QueuedChunkUploadItem, nowMs: number): Promise<void> {
    if (item.verificationState === 'verified' || item.uploadState === 'failed_terminal') {
      return;
    }
    if (item.nextRetryAtMs > nowMs) {
      return;
    }

    // Never lose or delete local file; ensure it is still readable before attempting upload.
    if (!this.localFiles.hasLocalFile(item.localFile)) {
      item.uploadState = 'failed_terminal';
      item.lastErrorCode = 'local_file_missing';
      item.lastErrorMessage = 'Local chunk file is not readable on disk.';
      return;
    }

    try {
      await this.ensureSessionAndSourcesRegistered();

      // Step 1: Register chunk metadata (idempotent on retry)
      if (!item.serverChunkId) {
        const registered = await this.adapter.registerChunk(item.recordingId, {
          chunkId: item.clientChunkId,
          clientChunkId: item.clientChunkId,
          workspaceId: this.manifest?.workspaceId ?? undefined,
          recordingSourceId: item.recordingSourceId,
          sequenceNo: item.sequenceNo,
          idempotencyKey: item.idempotencyKey,
          meetingStartMs: item.meetingStartMs,
          meetingEndMs: item.meetingEndMs,
          durationMs: item.durationMs,
          sampleStart: item.sampleStart,
          sampleEnd: item.sampleEnd,
          firstSampleMonotonicTicks: item.firstSampleMonotonicTicks,
          byteSize: item.byteSize,
          checksum: item.checksum,
          codec: item.codec,
          container: item.container,
          sampleRateHz: item.sampleRateHz,
          channels: item.channels,
          encoderDelaySamples: item.encoderDelaySamples,
          encoderPaddingSamples: item.encoderPaddingSamples,
        });
        item.serverChunkId = registered.chunk.id;
        if (registered.chunk.verificationState === 'verified') {
          item.uploadState = 'verified';
          item.verificationState = 'verified';
          item.verifiedAt = registered.chunk.verifiedAt;
          item.lastErrorCode = null;
          item.lastErrorMessage = null;
          return;
        }
      }

      // Step 2: Obtain or refresh short-lived upload authorization
      if (this.isAuthorizationExpired(item.uploadAuthorization, nowMs)) {
        item.uploadState = 'authorizing';
        item.uploadAuthorization = await this.adapter.authorizeChunkUpload(
          item.recordingId,
          item.serverChunkId,
        );
        if (item.uploadAuthorization.alreadyVerified) {
          item.uploadState = 'verified';
          item.verificationState = 'verified';
          item.lastErrorCode = null;
          item.lastErrorMessage = null;
          return;
        }
      }

      // Step 3: Upload chunk bytes directly to private object storage
      item.uploadState = 'uploading';
      const bytes = await this.localFiles.readChunkBytes(item.localFile);
      try {
        await this.adapter.uploadChunkBytesToStorage(item.uploadAuthorization!, bytes, nowMs);
      } catch (uploadErr) {
        // If signed URL expired right before PUT, clear cached authorization and re-authorize immediately
        if (uploadErr instanceof UploadTransportError && uploadErr.code === 'upload_url_expired') {
          item.uploadAuthorization = null;
          item.uploadState = 'authorizing';
          item.uploadAuthorization = await this.adapter.authorizeChunkUpload(
            item.recordingId,
            item.serverChunkId,
          );
          item.uploadState = 'uploading';
          await this.adapter.uploadChunkBytesToStorage(item.uploadAuthorization, bytes, nowMs);
        } else {
          throw uploadErr;
        }
      }
      item.uploadState = 'uploaded';

      // Step 4: Ask server to independently verify stored object metadata & SHA-256 checksum
      item.uploadState = 'verifying';
      item.verificationState = 'verifying';
      const verified = await this.adapter.verifyChunkUpload(item.recordingId, item.serverChunkId);
      if (!verified.verified) {
        item.verificationState = verified.chunk.verificationState;
        throw new UploadTransportError(
          'verification_failed',
          verified.verification.failureDetail ?? 'Server verification rejected uploaded chunk.',
          true,
        );
      }

      item.uploadState = 'verified';
      item.verificationState = 'verified';
      item.verifiedAt = verified.chunk.verifiedAt;
      item.lastErrorCode = null;
      item.lastErrorMessage = null;
    } catch (cause) {
      item.attemptCount += 1;
      const isTransport = cause instanceof UploadTransportError;
      const code = isTransport ? cause.code : 'network_loss';
      const retryable = isTransport ? cause.retryable : true;
      const message = cause instanceof Error ? cause.message : String(cause);

      if (!retryable || item.attemptCount >= this.maxAttempts) {
        item.uploadState = 'failed_terminal';
      } else {
        item.uploadState = 'failed_retryable';
        item.nextRetryAtMs = this.computeNextRetryAtMs(nowMs, item.attemptCount);
      }
      item.lastErrorCode = code;
      item.lastErrorMessage = message;
    }
  }

  /**
   * Processes all eligible chunks in the queue without throwing or disrupting local capture.
   */
  async processQueue(nowMs = Date.now()): Promise<UploadQueueSnapshot> {
    const ordered = [...this.itemsByKey.values()].sort(
      (a, b) =>
        a.recordingSourceId.localeCompare(b.recordingSourceId) || a.sequenceNo - b.sequenceNo,
    );

    for (const item of ordered) {
      await this.processSingleChunk(item, nowMs);
    }

    return this.snapshot();
  }

  /**
   * Attempts to finalize the recording session on the server only when local capture has stopped
   * and every queued chunk has been server-verified.
   */
  async tryFinalizeRecording(): Promise<FinalizeRecordingResponse | null> {
    if (!this.manifest || this.manifest.state !== 'stopped') {
      return null;
    }
    const items = [...this.itemsByKey.values()];
    if (items.length === 0 || items.some((item) => item.verificationState !== 'verified')) {
      return null;
    }

    const expectedSources = this.manifest.sources.map((source) => ({
      recordingSourceId: source.recordingSourceId,
      expectedChunkCount: items.filter(
        (item) => item.recordingSourceId === source.recordingSourceId,
      ).length,
    }));

    const canonicalDurationMs = items.reduce((max, item) => Math.max(max, item.meetingEndMs), 0);

    const response = await this.adapter.finalizeRecording(this.manifest.recordingId, {
      workspaceId: this.manifest.workspaceId ?? undefined,
      canonicalDurationMs,
      stoppedAt: this.manifest.stoppedAt ?? undefined,
      manifestRevision: this.manifest.revision,
      expectedSources,
    });

    if (response.status === 'finalized') {
      this.finalizedOnServer = true;
      this.processingJobId = response.job.id;
    }

    return response;
  }
}
