import { describe, expect, it } from 'vitest';
import { buildMeetingExport, exportFormats, exportNotices } from './export';
import { createDemoRepositories } from './demo/repositories';
import { demoDataset } from './demo/dataset';
import { DEMO_WORKSPACE_ID } from './demo/ids';
import type { MeetingExportInput } from './export';

/**
 * The export surface is the one place the product hands its records to another tool, so the rule here is that a
 * file may not say anything the screens do not — and must state plainly what is missing.
 */

const flagshipId = 'meeting_foodera_marketing_strategy';
const draftId = demoDataset.meetings.find((meeting) => meeting.state === 'draft')!.id;

async function exportInputFor(meetingId: string, includeTranscript: boolean) {
  const repositories = createDemoRepositories(demoDataset);
  const detail = await repositories.meetings.detail(meetingId);
  const scope = { workspaceId: DEMO_WORKSPACE_ID, meetingId };
  const transcript = await repositories.transcripts.forMeeting(meetingId);
  const people = new Map(demoDataset.people.map((person) => [person.id, person.name]));
  const input: MeetingExportInput = {
    detail,
    decisions: await repositories.meetings.decisionsFor(scope),
    tasks: (await repositories.tasks.list(DEMO_WORKSPACE_ID, { meetingId })).filter(
      (task) => task.meetingId === meetingId,
    ),
    facts: await repositories.meetings.factsFor(scope),
    questions: await repositories.meetings.questionsFor(scope),
    ideas: await repositories.meetings.ideasFor(scope),
    commitments: await repositories.meetings.commitmentsFor(scope),
    topics: transcript.topics,
    transcript,
    nameOf: (personId) => (personId ? people.get(personId) : undefined),
    includeTranscript,
  };
  return { repositories, input, transcript };
}

describe('meeting export', () => {
  it('offers four formats, each naming what is inside', async () => {
    const { input } = await exportInputFor(flagshipId, true);
    for (const format of exportFormats) {
      const document = buildMeetingExport(input, format);
      expect(document.body.length).toBeGreaterThan(200);
      expect(document.filename.endsWith(`.${format}`)).toBe(true);
      expect(document.includes.toLowerCase()).toMatch(/record|meeting|row/i);
      expect(document.mediaType).toMatch(/text|json/);
    }
  });

  it('carries every record with its transcript evidence range', async () => {
    const { input } = await exportInputFor(flagshipId, false);
    const markdown = buildMeetingExport(input, 'md');
    for (const decision of input.decisions) {
      expect(markdown.body).toContain(decision.title);
    }
    for (const task of input.tasks) expect(markdown.body).toContain(task.title);
    // The evidence ranges are in the document, so a reader can find the line the claim came from.
    expect(markdown.body).toMatch(/in “.*”/);
    expect(markdown.body).toMatch(/\d\d:\d\d/);
    expect(markdown.body).toMatch(/status: (proposed|tentative|confirmed|rejected|superseded)/);
    expect(markdown.body).toMatch(/No model was called/i);
  });

  it('does not include a transcript the caller did not ask for, and never invents one', async () => {
    const without = buildMeetingExport((await exportInputFor(flagshipId, false)).input, 'md');
    expect(without.body).not.toMatch(/## Transcript/);
    const json = JSON.parse(
      buildMeetingExport((await exportInputFor(flagshipId, false)).input, 'json').body,
    );
    expect(json.transcript).toBe('excluded by request');
    const withTranscript = JSON.parse(
      buildMeetingExport((await exportInputFor(flagshipId, true)).input, 'json').body,
    );
    expect(withTranscript.transcript.length).toBe(
      demoDataset.transcripts[flagshipId]!.segments.length,
    );
    expect(withTranscript.schema).toBe('suhbat.meeting-export/1');
    expect(withTranscript.generatedFrom).toMatch(/demo fixtures/i);
  });

  it('escapes CSV cells instead of letting a comma split a record', async () => {
    const { input } = await exportInputFor(flagshipId, false);
    const csv = buildMeetingExport(input, 'csv').body;
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('kind,id,summary,status,person,date,evidence');
    const countCells = (line: string) => {
      let inQuotes = false;
      let cells = 1;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]!;
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) cells += 1;
      }
      return cells;
    };
    for (const line of lines.slice(1)) expect(countCells(line)).toBe(7);
  });

  it('states what a draft export is missing rather than printing an empty document', async () => {
    const { input } = await exportInputFor(draftId, true);
    const notices = exportNotices(input);
    expect(notices.map((notice) => notice.code)).toEqual(
      expect.arrayContaining(['not_ready', 'no_records', 'no_transcript']),
    );
    const document = buildMeetingExport(input, 'txt');
    expect(document.body).toMatch(/No decisions, tasks or facts are recorded/i);
    expect(document.body).toMatch(/No transcript is attached/i);
    expect(document.body).toMatch(/nothing captured yet/i);
    expect(document.body).toMatch(/Draft|draft/);
    expect(document.body).toMatch(/No summary recorded/i);
  });
});
