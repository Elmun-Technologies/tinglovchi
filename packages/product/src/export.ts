import { formatTimestamp } from './domain';
import type {
  Commitment,
  Decision,
  Fact,
  Idea,
  MeetingDetail,
  MeetingTranscript,
  Question,
  Task,
  Topic,
} from './domain';

/**
 * The export/print surface: documents built from records the workspace already holds.
 *
 * Two rules. (1) An export is *derived from the same typed records the screens render*, so a file can never
 * say something the UI does not. (2) Where a value is missing — no transcript, unassigned owner, no analysis
 * yet — the document says so rather than leaving a blank that reads as "none". Nothing in this module calls a
 * model or a provider: it formats.
 */

export const exportFormats = ['md', 'txt', 'csv', 'json'] as const;
export type ExportFormat = (typeof exportFormats)[number];

export const exportFormatLabels: Record<ExportFormat, string> = {
  md: 'Markdown',
  txt: 'Plain text',
  csv: 'Records (CSV)',
  json: 'Structured (JSON)',
};

export type ExportDocument = {
  filename: string;
  mediaType: string;
  body: string;
  /** What the reader should expect inside; shown next to each option in the UI. */
  includes: string;
};

export type MeetingExportInput = {
  detail: MeetingDetail;
  decisions: Decision[];
  tasks: Task[];
  facts: Fact[];
  questions: Question[];
  ideas: Idea[];
  commitments: Commitment[];
  topics: Topic[];
  /** Included only when the caller asks and a transcript exists. */
  transcript?: MeetingTranscript | null;
  nameOf: (personId: string | null | undefined) => string | undefined;
  includeTranscript: boolean;
};

export type ExportNotice = { code: string; message: string };

/** Partial exports are stated, not hidden: an export of a meeting that was never analysed is legitimately thin. */
export function exportNotices(input: MeetingExportInput): ExportNotice[] {
  const notices: ExportNotice[] = [];
  if (input.detail.state !== 'ready') {
    notices.push({
      code: 'not_ready',
      message: `This meeting is in the “${input.detail.state}” state, so analysed records may be incomplete.`,
    });
  }
  if (input.decisions.length === 0 && input.tasks.length === 0 && input.facts.length === 0) {
    notices.push({
      code: 'no_records',
      message: 'No decisions, tasks or facts are recorded for this meeting yet.',
    });
  }
  if (input.includeTranscript && (!input.transcript || input.transcript.segments.length === 0)) {
    notices.push({
      code: 'no_transcript',
      message: 'No transcript is attached to this meeting, so none is included.',
    });
  }
  return notices;
}

type RecordRow = {
  kind: string;
  id: string;
  summary: string;
  status: string;
  person: string;
  date: string;
  evidence: string;
};

function evidenceLabel(
  evidence: { startMs: number; endMs: number; meetingTitle: string } | undefined,
) {
  if (!evidence) return 'no evidence';
  return `${formatTimestamp(evidence.startMs)}–${formatTimestamp(evidence.endMs)} in “${evidence.meetingTitle}”`;
}

function rows(input: MeetingExportInput): RecordRow[] {
  const when = input.detail.occurredAt.slice(0, 10);
  const list: RecordRow[] = [];
  for (const decision of input.decisions) {
    list.push({
      kind: 'decision',
      id: decision.id,
      summary: `${decision.title} — ${decision.description}`,
      status: decision.status,
      person: '',
      date: decision.decidedOn || when,
      evidence: evidenceLabel(decision.evidence[0]),
    });
  }
  for (const task of input.tasks) {
    list.push({
      kind: 'task',
      id: task.id,
      summary: task.detail ? `${task.title} — ${task.detail}` : task.title,
      status: task.status,
      person: task.ownerLabel ?? '',
      date: task.dueDate ?? when,
      evidence: evidenceLabel(task.evidence[0]),
    });
  }
  for (const fact of input.facts) {
    list.push({
      kind: 'fact',
      id: fact.id,
      summary: `${fact.label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`,
      status: fact.category,
      person: input.nameOf(fact.speakerPersonId) ?? '',
      date: fact.capturedAt.slice(0, 10),
      evidence: evidenceLabel(fact.evidence[0]),
    });
  }
  for (const question of input.questions) {
    list.push({
      kind: 'question',
      id: question.id,
      summary: question.resolution
        ? `${question.text} — ${question.resolution.answer}`
        : question.text,
      status: question.status,
      person: input.nameOf(question.askedByPersonId) ?? '',
      date: question.raisedOn || when,
      evidence: evidenceLabel(question.evidence[0]),
    });
  }
  for (const idea of input.ideas) {
    list.push({
      kind: 'idea',
      id: idea.id,
      summary: idea.text,
      status: idea.status,
      person: input.nameOf(idea.proposedByPersonId) ?? '',
      date: idea.raisedOn || when,
      evidence: evidenceLabel(idea.evidence[0]),
    });
  }
  for (const commitment of input.commitments) {
    list.push({
      kind: 'commitment',
      id: commitment.id,
      summary: commitment.text,
      status: commitment.status,
      person: input.nameOf(commitment.byPersonId) ?? '',
      date: commitment.dueDate ?? when,
      evidence: evidenceLabel(commitment.evidence[0]),
    });
  }
  return list;
}

function header(input: MeetingExportInput) {
  const { detail } = input;
  const speakers = detail.participants
    .map((participant) =>
      participant.kind === 'internal'
        ? participant.name
        : `${participant.name} (${participant.kind})`,
    )
    .join(', ');
  return {
    title: detail.title,
    lines: [
      ['Company', detail.companyName ?? 'not linked'],
      ['Project', detail.projectName ?? 'not linked'],
      ['Type', detail.meetingTypeLabel],
      ['When', `${detail.occurredAt.slice(0, 10)} ${detail.occurredAt.slice(11, 16)}`],
      ['Duration', `${Math.round(detail.durationMs / 60000)} min`],
      [
        'Captured',
        detail.capturedMs === null
          ? 'nothing captured yet'
          : `${Math.round(detail.capturedMs / 60000)} min`,
      ],
      ['Languages', detail.languages.length > 0 ? detail.languages.join(', ') : 'not recorded'],
      ['Participants', speakers || 'not recorded'],
    ] as [string, string][],
    summary: detail.executiveSummary,
    outcome: detail.keyOutcome ?? null,
  };
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Builds one export document. `csv` and `json` are machine-shaped and keep their structure even when a section
 * is empty; `md` and `txt` are for humans and say which sections had nothing.
 */
export function buildMeetingExport(
  input: MeetingExportInput,
  format: ExportFormat,
): ExportDocument {
  const meta = header(input);
  const items = rows(input);
  const notices = exportNotices(input);
  const slug = meta.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const base = { filename: '', mediaType: '', body: '', includes: '' };

  if (format === 'json') {
    return {
      ...base,
      filename: `${slug || 'meeting'}.json`,
      mediaType: 'application/json',
      includes:
        'meeting, participants, every record with its evidence ranges, and the transcript when attached',
      body: JSON.stringify(
        {
          schema: 'suhbat.meeting-export/1',
          generatedFrom: 'demo fixtures — no pipeline output',
          meeting: input.detail,
          topics: input.topics,
          records: {
            decisions: input.decisions,
            tasks: input.tasks,
            facts: input.facts,
            questions: input.questions,
            ideas: input.ideas,
            commitments: input.commitments,
          },
          transcript: input.includeTranscript
            ? (input.transcript?.segments ?? [])
            : 'excluded by request',
          notices,
        },
        null,
        2,
      ),
    };
  }

  if (format === 'csv') {
    const columns = ['kind', 'id', 'summary', 'status', 'person', 'date', 'evidence'];
    const lines = [columns.join(',')];
    for (const row of items) {
      lines.push(
        [row.kind, row.id, row.summary, row.status, row.person, row.date, row.evidence]
          .map(csvCell)
          .join(','),
      );
    }
    return {
      ...base,
      filename: `${slug || 'meeting'}-records.csv`,
      mediaType: 'text/csv',
      includes: `one row per decision, task, fact, question, idea and commitment (${items.length} rows)`,
      body: `${lines.join('\n')}\n`,
    };
  }

  const md = format === 'md';
  const bold = (value: string) => (md ? `**${value}**` : value);
  const heading = (value: string, level = 2) =>
    md ? `${'#'.repeat(level)} ${value}` : value.toUpperCase();
  const bullet = (value: string) => (md ? `- ${value}` : `  - ${value}`);
  const out: string[] = [md ? `# ${meta.title}` : meta.title.toUpperCase(), ''];
  for (const [term, value] of meta.lines) out.push(bullet(`${bold(term)}: ${value}`));
  if (notices.length > 0) {
    out.push('', heading('Notices', 3));
    for (const notice of notices) out.push(bullet(notice.message));
  }
  if (meta.summary.length > 0) {
    out.push('', heading('Summary'));
    for (const paragraph of meta.summary) out.push(paragraph);
  } else {
    out.push('', heading('Summary'), 'No summary recorded for this meeting.');
  }
  if (meta.outcome) {
    out.push('', heading('Outcome'), meta.outcome);
  }
  const sections: [string, RecordRow[]][] = [
    ['Decisions', items.filter((row) => row.kind === 'decision')],
    ['Tasks', items.filter((row) => row.kind === 'task')],
    ['Facts', items.filter((row) => row.kind === 'fact')],
    ['Questions', items.filter((row) => row.kind === 'question')],
    ['Ideas', items.filter((row) => row.kind === 'idea')],
    ['Commitments', items.filter((row) => row.kind === 'commitment')],
  ];
  for (const [label, sectionRows] of sections) {
    out.push('', heading(label));
    if (sectionRows.length === 0) {
      out.push(`No ${label.toLowerCase()} recorded.`);
      continue;
    }
    for (const row of sectionRows) {
      const trail = [
        row.status && `status: ${row.status}`,
        row.person && `owner/speaker: ${row.person}`,
        row.date && `date: ${row.date}`,
        row.evidence,
      ]
        .filter(Boolean)
        .join(' · ');
      out.push(
        md
          ? `- ${row.summary}${trail ? `\n  - ${trail}` : ''}`
          : `  - ${row.summary}${trail ? `\n    ${trail}` : ''}`,
      );
    }
  }
  if (input.topics.length > 0) {
    out.push('', heading('Topics'));
    for (const topic of input.topics) {
      const range =
        topic.startMs !== undefined && topic.endMs !== undefined
          ? ` (${formatTimestamp(topic.startMs)}–${formatTimestamp(topic.endMs)})`
          : '';
      out.push(bullet(`${topic.title}${range} — ${topic.segmentIds.length} lines`));
    }
  }
  if (input.includeTranscript && input.transcript && input.transcript.segments.length > 0) {
    out.push('', heading('Transcript'));
    for (const segment of input.transcript.segments) {
      const speaker =
        (segment.speakerPersonId && input.nameOf(segment.speakerPersonId)) ||
        segment.speakerLabel ||
        'Unknown speaker';
      out.push(
        md
          ? `**${formatTimestamp(segment.startMs)}** ${speaker} — ${segment.text}`
          : `${formatTimestamp(segment.startMs)} ${speaker}: ${segment.text}`,
      );
      out.push('');
    }
  } else if (input.includeTranscript) {
    out.push('', heading('Transcript'), 'No transcript is attached to this meeting.');
  }
  out.push(
    '',
    md ? '---' : '---',
    'Generated from records stored in this workspace. No model was called to produce this document.',
  );

  return {
    ...base,
    filename: `${slug || 'meeting'}.${format}`,
    mediaType: format === 'md' ? 'text/markdown' : 'text/plain',
    includes: `meeting details, ${items.length} records with evidence ranges${
      input.includeTranscript ? ', full transcript' : ''
    }`,
    body: `${out.join('\n')}\n`,
  };
}

/** A compact printable line for the print view: same content, no file semantics. */
export function exportSummaryLabel(document: ExportDocument) {
  return `${document.filename} · ${document.includes}`;
}
