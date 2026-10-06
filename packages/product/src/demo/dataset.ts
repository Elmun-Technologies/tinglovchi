import type {
  CompanyIntelligence,
  CompanyIntelligenceItem,
  Commitment,
  DashboardSnapshot,
  Decision,
  EvidenceRef,
  Fact,
  Idea,
  KnowledgeEntry,
  MeetingDetail,
  MeetingSummary,
  MeetingTranscript,
  ProcessingTimeline,
  Question,
  SettingsSnapshot,
  Task,
  Topic,
  TranscriptSegment,
} from '../domain';
import {
  demoCompanies,
  demoMeetingTypes,
  demoPeople,
  demoProjects,
  demoVocabulary,
  DEMO_GENERATED_AT,
  DEMO_TODAY_ISO_DATE,
  demoWorkspace,
} from './corpus';
import {
  demoCommitments,
  demoDecisions,
  demoFacts,
  demoIdeas,
  demoIntelligenceNotes,
  demoQuestions,
  demoTasks,
} from './analysis';
import { demoMeetingSeeds, type DemoMeetingSeed } from './meetings';
import { DEMO_CURRENT_PERSON_ID, DEMO_WORKSPACE_ID, person } from './ids';
import { meetingSlugs, speakerLabels, transcriptLines } from './transcripts';
import { demoTopicSeeds } from './topics';
import { MEETING_ID_BY_KEY, type LineRange, type MeetingKey } from './ranges';

/**
 * The demo dataset builder.
 *
 * Everything derived — segment ids, evidence time ranges, per-meeting counts, topic membership, company and
 * project links on analysis artifacts, dashboard aggregates — is computed here from a single authored source.
 * That is what makes the fixtures internally consistent *by construction*: an artifact cannot cite a line
 * that was never authored, and a summary cannot claim a count its own children contradict. `integrity.ts`
 * then verifies the assembled result, because a builder should not be trusted on assertion alone.
 */

export type DemoDataset = {
  todayIsoDate: string;
  generatedAt: string;
  currentPersonId: string;
  workspaces: (typeof demoWorkspace)[];
  people: typeof demoPeople;
  companies: typeof demoCompanies;
  projects: typeof demoProjects;
  meetingTypes: typeof demoMeetingTypes;
  meetings: MeetingSummary[];
  details: Record<string, MeetingDetail>;
  transcripts: Record<string, MeetingTranscript>;
  topicsByMeeting: Record<string, Topic[]>;
  decisions: Decision[];
  tasks: Task[];
  facts: Fact[];
  questions: Question[];
  ideas: Idea[];
  commitments: Commitment[];
  processing: Record<string, ProcessingTimeline>;
  intelligence: Record<string, CompanyIntelligence>;
  settings: SettingsSnapshot;
  dashboard: DashboardSnapshot;
};

const QUOTE_LIMIT = 220;
const SPEECH_MS_PER_WORD = 335;
const LINE_GAP_MS = 650;

const meetingIdOf = (key: MeetingKey): string => MEETING_ID_BY_KEY[key];

function quoteFrom(segments: TranscriptSegment[]): string {
  const joined = segments.map((segment) => segment.text).join(' ');
  return joined.length > QUOTE_LIMIT ? `${joined.slice(0, QUOTE_LIMIT - 1)}…` : joined;
}

/** Turns an authored line range into a real, resolvable evidence reference over the built transcript. */
function evidenceFor(
  meeting: DemoMeetingSeed,
  segments: TranscriptSegment[],
  lines: LineRange,
): EvidenceRef {
  const slice = segments.filter(
    (segment) => segment.index >= lines[0] && segment.index <= lines[1],
  );
  return {
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    occurredAt: meeting.occurredAt,
    startMs: slice[0]?.startMs ?? 0,
    endMs: slice.at(-1)?.endMs ?? 0,
    segmentIds: slice.map((segment) => segment.id),
    speakerPersonIds: [
      ...new Set(
        slice.map((segment) => segment.speakerPersonId).filter((id): id is string => id !== null),
      ),
    ],
    quote: quoteFrom(slice),
  };
}

function buildTranscript(meeting: DemoMeetingSeed): MeetingTranscript {
  const labelOfPerson = speakerLabels[meeting.transcript ?? ''] ?? {};
  const unmapped = new Set(meeting.unmappedSpeakers ?? []);
  const lines = meeting.transcript === null ? [] : transcriptLines[meeting.transcript];
  const slug = meeting.transcript === null ? 'empty' : meetingSlugs[meeting.transcript];
  const slot = lines.length > 0 ? Math.floor(meeting.durationMs / lines.length) : 0;

  const segments: TranscriptSegment[] = lines.map((line, index) => {
    const [speakerPersonId, text, language = 'uz'] = line;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const startMs = index * slot;
    const speechMs = Math.min(
      Math.max(words * SPEECH_MS_PER_WORD + LINE_GAP_MS, 1_400),
      15_000,
      Math.max(slot - 200, 800),
    );
    const label = labelOfPerson[speakerPersonId] ?? `Speaker ${index + 1}`;
    return {
      id: `seg_${slug}_${String(index).padStart(3, '0')}`,
      meetingId: meeting.id,
      index,
      // An unattributed diarization label carries no person id; mapping it is the UI's job, not a guess.
      speakerPersonId: unmapped.has(label) ? null : speakerPersonId,
      speakerLabel: label,
      startMs,
      endMs: startMs + speechMs,
      text,
      language,
      topicId: null,
    };
  });

  const speakerMappings = [...new Set(segments.map((segment) => segment.speakerLabel))].map(
    (label) => ({
      label,
      // An unmapped label has no candidate person at all: suggesting one here would be the UI guessing.
      personId: unmapped.has(label)
        ? null
        : (Object.keys(labelOfPerson).find((personId) => labelOfPerson[personId] === label) ??
          null),
      confirmed: !unmapped.has(label),
      segmentCount: segments.filter((segment) => segment.speakerLabel === label).length,
    }),
  );

  return {
    meetingId: meeting.id,
    segments,
    topics: [],
    participants: meeting.participants,
    speakerMappings,
    totalMs: segments.at(-1)?.endMs ?? 0,
    wordCount: segments.reduce(
      (sum, segment) => sum + segment.text.trim().split(/\s+/).filter(Boolean).length,
      0,
    ),
  };
}

function buildTopics(meeting: DemoMeetingSeed, segments: TranscriptSegment[]): Topic[] {
  const seeds = demoTopicSeeds.filter(
    (seed) => meeting.transcript !== null && seed.meetingKey === meeting.transcript,
  );
  return seeds.map((seed) => {
    const slice = segments.filter(
      (segment) => segment.index >= seed.lines[0] && segment.index <= seed.lines[1],
    );
    return {
      id: seed.id,
      workspaceId: DEMO_WORKSPACE_ID,
      meetingId: meeting.id,
      parentId: seed.parentId,
      title: seed.title,
      summary: seed.summary,
      keywords: seed.keywords,
      startMs: slice[0]?.startMs ?? 0,
      endMs: slice.at(-1)?.endMs ?? 0,
      participantPersonIds: [
        ...new Set(
          slice.map((segment) => segment.speakerPersonId).filter((id): id is string => id !== null),
        ),
      ],
      // The full authored span, so a parent section header still points at everything it covers.
      segmentIds: slice.map((segment) => segment.id),
      decisionIds: [],
      taskIds: [],
      questionIds: [],
      ideaIds: [],
    };
  });
}

/**
 * Marks each segment with the most specific topic covering it, so a child's transcript view is precise while
 * the parent keeps the union. Without this, "click a topic → see its sections" would light up the whole
 * meeting for every parent topic.
 */
function attributeSegments(topics: Topic[], segments: TranscriptSegment[]): TranscriptSegment[] {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const depthOf = (topicId: string): number => {
    let depth = 0;
    let current = byId.get(topicId);
    while (current?.parentId) {
      depth += 1;
      current = byId.get(current.parentId);
    }
    return depth;
  };
  const owners = new Map<string, { topicId: string; depth: number }>();
  for (const topic of topics) {
    const depth = depthOf(topic.id);
    for (const segmentId of topic.segmentIds) {
      const existing = owners.get(segmentId);
      if (!existing || depth > existing.depth) owners.set(segmentId, { topicId: topic.id, depth });
    }
  }
  return segments.map((segment) => {
    const owner = owners.get(segment.id);
    return owner ? { ...segment, topicId: owner.topicId } : segment;
  });
}

function toSummary(
  seed: DemoMeetingSeed,
  segments: TranscriptSegment[],
  topics: Topic[],
): MeetingSummary {
  const companyEntity = demoCompanies.find((item) => item.id === seed.companyId);
  const projectEntity = demoProjects.find((item) => item.id === seed.projectId);
  return {
    id: seed.id,
    workspaceId: DEMO_WORKSPACE_ID,
    title: seed.title,
    companyId: seed.companyId,
    companyName: companyEntity?.name,
    projectId: seed.projectId,
    projectName: projectEntity?.name,
    meetingTypeId: seed.meetingTypeId,
    meetingTypeKey: seed.meetingTypeKey,
    meetingTypeLabel: seed.meetingTypeLabel,
    occurredAt: seed.occurredAt,
    durationMs: seed.durationMs,
    capturedMs: seed.capturedMs,
    state: seed.state,
    languages: seed.languages,
    participants: seed.participants.map((participant) => ({
      ...participant,
      spokeInMeeting:
        participant.spokeInMeeting &&
        segments.some((segment) => segment.speakerPersonId === participant.personId),
    })),
    origin: seed.origin,
    recordingAvailable: seed.recording.available,
    counts: {
      topics: topics.length,
      decisions: 0,
      tasks: 0,
      facts: 0,
      questions: 0,
      ideas: 0,
      segments: segments.length,
    },
  };
}

function toDetail(
  seed: DemoMeetingSeed,
  summary: MeetingSummary,
  transcript: MeetingTranscript,
  topics: Topic[],
): MeetingDetail {
  return {
    ...summary,
    executiveSummary: seed.executiveSummary,
    keyOutcome: seed.keyOutcome,
    unmappedSpeakers: seed.unmappedSpeakers ?? [],
    recording: seed.recording,
    stats: {
      speakingParticipants: new Set(
        transcript.segments.map((segment) => segment.speakerPersonId ?? segment.speakerLabel),
      ).size,
      topics: topics.length,
      decisions: 0,
      confirmedDecisions: 0,
      tasks: 0,
      openTasks: 0,
      questions: 0,
      openQuestions: 0,
      facts: 0,
      ideas: 0,
      words: transcript.wordCount,
    },
    processing: processingTimeline(seed),
  };
}

function processingTimeline(seed: DemoMeetingSeed): ProcessingTimeline {
  return {
    meetingId: seed.id,
    state: seed.state,
    steps: seed.steps ?? [{ state: 'pending', key: 'capture', label: 'Not recorded yet' }],
    ...(seed.failure ? { error: seed.failure } : {}),
  };
}

const MEMBER_ROLES: Record<string, 'owner' | 'admin' | 'member'> = {
  [person.elmurod]: 'owner',
  [person.akmal]: 'admin',
  [person.aziz]: 'admin',
};

function buildSettings(): SettingsSnapshot {
  return {
    workspaceId: DEMO_WORKSPACE_ID,
    workspaceName: demoWorkspace.name,
    workspaceSlug: demoWorkspace.slug,
    currentRole: demoWorkspace.role,
    members: demoPeople.map((individual) => ({
      personId: individual.id,
      name: individual.name,
      email: individual.email,
      role: MEMBER_ROLES[individual.id] ?? 'member',
      // The consultant has not accepted an invitation yet — the list must show that, not a fake "active".
      status:
        individual.id === person.rustam
          ? 'invited'
          : individual.kind === 'internal'
            ? 'active'
            : 'active',
    })),
    meetingTypes: demoMeetingTypes,
    vocabulary: demoVocabulary,
    recording: {
      preferredInputLabel: 'MacBook Pro Microphone (built-in)',
      captureSystemAudio: true,
      retentionLabel: 'Kept on the capture machine until deleted; nothing uploads automatically',
      screenContextDefault: 'ask',
      audioFormatLabel: 'PCM s16le in WAV · 48 kHz · microphone mono + system audio stereo',
      chunkLengthSeconds: 30,
      storageRootLabel: 'Application data directory · recordings/sessions/<session id>',
    },
    ai: {
      transcriptionLanguages: ['uz', 'ru', 'en'],
      speakerLanguageGuessing: true,
      summaryStyle: 'executive_brief',
      analysisDepth: 'standard',
      providerNote:
        'No provider is configured in this build. Language, summary style and depth are stored per workspace and take effect when a pipeline adapter exists.',
    },
    integrations: [
      {
        key: 'telegram',
        label: 'Telegram',
        state: 'coming_later',
        detail: 'Deliver decisions and task digests to a chat.',
      },
      {
        key: 'google_calendar',
        label: 'Google Calendar',
        state: 'coming_later',
        detail: 'Schedule follow-ups from tasks that have deadlines.',
      },
      {
        key: 'amocrm',
        label: 'amoCRM',
        state: 'not_connected',
        detail: 'Push qualified-lead fields and deal stages.',
      },
      {
        key: 'google_docs',
        label: 'Google Docs',
        state: 'not_connected',
        detail: 'Export a meeting brief as a document.',
      },
    ],
  };
}

function buildIntelligence(sources: {
  meetings: MeetingSummary[];
  facts: Fact[];
  commitments: Commitment[];
}): Record<string, CompanyIntelligence> {
  const out: Record<string, CompanyIntelligence> = {};
  for (const companyEntity of demoCompanies) {
    const notes = demoIntelligenceNotes[companyEntity.id];
    const companyMeetingIds = new Set(
      sources.meetings
        .filter((meeting) => meeting.companyId === companyEntity.id)
        .map((meeting) => meeting.id),
    );
    const narrative = (text: string, personId: string | null = null): CompanyIntelligenceItem => ({
      text,
      personId,
    });
    const companyFacts = sources.facts.filter((fact) => fact.companyId === companyEntity.id);
    const companyCommitments = sources.commitments.filter((commitment) =>
      companyMeetingIds.has(commitment.meetingId),
    );
    out[companyEntity.id] = {
      companyId: companyEntity.id,
      updatedAt: DEMO_GENERATED_AT,
      derivedFrom: 'demo_fixtures',
      goals: (notes?.goals ?? []).map((text) => narrative(text)),
      painPoints: (notes?.painPoints ?? []).map((text) => narrative(text)),
      importantFacts: companyFacts.slice(0, 5).map((fact) => ({
        text: `${fact.label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`,
        personId: fact.speakerPersonId,
        evidence: fact.evidence[0],
      })),
      decisionMakers: (notes?.decisionMakers ?? []).map((text) => narrative(text)),
      objections: (notes?.objections ?? []).map((text) => narrative(text)),
      commitments: companyCommitments.map((commitment) => ({
        text: commitment.text,
        personId: commitment.byPersonId,
        evidence: commitment.evidence[0],
      })),
    };
  }
  return out;
}

/**
 * The one derivation of the home screen. The fixture builder calls it once; the demo adapter calls it again
 * after every write, so a created draft or an archived company is reflected instead of stranded behind a
 * stale snapshot.
 */
export function deriveDashboard(dataset: {
  todayIsoDate: string;
  generatedAt: string;
  workspaceId: string;
  meetings: MeetingSummary[];
  tasks: Task[];
  decisions: Decision[];
  questions: Question[];
  processing: Record<string, ProcessingTimeline>;
  companyCount: number;
}): DashboardSnapshot {
  const today = dataset.todayIsoDate;
  const weekAgo = weekAgoOf(today);
  const isToday = (iso: string) => iso.slice(0, 10) === today;
  const isOpen = (task: Task) =>
    task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked';
  const isOverdue = (task: Task) => isOpen(task) && task.dueDate !== null && task.dueDate < today;
  const sorted = [...dataset.meetings].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt),
  );
  return {
    workspaceId: dataset.workspaceId,
    generatedAt: dataset.generatedAt,
    todayMeetings: sorted.filter((meeting) => isToday(meeting.occurredAt)),
    openTaskCount: dataset.tasks.filter(isOpen).length,
    overdueTaskCount: dataset.tasks.filter(isOverdue).length,
    decisionCount7d: dataset.decisions.filter((decision) => decision.decidedOn >= weekAgo).length,
    openQuestionCount: dataset.questions.filter((question) => question.status === 'open').length,
    recentMeetings: sorted.slice(0, 5).map((meeting) => ({
      meeting,
      openTaskCount: dataset.tasks.filter((task) => task.meetingId === meeting.id && isOpen(task))
        .length,
      overdueTaskCount: dataset.tasks.filter(
        (task) => task.meetingId === meeting.id && isOverdue(task),
      ).length,
    })),
    upcomingOrToday: sorted.filter(
      (meeting) => isToday(meeting.occurredAt) && meeting.state === 'draft',
    ),
    recentActions: [...dataset.tasks]
      .filter(isOpen)
      .sort((left, right) => (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'))
      .slice(0, 5),
    recentDecisions: [...dataset.decisions]
      .filter((decision) => decision.decidedOn >= weekAgo)
      .sort((left, right) => right.decidedOn.localeCompare(left.decidedOn))
      .slice(0, 4),
    processing: Object.values(dataset.processing).filter(
      (timeline) => timeline.state !== 'ready' && timeline.state !== 'failed',
    ),
    meetingCount: dataset.meetings.length,
    companyCount: dataset.companyCount,
  };
}

/** Seven days before a calendar date, as the same `YYYY-MM-DD` form the records use. */
function weekAgoOf(isoDate: string): string {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base)) return isoDate;
  return new Date(base - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Fixture-time dashboard: the same derivation with the demo workspace's fixed clock. */
function buildDashboard(
  meetings: MeetingSummary[],
  tasks: Task[],
  decisions: Decision[],
  questions: Question[],
  processing: Record<string, ProcessingTimeline>,
): DashboardSnapshot {
  return deriveDashboard({
    todayIsoDate: DEMO_TODAY_ISO_DATE,
    generatedAt: DEMO_GENERATED_AT,
    workspaceId: DEMO_WORKSPACE_ID,
    meetings,
    tasks,
    decisions,
    questions,
    processing,
    companyCount: demoCompanies.length,
  });
}

export function knowledgeEntries(dataset: DemoDataset): KnowledgeEntry[] {
  const meetingOf = (id: string) => dataset.meetings.find((meeting) => meeting.id === id);
  const entries: KnowledgeEntry[] = [];
  for (const decision of dataset.decisions) {
    entries.push({
      kind: 'decision',
      id: decision.id,
      workspaceId: decision.workspaceId,
      meetingId: decision.meetingId,
      companyId: decision.companyId,
      projectId: decision.projectId,
      title: decision.title,
      body: decision.description,
      at: `${decision.decidedOn}T12:00:00Z`,
      personIds: decision.participantPersonIds,
      tags: [decision.status, meetingOf(decision.meetingId)?.meetingTypeLabel ?? 'meeting'],
      statusLabel: decision.status,
      evidence: decision.evidence,
    });
  }
  for (const fact of dataset.facts) {
    entries.push({
      kind: 'fact',
      id: fact.id,
      workspaceId: fact.workspaceId,
      meetingId: fact.meetingId,
      companyId: fact.companyId,
      projectId: fact.projectId,
      title: fact.label,
      body: `${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`,
      at: fact.capturedAt,
      personIds: fact.speakerPersonId ? [fact.speakerPersonId] : [],
      tags: [fact.category],
      statusLabel: fact.category,
      evidence: fact.evidence,
    });
  }
  for (const [meetingId, topics] of Object.entries(dataset.topicsByMeeting)) {
    const meeting = meetingOf(meetingId);
    for (const topic of topics) {
      entries.push({
        kind: 'topic',
        id: topic.id,
        workspaceId: topic.workspaceId,
        meetingId: topic.meetingId,
        companyId: meeting?.companyId ?? null,
        projectId: meeting?.projectId ?? null,
        title: topic.title,
        body: topic.summary,
        at: meeting?.occurredAt ?? DEMO_GENERATED_AT,
        personIds: topic.participantPersonIds,
        tags: topic.keywords,
        statusLabel: `${topic.segmentIds.length} segments`,
        evidence: [
          {
            meetingId: topic.meetingId,
            meetingTitle: meeting?.title ?? 'Unknown meeting',
            occurredAt: meeting?.occurredAt ?? DEMO_GENERATED_AT,
            startMs: topic.startMs,
            endMs: topic.endMs,
            segmentIds: topic.segmentIds,
            speakerPersonIds: topic.participantPersonIds,
          },
        ],
      });
    }
  }
  for (const commitment of dataset.commitments) {
    entries.push({
      kind: 'commitment',
      id: commitment.id,
      workspaceId: commitment.workspaceId,
      meetingId: commitment.meetingId,
      companyId: commitment.companyId,
      projectId: null,
      title: 'Commitment',
      body: commitment.text,
      at: meetingOf(commitment.meetingId)?.occurredAt ?? DEMO_GENERATED_AT,
      personIds: [commitment.byPersonId],
      tags: [commitment.status],
      statusLabel: commitment.status,
      evidence: commitment.evidence,
    });
  }
  for (const question of dataset.questions) {
    entries.push({
      kind: 'question',
      id: question.id,
      workspaceId: question.workspaceId,
      meetingId: question.meetingId,
      companyId: question.companyId,
      projectId: question.projectId,
      title: question.status === 'open' ? 'Open question' : 'Question',
      body: question.text,
      at: `${question.raisedOn}T12:00:00Z`,
      personIds: question.askedByPersonId ? [question.askedByPersonId] : [],
      tags: [question.status],
      statusLabel: question.status,
      evidence: question.evidence,
    });
  }
  return entries;
}

export function buildDemoDataset(): DemoDataset {
  const meetings = demoMeetingSeeds;
  const transcripts: Record<string, MeetingTranscript> = {};
  const topicsByMeeting: Record<string, Topic[]> = {};
  const details: Record<string, MeetingDetail> = {};
  const processing: Record<string, ProcessingTimeline> = {};
  const summaries: MeetingSummary[] = [];

  for (const seed of meetings) {
    const baseTranscript = buildTranscript(seed);
    const topics = buildTopics(seed, baseTranscript.segments);
    const segments = attributeSegments(topics, baseTranscript.segments);
    const linkedTopics = topics.map((topic) => ({
      ...topic,
      participantPersonIds: [
        ...new Set(
          segments
            .filter(
              (segment) => segment.topicId === topic.id || topic.segmentIds.includes(segment.id),
            )
            .map((segment) => segment.speakerPersonId)
            .filter((id): id is string => id !== null),
        ),
      ],
    }));
    const transcript: MeetingTranscript = { ...baseTranscript, segments, topics: linkedTopics };
    transcripts[seed.id] = transcript;
    topicsByMeeting[seed.id] = linkedTopics;
    processing[seed.id] = processingTimeline(seed);
    const summary = toSummary(seed, segments, linkedTopics);
    summaries.push(summary);
    details[seed.id] = toDetail(seed, summary, transcript, linkedTopics);
  }

  const summaryById = new Map(summaries.map((meeting) => [meeting.id, meeting]));
  const segmentById = new Map<string, TranscriptSegment[]>();
  for (const [meetingId, transcript] of Object.entries(transcripts))
    segmentById.set(meetingId, transcript.segments);
  const seedById = new Map(meetings.map((seed) => [seed.id, seed]));

  const scopeOf = (meetingId: string) => {
    const meeting = summaryById.get(meetingId);
    return {
      workspaceId: DEMO_WORKSPACE_ID,
      meetingId,
      companyId: meeting?.companyId ?? null,
      projectId: meeting?.projectId ?? null,
    };
  };
  const evidence = (meetingKey: MeetingKey, lines: LineRange): EvidenceRef => {
    const meetingId = meetingIdOf(meetingKey);
    const seed = seedById.get(meetingId);
    if (!seed) throw new Error(`demo fixture: unknown meeting key ${meetingKey}`);
    const ref = evidenceFor(seed, segmentById.get(meetingId) ?? [], lines);
    if (ref.segmentIds.length === 0) {
      throw new Error(
        `demo fixture: ${meetingKey} lines ${lines[0]}-${lines[1]} match no transcript segment`,
      );
    }
    return ref;
  };

  const decisions: Decision[] = demoDecisions.map((seed) => ({
    id: seed.id,
    ...scopeOf(meetingIdOf(seed.meetingKey)),
    topicId: seed.topicId,
    title: seed.title,
    description: seed.description,
    status: seed.status,
    participantPersonIds: seed.participantPersonIds,
    evidence: [evidence(seed.meetingKey, seed.lines)],
    decidedOn: seed.decidedOn,
    supersededByDecisionId: seed.supersededByDecisionId ?? null,
    hasFollowUpTasks: demoTasks.some(
      (task) =>
        task.meetingKey === seed.meetingKey &&
        (seed.topicId === null || task.topicId === seed.topicId),
    ),
  }));

  const tasks: Task[] = demoTasks.map((seed) => {
    const meetingId = meetingIdOf(seed.meetingKey);
    const owner = demoPeople.find((item) => item.id === seed.ownerPersonId);
    return {
      id: seed.id,
      ...scopeOf(meetingId),
      topicId: seed.topicId,
      title: seed.title,
      detail: seed.detail,
      ownerPersonId: seed.ownerPersonId,
      ownerLabel: owner?.name ?? 'Unassigned',
      dueDate: seed.dueDate,
      status: seed.status,
      priority: seed.priority,
      evidence: [evidence(seed.meetingKey, seed.lines)],
      createdAt: summaryById.get(meetingId)?.occurredAt ?? DEMO_GENERATED_AT,
      ...(seed.status === 'completed' ? { completedAt: '2026-10-03T09:00:00Z' } : {}),
    };
  });

  const facts: Fact[] = demoFacts.map((seed) => {
    const meetingId = meetingIdOf(seed.meetingKey);
    return {
      id: seed.id,
      ...scopeOf(meetingId),
      category: seed.category,
      label: seed.label,
      value: seed.value,
      unit: seed.unit,
      speakerPersonId: seed.speakerPersonId,
      evidence: [evidence(seed.meetingKey, seed.lines)],
      capturedAt: summaryById.get(meetingId)?.occurredAt ?? DEMO_GENERATED_AT,
    };
  });

  const questions: Question[] = demoQuestions.map((seed) => {
    const meetingId = meetingIdOf(seed.meetingKey);
    return {
      id: seed.id,
      ...scopeOf(meetingId),
      topicId: seed.topicId,
      text: seed.text,
      askedByPersonId: seed.askedByPersonId,
      status: seed.status,
      raisedOn: (summaryById.get(meetingId)?.occurredAt ?? DEMO_GENERATED_AT).slice(0, 10),
      evidence: [evidence(seed.meetingKey, seed.lines)],
      ...(seed.resolution
        ? {
            resolution: {
              answer: seed.resolution.answer,
              answeredOn: seed.resolution.answeredOn,
              answeredByPersonId: seed.resolution.answeredByPersonId,
              evidence: [evidence(seed.meetingKey, seed.resolution.lines)],
            },
          }
        : {}),
    };
  });

  const ideas: Idea[] = demoIdeas.map((seed) => {
    const meetingId = meetingIdOf(seed.meetingKey);
    return {
      id: seed.id,
      ...scopeOf(meetingId),
      topicId: seed.topicId,
      text: seed.text,
      proposedByPersonId: seed.proposedByPersonId,
      status: seed.status,
      raisedOn: (summaryById.get(meetingId)?.occurredAt ?? DEMO_GENERATED_AT).slice(0, 10),
      evidence: [evidence(seed.meetingKey, seed.lines)],
    };
  });

  const commitments: Commitment[] = demoCommitments.map((seed) => {
    const meetingId = meetingIdOf(seed.meetingKey);
    return {
      id: seed.id,
      ...scopeOf(meetingId),
      text: seed.text,
      byPersonId: seed.byPersonId,
      dueDate: seed.dueDate,
      status: seed.status,
      evidence: [evidence(seed.meetingKey, seed.lines)],
    };
  });

  for (const [meetingId, topics] of Object.entries(topicsByMeeting)) {
    const linked = topics.map((topic) => ({
      ...topic,
      decisionIds: decisions
        .filter((item) => item.meetingId === meetingId && item.topicId === topic.id)
        .map((item) => item.id),
      taskIds: tasks
        .filter((item) => item.meetingId === meetingId && item.topicId === topic.id)
        .map((item) => item.id),
      questionIds: questions
        .filter((item) => item.meetingId === meetingId && item.topicId === topic.id)
        .map((item) => item.id),
      ideaIds: ideas
        .filter((item) => item.meetingId === meetingId && item.topicId === topic.id)
        .map((item) => item.id),
    }));
    topicsByMeeting[meetingId] = linked;
    transcripts[meetingId] = { ...transcripts[meetingId]!, topics: linked };
  }

  // Counts that depend on analysis artifacts are derived last, so a row can never disagree with its children.
  const isOpenTask = (task: Task) =>
    task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked';
  for (const meeting of summaries) {
    const own = <T extends { meetingId: string }>(items: T[]) =>
      items.filter((item) => item.meetingId === meeting.id);
    const meetingTasks = own(tasks);
    const meetingDecisions = own(decisions);
    const meetingQuestions = own(questions);
    const counts = {
      ...meeting.counts,
      topics: (topicsByMeeting[meeting.id] ?? []).length,
      decisions: meetingDecisions.length,
      tasks: meetingTasks.length,
      facts: own(facts).length,
      questions: meetingQuestions.length,
      ideas: own(ideas).length,
    };
    meeting.counts = counts;
    const detail = details[meeting.id]!;
    detail.counts = counts;
    detail.stats = {
      ...detail.stats,
      topics: counts.topics,
      decisions: counts.decisions,
      confirmedDecisions: meetingDecisions.filter((decision) => decision.status === 'confirmed')
        .length,
      tasks: counts.tasks,
      openTasks: meetingTasks.filter(isOpenTask).length,
      questions: counts.questions,
      openQuestions: meetingQuestions.filter((question) => question.status === 'open').length,
      facts: counts.facts,
      ideas: counts.ideas,
    };
  }

  const dataset: DemoDataset = {
    todayIsoDate: DEMO_TODAY_ISO_DATE,
    generatedAt: DEMO_GENERATED_AT,
    currentPersonId: DEMO_CURRENT_PERSON_ID,
    workspaces: [demoWorkspace],
    people: demoPeople,
    companies: demoCompanies,
    projects: demoProjects,
    meetingTypes: demoMeetingTypes,
    meetings: summaries,
    details,
    transcripts,
    topicsByMeeting,
    decisions,
    tasks,
    facts,
    questions,
    ideas,
    commitments,
    processing,
    intelligence: buildIntelligence({ meetings: summaries, facts, commitments }),
    settings: buildSettings(),
    dashboard: buildDashboard(summaries, tasks, decisions, questions, processing),
  };

  return dataset;
}

export const demoDataset = buildDemoDataset();
export const demoPersonIds = person;
