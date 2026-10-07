import {
  RepositoryError,
  disabledWriteActions,
  filterKnowledge,
  filterMeetings,
  filterTasks,
  readTranscriptWindowRequest,
  routes,
  windowTranscript,
  type AskAiAnswer,
  type AskAiCitation,
  type Commitment,
  type Company,
  type CompanyIntelligence,
  type CompanyOverview,
  type DataCapabilities,
  type DashboardSnapshot,
  type Decision,
  type EvidenceRef,
  type Fact,
  type FactCategory,
  type Idea,
  type KnowledgeEntry,
  type KnowledgeFilter,
  type LanguageCode,
  type MeetingDetail,
  type MeetingFilter,
  type MeetingListRow,
  type MeetingScope,
  type MeetingSummary,
  type MeetingTranscript,
  type MeetingType,
  type Participant,
  type ProcessingTimeline,
  type ProductRepositories,
  type Project,
  type ProjectOverview,
  type Question,
  type SearchHit,
  type SettingsSnapshot,
  type SpeakerMapping,
  type SpeakerMappingCommit,
  type Task,
  type TaskFilter,
  type Topic,
  type TranscriptSegment,
  type TranscriptWindow,
  type TranscriptWindowRequest,
  type VocabularyTerm,
  type WorkspaceMember,
  type WorkspaceMemberSetting,
  type WorkspaceSummary,
} from '@suhbat/product';
import {
  Phase4BackboneService,
  Phase4ServiceError,
  type AuthenticatedPrincipal,
} from '@suhbat/database/phase4';
import { Phase5TranscriptionService } from '@suhbat/database/phase5';
import { Phase6IntelligenceService } from '@suhbat/database/phase6';
import { Phase7KnowledgeService } from '@suhbat/database/phase7';
import { Phase8TelegramService } from '@suhbat/database/phase8';
import { Phase9AutomationService } from '@suhbat/database/phase9';
import {
  createTranscriptionProviderFromEnv,
  type TranscriptionProvider,
} from '@suhbat/database/transcription-provider';
import {
  createMeetingIntelligenceProviderFromEnv,
  type MeetingIntelligenceProvider,
} from '@suhbat/database/intelligence-provider';
import {
  createEmbeddingProviderFromEnv,
  type EmbeddingProvider,
} from '@suhbat/database/embedding-provider';
import {
  createTelegramBotProviderFromEnv,
  type TelegramBotProvider,
} from '@suhbat/database/telegram-provider';
import {
  createBusinessAutomationProviderFromEnv,
  type BusinessAutomationProvider,
} from '@suhbat/database/automation-provider';
import type {
  FactCategory as ContractFactCategory,
  GetMeetingIntelligenceResponse,
  GetMeetingTranscriptResponse,
  IntelligenceEvidenceDto,
} from '@suhbat/contracts';

/**
 * Live repository adapter for Phase 4, Phase 5, Phase 6 & Phase 7 (Upload, Storage, Processing Backbone,
 * Transcription & Canonical Alignment Pipeline, AI Meeting Intelligence, and Company Memory / Knowledge Indexing & Ask AI).
 *
 * Connects the product UI to the real PostgreSQL/API boundary for workspace hierarchy,
 * recording status, meeting processing state, canonical transcripts, diarized speakers,
 * speaker-to-participant mapping, structured evidence-linked meeting intelligence,
 * versioned knowledge chunks, and retrieval-backed Ask AI with canonical citations,
 * while never falling back to demo data.
 */

export const liveCapabilities: DataCapabilities = {
  mode: 'live',
  reads: 'live',
  writes: false,
  pipeline: 'live',
  demoStateTransitions: false,
  playback: 'none',
  actions: disabledWriteActions,
  persistence: 'workspace_database',
  persistenceLabel:
    'Recording sessions, verified chunk metadata, canonical transcripts, speaker mappings, AI meeting intelligence, and versioned knowledge chunks are persisted in PostgreSQL.',
  provenanceLabel:
    'Live workspace database — recording, processing, canonical transcript, AI analysis, and company memory states come from verified backend records.',
};

export const connectedLiveCapabilities: DataCapabilities = {
  ...liveCapabilities,
  writes: true,
  actions: {
    ...disabledWriteActions,
    'transcript.speakerMapping': true,
  },
};

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new RepositoryError(
      'provider_unavailable',
      'The live data adapter for this feature is not implemented yet.',
      {
        detail: method,
        hint: 'Phases 4–6 implement recording upload, verification, canonical transcription, speaker mapping, and AI meeting intelligence. Embeddings and Ask AI RAG are scheduled for Phase 7.',
      },
    ),
  );
}

function mapPhase4Error(cause: unknown, fallbackMethod: string): RepositoryError {
  if (cause instanceof RepositoryError) return cause;
  if (cause instanceof Phase4ServiceError) {
    if (cause.code === 'not_found') {
      return new RepositoryError('not_found', cause.message, { detail: fallbackMethod });
    }
    if (
      cause.code === 'unauthenticated' ||
      cause.code === 'unauthorized' ||
      cause.code === 'cross_workspace_access_denied'
    ) {
      return new RepositoryError('unauthorized', cause.message, { detail: fallbackMethod });
    }
    if (cause.code === 'validation_failed' || cause.code === 'invalid_state') {
      return new RepositoryError('validation_failed', cause.message, { detail: fallbackMethod });
    }
    return new RepositoryError('provider_unavailable', cause.message, { detail: fallbackMethod });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RepositoryError('provider_unavailable', 'Live repository read failed.', {
    detail: `${fallbackMethod}: ${message}`,
  });
}

/** One proxy per repository namespace: any property access yields a rejecting method. */
function namespace(name: string): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return () => notImplemented(`${name}.${property}`);
      },
    },
  );
}

export type LiveRepositoryContext = {
  service: Phase4BackboneService;
  phase5Service?: Phase5TranscriptionService;
  phase6Service?: Phase6IntelligenceService;
  phase7Service?: Phase7KnowledgeService;
  phase8Service?: Phase8TelegramService;
  phase9Service?: Phase9AutomationService;
  transcriptionProvider?: TranscriptionProvider;
  intelligenceProvider?: MeetingIntelligenceProvider;
  embeddingProvider?: EmbeddingProvider;
  telegramProvider?: TelegramBotProvider;
  automationProvider?: BusinessAutomationProvider;
  principal: AuthenticatedPrincipal | null;
};

type DbMeetingJoinedRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  company_name: string | null;
  project_id: string | null;
  project_name: string | null;
  meeting_type_id: string;
  meeting_type_key: string;
  meeting_type_label: string;
  title: string;
  started_at: string | null;
  created_at: string;
  created_by: string;
  timeline_duration_ms: number | null;
  active_capture_duration_ms: number | null;
};

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date().toISOString();
}

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'S';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.slice(0, 3).toUpperCase();
}

function toProductLanguageCode(lang: string): LanguageCode {
  if (lang === 'ru') return 'ru';
  if (lang === 'en') return 'en';
  if (lang === 'tr') return 'tr';
  if (lang === 'kk') return 'kk';
  return 'uz';
}

function normalizeDetectedLanguages(langs: readonly string[]): LanguageCode[] {
  const result = new Set<LanguageCode>();
  for (const lang of langs) {
    if (lang === 'uz' || lang === 'ru' || lang === 'en' || lang === 'tr' || lang === 'kk') {
      result.add(lang);
    } else if (lang === 'mixed') {
      result.add('uz');
      result.add('ru');
      result.add('en');
    }
  }
  return [...result];
}

function mapContractFactCategoryToProduct(category: ContractFactCategory): FactCategory {
  switch (category) {
    case 'budget':
    case 'commercial':
      return 'budget';
    case 'metric':
      return 'metric';
    case 'timeline':
      return 'timeline';
    case 'team':
      return 'team';
    case 'technical':
      return 'tooling';
    case 'legal':
    case 'operations':
      return 'constraint';
    case 'general':
    default:
      return 'target';
  }
}

export function createLiveRepositories(
  context?: LiveRepositoryContext | null,
): ProductRepositories {
  if (!context) {
    return createLivePlaceholderRepositories();
  }

  const { service, principal } = context;
  const phase5Service =
    context.phase5Service ??
    new Phase5TranscriptionService({
      phase4: service,
      provider: context.transcriptionProvider ?? createTranscriptionProviderFromEnv(),
    });
  const phase6Service =
    context.phase6Service ??
    new Phase6IntelligenceService({
      db: service.db,
      phase5: phase5Service,
      intelligenceProvider:
        context.intelligenceProvider ?? createMeetingIntelligenceProviderFromEnv(),
    });
  const phase7Service =
    context.phase7Service ??
    new Phase7KnowledgeService({
      db: service.db,
      phase6: phase6Service,
      embeddingProvider: context.embeddingProvider ?? createEmbeddingProviderFromEnv(),
    });
  const phase8Service =
    context.phase8Service ??
    new Phase8TelegramService({
      db: service.db,
      phase7: phase7Service,
      telegramProvider: context.telegramProvider ?? createTelegramBotProviderFromEnv(),
    });
  const phase9Service =
    context.phase9Service ??
    new Phase9AutomationService({
      db: service.db,
      phase8: phase8Service,
      automationProvider: context.automationProvider ?? createBusinessAutomationProviderFromEnv(),
    });

  async function hasPhase8Tables(): Promise<boolean> {
    try {
      const res = await service.db.query<{ reg: string | null }>(
        `select to_regclass('public.telegram_account_links')::text as reg`,
      );
      return Boolean(res.rows[0]?.reg);
    } catch {
      return false;
    }
  }

  async function hasPhase9Tables(): Promise<boolean> {
    try {
      const res = await service.db.query<{ reg: string | null }>(
        `select to_regclass('public.workspace_automation_connectors')::text as reg`,
      );
      return Boolean(res.rows[0]?.reg);
    } catch {
      return false;
    }
  }

  async function hasPhase5Tables(): Promise<boolean> {
    try {
      const res = await service.db.query<{ reg: string | null }>(
        `select to_regclass('public.transcript_segments')::text as reg`,
      );
      return Boolean(res.rows[0]?.reg);
    } catch {
      return false;
    }
  }

  async function hasPhase6Tables(): Promise<boolean> {
    try {
      const res = await service.db.query<{ reg: string | null }>(
        `select to_regclass('public.analysis_runs')::text as reg`,
      );
      return Boolean(res.rows[0]?.reg);
    } catch {
      return false;
    }
  }

  async function hasPhase7Tables(): Promise<boolean> {
    try {
      const res = await service.db.query<{ reg: string | null }>(
        `select to_regclass('public.knowledge_chunks')::text as reg`,
      );
      return Boolean(res.rows[0]?.reg);
    } catch {
      return false;
    }
  }

  async function loadTranscriptDataIfAvailable(
    meetingId: string,
  ): Promise<GetMeetingTranscriptResponse | null> {
    if (!(await hasPhase5Tables())) {
      return null;
    }
    return phase5Service.getMeetingTranscript(principal, meetingId);
  }

  async function loadIntelligenceDataIfAvailable(
    meetingId: string,
  ): Promise<GetMeetingIntelligenceResponse | null> {
    if (!(await hasPhase6Tables())) {
      return null;
    }
    return phase6Service.getMeetingIntelligence(principal, meetingId);
  }

  function buildProductParticipantsAndMappings(
    transcriptData: GetMeetingTranscriptResponse | null,
  ): {
    participants: Participant[];
    speakerMappings: SpeakerMapping[];
    unmappedSpeakers: string[];
    segments: TranscriptSegment[];
    speakerPersonBySegmentId: Map<string, string>;
  } {
    if (!transcriptData) {
      return {
        participants: [],
        speakerMappings: [],
        unmappedSpeakers: [],
        segments: [],
        speakerPersonBySegmentId: new Map(),
      };
    }

    const participantById = new Map(transcriptData.participants.map((p) => [p.id, p]));
    const participants: Participant[] = [];
    const seenParticipantIds = new Set<string>();

    for (const speaker of transcriptData.speakers) {
      if (speaker.participantId) {
        const part = participantById.get(speaker.participantId);
        if (part && !seenParticipantIds.has(part.id)) {
          seenParticipantIds.add(part.id);
          participants.push({
            personId: part.id,
            name: part.displayName,
            initials: computeInitials(part.displayName),
            kind: part.isExternal ? 'external' : 'internal',
            speakerLabel: speaker.providerSpeakerLabel,
            mapped: true,
            spokeInMeeting: speaker.segmentCount > 0,
          });
        }
      }
    }

    for (const part of transcriptData.participants) {
      if (!seenParticipantIds.has(part.id)) {
        seenParticipantIds.add(part.id);
        participants.push({
          personId: part.id,
          name: part.displayName,
          initials: computeInitials(part.displayName),
          kind: part.isExternal ? 'external' : 'internal',
          mapped: true,
          spokeInMeeting: false,
        });
      }
    }

    const speakerMappings: SpeakerMapping[] = transcriptData.speakers.map((s) => ({
      label: s.providerSpeakerLabel,
      personId: s.participantId,
      confirmed: s.participantId !== null,
      segmentCount: s.segmentCount,
    }));

    const unmappedSpeakers = transcriptData.speakers
      .filter((s) => s.participantId === null)
      .map((s) => s.providerSpeakerLabel);

    const speakerPersonBySegmentId = new Map<string, string>();
    const segments: TranscriptSegment[] = transcriptData.segments.map((seg) => {
      if (seg.participantId) {
        speakerPersonBySegmentId.set(seg.id, seg.participantId);
      }
      return {
        id: seg.id,
        meetingId: seg.meetingId,
        index: seg.sequenceNo,
        speakerPersonId: seg.participantId,
        speakerLabel: seg.providerSpeakerLabel,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
        language: toProductLanguageCode(seg.language),
        topicId: null,
        ...(seg.confidence !== null ? { confidence: seg.confidence } : {}),
      };
    });

    return {
      participants,
      speakerMappings,
      unmappedSpeakers,
      segments,
      speakerPersonBySegmentId,
    };
  }

  function mapEvidenceDtosToRefs(
    evidence: readonly IntelligenceEvidenceDto[],
    meetingMeta: { id: string; title: string; occurredAt: string },
    speakerPersonBySegmentId: Map<string, string>,
  ): EvidenceRef[] {
    return evidence.map((ev) => {
      const speakerPersonId = speakerPersonBySegmentId.get(ev.transcriptSegmentId);
      return {
        meetingId: meetingMeta.id,
        meetingTitle: meetingMeta.title,
        occurredAt: meetingMeta.occurredAt,
        startMs: ev.startMs,
        endMs: ev.endMs,
        segmentIds: [ev.transcriptSegmentId],
        speakerPersonIds: speakerPersonId ? [speakerPersonId] : [],
        quote: ev.excerpt,
      };
    });
  }

  async function buildMeetingSummaryAndDetail(meetingId: string): Promise<{
    summary: MeetingSummary;
    detail: MeetingDetail;
    processing: ProcessingTimeline;
    transcript: MeetingTranscript;
    decisions: Decision[];
    tasks: Task[];
    facts: Fact[];
    questions: Question[];
    ideas: Idea[];
    commitments: Commitment[];
    intelData: GetMeetingIntelligenceResponse | null;
    speakerPersonBySegmentId: Map<string, string>;
  }> {
    try {
      const processingInfo = await service.getMeetingProcessing(principal, meetingId);
      const meetingRes = await service.db.query<DbMeetingJoinedRow>(
        `select m.id,
                m.workspace_id,
                m.company_id,
                c.name as company_name,
                m.project_id,
                p.name as project_name,
                m.meeting_type_id,
                mt.key as meeting_type_key,
                mt.display_name as meeting_type_label,
                m.title,
                m.started_at,
                m.created_at,
                m.created_by,
                m.timeline_duration_ms,
                m.active_capture_duration_ms
           from public.meetings m
           join public.meeting_types mt
             on mt.id = m.meeting_type_id and mt.workspace_id = m.workspace_id
           left join public.companies c
             on c.id = m.company_id and c.workspace_id = m.workspace_id
           left join public.projects p
             on p.id = m.project_id and p.workspace_id = m.workspace_id
          where m.id = $1`,
        [meetingId],
      );
      const row = meetingRes.rows[0];
      if (!row) {
        throw new RepositoryError('not_found', 'Meeting was not found in this workspace.');
      }

      const [recordingDetail, transcriptData, intelData] = await Promise.all([
        processingInfo.activeRecordingId
          ? service.getRecording(principal, processingInfo.activeRecordingId, row.workspace_id)
          : Promise.resolve(null),
        loadTranscriptDataIfAvailable(meetingId),
        loadIntelligenceDataIfAvailable(meetingId),
      ]);

      const {
        participants,
        speakerMappings,
        unmappedSpeakers,
        segments,
        speakerPersonBySegmentId,
      } = buildProductParticipantsAndMappings(transcriptData);

      const durationMs =
        transcriptData && transcriptData.totalDurationMs > 0
          ? transcriptData.totalDurationMs
          : (row.timeline_duration_ms ?? recordingDetail?.recording.canonicalDurationMs ?? 0);
      const capturedMs =
        row.active_capture_duration_ms ?? recordingDetail?.recording.activeCaptureMs ?? null;
      const languages = transcriptData
        ? normalizeDetectedLanguages(transcriptData.detectedLanguages)
        : [];
      const wordCount = transcriptData?.wordCount ?? 0;
      const occurredAt = toIso(row.started_at ?? row.created_at);
      const decidedOnDate = occurredAt.slice(0, 10);
      const meetingMeta = { id: row.id, title: row.title, occurredAt };

      // Build Topics & assign topicId onto segments
      const topics: Topic[] = (intelData?.topics ?? []).map((t) => {
        const decisionIds = (intelData?.decisions ?? [])
          .filter((d) => d.topicId === t.id)
          .map((d) => d.id);
        const taskIds = (intelData?.actionItems ?? [])
          .filter((a) => a.topicId === t.id)
          .map((a) => a.id);
        const questionIds = (intelData?.questions ?? [])
          .filter((q) => q.topicId === t.id)
          .map((q) => q.id);
        const ideaIds = (intelData?.ideas ?? []).filter((i) => i.topicId === t.id).map((i) => i.id);

        return {
          id: t.id,
          workspaceId: t.workspaceId,
          meetingId: t.meetingId,
          parentId: null,
          title: t.title,
          summary: t.summary,
          keywords: t.keywords,
          startMs: t.startMs,
          endMs: t.endMs,
          participantPersonIds: t.participantIds,
          segmentIds: t.sourceSegmentIds,
          decisionIds,
          taskIds,
          questionIds,
          ideaIds,
        };
      });

      const topicIdBySegmentId = new Map<string, string>();
      for (const topic of topics) {
        for (const segId of topic.segmentIds) {
          if (!topicIdBySegmentId.has(segId)) {
            topicIdBySegmentId.set(segId, topic.id);
          }
        }
      }
      for (const seg of segments) {
        seg.topicId = topicIdBySegmentId.get(seg.id) ?? null;
      }

      const actionDecisionIds = new Set(
        (intelData?.actionItems ?? [])
          .map((a) => a.decisionId)
          .filter((id): id is string => Boolean(id)),
      );

      const decisions: Decision[] = (intelData?.decisions ?? []).map((d) => {
        const evRefs = mapEvidenceDtosToRefs(d.evidence, meetingMeta, speakerPersonBySegmentId);
        const participantPersonIds = Array.from(
          new Set([
            ...(d.ownerParticipantId ? [d.ownerParticipantId] : []),
            ...evRefs.flatMap((e) => e.speakerPersonIds),
          ]),
        );
        return {
          id: d.id,
          workspaceId: d.workspaceId,
          meetingId: d.meetingId,
          companyId: row.company_id,
          projectId: row.project_id,
          topicId: d.topicId,
          title: d.statement,
          description: d.rationale ?? d.statement,
          status: d.status,
          participantPersonIds,
          evidence: evRefs,
          decidedOn: decidedOnDate,
          supersededByDecisionId: null,
          hasFollowUpTasks: actionDecisionIds.has(d.id),
        };
      });

      const tasks: Task[] = (intelData?.actionItems ?? []).map((a) => {
        const evRefs = mapEvidenceDtosToRefs(a.evidence, meetingMeta, speakerPersonBySegmentId);
        const mappedStatus: Task['status'] =
          a.status === 'done'
            ? 'completed'
            : a.status === 'in_progress'
              ? 'in_progress'
              : a.status === 'cancelled'
                ? 'cancelled'
                : 'open';
        return {
          id: a.id,
          workspaceId: a.workspaceId,
          meetingId: a.meetingId,
          companyId: row.company_id,
          projectId: row.project_id,
          topicId: a.topicId,
          title: a.title,
          ...(a.dueHint ? { detail: `Due hint: ${a.dueHint}` } : {}),
          ownerPersonId: a.ownerParticipantId,
          ownerLabel: a.ownerLabel ?? 'Unassigned',
          dueDate: a.dueDate,
          status: mappedStatus,
          priority: 'normal',
          evidence: evRefs,
          createdAt: a.createdAt,
        };
      });

      const facts: Fact[] = (intelData?.facts ?? []).map((f) => {
        const evRefs = mapEvidenceDtosToRefs(f.evidence, meetingMeta, speakerPersonBySegmentId);
        return {
          id: f.id,
          workspaceId: f.workspaceId,
          meetingId: f.meetingId,
          companyId: row.company_id,
          projectId: row.project_id,
          category: mapContractFactCategoryToProduct(f.category),
          label: f.label,
          value: f.valueText,
          ...(f.unit ? { unit: f.unit } : {}),
          speakerPersonId: f.speakerParticipantId,
          evidence: evRefs,
          ...(f.confidence !== null ? { confidence: f.confidence } : {}),
          capturedAt: f.createdAt,
        };
      });

      const questions: Question[] = (intelData?.questions ?? []).map((q) => {
        const evRefs = mapEvidenceDtosToRefs(q.evidence, meetingMeta, speakerPersonBySegmentId);
        return {
          id: q.id,
          workspaceId: q.workspaceId,
          meetingId: q.meetingId,
          companyId: row.company_id,
          projectId: row.project_id,
          topicId: q.topicId,
          text: q.question,
          askedByPersonId: q.askedByParticipantId,
          status: q.status,
          raisedOn: decidedOnDate,
          ...(q.status === 'answered' && q.answerSummary
            ? {
                resolution: {
                  answer: q.answerSummary,
                  answeredOn: decidedOnDate,
                  answeredByPersonId: q.ownerParticipantId,
                  evidence: evRefs,
                },
              }
            : {}),
          evidence: evRefs,
        };
      });

      const ideas: Idea[] = (intelData?.ideas ?? []).map((i) => {
        const evRefs = mapEvidenceDtosToRefs(i.evidence, meetingMeta, speakerPersonBySegmentId);
        const mappedStatus: Idea['status'] =
          i.status === 'accepted'
            ? 'adopted'
            : i.status === 'rejected'
              ? 'dropped'
              : i.status === 'exploring' || i.status === 'parked'
                ? 'considering'
                : 'new';
        const fallbackPersonId =
          i.proposedByParticipantId ?? evRefs[0]?.speakerPersonIds[0] ?? row.created_by;
        return {
          id: i.id,
          workspaceId: i.workspaceId,
          meetingId: i.meetingId,
          companyId: row.company_id,
          projectId: row.project_id,
          topicId: i.topicId,
          text: i.notes ? `${i.idea} — ${i.notes}` : i.idea,
          proposedByPersonId: fallbackPersonId,
          status: mappedStatus,
          raisedOn: decidedOnDate,
          evidence: evRefs,
        };
      });

      const commitments: Commitment[] = (intelData?.commitments ?? []).map((c) => {
        const evRefs = mapEvidenceDtosToRefs(c.evidence, meetingMeta, speakerPersonBySegmentId);
        const mappedStatus: Commitment['status'] =
          c.status === 'kept' ? 'met' : c.status === 'broken' ? 'missed' : 'pending';
        const fallbackPersonId =
          c.ownerParticipantId ?? evRefs[0]?.speakerPersonIds[0] ?? row.created_by;
        return {
          id: c.id,
          workspaceId: c.workspaceId,
          meetingId: c.meetingId,
          companyId: row.company_id,
          text: c.dueLabel ? `${c.commitment} (${c.dueLabel})` : c.commitment,
          byPersonId: fallbackPersonId,
          dueDate: null,
          status: mappedStatus,
          evidence: evRefs,
        };
      });

      const summaryBullets: string[] = [];
      if (intelData?.summary) {
        const rawBullets = [
          intelData.summary.tlDr,
          intelData.summary.whyMeetingHappened,
          ...intelData.summary.majorDiscussions,
          ...intelData.summary.unresolvedPoints,
        ];
        for (const bullet of rawBullets) {
          const trimmed = bullet.trim();
          if (trimmed.length > 0 && !summaryBullets.includes(trimmed)) {
            summaryBullets.push(trimmed);
          }
        }
      }

      const summary: MeetingSummary = {
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        companyId: row.company_id,
        ...(row.company_name ? { companyName: row.company_name } : {}),
        projectId: row.project_id,
        ...(row.project_name ? { projectName: row.project_name } : {}),
        meetingTypeId: row.meeting_type_id,
        meetingTypeKey: row.meeting_type_key,
        meetingTypeLabel: row.meeting_type_label,
        occurredAt,
        durationMs,
        capturedMs,
        state: processingInfo.productState,
        languages,
        participants,
        origin: recordingDetail ? 'desktop' : 'draft',
        recordingAvailable: processingInfo.recordingAvailable,
        counts: {
          topics: topics.length,
          decisions: decisions.length,
          tasks: tasks.length,
          facts: facts.length,
          questions: questions.length,
          ideas: ideas.length,
          segments: segments.length,
        },
      };

      const recordingNote = recordingDetail
        ? processingInfo.recordingAvailable
          ? `${processingInfo.verifiedChunkCount} of ${processingInfo.totalChunkCount} chunks verified in private object storage.`
          : `${processingInfo.verifiedChunkCount} of ${processingInfo.totalChunkCount} chunks verified; recording is ${recordingDetail.recording.status}.`
        : 'No recording attached to this meeting.';

      const openTasksCount = tasks.filter(
        (t) => t.status === 'open' || t.status === 'in_progress',
      ).length;
      const confirmedDecisionsCount = decisions.filter((d) => d.status === 'confirmed').length;
      const openQuestionsCount = questions.filter((q) => q.status === 'open').length;

      const detail: MeetingDetail = {
        ...summary,
        executiveSummary: summaryBullets,
        ...(intelData?.summary?.headline ? { keyOutcome: intelData.summary.headline } : {}),
        unmappedSpeakers,
        recording: {
          available: processingInfo.recordingAvailable,
          source: processingInfo.recordingAvailable ? 'object_storage' : 'none',
          note: recordingNote,
          ...(recordingDetail ? { manifestSessionId: recordingDetail.recording.sessionId } : {}),
        },
        stats: {
          speakingParticipants: transcriptData?.speakers.length ?? 0,
          topics: topics.length,
          decisions: decisions.length,
          confirmedDecisions: confirmedDecisionsCount,
          tasks: tasks.length,
          openTasks: openTasksCount,
          questions: questions.length,
          openQuestions: openQuestionsCount,
          facts: facts.length,
          ideas: ideas.length,
          words: wordCount,
        },
        processing: processingInfo.timeline,
      };

      const transcript: MeetingTranscript = {
        meetingId: detail.id,
        segments,
        topics,
        participants,
        speakerMappings,
        totalMs: durationMs,
        wordCount,
      };

      return {
        summary,
        detail,
        processing: processingInfo.timeline,
        transcript,
        decisions,
        tasks,
        facts,
        questions,
        ideas,
        commitments,
        intelData,
        speakerPersonBySegmentId,
      };
    } catch (cause) {
      throw mapPhase4Error(cause, 'meetings.detail');
    }
  }

  async function loadScopedMeetingBundles(scope: MeetingScope) {
    if (scope.meetingId) {
      const bundle = await buildMeetingSummaryAndDetail(scope.meetingId);
      if (bundle.summary.workspaceId !== scope.workspaceId) {
        throw new RepositoryError(
          'unauthorized',
          'Meeting does not belong to the requested workspace.',
        );
      }
      return [bundle];
    }
    await workspacesRepo.get(scope.workspaceId);
    const res = await service.db.query<{ id: string }>(
      `select id
         from public.meetings
        where workspace_id = $1
          and ($2::uuid is null or company_id = $2::uuid)
          and ($3::uuid is null or project_id = $3::uuid)
          and deleted_at is null
          and purge_status = 'active'
        order by created_at desc`,
      [scope.workspaceId, scope.companyId ?? null, scope.projectId ?? null],
    );
    return Promise.all(res.rows.map((r) => buildMeetingSummaryAndDetail(r.id)));
  }

  const workspacesRepo: ProductRepositories['workspaces'] = {
    async list(): Promise<WorkspaceSummary[]> {
      if (!principal?.userId) {
        throw new RepositoryError('unauthorized', 'Authenticated user session is required.');
      }
      try {
        const res = await service.db.query<{
          id: string;
          name: string;
          slug: string;
          role: 'owner' | 'admin' | 'member';
          member_count: string | number;
        }>(
          `select w.id,
                  w.name,
                  w.slug,
                  wm.role::text as role,
                  (select count(*) from public.workspace_members m2 where m2.workspace_id = w.id and m2.membership_status = 'active') as member_count
             from public.workspaces w
             join public.workspace_members wm
               on wm.workspace_id = w.id
              and wm.user_id = $1
              and wm.membership_status = 'active'
            order by w.created_at asc`,
          [principal.userId],
        );
        return res.rows.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          role: r.role,
          memberCount:
            typeof r.member_count === 'number'
              ? r.member_count
              : Number.parseInt(r.member_count, 10),
          demo: false,
        }));
      } catch (cause) {
        throw mapPhase4Error(cause, 'workspaces.list');
      }
    },
    async get(workspaceId: string): Promise<WorkspaceSummary> {
      const list = await workspacesRepo.list();
      const found = list.find((w) => w.id === workspaceId);
      if (!found) {
        throw new RepositoryError('not_found', 'Workspace was not found.');
      }
      return found;
    },
    async currentPersonId(workspaceId: string): Promise<string | null> {
      await workspacesRepo.get(workspaceId);
      return principal?.userId ?? null;
    },
    async members(workspaceId: string): Promise<WorkspaceMember[]> {
      await workspacesRepo.get(workspaceId);
      try {
        const membersRes = await service.db.query<{
          user_id: string;
          role: 'owner' | 'admin' | 'member';
          membership_status: 'active' | 'invited' | 'disabled';
          display_name: string | null;
        }>(
          `select wm.user_id,
                  wm.role::text as role,
                  wm.membership_status::text as membership_status,
                  p.display_name
             from public.workspace_members wm
             left join public.profiles p on p.id = wm.user_id
            where wm.workspace_id = $1
            order by wm.joined_at asc`,
          [workspaceId],
        );

        const membersMap = new Map<string, WorkspaceMember>();
        for (const m of membersRes.rows) {
          const name = m.display_name?.trim() || 'Workspace Member';
          membersMap.set(m.user_id, {
            personId: m.user_id,
            name,
            role: m.role,
            status: m.membership_status,
            openTaskCount: 0,
            meetingCount: 0,
          });
        }

        if (await hasPhase5Tables()) {
          const partsRes = await service.db.query<{
            id: string;
            user_id: string | null;
            display_name: string;
            email: string | null;
          }>(
            `select id, user_id, display_name, email
               from public.meeting_participants
              where workspace_id = $1
              order by created_at asc`,
            [workspaceId],
          );
          for (const part of partsRes.rows) {
            if (!membersMap.has(part.id)) {
              membersMap.set(part.id, {
                personId: part.id,
                name: part.display_name,
                ...(part.email ? { email: part.email } : {}),
                role: 'member',
                status: 'active',
                openTaskCount: 0,
                meetingCount: 1,
              });
            }
          }
        }

        return [...membersMap.values()];
      } catch (cause) {
        throw mapPhase4Error(cause, 'workspaces.members');
      }
    },
  };

  const companiesRepo: ProductRepositories['companies'] = {
    async list(workspaceId, filter): Promise<Company[]> {
      await workspacesRepo.get(workspaceId);
      try {
        const includeArchived = filter?.includeArchived ?? false;
        const res = await service.db.query<{
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          archived_at: string | null;
          created_at: string;
        }>(
          `select id, workspace_id, name, description, archived_at, created_at
             from public.companies
            where workspace_id = $1
              and ($2::boolean or archived_at is null)
            order by name asc`,
          [workspaceId, includeArchived],
        );
        return res.rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          status: r.archived_at ? 'archived' : 'active',
          createdAt: toIso(r.created_at),
        }));
      } catch (cause) {
        throw mapPhase4Error(cause, 'companies.list');
      }
    },
    async get(companyId: string): Promise<Company> {
      try {
        const res = await service.db.query<{
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          archived_at: string | null;
          created_at: string;
        }>(
          `select id, workspace_id, name, description, archived_at, created_at
             from public.companies
            where id = $1`,
          [companyId],
        );
        const r = res.rows[0];
        if (!r) {
          throw new RepositoryError('not_found', 'Company was not found.');
        }
        await workspacesRepo.get(r.workspace_id);
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          status: r.archived_at ? 'archived' : 'active',
          createdAt: toIso(r.created_at),
        };
      } catch (cause) {
        throw mapPhase4Error(cause, 'companies.get');
      }
    },
    async overview(workspaceId, filter): Promise<CompanyOverview[]> {
      try {
        const companies = await companiesRepo.list(workspaceId, filter);
        const projects = await projectsRepo.list(workspaceId, { includeArchived: true });
        const bundles = await loadScopedMeetingBundles({ workspaceId });

        return companies.map((company) => {
          const companyBundles = bundles.filter((b) => b.summary.companyId === company.id);
          const activeProjects = projects.filter(
            (p) => p.companyId === company.id && p.status === 'active',
          );
          const openTaskCount = companyBundles.reduce(
            (sum, b) => sum + b.detail.stats.openTasks,
            0,
          );
          const decisionCount = companyBundles.reduce(
            (sum, b) => sum + b.detail.stats.decisions,
            0,
          );
          const lastMeetingAt =
            companyBundles
              .map((b) => b.summary.occurredAt)
              .sort()
              .at(-1) ?? null;

          return {
            company,
            activeProjectCount: activeProjects.length,
            meetingCount: companyBundles.length,
            openTaskCount,
            decisionCount,
            lastMeetingAt,
          };
        });
      } catch (cause) {
        throw mapPhase4Error(cause, 'companies.overview');
      }
    },
    async intelligence(companyId: string): Promise<CompanyIntelligence> {
      try {
        const company = await companiesRepo.get(companyId);
        const bundles = await loadScopedMeetingBundles({
          workspaceId: company.workspaceId,
          companyId: company.id,
        });

        const goals: CompanyIntelligence['goals'] = [];
        const painPoints: CompanyIntelligence['painPoints'] = [];
        const importantFacts: CompanyIntelligence['importantFacts'] = [];
        const decisionMakers: CompanyIntelligence['decisionMakers'] = [];
        const objections: CompanyIntelligence['objections'] = [];
        const commitments: CompanyIntelligence['commitments'] = [];

        for (const b of bundles) {
          const meetingMeta = {
            id: b.summary.id,
            title: b.summary.title,
            occurredAt: b.summary.occurredAt,
          };

          for (const d of b.decisions) {
            if (d.status === 'confirmed' || d.status === 'proposed' || d.status === 'tentative') {
              goals.push({
                text: d.title,
                personId: d.participantPersonIds[0] ?? null,
                ...(d.evidence[0] ? { evidence: d.evidence[0] } : {}),
              });
            }
            if (d.status === 'confirmed' && d.participantPersonIds[0]) {
              decisionMakers.push({
                text: d.title,
                personId: d.participantPersonIds[0],
                ...(d.evidence[0] ? { evidence: d.evidence[0] } : {}),
              });
            }
          }

          for (const f of b.facts) {
            importantFacts.push({
              text: `${f.label}: ${f.value}`,
              personId: f.speakerPersonId,
              ...(f.evidence[0] ? { evidence: f.evidence[0] } : {}),
            });
          }

          for (const c of b.commitments) {
            commitments.push({
              text: c.text,
              personId: c.byPersonId,
              ...(c.evidence[0] ? { evidence: c.evidence[0] } : {}),
            });
          }

          for (const obj of b.intelData?.objections ?? []) {
            const evRefs = mapEvidenceDtosToRefs(
              obj.evidence,
              meetingMeta,
              b.speakerPersonBySegmentId,
            );
            objections.push({
              text: obj.responseSummary ? `${obj.summary} — ${obj.responseSummary}` : obj.summary,
              personId: obj.raisedByParticipantId,
              ...(evRefs[0] ? { evidence: evRefs[0] } : {}),
            });
          }

          for (const risk of b.intelData?.risks ?? []) {
            const evRefs = mapEvidenceDtosToRefs(
              risk.evidence,
              meetingMeta,
              b.speakerPersonBySegmentId,
            );
            painPoints.push({
              text: risk.detail ? `${risk.title} — ${risk.detail}` : risk.title,
              personId: risk.ownerParticipantId,
              ...(evRefs[0] ? { evidence: evRefs[0] } : {}),
            });
          }
        }

        return {
          companyId: company.id,
          updatedAt: new Date().toISOString(),
          derivedFrom: 'analysis_pipeline',
          goals,
          painPoints,
          importantFacts,
          decisionMakers,
          objections,
          commitments,
        };
      } catch (cause) {
        throw mapPhase4Error(cause, 'companies.intelligence');
      }
    },
  };

  const projectsRepo: ProductRepositories['projects'] = {
    async list(workspaceId, filter): Promise<Project[]> {
      await workspacesRepo.get(workspaceId);
      try {
        const includeArchived = filter?.includeArchived ?? false;
        const res = await service.db.query<{
          id: string;
          workspace_id: string;
          company_id: string | null;
          name: string;
          description: string | null;
          archived_at: string | null;
          created_at: string;
        }>(
          `select id, workspace_id, company_id, name, description, archived_at, created_at
             from public.projects
            where workspace_id = $1
              and ($2::boolean or archived_at is null)
            order by name asc`,
          [workspaceId, includeArchived],
        );
        return res.rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
          companyId: r.company_id,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          status: r.archived_at ? 'closed' : 'active',
          createdAt: toIso(r.created_at),
        }));
      } catch (cause) {
        throw mapPhase4Error(cause, 'projects.list');
      }
    },
    async get(projectId: string): Promise<Project> {
      try {
        const res = await service.db.query<{
          id: string;
          workspace_id: string;
          company_id: string | null;
          name: string;
          description: string | null;
          archived_at: string | null;
          created_at: string;
        }>(
          `select id, workspace_id, company_id, name, description, archived_at, created_at
             from public.projects
            where id = $1`,
          [projectId],
        );
        const r = res.rows[0];
        if (!r) {
          throw new RepositoryError('not_found', 'Project was not found.');
        }
        await workspacesRepo.get(r.workspace_id);
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          companyId: r.company_id,
          name: r.name,
          ...(r.description ? { description: r.description } : {}),
          status: r.archived_at ? 'closed' : 'active',
          createdAt: toIso(r.created_at),
        };
      } catch (cause) {
        throw mapPhase4Error(cause, 'projects.get');
      }
    },
    async overview(workspaceId, filter): Promise<ProjectOverview[]> {
      try {
        const projects = await projectsRepo.list(workspaceId, filter);
        const companies = await companiesRepo.list(workspaceId, { includeArchived: true });
        const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
        const bundles = await loadScopedMeetingBundles({ workspaceId });

        return projects.map((project) => {
          const projBundles = bundles.filter((b) => b.summary.projectId === project.id);
          const openTaskCount = projBundles.reduce((sum, b) => sum + b.detail.stats.openTasks, 0);
          const decisionCount = projBundles.reduce((sum, b) => sum + b.detail.stats.decisions, 0);
          const lastActivityAt =
            projBundles
              .map((b) => b.summary.occurredAt)
              .sort()
              .at(-1) ?? null;
          const companyName = project.companyId
            ? (companyNameById.get(project.companyId) ?? null)
            : null;

          return {
            project,
            companyName,
            meetingCount: projBundles.length,
            openTaskCount,
            decisionCount,
            lastActivityAt,
          };
        });
      } catch (cause) {
        throw mapPhase4Error(cause, 'projects.overview');
      }
    },
  };

  const meetingsRepo: ProductRepositories['meetings'] = {
    async list(workspaceId: string, filter?: MeetingFilter): Promise<MeetingListRow[]> {
      await workspacesRepo.get(workspaceId);
      try {
        const res = await service.db.query<{ id: string }>(
          `select id
             from public.meetings
            where workspace_id = $1
              and deleted_at is null
              and purge_status = 'active'
            order by created_at desc`,
          [workspaceId],
        );
        const built = await Promise.all(res.rows.map((r) => buildMeetingSummaryAndDetail(r.id)));
        const byId = new Map(built.map((item) => [item.summary.id, item]));
        const summaries = filterMeetings(
          built.map((item) => item.summary),
          filter,
        );
        return summaries.map((meeting) => {
          const b = byId.get(meeting.id);
          return {
            meeting,
            openTaskCount: b?.detail.stats.openTasks ?? 0,
            overdueTaskCount: 0,
          };
        });
      } catch (cause) {
        throw mapPhase4Error(cause, 'meetings.list');
      }
    },
    async detail(meetingId: string): Promise<MeetingDetail> {
      const { detail } = await buildMeetingSummaryAndDetail(meetingId);
      return detail;
    },
    async participants(meetingId: string) {
      const { transcript } = await buildMeetingSummaryAndDetail(meetingId);
      return transcript.participants;
    },
    async meetingTypes(workspaceId: string): Promise<MeetingType[]> {
      await workspacesRepo.get(workspaceId);
      try {
        const res = await service.db.query<{
          id: string;
          workspace_id: string;
          key: string;
          display_name: string;
          template_key: string | null;
          sort_order: number;
          is_active: boolean;
        }>(
          `select id, workspace_id, key, display_name, template_key, sort_order, is_active
             from public.meeting_types
            where workspace_id = $1
            order by sort_order asc`,
          [workspaceId],
        );
        return res.rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
          key: r.key,
          displayName: r.display_name,
          sortOrder: r.sort_order,
          builtIn: r.template_key !== null,
          active: r.is_active,
        }));
      } catch (cause) {
        throw mapPhase4Error(cause, 'meetings.meetingTypes');
      }
    },
    async dashboard(workspaceId: string): Promise<DashboardSnapshot> {
      try {
        const [bundles, companies] = await Promise.all([
          loadScopedMeetingBundles({ workspaceId }),
          companiesRepo.list(workspaceId),
        ]);
        const rows: MeetingListRow[] = bundles.map((b) => ({
          meeting: b.summary,
          openTaskCount: b.detail.stats.openTasks,
          overdueTaskCount: 0,
        }));
        const allTasks = bundles.flatMap((b) => b.tasks);
        const allDecisions = bundles.flatMap((b) => b.decisions);
        const allQuestions = bundles.flatMap((b) => b.questions);
        const openTasks = allTasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
        const openQuestions = allQuestions.filter((q) => q.status === 'open');
        const timelines = bundles.map((b) => b.processing);

        return {
          workspaceId,
          generatedAt: new Date().toISOString(),
          todayMeetings: rows.map((r) => r.meeting),
          openTaskCount: openTasks.length,
          overdueTaskCount: 0,
          decisionCount7d: allDecisions.length,
          openQuestionCount: openQuestions.length,
          recentMeetings: rows,
          upcomingOrToday: rows.map((r) => r.meeting),
          recentActions: openTasks.slice(0, 8),
          recentDecisions: allDecisions.slice(0, 8),
          processing: timelines.filter((t) => t.state !== 'draft'),
          meetingCount: rows.length,
          companyCount: companies.length,
        };
      } catch (cause) {
        throw mapPhase4Error(cause, 'meetings.dashboard');
      }
    },
    async processing(meetingId: string): Promise<ProcessingTimeline> {
      try {
        const result = await service.getMeetingProcessing(principal, meetingId);
        return result.timeline;
      } catch (cause) {
        throw mapPhase4Error(cause, 'meetings.processing');
      }
    },
    async decisionsFor(scope) {
      const bundles = await loadScopedMeetingBundles(scope);
      return bundles.flatMap((b) => b.decisions);
    },
    async factsFor(scope) {
      const bundles = await loadScopedMeetingBundles(scope);
      return bundles.flatMap((b) => b.facts);
    },
    async questionsFor(scope) {
      const bundles = await loadScopedMeetingBundles(scope);
      return bundles.flatMap((b) => b.questions);
    },
    async ideasFor(scope) {
      const bundles = await loadScopedMeetingBundles(scope);
      return bundles.flatMap((b) => b.ideas);
    },
    async commitmentsFor(scope) {
      const bundles = await loadScopedMeetingBundles(scope);
      return bundles.flatMap((b) => b.commitments);
    },
  };

  const transcriptsRepo: ProductRepositories['transcripts'] = {
    async forMeeting(meetingId: string): Promise<MeetingTranscript> {
      try {
        const { transcript } = await buildMeetingSummaryAndDetail(meetingId);
        return transcript;
      } catch (cause) {
        throw mapPhase4Error(cause, 'transcripts.forMeeting');
      }
    },
    async window(request: TranscriptWindowRequest): Promise<TranscriptWindow> {
      const normalized = readTranscriptWindowRequest(request);
      const transcript = await transcriptsRepo.forMeeting(normalized.meetingId);
      return windowTranscript(transcript.segments, normalized, {
        totalMs: transcript.totalMs,
        wordCount: transcript.wordCount,
      });
    },
    async segmentsForTopic(topicId: string) {
      try {
        if (!(await hasPhase6Tables())) return [];
        const topicRes = await service.db.query<{
          meeting_id: string;
          source_segment_ids: string[];
        }>(`select meeting_id, source_segment_ids from public.meeting_topics where id = $1`, [
          topicId,
        ]);
        const row = topicRes.rows[0];
        if (!row) return [];
        return transcriptsRepo.segmentsByIds(row.meeting_id, row.source_segment_ids);
      } catch (cause) {
        throw mapPhase4Error(cause, 'transcripts.segmentsForTopic');
      }
    },
    async segmentsByIds(meetingId: string, segmentIds: string[]) {
      const transcript = await transcriptsRepo.forMeeting(meetingId);
      if (segmentIds.length === 0) return [];
      const wanted = new Set(segmentIds);
      return transcript.segments.filter((s) => wanted.has(s.id)).sort((a, b) => a.index - b.index);
    },
    async confirmSpeakerMapping(input: SpeakerMappingCommit): Promise<SpeakerMapping[]> {
      try {
        await phase5Service.updateSpeakerMappings(principal, input.meetingId, {
          mappings: [
            {
              speakerLabel: input.label,
              participantId: input.personId,
            },
          ],
        });
        const updated = await transcriptsRepo.forMeeting(input.meetingId);
        return updated.speakerMappings;
      } catch (cause) {
        throw mapPhase4Error(cause, 'transcripts.confirmSpeakerMapping');
      }
    },
  };

  const tasksRepo: ProductRepositories['tasks'] = {
    async list(workspaceId: string, filter?: TaskFilter): Promise<Task[]> {
      try {
        const bundles = await loadScopedMeetingBundles({
          workspaceId,
          meetingId: filter?.meetingId ?? null,
          companyId: filter?.companyId ?? null,
          projectId: filter?.projectId ?? null,
        });
        const tasks = bundles.flatMap((b) => b.tasks);
        const todayIsoDate = new Date().toISOString().slice(0, 10);
        return filterTasks(tasks, filter, {
          currentPersonId: principal?.userId ?? null,
          todayIsoDate,
        });
      } catch (cause) {
        throw mapPhase4Error(cause, 'tasks.list');
      }
    },
  };

  const knowledgeRepo: ProductRepositories['knowledge'] = {
    async entries(filter: KnowledgeFilter): Promise<KnowledgeEntry[]> {
      try {
        const workspaces = await workspacesRepo.list();
        const bundles = (
          await Promise.all(
            workspaces.map((ws) =>
              loadScopedMeetingBundles({
                workspaceId: ws.id,
                companyId: filter.companyId ?? null,
                projectId: filter.projectId ?? null,
              }),
            ),
          )
        ).flat();

        const entries: KnowledgeEntry[] = [];
        for (const b of bundles) {
          for (const d of b.decisions) {
            entries.push({
              kind: 'decision',
              id: d.id,
              workspaceId: d.workspaceId,
              meetingId: d.meetingId,
              companyId: d.companyId,
              projectId: d.projectId,
              title: d.title,
              body: d.description,
              at: b.summary.occurredAt,
              personIds: d.participantPersonIds,
              tags: [d.status],
              statusLabel: d.status,
              evidence: d.evidence,
            });
          }

          for (const f of b.facts) {
            entries.push({
              kind: 'fact',
              id: f.id,
              workspaceId: f.workspaceId,
              meetingId: f.meetingId,
              companyId: f.companyId,
              projectId: f.projectId,
              title: `${f.label}: ${f.value}`,
              body: f.evidence[0]?.quote ?? `${f.label} = ${f.value}`,
              at: f.capturedAt,
              personIds: f.speakerPersonId ? [f.speakerPersonId] : [],
              tags: [f.category],
              statusLabel: f.category,
              evidence: f.evidence,
            });
          }

          for (const t of b.transcript.topics) {
            const topicDto = b.intelData?.topics.find((td) => td.id === t.id);
            const evRefs = topicDto
              ? mapEvidenceDtosToRefs(
                  topicDto.evidence,
                  {
                    id: b.summary.id,
                    title: b.summary.title,
                    occurredAt: b.summary.occurredAt,
                  },
                  b.speakerPersonBySegmentId,
                )
              : [];
            entries.push({
              kind: 'topic',
              id: t.id,
              workspaceId: t.workspaceId,
              meetingId: t.meetingId,
              companyId: b.summary.companyId,
              projectId: b.summary.projectId,
              title: t.title,
              body: t.summary,
              at: b.summary.occurredAt,
              personIds: t.participantPersonIds,
              tags: t.keywords.length > 0 ? t.keywords : ['topic'],
              statusLabel: 'discussed',
              evidence: evRefs,
            });
          }

          for (const c of b.commitments) {
            entries.push({
              kind: 'commitment',
              id: c.id,
              workspaceId: c.workspaceId,
              meetingId: c.meetingId,
              companyId: c.companyId,
              projectId: b.summary.projectId,
              title: c.text,
              body: c.evidence[0]?.quote ?? c.text,
              at: b.summary.occurredAt,
              personIds: [c.byPersonId],
              tags: [c.status],
              statusLabel: c.status,
              evidence: c.evidence,
            });
          }

          for (const q of b.questions) {
            entries.push({
              kind: 'question',
              id: q.id,
              workspaceId: q.workspaceId,
              meetingId: q.meetingId,
              companyId: q.companyId,
              projectId: q.projectId,
              title: q.text,
              body: q.resolution?.answer ?? q.evidence[0]?.quote ?? q.text,
              at: b.summary.occurredAt,
              personIds: q.askedByPersonId ? [q.askedByPersonId] : [],
              tags: [q.status],
              statusLabel: q.status,
              evidence: q.evidence,
            });
          }
        }

        return filterKnowledge(entries, filter);
      } catch (cause) {
        throw mapPhase4Error(cause, 'knowledge.entries');
      }
    },
  };

  const askAiRepo: ProductRepositories['askAi'] = {
    async ask(workspaceId: string, question: string): Promise<AskAiAnswer> {
      try {
        await workspacesRepo.get(workspaceId);
        const trimmed = question.trim();
        if (!trimmed) {
          throw new RepositoryError(
            'validation_failed',
            'Ask a question to see a retrieval-backed answer.',
          );
        }
        const response = await phase7Service.askWorkspaceQuestion(principal, workspaceId, {
          question: trimmed,
        });
        const mappedCitations: AskAiCitation[] = response.citations.map((c) => ({
          kind: c.kind,
          id: c.id,
          meetingId: c.meetingId,
          meetingTitle: c.meetingTitle,
          occurredAt: c.occurredAt,
          startMs: c.startMs,
          endMs: c.endMs,
          speakerNames: c.speakerNames ?? [],
          quote: c.quote,
          segmentIds: c.segmentIds,
          target: c.target,
        }));
        return {
          id: response.id,
          question: response.question,
          answer: response.answer,
          citations: mappedCitations,
          adapter: 'rag_pipeline',
          generatedAt: response.generatedAt,
          matchedKnownQuestion: false,
          notes: response.notes,
        };
      } catch (cause) {
        throw mapPhase4Error(cause, 'askAi.ask');
      }
    },
    async suggestions(workspaceId: string): Promise<string[]> {
      try {
        await workspacesRepo.get(workspaceId);
        const companies = await companiesRepo.list(workspaceId);
        const companyName = companies[0]?.name;
        return [
          companyName
            ? `${companyName} bilan budget haqida nima kelishganmiz?`
            : 'Budget haqida nima kelishganmiz?',
          'Qanday ochiq vazifalar va muddatlar qolgan?',
          'Oxirgi yig‘ilishlarda qanday qarorlar tasdiqlangan?',
          'Mijoz tomonidan qanday e’tiroz yoki savollar ko‘tarilgan?',
          'What commitments and deadlines were agreed?',
          'Какие ключевые факты и метрики были зафиксированы?',
        ];
      } catch (cause) {
        throw mapPhase4Error(cause, 'askAi.suggestions');
      }
    },
  };

  const searchRepo: ProductRepositories['search'] = {
    async search(workspaceId: string, query: string): Promise<SearchHit[]> {
      try {
        await workspacesRepo.get(workspaceId);
        const needle = query.trim().toLowerCase();
        if (needle.length < 2) return [];

        const [bundles, companies, projects, members] = await Promise.all([
          loadScopedMeetingBundles({ workspaceId }),
          companiesRepo.list(workspaceId, { includeArchived: true }),
          projectsRepo.list(workspaceId, { includeArchived: true }),
          workspacesRepo.members(workspaceId),
        ]);

        const hits: SearchHit[] = [];
        const add = (hit: SearchHit) => {
          if (
            !hits.some((existing) => existing.href === hit.href && existing.title === hit.title)
          ) {
            hits.push(hit);
          }
        };

        for (const b of bundles) {
          const meeting = b.summary;
          if (
            `${meeting.title} ${meeting.companyName ?? ''} ${meeting.projectName ?? ''}`
              .toLowerCase()
              .includes(needle)
          ) {
            add({
              kind: 'meeting',
              id: meeting.id,
              title: meeting.title,
              subtitle: `${meeting.companyName ?? 'No company'} · ${new Date(meeting.occurredAt).toLocaleDateString('en', { dateStyle: 'medium' })}`,
              href: routes.meeting({ workspaceId, meetingId: meeting.id }),
            });
          }
        }

        for (const company of companies) {
          if (`${company.name} ${company.description ?? ''}`.toLowerCase().includes(needle)) {
            add({
              kind: 'company',
              id: company.id,
              title: company.name,
              subtitle: company.description ?? 'Company',
              href: routes.company({ workspaceId, companyId: company.id }),
            });
          }
        }

        for (const project of projects) {
          if (`${project.name} ${project.description ?? ''}`.toLowerCase().includes(needle)) {
            add({
              kind: 'project',
              id: project.id,
              title: project.name,
              subtitle: project.description ?? 'Project',
              href: routes.project({ workspaceId, projectId: project.id }),
            });
          }
        }

        for (const member of members) {
          if (`${member.name} ${member.email ?? ''}`.toLowerCase().includes(needle)) {
            add({
              kind: 'person',
              id: member.personId,
              title: member.name,
              subtitle: `Workspace ${member.role}`,
              href: routes.tasks({ workspaceId }, { person: member.personId }),
            });
          }
        }

        for (const b of bundles) {
          for (const decision of b.decisions) {
            if (`${decision.title} ${decision.description}`.toLowerCase().includes(needle)) {
              add({
                kind: 'decision',
                id: decision.id,
                title: decision.title,
                subtitle: `Decision · ${decision.status}`,
                href: routes.meetingTab({
                  workspaceId,
                  meetingId: decision.meetingId,
                  tab: 'decisions',
                }),
              });
            }
          }
          for (const task of b.tasks) {
            if (
              `${task.title} ${task.detail ?? ''} ${task.ownerLabel}`.toLowerCase().includes(needle)
            ) {
              add({
                kind: 'task',
                id: task.id,
                title: task.title,
                subtitle: `Task · ${task.ownerLabel}`,
                href: routes.meetingTab({
                  workspaceId,
                  meetingId: task.meetingId,
                  tab: 'tasks',
                }),
              });
            }
          }
        }

        // Also search indexed Phase 7 knowledge_chunks (for canonical transcript segments, facts, topics, etc.)
        // strictly scoped to active meetings in this workspace.
        if (await hasPhase7Tables()) {
          const chunkRes = await service.db.query<{
            id: string;
            meeting_id: string;
            meeting_title: string;
            chunk_type: string;
            title: string;
            canonical_text: string;
          }>(
            `select kc.id,
                    kc.meeting_id,
                    m.title as meeting_title,
                    kc.chunk_type::text as chunk_type,
                    kc.title,
                    kc.canonical_text
               from public.knowledge_chunks kc
               join public.meetings m
                 on m.id = kc.meeting_id
                and m.workspace_id = kc.workspace_id
              where kc.workspace_id = $1
                and m.deleted_at is null
                and m.purge_status = 'active'
                and m.current_embedding_run_id = kc.embedding_run_id
                and (lower(kc.title) like $2 or lower(kc.canonical_text) like $2)
              order by kc.sequence_no asc
              limit 12`,
            [workspaceId, `%${needle}%`],
          );

          for (const row of chunkRes.rows) {
            add({
              kind: 'meeting',
              id: row.meeting_id,
              title: row.title,
              subtitle: `${row.meeting_title} · ${row.chunk_type.replace('_', ' ')}`,
              href:
                row.chunk_type === 'transcript'
                  ? routes.meetingTab({
                      workspaceId,
                      meetingId: row.meeting_id,
                      tab: 'transcript',
                    })
                  : routes.meeting({ workspaceId, meetingId: row.meeting_id }),
            });
          }
        }

        return hits.slice(0, 12);
      } catch (cause) {
        throw mapPhase4Error(cause, 'search.search');
      }
    },
    async recent(workspaceId: string, limit = 12): Promise<SearchHit[]> {
      try {
        await workspacesRepo.get(workspaceId);
        const bundles = await loadScopedMeetingBundles({ workspaceId });
        const hits: SearchHit[] = bundles
          .map((b) => b.summary)
          .slice()
          .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
          .slice(0, Math.max(1, Math.min(limit, 8)))
          .map((meeting) => ({
            kind: 'meeting' as const,
            id: meeting.id,
            title: meeting.title,
            subtitle: `${meeting.state === 'draft' ? 'Draft' : meeting.meetingTypeLabel} · ${meeting.companyName ?? 'No company'}`,
            href: routes.meeting({ workspaceId, meetingId: meeting.id }),
          }));

        const openTasks = bundles
          .flatMap((b) => b.tasks)
          .filter((t) => t.status === 'open' || t.status === 'in_progress')
          .sort((left, right) => (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'))
          .slice(0, Math.max(0, limit - hits.length));

        for (const task of openTasks) {
          hits.push({
            kind: 'task',
            id: task.id,
            title: task.title,
            subtitle: `Open task · ${task.ownerLabel}${task.dueDate ? ` · due ${task.dueDate}` : ''}`,
            href: routes.meetingTab({ workspaceId, meetingId: task.meetingId, tab: 'tasks' }),
          });
        }

        return hits;
      } catch (cause) {
        throw mapPhase4Error(cause, 'search.recent');
      }
    },
  };

  const settingsRepo: ProductRepositories['settings'] = {
    async get(workspaceId: string): Promise<SettingsSnapshot> {
      try {
        const ws = await workspacesRepo.get(workspaceId);
        const [members, meetingTypes] = await Promise.all([
          workspacesRepo.members(workspaceId),
          meetingsRepo.meetingTypes(workspaceId),
        ]);

        const memberSettings: WorkspaceMemberSetting[] = members.map((m) => ({
          personId: m.personId,
          name: m.name,
          ...(m.email ? { email: m.email } : {}),
          role: m.role,
          status: m.status,
        }));

        let telegramCard: SettingsSnapshot['integrations'][number] = {
          key: 'telegram',
          label: 'Telegram Companion',
          state: 'not_connected',
          detail: `Connect @${phase8Service.telegramProvider.botUsername} via a single-use verification token for processing-ready notifications and workspace Q&A.`,
        };

        if (await hasPhase8Tables()) {
          try {
            const tgStatus = await phase8Service.getWorkspaceTelegramStatus(principal, workspaceId);
            if (tgStatus.currentUserLink && tgStatus.currentUserLink.status === 'active') {
              const handle = tgStatus.currentUserLink.telegramUsername
                ? `@${tgStatus.currentUserLink.telegramUsername}`
                : (tgStatus.currentUserLink.telegramDisplayName ??
                  tgStatus.currentUserLink.telegramChatId);
              telegramCard = {
                key: 'telegram',
                label: 'Telegram Companion',
                state: 'connected',
                detail: `Connected (${handle}) via @${tgStatus.botUsername} · Notifications: ${tgStatus.currentUserLink.notifyOnMeetingReady ? 'enabled' : 'disabled'} (${tgStatus.activeWorkspaceLinkCount} active workspace link${tgStatus.activeWorkspaceLinkCount === 1 ? '' : 's'}).`,
              };
            }
          } catch {
            // Keep default not_connected card if status lookup fails
          }
        }

        let googleCalendarCard: SettingsSnapshot['integrations'][number] = {
          key: 'google_calendar',
          label: 'Google Calendar',
          state: 'not_connected',
          detail:
            'Requires explicit user confirmation and auditable idempotency before scheduling follow-ups.',
        };
        let amocrmCard: SettingsSnapshot['integrations'][number] = {
          key: 'amocrm',
          label: 'amoCRM',
          state: 'not_connected',
          detail:
            'Requires explicit user confirmation and auditable idempotency before syncing summaries or tasks.',
        };
        let googleDocsCard: SettingsSnapshot['integrations'][number] = {
          key: 'google_docs',
          label: 'Google Docs',
          state: 'not_connected',
          detail:
            'Requires explicit user confirmation and auditable idempotency before publishing meeting briefs.',
        };

        if (await hasPhase9Tables()) {
          try {
            const { connectors } = await phase9Service.listWorkspaceConnectors(
              principal,
              workspaceId,
            );
            for (const c of connectors) {
              if (c.status !== 'active') continue;
              if (c.connectorType === 'google_calendar') {
                googleCalendarCard = {
                  key: 'google_calendar',
                  label: c.label || 'Google Calendar',
                  state: 'connected',
                  detail: `Connected (${c.endpointUrl ?? 'workspace webhook'}) · Explicit user confirmation required per action.`,
                };
              } else if (c.connectorType === 'amocrm') {
                amocrmCard = {
                  key: 'amocrm',
                  label: c.label || 'amoCRM',
                  state: 'connected',
                  detail: `Connected (${c.endpointUrl ?? 'workspace webhook'}) · Explicit user confirmation required per action.`,
                };
              } else if (c.connectorType === 'google_docs') {
                googleDocsCard = {
                  key: 'google_docs',
                  label: c.label || 'Google Docs',
                  state: 'connected',
                  detail: `Connected (${c.endpointUrl ?? 'workspace webhook'}) · Explicit user confirmation required per action.`,
                };
              }
            }
          } catch {
            // Keep default not_connected cards if lookup fails
          }
        }

        return {
          workspaceId: ws.id,
          workspaceName: ws.name,
          workspaceSlug: ws.slug,
          currentRole: ws.role,
          members: memberSettings,
          meetingTypes,
          vocabulary: [],
          recording: {
            preferredInputLabel: 'Default system microphone & system audio',
            captureSystemAudio: true,
            retentionLabel:
              'Keep verified audio chunks and canonical transcripts in workspace storage',
            screenContextDefault: 'never',
            audioFormatLabel: 'Opus / WAV 48kHz',
            chunkLengthSeconds: 30,
            storageRootLabel: 'Private workspace object storage',
          },
          ai: {
            transcriptionLanguages: ['uz', 'ru', 'en'],
            speakerLanguageGuessing: true,
            summaryStyle: 'executive_brief',
            analysisDepth: 'standard',
            providerNote: `Transcription provider: ${phase5Service.provider.providerName} (${phase5Service.provider.defaultModel}). Intelligence provider: ${phase6Service.intelligenceProvider.providerName} (${phase6Service.intelligenceProvider.defaultModel}, ${phase6Service.intelligenceProvider.promptVersion}). Embedding provider: ${phase7Service.embeddingProvider.providerName} (${phase7Service.embeddingProvider.defaultModel}, ${phase7Service.embeddingProvider.dimensions}d).`,
          },
          integrations: [telegramCard, googleCalendarCard, amocrmCard, googleDocsCard],
        };
      } catch (cause) {
        throw mapPhase4Error(cause, 'settings.get');
      }
    },
    async vocabulary(workspaceId: string): Promise<VocabularyTerm[]> {
      await workspacesRepo.get(workspaceId);
      return [];
    },
  };

  const desktopRepo: ProductRepositories['desktop'] = {
    async status() {
      return {
        state: 'not_validated',
        detail:
          'Local-first macOS recorder and Phase 4 upload queue are implemented in apps/desktop, awaiting real-Mac hardware validation.',
        deepLink: 'suhbat://recorder',
      };
    },
  };

  const namespaces = new Map<string, object>([
    ['workspaces', workspacesRepo],
    ['companies', companiesRepo],
    ['projects', projectsRepo],
    ['meetings', meetingsRepo],
    ['transcripts', transcriptsRepo],
    ['tasks', tasksRepo],
    ['knowledge', knowledgeRepo],
    ['askAi', askAiRepo],
    ['search', searchRepo],
    ['settings', settingsRepo],
    ['desktop', desktopRepo],
  ]);

  return new Proxy({ capabilities: connectedLiveCapabilities } as ProductRepositories, {
    get(target, property) {
      if (property === 'capabilities') return target.capabilities;
      if (typeof property !== 'string') return undefined;
      const existing = namespaces.get(property);
      if (existing) return existing;
      const created = namespace(property);
      namespaces.set(property, created);
      return created;
    },
  });
}

export function createLivePlaceholderRepositories(): ProductRepositories {
  const namespaces = new Map<string, object>();
  return new Proxy({ capabilities: liveCapabilities } as ProductRepositories, {
    get(target, property) {
      if (property === 'capabilities') return target.capabilities;
      if (typeof property !== 'string') return undefined;
      const existing = namespaces.get(property);
      if (existing) return existing;
      const created = namespace(property);
      namespaces.set(property, created);
      return created;
    },
  });
}
