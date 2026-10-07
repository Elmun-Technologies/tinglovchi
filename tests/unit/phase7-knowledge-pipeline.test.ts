import { describe, expect, it } from 'vitest';
import {
  askAiCitationDtoSchema,
  askWorkspaceQuestionRequestSchema,
  askWorkspaceQuestionResponseSchema,
  getMeetingKnowledgeStatusResponseSchema,
  knowledgeChunkDtoSchema,
  reindexKnowledgeRequestSchema,
  type CanonicalTranscriptSegmentDto,
  type GetMeetingIntelligenceResponse,
} from '@suhbat/contracts';
import {
  FakeEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProviderFromEnv,
  cosineSimilarity,
} from '@suhbat/database/embedding-provider';
import {
  KNOWLEDGE_SOURCE_VERSION,
  buildCanonicalKnowledgeChunks,
  computeKnowledgeContentHash,
} from '@suhbat/database/knowledge-pipeline';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '55555555-5555-4555-8555-555555555555';
const RECORDING_ID = '66666666-6666-4666-8666-666666666666';
const TRANSCRIPTION_RUN_ID = '77777777-7777-4777-8777-777777777777';
const TRANSCRIPTION_ASSET_ID = '88888888-8888-4888-8888-888888888888';
const ANALYSIS_RUN_ID = '99999999-9999-4999-8999-999999999999';
const SPEAKER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPEAKER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARTICIPANT_A_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTICIPANT_B_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const SEG_1_ID = '00000000-0000-4000-8000-000000000001';
const SEG_2_ID = '00000000-0000-4000-8000-000000000002';
const SEG_3_ID = '00000000-0000-4000-8000-000000000003';

function sampleSegments(): CanonicalTranscriptSegmentDto[] {
  return [
    {
      id: SEG_1_ID,
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      recordingId: RECORDING_ID,
      transcriptionRunId: TRANSCRIPTION_RUN_ID,
      transcriptionAssetId: TRANSCRIPTION_ASSET_ID,
      sequenceNo: 0,
      providerSegmentKey: 'seg_0',
      speakerId: SPEAKER_A_ID,
      participantId: PARTICIPANT_A_ID,
      providerSpeakerLabel: 'speaker_0',
      speakerDisplayLabel: 'Akmal',
      startMs: 1000,
      endMs: 8500,
      durationMs: 7500,
      assetStartMs: 1000,
      assetEndMs: 8500,
      sourceRecordingSourceId: null,
      sourceRecordingChunkId: null,
      sourceSampleStart: 48000,
      sourceSampleEnd: 408000,
      text: "Oktyabr oyi uchun marketing byudjetini 5000 dollar qilib tasdiqlaymiz, shundan 800 dollar Google PMax testiga yo'naltiriladi.",
      language: 'uz',
      confidence: 0.95,
      wordCount: 16,
      words: [],
      alignmentStatus: 'canonical',
      alignmentMetadata: {},
      createdAt: '2026-10-07T09:00:00.000Z',
    },
    {
      id: SEG_2_ID,
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      recordingId: RECORDING_ID,
      transcriptionRunId: TRANSCRIPTION_RUN_ID,
      transcriptionAssetId: TRANSCRIPTION_ASSET_ID,
      sequenceNo: 1,
      providerSegmentKey: 'seg_1',
      speakerId: SPEAKER_B_ID,
      participantId: PARTICIPANT_B_ID,
      providerSpeakerLabel: 'speaker_1',
      speakerDisplayLabel: 'Dilshod',
      startMs: 9000,
      endMs: 16500,
      durationMs: 7500,
      assetStartMs: 9000,
      assetEndMs: 16500,
      sourceRecordingSourceId: null,
      sourceRecordingChunkId: null,
      sourceSampleStart: 432000,
      sourceSampleEnd: 792000,
      text: 'Akmal 15-oktabrgacha 6 ta UGC skriptini qayta yozib beradi. Bojxona rasmiylashtiruvi 5 kun kechikishi mumkin.',
      language: 'uz',
      confidence: 0.94,
      wordCount: 16,
      words: [],
      alignmentStatus: 'canonical',
      alignmentMetadata: {},
      createdAt: '2026-10-07T09:00:08.000Z',
    },
    {
      id: SEG_3_ID,
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      recordingId: RECORDING_ID,
      transcriptionRunId: TRANSCRIPTION_RUN_ID,
      transcriptionAssetId: TRANSCRIPTION_ASSET_ID,
      sequenceNo: 2,
      providerSegmentKey: 'seg_2',
      speakerId: SPEAKER_A_ID,
      participantId: PARTICIPANT_A_ID,
      providerSpeakerLabel: 'speaker_0',
      speakerDisplayLabel: 'Akmal',
      startMs: 17000,
      endMs: 24000,
      durationMs: 7000,
      assetStartMs: 17000,
      assetEndMs: 24000,
      sourceRecordingSourceId: null,
      sourceRecordingChunkId: null,
      sourceSampleStart: 816000,
      sourceSampleEnd: 1152000,
      text: 'Sanjar payshanba kunigacha yangilangan tijorat taklifini yuborishni zimmasiga oldi. Q4 konversiya prognozi necha foiz bo‘ladi?',
      language: 'uz',
      confidence: 0.93,
      wordCount: 15,
      words: [],
      alignmentStatus: 'canonical',
      alignmentMetadata: {},
      createdAt: '2026-10-07T09:00:17.000Z',
    },
  ];
}

function sampleIntelligence(): GetMeetingIntelligenceResponse {
  const evSeg1 = {
    id: '10000000-0000-4000-8000-000000000001',
    workspaceId: WORKSPACE_ID,
    meetingId: MEETING_ID,
    analysisRunId: ANALYSIS_RUN_ID,
    transcriptionRunId: TRANSCRIPTION_RUN_ID,
    entityType: 'decision' as const,
    entityId: '20000000-0000-4000-8000-000000000001',
    transcriptSegmentId: SEG_1_ID,
    evidenceOrder: 0,
    speakerDisplayLabel: 'Akmal',
    excerpt: 'Oktyabr oyi uchun marketing byudjetini 5000 dollar qilib tasdiqlaymiz',
    startMs: 1000,
    endMs: 8500,
    confidence: 0.95,
    createdAt: '2026-10-07T09:05:00.000Z',
  };
  const evSeg2 = {
    id: '10000000-0000-4000-8000-000000000002',
    workspaceId: WORKSPACE_ID,
    meetingId: MEETING_ID,
    analysisRunId: ANALYSIS_RUN_ID,
    transcriptionRunId: TRANSCRIPTION_RUN_ID,
    entityType: 'action_item' as const,
    entityId: '20000000-0000-4000-8000-000000000002',
    transcriptSegmentId: SEG_2_ID,
    evidenceOrder: 0,
    speakerDisplayLabel: 'Dilshod',
    excerpt: 'Akmal 15-oktabrgacha 6 ta UGC skriptini qayta yozib beradi.',
    startMs: 9000,
    endMs: 16500,
    confidence: 0.94,
    createdAt: '2026-10-07T09:05:00.000Z',
  };
  const evSeg3 = {
    id: '10000000-0000-4000-8000-000000000003',
    workspaceId: WORKSPACE_ID,
    meetingId: MEETING_ID,
    analysisRunId: ANALYSIS_RUN_ID,
    transcriptionRunId: TRANSCRIPTION_RUN_ID,
    entityType: 'question' as const,
    entityId: '20000000-0000-4000-8000-000000000003',
    transcriptSegmentId: SEG_3_ID,
    evidenceOrder: 0,
    speakerDisplayLabel: 'Akmal',
    excerpt: 'Q4 konversiya prognozi necha foiz bo‘ladi?',
    startMs: 17000,
    endMs: 24000,
    confidence: 0.93,
    createdAt: '2026-10-07T09:05:00.000Z',
  };

  return {
    meetingId: MEETING_ID,
    workspaceId: WORKSPACE_ID,
    currentAnalysisRun: null,
    summary: {
      id: '30000000-0000-4000-8000-000000000001',
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      analysisRunId: ANALYSIS_RUN_ID,
      transcriptionRunId: TRANSCRIPTION_RUN_ID,
      headline: 'Marketing budget and Q4 creative deliverables were finalized.',
      tlDr: 'Foodera marketing budget held at $5,000 with $800 for Google PMax and UGC scripts assigned to Akmal.',
      whyMeetingHappened: 'Align on October marketing budget and creative pipeline.',
      majorDiscussions: ['Budget allocation', 'UGC script rewrites'],
      confirmedDecisions: ['Hold October marketing budget at $5,000 with $800 for Google PMax.'],
      nextActions: ['Rewrite 6 UGC scripts by October 15'],
      unresolvedPoints: ['Q4 conversion forecast percentage'],
      followUps: ['Send revised commercial proposal by Thursday'],
      claims: [],
      sourceSegmentIds: [SEG_1_ID, SEG_2_ID, SEG_3_ID],
      evidence: [
        {
          ...evSeg1,
          entityType: 'summary_claim',
          entityId: '30000000-0000-4000-8000-000000000001',
        },
      ],
      createdAt: '2026-10-07T09:05:00.000Z',
    },
    topics: [
      {
        id: '30000000-0000-4000-8000-000000000002',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        sequenceNo: 0,
        topicKey: 'topic_budget',
        title: 'October Marketing Budget & Google PMax',
        summary: 'Agreed to hold October budget at $5,000 and allocate $800 to Google PMax.',
        startMs: 1000,
        endMs: 8500,
        keywords: ['budget', 'pmax', 'marketing'],
        participantIds: [PARTICIPANT_A_ID],
        speakerLabels: ['Akmal'],
        sourceSegmentIds: [SEG_1_ID],
        evidence: [
          { ...evSeg1, entityType: 'topic', entityId: '30000000-0000-4000-8000-000000000002' },
        ],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    decisions: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        topicId: '30000000-0000-4000-8000-000000000002',
        sequenceNo: 0,
        decisionKey: 'decision_budget',
        statement:
          'Hold October marketing budget at $5,000 with $800 allocated to Google PMax test.',
        rationale: 'Reduce Meta dependency without shrinking audience.',
        status: 'confirmed',
        ownerParticipantId: PARTICIPANT_A_ID,
        ownerLabel: 'Akmal',
        confidence: 0.95,
        sourceSegmentIds: [SEG_1_ID],
        evidence: [evSeg1],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    actionItems: [
      {
        id: '20000000-0000-4000-8000-000000000002',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        topicId: '30000000-0000-4000-8000-000000000002',
        decisionId: '20000000-0000-4000-8000-000000000001',
        sequenceNo: 0,
        actionKey: 'action_ugc',
        title: 'Rewrite 6 UGC scripts based on September metrics',
        ownerParticipantId: PARTICIPANT_A_ID,
        ownerLabel: 'Akmal',
        dueDate: '2026-10-15',
        dueHint: '15-oktabrgacha',
        status: 'open',
        confidence: 0.94,
        sourceSegmentIds: [SEG_2_ID],
        evidence: [evSeg2],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    facts: [
      {
        id: '20000000-0000-4000-8000-000000000004',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        topicId: '30000000-0000-4000-8000-000000000002',
        sequenceNo: 0,
        factKey: 'fact_budget',
        category: 'budget',
        label: 'October Marketing Budget',
        valueText: '$5,000 ($800 Google PMax)',
        numericValue: 5000,
        unit: 'USD',
        speakerParticipantId: PARTICIPANT_A_ID,
        speakerLabel: 'Akmal',
        confidence: 0.96,
        sourceSegmentIds: [SEG_1_ID],
        evidence: [
          { ...evSeg1, entityType: 'fact', entityId: '20000000-0000-4000-8000-000000000004' },
        ],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    questions: [
      {
        id: '20000000-0000-4000-8000-000000000003',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        topicId: null,
        sequenceNo: 0,
        questionKey: 'question_q4_forecast',
        question: 'Q4 konversiya prognozi necha foiz bo‘ladi?',
        status: 'open',
        askedByParticipantId: PARTICIPANT_A_ID,
        askedByLabel: 'Akmal',
        ownerParticipantId: null,
        ownerLabel: null,
        answerSummary: null,
        confidence: 0.92,
        sourceSegmentIds: [SEG_3_ID],
        evidence: [evSeg3],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    ideas: [],
    objections: [],
    commitments: [
      {
        id: '20000000-0000-4000-8000-000000000005',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        topicId: null,
        sequenceNo: 0,
        commitmentKey: 'commitment_proposal',
        commitment: 'Send updated commercial proposal by Thursday',
        ownerParticipantId: PARTICIPANT_A_ID,
        ownerLabel: 'Sanjar',
        counterpartyLabel: 'Foodera',
        dueLabel: 'payshanba kunigacha',
        status: 'pending',
        confidence: 0.91,
        sourceSegmentIds: [SEG_3_ID],
        evidence: [
          {
            ...evSeg3,
            entityType: 'commitment',
            entityId: '20000000-0000-4000-8000-000000000005',
          },
        ],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    risks: [
      {
        id: '20000000-0000-4000-8000-000000000006',
        workspaceId: WORKSPACE_ID,
        meetingId: MEETING_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        transcriptionRunId: TRANSCRIPTION_RUN_ID,
        topicId: null,
        sequenceNo: 0,
        riskKey: 'risk_customs',
        title: 'Customs clearance delay',
        detail: 'Bojxona rasmiylashtiruvi 5 kun kechikishi mumkin',
        severity: 'high',
        status: 'open',
        mitigation: null,
        ownerParticipantId: PARTICIPANT_B_ID,
        ownerLabel: 'Dilshod',
        confidence: 0.9,
        sourceSegmentIds: [SEG_2_ID],
        evidence: [
          { ...evSeg2, entityType: 'risk', entityId: '20000000-0000-4000-8000-000000000006' },
        ],
        createdAt: '2026-10-07T09:05:00.000Z',
      },
    ],
    evidenceCount: 3,
    quarantinedItemCount: 0,
  };
}

describe('Phase 7 unit: embedding provider & multilingual similarity', () => {
  it('FakeEmbeddingProvider produces deterministic normalized 64-dim embeddings with cross-lingual semantic alignment', async () => {
    const provider = new FakeEmbeddingProvider();
    expect(provider.providerName).toBe('fake');
    expect(provider.dimensions).toBe(64);

    const res = await provider.embedTexts({
      workspaceId: WORKSPACE_ID,
      texts: [
        'Foodera bilan byudjet va narx haqida qanday qaror qabul qilindi?',
        'Decision: Hold October marketing budget at $5,000 with $800 for Google PMax.',
        'Bojxona rasmiylashtiruvi 5 kun kechikishi xavfi bor.',
      ],
    });

    expect(res.embeddings).toHaveLength(3);
    expect(res.dimensions).toBe(64);
    for (const vec of res.embeddings) {
      expect(vec).toHaveLength(64);
      const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    }

    // Uzbek question about budget + decision should be much closer to the budget decision than to the customs risk
    const simBudget = cosineSimilarity(res.embeddings[0]!, res.embeddings[1]!);
    const simUnrelated = cosineSimilarity(res.embeddings[0]!, res.embeddings[2]!);
    expect(simBudget).toBeGreaterThan(simUnrelated);
    expect(simBudget).toBeGreaterThan(0.35);
  });

  it('OpenAIEmbeddingProvider fails closed when API key is missing and createEmbeddingProviderFromEnv never silently falls back', async () => {
    expect(() => createEmbeddingProviderFromEnv({ SUHBAT_EMBEDDING_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/i,
    );
    expect(() =>
      createEmbeddingProviderFromEnv({ SUHBAT_EMBEDDING_PROVIDER: 'unknown_provider' }),
    ).toThrow(/Unsupported SUHBAT_EMBEDDING_PROVIDER/i);

    const provider = new OpenAIEmbeddingProvider({ apiKey: '' });
    await expect(
      provider.embedTexts({ workspaceId: WORKSPACE_ID, texts: ['hello'] }),
    ).rejects.toThrow(/OPENAI_API_KEY/i);
  });
});

describe('Phase 7 unit: canonical knowledge chunk builder', () => {
  it('builds versioned knowledge chunks from canonical transcript segments and finalized intelligence items', () => {
    const segments = sampleSegments();
    const intelligence = sampleIntelligence();

    const drafts = buildCanonicalKnowledgeChunks({
      meetingTitle: 'Foodera Q4 Growth Sync',
      segments,
      intelligence,
      maxSegmentsPerTranscriptChunk: 2,
    });

    expect(drafts.length).toBeGreaterThanOrEqual(8);

    // Every draft must have sequential sequenceNo, non-empty transcriptSegmentIds, and valid contentSha256
    drafts.forEach((draft, idx) => {
      expect(draft.sequenceNo).toBe(idx);
      expect(draft.sourceVersion).toBe(KNOWLEDGE_SOURCE_VERSION);
      expect(draft.transcriptSegmentIds.length).toBeGreaterThan(0);
      expect(draft.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(draft.endMs).toBeGreaterThanOrEqual(draft.startMs);
    });

    const decisionChunk = drafts.find((d) => d.chunkType === 'decision');
    expect(decisionChunk).toBeDefined();
    expect(decisionChunk!.startMs).toBe(1000);
    expect(decisionChunk!.endMs).toBe(8500);
    expect(decisionChunk!.speakerLabels).toEqual(['Akmal']);
    expect(decisionChunk!.participantIds).toEqual([PARTICIPANT_A_ID]);
    expect(decisionChunk!.transcriptSegmentIds).toEqual([SEG_1_ID]);
    expect(decisionChunk!.itemSources).toEqual([
      {
        entityType: 'decision',
        entityId: '20000000-0000-4000-8000-000000000001',
      },
    ]);

    // Content hash is deterministic
    const recomputedHash = computeKnowledgeContentHash({
      chunkType: decisionChunk!.chunkType,
      chunkKey: decisionChunk!.chunkKey,
      canonicalText: decisionChunk!.canonicalText,
    });
    expect(recomputedHash).toBe(decisionChunk!.contentSha256);
  });

  it('rejects intelligence items whose evidence references non-existent transcript segments', () => {
    const segments = sampleSegments();
    const intelligence = sampleIntelligence();
    const bogusSegmentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    intelligence.decisions.push({
      id: '20000000-0000-4000-8000-000000000099',
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      analysisRunId: ANALYSIS_RUN_ID,
      transcriptionRunId: TRANSCRIPTION_RUN_ID,
      topicId: null,
      sequenceNo: 1,
      decisionKey: 'decision_bogus',
      statement: 'Hallucinated decision with non-canonical segment reference',
      rationale: null,
      status: 'proposed',
      ownerParticipantId: null,
      ownerLabel: null,
      confidence: 0.5,
      sourceSegmentIds: [bogusSegmentId],
      evidence: [
        {
          id: '10000000-0000-4000-8000-000000000099',
          workspaceId: WORKSPACE_ID,
          meetingId: MEETING_ID,
          analysisRunId: ANALYSIS_RUN_ID,
          transcriptionRunId: TRANSCRIPTION_RUN_ID,
          entityType: 'decision',
          entityId: '20000000-0000-4000-8000-000000000099',
          transcriptSegmentId: bogusSegmentId,
          evidenceOrder: 0,
          speakerDisplayLabel: 'Unknown',
          excerpt: 'Bogus quote',
          startMs: 0,
          endMs: 1000,
          confidence: 0.5,
          createdAt: '2026-10-07T09:05:00.000Z',
        },
      ],
      createdAt: '2026-10-07T09:05:00.000Z',
    });

    const drafts = buildCanonicalKnowledgeChunks({
      meetingTitle: 'Foodera Q4 Growth Sync',
      segments,
      intelligence,
    });

    expect(drafts.some((d) => d.chunkKey === 'decision:decision_bogus')).toBe(false);
  });
});

describe('Phase 7 unit: Zod contracts validation', () => {
  it('validates knowledge status, reindex request, and Ask AI request/response schemas', () => {
    const req = askWorkspaceQuestionRequestSchema.parse({
      question: '  Foodera bilan budget haqida nima kelishganmiz?  ',
      companyId: '33333333-3333-4333-8333-333333333333',
      limit: 5,
    });
    expect(req.question).toBe('Foodera bilan budget haqida nima kelishganmiz?');

    const reindexReq = reindexKnowledgeRequestSchema.parse({ force: true });
    expect(reindexReq.force).toBe(true);

    const citation = askAiCitationDtoSchema.parse({
      kind: 'decision',
      id: '20000000-0000-4000-8000-000000000001',
      meetingId: MEETING_ID,
      meetingTitle: 'Foodera Q4 Growth Sync',
      occurredAt: '2026-10-07T09:00:00.000Z',
      startMs: 1000,
      endMs: 8500,
      speakerNames: ['Akmal'],
      quote: 'Decision: Hold October marketing budget at $5,000',
      segmentIds: [SEG_1_ID],
      target: 'decisions',
    });
    expect(citation.speakerNames).toEqual(['Akmal']);

    const askRes = askWorkspaceQuestionResponseSchema.parse({
      id: '40000000-0000-4000-8000-000000000001',
      workspaceId: WORKSPACE_ID,
      companyId: '33333333-3333-4333-8333-333333333333',
      projectId: null,
      meetingId: null,
      question: req.question,
      answer: ['Hold October marketing budget at $5,000.'],
      citations: [citation],
      adapter: 'rag_pipeline',
      provider: 'fake',
      model: 'fake-multilingual-embedding-v1',
      retrievedChunkIds: ['50000000-0000-4000-8000-000000000001'],
      generatedAt: '2026-10-07T09:10:00.000Z',
      matchedKnownQuestion: false,
      notes: ['Hybrid vector + relational retrieval'],
    });
    expect(askRes.adapter).toBe('rag_pipeline');

    const chunkDto = knowledgeChunkDtoSchema.parse({
      id: '50000000-0000-4000-8000-000000000001',
      workspaceId: WORKSPACE_ID,
      meetingId: MEETING_ID,
      companyId: null,
      projectId: null,
      transcriptionRunId: TRANSCRIPTION_RUN_ID,
      analysisRunId: ANALYSIS_RUN_ID,
      embeddingRunId: '60000000-0000-4000-8000-000000000001',
      sequenceNo: 0,
      chunkKey: 'decision:decision_budget',
      chunkType: 'decision',
      title: 'Decision: Hold October marketing budget at $5,000',
      canonicalText: 'Decision (confirmed): Hold October marketing budget at $5,000.',
      contentSha256: 'a'.repeat(64),
      sourceVersion: KNOWLEDGE_SOURCE_VERSION,
      startMs: 1000,
      endMs: 8500,
      speakerLabels: ['Akmal'],
      participantIds: [PARTICIPANT_A_ID],
      tags: ['decision', 'confirmed'],
      embeddingProvider: 'fake',
      embeddingModel: 'fake-multilingual-embedding-v1',
      embeddingDimensions: 64,
      transcriptSources: [
        {
          id: '70000000-0000-4000-8000-000000000001',
          knowledgeChunkId: '50000000-0000-4000-8000-000000000001',
          transcriptSegmentId: SEG_1_ID,
          sequenceNo: 0,
        },
      ],
      itemSources: [
        {
          id: '70000000-0000-4000-8000-000000000002',
          knowledgeChunkId: '50000000-0000-4000-8000-000000000001',
          entityType: 'decision',
          entityId: '20000000-0000-4000-8000-000000000001',
          sequenceNo: 0,
        },
      ],
      createdAt: '2026-10-07T09:06:00.000Z',
    });

    const statusRes = getMeetingKnowledgeStatusResponseSchema.parse({
      meetingId: MEETING_ID,
      workspaceId: WORKSPACE_ID,
      meetingStatus: 'ready',
      currentEmbeddingRunId: '60000000-0000-4000-8000-000000000001',
      latestEmbeddingRunId: '60000000-0000-4000-8000-000000000001',
      runs: [],
      chunks: [chunkDto],
      jobs: [],
    });
    expect(statusRes.chunks).toHaveLength(1);
  });
});
