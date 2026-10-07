import {
  MEETING_INTELLIGENCE_PIPELINE_VERSION,
  MEETING_INTELLIGENCE_PROMPT_VERSION,
  MEETING_INTELLIGENCE_SCHEMA_VERSION,
  providerWindowExtractionSchema,
  type CanonicalTranscriptSegmentDto,
  type MeetingParticipantDto,
  type MeetingSpeakerDto,
  type ProviderActionItemCandidate,
  type ProviderCommitmentCandidate,
  type ProviderDecisionCandidate,
  type ProviderExecutiveSummaryClaim,
  type ProviderFactCandidate,
  type ProviderIdeaCandidate,
  type ProviderObjectionCandidate,
  type ProviderQuestionCandidate,
  type ProviderRiskCandidate,
  type ProviderTokenUsage,
  type ProviderTopicCandidate,
  type ProviderWindowExtraction,
} from '@suhbat/contracts';

export class MeetingIntelligenceProviderError extends Error {
  readonly code:
    | 'provider_not_configured'
    | 'provider_unavailable'
    | 'provider_invalid_response'
    | 'provider_analysis_failed';
  readonly retryable: boolean;

  constructor(code: MeetingIntelligenceProviderError['code'], message: string, retryable = false) {
    super(message);
    this.name = 'MeetingIntelligenceProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type TranscriptWindowSegmentInput = Pick<
  CanonicalTranscriptSegmentDto,
  | 'id'
  | 'sequenceNo'
  | 'providerSegmentKey'
  | 'speakerId'
  | 'providerSpeakerLabel'
  | 'participantId'
  | 'speakerDisplayLabel'
  | 'startMs'
  | 'endMs'
  | 'text'
  | 'language'
  | 'confidence'
>;

export type AnalyzeTranscriptWindowInput = {
  workspaceId: string;
  meetingId: string;
  meetingTitle: string;
  recordingId: string;
  transcriptionRunId: string;
  analysisRunId: string;
  windowIndex: number;
  totalWindows: number;
  segments: readonly TranscriptWindowSegmentInput[];
  speakers: readonly Pick<
    MeetingSpeakerDto,
    'id' | 'providerSpeakerLabel' | 'displayLabel' | 'participantId'
  >[];
  participants: readonly Pick<
    MeetingParticipantDto,
    'id' | 'displayName' | 'roleLabel' | 'isExternal'
  >[];
};

export type AnalyzeTranscriptWindowOutput = {
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  pipelineVersion: string;
  tokenUsage: ProviderTokenUsage;
  extraction: ProviderWindowExtraction;
  providerMetadata: Record<string, unknown>;
};

export interface MeetingIntelligenceProvider {
  readonly providerName: string;
  readonly defaultModel: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly pipelineVersion: string;
  isConfigured(): boolean;
  analyzeWindow(input: AnalyzeTranscriptWindowInput): Promise<AnalyzeTranscriptWindowOutput>;
}

/**
 * Centralized system prompt for Phase 6 structured meeting intelligence extraction.
 * Do not scatter prompts across API routes or UI components.
 */
export const MEETING_INTELLIGENCE_SYSTEM_PROMPT = `You are Suhbat's canonical Meeting Intelligence extraction engine (Prompt Version: ${MEETING_INTELLIGENCE_PROMPT_VERSION}, Schema Version: ${MEETING_INTELLIGENCE_SCHEMA_VERSION}).
Analyze the provided canonical transcript window (which may contain Uzbek, Russian, English, or mixed code-switching) and return ONLY strict JSON conforming to the schema.

Mandatory Semantic & Evidence Rules:
1. Every extracted summary claim, topic, decision, action item, fact, question, idea, objection, commitment, and risk MUST cite one or more exact segment UUIDs from the provided window in \`sourceSegmentIds\`.
2. NEVER invent or output timestamps; the server derives all timestamps strictly from canonical \`transcript_segments\`.
3. Decision discipline:
   - Differentiate \`proposed\`, \`tentative\`, \`confirmed\`, \`rejected\`, and \`superseded\`.
   - Tentative or exploratory language (e.g., "Balki $10,000 qilarmiz", "taklif kiritildi", "возможно", "maybe") MUST be \`proposed\` or \`tentative\`, NEVER \`confirmed\`.
   - Only explicit agreement (e.g., "Unda $10,000 budgetda kelishdik", "Agreed", "подтвердил", "зафиксируем") may be marked \`confirmed\`.
4. Action item discipline:
   - Do NOT invent \`ownerLabel\`, \`dueHint\`, or \`dueDate\`.
   - Leave \`ownerLabel\`, \`dueHint\`, and \`dueDate\` as \`null\` unless directly supported by transcript evidence.
   - Never infer an exact ISO \`dueDate\` from vague language.
5. Fact discipline:
   - Extract concrete facts with \`category\`, \`label\`, \`valueText\`, optional \`unit\`, optional \`numericValue\`, and \`speakerLabel\` if known.
   - Do NOT invent budgets, conversion rates, or metrics not stated in the cited segments.`;

export function buildMeetingWindowAnalysisUserPrompt(input: AnalyzeTranscriptWindowInput): string {
  const speakerLines = input.speakers.map(
    (s) => `- ${s.providerSpeakerLabel} => ${s.displayLabel}`,
  );
  const segmentLines = input.segments.map(
    (seg) =>
      `[segment_id=${seg.id}] [seq=${seg.sequenceNo}] [speaker=${seg.speakerDisplayLabel} (${seg.providerSpeakerLabel})] [lang=${seg.language}] ${seg.text}`,
  );
  return [
    `Meeting ID: ${input.meetingId}`,
    `Meeting Title: ${input.meetingTitle}`,
    `Transcription Run ID: ${input.transcriptionRunId}`,
    `Window: ${input.windowIndex + 1} of ${input.totalWindows}`,
    `Speakers:\n${speakerLines.join('\n') || '(none)'}`,
    `Canonical Transcript Segments:\n${segmentLines.join('\n')}`,
  ].join('\n\n');
}

/**
 * Centralized JSON Schema definition for OpenAI Structured Outputs (`response_format.json_schema`).
 */
export const MEETING_INTELLIGENCE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'windowIndex',
    'executiveSummary',
    'topics',
    'decisions',
    'actionItems',
    'facts',
    'questions',
    'ideas',
    'objections',
    'commitments',
    'risks',
    'followUps',
  ],
  properties: {
    windowIndex: { type: 'integer' },
    executiveSummary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'headline',
        'tlDr',
        'whyMeetingHappened',
        'majorDiscussions',
        'confirmedDecisions',
        'nextActions',
        'unresolvedPoints',
        'followUps',
        'claims',
        'sourceSegmentIds',
      ],
      properties: {
        headline: { type: 'string' },
        tlDr: { type: 'string' },
        whyMeetingHappened: { type: 'string' },
        majorDiscussions: { type: 'array', items: { type: 'string' } },
        confirmedDecisions: { type: 'array', items: { type: 'string' } },
        nextActions: { type: 'array', items: { type: 'string' } },
        unresolvedPoints: { type: 'array', items: { type: 'string' } },
        followUps: { type: 'array', items: { type: 'string' } },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claimKey', 'section', 'text', 'sourceSegmentIds'],
            properties: {
              claimKey: { type: 'string' },
              section: {
                type: 'string',
                enum: ['purpose', 'discussion', 'decision', 'action', 'unresolved'],
              },
              text: { type: 'string' },
              sourceSegmentIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        sourceSegmentIds: { type: 'array', items: { type: 'string' } },
      },
    },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topicKey', 'title', 'summary', 'keywords', 'speakerLabels', 'sourceSegmentIds'],
        properties: {
          topicKey: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          speakerLabels: { type: 'array', items: { type: 'string' } },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'decisionKey',
          'statement',
          'rationale',
          'status',
          'ownerLabel',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          decisionKey: { type: 'string' },
          statement: { type: 'string' },
          rationale: { type: ['string', 'null'] },
          status: {
            type: 'string',
            enum: ['proposed', 'tentative', 'confirmed', 'rejected', 'superseded'],
          },
          ownerLabel: { type: ['string', 'null'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'actionKey',
          'title',
          'ownerLabel',
          'dueHint',
          'dueDate',
          'status',
          'topicKey',
          'decisionKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          actionKey: { type: 'string' },
          title: { type: 'string' },
          ownerLabel: { type: ['string', 'null'] },
          dueHint: { type: ['string', 'null'] },
          dueDate: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
          topicKey: { type: ['string', 'null'] },
          decisionKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'factKey',
          'category',
          'label',
          'valueText',
          'unit',
          'numericValue',
          'speakerLabel',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          factKey: { type: 'string' },
          category: {
            type: 'string',
            enum: [
              'budget',
              'metric',
              'timeline',
              'team',
              'commercial',
              'technical',
              'legal',
              'operations',
              'general',
            ],
          },
          label: { type: 'string' },
          valueText: { type: 'string' },
          unit: { type: ['string', 'null'] },
          numericValue: { type: ['number', 'null'] },
          speakerLabel: { type: ['string', 'null'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'questionKey',
          'question',
          'status',
          'askedByLabel',
          'ownerLabel',
          'answerSummary',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          questionKey: { type: 'string' },
          question: { type: 'string' },
          status: { type: 'string', enum: ['open', 'answered', 'deferred'] },
          askedByLabel: { type: ['string', 'null'] },
          ownerLabel: { type: ['string', 'null'] },
          answerSummary: { type: ['string', 'null'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'ideaKey',
          'idea',
          'notes',
          'status',
          'proposedByLabel',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          ideaKey: { type: 'string' },
          idea: { type: 'string' },
          notes: { type: ['string', 'null'] },
          status: {
            type: 'string',
            enum: ['captured', 'exploring', 'accepted', 'parked', 'rejected'],
          },
          proposedByLabel: { type: ['string', 'null'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'objectionKey',
          'summary',
          'status',
          'raisedByLabel',
          'responseSummary',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          objectionKey: { type: 'string' },
          summary: { type: 'string' },
          status: { type: 'string', enum: ['open', 'addressed', 'mitigated', 'unresolved'] },
          raisedByLabel: { type: ['string', 'null'] },
          responseSummary: { type: ['string', 'null'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'commitmentKey',
          'commitment',
          'ownerLabel',
          'counterpartyLabel',
          'dueLabel',
          'status',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          commitmentKey: { type: 'string' },
          commitment: { type: 'string' },
          ownerLabel: { type: ['string', 'null'] },
          counterpartyLabel: { type: ['string', 'null'] },
          dueLabel: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['pending', 'kept', 'at_risk', 'broken'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'riskKey',
          'title',
          'detail',
          'severity',
          'status',
          'mitigation',
          'ownerLabel',
          'topicKey',
          'confidence',
          'sourceSegmentIds',
        ],
        properties: {
          riskKey: { type: 'string' },
          title: { type: 'string' },
          detail: { type: ['string', 'null'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          status: { type: 'string', enum: ['open', 'mitigating', 'resolved', 'accepted'] },
          mitigation: { type: ['string', 'null'] },
          ownerLabel: { type: ['string', 'null'] },
          topicKey: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          sourceSegmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    followUps: { type: 'array', items: { type: 'string' } },
  },
};

function pickSegmentAt(
  segments: readonly TranscriptWindowSegmentInput[],
  preferredIndex: number,
): TranscriptWindowSegmentInput {
  return segments[Math.min(segments.length - 1, Math.max(0, preferredIndex))]!;
}

function findSegmentMatching(
  segments: readonly TranscriptWindowSegmentInput[],
  pattern: RegExp,
  fallbackIndex: number,
): TranscriptWindowSegmentInput {
  return segments.find((seg) => pattern.test(seg.text)) ?? pickSegmentAt(segments, fallbackIndex);
}

/**
 * Deterministic `FakeMeetingIntelligenceProvider` for tests and local/dev verification.
 *
 * Guarantees against real Phase 5 transcript fixtures (and custom segments):
 * - At least 3 topics
 * - At least 2 confirmed decisions and 2 proposed/tentative decisions
 *   (Strictly differentiating tentative phrasing like "Balki $10,000 qilarmiz" vs confirmed "Unda $10,000 budgetda kelishdik")
 * - At least 4 action items, including items with `null` owner and/or `null` deadline
 * - Structured facts with value and unit (e.g., 18%, 57%, $5,000, team size = 6)
 * - Open questions, ideas, objections, commitments, and risks
 * - Every material claim in the executive summary and every extracted item cites real `transcript_segments` IDs from the input window
 * - Supports custom extraction overrides and failure injection for testing
 */
export class FakeMeetingIntelligenceProvider implements MeetingIntelligenceProvider {
  readonly providerName = 'fake';
  readonly defaultModel = 'fake-structured-intelligence-v1';
  readonly promptVersion = MEETING_INTELLIGENCE_PROMPT_VERSION;
  readonly schemaVersion = MEETING_INTELLIGENCE_SCHEMA_VERSION;
  readonly pipelineVersion = MEETING_INTELLIGENCE_PIPELINE_VERSION;

  private readonly customExtractions = new Map<string, ProviderWindowExtraction>();
  private readonly injectedFailures = new Map<
    string,
    { code: MeetingIntelligenceProviderError['code']; message: string; retryable: boolean }
  >();
  private readonly callLog: AnalyzeTranscriptWindowInput[] = [];

  isConfigured(): boolean {
    return true;
  }

  getCallLog(): readonly AnalyzeTranscriptWindowInput[] {
    return this.callLog;
  }

  clearCallLog(): void {
    this.callLog.length = 0;
  }

  setCustomExtractionForMeeting(
    meetingId: string,
    extraction: ProviderWindowExtraction,
    windowIndex?: number,
  ): void {
    const key = windowIndex !== undefined ? `${meetingId}:w:${windowIndex}` : meetingId;
    this.customExtractions.set(key, providerWindowExtractionSchema.parse(extraction));
  }

  clearCustomExtractionForMeeting(meetingId: string, windowIndex?: number): void {
    if (windowIndex !== undefined) {
      this.customExtractions.delete(`${meetingId}:w:${windowIndex}`);
    } else {
      this.customExtractions.delete(meetingId);
    }
  }

  injectFailureForMeeting(
    meetingId: string,
    failure: {
      code?: MeetingIntelligenceProviderError['code'];
      message: string;
      retryable?: boolean;
    },
  ): void {
    this.injectedFailures.set(meetingId, {
      code: failure.code ?? 'provider_unavailable',
      message: failure.message,
      retryable: failure.retryable ?? true,
    });
  }

  clearFailureForMeeting(meetingId: string): void {
    this.injectedFailures.delete(meetingId);
  }

  async analyzeWindow(input: AnalyzeTranscriptWindowInput): Promise<AnalyzeTranscriptWindowOutput> {
    this.callLog.push(input);

    const failure = this.injectedFailures.get(input.meetingId);
    if (failure) {
      throw new MeetingIntelligenceProviderError(failure.code, failure.message, failure.retryable);
    }

    const customWindow =
      this.customExtractions.get(`${input.meetingId}:w:${input.windowIndex}`) ??
      this.customExtractions.get(input.meetingId);
    if (customWindow) {
      return {
        provider: this.providerName,
        model: this.defaultModel,
        promptVersion: this.promptVersion,
        schemaVersion: this.schemaVersion,
        pipelineVersion: this.pipelineVersion,
        tokenUsage: {
          promptTokens: 480,
          completionTokens: 360,
          totalTokens: 840,
        },
        extraction: customWindow,
        providerMetadata: {
          deterministic_fixture: true,
          custom_override: true,
          window_index: input.windowIndex,
        },
      };
    }

    if (input.segments.length === 0) {
      throw new MeetingIntelligenceProviderError(
        'provider_invalid_response',
        'Cannot analyze an empty transcript window.',
        false,
      );
    }

    const segs = input.segments;
    const sOpening = findSegmentMatching(segs, /boshlaymiz|Assalomu alaykum/i, 0);
    const sForecast = findSegmentMatching(segs, /revenue forecast|18|SLA/i, 1);
    const sSchedule = findSegmentMatching(segs, /график поставок|Ташкенту|Самарканду/i, 2);
    const sApi = findSegmentMatching(segs, /API integration|staging report|Agreed/i, 3);
    const sCustoms = findSegmentMatching(segs, /Bojxona|sertifikatlar|chorshanba/i, 4);
    const sOnboarding = findSegmentMatching(segs, /onboarding|dedicated support/i, 5);
    const sBudget = findSegmentMatching(segs, /Финансовый|лимит бюджета|бюджет/i, 6);
    const sWebhook = findSegmentMatching(segs, /webhook retry|network drops/i, 7);
    const sWarehouse = findSegmentMatching(segs, /Samarqand omboridagi|taklif kiritildi/i, 8);
    const sRelease = findSegmentMatching(segs, /mobile va desktop|QA sign-off/i, 9);
    const sProtocol = findSegmentMatching(segs, /протокол встречи|после звонка/i, 10);
    const sClosing = findSegmentMatching(segs, /keyingi haftada|rahmat/i, 11);

    // Check for explicit tentative vs confirmed budget segments if present in custom transcripts
    const sTentativeBudget = segs.find((seg) => /balki\s+\$?10,?000\s+qilarmiz/i.test(seg.text));
    const sConfirmedBudget = segs.find((seg) =>
      /unda\s+\$?10,?000\s+budgetda\s+kelishdik/i.test(seg.text),
    );
    const sConversionFact = segs.find((seg) => /57%|conversion/i.test(seg.text));
    const sFiveKBudgetFact = segs.find((seg) => /\$5,?000/i.test(seg.text));
    const sTeamSizeFact = segs.find((seg) => /team size|6 kishi|6 человек/i.test(seg.text));

    const topics: ProviderTopicCandidate[] = [
      {
        topicKey: 'topic_export_logistics_sla',
        title: 'Q4 Export Forecast, Customs & Regional Logistics SLA',
        summary:
          'Reviewed the 18% Q4 revenue growth forecast, Tashkent/Samarkand delivery schedules, customs certificate requirements, and Samarkand warehouse stock proposals.',
        keywords: ['Q4 forecast', 'logistics SLA', 'customs', 'Tashkent', 'Samarkand'],
        speakerLabels: Array.from(
          new Set([
            sOpening.speakerDisplayLabel,
            sForecast.speakerDisplayLabel,
            sSchedule.speakerDisplayLabel,
            sCustoms.speakerDisplayLabel,
            sWarehouse.speakerDisplayLabel,
          ]),
        ),
        sourceSegmentIds: Array.from(
          new Set([sOpening.id, sForecast.id, sSchedule.id, sCustoms.id, sWarehouse.id]),
        ),
      },
      {
        topicKey: 'topic_engineering_release_reliability',
        title: 'API Integration, Webhook Reliability & Synchronized Release',
        summary:
          'Aligned on finalizing the API integration and staging report, verified the idempotent webhook retry policy, and planned synchronized mobile/desktop release with QA sign-off.',
        keywords: ['API integration', 'webhook retry', 'staging report', 'QA sign-off', 'release'],
        speakerLabels: Array.from(
          new Set([
            sApi.speakerDisplayLabel,
            sWebhook.speakerDisplayLabel,
            sRelease.speakerDisplayLabel,
          ]),
        ),
        sourceSegmentIds: Array.from(new Set([sApi.id, sWebhook.id, sRelease.id])),
      },
      {
        topicKey: 'topic_enterprise_onboarding_budget',
        title: 'Enterprise Onboarding Support & Q4 Budget Governance',
        summary:
          'Covered dedicated enterprise onboarding support channels, Q4 budget limit confirmation from finance, and immediate circulation of the meeting protocol.',
        keywords: ['enterprise onboarding', 'support channel', 'Q4 budget', 'protocol'],
        speakerLabels: Array.from(
          new Set([
            sOnboarding.speakerDisplayLabel,
            sBudget.speakerDisplayLabel,
            sProtocol.speakerDisplayLabel,
            sClosing.speakerDisplayLabel,
          ]),
        ),
        sourceSegmentIds: Array.from(
          new Set([sOnboarding.id, sBudget.id, sProtocol.id, sClosing.id]),
        ),
      },
    ];

    const decisions: ProviderDecisionCandidate[] = [
      {
        decisionKey: 'decision_api_staging_and_webhook_policy',
        statement:
          'Finalize API integration with Thursday staging report and enforce the verified idempotent webhook retry policy.',
        rationale:
          'Ensures transient network drops never duplicate orders before the synchronized sprint release.',
        status: 'confirmed',
        ownerLabel: sApi.speakerDisplayLabel,
        topicKey: 'topic_engineering_release_reliability',
        confidence: 0.96,
        sourceSegmentIds: Array.from(new Set([sApi.id, sWebhook.id])),
      },
      {
        decisionKey: 'decision_q4_budget_limit_approved',
        statement: sConfirmedBudget
          ? 'Confirmed $10,000 budget allocation for the initiative.'
          : 'Approved the Q4 budget limit confirmed by the finance department without additional delays.',
        rationale:
          'Finance completed verification so Q4 execution and enterprise onboarding can proceed on schedule.',
        status: 'confirmed',
        ownerLabel: (sConfirmedBudget ?? sBudget).speakerDisplayLabel,
        topicKey: 'topic_enterprise_onboarding_budget',
        confidence: 0.95,
        sourceSegmentIds: [sConfirmedBudget ? sConfirmedBudget.id : sBudget.id],
      },
      {
        decisionKey: 'decision_samarkand_warehouse_doubling',
        statement: sTentativeBudget
          ? 'Exploratory proposal to set the budget at $10,000 ("Balki $10,000 qilarmiz").'
          : 'Proposal to double the reserve inventory volume at the Samarkand warehouse.',
        rationale: sTentativeBudget
          ? 'Raised with tentative wording ("Balki") and requires explicit confirmation before commitment.'
          : 'Submitted as a proposal ("taklif kiritildi") to buffer regional delivery schedules.',
        status: sTentativeBudget ? 'tentative' : 'proposed',
        ownerLabel: (sTentativeBudget ?? sWarehouse).speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.91,
        sourceSegmentIds: [sTentativeBudget ? sTentativeBudget.id : sWarehouse.id],
      },
      {
        decisionKey: 'decision_synchronized_release_cadence',
        statement:
          'Tentative plan to ship mobile and desktop releases synchronously in the next sprint pending Friday QA sign-off.',
        rationale:
          'Dependent on Thursday staging report verification and Friday QA sign-off completion.',
        status: 'tentative',
        ownerLabel: sRelease.speakerDisplayLabel,
        topicKey: 'topic_engineering_release_reliability',
        confidence: 0.89,
        sourceSegmentIds: [sRelease.id],
      },
    ];

    const actionItems: ProviderActionItemCandidate[] = [
      {
        actionKey: 'action_finalize_api_and_staging_report',
        title: 'Finalize API integration and share the staging report',
        ownerLabel: sApi.speakerDisplayLabel,
        dueHint: 'Thursday',
        dueDate: null,
        status: 'open',
        topicKey: 'topic_engineering_release_reliability',
        decisionKey: 'decision_api_staging_and_webhook_policy',
        confidence: 0.96,
        sourceSegmentIds: [sApi.id],
      },
      {
        actionKey: 'action_prepare_customs_certificates',
        title: 'Complete customs documents and export certificates',
        ownerLabel: null,
        dueHint: 'Wednesday 16:00',
        dueDate: null,
        status: 'open',
        topicKey: 'topic_export_logistics_sla',
        decisionKey: null,
        confidence: 0.94,
        sourceSegmentIds: [sCustoms.id],
      },
      {
        actionKey: 'action_open_enterprise_support_channel',
        title: 'Open dedicated onboarding support channel for enterprise customers',
        ownerLabel: sOnboarding.speakerDisplayLabel,
        dueHint: null,
        dueDate: null,
        status: 'open',
        topicKey: 'topic_enterprise_onboarding_budget',
        decisionKey: null,
        confidence: 0.91,
        sourceSegmentIds: [sOnboarding.id],
      },
      {
        actionKey: 'action_resolve_logistics_sla_open_points',
        title: 'Prepare logistics SLA clarification response for Q4 contract review',
        ownerLabel: null,
        dueHint: null,
        dueDate: null,
        status: 'open',
        topicKey: 'topic_export_logistics_sla',
        decisionKey: null,
        confidence: 0.88,
        sourceSegmentIds: [sForecast.id],
      },
      {
        actionKey: 'action_send_meeting_protocol',
        title: 'Send meeting protocol and owner roster immediately after the call',
        ownerLabel: sProtocol.speakerDisplayLabel,
        dueHint: 'Immediately after call',
        dueDate: null,
        status: 'open',
        topicKey: 'topic_enterprise_onboarding_budget',
        decisionKey: null,
        confidence: 0.93,
        sourceSegmentIds: [sProtocol.id],
      },
    ];

    const facts: ProviderFactCandidate[] = [
      {
        factKey: 'fact_q4_revenue_growth_forecast',
        category: 'metric',
        label: 'Q4 revenue growth forecast',
        valueText: '18%',
        unit: '%',
        numericValue: 18,
        speakerLabel: sForecast.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.95,
        sourceSegmentIds: [sForecast.id],
      },
      {
        factKey: 'fact_samarkand_warehouse_multiplier',
        category: 'operations',
        label: 'Proposed Samarkand warehouse reserve multiplier',
        valueText: '2x',
        unit: 'x',
        numericValue: 2,
        speakerLabel: sWarehouse.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.92,
        sourceSegmentIds: [sWarehouse.id],
      },
      {
        factKey: 'fact_customs_cutoff_hour',
        category: 'timeline',
        label: 'Wednesday customs certificate readiness cutoff',
        valueText: '16:00',
        unit: 'hour',
        numericValue: 16,
        speakerLabel: sCustoms.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.94,
        sourceSegmentIds: [sCustoms.id],
      },
    ];

    if (sConversionFact) {
      facts.push({
        factKey: 'fact_conversion_rate',
        category: 'metric',
        label: 'conversion',
        valueText: '57%',
        unit: '%',
        numericValue: 57,
        speakerLabel: sConversionFact.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.96,
        sourceSegmentIds: [sConversionFact.id],
      });
    }

    if (sFiveKBudgetFact) {
      facts.push({
        factKey: 'fact_baseline_budget',
        category: 'budget',
        label: 'budget',
        valueText: '$5,000',
        unit: 'USD',
        numericValue: 5000,
        speakerLabel: sFiveKBudgetFact.speakerDisplayLabel,
        topicKey: 'topic_enterprise_onboarding_budget',
        confidence: 0.95,
        sourceSegmentIds: [sFiveKBudgetFact.id],
      });
    }

    if (sTeamSizeFact) {
      facts.push({
        factKey: 'fact_team_size',
        category: 'team',
        label: 'team size',
        valueText: '6',
        unit: 'people',
        numericValue: 6,
        speakerLabel: sTeamSizeFact.speakerDisplayLabel,
        topicKey: 'topic_engineering_release_reliability',
        confidence: 0.95,
        sourceSegmentIds: [sTeamSizeFact.id],
      });
    }

    const questions: ProviderQuestionCandidate[] = [
      {
        questionKey: 'question_logistics_sla_terms',
        question:
          'How will the open logistics SLA questions under the Q4 contract be resolved before regional shipments scale?',
        status: 'open',
        askedByLabel: sForecast.speakerDisplayLabel,
        ownerLabel: sSchedule.speakerDisplayLabel,
        answerSummary:
          'Tashkent and Samarkand delivery schedules are being locked down by Friday as the first mitigation step.',
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.92,
        sourceSegmentIds: Array.from(new Set([sForecast.id, sSchedule.id])),
      },
    ];

    const ideas: ProviderIdeaCandidate[] = [
      {
        ideaKey: 'idea_samarkand_buffer_expansion',
        idea: 'Double the reserve stock capacity at the Samarkand warehouse to absorb regional demand spikes.',
        notes: 'Introduced as an operational proposal during the export and logistics review.',
        status: 'exploring',
        proposedByLabel: sWarehouse.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.91,
        sourceSegmentIds: [sWarehouse.id],
      },
      {
        ideaKey: 'idea_dedicated_enterprise_onboarding_channel',
        idea: 'Provide a dedicated onboarding support channel for enterprise tier customers.',
        notes: 'Improves enterprise response times during initial rollout.',
        status: 'accepted',
        proposedByLabel: sOnboarding.speakerDisplayLabel,
        topicKey: 'topic_enterprise_onboarding_budget',
        confidence: 0.92,
        sourceSegmentIds: [sOnboarding.id],
      },
    ];

    const objections: ProviderObjectionCandidate[] = [
      {
        objectionKey: 'objection_logistics_sla_uncertainty',
        summary:
          'Despite the projected 18% Q4 revenue increase, unresolved logistics SLA terms pose a fulfillment concern.',
        status: 'mitigated',
        raisedByLabel: sForecast.speakerDisplayLabel,
        responseSummary:
          'Addressed by locking down explicit Tashkent and Samarkand delivery schedules by Friday.',
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.9,
        sourceSegmentIds: Array.from(new Set([sForecast.id, sSchedule.id])),
      },
    ];

    const commitments: ProviderCommitmentCandidate[] = [
      {
        commitmentKey: 'commitment_tashkent_samarkand_delivery_schedule',
        commitment: 'Lock in the Tashkent and Samarkand delivery schedule by Friday.',
        ownerLabel: sSchedule.speakerDisplayLabel,
        counterpartyLabel: sForecast.speakerDisplayLabel,
        dueLabel: 'Friday',
        status: 'pending',
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.94,
        sourceSegmentIds: [sSchedule.id],
      },
      {
        commitmentKey: 'commitment_thursday_staging_report',
        commitment: 'Deliver finalized API integration and staging report by Thursday.',
        ownerLabel: sApi.speakerDisplayLabel,
        counterpartyLabel: null,
        dueLabel: 'Thursday',
        status: 'pending',
        topicKey: 'topic_engineering_release_reliability',
        confidence: 0.96,
        sourceSegmentIds: [sApi.id],
      },
    ];

    const risks: ProviderRiskCandidate[] = [
      {
        riskKey: 'risk_customs_clearance_deadline',
        title: 'Customs documentation and export certificate Wednesday 16:00 deadline risk',
        detail:
          'Any delay in customs certificates past Wednesday 16:00 will block regional export shipments.',
        severity: 'high',
        status: 'open',
        mitigation: 'Enforce strict Wednesday 16:00 readiness cutoff for all customs paperwork.',
        ownerLabel: sCustoms.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.93,
        sourceSegmentIds: [sCustoms.id],
      },
      {
        riskKey: 'risk_logistics_sla_gaps',
        title: 'Unresolved logistics SLA questions against 18% Q4 demand growth',
        detail:
          'Contractual Q4 growth of 18% could strain regional delivery SLAs if warehouse and route schedules slip.',
        severity: 'medium',
        status: 'mitigating',
        mitigation:
          'Fix Tashkent/Samarkand delivery schedules by Friday and evaluate 2x Samarkand reserve stock.',
        ownerLabel: sForecast.speakerDisplayLabel,
        topicKey: 'topic_export_logistics_sla',
        confidence: 0.91,
        sourceSegmentIds: Array.from(new Set([sForecast.id, sSchedule.id, sWarehouse.id])),
      },
    ];

    const claims: ProviderExecutiveSummaryClaim[] = [
      {
        claimKey: 'claim_meeting_purpose',
        section: 'purpose',
        text: 'The team convened to align Q4 product delivery, export logistics SLAs, customs readiness, and enterprise onboarding.',
        sourceSegmentIds: Array.from(new Set([sOpening.id, sForecast.id])),
      },
      {
        claimKey: 'claim_discussion_logistics_and_engineering',
        section: 'discussion',
        text: 'Participants reviewed the 18% Q4 revenue forecast, Tashkent/Samarkand delivery schedules, API/webhook reliability, and dedicated enterprise onboarding support.',
        sourceSegmentIds: Array.from(
          new Set([sForecast.id, sSchedule.id, sApi.id, sOnboarding.id, sWebhook.id]),
        ),
      },
      {
        claimKey: 'claim_confirmed_decisions',
        section: 'decision',
        text: 'Confirmed Q4 finance budget approval and API integration completion with idempotent webhook retries.',
        sourceSegmentIds: Array.from(
          new Set([sApi.id, sWebhook.id, sConfirmedBudget ? sConfirmedBudget.id : sBudget.id]),
        ),
      },
      {
        claimKey: 'claim_next_actions',
        section: 'action',
        text: 'Next actions include Wednesday 16:00 customs certificate completion, Thursday API staging report, Friday delivery schedule & QA sign-off, and immediate protocol distribution.',
        sourceSegmentIds: Array.from(
          new Set([sCustoms.id, sApi.id, sSchedule.id, sRelease.id, sProtocol.id]),
        ),
      },
      {
        claimKey: 'claim_unresolved_points',
        section: 'unresolved',
        text: 'Open points remain on contractual logistics SLA questions and the proposed 2x Samarkand warehouse reserve expansion.',
        sourceSegmentIds: Array.from(
          new Set([sForecast.id, sTentativeBudget ? sTentativeBudget.id : sWarehouse.id]),
        ),
      },
    ];

    const allCitedSegmentIds = Array.from(new Set(claims.flatMap((c) => c.sourceSegmentIds)));

    const extraction = providerWindowExtractionSchema.parse({
      windowIndex: input.windowIndex,
      executiveSummary: {
        headline:
          'Q4 Product & Export Alignment: 18% Growth Forecast, API/Webhook Readiness, and Regional Logistics SLA',
        tlDr: 'Aligned on Q4 budget approval, Thursday API staging report, Wednesday 16:00 customs readiness, and Friday Tashkent/Samarkand delivery schedules while keeping Samarkand 2x stock expansion as a proposal.',
        whyMeetingHappened:
          'To synchronize product engineering, regional export logistics, customs readiness, and enterprise onboarding for the Q4 growth plan.',
        majorDiscussions: [
          '18% Q4 revenue growth forecast under contract and associated logistics SLA questions.',
          'Tashkent and Samarkand delivery schedules and Wednesday 16:00 customs documentation cutoff.',
          'API integration staging report, idempotent webhook retry verification, and synchronized mobile/desktop release.',
          'Dedicated enterprise onboarding support channel and Q4 finance budget confirmation.',
        ],
        confirmedDecisions: decisions
          .filter((d) => d.status === 'confirmed')
          .map((d) => d.statement),
        nextActions: actionItems.map((a) => a.title),
        unresolvedPoints: [
          'Open logistics SLA questions under the Q4 contract.',
          'Proposed 2x reserve inventory expansion at the Samarkand warehouse requires final sign-off.',
        ],
        followUps: [
          'Circulate the meeting protocol and owner list immediately after the call.',
          'Review execution results in next week’s follow-up meeting.',
        ],
        claims,
        sourceSegmentIds: allCitedSegmentIds,
      },
      topics,
      decisions,
      actionItems,
      facts,
      questions,
      ideas,
      objections,
      commitments,
      risks,
      followUps: [
        'Circulate the meeting protocol and owner list immediately after the call.',
        'Review execution results in next week’s follow-up meeting.',
      ],
    });

    return {
      provider: this.providerName,
      model: this.defaultModel,
      promptVersion: this.promptVersion,
      schemaVersion: this.schemaVersion,
      pipelineVersion: this.pipelineVersion,
      tokenUsage: {
        promptTokens: segs.length * 42,
        completionTokens: 520,
        totalTokens: segs.length * 42 + 520,
      },
      extraction,
      providerMetadata: {
        deterministic_fixture: true,
        window_index: input.windowIndex,
        total_windows: input.totalWindows,
        segment_count: segs.length,
      },
    };
  }
}

export type OpenAIMeetingIntelligenceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
};

type RawOpenAIChatCompletionResponse = {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
      refusal?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: {
    message?: unknown;
    code?: unknown;
  };
};

/**
 * Production-wired `OpenAIMeetingIntelligenceProvider`.
 *
 * - Stays disabled unless explicitly configured with an API key (`OPENAI_API_KEY`).
 * - Never silently falls back to `FakeMeetingIntelligenceProvider`.
 * - Uses centralized prompt version, schema version, and strict JSON Schema structured output.
 */
export class OpenAIMeetingIntelligenceProvider implements MeetingIntelligenceProvider {
  readonly providerName = 'openai';
  readonly defaultModel: string;
  readonly promptVersion = MEETING_INTELLIGENCE_PROMPT_VERSION;
  readonly schemaVersion = MEETING_INTELLIGENCE_SCHEMA_VERSION;
  readonly pipelineVersion = MEETING_INTELLIGENCE_PIPELINE_VERSION;

  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: OpenAIMeetingIntelligenceProviderConfig = {}) {
    const trimmedKey = config.apiKey?.trim() ?? '';
    this.apiKey = trimmedKey.length > 0 ? trimmedKey : null;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultModel = config.model?.trim() || 'gpt-4o-2024-08-06';
    this.fetchFn = config.fetchFn ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  async analyzeWindow(input: AnalyzeTranscriptWindowInput): Promise<AnalyzeTranscriptWindowOutput> {
    if (!this.apiKey) {
      throw new MeetingIntelligenceProviderError(
        'provider_not_configured',
        'OpenAIMeetingIntelligenceProvider is not configured: missing OPENAI_API_KEY. Live provider mode never falls back to fake provider mode.',
        false,
      );
    }

    if (input.segments.length === 0) {
      throw new MeetingIntelligenceProviderError(
        'provider_invalid_response',
        'Cannot analyze an empty transcript window.',
        false,
      );
    }

    const userPrompt = buildMeetingWindowAnalysisUserPrompt(input);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          temperature: 0,
          messages: [
            { role: 'system', content: MEETING_INTELLIGENCE_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'meeting_intelligence_window_v1',
              strict: true,
              schema: MEETING_INTELLIGENCE_JSON_SCHEMA,
            },
          },
        }),
      });
    } catch (err) {
      throw new MeetingIntelligenceProviderError(
        'provider_unavailable',
        `OpenAI chat completion request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new MeetingIntelligenceProviderError(
        retryable ? 'provider_unavailable' : 'provider_analysis_failed',
        `OpenAI chat completion returned HTTP ${response.status}`,
        retryable,
      );
    }

    let payload: RawOpenAIChatCompletionResponse;
    try {
      payload = (await response.json()) as RawOpenAIChatCompletionResponse;
    } catch (err) {
      throw new MeetingIntelligenceProviderError(
        'provider_invalid_response',
        `OpenAI returned non-JSON payload: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    const rawContent = payload.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      throw new MeetingIntelligenceProviderError(
        'provider_invalid_response',
        'OpenAI response did not contain a structured JSON message content string.',
        false,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch (err) {
      throw new MeetingIntelligenceProviderError(
        'provider_invalid_response',
        `OpenAI message content was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    const validated = providerWindowExtractionSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new MeetingIntelligenceProviderError(
        'provider_invalid_response',
        `OpenAI structured output failed schema validation: ${validated.error.message}`,
        false,
      );
    }

    const promptTokens =
      typeof payload.usage?.prompt_tokens === 'number' && payload.usage.prompt_tokens >= 0
        ? Math.floor(payload.usage.prompt_tokens)
        : 0;
    const completionTokens =
      typeof payload.usage?.completion_tokens === 'number' && payload.usage.completion_tokens >= 0
        ? Math.floor(payload.usage.completion_tokens)
        : 0;
    const totalTokens =
      typeof payload.usage?.total_tokens === 'number' && payload.usage.total_tokens >= 0
        ? Math.floor(payload.usage.total_tokens)
        : promptTokens + completionTokens;

    return {
      provider: this.providerName,
      model:
        typeof payload.model === 'string' && payload.model.trim().length > 0
          ? payload.model
          : this.defaultModel,
      promptVersion: this.promptVersion,
      schemaVersion: this.schemaVersion,
      pipelineVersion: this.pipelineVersion,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      extraction: validated.data,
      providerMetadata: {
        openai_completion_id: typeof payload.id === 'string' ? payload.id : null,
        window_index: input.windowIndex,
      },
    };
  }
}

export function createMeetingIntelligenceProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): MeetingIntelligenceProvider {
  const isProd = env.NODE_ENV === 'production';
  const rawMode =
    env.SUHBAT_INTELLIGENCE_PROVIDER ?? env.INTELLIGENCE_PROVIDER ?? (isProd ? 'openai' : 'fake');
  const mode = rawMode.trim().toLowerCase();
  if (mode === 'fake') {
    if (isProd) {
      throw new MeetingIntelligenceProviderError(
        'provider_not_configured',
        'FakeMeetingIntelligenceProvider is not permitted in production.',
        false,
      );
    }
    return new FakeMeetingIntelligenceProvider();
  }
  if (mode === 'openai') {
    if (isProd && !env.OPENAI_API_KEY?.trim()) {
      throw new MeetingIntelligenceProviderError(
        'provider_not_configured',
        'OpenAIMeetingIntelligenceProvider requires OPENAI_API_KEY in production.',
        false,
      );
    }
    return new OpenAIMeetingIntelligenceProvider({
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_INTELLIGENCE_MODEL ?? env.OPENAI_ANALYSIS_MODEL,
    });
  }
  throw new MeetingIntelligenceProviderError(
    'provider_not_configured',
    `Unsupported SUHBAT_INTELLIGENCE_PROVIDER "${mode}". Expected "fake" or "openai".`,
    false,
  );
}
