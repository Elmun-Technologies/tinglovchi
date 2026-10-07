import {
  buildCanonicalFinalizeTranscriptJobIdempotencyKey,
  buildCanonicalNormalizeJobIdempotencyKey,
  buildCanonicalTranscribeJobIdempotencyKey,
  providerTranscriptionResultSchema,
  retryTranscriptionRequestSchema,
  transcriptionAssetPieceSchema,
  transcriptionAssetSourceLineageSchema,
  updateSpeakerMappingsRequestSchema,
  type AudioContainerExt,
  type CanonicalTranscriptSegmentDto,
  type DetectedSegmentLanguage,
  type GetMeetingTranscriptResponse,
  type MeetingParticipantDto,
  type MeetingPipelineStatus,
  type MeetingSpeakerDto,
  type MeetingTranscriptionStatusResponse,
  type ProcessingJobDto,
  type ProviderTranscriptWord,
  type ProviderTranscriptionResult,
  type RetryTranscriptionRequestInput,
  type RetryTranscriptionResponse,
  type StorageBackend,
  type TranscriptionAssetDto,
  type TranscriptionAssetStatus,
  type TranscriptionRunDto,
  type TranscriptionRunStatus,
  type UpdateSpeakerMappingsRequestInput,
  type UpdateSpeakerMappingsResponse,
} from '@suhbat/contracts';
import {
  Phase4BackboneService,
  Phase4RecordingWorker,
  Phase4ServiceError,
  redactObservabilityMetadata,
  type AuthenticatedPrincipal,
  type ClaimJobOptions,
  type ObservabilitySink,
  type SqlExecutor,
} from './phase4-backbone';
import { MemoryStorageProvider, type StorageProvider } from './storage';
import {
  alignProviderTranscriptToCanonicalTimeline,
  prepareCanonicalTranscriptionAssetPlan,
} from './transcription-alignment';
import { TranscriptionProviderError, type TranscriptionProvider } from './transcription-provider';

type DbTranscriptionAssetRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  asset_version: number;
  asset_role: string;
  status: TranscriptionAssetStatus;
  storage_backend: StorageBackend;
  storage_key: string;
  container: AudioContainerExt;
  codec: string;
  sample_rate_hz: number;
  channels: number;
  byte_size: number | string;
  checksum_sha256: string;
  asset_duration_ms: number;
  canonical_duration_ms: number;
  active_capture_ms: number;
  timeline_map: unknown;
  source_lineage: unknown;
  preparation_metadata: Record<string, unknown>;
  prepared_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbTranscriptionRunRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  transcription_asset_id: string;
  asset_version: number;
  run_number: number;
  provider: string;
  provider_model: string;
  provider_job_id: string | null;
  status: TranscriptionRunStatus;
  normalization_version: number;
  requested_languages: string[];
  detected_languages: string[];
  diarization_enabled: boolean;
  segment_count: number;
  quarantined_segment_count: number;
  speaker_count: number;
  word_count: number;
  confidence_avg: number | string | null;
  started_at: string | null;
  provider_completed_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  failure_metadata: Record<string, unknown>;
  provider_summary_metadata: Record<string, unknown>;
  raw_provider_response: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type DbMeetingParticipantRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  user_id: string | null;
  display_name: string;
  role_label: string | null;
  email: string | null;
  is_external: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type DbMeetingSpeakerRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  transcription_run_id: string;
  provider_speaker_label: string;
  display_label: string;
  participant_id: string | null;
  mapped_by: string | null;
  mapped_at: string | null;
  segment_count: number;
  speaking_duration_ms: number;
  confidence_avg: number | string | null;
  created_at: string;
  updated_at: string;
};

type DbTranscriptSegmentRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  transcription_run_id: string;
  transcription_asset_id: string;
  sequence_no: number;
  provider_segment_key: string;
  speaker_id: string;
  provider_speaker_label: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  asset_start_ms: number;
  asset_end_ms: number;
  source_recording_source_id: string | null;
  source_recording_chunk_id: string | null;
  source_sample_start: number | string | null;
  source_sample_end: number | string | null;
  text: string;
  language: DetectedSegmentLanguage;
  confidence: number | string | null;
  word_count: number;
  words: unknown;
  alignment_status: 'canonical' | 'quarantined';
  alignment_metadata: Record<string, unknown>;
  created_at: string;
};

type DbMeetingPhase5Row = {
  id: string;
  workspace_id: string;
  status: MeetingTranscriptionStatusResponse['meetingStatus'];
  processing_status: MeetingPipelineStatus;
  current_transcription_run_id: string | null;
  latest_transcription_run_id: string | null;
  detected_languages: string[];
  timeline_duration_ms: number | null;
  deleted_at: string | null;
  purge_status: string;
};

type DbJobPhase5Row = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  job_type: ProcessingJobDto['jobType'];
  generation: number;
  idempotency_key: string;
  status: ProcessingJobDto['status'];
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

function toNullableFloat(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const parsed = typeof val === 'number' ? val : Number.parseFloat(val);
  return Number.isFinite(parsed) ? parsed : null;
}

export function defaultSpeakerDisplayLabel(providerSpeakerLabel: string): string {
  const match = /^speaker_([0-9]+)$/i.exec(providerSpeakerLabel.trim());
  if (match) {
    const zeroBased = Number.parseInt(match[1]!, 10);
    return `Speaker ${zeroBased + 1}`;
  }
  return providerSpeakerLabel;
}

function mapAssetRow(row: DbTranscriptionAssetRow): TranscriptionAssetDto {
  const rawMap = Array.isArray(row.timeline_map) ? row.timeline_map : [];
  const rawLineage = Array.isArray(row.source_lineage) ? row.source_lineage : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    assetVersion: row.asset_version,
    assetRole: row.asset_role,
    status: row.status,
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    container: row.container,
    codec: row.codec,
    sampleRateHz: row.sample_rate_hz,
    channels: row.channels,
    byteSize: toNum(row.byte_size),
    checksumSha256: row.checksum_sha256,
    assetDurationMs: row.asset_duration_ms,
    canonicalDurationMs: row.canonical_duration_ms,
    activeCaptureMs: row.active_capture_ms,
    timelineMap: rawMap.map((p) => transcriptionAssetPieceSchema.parse(p)),
    sourceLineage: rawLineage.map((s) => transcriptionAssetSourceLineageSchema.parse(s)),
    preparationMetadata: row.preparation_metadata ?? {},
    preparedAt: toNullableIsoString(row.prepared_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRunRow(row: DbTranscriptionRunRow): TranscriptionRunDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    transcriptionAssetId: row.transcription_asset_id,
    assetVersion: row.asset_version,
    runNumber: row.run_number,
    provider: row.provider,
    providerModel: row.provider_model,
    providerJobId: row.provider_job_id,
    status: row.status,
    normalizationVersion: row.normalization_version,
    requestedLanguages: Array.isArray(row.requested_languages) ? row.requested_languages : [],
    detectedLanguages: Array.isArray(row.detected_languages) ? row.detected_languages : [],
    diarizationEnabled: row.diarization_enabled,
    segmentCount: row.segment_count,
    quarantinedSegmentCount: row.quarantined_segment_count,
    speakerCount: row.speaker_count,
    wordCount: row.word_count,
    confidenceAvg: toNullableFloat(row.confidence_avg),
    startedAt: toNullableIsoString(row.started_at),
    providerCompletedAt: toNullableIsoString(row.provider_completed_at),
    completedAt: toNullableIsoString(row.completed_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failureMetadata: row.failure_metadata ?? {},
    providerSummaryMetadata: row.provider_summary_metadata ?? {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapParticipantRow(row: DbMeetingParticipantRow): MeetingParticipantDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    userId: row.user_id,
    displayName: row.display_name,
    roleLabel: row.role_label,
    email: row.email,
    isExternal: row.is_external,
    sortOrder: row.sort_order,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapSpeakerRow(row: DbMeetingSpeakerRow): MeetingSpeakerDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    transcriptionRunId: row.transcription_run_id,
    providerSpeakerLabel: row.provider_speaker_label,
    displayLabel: row.display_label,
    participantId: row.participant_id,
    mappedBy: row.mapped_by,
    mappedAt: toNullableIsoString(row.mapped_at),
    segmentCount: row.segment_count,
    speakingDurationMs: row.speaking_duration_ms,
    confidenceAvg: toNullableFloat(row.confidence_avg),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapJobRow(row: DbJobPhase5Row): ProcessingJobDto {
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

function mapSegmentRow(
  row: DbTranscriptSegmentRow,
  speakerMap: Map<string, DbMeetingSpeakerRow>,
  participantMap: Map<string, DbMeetingParticipantRow>,
): CanonicalTranscriptSegmentDto {
  const speaker = speakerMap.get(row.speaker_id);
  const participantId = speaker?.participant_id ?? null;
  const participant = participantId ? participantMap.get(participantId) : undefined;
  const speakerDisplayLabel =
    participant?.display_name ??
    speaker?.display_label ??
    defaultSpeakerDisplayLabel(row.provider_speaker_label);
  const words = Array.isArray(row.words) ? (row.words as ProviderTranscriptWord[]) : [];

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    transcriptionRunId: row.transcription_run_id,
    transcriptionAssetId: row.transcription_asset_id,
    sequenceNo: row.sequence_no,
    providerSegmentKey: row.provider_segment_key,
    speakerId: row.speaker_id,
    providerSpeakerLabel: row.provider_speaker_label,
    participantId,
    speakerDisplayLabel,
    startMs: row.start_ms,
    endMs: row.end_ms,
    durationMs: row.duration_ms,
    assetStartMs: row.asset_start_ms,
    assetEndMs: row.asset_end_ms,
    sourceRecordingSourceId: row.source_recording_source_id,
    sourceRecordingChunkId: row.source_recording_chunk_id,
    sourceSampleStart: toNullableNum(row.source_sample_start),
    sourceSampleEnd: toNullableNum(row.source_sample_end),
    text: row.text,
    language: row.language,
    confidence: toNullableFloat(row.confidence),
    wordCount: row.word_count,
    words,
    alignmentStatus: row.alignment_status,
    alignmentMetadata: row.alignment_metadata ?? {},
    createdAt: toIsoString(row.created_at),
  };
}

export class Phase5TranscriptionService {
  readonly phase4: Phase4BackboneService;
  readonly provider: TranscriptionProvider;

  constructor(options: {
    phase4?: Phase4BackboneService;
    db?: SqlExecutor;
    storage?: StorageProvider;
    provider: TranscriptionProvider;
    onEvent?: ObservabilitySink;
  }) {
    if (options.phase4) {
      this.phase4 = options.phase4;
    } else if (options.db && options.storage) {
      this.phase4 = new Phase4BackboneService({
        db: options.db,
        storage: options.storage,
        onEvent: options.onEvent,
      });
    } else {
      throw new Error('Phase5TranscriptionService requires either phase4 or { db, storage }.');
    }
    this.provider = options.provider;
  }

  get db(): SqlExecutor {
    return this.phase4.db;
  }

  get storage(): StorageProvider {
    return this.phase4.storage;
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

  private async loadAuthorizedMeetingPhase5(
    userId: string,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<DbMeetingPhase5Row> {
    const res = await this.db.query<DbMeetingPhase5Row>(
      `select id,
              workspace_id,
              status,
              processing_status,
              current_transcription_run_id,
              latest_transcription_run_id,
              detected_languages,
              timeline_duration_ms,
              deleted_at,
              purge_status::text as purge_status
         from public.meetings
        where id = $1`,
      [meetingId],
    );
    const meeting = res.rows[0];
    if (!meeting || meeting.deleted_at !== null || meeting.purge_status === 'purged') {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }
    if (clientWorkspaceId && clientWorkspaceId !== meeting.workspace_id) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Meeting does not belong to the supplied workspace.',
      );
    }
    const memberRes = await this.db.query<{ role: string }>(
      `select role::text as role
         from public.workspace_members
        where workspace_id = $1
          and user_id = $2
          and membership_status = 'active'`,
      [meeting.workspace_id, userId],
    );
    if (!memberRes.rows[0]) {
      throw new Phase4ServiceError(
        403,
        'unauthorized',
        'Active workspace membership is required for this operation.',
      );
    }
    return meeting;
  }

  /**
   * Deterministically builds and persists a canonical `transcription_assets` row (and its private object)
   * from a recording's verified chunks without modifying the original chunks.
   */
  async prepareTranscriptionAssetForRecording(
    recordingId: string,
    options: { assetVersion?: number; now?: Date } = {},
  ): Promise<TranscriptionAssetDto> {
    const assetVersion = options.assetVersion ?? 1;
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const recRes = await this.db.query<{
      id: string;
      workspace_id: string;
      meeting_id: string;
      created_by: string;
    }>(
      `select id, workspace_id, meeting_id, created_by
         from public.recordings
        where id = $1`,
      [recordingId],
    );
    const recMeta = recRes.rows[0];
    if (!recMeta) {
      throw new Phase4ServiceError(404, 'not_found', 'Recording was not found.');
    }

    const detail = await this.phase4.getRecording(
      { userId: recMeta.created_by },
      recordingId,
      recMeta.workspace_id,
    );

    if (detail.recording.status !== 'finalized') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Recording must be finalized before preparing a canonical transcription asset.',
      );
    }

    const chunkBytesById = new Map<string, Uint8Array>();
    if (typeof this.storage.getObjectBytes === 'function') {
      for (const chunk of detail.chunks) {
        const bytes = await this.storage.getObjectBytes(chunk.storageKey);
        if (bytes) {
          chunkBytesById.set(chunk.id, bytes);
        }
      }
    }

    const plan = prepareCanonicalTranscriptionAssetPlan({
      recording: detail.recording,
      sources: detail.sources,
      chunks: detail.chunks,
      assetVersion,
      chunkBytesById,
    });

    const assetContentType = plan.preparationMetadata.binary_mux_performed
      ? 'audio/wav'
      : 'application/json';
    if (this.storage instanceof MemoryStorageProvider) {
      this.storage.storeObjectBytes(plan.storageKey, plan.manifestBytes, {
        contentType: assetContentType,
        now,
      });
    } else if (typeof this.storage.putObjectBytes === 'function') {
      await this.storage.putObjectBytes(plan.storageKey, plan.manifestBytes, {
        contentType: assetContentType,
        now,
      });
    }

    const upsertRes = await this.db.query<DbTranscriptionAssetRow>(
      `insert into public.transcription_assets (
        workspace_id, meeting_id, recording_id, asset_version, asset_role,
        status, storage_backend, storage_key, container, codec,
        sample_rate_hz, channels, byte_size, checksum_sha256,
        asset_duration_ms, canonical_duration_ms, active_capture_ms,
        timeline_map, source_lineage, preparation_metadata, prepared_at
      )
      values (
        $1, $2, $3, $4, $5,
        'ready', $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16,
        $17::jsonb, $18::jsonb, $19::jsonb, $20
      )
      on conflict (recording_id, asset_version)
      do update set
        status = 'ready',
        storage_backend = excluded.storage_backend,
        storage_key = excluded.storage_key,
        container = excluded.container,
        codec = excluded.codec,
        sample_rate_hz = excluded.sample_rate_hz,
        channels = excluded.channels,
        byte_size = excluded.byte_size,
        checksum_sha256 = excluded.checksum_sha256,
        asset_duration_ms = excluded.asset_duration_ms,
        canonical_duration_ms = excluded.canonical_duration_ms,
        active_capture_ms = excluded.active_capture_ms,
        timeline_map = excluded.timeline_map,
        source_lineage = excluded.source_lineage,
        preparation_metadata = excluded.preparation_metadata,
        prepared_at = coalesce(public.transcription_assets.prepared_at, excluded.prepared_at)
      returning *`,
      [
        detail.recording.workspaceId,
        detail.recording.meetingId,
        detail.recording.id,
        plan.assetVersion,
        plan.assetRole,
        this.storage.backend,
        plan.storageKey,
        plan.container,
        plan.codec,
        plan.sampleRateHz,
        plan.channels,
        plan.byteSize,
        plan.checksumSha256,
        plan.assetDurationMs,
        plan.canonicalDurationMs,
        plan.activeCaptureMs,
        JSON.stringify(plan.timelineMap),
        JSON.stringify(plan.sourceLineage),
        JSON.stringify(plan.preparationMetadata),
        nowIso,
      ],
    );

    return mapAssetRow(upsertRes.rows[0]!);
  }

  /**
   * Ensures a canonical transcription asset exists and enqueues `transcribe_meeting` idempotently.
   */
  async enqueueTranscribeMeetingJob(params: {
    recordingId: string;
    assetVersion?: number;
    generation?: number;
    now?: Date;
  }): Promise<{ job: ProcessingJobDto; asset: TranscriptionAssetDto; idempotentReused: boolean }> {
    const asset = await this.prepareTranscriptionAssetForRecording(params.recordingId, {
      assetVersion: params.assetVersion ?? 1,
      now: params.now,
    });
    const generation = params.generation ?? 1;
    const nowIso = (params.now ?? new Date()).toISOString();
    const idempotencyKey = buildCanonicalTranscribeJobIdempotencyKey(
      asset.recordingId,
      asset.assetVersion,
      generation,
    );

    const insertRes = await this.db.query<DbJobPhase5Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'transcribe_meeting', $4, $5, 'queued', $6, $7::jsonb)
      on conflict do nothing
      returning *`,
      [
        asset.workspaceId,
        asset.meetingId,
        asset.recordingId,
        generation,
        idempotencyKey,
        nowIso,
        JSON.stringify({
          recording_id: asset.recordingId,
          transcription_asset_id: asset.id,
          asset_version: asset.assetVersion,
        }),
      ],
    );

    let jobRow = insertRes.rows[0];
    let idempotentReused = false;
    if (!jobRow) {
      const existingRes = await this.db.query<DbJobPhase5Row>(
        `select *
           from public.processing_jobs
          where idempotency_key = $1
             or (meeting_id = $2 and recording_id = $3 and job_type = 'transcribe_meeting' and generation = $4)
          order by created_at desc
          limit 1`,
        [idempotencyKey, asset.meetingId, asset.recordingId, generation],
      );
      jobRow = existingRes.rows[0]!;
      idempotentReused = true;
    } else {
      await this.phase4.recordProcessingEvent({
        workspaceId: asset.workspaceId,
        meetingId: asset.meetingId,
        recordingId: asset.recordingId,
        processingJobId: jobRow.id,
        eventType: 'job_created',
        metadata: {
          job_type: 'transcribe_meeting',
          idempotency_key: idempotencyKey,
          generation,
          asset_version: asset.assetVersion,
        },
      });
    }

    return {
      job: mapJobRow(jobRow),
      asset,
      idempotentReused,
    };
  }

  /**
   * Handles duplicate or asynchronous provider callbacks/results idempotently.
   * If the run already has its provider response persisted or is already completed,
   * returns the existing run and `normalize_transcript` job without duplicating state.
   */
  async ingestProviderCallbackResult(params: {
    transcriptionRunId: string;
    result: ProviderTranscriptionResult;
    now?: Date;
  }): Promise<{
    run: TranscriptionRunDto;
    normalizeJob: ProcessingJobDto;
    idempotentReused: boolean;
  }> {
    const parsedResult = providerTranscriptionResultSchema.parse(params.result);
    const nowIso = (params.now ?? new Date()).toISOString();

    const runRes = await this.db.query<DbTranscriptionRunRow>(
      `select * from public.transcription_runs where id = $1`,
      [params.transcriptionRunId],
    );
    const existingRun = runRes.rows[0];
    if (!existingRun) {
      throw new Phase4ServiceError(404, 'not_found', 'Transcription run was not found.');
    }

    let updatedRun = existingRun;
    let idempotentReused = false;

    if (existingRun.status === 'completed' || existingRun.status === 'normalizing') {
      idempotentReused = true;
    } else if (existingRun.status === 'queued' || existingRun.status === 'running') {
      const updRes = await this.db.query<DbTranscriptionRunRow>(
        `update public.transcription_runs
            set status = 'normalizing',
                provider_job_id = coalesce($2, provider_job_id),
                detected_languages = $3::text[],
                raw_provider_response = $4::jsonb,
                provider_completed_at = coalesce(provider_completed_at, $5)
          where id = $1
          returning *`,
        [
          existingRun.id,
          parsedResult.providerJobId,
          parsedResult.detectedLanguages,
          JSON.stringify(parsedResult),
          nowIso,
        ],
      );
      updatedRun = updRes.rows[0]!;
    } else {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        `Cannot ingest provider callback for transcription run in status "${existingRun.status}".`,
      );
    }

    const normGeneration = updatedRun.run_number;
    const normKey = buildCanonicalNormalizeJobIdempotencyKey(
      updatedRun.id,
      updatedRun.normalization_version,
      normGeneration,
    );
    const insertNormRes = await this.db.query<DbJobPhase5Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'normalize_transcript', $4, $5, 'queued', $6, $7::jsonb)
      on conflict do nothing
      returning *`,
      [
        updatedRun.workspace_id,
        updatedRun.meeting_id,
        updatedRun.recording_id,
        normGeneration,
        normKey,
        nowIso,
        JSON.stringify({
          transcription_run_id: updatedRun.id,
          transcription_asset_id: updatedRun.transcription_asset_id,
          normalization_version: updatedRun.normalization_version,
        }),
      ],
    );

    let normJobRow = insertNormRes.rows[0];
    if (!normJobRow) {
      const existingNormRes = await this.db.query<DbJobPhase5Row>(
        `select *
           from public.processing_jobs
          where idempotency_key = $1
             or (meeting_id = $2 and recording_id = $3 and job_type = 'normalize_transcript' and generation = $4)
          order by created_at desc
          limit 1`,
        [normKey, updatedRun.meeting_id, updatedRun.recording_id, normGeneration],
      );
      normJobRow = existingNormRes.rows[0]!;
      idempotentReused = true;
    }

    return {
      run: mapRunRow(updatedRun),
      normalizeJob: mapJobRow(normJobRow),
      idempotentReused,
    };
  }

  /**
   * `GET /api/v1/meetings/{meetingId}/transcription`
   */
  async getMeetingTranscriptionStatus(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<MeetingTranscriptionStatusResponse> {
    const auth = this.requireAuth(authInput);
    const meeting = await this.loadAuthorizedMeetingPhase5(
      auth.userId,
      meetingId,
      clientWorkspaceId,
    );
    const processing = await this.phase4.getMeetingProcessing(
      auth,
      meetingId,
      meeting.workspace_id,
    );

    const [assetsRes, runsRes, participantsRes] = await Promise.all([
      this.db.query<DbTranscriptionAssetRow>(
        `select *
           from public.transcription_assets
          where meeting_id = $1
            and workspace_id = $2
          order by asset_version desc, created_at desc`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbTranscriptionRunRow>(
        `select *
           from public.transcription_runs
          where meeting_id = $1
            and workspace_id = $2
          order by run_number desc, created_at desc`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbMeetingParticipantRow>(
        `select *
           from public.meeting_participants
          where meeting_id = $1
            and workspace_id = $2
          order by sort_order asc, created_at asc`,
        [meeting.id, meeting.workspace_id],
      ),
    ]);

    const activeRunId =
      meeting.current_transcription_run_id ??
      meeting.latest_transcription_run_id ??
      runsRes.rows[0]?.id ??
      null;

    const speakersRes = activeRunId
      ? await this.db.query<DbMeetingSpeakerRow>(
          `select *
             from public.meeting_speakers
            where meeting_id = $1
              and workspace_id = $2
              and transcription_run_id = $3
            order by provider_speaker_label asc`,
          [meeting.id, meeting.workspace_id, activeRunId],
        )
      : { rows: [] as DbMeetingSpeakerRow[] };

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      meetingStatus: meeting.status,
      pipelineStatus: meeting.processing_status,
      productState: processing.productState,
      activeRecordingId: processing.activeRecordingId,
      currentTranscriptionRunId: meeting.current_transcription_run_id,
      latestTranscriptionRunId: meeting.latest_transcription_run_id,
      currentAsset: assetsRes.rows[0] ? mapAssetRow(assetsRes.rows[0]) : null,
      runs: runsRes.rows.map(mapRunRow),
      speakers: speakersRes.rows.map(mapSpeakerRow),
      participants: participantsRes.rows.map(mapParticipantRow),
      jobs: processing.jobs,
    };
  }

  /**
   * `GET /api/v1/meetings/{meetingId}/transcript`
   */
  async getMeetingTranscript(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    options: {
      clientWorkspaceId?: string;
      speaker?: string;
      query?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<GetMeetingTranscriptResponse> {
    const auth = this.requireAuth(authInput);
    const meeting = await this.loadAuthorizedMeetingPhase5(
      auth.userId,
      meetingId,
      options.clientWorkspaceId,
    );

    const currentRunId = meeting.current_transcription_run_id;
    if (!currentRunId) {
      return {
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        currentTranscriptionRun: null,
        totalSegments: 0,
        totalDurationMs: meeting.timeline_duration_ms ?? 0,
        wordCount: 0,
        detectedLanguages: meeting.detected_languages ?? [],
        speakers: [],
        participants: [],
        segments: [],
        quarantinedSegmentCount: 0,
      };
    }

    const [runRes, speakersRes, participantsRes, segmentsRes] = await Promise.all([
      this.db.query<DbTranscriptionRunRow>(
        `select *
           from public.transcription_runs
          where id = $1
            and meeting_id = $2
            and workspace_id = $3`,
        [currentRunId, meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbMeetingSpeakerRow>(
        `select *
           from public.meeting_speakers
          where meeting_id = $1
            and workspace_id = $2
            and transcription_run_id = $3
          order by provider_speaker_label asc`,
        [meeting.id, meeting.workspace_id, currentRunId],
      ),
      this.db.query<DbMeetingParticipantRow>(
        `select *
           from public.meeting_participants
          where meeting_id = $1
            and workspace_id = $2
          order by sort_order asc, created_at asc`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbTranscriptSegmentRow>(
        `select *
           from public.transcript_segments
          where meeting_id = $1
            and workspace_id = $2
            and transcription_run_id = $3
            and alignment_status = 'canonical'
          order by sequence_no asc`,
        [meeting.id, meeting.workspace_id, currentRunId],
      ),
    ]);

    const runRow = runRes.rows[0] ?? null;
    const speakerMap = new Map(speakersRes.rows.map((s) => [s.id, s]));
    const participantMap = new Map(participantsRes.rows.map((p) => [p.id, p]));

    const allCanonicalSegments = segmentsRes.rows.map((seg) =>
      mapSegmentRow(seg, speakerMap, participantMap),
    );

    let filtered = allCanonicalSegments;
    const speakerFilter = options.speaker?.trim();
    if (speakerFilter) {
      filtered = filtered.filter(
        (seg) =>
          seg.providerSpeakerLabel === speakerFilter ||
          seg.participantId === speakerFilter ||
          seg.speakerId === speakerFilter,
      );
    }

    const searchQuery = options.query?.trim().toLowerCase();
    if (searchQuery) {
      filtered = filtered.filter((seg) => seg.text.toLowerCase().includes(searchQuery));
    }

    const offset = Math.max(0, options.offset ?? 0);
    const limit =
      options.limit !== undefined ? Math.max(1, Math.min(options.limit, 500)) : filtered.length;
    const windowed = filtered.slice(offset, offset + limit);

    const lastEndMs = allCanonicalSegments.at(-1)?.endMs ?? 0;
    const totalDurationMs = Math.max(meeting.timeline_duration_ms ?? 0, lastEndMs);
    const totalWordCount = allCanonicalSegments.reduce((sum, s) => sum + s.wordCount, 0);

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      currentTranscriptionRun: runRow ? mapRunRow(runRow) : null,
      totalSegments: filtered.length,
      totalDurationMs,
      wordCount: totalWordCount,
      detectedLanguages: runRow?.detected_languages ?? meeting.detected_languages ?? [],
      speakers: speakersRes.rows.map(mapSpeakerRow),
      participants: participantsRes.rows.map(mapParticipantRow),
      segments: windowed,
      quarantinedSegmentCount: runRow?.quarantined_segment_count ?? 0,
    };
  }

  /**
   * `POST /api/v1/meetings/{meetingId}/speakers`
   *
   * Persists speaker -> participant mappings on `meeting_speakers` (and `meeting_participants` where needed)
   * without rewriting any transcript segment text.
   */
  async updateSpeakerMappings(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    rawInput: UpdateSpeakerMappingsRequestInput,
    options: { now?: Date } = {},
  ): Promise<UpdateSpeakerMappingsResponse> {
    const auth = this.requireAuth(authInput);
    const parsed = updateSpeakerMappingsRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid speaker mapping request.',
      );
    }
    const input = parsed.data;
    const meeting = await this.loadAuthorizedMeetingPhase5(
      auth.userId,
      meetingId,
      input.workspaceId,
    );

    const activeRunId = meeting.current_transcription_run_id ?? meeting.latest_transcription_run_id;
    if (!activeRunId) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Meeting does not have a transcription run to map speakers against.',
      );
    }

    const nowIso = (options.now ?? new Date()).toISOString();

    // 1. Ensure any explicitly supplied participants exist in `meeting_participants`
    if (input.participants && input.participants.length > 0) {
      for (let i = 0; i < input.participants.length; i++) {
        const pInput = input.participants[i]!;
        if (pInput.participantId) {
          await this.db.query(
            `insert into public.meeting_participants (
              id, workspace_id, meeting_id, user_id, display_name, role_label, email, is_external, sort_order
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            on conflict (id) do update set
              display_name = excluded.display_name,
              role_label = coalesce(excluded.role_label, public.meeting_participants.role_label),
              email = coalesce(excluded.email, public.meeting_participants.email)`,
            [
              pInput.participantId,
              meeting.workspace_id,
              meeting.id,
              pInput.userId ?? null,
              pInput.displayName,
              pInput.roleLabel ?? null,
              pInput.email ?? null,
              pInput.isExternal,
              i,
            ],
          );
        } else if (pInput.userId) {
          await this.db.query(
            `insert into public.meeting_participants (
              workspace_id, meeting_id, user_id, display_name, role_label, email, is_external, sort_order
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            on conflict (meeting_id, user_id) where user_id is not null
            do update set
              display_name = excluded.display_name,
              role_label = coalesce(excluded.role_label, public.meeting_participants.role_label)`,
            [
              meeting.workspace_id,
              meeting.id,
              pInput.userId,
              pInput.displayName,
              pInput.roleLabel ?? null,
              pInput.email ?? null,
              pInput.isExternal,
              i,
            ],
          );
        } else {
          await this.db.query(
            `insert into public.meeting_participants (
              workspace_id, meeting_id, display_name, role_label, email, is_external, sort_order
            )
            values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              meeting.workspace_id,
              meeting.id,
              pInput.displayName,
              pInput.roleLabel ?? null,
              pInput.email ?? null,
              pInput.isExternal,
              i,
            ],
          );
        }
      }
    }

    // 2. Apply speaker mappings for each entry without touching `transcript_segments.text`
    for (const mapping of input.mappings) {
      const speakerRes = await this.db.query<DbMeetingSpeakerRow>(
        `select *
           from public.meeting_speakers
          where meeting_id = $1
            and workspace_id = $2
            and transcription_run_id = $3
            and provider_speaker_label = $4`,
        [meeting.id, meeting.workspace_id, activeRunId, mapping.speakerLabel],
      );
      const speaker = speakerRes.rows[0];
      if (!speaker) {
        throw new Phase4ServiceError(
          404,
          'not_found',
          `Speaker "${mapping.speakerLabel}" was not found on this meeting's transcription run.`,
        );
      }

      let resolvedParticipantId: string | null = null;
      let resolvedDisplayLabel =
        mapping.displayName?.trim() || defaultSpeakerDisplayLabel(mapping.speakerLabel);

      if (mapping.participantId || mapping.userId) {
        const candidateId = mapping.participantId ?? mapping.userId!;
        // Check if `candidateId` is already a `meeting_participants` row in this meeting
        const existingPartRes = await this.db.query<DbMeetingParticipantRow>(
          `select *
             from public.meeting_participants
            where meeting_id = $1
              and workspace_id = $2
              and (id::text = $3 or user_id::text = $3)
            limit 1`,
          [meeting.id, meeting.workspace_id, candidateId],
        );

        let participantRow = existingPartRes.rows[0];
        if (!participantRow) {
          // Check if `candidateId` is an active workspace member in `workspace_members`
          const memberRes = await this.db.query<{
            user_id: string;
            role: string;
            display_name: string | null;
          }>(
            `select wm.user_id,
                    wm.role::text as role,
                    p.display_name
               from public.workspace_members wm
               left join public.profiles p on p.id = wm.user_id
              where wm.workspace_id = $1
                and wm.user_id::text = $2
                and wm.membership_status = 'active'`,
            [meeting.workspace_id, candidateId],
          );
          const wsMember = memberRes.rows[0];

          if (wsMember) {
            const nameToUse =
              mapping.displayName?.trim() || wsMember.display_name?.trim() || 'Workspace Member';
            const roleToUse = mapping.roleLabel ?? wsMember.role;
            const createdPartRes = await this.db.query<DbMeetingParticipantRow>(
              `insert into public.meeting_participants (
                workspace_id, meeting_id, user_id, display_name, role_label, email, is_external
              )
              values ($1, $2, $3, $4, $5, null, false)
              on conflict (meeting_id, user_id) where user_id is not null
              do update set
                display_name = excluded.display_name,
                role_label = coalesce(excluded.role_label, public.meeting_participants.role_label)
              returning *`,
              [meeting.workspace_id, meeting.id, wsMember.user_id, nameToUse, roleToUse],
            );
            participantRow = createdPartRes.rows[0];
          } else if (mapping.displayName?.trim()) {
            // Create a meeting participant with the supplied `participantId`
            const createdPartRes = await this.db.query<DbMeetingParticipantRow>(
              `insert into public.meeting_participants (
                id, workspace_id, meeting_id, display_name, role_label, is_external
              )
              values ($1, $2, $3, $4, $5, $6)
              on conflict (id) do update set
                display_name = excluded.display_name,
                role_label = coalesce(excluded.role_label, public.meeting_participants.role_label)
              returning *`,
              [
                candidateId,
                meeting.workspace_id,
                meeting.id,
                mapping.displayName.trim(),
                mapping.roleLabel ?? null,
                mapping.isExternal ?? false,
              ],
            );
            participantRow = createdPartRes.rows[0];
          } else {
            throw new Phase4ServiceError(
              404,
              'not_found',
              `Participant "${candidateId}" was not found in this workspace or meeting.`,
            );
          }
        } else if (mapping.displayName?.trim() || mapping.roleLabel !== undefined) {
          const updatedPartRes = await this.db.query<DbMeetingParticipantRow>(
            `update public.meeting_participants
                set display_name = coalesce($2, display_name),
                    role_label = coalesce($3, role_label)
              where id = $1
              returning *`,
            [participantRow.id, mapping.displayName?.trim() ?? null, mapping.roleLabel ?? null],
          );
          participantRow = updatedPartRes.rows[0] ?? participantRow;
        }

        resolvedParticipantId = participantRow!.id;
        resolvedDisplayLabel = participantRow!.display_name;
      } else if (
        mapping.displayName?.trim() &&
        mapping.displayName.trim() !== defaultSpeakerDisplayLabel(mapping.speakerLabel)
      ) {
        // Custom participant name supplied without an existing participantId (e.g. external participant typed in UI)
        const existingByNameRes = await this.db.query<DbMeetingParticipantRow>(
          `select *
             from public.meeting_participants
            where meeting_id = $1
              and workspace_id = $2
              and lower(display_name) = lower($3)
            limit 1`,
          [meeting.id, meeting.workspace_id, mapping.displayName.trim()],
        );
        let participantRow = existingByNameRes.rows[0];
        if (!participantRow) {
          const createdPartRes = await this.db.query<DbMeetingParticipantRow>(
            `insert into public.meeting_participants (
              workspace_id, meeting_id, display_name, role_label, is_external
            )
            values ($1, $2, $3, $4, $5)
            returning *`,
            [
              meeting.workspace_id,
              meeting.id,
              mapping.displayName.trim(),
              mapping.roleLabel ?? null,
              mapping.isExternal ?? true,
            ],
          );
          participantRow = createdPartRes.rows[0]!;
        } else if (mapping.roleLabel !== undefined) {
          const updPartRes = await this.db.query<DbMeetingParticipantRow>(
            `update public.meeting_participants
                set role_label = coalesce($2, role_label)
              where id = $1
              returning *`,
            [participantRow.id, mapping.roleLabel],
          );
          participantRow = updPartRes.rows[0] ?? participantRow;
        }
        resolvedParticipantId = participantRow.id;
        resolvedDisplayLabel = participantRow.display_name;
      }

      await this.db.query(
        `update public.meeting_speakers
            set participant_id = $2,
                display_label = $3,
                mapped_by = $4,
                mapped_at = $5
          where id = $1`,
        [
          speaker.id,
          resolvedParticipantId,
          resolvedDisplayLabel,
          resolvedParticipantId ? auth.userId : null,
          resolvedParticipantId ? nowIso : null,
        ],
      );
    }

    await this.phase4.recordProcessingEvent({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      eventType: 'speaker_mapping_updated',
      actorId: auth.userId,
      metadata: {
        transcription_run_id: activeRunId,
        mapping_count: input.mappings.length,
      },
    });

    const [participantsRes, speakersRes] = await Promise.all([
      this.db.query<DbMeetingParticipantRow>(
        `select *
           from public.meeting_participants
          where meeting_id = $1
            and workspace_id = $2
          order by sort_order asc, created_at asc`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbMeetingSpeakerRow>(
        `select *
           from public.meeting_speakers
          where meeting_id = $1
            and workspace_id = $2
            and transcription_run_id = $3
          order by provider_speaker_label asc`,
        [meeting.id, meeting.workspace_id, activeRunId],
      ),
    ]);

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      transcriptionRunId: activeRunId,
      participants: participantsRes.rows.map(mapParticipantRow),
      speakers: speakersRes.rows.map(mapSpeakerRow),
    };
  }

  /**
   * `POST /api/v1/meetings/{meetingId}/transcription/retry`
   *
   * Retries transcription for an authorized workspace member when transcription failed
   * or is waiting in `ready_for_transcription`, preserving verified recording chunks and
   * keeping all historical `transcription_runs` rows intact.
   */
  async retryTranscription(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    rawInput: RetryTranscriptionRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<RetryTranscriptionResponse> {
    const auth = this.requireAuth(authInput);
    const parsed = retryTranscriptionRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid transcription retry request.',
      );
    }
    const input = parsed.data;
    const meeting = await this.loadAuthorizedMeetingPhase5(
      auth.userId,
      meetingId,
      input.workspaceId,
    );

    const recRes = await this.db.query<{ id: string; status: string }>(
      `select id, status::text as status
         from public.recordings
        where meeting_id = $1
          and workspace_id = $2
          and deleted_at is null
          and status = 'finalized'
        order by created_at desc
        limit 1`,
      [meeting.id, meeting.workspace_id],
    );
    const recording = recRes.rows[0];
    if (!recording) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot retry transcription: meeting does not have a finalized verified recording.',
      );
    }

    // Check if there is already an active (queued or running) transcription job
    const activeJobRes = await this.db.query<DbJobPhase5Row>(
      `select *
         from public.processing_jobs
        where meeting_id = $1
          and workspace_id = $2
          and recording_id = $3
          and job_type in ('transcribe_meeting', 'normalize_transcript', 'finalize_transcript')
          and status in ('queued', 'running')
        order by created_at desc
        limit 1`,
      [meeting.id, meeting.workspace_id, recording.id],
    );
    if (activeJobRes.rows[0]) {
      return {
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        recordingId: recording.id,
        job: mapJobRow(activeJobRes.rows[0]),
        idempotentReused: true,
      };
    }

    const maxGenRes = await this.db.query<{ max_gen: number | null }>(
      `select max(generation) as max_gen
         from public.processing_jobs
        where recording_id = $1
          and job_type = 'transcribe_meeting'`,
      [recording.id],
    );
    const nextGeneration = (maxGenRes.rows[0]?.max_gen ?? 0) + 1;

    const { job, idempotentReused } = await this.enqueueTranscribeMeetingJob({
      recordingId: recording.id,
      assetVersion: 1,
      generation: nextGeneration,
      now: options.now,
    });

    await this.db.query(
      `update public.meetings
          set status = 'transcribing',
              processing_status = 'transcribing'
        where id = $1
          and workspace_id = $2`,
      [meeting.id, meeting.workspace_id],
    );

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: recording.id,
      job,
      idempotentReused,
    };
  }
}

export type ExecutePhase5JobOptions = {
  now?: Date;
  /**
   * Optional test hook invoked after the provider returns (and `raw_provider_response` is persisted)
   * but before the worker commits `transcribe_meeting` completion. Used to test worker crash recovery
   * and stale worker fencing.
   */
  afterProviderResponseHook?: (context: {
    job: ProcessingJobDto;
    transcriptionRunId: string;
  }) => Promise<void>;
};

/**
 * Durable Phase 5 worker executing:
 * `prepare_recording -> transcribe_meeting -> normalize_transcript -> finalize_transcript`
 * using the PostgreSQL `claim_next_processing_job` lease + fencing token discipline.
 */
export class Phase5TranscriptionWorker {
  readonly service: Phase5TranscriptionService;
  readonly phase4Worker: Phase4RecordingWorker;

  constructor(service: Phase5TranscriptionService) {
    this.service = service;
    this.phase4Worker = new Phase4RecordingWorker(service.phase4);
  }

  private get db(): SqlExecutor {
    return this.service.db;
  }

  async claimNextJob(
    workerId: string,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    return this.phase4Worker.claimNextJob(workerId, options);
  }

  async heartbeatJob(
    workerId: string,
    jobId: string,
    fencingToken: number,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto> {
    return this.phase4Worker.heartbeatJob(workerId, jobId, fencingToken, options);
  }

  private async assertActiveJobLease(
    workerId: string,
    jobId: string,
    fencingToken: number,
    nowIso: string,
  ): Promise<DbJobPhase5Row> {
    const res = await this.db.query<DbJobPhase5Row>(
      `select *
         from public.processing_jobs
        where id = $1
          and status = 'running'
          and lease_owner = $2
          and fencing_token = $3
          and lease_expires_at > $4`,
      [jobId, workerId, fencingToken, nowIso],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Phase4ServiceError(
        409,
        'stale_fencing_token',
        'Stale worker fencing token or expired lease cannot mutate transcription pipeline state.',
      );
    }
    return row;
  }

  async runNextJob(
    workerId: string,
    options: ClaimJobOptions & ExecutePhase5JobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    const job = await this.claimNextJob(workerId, options);
    if (!job) return null;
    return this.executeClaimedJob(workerId, job, options);
  }

  async runUntilIdle(
    workerId: string,
    options: ClaimJobOptions & ExecutePhase5JobOptions & { maxJobs?: number } = {},
  ): Promise<ProcessingJobDto[]> {
    const executed: ProcessingJobDto[] = [];
    const maxJobs = options.maxJobs ?? 25;
    for (let i = 0; i < maxJobs; i++) {
      const result = await this.runNextJob(workerId, options);
      if (!result) break;
      executed.push(result);
    }
    return executed;
  }

  async executeClaimedJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase5JobOptions = {},
  ): Promise<ProcessingJobDto> {
    switch (job.jobType) {
      case 'prepare_recording':
      case 'assemble_recording':
        return this.executeClaimedPrepareRecordingJob(workerId, job, options);
      case 'transcribe_meeting':
        return this.executeClaimedTranscribeMeetingJob(workerId, job, options);
      case 'normalize_transcript':
        return this.executeClaimedNormalizeTranscriptJob(workerId, job, options);
      case 'finalize_transcript':
        return this.executeClaimedFinalizeTranscriptJob(workerId, job, options);
      default:
        return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
          code: 'unsupported_job_type',
          message: `Unsupported job type "${String(job.jobType)}".`,
          retryable: false,
          now: options.now,
        });
    }
  }

  /**
   * Stage 1: `prepare_recording`
   * Validates verified chunks, prepares canonical transcription asset & piecewise timeline map,
   * completes `prepare_recording`, and enqueues `transcribe_meeting` idempotently.
   */
  async executeClaimedPrepareRecordingJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase5JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const completedPrepare = await this.phase4Worker.executeClaimedPrepareRecordingJob(
      workerId,
      job,
      { now: options.now },
    );

    if (completedPrepare.status !== 'succeeded') {
      return completedPrepare;
    }

    const asset = await this.service.prepareTranscriptionAssetForRecording(job.recordingId, {
      assetVersion: 1,
      now: options.now,
    });

    await this.service.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'transcription_asset_prepared',
      fencingToken: job.fencingToken,
      metadata: {
        transcription_asset_id: asset.id,
        asset_version: asset.assetVersion,
        asset_duration_ms: asset.assetDurationMs,
        canonical_duration_ms: asset.canonicalDurationMs,
        piece_count: asset.timelineMap.length,
      },
    });

    await this.service.enqueueTranscribeMeetingJob({
      recordingId: job.recordingId,
      assetVersion: asset.assetVersion,
      generation: job.generation,
      now: options.now,
    });

    return completedPrepare;
  }

  /**
   * Stage 2: `transcribe_meeting`
   * Creates or resumes a `transcription_runs` record, invokes `TranscriptionProvider`,
   * stores normalized provider output, and enqueues `normalize_transcript`.
   */
  async executeClaimedTranscribeMeetingJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase5JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const assetVersion =
      typeof job.payload.asset_version === 'number' ? job.payload.asset_version : 1;
    const asset = await this.service.prepareTranscriptionAssetForRecording(job.recordingId, {
      assetVersion,
      now,
    });

    // Check if an earlier attempt of this job already persisted a provider response (crash-after-provider recovery!)
    const existingRunsRes = await this.db.query<DbTranscriptionRunRow>(
      `select *
         from public.transcription_runs
        where recording_id = $1
          and workspace_id = $2
        order by run_number desc`,
      [job.recordingId, job.workspaceId],
    );

    const recoverableRun = existingRunsRes.rows.find(
      (r) =>
        (r.status === 'normalizing' || r.status === 'completed') &&
        r.raw_provider_response &&
        Object.keys(r.raw_provider_response).length > 0 &&
        r.provider_summary_metadata?.transcribe_job_id === job.id,
    );

    if (recoverableRun) {
      await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);
      const normGen = recoverableRun.run_number;
      const normKey = buildCanonicalNormalizeJobIdempotencyKey(
        recoverableRun.id,
        recoverableRun.normalization_version,
        normGen,
      );
      await this.db.query(
        `insert into public.processing_jobs (
          workspace_id, meeting_id, recording_id, job_type, generation,
          idempotency_key, status, scheduled_at, payload
        )
        values ($1, $2, $3, 'normalize_transcript', $4, $5, 'queued', $6, $7::jsonb)
        on conflict do nothing`,
        [
          job.workspaceId,
          job.meetingId,
          job.recordingId,
          normGen,
          normKey,
          nowIso,
          JSON.stringify({
            transcription_run_id: recoverableRun.id,
            transcription_asset_id: asset.id,
            normalization_version: recoverableRun.normalization_version,
          }),
        ],
      );

      return this.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          stage: 'transcribe_meeting',
          transcription_run_id: recoverableRun.id,
          recovered_after_provider_response: true,
        },
        { now },
      );
    }

    // Create a new `transcription_runs` row with incremented `run_number` so historical runs are never overwritten
    const nextRunNumber = (existingRunsRes.rows[0]?.run_number ?? 0) + 1;
    const insertRunRes = await this.db.query<DbTranscriptionRunRow>(
      `insert into public.transcription_runs (
        workspace_id, meeting_id, recording_id, transcription_asset_id, asset_version,
        run_number, provider, provider_model, status, normalization_version,
        requested_languages, diarization_enabled, started_at, provider_summary_metadata
      )
      values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, 'running', 1,
        array['uz', 'ru', 'en'], true, $9, $10::jsonb
      )
      returning *`,
      [
        job.workspaceId,
        job.meetingId,
        job.recordingId,
        asset.id,
        asset.assetVersion,
        nextRunNumber,
        this.service.provider.providerName,
        this.service.provider.defaultModel,
        nowIso,
        JSON.stringify({
          transcribe_job_id: job.id,
          transcribe_job_attempt: job.attempt,
          transcribe_job_generation: job.generation,
        }),
      ],
    );
    const runRow = insertRunRes.rows[0]!;

    await this.db.query(
      `update public.meetings
          set latest_transcription_run_id = $3,
              status = 'transcribing',
              processing_status = 'transcribing'
        where id = $1
          and workspace_id = $2`,
      [job.meetingId, job.workspaceId, runRow.id],
    );

    await this.service.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'transcription_started',
      fencingToken: job.fencingToken,
      metadata: {
        transcription_run_id: runRow.id,
        run_number: runRow.run_number,
        provider: runRow.provider,
        provider_model: runRow.provider_model,
      },
    });

    let signedReadUrl: string | undefined;
    try {
      const readAuth = await this.service.storage.createReadAuthorization({
        storageKey: asset.storageKey,
        expiresInSeconds: 300,
        now,
      });
      signedReadUrl = readAuth.readUrl;
    } catch {
      signedReadUrl = undefined;
    }

    let providerResult: ProviderTranscriptionResult;
    try {
      providerResult = await this.service.provider.transcribe({
        assetId: asset.id,
        workspaceId: asset.workspaceId,
        meetingId: asset.meetingId,
        recordingId: asset.recordingId,
        assetVersion: asset.assetVersion,
        storageKey: asset.storageKey,
        signedAudioUrl: signedReadUrl,
        assetDurationMs: asset.assetDurationMs,
        sampleRateHz: asset.sampleRateHz,
        channels: asset.channels,
        timelineMap: asset.timelineMap,
        requestedLanguages: ['uz', 'ru', 'en'],
      });
    } catch (cause) {
      const errCode =
        cause instanceof TranscriptionProviderError ? cause.code : 'provider_transcription_failed';
      const errMsg = cause instanceof Error ? cause.message : String(cause);
      const retryable = cause instanceof TranscriptionProviderError ? cause.retryable : false;

      // Verify lease before mutating state; if lease was lost, throw stale_fencing_token
      await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

      await this.db.query(
        `update public.transcription_runs
            set status = 'failed',
                completed_at = $2,
                error_code = $3,
                error_message = $4,
                failure_metadata = $5::jsonb
          where id = $1`,
        [
          runRow.id,
          nowIso,
          errCode.slice(0, 80),
          errMsg.slice(0, 500),
          JSON.stringify(
            redactObservabilityMetadata({
              attempt: job.attempt,
              retryable,
            }),
          ),
        ],
      );

      await this.service.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: job.id,
        eventType: 'transcription_failed',
        fencingToken: job.fencingToken,
        metadata: {
          transcription_run_id: runRow.id,
          run_number: runRow.run_number,
          error_code: errCode,
          retryable,
        },
      });

      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: errCode,
        message: errMsg,
        retryable,
        now,
      });
    }

    // Verify worker still owns lease before persisting provider response
    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    await this.db.query(
      `update public.transcription_runs
          set status = 'normalizing',
              provider_job_id = $2,
              detected_languages = $3::text[],
              raw_provider_response = $4::jsonb,
              provider_completed_at = $5
        where id = $1`,
      [
        runRow.id,
        providerResult.providerJobId,
        providerResult.detectedLanguages,
        JSON.stringify(providerResult),
        nowIso,
      ],
    );

    if (options.afterProviderResponseHook) {
      await options.afterProviderResponseHook({
        job,
        transcriptionRunId: runRow.id,
      });
    }

    // Re-verify lease after optional hook so a stale worker that lost its lease after receiving
    // the provider response cannot enqueue or complete!
    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const normGen = runRow.run_number;
    const normKey = buildCanonicalNormalizeJobIdempotencyKey(
      runRow.id,
      runRow.normalization_version,
      normGen,
    );
    const normRes = await this.db.query<DbJobPhase5Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'normalize_transcript', $4, $5, 'queued', $6, $7::jsonb)
      on conflict do nothing
      returning *`,
      [
        job.workspaceId,
        job.meetingId,
        job.recordingId,
        normGen,
        normKey,
        nowIso,
        JSON.stringify({
          transcription_run_id: runRow.id,
          transcription_asset_id: asset.id,
          normalization_version: runRow.normalization_version,
        }),
      ],
    );

    if (normRes.rows[0]) {
      await this.service.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: normRes.rows[0].id,
        eventType: 'job_created',
        fencingToken: job.fencingToken,
        metadata: {
          job_type: 'normalize_transcript',
          transcription_run_id: runRow.id,
        },
      });
    }

    await this.service.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'transcription_completed',
      fencingToken: job.fencingToken,
      metadata: {
        transcription_run_id: runRow.id,
        run_number: runRow.run_number,
        provider_job_id: providerResult.providerJobId,
        raw_segment_count: providerResult.segments.length,
      },
    });

    return this.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        stage: 'transcribe_meeting',
        transcription_run_id: runRow.id,
        run_number: runRow.run_number,
        raw_segment_count: providerResult.segments.length,
      },
      { now },
    );
  }

  /**
   * Stage 3: `normalize_transcript`
   * Maps provider-local timestamps through the persisted `timeline_map` onto canonical meeting time,
   * quarantines invalid/out-of-range/discontinuity-spanning segments, persists `meeting_speakers`
   * and `transcript_segments` idempotently, and enqueues `finalize_transcript`.
   */
  async executeClaimedNormalizeTranscriptJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase5JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const runId =
      typeof job.payload.transcription_run_id === 'string' ? job.payload.transcription_run_id : '';
    if (!runId) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'missing_transcription_run_id',
        message: 'normalize_transcript job payload is missing transcription_run_id.',
        retryable: false,
        now,
      });
    }

    const runRes = await this.db.query<DbTranscriptionRunRow>(
      `select * from public.transcription_runs where id = $1 and workspace_id = $2`,
      [runId, job.workspaceId],
    );
    const run = runRes.rows[0];
    if (!run) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'transcription_run_not_found',
        message: `Transcription run ${runId} was not found.`,
        retryable: false,
        now,
      });
    }

    // If this run is already completed, ensure finalize_transcript is queued and complete idempotently
    if (run.status === 'completed') {
      const finGen = run.run_number;
      const finKey = buildCanonicalFinalizeTranscriptJobIdempotencyKey(run.id, finGen);
      await this.db.query(
        `insert into public.processing_jobs (
          workspace_id, meeting_id, recording_id, job_type, generation,
          idempotency_key, status, scheduled_at, payload
        )
        values ($1, $2, $3, 'finalize_transcript', $4, $5, 'queued', $6, $7::jsonb)
        on conflict do nothing`,
        [
          job.workspaceId,
          job.meetingId,
          job.recordingId,
          finGen,
          finKey,
          nowIso,
          JSON.stringify({ transcription_run_id: run.id }),
        ],
      );
      return this.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          stage: 'normalize_transcript',
          transcription_run_id: run.id,
          idempotent_already_completed: true,
        },
        { now },
      );
    }

    const assetRes = await this.db.query<DbTranscriptionAssetRow>(
      `select * from public.transcription_assets where id = $1 and workspace_id = $2`,
      [run.transcription_asset_id, job.workspaceId],
    );
    const assetRow = assetRes.rows[0];
    if (!assetRow) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'transcription_asset_not_found',
        message: `Transcription asset ${run.transcription_asset_id} was not found.`,
        retryable: false,
        now,
      });
    }
    const asset = mapAssetRow(assetRow);

    const parsedProviderResult = providerTranscriptionResultSchema.safeParse(
      run.raw_provider_response,
    );
    if (!parsedProviderResult.success) {
      await this.db.query(
        `update public.transcription_runs
            set status = 'failed',
                completed_at = $2,
                error_code = 'provider_invalid_response',
                error_message = $3
          where id = $1`,
        [
          run.id,
          nowIso,
          parsedProviderResult.error.issues[0]?.message ?? 'Invalid stored provider response.',
        ],
      );
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'provider_invalid_response',
        message:
          parsedProviderResult.error.issues[0]?.message ?? 'Invalid stored provider response.',
        retryable: false,
        now,
      });
    }

    const alignmentOutcome = alignProviderTranscriptToCanonicalTimeline({
      segments: parsedProviderResult.data.segments,
      assetDurationMs: asset.assetDurationMs,
      timelineMap: asset.timelineMap,
    });

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    if (alignmentOutcome.canonicalSegments.length === 0) {
      const failDetail =
        alignmentOutcome.quarantinedSegments[0]?.detail ??
        'No valid canonical transcript segments could be aligned onto the meeting timeline.';
      await this.db.query(
        `update public.transcription_runs
            set status = 'failed',
                completed_at = $2,
                quarantined_segment_count = $3,
                error_code = 'timestamp_alignment_failed',
                error_message = $4,
                failure_metadata = $5::jsonb
          where id = $1`,
        [
          run.id,
          nowIso,
          alignmentOutcome.quarantinedSegments.length,
          failDetail.slice(0, 500),
          JSON.stringify({
            quarantined_segments: alignmentOutcome.quarantinedSegments,
          }),
        ],
      );

      await this.service.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: job.id,
        eventType: 'transcription_failed',
        fencingToken: job.fencingToken,
        metadata: {
          transcription_run_id: run.id,
          error_code: 'timestamp_alignment_failed',
          quarantined_segment_count: alignmentOutcome.quarantinedSegments.length,
        },
      });

      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'timestamp_alignment_failed',
        message: failDetail,
        retryable: false,
        now,
      });
    }

    // Load any prior speaker mappings from previous runs of this meeting so participant assignments carry forward
    const priorSpeakersRes = await this.db.query<DbMeetingSpeakerRow>(
      `select *
         from public.meeting_speakers
        where meeting_id = $1
          and workspace_id = $2
          and transcription_run_id <> $3
          and participant_id is not null
        order by updated_at desc`,
      [job.meetingId, job.workspaceId, run.id],
    );
    const priorByLabel = new Map<string, DbMeetingSpeakerRow>();
    for (const ps of priorSpeakersRes.rows) {
      if (!priorByLabel.has(ps.provider_speaker_label)) {
        priorByLabel.set(ps.provider_speaker_label, ps);
      }
    }

    // Group canonical segments by `providerSpeakerLabel` to compute speaker stats
    const speakerStats = new Map<
      string,
      {
        segmentCount: number;
        speakingDurationMs: number;
        confidenceSum: number;
        confidenceCount: number;
      }
    >();
    for (const seg of alignmentOutcome.canonicalSegments) {
      const entry = speakerStats.get(seg.providerSpeakerLabel) ?? {
        segmentCount: 0,
        speakingDurationMs: 0,
        confidenceSum: 0,
        confidenceCount: 0,
      };
      entry.segmentCount += 1;
      entry.speakingDurationMs += seg.durationMs;
      if (seg.confidence !== null) {
        entry.confidenceSum += seg.confidence;
        entry.confidenceCount += 1;
      }
      speakerStats.set(seg.providerSpeakerLabel, entry);
    }

    const speakerRowByLabel = new Map<string, DbMeetingSpeakerRow>();
    const sortedSpeakerLabels = [...speakerStats.keys()].sort();

    for (const label of sortedSpeakerLabels) {
      const stats = speakerStats.get(label)!;
      const prior = priorByLabel.get(label);
      const displayLabel = prior?.display_label ?? defaultSpeakerDisplayLabel(label);
      const participantId = prior?.participant_id ?? null;
      const confidenceAvg =
        stats.confidenceCount > 0
          ? Number((stats.confidenceSum / stats.confidenceCount).toFixed(4))
          : null;

      const upsertedSpeakerRes = await this.db.query<DbMeetingSpeakerRow>(
        `insert into public.meeting_speakers (
          workspace_id, meeting_id, transcription_run_id, provider_speaker_label,
          display_label, participant_id, mapped_by, mapped_at,
          segment_count, speaking_duration_ms, confidence_avg
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (transcription_run_id, provider_speaker_label)
        do update set
          segment_count = excluded.segment_count,
          speaking_duration_ms = excluded.speaking_duration_ms,
          confidence_avg = excluded.confidence_avg
        returning *`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          label,
          displayLabel,
          participantId,
          prior?.mapped_by ?? null,
          prior?.mapped_at ?? null,
          stats.segmentCount,
          stats.speakingDurationMs,
          confidenceAvg,
        ],
      );
      speakerRowByLabel.set(label, upsertedSpeakerRes.rows[0]!);
    }

    // Replace/upsert canonical `transcript_segments` for THIS `transcription_run_id` only.
    // Deleting stale segments for `run.id` before upserting guarantees `sequence_no` and `provider_segment_key`
    // never collide or duplicate on retry.
    await this.db.query(`delete from public.transcript_segments where transcription_run_id = $1`, [
      run.id,
    ]);

    let totalWords = 0;
    let confSum = 0;
    let confCount = 0;
    const detectedLangSet = new Set<string>(parsedProviderResult.data.detectedLanguages);

    for (const seg of alignmentOutcome.canonicalSegments) {
      const speakerRow = speakerRowByLabel.get(seg.providerSpeakerLabel)!;
      totalWords += seg.wordCount;
      if (seg.confidence !== null) {
        confSum += seg.confidence;
        confCount += 1;
      }
      if (seg.language !== 'unknown') {
        detectedLangSet.add(seg.language);
      }

      await this.db.query(
        `insert into public.transcript_segments (
          workspace_id, meeting_id, recording_id, transcription_run_id, transcription_asset_id,
          sequence_no, provider_segment_key, speaker_id, provider_speaker_label,
          start_ms, end_ms, duration_ms, asset_start_ms, asset_end_ms,
          source_recording_source_id, source_recording_chunk_id,
          source_sample_start, source_sample_end,
          text, language, confidence, word_count, words,
          alignment_status, alignment_metadata
        )
        values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16,
          $17, $18,
          $19, $20, $21, $22, $23::jsonb,
          'canonical', $24::jsonb
        )`,
        [
          job.workspaceId,
          job.meetingId,
          job.recordingId,
          run.id,
          asset.id,
          seg.sequenceNo,
          seg.providerSegmentKey,
          speakerRow.id,
          seg.providerSpeakerLabel,
          seg.startMs,
          seg.endMs,
          seg.durationMs,
          seg.assetStartMs,
          seg.assetEndMs,
          seg.sourceRecordingSourceId,
          seg.sourceRecordingChunkId,
          seg.sourceSampleStart,
          seg.sourceSampleEnd,
          seg.text,
          seg.language,
          seg.confidence,
          seg.wordCount,
          JSON.stringify(seg.words),
          JSON.stringify(seg.alignmentMetadata),
        ],
      );
    }

    const runConfidenceAvg = confCount > 0 ? Number((confSum / confCount).toFixed(4)) : null;
    const detectedLanguages = [...detectedLangSet];

    await this.db.query(
      `update public.transcription_runs
          set segment_count = $2,
              quarantined_segment_count = $3,
              speaker_count = $4,
              word_count = $5,
              confidence_avg = $6,
              detected_languages = $7::text[],
              provider_summary_metadata = coalesce(provider_summary_metadata, '{}'::jsonb) || $8::jsonb
        where id = $1`,
      [
        run.id,
        alignmentOutcome.canonicalSegments.length,
        alignmentOutcome.quarantinedSegments.length,
        sortedSpeakerLabels.length,
        totalWords,
        runConfidenceAvg,
        detectedLanguages,
        JSON.stringify({
          quarantined_segments: alignmentOutcome.quarantinedSegments,
          normalized_at: nowIso,
        }),
      ],
    );

    const finGen = run.run_number;
    const finKey = buildCanonicalFinalizeTranscriptJobIdempotencyKey(run.id, finGen);
    const finJobRes = await this.db.query<DbJobPhase5Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'finalize_transcript', $4, $5, 'queued', $6, $7::jsonb)
      on conflict do nothing
      returning *`,
      [
        job.workspaceId,
        job.meetingId,
        job.recordingId,
        finGen,
        finKey,
        nowIso,
        JSON.stringify({
          transcription_run_id: run.id,
          transcription_asset_id: asset.id,
        }),
      ],
    );

    if (finJobRes.rows[0]) {
      await this.service.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: finJobRes.rows[0].id,
        eventType: 'job_created',
        fencingToken: job.fencingToken,
        metadata: {
          job_type: 'finalize_transcript',
          transcription_run_id: run.id,
        },
      });
    }

    await this.service.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'transcript_normalized',
      fencingToken: job.fencingToken,
      metadata: {
        transcription_run_id: run.id,
        canonical_segment_count: alignmentOutcome.canonicalSegments.length,
        quarantined_segment_count: alignmentOutcome.quarantinedSegments.length,
        speaker_count: sortedSpeakerLabels.length,
        word_count: totalWords,
      },
    });

    return this.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        stage: 'normalize_transcript',
        transcription_run_id: run.id,
        canonical_segment_count: alignmentOutcome.canonicalSegments.length,
        quarantined_segment_count: alignmentOutcome.quarantinedSegments.length,
        speaker_count: sortedSpeakerLabels.length,
      },
      { now },
    );
  }

  /**
   * Stage 4: `finalize_transcript`
   * Seals the `transcription_runs` row (`status = 'completed'`, making it immutable via DB trigger),
   * switches `meetings.current_transcription_run_id` atomically, and transitions the meeting to
   * `transcript_ready` (never `ready` before Phase 6 AI analysis).
   */
  async executeClaimedFinalizeTranscriptJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase5JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const runId =
      typeof job.payload.transcription_run_id === 'string' ? job.payload.transcription_run_id : '';
    if (!runId) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'missing_transcription_run_id',
        message: 'finalize_transcript job payload is missing transcription_run_id.',
        retryable: false,
        now,
      });
    }

    const runRes = await this.db.query<DbTranscriptionRunRow>(
      `select * from public.transcription_runs where id = $1 and workspace_id = $2`,
      [runId, job.workspaceId],
    );
    const run = runRes.rows[0];
    if (!run) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'transcription_run_not_found',
        message: `Transcription run ${runId} was not found.`,
        retryable: false,
        now,
      });
    }

    const segCountRes = await this.db.query<{ cnt: string | number }>(
      `select count(*) as cnt
         from public.transcript_segments
        where transcription_run_id = $1
          and workspace_id = $2
          and alignment_status = 'canonical'`,
      [run.id, job.workspaceId],
    );
    const canonicalCount = toNum(segCountRes.rows[0]?.cnt ?? 0);
    if (canonicalCount === 0) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'empty_canonical_transcript',
        message: 'Cannot finalize transcript: no canonical transcript segments exist for run.',
        retryable: false,
        now,
      });
    }

    // Seal `transcription_runs` row if not already sealed
    if (run.status !== 'completed') {
      await this.db.query(
        `update public.transcription_runs
            set status = 'completed',
                completed_at = $2
          where id = $1
            and status <> 'completed'`,
        [run.id, nowIso],
      );
    }

    // Atomically update meeting canonical transcript pointers and transition to `transcript_ready`
    await this.db.query(
      `update public.meetings
          set current_transcription_run_id = $3,
              latest_transcription_run_id = $3,
              detected_languages = $4::text[],
              status = 'transcript_ready',
              processing_status = 'transcript_ready'
        where id = $1
          and workspace_id = $2`,
      [job.meetingId, job.workspaceId, run.id, run.detected_languages],
    );

    await this.service.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'transcript_finalized',
      fencingToken: job.fencingToken,
      metadata: {
        transcription_run_id: run.id,
        run_number: run.run_number,
        canonical_segment_count: canonicalCount,
      },
    });

    return this.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        stage: 'finalize_transcript',
        transcription_run_id: run.id,
        run_number: run.run_number,
        canonical_segment_count: canonicalCount,
        meeting_status: 'transcript_ready',
      },
      { now },
    );
  }
}
