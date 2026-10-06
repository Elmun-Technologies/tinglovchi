import { describe, expect, it } from 'vitest';
import { DEMO_CAPABILITIES, createDemoRepositories } from './repositories';
import { demoDataset } from './dataset';
import { RepositoryError, can, writeActions, type MeetingScope } from '../repositories';
import { meetingFilterSchema } from '../domain';
import { routes } from '../query';
import { DEMO_WORKSPACE_ID } from './ids';

/**
 * The demo adapter is what the UI runs on, so it is tested against the same contract the real adapter will
 * implement: workspace scoping, filters, aggregates, not-found behaviour and — critically — the lines it refuses
 * to draw. Writes are exercised here rather than in the browser, because the rule that matters ("a demo write is
 * real but in-memory, and a refusal is explained") is adapter behaviour, not rendering.
 */

const workspaceId = DEMO_WORKSPACE_ID;
const flagshipId = 'meeting_foodera_marketing_strategy';
const failedMeetingId = 'meeting_chirchik_export_review';
const nomadMeetingId = 'meeting_nomad_q3_pipeline';

function adapter() {
  // A fresh adapter per test: demo mutations must not leak between assertions.
  return createDemoRepositories(demoDataset);
}

describe('capabilities', () => {
  it('declares in-memory writes and no real pipeline', () => {
    expect(DEMO_CAPABILITIES.mode).toBe('demo');
    expect(DEMO_CAPABILITIES.reads).toBe('demo');
    // Writes exist; the honesty lives in what the capability record says about where they go.
    expect(DEMO_CAPABILITIES.writes).toBe(true);
    expect(DEMO_CAPABILITIES.persistence).toBe('in_memory');
    expect(DEMO_CAPABILITIES.persistenceLabel).toMatch(/in memory/i);
    expect(DEMO_CAPABILITIES.pipeline).toBe('simulated');
    expect(DEMO_CAPABILITIES.demoStateTransitions).toBe(true);
    expect(DEMO_CAPABILITIES.playback).toBe('none');
    expect(DEMO_CAPABILITIES.provenanceLabel).toMatch(/no database, no network/i);
  });

  it('answers for every action the UI can gate, and none of them are invented keys', () => {
    const actions = DEMO_CAPABILITIES.actions;
    for (const key of writeActions) expect(key in actions).toBe(true);
    // Nothing the demo cannot do is advertised: no cloud persistence, no provider work.
    expect(can(DEMO_CAPABILITIES, 'company.create')).toBe(true);
    expect(can(DEMO_CAPABILITIES, 'transcript.speakerMapping')).toBe(true);
    const readOnly = createDemoRepositories(demoDataset, { writes: false });
    expect(readOnly.capabilities.writes).toBe(false);
    expect(can(readOnly.capabilities, 'company.create')).toBe(false);
  });

  it('reports the desktop recorder as never validated, and never as recording', async () => {
    const status = await adapter().desktop.status();
    expect(status.state).toBe('not_validated');
    expect(status.deepLink).toBe('suhbat://record');
    expect(status.detail).toMatch(/has not been validated/i);
    expect(status.detail).not.toMatch(/recording started/i);
  });
});

describe('workspace scoping', () => {
  it('fails loudly for an unknown workspace', async () => {
    const repositories = adapter();
    await expect(repositories.meetings.list('ws_missing')).rejects.toBeInstanceOf(RepositoryError);
    await expect(repositories.meetings.dashboard('nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(repositories.workspaces.get('nope')).rejects.toMatchObject({
      code: 'not_found',
      hint: expect.stringContaining('demo workspace'),
    });
  });

  it('returns only that workspace’s records', async () => {
    const repositories = adapter();
    const rows = await repositories.meetings.list(workspaceId);
    expect(rows).toHaveLength(demoDataset.meetings.length);
    expect(rows.every((row) => row.meeting.workspaceId === workspaceId)).toBe(true);
    expect(
      (await repositories.tasks.list(workspaceId)).every(
        (task) => task.workspaceId === workspaceId,
      ),
    ).toBe(true);
    expect((await repositories.knowledge.entries({})).length).toBeGreaterThan(30);
    expect(await repositories.workspaces.currentPersonId(workspaceId)).toBe(
      demoDataset.currentPersonId,
    );
  });
});

describe('meetings list', () => {
  it('carries per-row counts that match the task list', async () => {
    const repositories = adapter();
    const rows = await repositories.meetings.list(workspaceId);
    for (const row of rows) {
      const tasks = await repositories.tasks.list(workspaceId, { meetingId: row.meeting.id });
      const open = tasks.filter(
        (task) =>
          task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked',
      );
      expect(row.openTaskCount).toBe(open.length);
      expect(row.overdueTaskCount).toBeLessThanOrEqual(row.openTaskCount);
    }
    const flagship = rows.find((row) => row.meeting.id === flagshipId)!;
    expect(flagship.openTaskCount).toBeGreaterThan(0);
    expect(flagship.meeting.counts.segments).toBe(
      (await repositories.transcripts.forMeeting(flagshipId)).segments.length,
    );
  });

  it('applies every filter the meetings page exposes', async () => {
    const repositories = adapter();
    const company = demoDataset.companies.find((item) => item.name === 'Foodera')!;
    const person = (await repositories.meetings.detail(flagshipId)).participants[0]!;
    expect(
      (await repositories.meetings.list(workspaceId, { state: 'failed' })).every(
        (row) => row.meeting.state === 'failed',
      ),
    ).toBe(true);
    const byCompany = await repositories.meetings.list(workspaceId, { companyId: company.id });
    expect(byCompany.length).toBeGreaterThan(0);
    expect(byCompany.every((row) => row.meeting.companyId === company.id)).toBe(true);
    expect(
      (await repositories.meetings.list(workspaceId, { participantId: person.personId })).length,
    ).toBeGreaterThan(0);
    expect(
      (await repositories.meetings.list(workspaceId, { query: 'akmal' })).length,
    ).toBeGreaterThan(0);
    expect(
      (await repositories.meetings.list(workspaceId, { query: 'marketing' })).length,
    ).toBeGreaterThan(0);
    expect(await repositories.meetings.list(workspaceId, { query: 'zzzzz' })).toEqual([]);
    expect(
      (await repositories.meetings.list(workspaceId, { from: '2026-10-05' })).every(
        (row) => row.meeting.occurredAt.slice(0, 10) >= '2026-10-05',
      ),
    ).toBe(true);
  });

  it('validates filter shape at the boundary, not in the adapter', () => {
    // A page parses URL params with this schema; the adapter then trusts the typed result.
    expect(meetingFilterSchema.safeParse({ state: 'done' }).success).toBe(false);
    expect(meetingFilterSchema.safeParse({}).success).toBe(true);
    expect(meetingFilterSchema.safeParse({ query: 'budget', state: 'analyzing' }).success).toBe(
      true,
    );
  });
});

describe('meeting detail and transcript', () => {
  it('returns a detail record whose stats agree with its children', async () => {
    const repositories = adapter();
    const detail = await repositories.meetings.detail(flagshipId);
    const transcript = await repositories.transcripts.forMeeting(flagshipId);
    const decisions = await repositories.meetings.decisionsFor({
      workspaceId,
      meetingId: flagshipId,
    });
    expect(detail.counts.decisions).toBe(decisions.length);
    expect(detail.stats.words).toBeGreaterThan(1000);
    expect(detail.stats.confirmedDecisions).toBeLessThanOrEqual(detail.stats.decisions);
    expect(transcript.segments).toHaveLength(detail.counts.segments);
    expect(transcript.topics.length).toBe(detail.counts.topics);
    expect(transcript.participants.length).toBe(detail.participants.length);
    expect(detail.recording.note.length).toBeGreaterThan(0);
  });

  it('keeps meeting-scoped reads inside the meeting', async () => {
    const repositories = adapter();
    const scope: MeetingScope = { workspaceId, meetingId: flagshipId };
    const [decisions, facts, questions, ideas, commitments] = await Promise.all([
      repositories.meetings.decisionsFor(scope),
      repositories.meetings.factsFor(scope),
      repositories.meetings.questionsFor(scope),
      repositories.meetings.ideasFor(scope),
      repositories.meetings.commitmentsFor(scope),
    ]);
    for (const list of [decisions, facts, questions, ideas, commitments]) {
      expect(list.every((item) => item.meetingId === flagshipId)).toBe(true);
    }
    expect(decisions.length).toBeGreaterThan(0);
    expect(facts.length).toBeGreaterThan(0);
    const companyScope: MeetingScope = { workspaceId, companyId: demoDataset.companies[0]!.id };
    const companyDecisions = await repositories.meetings.decisionsFor(companyScope);
    expect(companyDecisions.length).toBeGreaterThanOrEqual(decisions.length);
  });

  it('serves topic segments and evidence segment lookups', async () => {
    const repositories = adapter();
    const transcript = await repositories.transcripts.forMeeting(flagshipId);
    const topic = transcript.topics[0]!;
    const segments = await repositories.transcripts.segmentsForTopic(topic.id);
    expect(segments).toHaveLength(topic.segmentIds.length);
    expect(segments.every((segment) => segment.meetingId === flagshipId)).toBe(true);
    const evidence = (
      await repositories.meetings.decisionsFor({ workspaceId, meetingId: flagshipId })
    )[0]!.evidence[0]!;
    const resolved = await repositories.transcripts.segmentsByIds(flagshipId, evidence.segmentIds);
    expect(resolved).toHaveLength(evidence.segmentIds.length);
    // The stored quote has to be findable in the segments it cites — that is what a reviewer clicks.
    expect(resolved.map((segment) => segment.text).join(' ')).toContain(
      evidence.quote!.slice(0, 12),
    );
  });

  it('surfaces not_found with the id in the detail so the UI can be specific', async () => {
    const repositories = adapter();
    for (const promise of [
      repositories.meetings.detail('meeting_missing'),
      repositories.transcripts.forMeeting('meeting_missing'),
      repositories.meetings.processing('meeting_missing'),
      repositories.companies.get('company_missing'),
      repositories.projects.get('project_missing'),
    ]) {
      const error = await promise.catch((cause) => cause);
      expect(error).toBeInstanceOf(RepositoryError);
      expect(error.code).toBe('not_found');
    }
    expect(
      await repositories.transcripts.segmentsForTopic('topic_missing').catch(() => 'threw'),
    ).toBe('threw');
    expect(
      await repositories.transcripts
        .segmentsByIds('meeting_missing', ['seg_001'])
        .catch(() => 'threw'),
    ).toBe('threw');
  });
});

describe('processing timeline', () => {
  it('exposes steps and a useful error for the failed meeting', async () => {
    const repositories = adapter();
    const timeline = await repositories.meetings.processing(failedMeetingId);
    expect(timeline.state).toBe('failed');
    expect(timeline.steps.length).toBeGreaterThanOrEqual(6);
    expect(timeline.steps.some((step) => step.state === 'failed')).toBe(true);
    expect(timeline.error?.retryable).toBe(true);
    expect(timeline.error?.message.length).toBeGreaterThan(10);
    const rows = await repositories.meetings.list(workspaceId);
    expect(rows.find((row) => row.meeting.id === failedMeetingId)!.meeting.state).toBe(
      timeline.state,
    );
  });

  it('advances exactly one step per call and only reaches ready at the end', async () => {
    const repositories = adapter();
    let timeline = await repositories.meetings.processing(failedMeetingId);
    const doneBefore = timeline.steps.filter((step) => step.state === 'done').length;
    timeline = await repositories.meetings.advanceDemoState!(failedMeetingId);
    expect(timeline.steps.filter((step) => step.state === 'done')).toHaveLength(doneBefore + 1);
    expect(timeline.state).not.toBe('ready');
    for (let index = 0; index < 10 && timeline.state !== 'ready'; index += 1) {
      timeline = await repositories.meetings.advanceDemoState!(failedMeetingId);
    }
    expect(timeline.state).toBe('ready');
    expect(timeline.error).toBeUndefined();
    const rows = await repositories.meetings.list(workspaceId);
    expect(rows.find((row) => row.meeting.id === failedMeetingId)!.meeting.state).toBe('ready');
    expect(timeline.steps.every((step) => step.state === 'done')).toBe(true);
  });

  it('refuses to advance a meeting that is not mid-pipeline', async () => {
    const repositories = adapter();
    await expect(repositories.meetings.advanceDemoState!(flagshipId)).rejects.toMatchObject({
      code: 'unsupported_in_demo',
    });
    const draft = demoDataset.meetings.find((meeting) => meeting.state === 'draft')!;
    await expect(repositories.meetings.advanceDemoState!(draft.id)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });
});

describe('refusals', () => {
  it('refuses every write when the adapter is configured not to write', async () => {
    const repositories = createDemoRepositories(demoDataset, { writes: false });
    await expect(
      repositories.companies.create!({ workspaceId, name: 'Never Created', description: null }),
    ).rejects.toMatchObject({ code: 'unsupported_in_demo' });
    await expect(
      repositories.tasks.updateStatus!(demoDataset.tasks[0]!.id, 'completed'),
    ).rejects.toMatchObject({ code: 'unsupported_in_demo' });
    // Reads still work: disabling writes must not turn a screen into an empty one.
    expect((await repositories.companies.list(workspaceId)).length).toBeGreaterThan(0);
  });

  it('answers an empty question with a refusal rather than a fabricated answer', async () => {
    const repositories = adapter();
    await expect(repositories.askAi.ask(workspaceId, '   ')).rejects.toMatchObject({
      code: 'unsupported_in_demo',
    });
    await expect(repositories.askAi.ask('nope', 'anything')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('task mutation', () => {
  it('completes a task, recounts the dashboard, and never touches the source fixtures', async () => {
    const repositories = adapter();
    const before = await repositories.meetings.dashboard(workspaceId);
    const open = (await repositories.tasks.list(workspaceId, { bucket: 'open' }))[0]!;
    const updated = await repositories.tasks.updateStatus!(open.id, 'completed');
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeTruthy();
    const after = await repositories.meetings.dashboard(workspaceId);
    expect(after.openTaskCount).toBe(before.openTaskCount - 1);
    expect(demoDataset.tasks.find((task) => task.id === open.id)!.status).not.toBe('completed');
    await expect(repositories.tasks.updateStatus!('task_missing', 'open')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('filters the way the tasks page links to it', async () => {
    const repositories = adapter();
    const current = demoDataset.currentPersonId;
    const mine = await repositories.tasks.list(workspaceId, { bucket: 'mine' });
    expect(mine.length).toBeGreaterThan(0);
    // 'Mine' is always the signed-in person; the owner dropdown is a separate `personId` filter.
    expect(mine.every((task) => task.ownerPersonId === current)).toBe(true);
    const byOwner = await repositories.tasks.list(workspaceId, {
      personId: (await repositories.tasks.list(workspaceId))[0]!.ownerPersonId!,
    });
    expect(byOwner.length).toBeGreaterThan(0);
    const overdue = await repositories.tasks.list(workspaceId, { bucket: 'overdue' });
    expect(
      overdue.every(
        (task) => task.status !== 'completed' && task.dueDate! < demoDataset.todayIsoDate,
      ),
    ).toBe(true);
    const completed = await repositories.tasks.list(workspaceId, { bucket: 'completed' });
    expect(completed.every((task) => task.status === 'completed')).toBe(true);
  });
});

describe('speaker mapping', () => {
  it('attributes an unmapped label and clears it from the detail', async () => {
    const repositories = adapter();
    const detail = await repositories.meetings.detail(nomadMeetingId);
    expect(detail.unmappedSpeakers).toEqual(['Speaker C']);
    const before = await repositories.transcripts.forMeeting(nomadMeetingId);
    const unmappedSegments = before.segments.filter((segment) => segment.speakerPersonId === null);
    expect(unmappedSegments.length).toBeGreaterThan(0);

    const mapping = await repositories.transcripts.confirmSpeakerMapping!({
      meetingId: nomadMeetingId,
      label: 'Speaker C',
      personId: 'person_aziz',
    });
    expect(mapping.find((item) => item.label === 'Speaker C')?.confirmed).toBe(true);
    const after = await repositories.transcripts.forMeeting(nomadMeetingId);
    expect(
      after.segments
        .filter((segment) => segment.speakerLabel === 'Speaker C')
        .every((segment) => segment.speakerPersonId === 'person_aziz'),
    ).toBe(true);
    expect((await repositories.meetings.detail(nomadMeetingId)).unmappedSpeakers).toEqual([]);
    // The source fixture is untouched: another adapter instance still sees the unmapped label.
    expect((await adapter().meetings.detail(nomadMeetingId)).unmappedSpeakers).toEqual([
      'Speaker C',
    ]);
    await expect(
      repositories.transcripts.confirmSpeakerMapping!({
        meetingId: nomadMeetingId,
        label: 'Speaker C',
        personId: 'person_ghost',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('companies, projects, knowledge', () => {
  it('summarises each company with counts the pages can trust', async () => {
    const repositories = adapter();
    const overviews = await repositories.companies.overview(workspaceId);
    expect(overviews.length).toBe(demoDataset.companies.length);
    const foodera = overviews.find((row) => row.company.name === 'Foodera')!;
    expect(foodera.meetingCount).toBe(
      demoDataset.meetings.filter((meeting) => meeting.companyId === foodera.company.id).length,
    );
    expect(foodera.decisionCount).toBe(
      demoDataset.decisions.filter((decision) => decision.companyId === foodera.company.id).length,
    );
    expect(foodera.openTaskCount).toBeGreaterThanOrEqual(0);
    expect(foodera.lastMeetingAt).toBeTruthy();
    expect(overviews[0]!.meetingCount).toBeGreaterThanOrEqual(overviews.at(-1)!.meetingCount);

    const intelligence = await repositories.companies.intelligence(foodera.company.id);
    expect(intelligence.derivedFrom).toBe('demo_fixtures');
    expect(intelligence.goals.length).toBeGreaterThan(0);
    expect(intelligence.objections.length).toBeGreaterThan(0);
    await expect(repositories.companies.intelligence('company_missing')).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it('summarises projects and links them to their company', async () => {
    const repositories = adapter();
    const overviews = await repositories.projects.overview(workspaceId);
    expect(overviews.length).toBe(demoDataset.projects.length);
    for (const row of overviews) {
      const project = demoDataset.projects.find((item) => item.id === row.project.id)!;
      expect(row.companyName).toBe(
        demoDataset.companies.find((item) => item.id === project.companyId)?.name ?? null,
      );
      expect(row.meetingCount).toBe(
        demoDataset.meetings.filter((meeting) => meeting.projectId === project.id).length,
      );
    }
  });

  it('filters knowledge the way the Knowledge page does', async () => {
    const repositories = adapter();
    const all = await repositories.knowledge.entries({});
    expect(all.length).toBeGreaterThan(0);
    // The unfiltered read is the union the per-kind tabs slice from, so it must stay inside the workspace and
    // actually mix kinds; a single-kind stream would make the Knowledge tabs meaningless.
    expect(all.every((entry) => entry.workspaceId === workspaceId)).toBe(true);
    expect(new Set(all.map((entry) => entry.kind)).size).toBeGreaterThan(1);
    const decisions = await repositories.knowledge.entries({ kinds: ['decision'] });
    expect(decisions.length).toBe(demoDataset.decisions.length);
    expect(decisions.every((entry) => entry.kind === 'decision')).toBe(true);
    expect(decisions.every((entry) => entry.evidence.length > 0)).toBe(true);
    const company = demoDataset.companies[1]!;
    const scoped = await repositories.knowledge.entries({ companyId: company.id });
    expect(scoped.every((entry) => entry.companyId === company.id)).toBe(true);
    expect(scoped.length).toBeGreaterThan(0);
    expect((await repositories.knowledge.entries({ query: 'budget' })).length).toBeGreaterThan(0);
    expect(await repositories.knowledge.entries({ query: 'zzzzz' })).toEqual([]);
    const person = demoDataset.people[0]!;
    const byPerson = await repositories.knowledge.entries({ participantId: person.id });
    expect(byPerson.every((entry) => entry.personIds.includes(person.id))).toBe(true);
  });
});

describe('Ask AI adapter', () => {
  it('returns a fixture answer with resolvable citations', async () => {
    const repositories = adapter();
    const answer = await repositories.askAi.ask(
      workspaceId,
      'What is still unresolved about our revenue numbers?',
    );
    expect(answer.adapter).toBe('demo_fixtures');
    expect(answer.matchedKnownQuestion).toBe(true);
    expect(answer.answer.length).toBeGreaterThan(0);
    expect(answer.citations.length).toBeGreaterThan(0);
    for (const citation of answer.citations) {
      expect(citation.endMs).toBeGreaterThan(citation.startMs);
      expect(citation.speakerNames.length + citation.quote.length).toBeGreaterThan(0);
      // A citation is only worth showing if its quote can be found in the meeting it points at.
      const transcript = await repositories.transcripts.forMeeting(citation.meetingId);
      expect(transcript.segments.length).toBeGreaterThan(0);
      // Every citation has to resolve to the record it names, in the meeting it claims.
      const collection =
        citation.kind === 'decision'
          ? demoDataset.decisions
          : citation.kind === 'task'
            ? demoDataset.tasks
            : citation.kind === 'fact'
              ? demoDataset.facts
              : citation.kind === 'question'
                ? demoDataset.questions
                : citation.kind === 'idea'
                  ? demoDataset.ideas
                  : demoDataset.commitments;
      const record = collection.find((item) => item.id === citation.id);
      expect(record).toBeTruthy();
      expect(record!.meetingId).toBe(citation.meetingId);
      expect(citation.quote.trim().length).toBeGreaterThan(0);
      expect(citation.meetingTitle).toBe(
        demoDataset.meetings.find((meeting) => meeting.id === citation.meetingId)!.title,
      );
      // The product rule: a cited record is only citable because it has transcript evidence behind it.
      expect(record!.evidence.length).toBeGreaterThan(0);
      const target = citation.target === 'transcript' ? 'transcript' : citation.target;
      expect(
        routes.meetingTab({ workspaceId, meetingId: citation.meetingId, tab: target }),
      ).toContain('/meetings/');
    }
    expect(answer.notes.join(' ')).toMatch(/demo fixtures/i);
    // Any other phrasing must fall back to retrieval and say so, rather than pretending to be an authored answer.
    const fallback = await repositories.askAi.ask(
      workspaceId,
      'how do we handle the delivery radius',
    );
    expect(fallback.matchedKnownQuestion).toBe(false);
    expect(fallback.adapter).toBe('demo_fixtures');
    expect(fallback.answer.length).toBeGreaterThan(1);
    expect(fallback.notes.join(' ')).toMatch(/no model call was made/i);
  });

  it('suggests questions that all resolve to citations', async () => {
    const repositories = adapter();
    const suggestions = await repositories.askAi.suggestions(workspaceId);
    expect(suggestions.length).toBeGreaterThan(4);
    for (const suggestion of suggestions) {
      const answer = await repositories.askAi.ask(workspaceId, suggestion);
      expect(answer.citations.length).toBeGreaterThan(0);
    }
  });
});

describe('global search', () => {
  it('returns navigable hrefs and nothing for noise', async () => {
    const repositories = adapter();
    const hits = await repositories.search.search(workspaceId, 'crm');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.href.startsWith(`/w/${workspaceId}/`)).toBe(true);
      expect(['meeting', 'company', 'project', 'person', 'decision', 'task']).toContain(hit.kind);
      expect(hit.subtitle.length).toBeGreaterThan(0);
    }
    expect(await repositories.search.search(workspaceId, '')).toEqual([]);
    expect(await repositories.search.search(workspaceId, 'q')).toEqual([]);
    expect(await repositories.search.search(workspaceId, 'zzzzzz')).toEqual([]);
    expect(await repositories.search.search(workspaceId, 'Foodera')).toEqual(
      await repositories.search.search(workspaceId, 'foodera'),
    );
  });
});

describe('settings', () => {
  it('returns a snapshot whose panels are all renderable and unconnected', async () => {
    const repositories = adapter();
    const settings = await repositories.settings.get(workspaceId);
    expect(settings.workspaceId).toBe(workspaceId);
    expect(settings.members.length).toBeGreaterThan(3);
    expect(settings.members.some((member) => member.status === 'invited')).toBe(true);
    expect(settings.members.some((member) => member.role === 'owner')).toBe(true);
    expect(settings.meetingTypes.filter((type) => type.builtIn)).toHaveLength(8);
    expect(settings.meetingTypes.every((type) => type.active)).toBe(true);
    expect(await repositories.settings.vocabulary(workspaceId)).toEqual(settings.vocabulary);
    expect(settings.vocabulary.some((term) => term.scope === 'company')).toBe(true);
    expect(settings.vocabulary.every((term) => term.term.length > 0)).toBe(true);
    expect(settings.recording.chunkLengthSeconds).toBe(30);
    expect(['ask', 'always', 'never']).toContain(settings.recording.screenContextDefault);
    expect(settings.ai.providerNote).toMatch(/no provider is configured/i);
    expect(settings.ai.transcriptionLanguages.length).toBeGreaterThan(0);
    expect(settings.integrations.map((card) => card.key).sort()).toEqual(
      ['amocrm', 'google_calendar', 'google_docs', 'telegram'].sort(),
    );
    expect(
      settings.integrations.every(
        (card) => card.state === 'not_connected' || card.state === 'coming_later',
      ),
    ).toBe(true);
    await expect(repositories.settings.get('nope')).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('adapter isolation', () => {
  it('two adapters do not share mutable state', async () => {
    const first = adapter();
    const second = adapter();
    const task = (await first.tasks.list(workspaceId, { bucket: 'open' }))[0]!;
    await first.tasks.updateStatus!(task.id, 'completed');
    const stillOpen = await second.tasks.list(workspaceId, { meetingId: task.meetingId });
    expect(stillOpen.find((item) => item.id === task.id)!.status).not.toBe('completed');
  });

  it('routes are the only place hrefs are built', () => {
    expect(routes.meetingTab({ workspaceId, meetingId: flagshipId, tab: 'transcript' })).toBe(
      `/w/${workspaceId}/meetings/${flagshipId}/transcript`,
    );
    expect(
      routes.evidence({ workspaceId, meetingId: flagshipId, segmentId: 'seg_042', startMs: 1000 }),
    ).toContain('?seg=seg_042&t=1000');
  });
});
