import { z } from 'zod';
import {
  CHECKSUM_SCHEMA,
  RESOURCE_ID_SCHEMA_PATTERN,
  bigCountSchema,
  countSchema,
  hzSchema,
} from './recorder';

const uuidSchema = () => z.string().regex(RESOURCE_ID_SCHEMA_PATTERN, 'expected a lowercase UUID');

export const recordingStatusSchema = z.enum([
  'registered',
  'recording',
  'paused',
  'uploading',
  'finalizing',
  'finalized',
  'failed',
  'interrupted',
  'deleted',
]);
export type RecordingStatus = z.infer<typeof recordingStatusSchema>;

export const recordingSourceKindExtendedSchema = z.enum([
  'microphone',
  'system_audio',
  'mixed_rendered',
]);
export type RecordingSourceKindExtended = z.infer<typeof recordingSourceKindExtendedSchema>;

export const recordingSourceRoleSchema = z.enum(['original', 'derived']);
export type RecordingSourceRole = z.infer<typeof recordingSourceRoleSchema>;

export const chunkUploadStateSchema = z.enum([
  'pending',
  'authorizing',
  'uploading',
  'uploaded',
  'verifying',
  'verified',
  'failed_retryable',
  'failed_terminal',
]);
export type ChunkUploadState = z.infer<typeof chunkUploadStateSchema>;

export const chunkVerificationStateSchema = z.enum([
  'pending',
  'verifying',
  'verified',
  'rejected',
]);
export type ChunkVerificationState = z.infer<typeof chunkVerificationStateSchema>;

export const processingJobStatusSchema = z.enum([
  'queued',
  'running',
  'retryable_failed',
  'succeeded',
  'dead_lettered',
  'cancelled',
]);
export type ProcessingJobStatus = z.infer<typeof processingJobStatusSchema>;

export const processingJobTypeSchema = z.enum([
  'prepare_recording',
  'assemble_recording',
  'transcribe_meeting',
  'normalize_transcript',
  'finalize_transcript',
  'analyze_meeting',
  'normalize_intelligence',
  'finalize_analysis',
  'generate_embeddings',
  'index_knowledge',
  'send_telegram_notifications',
  'execute_automation_action',
]);
export type ProcessingJobType = z.infer<typeof processingJobTypeSchema>;

export const meetingPipelineStatusSchema = z.enum([
  'idle',
  'recording',
  'uploading',
  'uploaded',
  'preparing',
  'ready_for_transcription',
  'transcribing',
  'normalizing_transcript',
  'transcript_ready',
  'transcription_failed',
  'ready_for_analysis',
  'analyzing',
  'normalizing_analysis',
  'analysis_ready',
  'analysis_failed',
  'ready',
  'failed',
]);
export type MeetingPipelineStatus = z.infer<typeof meetingPipelineStatusSchema>;

export const processingEventTypeSchema = z.enum([
  'recording_created',
  'source_registered',
  'chunk_registered',
  'upload_authorized',
  'chunk_uploaded',
  'chunk_verified',
  'chunk_verification_failed',
  'recording_finalized',
  'recording_finalize_incomplete',
  'job_created',
  'job_claimed',
  'job_heartbeat',
  'job_retry_scheduled',
  'job_reclaimed',
  'job_succeeded',
  'job_failed',
  'job_dead_lettered',
  'job_cancelled',
  'recording_deletion_requested',
  'object_deleted',
  'object_delete_reconciliation_required',
  'recording_deletion_completed',
  'transcription_asset_prepared',
  'transcription_started',
  'transcription_completed',
  'transcription_failed',
  'transcript_normalized',
  'transcript_finalized',
  'speaker_mapping_updated',
  'analysis_started',
  'analysis_window_processed',
  'analysis_completed',
  'analysis_failed',
  'intelligence_normalized',
  'intelligence_evidence_quarantined',
  'analysis_finalized',
  'analysis_retried',
  'embeddings_started',
  'embeddings_completed',
  'embeddings_failed',
  'knowledge_indexed',
  'knowledge_reindexed',
  'ask_ai_queried',
  'telegram_link_token_created',
  'telegram_account_linked',
  'telegram_account_unlinked',
  'telegram_notification_queued',
  'telegram_notification_sent',
  'telegram_notification_failed',
  'telegram_bot_command_handled',
  'telegram_rate_limited',
  'automation_action_prepared',
  'automation_action_confirmed',
  'automation_action_succeeded',
  'automation_action_failed',
  'automation_action_cancelled',
  'meeting_exported',
]);
export type ProcessingEventType = z.infer<typeof processingEventTypeSchema>;

export const storageBackendSchema = z.enum(['local', 'memory', 'r2', 's3']);
export type StorageBackend = z.infer<typeof storageBackendSchema>;

export const audioContainerExtSchema = z.enum(['wav', 'ogg', 'opus', 'flac', 'm4a']);
export type AudioContainerExt = z.infer<typeof audioContainerExtSchema>;

export function buildCanonicalChunkIdempotencyKey(
  recordingId: string,
  recordingSourceId: string,
  sequenceNo: number,
): string {
  return `${recordingId}:${recordingSourceId}:${sequenceNo}`;
}

export function buildCanonicalPrepareJobIdempotencyKey(
  recordingId: string,
  generation = 1,
): string {
  return `recording:${recordingId}:prepare_recording:gen:${generation}`;
}

export const recordingTimelineMetadataSchema = z.object({
  clock: z.literal('platform_monotonic_continuous').default('platform_monotonic_continuous'),
  clockEpochId: z.string().trim().min(1).max(64),
  originTicks: bigCountSchema,
  originWallClockUtc: z.string().min(1),
  tickFrequencyHz: hzSchema,
});
export type RecordingTimelineMetadata = z.infer<typeof recordingTimelineMetadataSchema>;

export const recordingConsentMetadataSchema = z.object({
  acknowledgedAt: z.string().min(1),
  policyVersion: z.string().trim().min(1).max(32).default('v1'),
});
export type RecordingConsentMetadata = z.infer<typeof recordingConsentMetadataSchema>;

export const createRecordingRequestSchema = z.object({
  recordingId: uuidSchema().optional(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  sessionId: uuidSchema(),
  timeline: recordingTimelineMetadataSchema,
  consent: recordingConsentMetadataSchema,
  startedAt: z.string().min(1).optional(),
  manifestRevision: z.number().int().positive().default(1),
  timelineMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateRecordingRequest = z.infer<typeof createRecordingRequestSchema>;
export type CreateRecordingRequestInput = z.input<typeof createRecordingRequestSchema>;

export const recordingDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  sessionId: uuidSchema(),
  status: recordingStatusSchema,
  timeline: recordingTimelineMetadataSchema,
  consent: recordingConsentMetadataSchema,
  canonicalDurationMs: countSchema.nullable(),
  activeCaptureMs: countSchema.nullable(),
  startedAt: z.string().min(1),
  stoppedAt: z.string().min(1).nullable(),
  finalizedAt: z.string().min(1).nullable(),
  manifestRevision: z.number().int().positive(),
  createdBy: uuidSchema(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type RecordingDto = z.infer<typeof recordingDtoSchema>;

export const registerRecordingSourceRequestSchema = z
  .object({
    sourceId: uuidSchema().optional(),
    workspaceId: uuidSchema().optional(),
    sourceKind: recordingSourceKindExtendedSchema,
    sourceRole: recordingSourceRoleSchema.default('original'),
    isRequired: z.boolean().default(true),
    codec: z.string().trim().min(1).max(64),
    container: audioContainerExtSchema,
    sampleRateHz: hzSchema,
    channels: z.number().int().min(1).max(32),
    deviceUid: z.string().max(128).nullish(),
    deviceName: z.string().max(160).nullish(),
    startedAtTicks: bigCountSchema.nullish(),
    endedAtTicks: bigCountSchema.nullish(),
    firstSampleIndex: countSchema.default(0),
    lastSampleIndexExclusive: countSchema.nullish(),
    firstSampleMeetingMs: countSchema.default(0),
    lastSampleMeetingMs: countSchema.nullish(),
    droppedSampleCount: countSchema.default(0),
    expectedChunkCount: countSchema.nullish(),
    captureMetadata: z.record(z.string(), z.unknown()).default({}),
    formatMetadata: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (data) =>
      data.lastSampleIndexExclusive === undefined ||
      data.lastSampleIndexExclusive === null ||
      data.lastSampleIndexExclusive >= data.firstSampleIndex,
    { message: 'lastSampleIndexExclusive must be >= firstSampleIndex' },
  )
  .refine(
    (data) =>
      data.lastSampleMeetingMs === undefined ||
      data.lastSampleMeetingMs === null ||
      data.lastSampleMeetingMs >= data.firstSampleMeetingMs,
    { message: 'lastSampleMeetingMs must be >= firstSampleMeetingMs' },
  );
export type RegisterRecordingSourceRequest = z.infer<typeof registerRecordingSourceRequestSchema>;
export type RegisterRecordingSourceRequestInput = z.input<
  typeof registerRecordingSourceRequestSchema
>;

export const recordingSourceDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  sourceKind: recordingSourceKindExtendedSchema,
  sourceRole: recordingSourceRoleSchema,
  isRequired: z.boolean(),
  codec: z.string().min(1),
  container: audioContainerExtSchema,
  sampleRateHz: hzSchema,
  channels: z.number().int().min(1).max(32),
  deviceUid: z.string().nullable(),
  deviceName: z.string().nullable(),
  startedAtTicks: bigCountSchema.nullable(),
  endedAtTicks: bigCountSchema.nullable(),
  firstSampleIndex: countSchema,
  lastSampleIndexExclusive: countSchema.nullable(),
  firstSampleMeetingMs: countSchema,
  lastSampleMeetingMs: countSchema.nullable(),
  droppedSampleCount: countSchema,
  expectedChunkCount: countSchema.nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type RecordingSourceDto = z.infer<typeof recordingSourceDtoSchema>;

export const registerRecordingChunkRequestSchema = z
  .object({
    chunkId: uuidSchema().optional(),
    clientChunkId: uuidSchema().optional(),
    workspaceId: uuidSchema().optional(),
    recordingSourceId: uuidSchema(),
    sequenceNo: countSchema,
    idempotencyKey: z.string().trim().min(1).max(256).optional(),
    meetingStartMs: countSchema,
    meetingEndMs: countSchema,
    durationMs: z.number().int().positive().optional(),
    sampleStart: countSchema,
    sampleEnd: countSchema,
    firstSampleMonotonicTicks: bigCountSchema.default('0'),
    byteSize: z.number().int().positive(),
    checksum: CHECKSUM_SCHEMA,
    codec: z.string().trim().min(1).max(64),
    container: audioContainerExtSchema,
    sampleRateHz: hzSchema,
    channels: z.number().int().min(1).max(32),
    encoderDelaySamples: countSchema.default(0),
    encoderPaddingSamples: countSchema.default(0),
  })
  .refine((data) => data.meetingEndMs > data.meetingStartMs, {
    message: 'meetingEndMs must be greater than meetingStartMs',
  })
  .refine((data) => data.sampleEnd > data.sampleStart, {
    message: 'sampleEnd must be greater than sampleStart',
  });
export type RegisterRecordingChunkRequest = z.infer<typeof registerRecordingChunkRequestSchema>;
export type RegisterRecordingChunkRequestInput = z.input<
  typeof registerRecordingChunkRequestSchema
>;

export const recordingChunkDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  recordingSourceId: uuidSchema(),
  clientChunkId: uuidSchema(),
  idempotencyKey: z.string().min(1),
  sequenceNo: countSchema,
  meetingStartMs: countSchema,
  meetingEndMs: countSchema,
  durationMs: z.number().int().positive(),
  sampleStart: countSchema,
  sampleEnd: countSchema,
  firstSampleMonotonicTicks: bigCountSchema,
  byteSize: z.number().int().positive(),
  checksum: CHECKSUM_SCHEMA,
  storageBackend: storageBackendSchema,
  storageKey: z.string().min(16).max(512),
  uploadState: chunkUploadStateSchema,
  verificationState: chunkVerificationStateSchema,
  codec: z.string().min(1),
  container: audioContainerExtSchema,
  sampleRateHz: hzSchema,
  channels: z.number().int().min(1).max(32),
  encoderDelaySamples: countSchema,
  encoderPaddingSamples: countSchema,
  verifiedByteSize: z.number().int().positive().nullable(),
  verifiedSha256: z.string().nullable(),
  verificationMethod: z.string().nullable(),
  verificationErrorCode: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  uploadedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
});
export type RecordingChunkDto = z.infer<typeof recordingChunkDtoSchema>;

export const authorizeChunkUploadRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  expiresInSeconds: z.number().int().min(30).max(900).default(300),
  contentType: z.string().trim().min(1).max(120).optional(),
});
export type AuthorizeChunkUploadRequest = z.infer<typeof authorizeChunkUploadRequestSchema>;
export type AuthorizeChunkUploadRequestInput = z.input<typeof authorizeChunkUploadRequestSchema>;

export const chunkUploadAuthorizationDtoSchema = z.object({
  chunkId: uuidSchema(),
  recordingId: uuidSchema(),
  recordingSourceId: uuidSchema(),
  sequenceNo: countSchema,
  storageBackend: storageBackendSchema,
  storageKey: z.string().min(16).max(512),
  method: z.literal('PUT'),
  uploadUrl: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().min(1),
  alreadyVerified: z.boolean(),
});
export type ChunkUploadAuthorizationDto = z.infer<typeof chunkUploadAuthorizationDtoSchema>;

export const verifyChunkUploadRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
});
export type VerifyChunkUploadRequest = z.infer<typeof verifyChunkUploadRequestSchema>;
export type VerifyChunkUploadRequestInput = z.input<typeof verifyChunkUploadRequestSchema>;

export const verifyChunkUploadResponseSchema = z.object({
  verified: z.boolean(),
  chunk: recordingChunkDtoSchema,
  verification: z.object({
    method: z.string().nullable(),
    verifiedByteSize: z.number().int().positive().nullable(),
    verifiedSha256: z.string().nullable(),
    failureReason: z.string().nullable(),
    failureDetail: z.string().nullable(),
  }),
});
export type VerifyChunkUploadResponse = z.infer<typeof verifyChunkUploadResponseSchema>;

export const expectedSourceChunkSummarySchema = z.object({
  recordingSourceId: uuidSchema(),
  expectedChunkCount: countSchema,
});
export type ExpectedSourceChunkSummary = z.infer<typeof expectedSourceChunkSummarySchema>;

export const finalizeRecordingRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  canonicalDurationMs: countSchema.optional(),
  activeCaptureMs: countSchema.optional(),
  stoppedAt: z.string().min(1).optional(),
  manifestRevision: z.number().int().positive().optional(),
  expectedSources: z.array(expectedSourceChunkSummarySchema).optional(),
});
export type FinalizeRecordingRequest = z.infer<typeof finalizeRecordingRequestSchema>;
export type FinalizeRecordingRequestInput = z.input<typeof finalizeRecordingRequestSchema>;

export const processingJobDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  jobType: processingJobTypeSchema,
  generation: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  status: processingJobStatusSchema,
  attempt: countSchema,
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  fencingToken: countSchema,
  scheduledAt: z.string().min(1),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  errorMetadata: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  resultMetadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ProcessingJobDto = z.infer<typeof processingJobDtoSchema>;

export const incompleteRecordingResponseSchema = z.object({
  status: z.literal('incomplete'),
  recordingId: uuidSchema(),
  code: z.literal('recording_incomplete'),
  message: z.string().min(1),
  missingSources: z.array(uuidSchema()),
  missingChunks: z.array(
    z.object({
      recordingSourceId: uuidSchema(),
      sequenceNo: countSchema,
    }),
  ),
  unverifiedChunks: z.array(
    z.object({
      chunkId: uuidSchema(),
      recordingSourceId: uuidSchema(),
      sequenceNo: countSchema,
      uploadState: chunkUploadStateSchema,
      verificationState: chunkVerificationStateSchema,
    }),
  ),
});
export type IncompleteRecordingResponse = z.infer<typeof incompleteRecordingResponseSchema>;

export const finalizedRecordingResponseSchema = z.object({
  status: z.literal('finalized'),
  recording: recordingDtoSchema,
  job: processingJobDtoSchema,
  idempotentReused: z.boolean(),
});
export type FinalizedRecordingResponse = z.infer<typeof finalizedRecordingResponseSchema>;

export const finalizeRecordingResponseSchema = z.discriminatedUnion('status', [
  finalizedRecordingResponseSchema,
  incompleteRecordingResponseSchema,
]);
export type FinalizeRecordingResponse = z.infer<typeof finalizeRecordingResponseSchema>;

export const processingEventDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema().nullable(),
  recordingSourceId: uuidSchema().nullable(),
  recordingChunkId: uuidSchema().nullable(),
  processingJobId: uuidSchema().nullable(),
  sequenceNo: countSchema.nullable(),
  eventType: processingEventTypeSchema,
  actorId: uuidSchema().nullable(),
  fencingToken: countSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
});
export type ProcessingEventDto = z.infer<typeof processingEventDtoSchema>;

export const recordingDetailResponseSchema = z.object({
  recording: recordingDtoSchema,
  sources: z.array(recordingSourceDtoSchema),
  chunks: z.array(recordingChunkDtoSchema),
  jobs: z.array(processingJobDtoSchema),
});
export type RecordingDetailResponse = z.infer<typeof recordingDetailResponseSchema>;

export const meetingProcessingStepDtoSchema = z.object({
  state: z.enum(['done', 'active', 'pending', 'failed']),
  key: z.string().min(1),
  label: z.string().min(1),
  at: z.string().optional(),
  detail: z.string().optional(),
});

export const meetingProcessingResponseSchema = z.object({
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  meetingStatus: z.enum([
    'draft',
    'recording',
    'uploading',
    'processing',
    'ready_for_transcription',
    'transcribing',
    'normalizing_transcript',
    'transcript_ready',
    'transcription_failed',
    'ready_for_analysis',
    'analyzing',
    'normalizing_analysis',
    'analysis_ready',
    'analysis_failed',
    'ready',
    'failed',
    'archived',
  ]),
  pipelineStatus: meetingPipelineStatusSchema,
  productState: z.enum([
    'draft',
    'recording',
    'queued',
    'uploading',
    'preparing',
    'ready_for_transcription',
    'preparing_transcript',
    'transcribing',
    'normalizing_transcript',
    'transcript_ready',
    'transcription_failed',
    'ready_for_analysis',
    'analyzing',
    'normalizing_analysis',
    'analysis_ready',
    'analysis_failed',
    'indexing',
    'ready',
    'failed',
  ]),
  recordingAvailable: z.boolean(),
  activeRecordingId: uuidSchema().nullable(),
  verifiedChunkCount: countSchema,
  totalChunkCount: countSchema,
  jobs: z.array(processingJobDtoSchema),
  timeline: z.object({
    meetingId: uuidSchema(),
    state: z.enum([
      'draft',
      'recording',
      'queued',
      'uploading',
      'preparing',
      'ready_for_transcription',
      'preparing_transcript',
      'transcribing',
      'normalizing_transcript',
      'transcript_ready',
      'transcription_failed',
      'ready_for_analysis',
      'analyzing',
      'normalizing_analysis',
      'analysis_ready',
      'analysis_failed',
      'indexing',
      'ready',
      'failed',
    ]),
    steps: z.array(meetingProcessingStepDtoSchema).min(1),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        hint: z.string().optional(),
        retryable: z.boolean(),
      })
      .optional(),
  }),
});
export type MeetingProcessingResponse = z.infer<typeof meetingProcessingResponseSchema>;

export const objectDeletionEntryDtoSchema = z.object({
  id: uuidSchema(),
  recordingChunkId: uuidSchema().nullable(),
  storageBackend: storageBackendSchema,
  storageKey: z.string().min(1),
  status: z.enum(['pending', 'deleted', 'reconciliation_required']),
  attemptCount: countSchema,
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
});
export type ObjectDeletionEntryDto = z.infer<typeof objectDeletionEntryDtoSchema>;

export const deleteRecordingResponseSchema = z.object({
  recordingId: uuidSchema(),
  meetingId: uuidSchema(),
  workspaceId: uuidSchema(),
  status: z.enum(['deleted', 'reconciliation_required']),
  deletedObjectCount: countSchema,
  reconciliationPendingCount: countSchema,
  ledger: z.array(objectDeletionEntryDtoSchema),
});
export type DeleteRecordingResponse = z.infer<typeof deleteRecordingResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  'unauthenticated',
  'unauthorized',
  'cross_workspace_access_denied',
  'not_found',
  'validation_failed',
  'chunk_conflict',
  'source_conflict',
  'recording_conflict',
  'recording_incomplete',
  'verification_failed',
  'invalid_state',
  'stale_fencing_token',
  'storage_error',
  'provider_not_configured',
  'provider_unavailable',
  'timestamp_alignment_failed',
  'evidence_validation_failed',
  'analysis_failed',
  'embeddings_failed',
  'rate_limited',
  'telegram_delivery_failed',
  'idempotency_conflict',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    detail: z.string().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
