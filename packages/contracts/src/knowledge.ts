import { z } from 'zod';
import { intelligenceEntityTypeSchema } from './intelligence';
import { RESOURCE_ID_SCHEMA_PATTERN, countSchema } from './recorder';
import { meetingPipelineStatusSchema, processingJobDtoSchema } from './upload';

const uuidSchema = () => z.string().regex(RESOURCE_ID_SCHEMA_PATTERN, 'expected a lowercase UUID');

export const KNOWLEDGE_CHUNKING_VERSION = 'phase7-chunker-v1';
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 64;
export const DEFAULT_OPENAI_EMBEDDING_DIMENSIONS = 1536;

export function buildCanonicalGenerateEmbeddingsJobIdempotencyKey(
  analysisRunId: string,
  generation = 1,
): string {
  return `analysis_run:${analysisRunId}:generate_embeddings:gen:${generation}`;
}

export function buildCanonicalIndexKnowledgeJobIdempotencyKey(
  embeddingRunId: string,
  generation = 1,
): string {
  return `embedding_run:${embeddingRunId}:index_knowledge:gen:${generation}`;
}

export const embeddingRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'superseded',
]);
export type EmbeddingRunStatus = z.infer<typeof embeddingRunStatusSchema>;

export const knowledgeChunkTypeSchema = z.enum([
  'transcript',
  'summary',
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
export type KnowledgeChunkType = z.infer<typeof knowledgeChunkTypeSchema>;

export const embeddingRunDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  recordingId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  analysisRunId: uuidSchema(),
  runNumber: z.number().int().min(1),
  provider: z.string().min(2).max(64),
  model: z.string().min(1).max(120),
  dimensions: z.number().int().min(8).max(4096),
  chunkingVersion: z.string().min(1).max(64),
  status: embeddingRunStatusSchema,
  chunkCount: countSchema,
  transcriptSourceCount: countSchema,
  itemSourceCount: countSchema,
  startedAt: z.string().datetime().nullable(),
  providerCompletedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  failureMetadata: z.record(z.string(), z.unknown()),
  tokenUsageMetadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EmbeddingRunDto = z.infer<typeof embeddingRunDtoSchema>;

export const knowledgeChunkTranscriptSourceDtoSchema = z.object({
  id: uuidSchema(),
  knowledgeChunkId: uuidSchema(),
  transcriptSegmentId: uuidSchema(),
  sequenceNo: countSchema,
});
export type KnowledgeChunkTranscriptSourceDto = z.infer<
  typeof knowledgeChunkTranscriptSourceDtoSchema
>;

export const knowledgeChunkItemSourceDtoSchema = z.object({
  id: uuidSchema(),
  knowledgeChunkId: uuidSchema(),
  entityType: intelligenceEntityTypeSchema,
  entityId: uuidSchema(),
  sequenceNo: countSchema,
});
export type KnowledgeChunkItemSourceDto = z.infer<typeof knowledgeChunkItemSourceDtoSchema>;

export const knowledgeChunkDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  companyId: uuidSchema().nullable(),
  projectId: uuidSchema().nullable(),
  meetingId: uuidSchema(),
  embeddingRunId: uuidSchema(),
  transcriptionRunId: uuidSchema(),
  analysisRunId: uuidSchema(),
  sequenceNo: countSchema,
  chunkKey: z.string().min(1).max(160),
  chunkType: knowledgeChunkTypeSchema,
  title: z.string().min(1).max(500),
  canonicalText: z.string().min(1).max(16000),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  startMs: countSchema,
  endMs: countSchema,
  speakerLabels: z.array(z.string()),
  participantIds: z.array(uuidSchema()),
  tags: z.array(z.string()),
  sourceVersion: z.string().min(1).max(64),
  embeddingProvider: z.string().min(2).max(64),
  embeddingModel: z.string().min(1).max(120),
  embeddingDimensions: z.number().int().min(8).max(4096),
  transcriptSources: z.array(knowledgeChunkTranscriptSourceDtoSchema),
  itemSources: z.array(knowledgeChunkItemSourceDtoSchema),
  createdAt: z.string().datetime(),
});
export type KnowledgeChunkDto = z.infer<typeof knowledgeChunkDtoSchema>;

export const meetingKnowledgeStatusResponseSchema = z.object({
  meetingId: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingStatus: meetingPipelineStatusSchema,
  currentEmbeddingRunId: uuidSchema().nullable(),
  latestEmbeddingRunId: uuidSchema().nullable(),
  runs: z.array(embeddingRunDtoSchema),
  chunks: z.array(knowledgeChunkDtoSchema),
  jobs: z.array(processingJobDtoSchema),
});
export const getMeetingKnowledgeStatusResponseSchema = meetingKnowledgeStatusResponseSchema;
export type MeetingKnowledgeStatusResponse = z.infer<typeof meetingKnowledgeStatusResponseSchema>;
export type GetMeetingKnowledgeStatusResponse = MeetingKnowledgeStatusResponse;

export const reindexKnowledgeRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  reason: z.string().trim().min(1).max(200).optional(),
  force: z.boolean().optional(),
});
export type ReindexKnowledgeRequestInput = z.infer<typeof reindexKnowledgeRequestSchema>;

export const reindexKnowledgeResponseSchema = z.object({
  meetingId: uuidSchema(),
  workspaceId: uuidSchema(),
  analysisRunId: uuidSchema(),
  job: processingJobDtoSchema,
  idempotentReused: z.boolean(),
});
export type ReindexKnowledgeResponse = z.infer<typeof reindexKnowledgeResponseSchema>;

export const askWorkspaceQuestionRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  companyId: uuidSchema().nullable().optional(),
  projectId: uuidSchema().nullable().optional(),
  meetingId: uuidSchema().nullable().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type AskWorkspaceQuestionRequestInput = z.infer<typeof askWorkspaceQuestionRequestSchema>;

export const askAiCitationDtoSchema = z.object({
  kind: z.enum(['decision', 'task', 'fact', 'question', 'idea', 'segment', 'commitment']),
  id: uuidSchema(),
  meetingId: uuidSchema(),
  meetingTitle: z.string().min(1),
  occurredAt: z.string().datetime(),
  startMs: countSchema,
  endMs: countSchema,
  speakerNames: z.array(z.string().min(1)).default([]),
  quote: z.string().min(1),
  segmentIds: z.array(uuidSchema()),
  target: z.enum(['overview', 'transcript', 'decisions', 'tasks', 'facts', 'questions', 'ideas']),
});
export type AskAiCitationDto = z.infer<typeof askAiCitationDtoSchema>;

export const askWorkspaceQuestionResponseSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  companyId: uuidSchema().nullable(),
  projectId: uuidSchema().nullable(),
  meetingId: uuidSchema().nullable(),
  question: z.string().min(1),
  answer: z.array(z.string().min(1)).min(1),
  citations: z.array(askAiCitationDtoSchema),
  adapter: z.enum(['rag_pipeline', 'demo_fixtures']),
  provider: z.string().min(2).max(64),
  model: z.string().min(1).max(120),
  retrievedChunkIds: z.array(uuidSchema()),
  generatedAt: z.string().datetime(),
  matchedKnownQuestion: z.boolean(),
  notes: z.array(z.string().min(1)),
});
export type AskWorkspaceQuestionResponse = z.infer<typeof askWorkspaceQuestionResponseSchema>;
