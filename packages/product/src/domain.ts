import { z } from 'zod';

/**
 * Product domain contracts for the SUHBAT AI meeting-intelligence interface.
 *
 * These types describe what the UI needs, not what a database stores. Two consequences are deliberate:
 *
 * 1. **IDs are strings, not UUIDs.** Demo fixtures use readable ids (`seg_foodera_042`) so evidence
 *    references are inspectable in tests and in the browser. Real adapters return UUIDs / canonical
 *    segment ids; nothing in the UI may assume a shape beyond "opaque, stable, resolvable".
 * 2. **Every claim carries evidence.** Decisions, tasks, facts, questions, ideas and commitments each
 *    hold an `EvidenceRef` that resolves to a meeting and transcript segment ids. The integrity test in
 *    `packages/product/src/demo/integrity.ts` fails the build if a reference dangles, so "the demo looks
 *    wired" is enforced rather than hoped for.
 */

export const idSchema = z.string().min(1).max(120);
export const isoDateSchema = z.string().min(1);
export const isoDateTimeSchema = z.string().min(1);
export const nonEmptyTextSchema = z.string().min(1);

/** Canonical language codes seen in the product's meeting corpus. */
export const languageCodeSchema = z.enum(['uz', 'ru', 'en', 'tr', 'kk']);
export type LanguageCode = z.infer<typeof languageCodeSchema>;

/**
 * Meeting lifecycle as the product presents it. `draft`…`recording` are capture-side states, the middle
 * group is the future pipeline's UI surface, and `ready`/`failed` are terminal for display purposes.
 * Phase 2 note: this is a *presentation* vocabulary. The native recorder's own state machine
 * (`docs/recording.md` §2) is separate and is not redefined here.
 */
export const meetingProcessingStateSchema = z.enum([
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
]);
export type MeetingProcessingState = z.infer<typeof meetingProcessingStateSchema>;

export const processingStepStateSchema = z.enum(['done', 'active', 'pending', 'failed']);
export type ProcessingStepState = z.infer<typeof processingStepStateSchema>;

export const processingStepSchema = z.object({
  state: processingStepStateSchema,
  /** Stable key used for copy lookup and tests, e.g. `transcribing`. */
  key: z.string().min(1),
  label: z.string().min(1),
  at: isoDateTimeSchema.optional(),
  /** Only real, human-readable facts. No invented percentages anywhere in this product surface. */
  detail: z.string().min(1).optional(),
});
export type ProcessingStep = z.infer<typeof processingStepSchema>;

export const processingTimelineSchema = z.object({
  meetingId: idSchema,
  state: meetingProcessingStateSchema,
  steps: z.array(processingStepSchema).min(1),
  /** Present only when `state === 'failed'`. */
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      hint: z.string().min(1).optional(),
      retryable: z.boolean(),
    })
    .optional(),
});
export type ProcessingTimeline = z.infer<typeof processingTimelineSchema>;

export const personSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1),
  initials: z.string().min(1).max(3),
  /** Free-form display role; not an authorization concept. */
  title: z.string().min(1).optional(),
  kind: z.enum(['internal', 'client', 'external']).default('internal'),
  email: z.string().min(1).optional(),
});
export type Person = z.infer<typeof personSchema>;

export const workspaceSummarySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  /** Role of the signed-in (or demo-current) user in this workspace. */
  role: z.enum(['owner', 'admin', 'member']),
  memberCount: z.number().int().nonnegative(),
  demo: z.boolean().default(false),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const meetingTypeSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  key: z.string().min(1),
  displayName: z.string().min(1),
  sortOrder: z.number().int(),
  builtIn: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type MeetingType = z.infer<typeof meetingTypeSchema>;

export const companySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  status: z.enum(['active', 'archived']).default('active'),
  createdAt: isoDateTimeSchema,
});
export type Company = z.infer<typeof companySchema>;

export const projectSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  companyId: idSchema.nullable().default(null),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  status: z.enum(['active', 'paused', 'closed']).default('active'),
  createdAt: isoDateTimeSchema,
  lastActivityAt: isoDateTimeSchema.optional(),
});
export type Project = z.infer<typeof projectSchema>;

/** Who was in the room, and which diarization label belonged to them. */
export const participantSchema = z.object({
  personId: idSchema,
  name: z.string().min(1),
  initials: z.string().min(1).max(3),
  kind: z.enum(['internal', 'client', 'external']),
  /** Raw diarization label before mapping, when the meeting still needs one. */
  speakerLabel: z.string().min(1).optional(),
  mapped: z.boolean().default(true),
  spokeInMeeting: z.boolean().default(true),
});
export type Participant = z.infer<typeof participantSchema>;

export const evidenceRefSchema = z.object({
  meetingId: idSchema,
  /** Denormalised for cards; the UI must not need a second lookup to render a citation. */
  meetingTitle: z.string().min(1),
  occurredAt: isoDateTimeSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** Canonical transcript segment ids. These are what a real adapter will supply. */
  segmentIds: z.array(idSchema).min(1),
  speakerPersonIds: z.array(idSchema).default([]),
  /** Short quote so the citation is readable without loading the transcript. */
  quote: z.string().min(1).optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const transcriptSegmentSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  index: z.number().int().nonnegative(),
  /** `null` while a diarization label has not been mapped to a person yet. */
  speakerPersonId: idSchema.nullable().default(null),
  speakerLabel: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: nonEmptyTextSchema,
  language: languageCodeSchema,
  topicId: idSchema.nullable().default(null),
  /** Only where a real ASR engine reported one; absent means "not measured", not "1.0". */
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const decisionStatusSchema = z.enum([
  'proposed',
  'tentative',
  'confirmed',
  'rejected',
  'superseded',
]);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const decisionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  companyId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  topicId: idSchema.nullable().default(null),
  title: z.string().min(1),
  description: z.string().min(1),
  status: decisionStatusSchema,
  participantPersonIds: z.array(idSchema).default([]),
  evidence: z.array(evidenceRefSchema).min(1),
  decidedOn: isoDateSchema,
  supersededByDecisionId: idSchema.nullable().default(null),
  /** Distinguishes a real commitment from ambient discussion in dense lists. */
  hasFollowUpTasks: z.boolean().default(false),
});
export type Decision = z.infer<typeof decisionSchema>;

export const taskStatusSchema = z.enum([
  'open',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  companyId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  topicId: idSchema.nullable().default(null),
  title: z.string().min(1),
  detail: z.string().min(1).optional(),
  ownerPersonId: idSchema.nullable().default(null),
  ownerLabel: z.string().min(1).default('Unassigned'),
  dueDate: isoDateSchema.nullable().default(null),
  status: taskStatusSchema,
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  evidence: z.array(evidenceRefSchema).min(1),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const factCategorySchema = z.enum([
  'metric',
  'target',
  'budget',
  'team',
  'tooling',
  'timeline',
  'constraint',
  'preference',
]);
export type FactCategory = z.infer<typeof factCategorySchema>;

export const factSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  companyId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  category: factCategorySchema,
  label: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().min(1).optional(),
  speakerPersonId: idSchema.nullable().default(null),
  evidence: z.array(evidenceRefSchema).min(1),
  /** Optional and never the primary signal: a low number here must not look like a verdict. */
  confidence: z.number().min(0).max(1).optional(),
  capturedAt: isoDateTimeSchema,
});
export type Fact = z.infer<typeof factSchema>;

export const questionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  companyId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  topicId: idSchema.nullable().default(null),
  text: z.string().min(1),
  askedByPersonId: idSchema.nullable().default(null),
  status: z.enum(['open', 'answered', 'deferred']).default('open'),
  raisedOn: isoDateSchema,
  /** Only for answered questions: what resolved it, and where. */
  resolution: z
    .object({
      answer: z.string().min(1),
      answeredOn: isoDateSchema,
      answeredByPersonId: idSchema.nullable().default(null),
      evidence: z.array(evidenceRefSchema).min(1),
    })
    .optional(),
  evidence: z.array(evidenceRefSchema).min(1),
});
export type Question = z.infer<typeof questionSchema>;

export const ideaSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  companyId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  topicId: idSchema.nullable().default(null),
  text: z.string().min(1),
  proposedByPersonId: idSchema,
  status: z.enum(['new', 'considering', 'adopted', 'dropped']).default('new'),
  raisedOn: isoDateSchema,
  evidence: z.array(evidenceRefSchema).min(1),
});
export type Idea = z.infer<typeof ideaSchema>;

export const commitmentSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  companyId: idSchema.nullable().default(null),
  text: z.string().min(1),
  byPersonId: idSchema,
  dueDate: isoDateSchema.nullable().default(null),
  status: z.enum(['pending', 'met', 'missed']).default('pending'),
  evidence: z.array(evidenceRefSchema).min(1),
});
export type Commitment = z.infer<typeof commitmentSchema>;

export const topicSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  meetingId: idSchema,
  parentId: idSchema.nullable().default(null),
  title: z.string().min(1),
  summary: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  participantPersonIds: z.array(idSchema).default([]),
  /** Ordered segment ids that belong to this topic — the transcript jump target. */
  segmentIds: z.array(idSchema).min(1),
  decisionIds: z.array(idSchema).default([]),
  taskIds: z.array(idSchema).default([]),
  questionIds: z.array(idSchema).default([]),
  ideaIds: z.array(idSchema).default([]),
});
export type Topic = z.infer<typeof topicSchema>;

export const meetingSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  title: z.string().min(1),
  companyId: idSchema.nullable().default(null),
  companyName: z.string().min(1).optional(),
  projectId: idSchema.nullable().default(null),
  projectName: z.string().min(1).optional(),
  meetingTypeId: idSchema,
  meetingTypeKey: z.string().min(1),
  meetingTypeLabel: z.string().min(1),
  occurredAt: isoDateTimeSchema,
  durationMs: z.number().int().nonnegative(),
  /** Canonical captured duration; `null` when nothing was captured yet (draft). */
  capturedMs: z.number().int().nonnegative().nullable().default(null),
  state: meetingProcessingStateSchema,
  languages: z.array(languageCodeSchema).default([]),
  participants: z.array(participantSchema).default([]),
  origin: z.enum(['draft', 'desktop', 'upload']),
  recordingAvailable: z.boolean().default(false),
  counts: z.object({
    topics: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    ideas: z.number().int().nonnegative(),
    segments: z.number().int().nonnegative(),
  }),
});
export type MeetingSummary = z.infer<typeof meetingSummarySchema>;

export const meetingDetailSchema = meetingSummarySchema.extend({
  executiveSummary: z.array(z.string().min(1)).default([]),
  keyOutcome: z.string().min(1).optional(),
  /** Speaker mapping still needed before the transcript is trustworthy. */
  unmappedSpeakers: z.array(z.string().min(1)).default([]),
  recording: z
    .object({
      available: z.boolean(),
      /** `local_desktop` points at Phase 2 artifacts; `none` means the UI must not offer playback. */
      source: z.enum(['none', 'local_desktop', 'object_storage']),
      /** Honest explanation for why play is or is not possible in the current build. */
      note: z.string().min(1),
      manifestSessionId: z.string().min(1).optional(),
    })
    .default({ available: false, source: 'none', note: 'No recording attached to this meeting.' }),
  stats: z.object({
    speakingParticipants: z.number().int().nonnegative(),
    topics: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    confirmedDecisions: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    openTasks: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    openQuestions: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
    ideas: z.number().int().nonnegative(),
    words: z.number().int().nonnegative(),
  }),
  processing: processingTimelineSchema.optional(),
});
export type MeetingDetail = z.infer<typeof meetingDetailSchema>;

export const companyIntelligenceItemSchema = z.object({
  text: z.string().min(1),
  personId: idSchema.nullable().default(null),
  evidence: evidenceRefSchema.optional(),
});

export const companyIntelligenceSchema = z.object({
  companyId: idSchema,
  updatedAt: isoDateTimeSchema,
  /** Label exists so the UI can say where this came from; in demo mode it is fixture-derived. */
  derivedFrom: z.enum(['demo_fixtures', 'analysis_pipeline']),
  goals: z.array(companyIntelligenceItemSchema).default([]),
  painPoints: z.array(companyIntelligenceItemSchema).default([]),
  importantFacts: z.array(companyIntelligenceItemSchema).default([]),
  decisionMakers: z.array(companyIntelligenceItemSchema).default([]),
  objections: z.array(companyIntelligenceItemSchema).default([]),
  commitments: z.array(companyIntelligenceItemSchema).default([]),
});
export type CompanyIntelligence = z.infer<typeof companyIntelligenceSchema>;
export type CompanyIntelligenceItem = z.infer<typeof companyIntelligenceItemSchema>;

/** One browsable row in the company-memory view. `kind` keeps the different entities distinguishable. */
export const knowledgeKindSchema = z.enum(['decision', 'fact', 'topic', 'commitment', 'question']);
export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;
export const knowledgeEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('decision'),
    id: idSchema,
    workspaceId: idSchema,
    meetingId: idSchema,
    companyId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    at: isoDateTimeSchema,
    personIds: z.array(idSchema),
    tags: z.array(z.string().min(1)),
    statusLabel: z.string().min(1),
    evidence: z.array(evidenceRefSchema),
  }),
  z.object({
    kind: z.literal('fact'),
    id: idSchema,
    workspaceId: idSchema,
    meetingId: idSchema,
    companyId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    at: isoDateTimeSchema,
    personIds: z.array(idSchema),
    tags: z.array(z.string().min(1)),
    statusLabel: z.string().min(1),
    evidence: z.array(evidenceRefSchema),
  }),
  z.object({
    kind: z.literal('topic'),
    id: idSchema,
    workspaceId: idSchema,
    meetingId: idSchema,
    companyId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    at: isoDateTimeSchema,
    personIds: z.array(idSchema),
    tags: z.array(z.string().min(1)),
    statusLabel: z.string().min(1),
    evidence: z.array(evidenceRefSchema),
  }),
  z.object({
    kind: z.literal('commitment'),
    id: idSchema,
    workspaceId: idSchema,
    meetingId: idSchema,
    companyId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    at: isoDateTimeSchema,
    personIds: z.array(idSchema),
    tags: z.array(z.string().min(1)),
    statusLabel: z.string().min(1),
    evidence: z.array(evidenceRefSchema),
  }),
  z.object({
    kind: z.literal('question'),
    id: idSchema,
    workspaceId: idSchema,
    meetingId: idSchema,
    companyId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    at: isoDateTimeSchema,
    personIds: z.array(idSchema),
    tags: z.array(z.string().min(1)),
    statusLabel: z.string().min(1),
    evidence: z.array(evidenceRefSchema),
  }),
]);
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

export const askAiCitationSchema = z.object({
  kind: z.enum(['decision', 'task', 'fact', 'question', 'idea', 'segment', 'commitment']),
  id: idSchema,
  meetingId: idSchema,
  meetingTitle: z.string().min(1),
  occurredAt: isoDateTimeSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speakerNames: z.array(z.string().min(1)).default([]),
  quote: z.string().min(1),
  /**
   * Canonical segment ids behind the quote, when the cited record has them. This is what lets a source card deep-link
   * to one transcript line instead of the top of a tab.
   */
  segmentIds: z.array(idSchema).default([]),
  /** Where clicking the source goes. Route construction stays in the app layer. */
  target: z.enum(['overview', 'transcript', 'decisions', 'tasks', 'facts', 'questions', 'ideas']),
});
export type AskAiCitation = z.infer<typeof askAiCitationSchema>;

export const askAiAnswerSchema = z.object({
  id: idSchema,
  question: z.string().min(1),
  /** Deterministic, retrieval-backed prose. Never presented as model output. */
  answer: z.array(z.string().min(1)).min(1),
  citations: z.array(askAiCitationSchema).default([]),
  /** So the UI can state the provenance truthfully, e.g. `demo_fixtures`. */
  adapter: z.enum(['demo_fixtures', 'rag_pipeline']),
  generatedAt: isoDateTimeSchema,
  matchedKnownQuestion: z.boolean().default(false),
  /** Surfaced instead of an empty answer so silence is never mistaken for "nothing known". */
  notes: z.array(z.string().min(1)).default([]),
});
export type AskAiAnswer = z.infer<typeof askAiAnswerSchema>;

export const vocabularyTermSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  term: z.string().min(1),
  context: z.string().min(1).optional(),
  scope: z.enum(['workspace', 'company', 'meeting']),
  companyId: idSchema.nullable().default(null),
  /** Only set for `scope: 'meeting'`; a term never silently widens itself to the whole workspace. */
  meetingId: idSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});
export type VocabularyTerm = z.infer<typeof vocabularyTermSchema>;

export const recordingSettingsSchema = z.object({
  preferredInputLabel: z.string().min(1),
  captureSystemAudio: z.boolean(),
  retentionLabel: z.string().min(1),
  screenContextDefault: z.enum(['ask', 'always', 'never']),
  audioFormatLabel: z.string().min(1),
  chunkLengthSeconds: z.number().int().positive(),
  storageRootLabel: z.string().min(1),
});
export type RecordingSettings = z.infer<typeof recordingSettingsSchema>;

export const aiSettingsSchema = z.object({
  transcriptionLanguages: z.array(languageCodeSchema).min(1),
  speakerLanguageGuessing: z.boolean(),
  summaryStyle: z.enum(['executive_brief', 'detailed', 'action_only']),
  analysisDepth: z.enum(['essential', 'standard', 'thorough']),
  /** Deliberately not a secret field: server credentials never belong in this surface. */
  providerNote: z.string().min(1),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const integrationCardSchema = z.object({
  key: z.enum(['telegram', 'google_calendar', 'amocrm', 'google_docs']),
  label: z.string().min(1),
  state: z.enum(['coming_later', 'not_connected', 'connected']),
  detail: z.string().min(1),
});
export type IntegrationCard = z.infer<typeof integrationCardSchema>;

export const memberSettingSchema = z.object({
  personId: idSchema,
  name: z.string().min(1),
  email: z.string().min(1).optional(),
  role: z.enum(['owner', 'admin', 'member']),
  status: z.enum(['active', 'invited', 'disabled']),
});
export type WorkspaceMemberSetting = z.infer<typeof memberSettingSchema>;

export const settingsSnapshotSchema = z.object({
  workspaceId: idSchema,
  workspaceName: z.string().min(1),
  workspaceSlug: z.string().min(1),
  currentRole: z.enum(['owner', 'admin', 'member']),
  members: z.array(memberSettingSchema).default([]),
  meetingTypes: z.array(meetingTypeSchema).default([]),
  vocabulary: z.array(vocabularyTermSchema).default([]),
  recording: recordingSettingsSchema,
  ai: aiSettingsSchema,
  integrations: z.array(integrationCardSchema).default([]),
});
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;

export const companyOverviewSchema = z.object({
  company: companySchema,
  activeProjectCount: z.number().int().nonnegative(),
  meetingCount: z.number().int().nonnegative(),
  openTaskCount: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
  lastMeetingAt: isoDateTimeSchema.nullable().default(null),
});
export type CompanyOverview = z.infer<typeof companyOverviewSchema>;

export const projectOverviewSchema = z.object({
  project: projectSchema,
  companyName: z.string().min(1).nullable().default(null),
  meetingCount: z.number().int().nonnegative(),
  openTaskCount: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
  lastActivityAt: isoDateTimeSchema.nullable().default(null),
});
export type ProjectOverview = z.infer<typeof projectOverviewSchema>;

export const meetingFilterSchema = z.object({
  query: z.string().default(''),
  from: z.string().optional(),
  to: z.string().optional(),
  companyId: idSchema.optional(),
  projectId: idSchema.optional(),
  meetingTypeId: idSchema.optional(),
  participantId: idSchema.optional(),
  state: meetingProcessingStateSchema.optional(),
});
/** Input type on purpose: pages build partial filters and the adapter fills defaults at the boundary. */
export type MeetingFilter = z.input<typeof meetingFilterSchema>;

export const taskFilterSchema = z.object({
  bucket: z.enum(['all', 'mine', 'open', 'overdue', 'completed']).default('all'),
  meetingId: idSchema.optional(),
  companyId: idSchema.optional(),
  projectId: idSchema.optional(),
  personId: idSchema.optional(),
  query: z.string().default(''),
});
export type TaskFilter = z.input<typeof taskFilterSchema>;

export const knowledgeFilterSchema = z.object({
  kinds: z.array(knowledgeKindSchema).default([]),
  companyId: idSchema.optional(),
  projectId: idSchema.optional(),
  participantId: idSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  query: z.string().default(''),
});
export type KnowledgeFilter = z.input<typeof knowledgeFilterSchema>;

export const searchHitSchema = z.object({
  kind: z.enum(['meeting', 'company', 'project', 'person', 'decision', 'task']),
  id: idSchema,
  title: z.string().min(1),
  subtitle: z.string().min(1),
  /** App-relative path; the repository layer never builds `next/link` objects. */
  href: z.string().min(1),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const meetingListRowSchema = z.object({
  meeting: meetingSummarySchema,
  /** Task/decision counts are needed by the meetings table but not part of `MeetingSummary` noise. */
  openTaskCount: z.number().int().nonnegative().default(0),
  overdueTaskCount: z.number().int().nonnegative().default(0),
});
export type MeetingListRow = z.infer<typeof meetingListRowSchema>;

/** Everything the transcript/speaker UI needs for one meeting, in a single read. */
/** Speaker label → person, as stored. `personId === null` means the label is still unclaimed. */
export const speakerMappingSchema = z.object({
  label: z.string().min(1),
  personId: idSchema.nullable(),
  confirmed: z.boolean().default(false),
  segmentCount: z.number().int().nonnegative(),
});
export type SpeakerMapping = z.infer<typeof speakerMappingSchema>;

export const meetingTranscriptSchema = z.object({
  meetingId: idSchema,
  segments: z.array(transcriptSegmentSchema),
  topics: z.array(topicSchema),
  participants: z.array(participantSchema),
  /** Persisted diarization-label → person assignments; `personId === null` means still unclaimed. */
  speakerMappings: z.array(speakerMappingSchema).default([]),
  totalMs: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
});
export type MeetingTranscript = z.infer<typeof meetingTranscriptSchema>;

/**
 * Windowed transcript reads. A long meeting must not be delivered as one unbounded array, and a page must not
 * fake that it is paginating by slicing in the browser: the read itself is scoped.
 *
 * `offset`/`span` address the *filtered* list, so search results and paging cannot disagree. `focusSegmentId`
 * is how an evidence deep link finds the window that contains its line: the caller names the line, the adapter
 * picks the offset. It is a request hint, never a mutation.
 */
export const transcriptWindowRequestSchema = z.object({
  meetingId: idSchema,
  offset: z.number().int().nonnegative().default(0),
  span: z.number().int().positive().max(400).default(120),
  query: z.string().default(''),
  /** A person id, or `label:Speaker A` for a diarization label nobody has claimed. */
  speaker: z.string().optional(),
  topicId: z.string().optional(),
  focusSegmentId: z.string().optional(),
});
/** What a caller may send: paging fields are optional and defaulted at the boundary. */
export type TranscriptWindowRequest = z.input<typeof transcriptWindowRequestSchema>;
/** What the resolver hands to the windowing function: every default applied. */
export type TranscriptWindowRead = z.output<typeof transcriptWindowRequestSchema>;

export const transcriptWindowSchema = z.object({
  meetingId: idSchema,
  segments: z.array(transcriptSegmentSchema),
  /** Lines matching the current filters — the population the offset counts through. */
  filteredCount: z.number().int().nonnegative(),
  /** Lines in the meeting regardless of filters, so the UI can say "3 of 59 lines". */
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  span: z.number().int().positive(),
  hasPrevious: z.boolean(),
  hasNext: z.boolean(),
  /** Set when a focus request moved the window, so the UI can say "jumped to the cited line". */
  focusedSegmentId: z.string().nullable().default(null),
  /** Word count and duration of the whole transcript, not the window: totals must not shrink with paging. */
  totalMs: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
});
export type TranscriptWindow = z.infer<typeof transcriptWindowSchema>;

/** A member roster row: a person plus their workspace role and invitation state. */
export const workspaceMemberSchema = z.object({
  personId: idSchema,
  name: z.string().min(1),
  email: z.string().min(1).optional(),
  role: z.enum(['owner', 'admin', 'member']),
  status: z.enum(['active', 'invited', 'disabled']),
  /** Person ids this member owns tasks for; lets the UI explain why a removal was refused. */
  openTaskCount: z.number().int().nonnegative().default(0),
  meetingCount: z.number().int().nonnegative().default(0),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const workspaceSettingsSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const dashboardSnapshotSchema = z.object({
  workspaceId: idSchema,
  generatedAt: isoDateTimeSchema,
  todayMeetings: z.array(meetingSummarySchema).default([]),
  openTaskCount: z.number().int().nonnegative(),
  overdueTaskCount: z.number().int().nonnegative(),
  decisionCount7d: z.number().int().nonnegative(),
  openQuestionCount: z.number().int().nonnegative(),
  recentMeetings: z.array(meetingListRowSchema).default([]),
  upcomingOrToday: z.array(meetingSummarySchema).default([]),
  recentActions: z.array(taskSchema).default([]),
  recentDecisions: z.array(decisionSchema).default([]),
  processing: z.array(processingTimelineSchema).default([]),
  meetingCount: z.number().int().nonnegative(),
  companyCount: z.number().int().nonnegative(),
});
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;

/** Format a millisecond offset as `HH:MM:SS` or `MM:SS` — the transcript's canonical display form. */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** Compact duration for row/table density, e.g. `1h 03m` or `42m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
