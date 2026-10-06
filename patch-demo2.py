p = 'packages/product/src/demo/repositories.ts'
s = open(p).read()

# imports fix: bring in every write schema used above
old = """import { entityListFilterSchema, parseWriteInput, toIsoInstant } from '../writes';
import type { EntityListFilter } from '../writes';"""
new = """import {
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
import type { EntityListFilter } from '../writes';"""
assert old in s
s = s.replace(old, new, 1)

# ---------- meetings: draft lifecycle (inserted before advanceDemoState)
old = """      async advanceDemoState(meetingId) {"""
new = """      /**
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
          throw new RepositoryError('not_allowed', 'That company is archived. Reactivate it first.');
        const project = input.projectId ? projectOrThrow(input.projectId) : null;
        if (project && company && project.companyId && project.companyId !== company.id)
          throw new RepositoryError(
            'not_allowed',
            `That project belongs to ${
              data.companies.find((item) => item.id === project.companyId)?.name ?? 'another company'
            }, not ${company.name}.`,
          );
        const occurredAt = toIsoInstant(
          input.occurredAt,
          `${data.todayIsoDate}T09:00:00.000Z`,
        );
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
        const detail = draftDetail(summary, input.notes ?? null);
        data.details[summary.id] = detail;
        data.transcripts[summary.id] = {
          meetingId: summary.id,
          segments: [],
          topics: [],
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
          throw new RepositoryError('validation_failed', 'Choose a meeting type that is still active.');
        const company = input.companyId ? companyOrThrow(input.companyId) : null;
        const project = input.projectId ? projectOrThrow(input.projectId) : null;
        if (project && company && project.companyId && project.companyId !== company.id)
          throw new RepositoryError('not_allowed', 'That project belongs to a different company.');
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
        const participantIds = toIdList(input.participantIds);
        if (participantIds.length > 0 || input.participantIds.length > 0)
          meeting.participants = participantIds.map(participantOf);
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
            'not_allowed',
            'This draft already has transcript or analysis records; it cannot be deleted.',
          );
        data.meetings = data.meetings.filter((item) => item.id !== meetingId);
        delete data.details[meetingId];
        delete data.transcripts[meetingId];
        delete data.topicsByMeeting[meetingId];
        delete data.processing[meetingId];
        return { id: meetingId };
      },
      async advanceDemoState(meetingId) {"""
assert old in s
s = s.replace(old, new, 1)

# ---------- transcripts: windowed read
old = """    transcripts: {
      async forMeeting(meetingId) {
        return transcriptsFor(meetingId);
      },"""
new = """    transcripts: {
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
        return windowTranscript(
          transcript.segments,
          readTranscriptWindowRequest(request),
          { totalMs: transcript.totalMs, wordCount: transcript.wordCount },
        );
      },"""
assert old in s
s = s.replace(old, new, 1)

# speaker mapping: validate through the shared contract
old = """      async confirmSpeakerMapping({ meetingId, label, personId }) {
        const transcript = transcriptsFor(meetingId);"""
new = """      async confirmSpeakerMapping(raw) {
        requireAction('transcript.speakerMapping');
        const { meetingId, label, personId } = parseWriteInput(speakerMappingCommitSchema, raw);
        const transcript = transcriptsFor(meetingId);"""
assert old in s
s = s.replace(old, new, 1)
# keep segments' display name in step with the assignment, and persist the mapping the same way
old = """        transcript.segments = transcript.segments.map((segment) =>
          segment.speakerLabel === label ? { ...segment, speakerPersonId: personId } : segment,
        );"""
new = """        transcript.segments = transcript.segments.map((segment) =>
          segment.speakerLabel === label
            ? { ...segment, speakerPersonId: personId, speakerName: personName(personId) }
            : segment,
        );
        for (const meeting of data.meetings)
          if (meeting.id === meetingId)
            meeting.participants = meeting.participants.map((participant) =>
              participant.personId === personId
                ? { ...participant, mapped: true, spokeInMeeting: true }
                : participant,
            );"""
assert old in s
s = s.replace(old, new, 1)

# ---------- search: recent records for the empty state
old = """        return hits.slice(0, 12);
      },
    },
    settings: {"""
new = """        return hits.slice(0, 12);
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
          .sort((left, right) =>
            (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'),
          )
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
    settings: {"""
assert old in s
s = s.replace(old, new, 1)

# ---------- settings: meeting types + vocabulary CRUD
old = """      async vocabulary(workspaceId) {
        inWorkspace(workspaceId);
        return data.settings.vocabulary;
      },
      // No `createMeetingType`: the demo adapter cannot persist a new meeting type, and the UI says exactly that.
    },"""
new = """      async vocabulary(workspaceId) {
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
          throw new RepositoryError('not_allowed', 'A meeting type with that key already exists.');
        if (
          data.meetingTypes.some(
            (type) =>
              type.displayName.toLowerCase() === input.displayName.toLowerCase() && type.active,
          )
        )
          throw new RepositoryError('not_allowed', 'An active meeting type already uses that name.');
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
          throw new RepositoryError('not_found', 'Unknown meeting type.', { detail: meetingTypeId });
        const input = parseWriteInput(meetingTypeUpdateInputSchema, raw);
        if (input.displayName) type.displayName = input.displayName;
        if (input.sortOrder !== undefined) type.sortOrder = input.sortOrder;
        if (input.active !== undefined) {
          const used = data.meetings.some(
            (meeting) =>
              meeting.meetingTypeId === type.id && meeting.state !== 'draft',
          );
          if (!input.active && used)
            throw new RepositoryError(
              'not_allowed',
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
            (item) => item.scope === input.scope && item.term.toLowerCase() === input.term.toLowerCase(),
          )
        )
          throw new RepositoryError(
            'not_allowed',
            'That term is already in this scope. Edit it instead of adding a duplicate.',
          );
        const term: VocabularyTerm = {
          id: nextId('vocabulary'),
          workspaceId: input.workspaceId,
          term: input.term,
          ...(input.context ? { context: input.context } : {}),
          scope: input.scope,
          companyId: input.scope === 'company' ? input.companyId : null,
          enabled: input.enabled,
        };
        data.settings.vocabulary.push(term);
        return [...data.settings.vocabulary];
      },
      async updateVocabulary(termId, raw) {
        requireAction('vocabulary.update');
        const term = data.settings.vocabulary.find((item) => item.id === termId);
        if (!term) throw new RepositoryError('not_found', 'Unknown vocabulary term.', { detail: termId });
        const input = parseWriteInput(vocabularyUpdateInputSchema, raw);
        if (input.term) term.term = input.term;
        if (input.context) term.context = input.context;
        else if (input.context === null) delete term.context;
        if (input.enabled !== undefined) term.enabled = input.enabled;
        return [...data.settings.vocabulary];
      },
      async deleteVocabulary(termId) {
        requireAction('vocabulary.delete');
        if (!data.settings.vocabulary.some((item) => item.id === termId))
          throw new RepositoryError('not_found', 'Unknown vocabulary term.', { detail: termId });
        data.settings.vocabulary = data.settings.vocabulary.filter((item) => item.id !== termId);
        return [...data.settings.vocabulary];
      },
    },"""
assert old in s
s = s.replace(old, new, 1)

# `pushMeetingType` helper + a name/initials helper for invitees, next to the other write helpers
old = """  const emptyIntelligence = (companyId: string) => ({"""
new = """  const pushMeetingType = (type: (typeof data.meetingTypes)[number]) => {
    if (!data.meetingTypes.includes(type)) data.meetingTypes.push(type);
    if (data.settings.meetingTypes !== data.meetingTypes) data.settings.meetingTypes.push(type);
  };

  /** Display name for an address nobody has a profile for yet: the local part, tidied — not an invention. */
  const nameFromEmail = (email: string) => {
    const local = email.split('@')[0] ?? email;
    const words = local
      .replace(/[._-]+/g, ' ')
      .replace(/\\d+$/, '')
      .trim()
      .split(/\\s+/)
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

  const emptyIntelligence = (companyId: string) => ({"""
assert old in s
s = s.replace(old, new, 1)

open(p, 'w').write(s)
print('phase 2 done')
