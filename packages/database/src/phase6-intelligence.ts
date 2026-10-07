import {
  MEETING_INTELLIGENCE_PIPELINE_VERSION,
  MEETING_INTELLIGENCE_PROMPT_VERSION,
  MEETING_INTELLIGENCE_SCHEMA_VERSION,
  buildCanonicalAnalyzeMeetingJobIdempotencyKey,
  buildCanonicalFinalizeAnalysisJobIdempotencyKey,
  buildCanonicalNormalizeIntelligenceJobIdempotencyKey,
  providerMeetingIntelligenceResultSchema,
  retryAnalysisRequestSchema,
  type ActionItemStatus,
  type AnalysisRunDto,
  type AnalysisRunStatus,
  type CommitmentStatus,
  type DecisionStatus,
  type FactCategory,
  type GetMeetingIntelligenceResponse,
  type IdeaStatus,
  type IntelligenceEntityType,
  type IntelligenceEvidenceDto,
  type MeetingActionItemDto,
  type MeetingAnalysisStatusResponse,
  type MeetingCommitmentDto,
  type MeetingDecisionDto,
  type MeetingFactDto,
  type MeetingIdeaDto,
  type MeetingObjectionDto,
  type MeetingPipelineStatus,
  type MeetingQuestionDto,
  type MeetingRiskDto,
  type MeetingSummaryDto,
  type MeetingTopicDto,
  type ObjectionStatus,
  type ProcessingJobDto,
  type ProviderExecutiveSummaryClaim,
  type ProviderMeetingIntelligenceResult,
  type ProviderWindowExtraction,
  type QuestionStatus,
  type RetryAnalysisRequestInput,
  type RetryAnalysisResponse,
  type RiskSeverity,
  type RiskStatus,
} from '@suhbat/contracts';
import {
  Phase4RecordingWorker,
  Phase4ServiceError,
  buildProductProcessingTimeline,
  redactObservabilityMetadata,
  type AuthenticatedPrincipal,
  type ClaimJobOptions,
  type ObservabilitySink,
  type SqlExecutor,
} from './phase4-backbone';
import {
  Phase5TranscriptionService,
  Phase5TranscriptionWorker,
  defaultSpeakerDisplayLabel,
  type ExecutePhase5JobOptions,
} from './phase5-transcription';
import {
  buildTranscriptWindows,
  consolidateWindowExtractions,
  validateAndNormalizeIntelligence,
  type BuildTranscriptWindowsOptions,
  type NormalizedEvidenceDraft,
} from './intelligence-pipeline';
import {
  FakeMeetingIntelligenceProvider,
  MeetingIntelligenceProviderError,
  type MeetingIntelligenceProvider,
} from './intelligence-provider';
import type { StorageProvider } from './storage';
import { FakeTranscriptionProvider, type TranscriptionProvider } from './transcription-provider';

type DbAnalysisRunRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  transcription_run_id: string;
  run_number: number;
  provider: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  pipeline_version: string;
  status: AnalysisRunStatus;
  window_count: number;
  topic_count: number;
  decision_count: number;
  action_item_count: number;
  fact_count: number;
  question_count: number;
  idea_count: number;
  objection_count: number;
  commitment_count: number;
  risk_count: number;
  evidence_count: number;
  quarantined_item_count: number;
  started_at: string | null;
  provider_completed_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  failure_metadata: Record<string, unknown>;
  token_usage_metadata: Record<string, unknown>;
  raw_provider_response: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type DbMeetingSummaryRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  headline: string;
  tl_dr: string;
  why_meeting_happened: string;
  major_discussions: unknown;
  confirmed_decisions: unknown;
  next_actions: unknown;
  unresolved_points: unknown;
  follow_ups: unknown;
  claims: unknown;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingTopicRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  sequence_no: number;
  topic_key: string;
  title: string;
  summary: string;
  keywords: string[];
  participant_ids: string[];
  speaker_labels: string[];
  start_ms: number;
  end_ms: number;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingDecisionRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  decision_key: string;
  statement: string;
  rationale: string | null;
  status: DecisionStatus;
  owner_participant_id: string | null;
  owner_label: string | null;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingActionItemRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  decision_id: string | null;
  sequence_no: number;
  action_key: string;
  title: string;
  owner_participant_id: string | null;
  owner_label: string | null;
  due_hint: string | null;
  due_date: string | Date | null;
  status: ActionItemStatus;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingFactRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  fact_key: string;
  category: FactCategory;
  label: string;
  value_text: string;
  unit: string | null;
  numeric_value: number | string | null;
  speaker_participant_id: string | null;
  speaker_label: string | null;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingQuestionRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  question_key: string;
  question: string;
  status: QuestionStatus;
  asked_by_participant_id: string | null;
  asked_by_label: string | null;
  owner_participant_id: string | null;
  owner_label: string | null;
  answer_summary: string | null;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingIdeaRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  idea_key: string;
  idea: string;
  notes: string | null;
  status: IdeaStatus;
  proposed_by_participant_id: string | null;
  proposed_by_label: string | null;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingObjectionRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  objection_key: string;
  summary: string;
  status: ObjectionStatus;
  raised_by_participant_id: string | null;
  raised_by_label: string | null;
  response_summary: string | null;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingCommitmentRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  commitment_key: string;
  commitment: string;
  owner_participant_id: string | null;
  owner_label: string | null;
  counterparty_label: string | null;
  due_label: string | null;
  status: CommitmentStatus;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbMeetingRiskRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  topic_id: string | null;
  sequence_no: number;
  risk_key: string;
  title: string;
  detail: string | null;
  severity: RiskSeverity;
  status: RiskStatus;
  mitigation: string | null;
  owner_participant_id: string | null;
  owner_label: string | null;
  confidence: number | string | null;
  source_segment_ids: string[];
  created_at: string;
};

type DbIntelligenceEvidenceJoinedRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  transcription_run_id: string;
  entity_type: IntelligenceEntityType;
  entity_id: string;
  transcript_segment_id: string;
  evidence_order: number;
  confidence: number | string | null;
  created_at: string;
  canonical_start_ms: number;
  canonical_end_ms: number;
  canonical_text: string;
  provider_speaker_label: string;
  speaker_display_label: string | null;
  participant_display_name: string | null;
};

type DbMeetingPhase6Row = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  project_id: string | null;
  meeting_type_id: string;
  title: string;
  status: MeetingAnalysisStatusResponse['meetingStatus'];
  processing_status: MeetingPipelineStatus;
  started_at: string | null;
  ended_at: string | null;
  timeline_origin_at: string | null;
  timeline_duration_ms: number | null;
  active_capture_duration_ms: number | null;
  current_transcription_run_id: string | null;
  latest_transcription_run_id: string | null;
  current_analysis_run_id: string | null;
  latest_analysis_run_id: string | null;
  detected_languages: string[];
  deleted_at: string | null;
  purge_status: 'active' | 'tombstoned' | 'purge_pending' | 'purged';
  created_by: string;
  created_at: string;
  updated_at: string;
};

type DbJobPhase6Row = {
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

function toDateOnlyString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'string') return val.slice(0, 10);
  return null;
}

function toNum(val: number | string): number {
  return typeof val === 'number' ? val : Number.parseInt(val, 10);
}

function toNullableFloat(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const parsed = typeof val === 'number' ? val : Number.parseFloat(val);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === 'string');
}

function mapAnalysisRunRow(row: DbAnalysisRunRow): AnalysisRunDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    transcriptionRunId: row.transcription_run_id,
    runNumber: row.run_number,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    pipelineVersion: row.pipeline_version,
    status: row.status,
    windowCount: row.window_count,
    topicCount: row.topic_count,
    decisionCount: row.decision_count,
    actionItemCount: row.action_item_count,
    factCount: row.fact_count,
    questionCount: row.question_count,
    ideaCount: row.idea_count,
    objectionCount: row.objection_count,
    commitmentCount: row.commitment_count,
    riskCount: row.risk_count,
    evidenceCount: row.evidence_count,
    quarantinedItemCount: row.quarantined_item_count,
    startedAt: toNullableIsoString(row.started_at),
    providerCompletedAt: toNullableIsoString(row.provider_completed_at),
    completedAt: toNullableIsoString(row.completed_at),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failureMetadata: redactObservabilityMetadata(row.failure_metadata ?? {}),
    tokenUsageMetadata: redactObservabilityMetadata(row.token_usage_metadata ?? {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapJobPhase6Row(row: DbJobPhase6Row): ProcessingJobDto {
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
    errorMetadata: redactObservabilityMetadata(row.error_metadata ?? {}),
    payload: redactObservabilityMetadata(row.payload ?? {}),
    resultMetadata: redactObservabilityMetadata(row.result_metadata ?? {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapEvidenceRow(row: DbIntelligenceEvidenceJoinedRow): IntelligenceEvidenceDto {
  const speakerDisplayLabel =
    row.participant_display_name ??
    row.speaker_display_label ??
    defaultSpeakerDisplayLabel(row.provider_speaker_label);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    analysisRunId: row.analysis_run_id,
    transcriptionRunId: row.transcription_run_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    transcriptSegmentId: row.transcript_segment_id,
    evidenceOrder: row.evidence_order,
    startMs: row.canonical_start_ms,
    endMs: row.canonical_end_ms,
    speakerDisplayLabel,
    excerpt: row.canonical_text,
    confidence: toNullableFloat(row.confidence),
    createdAt: toIsoString(row.created_at),
  };
}

export class Phase6IntelligenceService {
  readonly db: SqlExecutor;
  readonly phase5: Phase5TranscriptionService;
  readonly intelligenceProvider: MeetingIntelligenceProvider;
  readonly windowOptions: BuildTranscriptWindowsOptions;

  constructor(options: {
    db: SqlExecutor;
    storage?: StorageProvider;
    transcriptionProvider?: TranscriptionProvider;
    intelligenceProvider?: MeetingIntelligenceProvider;
    phase5?: Phase5TranscriptionService;
    windowOptions?: BuildTranscriptWindowsOptions;
    onEvent?: ObservabilitySink;
  }) {
    this.db = options.db;
    this.phase5 =
      options.phase5 ??
      new Phase5TranscriptionService({
        db: options.db,
        ...(options.storage ? { storage: options.storage } : {}),
        provider: options.transcriptionProvider ?? new FakeTranscriptionProvider(),
        onEvent: options.onEvent,
      });
    this.intelligenceProvider =
      options.intelligenceProvider ?? new FakeMeetingIntelligenceProvider();
    this.windowOptions = options.windowOptions ?? {};
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
        'cross_workspace_access_denied',
        'Caller is not an active member of the target workspace.',
      );
    }
    return membership;
  }

  private async loadAuthorizedMeeting(
    userId: string,
    meetingId: string,
    expectedWorkspaceId?: string,
  ): Promise<DbMeetingPhase6Row> {
    const res = await this.db.query<DbMeetingPhase6Row>(
      `select id, workspace_id, company_id, project_id, meeting_type_id, title,
              status::text as status, processing_status::text as processing_status,
              started_at, ended_at, timeline_origin_at, timeline_duration_ms,
              active_capture_duration_ms, current_transcription_run_id,
              latest_transcription_run_id, current_analysis_run_id,
              latest_analysis_run_id, detected_languages, deleted_at,
              purge_status::text as purge_status, created_by, created_at, updated_at
         from public.meetings
        where id = $1`,
      [meetingId],
    );
    const meeting = res.rows[0];
    if (!meeting) {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }
    if (expectedWorkspaceId && meeting.workspace_id !== expectedWorkspaceId) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Meeting does not belong to the requested workspace.',
      );
    }
    await this.assertActiveWorkspaceMembership(userId, meeting.workspace_id);
    if (meeting.deleted_at || meeting.purge_status !== 'active') {
      throw new Phase4ServiceError(409, 'invalid_state', 'Meeting is deleted or not active.');
    }
    return meeting;
  }

  /**
   * Enqueues `analyze_meeting` idempotently for a completed `transcription_run_id`.
   */
  async enqueueAnalyzeMeetingJob(params: {
    meetingId: string;
    transcriptionRunId?: string;
    generation?: number;
    now?: Date;
  }): Promise<{ job: ProcessingJobDto; idempotentReused: boolean }> {
    const nowIso = (params.now ?? new Date()).toISOString();

    const meetingRes = await this.db.query<DbMeetingPhase6Row>(
      `select id, workspace_id, status::text as status, processing_status::text as processing_status,
              current_transcription_run_id, latest_transcription_run_id,
              current_analysis_run_id, latest_analysis_run_id
         from public.meetings
        where id = $1`,
      [params.meetingId],
    );
    const meeting = meetingRes.rows[0];
    if (!meeting) {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }

    const targetTranscriptionRunId =
      params.transcriptionRunId ?? meeting.current_transcription_run_id;
    if (!targetTranscriptionRunId) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot enqueue meeting analysis before a canonical transcription run is completed.',
      );
    }

    const trRunRes = await this.db.query<{
      id: string;
      workspace_id: string;
      meeting_id: string;
      recording_id: string;
      status: string;
    }>(
      `select id, workspace_id, meeting_id, recording_id, status::text as status
         from public.transcription_runs
        where id = $1
          and meeting_id = $2
          and workspace_id = $3`,
      [targetTranscriptionRunId, meeting.id, meeting.workspace_id],
    );
    const trRun = trRunRes.rows[0];
    if (!trRun || trRun.status !== 'completed') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Target transcription run is missing or not completed.',
      );
    }

    const generation = params.generation ?? 1;
    const idempotencyKey = buildCanonicalAnalyzeMeetingJobIdempotencyKey(trRun.id, generation);

    const insertRes = await this.db.query<DbJobPhase6Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'analyze_meeting', $4, $5, 'queued', $6, $7::jsonb)
      on conflict do nothing
      returning *`,
      [
        meeting.workspace_id,
        meeting.id,
        trRun.recording_id,
        generation,
        idempotencyKey,
        nowIso,
        JSON.stringify({
          transcription_run_id: trRun.id,
          generation,
        }),
      ],
    );

    let jobRow = insertRes.rows[0];
    let idempotentReused = false;
    if (!jobRow) {
      const existingRes = await this.db.query<DbJobPhase6Row>(
        `select *
           from public.processing_jobs
          where idempotency_key = $1
             or (meeting_id = $2 and recording_id = $3 and job_type = 'analyze_meeting' and generation = $4)
          order by created_at desc
          limit 1`,
        [idempotencyKey, meeting.id, trRun.recording_id, generation],
      );
      jobRow = existingRes.rows[0]!;
      idempotentReused = true;
    } else {
      await this.phase5.phase4.recordProcessingEvent({
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        recordingId: trRun.recording_id,
        processingJobId: jobRow.id,
        eventType: 'job_created',
        metadata: {
          job_type: 'analyze_meeting',
          transcription_run_id: trRun.id,
          generation,
        },
      });
    }

    if (meeting.status === 'transcript_ready' || meeting.status === 'analysis_failed') {
      await this.db.query(
        `update public.meetings
            set status = 'ready_for_analysis',
                processing_status = 'ready_for_analysis'
          where id = $1
            and workspace_id = $2
            and status in ('transcript_ready', 'analysis_failed')`,
        [meeting.id, meeting.workspace_id],
      );
    }

    return {
      job: mapJobPhase6Row(jobRow),
      idempotentReused,
    };
  }

  /**
   * `GET /api/v1/meetings/{meetingId}/analysis`
   * Returns analysis run history, active pointers, and job status without exposing provider secrets.
   */
  async getMeetingAnalysisStatus(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<MeetingAnalysisStatusResponse> {
    const auth = this.requireAuth(authInput);
    if (clientWorkspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, clientWorkspaceId);
    }
    const meeting = await this.loadAuthorizedMeeting(auth.userId, meetingId, clientWorkspaceId);

    const [runsRes, jobsRes] = await Promise.all([
      this.db.query<DbAnalysisRunRow>(
        `select *
           from public.analysis_runs
          where meeting_id = $1
            and workspace_id = $2
          order by run_number asc`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbJobPhase6Row>(
        `select *
           from public.processing_jobs
          where meeting_id = $1
            and workspace_id = $2
          order by created_at asc`,
        [meeting.id, meeting.workspace_id],
      ),
    ]);

    const { productState } = buildProductProcessingTimeline({
      meeting: meeting as unknown as Parameters<
        typeof buildProductProcessingTimeline
      >[0]['meeting'],
      recording: null,
      sources: [],
      chunks: [],
      jobs: jobsRes.rows as unknown as Parameters<typeof buildProductProcessingTimeline>[0]['jobs'],
    });

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      meetingStatus: meeting.status,
      pipelineStatus: meeting.processing_status,
      productState,
      currentTranscriptionRunId: meeting.current_transcription_run_id,
      currentAnalysisRunId: meeting.current_analysis_run_id,
      latestAnalysisRunId: meeting.latest_analysis_run_id,
      runs: runsRes.rows.map(mapAnalysisRunRow),
      jobs: jobsRes.rows.map(mapJobPhase6Row),
    };
  }

  /**
   * `GET /api/v1/meetings/{meetingId}/intelligence`
   * Returns the canonical structured meeting intelligence and evidence links for `current_analysis_run_id`.
   * Timestamps and speaker labels are always derived from `transcript_segments` and `meeting_speakers`/`meeting_participants`.
   */
  async getMeetingIntelligence(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<GetMeetingIntelligenceResponse> {
    const auth = this.requireAuth(authInput);
    if (clientWorkspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, clientWorkspaceId);
    }
    const meeting = await this.loadAuthorizedMeeting(auth.userId, meetingId, clientWorkspaceId);

    const activeRunId = meeting.current_analysis_run_id;
    if (!activeRunId) {
      return {
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        currentAnalysisRun: null,
        summary: null,
        topics: [],
        decisions: [],
        actionItems: [],
        facts: [],
        questions: [],
        ideas: [],
        objections: [],
        commitments: [],
        risks: [],
        evidenceCount: 0,
        quarantinedItemCount: 0,
      };
    }

    const [
      runRes,
      summaryRes,
      topicsRes,
      decisionsRes,
      actionItemsRes,
      factsRes,
      questionsRes,
      ideasRes,
      objectionsRes,
      commitmentsRes,
      risksRes,
      evidenceRes,
    ] = await Promise.all([
      this.db.query<DbAnalysisRunRow>(
        `select * from public.analysis_runs where id = $1 and workspace_id = $2`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingSummaryRow>(
        `select * from public.meeting_summaries where analysis_run_id = $1 and workspace_id = $2`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingTopicRow>(
        `select * from public.meeting_topics where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingDecisionRow>(
        `select * from public.meeting_decisions where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingActionItemRow>(
        `select * from public.meeting_action_items where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingFactRow>(
        `select * from public.meeting_facts where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingQuestionRow>(
        `select * from public.meeting_questions where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingIdeaRow>(
        `select * from public.meeting_ideas where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingObjectionRow>(
        `select * from public.meeting_objections where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingCommitmentRow>(
        `select * from public.meeting_commitments where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbMeetingRiskRow>(
        `select * from public.meeting_risks where analysis_run_id = $1 and workspace_id = $2 order by sequence_no asc`,
        [activeRunId, meeting.workspace_id],
      ),
      this.db.query<DbIntelligenceEvidenceJoinedRow>(
        `select ie.*,
                ts.start_ms as canonical_start_ms,
                ts.end_ms as canonical_end_ms,
                ts.text as canonical_text,
                ts.provider_speaker_label,
                ms.display_label as speaker_display_label,
                mp.display_name as participant_display_name
           from public.intelligence_evidence ie
           join public.transcript_segments ts
             on ts.id = ie.transcript_segment_id
            and ts.transcription_run_id = ie.transcription_run_id
            and ts.meeting_id = ie.meeting_id
            and ts.workspace_id = ie.workspace_id
           left join public.meeting_speakers ms
             on ms.id = ts.speaker_id
           left join public.meeting_participants mp
             on mp.id = ms.participant_id
          where ie.analysis_run_id = $1
            and ie.workspace_id = $2
          order by ie.entity_type asc, ie.entity_id asc, ie.evidence_order asc`,
        [activeRunId, meeting.workspace_id],
      ),
    ]);

    const runRow = runRes.rows[0] ?? null;
    const evidenceByEntity = new Map<string, IntelligenceEvidenceDto[]>();
    for (const evRow of evidenceRes.rows) {
      const dto = mapEvidenceRow(evRow);
      const key = `${dto.entityType}:${dto.entityId}`;
      const list = evidenceByEntity.get(key) ?? [];
      list.push(dto);
      evidenceByEntity.set(key, list);
    }

    const summaryRow = summaryRes.rows[0] ?? null;
    const summaryDto: MeetingSummaryDto | null = summaryRow
      ? {
          id: summaryRow.id,
          workspaceId: summaryRow.workspace_id,
          meetingId: summaryRow.meeting_id,
          analysisRunId: summaryRow.analysis_run_id,
          transcriptionRunId: summaryRow.transcription_run_id,
          headline: summaryRow.headline,
          tlDr: summaryRow.tl_dr,
          whyMeetingHappened: summaryRow.why_meeting_happened,
          majorDiscussions: toStringArray(summaryRow.major_discussions),
          confirmedDecisions: toStringArray(summaryRow.confirmed_decisions),
          nextActions: toStringArray(summaryRow.next_actions),
          unresolvedPoints: toStringArray(summaryRow.unresolved_points),
          followUps: toStringArray(summaryRow.follow_ups),
          claims: Array.isArray(summaryRow.claims)
            ? (summaryRow.claims as ProviderExecutiveSummaryClaim[])
            : [],
          sourceSegmentIds: summaryRow.source_segment_ids,
          evidence: evidenceByEntity.get(`summary_claim:${summaryRow.id}`) ?? [],
          createdAt: toIsoString(summaryRow.created_at),
        }
      : null;

    const topics: MeetingTopicDto[] = topicsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      sequenceNo: r.sequence_no,
      topicKey: r.topic_key,
      title: r.title,
      summary: r.summary,
      keywords: r.keywords ?? [],
      participantIds: r.participant_ids ?? [],
      speakerLabels: r.speaker_labels ?? [],
      startMs: r.start_ms,
      endMs: r.end_ms,
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`topic:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const decisions: MeetingDecisionDto[] = decisionsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      decisionKey: r.decision_key,
      statement: r.statement,
      rationale: r.rationale,
      status: r.status,
      ownerParticipantId: r.owner_participant_id,
      ownerLabel: r.owner_label,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`decision:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const actionItems: MeetingActionItemDto[] = actionItemsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      decisionId: r.decision_id,
      sequenceNo: r.sequence_no,
      actionKey: r.action_key,
      title: r.title,
      ownerParticipantId: r.owner_participant_id,
      ownerLabel: r.owner_label,
      dueHint: r.due_hint,
      dueDate: toDateOnlyString(r.due_date),
      status: r.status,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`action_item:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const facts: MeetingFactDto[] = factsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      factKey: r.fact_key,
      category: r.category,
      label: r.label,
      valueText: r.value_text,
      unit: r.unit,
      numericValue: toNullableFloat(r.numeric_value),
      speakerParticipantId: r.speaker_participant_id,
      speakerLabel: r.speaker_label,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`fact:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const questions: MeetingQuestionDto[] = questionsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      questionKey: r.question_key,
      question: r.question,
      status: r.status,
      askedByParticipantId: r.asked_by_participant_id,
      askedByLabel: r.asked_by_label,
      ownerParticipantId: r.owner_participant_id,
      ownerLabel: r.owner_label,
      answerSummary: r.answer_summary,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`question:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const ideas: MeetingIdeaDto[] = ideasRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      ideaKey: r.idea_key,
      idea: r.idea,
      notes: r.notes,
      status: r.status,
      proposedByParticipantId: r.proposed_by_participant_id,
      proposedByLabel: r.proposed_by_label,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`idea:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const objections: MeetingObjectionDto[] = objectionsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      objectionKey: r.objection_key,
      summary: r.summary,
      status: r.status,
      raisedByParticipantId: r.raised_by_participant_id,
      raisedByLabel: r.raised_by_label,
      responseSummary: r.response_summary,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`objection:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const commitments: MeetingCommitmentDto[] = commitmentsRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      commitmentKey: r.commitment_key,
      commitment: r.commitment,
      ownerParticipantId: r.owner_participant_id,
      ownerLabel: r.owner_label,
      counterpartyLabel: r.counterparty_label,
      dueLabel: r.due_label,
      status: r.status,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`commitment:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    const risks: MeetingRiskDto[] = risksRes.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      meetingId: r.meeting_id,
      analysisRunId: r.analysis_run_id,
      transcriptionRunId: r.transcription_run_id,
      topicId: r.topic_id,
      sequenceNo: r.sequence_no,
      riskKey: r.risk_key,
      title: r.title,
      detail: r.detail,
      severity: r.severity,
      status: r.status,
      mitigation: r.mitigation,
      ownerParticipantId: r.owner_participant_id,
      ownerLabel: r.owner_label,
      confidence: toNullableFloat(r.confidence),
      sourceSegmentIds: r.source_segment_ids,
      evidence: evidenceByEntity.get(`risk:${r.id}`) ?? [],
      createdAt: toIsoString(r.created_at),
    }));

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      currentAnalysisRun: runRow ? mapAnalysisRunRow(runRow) : null,
      summary: summaryDto,
      topics,
      decisions,
      actionItems,
      facts,
      questions,
      ideas,
      objections,
      commitments,
      risks,
      evidenceCount: evidenceRes.rows.length,
      quarantinedItemCount: runRow?.quarantined_item_count ?? 0,
    };
  }

  /**
   * `POST /api/v1/meetings/{meetingId}/analysis/retry`
   * Idempotently schedules a new `analyze_meeting` job without overwriting historical analysis runs.
   */
  async retryAnalysis(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    rawInput: RetryAnalysisRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<RetryAnalysisResponse> {
    const auth = this.requireAuth(authInput);
    const parsed = retryAnalysisRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid analysis retry request.',
      );
    }
    const input = parsed.data;
    if (input.workspaceId) {
      await this.assertActiveWorkspaceMembership(auth.userId, input.workspaceId);
    }
    const meeting = await this.loadAuthorizedMeeting(auth.userId, meetingId, input.workspaceId);

    if (!meeting.current_transcription_run_id) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot retry meeting analysis before canonical transcript is finalized.',
      );
    }

    // If an analysis job is already queued, running, or retryable_failed, return it idempotently
    const activeJobRes = await this.db.query<DbJobPhase6Row>(
      `select *
         from public.processing_jobs
        where meeting_id = $1
          and workspace_id = $2
          and job_type in ('analyze_meeting', 'normalize_intelligence', 'finalize_analysis')
          and status in ('queued', 'running', 'retryable_failed')
        order by created_at desc
        limit 1`,
      [meeting.id, meeting.workspace_id],
    );
    if (activeJobRes.rows[0]) {
      return {
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        transcriptionRunId: meeting.current_transcription_run_id,
        job: mapJobPhase6Row(activeJobRes.rows[0]),
        idempotentReused: true,
      };
    }

    const [maxJobGenRes, maxRunRes] = await Promise.all([
      this.db.query<{ max_gen: number | null }>(
        `select max(generation) as max_gen
           from public.processing_jobs
          where meeting_id = $1
            and workspace_id = $2
            and job_type = 'analyze_meeting'`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<{ max_run: number | null }>(
        `select max(run_number) as max_run
           from public.analysis_runs
          where meeting_id = $1
            and workspace_id = $2`,
        [meeting.id, meeting.workspace_id],
      ),
    ]);

    const nextGen =
      Math.max(maxJobGenRes.rows[0]?.max_gen ?? 0, maxRunRes.rows[0]?.max_run ?? 0) + 1;

    const { job, idempotentReused } = await this.enqueueAnalyzeMeetingJob({
      meetingId: meeting.id,
      transcriptionRunId: meeting.current_transcription_run_id,
      generation: nextGen,
      now: options.now,
    });

    if (!idempotentReused) {
      await this.phase5.phase4.recordProcessingEvent({
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        recordingId: job.recordingId,
        processingJobId: job.id,
        eventType: 'analysis_retried',
        actorId: auth.userId,
        metadata: {
          transcription_run_id: meeting.current_transcription_run_id,
          generation: nextGen,
          reason: input.reason ?? null,
        },
      });
    }

    return {
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      transcriptionRunId: meeting.current_transcription_run_id,
      job,
      idempotentReused,
    };
  }
}

export type ExecutePhase6JobOptions = ExecutePhase5JobOptions & {
  /**
   * Optional test hook invoked after the intelligence provider returns and `raw_provider_response`
   * is persisted on `analysis_runs`, before `analyze_meeting` job completion is committed.
   */
  afterAnalysisProviderResponseHook?: (context: {
    job: ProcessingJobDto;
    analysisRunId: string;
  }) => Promise<void>;
};

/**
 * Durable Phase 6 worker executing:
 * `transcript_ready -> analyze_meeting -> normalize_intelligence -> finalize_analysis`
 * (and also capable of delegating Phase 4/5 jobs through `Phase5TranscriptionWorker` for full end-to-end runs).
 */
export class Phase6IntelligenceWorker {
  readonly service: Phase6IntelligenceService;
  readonly phase5Worker: Phase5TranscriptionWorker;
  readonly phase4Worker: Phase4RecordingWorker;

  constructor(service: Phase6IntelligenceService) {
    this.service = service;
    this.phase5Worker = new Phase5TranscriptionWorker(service.phase5);
    this.phase4Worker = this.phase5Worker.phase4Worker;
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
  ): Promise<DbJobPhase6Row> {
    const res = await this.db.query<DbJobPhase6Row>(
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
        'Stale worker fencing token or expired lease cannot mutate meeting intelligence pipeline state.',
      );
    }
    return row;
  }

  /**
   * Enqueues `analyze_meeting` for any meeting currently in `transcript_ready` with a completed
   * `current_transcription_run_id` that does not yet have an analysis job for that run.
   */
  async enqueuePendingTranscriptReadyMeetings(
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto[]> {
    const res = await this.db.query<{
      id: string;
      workspace_id: string;
      current_transcription_run_id: string;
    }>(
      `select m.id, m.workspace_id, m.current_transcription_run_id
         from public.meetings m
        where m.status = 'transcript_ready'
          and m.current_transcription_run_id is not null
          and m.deleted_at is null
          and m.purge_status = 'active'
          and not exists (
            select 1
              from public.processing_jobs pj
             where pj.meeting_id = m.id
               and pj.job_type = 'analyze_meeting'
          )`,
    );

    const enqueued: ProcessingJobDto[] = [];
    for (const row of res.rows) {
      const { job } = await this.service.enqueueAnalyzeMeetingJob({
        meetingId: row.id,
        transcriptionRunId: row.current_transcription_run_id,
        generation: 1,
        now: options.now,
      });
      enqueued.push(job);
    }
    return enqueued;
  }

  async runNextJob(
    workerId: string,
    options: ClaimJobOptions & ExecutePhase6JobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    let job = await this.claimNextJob(workerId, options);
    if (!job) {
      const newlyQueued = await this.enqueuePendingTranscriptReadyMeetings({
        now: options.now,
      });
      if (newlyQueued.length > 0) {
        job = await this.claimNextJob(workerId, options);
      }
    }
    if (!job) return null;
    return this.executeClaimedJob(workerId, job, options);
  }

  async runUntilIdle(
    workerId: string,
    options: ClaimJobOptions & ExecutePhase6JobOptions & { maxJobs?: number } = {},
  ): Promise<ProcessingJobDto[]> {
    const executed: ProcessingJobDto[] = [];
    const maxJobs = options.maxJobs ?? 35;
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
    options: ExecutePhase6JobOptions = {},
  ): Promise<ProcessingJobDto> {
    switch (job.jobType) {
      case 'prepare_recording':
      case 'assemble_recording':
      case 'transcribe_meeting':
      case 'normalize_transcript':
        return this.phase5Worker.executeClaimedJob(workerId, job, options);
      case 'finalize_transcript': {
        const finalized = await this.phase5Worker.executeClaimedFinalizeTranscriptJob(
          workerId,
          job,
          options,
        );
        if (finalized.status === 'succeeded') {
          const trRunId =
            typeof job.payload.transcription_run_id === 'string'
              ? job.payload.transcription_run_id
              : undefined;
          await this.service.enqueueAnalyzeMeetingJob({
            meetingId: job.meetingId,
            transcriptionRunId: trRunId,
            generation: job.generation,
            now: options.now,
          });
        }
        return finalized;
      }
      case 'analyze_meeting':
        return this.executeClaimedAnalyzeMeetingJob(workerId, job, options);
      case 'normalize_intelligence':
        return this.executeClaimedNormalizeIntelligenceJob(workerId, job, options);
      case 'finalize_analysis':
        return this.executeClaimedFinalizeAnalysisJob(workerId, job, options);
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
   * Stage 1: `analyze_meeting`
   * Splits canonical transcript into bounded windows, invokes `MeetingIntelligenceProvider`,
   * consolidates window extractions, persists raw provider output on `analysis_runs`,
   * and enqueues `normalize_intelligence`.
   */
  async executeClaimedAnalyzeMeetingJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase6JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const meetingRes = await this.db.query<DbMeetingPhase6Row>(
      `select id, workspace_id, title, status::text as status,
              processing_status::text as processing_status,
              current_transcription_run_id, current_analysis_run_id
         from public.meetings
        where id = $1
          and workspace_id = $2`,
      [job.meetingId, job.workspaceId],
    );
    const meeting = meetingRes.rows[0];
    if (!meeting) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'meeting_not_found',
        message: `Meeting ${job.meetingId} was not found.`,
        retryable: false,
        now,
      });
    }

    const transcriptionRunId =
      typeof job.payload.transcription_run_id === 'string' &&
      job.payload.transcription_run_id.length > 0
        ? job.payload.transcription_run_id
        : meeting.current_transcription_run_id;

    if (!transcriptionRunId) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'missing_transcription_run_id',
        message: 'analyze_meeting job has no target transcription_run_id.',
        retryable: false,
        now,
      });
    }

    // Crash-after-provider recovery: check if an earlier attempt of this job already persisted provider output
    const existingRunsRes = await this.db.query<DbAnalysisRunRow>(
      `select *
         from public.analysis_runs
        where meeting_id = $1
          and workspace_id = $2
        order by run_number desc`,
      [job.meetingId, job.workspaceId],
    );

    const recoverableRun = existingRunsRes.rows.find(
      (r) =>
        (r.status === 'normalizing' || r.status === 'completed') &&
        r.raw_provider_response &&
        Object.keys(r.raw_provider_response).length > 0 &&
        r.token_usage_metadata?.analyze_job_id === job.id,
    );

    if (recoverableRun) {
      await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);
      const normGen = recoverableRun.run_number;
      const normKey = buildCanonicalNormalizeIntelligenceJobIdempotencyKey(
        recoverableRun.id,
        normGen,
      );
      await this.db.query(
        `insert into public.processing_jobs (
          workspace_id, meeting_id, recording_id, job_type, generation,
          idempotency_key, status, scheduled_at, payload
        )
        values ($1, $2, $3, 'normalize_intelligence', $4, $5, 'queued', $6, $7::jsonb)
        on conflict do nothing`,
        [
          job.workspaceId,
          job.meetingId,
          job.recordingId,
          normGen,
          normKey,
          nowIso,
          JSON.stringify({
            analysis_run_id: recoverableRun.id,
            transcription_run_id: recoverableRun.transcription_run_id,
          }),
        ],
      );

      return this.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          stage: 'analyze_meeting',
          analysis_run_id: recoverableRun.id,
          recovered_after_provider_response: true,
        },
        { now },
      );
    }

    const transcriptBundle = await this.loadTranscriptBundleForRun(
      job.workspaceId,
      job.meetingId,
      transcriptionRunId,
    );

    const windows = buildTranscriptWindows(transcriptBundle.segments, this.service.windowOptions);
    if (windows.length === 0) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'empty_canonical_transcript',
        message: 'Cannot analyze meeting: zero canonical transcript segments exist.',
        retryable: false,
        now,
      });
    }

    const nextRunNumber = (existingRunsRes.rows[0]?.run_number ?? 0) + 1;
    const provider = this.service.intelligenceProvider;

    const insertRunRes = await this.db.query<DbAnalysisRunRow>(
      `insert into public.analysis_runs (
        workspace_id, meeting_id, recording_id, transcription_run_id, run_number,
        provider, model, prompt_version, schema_version, pipeline_version,
        status, window_count, started_at, token_usage_metadata
      )
      values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        'running', $11, $12, $13::jsonb
      )
      returning *`,
      [
        job.workspaceId,
        job.meetingId,
        job.recordingId,
        transcriptionRunId,
        nextRunNumber,
        provider.providerName,
        provider.defaultModel,
        provider.promptVersion,
        provider.schemaVersion,
        provider.pipelineVersion,
        windows.length,
        nowIso,
        JSON.stringify({
          analyze_job_id: job.id,
          analyze_job_attempt: job.attempt,
          analyze_job_generation: job.generation,
        }),
      ],
    );
    const runRow = insertRunRes.rows[0]!;

    await this.db.query(
      `update public.meetings
          set latest_analysis_run_id = $3,
              status = case when status = 'ready' then status else 'analyzing'::public.meeting_status end,
              processing_status = case when processing_status = 'ready' then processing_status else 'analyzing'::public.meeting_processing_status end
        where id = $1
          and workspace_id = $2`,
      [job.meetingId, job.workspaceId, runRow.id],
    );

    await this.service.phase5.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'analysis_started',
      fencingToken: job.fencingToken,
      metadata: {
        analysis_run_id: runRow.id,
        run_number: runRow.run_number,
        provider: runRow.provider,
        model: runRow.model,
        prompt_version: runRow.prompt_version,
        schema_version: runRow.schema_version,
        pipeline_version: runRow.pipeline_version,
        window_count: windows.length,
      },
    });

    const windowExtractions: ProviderWindowExtraction[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let resolvedModel = provider.defaultModel;

    try {
      for (const win of windows) {
        const winOut = await provider.analyzeWindow({
          workspaceId: job.workspaceId,
          meetingId: job.meetingId,
          meetingTitle: meeting.title,
          recordingId: job.recordingId,
          transcriptionRunId,
          analysisRunId: runRow.id,
          windowIndex: win.windowIndex,
          totalWindows: win.totalWindows,
          segments: win.segments,
          speakers: transcriptBundle.speakers,
          participants: transcriptBundle.participants,
        });

        resolvedModel = winOut.model || resolvedModel;
        promptTokens += winOut.tokenUsage.promptTokens;
        completionTokens += winOut.tokenUsage.completionTokens;
        totalTokens += winOut.tokenUsage.totalTokens;
        windowExtractions.push(winOut.extraction);

        await this.service.phase5.phase4.recordProcessingEvent({
          workspaceId: job.workspaceId,
          meetingId: job.meetingId,
          recordingId: job.recordingId,
          processingJobId: job.id,
          eventType: 'analysis_window_processed',
          fencingToken: job.fencingToken,
          metadata: {
            analysis_run_id: runRow.id,
            window_index: win.windowIndex,
            total_windows: win.totalWindows,
            segment_count: win.segments.length,
          },
        });
      }
    } catch (cause) {
      const errCode =
        cause instanceof MeetingIntelligenceProviderError ? cause.code : 'provider_analysis_failed';
      const errMsg = cause instanceof Error ? cause.message : String(cause);
      const retryable = cause instanceof MeetingIntelligenceProviderError ? cause.retryable : false;

      await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

      await this.db.query(
        `update public.analysis_runs
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

      await this.service.phase5.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: job.id,
        eventType: 'analysis_failed',
        fencingToken: job.fencingToken,
        metadata: {
          analysis_run_id: runRow.id,
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

    const consolidatedExtraction = consolidateWindowExtractions(
      windowExtractions,
      transcriptBundle.segments,
    );

    const providerResult: ProviderMeetingIntelligenceResult =
      providerMeetingIntelligenceResultSchema.parse({
        provider: provider.providerName,
        model: resolvedModel,
        promptVersion: provider.promptVersion,
        schemaVersion: provider.schemaVersion,
        pipelineVersion: provider.pipelineVersion,
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        windowCount: windows.length,
        extraction: consolidatedExtraction,
        providerMetadata: {
          window_count: windows.length,
          total_segments: transcriptBundle.segments.length,
        },
      });

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    await this.db.query(
      `update public.analysis_runs
          set model = $2,
              status = 'normalizing',
              provider_completed_at = $3,
              token_usage_metadata = coalesce(token_usage_metadata, '{}'::jsonb) || $4::jsonb,
              raw_provider_response = $5::jsonb
        where id = $1`,
      [
        runRow.id,
        resolvedModel,
        nowIso,
        JSON.stringify({
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          window_count: windows.length,
        }),
        JSON.stringify(providerResult),
      ],
    );

    if (options.afterAnalysisProviderResponseHook) {
      await options.afterAnalysisProviderResponseHook({
        job,
        analysisRunId: runRow.id,
      });
    }

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const normGen = runRow.run_number;
    const normKey = buildCanonicalNormalizeIntelligenceJobIdempotencyKey(runRow.id, normGen);
    const normJobRes = await this.db.query<DbJobPhase6Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'normalize_intelligence', $4, $5, 'queued', $6, $7::jsonb)
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
          analysis_run_id: runRow.id,
          transcription_run_id: transcriptionRunId,
        }),
      ],
    );

    if (normJobRes.rows[0]) {
      await this.service.phase5.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: normJobRes.rows[0].id,
        eventType: 'job_created',
        fencingToken: job.fencingToken,
        metadata: {
          job_type: 'normalize_intelligence',
          analysis_run_id: runRow.id,
        },
      });
    }

    await this.service.phase5.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'analysis_completed',
      fencingToken: job.fencingToken,
      metadata: {
        analysis_run_id: runRow.id,
        run_number: runRow.run_number,
        window_count: windows.length,
        total_tokens: totalTokens,
      },
    });

    return this.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        stage: 'analyze_meeting',
        analysis_run_id: runRow.id,
        run_number: runRow.run_number,
        window_count: windows.length,
        total_tokens: totalTokens,
      },
      { now },
    );
  }

  /**
   * Stage 2: `normalize_intelligence`
   * Validates candidate intelligence items and `sourceSegmentIds` against canonical `transcript_segments`,
   * quarantines invalid items, persists canonical intelligence entities + `intelligence_evidence` rows,
   * and enqueues `finalize_analysis`.
   */
  async executeClaimedNormalizeIntelligenceJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase6JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const analysisRunId =
      typeof job.payload.analysis_run_id === 'string' ? job.payload.analysis_run_id : '';
    if (!analysisRunId) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'missing_analysis_run_id',
        message: 'normalize_intelligence job payload is missing analysis_run_id.',
        retryable: false,
        now,
      });
    }

    const runRes = await this.db.query<DbAnalysisRunRow>(
      `select * from public.analysis_runs where id = $1 and workspace_id = $2`,
      [analysisRunId, job.workspaceId],
    );
    const run = runRes.rows[0];
    if (!run) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'analysis_run_not_found',
        message: `Analysis run ${analysisRunId} was not found.`,
        retryable: false,
        now,
      });
    }

    if (run.status === 'completed') {
      const finGen = run.run_number;
      const finKey = buildCanonicalFinalizeAnalysisJobIdempotencyKey(run.id, finGen);
      await this.db.query(
        `insert into public.processing_jobs (
          workspace_id, meeting_id, recording_id, job_type, generation,
          idempotency_key, status, scheduled_at, payload
        )
        values ($1, $2, $3, 'finalize_analysis', $4, $5, 'queued', $6, $7::jsonb)
        on conflict do nothing`,
        [
          job.workspaceId,
          job.meetingId,
          job.recordingId,
          finGen,
          finKey,
          nowIso,
          JSON.stringify({ analysis_run_id: run.id }),
        ],
      );
      return this.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          stage: 'normalize_intelligence',
          analysis_run_id: run.id,
          idempotent_already_completed: true,
        },
        { now },
      );
    }

    const parsedProviderResult = providerMeetingIntelligenceResultSchema.safeParse(
      run.raw_provider_response,
    );
    if (!parsedProviderResult.success) {
      await this.db.query(
        `update public.analysis_runs
            set status = 'failed',
                completed_at = $2,
                error_code = 'provider_invalid_response',
                error_message = $3
          where id = $1`,
        [
          run.id,
          nowIso,
          parsedProviderResult.error.issues[0]?.message ??
            'Invalid stored analysis provider response.',
        ],
      );
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'provider_invalid_response',
        message:
          parsedProviderResult.error.issues[0]?.message ??
          'Invalid stored analysis provider response.',
        retryable: false,
        now,
      });
    }

    const transcriptBundle = await this.loadTranscriptBundleForRun(
      job.workspaceId,
      job.meetingId,
      run.transcription_run_id,
    );

    const validated = validateAndNormalizeIntelligence({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      transcriptionRunId: run.transcription_run_id,
      extraction: parsedProviderResult.data.extraction,
      segments: transcriptBundle.segments,
      speakers: transcriptBundle.speakers,
      participants: transcriptBundle.participants,
    });

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    if (validated.quarantinedItems.length > 0) {
      await this.service.phase5.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: job.id,
        eventType: 'intelligence_evidence_quarantined',
        fencingToken: job.fencingToken,
        metadata: {
          analysis_run_id: run.id,
          quarantined_count: validated.quarantinedItems.length,
          quarantined_items: validated.quarantinedItems,
        },
      });
    }

    if (validated.totalEvidenceCount === 0) {
      const failMsg =
        'All extracted meeting intelligence items failed canonical transcript segment evidence validation.';
      await this.db.query(
        `update public.analysis_runs
            set status = 'failed',
                completed_at = $2,
                quarantined_item_count = $3,
                error_code = 'evidence_validation_failed',
                error_message = $4,
                failure_metadata = $5::jsonb
          where id = $1`,
        [
          run.id,
          nowIso,
          validated.quarantinedItems.length,
          failMsg,
          JSON.stringify({
            quarantined_items: validated.quarantinedItems,
          }),
        ],
      );

      await this.service.phase5.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: job.id,
        eventType: 'analysis_failed',
        fencingToken: job.fencingToken,
        metadata: {
          analysis_run_id: run.id,
          error_code: 'evidence_validation_failed',
          quarantined_count: validated.quarantinedItems.length,
        },
      });

      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'evidence_validation_failed',
        message: failMsg,
        retryable: false,
        now,
      });
    }

    // Clear any partial intelligence rows for THIS `analysis_run_id` only before inserting
    await this.db.query(`delete from public.intelligence_evidence where analysis_run_id = $1`, [
      run.id,
    ]);
    await this.db.query(`delete from public.meeting_risks where analysis_run_id = $1`, [run.id]);
    await this.db.query(`delete from public.meeting_commitments where analysis_run_id = $1`, [
      run.id,
    ]);
    await this.db.query(`delete from public.meeting_objections where analysis_run_id = $1`, [
      run.id,
    ]);
    await this.db.query(`delete from public.meeting_ideas where analysis_run_id = $1`, [run.id]);
    await this.db.query(`delete from public.meeting_questions where analysis_run_id = $1`, [
      run.id,
    ]);
    await this.db.query(`delete from public.meeting_facts where analysis_run_id = $1`, [run.id]);
    await this.db.query(`delete from public.meeting_action_items where analysis_run_id = $1`, [
      run.id,
    ]);
    await this.db.query(`delete from public.meeting_decisions where analysis_run_id = $1`, [
      run.id,
    ]);
    await this.db.query(`delete from public.meeting_topics where analysis_run_id = $1`, [run.id]);
    await this.db.query(`delete from public.meeting_summaries where analysis_run_id = $1`, [
      run.id,
    ]);

    const insertEvidenceList = async (
      entityType: IntelligenceEntityType,
      entityId: string,
      evidenceList: readonly NormalizedEvidenceDraft[],
    ): Promise<void> => {
      for (const ev of evidenceList) {
        await this.db.query(
          `insert into public.intelligence_evidence (
            workspace_id, meeting_id, analysis_run_id, transcription_run_id,
            entity_type, entity_id, transcript_segment_id, evidence_order,
            start_ms, end_ms, speaker_display_label, excerpt, confidence
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            job.workspaceId,
            job.meetingId,
            run.id,
            run.transcription_run_id,
            entityType,
            entityId,
            ev.transcriptSegmentId,
            ev.evidenceOrder,
            ev.startMs,
            ev.endMs,
            ev.speakerDisplayLabel,
            ev.excerpt,
            ev.confidence,
          ],
        );
      }
    };

    // 1. Insert Executive Summary
    if (validated.summary) {
      const sumRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_summaries (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          headline, tl_dr, why_meeting_happened, major_discussions,
          confirmed_decisions, next_actions, unresolved_points,
          follow_ups, claims, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8::jsonb,
          $9::jsonb, $10::jsonb, $11::jsonb,
          $12::jsonb, $13::jsonb, $14::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          validated.summary.headline,
          validated.summary.tlDr,
          validated.summary.whyMeetingHappened,
          JSON.stringify(validated.summary.majorDiscussions),
          JSON.stringify(validated.summary.confirmedDecisions),
          JSON.stringify(validated.summary.nextActions),
          JSON.stringify(validated.summary.unresolvedPoints),
          JSON.stringify(validated.summary.followUps),
          JSON.stringify(validated.summary.claims),
          validated.summary.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('summary_claim', sumRes.rows[0]!.id, validated.summary.evidence);
    }

    // 2. Insert Topics
    const topicIdByKey = new Map<string, string>();
    for (const topic of validated.topics) {
      const topRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_topics (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          sequence_no, topic_key, title, summary, keywords,
          participant_ids, speaker_labels, start_ms, end_ms, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9::text[],
          $10::uuid[], $11::text[], $12, $13, $14::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topic.sequenceNo,
          topic.topicKey,
          topic.title,
          topic.summary,
          topic.keywords,
          topic.participantIds,
          topic.speakerLabels,
          topic.startMs,
          topic.endMs,
          topic.sourceSegmentIds,
        ],
      );
      const topicId = topRes.rows[0]!.id;
      topicIdByKey.set(topic.topicKey, topicId);
      await insertEvidenceList('topic', topicId, topic.evidence);
    }

    // 3. Insert Decisions
    const decisionIdByKey = new Map<string, string>();
    for (const dec of validated.decisions) {
      const topicId = dec.topicKey ? (topicIdByKey.get(dec.topicKey) ?? null) : null;
      const decRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_decisions (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, decision_key, statement, rationale,
          status, owner_participant_id, owner_label, confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          dec.sequenceNo,
          dec.decisionKey,
          dec.statement,
          dec.rationale,
          dec.status,
          dec.ownerParticipantId,
          dec.ownerLabel,
          dec.confidence,
          dec.sourceSegmentIds,
        ],
      );
      const decId = decRes.rows[0]!.id;
      decisionIdByKey.set(dec.decisionKey, decId);
      await insertEvidenceList('decision', decId, dec.evidence);
    }

    // 4. Insert Action Items
    for (const act of validated.actionItems) {
      const topicId = act.topicKey ? (topicIdByKey.get(act.topicKey) ?? null) : null;
      const decisionId = act.decisionKey ? (decisionIdByKey.get(act.decisionKey) ?? null) : null;
      const actRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_action_items (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, decision_id, sequence_no, action_key, title,
          owner_participant_id, owner_label, due_hint, due_date,
          status, confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13::date,
          $14, $15, $16::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          decisionId,
          act.sequenceNo,
          act.actionKey,
          act.title,
          act.ownerParticipantId,
          act.ownerLabel,
          act.dueHint,
          act.dueDate,
          act.status,
          act.confidence,
          act.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('action_item', actRes.rows[0]!.id, act.evidence);
    }

    // 5. Insert Facts
    for (const fact of validated.facts) {
      const topicId = fact.topicKey ? (topicIdByKey.get(fact.topicKey) ?? null) : null;
      const factRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_facts (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, fact_key, category, label, value_text,
          unit, numeric_value, speaker_participant_id, speaker_label,
          confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          fact.sequenceNo,
          fact.factKey,
          fact.category,
          fact.label,
          fact.valueText,
          fact.unit,
          fact.numericValue,
          fact.speakerParticipantId,
          fact.speakerLabel,
          fact.confidence,
          fact.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('fact', factRes.rows[0]!.id, fact.evidence);
    }

    // 6. Insert Questions
    for (const q of validated.questions) {
      const topicId = q.topicKey ? (topicIdByKey.get(q.topicKey) ?? null) : null;
      const qRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_questions (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, question_key, question, status,
          asked_by_participant_id, asked_by_label, owner_participant_id, owner_label,
          answer_summary, confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          q.sequenceNo,
          q.questionKey,
          q.question,
          q.status,
          q.askedByParticipantId,
          q.askedByLabel,
          q.ownerParticipantId,
          q.ownerLabel,
          q.answerSummary,
          q.confidence,
          q.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('question', qRes.rows[0]!.id, q.evidence);
    }

    // 7. Insert Ideas
    for (const idea of validated.ideas) {
      const topicId = idea.topicKey ? (topicIdByKey.get(idea.topicKey) ?? null) : null;
      const ideaRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_ideas (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, idea_key, idea, notes, status,
          proposed_by_participant_id, proposed_by_label, confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          idea.sequenceNo,
          idea.ideaKey,
          idea.idea,
          idea.notes,
          idea.status,
          idea.proposedByParticipantId,
          idea.proposedByLabel,
          idea.confidence,
          idea.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('idea', ideaRes.rows[0]!.id, idea.evidence);
    }

    // 8. Insert Objections
    for (const obj of validated.objections) {
      const topicId = obj.topicKey ? (topicIdByKey.get(obj.topicKey) ?? null) : null;
      const objRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_objections (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, objection_key, summary, status,
          raised_by_participant_id, raised_by_label, response_summary,
          confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          obj.sequenceNo,
          obj.objectionKey,
          obj.summary,
          obj.status,
          obj.raisedByParticipantId,
          obj.raisedByLabel,
          obj.responseSummary,
          obj.confidence,
          obj.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('objection', objRes.rows[0]!.id, obj.evidence);
    }

    // 9. Insert Commitments
    for (const com of validated.commitments) {
      const topicId = com.topicKey ? (topicIdByKey.get(com.topicKey) ?? null) : null;
      const comRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_commitments (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, commitment_key, commitment,
          owner_participant_id, owner_label, counterparty_label, due_label,
          status, confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          com.sequenceNo,
          com.commitmentKey,
          com.commitment,
          com.ownerParticipantId,
          com.ownerLabel,
          com.counterpartyLabel,
          com.dueLabel,
          com.status,
          com.confidence,
          com.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('commitment', comRes.rows[0]!.id, com.evidence);
    }

    // 10. Insert Risks
    for (const risk of validated.risks) {
      const topicId = risk.topicKey ? (topicIdByKey.get(risk.topicKey) ?? null) : null;
      const riskRes = await this.db.query<{ id: string }>(
        `insert into public.meeting_risks (
          workspace_id, meeting_id, analysis_run_id, transcription_run_id,
          topic_id, sequence_no, risk_key, title, detail,
          severity, status, mitigation, owner_participant_id, owner_label,
          confidence, source_segment_ids
        )
        values (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16::uuid[]
        )
        returning id`,
        [
          job.workspaceId,
          job.meetingId,
          run.id,
          run.transcription_run_id,
          topicId,
          risk.sequenceNo,
          risk.riskKey,
          risk.title,
          risk.detail,
          risk.severity,
          risk.status,
          risk.mitigation,
          risk.ownerParticipantId,
          risk.ownerLabel,
          risk.confidence,
          risk.sourceSegmentIds,
        ],
      );
      await insertEvidenceList('risk', riskRes.rows[0]!.id, risk.evidence);
    }

    // Update counts on `analysis_runs`
    await this.db.query(
      `update public.analysis_runs
          set topic_count = $2,
              decision_count = $3,
              action_item_count = $4,
              fact_count = $5,
              question_count = $6,
              idea_count = $7,
              objection_count = $8,
              commitment_count = $9,
              risk_count = $10,
              evidence_count = $11,
              quarantined_item_count = $12,
              token_usage_metadata = coalesce(token_usage_metadata, '{}'::jsonb) || $13::jsonb
        where id = $1`,
      [
        run.id,
        validated.topics.length,
        validated.decisions.length,
        validated.actionItems.length,
        validated.facts.length,
        validated.questions.length,
        validated.ideas.length,
        validated.objections.length,
        validated.commitments.length,
        validated.risks.length,
        validated.totalEvidenceCount,
        validated.quarantinedItems.length,
        JSON.stringify({
          normalized_at: nowIso,
          quarantined_items: validated.quarantinedItems,
        }),
      ],
    );

    const finGen = run.run_number;
    const finKey = buildCanonicalFinalizeAnalysisJobIdempotencyKey(run.id, finGen);
    const finJobRes = await this.db.query<DbJobPhase6Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation,
        idempotency_key, status, scheduled_at, payload
      )
      values ($1, $2, $3, 'finalize_analysis', $4, $5, 'queued', $6, $7::jsonb)
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
          analysis_run_id: run.id,
          transcription_run_id: run.transcription_run_id,
        }),
      ],
    );

    if (finJobRes.rows[0]) {
      await this.service.phase5.phase4.recordProcessingEvent({
        workspaceId: job.workspaceId,
        meetingId: job.meetingId,
        recordingId: job.recordingId,
        processingJobId: finJobRes.rows[0].id,
        eventType: 'job_created',
        fencingToken: job.fencingToken,
        metadata: {
          job_type: 'finalize_analysis',
          analysis_run_id: run.id,
        },
      });
    }

    await this.service.phase5.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'intelligence_normalized',
      fencingToken: job.fencingToken,
      metadata: {
        analysis_run_id: run.id,
        topic_count: validated.topics.length,
        decision_count: validated.decisions.length,
        action_item_count: validated.actionItems.length,
        fact_count: validated.facts.length,
        question_count: validated.questions.length,
        idea_count: validated.ideas.length,
        objection_count: validated.objections.length,
        commitment_count: validated.commitments.length,
        risk_count: validated.risks.length,
        evidence_count: validated.totalEvidenceCount,
        quarantined_item_count: validated.quarantinedItems.length,
      },
    });

    return this.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        stage: 'normalize_intelligence',
        analysis_run_id: run.id,
        evidence_count: validated.totalEvidenceCount,
        quarantined_item_count: validated.quarantinedItems.length,
      },
      { now },
    );
  }

  /**
   * Stage 3: `finalize_analysis`
   * Seals the `analysis_runs` row (`status = 'completed'`, making it immutable via DB trigger),
   * switches `meetings.current_analysis_run_id` atomically, and transitions the meeting to
   * product-level `ready`.
   */
  async executeClaimedFinalizeAnalysisJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase6JobOptions = {},
  ): Promise<ProcessingJobDto> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    await this.assertActiveJobLease(workerId, job.id, job.fencingToken, nowIso);

    const analysisRunId =
      typeof job.payload.analysis_run_id === 'string' ? job.payload.analysis_run_id : '';
    if (!analysisRunId) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'missing_analysis_run_id',
        message: 'finalize_analysis job payload is missing analysis_run_id.',
        retryable: false,
        now,
      });
    }

    const runRes = await this.db.query<DbAnalysisRunRow>(
      `select * from public.analysis_runs where id = $1 and workspace_id = $2`,
      [analysisRunId, job.workspaceId],
    );
    const run = runRes.rows[0];
    if (!run) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'analysis_run_not_found',
        message: `Analysis run ${analysisRunId} was not found.`,
        retryable: false,
        now,
      });
    }

    const evCountRes = await this.db.query<{ cnt: string | number }>(
      `select count(*) as cnt
         from public.intelligence_evidence
        where analysis_run_id = $1
          and workspace_id = $2`,
      [run.id, job.workspaceId],
    );
    const evCount = toNum(evCountRes.rows[0]?.cnt ?? 0);
    if (evCount === 0) {
      return this.phase4Worker.failJob(workerId, job.id, job.fencingToken, {
        code: 'empty_intelligence_evidence',
        message: 'Cannot finalize analysis: no validated intelligence evidence rows exist for run.',
        retryable: false,
        now,
      });
    }

    if (run.status !== 'completed') {
      await this.db.query(
        `update public.analysis_runs
            set status = 'completed',
                completed_at = $2
          where id = $1
            and status <> 'completed'`,
        [run.id, nowIso],
      );
    }

    await this.db.query(
      `update public.meetings
          set current_analysis_run_id = $3,
              latest_analysis_run_id = $3,
              status = 'ready',
              processing_status = 'ready'
        where id = $1
          and workspace_id = $2`,
      [job.meetingId, job.workspaceId, run.id],
    );

    await this.service.phase5.phase4.recordProcessingEvent({
      workspaceId: job.workspaceId,
      meetingId: job.meetingId,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'analysis_finalized',
      fencingToken: job.fencingToken,
      metadata: {
        analysis_run_id: run.id,
        run_number: run.run_number,
        evidence_count: evCount,
      },
    });

    return this.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        stage: 'finalize_analysis',
        analysis_run_id: run.id,
        run_number: run.run_number,
        evidence_count: evCount,
        meeting_status: 'ready',
      },
      { now },
    );
  }

  private async loadTranscriptBundleForRun(
    workspaceId: string,
    meetingId: string,
    transcriptionRunId: string,
  ) {
    const meetingRes = await this.db.query<{ created_by: string }>(
      `select created_by from public.meetings where id = $1 and workspace_id = $2`,
      [meetingId, workspaceId],
    );
    const actorUserId = meetingRes.rows[0]?.created_by;
    if (!actorUserId) {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }

    const transcript = await this.service.phase5.getMeetingTranscript(
      { userId: actorUserId },
      meetingId,
      { clientWorkspaceId: workspaceId },
    );

    const segmentsForRun = transcript.segments.filter(
      (s) => s.transcriptionRunId === transcriptionRunId && s.alignmentStatus === 'canonical',
    );

    return {
      segments: segmentsForRun,
      speakers: transcript.speakers,
      participants: transcript.participants,
    };
  }
}

export {
  MEETING_INTELLIGENCE_PIPELINE_VERSION,
  MEETING_INTELLIGENCE_PROMPT_VERSION,
  MEETING_INTELLIGENCE_SCHEMA_VERSION,
};
