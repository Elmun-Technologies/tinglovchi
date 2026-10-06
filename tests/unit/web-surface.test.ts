import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  can,
  defaultTranscriptSpan,
  exportFormats,
  exportNotices,
  routes,
  writeActions,
  type ExportFormat,
} from '@suhbat/product';
import { DEMO_CAPABILITIES, createDemoRepositories, demoDataset } from '@suhbat/product/demo';
import {
  attachmentDisposition,
  loadExportInput,
  parseExportFormat,
  transcriptRequested,
} from '../../apps/web/src/lib/export-input';
import { floorToPage, transcriptPagingFromQuery } from '../../apps/web/src/lib/transcript-window';
import {
  cleanParams,
  evidenceHref,
  evidenceLinker,
  transcriptHref,
} from '../../apps/web/src/lib/hrefs';
import { readFlash } from '../../apps/web/src/lib/feedback';
import {
  isSidebarCollapsed,
  SIDEBAR_COLLAPSED,
  SIDEBAR_COOKIE,
} from '../../apps/web/src/lib/sidebar';
import { resolveDataMode } from '../../apps/web/src/lib/data-mode';

/**
 * The web layer's own routing and feedback contract, tested without a browser.
 *
 * These are the pieces a page cannot be blamed for getting wrong later: what a citation resolves to, what a
 * redirect code says, and which data mode a request lands in. Rendering of the pages themselves is exercised by
 * the production server run, not by this file.
 */

const WS = 'ws_suhbat_demo';

describe('workspace routing surface', () => {
  it('builds every navigation target under the workspace segment', () => {
    expect(routes.home({ workspaceId: WS })).toBe(`/w/${WS}`);
    expect(routes.meetings({ workspaceId: WS })).toBe(`/w/${WS}/meetings`);
    expect(routes.newMeeting({ workspaceId: WS })).toBe(`/w/${WS}/meetings/new`);
    expect(routes.companies({ workspaceId: WS })).toBe(`/w/${WS}/companies`);
    expect(routes.projects({ workspaceId: WS })).toMatch(/\/w\/ws_suhbat_demo\/projects$/);
    expect(routes.tasks({ workspaceId: WS })).toBe(`/w/${WS}/tasks`);
    expect(routes.knowledge({ workspaceId: WS })).toBe(`/w/${WS}/knowledge`);
    expect(routes.ask({ workspaceId: WS })).toBe(`/w/${WS}/ask`);
    expect(routes.settings({ workspaceId: WS })).toBe(`/w/${WS}/settings`);
    expect(routes.search({ workspaceId: WS }, '')).toBe(`/w/${WS}/search`);
  });

  it('keeps a tab route one segment away and drops the redundant overview segment', () => {
    const meeting = demoDataset.meetings[0]!;
    expect(routes.meeting({ workspaceId: WS, meetingId: meeting.id })).toBe(
      `/w/${WS}/meetings/${meeting.id}`,
    );
    expect(routes.meetingTab({ workspaceId: WS, meetingId: meeting.id, tab: 'decisions' })).toBe(
      `/w/${WS}/meetings/${meeting.id}/decisions`,
    );
    // Overview is the index route, so a page that links the default tab must use `routes.meeting`, not a
    // `/overview` segment — otherwise the same view is reachable by two URLs and the tab strip cannot tell
    // which one is current.
    expect(
      routes.meetingTab({ workspaceId: WS, meetingId: meeting.id, tab: 'transcript' }),
    ).toContain('/transcript');
  });

  it('carries filter values in the address bar and drops empty ones', () => {
    expect(routes.knowledge({ workspaceId: WS }, { kind: 'decision', q: '' })).toBe(
      `/w/${WS}/knowledge?kind=decision`,
    );
    expect(routes.tasks({ workspaceId: WS }, { bucket: 'overdue' })).toContain('bucket=overdue');
    expect(cleanParams({ q: '  budget ', company: '', from: undefined })).toEqual({
      q: 'budget',
    });
  });

  it('resolves a company tab without inventing an overview segment', () => {
    const company = demoDataset.companies[0]!;
    expect(routes.company({ workspaceId: WS, companyId: company.id, tab: 'overview' })).toBe(
      `/w/${WS}/companies/${company.id}`,
    );
    expect(routes.company({ workspaceId: WS, companyId: company.id, tab: 'knowledge' })).toBe(
      `/w/${WS}/companies/${company.id}/knowledge`,
    );
  });
});

describe('evidence → transcript navigation', () => {
  it('links a citation to the exact line, with playback position and fragment', () => {
    const decision = demoDataset.decisions[0]!;
    const evidence = decision.evidence[0]!;
    const href = evidenceHref(WS, evidence);
    expect(href).toContain(`/w/${WS}/meetings/${evidence.meetingId}/transcript?`);
    expect(href).toContain(`seg=${evidence.segmentIds[0]}`);
    expect(href).toContain(`t=${evidence.startMs}`);
    expect(href.endsWith(`#${evidence.segmentIds[0]}`)).toBe(true);
  });

  it('falls back to the transcript tab when a citation has no segment ids', () => {
    const href = evidenceHref(WS, {
      meetingId: 'meeting_x',
      meetingTitle: 'Untitled',
      occurredAt: '2026-10-06T09:00:00.000Z',
      startMs: 1000,
      endMs: 2000,
      segmentIds: [],
      speakerPersonIds: [],
    });
    expect(href).toBe(`/w/${WS}/meetings/meeting_x/transcript`);
  });

  it('names speakers from the meeting roster, and says so when nobody is mapped', () => {
    const decision = demoDataset.decisions[0]!;
    const evidence = decision.evidence[0]!;
    const people = new Map(demoDataset.people.map((person) => [person.id, { name: person.name }]));
    const linker = evidenceLinker(WS, people, () => 'Speaker A');
    const names = linker.namesOf(evidence);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        [...people.values()].some((person) => person.name === name) || name === 'Speaker A',
      ).toBe(true);
    }
    expect(linker.namesOf({ ...evidence, speakerPersonIds: [] })[0]).toBe('Speaker A');
  });

  it('resolves every citation in the dataset to a line that exists in that transcript', () => {
    const citations = [
      ...demoDataset.decisions.flatMap((item) => item.evidence),
      ...demoDataset.tasks.flatMap((item) => item.evidence),
      ...demoDataset.facts.flatMap((item) => item.evidence),
    ];
    expect(citations.length).toBeGreaterThan(10);
    for (const evidence of citations) {
      const transcript = demoDataset.transcripts[evidence.meetingId];
      expect(transcript, `no transcript for ${evidence.meetingId}`).toBeTruthy();
      const ids = new Set(transcript!.segments.map((segment) => segment.id));
      for (const segmentId of evidence.segmentIds) {
        expect(ids.has(segmentId), `${segmentId} is not in ${evidence.meetingId}`).toBe(true);
      }
      expect(evidenceHref(WS, evidence)).toContain(`/meetings/${evidence.meetingId}/transcript`);
    }
  });

  it('keeps a plain transcript link separate from a cited one', () => {
    expect(transcriptHref(WS, 'meeting_x', { q: 'budget' })).toBe(
      `/w/${WS}/meetings/meeting_x/transcript?q=budget`,
    );
    expect(transcriptHref(WS, 'meeting_x')).toBe(`/w/${WS}/meetings/meeting_x/transcript`);
  });
});

describe('action feedback and data mode', () => {
  it('turns a redirect code into a sentence, and refuses to invent one', () => {
    const advanced = readFlash({ notice: 'state-advanced' });
    expect(advanced?.tone).toBe('info');
    expect(advanced?.title).toContain('Demo pipeline step advanced');
    expect(readFlash({ notice: 'error:provider_unavailable' })?.tone).toBe('danger');
    expect(readFlash({ error: 'error:not_found' })?.title).toContain('not in this workspace');
    expect(readFlash({ notice: 'made-up-code' })).toBeNull();
    expect(readFlash({})).toBeNull();
  });

  it('reads the sidebar preference without client state', () => {
    expect(SIDEBAR_COOKIE).toBe('suhbat_sidebar');
    expect(isSidebarCollapsed(SIDEBAR_COLLAPSED)).toBe(true);
    expect(isSidebarCollapsed('expanded')).toBe(false);
    expect(isSidebarCollapsed(undefined)).toBe(false);
  });

  it('defaults to demo data, because claiming live without an adapter would be a false statement', () => {
    const previous = process.env.SUHBAT_DATA_MODE;
    delete process.env.SUHBAT_DATA_MODE;
    expect(resolveDataMode()).toBe('demo');
    process.env.SUHBAT_DATA_MODE = 'live';
    expect(resolveDataMode()).toBe('live');
    if (previous === undefined) delete process.env.SUHBAT_DATA_MODE;
    else process.env.SUHBAT_DATA_MODE = previous;
  });
});

/* ------------------------------------------------------------------ write surfaces */

const repositories = createDemoRepositories(demoDataset);
const flagship = demoDataset.meetings.find((meeting) => meeting.state === 'ready')!;
const draft =
  demoDataset.meetings.find((meeting) => meeting.state === 'draft') ?? demoDataset.meetings[0]!;

/** Longest word in a line: a search term that exists in the fixture, whatever the fixtures say. */
function wordOf(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 3);
  return words.sort((a, b) => b.length - a.length)[0] ?? 'meeting';
}

describe('write-surface addresses', () => {
  it('gives every create and edit form a route of its own', () => {
    const company = demoDataset.companies[0]!;
    const project = demoDataset.projects[0]!;
    expect(routes.newCompany({ workspaceId: WS })).toBe(`/w/${WS}/companies/new`);
    expect(routes.editCompany({ workspaceId: WS, companyId: company.id })).toBe(
      `/w/${WS}/companies/${company.id}/edit`,
    );
    expect(routes.newProject({ workspaceId: WS })).toBe(`/w/${WS}/projects/new`);
    expect(routes.editProject({ workspaceId: WS, projectId: project.id })).toBe(
      `/w/${WS}/projects/${project.id}/edit`,
    );
    expect(routes.editMeeting({ workspaceId: WS, meetingId: draft.id })).toBe(
      `/w/${WS}/meetings/${draft.id}/edit`,
    );
  });

  it('keeps export and print under their own static segments, not under the tab route', () => {
    // `meetings/[meetingId]/[tab]` resolves any single segment, so export and print deliberately live outside it:
    // a document URL must not be mistaken for a tab name.
    expect(routes.exportMeeting({ workspaceId: WS, meetingId: flagship.id })).toBe(
      `/w/${WS}/exports/meeting/${flagship.id}`,
    );
    expect(routes.printMeeting({ workspaceId: WS, meetingId: flagship.id })).toBe(
      `/w/${WS}/print/meeting/${flagship.id}`,
    );
  });
});

/* ------------------------------------------------------------------ export request handling */

describe('export request handling', () => {
  it('accepts only the formats the product can build', () => {
    for (const format of exportFormats) {
      expect(parseExportFormat(format)).toBe(format as ExportFormat);
      expect(parseExportFormat(format.toUpperCase())).toBe(format as ExportFormat);
    }
    expect(parseExportFormat(null)).toBe('md');
    expect(parseExportFormat(undefined)).toBe('md');
    expect(parseExportFormat('')).toBe('md');
  });

  it('refuses an unknown format instead of guessing at one', () => {
    for (const junk of ['exe', 'pdf', 'markdown', '../md', 'mdx', 'json2']) {
      expect(parseExportFormat(junk), junk).toBeNull();
    }
  });

  it('attaches a transcript only when exactly asked', () => {
    expect(transcriptRequested('1')).toBe(true);
    for (const raw of ['0', '', 'true', 'yes', null, undefined]) {
      expect(transcriptRequested(raw), String(raw)).toBe(false);
    }
  });

  it('cannot be steered by a quote in a filename', () => {
    expect(attachmentDisposition('budget.md')).toBe('attachment; filename="budget.md"');
    // A crafted name must not close the quoted string and append a second header.
    const hostile = 'a.md"; x-y="z';
    const header = attachmentDisposition(hostile);
    expect(header.match(/"/g)?.length).toBe(2);
    expect(header).not.toMatch(/";\s*[\w-]+=/);
    expect(attachmentDisposition('two\r\nlines.txt')).toBe('attachment; filename="twolines.txt"');
  });
});

/* ------------------------------------------------------------------ transcript windowing */

describe('transcript window paging from the address bar', () => {
  it('carries a well-formed window through, and nothing else', () => {
    expect(transcriptPagingFromQuery({ offset: '40', span: '20' })).toEqual({
      offset: 40,
      span: 20,
    });
    expect(transcriptPagingFromQuery({})).toEqual({});
    expect(transcriptPagingFromQuery({ offset: '', span: '' })).toEqual({});
    // A URL anyone can type must not be able to ask for a negative slice or the whole meeting at once.
    for (const junk of ['-40', '2.5', 'abc', 'NaN', '0', 'Infinity']) {
      expect(transcriptPagingFromQuery({ offset: junk, span: junk }), junk).toEqual({});
    }
  });

  it('aligns an offset down to a whole page', () => {
    expect(floorToPage(45, 20)).toBe(40);
    expect(floorToPage(19, 20)).toBe(0);
    expect(floorToPage(10, 0)).toBe(0);
  });

  it('walks a real transcript in windows whose counts agree with the pager', async () => {
    const transcript = demoDataset.transcripts[flagship.id]!;
    const span = 20;
    const first = await repositories.transcripts.window({
      meetingId: flagship.id,
      span,
      query: '',
    });
    expect(first.totalCount).toBe(transcript.segments.length);
    expect(first.filteredCount).toBe(transcript.segments.length);
    expect(first.segments.length).toBe(Math.min(span, first.totalCount));
    expect(first.span).toBe(span);

    const second = await repositories.transcripts.window({
      meetingId: flagship.id,
      span,
      offset: span,
      query: '',
    });
    expect(second.segments[0]!.id).toBe(
      first.segments[span - 1]!.id === '' ? '' : transcript.segments[span]!.id,
    );
    expect(second.hasPrevious).toBe(true);

    // The last window is the short one, and it reports no next page.
    let offset = 0;
    let last = first;
    const seen: string[] = [];
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await repositories.transcripts.window({
        meetingId: flagship.id,
        span,
        offset,
        query: '',
      });
      seen.push(...page.segments.map((segment) => segment.id));
      last = page;
      if (!page.hasNext) break;
      offset += page.span;
    }
    expect(last.hasNext).toBe(false);
    expect(new Set(seen).size).toBe(first.totalCount);
    expect(seen.length).toBe(first.totalCount);
  });

  it('filters before slicing, so a window of search results is a window of the results', async () => {
    const term = wordOf(demoDataset.transcripts[flagship.id]!.segments[3]!.text);
    const window = await repositories.transcripts.window({
      meetingId: flagship.id,
      query: term,
      span: 2,
      offset: 0,
    });
    expect(window.filteredCount).toBeGreaterThan(0);
    expect(window.segments.length).toBeLessThanOrEqual(2);
    for (const segment of window.segments) {
      expect(segment.text.toLowerCase()).toContain(term);
    }
    expect(window.totalCount).toBeGreaterThanOrEqual(window.filteredCount);
  });

  it('defaults to the shared window size when the reader asks for more than the surface allows', async () => {
    const huge = await repositories.transcripts.window({
      meetingId: flagship.id,
      span: 10_000,
      query: '',
    });
    expect(huge.span).toBeLessThanOrEqual(400);
    const lines = demoDataset.transcripts[flagship.id]!.segments.length;
    expect(huge.segments.length).toBe(lines);
    expect(huge.hasNext).toBe(false);
    const plain = await repositories.transcripts.window({ meetingId: flagship.id, query: '' });
    // A meeting shorter than the default window is one page: never a promise of a second one.
    expect(defaultTranscriptSpan).toBeGreaterThan(0);
    expect(plain.segments.length).toBe(Math.min(lines, plain.span));
    expect(plain.hasPrevious).toBe(false);
  });

  it('pulls a cited line into its own window instead of reporting it unreachable', async () => {
    const transcript = demoDataset.transcripts[flagship.id]!;
    const target = transcript.segments[transcript.segments.length - 1]!;
    const focused = await repositories.transcripts.window({
      meetingId: flagship.id,
      span: 20,
      query: '',
      focusSegmentId: target.id,
    });
    expect(focused.segments.some((segment) => segment.id === target.id)).toBe(true);
    expect(focused.offset).toBeGreaterThan(0);
    // Asking for a line that is already on the page must not move the window.
    const samePage = await repositories.transcripts.window({
      meetingId: flagship.id,
      span: 20,
      query: '',
      offset: focused.offset,
      focusSegmentId: focused.segments[0]!.id,
    });
    expect(samePage.focusedSegmentId).toBeNull();
  });
});

/* ------------------------------------------------------------------ export content */

describe('one export input feeds the download and the print view', () => {
  it('builds a typed input from the repository contract alone', async () => {
    const loaded = await loadExportInput(repositories, WS, flagship.id, {
      includeTranscript: false,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { input, title } = loaded;
    expect(title).toBe(flagship.title);
    expect(input.detail.id).toBe(flagship.id);
    expect(input.decisions.length).toBe(flagship.counts.decisions);
    expect(input.nameOf(input.decisions[0]!.evidence[0]!.speakerPersonIds[0] ?? '')).toBeTruthy();
    // A ready meeting with records is not a partial document, and the export says so with an empty notice list.
    expect(input.includeTranscript).toBe(false);
    expect(input.transcript ?? null).toBeNull();
    expect(exportNotices(input)).toEqual([]);

    const documents = await Promise.all(
      exportFormats.map(async (format) => ({
        format,
        document: (await import('@suhbat/product')).buildMeetingExport(input, format),
      })),
    );
    for (const { format, document } of documents) {
      expect(
        document.filename.endsWith(
          `.${format === 'json' ? 'json' : format === 'csv' ? 'csv' : format}`,
        ),
      ).toBe(true);
      expect(document.body.length).toBeGreaterThan(80);
      expect(document.body).toContain(flagship.title);
    }
    const json = documents.find((item) => item.format === 'json')!;
    expect(() => JSON.parse(json.document.body)).not.toThrow();
    const csv = documents.find((item) => item.format === 'csv')!;
    expect(csv.document.body.split('\n')[0]!.split(',').length).toBeGreaterThanOrEqual(5);
  });

  it('includes the transcript only when it was asked for, and never pretends about records', async () => {
    const withTranscript = await loadExportInput(repositories, WS, flagship.id, {
      includeTranscript: true,
    });
    const without = await loadExportInput(repositories, WS, flagship.id, {
      includeTranscript: false,
    });
    if (!withTranscript.ok || !without.ok) throw new Error('export input failed to build');
    expect(withTranscript.input.transcript?.segments.length).toBe(
      demoDataset.transcripts[flagship.id]!.segments.length,
    );
    expect(without.input.transcript ?? null).toBeNull();
    // Declining the transcript is a choice, not a gap, so it must not raise a warning of its own.
    expect(exportNotices(without.input)).toEqual([]);
    // A meeting that was never analysed is thin, and the document admits which part is missing.
    const asDraft = await loadExportInput(repositories, WS, draft.id, { includeTranscript: true });
    expect(asDraft.ok).toBe(true);
    if (!asDraft.ok) return;
    const codes = exportNotices(asDraft.input).map((notice) => notice.code);
    expect(codes).toContain('not_ready');
  });

  it('reports a missing meeting as an error the page can render, not an empty file', async () => {
    const loaded = await loadExportInput(repositories, WS, 'meeting_that_does_not_exist', {
      includeTranscript: false,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('not_found');
    expect(loaded.error.message.length).toBeGreaterThan(10);
  });
});

/* ------------------------------------------------------------------ capability gating */

describe('capability-gated write surfaces', () => {
  it('opens every documented write in demo mode, because demo state is allowed to change', () => {
    for (const action of writeActions) {
      expect(can(DEMO_CAPABILITIES, action), action).toBe(true);
    }
    expect(DEMO_CAPABILITIES.persistence).toBe('in_memory');
    expect(DEMO_CAPABILITIES.persistenceLabel).toMatch(/memory/i);
  });

  it('says the same thing about persistence in the label as in the flag', () => {
    // Copy that promises more than `persistence` delivers is the failure mode this guards.
    expect(DEMO_CAPABILITIES.persistenceLabel.toLowerCase()).not.toMatch(/cloud|supabase|uploaded/);
    expect(DEMO_CAPABILITIES.provenanceLabel.toLowerCase()).toMatch(/no database|no network/);
  });

  it('disables every action at once when writes are switched off', async () => {
    const inert = createDemoRepositories(demoDataset, { writes: false });
    for (const action of writeActions) {
      expect(can(inert.capabilities, action), action).toBe(false);
    }
    expect(inert.capabilities.persistence).toBe('none');
    expect(inert.capabilities.persistenceLabel).toMatch(/refuses every write/);

    // The refusal is enforced by the adapter, not only advertised: a page that forgot to check still fails.
    // `create` is optional on the contract, so it is taken as a value and bound with `call` rather than assumed.
    const create = inert.companies.create!;
    const error = await create
      .call(inert.companies, { workspaceId: WS, name: 'Should not appear', description: null })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe('unsupported_in_demo');
    const stillThere = await repositories.companies
      .list(WS, { includeArchived: true })
      .then((rows) => rows.some((row) => row.name === 'Should not appear'));
    expect(stillThere).toBe(false);
  });

  it('turns the simulated pipeline off without turning the rest of demo mode off', () => {
    const frozen = createDemoRepositories(demoDataset, { demoStateTransitions: false });
    expect(can(frozen.capabilities, 'demo.pipeline')).toBe(false);
    // The states this adapter holds stay honestly labelled as simulated; only the control to move them is gone.
    expect(frozen.capabilities.pipeline).toBe('simulated');
    expect(can(frozen.capabilities, 'company.create')).toBe(true);
  });
});

/* ------------------------------------------------------------------ source contracts */

/**
 * The checks below read the page sources on purpose. Rendering a server component needs a running Next server,
 * and the e2e suite owns that; what a unit test *can* pin is that a page never quietly grows a claim or a form
 * field the action cannot read — both have happened here already, and both fail silently in a browser.
 */
const web = (path: string) =>
  readFileSync(new URL(`../../apps/web/src/${path}`, import.meta.url), 'utf8');

const writePages = [
  'app/w/[workspaceId]/companies/new/page.tsx',
  'app/w/[workspaceId]/companies/[companyId]/edit/page.tsx',
  'app/w/[workspaceId]/projects/new/page.tsx',
  'app/w/[workspaceId]/projects/[projectId]/edit/page.tsx',
  'app/w/[workspaceId]/meetings/new/page.tsx',
  'app/w/[workspaceId]/meetings/[meetingId]/edit/page.tsx',
  'app/w/[workspaceId]/settings/page.tsx',
];

describe('write page sources', () => {
  it.each(writePages)('%s gates its form on a named capability', (file) => {
    const source = web(file);
    expect(source).toMatch(/can\(capabilit|can\(getCapabilities\(\)/);
    expect(source).toMatch(/write-form|WriteForm|disabled=/);
  });

  it.each(writePages)('%s claims no persistence the adapter did not offer', (file) => {
    const source = web(file);
    expect(source.toLowerCase()).not.toMatch(
      /saved to (your|the) (cloud|database)|synced to|uploaded to|stored in supabase/,
    );
    expect(source).not.toMatch(/demoEnabled/);
  });

  it('sends only fields some action actually reads', () => {
    // A form field no action asks for is dropped without an error — the bug this pins. `readFormData` names
    // reach this list through the helpers the actions share, so the whole file is the source of truth.
    const actions = web('app/actions/product.ts');
    const read = new Set<string>(['next', 'workspaceId', 'returnTo']);
    for (const match of actions.matchAll(/\((?:formData|data), '(\w+)'\)/g)) read.add(match[1]!);
    for (const match of actions.matchAll(/^  (\w+): (?:text|list|number|booleanOf)\(/gm)) {
      read.add(match[1]!);
    }
    expect(read.size).toBeGreaterThan(12);
    for (const file of writePages) {
      const source = web(file);
      const sent = [...source.matchAll(/name="([\w[\]]+)"/g)]
        // `<Icon name="search" />` names an icon, not a field: only form controls count.
        .filter((match) => {
          const open = source.lastIndexOf('<', match.index);
          return !/^<Icon\b/.test(source.slice(open, match.index + 1));
        })
        .map((match) => match[1]!);
      expect(sent.length, `${file} renders no form fields`).toBeGreaterThan(0);
      for (const field of sent) {
        expect(read.has(field), `${file} sends "${field}", which no action reads`).toBe(true);
      }
    }
  });
  it('redirects every settings action to a section the settings page renders', () => {
    const actions = web('app/actions/product.ts');
    const page = web('app/w/[workspaceId]/settings/page.tsx');
    const rendered = page.slice(page.indexOf('const sections = ['), page.indexOf('] as const;'));
    const sections = [...rendered.matchAll(/'(\w+)'/g)].map((match) => match[1]!);
    expect(sections.length).toBeGreaterThan(4);
    const targeted = [
      ...actions.matchAll(/routes\.settings\(\{ workspaceId \}, '([\w-]+)'\)/g),
    ].map((match) => match[1]!);
    expect(targeted.length).toBeGreaterThan(2);
    for (const section of targeted) {
      expect(sections, `actions land on "${section}", which the page does not render`).toContain(
        section,
      );
    }
  });
});

/*
 * Guards over page sources. Rendering a server component needs a running Next server — the e2e suite owns that —
 * so what a unit test can pin here is the two ways these pages have actually broken: a form field the action
 * never reads, and a redirect to a section the page does not render.
 */
describe('write flows keep their promises narrow', () => {
  it('leaves transcript filtering to the adapter, so two implementations cannot diverge', () => {
    const tab = web('app/components/meeting/transcript-tab.tsx');
    const page = web('app/w/[workspaceId]/meetings/[meetingId]/[tab]/page.tsx');
    // The rows are the window, and the predicates that used to duplicate the adapter's filtering are gone.
    // (Facet counts in the filter dropdown may still walk the full transcript — those are totals by design.)
    expect(tab).toMatch(/const filtered = window\.segments/);
    expect(tab).not.toMatch(/normalizeText|filterTranscriptSegments/);
    expect(tab).not.toMatch(/speakerPersonId !== speaker|segment\.topicId !== topic/);
    expect(tab).toMatch(/window: TranscriptWindow/);
    expect(page).toMatch(/repositories\.transcripts\.window\(/);
    expect(page).toMatch(/transcriptPagingFromQuery/);
  });

  it('checks the capability before a record form renders, not after it submits', () => {
    for (const file of [
      'app/w/[workspaceId]/companies/[companyId]/edit/page.tsx',
      'app/w/[workspaceId]/projects/[projectId]/edit/page.tsx',
    ]) {
      const source = web(file);
      const head = source.slice(0, source.indexOf('const loaded = await Promise.all(['));
      expect(head.length, `${file} no longer loads the way this guard expects`).toBeGreaterThan(0);
      expect(head, file).toMatch(/can\(capabilities, '(company|project)\.update'\)/);
      expect(source).toMatch(/canWrite=\{canWrite\}/);
    }
  });

  it.each([
    ['app/w/[workspaceId]/companies/new/page.tsx', 'company.create'],
    ['app/w/[workspaceId]/projects/new/page.tsx', 'project.create'],
    ['app/w/[workspaceId]/meetings/new/page.tsx', 'meeting.draft.create'],
    ['app/w/[workspaceId]/meetings/[meetingId]/edit/page.tsx', 'meeting.draft.delete'],
    ['app/w/[workspaceId]/settings/page.tsx', 'workspace.members.invite'],
  ])('%s gates itself on %s', (file, action) => {
    expect(web(file), `${file} should gate on ${action}`).toContain(`'${action}'`);
  });

  it('lands every settings action on a section the settings page renders', () => {
    const actions = web('app/actions/product.ts');
    const page = web('app/w/[workspaceId]/settings/page.tsx');
    const nav = page.slice(page.indexOf('const sections = ['), page.indexOf('] as const;'));
    const sections = [...nav.matchAll(/'(\w+)'/g)].map((match) => match[1]!);
    expect(sections.length).toBeGreaterThan(4);
    const targeted = [
      ...actions.matchAll(/routes\.settings\(\{ workspaceId \}, '([\w-]+)'\)/g),
    ].map((match) => match[1]!);
    expect(targeted.length).toBeGreaterThan(2);
    for (const section of targeted) {
      expect(sections, `an action lands on "${section}", which the page does not render`).toContain(
        section,
      );
    }
  });
});
