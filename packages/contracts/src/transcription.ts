import { z } from 'zod';
import { RESOURCE_ID_SCHEMA_PATTERN, countSchema, hzSchema } from './recorder';
import {
  audioContainerExtSchema,
  meetingPipelineStatusSchema,
  processingJobDtoSchema,
  recordingSourceKindExtendedSchema,
  recordingSourceRoleSchema,
  storageBackendSchema,
} from './upload';

const uuidSchema = () => z.string().regex(RESOURCE_ID_SCHEMA_PATTERN, 'expected a lowercase UUID');

export const transcriptionAssetStatusSchema = z.enum(['preparing', 'ready', 'failed', 'deleted']);
export type TranscriptionAssetStatus = z.infer<typeof transcriptionAssetStatusSchema>;

export const transcriptionRunStatusSchema = z.enum([
  'queued',
  'running',
  'normalizing',
  'completed',
  'failed',
  'superseded',
]);
export type TranscriptionRunStatus = z.infer<typeof transcriptionRunStatusSchema>;

export const detectedSegmentLanguageSchema = z.enum(['uz', 'ru', 'en', 'mixed', 'unknown']);
export type DetectedSegmentLanguage = z.infer<typeof detectedSegmentLanguageSchema>;

export const discontinuityReasonSchema = z.enum([
  'none',
  'pause_gap',
  'chunk_gap',
  'late_source_join',
  'source_concatenation',
]);
export type DiscontinuityReason = z.infer<typeof discontinuityReasonSchema>;

export function buildCanonicalTranscribeJobIdempotencyKey(
  recordingId: string,
  assetVersion = 1,
  generation = 1,
): string {
  return `recording:${recordingId}:asset:${assetVersion}:transcribe_meeting:gen:${generation}`;
}

export function buildCanonicalNormalizeJobIdempotencyKey(
  transcriptionRunId: string,
  normalizationVersion = 1,
  generation = 1,
): string {
  return `transcription_run:${transcriptionRunId}:normalize_transcript:v:${normalizationVersion}:gen:${generation}`;
}

export function buildCanonicalFinalizeTranscriptJobIdempotencyKey(
  transcriptionRunId: string,
  generation = 1,
): string {
  return `transcription_run:${transcriptionRunId}:finalize_transcript:gen:${generation}`;
}

/**
 * Piecewise `asset_time -> meeting_time -> original_source_sample` entry persisted on `transcription_assets`.
 */
export const transcriptionAssetPieceSchema = z
  .object({
    pieceIndex: countSchema,
    recordingSourceId: uuidSchema(),
    sourceKind: recordingSourceKindExtendedSchema,
    recordingChunkId: uuidSchema(),
    chunkSequenceNo: countSchema,
    assetStartMs: countSchema,
    assetEndMs: countSchema,
    meetingStartMs: countSchema,
    meetingEndMs: countSchema,
    sourceSampleStart: countSchema,
    sourceSampleEnd: countSchema,
    sampleRateHz: hzSchema,
    channels: z.number().int().min(1).max(32),
    gapBeforeAssetMs: countSchema.default(0),
    gapBeforeMeetingMs: countSchema.default(0),
    discontinuityReason: discontinuityReasonSchema.default('none'),
  })
  .refine((piece) => piece.assetEndMs > piece.assetStartMs, {
    message: 'assetEndMs must be greater than assetStartMs',
  })
  .refine((piece) => piece.meetingEndMs > piece.meetingStartMs, {
    message: 'meetingEndMs must be greater than meetingStartMs',
  })
  .refine((piece) => piece.sourceSampleEnd > piece.sourceSampleStart, {
    message: 'sourceSampleEnd must be greater than sourceSampleStart',
  });
export type TranscriptionAssetPiece = z.infer<typeof transcriptionAssetPieceSchema>;

export const transcriptionAssetSourceLineageSchema = z.object({
  recordingSourceId: uuidSchema(),
  sourceKind: recordingSourceKindExtendedSchema,
  sourceRole: recordingSourceRoleSchema,
  codec: z.string().min(1),
  container: audioContainerExtSchema,
  sampleRateHz: hzSchema,
  channels: z.number().int().min(1).max(32),
  chunkIds: z.array(uuidSchema()),
  sequenceNumbers: z.array(countSchema),
  totalByteSize: countSchema,
  firstSampleMeetingMs: countSchema,
  lastSampleMeetingMs: countSchema,
  droppedSampleCount: countSchema,
});
export type TranscriptionAssetSourceLineage = z.infer<typeof transcriptionAssetSourceLineageSchema>;

export const transcriptionAssetDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  assetVersion: z.number().int().positive(),
  assetRole: z.string().min(1),
  status: transcriptionAssetStatusSchema,
  storageBackend: storageBackendSchema,
  storageKey: z.string().min(16).max(512),
  container: audioContainerExtSchema,
  codec: z.string().min(1),
  sampleRateHz: hzSchema,
  channels: z.number().int().min(1).max(32),
  byteSize: z.number().int().positive(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  assetDurationMs: countSchema,
  canonicalDurationMs: countSchema,
  activeCaptureMs: countSchema,
  timelineMap: z.array(transcriptionAssetPieceSchema).min(1),
  sourceLineage: z.array(transcriptionAssetSourceLineageSchema).min(1),
  preparationMetadata: z.record(z.string(), z.unknown()),
  preparedAt: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TranscriptionAssetDto = z.infer<typeof transcriptionAssetDtoSchema>;

/**
 * Provider-neutral transcription word/token shape.
 */
export const providerTranscriptWordSchema = z
  .object({
    text: z.string().min(1),
    startMs: z.number().int(),
    endMs: z.number().int(),
    confidence: z.number().min(0).max(1).nullable().default(null),
    speakerLabel: z.string().min(1).nullable().default(null),
  })
  .refine((w) => w.endMs >= w.startMs, {
    message: 'word endMs must be >= startMs',
  });
export type ProviderTranscriptWord = z.infer<typeof providerTranscriptWordSchema>;

/**
 * Provider-neutral transcript segment/utterance shape returned by any `TranscriptionProvider`.
 * Note: `startMs` and `endMs` here are provider/asset-local timestamps (before canonical timeline alignment).
 */
export const providerTranscriptSegmentSchema = z.object({
  providerSegmentKey: z.string().min(1).max(160),
  speakerLabel: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, 'invalid speakerLabel'),
  startMs: z.number().int(),
  endMs: z.number().int(),
  text: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).nullable().default(null),
  detectedLanguage: detectedSegmentLanguageSchema.default('unknown'),
  words: z.array(providerTranscriptWordSchema).default([]),
  providerMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderTranscriptSegment = z.infer<typeof providerTranscriptSegmentSchema>;

export const providerTranscriptionResultSchema = z.object({
  provider: z.string().min(1).max(64),
  providerModel: z.string().min(1).max(120),
  providerJobId: z.string().min(1).max(160),
  detectedLanguages: z.array(detectedSegmentLanguageSchema).default([]),
  durationMs: countSchema.nullable().default(null),
  segments: z.array(providerTranscriptSegmentSchema),
  providerMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderTranscriptionResult = z.infer<typeof providerTranscriptionResultSchema>;

export const transcriptionRunDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  transcriptionAssetId: uuidSchema(),
  assetVersion: z.number().int().positive(),
  runNumber: z.number().int().positive(),
  provider: z.string().min(1),
  providerModel: z.string().min(1),
  providerJobId: z.string().nullable(),
  status: transcriptionRunStatusSchema,
  normalizationVersion: z.number().int().positive(),
  requestedLanguages: z.array(z.string()),
  detectedLanguages: z.array(z.string()),
  diarizationEnabled: z.boolean(),
  segmentCount: countSchema,
  quarantinedSegmentCount: countSchema,
  speakerCount: countSchema,
  wordCount: countSchema,
  confidenceAvg: z.number().min(0).max(1).nullable(),
  startedAt: z.string().nullable(),
  providerCompletedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  failureMetadata: z.record(z.string(), z.unknown()),
  providerSummaryMetadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type TranscriptionRunDto = z.infer<typeof transcriptionRunDtoSchema>;

export const meetingParticipantDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  userId: uuidSchema().nullable(),
  displayName: z.string().min(1).max(160),
  roleLabel: z.string().max(120).nullable(),
  email: z.string().max(240).nullable(),
  isExternal: z.boolean(),
  sortOrder: countSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MeetingParticipantDto = z.infer<typeof meetingParticipantDtoSchema>;

export const meetingSpeakerDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  providerSpeakerLabel: z.string().min(1),
  displayLabel: z.string().min(1),
  participantId: uuidSchema().nullable(),
  mappedBy: uuidSchema().nullable(),
  mappedAt: z.string().nullable(),
  segmentCount: countSchema,
  speakingDurationMs: countSchema,
  confidenceAvg: z.number().min(0).max(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MeetingSpeakerDto = z.infer<typeof meetingSpeakerDtoSchema>;

export const canonicalTranscriptSegmentDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  transcriptionAssetId: uuidSchema(),
  sequenceNo: countSchema,
  providerSegmentKey: z.string().min(1),
  speakerId: uuidSchema(),
  providerSpeakerLabel: z.string().min(1),
  participantId: uuidSchema().nullable(),
  speakerDisplayLabel: z.string().min(1),
  startMs: countSchema,
  endMs: countSchema,
  durationMs: z.number().int().positive(),
  assetStartMs: countSchema,
  assetEndMs: countSchema,
  sourceRecordingSourceId: uuidSchema().nullable(),
  sourceRecordingChunkId: uuidSchema().nullable(),
  sourceSampleStart: countSchema.nullable(),
  sourceSampleEnd: countSchema.nullable(),
  text: z.string().min(1),
  language: detectedSegmentLanguageSchema,
  confidence: z.number().min(0).max(1).nullable(),
  wordCount: countSchema,
  words: z.array(providerTranscriptWordSchema),
  alignmentStatus: z.enum(['canonical', 'quarantined']),
  alignmentMetadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
});
export type CanonicalTranscriptSegmentDto = z.infer<typeof canonicalTranscriptSegmentDtoSchema>;

export const meetingTranscriptionStatusResponseSchema = z.object({
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
  activeRecordingId: uuidSchema().nullable(),
  currentTranscriptionRunId: uuidSchema().nullable(),
  latestTranscriptionRunId: uuidSchema().nullable(),
  currentAsset: transcriptionAssetDtoSchema.nullable(),
  runs: z.array(transcriptionRunDtoSchema),
  speakers: z.array(meetingSpeakerDtoSchema),
  participants: z.array(meetingParticipantDtoSchema),
  jobs: z.array(processingJobDtoSchema),
});
export type MeetingTranscriptionStatusResponse = z.infer<
  typeof meetingTranscriptionStatusResponseSchema
>;

export const getMeetingTranscriptResponseSchema = z.object({
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  currentTranscriptionRun: transcriptionRunDtoSchema.nullable(),
  totalSegments: countSchema,
  totalDurationMs: countSchema,
  wordCount: countSchema,
  detectedLanguages: z.array(z.string()),
  speakers: z.array(meetingSpeakerDtoSchema),
  participants: z.array(meetingParticipantDtoSchema),
  segments: z.array(canonicalTranscriptSegmentDtoSchema),
  quarantinedSegmentCount: countSchema,
});
export type GetMeetingTranscriptResponse = z.infer<typeof getMeetingTranscriptResponseSchema>;

export const speakerMappingEntryInputSchema = z.object({
  speakerLabel: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, 'invalid speakerLabel'),
  participantId: uuidSchema().nullable().optional(),
  userId: uuidSchema().nullable().optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  roleLabel: z.string().trim().max(120).nullable().optional(),
  isExternal: z.boolean().optional(),
});
export type SpeakerMappingEntryInput = z.infer<typeof speakerMappingEntryInputSchema>;

export const meetingParticipantInputSchema = z.object({
  participantId: uuidSchema().optional(),
  userId: uuidSchema().nullable().optional(),
  displayName: z.string().trim().min(1).max(160),
  roleLabel: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().max(240).nullable().optional(),
  isExternal: z.boolean().default(false),
});
export type MeetingParticipantInput = z.infer<typeof meetingParticipantInputSchema>;

export const updateSpeakerMappingsRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  participants: z.array(meetingParticipantInputSchema).optional(),
  mappings: z.array(speakerMappingEntryInputSchema).min(1),
});
export type UpdateSpeakerMappingsRequest = z.infer<typeof updateSpeakerMappingsRequestSchema>;
export type UpdateSpeakerMappingsRequestInput = z.input<typeof updateSpeakerMappingsRequestSchema>;

export const updateSpeakerMappingsResponseSchema = z.object({
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  participants: z.array(meetingParticipantDtoSchema),
  speakers: z.array(meetingSpeakerDtoSchema),
});
export type UpdateSpeakerMappingsResponse = z.infer<typeof updateSpeakerMappingsResponseSchema>;

export const retryTranscriptionRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  reason: z.string().trim().max(240).optional(),
});
export type RetryTranscriptionRequest = z.infer<typeof retryTranscriptionRequestSchema>;
export type RetryTranscriptionRequestInput = z.input<typeof retryTranscriptionRequestSchema>;

export const retryTranscriptionResponseSchema = z.object({
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  job: processingJobDtoSchema,
  idempotentReused: z.boolean(),
});
export type RetryTranscriptionResponse = z.infer<typeof retryTranscriptionResponseSchema>;
