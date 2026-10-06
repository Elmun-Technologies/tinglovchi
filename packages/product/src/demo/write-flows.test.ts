import { describe, expect, it } from 'vitest';
import { createDemoRepositories } from './repositories';
import { demoDataset } from './dataset';
import { RepositoryError, writeActions, can } from '../repositories';
import { routes, windowTranscript, readTranscriptWindowRequest, windowRangeLabel } from '../query';
import { DEMO_WORKSPACE_ID, person as personIds } from './ids';

/**
 * The write flows, tested at the adapter — which is where their meaning lives. A form that shows a success
 * message while the record did not change, or a list that keeps showing an archived company, is a data bug, not
 * a rendering bug; these assertions are what the UI is allowed to rely on.
 */

const workspaceId = DEMO_WORKSPACE_ID;
const flagshipId = 'meeting_foodera_marketing_strategy';
const nomadId = 'meeting_nomad_q3_pipeline';

function adapter() {
  return createDemoRepositories(demoDataset);
}

function firstOpenTaskOwner() {
  const task = demoDataset.tasks.find(
    (item) => item.status === 'open' || item.status === 'in_progress' || item.status === 'blocked',
  )!;
  return task.ownerPersonId;
}

describe('company writes', () => {
  it('creates a company that is immediately readable, empty, and honest about having no history', async () => {
    const repositories = adapter();
    const before = await repositories.companies.list(workspaceId);
    const created = await repositories.companies.create!({
      workspaceId,
      name: '  Nudge Studio  ',
      description: '  ',
    });
    expect(created.name).toBe('Nudge Studio');
    expect(created.status).toBe('active');
    const after = await repositories.companies.list(workspaceId);
    expect(after.length).toBe(before.length + 1);
    const overview = (await repositories.companies.overview(workspaceId)).find(
      (row) => row.company.id === created.id,
    )!;
    expect(overview.meetingCount).toBe(0);
    expect(overview.openTaskCount).toBe(0);
    expect(overview.lastMeetingAt).toBeNull();
    // A brand-new company has no intelligence; an empty derived record states that instead of erroring.
    const intelligence = await repositories.companies.intelligence(created.id);
    expect(intelligence.companyId).toBe(created.id);
    expect(intelligence.importantFacts).toEqual([]);
    expect(intelligence.derivedFrom).toBe('demo_fixtures');
  });

  it('refuses a duplicate name and leaves the list untouched', async () => {
    const repositories = adapter();
    const before = await repositories.companies.list(workspaceId);
    await expect(
      repositories.companies.create!({
        workspaceId,
        name: before[0]!.name,
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /already exists/i });
    expect(await repositories.companies.list(workspaceId)).toHaveLength(before.length);
  });

  it('renames a company where its meetings point at it, and archives it out of the default list only', async () => {
    const repositories = adapter();
    const company = (await repositories.companies.list(workspaceId)).find((item) =>
      demoDataset.meetings.some((meeting) => meeting.companyId === item.id),
    )!;
    const renamed = await repositories.companies.update!(company.id, {
      name: 'Renamed Co',
      description: 'Updated note',
    });
    expect(renamed.description).toBe('Updated note');
    const meetings = await repositories.meetings.list(workspaceId);
    const linked = meetings.filter((row) => row.meeting.companyId === company.id);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((row) => row.meeting.companyName === 'Renamed Co')).toBe(true);

    await repositories.companies.setArchived!(company.id, true);
    const visible = await repositories.companies.list(workspaceId);
    expect(visible.some((item) => item.id === company.id)).toBe(false);
    const withArchived = await repositories.companies.list(workspaceId, {
      includeArchived: true,
    });
    expect(withArchived.some((item) => item.id === company.id)).toBe(true);
    // A lookup still resolves an archived company: history must not lose its subject.
    expect((await repositories.companies.get(company.id)).status).toBe('archived');
    // The meeting that references it is unchanged and still names it.
    expect(linked[0]!.meeting.title).toBe(
      demoDataset.meetings.find((meeting) => meeting.id === linked[0]!.meeting.id)!.title,
    );
    expect(await repositories.companies.intelligence(company.id)).toBeTruthy();
  });

  it('filters by query and keeps archived records reachable only when asked', async () => {
    const repositories = adapter();
    const all = await repositories.companies.list(workspaceId, { includeArchived: true });
    const target = all[0]!;
    const found = await repositories.companies.list(workspaceId, {
      query: target.name.slice(0, 4),
    });
    expect(found.some((item) => item.id === target.id)).toBe(true);
    expect(await repositories.companies.list(workspaceId, { query: 'zzzz-no-such-name' })).toEqual(
      [],
    );
    await expect(
      repositories.companies.list(workspaceId, { includeArchived: 'yes' as unknown as boolean }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('project writes', () => {
  it('creates a project under a company and shows it in the overview with its company name', async () => {
    const repositories = adapter();
    const company = (await repositories.companies.list(workspaceId))[0]!;
    const created = await repositories.projects.create!({
      workspaceId,
      name: 'Renewal motion',
      companyId: company.id,
      description: null,
    });
    const overview = (await repositories.projects.overview(workspaceId)).find(
      (row) => row.project.id === created.id,
    )!;
    expect(overview.companyName).toBe(company.name);
    expect(overview.meetingCount).toBe(0);
  });

  it('refuses to re-parent a project whose meetings belong to another company', async () => {
    const repositories = adapter();
    const meeting = demoDataset.meetings.find((item) => item.projectId && item.companyId)!;
    const other = (await repositories.companies.list(workspaceId)).find(
      (item) => item.id !== meeting.companyId,
    )!;
    await expect(
      repositories.projects.update!(meeting.projectId!, {
        name: 'Moved project',
        companyId: other.id,
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /another company/i });
  });

  it('closing a project hides it from the default list', async () => {
    const repositories = adapter();
    const project = (await repositories.projects.list(workspaceId))[0]!;
    await repositories.projects.setArchived!(project.id, true);
    const visible = await repositories.projects.list(workspaceId);
    expect(visible.some((item) => item.id === project.id)).toBe(false);
    expect((await repositories.projects.get(project.id)).status).toBe('closed');
  });
});

describe('meeting draft lifecycle', () => {
  it('creates a draft that promises nothing: no transcript, no recording, no counts', async () => {
    const repositories = adapter();
    const meetingType = (await repositories.meetings.meetingTypes(workspaceId)).find(
      (type) => type.active,
    )!;
    const company = (await repositories.companies.list(workspaceId))[0]!;
    const created = await repositories.meetings.createDraft!({
      workspaceId,
      title: 'Renewal conversation prep',
      meetingTypeId: meetingType.id,
      companyId: company.id,
      projectId: null,
      participantIds: [demoDataset.currentPersonId],
      occurredAt: '2026-10-12',
      durationMinutes: 30,
      notes: 'Bring the churn numbers.',
    });
    expect(created.state).toBe('draft');
    expect(created.origin).toBe('draft');
    expect(created.capturedMs).toBeNull();
    expect(created.recordingAvailable).toBe(false);
    expect(created.counts.segments).toBe(0);
    expect(created.participants[0]!.spokeInMeeting).toBe(false);

    const rows = await repositories.meetings.list(workspaceId, { state: 'draft' });
    expect(rows.map((row) => row.meeting.id)).toContain(created.id);

    const detail = await repositories.meetings.detail(created.id);
    expect(detail.recording.available).toBe(false);
    expect(detail.recording.source).toBe('none');
    expect(detail.recording.note).toMatch(/draft only/i);
    expect(detail.executiveSummary).toEqual(['Bring the churn numbers.']);
    expect(detail.stats.words).toBe(0);
    expect(detail.processing?.steps.map((step) => step.state)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);

    // A draft has no transcript to page through, and the windowed read says so rather than failing.
    const window = await repositories.transcripts.window({ meetingId: created.id });
    expect(window.segments).toEqual([]);
    expect(window.totalCount).toBe(0);
    expect(windowRangeLabel(window)).toBe('no matching lines');

    // Advancing a draft is refused: there is nothing recorded to push through a pipeline.
    await expect(repositories.meetings.advanceDemoState!(created.id)).rejects.toMatchObject({
      code: 'unsupported_in_demo',
    });
  });

  it('refuses an inactive meeting type and a project from another company', async () => {
    const repositories = adapter();
    const types = await repositories.meetings.meetingTypes(workspaceId);
    const inactive = types.find((type) => !type.active) ?? null;
    if (inactive)
      await expect(
        repositories.meetings.createDraft!({
          workspaceId,
          title: 'Bad type draft',
          meetingTypeId: inactive.id,
          companyId: null,
          projectId: null,
          participantIds: [],
          notes: null,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    const meeting = demoDataset.meetings.find((item) => item.projectId && item.companyId)!;
    const other = (await repositories.companies.list(workspaceId)).find(
      (item) => item.id !== meeting.companyId,
    )!;
    await expect(
      repositories.meetings.createDraft!({
        workspaceId,
        title: 'Mismatched draft',
        meetingTypeId: types.find((type) => type.active)!.id,
        companyId: other.id,
        projectId: meeting.projectId,
        participantIds: [],
        notes: null,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /belongs to/i });
  });

  it('edits a draft and refuses to edit a meeting that has been recorded', async () => {
    const repositories = adapter();
    const type = (await repositories.meetings.meetingTypes(workspaceId)).find(
      (item) => item.active,
    )!;
    const draft = await repositories.meetings.createDraft!({
      workspaceId,
      title: 'Original title',
      meetingTypeId: type.id,
      companyId: null,
      projectId: null,
      participantIds: [],
      notes: null,
    });
    const renamed = await repositories.meetings.updateDraft!(draft.id, {
      title: 'Retitled draft',
      meetingTypeId: type.id,
      companyId: null,
      projectId: null,
      participantIds: [],
      notes: 'Shorter agenda',
    });
    expect(renamed.title).toBe('Retitled draft');
    expect((await repositories.meetings.detail(draft.id)).executiveSummary).toEqual([
      'Shorter agenda',
    ]);
    await expect(
      repositories.meetings.updateDraft!(flagshipId, {
        title: 'Rewriting history',
        meetingTypeId: type.id,
        companyId: null,
        projectId: null,
        participantIds: [],
        notes: null,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /unrecorded draft/i });
    await expect(repositories.meetings.deleteDraft!(flagshipId)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    // The flagship meeting survives the refused delete, with its transcript intact.
    expect((await repositories.transcripts.forMeeting(flagshipId)).segments.length).toBeGreaterThan(
      0,
    );
  });

  it('deletes only a draft, and the delete is visible in every read', async () => {
    const repositories = adapter();
    const type = (await repositories.meetings.meetingTypes(workspaceId)).find(
      (item) => item.active,
    )!;
    const draft = await repositories.meetings.createDraft!({
      workspaceId,
      title: 'Deleted before it happened',
      meetingTypeId: type.id,
      companyId: null,
      projectId: null,
      participantIds: [],
      notes: null,
    });
    expect(await repositories.meetings.detail(draft.id)).toBeTruthy();
    expect(await repositories.meetings.deleteDraft!(draft.id)).toEqual({ id: draft.id });
    await expect(repositories.meetings.detail(draft.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const rows = await repositories.meetings.list(workspaceId);
    expect(rows.some((row) => row.meeting.id === draft.id)).toBe(false);
    await expect(repositories.meetings.deleteDraft!(draft.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keeps the home screen in step with created and removed drafts', async () => {
    const repositories = adapter();
    const before = await repositories.meetings.dashboard(workspaceId);
    const type = (await repositories.meetings.meetingTypes(workspaceId)).find(
      (item) => item.active,
    )!;
    const draft = await repositories.meetings.createDraft!({
      workspaceId,
      title: 'Draft that shows up at home',
      meetingTypeId: type.id,
      companyId: null,
      projectId: null,
      participantIds: [],
      occurredAt: demoDataset.todayIsoDate,
      notes: null,
    });
    const after = await repositories.meetings.dashboard(workspaceId);
    expect(after.meetingCount).toBe(before.meetingCount + 1);
    expect(after.todayMeetings.map((item) => item.id)).toContain(draft.id);
    expect(after.upcomingOrToday.map((item) => item.id)).toContain(draft.id);
    await repositories.meetings.deleteDraft!(draft.id);
    expect((await repositories.meetings.dashboard(workspaceId)).meetingCount).toBe(
      before.meetingCount,
    );
  });
});

describe('settings writes', () => {
  it('creates a meeting type that every reader sees, and refuses a duplicate key', async () => {
    const repositories = adapter();
    const created = await repositories.settings.createMeetingType!({
      workspaceId,
      key: 'partner_sync',
      displayName: 'Partner sync',
    });
    const inSettings = (await repositories.settings.get(workspaceId)).meetingTypes;
    const inMeetingForm = await repositories.meetings.meetingTypes(workspaceId);
    expect(inSettings.map((item) => item.id)).toContain(
      created.find((item) => item.key === 'partner_sync')!.id,
    );
    expect(inMeetingForm.map((item) => item.key)).toContain('partner_sync');
    expect(inSettings).toBe(inMeetingForm);
    await expect(
      repositories.settings.createMeetingType!({
        workspaceId,
        key: 'partner_sync',
        displayName: 'Partner sync 2',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /key already exists/i });
  });

  it('renames and disables a type, but not while recorded meetings use it', async () => {
    const repositories = adapter();
    const used = demoDataset.meetings.find((meeting) => meeting.state === 'ready')!;
    await expect(
      repositories.settings.updateMeetingType!(used.meetingTypeId, { active: false }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /cannot be disabled/i });
    const type = (await repositories.meetings.meetingTypes(workspaceId)).find(
      (item) =>
        !demoDataset.meetings.some(
          (meeting) => meeting.meetingTypeId === item.id && meeting.state !== 'draft',
        ),
    )!;
    const updated = await repositories.settings.updateMeetingType!(type.id, {
      displayName: 'Renamed type',
    });
    expect(updated.find((item) => item.id === type.id)!.displayName).toBe('Renamed type');
    expect(await repositories.settings.updateMeetingType!(type.id, { active: false })).toBeTruthy();
    expect((await repositories.settings.get(workspaceId)).meetingTypes).toHaveLength(
      updated.length,
    );
  });

  it('creates, toggles and deletes a vocabulary term, and remembers the meeting a scoped term belongs to', async () => {
    const repositories = adapter();
    const created = await repositories.settings.createVocabulary!({
      workspaceId,
      term: '  tinglovchi ',
      context: 'Product name; stress on the second syllable.',
      scope: 'meeting',
      companyId: null,
      meetingId: flagshipId,
      enabled: true,
    });
    const term = created.find((item) => item.term === 'tinglovchi')!;
    expect(term.meetingId).toBe(flagshipId);
    expect(term.scope).toBe('meeting');
    expect((await repositories.settings.vocabulary(workspaceId)).map((item) => item.id)).toContain(
      term.id,
    );
    await expect(
      repositories.settings.createVocabulary!({
        workspaceId,
        term: 'tinglovchi',
        context: null,
        scope: 'meeting',
        companyId: null,
        meetingId: flagshipId,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /already in this scope/i });

    const toggled = await repositories.settings.updateVocabulary!(term.id, { enabled: false });
    expect(toggled.find((item) => item.id === term.id)!.enabled).toBe(false);
    const remaining = await repositories.settings.deleteVocabulary!(term.id);
    expect(remaining.some((item) => item.id === term.id)).toBe(false);
    await expect(repositories.settings.deleteVocabulary!(term.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('renames the workspace for every reader', async () => {
    const repositories = adapter();
    const renamed = await repositories.workspaces.rename!({
      workspaceId,
      name: 'Elmun Consulting',
    });
    expect(renamed.name).toBe('Elmun Consulting');
    expect((await repositories.workspaces.list())[0]!.name).toBe('Elmun Consulting');
    expect((await repositories.settings.get(workspaceId)).workspaceName).toBe('Elmun Consulting');
    await expect(
      repositories.workspaces.rename!({ workspaceId, name: 'x' }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('member roster writes', () => {
  it('reports the roster with real workload, not just a name list', async () => {
    const repositories = adapter();
    const owner = firstOpenTaskOwner();
    const members = await repositories.workspaces.members(workspaceId);
    const row = members.find((item) => item.personId === owner)!;
    expect(row.openTaskCount).toBeGreaterThan(0);
    expect(row.meetingCount).toBeGreaterThanOrEqual(0);
    expect(members.some((item) => item.role === 'owner')).toBe(true);
  });

  it('records an invitation as invited, never as active, and refuses a duplicate address', async () => {
    const repositories = adapter();
    const invited = await repositories.workspaces.inviteMember!({
      workspaceId,
      email: '  Advisor.Example@Mail.com ',
      role: 'member',
    });
    expect(invited.status).toBe('invited');
    expect(invited.email).toBe('advisor.example@mail.com');
    expect(invited.name).toBe('Advisor Example');
    const roster = await repositories.workspaces.members(workspaceId);
    expect(roster.filter((item) => item.status === 'invited').length).toBeGreaterThan(1);
    await expect(
      repositories.workspaces.inviteMember!({
        workspaceId,
        email: 'advisor.example@mail.com',
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /already been invited/i });
  });

  it('refuses to demote or remove the owner, and refuses to orphan open tasks', async () => {
    const repositories = adapter();
    const roster = await repositories.workspaces.members(workspaceId);
    const owner = roster.find((item) => item.role === 'owner')!;
    await expect(
      repositories.workspaces.setMemberRole!({
        workspaceId,
        personId: owner.personId,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /owner role/i });
    await expect(
      repositories.workspaces.removeMember!({ workspaceId, personId: owner.personId }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /cannot be removed/i });

    const busy = roster.find((item) => item.role !== 'owner' && item.openTaskCount > 0)!;
    await expect(
      repositories.workspaces.removeMember!({ workspaceId, personId: busy.personId }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: /still assigned to/i });

    const free = roster.find((item) => item.role !== 'owner' && item.openTaskCount === 0)!;
    const after = await repositories.workspaces.removeMember!({
      workspaceId,
      personId: free.personId,
    });
    expect(after.some((item) => item.personId === free.personId)).toBe(false);
    expect(
      (await repositories.workspaces.members(workspaceId)).map((item) => item.personId),
    ).toEqual(after.map((item) => item.personId));
  });

  it('changes a role and keeps the roster consistent', async () => {
    const repositories = adapter();
    const roster = await repositories.workspaces.members(workspaceId);
    const target = roster.find((item) => item.role === 'member')!;
    const updated = await repositories.workspaces.setMemberRole!({
      workspaceId,
      personId: target.personId,
      role: 'admin',
    });
    expect(updated.find((item) => item.personId === target.personId)!.role).toBe('admin');
    expect((await repositories.settings.get(workspaceId)).members).toHaveLength(updated.length);
    const promoted = updated.find((item) => item.personId === target.personId)!;
    expect(promoted.role).toBe('admin');
  });
});

describe('speaker mapping persistence', () => {
  it('assigns a diarization label to a person and leaves the rest of the meeting alone', async () => {
    const repositories = adapter();
    const before = await repositories.transcripts.forMeeting(nomadId);
    const unclaimed = before.speakerMappings.find((mapping) => mapping.personId === null)!;
    expect(unclaimed).toBeTruthy();
    const person = (await repositories.workspaces.members(workspaceId)).find(
      (item) => item.personId !== unclaimed.personId,
    )!;
    const mappings = await repositories.transcripts.confirmSpeakerMapping!({
      meetingId: nomadId,
      label: unclaimed.label,
      personId: person.personId,
    });
    const updated = mappings.find((mapping) => mapping.label === unclaimed.label)!;
    expect(updated.personId).toBe(person.personId);
    expect(updated.confirmed).toBe(true);
    expect(updated.segmentCount).toBe(unclaimed.segmentCount);

    const after = await repositories.transcripts.forMeeting(nomadId);
    const relabelled = after.segments.filter((segment) => segment.speakerLabel === unclaimed.label);
    expect(relabelled.length).toBe(unclaimed.segmentCount);
    expect(relabelled.every((segment) => segment.speakerPersonId === person.personId)).toBe(true);
    // Labels nobody claimed are untouched; one assignment never confirms the whole transcript.
    for (const mapping of after.speakerMappings.filter((item) => item.label !== unclaimed.label)) {
      const previous = before.speakerMappings.find((item) => item.label === mapping.label)!;
      expect(mapping.personId).toBe(previous.personId);
      expect(mapping.confirmed).toBe(previous.confirmed);
    }
    // The meeting detail stops listing that label as unmapped.
    expect((await repositories.meetings.detail(nomadId)).unmappedSpeakers).not.toContain(
      unclaimed.label,
    );
    // Re-mapping the same label to the same person is idempotent.
    const again = await repositories.transcripts.confirmSpeakerMapping!({
      meetingId: nomadId,
      label: unclaimed.label,
      personId: person.personId,
    });
    expect(again.find((mapping) => mapping.label === unclaimed.label)!.segmentCount).toBe(
      unclaimed.segmentCount,
    );
  });

  it('refuses to map a label onto a person outside the workspace', async () => {
    const repositories = adapter();
    const transcript = await repositories.transcripts.forMeeting(nomadId);
    await expect(
      repositories.transcripts.confirmSpeakerMapping!({
        meetingId: nomadId,
        label: transcript.speakerMappings[0]!.label,
        personId: 'person_nobody',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      repositories.transcripts.confirmSpeakerMapping!({
        meetingId: nomadId,
        label: 'Speaker ZZZ',
        personId: personIds.malika,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('transcript windowing', () => {
  it('pages through a long transcript without ever returning the whole thing', async () => {
    const repositories = adapter();
    const full = await repositories.transcripts.forMeeting(flagshipId);
    expect(full.segments.length).toBeGreaterThan(30);
    const first = await repositories.transcripts.window({ meetingId: flagshipId, span: 20 });
    expect(first.segments).toHaveLength(20);
    expect(first.totalCount).toBe(full.segments.length);
    expect(first.filteredCount).toBe(full.segments.length);
    expect(first.hasPrevious).toBe(false);
    expect(first.hasNext).toBe(true);
    expect(first.offset).toBe(0);
    // Totals describe the meeting, not the window.
    expect(first.totalMs).toBe(full.totalMs);
    expect(first.wordCount).toBe(full.wordCount);
    expect(first.segments[0]!.id).toBe(full.segments[0]!.id);

    const second = await repositories.transcripts.window({
      meetingId: flagshipId,
      span: 20,
      offset: 20,
    });
    expect(second.segments[0]!.id).toBe(full.segments[20]!.id);
    expect(windowRangeLabel(second)).toBe(`lines 21–40 of ${full.segments.length}`);

    const last = await repositories.transcripts.window({
      meetingId: flagshipId,
      span: 20,
      offset: 9999,
    });
    expect(last.hasNext).toBe(false);
    expect(last.segments.length).toBeGreaterThan(0);
    expect(last.segments.at(-1)!.id).toBe(full.segments.at(-1)!.id);
  });

  it('filters before paging, so a search and its pager count the same list', async () => {
    const repositories = adapter();
    const speaker = full_person_with_segments();
    const filtered = await repositories.transcripts.window({
      meetingId: flagshipId,
      speaker,
      span: 5,
    });
    expect(filtered.filteredCount).toBeLessThan(filtered.totalCount);
    expect(filtered.segments.length).toBeLessThanOrEqual(5);
    expect(filtered.segments.every((segment) => segment.speakerPersonId === speaker)).toBe(true);
    expect(windowRangeLabel(filtered)).toContain(
      `of ${filtered.filteredCount} of ${filtered.totalCount}`,
    );
  });

  it('matches on query text and on an unmapped label, and reports no matches without failing', async () => {
    const repositories = adapter();
    const transcript = await repositories.transcripts.forMeeting(flagshipId);
    const needle = transcript.segments[3]!.text.split(' ').slice(0, 3).join(' ');
    const found = await repositories.transcripts.window({
      meetingId: flagshipId,
      query: needle,
      span: 10,
    });
    expect(found.filteredCount).toBeGreaterThan(0);
    expect(
      found.segments.every((segment) => segment.text.toLowerCase().includes(needle.toLowerCase())),
    ).toBe(true);
    const none = await repositories.transcripts.window({
      meetingId: flagshipId,
      query: 'qqq-no-such-phrase-zzz',
    });
    expect(none.segments).toEqual([]);
    expect(none.filteredCount).toBe(0);
    expect(none.hasPrevious).toBe(false);
    expect(none.hasNext).toBe(false);
    const label = transcript.speakerMappings.find((mapping) => mapping.personId === null)?.label;
    if (label) {
      const byLabel = await repositories.transcripts.window({
        meetingId: flagshipId,
        speaker: `label:${label}`,
      });
      expect(byLabel.segments.every((segment) => segment.speakerLabel === label)).toBe(true);
    }
  });

  it('pulls a cited line into the window when evidence links into a long transcript', async () => {
    const repositories = adapter();
    const full = await repositories.transcripts.forMeeting(flagshipId);
    const cited = full.segments[Math.floor(full.segments.length * 0.7)]!;
    const jumped = await repositories.transcripts.window({
      meetingId: flagshipId,
      span: 20,
      offset: 0,
      focusSegmentId: cited.id,
    });
    expect(jumped.offset).toBeGreaterThan(0);
    expect(jumped.focusedSegmentId).toBe(cited.id);
    expect(jumped.segments.map((segment) => segment.id)).toContain(cited.id);
    // Already visible: the window stays put and the UI does not claim a jump.
    const stayed = await repositories.transcripts.window({
      meetingId: flagshipId,
      span: 20,
      offset: jumped.offset,
      focusSegmentId: cited.id,
    });
    expect(stayed.offset).toBe(jumped.offset);
    expect(stayed.focusedSegmentId).toBeNull();
    // A cited line from a *different* meeting must not crash or shift anything.
    const elsewhere = await repositories.transcripts.window({
      meetingId: flagshipId,
      focusSegmentId: 'seg_not_in_this_meeting',
    });
    expect(elsewhere.offset).toBe(0);
    expect(elsewhere.focusedSegmentId).toBeNull();
  });

  it('resists a hostile paging request instead of trusting the address bar', () => {
    const segments = demoDataset.transcripts[flagshipId]!.segments;
    expect(() =>
      readTranscriptWindowRequest({ meetingId: flagshipId, span: 9000, offset: -20 }),
    ).not.toThrow();
    const normalized = readTranscriptWindowRequest({
      meetingId: flagshipId,
      span: 9000,
      offset: -20,
    });
    expect(normalized.span).toBeLessThanOrEqual(400);
    const window = windowTranscript(segments, normalized, {
      totalMs: demoDataset.transcripts[flagshipId]!.totalMs,
      wordCount: demoDataset.transcripts[flagshipId]!.wordCount,
    });
    expect(window.span).toBeLessThanOrEqual(400);
    expect(window.offset).toBe(0);
    expect(window.segments.length).toBeGreaterThan(0);
    const garbage = readTranscriptWindowRequest({
      meetingId: flagshipId,
      span: 'wide' as unknown as number,
      offset: 3.5 as unknown as number,
    });
    expect(garbage.span).toBe(120);
    expect(garbage.offset).toBe(0);
  });

  it('is the same window the unfiltered read produces when no request is given', async () => {
    const repositories = adapter();
    const full = await repositories.transcripts.forMeeting(flagshipId);
    const window = await repositories.transcripts.window({ meetingId: flagshipId });
    expect(window.span).toBe(120);
    expect(window.segments).toHaveLength(Math.min(120, full.segments.length));
  });
});

describe('recent records for the search screen', () => {
  it('offers the newest meetings and the soonest open work, all of them resolvable', async () => {
    const repositories = adapter();
    const hits = await repositories.search.recent(workspaceId);
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.filter((hit) => hit.kind === 'meeting').length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.href.startsWith(`/w/${workspaceId}/`))).toBe(true);
    const meetings = hits.filter((hit) => hit.kind === 'meeting');
    expect(meetings.length).toBeLessThanOrEqual(8);
    for (const hit of hits.slice(0, 4)) {
      const meetingId = hit.href.match(/meetings\/([^/?#]+)/)?.[1];
      if (hit.href.includes('/meetings/') && !hit.href.includes('/tasks') && meetingId)
        expect(await repositories.meetings.detail(meetingId)).toBeTruthy();
    }
    const capped = await repositories.search.recent(workspaceId, 3);
    expect(capped).toHaveLength(3);
    await expect(repositories.search.recent('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('routes match the pages the product actually serves', () => {
    expect(routes.newCompany({ workspaceId })).toBe(`/w/${workspaceId}/companies/new`);
    expect(routes.editCompany({ workspaceId, companyId: 'company_1' })).toBe(
      `/w/${workspaceId}/companies/company_1/edit`,
    );
    expect(routes.editMeeting({ workspaceId, meetingId: 'm_1' })).toBe(
      `/w/${workspaceId}/meetings/m_1/edit`,
    );
    expect(routes.exportMeeting({ workspaceId, meetingId: 'm_1', format: 'csv' })).toBe(
      `/w/${workspaceId}/exports/meeting/m_1?format=csv`,
    );
    expect(routes.printMeeting({ workspaceId, meetingId: 'm_1' })).toBe(
      `/w/${workspaceId}/print/meeting/m_1`,
    );
  });
});

describe('capability gating', () => {
  it('refuses an action the instance was configured not to support', async () => {
    const readOnly = createDemoRepositories(demoDataset, { writes: false });
    for (const key of writeActions) expect(can(readOnly.capabilities, key)).toBe(false);
    await expect(
      readOnly.meetings.createDraft!({
        workspaceId,
        title: 'Should not exist',
        meetingTypeId: demoDataset.meetingTypes[0]!.id,
        companyId: null,
        projectId: null,
        participantIds: [],
        notes: null,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_in_demo' });
    await expect(
      readOnly.settings.createVocabulary!({
        workspaceId,
        term: 'nope',
        context: null,
        scope: 'workspace',
        companyId: null,
        meetingId: null,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_in_demo' });
  });
});

function full_person_with_segments() {
  const counts = new Map<string, number>();
  for (const segment of demoDataset.transcripts[flagshipId]!.segments)
    if (segment.speakerPersonId)
      counts.set(segment.speakerPersonId, (counts.get(segment.speakerPersonId) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  // Someone with more lines than one page, so a filtered window has to page.
  const speaker = sorted.find(([, count]) => count > 3) ?? sorted[0]!;
  return speaker[0];
}
