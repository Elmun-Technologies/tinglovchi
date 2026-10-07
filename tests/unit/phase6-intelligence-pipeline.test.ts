import { describe, expect, it } from 'vitest';
import {
  MEETING_INTELLIGENCE_PIPELINE_VERSION,
  MEETING_INTELLIGENCE_PROMPT_VERSION,
  MEETING_INTELLIGENCE_SCHEMA_VERSION,
  providerWindowExtractionSchema,
  type CanonicalTranscriptSegmentDto,
  type MeetingParticipantDto,
  type MeetingSpeakerDto,
} from '@suhbat/contracts';
import {
  FakeMeetingIntelligenceProvider,
  MEETING_INTELLIGENCE_JSON_SCHEMA,
  MEETING_INTELLIGENCE_SYSTEM_PROMPT,
  MeetingIntelligenceProviderError,
  OpenAIMeetingIntelligenceProvider,
  buildMeetingWindowAnalysisUserPrompt,
  createMeetingIntelligenceProviderFromEnv,
} from '@suhbat/database/intelligence-provider';
import {
  buildTranscriptWindows,
  consolidateWindowExtractions,
  enforceDecisionStatusSemantics,
  validateAndNormalizeIntelligence,
} from '@suhbat/database/intelligence-pipeline';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const MEETING_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEETING_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECORDING_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TR_RUN_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TR_RUN_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ASSET_A = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ANALYSIS_RUN_A = '99999999-9999-4999-8999-999999999999';

function makeUuid(seq: number): string {
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function buildCanonicalFixtures(): {
  segments: CanonicalTranscriptSegmentDto[];
  speakers: MeetingSpeakerDto[];
  participants: MeetingParticipantDto[];
} {
  const partAzizaId = makeUuid(101);
  const partTimurId = makeUuid(102);
  const spk0Id = makeUuid(201);
  const spk1Id = makeUuid(202);
  const spk2Id = makeUuid(203);

  const participants: MeetingParticipantDto[] = [
    {
      id: partAzizaId,
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      userId: null,
      displayName: 'Aziza Karimova',
      roleLabel: 'Product Lead',
      email: 'aziza@example.com',
      isExternal: false,
      sortOrder: 0,
      createdAt: '2026-10-07T08:00:00.000Z',
      updatedAt: '2026-10-07T08:00:00.000Z',
    },
    {
      id: partTimurId,
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      userId: null,
      displayName: 'Timur Alimov',
      roleLabel: 'Finance Director',
      email: 'timur@example.com',
      isExternal: false,
      sortOrder: 1,
      createdAt: '2026-10-07T08:00:00.000Z',
      updatedAt: '2026-10-07T08:00:00.000Z',
    },
  ];

  const speakers: MeetingSpeakerDto[] = [
    {
      id: spk0Id,
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      transcriptionRunId: TR_RUN_A,
      providerSpeakerLabel: 'speaker_0',
      displayLabel: 'Aziza Karimova',
      participantId: partAzizaId,
      mappedBy: null,
      mappedAt: '2026-10-07T08:05:00.000Z',
      segmentCount: 5,
      speakingDurationMs: 25000,
      confidenceAvg: 0.96,
      createdAt: '2026-10-07T08:00:00.000Z',
      updatedAt: '2026-10-07T08:05:00.000Z',
    },
    {
      id: spk1Id,
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      transcriptionRunId: TR_RUN_A,
      providerSpeakerLabel: 'speaker_1',
      displayLabel: 'Timur Alimov',
      participantId: partTimurId,
      mappedBy: null,
      mappedAt: '2026-10-07T08:05:00.000Z',
      segmentCount: 5,
      speakingDurationMs: 25000,
      confidenceAvg: 0.94,
      createdAt: '2026-10-07T08:00:00.000Z',
      updatedAt: '2026-10-07T08:05:00.000Z',
    },
    {
      id: spk2Id,
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      transcriptionRunId: TR_RUN_A,
      providerSpeakerLabel: 'speaker_2',
      displayLabel: 'Speaker 3',
      participantId: null,
      mappedBy: null,
      mappedAt: null,
      segmentCount: 5,
      speakingDurationMs: 25000,
      confidenceAvg: 0.93,
      createdAt: '2026-10-07T08:00:00.000Z',
      updatedAt: '2026-10-07T08:00:00.000Z',
    },
  ];

  const utterances: Array<{
    speakerIdx: 0 | 1 | 2;
    lang: 'uz' | 'ru' | 'en' | 'mixed';
    text: string;
  }> = [
    {
      speakerIdx: 0,
      lang: 'uz',
      text: 'Assalomu alaykum barchaga, bugungi mahsulot va eksport uchrashuvimizni boshlaymiz.',
    },
    {
      speakerIdx: 1,
      lang: 'mixed',
      text: "Bizning Q4 revenue forecast bo'yicha по договору 18 фоиз o'sish kutilmoqda, conversion 57% ga yetdi, lekin logistika SLA bo'yicha savollar bor.",
    },
    {
      speakerIdx: 2,
      lang: 'ru',
      text: 'Давайте отдельно зафиксируем график поставок по Ташкенту и Самарканду до пятницы.',
    },
    {
      speakerIdx: 0,
      lang: 'en',
      text: 'Agreed, the engineering team of 6 people (team size 6) will finalize the API integration and share the staging report by Thursday.',
    },
    {
      speakerIdx: 1,
      lang: 'uz',
      text: "Bojxona hujjatlari va sertifikatlar chorshanba kuni soat o'n oltigacha tayyor bo'lishi shart.",
    },
    {
      speakerIdx: 2,
      lang: 'mixed',
      text: 'По клиентскому onboarding jarayonida enterprise mijozlar uchun dedicated support channel ochamiz, baseline budget $5,000.',
    },
    {
      speakerIdx: 2,
      lang: 'uz',
      text: 'Balki $10,000 qilarmiz marketing kampaniyasi uchun?',
    },
    {
      speakerIdx: 1,
      lang: 'uz',
      text: 'Unda $10,000 budgetda kelishdik Q4 eksport va enterprise onboarding uchun.',
    },
    {
      speakerIdx: 1,
      lang: 'en',
      text: 'We also verified the webhook retry policy so transient network drops never duplicate orders.',
    },
    {
      speakerIdx: 2,
      lang: 'uz',
      text: "Samarqand omboridagi захира hajmini yana ikki barobar ko'paytirish bo'yicha taklif kiritildi.",
    },
    {
      speakerIdx: 0,
      lang: 'mixed',
      text: 'Keyingi sprintda mobile va desktop release-larni синхронно chiqaramiz, QA sign-off juma kuni.',
    },
    {
      speakerIdx: 1,
      lang: 'ru',
      text: 'Отлично, тогда протокол встречи и список ответственных отправим сразу после звонка.',
    },
    {
      speakerIdx: 2,
      lang: 'uz',
      text: "Hammaga rahmat, keyingi haftada natijalarni ko'rib chiqamiz.",
    },
  ];

  const segments: CanonicalTranscriptSegmentDto[] = utterances.map((u, idx) => {
    const spk = speakers[u.speakerIdx]!;
    const startMs = idx * 5000;
    const endMs = startMs + 4500;
    return {
      id: makeUuid(idx + 1),
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      recordingId: RECORDING_A,
      transcriptionRunId: TR_RUN_A,
      transcriptionAssetId: ASSET_A,
      sequenceNo: idx,
      providerSegmentKey: `seg_${String(idx).padStart(4, '0')}`,
      speakerId: spk.id,
      providerSpeakerLabel: spk.providerSpeakerLabel,
      participantId: spk.participantId,
      speakerDisplayLabel: spk.displayLabel,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      assetStartMs: startMs,
      assetEndMs: endMs,
      sourceRecordingSourceId: null,
      sourceRecordingChunkId: null,
      sourceSampleStart: startMs * 48,
      sourceSampleEnd: endMs * 48,
      text: u.text,
      language: u.lang,
      confidence: 0.95,
      wordCount: u.text.split(/\s+/).length,
      words: [],
      alignmentStatus: 'canonical',
      alignmentMetadata: {},
      createdAt: '2026-10-07T08:01:00.000Z',
    };
  });

  return { segments, speakers, participants };
}

describe('Phase 6 — MeetingIntelligenceProvider & Semantic Discipline Unit Tests', () => {
  it('centralizes prompt, schema, and pipeline versions and produces rich structured intelligence from FakeMeetingIntelligenceProvider', async () => {
    const { segments, speakers, participants } = buildCanonicalFixtures();
    const provider = new FakeMeetingIntelligenceProvider();

    expect(provider.promptVersion).toBe(MEETING_INTELLIGENCE_PROMPT_VERSION);
    expect(provider.schemaVersion).toBe(MEETING_INTELLIGENCE_SCHEMA_VERSION);
    expect(provider.pipelineVersion).toBe(MEETING_INTELLIGENCE_PIPELINE_VERSION);
    expect(MEETING_INTELLIGENCE_SYSTEM_PROMPT).toContain(MEETING_INTELLIGENCE_PROMPT_VERSION);
    expect(MEETING_INTELLIGENCE_JSON_SCHEMA.type).toBe('object');

    const windows = buildTranscriptWindows(segments, { maxSegmentsPerWindow: 20 });
    expect(windows).toHaveLength(1);

    const userPrompt = buildMeetingWindowAnalysisUserPrompt({
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      meetingTitle: 'Q4 Product & Export Review',
      recordingId: RECORDING_A,
      transcriptionRunId: TR_RUN_A,
      analysisRunId: ANALYSIS_RUN_A,
      windowIndex: 0,
      totalWindows: 1,
      segments: windows[0]!.segments,
      speakers,
      participants,
    });
    expect(userPrompt).toContain(segments[0]!.id);
    expect(userPrompt).toContain('Balki $10,000 qilarmiz');
    expect(userPrompt).toContain('Unda $10,000 budgetda kelishdik');

    const out = await provider.analyzeWindow({
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      meetingTitle: 'Q4 Product & Export Review',
      recordingId: RECORDING_A,
      transcriptionRunId: TR_RUN_A,
      analysisRunId: ANALYSIS_RUN_A,
      windowIndex: 0,
      totalWindows: 1,
      segments: windows[0]!.segments,
      speakers,
      participants,
    });

    const ext = out.extraction;
    expect(ext.topics.length).toBeGreaterThanOrEqual(3);
    expect(ext.decisions.filter((d) => d.status === 'confirmed').length).toBeGreaterThanOrEqual(2);
    expect(
      ext.decisions.filter((d) => d.status === 'proposed' || d.status === 'tentative').length,
    ).toBeGreaterThanOrEqual(2);
    expect(ext.actionItems.length).toBeGreaterThanOrEqual(4);
    expect(ext.actionItems.some((a) => a.ownerLabel === null)).toBe(true);
    expect(ext.actionItems.every((a) => a.dueDate === null)).toBe(true);

    // Check tentative vs confirmed budget differentiation
    const tentativeBudget = ext.decisions.find((d) =>
      d.statement.includes('Balki $10,000 qilarmiz'),
    );
    expect(tentativeBudget).toBeDefined();
    expect(tentativeBudget?.status).toBe('tentative');

    const confirmedBudget = ext.decisions.find((d) =>
      d.statement.includes('Confirmed $10,000 budget allocation'),
    );
    expect(confirmedBudget).toBeDefined();
    expect(confirmedBudget?.status).toBe('confirmed');

    // Check structured facts (conversion = 57%, budget = $5,000, team size = 6)
    expect(
      ext.facts.some((f) => f.label === 'conversion' && f.valueText === '57%' && f.unit === '%'),
    ).toBe(true);
    expect(
      ext.facts.some((f) => f.label === 'budget' && f.valueText === '$5,000' && f.unit === 'USD'),
    ).toBe(true);
    expect(
      ext.facts.some((f) => f.label === 'team size' && f.valueText === '6' && f.unit === 'people'),
    ).toBe(true);

    // Check questions, ideas, objections, commitments, risks
    expect(ext.questions.length).toBeGreaterThanOrEqual(1);
    expect(ext.ideas.length).toBeGreaterThanOrEqual(1);
    expect(ext.objections.length).toBeGreaterThanOrEqual(1);
    expect(ext.commitments.length).toBeGreaterThanOrEqual(1);
    expect(ext.risks.length).toBeGreaterThanOrEqual(1);
  });

  it('enforces decision status semantics so tentative phrasing ("Balki $10,000 qilarmiz") is never promoted to confirmed', () => {
    expect(
      enforceDecisionStatusSemantics('confirmed', [
        'Balki $10,000 qilarmiz marketing kampaniyasi uchun?',
      ]),
    ).toBe('tentative');

    expect(
      enforceDecisionStatusSemantics('confirmed', [
        "Samarqand omboridagi захира hajmini yana ikki barobar ko'paytirish bo'yicha taklif kiritildi.",
      ]),
    ).toBe('proposed');

    expect(
      enforceDecisionStatusSemantics('confirmed', [
        'Unda $10,000 budgetda kelishdik Q4 eksport va enterprise onboarding uchun.',
      ]),
    ).toBe('confirmed');
  });

  it('validates evidence references against canonical transcript_segments and quarantines invalid/cross-meeting/cross-run references', async () => {
    const { segments, speakers, participants } = buildCanonicalFixtures();
    const provider = new FakeMeetingIntelligenceProvider();
    const windows = buildTranscriptWindows(segments);
    const out = await provider.analyzeWindow({
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      meetingTitle: 'Q4 Product & Export Review',
      recordingId: RECORDING_A,
      transcriptionRunId: TR_RUN_A,
      analysisRunId: ANALYSIS_RUN_A,
      windowIndex: 0,
      totalWindows: 1,
      segments: windows[0]!.segments,
      speakers,
      participants,
    });

    // Add segments from another meeting, another workspace, another transcription run, and a quarantined segment
    const wrongMeetingSeg: CanonicalTranscriptSegmentDto = {
      ...segments[0]!,
      id: makeUuid(901),
      meetingId: MEETING_B,
    };
    const wrongWorkspaceSeg: CanonicalTranscriptSegmentDto = {
      ...segments[0]!,
      id: makeUuid(902),
      workspaceId: WORKSPACE_B,
    };
    const wrongRunSeg: CanonicalTranscriptSegmentDto = {
      ...segments[0]!,
      id: makeUuid(903),
      transcriptionRunId: TR_RUN_OLD,
    };
    const quarantinedSeg: CanonicalTranscriptSegmentDto = {
      ...segments[0]!,
      id: makeUuid(904),
      alignmentStatus: 'quarantined',
    };
    const nonExistentSegId = makeUuid(999);

    const mutatedExtraction = providerWindowExtractionSchema.parse({
      ...out.extraction,
      decisions: [
        ...out.extraction.decisions,
        {
          decisionKey: 'decision_hallucinated_segment',
          statement: 'Hallucinated decision pointing to non-existent segment',
          rationale: null,
          status: 'confirmed',
          ownerLabel: null,
          topicKey: null,
          confidence: 0.9,
          sourceSegmentIds: [nonExistentSegId],
        },
        {
          decisionKey: 'decision_wrong_meeting_segment',
          statement: 'Decision pointing to another meeting segment',
          rationale: null,
          status: 'confirmed',
          ownerLabel: null,
          topicKey: null,
          confidence: 0.9,
          sourceSegmentIds: [wrongMeetingSeg.id],
        },
      ],
      actionItems: [
        ...out.extraction.actionItems,
        {
          actionKey: 'action_wrong_run_segment',
          title: 'Task pointing to stale transcription run segment',
          ownerLabel: 'Fabricated Person Not In Meeting',
          dueHint: 'Next month',
          dueDate: '2026-11-15',
          status: 'open',
          topicKey: null,
          decisionKey: null,
          confidence: 0.85,
          sourceSegmentIds: [wrongRunSeg.id],
        },
        {
          actionKey: 'action_with_fabricated_owner_and_date_on_valid_segment',
          title: 'Task with ungrounded owner and ISO dueDate',
          ownerLabel: 'NonExistentGhostOwner',
          dueHint: 'Soon',
          dueDate: '2026-12-31',
          status: 'open',
          topicKey: null,
          decisionKey: null,
          confidence: 0.85,
          sourceSegmentIds: [segments[4]!.id],
        },
      ],
      facts: [
        ...out.extraction.facts,
        {
          factKey: 'fact_quarantined_segment',
          category: 'budget',
          label: 'Quarantined budget',
          valueText: '$99,000',
          unit: 'USD',
          numericValue: 99000,
          speakerLabel: null,
          topicKey: null,
          confidence: 0.5,
          sourceSegmentIds: [quarantinedSeg.id],
        },
      ],
    });

    const bundle = validateAndNormalizeIntelligence({
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      transcriptionRunId: TR_RUN_A,
      extraction: mutatedExtraction,
      segments: [...segments, wrongMeetingSeg, wrongWorkspaceSeg, wrongRunSeg, quarantinedSeg],
      speakers,
      participants,
    });

    // Invalid items must be quarantined and excluded from normalized records
    expect(bundle.quarantinedItems).toHaveLength(4);
    expect(bundle.quarantinedItems.map((q) => q.candidateKey)).toEqual(
      expect.arrayContaining([
        'decision_hallucinated_segment',
        'decision_wrong_meeting_segment',
        'action_wrong_run_segment',
        'fact_quarantined_segment',
      ]),
    );
    expect(bundle.decisions.some((d) => d.decisionKey === 'decision_hallucinated_segment')).toBe(
      false,
    );
    expect(bundle.decisions.some((d) => d.decisionKey === 'decision_wrong_meeting_segment')).toBe(
      false,
    );
    expect(bundle.facts.some((f) => f.factKey === 'fact_quarantined_segment')).toBe(false);

    // Valid action item with fabricated owner/dueDate must have ownerLabel=null, ownerParticipantId=null, dueDate=null
    const sanitizedAction = bundle.actionItems.find(
      (a) => a.actionKey === 'action_with_fabricated_owner_and_date_on_valid_segment',
    );
    expect(sanitizedAction).toBeDefined();
    expect(sanitizedAction?.ownerParticipantId).toBeNull();
    expect(sanitizedAction?.ownerLabel).toBeNull();
    expect(sanitizedAction?.dueDate).toBeNull();

    // All persisted evidence timestamps must match canonical transcript_segments
    const segById = new Map(segments.map((s) => [s.id, s]));
    for (const dec of bundle.decisions) {
      for (const ev of dec.evidence) {
        const canonical = segById.get(ev.transcriptSegmentId)!;
        expect(ev.startMs).toBe(canonical.startMs);
        expect(ev.endMs).toBe(canonical.endMs);
        expect(ev.excerpt).toBe(canonical.text);
      }
    }
  });

  it('chunks long transcripts into bounded windows and consolidates/deduplicates candidates while preserving sourceSegmentIds', async () => {
    const { segments: baseSegments, speakers, participants } = buildCanonicalFixtures();
    // Create a 42-segment long synthetic meeting transcript
    const longSegments: CanonicalTranscriptSegmentDto[] = [];
    for (let i = 0; i < 42; i++) {
      const template = baseSegments[i % baseSegments.length]!;
      const startMs = i * 15000;
      const endMs = startMs + 12000;
      longSegments.push({
        ...template,
        id: makeUuid(1000 + i),
        sequenceNo: i,
        providerSegmentKey: `long_seg_${String(i).padStart(4, '0')}`,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        assetStartMs: startMs,
        assetEndMs: endMs,
      });
    }

    const windows = buildTranscriptWindows(longSegments, {
      maxSegmentsPerWindow: 12,
      overlapSegments: 2,
    });
    expect(windows.length).toBeGreaterThanOrEqual(4);
    for (const win of windows) {
      expect(win.segments.length).toBeLessThanOrEqual(12);
    }

    const provider = new FakeMeetingIntelligenceProvider();
    const windowExtractions = [];
    for (const win of windows) {
      const res = await provider.analyzeWindow({
        workspaceId: WORKSPACE_A,
        meetingId: MEETING_A,
        meetingTitle: 'Long Synthetic Strategy Meeting',
        recordingId: RECORDING_A,
        transcriptionRunId: TR_RUN_A,
        analysisRunId: ANALYSIS_RUN_A,
        windowIndex: win.windowIndex,
        totalWindows: win.totalWindows,
        segments: win.segments,
        speakers,
        participants,
      });
      windowExtractions.push(res.extraction);
    }

    const consolidated = consolidateWindowExtractions(windowExtractions, longSegments);
    // Topics with the same topicKey across windows are deduplicated and union their sourceSegmentIds
    expect(consolidated.topics).toHaveLength(3);
    for (const topic of consolidated.topics) {
      expect(topic.sourceSegmentIds.length).toBeGreaterThan(windows[0]!.segments.length / 3);
    }

    const validated = validateAndNormalizeIntelligence({
      workspaceId: WORKSPACE_A,
      meetingId: MEETING_A,
      transcriptionRunId: TR_RUN_A,
      extraction: consolidated,
      segments: longSegments,
      speakers,
      participants,
    });
    expect(validated.quarantinedItems).toHaveLength(0);
    expect(validated.totalEvidenceCount).toBeGreaterThan(20);
  });

  it('keeps OpenAIMeetingIntelligenceProvider disabled unless explicitly configured and never falls back to FakeMeetingIntelligenceProvider', async () => {
    const { segments, speakers, participants } = buildCanonicalFixtures();
    const unconfigured = new OpenAIMeetingIntelligenceProvider({});
    expect(unconfigured.isConfigured()).toBe(false);

    await expect(
      unconfigured.analyzeWindow({
        workspaceId: WORKSPACE_A,
        meetingId: MEETING_A,
        meetingTitle: 'Test',
        recordingId: RECORDING_A,
        transcriptionRunId: TR_RUN_A,
        analysisRunId: ANALYSIS_RUN_A,
        windowIndex: 0,
        totalWindows: 1,
        segments,
        speakers,
        participants,
      }),
    ).rejects.toMatchObject({
      name: 'MeetingIntelligenceProviderError',
      code: 'provider_not_configured',
      retryable: false,
    });

    const fromEnvOpenAI = createMeetingIntelligenceProviderFromEnv({
      SUHBAT_INTELLIGENCE_PROVIDER: 'openai',
    });
    expect(fromEnvOpenAI.providerName).toBe('openai');
    expect(fromEnvOpenAI.isConfigured()).toBe(false);

    expect(() =>
      createMeetingIntelligenceProviderFromEnv({
        SUHBAT_INTELLIGENCE_PROVIDER: 'unknown_provider',
      }),
    ).toThrowError(MeetingIntelligenceProviderError);
  });
});
