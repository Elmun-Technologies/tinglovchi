import re

# ---------------------------------------------------------------- domain.ts: reuse speakerMappingSchema
p = 'packages/product/src/domain.ts'
s = open(p).read()

speaker_block = """/** Speaker label → person, as stored. `personId === null` means the label is still unclaimed. */
export const speakerMappingSchema = z.object({
  label: z.string().min(1),
  personId: idSchema.nullable(),
  confirmed: z.boolean().default(false),
  segmentCount: z.number().int().nonnegative(),
});
export type SpeakerMapping = z.infer<typeof speakerMappingSchema>;

"""
assert speaker_block in s
s = s.replace(speaker_block, '', 1)

old_mappings = """  speakerMappings: z
    .array(
      z.object({
        label: z.string().min(1),
        personId: idSchema.nullable(),
        confirmed: z.boolean().default(false),
        segmentCount: z.number().int().nonnegative(),
      }),
    )
    .default([]),"""
new_mappings = """  /** Persisted diarization-label → person assignments; `personId === null` means still unclaimed. */
  speakerMappings: z.array(speakerMappingSchema).default([]),"""
assert old_mappings in s

# Insert speakerMappingSchema just before meetingTranscriptSchema, and drop the duplicate below.
anchor = "/** Persisted label → person assignments"
marker = 'export const meetingTranscriptSchema'
idx = s.find(marker)
assert idx > 0
s = s[:idx] + speaker_block + s[idx:]
s = s.replace(old_mappings, new_mappings, 1)

open(p, 'w').write(s)

# ---------------------------------------------------------------- demo/repositories.ts
p = 'packages/product/src/demo/repositories.ts'
s = open(p).read()

# imports
old_imports = """import type {
  CompanyOverview,
  MeetingProcessingState,"""
new_imports = """import type {
  Company,
  CompanyOverview,
  MeetingDetail,
  MeetingProcessingState,"""
assert old_imports in s
s = s.replace(old_imports, new_imports, 1)

old_tail = """  Topic,
  TranscriptSegment,
} from '../domain';
import {
  compareTasks,
  filterKnowledge,
  filterMeetings,
  filterTasks,
  isTaskOverdue,
  routes,
} from '../query';"""
new_tail = """  Topic,
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
import { entityListFilterSchema, parseWriteInput, toIsoInstant } from '../writes';
import type { EntityListFilter } from '../writes';"""
assert old_tail in s
s = s.replace(old_tail, new_tail, 1)

# capabilities: demo can write, in memory only
old_caps = """export const DEMO_CAPABILITIES: DataCapabilities = {
  mode: 'demo',
  reads: 'demo',
  writes: false,
  pipeline: 'simulated',
  demoStateTransitions: true,
  playback: 'none',
  provenanceLabel: 'Typed demo fixtures in @suhbat/product/demo — no database, no network',
};"""
new_caps = """export const DEMO_CAPABILITIES: DataCapabilities = {
  mode: 'demo',
  reads: 'demo',
  // The demo adapter writes — to its own in-memory copy of the dataset. `persistence` is what makes that
  // honest: every form states that a restart discards the change, and no screen claims a cloud save.
  writes: true,
  pipeline: 'simulated',
  demoStateTransitions: true,
  playback: 'none',
  persistence: 'in_memory',
  persistenceLabel: 'In memory for this demo session only — reloading the page restores the fixture data.',
  actions: demoWriteActions,
  provenanceLabel: 'Typed demo fixtures in @suhbat/product/demo — no database, no network',
};

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
};"""
assert old_caps in s
s = s.replace(old_caps, new_caps, 1)

s = s.replace(
    """import {
  RepositoryError,
  type DataCapabilities,""",
    """import {
  RepositoryError,
  can,
  writeActions,
  type DataCapabilities,
  type WriteActionKey,""",
    1,
)

# helpers right before `return {` of the factory: find the `const capabilities` line
helper_anchor = """  return {
    capabilities,"""
assert helper_anchor in s
helpers = """  /* ------------------------------------------------------------------ writes
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

  const keeps = (filter: EntityListFilter | undefined): boolean =>
    entityListFilterSchema.safeParse(filter ?? {}).success;
  const matchesListFilter = <T extends { name: string; status: string }>(
    item: T,
    filter: EntityListFilter | undefined,
  ) => {
    if (!filter?.includeArchived && item.status === 'archived') return false;
    const needle = (filter?.query ?? '').trim().toLowerCase();
    return needle === '' || item.name.toLowerCase().includes(needle);
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
        'not_allowed',
        'Only an unrecorded draft can be edited this way; a meeting with a transcript is corrected in its records.',
        { detail: meetingId },
      );
    return meeting;
  };

  const requireAction = (action: WriteActionKey) => {
    if (!can(capabilities, action))
      throw new RepositoryError(
        'unsupported_in_demo',
        'This build cannot perform that action.',
        { detail: action },
      );
  };

"""
s = s.replace(helper_anchor, helpers + helper_anchor, 1)

# workspaces: roster + rename + invite/role/remove
old_ws = """      async currentPersonId(workspaceId) {
        inWorkspace(workspaceId);
        return data.currentPersonId;
      },
    },"""
new_ws = """      async currentPersonId(workspaceId) {
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
          throw new RepositoryError('not_allowed', 'That address has already been invited.');
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
            'not_allowed',
            'The owner role is transferred by an owner, not from this screen.',
          );
        const owners = data.settings.members.filter((item) => item.role === 'owner');
        if (input.role !== 'owner' && owners.length === 1)
          throw new RepositoryError('not_allowed', 'A workspace needs at least one owner.');
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
          throw new RepositoryError('not_allowed', 'The workspace owner cannot be removed.');
        const owned = data.tasks.filter(
          (task) => task.ownerPersonId === input.personId && isOpenStatus(task.status),
        );
        if (owned.length > 0)
          throw new RepositoryError(
            'not_allowed',
            `${owned.length} open ${owned.length === 1 ? 'task is' : 'tasks are'} still assigned to ${member.name}. Reassign them first.`,
          );
        data.settings.members = data.settings.members.filter(
          (item) => item.personId !== input.personId,
        );
        return data.settings.members.map(memberView);
      },
    },"""
assert old_ws in s
s = s.replace(old_ws, new_ws, 1)

# companies
old_co = """    companies: {
      async list(workspaceId) {
        inWorkspace(workspaceId);
        return data.companies;
      },
      async get(companyId) {
        return companyOrThrow(companyId);
      },
      async overview(workspaceId) {
        inWorkspace(workspaceId);
        const overview: CompanyOverview[] = data.companies.map((company) => {"""
new_co = """    companies: {
      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        if (!keeps(filter))
          throw new RepositoryError('validation_failed', 'The company list filter is malformed.');
        return data.companies.filter((company) => matchesListFilter(company, filter));
      },
      async get(companyId) {
        return companyOrThrow(companyId);
      },
      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        const visible = data.companies.filter((company) => matchesListFilter(company, filter));
        const overview: CompanyOverview[] = visible.map((company) => {"""
assert old_co in s
s = s.replace(old_co, new_co, 1)

old_intel = """      async intelligence(companyId) {
        const record = data.intelligence[companyId];
        if (!record) throw new RepositoryError('not_found', 'No company summary for that company.');
        return record;
      },
      // `create` is intentionally absent: demo data is read-only, and the UI says so instead of faking a save.
    },"""
new_intel = """      async intelligence(companyId) {
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
            'not_allowed',
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
            'not_allowed',
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
        return company;
      },
    },"""
assert old_intel in s
s = s.replace(old_intel, new_intel, 1)

# projects
old_pr = """    projects: {
      async list(workspaceId) {
        inWorkspace(workspaceId);
        return data.projects;
      },
      async get(projectId) {
        return projectOrThrow(projectId);
      },
      async overview(workspaceId) {
        inWorkspace(workspaceId);
        return data.projects.map<ProjectOverview>((project) => {"""
new_pr = """    projects: {
      async list(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        if (!keeps(filter))
          throw new RepositoryError('validation_failed', 'The project list filter is malformed.');
        return data.projects.filter((project) => matchesListFilter(project, filter));
      },
      async get(projectId) {
        return projectOrThrow(projectId);
      },
      async overview(workspaceId, filter?: EntityListFilter) {
        inWorkspace(workspaceId);
        return data.projects
          .filter((project) => matchesListFilter(project, filter))
          .map<ProjectOverview>((project) => {"""
assert old_pr in s
s = s.replace(old_pr, new_pr, 1)

# close the map callback + add project writes; anchor on the projects block end
old_pr_end = """            lastActivityAt:
              meetings
                .map((meeting) => meeting.occurredAt)
                .sort()
                .at(-1) ??
              project.lastActivityAt ??
              null,
          };
        });
      },
    },"""
new_pr_end = """              lastActivityAt:
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
            'not_allowed',
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
              meeting.projectId === project.id && meeting.companyId && meeting.companyId !== company.id,
          );
          if (foreign.length > 0)
            throw new RepositoryError(
              'not_allowed',
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
    },"""
assert old_pr_end in s
s = s.replace(old_pr_end, new_pr_end, 1)

open(p, 'w').write(s)
print('phase 1 done')
