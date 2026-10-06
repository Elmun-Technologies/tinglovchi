import type {
  Company,
  CompanyOverview,
  MeetingDetail,
  MeetingProcessingState,
  DashboardSnapshot,
  KnowledgeFilter,
  MeetingFilter,
  MeetingListRow,
  MeetingSummary,
  MeetingTranscript,
  ProcessingStep,
  ProcessingTimeline,
  ProjectOverview,
  SearchHit,
  Task,
  TaskFilter,
  Topic,
  TranscriptSegment,
  VocabularyTerm,
  WorkspaceMember,
} from '../domain';
import {
  compareTasks,
  filterKnowledge,
  filterMeetings,
  filterTasks,
  isTaskOverdue,
  readTranscriptWindowRequest,
  routes,
  windowTranscript,
} from '../query';
import {
  companyCreateInputSchema,
  companyUpdateInputSchema,
  entityListFilterSchema,
  meetingDraftCreateInputSchema,
  meetingDraftUpdateInputSchema,
  meetingTypeCreateInputSchema,
  meetingTypeUpdateInputSchema,
  memberInviteInputSchema,
  memberRemoveInputSchema,
  memberRoleUpdateInputSchema,
  parseWriteInput,
  projectCreateInputSchema,
  projectUpdateInputSchema,
  speakerMappingCommitSchema,
  toIdList,
  toIsoInstant,
  vocabularyCreateInputSchema,
  vocabularyUpdateInputSchema,
  workspaceRenameInputSchema,
} from '../writes';
import type { EntityListFilter } from '../writes';
import { deriveDashboard, knowledgeEntries, type DemoDataset } from './dataset';
import { buildAskAnswer, demoAskSuggestions } from './ask';
import {
  RepositoryError,
  can,
  writeActions,
  type DataCapabilities,
  type WriteActionKey,
  type MeetingScope,
  type ProductRepositories,
} from '../repositories';

/**
 * Demo adapter: the same `ProductRepositories` contract the real adapter will implement, served from typed
 * fixtures.
 *
 * Writes are real but local: every create, update and archive below edits this adapter's clone of the fixture
 * dataset, so a change shows up in the next read of the same adapter and is gone on restart. That is what
 * `capabilities.persistence === 'in_memory'` means, and every form repeats it — the demo never implies a row
 * was written to a database, queued for a provider, or delivered to a person.
 */

/**
 * Everything the demo adapter can do locally is on; anything that would need a provider or a database is off,
 * including the two flows that would be fake: a real invitation (no mail is sent) and a pipeline that
 * transcribes (no provider exists). `demo.pipeline` stays `simulated` for the same reason.
 */
export const demoWriteActions: Record<WriteActionKey, boolean> = {
  'company.create': true,
  'company.update': true,
  'company.archive': true,
  'project.create': true,
  'project.update': true,
  'project.archive': true,
  'meeting.draft.create': true,
  'meeting.draft.update': true,
  'meeting.draft.delete': true,
  'meetingType.create': true,
  'meetingType.update': true,
  'vocabulary.create': true,
  'vocabulary.update': true,
  'vocabulary.delete': true,
  'workspace.rename': true,
  // Invitations are recorded in the roster as `invited`; nobody receives an email, and the copy says so.
  'workspace.members.invite': true,
  'workspace.members.role': true,
  'workspace.members.remove': true,
  'task.status': true,
  'transcript.speakerMapping': true,
  'demo.pipeline': true,
};

export const DEMO_CAPABILITIES: DataCapabilities = {
  mode: 'demo',
  reads: 'demo',
  // The demo adapter writes — to its own in-memory copy of the dataset. `persistence` is what makes that
  // honest: every form states that a restart discards the change, and no screen claims a cloud save.
  writes: true,
  pipeline: 'simulated',
  demoStateTransitions: true,
  playback: 'none',
  persistence: 'in_memory',
  persistenceLabel:
    'In memory for this demo session only — reloading the page restores the fixture data.',
  actions: demoWriteActions,
  provenanceLabel: 'Typed demo fixtures in @suhbat/product/demo — no database, no network',
};

const isOpenStatus = (status: Task['status']) =>
  status === 'open' || status === 'in_progress' || status === 'blocked';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createDemoRepositories(
  source: DemoDataset,
  overrides: Partial<DataCapabilities> = {},
): ProductRepositories {
  const data = clone(source);
  // Overrides must not be able to leave the capability record claiming more than this instance can do: a
  // `writes: false` override disables every action too, so `can()` and the repository never disagree.
  const capabilities: DataCapabilities = (() => {
    const merged: DataCapabilities = { ...DEMO_CAPABILITIES, ...overrides };
    if (!merged.writes)
      return {
        ...merged,
        persistence: 'none',
        persistenceLabel: 'This adapter instance refuses every write; nothing typed here is kept.',
        actions: Object.fromEntries(writeActions.map((key) => [key, false])) as Record<
          WriteActionKey,
          boolean
        >,
      };
    return {
      ...merged,
      actions: {
        ...merged.actions,
        'demo.pipeline': merged.demoStateTransitions,
      },
    };
  })();
  const today = () => data.todayIsoDate;

  const meetingOrThrow = (meetingId: string): MeetingSummary => {
    const meeting = data.meetings.find((item) => item.id === meetingId);
    if (!meeting)
      throw new RepositoryError('not_found', 'That meeting is not in this workspace.', {
        detail: meetingId,
      });
    return meeting;
  };

  const companyOrThrow = (companyId: string) => {
    const company = data.companies.find((item) => item.id === companyId);
    if (!company)
      throw new RepositoryError('not_found', 'That company is not in this workspace.', {
        detail: companyId,
      });
    return company;
  };

  const projectOrThrow = (projectId: string) => {
    const project = data.projects.find((item) => item.id === projectId);
    if (!project)
      throw new RepositoryError('not_found', 'That project is not in this workspace.', {
        detail: projectId,
      });
    return project;
  };

  const inWorkspace = (workspaceId: string) => {
    if (!data.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new RepositoryError('not_found', 'Unknown workspace.', {
        detail: workspaceId,
        hint: 'Demo mode knows one workspace: the demo workspace id.',
      });
    }
  };

  const tasksOfMeeting = (meetingId: string) =>
    data.tasks.filter((task) => task.meetingId === meetingId);

  const processingFor = (meetingId: string): ProcessingTimeline => {
    const timeline = data.processing[meetingId];
    if (!timeline) throw new RepositoryError('not_found', 'No processing record for that meeting.');
    return timeline;
  };

  const setMeetingState = (meetingId: string, state: ProcessingTimeline['state']) => {
    const meeting = meetingOrThrow(meetingId);
    meeting.state = state;
    const detail = data.details[meetingId];
    if (detail) detail.state = state;
    const timeline = data.processing[meetingId];
    if (timeline) timeline.state = state;
  };

  const transcriptsFor = (meetingId: string): MeetingTranscript => {
    meetingOrThrow(meetingId);
    return (
      data.transcripts[meetingId] ?? {
        meetingId,
        segments: [],
        topics: [],
        participants: [],
        speakerMappings: [],
        totalMs: 0,
        wordCount: 0,
      }
    );
  };

  const knowledgeFor = (filter: KnowledgeFilter) => filterKnowledge(knowledgeEntries(data), filter);

  /**
   * One predicate for every "records for this meeting / company / project" read, so a meeting tab and a
   * company tab cannot drift apart in what "in scope" means.
   */
  const inScope = (
    scope: MeetingScope,
    item: {
      workspaceId: string;
      companyId: string | null;
      projectId?: string | null;
      meetingId: string;
    },
  ) =>
    item.workspaceId === scope.workspaceId &&
    (scope.meetingId === undefined || item.meetingId === scope.meetingId) &&
    (scope.companyId === undefined || item.companyId === scope.companyId) &&
    (scope.projectId === undefined || item.projectId === scope.projectId);

  /* ------------------------------------------------------------------ writes
   * Every mutation below edits `data` — this adapter instance's clone of the fixture dataset — and nothing
   * else. There is no queue, no retry, no "syncing" state, because there is nothing to sync to. Validation
   * that has product meaning (duplicate names, a project under another company, an owner who cannot be
   * removed, a recorded meeting that is not a draft anymore) lives here rather than in the form, so a future
   * live adapter inherits the same rules.
   */
  let minted = 0;
  const nextId = (prefix: string) => {
    minted += 1;
    return `${prefix}_draft${minted}`;
  };
  /** Monotonic and derived from the fixture clock, so created records sort after authored ones. */
  const stamp = () => {
    minted += 1;
    return new Date(Date.parse(data.generatedAt) + minted * 1000).toISOString();
  };

  /**
   * Archived records are hidden from a browse but never from a lookup: a meeting recorded against an archived
   * company must still name that company.
   */
  const readListFilter = (filter: EntityListFilter | undefined) => {
    const parsed = entityListFilterSchema.safeParse(filter ?? {});
    if (!parsed.success)
      throw new RepositoryError('validation_failed', 'That list filter is not valid.');
    return parsed.data;
  };
  type ListFilter = {
    includeArchived: boolean;
    query: string;
    status?: string;
    companyId?: string;
  };
  const matchesListFilter = (
    item: { name: string; status: string; description?: string },
    filter: ListFilter,
    extraText = '',
  ) => {
    // `closed` is what archiving means for a project, so one toggle covers both entities.
    if (!filter.includeArchived && (item.status === 'archived' || item.status === 'closed'))
      return false;
    if (filter.status && item.status !== filter.status) return false;
    if (filter.query === '') return true;
    const needle = filter.query.toLowerCase();
    return (
      item.name.toLowerCase().includes(needle) ||
      (item.description ?? '').toLowerCase().includes(needle) ||
      extraText.toLowerCase().includes(needle)
    );
  };

  const memberView = (member: {
    personId: string;
    name: string;
    email?: string;
    role: WorkspaceMember['role'];
    status: WorkspaceMember['status'];
  }): WorkspaceMember => ({
    ...member,
    openTaskCount: data.tasks.filter(
      (task) => task.ownerPersonId === member.personId && isOpenStatus(task.status),
    ).length,
    meetingCount: data.meetings.filter((meeting) =>
      meeting.participants.some((participant) => participant.personId === member.personId),
    ).length,
  });

  const pushMeetingType = (type: (typeof data.meetingTypes)[number]) => {
    if (!data.meetingTypes.includes(type)) data.meetingTypes.push(type);
    if (data.settings.meetingTypes !== data.meetingTypes) data.settings.meetingTypes.push(type);
  };

  /** Display name for an address nobody has a profile for yet: the local part, tidied — not an invention. */
  const nameFromEmail = (email: string) => {
    const local = email.split('@')[0] ?? email;
    const words = local
      .replace(/[._-]+/g, ' ')
      .replace(/\d+$/, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (words.length === 0) return email;
    return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
  };

  const initialsFromEmail = (email: string) =>
    nameFromEmail(email)
      .split(' ')
      .map((word) => word[0]!.toUpperCase())
      .join('')
      .slice(0, 3) || email.slice(0, 2).toUpperCase();

  /**
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

  const emptyIntelligence = (companyId: string) => ({
    companyId,
    updatedAt: stamp(),
    derivedFrom: 'demo_fixtures' as const,
    goals: [],
    painPoints: [],
    importantFacts: [],
    decisionMakers: [],
    objections: [],
    commitments: [],
  });

  const participantOf = (personId: string) => {
    const person = data.people.find((item) => item.id === personId);
    if (!person)
      throw new RepositoryError('validation_failed', 'That participant is not in this workspace.', {
        detail: personId,
      });
    return {
      personId: person.id,
      name: person.name,
      initials: person.initials,
      kind: person.kind,
      mapped: true,
      // Nothing has been said yet, so nobody "spoke" — the flag is recomputed once a transcript exists.
      spokeInMeeting: false,
    };
  };

  const draftDetail = (summary: MeetingSummary, notes: string | null): MeetingDetail => ({
    ...summary,
    executiveSummary: notes ? [notes] : [],
    unmappedSpeakers: [],
    recording: {
      available: false,
      source: 'none',
      note: 'Draft only — nothing has been recorded or uploaded for this meeting.',
    },
    stats: {
      speakingParticipants: 0,
      topics: 0,
      decisions: 0,
      confirmedDecisions: 0,
      tasks: 0,
      openTasks: 0,
      questions: 0,
      openQuestions: 0,
      facts: 0,
      ideas: 0,
      words: 0,
    },
    processing: {
      meetingId: summary.id,
      state: 'draft',
      steps: [
        { state: 'pending', key: 'capture', label: 'Not recorded yet' },
        { state: 'pending', key: 'transcribe', label: 'No transcript yet' },
        { state: 'pending', key: 'analyze', label: 'Nothing analyzed yet' },
      ],
    },
  });

  const isDraft = (meetingId: string) => {
    const meeting = meetingOrThrow(meetingId);
    if (meeting.state !== 'draft')
      throw new RepositoryError(
        'validation_failed',
        'Only an unrecorded draft can be edited this way; a meeting with a transcript is corrected in its records.',
        { detail: meetingId },
      );
    return meeting;
  };

  const requireAction = (action: WriteActionKey) => {
    if (!can(capabilities, action))
      throw new RepositoryError('unsupported_in_demo', 'This build cannot perform that action.', {
        detail: action,
      });
  };

  return {
    capabilities,
    workspaces: {
      async list() {
        return data.workspaces;
      },
      async get(workspaceId) {
        inWorkspace(workspaceId);
        return data.workspaces.find((workspace) => workspace.id === workspaceId)!;
      },
      async currentPersonId(workspaceId) {
        inWorkspace(workspaceId);
        return data.currentPersonId;
      },
      /** Roster joined with real per-person counts, so access and workload are visible together. */
      async members(workspaceId) {
        inWorkspace(workspaceId);
        return data.settings.members.map(memberView);
      },
      async rename(raw) {
        requireAction('workspace.rename');
        const input = parseWriteInput(workspaceRenameInputSchema, raw);
        inWorkspace(input.workspaceId);
        data.settings.workspaceName = input.name;
        const workspace = data.workspaces.find((item) => item.id === input.workspaceId);
        if (workspace) workspace.name = input.name;
        return workspace ?? data.workspaces[0]!;
      },
      /**
       * An invitation is a roster entry with `status: 'invited'`. No mail leaves this build, and the copy on
       * the settings page says that out loud rather than showing a "sent" toast.
       */
      async inviteMember(raw) {
        requireAction('workspace.members.invite');
        const input = parseWriteInput(memberInviteInputSchema, raw);
        inWorkspace(input.workspaceId);
        if (data.settings.members.some((member) => member.email?.toLowerCase() === input.email))
          throw new RepositoryError('validation_failed', 'That address has already been invited.');
        let person = data.people.find((item) => item.email?.toLowerCase() === input.email);
        if (!person) {
          person = {
            id: nextId('person'),
            workspaceId: input.workspaceId,
            name: nameFromEmail(input.email),
            initials: initialsFromEmail(input.email),
            kind: 'external',
            email: input.email,
          };
          data.people.push(person);
        }
        const member = {
          personId: person.id,
          name: person.name,
          email: input.email,
          role: input.role,
          status: 'invited' as const,
        };
        data.settings.members.push(member);
        return memberView(member);
      },
      async setMemberRole(raw) {
        requireAction('workspace.members.role');
        const input = parseWriteInput(memberRoleUpdateInputSchema, raw);
        inWorkspace(input.workspaceId);
        const member = data.settings.members.find((item) => item.personId === input.personId);
        if (!member)
          throw new RepositoryError('not_found', 'That person is not in this workspace.', {
            detail: input.personId,
          });
        if (member.role === 'owner')
          throw new RepositoryError(
            'validation_failed',
            'The owner role is transferred by an owner, not from this screen.',
          );
        member.role = input.role;
        return data.settings.members.map(memberView);
      },
      /**
       * Removing a member is refused while they still own open tasks: in the demo those tasks are real records
       * with owners, and silently orphaning them would be a worse lie than refusing.
       */
      async removeMember(raw) {
        requireAction('workspace.members.remove');
        const input = parseWriteInput(memberRemoveInputSchema, raw);
        inWorkspace(input.workspaceId);
        const member = data.settings.members.find((item) => item.personId === input.personId);
        if (!member)
          throw new RepositoryError('not_found', 'That person is not in this workspace.', {
            detail: input.personId,
          });
        if (member.role === 'owner')
          throw new RepositoryError('validation_failed', 'The workspace owner cannot be removed.');
        const owned = data.tasks.filter(
          (task) => task.ownerPersonId === input.personId && isOpenStatus(task.status),
        );
        if (owned.length > 0)
          throw new RepositoryError(
            'validation_failed',
            `${owned.length} open ${owned.length === 1 ? 'task is' : 'tasks are'} still assigned to ${member.name}. Reassign them first.`,
          );
        const index = data.settings.members.findIndex((item) => item.personId === input.personId);
        if (index >= 0) data.settings.members.splice(index, 1);
        return data.settings.members.map(memberView);
      },
    },
    companies: {
      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        return data.companies.filter((company) => matchesListFilter(company, scoped));
      },
      async get(companyId) {
        return companyOrThrow(companyId);
      },
      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        const visible = data.companies.filter((company) => matchesListFilter(company, scoped));
        const overview: CompanyOverview[] = visible.map((company) => {
          const meetings = data.meetings.filter((meeting) => meeting.companyId === company.id);
          const tasks = data.tasks.filter((task) => task.companyId === company.id);
          return {
            company,
            activeProjectCount: data.projects.filter(
              (project) => project.companyId === company.id && project.status === 'active',
            ).length,
            meetingCount: meetings.length,
            openTaskCount: tasks.filter((task) => isOpenStatus(task.status)).length,
            decisionCount: data.decisions.filter((decision) => decision.companyId === company.id)
              .length,
            lastMeetingAt:
              meetings
                .map((meeting) => meeting.occurredAt)
                .sort()
                .at(-1) ?? null,
          };
        });
        return overview.sort(
          (left, right) =>
            right.meetingCount - left.meetingCount ||
            left.company.name.localeCompare(right.company.name),
        );
      },
      async intelligence(companyId) {
        const company = companyOrThrow(companyId);
        // A company with no meetings has no intelligence yet; an empty derived record states that instead of
        // failing, so a freshly created company opens its own page.
        return data.intelligence[companyId] ?? emptyIntelligence(company.id);
      },
      async create(raw) {
        requireAction('company.create');
        const input = parseWriteInput(companyCreateInputSchema, raw);
        inWorkspace(input.workspaceId);
        const name = input.name;
        if (data.companies.some((company) => company.name.toLowerCase() === name.toLowerCase()))
          throw new RepositoryError(
            'validation_failed',
            'A company with that name already exists in this workspace.',
          );
        const company: Company = {
          id: nextId('company'),
          workspaceId: input.workspaceId,
          name,
          ...(input.description ? { description: input.description } : {}),
          status: 'active',
          createdAt: stamp(),
        };
        data.companies.push(company);
        data.intelligence[company.id] = emptyIntelligence(company.id);
        syncDashboard();
        return company;
      },
      async update(companyId, raw) {
        requireAction('company.update');
        const company = companyOrThrow(companyId);
        const input = parseWriteInput(companyUpdateInputSchema, raw);
        if (
          data.companies.some(
            (item) =>
              item.id !== company.id && item.name.toLowerCase() === input.name.toLowerCase(),
          )
        )
          throw new RepositoryError(
            'validation_failed',
            'Another company already uses that name in this workspace.',
          );
        company.name = input.name;
        if (input.description) company.description = input.description;
        else delete company.description;
        // Aggregate names on meeting rows must not go stale after a rename.
        for (const meeting of data.meetings)
          if (meeting.companyId === company.id) meeting.companyName = company.name;
        return company;
      },
      async setArchived(companyId, archived) {
        requireAction('company.archive');
        const company = companyOrThrow(companyId);
        company.status = archived ? 'archived' : 'active';
        syncDashboard();
        return company;
      },
    },
    projects: {
      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        return data.projects.filter((project) => matchesListFilter(project, scoped));
      },
      async get(projectId) {
        return projectOrThrow(projectId);
      },
      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const scoped = readListFilter(filter);
        return data.projects
          .filter(
            (project) =>
              (!scoped.companyId || project.companyId === scoped.companyId) &&
              matchesListFilter(
                project,
                scoped,
                data.companies.find((company) => company.id === project.companyId)?.name ?? '',
              ),
          )
          .map<ProjectOverview>((project) => {
            const meetings = data.meetings.filter((meeting) => meeting.projectId === project.id);
            const tasks = data.tasks.filter((task) => task.projectId === project.id);
            return {
              project,
              companyName:
                data.companies.find((company) => company.id === project.companyId)?.name ?? null,
              meetingCount: meetings.length,
              openTaskCount: tasks.filter((task) => isOpenStatus(task.status)).length,
              decisionCount: data.decisions.filter((decision) => decision.projectId === project.id)
                .length,
              lastActivityAt:
                meetings
                  .map((meeting) => meeting.occurredAt)
                  .sort()
                  .at(-1) ??
                project.lastActivityAt ??
                null,
            };
          });
      },
      async create(raw) {
        requireAction('project.create');
        const input = parseWriteInput(projectCreateInputSchema, raw);
        inWorkspace(input.workspaceId);
        if (
          data.projects.some(
            (project) =>
              project.workspaceId === input.workspaceId &&
              project.name.toLowerCase() === input.name.toLowerCase(),
          )
        )
          throw new RepositoryError(
            'validation_failed',
            'A project with that name already exists in this workspace.',
          );
        const company = input.companyId ? companyOrThrow(input.companyId) : null;
        const project = {
          id: nextId('project'),
          workspaceId: input.workspaceId,
          companyId: company?.id ?? null,
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          status: 'active' as const,
          createdAt: stamp(),
          lastActivityAt: stamp(),
        };
        data.projects.push(project);
        return project;
      },
      async update(projectId, raw) {
        requireAction('project.update');
        const project = projectOrThrow(projectId);
        const input = parseWriteInput(projectUpdateInputSchema, raw);
        if (input.companyId) {
          const company = companyOrThrow(input.companyId);
          // A project may not sit under a company its meetings do not belong to.
          const foreign = data.meetings.filter(
            (meeting) =>
              meeting.projectId === project.id &&
              meeting.companyId &&
              meeting.companyId !== company.id,
          );
          if (foreign.length > 0)
            throw new RepositoryError(
              'validation_failed',
              `${foreign.length} ${foreign.length === 1 ? 'meeting is' : 'meetings are'} recorded under another company for this project. Move them first.`,
            );
        }
        project.name = input.name;
        project.companyId = input.companyId ?? project.companyId;
        if (input.description) project.description = input.description;
        else delete project.description;
        if (input.status) project.status = input.status;
        project.lastActivityAt = stamp();
        for (const meeting of data.meetings)
          if (meeting.projectId === project.id) meeting.projectName = project.name;
        return project;
      },
      async setArchived(projectId, archived) {
        requireAction('project.archive');
        const project = projectOrThrow(projectId);
        // Archive and close mean the same thing for a project row in this build; `status` keeps its own words.
        project.status = archived ? 'closed' : 'active';
        return project;
      },
    },
    meetings: {
      async list(workspaceId, filter?: MeetingFilter) {
        inWorkspace(workspaceId);
        const rows = filterMeetings(data.meetings, filter).map<MeetingListRow>((meeting) => {
          const tasks = tasksOfMeeting(meeting.id);
          return {
            meeting,
            openTaskCount: tasks.filter((task) => isOpenStatus(task.status)).length,
            overdueTaskCount: tasks.filter((task) => isTaskOverdue(task, today())).length,
          };
        });
        return rows;
      },
      async detail(meetingId) {
        const detail = data.details[meetingId];
        if (!detail)
          throw new RepositoryError('not_found', 'That meeting is not in this workspace.', {
            detail: meetingId,
          });
        return detail;
      },
      async participants(meetingId) {
        return meetingOrThrow(meetingId).participants;
      },
      async meetingTypes(workspaceId) {
        inWorkspace(workspaceId);
        return data.meetingTypes;
      },
      async dashboard(workspaceId): Promise<DashboardSnapshot> {
        inWorkspace(workspaceId);
        return data.dashboard;
      },
      processing: async (meetingId) => processingFor(meetingId),
      async decisionsFor(scope) {
        return data.decisions.filter((decision) => inScope(scope, decision));
      },
      async factsFor(scope) {
        return data.facts.filter((fact) => inScope(scope, fact));
      },
      async questionsFor(scope) {
        return data.questions.filter((question) => inScope(scope, question));
      },
      async ideasFor(scope) {
        return data.ideas.filter((idea) => inScope(scope, idea));
      },
      async commitmentsFor(scope) {
        return data.commitments.filter((commitment) => inScope(scope, commitment));
      },
      /**
       * Demo-only: moves a meeting one step along its documented pipeline so the processing UI can be
       * reviewed. It does not transcribe or analyse anything, and the UI labels it as a demo transition.
       */
      /**
       * A draft reserves a slot for a meeting that has not happened yet. The record it produces is
       * deliberately empty: no transcript, no recording, zero counts, `origin: 'draft'`, and a pipeline that
       * refuses to advance because nothing was captured.
       */
      async createDraft(raw) {
        requireAction('meeting.draft.create');
        const input = parseWriteInput(meetingDraftCreateInputSchema, raw);
        inWorkspace(input.workspaceId);
        const meetingType = data.meetingTypes.find(
          (type) => type.id === input.meetingTypeId && type.active,
        );
        if (!meetingType)
          throw new RepositoryError(
            'validation_failed',
            'Choose a meeting type that is still active.',
            { detail: input.meetingTypeId },
          );
        const company = input.companyId ? companyOrThrow(input.companyId) : null;
        if (company && company.status === 'archived')
          throw new RepositoryError(
            'validation_failed',
            'That company is archived. Reactivate it first.',
          );
        const project = input.projectId ? projectOrThrow(input.projectId) : null;
        if (project && company && project.companyId && project.companyId !== company.id)
          throw new RepositoryError(
            'validation_failed',
            `That project belongs to ${
              data.companies.find((item) => item.id === project.companyId)?.name ??
              'another company'
            }, not ${company.name}.`,
          );
        const occurredAt = toIsoInstant(input.occurredAt, `${data.todayIsoDate}T09:00:00.000Z`);
        const participantIds = toIdList(input.participantIds);
        const summary: MeetingSummary = {
          id: nextId('meeting'),
          workspaceId: input.workspaceId,
          title: input.title,
          companyId: company?.id ?? null,
          ...(company ? { companyName: company.name } : {}),
          projectId: project?.id ?? null,
          ...(project ? { projectName: project.name } : {}),
          meetingTypeId: meetingType.id,
          meetingTypeKey: meetingType.key,
          meetingTypeLabel: meetingType.displayName,
          occurredAt,
          durationMs: (input.durationMinutes ?? 0) * 60_000,
          capturedMs: null,
          state: 'draft',
          languages: data.settings.ai.transcriptionLanguages,
          participants: participantIds.map(participantOf),
          origin: 'draft',
          recordingAvailable: false,
          counts: {
            topics: 0,
            decisions: 0,
            tasks: 0,
            facts: 0,
            questions: 0,
            ideas: 0,
            segments: 0,
          },
        };
        data.meetings.push(summary);
        syncDashboard();
        const detail = draftDetail(summary, input.notes ?? null);
        data.details[summary.id] = detail;
        data.transcripts[summary.id] = {
          meetingId: summary.id,
          segments: [],
          topics: [],
          // The people the draft was planned with: declared, not heard. `spokeInMeeting` stays false.
          participants: summary.participants,
          speakerMappings: [],
          totalMs: 0,
          wordCount: 0,
        };
        data.topicsByMeeting[summary.id] = [];
        data.processing[summary.id] = detail.processing!;
        return summary;
      },
      /** Editing a draft is the only way to change a meeting's identity; after capture, records are the surface. */
      async updateDraft(meetingId, raw) {
        requireAction('meeting.draft.update');
        const meeting = isDraft(meetingId);
        const input = parseWriteInput(meetingDraftUpdateInputSchema, raw);
        const meetingType = data.meetingTypes.find(
          (type) => type.id === input.meetingTypeId && type.active,
        );
        if (!meetingType)
          throw new RepositoryError(
            'validation_failed',
            'Choose a meeting type that is still active.',
          );
        const company = input.companyId ? companyOrThrow(input.companyId) : null;
        const project = input.projectId ? projectOrThrow(input.projectId) : null;
        if (project && company && project.companyId && project.companyId !== company.id)
          throw new RepositoryError(
            'validation_failed',
            'That project belongs to a different company.',
          );
        meeting.title = input.title;
        meeting.meetingTypeId = meetingType.id;
        meeting.meetingTypeKey = meetingType.key;
        meeting.meetingTypeLabel = meetingType.displayName;
        meeting.companyId = company?.id ?? null;
        if (company) meeting.companyName = company.name;
        else delete meeting.companyName;
        meeting.projectId = project?.id ?? null;
        if (project) meeting.projectName = project.name;
        else delete meeting.projectName;
        meeting.occurredAt = toIsoInstant(input.occurredAt, meeting.occurredAt);
        if (input.durationMinutes !== undefined)
          meeting.durationMs = input.durationMinutes * 60_000;
        if (input.occurredAt) meeting.capturedMs = null;
        meeting.participants = toIdList(input.participantIds).map(participantOf);
        const detail = data.details[meetingId];
        if (detail) {
          Object.assign(detail, {
            ...meeting,
            executiveSummary: input.notes ? [input.notes] : [],
          });
        }
        return meeting;
      },
      /**
       * Deletion exists only for a draft. A meeting with a transcript, a decision or a task is archived with
       * its evidence intact — there is no code path here that can erase an analyzed meeting.
       */
      async deleteDraft(meetingId) {
        requireAction('meeting.draft.delete');
        const meeting = isDraft(meetingId);
        const detail = data.details[meetingId];
        const linked =
          (detail?.stats.decisions ?? 0) + (detail?.stats.tasks ?? 0) + meeting.counts.segments;
        if (linked > 0)
          throw new RepositoryError(
            'validation_failed',
            'This draft already has transcript or analysis records; it cannot be deleted.',
          );
        const index = data.meetings.findIndex((item) => item.id === meetingId);
        if (index >= 0) data.meetings.splice(index, 1);
        delete data.details[meetingId];
        delete data.transcripts[meetingId];
        delete data.topicsByMeeting[meetingId];
        delete data.processing[meetingId];
        syncDashboard();
        return { id: meetingId };
      },
      async advanceDemoState(meetingId) {
        requireAction('demo.pipeline');
        const timeline = processingFor(meetingId);
        const activeIndex = timeline.steps.findIndex(
          (step) => step.state === 'active' || step.state === 'failed',
        );
        if (timeline.state === 'ready' || timeline.state === 'draft') {
          throw new RepositoryError(
            'unsupported_in_demo',
            'This meeting is not mid-pipeline, so there is nothing to advance.',
          );
        }
        if (activeIndex === -1) {
          setMeetingState(meetingId, 'ready');
          return { ...timeline, state: 'ready', error: undefined };
        }
        const steps: ProcessingStep[] = timeline.steps.map((step, index) =>
          index === activeIndex
            ? {
                ...step,
                state: 'done',
                at: data.generatedAt,
                detail:
                  step.state === 'failed' ? 'Re-run completed (demo transition)' : step.detail,
              }
            : index === activeIndex + 1
              ? { ...step, state: 'pending' }
              : step,
        );
        const nextActive = steps.findIndex((step) => step.state === 'pending');
        let state: MeetingProcessingState = timeline.state;
        if (nextActive === -1) {
          state = 'ready';
        } else {
          steps[nextActive] = { ...steps[nextActive]!, state: 'active' };
          const key = steps[nextActive]!.key;
          state =
            key === 'index'
              ? 'indexing'
              : key === 'analyze'
                ? 'analyzing'
                : key === 'transcribe'
                  ? 'transcribing'
                  : 'preparing_transcript';
        }
        const updated: ProcessingTimeline = { ...timeline, steps, state, error: undefined };
        data.processing[meetingId] = updated;
        setMeetingState(meetingId, state);
        return updated;
      },
    },
    transcripts: {
      async forMeeting(meetingId) {
        return transcriptsFor(meetingId);
      },
      /**
       * The paged read every transcript screen uses. Filters are applied before the slice so a search result
       * count and the pager describe the same list, and an evidence link can pull its own line into view
       * without the browser holding 3 hours of text.
       */
      async window(request) {
        const transcript = transcriptsFor(request.meetingId);
        return windowTranscript(transcript.segments, readTranscriptWindowRequest(request), {
          totalMs: transcript.totalMs,
          wordCount: transcript.wordCount,
        });
      },
      async segmentsForTopic(topicId) {
        for (const [meetingId, topics] of Object.entries(data.topicsByMeeting)) {
          const topic = topics.find((item: Topic) => item.id === topicId);
          if (topic) {
            const byId = new Map(
              transcriptsFor(meetingId).segments.map((segment) => [segment.id, segment]),
            );
            return topic.segmentIds
              .map((id) => byId.get(id))
              .filter((segment): segment is TranscriptSegment => Boolean(segment));
          }
        }
        throw new RepositoryError('not_found', 'Unknown topic.', { detail: topicId });
      },
      async segmentsByIds(meetingId, segmentIds) {
        const wanted = new Set(segmentIds);
        return transcriptsFor(meetingId).segments.filter((segment) => wanted.has(segment.id));
      },
      /** Demo-only speaker mapping so the mapping dialog can be exercised end to end. */
      async confirmSpeakerMapping(raw) {
        requireAction('transcript.speakerMapping');
        const { meetingId, label, personId } = parseWriteInput(speakerMappingCommitSchema, raw);
        const transcript = transcriptsFor(meetingId);
        if (!data.people.some((person) => person.id === personId)) {
          throw new RepositoryError('not_found', 'Unknown person for speaker mapping.', {
            detail: personId,
          });
        }
        // Mapping a label nobody spoke would silently change nothing, so the refusal comes from the adapter.
        if (!transcript.speakerMappings.some((mapping) => mapping.label === label))
          throw new RepositoryError(
            'validation_failed',
            'That speaker label is not in this meeting.',
            {
              detail: label,
            },
          );
        transcript.segments = transcript.segments.map((segment) =>
          segment.speakerLabel === label ? { ...segment, speakerPersonId: personId } : segment,
        );
        for (const meeting of data.meetings)
          if (meeting.id === meetingId)
            meeting.participants = meeting.participants.map((participant) =>
              participant.personId === personId
                ? { ...participant, mapped: true, spokeInMeeting: true }
                : participant,
            );
        transcript.speakerMappings = transcript.speakerMappings.map((mapping) =>
          mapping.label === label ? { ...mapping, personId, confirmed: true } : mapping,
        );
        data.transcripts[meetingId] = transcript;
        const detail = data.details[meetingId];
        if (detail)
          detail.unmappedSpeakers = detail.unmappedSpeakers.filter((item) => item !== label);
        return transcript.speakerMappings;
      },
    },
    tasks: {
      async list(workspaceId, filter?: TaskFilter) {
        inWorkspace(workspaceId);
        const scoped = data.tasks.filter(
          (task) =>
            task.workspaceId === workspaceId &&
            (!filter?.meetingId || task.meetingId === filter.meetingId),
        );
        const filtered = filterTasks(scoped, filter, {
          currentPersonId: data.currentPersonId,
          todayIsoDate: today(),
        });
        return [...filtered].sort(compareTasks(today()));
      },
      async updateStatus(taskId, status) {
        requireAction('task.status');
        const task = data.tasks.find((item) => item.id === taskId);
        if (!task) throw new RepositoryError('not_found', 'Unknown task.', { detail: taskId });
        task.status = status;
        task.completedAt = status === 'completed' ? data.generatedAt : undefined;
        // Keep the dashboard totals honest after a mutation.
        syncDashboard();
        return task;
      },
    },
    knowledge: {
      async entries(filter) {
        return knowledgeFor(filter);
      },
    },
    askAi: {
      async ask(workspaceId, question) {
        inWorkspace(workspaceId);
        if (!question.trim()) {
          throw new RepositoryError(
            'unsupported_in_demo',
            'Ask a question to see a retrieval-backed answer.',
          );
        }
        return buildAskAnswer(data, question);
      },
      async suggestions(workspaceId) {
        inWorkspace(workspaceId);
        return demoAskSuggestions;
      },
    },
    search: {
      async search(workspaceId, query) {
        inWorkspace(workspaceId);
        const needle = query.trim().toLowerCase();
        if (needle.length < 2) return [];
        const hits: SearchHit[] = [];
        const add = (hit: SearchHit) => {
          if (!hits.some((existing) => existing.href === hit.href && existing.title === hit.title))
            hits.push(hit);
        };
        for (const meeting of data.meetings) {
          if (
            `${meeting.title} ${meeting.companyName ?? ''} ${meeting.projectName ?? ''}`
              .toLowerCase()
              .includes(needle)
          ) {
            add({
              kind: 'meeting',
              id: meeting.id,
              title: meeting.title,
              subtitle: `${meeting.companyName ?? 'No company'} · ${new Date(meeting.occurredAt).toLocaleDateString('en', { dateStyle: 'medium' })}`,
              href: routes.meeting({ workspaceId, meetingId: meeting.id }),
            });
          }
        }
        for (const company of data.companies) {
          if (company.name.toLowerCase().includes(needle)) {
            add({
              kind: 'company',
              id: company.id,
              title: company.name,
              subtitle: company.description ?? 'Company',
              href: routes.company({ workspaceId, companyId: company.id }),
            });
          }
        }
        for (const project of data.projects) {
          if (project.name.toLowerCase().includes(needle)) {
            add({
              kind: 'project',
              id: project.id,
              title: project.name,
              subtitle: 'Project',
              href: routes.project({ workspaceId, projectId: project.id }),
            });
          }
        }
        for (const individual of data.people) {
          if (individual.name.toLowerCase().includes(needle)) {
            add({
              kind: 'person',
              id: individual.id,
              title: individual.name,
              subtitle: individual.title ?? 'Workspace member',
              href: routes.tasks({ workspaceId }, { person: individual.id }),
            });
          }
        }
        for (const decision of data.decisions) {
          if (`${decision.title} ${decision.description}`.toLowerCase().includes(needle)) {
            add({
              kind: 'decision',
              id: decision.id,
              title: decision.title,
              subtitle: `Decision · ${decision.status}`,
              href: routes.meetingTab({
                workspaceId,
                meetingId: decision.meetingId,
                tab: 'decisions',
              }),
            });
          }
        }
        for (const task of data.tasks) {
          if (`${task.title} ${task.detail ?? ''}`.toLowerCase().includes(needle)) {
            add({
              kind: 'task',
              id: task.id,
              title: task.title,
              subtitle: `Task · ${task.ownerLabel}`,
              href: routes.meetingTab({ workspaceId, meetingId: task.meetingId, tab: 'tasks' }),
            });
          }
        }
        return hits.slice(0, 12);
      },
      /**
       * Offered before anyone has typed: the newest meetings and the soonest open work in this workspace. It is
       * derived from workspace data rather than from a browsing history, because this build stores nothing about
       * the person using it.
       */
      async recent(workspaceId, limit = 12) {
        inWorkspace(workspaceId);
        const hits: SearchHit[] = data.meetings
          .slice()
          .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
          .slice(0, Math.max(1, Math.min(limit, 8)))
          .map((meeting) => ({
            kind: 'meeting' as const,
            id: meeting.id,
            title: meeting.title,
            subtitle: `${meeting.state === 'draft' ? 'Draft' : meeting.meetingTypeLabel} · ${meeting.companyName ?? 'No company'}`,
            href: routes.meeting({ workspaceId, meetingId: meeting.id }),
          }));
        const open = data.tasks
          .filter((task) => task.workspaceId === workspaceId && isOpenStatus(task.status))
          .sort((left, right) => (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'))
          .slice(0, Math.max(0, limit - hits.length));
        for (const task of open)
          hits.push({
            kind: 'task',
            id: task.id,
            title: task.title,
            subtitle: `Open task · ${task.ownerLabel}${task.dueDate ? ` · due ${task.dueDate}` : ''}`,
            href: routes.meetingTab({ workspaceId, meetingId: task.meetingId, tab: 'tasks' }),
          });
        return hits;
      },
    },
    settings: {
      async get(workspaceId) {
        inWorkspace(workspaceId);
        return data.settings;
      },
      async vocabulary(workspaceId) {
        inWorkspace(workspaceId);
        return data.settings.vocabulary;
      },
      /**
       * Meeting types and vocabulary live in the same cloned workspace record the reads use, which is why a
       * created type shows up in the draft form and in the meetings table at once. `settings.meetingTypes` and
       * `dataset.meetingTypes` are aliases of one array in the fixture dataset — both are updated when they are
       * not, so the write never depends on that aliasing.
       */
      async createMeetingType(raw) {
        requireAction('meetingType.create');
        const input = parseWriteInput(meetingTypeCreateInputSchema, raw);
        inWorkspace(input.workspaceId);
        if (data.meetingTypes.some((type) => type.key === input.key))
          throw new RepositoryError(
            'validation_failed',
            'A meeting type with that key already exists.',
          );
        if (
          data.meetingTypes.some(
            (type) =>
              type.displayName.toLowerCase() === input.displayName.toLowerCase() && type.active,
          )
        )
          throw new RepositoryError(
            'validation_failed',
            'An active meeting type already uses that name.',
          );
        const created = {
          id: nextId('meeting_type'),
          workspaceId: input.workspaceId,
          key: input.key,
          displayName: input.displayName,
          sortOrder: data.meetingTypes.reduce((max, type) => Math.max(max, type.sortOrder), -1) + 1,
          builtIn: false,
          active: true,
        };
        pushMeetingType(created);
        return [...data.meetingTypes];
      },
      async updateMeetingType(meetingTypeId, raw) {
        requireAction('meetingType.update');
        const type = data.meetingTypes.find((item) => item.id === meetingTypeId);
        if (!type)
          throw new RepositoryError('not_found', 'Unknown meeting type.', {
            detail: meetingTypeId,
          });
        const input = parseWriteInput(meetingTypeUpdateInputSchema, raw);
        if (input.displayName) type.displayName = input.displayName;
        if (input.sortOrder !== undefined) type.sortOrder = input.sortOrder;
        if (input.active !== undefined) {
          const used = data.meetings.some(
            (meeting) => meeting.meetingTypeId === type.id && meeting.state !== 'draft',
          );
          if (!input.active && used)
            throw new RepositoryError(
              'validation_failed',
              'Recorded meetings already use this type, so it cannot be disabled. Finish with them or rename it.',
            );
          type.active = input.active;
        }
        return [...data.meetingTypes];
      },
      async createVocabulary(raw) {
        requireAction('vocabulary.create');
        const input = parseWriteInput(vocabularyCreateInputSchema, raw);
        inWorkspace(input.workspaceId);
        if (
          data.settings.vocabulary.some(
            (item) =>
              item.scope === input.scope && item.term.toLowerCase() === input.term.toLowerCase(),
          )
        )
          throw new RepositoryError(
            'validation_failed',
            'That term is already in this scope. Edit it instead of adding a duplicate.',
          );
        const term: VocabularyTerm = {
          id: nextId('vocabulary'),
          workspaceId: input.workspaceId,
          term: input.term,
          ...(input.context ? { context: input.context } : {}),
          scope: input.scope,
          companyId: input.scope === 'company' ? input.companyId : null,
          meetingId: input.scope === 'meeting' ? input.meetingId : null,
          enabled: input.enabled,
        };
        data.settings.vocabulary.push(term);
        return [...data.settings.vocabulary];
      },
      async updateVocabulary(termId, raw) {
        requireAction('vocabulary.update');
        const term = data.settings.vocabulary.find((item) => item.id === termId);
        if (!term)
          throw new RepositoryError('not_found', 'Unknown vocabulary term.', { detail: termId });
        const input = parseWriteInput(vocabularyUpdateInputSchema, raw);
        if (input.term) term.term = input.term;
        if (input.context !== undefined) {
          if (input.context) term.context = input.context;
          else delete term.context;
        }
        if (input.enabled !== undefined) term.enabled = input.enabled;
        return [...data.settings.vocabulary];
      },
      async deleteVocabulary(termId) {
        requireAction('vocabulary.delete');
        if (!data.settings.vocabulary.some((item) => item.id === termId))
          throw new RepositoryError('not_found', 'Unknown vocabulary term.', { detail: termId });
        const index = data.settings.vocabulary.findIndex((item) => item.id === termId);
        if (index >= 0) data.settings.vocabulary.splice(index, 1);
        return [...data.settings.vocabulary];
      },
    },
    desktop: {
      async status() {
        return {
          state: 'not_validated' as const,
          detail:
            'The desktop recorder exists in this repository but has not been validated on macOS, and this web build has no native bridge. Nothing has been recorded from here.',
          deepLink: 'suhbat://record',
        };
      },
    },
  };
}
