import { z } from 'zod';
import { RESOURCE_ID_SCHEMA_PATTERN, countSchema } from './recorder';
import { meetingPipelineStatusSchema, processingJobDtoSchema } from './upload';

const uuidSchema = () => z.string().regex(RESOURCE_ID_SCHEMA_PATTERN, 'expected a lowercase UUID');

export const MEETING_INTELLIGENCE_PROMPT_VERSION = 'phase6-prompt-v1';
export const MEETING_INTELLIGENCE_SCHEMA_VERSION = 'phase6-schema-v1';
export const MEETING_INTELLIGENCE_PIPELINE_VERSION = 'phase6-pipeline-v1';

export function buildCanonicalAnalyzeMeetingJobIdempotencyKey(
  transcriptionRunId: string,
  generation = 1,
): string {
  return `transcription_run:${transcriptionRunId}:analyze_meeting:gen:${generation}`;
}

export function buildCanonicalNormalizeIntelligenceJobIdempotencyKey(
  analysisRunId: string,
  generation = 1,
): string {
  return `analysis_run:${analysisRunId}:normalize_intelligence:gen:${generation}`;
}

export function buildCanonicalFinalizeAnalysisJobIdempotencyKey(
  analysisRunId: string,
  generation = 1,
): string {
  return `analysis_run:${analysisRunId}:finalize_analysis:gen:${generation}`;
}

export const analysisRunStatusSchema = z.enum([
  'queued',
  'running',
  'normalizing',
  'completed',
  'failed',
  'superseded',
]);
export type AnalysisRunStatus = z.infer<typeof analysisRunStatusSchema>;

export const decisionStatusSchema = z.enum([
  'proposed',
  'tentative',
  'confirmed',
  'rejected',
  'superseded',
]);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const actionItemStatusSchema = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export type ActionItemStatus = z.infer<typeof actionItemStatusSchema>;

export const factCategorySchema = z.enum([
  'budget',
  'metric',
  'timeline',
  'team',
  'commercial',
  'technical',
  'legal',
  'operations',
  'general',
]);
export type FactCategory = z.infer<typeof factCategorySchema>;

export const questionStatusSchema = z.enum(['open', 'answered', 'deferred']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

export const ideaStatusSchema = z.enum(['captured', 'exploring', 'accepted', 'parked', 'rejected']);
export type IdeaStatus = z.infer<typeof ideaStatusSchema>;

export const objectionStatusSchema = z.enum(['open', 'addressed', 'mitigated', 'unresolved']);
export type ObjectionStatus = z.infer<typeof objectionStatusSchema>;

export const commitmentStatusSchema = z.enum(['pending', 'kept', 'at_risk', 'broken']);
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>;

export const riskSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;

export const riskStatusSchema = z.enum(['open', 'mitigating', 'resolved', 'accepted']);
export type RiskStatus = z.infer<typeof riskStatusSchema>;

export const intelligenceEntityTypeSchema = z.enum([
  'summary_claim',
  'topic',
  'decision',
  'action_item',
  'fact',
  'question',
  'idea',
  'objection',
  'commitment',
  'risk',
]);
export type IntelligenceEntityType = z.infer<typeof intelligenceEntityTypeSchema>;

export const summaryClaimSectionSchema = z.enum([
  'purpose',
  'discussion',
  'decision',
  'action',
  'unresolved',
]);
export type SummaryClaimSection = z.infer<typeof summaryClaimSectionSchema>;

/**
 * Provider-level structured output schemas.
 * Notice: LLM outputs reference `sourceSegmentIds` only. Canonical timestamps are NEVER taken from LLM output.
 */
export const providerExecutiveSummaryClaimSchema = z.object({
  claimKey: z.string().trim().min(1).max(160),
  section: summaryClaimSectionSchema,
  text: z.string().trim().min(1),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderExecutiveSummaryClaim = z.infer<typeof providerExecutiveSummaryClaimSchema>;

export const providerExecutiveSummarySchema = z.object({
  headline: z.string().trim().min(1),
  tlDr: z.string().trim().min(1),
  whyMeetingHappened: z.string().trim().min(1),
  majorDiscussions: z.array(z.string().trim().min(1)).min(1),
  confirmedDecisions: z.array(z.string().trim().min(1)),
  nextActions: z.array(z.string().trim().min(1)),
  unresolvedPoints: z.array(z.string().trim().min(1)),
  followUps: z.array(z.string().trim().min(1)).default([]),
  claims: z.array(providerExecutiveSummaryClaimSchema).min(1),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderExecutiveSummary = z.infer<typeof providerExecutiveSummarySchema>;

export const providerTopicCandidateSchema = z.object({
  topicKey: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  keywords: z.array(z.string().trim().min(1)).default([]),
  speakerLabels: z.array(z.string().trim().min(1)).default([]),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderTopicCandidate = z.infer<typeof providerTopicCandidateSchema>;

export const providerDecisionCandidateSchema = z.object({
  decisionKey: z.string().trim().min(1).max(160),
  statement: z.string().trim().min(1),
  rationale: z.string().trim().min(1).nullable().default(null),
  status: decisionStatusSchema,
  ownerLabel: z.string().trim().min(1).nullable().default(null),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderDecisionCandidate = z.infer<typeof providerDecisionCandidateSchema>;

export const providerActionItemCandidateSchema = z.object({
  actionKey: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1),
  ownerLabel: z.string().trim().min(1).nullable().default(null),
  dueHint: z.string().trim().min(1).nullable().default(null),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected ISO date YYYY-MM-DD')
    .nullable()
    .default(null),
  status: actionItemStatusSchema.default('open'),
  topicKey: z.string().trim().min(1).nullable().default(null),
  decisionKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderActionItemCandidate = z.infer<typeof providerActionItemCandidateSchema>;

export const providerFactCandidateSchema = z.object({
  factKey: z.string().trim().min(1).max(160),
  category: factCategorySchema,
  label: z.string().trim().min(1),
  valueText: z.string().trim().min(1),
  unit: z.string().trim().min(1).nullable().default(null),
  numericValue: z.number().nullable().default(null),
  speakerLabel: z.string().trim().min(1).nullable().default(null),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderFactCandidate = z.infer<typeof providerFactCandidateSchema>;

export const providerQuestionCandidateSchema = z.object({
  questionKey: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1),
  status: questionStatusSchema.default('open'),
  askedByLabel: z.string().trim().min(1).nullable().default(null),
  ownerLabel: z.string().trim().min(1).nullable().default(null),
  answerSummary: z.string().trim().min(1).nullable().default(null),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderQuestionCandidate = z.infer<typeof providerQuestionCandidateSchema>;

export const providerIdeaCandidateSchema = z.object({
  ideaKey: z.string().trim().min(1).max(160),
  idea: z.string().trim().min(1),
  notes: z.string().trim().min(1).nullable().default(null),
  status: ideaStatusSchema.default('captured'),
  proposedByLabel: z.string().trim().min(1).nullable().default(null),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderIdeaCandidate = z.infer<typeof providerIdeaCandidateSchema>;

export const providerObjectionCandidateSchema = z.object({
  objectionKey: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1),
  status: objectionStatusSchema.default('open'),
  raisedByLabel: z.string().trim().min(1).nullable().default(null),
  responseSummary: z.string().trim().min(1).nullable().default(null),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderObjectionCandidate = z.infer<typeof providerObjectionCandidateSchema>;

export const providerCommitmentCandidateSchema = z.object({
  commitmentKey: z.string().trim().min(1).max(160),
  commitment: z.string().trim().min(1),
  ownerLabel: z.string().trim().min(1).nullable().default(null),
  counterpartyLabel: z.string().trim().min(1).nullable().default(null),
  dueLabel: z.string().trim().min(1).nullable().default(null),
  status: commitmentStatusSchema.default('pending'),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderCommitmentCandidate = z.infer<typeof providerCommitmentCandidateSchema>;

export const providerRiskCandidateSchema = z.object({
  riskKey: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1).nullable().default(null),
  severity: riskSeveritySchema.default('medium'),
  status: riskStatusSchema.default('open'),
  mitigation: z.string().trim().min(1).nullable().default(null),
  ownerLabel: z.string().trim().min(1).nullable().default(null),
  topicKey: z.string().trim().min(1).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
});
export type ProviderRiskCandidate = z.infer<typeof providerRiskCandidateSchema>;

export const providerWindowExtractionSchema = z.object({
  windowIndex: countSchema,
  executiveSummary: providerExecutiveSummarySchema,
  topics: z.array(providerTopicCandidateSchema),
  decisions: z.array(providerDecisionCandidateSchema),
  actionItems: z.array(providerActionItemCandidateSchema),
  facts: z.array(providerFactCandidateSchema),
  questions: z.array(providerQuestionCandidateSchema),
  ideas: z.array(providerIdeaCandidateSchema),
  objections: z.array(providerObjectionCandidateSchema),
  commitments: z.array(providerCommitmentCandidateSchema),
  risks: z.array(providerRiskCandidateSchema),
  followUps: z.array(z.string().trim().min(1)).default([]),
});
export type ProviderWindowExtraction = z.infer<typeof providerWindowExtractionSchema>;

export const providerTokenUsageSchema = z.object({
  promptTokens: countSchema,
  completionTokens: countSchema,
  totalTokens: countSchema,
});
export type ProviderTokenUsage = z.infer<typeof providerTokenUsageSchema>;

export const providerMeetingIntelligenceResultSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(120),
  promptVersion: z.string().trim().min(1).max(64),
  schemaVersion: z.string().trim().min(1).max(64),
  pipelineVersion: z.string().trim().min(1).max(64),
  tokenUsage: providerTokenUsageSchema,
  windowCount: z.number().int().positive(),
  extraction: providerWindowExtractionSchema,
  providerMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderMeetingIntelligenceResult = z.infer<
  typeof providerMeetingIntelligenceResultSchema
>;

/**
 * Canonical persisted DTO schemas.
 */
export const intelligenceEvidenceDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  entityType: intelligenceEntityTypeSchema,
  entityId: uuidSchema(),
  transcriptSegmentId: uuidSchema(),
  evidenceOrder: countSchema,
  startMs: countSchema,
  endMs: countSchema,
  speakerDisplayLabel: z.string().min(1),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  createdAt: z.string().min(1),
});
export type IntelligenceEvidenceDto = z.infer<typeof intelligenceEvidenceDtoSchema>;

export const analysisRunDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  runNumber: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  pipelineVersion: z.string().min(1),
  status: analysisRunStatusSchema,
  windowCount: countSchema,
  topicCount: countSchema,
  decisionCount: countSchema,
  actionItemCount: countSchema,
  factCount: countSchema,
  questionCount: countSchema,
  ideaCount: countSchema,
  objectionCount: countSchema,
  commitmentCount: countSchema,
  riskCount: countSchema,
  evidenceCount: countSchema,
  quarantinedItemCount: countSchema,
  startedAt: z.string().nullable(),
  providerCompletedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  failureMetadata: z.record(z.string(), z.unknown()),
  tokenUsageMetadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AnalysisRunDto = z.infer<typeof analysisRunDtoSchema>;

export const meetingSummaryDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  headline: z.string().min(1),
  tlDr: z.string().min(1),
  whyMeetingHappened: z.string().min(1),
  majorDiscussions: z.array(z.string()),
  confirmedDecisions: z.array(z.string()),
  nextActions: z.array(z.string()),
  unresolvedPoints: z.array(z.string()),
  followUps: z.array(z.string()),
  claims: z.array(providerExecutiveSummaryClaimSchema),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingSummaryDto = z.infer<typeof meetingSummaryDtoSchema>;

export const meetingTopicDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  sequenceNo: countSchema,
  topicKey: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  keywords: z.array(z.string()),
  participantIds: z.array(uuidSchema()),
  speakerLabels: z.array(z.string()),
  startMs: countSchema,
  endMs: countSchema,
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingTopicDto = z.infer<typeof meetingTopicDtoSchema>;

export const meetingDecisionDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  decisionKey: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().nullable(),
  status: decisionStatusSchema,
  ownerParticipantId: uuidSchema().nullable(),
  ownerLabel: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingDecisionDto = z.infer<typeof meetingDecisionDtoSchema>;

export const meetingActionItemDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  decisionId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  actionKey: z.string().min(1),
  title: z.string().min(1),
  ownerParticipantId: uuidSchema().nullable(),
  ownerLabel: z.string().nullable(),
  dueHint: z.string().nullable(),
  dueDate: z.string().nullable(),
  status: actionItemStatusSchema,
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingActionItemDto = z.infer<typeof meetingActionItemDtoSchema>;

export const meetingFactDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  factKey: z.string().min(1),
  category: factCategorySchema,
  label: z.string().min(1),
  valueText: z.string().min(1),
  unit: z.string().nullable(),
  numericValue: z.number().nullable(),
  speakerParticipantId: uuidSchema().nullable(),
  speakerLabel: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingFactDto = z.infer<typeof meetingFactDtoSchema>;

export const meetingQuestionDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  questionKey: z.string().min(1),
  question: z.string().min(1),
  status: questionStatusSchema,
  askedByParticipantId: uuidSchema().nullable(),
  askedByLabel: z.string().nullable(),
  ownerParticipantId: uuidSchema().nullable(),
  ownerLabel: z.string().nullable(),
  answerSummary: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingQuestionDto = z.infer<typeof meetingQuestionDtoSchema>;

export const meetingIdeaDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  ideaKey: z.string().min(1),
  idea: z.string().min(1),
  notes: z.string().nullable(),
  status: ideaStatusSchema,
  proposedByParticipantId: uuidSchema().nullable(),
  proposedByLabel: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingIdeaDto = z.infer<typeof meetingIdeaDtoSchema>;

export const meetingObjectionDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  objectionKey: z.string().min(1),
  summary: z.string().min(1),
  status: objectionStatusSchema,
  raisedByParticipantId: uuidSchema().nullable(),
  raisedByLabel: z.string().nullable(),
  responseSummary: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingObjectionDto = z.infer<typeof meetingObjectionDtoSchema>;

export const meetingCommitmentDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  commitmentKey: z.string().min(1),
  commitment: z.string().min(1),
  ownerParticipantId: uuidSchema().nullable(),
  ownerLabel: z.string().nullable(),
  counterpartyLabel: z.string().nullable(),
  dueLabel: z.string().nullable(),
  status: commitmentStatusSchema,
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingCommitmentDto = z.infer<typeof meetingCommitmentDtoSchema>;

export const meetingRiskDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  topicId: uuidSchema().nullable(),
  sequenceNo: countSchema,
  riskKey: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().nullable(),
  severity: riskSeveritySchema,
  status: riskStatusSchema,
  mitigation: z.string().nullable(),
  ownerParticipantId: uuidSchema().nullable(),
  ownerLabel: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  sourceSegmentIds: z.array(uuidSchema()).min(1),
  evidence: z.array(intelligenceEvidenceDtoSchema).min(1),
  createdAt: z.string().min(1),
});
export type MeetingRiskDto = z.infer<typeof meetingRiskDtoSchema>;

export const meetingAnalysisStatusResponseSchema = z.object({
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
  currentTranscriptionRunId: uuidSchema().nullable(),
  currentAnalysisRunId: uuidSchema().nullable(),
  latestAnalysisRunId: uuidSchema().nullable(),
  runs: z.array(analysisRunDtoSchema),
  jobs: z.array(processingJobDtoSchema),
});
export type MeetingAnalysisStatusResponse = z.infer<typeof meetingAnalysisStatusResponseSchema>;

export const getMeetingIntelligenceResponseSchema = z.object({
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  currentAnalysisRun: analysisRunDtoSchema.nullable(),
  summary: meetingSummaryDtoSchema.nullable(),
  topics: z.array(meetingTopicDtoSchema),
  decisions: z.array(meetingDecisionDtoSchema),
  actionItems: z.array(meetingActionItemDtoSchema),
  facts: z.array(meetingFactDtoSchema),
  questions: z.array(meetingQuestionDtoSchema),
  ideas: z.array(meetingIdeaDtoSchema),
  objections: z.array(meetingObjectionDtoSchema),
  commitments: z.array(meetingCommitmentDtoSchema),
  risks: z.array(meetingRiskDtoSchema),
  evidenceCount: countSchema,
  quarantinedItemCount: countSchema,
});
export type GetMeetingIntelligenceResponse = z.infer<typeof getMeetingIntelligenceResponseSchema>;

export const retryAnalysisRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  reason: z.string().trim().max(240).optional(),
});
export type RetryAnalysisRequest = z.infer<typeof retryAnalysisRequestSchema>;
export type RetryAnalysisRequestInput = z.input<typeof retryAnalysisRequestSchema>;

export const retryAnalysisResponseSchema = z.object({
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  job: processingJobDtoSchema,
  idempotentReused: z.boolean(),
});
export type RetryAnalysisResponse = z.infer<typeof retryAnalysisResponseSchema>;
