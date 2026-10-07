import {
  KNOWLEDGE_CHUNKING_VERSION,
  type CanonicalTranscriptSegmentDto,
  type GetMeetingIntelligenceResponse,
  type IntelligenceEntityType,
  type KnowledgeChunkType,
} from '@suhbat/contracts';
import { computeSha256Hex } from './storage';

export const KNOWLEDGE_SOURCE_VERSION = KNOWLEDGE_CHUNKING_VERSION;

export type CanonicalKnowledgeChunkDraft = {
  sequenceNo: number;
  chunkKey: string;
  chunkType: KnowledgeChunkType;
  title: string;
  canonicalText: string;
  contentSha256: string;
  startMs: number;
  endMs: number;
  speakerLabels: string[];
  participantIds: string[];
  tags: string[];
  sourceVersion: string;
  transcriptSegmentIds: string[];
  itemSources: Array<{
    entityType: IntelligenceEntityType;
    entityId: string;
  }>;
};

export type BuildKnowledgeChunksInput = {
  meetingTitle: string;
  segments: CanonicalTranscriptSegmentDto[];
  intelligence: GetMeetingIntelligenceResponse;
  maxSegmentsPerTranscriptChunk?: number;
};

function computeTextSha256(text: string): string {
  return computeSha256Hex(new TextEncoder().encode(text));
}

export function computeKnowledgeContentHash(input: {
  chunkType: KnowledgeChunkType;
  chunkKey: string;
  canonicalText: string;
}): string {
  return computeTextSha256(`${input.chunkType}:${input.chunkKey}:${input.canonicalText.trim()}`);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const val of values) {
    if (!val) continue;
    const trimmed = val.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Deterministically builds canonical knowledge chunks from a meeting's verified transcript segments
 * and finalized Phase 6 intelligence records (`docs/ai-pipeline.md` §264, `docs/database.md` §132-133).
 *
 * Every knowledge chunk links to canonical `transcript_segments` IDs and/or typed intelligence `entity_id`s
 * in the exact same meeting, workspace, transcription run, and analysis run.
 */
export function buildCanonicalKnowledgeChunks(
  input: BuildKnowledgeChunksInput,
): CanonicalKnowledgeChunkDraft[] {
  const canonicalSegments = input.segments.filter(
    (s) => !s.alignmentStatus || s.alignmentStatus === 'canonical',
  );
  const segmentById = new Map<string, CanonicalTranscriptSegmentDto>();
  for (const seg of canonicalSegments) {
    segmentById.set(seg.id, seg);
  }

  const resolveValidSegmentMetadata = (
    segmentIds?: string[],
    evidence?: ReadonlyArray<{ transcriptSegmentId: string }>,
  ) => {
    const rawIds = [
      ...(segmentIds ?? []),
      ...(evidence ? evidence.map((e) => e.transcriptSegmentId) : []),
    ];
    const validSegs = uniqueStrings(rawIds)
      .map((id) => segmentById.get(id))
      .filter((s): s is CanonicalTranscriptSegmentDto => s !== undefined)
      .sort((a, b) => a.startMs - b.startMs || a.sequenceNo - b.sequenceNo);

    const startMs = validSegs[0]?.startMs ?? 0;
    const endMs = validSegs[validSegs.length - 1]?.endMs ?? startMs;
    const speakerLabels = uniqueStrings(
      validSegs.map((s) => s.speakerDisplayLabel ?? s.providerSpeakerLabel),
    );
    const participantIds = uniqueStrings(validSegs.map((s) => s.participantId));
    return {
      validSegmentIds: validSegs.map((s) => s.id),
      startMs,
      endMs,
      speakerLabels,
      participantIds,
    };
  };

  const drafts: CanonicalKnowledgeChunkDraft[] = [];
  const pushDraft = (
    draft: Omit<CanonicalKnowledgeChunkDraft, 'sequenceNo' | 'contentSha256' | 'sourceVersion'>,
  ) => {
    if (draft.transcriptSegmentIds.length === 0) return;
    const canonicalText = draft.canonicalText.trim();
    if (!canonicalText) return;
    drafts.push({
      ...draft,
      canonicalText,
      sequenceNo: drafts.length,
      contentSha256: computeKnowledgeContentHash({
        chunkType: draft.chunkType,
        chunkKey: draft.chunkKey,
        canonicalText,
      }),
      sourceVersion: KNOWLEDGE_CHUNKING_VERSION,
    });
  };

  const { intelligence } = input;

  // 1. Summary chunk
  if (intelligence.summary) {
    const summary = intelligence.summary;
    const meta = resolveValidSegmentMetadata(summary.sourceSegmentIds, summary.evidence);
    const bodyLines = [
      summary.headline,
      summary.tlDr,
      summary.whyMeetingHappened,
      ...(summary.confirmedDecisions ?? []),
      ...(summary.nextActions ?? []),
    ].filter(Boolean);
    pushDraft({
      chunkKey: `summary:${summary.id}`,
      chunkType: 'summary',
      title: `${input.meetingTitle} — Executive Summary`,
      canonicalText: bodyLines.join(' | '),
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: meta.speakerLabels,
      participantIds: meta.participantIds,
      tags: ['summary', 'executive_summary'],
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'summary_claim', entityId: summary.id }],
    });
  }

  // 2. Topic chunks
  for (const topic of intelligence.topics) {
    const meta = resolveValidSegmentMetadata(topic.sourceSegmentIds, topic.evidence);
    pushDraft({
      chunkKey: `topic:${topic.topicKey ?? topic.id}`,
      chunkType: 'topic',
      title: topic.title,
      canonicalText: `${topic.title}: ${topic.summary}${
        topic.keywords.length > 0 ? ` (Keywords: ${topic.keywords.join(', ')})` : ''
      }`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: uniqueStrings([...(topic.speakerLabels ?? []), ...meta.speakerLabels]),
      participantIds: uniqueStrings([...(topic.participantIds ?? []), ...meta.participantIds]),
      tags: uniqueStrings(['topic', ...topic.keywords]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'topic', entityId: topic.id }],
    });
  }

  // 3. Decision chunks
  for (const decision of intelligence.decisions) {
    const meta = resolveValidSegmentMetadata(decision.sourceSegmentIds, decision.evidence);
    pushDraft({
      chunkKey: `decision:${decision.decisionKey ?? decision.id}`,
      chunkType: 'decision',
      title: decision.statement,
      canonicalText: `Decision (${decision.status}): ${decision.statement}${
        decision.rationale ? ` — Rationale: ${decision.rationale}` : ''
      }${decision.ownerLabel ? ` — Owner: ${decision.ownerLabel}` : ''}`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: meta.speakerLabels,
      participantIds: uniqueStrings([decision.ownerParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['decision', decision.status]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'decision', entityId: decision.id }],
    });
  }

  // 4. Action item / task chunks
  for (const action of intelligence.actionItems) {
    const meta = resolveValidSegmentMetadata(action.sourceSegmentIds, action.evidence);
    pushDraft({
      chunkKey: `action_item:${action.actionKey ?? action.id}`,
      chunkType: 'action_item',
      title: action.title,
      canonicalText: `Task (${action.status}): ${action.title}${
        action.ownerLabel ? ` — Owner: ${action.ownerLabel}` : ' — Owner: Unassigned'
      }${action.dueDate ? ` — Due: ${action.dueDate}` : action.dueHint ? ` — Due hint: ${action.dueHint}` : ''}`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: meta.speakerLabels,
      participantIds: uniqueStrings([action.ownerParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['task', 'action_item', action.status, action.ownerLabel]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'action_item', entityId: action.id }],
    });
  }

  // 5. Fact chunks
  for (const fact of intelligence.facts) {
    const meta = resolveValidSegmentMetadata(fact.sourceSegmentIds, fact.evidence);
    pushDraft({
      chunkKey: `fact:${fact.factKey ?? fact.id}`,
      chunkType: 'fact',
      title: `${fact.label}: ${fact.valueText}${fact.unit ? ` ${fact.unit}` : ''}`,
      canonicalText: `Fact (${fact.category}) — ${fact.label}: ${fact.valueText}${
        fact.unit ? ` ${fact.unit}` : ''
      }`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: uniqueStrings([fact.speakerLabel, ...meta.speakerLabels]),
      participantIds: uniqueStrings([fact.speakerParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['fact', fact.category, fact.label]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'fact', entityId: fact.id }],
    });
  }

  // 6. Question chunks
  for (const question of intelligence.questions) {
    const meta = resolveValidSegmentMetadata(question.sourceSegmentIds, question.evidence);
    pushDraft({
      chunkKey: `question:${question.questionKey ?? question.id}`,
      chunkType: 'question',
      title: question.question,
      canonicalText: `Question (${question.status}): ${question.question}${
        question.answerSummary ? ` — Answer: ${question.answerSummary}` : ''
      }`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: uniqueStrings([question.askedByLabel, ...meta.speakerLabels]),
      participantIds: uniqueStrings([
        question.askedByParticipantId,
        question.ownerParticipantId,
        ...meta.participantIds,
      ]),
      tags: uniqueStrings(['question', question.status]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'question', entityId: question.id }],
    });
  }

  // 7. Idea chunks
  for (const idea of intelligence.ideas) {
    const meta = resolveValidSegmentMetadata(idea.sourceSegmentIds, idea.evidence);
    pushDraft({
      chunkKey: `idea:${idea.ideaKey ?? idea.id}`,
      chunkType: 'idea',
      title: idea.idea,
      canonicalText: `Idea (${idea.status}): ${idea.idea}${idea.notes ? ` — ${idea.notes}` : ''}`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: uniqueStrings([idea.proposedByLabel, ...meta.speakerLabels]),
      participantIds: uniqueStrings([idea.proposedByParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['idea', idea.status]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'idea', entityId: idea.id }],
    });
  }

  // 8. Objection chunks
  for (const objection of intelligence.objections) {
    const meta = resolveValidSegmentMetadata(objection.sourceSegmentIds, objection.evidence);
    pushDraft({
      chunkKey: `objection:${objection.objectionKey ?? objection.id}`,
      chunkType: 'objection',
      title: objection.summary,
      canonicalText: `Objection (${objection.status}): ${objection.summary}${
        objection.responseSummary ? ` — Response: ${objection.responseSummary}` : ''
      }`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: uniqueStrings([objection.raisedByLabel, ...meta.speakerLabels]),
      participantIds: uniqueStrings([objection.raisedByParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['objection', objection.status]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'objection', entityId: objection.id }],
    });
  }

  // 9. Commitment chunks
  for (const commitment of intelligence.commitments) {
    const meta = resolveValidSegmentMetadata(commitment.sourceSegmentIds, commitment.evidence);
    pushDraft({
      chunkKey: `commitment:${commitment.commitmentKey ?? commitment.id}`,
      chunkType: 'commitment',
      title: commitment.commitment,
      canonicalText: `Commitment (${commitment.status}): ${commitment.commitment}${
        commitment.ownerLabel ? ` — By: ${commitment.ownerLabel}` : ''
      }${commitment.dueLabel ? ` — Due: ${commitment.dueLabel}` : ''}`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: meta.speakerLabels,
      participantIds: uniqueStrings([commitment.ownerParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['commitment', commitment.status]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'commitment', entityId: commitment.id }],
    });
  }

  // 10. Risk chunks
  for (const risk of intelligence.risks) {
    const meta = resolveValidSegmentMetadata(risk.sourceSegmentIds, risk.evidence);
    pushDraft({
      chunkKey: `risk:${risk.riskKey ?? risk.id}`,
      chunkType: 'risk',
      title: risk.title,
      canonicalText: `Risk (${risk.severity}, ${risk.status}): ${risk.title}${
        risk.detail ? ` — ${risk.detail}` : ''
      }${risk.mitigation ? ` — Mitigation: ${risk.mitigation}` : ''}`,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: meta.speakerLabels,
      participantIds: uniqueStrings([risk.ownerParticipantId, ...meta.participantIds]),
      tags: uniqueStrings(['risk', risk.severity, risk.status]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [{ entityType: 'risk', entityId: risk.id }],
    });
  }

  // 11. Bounded transcript window chunks (so every spoken line is searchable even if not part of a typed record)
  const maxSegs = Math.max(1, input.maxSegmentsPerTranscriptChunk ?? 4);
  for (let i = 0; i < canonicalSegments.length; i += maxSegs) {
    const slice = canonicalSegments.slice(i, i + maxSegs);
    const segIds = slice.map((s) => s.id);
    const meta = resolveValidSegmentMetadata(segIds);
    const text = slice
      .map((s) => `${s.speakerDisplayLabel ?? s.providerSpeakerLabel}: ${s.text}`)
      .join(' ');
    pushDraft({
      chunkKey: `transcript:seg_${slice[0]!.sequenceNo}_${slice[slice.length - 1]!.sequenceNo}`,
      chunkType: 'transcript',
      title: `${input.meetingTitle} — Transcript (${slice[0]!.sequenceNo + 1}–${slice[slice.length - 1]!.sequenceNo + 1})`,
      canonicalText: text,
      startMs: meta.startMs,
      endMs: meta.endMs,
      speakerLabels: meta.speakerLabels,
      participantIds: meta.participantIds,
      tags: uniqueStrings(['transcript', ...slice.map((s) => s.language)]),
      transcriptSegmentIds: meta.validSegmentIds,
      itemSources: [],
    });
  }

  return drafts;
}
