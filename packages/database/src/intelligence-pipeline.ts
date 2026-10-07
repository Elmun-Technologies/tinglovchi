import {
  providerWindowExtractionSchema,
  type ActionItemStatus,
  type CanonicalTranscriptSegmentDto,
  type CommitmentStatus,
  type DecisionStatus,
  type FactCategory,
  type IdeaStatus,
  type IntelligenceEntityType,
  type MeetingParticipantDto,
  type MeetingSpeakerDto,
  type ObjectionStatus,
  type ProviderDecisionCandidate,
  type ProviderExecutiveSummaryClaim,
  type ProviderTopicCandidate,
  type ProviderWindowExtraction,
  type QuestionStatus,
  type RiskSeverity,
  type RiskStatus,
} from '@suhbat/contracts';
import type { TranscriptWindowSegmentInput } from './intelligence-provider';

export type TranscriptAnalysisWindow = {
  windowIndex: number;
  totalWindows: number;
  startMs: number;
  endMs: number;
  charCount: number;
  segments: TranscriptWindowSegmentInput[];
};

export type BuildTranscriptWindowsOptions = {
  maxSegmentsPerWindow?: number;
  maxCharsPerWindow?: number;
  overlapSegments?: number;
};

/**
 * Splits canonical transcript segments into bounded windows for LLM extraction.
 * Preserves exact canonical segment IDs and sequence numbers across windows.
 */
export function buildTranscriptWindows(
  segments: readonly CanonicalTranscriptSegmentDto[],
  options: BuildTranscriptWindowsOptions = {},
): TranscriptAnalysisWindow[] {
  const maxSegments = Math.max(1, options.maxSegmentsPerWindow ?? 16);
  const maxChars = Math.max(500, options.maxCharsPerWindow ?? 6000);
  const overlap = Math.max(0, Math.min(maxSegments - 1, options.overlapSegments ?? 2));

  const canonical = segments
    .filter((seg) => seg.alignmentStatus === 'canonical')
    .slice()
    .sort((a, b) => a.sequenceNo - b.sequenceNo);

  if (canonical.length === 0) {
    return [];
  }

  const rawWindows: TranscriptWindowSegmentInput[][] = [];
  let cursor = 0;

  while (cursor < canonical.length) {
    const windowSegs: TranscriptWindowSegmentInput[] = [];
    let charCount = 0;
    let idx = cursor;

    while (idx < canonical.length && windowSegs.length < maxSegments) {
      const seg = canonical[idx]!;
      const segChars = seg.text.length + seg.speakerDisplayLabel.length + 48;
      if (windowSegs.length > 0 && charCount + segChars > maxChars) {
        break;
      }
      windowSegs.push({
        id: seg.id,
        sequenceNo: seg.sequenceNo,
        providerSegmentKey: seg.providerSegmentKey,
        speakerId: seg.speakerId,
        providerSpeakerLabel: seg.providerSpeakerLabel,
        participantId: seg.participantId,
        speakerDisplayLabel: seg.speakerDisplayLabel,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
        language: seg.language,
        confidence: seg.confidence,
      });
      charCount += segChars;
      idx += 1;
    }

    rawWindows.push(windowSegs);
    if (idx >= canonical.length) {
      break;
    }

    const nextCursor = idx - overlap;
    cursor = nextCursor > cursor ? nextCursor : idx;
  }

  const totalWindows = rawWindows.length;
  return rawWindows.map((segs, windowIndex) => ({
    windowIndex,
    totalWindows,
    startMs: segs[0]!.startMs,
    endMs: segs[segs.length - 1]!.endMs,
    charCount: segs.reduce((acc, s) => acc + s.text.length, 0),
    segments: segs,
  }));
}

function normalizeDedupKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/gi, '_')
    .replace(/^_+|_+$/g, '');
}

function mergeUniqueStrings(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

const TENTATIVE_DECISION_PATTERN =
  /\b(balki|ehtimol|o'ylab\s+ko'ramiz|taklif\s+kiritildi|taklif|возможно|может\s+быть|наверное|maybe|perhaps|might|tentative|exploratory)\b/i;

const CONFIRMED_DECISION_PATTERN =
  /\b(kelishdik|tasdiqlandi|qabul\s+qildik|agreed|confirmed|approved|подтвердил|зафиксируем|решили|согласовали|отлично,\s*тогда)\b/i;

/**
 * Enforces decision status semantics against the cited transcript segment text.
 * Tentative language ("Balki $10,000 qilarmiz") must NEVER become `confirmed` unless an explicit
 * confirmation segment is also cited.
 */
export function enforceDecisionStatusSemantics(
  candidateStatus: DecisionStatus,
  citedSegmentTexts: readonly string[],
): DecisionStatus {
  if (candidateStatus !== 'confirmed') {
    return candidateStatus;
  }
  const combinedText = citedSegmentTexts.join(' ');
  const hasTentativeCue = TENTATIVE_DECISION_PATTERN.test(combinedText);
  const hasConfirmedCue = CONFIRMED_DECISION_PATTERN.test(combinedText);

  if (hasTentativeCue && !hasConfirmedCue) {
    if (/\btaklif\s+kiritildi\b/i.test(combinedText)) {
      return 'proposed';
    }
    return 'tentative';
  }
  return candidateStatus;
}

/**
 * Consolidates and deduplicates structured extractions across multiple transcript windows,
 * preserving all cited `sourceSegmentIds` in canonical sequence order.
 */
export function consolidateWindowExtractions(
  extractions: readonly ProviderWindowExtraction[],
  canonicalSegments: readonly CanonicalTranscriptSegmentDto[],
): ProviderWindowExtraction {
  if (extractions.length === 0) {
    throw new Error('Cannot consolidate zero window extractions.');
  }

  const segOrder = new Map<string, number>();
  for (const seg of canonicalSegments) {
    segOrder.set(seg.id, seg.sequenceNo);
  }

  const sortSegmentIds = (ids: readonly string[]): string[] => {
    return Array.from(new Set(ids)).sort(
      (a, b) =>
        (segOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (segOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  };

  if (extractions.length === 1) {
    const single = extractions[0]!;
    return providerWindowExtractionSchema.parse({
      ...single,
      windowIndex: 0,
      executiveSummary: {
        ...single.executiveSummary,
        claims: single.executiveSummary.claims.map((c) => ({
          ...c,
          sourceSegmentIds: sortSegmentIds(c.sourceSegmentIds),
        })),
        sourceSegmentIds: sortSegmentIds(single.executiveSummary.sourceSegmentIds),
      },
      topics: single.topics.map((t) => ({
        ...t,
        sourceSegmentIds: sortSegmentIds(t.sourceSegmentIds),
      })),
      decisions: single.decisions.map((d) => ({
        ...d,
        sourceSegmentIds: sortSegmentIds(d.sourceSegmentIds),
      })),
      actionItems: single.actionItems.map((a) => ({
        ...a,
        sourceSegmentIds: sortSegmentIds(a.sourceSegmentIds),
      })),
      facts: single.facts.map((f) => ({
        ...f,
        sourceSegmentIds: sortSegmentIds(f.sourceSegmentIds),
      })),
      questions: single.questions.map((q) => ({
        ...q,
        sourceSegmentIds: sortSegmentIds(q.sourceSegmentIds),
      })),
      ideas: single.ideas.map((i) => ({
        ...i,
        sourceSegmentIds: sortSegmentIds(i.sourceSegmentIds),
      })),
      objections: single.objections.map((o) => ({
        ...o,
        sourceSegmentIds: sortSegmentIds(o.sourceSegmentIds),
      })),
      commitments: single.commitments.map((c) => ({
        ...c,
        sourceSegmentIds: sortSegmentIds(c.sourceSegmentIds),
      })),
      risks: single.risks.map((r) => ({
        ...r,
        sourceSegmentIds: sortSegmentIds(r.sourceSegmentIds),
      })),
    });
  }

  // Merge topics by normalized topicKey or title
  const topicMap = new Map<string, ProviderTopicCandidate>();
  for (const ext of extractions) {
    for (const topic of ext.topics) {
      const key = normalizeDedupKey(topic.topicKey || topic.title);
      const existing = topicMap.get(key);
      if (!existing) {
        topicMap.set(key, {
          ...topic,
          sourceSegmentIds: sortSegmentIds(topic.sourceSegmentIds),
        });
      } else {
        topicMap.set(key, {
          ...existing,
          keywords: mergeUniqueStrings([existing.keywords, topic.keywords]),
          speakerLabels: mergeUniqueStrings([existing.speakerLabels, topic.speakerLabels]),
          sourceSegmentIds: sortSegmentIds([
            ...existing.sourceSegmentIds,
            ...topic.sourceSegmentIds,
          ]),
        });
      }
    }
  }

  // Merge decisions by decisionKey or statement
  const decisionRank: Record<DecisionStatus, number> = {
    proposed: 1,
    tentative: 2,
    rejected: 3,
    superseded: 4,
    confirmed: 5,
  };
  const decisionMap = new Map<string, ProviderDecisionCandidate>();
  for (const ext of extractions) {
    for (const dec of ext.decisions) {
      const key = normalizeDedupKey(dec.decisionKey || dec.statement);
      const existing = decisionMap.get(key);
      if (!existing) {
        decisionMap.set(key, {
          ...dec,
          sourceSegmentIds: sortSegmentIds(dec.sourceSegmentIds),
        });
      } else {
        const mergedStatus =
          decisionRank[dec.status] >= decisionRank[existing.status] ? dec.status : existing.status;
        decisionMap.set(key, {
          ...existing,
          statement:
            dec.status === 'confirmed' && existing.status !== 'confirmed'
              ? dec.statement
              : existing.statement,
          rationale: dec.rationale ?? existing.rationale,
          status: mergedStatus,
          ownerLabel: dec.ownerLabel ?? existing.ownerLabel,
          topicKey: dec.topicKey ?? existing.topicKey,
          confidence:
            dec.confidence !== null && existing.confidence !== null
              ? Math.max(dec.confidence, existing.confidence)
              : (dec.confidence ?? existing.confidence),
          sourceSegmentIds: sortSegmentIds([...existing.sourceSegmentIds, ...dec.sourceSegmentIds]),
        });
      }
    }
  }

  const mergeByKey = <T extends { sourceSegmentIds: string[] }>(
    items: readonly T[],
    getKey: (item: T) => string,
  ): T[] => {
    const map = new Map<string, T>();
    for (const item of items) {
      const key = normalizeDedupKey(getKey(item));
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          ...item,
          sourceSegmentIds: sortSegmentIds(item.sourceSegmentIds),
        });
      } else {
        map.set(key, {
          ...existing,
          ...item,
          sourceSegmentIds: sortSegmentIds([
            ...existing.sourceSegmentIds,
            ...item.sourceSegmentIds,
          ]),
        });
      }
    }
    return Array.from(map.values());
  };

  const claims = mergeByKey(
    extractions.flatMap((e) => e.executiveSummary.claims),
    (c) => `${c.section}:${c.claimKey || c.text}`,
  );
  const actionItems = mergeByKey(
    extractions.flatMap((e) => e.actionItems),
    (a) => a.actionKey || a.title,
  );
  const facts = mergeByKey(
    extractions.flatMap((e) => e.facts),
    (f) => f.factKey || `${f.category}:${f.label}:${f.valueText}`,
  );
  const questions = mergeByKey(
    extractions.flatMap((e) => e.questions),
    (q) => q.questionKey || q.question,
  );
  const ideas = mergeByKey(
    extractions.flatMap((e) => e.ideas),
    (i) => i.ideaKey || i.idea,
  );
  const objections = mergeByKey(
    extractions.flatMap((e) => e.objections),
    (o) => o.objectionKey || o.summary,
  );
  const commitments = mergeByKey(
    extractions.flatMap((e) => e.commitments),
    (c) => c.commitmentKey || c.commitment,
  );
  const risks = mergeByKey(
    extractions.flatMap((e) => e.risks),
    (r) => r.riskKey || r.title,
  );

  const firstSummary = extractions[0]!.executiveSummary;
  const followUps = mergeUniqueStrings([
    ...extractions.map((e) => e.executiveSummary.followUps),
    ...extractions.map((e) => e.followUps),
  ]);
  const summarySourceSegmentIds = sortSegmentIds([
    ...extractions.flatMap((e) => e.executiveSummary.sourceSegmentIds),
    ...claims.flatMap((c) => c.sourceSegmentIds),
  ]);

  return providerWindowExtractionSchema.parse({
    windowIndex: 0,
    executiveSummary: {
      headline: firstSummary.headline,
      tlDr: extractions.map((e) => e.executiveSummary.tlDr).join(' '),
      whyMeetingHappened: firstSummary.whyMeetingHappened,
      majorDiscussions: mergeUniqueStrings(
        extractions.map((e) => e.executiveSummary.majorDiscussions),
      ),
      confirmedDecisions: mergeUniqueStrings(
        extractions.map((e) => e.executiveSummary.confirmedDecisions),
      ),
      nextActions: mergeUniqueStrings(extractions.map((e) => e.executiveSummary.nextActions)),
      unresolvedPoints: mergeUniqueStrings(
        extractions.map((e) => e.executiveSummary.unresolvedPoints),
      ),
      followUps,
      claims,
      sourceSegmentIds: summarySourceSegmentIds,
    },
    topics: Array.from(topicMap.values()),
    decisions: Array.from(decisionMap.values()),
    actionItems,
    facts,
    questions,
    ideas,
    objections,
    commitments,
    risks,
    followUps,
  });
}

export type QuarantinedIntelligenceItem = {
  entityType: IntelligenceEntityType;
  candidateKey: string;
  invalidSegmentIds: string[];
  reason: string;
};

export type NormalizedEvidenceDraft = {
  transcriptSegmentId: string;
  evidenceOrder: number;
  startMs: number;
  endMs: number;
  speakerDisplayLabel: string;
  excerpt: string;
  confidence: number | null;
};

export type NormalizedSummaryRecord = {
  headline: string;
  tlDr: string;
  whyMeetingHappened: string;
  majorDiscussions: string[];
  confirmedDecisions: string[];
  nextActions: string[];
  unresolvedPoints: string[];
  followUps: string[];
  claims: ProviderExecutiveSummaryClaim[];
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedTopicRecord = {
  sequenceNo: number;
  topicKey: string;
  title: string;
  summary: string;
  keywords: string[];
  participantIds: string[];
  speakerLabels: string[];
  startMs: number;
  endMs: number;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedDecisionRecord = {
  sequenceNo: number;
  decisionKey: string;
  topicKey: string | null;
  statement: string;
  rationale: string | null;
  status: DecisionStatus;
  ownerParticipantId: string | null;
  ownerLabel: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedActionItemRecord = {
  sequenceNo: number;
  actionKey: string;
  topicKey: string | null;
  decisionKey: string | null;
  title: string;
  ownerParticipantId: string | null;
  ownerLabel: string | null;
  dueHint: string | null;
  dueDate: string | null;
  status: ActionItemStatus;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedFactRecord = {
  sequenceNo: number;
  factKey: string;
  topicKey: string | null;
  category: FactCategory;
  label: string;
  valueText: string;
  unit: string | null;
  numericValue: number | null;
  speakerParticipantId: string | null;
  speakerLabel: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedQuestionRecord = {
  sequenceNo: number;
  questionKey: string;
  topicKey: string | null;
  question: string;
  status: QuestionStatus;
  askedByParticipantId: string | null;
  askedByLabel: string | null;
  ownerParticipantId: string | null;
  ownerLabel: string | null;
  answerSummary: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedIdeaRecord = {
  sequenceNo: number;
  ideaKey: string;
  topicKey: string | null;
  idea: string;
  notes: string | null;
  status: IdeaStatus;
  proposedByParticipantId: string | null;
  proposedByLabel: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedObjectionRecord = {
  sequenceNo: number;
  objectionKey: string;
  topicKey: string | null;
  summary: string;
  status: ObjectionStatus;
  raisedByParticipantId: string | null;
  raisedByLabel: string | null;
  responseSummary: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedCommitmentRecord = {
  sequenceNo: number;
  commitmentKey: string;
  topicKey: string | null;
  commitment: string;
  ownerParticipantId: string | null;
  ownerLabel: string | null;
  counterpartyLabel: string | null;
  dueLabel: string | null;
  status: CommitmentStatus;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type NormalizedRiskRecord = {
  sequenceNo: number;
  riskKey: string;
  topicKey: string | null;
  title: string;
  detail: string | null;
  severity: RiskSeverity;
  status: RiskStatus;
  mitigation: string | null;
  ownerParticipantId: string | null;
  ownerLabel: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  evidence: NormalizedEvidenceDraft[];
};

export type ValidatedIntelligenceBundle = {
  summary: NormalizedSummaryRecord | null;
  topics: NormalizedTopicRecord[];
  decisions: NormalizedDecisionRecord[];
  actionItems: NormalizedActionItemRecord[];
  facts: NormalizedFactRecord[];
  questions: NormalizedQuestionRecord[];
  ideas: NormalizedIdeaRecord[];
  objections: NormalizedObjectionRecord[];
  commitments: NormalizedCommitmentRecord[];
  risks: NormalizedRiskRecord[];
  quarantinedItems: QuarantinedIntelligenceItem[];
  totalEvidenceCount: number;
};

/**
 * Validates all candidate intelligence items and their `sourceSegmentIds` against the meeting's
 * canonical `transcript_segments` for `(workspaceId, meetingId, transcriptionRunId)`.
 *
 * - Rejects/quarantines any item whose evidence references fail validation (missing segment,
 *   wrong workspace, wrong meeting, wrong transcription run, or quarantined alignment status).
 * - Derives all timestamps (`startMs`, `endMs`) and excerpts strictly from canonical `transcript_segments`.
 * - Resolves participant IDs deterministically without fabricating unsupported owners or deadlines.
 */
export function validateAndNormalizeIntelligence(params: {
  workspaceId: string;
  meetingId: string;
  transcriptionRunId: string;
  extraction: ProviderWindowExtraction;
  segments: readonly CanonicalTranscriptSegmentDto[];
  speakers: readonly MeetingSpeakerDto[];
  participants: readonly MeetingParticipantDto[];
}): ValidatedIntelligenceBundle {
  const canonicalSegmentMap = new Map<string, CanonicalTranscriptSegmentDto>();
  for (const seg of params.segments) {
    if (
      seg.workspaceId === params.workspaceId &&
      seg.meetingId === params.meetingId &&
      seg.transcriptionRunId === params.transcriptionRunId &&
      seg.alignmentStatus === 'canonical'
    ) {
      canonicalSegmentMap.set(seg.id, seg);
    }
  }

  const quarantinedItems: QuarantinedIntelligenceItem[] = [];

  const validateSegmentRefs = (
    entityType: IntelligenceEntityType,
    candidateKey: string,
    rawSegmentIds: readonly string[],
    confidence: number | null,
  ): {
    validSegments: CanonicalTranscriptSegmentDto[];
    sourceSegmentIds: string[];
    evidence: NormalizedEvidenceDraft[];
  } | null => {
    const uniqueIds = Array.from(new Set(rawSegmentIds));
    if (uniqueIds.length === 0) {
      quarantinedItems.push({
        entityType,
        candidateKey,
        invalidSegmentIds: [],
        reason: 'Candidate has empty sourceSegmentIds.',
      });
      return null;
    }

    const invalidIds = uniqueIds.filter((id) => !canonicalSegmentMap.has(id));
    if (invalidIds.length > 0) {
      quarantinedItems.push({
        entityType,
        candidateKey,
        invalidSegmentIds: invalidIds,
        reason:
          'One or more sourceSegmentIds do not exist in the active canonical transcript_segments for this meeting and workspace.',
      });
      return null;
    }

    const validSegments = uniqueIds
      .map((id) => canonicalSegmentMap.get(id)!)
      .sort((a, b) => a.sequenceNo - b.sequenceNo);

    const evidence: NormalizedEvidenceDraft[] = validSegments.map((seg, idx) => ({
      transcriptSegmentId: seg.id,
      evidenceOrder: idx,
      startMs: seg.startMs,
      endMs: seg.endMs,
      speakerDisplayLabel: seg.speakerDisplayLabel,
      excerpt: seg.text,
      confidence: confidence ?? seg.confidence,
    }));

    return {
      validSegments,
      sourceSegmentIds: validSegments.map((s) => s.id),
      evidence,
    };
  };

  const resolveActor = (
    rawLabel: string | null | undefined,
    citedSegments: readonly CanonicalTranscriptSegmentDto[],
  ): { participantId: string | null; label: string | null } => {
    const trimmed = rawLabel?.trim() ?? '';
    if (!trimmed) {
      return { participantId: null, label: null };
    }
    const lower = trimmed.toLowerCase();

    // 1. Direct match against meeting_participants
    const participantMatch = params.participants.find(
      (p) =>
        p.displayName.trim().toLowerCase() === lower ||
        (p.roleLabel && p.roleLabel.trim().toLowerCase() === lower),
    );
    if (participantMatch) {
      return {
        participantId: participantMatch.id,
        label: participantMatch.displayName,
      };
    }

    // 2. Match against meeting_speakers
    const speakerMatch = params.speakers.find(
      (s) =>
        s.displayLabel.trim().toLowerCase() === lower ||
        s.providerSpeakerLabel.trim().toLowerCase() === lower,
    );
    if (speakerMatch) {
      const mappedParticipant = speakerMatch.participantId
        ? params.participants.find((p) => p.id === speakerMatch.participantId)
        : null;
      return {
        participantId: speakerMatch.participantId,
        label: mappedParticipant ? mappedParticipant.displayName : speakerMatch.displayLabel,
      };
    }

    // 3. Match against speaker of cited canonical segments
    const citedSpeaker = citedSegments.find(
      (s) =>
        s.speakerDisplayLabel.trim().toLowerCase() === lower ||
        s.providerSpeakerLabel.trim().toLowerCase() === lower,
    );
    if (citedSpeaker) {
      return {
        participantId: citedSpeaker.participantId,
        label: citedSpeaker.speakerDisplayLabel,
      };
    }

    // 4. Only preserve unmapped label if it literally appears in the cited transcript text;
    // otherwise reject fabricated actor names and return null.
    const appearsInText = citedSegments.some((s) => s.text.toLowerCase().includes(lower));
    if (appearsInText) {
      return { participantId: null, label: trimmed };
    }

    return { participantId: null, label: null };
  };

  // Validate topics
  const topics: NormalizedTopicRecord[] = [];
  for (const cand of params.extraction.topics) {
    const validated = validateSegmentRefs('topic', cand.topicKey, cand.sourceSegmentIds, null);
    if (!validated) continue;

    const participantIds = Array.from(
      new Set(
        validated.validSegments
          .map((s) => s.participantId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const speakerLabels = Array.from(
      new Set([
        ...validated.validSegments.map((s) => s.speakerDisplayLabel),
        ...cand.speakerLabels,
      ]),
    );
    const startMs = Math.min(...validated.validSegments.map((s) => s.startMs));
    const endMs = Math.max(...validated.validSegments.map((s) => s.endMs));

    topics.push({
      sequenceNo: topics.length,
      topicKey: cand.topicKey,
      title: cand.title,
      summary: cand.summary,
      keywords: cand.keywords,
      participantIds,
      speakerLabels,
      startMs,
      endMs,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate decisions
  const decisions: NormalizedDecisionRecord[] = [];
  for (const cand of params.extraction.decisions) {
    const validated = validateSegmentRefs(
      'decision',
      cand.decisionKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const effectiveStatus = enforceDecisionStatusSemantics(
      cand.status,
      validated.validSegments.map((s) => s.text),
    );
    const owner = resolveActor(cand.ownerLabel, validated.validSegments);

    decisions.push({
      sequenceNo: decisions.length,
      decisionKey: cand.decisionKey,
      topicKey: cand.topicKey,
      statement: cand.statement,
      rationale: cand.rationale,
      status: effectiveStatus,
      ownerParticipantId: owner.participantId,
      ownerLabel: owner.label,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate action items
  const actionItems: NormalizedActionItemRecord[] = [];
  for (const cand of params.extraction.actionItems) {
    const validated = validateSegmentRefs(
      'action_item',
      cand.actionKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const owner = resolveActor(cand.ownerLabel, validated.validSegments);
    // Do not infer an exact ISO dueDate unless explicitly stated in the cited segment text
    const citedText = validated.validSegments.map((s) => s.text).join(' ');
    const dueDate = cand.dueDate && citedText.includes(cand.dueDate) ? cand.dueDate : null;

    actionItems.push({
      sequenceNo: actionItems.length,
      actionKey: cand.actionKey,
      topicKey: cand.topicKey,
      decisionKey: cand.decisionKey,
      title: cand.title,
      ownerParticipantId: owner.participantId,
      ownerLabel: owner.label,
      dueHint: cand.dueHint,
      dueDate,
      status: cand.status,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate facts
  const facts: NormalizedFactRecord[] = [];
  for (const cand of params.extraction.facts) {
    const validated = validateSegmentRefs(
      'fact',
      cand.factKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const speaker = resolveActor(cand.speakerLabel, validated.validSegments);
    facts.push({
      sequenceNo: facts.length,
      factKey: cand.factKey,
      topicKey: cand.topicKey,
      category: cand.category,
      label: cand.label,
      valueText: cand.valueText,
      unit: cand.unit,
      numericValue: cand.numericValue,
      speakerParticipantId: speaker.participantId,
      speakerLabel: speaker.label,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate questions
  const questions: NormalizedQuestionRecord[] = [];
  for (const cand of params.extraction.questions) {
    const validated = validateSegmentRefs(
      'question',
      cand.questionKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const askedBy = resolveActor(cand.askedByLabel, validated.validSegments);
    const owner = resolveActor(cand.ownerLabel, validated.validSegments);
    questions.push({
      sequenceNo: questions.length,
      questionKey: cand.questionKey,
      topicKey: cand.topicKey,
      question: cand.question,
      status: cand.status,
      askedByParticipantId: askedBy.participantId,
      askedByLabel: askedBy.label,
      ownerParticipantId: owner.participantId,
      ownerLabel: owner.label,
      answerSummary: cand.answerSummary,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate ideas
  const ideas: NormalizedIdeaRecord[] = [];
  for (const cand of params.extraction.ideas) {
    const validated = validateSegmentRefs(
      'idea',
      cand.ideaKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const proposedBy = resolveActor(cand.proposedByLabel, validated.validSegments);
    ideas.push({
      sequenceNo: ideas.length,
      ideaKey: cand.ideaKey,
      topicKey: cand.topicKey,
      idea: cand.idea,
      notes: cand.notes,
      status: cand.status,
      proposedByParticipantId: proposedBy.participantId,
      proposedByLabel: proposedBy.label,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate objections
  const objections: NormalizedObjectionRecord[] = [];
  for (const cand of params.extraction.objections) {
    const validated = validateSegmentRefs(
      'objection',
      cand.objectionKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const raisedBy = resolveActor(cand.raisedByLabel, validated.validSegments);
    objections.push({
      sequenceNo: objections.length,
      objectionKey: cand.objectionKey,
      topicKey: cand.topicKey,
      summary: cand.summary,
      status: cand.status,
      raisedByParticipantId: raisedBy.participantId,
      raisedByLabel: raisedBy.label,
      responseSummary: cand.responseSummary,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate commitments
  const commitments: NormalizedCommitmentRecord[] = [];
  for (const cand of params.extraction.commitments) {
    const validated = validateSegmentRefs(
      'commitment',
      cand.commitmentKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const owner = resolveActor(cand.ownerLabel, validated.validSegments);
    commitments.push({
      sequenceNo: commitments.length,
      commitmentKey: cand.commitmentKey,
      topicKey: cand.topicKey,
      commitment: cand.commitment,
      ownerParticipantId: owner.participantId,
      ownerLabel: owner.label,
      counterpartyLabel: cand.counterpartyLabel,
      dueLabel: cand.dueLabel,
      status: cand.status,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate risks
  const risks: NormalizedRiskRecord[] = [];
  for (const cand of params.extraction.risks) {
    const validated = validateSegmentRefs(
      'risk',
      cand.riskKey,
      cand.sourceSegmentIds,
      cand.confidence,
    );
    if (!validated) continue;

    const owner = resolveActor(cand.ownerLabel, validated.validSegments);
    risks.push({
      sequenceNo: risks.length,
      riskKey: cand.riskKey,
      topicKey: cand.topicKey,
      title: cand.title,
      detail: cand.detail,
      severity: cand.severity,
      status: cand.status,
      mitigation: cand.mitigation,
      ownerParticipantId: owner.participantId,
      ownerLabel: owner.label,
      confidence: cand.confidence,
      sourceSegmentIds: validated.sourceSegmentIds,
      evidence: validated.evidence,
    });
  }

  // Validate executive summary claims
  const validClaims: ProviderExecutiveSummaryClaim[] = [];
  for (const claim of params.extraction.executiveSummary.claims) {
    const validatedClaim = validateSegmentRefs(
      'summary_claim',
      claim.claimKey,
      claim.sourceSegmentIds,
      null,
    );
    if (!validatedClaim) continue;
    validClaims.push({
      ...claim,
      sourceSegmentIds: validatedClaim.sourceSegmentIds,
    });
  }

  let summary: NormalizedSummaryRecord | null = null;
  if (validClaims.length > 0) {
    const claimSegmentIds = Array.from(new Set(validClaims.flatMap((c) => c.sourceSegmentIds)));
    const validatedSummary = validateSegmentRefs(
      'summary_claim',
      'executive_summary',
      claimSegmentIds,
      null,
    );
    if (validatedSummary) {
      summary = {
        headline: params.extraction.executiveSummary.headline,
        tlDr: params.extraction.executiveSummary.tlDr,
        whyMeetingHappened: params.extraction.executiveSummary.whyMeetingHappened,
        majorDiscussions: params.extraction.executiveSummary.majorDiscussions,
        confirmedDecisions: decisions
          .filter((d) => d.status === 'confirmed')
          .map((d) => d.statement),
        nextActions: actionItems.map((a) => a.title),
        unresolvedPoints: params.extraction.executiveSummary.unresolvedPoints,
        followUps: params.extraction.executiveSummary.followUps,
        claims: validClaims,
        sourceSegmentIds: validatedSummary.sourceSegmentIds,
        evidence: validatedSummary.evidence,
      };
    }
  }

  const totalEvidenceCount =
    (summary?.evidence.length ?? 0) +
    topics.reduce((acc, i) => acc + i.evidence.length, 0) +
    decisions.reduce((acc, i) => acc + i.evidence.length, 0) +
    actionItems.reduce((acc, i) => acc + i.evidence.length, 0) +
    facts.reduce((acc, i) => acc + i.evidence.length, 0) +
    questions.reduce((acc, i) => acc + i.evidence.length, 0) +
    ideas.reduce((acc, i) => acc + i.evidence.length, 0) +
    objections.reduce((acc, i) => acc + i.evidence.length, 0) +
    commitments.reduce((acc, i) => acc + i.evidence.length, 0) +
    risks.reduce((acc, i) => acc + i.evidence.length, 0);

  return {
    summary,
    topics,
    decisions,
    actionItems,
    facts,
    questions,
    ideas,
    objections,
    commitments,
    risks,
    quarantinedItems,
    totalEvidenceCount,
  };
}
