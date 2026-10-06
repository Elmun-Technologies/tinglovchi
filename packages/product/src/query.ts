import type {
  EvidenceRef,
  KnowledgeEntry,
  KnowledgeFilter,
  MeetingFilter,
  MeetingSummary,
  ProcessingTimeline,
  Task,
  TaskFilter,
  Topic,
  TranscriptSegment,
  TranscriptWindow,
  TranscriptWindowRead,
  TranscriptWindowRequest,
} from './domain';
import { transcriptWindowRequestSchema } from './domain';

/**
 * Pure query helpers shared by adapters, pages and tests.
 *
 * Two rules matter here: (1) no I/O and no framework imports, so the same logic is testable in Node and
 * reusable by any future adapter; (2) text matching is normalization-based rather than locale-magic, because
 * this product's corpus is mixed Uzbek/Russian/English and the Latin Uzbek apostrophe (`ʻ`, `’`) otherwise
 * breaks naive comparisons.
 */

const APOSTROPHE_VARIANTS = /[ʻʼ’‘`\u0027]/g;

export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(APOSTROPHE_VARIANTS, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.:%$/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  // en
  'the',
  'and',
  'for',
  'with',
  'what',
  'when',
  'who',
  'did',
  'have',
  'has',
  'are',
  'was',
  'were',
  'about',
  'that',
  'this',
  'from',
  'will',
  'any',
  'get',
  'got',
  // uz
  'haqida',
  'qanday',
  'nima',
  'kim',
  'qachon',
  'bilan',
  'uchun',
  'bo',
  'lti',
  'edi',
  'bu',
  'shu',
  'qoldi',
  'qolgan',
  'oyirgi',
  'oxirgi',
  'barcha',
  'ham',
  // ru
  'что',
  'как',
  'кто',
  'когда',
  'по',
  'для',
  'из',
  'или',
  'это',
  'было',
  'есть',
  'какие',
  'какой',
  'были',
  'нас',
  'всего',
]);

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.replace(/^[.\-:%$]+|[.\-:%$]+$/g, ''))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function matchesAnyQuery(fields: (string | undefined | null)[], query: string): boolean {
  const needle = normalizeText(query);
  if (!needle) return true;
  return fields.some((field) => (field ? normalizeText(field).includes(needle) : false));
}

/** Day key for date-range comparisons; demo fixtures are authored with explicit dates. */
export function dayKeyOf(isoDateTime: string): string {
  return isoDateTime.slice(0, 10);
}

function withinRange(day: string, from?: string, to?: string): boolean {
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

export function filterMeetings(
  meetings: MeetingSummary[],
  filter: MeetingFilter | undefined,
): MeetingSummary[] {
  if (!filter) return sortMeetingsDesc(meetings);
  // `query` is optional at runtime: zod applies the empty-string default only when the filter is parsed.
  const query = (filter.query ?? '').trim();
  const filtered = meetings.filter((meeting) => {
    // Meeting search covers who was in the room, so "Akmal" finds the meeting Akmal spoke in. Deeper
    // transcript/record search belongs to global search, not to this table.
    if (
      query &&
      !matchesAnyQuery(
        [meeting.title, meeting.companyName, meeting.projectName, meeting.meetingTypeLabel],
        query,
      ) &&
      !meeting.participants.some((participant) => matchesAnyQuery([participant.name], query))
    ) {
      return false;
    }
    if (filter.companyId && meeting.companyId !== filter.companyId) return false;
    if (filter.projectId && meeting.projectId !== filter.projectId) return false;
    if (filter.meetingTypeId && meeting.meetingTypeId !== filter.meetingTypeId) return false;
    if (filter.state && meeting.state !== filter.state) return false;
    if (
      filter.participantId &&
      !meeting.participants.some((p) => p.personId === filter.participantId)
    ) {
      return false;
    }
    return withinRange(dayKeyOf(meeting.occurredAt), filter.from, filter.to);
  });
  return sortMeetingsDesc(filtered);
}

export function sortMeetingsDesc(meetings: MeetingSummary[]): MeetingSummary[] {
  return [...meetings].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

export function isTaskOverdue(task: Task, todayIsoDate: string): boolean {
  if (task.status === 'completed' || task.status === 'cancelled') return false;
  if (!task.dueDate) return false;
  return task.dueDate < todayIsoDate;
}

export function taskIsOpen(task: Task): boolean {
  return task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked';
}

export function filterTasks(
  tasks: Task[],
  filter: TaskFilter | undefined,
  context: { currentPersonId: string | null; todayIsoDate: string },
): Task[] {
  const bucket = filter?.bucket ?? 'all';
  const query = filter?.query?.trim() ?? '';
  const result = tasks.filter((task) => {
    if (query && !matchesAnyQuery([task.title, task.detail, task.ownerLabel], query)) return false;
    if (filter?.companyId && task.companyId !== filter.companyId) return false;
    if (filter?.projectId && task.projectId !== filter.projectId) return false;
    if (filter?.personId && task.ownerPersonId !== filter.personId) return false;
    switch (bucket) {
      case 'mine':
        return task.ownerPersonId !== null && task.ownerPersonId === context.currentPersonId;
      case 'open':
        return taskIsOpen(task);
      case 'overdue':
        return isTaskOverdue(task, context.todayIsoDate);
      case 'completed':
        return task.status === 'completed';
      case 'all':
        return true;
    }
  });
  return result.sort(compareTasks(context.todayIsoDate));
}

/** Overdue first, then nearest deadline, then created order. Completed items sink to the bottom. */
export function compareTasks(todayIsoDate: string) {
  return (left: Task, right: Task): number => {
    const rank = (task: Task): number => {
      if (task.status === 'completed' || task.status === 'cancelled') return 3;
      if (isTaskOverdue(task, todayIsoDate)) return 0;
      return 1;
    };
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftDue = left.dueDate ?? '9999-12-31';
    const rightDue = right.dueDate ?? '9999-12-31';
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    return left.createdAt.localeCompare(right.createdAt);
  };
}

export function filterKnowledge(
  entries: KnowledgeEntry[],
  filter: KnowledgeFilter,
): KnowledgeEntry[] {
  const query = (filter.query ?? '').trim();
  const kinds = filter.kinds ?? [];
  return entries
    .filter((entry) => {
      if (kinds.length > 0 && !kinds.includes(entry.kind)) return false;
      if (filter.companyId && entry.companyId !== filter.companyId) return false;
      if (filter.projectId && entry.projectId !== filter.projectId) return false;
      if (filter.participantId && !entry.personIds.includes(filter.participantId)) return false;
      if (!withinRange(dayKeyOf(entry.at), filter.from, filter.to)) return false;
      return query ? matchesAnyQuery([entry.title, entry.body, ...entry.tags], query) : true;
    })
    .sort((left, right) => right.at.localeCompare(left.at));
}

export type TopicNode = Topic & { children: TopicNode[]; depth: number };

/** Builds the sectioned topic hierarchy. Parent order is preserved; orphans are attached at the root. */
export function topicTree(topics: Topic[]): TopicNode[] {
  const byId = new Map(
    topics.map((topic) => [topic.id, { ...topic, children: [] as TopicNode[], depth: 0 }]),
  );
  const roots: TopicNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const assignDepth = (nodes: TopicNode[], depth: number): void => {
    for (const node of nodes) {
      node.depth = depth;
      node.children.sort((left, right) => left.startMs - right.startMs);
      assignDepth(node.children, depth + 1);
    }
  };
  roots.sort((left, right) => left.startMs - right.startMs);
  assignDepth(roots, 0);
  return roots;
}

export function flattenTopicTree(nodes: TopicNode[]): TopicNode[] {
  const out: TopicNode[] = [];
  const walk = (list: TopicNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export type SpeakerStat = {
  /** `null` for a diarization label that nobody has mapped to a person yet. */
  personId: string | null;
  label: string;
  segments: number;
  words: number;
  spokenMs: number;
  share: number;
};

export function speakingStats(segments: TranscriptSegment[]): SpeakerStat[] {
  const stats = new Map<string, SpeakerStat>();
  const total = segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0);
  for (const segment of segments) {
    const key = segment.speakerPersonId ?? `label:${segment.speakerLabel}`;
    const entry = stats.get(key) ?? {
      personId: segment.speakerPersonId,
      label: segment.speakerLabel,
      segments: 0,
      words: 0,
      spokenMs: 0,
      share: 0,
    };
    entry.segments += 1;
    entry.words += segment.text.trim().split(/\s+/).filter(Boolean).length;
    entry.spokenMs += segment.endMs - segment.startMs;
    stats.set(key, entry);
  }
  const list = [...stats.values()].map((entry) => ({
    ...entry,
    share: total > 0 ? entry.spokenMs / total : 0,
  }));
  return list.sort((left, right) => right.spokenMs - left.spokenMs);
}

export type EvidenceResolution = {
  /** Segments that exist and belong to the evidence's meeting, in the order cited. */
  resolved: TranscriptSegment[];
  /** Cited ids that do not resolve — the UI must surface these rather than hide them. */
  missingSegmentIds: string[];
  /** Set when the evidence points at a different meeting than the one it is rendered in. */
  crossMeeting: boolean;
};

export function resolveEvidence(
  evidence: EvidenceRef,
  availableSegments: TranscriptSegment[],
  currentMeetingId?: string,
): EvidenceResolution {
  const byId = new Map(availableSegments.map((segment) => [segment.id, segment]));
  const resolved: TranscriptSegment[] = [];
  const missingSegmentIds: string[] = [];
  for (const segmentId of evidence.segmentIds) {
    const segment = byId.get(segmentId);
    if (segment) resolved.push(segment);
    else missingSegmentIds.push(segmentId);
  }
  return {
    resolved,
    missingSegmentIds,
    crossMeeting: currentMeetingId !== undefined && evidence.meetingId !== currentMeetingId,
  };
}

/** Step counter for processing UI. Deliberately a count of steps, never a fabricated percentage. */
export function processingLabel(timeline: ProcessingTimeline): string {
  const done = timeline.steps.filter((step) => step.state === 'done').length;
  const active = timeline.steps.find((step) => step.state === 'active' || step.state === 'failed');
  const suffix = active ? ` · ${active.label}` : '';
  return `Step ${Math.min(done + 1, timeline.steps.length)} of ${timeline.steps.length}${suffix}`;
}

/* ------------------------------------------------------------------ *
 * Route builders. Kept here so navigation is one contract, tested in
 * `packages/product/src/query.test.ts` and reused by search hits, evidence links and the sidebar.
 * ------------------------------------------------------------------ */

export type RouteInput = { workspaceId: string };

export const routes = {
  home: ({ workspaceId }: RouteInput) => `/w/${workspaceId}`,
  meetings: ({ workspaceId }: RouteInput) => `/w/${workspaceId}/meetings`,
  newMeeting: ({ workspaceId }: RouteInput) => `/w/${workspaceId}/meetings/new`,
  meeting: ({ workspaceId, meetingId }: RouteInput & { meetingId: string }) =>
    `/w/${workspaceId}/meetings/${meetingId}`,
  meetingTab: (
    input: RouteInput & { meetingId: string; tab: MeetingTab },
    params?: Record<string, string | number | undefined>,
  ) => withQuery(`/w/${input.workspaceId}/meetings/${input.meetingId}/${input.tab}`, params),
  transcript: (input: RouteInput & { meetingId: string }) =>
    `/w/${input.workspaceId}/meetings/${input.meetingId}/transcript`,
  /**
   * Deep link into a transcript line. The fragment is what makes the browser scroll and let `:target`
   * highlight the line with no JS at all; `seg` keeps the same information available to a server component
   * that needs to render the row as active, and `t` is the playback position the line starts at.
   */
  evidence: (input: RouteInput & { meetingId: string; segmentId: string; startMs?: number }) =>
    `${withQuery(
      `/w/${input.workspaceId}/meetings/${input.meetingId}/transcript`,
      startMsParams(input.segmentId, input.startMs),
    )}#${input.segmentId}`,
  /**
   * Create and edit forms are real routes, so a half-finished form has a URL, a back button and a reload that
   * works. They are separate from list pages on purpose: a form is not a filter state.
   */
  newCompany: ({ workspaceId }: RouteInput) => `/w/${workspaceId}/companies/new`,
  editCompany: ({ workspaceId, companyId }: RouteInput & { companyId: string }) =>
    `/w/${workspaceId}/companies/${companyId}/edit`,
  newProject: ({ workspaceId }: RouteInput, params?: Record<string, string | undefined>) =>
    withQuery(`/w/${workspaceId}/projects/new`, params),
  editProject: ({ workspaceId, projectId }: RouteInput & { projectId: string }) =>
    `/w/${workspaceId}/projects/${projectId}/edit`,
  editMeeting: ({ workspaceId, meetingId }: RouteInput & { meetingId: string }) =>
    `/w/${workspaceId}/meetings/${meetingId}/edit`,
  companies: ({ workspaceId }: RouteInput) => `/w/${workspaceId}/companies`,
  company: (input: RouteInput & { companyId: string; tab?: string }) =>
    withQuery(
      `/w/${input.workspaceId}/companies/${input.companyId}${input.tab && input.tab !== 'overview' ? `/${input.tab}` : ''}`,
    ),
  projects: ({ workspaceId }: RouteInput) => workspaceProjectsPath(workspaceId),
  project: (input: RouteInput & { projectId: string; tab?: ProjectTab }) =>
    withQuery(
      `/w/${input.workspaceId}/projects/${input.projectId}${input.tab && input.tab !== 'overview' ? `/${input.tab}` : ''}`,
    ),
  tasks: ({ workspaceId }: RouteInput, params?: Record<string, string | undefined>) =>
    withQuery(`/w/${workspaceId}/tasks`, params),
  knowledge: ({ workspaceId }: RouteInput, params?: Record<string, string | undefined>) =>
    withQuery(`/w/${workspaceId}/knowledge`, params),
  ask: ({ workspaceId }: RouteInput, params?: Record<string, string | undefined>) =>
    withQuery(`/w/${workspaceId}/ask`, params),
  settings: ({ workspaceId }: RouteInput, section?: string) =>
    withQuery(`/w/${workspaceId}/settings`, section ? { section } : undefined),
  search: ({ workspaceId }: RouteInput, query: string) =>
    withQuery(`/w/${workspaceId}/search`, query ? { q: query } : undefined),
  /**
   * Export and print live outside the meeting subtree so a download is a resource of its own: it can be
   * opened in a new tab, linked, and (later) protected separately from the app shell.
   */
  exportMeeting: (
    input: RouteInput & { meetingId: string; format?: 'md' | 'txt' | 'csv' | 'json' },
  ) =>
    withQuery(`/w/${input.workspaceId}/exports/meeting/${input.meetingId}`, {
      format: input.format,
    }),
  printMeeting: ({ workspaceId, meetingId }: RouteInput & { meetingId: string }) =>
    `/w/${workspaceId}/print/meeting/${meetingId}`,
} as const;

function startMsParams(segmentId: string, startMs: number | undefined): Record<string, string> {
  const params: Record<string, string> = { seg: segmentId };
  if (typeof startMs === 'number' && Number.isFinite(startMs))
    params.t = String(Math.floor(startMs));
  return params;
}

function withQuery(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** Meeting-detail tabs. Route-safe: each tab is a real sub-route, not component state. */
export const meetingTabs = [
  'overview',
  'topics',
  'transcript',
  'decisions',
  'tasks',
  'facts',
  'questions',
  'ideas',
] as const;
export type MeetingTab = (typeof meetingTabs)[number];

/** Company-detail tabs. */
export const companyTabs = [
  'overview',
  'meetings',
  'projects',
  'tasks',
  'decisions',
  'knowledge',
] as const;
export type CompanyTab = (typeof companyTabs)[number];

export const projectTabs = ['overview', 'meetings', 'decisions', 'tasks', 'knowledge'] as const;
export type ProjectTab = (typeof projectTabs)[number];

/* ------------------------------------------------------------------ *
 * Deterministic retrieval used by the demo Ask AI adapter.
 * ------------------------------------------------------------------ */

export type Retrievable = {
  id: string;
  /** Entity kind, surfaced to the UI so a citation says what it is. */
  kind: string;
  title: string;
  body: string;
  meetingId: string;
  tags?: string[];
};

export type Retrieved = { item: Retrievable; score: number; matchedTokens: string[] };

/**
 * Scores fixtures by distinct-token overlap with the question, weighting title and tag matches. It is
 * deterministic on purpose: identical input always produces identical output, so a UI change cannot
 * silently alter demo answers and the tests can pin citations exactly.
 */
export function retrieve(
  question: string,
  items: Retrievable[],
  options: { limit?: number; titleWeight?: number; tagWeight?: number } = {},
): Retrieved[] {
  const limit = options.limit ?? 5;
  const titleWeight = options.titleWeight ?? 2;
  const tagWeight = options.tagWeight ?? 1;
  const questionTokens = [...new Set(tokenize(question))];
  if (questionTokens.length === 0) return [];
  const scored = items.map((item) => {
    const titleTokens = new Set(tokenize(item.title));
    const bodyTokens = new Set(tokenize(item.body));
    const tagTokens = new Set((item.tags ?? []).flatMap((tag) => tokenize(tag)));
    const matched: string[] = [];
    let score = 0;
    for (const token of questionTokens) {
      let hit = 0;
      if (titleTokens.has(token)) hit += titleWeight;
      if (tagTokens.has(token)) hit += tagWeight;
      if (bodyTokens.has(token)) hit += 1;
      if (hit > 0) {
        matched.push(token);
        score += hit;
      }
    }
    return { item, score, matchedTokens: matched };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .slice(0, limit);
}

/** `routes.projects` helper kept separate to avoid a typo-prone template above. */
function workspaceProjectsPath(workspaceId: string): string {
  return `/w/${workspaceId}/projects`;
}

export { workspaceProjectsPath };

/**
 * Transcript windowing.
 *
 * A page asks for a window of a filtered list, and the filter and the paging are resolved in one place, so a
 * search result count and the pager cannot drift apart. `focusSegmentId` shifts the window to contain a cited
 * line, which is what makes an evidence deep link work against a 3-hour meeting without shipping the whole
 * transcript to the browser.
 */
export const transcriptWindowSpans = [60, 120, 300] as const;
export const defaultTranscriptSpan = 120;

export function filterTranscriptSegments(
  segments: TranscriptSegment[],
  filter: { query?: string; speaker?: string; topicId?: string },
): TranscriptSegment[] {
  const needle = normalizeText(filter.query ?? '');
  const speaker = filter.speaker ?? '';
  const topicId = filter.topicId ?? '';
  if (!needle && !speaker && !topicId) return segments;
  return segments.filter((segment) => {
    if (
      speaker &&
      segment.speakerPersonId !== speaker &&
      `label:${segment.speakerLabel}` !== speaker
    )
      return false;
    if (topicId && segment.topicId !== topicId) return false;
    if (needle && !normalizeText(segment.text).includes(needle)) return false;
    return true;
  });
}

/** Normalizes a partial request: clamped span, aligned offset, unknown focus id tolerated (no crash). */
/** Normalizes a partial request: clamped span, aligned offset, unknown focus id tolerated (no crash). */
export function readTranscriptWindowRequest(
  raw: Partial<TranscriptWindowRequest> | undefined,
): TranscriptWindowRead {
  const parsed = transcriptWindowRequestSchema.safeParse({
    meetingId: raw?.meetingId ?? '',
    offset: raw?.offset ?? 0,
    span: raw?.span ?? defaultTranscriptSpan,
    query: raw?.query ?? '',
    ...(raw?.speaker ? { speaker: raw.speaker } : {}),
    ...(raw?.topicId ? { topicId: raw.topicId } : {}),
    ...(raw?.focusSegmentId ? { focusSegmentId: raw.focusSegmentId } : {}),
  });
  if (parsed.success) return parsed.data;
  // A malformed paging value must not break a transcript; fall back to the default window.
  return {
    meetingId: raw?.meetingId ?? '',
    offset: 0,
    span: defaultTranscriptSpan,
    query: raw?.query ?? '',
    ...(raw?.speaker ? { speaker: raw.speaker } : {}),
    ...(raw?.topicId ? { topicId: raw.topicId } : {}),
    ...(raw?.focusSegmentId ? { focusSegmentId: raw.focusSegmentId } : {}),
  };
}

export function windowTranscript(
  segments: TranscriptSegment[],
  request: TranscriptWindowRead,
  totals: { totalMs: number; wordCount: number },
): TranscriptWindow {
  const filtered = filterTranscriptSegments(segments, request);
  const span = Math.min(Math.max(1, request.span), 400);
  let offset = Math.max(0, Math.floor(request.offset / span) * span);
  let focusedSegmentId: string | null = null;
  const focus = request.focusSegmentId;
  if (focus) {
    const index = filtered.findIndex((segment) => segment.id === focus);
    if (index >= 0) {
      const wanted = Math.floor(index / span) * span;
      if (wanted !== offset) focusedSegmentId = focus;
      offset = wanted;
    }
  }
  const lastStart = Math.max(0, Math.floor((filtered.length - 1) / span) * span);
  offset = Math.min(offset, lastStart);
  const window = filtered.slice(offset, offset + span);
  return {
    meetingId: request.meetingId,
    segments: window,
    filteredCount: filtered.length,
    totalCount: segments.length,
    offset,
    span,
    hasPrevious: offset > 0,
    hasNext: offset + window.length < filtered.length,
    focusedSegmentId,
    totalMs: totals.totalMs,
    wordCount: totals.wordCount,
  };
}

/** Human label for a window's position, e.g. `lines 121–240 of 591`. */
export function windowRangeLabel(window: TranscriptWindow): string {
  if (window.filteredCount === 0) return 'no matching lines';
  const first = window.offset + 1;
  const last = window.offset + window.segments.length;
  const scope =
    window.filteredCount === window.totalCount
      ? String(window.totalCount)
      : `${window.filteredCount} of ${window.totalCount}`;
  return `lines ${first}–${last} of ${scope}`;
}
