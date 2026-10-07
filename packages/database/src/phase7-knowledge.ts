import {
  KNOWLEDGE_CHUNKING_VERSION,
  askWorkspaceQuestionRequestSchema,
  buildCanonicalGenerateEmbeddingsJobIdempotencyKey,
  buildCanonicalIndexKnowledgeJobIdempotencyKey,
  reindexKnowledgeRequestSchema,
  type AskAiCitationDto,
  type AskWorkspaceQuestionRequestInput,
  type AskWorkspaceQuestionResponse,
  type EmbeddingRunDto,
  type EmbeddingRunStatus,
  type IntelligenceEntityType,
  type KnowledgeChunkDto,
  type KnowledgeChunkItemSourceDto,
  type KnowledgeChunkTranscriptSourceDto,
  type KnowledgeChunkType,
  type MeetingKnowledgeStatusResponse,
  type MeetingPipelineStatus,
  type ProcessingJobDto,
  type ReindexKnowledgeRequestInput,
  type ReindexKnowledgeResponse,
} from '@suhbat/contracts';
import {
  Phase4ServiceError,
  redactObservabilityMetadata,
  type AuthenticatedPrincipal,
  type ClaimJobOptions,
  type ObservabilitySink,
  type SqlExecutor,
} from './phase4-backbone';
import {
  Phase6IntelligenceService,
  Phase6IntelligenceWorker,
  type ExecutePhase6JobOptions,
} from './phase6-intelligence';
import {
  EmbeddingProviderError,
  FakeEmbeddingProvider,
  type EmbeddingProvider,
} from './embedding-provider';
import {
  buildCanonicalKnowledgeChunks,
  type CanonicalKnowledgeChunkDraft,
} from './knowledge-pipeline';

type DbEmbeddingRunRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  recording_id: string;
  transcription_run_id: string;
  analysis_run_id: string;
  run_number: number;
  provider: string;
  model: string;
  dimensions: number;
  chunking_version: string;
  status: EmbeddingRunStatus;
  chunk_count: number;
  transcript_source_count: number;
  item_source_count: number;
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

type DbKnowledgeChunkRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  project_id: string | null;
  meeting_id: string;
  embedding_run_id: string;
  transcription_run_id: string;
  analysis_run_id: string;
  sequence_no: number;
  chunk_key: string;
  chunk_type: KnowledgeChunkType;
  title: string;
  canonical_text: string;
  content_sha256: string;
  start_ms: number;
  end_ms: number;
  speaker_labels: string[];
  participant_ids: string[];
  tags: string[];
  source_version: string;
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number;
  created_at: string;
};

type DbKnowledgeChunkTranscriptSourceRow = {
  id: string;
  knowledge_chunk_id: string;
  transcript_segment_id: string;
  sequence_no: number;
};

type DbKnowledgeChunkItemSourceRow = {
  id: string;
  knowledge_chunk_id: string;
  entity_type: IntelligenceEntityType;
  entity_id: string;
  sequence_no: number;
};

type DbJobPhase7Row = {
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

function mapEmbeddingRunRow(row: DbEmbeddingRunRow): EmbeddingRunDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    transcriptionRunId: row.transcription_run_id,
    analysisRunId: row.analysis_run_id,
    runNumber: row.run_number,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    chunkingVersion: row.chunking_version,
    status: row.status,
    chunkCount: row.chunk_count,
    transcriptSourceCount: row.transcript_source_count,
    itemSourceCount: row.item_source_count,
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

function mapJobPhase7Row(row: DbJobPhase7Row): ProcessingJobDto {
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

const QUESTION_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'what',
  'which',
  'who',
  'how',
  'are',
  'was',
  'were',
  'about',
  'our',
  'from',
  'this',
  'that',
  'bilan',
  'haqida',
  'nima',
  'qanday',
  'uchun',
  'ham',
  'bor',
  'bo',
  'yicha',
  'bo‘yicha',
  "bo'yicha",
  'что',
  'как',
  'какие',
  'для',
  'или',
  'по',
  'на',
]);

function extractSearchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’`ʻʼ]/g, "'")
    .split(/[^\p{L}\p{N}$%]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !QUESTION_STOP_WORDS.has(t));
}

function computeLexicalOverlapScore(questionTokens: string[], candidateText: string): number {
  if (questionTokens.length === 0) return 0;
  const lowerCandidate = candidateText.toLowerCase().replace(/['’`ʻʼ]/g, "'");
  let matched = 0;
  for (const qt of questionTokens) {
    if (lowerCandidate.includes(qt)) {
      matched += 1;
      continue;
    }
    if (qt.length >= 4 && lowerCandidate.includes(qt.slice(0, 4))) {
      matched += 0.65;
    }
  }
  return matched / questionTokens.length;
}

export type Phase7KnowledgeServiceOptions = {
  db?: SqlExecutor;
  phase6: Phase6IntelligenceService;
  embeddingProvider?: EmbeddingProvider;
  onEvent?: ObservabilitySink;
};

export class Phase7KnowledgeService {
  readonly db: SqlExecutor;
  readonly phase6: Phase6IntelligenceService;
  readonly embeddingProvider: EmbeddingProvider;

  constructor(options: Phase7KnowledgeServiceOptions) {
    this.db = options.db ?? options.phase6.db;
    this.phase6 = options.phase6;
    this.embeddingProvider = options.embeddingProvider ?? new FakeEmbeddingProvider();
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
  ): Promise<void> {
    const res = await this.db.query<{ role: string }>(
      `select role::text as role
         from public.workspace_members
        where workspace_id = $1
          and user_id = $2
          and membership_status = 'active'`,
      [workspaceId, userId],
    );
    if (!res.rows[0]) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'User is not an active member of the requested workspace.',
      );
    }
  }

  private async loadAuthorizedMeeting(
    userId: string,
    meetingId: string,
    clientWorkspaceId?: string,
  ): Promise<{
    id: string;
    workspace_id: string;
    company_id: string | null;
    project_id: string | null;
    title: string;
    status: MeetingPipelineStatus;
    current_transcription_run_id: string | null;
    current_analysis_run_id: string | null;
    current_embedding_run_id: string | null;
    latest_embedding_run_id: string | null;
    deleted_at: string | null;
    purge_status: string;
  }> {
    const res = await this.db.query<{
      id: string;
      workspace_id: string;
      company_id: string | null;
      project_id: string | null;
      title: string;
      status: MeetingPipelineStatus;
      current_transcription_run_id: string | null;
      current_analysis_run_id: string | null;
      current_embedding_run_id: string | null;
      latest_embedding_run_id: string | null;
      deleted_at: string | null;
      purge_status: string;
    }>(
      `select id,
              workspace_id,
              company_id,
              project_id,
              title,
              status::text as status,
              current_transcription_run_id,
              current_analysis_run_id,
              current_embedding_run_id,
              latest_embedding_run_id,
              deleted_at,
              purge_status
         from public.meetings
        where id = $1`,
      [meetingId],
    );
    const meeting = res.rows[0];
    if (!meeting || meeting.deleted_at !== null || meeting.purge_status !== 'active') {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }
    if (clientWorkspaceId && clientWorkspaceId !== meeting.workspace_id) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Meeting does not belong to the supplied workspace.',
      );
    }
    await this.assertActiveWorkspaceMembership(userId, meeting.workspace_id);
    return meeting;
  }

  /**
   * Enqueues `generate_embeddings` for a meeting with a completed `analysis_runs` row.
   */
  async enqueueGenerateEmbeddingsJob(params: {
    meetingId: string;
    analysisRunId?: string;
    generation?: number;
    actorId?: string | null;
  }): Promise<{ job: ProcessingJobDto; idempotentReused: boolean }> {
    const meetingRes = await this.db.query<{
      id: string;
      workspace_id: string;
      status: string;
      current_analysis_run_id: string | null;
      deleted_at: string | null;
      purge_status: string;
    }>(
      `select id, workspace_id, status::text as status, current_analysis_run_id, deleted_at, purge_status
         from public.meetings
        where id = $1`,
      [params.meetingId],
    );
    const meeting = meetingRes.rows[0];
    if (!meeting || meeting.deleted_at !== null || meeting.purge_status !== 'active') {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
    }

    const targetAnalysisRunId = params.analysisRunId ?? meeting.current_analysis_run_id;
    if (!targetAnalysisRunId) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot generate embeddings before meeting intelligence is finalized.',
      );
    }

    const arRes = await this.db.query<{
      id: string;
      recording_id: string;
      transcription_run_id: string;
      status: string;
    }>(
      `select id, recording_id, transcription_run_id, status::text as status
         from public.analysis_runs
        where id = $1 and meeting_id = $2 and workspace_id = $3`,
      [targetAnalysisRunId, meeting.id, meeting.workspace_id],
    );
    const analysisRun = arRes.rows[0];
    if (!analysisRun || analysisRun.status !== 'completed') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Referenced analysis run is not in completed status.',
      );
    }

    const generation = params.generation ?? 1;
    const idempotencyKey = buildCanonicalGenerateEmbeddingsJobIdempotencyKey(
      analysisRun.id,
      generation,
    );

    const existingRes = await this.db.query<DbJobPhase7Row>(
      `select *
         from public.processing_jobs
        where idempotency_key = $1
           or (meeting_id = $2 and recording_id = $3 and job_type = 'generate_embeddings' and generation = $4)
        order by created_at desc
        limit 1`,
      [idempotencyKey, meeting.id, analysisRun.recording_id, generation],
    );
    if (existingRes.rows[0]) {
      return {
        job: mapJobPhase7Row(existingRes.rows[0]),
        idempotentReused: true,
      };
    }

    const insertRes = await this.db.query<DbJobPhase7Row>(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation, idempotency_key,
        status, max_attempts, payload
      )
      values ($1, $2, $3, 'generate_embeddings', $4, $5, 'queued', 3, $6::jsonb)
      on conflict do nothing
      returning *`,
      [
        meeting.workspace_id,
        meeting.id,
        analysisRun.recording_id,
        generation,
        idempotencyKey,
        JSON.stringify({
          analysis_run_id: analysisRun.id,
          transcription_run_id: analysisRun.transcription_run_id,
          generation,
        }),
      ],
    );
    const job = insertRes.rows[0];
    if (!job) {
      const racedRes = await this.db.query<DbJobPhase7Row>(
        `select *
           from public.processing_jobs
          where idempotency_key = $1
             or (meeting_id = $2 and recording_id = $3 and job_type = 'generate_embeddings' and generation = $4)
          order by created_at desc
          limit 1`,
        [idempotencyKey, meeting.id, analysisRun.recording_id, generation],
      );
      return {
        job: mapJobPhase7Row(racedRes.rows[0]!),
        idempotentReused: true,
      };
    }

    await this.phase6.phase5.phase4.recordProcessingEvent({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: analysisRun.recording_id,
      processingJobId: job.id,
      eventType: 'job_created',
      actorId: params.actorId ?? null,
      metadata: {
        job_type: 'generate_embeddings',
        analysis_run_id: analysisRun.id,
        generation,
      },
    });

    return {
      job: mapJobPhase7Row(job),
      idempotentReused: false,
    };
  }

  /**
   * Re-indexes a meeting's knowledge chunks (`POST /api/v1/meetings/{meetingId}/knowledge/reindex`).
   */
  async reindexMeetingKnowledge(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    rawInput: ReindexKnowledgeRequestInput = {},
  ): Promise<ReindexKnowledgeResponse> {
    const auth = this.requireAuth(authInput);
    const parsed = reindexKnowledgeRequestSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid knowledge reindex request.',
      );
    }

    const meeting = await this.loadAuthorizedMeeting(
      auth.userId,
      meetingId,
      parsed.data.workspaceId,
    );

    if (!meeting.current_analysis_run_id) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Meeting does not have a finalized intelligence run to index.',
      );
    }

    const activeJobRes = await this.db.query<DbJobPhase7Row>(
      `select *
         from public.processing_jobs
        where meeting_id = $1
          and workspace_id = $2
          and job_type in ('generate_embeddings', 'index_knowledge')
          and status in ('queued', 'running', 'retryable_failed')
        order by created_at desc
        limit 1`,
      [meeting.id, meeting.workspace_id],
    );
    if (activeJobRes.rows[0]) {
      return {
        meetingId: meeting.id,
        workspaceId: meeting.workspace_id,
        analysisRunId: meeting.current_analysis_run_id,
        job: mapJobPhase7Row(activeJobRes.rows[0]),
        idempotentReused: true,
      };
    }

    const maxGenRes = await this.db.query<{ max_gen: number | null }>(
      `select coalesce(max(generation), 0)::int as max_gen
         from public.processing_jobs
        where meeting_id = $1
          and job_type = 'generate_embeddings'`,
      [meeting.id],
    );
    const maxRunRes = await this.db.query<{ max_run: number | null }>(
      `select coalesce(max(run_number), 0)::int as max_run
         from public.embedding_runs
        where meeting_id = $1`,
      [meeting.id],
    );
    const nextGeneration =
      Math.max(maxGenRes.rows[0]?.max_gen ?? 0, maxRunRes.rows[0]?.max_run ?? 0) + 1;

    const { job, idempotentReused } = await this.enqueueGenerateEmbeddingsJob({
      meetingId: meeting.id,
      analysisRunId: meeting.current_analysis_run_id,
      generation: nextGeneration,
      actorId: auth.userId,
    });

    await this.phase6.phase5.phase4.recordProcessingEvent({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: job.recordingId,
      processingJobId: job.id,
      eventType: 'knowledge_reindexed',
      actorId: auth.userId,
      metadata: {
        generation: nextGeneration,
        reason: parsed.data.reason ?? 'user_requested',
      },
    });

    return {
      meetingId: meeting.id,
      workspaceId: meeting.workspace_id,
      analysisRunId: meeting.current_analysis_run_id,
      job,
      idempotentReused,
    };
  }

  /**
   * Returns embedding runs, indexed knowledge chunks, and Phase 7 jobs for a meeting (`GET /api/v1/meetings/{meetingId}/knowledge`).
   */
  async getMeetingKnowledgeStatus(
    authInput: AuthenticatedPrincipal | null | undefined,
    meetingId: string,
    options: { clientWorkspaceId?: string } = {},
  ): Promise<MeetingKnowledgeStatusResponse> {
    const auth = this.requireAuth(authInput);
    const meeting = await this.loadAuthorizedMeeting(
      auth.userId,
      meetingId,
      options.clientWorkspaceId,
    );

    const [runsRes, jobsRes] = await Promise.all([
      this.db.query<DbEmbeddingRunRow>(
        `select *
           from public.embedding_runs
          where meeting_id = $1
            and workspace_id = $2
          order by run_number asc, created_at asc`,
        [meeting.id, meeting.workspace_id],
      ),
      this.db.query<DbJobPhase7Row>(
        `select *
           from public.processing_jobs
          where meeting_id = $1
            and workspace_id = $2
            and job_type in ('generate_embeddings', 'index_knowledge')
          order by created_at asc`,
        [meeting.id, meeting.workspace_id],
      ),
    ]);

    const targetRunId = meeting.current_embedding_run_id ?? meeting.latest_embedding_run_id;
    let chunks: KnowledgeChunkDto[] = [];

    if (targetRunId) {
      const [chunksRes, trSourcesRes, itemSourcesRes] = await Promise.all([
        this.db.query<DbKnowledgeChunkRow>(
          `select id, workspace_id, company_id, project_id, meeting_id, embedding_run_id,
                  transcription_run_id, analysis_run_id, sequence_no, chunk_key, chunk_type,
                  title, canonical_text, content_sha256, start_ms, end_ms, speaker_labels,
                  participant_ids, tags, source_version, embedding_provider, embedding_model,
                  embedding_dimensions, created_at
             from public.knowledge_chunks
            where meeting_id = $1
              and workspace_id = $2
              and embedding_run_id = $3
            order by sequence_no asc`,
          [meeting.id, meeting.workspace_id, targetRunId],
        ),
        this.db.query<DbKnowledgeChunkTranscriptSourceRow>(
          `select id, knowledge_chunk_id, transcript_segment_id, sequence_no
             from public.knowledge_chunk_transcript_sources
            where meeting_id = $1
              and workspace_id = $2
              and embedding_run_id = $3
            order by sequence_no asc`,
          [meeting.id, meeting.workspace_id, targetRunId],
        ),
        this.db.query<DbKnowledgeChunkItemSourceRow>(
          `select id, knowledge_chunk_id, entity_type, entity_id, sequence_no
             from public.knowledge_chunk_item_sources
            where meeting_id = $1
              and workspace_id = $2
              and embedding_run_id = $3
            order by sequence_no asc`,
          [meeting.id, meeting.workspace_id, targetRunId],
        ),
      ]);

      const trByChunk = new Map<string, KnowledgeChunkTranscriptSourceDto[]>();
      for (const r of trSourcesRes.rows) {
        const list = trByChunk.get(r.knowledge_chunk_id) ?? [];
        list.push({
          id: r.id,
          knowledgeChunkId: r.knowledge_chunk_id,
          transcriptSegmentId: r.transcript_segment_id,
          sequenceNo: r.sequence_no,
        });
        trByChunk.set(r.knowledge_chunk_id, list);
      }

      const itemByChunk = new Map<string, KnowledgeChunkItemSourceDto[]>();
      for (const r of itemSourcesRes.rows) {
        const list = itemByChunk.get(r.knowledge_chunk_id) ?? [];
        list.push({
          id: r.id,
          knowledgeChunkId: r.knowledge_chunk_id,
          entityType: r.entity_type,
          entityId: r.entity_id,
          sequenceNo: r.sequence_no,
        });
        itemByChunk.set(r.knowledge_chunk_id, list);
      }

      chunks = chunksRes.rows.map((c) => ({
        id: c.id,
        workspaceId: c.workspace_id,
        companyId: c.company_id,
        projectId: c.project_id,
        meetingId: c.meeting_id,
        embeddingRunId: c.embedding_run_id,
        transcriptionRunId: c.transcription_run_id,
        analysisRunId: c.analysis_run_id,
        sequenceNo: c.sequence_no,
        chunkKey: c.chunk_key,
        chunkType: c.chunk_type,
        title: c.title,
        canonicalText: c.canonical_text,
        contentSha256: c.content_sha256,
        startMs: c.start_ms,
        endMs: c.end_ms,
        speakerLabels: c.speaker_labels ?? [],
        participantIds: c.participant_ids ?? [],
        tags: c.tags ?? [],
        sourceVersion: c.source_version,
        embeddingProvider: c.embedding_provider,
        embeddingModel: c.embedding_model,
        embeddingDimensions: c.embedding_dimensions,
        transcriptSources: trByChunk.get(c.id) ?? [],
        itemSources: itemByChunk.get(c.id) ?? [],
        createdAt: toIsoString(c.created_at),
      }));
    }

    return {
      meetingId: meeting.id,
      workspaceId: meeting.workspace_id,
      meetingStatus: meeting.status,
      currentEmbeddingRunId: meeting.current_embedding_run_id,
      latestEmbeddingRunId: meeting.latest_embedding_run_id,
      runs: runsRes.rows.map(mapEmbeddingRunRow),
      chunks,
      jobs: jobsRes.rows.map(mapJobPhase7Row),
    };
  }

  /**
   * Executes a workspace/company/project/meeting-scoped Ask AI query (`POST /api/v1/workspaces/{workspaceId}/ask`).
   *
   * Security & Retrieval Invariants (`docs/ai-pipeline.md` §264-266, `docs/security.md` §41, §85):
   * 1. Workspace membership and optional company/project/meeting scope are authorized BEFORE any vector/DB query.
   * 2. Tombstoned/deleted meetings (`deleted_at IS NOT NULL` or `purge_status <> 'active'`) are strictly excluded.
   * 3. Vector similarity (`public.cosine_similarity`) executes inside PostgreSQL after tenant predicates.
   * 4. Relational records (`meeting_decisions`, `meeting_action_items`, `meeting_facts`, `meeting_questions`,
   *    `meeting_ideas`, `meeting_commitments`, `transcript_segments`) remain the source of truth for citations.
   */
  async askWorkspaceQuestion(
    authInput: AuthenticatedPrincipal | null | undefined,
    workspaceId: string,
    rawInput: AskWorkspaceQuestionRequestInput,
  ): Promise<AskWorkspaceQuestionResponse> {
    const auth = this.requireAuth(authInput);
    await this.assertActiveWorkspaceMembership(auth.userId, workspaceId);

    const parsed = askWorkspaceQuestionRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid Ask AI question payload.',
      );
    }
    const input = parsed.data;
    const companyId = input.companyId ?? null;
    const projectId = input.projectId ?? null;
    const meetingId = input.meetingId ?? null;

    // Validate optional company/project/meeting belong to the authorized workspace
    if (companyId) {
      const compRes = await this.db.query<{ workspace_id: string }>(
        `select workspace_id from public.companies where id = $1`,
        [companyId],
      );
      if (!compRes.rows[0]) {
        throw new Phase4ServiceError(404, 'not_found', 'Company was not found.');
      }
      if (compRes.rows[0].workspace_id !== workspaceId) {
        throw new Phase4ServiceError(
          403,
          'cross_workspace_access_denied',
          'Company does not belong to the authorized workspace.',
        );
      }
    }

    if (projectId) {
      const projRes = await this.db.query<{ workspace_id: string }>(
        `select workspace_id from public.projects where id = $1`,
        [projectId],
      );
      if (!projRes.rows[0]) {
        throw new Phase4ServiceError(404, 'not_found', 'Project was not found.');
      }
      if (projRes.rows[0].workspace_id !== workspaceId) {
        throw new Phase4ServiceError(
          403,
          'cross_workspace_access_denied',
          'Project does not belong to the authorized workspace.',
        );
      }
    }

    if (meetingId) {
      await this.loadAuthorizedMeeting(auth.userId, meetingId, workspaceId);
    }

    // Ensure any ready meetings in this workspace with finalized intelligence but no current embedding run are indexed
    const unindexedRes = await this.db.query<{ id: string; current_analysis_run_id: string }>(
      `select id, current_analysis_run_id
         from public.meetings
        where workspace_id = $1
          and status = 'ready'
          and deleted_at is null
          and purge_status = 'active'
          and current_analysis_run_id is not null
          and current_embedding_run_id is null`,
      [workspaceId],
    );
    if (unindexedRes.rows.length > 0) {
      const tempWorker = new Phase7KnowledgeWorker(this);
      for (const m of unindexedRes.rows) {
        await this.enqueueGenerateEmbeddingsJob({
          meetingId: m.id,
          analysisRunId: m.current_analysis_run_id,
        });
      }
      await tempWorker.runUntilIdle('worker-phase7-autoindex');
    }

    // 1. Embed the question using the configured EmbeddingProvider
    const embedRes = await this.embeddingProvider.embedTexts({
      workspaceId,
      texts: [input.question],
    });
    const queryEmbedding = embedRes.embeddings[0]!;

    // 2. Query knowledge_chunks in PostgreSQL with workspace, scope, tombstone, and current_embedding_run predicates
    const candidateRowsRes = await this.db.query<{
      id: string;
      meeting_id: string;
      meeting_title: string;
      meeting_created_at: string;
      chunk_type: KnowledgeChunkType;
      title: string;
      canonical_text: string;
      start_ms: number;
      end_ms: number;
      speaker_labels: string[];
      tags: string[];
      vector_score: number | string;
    }>(
      `select kc.id,
              kc.meeting_id,
              m.title as meeting_title,
              m.created_at as meeting_created_at,
              kc.chunk_type,
              kc.title,
              kc.canonical_text,
              kc.start_ms,
              kc.end_ms,
              kc.speaker_labels,
              kc.tags,
              public.cosine_similarity(kc.embedding, $2::double precision[]) as vector_score
         from public.knowledge_chunks kc
         join public.meetings m
           on m.id = kc.meeting_id
          and m.workspace_id = kc.workspace_id
        where kc.workspace_id = $1
          and m.deleted_at is null
          and m.purge_status = 'active'
          and m.status = 'ready'
          and kc.embedding_run_id = m.current_embedding_run_id
          and kc.embedding_dimensions = $3
          and ($4::uuid is null or kc.company_id = $4::uuid)
          and ($5::uuid is null or kc.project_id = $5::uuid)
          and ($6::uuid is null or kc.meeting_id = $6::uuid)
        order by vector_score desc, kc.sequence_no asc
        limit 60`,
      [workspaceId, queryEmbedding, queryEmbedding.length, companyId, projectId, meetingId],
    );

    const questionTokens = extractSearchTokens(input.question);
    const lowerQ = input.question.toLowerCase();

    // Detect intent to boost authoritative relational chunk types (docs/ai-pipeline.md §264)
    const wantsDecision =
      /\b(decision|qaror|kelish|решен|договор|agreed|approved|budget|byudjet|бюджет)\b/iu.test(
        lowerQ,
      );
    const wantsTask =
      /\b(task|vazifa|topshiriq|задач|action|who|kim|mas'ul|deadline|muddat|due|zimma)\b/iu.test(
        lowerQ,
      );
    const wantsFact =
      /\b(fact|metric|conversion|forecast|revenue|how much|qancha|сколько|budget|byudjet|team size|percent|%|\$)\b/iu.test(
        lowerQ,
      );
    const wantsObjectionOrRisk =
      /\b(objection|e'tiroz|возражен|risk|xavf|риск|concern|xavotir|blocker|bojxona|sla|problem|muammo)\b/iu.test(
        lowerQ,
      );
    const wantsQuestion = /\b(question|savol|вопрос|unresolved|open|ochiq)\b/iu.test(lowerQ);

    const scoredCandidates = candidateRowsRes.rows
      .map((row) => {
        const vectorScore =
          typeof row.vector_score === 'number'
            ? row.vector_score
            : Number.parseFloat(String(row.vector_score));
        const lexicalScore = computeLexicalOverlapScore(
          questionTokens,
          `${row.title} ${row.canonical_text} ${(row.tags ?? []).join(' ')}`,
        );

        let relationalBonus = 0;
        if (row.chunk_type !== 'transcript' && row.chunk_type !== 'summary') {
          relationalBonus += 0.08;
        }
        if (wantsDecision && row.chunk_type === 'decision') relationalBonus += 0.22;
        if (wantsTask && row.chunk_type === 'action_item') relationalBonus += 0.22;
        if (wantsFact && row.chunk_type === 'fact') relationalBonus += 0.22;
        if (wantsObjectionOrRisk && (row.chunk_type === 'objection' || row.chunk_type === 'risk')) {
          relationalBonus += 0.22;
        }
        if (wantsQuestion && row.chunk_type === 'question') relationalBonus += 0.22;

        const hybridScore = vectorScore * 0.55 + lexicalScore * 0.45 + relationalBonus;
        return {
          row,
          vectorScore,
          lexicalScore,
          hybridScore,
        };
      })
      .filter((item) => item.vectorScore >= 0.18 || item.lexicalScore > 0)
      .sort((a, b) => b.hybridScore - a.hybridScore);

    const maxResults = Math.min(input.limit ?? 6, 12);
    const topMatches = scoredCandidates.slice(0, maxResults);

    if (topMatches.length === 0) {
      const emptyAnswer = [
        'No verified meeting intelligence or transcript segments in the authorized scope matched this question.',
      ];
      const nowIso = new Date().toISOString();
      const logRes = await this.db.query<{ id: string }>(
        `insert into public.ask_ai_queries (
          workspace_id, company_id, project_id, meeting_id, asked_by, question,
          adapter, provider, model, retrieved_chunk_ids, citation_count, answer_payload
        )
        values ($1, $2, $3, $4, $5, $6, 'rag_pipeline', $7, $8, '{}'::uuid[], 0, $9::jsonb)
        returning id`,
        [
          workspaceId,
          companyId,
          projectId,
          meetingId,
          auth.userId,
          input.question,
          this.embeddingProvider.providerName,
          this.embeddingProvider.defaultModel,
          JSON.stringify({ answer: emptyAnswer, citations: [] }),
        ],
      );

      return {
        id: logRes.rows[0]!.id,
        workspaceId,
        companyId,
        projectId,
        meetingId,
        question: input.question,
        answer: emptyAnswer,
        citations: [],
        adapter: 'rag_pipeline',
        provider: this.embeddingProvider.providerName,
        model: this.embeddingProvider.defaultModel,
        retrievedChunkIds: [],
        generatedAt: nowIso,
        matchedKnownQuestion: false,
        notes: [
          'Searched canonical knowledge chunks and relational intelligence scoped to your authorized workspace.',
        ],
      };
    }

    // 3. Resolve normalized transcript sources and item sources for the top matched chunks
    const matchedChunkIds = topMatches.map((m) => m.row.id);
    const [trSourceRes, itemSourceRes] = await Promise.all([
      this.db.query<{
        knowledge_chunk_id: string;
        transcript_segment_id: string;
        start_ms: number;
        end_ms: number;
        text: string;
      }>(
        `select kcts.knowledge_chunk_id,
                kcts.transcript_segment_id,
                ts.start_ms,
                ts.end_ms,
                ts.text
           from public.knowledge_chunk_transcript_sources kcts
           join public.transcript_segments ts
             on ts.id = kcts.transcript_segment_id
            and ts.transcription_run_id = kcts.transcription_run_id
            and ts.meeting_id = kcts.meeting_id
            and ts.workspace_id = kcts.workspace_id
          where kcts.workspace_id = $1
            and kcts.knowledge_chunk_id = any($2::uuid[])
          order by kcts.sequence_no asc`,
        [workspaceId, matchedChunkIds],
      ),
      this.db.query<{
        knowledge_chunk_id: string;
        entity_type: IntelligenceEntityType;
        entity_id: string;
      }>(
        `select knowledge_chunk_id, entity_type, entity_id
           from public.knowledge_chunk_item_sources
          where workspace_id = $1
            and knowledge_chunk_id = any($2::uuid[])
          order by sequence_no asc`,
        [workspaceId, matchedChunkIds],
      ),
    ]);

    const segmentsByChunk = new Map<
      string,
      Array<{ id: string; startMs: number; endMs: number; text: string }>
    >();
    for (const s of trSourceRes.rows) {
      const list = segmentsByChunk.get(s.knowledge_chunk_id) ?? [];
      list.push({
        id: s.transcript_segment_id,
        startMs: s.start_ms,
        endMs: s.end_ms,
        text: s.text,
      });
      segmentsByChunk.set(s.knowledge_chunk_id, list);
    }

    const itemByChunk = new Map<string, { entityType: IntelligenceEntityType; entityId: string }>();
    for (const item of itemSourceRes.rows) {
      if (!itemByChunk.has(item.knowledge_chunk_id)) {
        itemByChunk.set(item.knowledge_chunk_id, {
          entityType: item.entity_type,
          entityId: item.entity_id,
        });
      }
    }

    const citations: AskAiCitationDto[] = [];
    const seenCitationKeys = new Set<string>();
    const answerLines: string[] = [];

    const distinctMeetings = [...new Set(topMatches.map((m) => m.row.meeting_title))];
    answerLines.push(
      `Retrieved ${topMatches.length} evidence-backed record${topMatches.length === 1 ? '' : 's'} across ${distinctMeetings.length} meeting${distinctMeetings.length === 1 ? '' : 's'} (${distinctMeetings.slice(0, 3).join('; ')}):`,
    );

    for (const match of topMatches) {
      const { row } = match;
      const segs = segmentsByChunk.get(row.id) ?? [];
      if (segs.length === 0) continue;

      const itemSource = itemByChunk.get(row.id);
      const startMs = segs[0]!.startMs;
      const endMs = segs[segs.length - 1]!.endMs;
      const segmentIds = segs.map((s) => s.id);

      let kind: AskAiCitationDto['kind'] = 'segment';
      let target: AskAiCitationDto['target'] = 'transcript';
      let citedId = segs[0]!.id;

      if (itemSource) {
        citedId = itemSource.entityId;
        switch (itemSource.entityType) {
          case 'decision':
            kind = 'decision';
            target = 'decisions';
            break;
          case 'action_item':
            kind = 'task';
            target = 'tasks';
            break;
          case 'fact':
            kind = 'fact';
            target = 'facts';
            break;
          case 'question':
            kind = 'question';
            target = 'questions';
            break;
          case 'idea':
            kind = 'idea';
            target = 'ideas';
            break;
          case 'commitment':
            kind = 'commitment';
            target = 'overview';
            break;
          default:
            kind = 'segment';
            target = 'overview';
            citedId = segs[0]!.id;
            break;
        }
      }

      const citationKey = `${kind}:${citedId}`;
      if (!seenCitationKeys.has(citationKey)) {
        seenCitationKeys.add(citationKey);
        citations.push({
          kind,
          id: citedId,
          meetingId: row.meeting_id,
          meetingTitle: row.meeting_title,
          occurredAt: toIsoString(row.meeting_created_at),
          startMs,
          endMs,
          speakerNames: row.speaker_labels ?? [],
          quote: row.title,
          segmentIds,
          target,
        });
      }

      answerLines.push(`${row.canonical_text} [${row.meeting_title}]`);
    }

    const nowIso = new Date().toISOString();
    const logRes = await this.db.query<{ id: string }>(
      `insert into public.ask_ai_queries (
        workspace_id, company_id, project_id, meeting_id, asked_by, question,
        adapter, provider, model, retrieved_chunk_ids, citation_count, answer_payload
      )
      values ($1, $2, $3, $4, $5, $6, 'rag_pipeline', $7, $8, $9::uuid[], $10, $11::jsonb)
      returning id`,
      [
        workspaceId,
        companyId,
        projectId,
        meetingId,
        auth.userId,
        input.question,
        this.embeddingProvider.providerName,
        this.embeddingProvider.defaultModel,
        matchedChunkIds,
        citations.length,
        JSON.stringify({
          answer: answerLines,
          citations,
        }),
      ],
    );
    const queryId = logRes.rows[0]!.id;

    return {
      id: queryId,
      workspaceId,
      companyId,
      projectId,
      meetingId,
      question: input.question,
      answer: answerLines,
      citations,
      adapter: 'rag_pipeline',
      provider: this.embeddingProvider.providerName,
      model: this.embeddingProvider.defaultModel,
      retrievedChunkIds: matchedChunkIds,
      generatedAt: nowIso,
      matchedKnownQuestion: false,
      notes: [
        `Hybrid vector + relational retrieval (${this.embeddingProvider.providerName}/${this.embeddingProvider.defaultModel}) over workspace-scoped canonical knowledge chunks and transcript segments.`,
      ],
    };
  }
}

export type ExecutePhase7JobOptions = ExecutePhase6JobOptions & {
  afterEmbeddingProviderResponseHook?: (run: EmbeddingRunDto) => Promise<void>;
};

export class Phase7KnowledgeWorker {
  readonly service: Phase7KnowledgeService;
  readonly phase6Worker: Phase6IntelligenceWorker;

  constructor(service: Phase7KnowledgeService) {
    this.service = service;
    this.phase6Worker = new Phase6IntelligenceWorker(service.phase6);
  }

  private get db(): SqlExecutor {
    return this.service.db;
  }

  async claimNextJob(
    workerId: string,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    return this.phase6Worker.claimNextJob(workerId, options);
  }

  async executeClaimedGenerateEmbeddingsJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase7JobOptions = {},
  ): Promise<ProcessingJobDto> {
    if (job.jobType !== 'generate_embeddings') {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        `Expected generate_embeddings job, got ${job.jobType}.`,
      );
    }

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const meetingRes = await this.db.query<{
      id: string;
      workspace_id: string;
      company_id: string | null;
      project_id: string | null;
      title: string;
      current_transcription_run_id: string | null;
      current_analysis_run_id: string | null;
      created_by: string;
    }>(
      `select id, workspace_id, company_id, project_id, title,
              current_transcription_run_id, current_analysis_run_id, created_by
         from public.meetings
        where id = $1 and workspace_id = $2`,
      [job.meetingId, job.workspaceId],
    );
    const meeting = meetingRes.rows[0];
    if (!meeting) {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting not found for embedding job.');
    }

    const payloadAnalysisRunId =
      typeof job.payload.analysis_run_id === 'string'
        ? job.payload.analysis_run_id
        : meeting.current_analysis_run_id;
    if (!payloadAnalysisRunId) {
      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: 'invalid_state',
          message: 'No completed analysis_run_id available for generate_embeddings.',
          retryable: false,
          now,
        },
      );
    }

    const arRes = await this.db.query<{
      id: string;
      transcription_run_id: string;
      recording_id: string;
      status: string;
    }>(
      `select id, transcription_run_id, recording_id, status::text as status
         from public.analysis_runs
        where id = $1 and meeting_id = $2 and workspace_id = $3`,
      [payloadAnalysisRunId, meeting.id, meeting.workspace_id],
    );
    const analysisRun = arRes.rows[0];
    if (!analysisRun || analysisRun.status !== 'completed') {
      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: 'invalid_state',
          message: 'Referenced analysis run is not completed.',
          retryable: false,
          now,
        },
      );
    }

    // Create or reuse embedding_runs row for this generation
    let runRow: DbEmbeddingRunRow;
    const existingRunRes = await this.db.query<DbEmbeddingRunRow>(
      `select *
         from public.embedding_runs
        where meeting_id = $1 and run_number = $2`,
      [meeting.id, job.generation],
    );

    if (existingRunRes.rows[0]) {
      const existing = existingRunRes.rows[0];
      if (
        existing.status === 'completed' ||
        existing.status === 'failed' ||
        existing.status === 'superseded'
      ) {
        const nextNumRes = await this.db.query<{ next_num: number }>(
          `select (coalesce(max(run_number), 0) + 1)::int as next_num
             from public.embedding_runs
            where meeting_id = $1`,
          [meeting.id],
        );
        const nextNum = nextNumRes.rows[0]!.next_num;
        const createdRes = await this.db.query<DbEmbeddingRunRow>(
          `insert into public.embedding_runs (
            workspace_id, meeting_id, recording_id, transcription_run_id, analysis_run_id,
            run_number, provider, model, dimensions, chunking_version, status, started_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running', $11)
          returning *`,
          [
            meeting.workspace_id,
            meeting.id,
            analysisRun.recording_id,
            analysisRun.transcription_run_id,
            analysisRun.id,
            nextNum,
            this.service.embeddingProvider.providerName,
            this.service.embeddingProvider.defaultModel,
            this.service.embeddingProvider.dimensions,
            KNOWLEDGE_CHUNKING_VERSION,
            nowIso,
          ],
        );
        runRow = createdRes.rows[0]!;
      } else {
        const updatedRes = await this.db.query<DbEmbeddingRunRow>(
          `update public.embedding_runs
              set status = 'running',
                  started_at = coalesce(started_at, $2)
            where id = $1
            returning *`,
          [existing.id, nowIso],
        );
        runRow = updatedRes.rows[0]!;
      }
    } else {
      const createdRes = await this.db.query<DbEmbeddingRunRow>(
        `insert into public.embedding_runs (
          workspace_id, meeting_id, recording_id, transcription_run_id, analysis_run_id,
          run_number, provider, model, dimensions, chunking_version, status, started_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running', $11)
        returning *`,
        [
          meeting.workspace_id,
          meeting.id,
          analysisRun.recording_id,
          analysisRun.transcription_run_id,
          analysisRun.id,
          job.generation,
          this.service.embeddingProvider.providerName,
          this.service.embeddingProvider.defaultModel,
          this.service.embeddingProvider.dimensions,
          KNOWLEDGE_CHUNKING_VERSION,
          nowIso,
        ],
      );
      runRow = createdRes.rows[0]!;
    }

    await this.db.query(
      `update public.meetings
          set latest_embedding_run_id = $3
        where id = $1 and workspace_id = $2`,
      [meeting.id, meeting.workspace_id, runRow.id],
    );

    // Crash recovery check: if provider_completed_at is already set on this run, skip calling provider again!
    if (
      runRow.provider_completed_at &&
      Array.isArray((runRow.raw_provider_response as { drafts?: unknown }).drafts) &&
      Array.isArray((runRow.raw_provider_response as { embeddings?: unknown }).embeddings)
    ) {
      await this.enqueueIndexKnowledgeJob({
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        recordingId: analysisRun.recording_id,
        embeddingRunId: runRow.id,
        generation: runRow.run_number,
      });

      return this.phase6Worker.phase5Worker.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          embedding_run_id: runRow.id,
          recovered_after_provider_response: true,
        },
        { now },
      );
    }

    await this.service.phase6.phase5.phase4.recordProcessingEvent({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: analysisRun.recording_id,
      processingJobId: job.id,
      eventType: 'embeddings_started',
      fencingToken: job.fencingToken,
      metadata: {
        embedding_run_id: runRow.id,
        provider: this.service.embeddingProvider.providerName,
        model: this.service.embeddingProvider.defaultModel,
        dimensions: this.service.embeddingProvider.dimensions,
      },
    });

    const [transcriptRes, intelligenceRes] = await Promise.all([
      this.service.phase6.phase5.getMeetingTranscript({ userId: meeting.created_by }, meeting.id, {
        clientWorkspaceId: meeting.workspace_id,
      }),
      this.service.phase6.getMeetingIntelligence(
        { userId: meeting.created_by },
        meeting.id,
        meeting.workspace_id,
      ),
    ]);

    const drafts = buildCanonicalKnowledgeChunks({
      meetingTitle: meeting.title,
      segments: transcriptRes.segments,
      intelligence: intelligenceRes,
    });

    if (drafts.length === 0) {
      await this.db.query(
        `update public.embedding_runs
            set status = 'failed',
                completed_at = $2,
                error_code = 'embeddings_failed',
                error_message = 'No canonical knowledge chunks could be constructed from meeting.'
          where id = $1`,
        [runRow.id, nowIso],
      );
      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: 'embeddings_failed',
          message: 'No canonical knowledge chunks could be constructed from meeting.',
          retryable: false,
          now,
        },
      );
    }

    try {
      const embedResult = await this.service.embeddingProvider.embedTexts({
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        embeddingRunId: runRow.id,
        texts: drafts.map((d) => `${d.title}\n${d.canonicalText}`),
      });

      const updatedRunRes = await this.db.query<DbEmbeddingRunRow>(
        `update public.embedding_runs
            set provider = $2,
                model = $3,
                dimensions = $4,
                provider_completed_at = $5,
                token_usage_metadata = $6::jsonb,
                raw_provider_response = $7::jsonb
          where id = $1
          returning *`,
        [
          runRow.id,
          embedResult.provider,
          embedResult.model,
          embedResult.dimensions,
          nowIso,
          JSON.stringify(embedResult.tokenUsageMetadata),
          JSON.stringify({
            drafts,
            embeddings: embedResult.embeddings,
          }),
        ],
      );
      runRow = updatedRunRes.rows[0]!;
    } catch (cause) {
      const isProviderErr = cause instanceof EmbeddingProviderError;
      const retryable = isProviderErr ? cause.retryable : false;
      const errorCode = isProviderErr ? cause.code : 'embeddings_failed';
      const errorMessage =
        cause instanceof Error ? cause.message : 'Embedding provider execution failed.';

      if (!retryable || job.attempt >= job.maxAttempts) {
        await this.db.query(
          `update public.embedding_runs
              set status = 'failed',
                  completed_at = $2,
                  error_code = $3,
                  error_message = $4
            where id = $1`,
          [runRow.id, nowIso, errorCode, errorMessage.slice(0, 500)],
        );
      }

      await this.service.phase6.phase5.phase4.recordProcessingEvent({
        workspaceId: meeting.workspace_id,
        meetingId: meeting.id,
        recordingId: analysisRun.recording_id,
        processingJobId: job.id,
        eventType: 'embeddings_failed',
        fencingToken: job.fencingToken,
        metadata: {
          embedding_run_id: runRow.id,
          error_code: errorCode,
          retryable,
        },
      });

      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: errorCode,
          message: errorMessage,
          retryable,
          now,
        },
      );
    }

    if (options.afterEmbeddingProviderResponseHook) {
      await options.afterEmbeddingProviderResponseHook(mapEmbeddingRunRow(runRow));
    }

    await this.enqueueIndexKnowledgeJob({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: analysisRun.recording_id,
      embeddingRunId: runRow.id,
      generation: runRow.run_number,
    });

    await this.service.phase6.phase5.phase4.recordProcessingEvent({
      workspaceId: meeting.workspace_id,
      meetingId: meeting.id,
      recordingId: analysisRun.recording_id,
      processingJobId: job.id,
      eventType: 'embeddings_completed',
      fencingToken: job.fencingToken,
      metadata: {
        embedding_run_id: runRow.id,
        chunk_count: drafts.length,
      },
    });

    return this.phase6Worker.phase5Worker.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        embedding_run_id: runRow.id,
        chunk_count: drafts.length,
      },
      { now },
    );
  }

  private async enqueueIndexKnowledgeJob(params: {
    workspaceId: string;
    meetingId: string;
    recordingId: string;
    embeddingRunId: string;
    generation: number;
  }): Promise<void> {
    const idempotencyKey = buildCanonicalIndexKnowledgeJobIdempotencyKey(
      params.embeddingRunId,
      params.generation,
    );
    await this.db.query(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation, idempotency_key,
        status, max_attempts, payload
      )
      values ($1, $2, $3, 'index_knowledge', $4, $5, 'queued', 3, $6::jsonb)
      on conflict do nothing`,
      [
        params.workspaceId,
        params.meetingId,
        params.recordingId,
        params.generation,
        idempotencyKey,
        JSON.stringify({
          embedding_run_id: params.embeddingRunId,
          generation: params.generation,
        }),
      ],
    );
  }

  async executeClaimedIndexKnowledgeJob(
    workerId: string,
    job: ProcessingJobDto,
    options: ExecutePhase7JobOptions = {},
  ): Promise<ProcessingJobDto> {
    if (job.jobType !== 'index_knowledge') {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        `Expected index_knowledge job, got ${job.jobType}.`,
      );
    }

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const embeddingRunId =
      typeof job.payload.embedding_run_id === 'string' ? job.payload.embedding_run_id : null;

    if (!embeddingRunId) {
      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: 'validation_failed',
          message: 'Missing embedding_run_id in index_knowledge job payload.',
          retryable: false,
          now,
        },
      );
    }

    const runRes = await this.db.query<DbEmbeddingRunRow>(
      `select *
         from public.embedding_runs
        where id = $1 and meeting_id = $2 and workspace_id = $3`,
      [embeddingRunId, job.meetingId, job.workspaceId],
    );
    const run = runRes.rows[0];
    if (!run) {
      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: 'not_found',
          message: 'Embedding run not found for index_knowledge job.',
          retryable: false,
          now,
        },
      );
    }

    const meetingRes = await this.db.query<{
      company_id: string | null;
      project_id: string | null;
    }>(
      `select company_id, project_id
         from public.meetings
        where id = $1 and workspace_id = $2`,
      [job.meetingId, job.workspaceId],
    );
    const meeting = meetingRes.rows[0]!;

    const raw = run.raw_provider_response as {
      drafts?: CanonicalKnowledgeChunkDraft[];
      embeddings?: number[][];
    };
    const drafts = raw.drafts ?? [];
    const embeddings = raw.embeddings ?? [];

    if (drafts.length === 0 || drafts.length !== embeddings.length) {
      return this.phase6Worker.phase5Worker.phase4Worker.failJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          code: 'embeddings_failed',
          message: 'Stored embedding run payload is incomplete or mismatched.',
          retryable: false,
          now,
        },
      );
    }

    // Clear any partial chunks from a previous interrupted attempt on this run
    await this.db.query(`delete from public.knowledge_chunks where embedding_run_id = $1`, [
      run.id,
    ]);

    let transcriptSourceCount = 0;
    let itemSourceCount = 0;

    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i]!;
      const vec = embeddings[i]!;

      const chunkRes = await this.db.query<{ id: string }>(
        `insert into public.knowledge_chunks (
          workspace_id, company_id, project_id, meeting_id, embedding_run_id,
          transcription_run_id, analysis_run_id, sequence_no, chunk_key, chunk_type,
          title, canonical_text, content_sha256, start_ms, end_ms, speaker_labels,
          participant_ids, tags, source_version, embedding_provider, embedding_model,
          embedding_dimensions, embedding
        )
        values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10::text::public.knowledge_chunk_type,
          $11, $12, $13, $14, $15, $16::text[],
          $17::uuid[], $18::text[], $19, $20, $21,
          $22, $23::double precision[]
        )
        returning id`,
        [
          run.workspace_id,
          meeting.company_id,
          meeting.project_id,
          run.meeting_id,
          run.id,
          run.transcription_run_id,
          run.analysis_run_id,
          draft.sequenceNo,
          draft.chunkKey,
          draft.chunkType,
          draft.title,
          draft.canonicalText,
          draft.contentSha256,
          draft.startMs,
          draft.endMs,
          draft.speakerLabels,
          draft.participantIds,
          draft.tags,
          draft.sourceVersion,
          run.provider,
          run.model,
          run.dimensions,
          vec,
        ],
      );
      const chunkId = chunkRes.rows[0]!.id;

      for (let sIdx = 0; sIdx < draft.transcriptSegmentIds.length; sIdx += 1) {
        const segId = draft.transcriptSegmentIds[sIdx]!;
        await this.db.query(
          `insert into public.knowledge_chunk_transcript_sources (
            workspace_id, meeting_id, embedding_run_id, transcription_run_id,
            knowledge_chunk_id, transcript_segment_id, sequence_no
          )
          values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            run.workspace_id,
            run.meeting_id,
            run.id,
            run.transcription_run_id,
            chunkId,
            segId,
            sIdx,
          ],
        );
        transcriptSourceCount += 1;
      }

      for (let itemIdx = 0; itemIdx < draft.itemSources.length; itemIdx += 1) {
        const item = draft.itemSources[itemIdx]!;
        await this.db.query(
          `insert into public.knowledge_chunk_item_sources (
            workspace_id, meeting_id, embedding_run_id, analysis_run_id,
            knowledge_chunk_id, entity_type, entity_id, sequence_no
          )
          values ($1, $2, $3, $4, $5, $6::text::public.intelligence_entity_type, $7, $8)`,
          [
            run.workspace_id,
            run.meeting_id,
            run.id,
            run.analysis_run_id,
            chunkId,
            item.entityType,
            item.entityId,
            itemIdx,
          ],
        );
        itemSourceCount += 1;
      }
    }

    if (run.status !== 'completed') {
      await this.db.query(
        `update public.embedding_runs
            set status = 'completed',
                chunk_count = $2,
                transcript_source_count = $3,
                item_source_count = $4,
                completed_at = $5
          where id = $1`,
        [run.id, drafts.length, transcriptSourceCount, itemSourceCount, nowIso],
      );
    }

    await this.db.query(
      `update public.meetings
          set current_embedding_run_id = $3,
              latest_embedding_run_id = $3
        where id = $1 and workspace_id = $2`,
      [run.meeting_id, run.workspace_id, run.id],
    );

    await this.service.phase6.phase5.phase4.recordProcessingEvent({
      workspaceId: run.workspace_id,
      meetingId: run.meeting_id,
      recordingId: run.recording_id,
      processingJobId: job.id,
      eventType: 'knowledge_indexed',
      fencingToken: job.fencingToken,
      metadata: {
        embedding_run_id: run.id,
        chunk_count: drafts.length,
        transcript_source_count: transcriptSourceCount,
        item_source_count: itemSourceCount,
      },
    });

    return this.phase6Worker.phase5Worker.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        embedding_run_id: run.id,
        chunk_count: drafts.length,
        transcript_source_count: transcriptSourceCount,
        item_source_count: itemSourceCount,
      },
      { now },
    );
  }

  async runNextJob(
    workerId: string,
    options: ExecutePhase7JobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    // Auto-enqueue analyze_meeting for any transcript_ready meeting
    const readyForAnalysisRes = await this.db.query<{
      id: string;
      current_transcription_run_id: string | null;
    }>(
      `select id, current_transcription_run_id
         from public.meetings
        where status = 'transcript_ready'
          and deleted_at is null
          and purge_status = 'active'
          and current_transcription_run_id is not null
        order by updated_at asc`,
    );
    for (const m of readyForAnalysisRes.rows) {
      if (m.current_transcription_run_id) {
        await this.service.phase6.enqueueAnalyzeMeetingJob({
          meetingId: m.id,
          transcriptionRunId: m.current_transcription_run_id,
        });
      }
    }

    // Auto-enqueue generate_embeddings for any ready meeting with current_analysis_run_id and no current_embedding_run_id
    const readyForEmbeddingsRes = await this.db.query<{
      id: string;
      current_analysis_run_id: string | null;
    }>(
      `select id, current_analysis_run_id
         from public.meetings
        where status = 'ready'
          and deleted_at is null
          and purge_status = 'active'
          and current_analysis_run_id is not null
          and current_embedding_run_id is null
        order by updated_at asc`,
    );
    for (const m of readyForEmbeddingsRes.rows) {
      if (m.current_analysis_run_id) {
        await this.service.enqueueGenerateEmbeddingsJob({
          meetingId: m.id,
          analysisRunId: m.current_analysis_run_id,
        });
      }
    }

    const job = await this.claimNextJob(workerId, options);
    if (!job) return null;

    switch (job.jobType) {
      case 'generate_embeddings':
        return this.executeClaimedGenerateEmbeddingsJob(workerId, job, options);
      case 'index_knowledge':
        return this.executeClaimedIndexKnowledgeJob(workerId, job, options);
      default:
        return this.phase6Worker.executeClaimedJob(workerId, job, options);
    }
  }

  async runUntilIdle(
    workerId: string,
    options: ExecutePhase7JobOptions & { maxJobs?: number } = {},
  ): Promise<ProcessingJobDto[]> {
    const maxJobs = options.maxJobs ?? 100;
    const completed: ProcessingJobDto[] = [];
    for (let i = 0; i < maxJobs; i += 1) {
      const result = await this.runNextJob(workerId, options);
      if (!result) break;
      completed.push(result);
    }
    return completed;
  }
}
