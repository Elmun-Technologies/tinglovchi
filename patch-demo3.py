import re

# ================================================================= writes.ts
p = 'packages/product/src/writes.ts'
s = open(p).read()

# drafts carry prep notes
old = """  participantIds: z.array(idSchema).max(24).default([]),
  occurredAt: z.string().trim().optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
});
export type MeetingDraftCreateInput = z.infer<typeof meetingDraftCreateInputSchema>;"""
new = """  participantIds: z.array(idSchema).max(24).default([]),
  occurredAt: z.string().trim().optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
  /** What the recorder wants to get out of the meeting; free text, never an insight. */
  notes: optionalText(2000),
});
export type MeetingDraftCreateInput = z.infer<typeof meetingDraftCreateInputSchema>;"""
assert old in s
s = s.replace(old, new, 1)

old = """  participantIds: z.array(idSchema).max(24).default([]),
  occurredAt: z.string().trim().optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
});
export type MeetingDraftUpdateInput = z.infer<typeof meetingDraftUpdateInputSchema>;"""
new = """  participantIds: z.array(idSchema).max(24).default([]),
  occurredAt: z.string().trim().optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
  notes: optionalText(2000),
});
export type MeetingDraftUpdateInput = z.infer<typeof meetingDraftUpdateInputSchema>;"""
assert old in s
s = s.replace(old, new, 1)

# A meeting-scoped term must be able to say which meeting.
old = """/** A meeting type key is a slug: it is what the future pipeline will look prompts up by. */"""
new = """/** A meeting type key is a slug: it is what the future pipeline will look prompts up by. */"""

old_parser = """export class WriteValidationError extends Error {
  readonly fields: string[];
  constructor(message: string, fields: string[] = []) {
    super(message);
    this.name = 'WriteValidationError';
    this.fields = fields;
  }
}"""
new_parser = """export class WriteValidationError extends RepositoryError {
  readonly fields: string[];
  constructor(message: string, fields: string[] = []) {
    super('validation_failed', message, { detail: fields[0] });
    this.name = 'WriteValidationError';
    this.fields = fields;
  }
}"""
assert old_parser in s
s = s.replace(old_parser, new_parser, 1)
s = s.replace(
    """import { z } from 'zod';
import { idSchema } from './domain';""",
    """import { z } from 'zod';
import { idSchema } from './domain';
import { RepositoryError } from './repositories';""",
    1,
)
# `meetingId` on a term needs a real place to live
open(p, 'w').write(s)

# ================================================================= domain.ts
p = 'packages/product/src/domain.ts'
s = open(p).read()
old = """export const vocabularyTermSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  term: z.string().min(1),
  context: z.string().min(1).optional(),
  scope: z.enum(['workspace', 'company', 'meeting']),
  companyId: idSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});"""
new = """export const vocabularyTermSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  term: z.string().min(1),
  context: z.string().min(1).optional(),
  scope: z.enum(['workspace', 'company', 'meeting']),
  companyId: idSchema.nullable().default(null),
  /** Only set for `scope: 'meeting'`; a term never silently widens itself to the whole workspace. */
  meetingId: idSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)

# ================================================================= demo/repositories.ts corrections
p = 'packages/product/src/demo/repositories.ts'
s = open(p).read()

s = s.replace("'not_allowed'", "'validation_failed'")
s = s.replace(
    """import {
  RepositoryError,
  can,
  writeActions,
  type DataCapabilities,
  type WriteActionKey,""",
    """import {
  RepositoryError,
  can,
  type DataCapabilities,
  type WriteActionKey,""",
    1,
)

# list filters: parse once, use the normalized value
old = """  const keeps = (filter: EntityListFilter | undefined): boolean =>
    entityListFilterSchema.safeParse(filter ?? {}).success;
  const matchesListFilter = <T extends { name: string; status: string }>(
    item: T,
    filter: EntityListFilter | undefined,
  ) => {
    if (!filter?.includeArchived && item.status === 'archived') return false;
    const needle = (filter?.query ?? '').trim().toLowerCase();
    return needle === '' || item.name.toLowerCase().includes(needle);
  };"""
new = """  /**
   * Archived records are hidden from a browse but never from a lookup: a meeting recorded against an archived
   * company must still name that company.
   */
  const readListFilter = (filter: EntityListFilter | undefined) => {
    const parsed = entityListFilterSchema.safeParse(filter ?? {});
    if (!parsed.success)
      throw new RepositoryError('validation_failed', 'That list filter is not valid.');
    return parsed.data;
  };
  const matchesListFilter = <T extends { name: string; status: string }>(
    item: T,
    filter: { includeArchived: boolean; query: string },
  ) => {
    if (!filter.includeArchived && item.status === 'archived') return false;
    if (item.status === 'closed' && !filter.includeArchived) return false;
    return filter.query === '' || item.name.toLowerCase().includes(filter.query.toLowerCase());
  };"""
assert old in s
s = s.replace(old, new, 1)

old = """      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        if (!keeps(filter))
          throw new RepositoryError('validation_failed', 'The company list filter is malformed.');
        return data.companies.filter((company) => matchesListFilter(company, filter));
      },"""
new = """      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        return data.companies.filter((company) => matchesListFilter(company, scoped));
      },"""
assert old in s
s = s.replace(old, new, 1)

old = """      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const visible = data.companies.filter((company) => matchesListFilter(company, filter));"""
new = """      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        const visible = data.companies.filter((company) => matchesListFilter(company, scoped));"""
assert old in s
s = s.replace(old, new, 1)

old = """      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        if (!keeps(filter))
          throw new RepositoryError('validation_failed', 'The project list filter is malformed.');
        return data.projects.filter((project) => matchesListFilter(project, filter));
      },"""
new = """      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        return data.projects.filter((project) => matchesListFilter(project, scoped));
      },"""
assert old in s
s = s.replace(old, new, 1)

old = """      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        return data.projects
          .filter((project) => matchesListFilter(project, filter))"""
new = """      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        return data.projects
          .filter((project) => matchesListFilter(project, scoped))"""
assert old in s
s = s.replace(old, new, 1)

# no speakerName field; keep the label display name honest by leaving the segment as-is
old = """        transcript.segments = transcript.segments.map((segment) =>
          segment.speakerLabel === label
            ? { ...segment, speakerPersonId: personId, speakerName: personName(personId) }
            : segment,
        );"""
new = """        transcript.segments = transcript.segments.map((segment) =>
          segment.speakerLabel === label ? { ...segment, speakerPersonId: personId } : segment,
        );"""
assert old in s
s = s.replace(old, new, 1)

# splice instead of reassigning aliased arrays; refresh the derived dashboard
old = """        data.settings.members = data.settings.members.filter(
          (item) => item.personId !== input.personId,
        );
        return data.settings.members.map(memberView);"""
new = """        const index = data.settings.members.findIndex((item) => item.personId === input.personId);
        if (index >= 0) data.settings.members.splice(index, 1);
        return data.settings.members.map(memberView);"""
assert old in s
s = s.replace(old, new, 1)

old = """        data.meetings = data.meetings.filter((item) => item.id !== meetingId);
        delete data.details[meetingId];
        delete data.transcripts[meetingId];
        delete data.topicsByMeeting[meetingId];
        delete data.processing[meetingId];
        return { id: meetingId };"""
new = """        const index = data.meetings.findIndex((item) => item.id === meetingId);
        if (index >= 0) data.meetings.splice(index, 1);
        delete data.details[meetingId];
        delete data.transcripts[meetingId];
        delete data.topicsByMeeting[meetingId];
        delete data.processing[meetingId];
        syncDashboard();
        return { id: meetingId };"""
assert old in s
s = s.replace(old, new, 1)

old = """        data.settings.vocabulary = data.settings.vocabulary.filter((item) => item.id !== termId);
        return [...data.settings.vocabulary];"""
new = """        const index = data.settings.vocabulary.findIndex((item) => item.id === termId);
        if (index >= 0) data.settings.vocabulary.splice(index, 1);
        return [...data.settings.vocabulary];"""
assert old in s
s = s.replace(old, new, 1)

# participants: an empty selection clears them
old = """        const participantIds = toIdList(input.participantIds);
        if (participantIds.length > 0 || input.participantIds.length > 0)
          meeting.participants = participantIds.map(participantOf);"""
new = """        meeting.participants = toIdList(input.participantIds).map(participantOf);"""
assert old in s
s = s.replace(old, new, 1)

# vocabulary: keep meetingId, and update the alias-safe arrays
old = """          companyId: input.scope === 'company' ? input.companyId : null,
          enabled: input.enabled,
        };
        data.settings.vocabulary.push(term);"""
new = """          companyId: input.scope === 'company' ? input.companyId : null,
          meetingId: input.scope === 'meeting' ? input.meetingId : null,
          enabled: input.enabled,
        };
        data.settings.vocabulary.push(term);"""
assert old in s
s = s.replace(old, new, 1)

# meeting types created via settings must appear in the dataset read too
old = """        if (input.durationMinutes !== undefined)
          meeting.durationMs = input.durationMinutes * 60_000;"""
new = """        if (input.durationMinutes !== undefined)
          meeting.durationMs = input.durationMinutes * 60_000;
        if (input.occurredAt) meeting.capturedMs = null;"""
assert old in s
s = s.replace(old, new, 1)

# dashboard sync after meeting/company writes
old = """        data.meetings.push(summary);
        const detail = draftDetail(summary, input.notes ?? null);"""
new = """        data.meetings.push(summary);
        syncDashboard();
        const detail = draftDetail(summary, input.notes ?? null);"""
assert old in s
s = s.replace(old, new, 1)

old = """        data.companies.push(company);
        data.intelligence[company.id] = emptyIntelligence(company.id);
        return company;"""
new = """        data.companies.push(company);
        data.intelligence[company.id] = emptyIntelligence(company.id);
        syncDashboard();
        return company;"""
assert old in s
s = s.replace(old, new, 1)

old = """      async setArchived(companyId, archived) {
        requireAction('company.archive');
        const company = companyOrThrow(companyId);
        company.status = archived ? 'archived' : 'active';
        return company;
      },"""
new = """      async setArchived(companyId, archived) {
        requireAction('company.archive');
        const company = companyOrThrow(companyId);
        company.status = archived ? 'archived' : 'active';
        syncDashboard();
        return company;
      },"""
assert old in s
s = s.replace(old, new, 1)

old = """  const emptyIntelligence = (companyId: string) => ({"""
new = """  /**
   * The home screen summarizes records, so it is recomputed from the live arrays after any write instead of
   * being patched field by field — one derivation, used by the fixture builder and by every mutation alike.
   */
  const syncDashboard = () => {
    data.dashboard = deriveDashboard({
      todayIsoDate: data.todayIsoDate,
      generatedAt: data.generatedAt,
      workspaceId: data.workspaces[0]!.id,
      meetings: data.meetings,
      tasks: data.tasks,
      decisions: data.decisions,
      questions: data.questions,
      processing: data.processing,
      companyCount: data.companies.filter((company) => company.status === 'active').length,
    });
  };

  const emptyIntelligence = (companyId: string) => ({"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace(
    """import { knowledgeEntries, type DemoDataset } from './dataset';""",
    """import { deriveDashboard, knowledgeEntries, type DemoDataset } from './dataset';""",
    1,
)

# existing task write switches to the same recomputation
old = """        // Keep the dashboard totals honest after a mutation.
        const openCount = data.tasks.filter((item) => isOpenStatus(item.status)).length;
        data.dashboard = {
          ...data.dashboard,
          openTaskCount: openCount,
          overdueTaskCount: data.tasks.filter((item) => isTaskOverdue(item, today())).length,
        };
        return task;"""
new = """        // Keep the dashboard totals honest after a mutation.
        syncDashboard();
        return task;"""
assert old in s
s = s.replace(old, new, 1)

open(p, 'w').write(s)

# ================================================================= dataset.ts: single derivation
p = 'packages/product/src/demo/dataset.ts'
s = open(p).read()
old = """function buildDashboard(dataset: {
  meetings: MeetingSummary[];
  tasks: Task[];
  decisions: Decision[];
  questions: Question[];
  processing: Record<string, ProcessingTimeline>;
}): DashboardSnapshot {
  const today = DEMO_TODAY_ISO_DATE;
  const weekAgo = '2026-09-29';"""
new = """/**
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
  const weekAgo = weekAgoOf(today);"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace(
    """    workspaceId: DEMO_WORKSPACE_ID,
    generatedAt: DEMO_GENERATED_AT,
    todayMeetings: sorted.filter((meeting) => isToday(meeting.occurredAt)),""",
    """    workspaceId: dataset.workspaceId,
    generatedAt: dataset.generatedAt,
    todayMeetings: sorted.filter((meeting) => isToday(meeting.occurredAt)),""",
    1,
)
s = s.replace(
    """    meetingCount: dataset.meetings.length,
    companyCount: demoCompanies.length,
  };
}""",
    """    meetingCount: dataset.meetings.length,
    companyCount: dataset.companyCount,
  };
}

/** Seven days before a calendar date, as the same `YYYY-MM-DD` form the records use. */
function weekAgoOf(isoDate: string): string {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base)) return isoDate;
  return new Date(base - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}""",
    1,
)
s = s.replace(
    """    dashboard: buildDashboard({ meetings: summaries, tasks, decisions, questions, processing }),""",
    """    dashboard: buildDashboard(summaries, tasks, decisions, questions, processing),""",
    1,
)
old = "function buildDataset("
idx = s.find("  dashboard: buildDashboard(summaries, tasks, decisions, questions, processing),")
# add the wrapper that keeps the fixture path intact
s = s.replace(
    """    dashboard: buildDashboard(summaries, tasks, decisions, questions, processing),""",
    """    dashboard: buildDashboard(summaries, tasks, decisions, questions, processing),""",
    1,
)
s = s.replace(
    """export function knowledgeEntries(dataset: DemoDataset): KnowledgeEntry[] {""",
    """/** Fixture-time dashboard: the same derivation with the demo workspace's fixed clock. */
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

export function knowledgeEntries(dataset: DemoDataset): KnowledgeEntry[] {""",
    1,
)
open(p, 'w').write(s)
print('phase 3 done')
