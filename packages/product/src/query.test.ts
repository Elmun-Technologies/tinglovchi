import { describe, expect, it } from 'vitest';
import {
  compareTasks,
  filterKnowledge,
  filterMeetings,
  filterTasks,
  flattenTopicTree,
  isTaskOverdue,
  matchesAnyQuery,
  normalizeText,
  processingLabel,
  resolveEvidence,
  retrieve,
  routes,
  speakingStats,
  topicTree,
} from './query';
import { formatDuration, formatTimestamp } from './domain';
import type {
  Decision,
  EvidenceRef,
  MeetingSummary,
  Task,
  Topic,
  TranscriptSegment,
} from './domain';

/**
 * Query/route helpers are the parts of the product that both adapters share, so they are tested directly
 * rather than through pages. Everything here is pure and deterministic.
 */

function meeting(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id: 'm1',
    workspaceId: 'ws1',
    title: 'Foodera — Marketing Strategy',
    companyId: 'c1',
    companyName: 'Foodera',
    projectId: 'p1',
    projectName: 'Growth Sprint Q4',
    meetingTypeId: 'mt1',
    meetingTypeKey: 'marketing',
    meetingTypeLabel: 'Marketing',
    occurredAt: '2026-10-06T09:30:00Z',
    durationMs: 3_840_000,
    capturedMs: 3_700_000,
    state: 'ready',
    languages: ['uz'],
    participants: [
      {
        personId: 'per1',
        name: 'Akmal Rahimov',
        initials: 'AR',
        kind: 'internal',
        mapped: true,
        spokeInMeeting: true,
      },
    ],
    origin: 'desktop',
    recordingAvailable: true,
    counts: { topics: 4, decisions: 6, tasks: 6, facts: 9, questions: 2, ideas: 2, segments: 59 },
    ...overrides,
  } as MeetingSummary;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    // Explicit statuses: the buckets below depend on them, not on zod defaults.
    workspaceId: 'ws1',
    meetingId: 'm1',
    companyId: 'c1',
    projectId: 'p1',
    topicId: null,
    title: 'Ship the shortened lead form',
    ownerPersonId: 'per1',
    ownerLabel: 'Akmal Rahimov',
    dueDate: '2026-10-09',
    status: 'open',
    priority: 'high',
    evidence: [],
    createdAt: '2026-10-06T09:30:00Z',
    ...overrides,
  } as Task;
}

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg_001',
    meetingId: 'm1',
    index: 1,
    speakerPersonId: 'per1',
    speakerLabel: 'Speaker A',
    startMs: 1_000,
    endMs: 4_000,
    text: 'Targetni kengaytirishdan oldin funnelni tekshiramiz.',
    language: 'uz',
    topicId: null,
    ...overrides,
  } as TranscriptSegment;
}

function evidence(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    meetingId: 'm1',
    meetingTitle: 'Foodera — Marketing Strategy',
    occurredAt: '2026-10-06T09:30:00Z',
    startMs: 1_000,
    endMs: 4_000,
    segmentIds: ['seg_001'],
    speakerPersonIds: ['per1'],
    quote: 'Targetni kengaytirishdan oldin funnelni tekshiramiz.',
    ...overrides,
  } as EvidenceRef;
}

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'top1',
    workspaceId: 'ws1',
    meetingId: 'm1',
    parentId: null,
    title: 'Marketing',
    summary: 'Performance and the quality-first plan.',
    keywords: ['lead quality'],
    startMs: 0,
    endMs: 60_000,
    participantPersonIds: ['per1'],
    segmentIds: ['seg_001'],
    decisionIds: [],
    taskIds: [],
    questionIds: [],
    ideaIds: [],
    ...overrides,
  } as Topic;
}

describe('text normalization for a mixed-language corpus', () => {
  it('treats the Latin Uzbek apostrophe variants as equivalent', () => {
    expect(normalizeText('Bo‘laymiz')).toBe(normalizeText("Bo'laymiz"));
    expect(normalizeText('O‘')).toBe(normalizeText("O'"));
  });

  it('matches case-insensitively across languages and strips punctuation noise', () => {
    expect(matchesAnyQuery(['Foodera — Marketing Strategy'], 'marketing')).toBe(true);
    expect(matchesAnyQuery(['Мы сократили форму'], 'сократили')).toBe(true);
    expect(matchesAnyQuery([undefined, 'x'], 'y')).toBe(false);
    expect(matchesAnyQuery(['anything'], '   ')).toBe(true);
  });
});

describe('meeting filtering', () => {
  const meetings = [
    meeting(),
    meeting({
      id: 'm2',
      title: 'Nomad Education — Q3 pipeline review',
      companyId: 'c2',
      companyName: 'Nomad Education',
      projectId: 'p2',
      meetingTypeId: 'mt2',
      meetingTypeKey: 'sales',
      meetingTypeLabel: 'Sales review',
      occurredAt: '2026-09-02T16:30:00Z',
      state: 'failed',
      participants: [
        {
          personId: 'per2',
          name: 'Alexey Petrov',
          initials: 'AP',
          kind: 'client',
          mapped: true,
          spokeInMeeting: true,
        },
      ],
    }),
  ];

  it('searches title, company and project', () => {
    expect(filterMeetings(meetings, { query: 'foodera' })[0]?.id).toBe('m1');
    expect(filterMeetings(meetings, { query: 'nomad' })[0]?.id).toBe('m2');
    // Participant names are searchable too: "Akmal" finds the meeting he spoke in.
    expect(filterMeetings(meetings, { query: 'akmal' })[0]?.id).toBe('m1');
    expect(filterMeetings(meetings, { query: 'nothing here' })).toEqual([]);
  });

  it('filters by company, type, participant, state and date range', () => {
    expect(filterMeetings(meetings, { companyId: 'c2' }).map((item) => item.id)).toEqual(['m2']);
    expect(filterMeetings(meetings, { meetingTypeId: 'mt2' })[0]?.id).toBe('m2');
    expect(filterMeetings(meetings, { participantId: 'per1' }).map((item) => item.id)).toEqual([
      'm1',
    ]);
    expect(filterMeetings(meetings, { state: 'failed' })[0]?.id).toBe('m2');
    expect(filterMeetings(meetings, { from: '2026-10-01' }).map((item) => item.id)).toEqual(['m1']);
    expect(filterMeetings(meetings, { to: '2026-09-30' }).map((item) => item.id)).toEqual(['m2']);
  });

  it('sorts newest first with no filter', () => {
    expect(filterMeetings(meetings, undefined).map((item) => item.id)).toEqual(['m1', 'm2']);
  });
});

describe('task buckets and ordering', () => {
  const today = '2026-10-06';
  const tasks = [
    task({ id: 'overdue', dueDate: '2026-10-01', status: 'open' }),
    task({ id: 'open', dueDate: '2026-10-20', status: 'in_progress' }),
    task({
      id: 'mine',
      dueDate: '2026-10-09',
      status: 'open',
      ownerPersonId: 'me',
      ownerLabel: 'Me',
    }),
    task({
      id: 'done',
      dueDate: '2026-10-02',
      status: 'completed',
      completedAt: '2026-10-03T09:00:00Z',
    }),
    task({ id: 'no-deadline', dueDate: null, status: 'blocked' }),
  ];

  it('classifies overdue only for unfinished work', () => {
    expect(isTaskOverdue(tasks[0]!, today)).toBe(true);
    expect(isTaskOverdue(tasks[3]!, today)).toBe(false);
    expect(isTaskOverdue(tasks[4]!, today)).toBe(false);
  });

  it('slices by bucket', () => {
    expect(
      filterTasks(
        tasks,
        { bucket: 'open', query: '' },
        { currentPersonId: 'me', todayIsoDate: today },
      ).map((item) => item.id),
    ).toEqual(['overdue', 'mine', 'open', 'no-deadline']);
    expect(
      filterTasks(
        tasks,
        { bucket: 'mine', query: '' },
        { currentPersonId: 'me', todayIsoDate: today },
      ).map((item) => item.id),
    ).toEqual(['mine']);
    expect(
      filterTasks(
        tasks,
        { bucket: 'overdue', query: '' },
        { currentPersonId: 'me', todayIsoDate: today },
      ).map((item) => item.id),
    ).toEqual(['overdue']);
    expect(
      filterTasks(
        tasks,
        { bucket: 'completed', query: '' },
        { currentPersonId: null, todayIsoDate: today },
      ).map((item) => item.id),
    ).toEqual(['done']);
  });

  it('never drops the unassigned owner out of the list', () => {
    const orphan = task({ id: 'orphan', ownerPersonId: null, ownerLabel: 'Unassigned' });
    const result = filterTasks(
      [...tasks, orphan],
      { bucket: 'all', query: '' },
      { currentPersonId: 'me', todayIsoDate: today },
    );
    expect(result.map((item) => item.id)).toContain('orphan');
  });

  it('orders overdue first, then by deadline, with completed at the end', () => {
    const ordered = [...tasks].sort(compareTasks(today));
    expect(ordered.map((item) => item.id)).toEqual([
      'overdue',
      'mine',
      'open',
      'no-deadline',
      'done',
    ]);
  });
});

describe('knowledge filtering', () => {
  const entries = [
    {
      kind: 'decision' as const,
      id: 'd1',
      workspaceId: 'ws1',
      meetingId: 'm1',
      companyId: 'c1',
      projectId: 'p1',
      title: 'Budget held',
      body: 'October stays at $5,000.',
      at: '2026-10-06T09:30:00Z',
      personIds: ['per1'],
      tags: ['confirmed'],
      statusLabel: 'confirmed',
      evidence: [],
    },
    {
      kind: 'fact' as const,
      id: 'f1',
      workspaceId: 'ws1',
      meetingId: 'm2',
      companyId: 'c2',
      projectId: null,
      title: 'Conversion',
      body: '57%',
      at: '2026-09-02T16:30:00Z',
      personIds: ['per2'],
      tags: ['metric'],
      statusLabel: 'metric',
      evidence: [],
    },
  ];

  it('filters by kind, company, person, range and query', () => {
    expect(
      filterKnowledge(entries, { kinds: ['decision'], query: '' }).map((item) => item.id),
    ).toEqual(['d1']);
    expect(
      filterKnowledge(entries, { kinds: [], companyId: 'c2', query: '' }).map((item) => item.id),
    ).toEqual(['f1']);
    expect(
      filterKnowledge(entries, { kinds: [], participantId: 'per1', query: '' }).map(
        (item) => item.id,
      ),
    ).toEqual(['d1']);
    expect(
      filterKnowledge(entries, { kinds: [], from: '2026-10-01', query: '' }).map((item) => item.id),
    ).toEqual(['d1']);
    expect(filterKnowledge(entries, { kinds: [], query: 'budget' }).map((item) => item.id)).toEqual(
      ['d1'],
    );
    expect(
      filterKnowledge(entries, { kinds: ['decision', 'fact'], query: '' }).map((item) => item.id),
    ).toEqual(['d1', 'f1']);
  });
});

describe('topic tree', () => {
  it('nests children and keeps document order, flattening depth-first', () => {
    const nodes = topicTree([
      topic({ id: 'root', title: 'Marketing', segmentIds: ['a', 'b', 'c'] }),
      topic({
        id: 'child2',
        parentId: 'root',
        title: 'Creatives',
        startMs: 40_000,
        endMs: 60_000,
        segmentIds: ['c'],
      }),
      topic({
        id: 'child1',
        parentId: 'root',
        title: 'Meta Ads',
        startMs: 0,
        endMs: 20_000,
        segmentIds: ['a', 'b'],
      }),
    ]);
    expect(nodes.map((node) => node.title)).toEqual(['Marketing']);
    expect(nodes[0]!.children.map((child) => child.title)).toEqual(['Meta Ads', 'Creatives']);
    expect(nodes[0]!.depth).toBe(0);
    expect(nodes[0]!.children[1]!.depth).toBe(1);
    expect(flattenTopicTree(nodes).map((node) => node.id)).toEqual(['root', 'child1', 'child2']);
  });

  it('attaches orphaned topics at the root instead of dropping them', () => {
    const nodes = topicTree([topic({ id: 'x', parentId: 'missing' })]);
    expect(nodes.map((node) => node.id)).toEqual(['x']);
  });
});

describe('speaker statistics', () => {
  it('groups unmapped labels separately and shares sum to one', () => {
    const stats = speakingStats([
      segment({ id: 'a', speakerPersonId: 'per1', startMs: 0, endMs: 3_000 }),
      segment({
        id: 'b',
        speakerPersonId: null,
        speakerLabel: 'Speaker C',
        startMs: 4_000,
        endMs: 8_000,
      }),
      segment({ id: 'c', speakerPersonId: 'per1', startMs: 9_000, endMs: 11_000 }),
    ]);
    expect(stats.map((item) => item.personId)).toEqual(['per1', null]);
    expect(stats[0]!.words).toBeGreaterThan(0);
    expect(stats.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1, 6);
  });
});

describe('evidence resolution', () => {
  it('resolves cited segments and reports the ones that do not exist', () => {
    const segments = [
      segment({ id: 'seg_001' }),
      segment({ id: 'seg_002', startMs: 5_000, endMs: 8_000 }),
    ];
    const result = resolveEvidence(
      evidence({ segmentIds: ['seg_001', 'seg_002'] }),
      segments,
      'm1',
    );
    expect(result.resolved.map((item) => item.id)).toEqual(['seg_001', 'seg_002']);
    expect(result.missingSegmentIds).toEqual([]);
    expect(result.crossMeeting).toBe(false);
  });

  it('never silently hides a dangling citation', () => {
    const result = resolveEvidence(
      evidence({ segmentIds: ['seg_001', 'seg_999'] }),
      [segment()],
      'm1',
    );
    expect(result.missingSegmentIds).toEqual(['seg_999']);
  });

  it('flags evidence that points at another meeting', () => {
    const result = resolveEvidence(evidence({ meetingId: 'other' }), [segment()], 'm1');
    expect(result.crossMeeting).toBe(true);
  });
});

describe('processing label', () => {
  it('counts steps instead of inventing a percentage', () => {
    const label = processingLabel({
      meetingId: 'm1',
      state: 'analyzing',
      steps: [
        { state: 'done', key: 'a', label: 'Captured' },
        { state: 'done', key: 'b', label: 'Uploaded' },
        { state: 'active', key: 'c', label: 'Analyzing' },
        { state: 'pending', key: 'd', label: 'Indexing' },
      ],
    });
    expect(label).toBe('Step 3 of 4 · Analyzing');
    expect(label).not.toMatch('%');
  });
});

describe('route builders', () => {
  it('constructs every product route from one place', () => {
    expect(routes.home({ workspaceId: 'ws' })).toBe('/w/ws');
    expect(routes.meetings({ workspaceId: 'ws' })).toBe('/w/ws/meetings');
    expect(routes.newMeeting({ workspaceId: 'ws' })).toBe('/w/ws/meetings/new');
    expect(routes.meeting({ workspaceId: 'ws', meetingId: 'm' })).toBe('/w/ws/meetings/m');
    expect(routes.meetingTab({ workspaceId: 'ws', meetingId: 'm', tab: 'transcript' })).toBe(
      '/w/ws/meetings/m/transcript',
    );
    expect(routes.company({ workspaceId: 'ws', companyId: 'c' })).toBe('/w/ws/companies/c');
    expect(routes.company({ workspaceId: 'ws', companyId: 'c', tab: 'overview' })).toBe(
      '/w/ws/companies/c',
    );
    expect(routes.company({ workspaceId: 'ws', companyId: 'c', tab: 'tasks' })).toBe(
      '/w/ws/companies/c/tasks',
    );
    expect(routes.project({ workspaceId: 'ws', projectId: 'p', tab: 'knowledge' })).toBe(
      '/w/ws/projects/p/knowledge',
    );
    expect(routes.tasks({ workspaceId: 'ws' }, { bucket: 'overdue' })).toBe(
      '/w/ws/tasks?bucket=overdue',
    );
    expect(routes.settings({ workspaceId: 'ws' })).toBe('/w/ws/settings');
    expect(routes.settings({ workspaceId: 'ws' }, 'integrations')).toBe(
      '/w/ws/settings?section=integrations',
    );
    expect(routes.search({ workspaceId: 'ws' }, '')).toBe('/w/ws/search');
  });

  it('deep-links a transcript segment with its timestamp for scroll-and-highlight', () => {
    expect(
      routes.evidence({
        workspaceId: 'ws',
        meetingId: 'm',
        segmentId: 'seg_42',
        startMs: 2_538_000,
      }),
    ).toBe('/w/ws/meetings/m/transcript?seg=seg_42&t=2538000#seg_42');
    expect(routes.evidence({ workspaceId: 'ws', meetingId: 'm', segmentId: 'seg_42' })).toBe(
      '/w/ws/meetings/m/transcript?seg=seg_42#seg_42',
    );
  });

  it('omits empty params instead of emitting ?x=', () => {
    expect(routes.tasks({ workspaceId: 'ws' }, { bucket: '', company: 'c1' })).toBe(
      '/w/ws/tasks?company=c1',
    );
  });
});

describe('deterministic retrieval', () => {
  const items = [
    {
      id: 'decision:a',
      kind: 'decision',
      title: 'October budget stays at $5,000',
      body: 'no expansion this month',
      meetingId: 'm1',
      tags: ['confirmed'],
    },
    {
      id: 'task:b',
      kind: 'task',
      title: 'Rewrite six UGC scripts',
      body: 'by 15 October',
      meetingId: 'm1',
      tags: ['open'],
    },
    {
      id: 'fact:c',
      kind: 'fact',
      title: 'Monthly media budget',
      body: '5,000 USD',
      meetingId: 'm1',
      tags: ['budget'],
    },
  ];

  it('ranks by distinct token overlap with a title weight', () => {
    const result = retrieve('budget', items);
    // `budget` is in fact:c's title *and* tags, so it outranks decision:a — the tag weight is what this pins.
    expect(result.map((entry) => entry.item.id)).toEqual(['fact:c', 'decision:a']);
    expect(result[0]!.score).toBeGreaterThanOrEqual(result[1]!.score);
  });

  it('ignores stopword-only questions', () => {
    expect(retrieve('what is the', items)).toEqual([]);
  });

  it('is stable for equal scores by id, not by input order', () => {
    const first = retrieve('budget', items).map((entry) => entry.item.id);
    const second = retrieve('budget', [...items].reverse()).map((entry) => entry.item.id);
    expect(first).toEqual(second);
  });

  it('caps results at the limit', () => {
    expect(retrieve('budget month', items, { limit: 1 })).toHaveLength(1);
  });
});

describe('time formatting', () => {
  it('uses HH:MM:SS past one hour and MM:SS before', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(42 * 60_000 + 18_000)).toBe('42:18');
    expect(formatTimestamp(3_738_000)).toBe('01:02:18');
    expect(formatTimestamp(-1)).toBe('00:00');
  });

  it('formats durations compactly', () => {
    expect(formatDuration(2_520_000)).toBe('42m');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatDuration(0)).toBe('0m');
  });
});

describe('decision status vocabulary', () => {
  it('keeps superseded decisions pointing at their replacement, validated by the demo dataset', async () => {
    const { demoDataset } = await import('./demo/dataset');
    const superseded = demoDataset.decisions.filter(
      (decision: Decision) => decision.status === 'superseded',
    );
    expect(superseded.length).toBeGreaterThan(0);
    for (const decision of superseded) {
      const replacement = demoDataset.decisions.find(
        (item) => item.id === decision.supersededByDecisionId,
      );
      expect(replacement?.status).toBe('confirmed');
    }
    expect(
      demoDataset.decisions.some((decision: Decision) => decision.status === 'tentative'),
    ).toBe(true);
    expect(demoDataset.decisions.some((decision: Decision) => decision.status === 'proposed')).toBe(
      true,
    );
    expect(demoDataset.decisions.some((decision: Decision) => decision.status === 'rejected')).toBe(
      true,
    );
    expect(
      demoDataset.decisions.some((decision: Decision) => decision.status === 'confirmed'),
    ).toBe(true);
  });
});
