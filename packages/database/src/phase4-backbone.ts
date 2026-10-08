import { randomUUID } from 'node:crypto';
import {
  authorizeChunkUploadRequestSchema,
  buildCanonicalChunkIdempotencyKey,
  buildCanonicalPrepareJobIdempotencyKey,
  createRecordingRequestSchema,
  finalizeRecordingRequestSchema,
  registerRecordingChunkRequestSchema,
  registerRecordingSourceRequestSchema,
  verifyChunkUploadRequestSchema,
  type ApiErrorCode,
  type AuthorizeChunkUploadRequestInput,
  type ChunkUploadAuthorizationDto,
  type ChunkUploadState,
  type ChunkVerificationState,
  type CreateRecordingRequestInput,
  type DeleteRecordingResponse,
  type FinalizeRecordingRequestInput,
  type FinalizeRecordingResponse,
  type MeetingPipelineStatus,
  type MeetingProcessingResponse,
  type ObjectDeletionEntryDto,
  type ProcessingEventDto,
  type ProcessingEventType,
  type ProcessingJobDto,
  type ProcessingJobStatus,
  type RecordingChunkDto,
  type RecordingDetailResponse,
  type RecordingDto,
  type RecordingSourceDto,
  type RegisterRecordingChunkRequestInput,
  type RegisterRecordingSourceRequestInput,
  type StorageBackend,
  type VerifyChunkUploadRequestInput,
  type VerifyChunkUploadResponse,
} from '@suhbat/contracts';
import type { MeetingProcessingState, ProcessingStep, ProcessingTimeline } from '@suhbat/product';
import {
  assertPrivateCanonicalStorageKey,
  buildRecordingChunkStorageKey,
  type StorageProvider,
} from './storage';

export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<SqlQueryResult<Row>>;
  exec?(sql: string): Promise<unknown>;
}

export type AuthenticatedPrincipal = {
  userId: string;
};

export class Phase4ServiceError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly detail?: string;

  constructor(statusCode: number, code: ApiErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'Phase4ServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

const REDACTED_KEY_PATTERN =
  /(uploadurl|readurl|signedurl|authorization|token|secret|password|servicerole|apikey|accesskey|privatekey|connectionstring|dburl|audiobytes|rawaudio|payloadbytes|^bytes$|^pcm$)/i;

const SAFE_METADATA_KEY_SET = new Set([
  'prompttokens',
  'completiontokens',
  'totaltokens',
  'fencingtoken',
  'tokenusagemetadata',
]);

/**
 * Redacts sensitive fields (signed URLs, tokens, secrets, raw audio bytes) from observability metadata/logs.
 */
export function redactObservabilityMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (!SAFE_METADATA_KEY_SET.has(normalized) && REDACTED_KEY_PATTERN.test(normalized)) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (
      typeof value === 'string' &&
      (/^(https?|storage|mem-storage):\/\/.*[?&](X-Amz-Signature|sig|auth)=/i.test(value) ||
        /^Bearer\s+/i.test(value) ||
        /^sk-[A-Za-z0-9_-]{8,}/.test(value) ||
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
        /^postgres(ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value))
    ) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.map((item) => {
        if (item instanceof Uint8Array || Buffer.isBuffer(item)) return '[REDACTED]';
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return redactObservabilityMetadata(item as Record<string, unknown>);
        }
        return item;
      });
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redactObservabilityMetadata(value as Record<string, unknown>);
      continue;
    }
    output[key] = value;
  }
  return output;
}

export type StructuredObservabilityEvent = {
  event: ProcessingEventType;
  workspace_id: string;
  meeting_id: string;
  recording_id: string | null;
  source_id: string | null;
  chunk_id: string | null;
  job_id: string | null;
  sequence_no: number | null;
  fencing_token: number | null;
  metadata: Record<string, unknown>;
  timestamp: string;
};

export type ObservabilitySink = (entry: StructuredObservabilityEvent) => void;

type DbMeetingRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  project_id: string | null;
  meeting_type_id: string;
  title: string;
  status:
    | 'draft'
    | 'recording'
    | 'uploading'
    | 'processing'
    | 'ready_for_transcription'
    | 'transcribing'
    | 'normalizing_transcript'
    | 'transcript_ready'
    | 'transcription_failed'
    | 'ready_for_analysis'
    | 'analyzing'
    | 'normalizing_analysis'
    | 'analysis_ready'
    | 'analysis_failed'
    | 'ready'
    | 'failed'
    | 'archived';
  processing_status: MeetingPipelineStatus;
  started_at: string | null;
  ended_at: string | null;
  timeline_origin_at: string | null;
  timeline_duration_ms: number | null;
  active_capture_duration_ms: number | null;
  current_transcription_run_id?: string | null;
  latest_transcription_run_id?: string | null;
  current_analysis_run_id?: string | null;
  latest_analysis_run_id?: string | null;
  detected_languages?: string[];
  deleted_at: string | null;
  purge_status: 'active' | 'tombstoned' | 'purge_pending' | 'purged';
  created_by: string;
  created_at: string;
  updated_at: string;
};

type DbRecordingRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  session_id: string;
  status: RecordingDto['status'];
  clock_kind: string;
  clock_epoch_id: string;
  origin_ticks: string;
  origin_wall_clock_utc: string;
  tick_frequency_hz: number | string;
  canonical_duration_ms: number | null;
  active_capture_ms: number | null;
  started_at: string;
  stopped_at: string | null;
  finalized_at: string | null;
  consent_acknowledged_at: string;
  consent_policy_version: string;
  manifest_revision: number;
  timeline_metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type DbSourceRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  source_kind: RecordingSourceDto['sourceKind'];
  source_role: RecordingSourceDto['sourceRole'];
  is_required: boolean;
  device_uid: string | null;
  device_name: string | null;
  started_at_ticks: string | null;
  ended_at_ticks: string | null;
  first_sample_index: number | string;
  last_sample_index_exclusive: number | string | null;
  first_sample_meeting_ms: number;
  last_sample_meeting_ms: number | null;
  dropped_sample_count: number | string;
  expected_chunk_count: number | null;
  capture_metadata: Record<string, unknown>;
  codec: string;
  container: RecordingSourceDto['container'];
  sample_rate_hz: number;
  channels: number;
  format_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type DbChunkRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  recording_source_id: string;
  client_chunk_id: string;
  idempotency_key: string;
  sequence_no: number;
  meeting_start_ms: number;
  meeting_end_ms: number;
  duration_ms: number;
  sample_start: number | string;
  sample_end: number | string;
  first_sample_monotonic_ticks: string;
  byte_size: number | string;
  checksum_algorithm: 'sha256';
  checksum_sha256: string;
  storage_backend: StorageBackend;
  storage_key: string;
  upload_state: ChunkUploadState;
  verification_state: ChunkVerificationState;
  codec: string;
  container: RecordingChunkDto['container'];
  sample_rate_hz: number;
  channels: number;
  encoder_delay_samples: number;
  encoder_padding_samples: number;
  verified_byte_size: number | string | null;
  verified_sha256: string | null;
  verification_method: string | null;
  verification_error_code: string | null;
  created_at: string;
  updated_at: string;
  uploaded_at: string | null;
  verified_at: string | null;
};

type DbJobRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  job_type: ProcessingJobDto['jobType'];
  generation: number;
  idempotency_key: string;
  status: ProcessingJobStatus;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  fencing_token: number | string;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  error_metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  result_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type DbEventRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string | null;
  recording_source_id: string | null;
  recording_chunk_id: string | null;
  processing_job_id: string | null;
  sequence_no: number | null;
  event_type: ProcessingEventType;
  actor_id: string | null;
  fencing_token: number | string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type DbLedgerRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  recording_chunk_id: string | null;
  storage_backend: StorageBackend;
  storage_key: string;
  expected_byte_size: number | string;
  expected_sha256: string;
  status: 'pending' | 'deleted' | 'reconciliation_required';
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function toIsoString(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return new Date(val).toISOString();
  return new Date().toISOString();
}

function toNullableIsoString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return toIsoString(val);
}

function toNum(val: number | string): number {
  return typeof val === 'number' ? val : Number.parseInt(val, 10);
}

function toNullableNum(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  return toNum(val);
}

function mapRecordingRow(row: DbRecordingRow): RecordingDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    sessionId: row.session_id,
    status: row.status,
    timeline: {
      clock: 'platform_monotonic_continuous',
      clockEpochId: row.clock_epoch_id,
      originTicks: row.origin_ticks,
      originWallClockUtc: toIsoString(row.origin_wall_clock_utc),
      tickFrequencyHz: toNum(row.tick_frequency_hz),
    },
    consent: {
      acknowledgedAt: toIsoString(row.consent_acknowledged_at),
      policyVersion: row.consent_policy_version,
    },
    canonicalDurationMs: row.canonical_duration_ms,
    activeCaptureMs: row.active_capture_ms,
    startedAt: toIsoString(row.started_at),
    stoppedAt: toNullableIsoString(row.stopped_at),
    finalizedAt: toNullableIsoString(row.finalized_at),
    manifestRevision: row.manifest_revision,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapSourceRow(row: DbSourceRow): RecordingSourceDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    sourceKind: row.source_kind,
    sourceRole: row.source_role,
    isRequired: row.is_required,
    codec: row.codec,
    container: row.container,
    sampleRateHz: row.sample_rate_hz,
    channels: row.channels,
    deviceUid: row.device_uid,
    deviceName: row.device_name,
    startedAtTicks: row.started_at_ticks,
    endedAtTicks: row.ended_at_ticks,
    firstSampleIndex: toNum(row.first_sample_index),
    lastSampleIndexExclusive: toNullableNum(row.last_sample_index_exclusive),
    firstSampleMeetingMs: row.first_sample_meeting_ms,
    lastSampleMeetingMs: row.last_sample_meeting_ms,
    droppedSampleCount: toNum(row.dropped_sample_count),
    expectedChunkCount: row.expected_chunk_count,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapChunkRow(row: DbChunkRow): RecordingChunkDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    recordingSourceId: row.recording_source_id,
    clientChunkId: row.client_chunk_id,
    idempotencyKey: row.idempotency_key,
    sequenceNo: row.sequence_no,
    meetingStartMs: row.meeting_start_ms,
    meetingEndMs: row.meeting_end_ms,
    durationMs: row.duration_ms,
    sampleStart: toNum(row.sample_start),
    sampleEnd: toNum(row.sample_end),
    firstSampleMonotonicTicks: row.first_sample_monotonic_ticks,
    byteSize: toNum(row.byte_size),
    checksum: {
      algorithm: 'sha256',
      value: row.checksum_sha256,
    },
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    uploadState: row.upload_state,
    verificationState: row.verification_state,
    codec: row.codec,
    container: row.container,
    sampleRateHz: row.sample_rate_hz,
    channels: row.channels,
    encoderDelaySamples: row.encoder_delay_samples,
    encoderPaddingSamples: row.encoder_padding_samples,
    verifiedByteSize: toNullableNum(row.verified_byte_size),
    verifiedSha256: row.verified_sha256,
    verificationMethod: row.verification_method,
    verificationErrorCode: row.verification_error_code,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    uploadedAt: toNullableIsoString(row.uploaded_at),
    verifiedAt: toNullableIsoString(row.verified_at),
  };
}

function mapJobRow(row: DbJobRow): ProcessingJobDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    jobType: row.job_type,
    generation: row.generation,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toNullableIsoString(row.lease_expires_at),
    heartbeatAt: toNullableIsoString(row.heartbeat_at),
    fencingToken: toNum(row.fencing_token),
    scheduledAt: toIsoString(row.scheduled_at),
    startedAt: toNullableIsoString(row.started_at),
    completedAt: toNullableIsoString(row.completed_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorMetadata: row.error_metadata ?? {},
    payload: row.payload ?? {},
    resultMetadata: row.result_metadata ?? {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapEventRow(row: DbEventRow): ProcessingEventDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    recordingSourceId: row.recording_source_id,
    recordingChunkId: row.recording_chunk_id,
    processingJobId: row.processing_job_id,
    sequenceNo: row.sequence_no,
    eventType: row.event_type,
    actorId: row.actor_id,
    fencingToken: toNullableNum(row.fencing_token),
    metadata: row.metadata ?? {},
    createdAt: toIsoString(row.created_at),
  };
}

function mapLedgerRow(row: DbLedgerRow): ObjectDeletionEntryDto {
  return {
    id: row.id,
    recordingChunkId: row.recording_chunk_id,
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}

/**
 * Maps real backend meeting/recording/chunk/job state into the product UI `ProcessingTimeline` and `MeetingProcessingState`.
 *
 * Crucial Phase 4 rule:
 * A meeting NEVER enters `'ready'` in Phase 4 because transcription and AI analysis have not happened yet.
 * When `prepare_recording` succeeds, the meeting enters `'ready_for_transcription'`.
 */
export function buildProductProcessingTimeline(params: {
  meeting: DbMeetingRow;
  recording: DbRecordingRow | null;
  sources: DbSourceRow[];
  chunks: DbChunkRow[];
  jobs: DbJobRow[];
}): { productState: MeetingProcessingState; timeline: ProcessingTimeline } {
  const { meeting, recording, sources, chunks, jobs } = params;
  const totalChunks = chunks.length;
  const verifiedChunks = chunks.filter((c) => c.verification_state === 'verified').length;
  const rejectedChunks = chunks.filter((c) => c.verification_state === 'rejected').length;
  const prepareJob = jobs.find((j) => j.job_type === 'prepare_recording') ?? null;
  const transcribeJob = jobs.find((j) => j.job_type === 'transcribe_meeting') ?? null;
  const normalizeJob = jobs.find((j) => j.job_type === 'normalize_transcript') ?? null;
  const finalizeJob = jobs.find((j) => j.job_type === 'finalize_transcript') ?? null;
  const analyzeJob = jobs.find((j) => j.job_type === 'analyze_meeting') ?? null;
  const normalizeIntelJob = jobs.find((j) => j.job_type === 'normalize_intelligence') ?? null;
  const finalizeAnalysisJob = jobs.find((j) => j.job_type === 'finalize_analysis') ?? null;

  const hasPhase6Activity = Boolean(
    analyzeJob ||
    normalizeIntelJob ||
    finalizeAnalysisJob ||
    meeting.status === 'ready_for_analysis' ||
    meeting.status === 'analyzing' ||
    meeting.status === 'normalizing_analysis' ||
    meeting.status === 'analysis_ready' ||
    meeting.status === 'analysis_failed' ||
    meeting.status === 'ready' ||
    meeting.processing_status === 'ready_for_analysis' ||
    meeting.processing_status === 'analyzing' ||
    meeting.processing_status === 'normalizing_analysis' ||
    meeting.processing_status === 'analysis_ready' ||
    meeting.processing_status === 'analysis_failed' ||
    meeting.processing_status === 'ready' ||
    meeting.current_analysis_run_id,
  );

  const hasPhase5Activity = Boolean(
    hasPhase6Activity ||
    transcribeJob ||
    normalizeJob ||
    finalizeJob ||
    meeting.status === 'transcribing' ||
    meeting.status === 'normalizing_transcript' ||
    meeting.status === 'transcript_ready' ||
    meeting.status === 'transcription_failed' ||
    meeting.processing_status === 'transcribing' ||
    meeting.processing_status === 'normalizing_transcript' ||
    meeting.processing_status === 'transcript_ready' ||
    meeting.processing_status === 'transcription_failed' ||
    meeting.current_transcription_run_id,
  );

  // Determine canonical product state honestly. Only finalized Phase 6 analysis may enter `ready`.
  let productState: MeetingProcessingState = 'draft';
  if (
    meeting.status === 'analysis_failed' ||
    meeting.processing_status === 'analysis_failed' ||
    ((analyzeJob?.status === 'dead_lettered' ||
      normalizeIntelJob?.status === 'dead_lettered' ||
      finalizeAnalysisJob?.status === 'dead_lettered') &&
      meeting.status !== 'ready')
  ) {
    productState = 'analysis_failed';
  } else if (
    meeting.status === 'ready' ||
    meeting.processing_status === 'ready' ||
    finalizeAnalysisJob?.status === 'succeeded' ||
    Boolean(meeting.current_analysis_run_id)
  ) {
    productState = 'ready';
  } else if (
    meeting.status === 'analysis_ready' ||
    meeting.processing_status === 'analysis_ready' ||
    (finalizeAnalysisJob &&
      (finalizeAnalysisJob.status === 'queued' ||
        finalizeAnalysisJob.status === 'running' ||
        finalizeAnalysisJob.status === 'retryable_failed'))
  ) {
    productState = 'analysis_ready';
  } else if (
    meeting.status === 'normalizing_analysis' ||
    meeting.processing_status === 'normalizing_analysis' ||
    (normalizeIntelJob &&
      (normalizeIntelJob.status === 'queued' ||
        normalizeIntelJob.status === 'running' ||
        normalizeIntelJob.status === 'retryable_failed'))
  ) {
    productState = 'normalizing_analysis';
  } else if (
    meeting.status === 'analyzing' ||
    meeting.processing_status === 'analyzing' ||
    (analyzeJob && (analyzeJob.status === 'running' || analyzeJob.status === 'retryable_failed'))
  ) {
    productState = 'analyzing';
  } else if (
    meeting.status === 'ready_for_analysis' ||
    meeting.processing_status === 'ready_for_analysis' ||
    analyzeJob?.status === 'queued'
  ) {
    productState = 'ready_for_analysis';
  } else if (
    meeting.status === 'transcription_failed' ||
    meeting.processing_status === 'transcription_failed' ||
    transcribeJob?.status === 'dead_lettered' ||
    normalizeJob?.status === 'dead_lettered' ||
    finalizeJob?.status === 'dead_lettered'
  ) {
    productState = 'transcription_failed';
  } else if (
    meeting.status === 'failed' ||
    meeting.processing_status === 'failed' ||
    recording?.status === 'failed' ||
    prepareJob?.status === 'dead_lettered'
  ) {
    productState = 'failed';
  } else if (
    meeting.status === 'transcript_ready' ||
    meeting.processing_status === 'transcript_ready' ||
    finalizeJob?.status === 'succeeded' ||
    Boolean(meeting.current_transcription_run_id)
  ) {
    productState = 'transcript_ready';
  } else if (
    meeting.status === 'normalizing_transcript' ||
    meeting.processing_status === 'normalizing_transcript' ||
    (normalizeJob &&
      (normalizeJob.status === 'queued' ||
        normalizeJob.status === 'running' ||
        normalizeJob.status === 'retryable_failed' ||
        normalizeJob.status === 'succeeded')) ||
    (finalizeJob &&
      (finalizeJob.status === 'queued' ||
        finalizeJob.status === 'running' ||
        finalizeJob.status === 'retryable_failed'))
  ) {
    productState = 'normalizing_transcript';
  } else if (
    meeting.status === 'transcribing' ||
    meeting.processing_status === 'transcribing' ||
    (transcribeJob &&
      (transcribeJob.status === 'queued' ||
        transcribeJob.status === 'running' ||
        transcribeJob.status === 'retryable_failed'))
  ) {
    productState = 'transcribing';
  } else if (
    meeting.status === 'ready_for_transcription' ||
    meeting.processing_status === 'ready_for_transcription' ||
    prepareJob?.status === 'succeeded'
  ) {
    productState = 'ready_for_transcription';
  } else if (
    meeting.processing_status === 'preparing' ||
    meeting.processing_status === 'uploaded' ||
    recording?.status === 'finalized' ||
    (prepareJob &&
      (prepareJob.status === 'queued' ||
        prepareJob.status === 'running' ||
        prepareJob.status === 'retryable_failed'))
  ) {
    productState = 'preparing';
  } else if (
    meeting.processing_status === 'uploading' ||
    recording?.status === 'uploading' ||
    totalChunks > 0
  ) {
    productState = 'uploading';
  } else if (
    meeting.processing_status === 'recording' ||
    recording?.status === 'registered' ||
    recording?.status === 'recording' ||
    recording?.status === 'paused'
  ) {
    productState = 'recording';
  }

  const isPhase5Or6CompleteOrActive =
    productState === 'transcribing' ||
    productState === 'normalizing_transcript' ||
    productState === 'transcript_ready' ||
    productState === 'transcription_failed' ||
    productState === 'ready_for_analysis' ||
    productState === 'analyzing' ||
    productState === 'normalizing_analysis' ||
    productState === 'analysis_ready' ||
    productState === 'analysis_failed' ||
    productState === 'ready';

  const captureDone = Boolean(
    recording &&
    (recording.status === 'uploading' ||
      recording.status === 'finalizing' ||
      recording.status === 'finalized' ||
      totalChunks > 0),
  );
  const allChunksVerified =
    Boolean(recording?.status === 'finalized') ||
    (totalChunks > 0 && verifiedChunks === totalChunks && sources.length > 0);
  const jobSucceeded = prepareJob?.status === 'succeeded' || isPhase5Or6CompleteOrActive;
  const jobFailed = prepareJob?.status === 'dead_lettered';

  const steps: ProcessingStep[] = [
    {
      key: 'capture',
      label: 'Captured on device',
      state: captureDone ? 'done' : recording ? 'active' : 'pending',
      ...(recording?.started_at ? { at: toIsoString(recording.started_at) } : {}),
      detail: recording
        ? `${sources.length} source${sources.length === 1 ? '' : 's'} registered`
        : 'Waiting for desktop recorder session',
    },
    {
      key: 'upload',
      label: 'Uploaded to private storage',
      state: allChunksVerified
        ? 'done'
        : rejectedChunks > 0 && productState === 'failed'
          ? 'failed'
          : totalChunks > 0
            ? 'active'
            : 'pending',
      ...(recording?.finalized_at ? { at: toIsoString(recording.finalized_at) } : {}),
      detail:
        totalChunks > 0
          ? `${verifiedChunks} of ${totalChunks} chunk${totalChunks === 1 ? '' : 's'} verified`
          : 'No chunks registered yet',
    },
    {
      key: 'prepare_recording',
      label: 'Recording prepared',
      state: jobSucceeded ? 'done' : jobFailed ? 'failed' : prepareJob ? 'active' : 'pending',
      ...(prepareJob?.completed_at
        ? { at: toIsoString(prepareJob.completed_at) }
        : prepareJob?.started_at
          ? { at: toIsoString(prepareJob.started_at) }
          : {}),
      detail: jobSucceeded
        ? 'Verified chunk inventory and canonical timeline prepared'
        : prepareJob?.status === 'retryable_failed'
          ? `Retry scheduled (attempt ${prepareJob.attempt} of ${prepareJob.max_attempts})`
          : prepareJob
            ? 'Validating verified source and chunk inventory'
            : 'Waiting for recording finalization',
    },
    {
      key: 'ready_for_transcription',
      label: 'Ready for transcription',
      state: jobSucceeded ? 'done' : 'pending',
      ...(prepareJob?.completed_at && jobSucceeded
        ? { at: toIsoString(prepareJob.completed_at) }
        : {}),
      detail: jobSucceeded
        ? hasPhase5Activity
          ? 'Canonical transcription asset prepared for provider stage'
          : 'Awaiting transcription provider stage (not started in Phase 4)'
        : 'Requires prepared recording inventory',
    },
  ];

  const isTranscriptFinalizedOrLater =
    productState === 'transcript_ready' ||
    productState === 'ready_for_analysis' ||
    productState === 'analyzing' ||
    productState === 'normalizing_analysis' ||
    productState === 'analysis_ready' ||
    productState === 'analysis_failed' ||
    productState === 'ready';

  if (hasPhase5Activity) {
    const transcribeSucceeded =
      transcribeJob?.status === 'succeeded' ||
      productState === 'normalizing_transcript' ||
      isTranscriptFinalizedOrLater;
    const transcribeFailed = transcribeJob?.status === 'dead_lettered';
    const normalizeSucceeded = normalizeJob?.status === 'succeeded' || isTranscriptFinalizedOrLater;
    const normalizeFailed =
      normalizeJob?.status === 'dead_lettered' || finalizeJob?.status === 'dead_lettered';
    const transcriptReadyDone = isTranscriptFinalizedOrLater;

    steps.push(
      {
        key: 'transcribe',
        label: 'Transcribed',
        state: transcribeSucceeded
          ? 'done'
          : transcribeFailed || (productState === 'transcription_failed' && !transcribeSucceeded)
            ? 'failed'
            : transcribeJob
              ? 'active'
              : 'pending',
        ...(transcribeJob?.completed_at
          ? { at: toIsoString(transcribeJob.completed_at) }
          : transcribeJob?.started_at
            ? { at: toIsoString(transcribeJob.started_at) }
            : {}),
        detail: transcribeSucceeded
          ? 'Provider speech segments and diarized speaker labels captured'
          : transcribeJob?.status === 'retryable_failed'
            ? `Retry scheduled (attempt ${transcribeJob.attempt} of ${transcribeJob.max_attempts})`
            : transcribeFailed
              ? (transcribeJob?.error_message ?? 'Transcription provider stage failed')
              : 'Running provider speech-to-text and speaker diarization',
      },
      {
        key: 'normalize_transcript',
        label: 'Transcript aligned to canonical timeline',
        state: normalizeSucceeded
          ? 'done'
          : normalizeFailed
            ? 'failed'
            : normalizeJob || productState === 'normalizing_transcript'
              ? 'active'
              : 'pending',
        ...(normalizeJob?.completed_at
          ? { at: toIsoString(normalizeJob.completed_at) }
          : normalizeJob?.started_at
            ? { at: toIsoString(normalizeJob.started_at) }
            : {}),
        detail: normalizeSucceeded
          ? 'Mapped provider timestamps onto canonical meeting timeline'
          : normalizeFailed
            ? (normalizeJob?.error_message ??
              finalizeJob?.error_message ??
              'Canonical timestamp alignment failed')
            : 'Mapping provider timestamps through piecewise asset timeline map',
      },
      {
        key: 'transcript_ready',
        label: 'Transcript ready',
        state: transcriptReadyDone ? 'done' : 'pending',
        ...(finalizeJob?.completed_at ? { at: toIsoString(finalizeJob.completed_at) } : {}),
        detail: transcriptReadyDone
          ? hasPhase6Activity
            ? 'Canonical transcript finalized for AI meeting intelligence'
            : 'Canonical transcript and speaker segments persisted (AI analysis pending Phase 6)'
          : 'Awaiting canonical transcript finalization',
      },
    );
  }

  if (hasPhase6Activity) {
    const analyzeSucceeded =
      analyzeJob?.status === 'succeeded' ||
      productState === 'normalizing_analysis' ||
      productState === 'analysis_ready' ||
      productState === 'ready';
    const analyzeFailed = analyzeJob?.status === 'dead_lettered';
    const normalizeIntelSucceeded =
      normalizeIntelJob?.status === 'succeeded' ||
      productState === 'analysis_ready' ||
      productState === 'ready';
    const normalizeIntelFailed =
      normalizeIntelJob?.status === 'dead_lettered' ||
      finalizeAnalysisJob?.status === 'dead_lettered';
    const analysisFinalized = productState === 'ready';

    steps.push(
      {
        key: 'analyze_meeting',
        label: 'Structured intelligence extracted',
        state: analyzeSucceeded
          ? 'done'
          : analyzeFailed || (productState === 'analysis_failed' && !analyzeSucceeded)
            ? 'failed'
            : analyzeJob || productState === 'analyzing' || productState === 'ready_for_analysis'
              ? 'active'
              : 'pending',
        ...(analyzeJob?.completed_at
          ? { at: toIsoString(analyzeJob.completed_at) }
          : analyzeJob?.started_at
            ? { at: toIsoString(analyzeJob.started_at) }
            : {}),
        detail: analyzeSucceeded
          ? 'Windowed LLM extraction completed with segment evidence references'
          : analyzeJob?.status === 'retryable_failed'
            ? `Retry scheduled (attempt ${analyzeJob.attempt} of ${analyzeJob.max_attempts})`
            : analyzeFailed
              ? (analyzeJob?.error_message ?? 'AI meeting intelligence extraction failed')
              : 'Extracting structured topics, decisions, action items, facts, and risks',
      },
      {
        key: 'normalize_intelligence',
        label: 'Intelligence evidence validated',
        state: normalizeIntelSucceeded
          ? 'done'
          : normalizeIntelFailed
            ? 'failed'
            : normalizeIntelJob || productState === 'normalizing_analysis'
              ? 'active'
              : 'pending',
        ...(normalizeIntelJob?.completed_at
          ? { at: toIsoString(normalizeIntelJob.completed_at) }
          : normalizeIntelJob?.started_at
            ? { at: toIsoString(normalizeIntelJob.started_at) }
            : {}),
        detail: normalizeIntelSucceeded
          ? 'Validated segment evidence references and persisted canonical intelligence entities'
          : normalizeIntelFailed
            ? (normalizeIntelJob?.error_message ??
              finalizeAnalysisJob?.error_message ??
              'Evidence validation failed')
            : 'Validating evidence links against canonical transcript segments',
      },
      {
        key: 'finalize_analysis',
        label: 'Meeting intelligence finalized',
        state: analysisFinalized ? 'done' : 'pending',
        ...(finalizeAnalysisJob?.completed_at
          ? { at: toIsoString(finalizeAnalysisJob.completed_at) }
          : {}),
        detail: analysisFinalized
          ? 'Structured meeting intelligence and evidence links are live'
          : 'Awaiting analysis finalization',
      },
    );
  }

  const failedPhase5Job = [finalizeJob, normalizeJob, transcribeJob].find(
    (j) => j && (j.status === 'dead_lettered' || j.error_code),
  );
  const failedPhase6Job = [finalizeAnalysisJob, normalizeIntelJob, analyzeJob].find(
    (j) => j && (j.status === 'dead_lettered' || j.error_code),
  );

  const timeline: ProcessingTimeline = {
    meetingId: meeting.id,
    state: productState,
    steps,
    ...(productState === 'failed'
      ? {
          error: {
            code: prepareJob?.error_code ?? 'recording_processing_failed',
            message:
              prepareJob?.error_message ??
              'Recording preparation failed after the configured retry budget.',
            hint: 'Inspect processing events or retry from the last verified stage.',
            retryable: prepareJob ? prepareJob.status !== 'dead_lettered' : true,
          },
        }
      : productState === 'transcription_failed'
        ? {
            error: {
              code: failedPhase5Job?.error_code ?? 'transcription_failed',
              message:
                failedPhase5Job?.error_message ??
                'Transcription or canonical timeline alignment failed.',
              hint: 'Verified recording chunks are preserved. Retry transcription when the provider configuration or input is ready.',
              retryable: true,
            },
          }
        : productState === 'analysis_failed'
          ? {
              error: {
                code: failedPhase6Job?.error_code ?? 'analysis_failed',
                message:
                  failedPhase6Job?.error_message ??
                  'AI meeting intelligence or evidence validation failed.',
                hint: 'Canonical transcript is preserved. Retry analysis when the intelligence provider configuration is ready.',
                retryable: true,
              },
            }
          : {}),
  };

  return { productState, timeline };
}

export class Phase4BackboneService {
  readonly db: SqlExecutor;
  readonly storage: StorageProvider;
  private readonly onEvent?: ObservabilitySink;

  constructor(options: { db: SqlExecutor; storage: StorageProvider; onEvent?: ObservabilitySink }) {
    this.db = options.db;
    this.storage = options.storage;
    this.onEvent = options.onEvent;
  }

  private requireAuth(auth: AuthenticatedPrincipal | null | undefined): AuthenticatedPrincipal {
    if (!auth || !auth.userId || typeof auth.userId !== 'string') {
      throw new Phase4ServiceError(
        401,
        'unauthenticated',
        'Authenticated user session is required.',
      );
    }
    return auth;
  }

  private async assertActiveWorkspaceMembership(
    userId: string,
    workspaceId: string,
  ): Promise<{ role: 'owner' | 'admin' | 'member' }> {
    const res = await this.db.query<{ role: 'owner' | 'admin' | 'member' }>(
      `select role::text as role
         from public.workspace_members
        where workspace_id = $1
          and user_id = $2
          and membership_status = 'active'`,
      [workspaceId, userId],
    );
    const membership = res.rows[0];
    if (!membership) {
      throw new Phase4ServiceError(
        403,
        'unauthorized',
        'Active workspace membership is required for this operation.',
      );
    }
    return membership;
  }

  private async loadAuthorizedMeeting(
    userId: string,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<DbMeetingRow> {
    const res = await this.db.query<DbMeetingRow>(
      `select *
         from public.meetings
        where id = $1`,
      [meetingId],
    );
    const meeting = res.rows[0];
    if (!meeting || meeting.deleted_at !== null || meeting.purge_status === 'purged') {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }
    if (clientWorkspaceId && clientWorkspaceId !== meeting.workspace_id) {
      // Also check whether the user is even a member of either workspace to classify accurately.
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Meeting does not belong to the supplied workspace.',
      );
    }
    await this.assertActiveWorkspaceMembership(userId, meeting.workspace_id);
    return meeting;
  }

  private async loadAuthorizedRecording(
    userId: string,
    recordingId: string,
    clientWorkspaceId?: string,
  ): Promise<{ recording: DbRecordingRow; meeting: DbMeetingRow }> {
    const res = await this.db.query<DbRecordingRow>(
      `select *
         from public.recordings
        where id = $1`,
      [recordingId],
    );
    const recording = res.rows[0];
    if (!recording || recording.deleted_at !== null || recording.status === 'deleted') {
      throw new Phase4ServiceError(404, 'not_found', 'Recording session was not found.');
    }
    if (clientWorkspaceId && clientWorkspaceId !== recording.workspace_id) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Recording does not belong to the supplied workspace.',
      );
    }
    const meeting = await this.loadAuthorizedMeeting(
      userId,
      recording.meeting_id,
      recording.workspace_id,
    );
    return { recording, meeting };
  }

  async recordProcessingEvent(params: {
    workspaceId: string;
    meetingId: string;
    recordingId?: string | null;
    recordingSourceId?: string | null;
    recordingChunkId?: string | null;
    processingJobId?: string | null;
    sequenceNo?: number | null;
    eventType: ProcessingEventType;
    actorId?: string | null;
    fencingToken?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProcessingEventDto> {
    const safeMetadata = redactObservabilityMetadata(params.metadata ?? {});
    const res = await this.db.query<DbEventRow>(
      `insert into public.processing_events (
        workspace_id, meeting_id, recording_id, recording_source_id, recording_chunk_id,
        processing_job_id, sequence_no, event_type, actor_id, fencing_token, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      returning *`,
      [
        params.workspaceId,
        params.meetingId,
        params.recordingId ?? null,
        params.recordingSourceId ?? null,
        params.recordingChunkId ?? null,
        params.processingJobId ?? null,
        params.sequenceNo ?? null,
        params.eventType,
        params.actorId ?? null,
        params.fencingToken ?? null,
        JSON.stringify(safeMetadata),
      ],
    );
    const eventDto = mapEventRow(res.rows[0]!);
    this.onEvent?.({
      event: eventDto.eventType,
      workspace_id: eventDto.workspaceId,
      meeting_id: eventDto.meetingId,
      recording_id: eventDto.recordingId,
      source_id: eventDto.recordingSourceId,
      chunk_id: eventDto.recordingChunkId,
      job_id: eventDto.processingJobId,
      sequence_no: eventDto.sequenceNo,
      fencing_token: eventDto.fencingToken,
      metadata: safeMetadata,
      timestamp: eventDto.createdAt,
    });
    return eventDto;
  }

  /**
   * 3. Register a recorder session (`POST /api/v1/recordings`).
   */
  async createRecording(
    authInput: AuthenticatedPrincipal | null | undefined,
    rawInput: CreateRecordingRequestInput,
  ): Promise<{ recording: RecordingDto; idempotentReused: boolean }> {
    const auth = this.requireAuth(authInput);
    const parsed = createRecordingRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid recording registration request.',
      );
    }
    const input = parsed.data;

    // First verify the user is an active member of the workspace they claimed AND that the meeting belongs to it.
    await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    const meeting = await this.loadAuthorizedMeeting(
      auth.userId,
      input.meetingId,
      input.workspaceId,
    );

    // Check idempotent retry by (meeting_id, session_id)
    const existingRes = await this.db.query<DbRecordingRow>(
      `select *
         from public.recordings
        where meeting_id = $1
          and session_id = $2`,
      [meeting.id, input.sessionId],
    );
    const existing = existingRes.rows[0];
    if (existing) {
      if (
        (input.recordingId && existing.id !== input.recordingId) ||
        existing.clock_epoch_id !== input.timeline.clockEpochId ||
        existing.origin_ticks !== input.timeline.originTicks ||
        toNum(existing.tick_frequency_hz) !== input.timeline.tickFrequencyHz
      ) {
        throw new Phase4ServiceError(
          409,
          'recording_conflict',
          'Recording session already exists with conflicting timeline metadata.',
        );
      }
      return { recording: mapRecordingRow(existing), idempotentReused: true };
    }

    const recordingId = input.recordingId ?? randomUUID();
    const startedAt = input.startedAt ?? input.timeline.originWallClockUtc;
    const insertRes = await this.db.query<DbRecordingRow>(
      `insert into public.recordings (
        id, workspace_id, meeting_id, session_id, status, clock_kind, clock_epoch_id,
        origin_ticks, origin_wall_clock_utc, tick_frequency_hz, started_at,
        consent_acknowledged_at, consent_policy_version, manifest_revision,
        timeline_metadata, created_by
      )
      values ($1, $2, $3, $4, 'registered', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
      returning *`,
      [
        recordingId,
        meeting.workspace_id,
        meeting.id,
        input.sessionId,
        input.timeline.clock,
        input.timeline.clockEpochId,
        input.timeline.originTicks,
        input.timeline.originWallClockUtc,
        input.timeline.tickFrequencyHz,
        startedAt,
        input.consent.acknowledgedAt,
        input.consent.policyVersion,
        input.manifestRevision,
        JSON.stringify(redactObservabilityMetadata(input.timelineMetadata)),
        auth.userId,
      ],
    );
    const recording = insertRes.rows[0]!;

    await this.db.query(
      `update public.meetings
          set status = case when status = 'draft' then 'recording'::public.meeting_status else status end,
              processing_status = case when processing_status = 'idle' then 'recording'::public.meeting_processing_status else processing_status end,
              started_at = coalesce(started_at, $3),
              timeline_origin_at = coalesce(timeline_origin_at, $4)
        where id = $1
          and workspace_id = $2`,
      [meeting.id, meeting.workspace_id, startedAt, input.timeline.originWallClockUtc],
    );

    await this.recordProcessingEvent({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: recording.id,
      eventType: 'recording_created',
      actorId: auth.userId,
      metadata: {
        session_id: recording.session_id,
        clock_epoch_id: recording.clock_epoch_id,
      },
    });

    return { recording: mapRecordingRow(recording), idempotentReused: false };
  }

  /**
   * 4. Register microphone/system recording sources (`POST /api/v1/recordings/{recordingId}/sources`).
   */
  async registerSource(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    rawInput: RegisterRecordingSourceRequestInput,
  ): Promise<{ source: RecordingSourceDto; idempotentReused: boolean }> {
    const auth = this.requireAuth(authInput);
    const parsed = registerRecordingSourceRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid recording source registration request.',
      );
    }
    const input = parsed.data;
    if (input.workspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    }
    const { recording } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      input.workspaceId,
    );

    if (recording.status === 'finalized') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot register new sources on a finalized recording.',
      );
    }

    const existingRes = await this.db.query<DbSourceRow>(
      `select *
         from public.recording_sources
        where recording_id = $1
          and source_kind = $2
          and source_role = $3`,
      [recording.id, input.sourceKind, input.sourceRole],
    );
    const existing = existingRes.rows[0];
    if (existing) {
      if (
        (input.sourceId && existing.id !== input.sourceId) ||
        existing.codec !== input.codec ||
        existing.container !== input.container ||
        existing.sample_rate_hz !== input.sampleRateHz ||
        existing.channels !== input.channels ||
        existing.is_required !== input.isRequired
      ) {
        throw new Phase4ServiceError(
          409,
          'source_conflict',
          'Recording source already exists with conflicting format metadata.',
        );
      }

      const updatedRes = await this.db.query<DbSourceRow>(
        `update public.recording_sources
            set last_sample_index_exclusive = coalesce($2, last_sample_index_exclusive),
                last_sample_meeting_ms = coalesce($3, last_sample_meeting_ms),
                ended_at_ticks = coalesce($4, ended_at_ticks),
                expected_chunk_count = coalesce($5, expected_chunk_count),
                dropped_sample_count = $6
          where id = $1
          returning *`,
        [
          existing.id,
          input.lastSampleIndexExclusive ?? null,
          input.lastSampleMeetingMs ?? null,
          input.endedAtTicks ?? null,
          input.expectedChunkCount ?? null,
          input.droppedSampleCount,
        ],
      );
      return { source: mapSourceRow(updatedRes.rows[0]!), idempotentReused: true };
    }

    const sourceId = input.sourceId ?? randomUUID();
    const insertRes = await this.db.query<DbSourceRow>(
      `insert into public.recording_sources (
        id, workspace_id, meeting_id, recording_id, source_kind, source_role, is_required,
        device_uid, device_name, started_at_ticks, ended_at_ticks, first_sample_index,
        last_sample_index_exclusive, first_sample_meeting_ms, last_sample_meeting_ms,
        dropped_sample_count, expected_chunk_count, capture_metadata, codec, container,
        sample_rate_hz, channels, format_metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18::jsonb, $19, $20,
        $21, $22, $23::jsonb
      )
      returning *`,
      [
        sourceId,
        recording.workspace_id,
        recording.meeting_id,
        recording.id,
        input.sourceKind,
        input.sourceRole,
        input.isRequired,
        input.deviceUid ?? null,
        input.deviceName ?? null,
        input.startedAtTicks ?? null,
        input.endedAtTicks ?? null,
        input.firstSampleIndex,
        input.lastSampleIndexExclusive ?? null,
        input.firstSampleMeetingMs,
        input.lastSampleMeetingMs ?? null,
        input.droppedSampleCount,
        input.expectedChunkCount ?? null,
        JSON.stringify(redactObservabilityMetadata(input.captureMetadata)),
        input.codec,
        input.container,
        input.sampleRateHz,
        input.channels,
        JSON.stringify(redactObservabilityMetadata(input.formatMetadata)),
      ],
    );
    const source = insertRes.rows[0]!;

    await this.recordProcessingEvent({
      workspaceId: recording.workspace_id,
      meetingId: recording.meeting_id,
      recordingId: recording.id,
      recordingSourceId: source.id,
      eventType: 'source_registered',
      actorId: auth.userId,
      metadata: {
        source_kind: source.source_kind,
        source_role: source.source_role,
        codec: source.codec,
        container: source.container,
        sample_rate_hz: source.sample_rate_hz,
        channels: source.channels,
      },
    });

    return { source: mapSourceRow(source), idempotentReused: false };
  }

  /**
   * 5. Register a recording chunk with canonical idempotency and conflict rejection (`POST /api/v1/recordings/{recordingId}/chunks`).
   */
  async registerChunk(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    rawInput: RegisterRecordingChunkRequestInput,
  ): Promise<{ chunk: RecordingChunkDto; idempotentReused: boolean }> {
    const auth = this.requireAuth(authInput);
    const parsed = registerRecordingChunkRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid recording chunk registration request.',
      );
    }
    const input = parsed.data;
    if (input.workspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    }
    const { recording } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      input.workspaceId,
    );

    if (recording.status === 'finalized') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot register chunks on a finalized recording.',
      );
    }

    // Verify the source exists and belongs to the exact same recording and workspace.
    const sourceRes = await this.db.query<DbSourceRow>(
      `select *
         from public.recording_sources
        where id = $1`,
      [input.recordingSourceId],
    );
    const source = sourceRes.rows[0];
    if (!source) {
      throw new Phase4ServiceError(404, 'not_found', 'Recording source was not found.');
    }
    if (
      source.recording_id !== recording.id ||
      source.workspace_id !== recording.workspace_id ||
      source.meeting_id !== recording.meeting_id
    ) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Recording source does not belong to the specified recording or workspace.',
      );
    }

    if (
      source.codec !== input.codec ||
      source.container !== input.container ||
      source.sample_rate_hz !== input.sampleRateHz ||
      source.channels !== input.channels
    ) {
      throw new Phase4ServiceError(
        409,
        'chunk_conflict',
        'Chunk format metadata conflicts with the registered recording source.',
      );
    }

    const canonicalIdempotencyKey = buildCanonicalChunkIdempotencyKey(
      recording.id,
      source.id,
      input.sequenceNo,
    );
    const idempotencyKey = input.idempotencyKey ?? canonicalIdempotencyKey;
    if (idempotencyKey !== canonicalIdempotencyKey) {
      throw new Phase4ServiceError(
        409,
        'chunk_conflict',
        'Chunk idempotencyKey does not match canonical (recordingId, recordingSourceId, sequenceNo) identity.',
      );
    }

    const durationMs = input.durationMs ?? input.meetingEndMs - input.meetingStartMs;
    const storageKey = buildRecordingChunkStorageKey({
      workspaceId: recording.workspace_id,
      meetingId: recording.meeting_id,
      recordingId: recording.id,
      sourceId: source.id,
      sequenceNo: input.sequenceNo,
      container: input.container,
    });
    assertPrivateCanonicalStorageKey(storageKey, {
      workspaceId: recording.workspace_id,
      meetingId: recording.meeting_id,
      recordingId: recording.id,
      sourceId: source.id,
      sequenceNo: input.sequenceNo,
      container: input.container,
    });

    // Check existing chunk by (recording_source_id, sequence_no) or (recording_id, idempotency_key) or client_chunk_id
    const clientChunkId = input.clientChunkId ?? input.chunkId ?? randomUUID();
    const existingRes = await this.db.query<DbChunkRow>(
      `select *
         from public.recording_chunks
        where (recording_source_id = $1 and sequence_no = $2)
           or (recording_id = $3 and idempotency_key = $4)
           or (recording_id = $3 and client_chunk_id = $5)`,
      [source.id, input.sequenceNo, recording.id, idempotencyKey, clientChunkId],
    );

    if (existingRes.rows.length > 1) {
      throw new Phase4ServiceError(
        409,
        'chunk_conflict',
        'Chunk registration matches multiple distinct existing chunks.',
      );
    }

    const existing = existingRes.rows[0];
    if (existing) {
      const matchesCanonical =
        existing.recording_source_id === source.id &&
        existing.sequence_no === input.sequenceNo &&
        existing.idempotency_key === idempotencyKey &&
        existing.checksum_algorithm === input.checksum.algorithm &&
        existing.checksum_sha256 === input.checksum.value &&
        toNum(existing.byte_size) === input.byteSize &&
        existing.meeting_start_ms === input.meetingStartMs &&
        existing.meeting_end_ms === input.meetingEndMs &&
        existing.duration_ms === durationMs &&
        toNum(existing.sample_start) === input.sampleStart &&
        toNum(existing.sample_end) === input.sampleEnd &&
        existing.codec === input.codec &&
        existing.container === input.container &&
        existing.sample_rate_hz === input.sampleRateHz &&
        existing.channels === input.channels &&
        (!input.chunkId || existing.id === input.chunkId) &&
        (!input.clientChunkId || existing.client_chunk_id === input.clientChunkId);

      if (!matchesCanonical) {
        throw new Phase4ServiceError(
          409,
          'chunk_conflict',
          'Conflicting checksum, byte size, canonical timing, or sample range for existing chunk sequence.',
        );
      }
      return { chunk: mapChunkRow(existing), idempotentReused: true };
    }

    // Verify sequence ordering and non-overlapping intervals with sibling chunks of the same source
    const siblingConflictRes = await this.db.query<{ sequence_no: number }>(
      `select sequence_no
         from public.recording_chunks
        where recording_source_id = $1
          and (
            (sequence_no < $2 and (meeting_end_ms > $3 or sample_end > $5))
            or (sequence_no > $2 and (meeting_start_ms < $4 or sample_start < $6))
          )
        limit 1`,
      [
        source.id,
        input.sequenceNo,
        input.meetingStartMs,
        input.meetingEndMs,
        input.sampleStart,
        input.sampleEnd,
      ],
    );
    if (siblingConflictRes.rows.length > 0) {
      throw new Phase4ServiceError(
        409,
        'chunk_conflict',
        `Chunk sequence ${input.sequenceNo} overlaps or inverts canonical timing/sample bounds with sequence ${siblingConflictRes.rows[0]!.sequence_no}.`,
      );
    }

    const chunkId = input.chunkId ?? clientChunkId;
    const insertRes = await this.db.query<DbChunkRow>(
      `insert into public.recording_chunks (
        id, workspace_id, meeting_id, recording_id, recording_source_id,
        client_chunk_id, idempotency_key, sequence_no, meeting_start_ms, meeting_end_ms,
        duration_ms, sample_start, sample_end, first_sample_monotonic_ticks, byte_size,
        checksum_algorithm, checksum_sha256, storage_backend, storage_key,
        upload_state, verification_state, codec, container, sample_rate_hz,
        channels, encoder_delay_samples, encoder_padding_samples
      )
      values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19,
        'pending', 'pending', $20, $21, $22,
        $23, $24, $25
      )
      returning *`,
      [
        chunkId,
        recording.workspace_id,
        recording.meeting_id,
        recording.id,
        source.id,
        clientChunkId,
        idempotencyKey,
        input.sequenceNo,
        input.meetingStartMs,
        input.meetingEndMs,
        durationMs,
        input.sampleStart,
        input.sampleEnd,
        input.firstSampleMonotonicTicks,
        input.byteSize,
        input.checksum.algorithm,
        input.checksum.value,
        this.storage.backend,
        storageKey,
        input.codec,
        input.container,
        input.sampleRateHz,
        input.channels,
        input.encoderDelaySamples,
        input.encoderPaddingSamples,
      ],
    );
    const chunk = insertRes.rows[0]!;

    await this.db.query(
      `update public.recordings
          set status = case when status in ('registered', 'recording', 'paused') then 'uploading'::public.recording_status else status end
        where id = $1`,
      [recording.id],
    );

    await this.db.query(
      `update public.meetings
          set status = case when status in ('draft', 'recording') then 'uploading'::public.meeting_status else status end,
              processing_status = case when processing_status in ('idle', 'recording') then 'uploading'::public.meeting_processing_status else processing_status end
        where id = $1
          and workspace_id = $2`,
      [recording.meeting_id, recording.workspace_id],
    );

    await this.recordProcessingEvent({
      workspaceId: recording.workspace_id,
      meetingId: recording.meeting_id,
      recordingId: recording.id,
      recordingSourceId: source.id,
      recordingChunkId: chunk.id,
      sequenceNo: chunk.sequence_no,
      eventType: 'chunk_registered',
      actorId: auth.userId,
      metadata: {
        byte_size: toNum(chunk.byte_size),
        checksum_algorithm: chunk.checksum_algorithm,
        checksum_sha256: chunk.checksum_sha256,
        meeting_start_ms: chunk.meeting_start_ms,
        meeting_end_ms: chunk.meeting_end_ms,
        storage_backend: chunk.storage_backend,
      },
    });

    return { chunk: mapChunkRow(chunk), idempotentReused: false };
  }

  /**
   * 6. Issue short-lived upload authorization (`POST /api/v1/recordings/{recordingId}/chunks/{chunkId}/upload`).
   */
  async authorizeChunkUpload(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    chunkId: string,
    rawInput: AuthorizeChunkUploadRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<ChunkUploadAuthorizationDto> {
    const auth = this.requireAuth(authInput);
    const parsed = authorizeChunkUploadRequestSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid upload authorization request.',
      );
    }
    const input = parsed.data;
    if (input.workspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    }
    const { recording } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      input.workspaceId,
    );

    if (recording.status === 'finalized') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot issue upload authorization for a finalized recording.',
      );
    }

    const chunkRes = await this.db.query<DbChunkRow>(
      `select *
         from public.recording_chunks
        where id = $1`,
      [chunkId],
    );
    const chunk = chunkRes.rows[0];
    if (!chunk) {
      throw new Phase4ServiceError(404, 'not_found', 'Recording chunk was not found.');
    }
    if (chunk.recording_id !== recording.id || chunk.workspace_id !== recording.workspace_id) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Recording chunk does not belong to the specified recording or workspace.',
      );
    }
    if (chunk.upload_state === 'failed_terminal') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Chunk is in failed_terminal state and cannot be re-authorized.',
      );
    }

    const capability = await this.storage.createUploadAuthorization({
      storageKey: chunk.storage_key,
      expectedByteSize: toNum(chunk.byte_size),
      expectedSha256: chunk.checksum_sha256,
      contentType: input.contentType ?? `audio/${chunk.container}`,
      expiresInSeconds: input.expiresInSeconds,
      now: options.now,
    });

    if (chunk.verification_state === 'verified') {
      return {
        chunkId: chunk.id,
        recordingId: recording.id,
        recordingSourceId: chunk.recording_source_id,
        sequenceNo: chunk.sequence_no,
        storageBackend: capability.storageBackend,
        storageKey: chunk.storage_key,
        method: 'PUT',
        uploadUrl: capability.uploadUrl,
        headers: capability.headers,
        expiresAt: capability.expiresAt,
        alreadyVerified: true,
      };
    }

    await this.db.query(
      `update public.recording_chunks
          set upload_state = 'uploading',
              verification_state = case when verification_state = 'rejected' then 'pending'::public.chunk_verification_state else verification_state end,
              verification_error_code = null
        where id = $1`,
      [chunk.id],
    );

    await this.recordProcessingEvent({
      workspaceId: recording.workspace_id,
      meetingId: recording.meeting_id,
      recordingId: recording.id,
      recordingSourceId: chunk.recording_source_id,
      recordingChunkId: chunk.id,
      sequenceNo: chunk.sequence_no,
      eventType: 'upload_authorized',
      actorId: auth.userId,
      metadata: {
        authorization_id: capability.authorizationId,
        expires_at: capability.expiresAt,
        storage_backend: capability.storageBackend,
      },
    });

    return {
      chunkId: chunk.id,
      recordingId: recording.id,
      recordingSourceId: chunk.recording_source_id,
      sequenceNo: chunk.sequence_no,
      storageBackend: capability.storageBackend,
      storageKey: chunk.storage_key,
      method: 'PUT',
      uploadUrl: capability.uploadUrl,
      headers: capability.headers,
      expiresAt: capability.expiresAt,
      alreadyVerified: false,
    };
  }

  /**
   * 8 & 9. Independently verify uploaded chunk in private object storage (`POST /api/v1/recordings/{recordingId}/chunks/{chunkId}/verify`).
   */
  async verifyChunkUpload(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    chunkId: string,
    rawInput: VerifyChunkUploadRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<VerifyChunkUploadResponse> {
    const auth = this.requireAuth(authInput);
    const parsed = verifyChunkUploadRequestSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid chunk verification request.',
      );
    }
    const input = parsed.data;
    if (input.workspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    }
    const { recording } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      input.workspaceId,
    );

    const chunkRes = await this.db.query<DbChunkRow>(
      `select *
         from public.recording_chunks
        where id = $1`,
      [chunkId],
    );
    const chunk = chunkRes.rows[0];
    if (!chunk) {
      throw new Phase4ServiceError(404, 'not_found', 'Recording chunk was not found.');
    }
    if (chunk.recording_id !== recording.id || chunk.workspace_id !== recording.workspace_id) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Recording chunk does not belong to the specified recording or workspace.',
      );
    }

    const nowIso = (options.now ?? new Date()).toISOString();

    if (chunk.verification_state !== 'verified') {
      await this.db.query(
        `update public.recording_chunks
            set upload_state = 'verifying',
                verification_state = 'verifying',
                uploaded_at = coalesce(uploaded_at, $2)
          where id = $1`,
        [chunk.id, nowIso],
      );

      await this.recordProcessingEvent({
        workspaceId: recording.workspace_id,
        meetingId: recording.meeting_id,
        recordingId: recording.id,
        recordingSourceId: chunk.recording_source_id,
        recordingChunkId: chunk.id,
        sequenceNo: chunk.sequence_no,
        eventType: 'chunk_uploaded',
        actorId: auth.userId,
        metadata: {
          provisional: true,
        },
      });
    }

    const verificationResult = await this.storage.verifyObject({
      storageKey: chunk.storage_key,
      expectedByteSize: toNum(chunk.byte_size),
      expectedSha256: chunk.checksum_sha256,
    });

    if (!verificationResult.ok) {
      const nextVerificationState: ChunkVerificationState =
        verificationResult.reason === 'size_mismatch' ||
        verificationResult.reason === 'checksum_mismatch'
          ? 'rejected'
          : 'pending';
      const failedRes = await this.db.query<DbChunkRow>(
        `update public.recording_chunks
            set upload_state = 'failed_retryable',
                verification_state = $2,
                verified_at = null,
                verified_byte_size = null,
                verified_sha256 = null,
                verification_method = null,
                verification_error_code = $3
          where id = $1
          returning *`,
        [chunk.id, nextVerificationState, verificationResult.reason],
      );

      await this.recordProcessingEvent({
        workspaceId: recording.workspace_id,
        meetingId: recording.meeting_id,
        recordingId: recording.id,
        recordingSourceId: chunk.recording_source_id,
        recordingChunkId: chunk.id,
        sequenceNo: chunk.sequence_no,
        eventType: 'chunk_verification_failed',
        actorId: auth.userId,
        metadata: {
          reason: verificationResult.reason,
          expected_byte_size: toNum(chunk.byte_size),
          actual_byte_size: verificationResult.actualByteSize,
        },
      });

      return {
        verified: false,
        chunk: mapChunkRow(failedRes.rows[0]!),
        verification: {
          method: null,
          verifiedByteSize: verificationResult.actualByteSize,
          verifiedSha256: verificationResult.actualSha256,
          failureReason: verificationResult.reason,
          failureDetail: verificationResult.detail,
        },
      };
    }

    const verifiedRes = await this.db.query<DbChunkRow>(
      `update public.recording_chunks
          set upload_state = 'verified',
              verification_state = 'verified',
              verified_at = coalesce(verified_at, $2),
              uploaded_at = coalesce(uploaded_at, $2),
              verified_byte_size = $3,
              verified_sha256 = $4,
              verification_method = $5,
              verification_error_code = null
        where id = $1
        returning *`,
      [
        chunk.id,
        nowIso,
        verificationResult.metadata.byteSize,
        verificationResult.metadata.sha256,
        verificationResult.verificationMethod,
      ],
    );
    const updatedChunk = verifiedRes.rows[0]!;

    await this.recordProcessingEvent({
      workspaceId: recording.workspace_id,
      meetingId: recording.meeting_id,
      recordingId: recording.id,
      recordingSourceId: chunk.recording_source_id,
      recordingChunkId: chunk.id,
      sequenceNo: chunk.sequence_no,
      eventType: 'chunk_verified',
      actorId: auth.userId,
      metadata: {
        verified_byte_size: verificationResult.metadata.byteSize,
        verification_method: verificationResult.verificationMethod,
      },
    });

    return {
      verified: true,
      chunk: mapChunkRow(updatedChunk),
      verification: {
        method: verificationResult.verificationMethod,
        verifiedByteSize: verificationResult.metadata.byteSize,
        verifiedSha256: verificationResult.metadata.sha256,
        failureReason: null,
        failureDetail: null,
      },
    };
  }

  /**
   * 10, 11, 12. Finalize recording session after confirming all required chunks are present & verified,
   * and create exactly one canonical `prepare_recording` processing job (`POST /api/v1/recordings/{recordingId}/finalize`).
   */
  async finalizeRecording(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    rawInput: FinalizeRecordingRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<FinalizeRecordingResponse> {
    const auth = this.requireAuth(authInput);
    const parsed = finalizeRecordingRequestSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid recording finalize request.',
      );
    }
    const input = parsed.data;
    if (input.workspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    }
    const { recording, meeting } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      input.workspaceId,
    );

    const jobIdempotencyKey = buildCanonicalPrepareJobIdempotencyKey(recording.id, 1);

    // Repeated finalize is idempotent
    if (recording.status === 'finalized') {
      const existingJobRes = await this.db.query<DbJobRow>(
        `select *
           from public.processing_jobs
          where idempotency_key = $1`,
        [jobIdempotencyKey],
      );
      if (existingJobRes.rows[0]) {
        return {
          status: 'finalized',
          recording: mapRecordingRow(recording),
          job: mapJobRow(existingJobRes.rows[0]),
          idempotentReused: true,
        };
      }
    }

    const sourcesRes = await this.db.query<DbSourceRow>(
      `select *
         from public.recording_sources
        where recording_id = $1
        order by created_at asc`,
      [recording.id],
    );
    const sources = sourcesRes.rows;

    const chunksRes = await this.db.query<DbChunkRow>(
      `select *
         from public.recording_chunks
        where recording_id = $1
        order by recording_source_id asc, sequence_no asc`,
      [recording.id],
    );
    const chunks = chunksRes.rows;

    const missingSources: string[] = [];
    const missingChunks: Array<{ recordingSourceId: string; sequenceNo: number }> = [];
    const unverifiedChunks: Array<{
      chunkId: string;
      recordingSourceId: string;
      sequenceNo: number;
      uploadState: ChunkUploadState;
      verificationState: ChunkVerificationState;
    }> = [];

    const sourceMap = new Map(sources.map((s) => [s.id, s]));
    const expectedCountBySource = new Map<string, number>();

    if (input.expectedSources) {
      for (const expected of input.expectedSources) {
        if (!sourceMap.has(expected.recordingSourceId)) {
          missingSources.push(expected.recordingSourceId);
        } else {
          expectedCountBySource.set(expected.recordingSourceId, expected.expectedChunkCount);
        }
      }
    }

    const requiredSources = sources.filter((s) => s.is_required);
    if (requiredSources.length === 0 && missingSources.length === 0) {
      missingSources.push(recording.id);
    }

    for (const source of sources) {
      const sourceChunks = chunks.filter((c) => c.recording_source_id === source.id);
      const maxSeq = sourceChunks.reduce((max, c) => Math.max(max, c.sequence_no), -1);
      const declaredCount =
        expectedCountBySource.get(source.id) ??
        source.expected_chunk_count ??
        (maxSeq >= 0 ? maxSeq + 1 : 0);

      if (source.is_required && declaredCount <= 0) {
        missingChunks.push({ recordingSourceId: source.id, sequenceNo: 0 });
        continue;
      }

      const bySeq = new Map(sourceChunks.map((c) => [c.sequence_no, c]));
      const totalRequired = Math.max(declaredCount, maxSeq + 1);
      for (let seq = 0; seq < totalRequired; seq += 1) {
        if (!bySeq.has(seq)) {
          missingChunks.push({ recordingSourceId: source.id, sequenceNo: seq });
        }
      }

      for (const chunk of sourceChunks) {
        if (chunk.verification_state !== 'verified' || !chunk.verified_at) {
          unverifiedChunks.push({
            chunkId: chunk.id,
            recordingSourceId: chunk.recording_source_id,
            sequenceNo: chunk.sequence_no,
            uploadState: chunk.upload_state,
            verificationState: chunk.verification_state,
          });
        }
      }
    }

    if (missingSources.length > 0 || missingChunks.length > 0 || unverifiedChunks.length > 0) {
      await this.recordProcessingEvent({
        workspaceId: recording.workspace_id,
        meetingId: recording.meeting_id,
        recordingId: recording.id,
        eventType: 'recording_finalize_incomplete',
        actorId: auth.userId,
        metadata: {
          missing_source_count: missingSources.length,
          missing_chunk_count: missingChunks.length,
          unverified_chunk_count: unverifiedChunks.length,
        },
      });

      return {
        status: 'incomplete',
        recordingId: recording.id,
        code: 'recording_incomplete',
        message:
          'Recording cannot be finalized until all required sources and chunks are registered and verified.',
        missingSources,
        missingChunks,
        unverifiedChunks,
      };
    }

    const nowIso = (options.now ?? new Date()).toISOString();
    const maxChunkEndMs = chunks.reduce((max, c) => Math.max(max, c.meeting_end_ms), 0);
    const totalPlayableDurationMs = Math.max(
      ...sources.map((s) =>
        chunks
          .filter((c) => c.recording_source_id === s.id)
          .reduce((sum, c) => sum + c.duration_ms, 0),
      ),
      0,
    );
    const canonicalDurationMs =
      input.canonicalDurationMs ?? recording.canonical_duration_ms ?? maxChunkEndMs;
    const activeCaptureMs =
      input.activeCaptureMs ?? recording.active_capture_ms ?? totalPlayableDurationMs;
    const stoppedAt = input.stoppedAt ?? recording.stopped_at ?? nowIso;

    const finalizedRecordingRes = await this.db.query<DbRecordingRow>(
      `update public.recordings
          set status = 'finalized',
              finalized_at = coalesce(finalized_at, $2),
              stopped_at = $3,
              canonical_duration_ms = $4,
              active_capture_ms = $5,
              manifest_revision = greatest(manifest_revision, coalesce($6, manifest_revision))
        where id = $1
        returning *`,
      [
        recording.id,
        nowIso,
        stoppedAt,
        canonicalDurationMs,
        activeCaptureMs,
        input.manifestRevision ?? null,
      ],
    );
    const finalizedRecording = finalizedRecordingRes.rows[0]!;

    // Create exactly one canonical `prepare_recording` processing job idempotently
    const insertJobRes = await this.db.query<DbJobRow>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'prepare_recording', 1, $4, 'queued', $5, $6::jsonb)
      on conflict (idempotency_key) do nothing
      returning *`,
      [
        recording.workspace_id,
        recording.meeting_id,
        recording.id,
        jobIdempotencyKey,
        nowIso,
        JSON.stringify({
          recording_id: recording.id,
          source_count: sources.length,
          chunk_count: chunks.length,
        }),
      ],
    );

    let jobRow = insertJobRes.rows[0];
    let idempotentReused = false;
    if (!jobRow) {
      const existingJobRes = await this.db.query<DbJobRow>(
        `select *
           from public.processing_jobs
          where idempotency_key = $1`,
        [jobIdempotencyKey],
      );
      jobRow = existingJobRes.rows[0]!;
      idempotentReused = true;
    }

    await this.db.query(
      `update public.meetings
          set status = case
                when status in ('ready_for_transcription', 'failed') then status
                else 'processing'::public.meeting_status
              end,
              processing_status = case
                when processing_status in ('ready_for_transcription', 'failed') then processing_status
                else 'preparing'::public.meeting_processing_status
              end,
              ended_at = coalesce(ended_at, $3),
              timeline_duration_ms = coalesce($4, timeline_duration_ms),
              active_capture_duration_ms = coalesce($5, active_capture_duration_ms)
        where id = $1
          and workspace_id = $2`,
      [meeting.id, meeting.workspace_id, stoppedAt, canonicalDurationMs, activeCaptureMs],
    );

    if (!idempotentReused) {
      await this.recordProcessingEvent({
        workspaceId: recording.workspace_id,
        meetingId: recording.meeting_id,
        recordingId: recording.id,
        eventType: 'recording_finalized',
        actorId: auth.userId,
        metadata: {
          canonical_duration_ms: canonicalDurationMs,
          active_capture_ms: activeCaptureMs,
          verified_chunk_count: chunks.length,
        },
      });

      await this.recordProcessingEvent({
        workspaceId: recording.workspace_id,
        meetingId: recording.meeting_id,
        recordingId: recording.id,
        processingJobId: jobRow.id,
        eventType: 'job_created',
        actorId: auth.userId,
        metadata: {
          job_type: jobRow.job_type,
          idempotency_key: jobRow.idempotency_key,
          generation: jobRow.generation,
        },
      });
    }

    return {
      status: 'finalized',
      recording: mapRecordingRow(finalizedRecording),
      job: mapJobRow(jobRow),
      idempotentReused,
    };
  }

  /**
   * `GET /api/v1/recordings/{recordingId}`
   */
  async getRecording(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    clientWorkspaceId?: string,
  ): Promise<RecordingDetailResponse> {
    const auth = this.requireAuth(authInput);
    if (clientWorkspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, clientWorkspaceId);
    }
    const { recording } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      clientWorkspaceId,
    );

    const [sourcesRes, chunksRes, jobsRes] = await Promise.all([
      this.db.query<DbSourceRow>(
        `select * from public.recording_sources where recording_id = $1 order by created_at asc`,
        [recording.id],
      ),
      this.db.query<DbChunkRow>(
        `select * from public.recording_chunks where recording_id = $1 order by recording_source_id asc, sequence_no asc`,
        [recording.id],
      ),
      this.db.query<DbJobRow>(
        `select * from public.processing_jobs where recording_id = $1 order by created_at asc`,
        [recording.id],
      ),
    ]);

    return {
      recording: mapRecordingRow(recording),
      sources: sourcesRes.rows.map(mapSourceRow),
      chunks: chunksRes.rows.map(mapChunkRow),
      jobs: jobsRes.rows.map(mapJobRow),
    };
  }

  /**
   * `GET /api/v1/meetings/{meetingId}/processing`
   */
  async getMeetingProcessing(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<MeetingProcessingResponse> {
    const auth = this.requireAuth(authInput);
    if (clientWorkspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, clientWorkspaceId);
    }
    const meeting = await this.loadAuthorizedMeeting(auth.userId, meetingId, clientWorkspaceId);

    const recordingsRes = await this.db.query<DbRecordingRow>(
      `select *
         from public.recordings
        where meeting_id = $1
          and workspace_id = $2
          and deleted_at is null
          and status <> 'deleted'
        order by created_at desc`,
      [meeting.id, meeting.workspace_id],
    );
    const activeRecording = recordingsRes.rows[0] ?? null;

    const [sourcesRes, chunksRes, jobsRes] = activeRecording
      ? await Promise.all([
          this.db.query<DbSourceRow>(
            `select * from public.recording_sources where recording_id = $1 order by created_at asc`,
            [activeRecording.id],
          ),
          this.db.query<DbChunkRow>(
            `select * from public.recording_chunks where recording_id = $1 order by recording_source_id asc, sequence_no asc`,
            [activeRecording.id],
          ),
          this.db.query<DbJobRow>(
            `select * from public.processing_jobs where meeting_id = $1 order by created_at desc`,
            [meeting.id],
          ),
        ])
      : [
          { rows: [] as DbSourceRow[] },
          { rows: [] as DbChunkRow[] },
          await this.db.query<DbJobRow>(
            `select * from public.processing_jobs where meeting_id = $1 order by created_at desc`,
            [meeting.id],
          ),
        ];

    const verifiedChunkCount = chunksRes.rows.filter(
      (c) => c.verification_state === 'verified',
    ).length;
    const totalChunkCount = chunksRes.rows.length;

    const { productState, timeline } = buildProductProcessingTimeline({
      meeting,
      recording: activeRecording,
      sources: sourcesRes.rows,
      chunks: chunksRes.rows,
      jobs: jobsRes.rows,
    });

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      meetingStatus: meeting.status,
      pipelineStatus: meeting.processing_status,
      productState,
      recordingAvailable: Boolean(
        activeRecording && activeRecording.status === 'finalized' && verifiedChunkCount > 0,
      ),
      activeRecordingId: activeRecording?.id ?? null,
      verifiedChunkCount,
      totalChunkCount,
      canonicalDurationMs: activeRecording?.canonical_duration_ms ?? null,
      detectedLanguages: meeting.detected_languages ?? [],
      jobs: jobsRes.rows.map(mapJobRow),
      timeline,
    };
  }

  /**
   * Safe cleanup and object-storage deletion reconciliation (`DELETE /api/v1/recordings/{recordingId}`).
   *
   * Never leaves verified objects orphaned silently; if object-store deletion fails, records
   * `reconciliation_required` in `object_deletion_ledger` and refuses to claim deletion is complete.
   */
  async deleteRecording(
    authInput: AuthenticatedPrincipal | null | undefined,
    recordingId: string,
    clientWorkspaceId?: string,
    options: { now?: Date } = {},
  ): Promise<DeleteRecordingResponse> {
    const auth = this.requireAuth(authInput);
    if (clientWorkspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, clientWorkspaceId);
    }
    const { recording, meeting } = await this.loadAuthorizedRecording(
      auth.userId,
      recordingId,
      clientWorkspaceId,
    );

    const nowIso = (options.now ?? new Date()).toISOString();

    await this.recordProcessingEvent({
      workspaceId: recording.workspace_id,
      meetingId: meeting.id,
      recordingId: recording.id,
      eventType: 'recording_deletion_requested',
      actorId: auth.userId,
    });

    // Cancel any active queued/retryable/running jobs for this recording
    const activeJobsRes = await this.db.query<DbJobRow>(
      `update public.processing_jobs
          set status = 'cancelled',
              lease_owner = null,
              lease_expires_at = null,
              completed_at = $2
        where recording_id = $1
          and status in ('queued', 'running', 'retryable_failed')
        returning *`,
      [recording.id, nowIso],
    );
    for (const cancelledJob of activeJobsRes.rows) {
      await this.recordProcessingEvent({
        workspaceId: recording.workspace_id,
        meetingId: meeting.id,
        recordingId: recording.id,
        processingJobId: cancelledJob.id,
        eventType: 'job_cancelled',
        actorId: auth.userId,
        fencingToken: toNum(cancelledJob.fencing_token),
      });
    }

    // Load all chunks for this recording that may have objects in storage
    const chunksRes = await this.db.query<DbChunkRow>(
      `select *
         from public.recording_chunks
        where recording_id = $1
        order by sequence_no asc`,
      [recording.id],
    );

    for (const chunk of chunksRes.rows) {
      if (chunk.upload_state !== 'pending') {
        await this.db.query(
          `insert into public.object_deletion_ledger (
            workspace_id, meeting_id, recording_id, recording_chunk_id,
            storage_backend, storage_key, expected_byte_size, expected_sha256, status
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
          on conflict (storage_backend, storage_key) do nothing`,
          [
            recording.workspace_id,
            meeting.id,
            recording.id,
            chunk.id,
            chunk.storage_backend,
            chunk.storage_key,
            toNum(chunk.byte_size),
            chunk.checksum_sha256,
          ],
        );
      }
    }

    const ledgerRes = await this.db.query<DbLedgerRow>(
      `select *
         from public.object_deletion_ledger
        where recording_id = $1
        order by created_at asc`,
      [recording.id],
    );

    let deletedObjectCount = 0;
    let reconciliationPendingCount = 0;

    for (const entry of ledgerRes.rows) {
      if (entry.status === 'deleted') {
        deletedObjectCount += 1;
        continue;
      }
      try {
        await this.storage.deleteObject(entry.storage_key);
        await this.db.query(
          `update public.object_deletion_ledger
              set status = 'deleted',
                  attempt_count = attempt_count + 1,
                  last_error_code = null,
                  last_error_message = null,
                  completed_at = $2
            where id = $1`,
          [entry.id, nowIso],
        );
        deletedObjectCount += 1;
        await this.recordProcessingEvent({
          workspaceId: recording.workspace_id,
          meetingId: meeting.id,
          recordingId: recording.id,
          recordingChunkId: entry.recording_chunk_id,
          eventType: 'object_deleted',
          actorId: auth.userId,
          metadata: {
            storage_backend: entry.storage_backend,
            ledger_id: entry.id,
          },
        });
      } catch (cause) {
        reconciliationPendingCount += 1;
        const errCode =
          cause && typeof cause === 'object' && 'code' in cause
            ? String((cause as { code: unknown }).code)
            : 'storage_delete_failed';
        const errMsg = cause instanceof Error ? cause.message : String(cause);
        await this.db.query(
          `update public.object_deletion_ledger
              set status = 'reconciliation_required',
                  attempt_count = attempt_count + 1,
                  last_error_code = $2,
                  last_error_message = $3
            where id = $1`,
          [entry.id, errCode.slice(0, 80), errMsg.slice(0, 500)],
        );
        await this.recordProcessingEvent({
          workspaceId: recording.workspace_id,
          meetingId: meeting.id,
          recordingId: recording.id,
          recordingChunkId: entry.recording_chunk_id,
          eventType: 'object_delete_reconciliation_required',
          actorId: auth.userId,
          metadata: {
            storage_backend: entry.storage_backend,
            ledger_id: entry.id,
            error_code: errCode,
          },
        });
      }
    }

    const updatedLedgerRes = await this.db.query<DbLedgerRow>(
      `select *
         from public.object_deletion_ledger
        where recording_id = $1
        order by created_at asc`,
      [recording.id],
    );

    if (reconciliationPendingCount > 0) {
      // Do NOT claim deletion complete while durable objects remain unintentionally in object storage.
      await this.db.query(
        `update public.meetings
            set purge_status = 'purge_pending'
          where id = $1
            and workspace_id = $2`,
        [meeting.id, meeting.workspace_id],
      );

      return {
        recordingId: recording.id,
        meetingId: meeting.id,
        workspaceId: recording.workspace_id,
        status: 'reconciliation_required',
        deletedObjectCount,
        reconciliationPendingCount,
        ledger: updatedLedgerRes.rows.map(mapLedgerRow),
      };
    }

    // All storage objects are confirmed deleted: remove chunk/source rows, purge knowledge chunks, and mark recording deleted.
    const kcReg = await this.db.query<{ reg: string | null }>(
      `select to_regclass('public.knowledge_chunks')::text as reg`,
    );
    if (kcReg.rows[0]?.reg) {
      await this.db.query(`delete from public.knowledge_chunks where meeting_id = $1`, [
        meeting.id,
      ]);
      await this.db.query(
        `update public.meetings
            set current_embedding_run_id = null,
                current_analysis_run_id = null,
                current_transcription_run_id = null
          where id = $1
            and workspace_id = $2`,
        [meeting.id, meeting.workspace_id],
      );
    }

    await this.db.query(`delete from public.recording_chunks where recording_id = $1`, [
      recording.id,
    ]);
    await this.db.query(`delete from public.recording_sources where recording_id = $1`, [
      recording.id,
    ]);
    await this.db.query(
      `update public.recordings
          set status = 'deleted',
              deleted_at = $2
        where id = $1`,
      [recording.id, nowIso],
    );
    await this.db.query(
      `update public.meetings
          set status = 'draft',
              processing_status = 'idle',
              purge_status = 'active'
        where id = $1
          and workspace_id = $2`,
      [meeting.id, meeting.workspace_id],
    );

    await this.recordProcessingEvent({
      workspaceId: recording.workspace_id,
      meetingId: meeting.id,
      recordingId: recording.id,
      eventType: 'recording_deletion_completed',
      actorId: auth.userId,
      metadata: {
        deleted_object_count: deletedObjectCount,
      },
    });

    return {
      recordingId: recording.id,
      meetingId: meeting.id,
      workspaceId: recording.workspace_id,
      status: 'deleted',
      deletedObjectCount,
      reconciliationPendingCount: 0,
      ledger: updatedLedgerRes.rows.map(mapLedgerRow),
    };
  }

  async listProcessingEvents(meetingId: string): Promise<ProcessingEventDto[]> {
    const res = await this.db.query<DbEventRow>(
      `select *
         from public.processing_events
        where meeting_id = $1
        order by created_at asc`,
      [meetingId],
    );
    return res.rows.map(mapEventRow);
  }
}

export type ClaimJobOptions = {
  leaseSeconds?: number;
  now?: Date;
};

export type FailJobOptions = {
  code: string;
  message: string;
  retryable: boolean;
  backoffSeconds?: number;
  metadata?: Record<string, unknown>;
  now?: Date;
};

/**
 * Durable Phase 4 worker for `prepare_recording`.
 *
 * Uses PostgreSQL `claim_next_processing_job` (`FOR UPDATE SKIP LOCKED`), lease expiration,
 * and monotonically increasing fencing tokens so stale workers can never overwrite a newer claim.
 */
export class Phase4RecordingWorker {
  readonly service: Phase4BackboneService;

  constructor(service: Phase4BackboneService) {
    this.service = service;
  }

  private get db(): SqlExecutor {
    return this.service.db;
  }

  private get storage(): StorageProvider {
    return this.service.storage;
  }

  /**
   * Atomically claims the next eligible queued, retryable, or lease-expired job.
   */
  async claimNextJob(
    workerId: string,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const leaseSeconds = options.leaseSeconds ?? 300;
    const res = await this.db.query<DbJobRow>(
      `select * from public.claim_next_processing_job($1, $2, $3::timestamptz)`,
      [workerId, leaseSeconds, nowIso],
    );
    const row = res.rows[0];
    return row ? mapJobRow(row) : null;
  }

  /**
   * Extends the lease for a running job only if `(jobId, workerId, fencingToken)` still owns an unexpired lease.
   */
  async heartbeatJob(
    workerId: string,
    jobId: string,
    fencingToken: number,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseSeconds = Math.max(options.leaseSeconds ?? 300, 5);
    const expiresAtIso = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

    const res = await this.db.query<DbJobRow>(
      `update public.processing_jobs
          set lease_expires_at = $5,
              heartbeat_at = $4
        where id = $1
          and status = 'running'
          and lease_owner = $2
          and fencing_token = $3
          and lease_expires_at > $4
        returning *`,
      [jobId, workerId, fencingToken, nowIso, expiresAtIso],
    );

    const row = res.rows[0];
    if (!row) {
      throw new Phase4ServiceError(
        409,
        'stale_fencing_token',
        'Cannot heartbeat job: worker lease expired or fencing token was superseded.',
      );
    }

    await this.service.recordProcessingEvent({
      workspaceId: row.workspace_id,
      meetingId: row.meeting_id,
      recordingId: row.recording_id,
      processingJobId: row.id,
      eventType: 'job_heartbeat',
      fencingToken: toNum(row.fencing_token),
      metadata: {
        lease_owner: workerId,
        lease_expires_at: expiresAtIso,
      },
    });

    return mapJobRow(row);
  }

  /**
   * Commits job completion only if `(jobId, workerId, fencingToken)` still holds an active lease.
   */
  async completeJob(
    workerId: string,
    jobId: string,
    fencingToken: number,
    resultMetadata: Record<string, unknown>,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const safeMetadata = redactObservabilityMetadata(resultMetadata);

    const res = await this.db.query<DbJobRow>(
      `update public.processing_jobs
          set status = 'succeeded',
              completed_at = $4,
              lease_owner = null,
              lease_expires_at = null,
              result_metadata = $5::jsonb,
              error_code = null,
              error_message = null
        where id = $1
          and status = 'running'
          and lease_owner = $2
          and fencing_token = $3
          and lease_expires_at > $4
        returning *`,
      [jobId, workerId, fencingToken, nowIso, JSON.stringify(safeMetadata)],
    );

    const row = res.rows[0];
    if (!row) {
      throw new Phase4ServiceError(
        409,
        'stale_fencing_token',
        'Stale worker fencing token or expired lease cannot commit job completion.',
      );
    }

    const nextMeetingStatus =
      row.job_type === 'finalize_analysis' ||
      row.job_type === 'generate_embeddings' ||
      row.job_type === 'index_knowledge' ||
      row.job_type === 'send_telegram_notifications' ||
      row.job_type === 'execute_automation_action'
        ? 'ready'
        : row.job_type === 'normalize_intelligence'
          ? 'analysis_ready'
          : row.job_type === 'analyze_meeting'
            ? 'normalizing_analysis'
            : row.job_type === 'finalize_transcript'
              ? 'transcript_ready'
              : row.job_type === 'transcribe_meeting' || row.job_type === 'normalize_transcript'
                ? 'normalizing_transcript'
                : 'ready_for_transcription';

    // Advance meeting status honestly (only `finalize_analysis` transitions a meeting to `ready`).
    await this.db.query(
      `update public.meetings
          set status = $3::text::public.meeting_status,
              processing_status = $3::text::public.meeting_processing_status
        where id = $1
          and workspace_id = $2`,
      [row.meeting_id, row.workspace_id, nextMeetingStatus],
    );

    await this.service.recordProcessingEvent({
      workspaceId: row.workspace_id,
      meetingId: row.meeting_id,
      recordingId: row.recording_id,
      processingJobId: row.id,
      eventType: 'job_succeeded',
      fencingToken: toNum(row.fencing_token),
      metadata: {
        lease_owner: workerId,
        attempt: row.attempt,
      },
    });

    return mapJobRow(row);
  }

  /**
   * Records a job failure (retryable or terminal/dead-lettered) only if `(jobId, workerId, fencingToken)` is valid.
   */
  async failJob(
    workerId: string,
    jobId: string,
    fencingToken: number,
    failure: FailJobOptions,
  ): Promise<ProcessingJobDto> {
    const now = failure.now ?? new Date();
    const nowIso = now.toISOString();

    const currentRes = await this.db.query<DbJobRow>(
      `select *
         from public.processing_jobs
        where id = $1
          and status = 'running'
          and lease_owner = $2
          and fencing_token = $3
          and lease_expires_at > $4`,
      [jobId, workerId, fencingToken, nowIso],
    );
    const current = currentRes.rows[0];
    if (!current) {
      throw new Phase4ServiceError(
        409,
        'stale_fencing_token',
        'Stale worker fencing token or expired lease cannot record job failure.',
      );
    }

    const canRetry = failure.retryable && current.attempt < current.max_attempts;
    const nextStatus: ProcessingJobStatus = canRetry ? 'retryable_failed' : 'dead_lettered';
    const backoffSeconds =
      failure.backoffSeconds ?? Math.min(30 * Math.pow(2, Math.max(0, current.attempt - 1)), 600);
    const scheduledAtIso = canRetry
      ? new Date(now.getTime() + backoffSeconds * 1000).toISOString()
      : current.scheduled_at;
    const completedAtIso = canRetry ? null : nowIso;
    const safeErrorMetadata = redactObservabilityMetadata(failure.metadata ?? {});

    const updatedRes = await this.db.query<DbJobRow>(
      `update public.processing_jobs
          set status = $2,
              lease_owner = null,
              lease_expires_at = null,
              scheduled_at = $3,
              completed_at = $4,
              error_code = $5,
              error_message = $6,
              error_metadata = $7::jsonb
        where id = $1
          and fencing_token = $8
        returning *`,
      [
        jobId,
        nextStatus,
        scheduledAtIso,
        completedAtIso,
        failure.code.slice(0, 80),
        failure.message.slice(0, 500),
        JSON.stringify(safeErrorMetadata),
        fencingToken,
      ],
    );
    const updated = updatedRes.rows[0];
    if (!updated) {
      throw new Phase4ServiceError(
        409,
        'stale_fencing_token',
        'Stale worker fencing token cannot commit failure state.',
      );
    }

    await this.service.recordProcessingEvent({
      workspaceId: updated.workspace_id,
      meetingId: updated.meeting_id,
      recordingId: updated.recording_id,
      processingJobId: updated.id,
      eventType: 'job_failed',
      fencingToken: toNum(updated.fencing_token),
      metadata: {
        error_code: failure.code,
        retryable: canRetry,
        attempt: updated.attempt,
        max_attempts: updated.max_attempts,
      },
    });

    if (canRetry) {
      await this.service.recordProcessingEvent({
        workspaceId: updated.workspace_id,
        meetingId: updated.meeting_id,
        recordingId: updated.recording_id,
        processingJobId: updated.id,
        eventType: 'job_retry_scheduled',
        fencingToken: toNum(updated.fencing_token),
        metadata: {
          scheduled_at: scheduledAtIso,
          attempt: updated.attempt,
        },
      });
    } else {
      if (
        updated.job_type !== 'generate_embeddings' &&
        updated.job_type !== 'index_knowledge' &&
        updated.job_type !== 'send_telegram_notifications' &&
        updated.job_type !== 'execute_automation_action'
      ) {
        const deadLetterMeetingStatus =
          updated.job_type === 'analyze_meeting' ||
          updated.job_type === 'normalize_intelligence' ||
          updated.job_type === 'finalize_analysis'
            ? 'analysis_failed'
            : updated.job_type === 'transcribe_meeting' ||
                updated.job_type === 'normalize_transcript' ||
                updated.job_type === 'finalize_transcript'
              ? 'transcription_failed'
              : 'failed';

        await this.db.query(
          `update public.meetings
              set status = $3::text::public.meeting_status,
                  processing_status = $3::text::public.meeting_processing_status
            where id = $1
              and workspace_id = $2`,
          [updated.meeting_id, updated.workspace_id, deadLetterMeetingStatus],
        );
      }

      await this.service.recordProcessingEvent({
        workspaceId: updated.workspace_id,
        meetingId: updated.meeting_id,
        recordingId: updated.recording_id,
        processingJobId: updated.id,
        eventType: 'job_dead_lettered',
        fencingToken: toNum(updated.fencing_token),
        metadata: {
          error_code: failure.code,
          attempt: updated.attempt,
          max_attempts: updated.max_attempts,
        },
      });
    }

    return mapJobRow(updated);
  }

  /**
   * Executes one `prepare_recording` job end-to-end:
   * - claims eligible job
   * - validates verified source/chunk inventory in DB and private object storage
   * - builds canonical recording asset metadata
   * - commits result guarded by `(workerId, fencingToken)`
   * Does NOT transcribe, call an LLM, or generate embeddings.
   */
  async runNextPrepareRecordingJob(
    workerId: string,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    const job = await this.claimNextJob(workerId, options);
    if (!job) return null;

    return this.executeClaimedPrepareRecordingJob(workerId, job, { now: options.now });
  }

  async executeClaimedPrepareRecordingJob(
    workerId: string,
    job: ProcessingJobDto,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto> {
    const [recordingRes, sourcesRes, chunksRes] = await Promise.all([
      this.db.query<DbRecordingRow>(
        `select * from public.recordings where id = $1 and workspace_id = $2`,
        [job.recordingId, job.workspaceId],
      ),
      this.db.query<DbSourceRow>(
        `select * from public.recording_sources where recording_id = $1 and workspace_id = $2 order by created_at asc`,
        [job.recordingId, job.workspaceId],
      ),
      this.db.query<DbChunkRow>(
        `select * from public.recording_chunks where recording_id = $1 and workspace_id = $2 order by recording_source_id asc, sequence_no asc`,
        [job.recordingId, job.workspaceId],
      ),
    ]);

    const recording = recordingRes.rows[0];
    if (!recording || recording.status !== 'finalized') {
      return this.failJob(workerId, job.id, job.fencingToken, {
        code: 'recording_not_finalized',
        message: 'Recording is missing or not finalized.',
        retryable: false,
        now: options.now,
      });
    }

    if (sourcesRes.rows.length === 0 || chunksRes.rows.length === 0) {
      return this.failJob(workerId, job.id, job.fencingToken, {
        code: 'empty_recording_inventory',
        message: 'Recording has no registered sources or chunks.',
        retryable: false,
        now: options.now,
      });
    }

    // Validate every chunk is verified and its object in storage still matches size & SHA-256
    let totalVerifiedBytes = 0;
    for (const chunk of chunksRes.rows) {
      if (chunk.verification_state !== 'verified' || !chunk.verified_at) {
        return this.failJob(workerId, job.id, job.fencingToken, {
          code: 'unverified_chunk_in_inventory',
          message: `Chunk ${chunk.id} (sequence ${chunk.sequence_no}) is not verified.`,
          retryable: false,
          now: options.now,
        });
      }
      const check = await this.storage.verifyObject({
        storageKey: chunk.storage_key,
        expectedByteSize: toNum(chunk.byte_size),
        expectedSha256: chunk.checksum_sha256,
      });
      if (!check.ok) {
        return this.failJob(workerId, job.id, job.fencingToken, {
          code: `storage_verification_${check.reason}`,
          message: check.detail,
          retryable: check.reason === 'storage_error',
          now: options.now,
        });
      }
      totalVerifiedBytes += toNum(chunk.byte_size);
    }

    const sourceInventory = sourcesRes.rows.map((source) => {
      const sourceChunks = chunksRes.rows.filter((c) => c.recording_source_id === source.id);
      return {
        source_id: source.id,
        source_kind: source.source_kind,
        codec: source.codec,
        container: source.container,
        sample_rate_hz: source.sample_rate_hz,
        channels: source.channels,
        chunk_count: sourceChunks.length,
        total_bytes: sourceChunks.reduce((sum, c) => sum + toNum(c.byte_size), 0),
        meeting_start_ms: sourceChunks[0]?.meeting_start_ms ?? 0,
        meeting_end_ms: sourceChunks.at(-1)?.meeting_end_ms ?? 0,
        sample_start: sourceChunks[0] ? toNum(sourceChunks[0].sample_start) : 0,
        sample_end: sourceChunks.at(-1) ? toNum(sourceChunks.at(-1)!.sample_end) : 0,
      };
    });

    const canonicalAssetMetadata = {
      schema_version: 1,
      stage: 'prepare_recording',
      workspace_id: job.workspaceId,
      meeting_id: job.meetingId,
      recording_id: job.recordingId,
      total_verified_chunks: chunksRes.rows.length,
      total_verified_bytes: totalVerifiedBytes,
      canonical_duration_ms: recording.canonical_duration_ms ?? 0,
      active_capture_ms: recording.active_capture_ms ?? 0,
      sources: sourceInventory,
      ready_for_stage: 'transcribe_meeting',
    };

    return this.completeJob(workerId, job.id, job.fencingToken, canonicalAssetMetadata, {
      now: options.now,
    });
  }
}
