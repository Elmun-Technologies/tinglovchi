import { Badge, ButtonLink, Meta, Notice, SectionCard } from '@suhbat/ui';
import {
  buildMeetingExport,
  clockTime,
  exportFormats,
  exportFormatLabels,
  exportNotices,
  formatDuration,
  formatTimestamp,
  routes,
  type Decision,
  type MeetingExportInput,
  type Task,
} from '@suhbat/product';
import { PrintButton } from '../../../../../components/print-button';
import { getRepositories } from '../../../../../../lib/repositories';
import { exportHref, loadExportInput } from '../../../../../../lib/export-input';
import { ui } from '../../../../../../copy/ui-copy';

export const metadata = { title: ui.export.print };

/**
 * The print view: the same records as the meeting screen, laid out for paper.
 *
 * It renders from the identical typed input the downloadable files are built from, so a printed page and a
 * `.md` export can never disagree; the difference is layout, not content. Links are replaced by plain text and
 * the transcript's timestamps stay, because a citation that cannot be traced on paper is decoration.
 */
export default async function PrintMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; meetingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, meetingId } = await params;
  const query = await searchParams;
  const single = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const includeTranscript = single('transcript') === '1';
  const repositories = getRepositories();
  const loaded = await loadExportInput(repositories, workspaceId, meetingId, { includeTranscript });

  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6" data-print-body="">
        <Notice tone="danger" title={ui.errors.providerTitle}>
          <p>{loaded.error.message}</p>
        </Notice>
        <ButtonLink href={routes.meeting({ workspaceId, meetingId })} variant="secondary" size="sm">
          {ui.writes.back}
        </ButtonLink>
      </div>
    );
  }

  const { input } = loaded;
  const notices = exportNotices(input);
  const formats = exportFormats.map((format) => ({
    format,
    document: buildMeetingExport(input, format),
  }));

  return (
    <div className="print-doc mx-auto max-w-3xl space-y-4 p-4 sm:p-6" data-print-body="">
      <header className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {ui.export.printNote}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          {input.detail.title}
        </h1>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-3">
          <MetaRow label={ui.export.printLabels.company} value={input.detail.companyName ?? '—'} />
          <MetaRow label={ui.projects.title} value={input.detail.projectName ?? '—'} />
          <MetaRow label={ui.export.printLabels.type} value={input.detail.meetingTypeLabel} />
          <MetaRow
            label={ui.export.printLabels.when}
            value={`${input.detail.occurredAt.slice(0, 10)} ${clockTime(input.detail.occurredAt)}`}
          />
          <MetaRow
            label={ui.common.duration}
            value={`${formatDuration(input.detail.durationMs)}${
              input.detail.capturedMs === null
                ? ` · ${ui.common.captured}: none`
                : ` · ${ui.common.captured} ${formatDuration(input.detail.capturedMs)}`
            }`}
          />
          <MetaRow
            label={ui.common.participants}
            value={
              input.detail.participants.map((participant) => participant.name).join(', ') ||
              ui.common.none
            }
          />
        </dl>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-y border-slate-200 py-2 print:hidden">
        <span className="text-[12px] font-medium text-slate-600">{ui.export.download}:</span>
        {formats.map(({ format, document }) => (
          <ButtonLink
            key={format}
            href={exportHref(workspaceId, meetingId, format, includeTranscript)}
            variant="secondary"
            size="sm"
            title={document.includes}
          >
            {exportFormatLabels[format]}
          </ButtonLink>
        ))}
        <ButtonLink
          href={`${routes.printMeeting({ workspaceId, meetingId })}${includeTranscript ? '' : '?transcript=1'}`}
          variant="secondary"
          size="sm"
          title={includeTranscript ? ui.export.transcriptIncluded : ui.export.includeTranscript}
        >
          {includeTranscript ? ui.export.transcriptOn : ui.export.transcriptOff}
        </ButtonLink>
        <ButtonLink
          href={routes.meeting({ workspaceId, meetingId })}
          variant="ghost"
          size="sm"
          className="ml-auto"
        >
          {ui.writes.back}
        </ButtonLink>
        <PrintButton label={ui.export.print} />
      </div>

      {notices.length > 0 ? (
        <Notice tone="warning" title={ui.export.noticesTitle}>
          <ul className="list-disc space-y-0.5 pl-4">
            {notices.map((notice) => (
              <li key={notice.code}>{notice.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <SectionCard title={ui.export.printLabels.summary}>
        {input.detail.executiveSummary.length > 0 ? (
          <div className="space-y-2 text-[13.5px] leading-relaxed text-slate-800">
            {input.detail.executiveSummary.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-slate-500">{ui.export.printLabels.summaryEmpty}</p>
        )}
        {input.detail.keyOutcome ? (
          <p className="mt-3 border-t border-slate-100 pt-3 text-[13px] text-slate-700">
            <span className="font-semibold">{ui.export.printLabels.outcome}:</span>{' '}
            {input.detail.keyOutcome}
          </p>
        ) : null}
      </SectionCard>

      <RecordSection
        title={ui.meeting.decisions.title}
        records={input.decisions.map(describeDecision)}
      />
      <RecordSection
        title={ui.meeting.tasks.title}
        records={input.tasks.map((task) => describeTask(task, input))}
      />
      <RecordSection
        title={ui.meeting.facts.title}
        records={input.facts.map((fact) => ({
          id: fact.id,
          title: `${fact.label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`,
          status: fact.category,
          person: input.nameOf(fact.speakerPersonId),
          at: fact.capturedAt.slice(0, 10),
          evidence: fact.evidence[0],
        }))}
      />
      <RecordSection
        title={ui.meeting.questions.title}
        records={input.questions.map((question) => ({
          id: question.id,
          title: question.resolution
            ? `${question.text} — ${question.resolution.answer}`
            : question.text,
          status: question.status,
          person: input.nameOf(question.askedByPersonId),
          at: question.raisedOn,
          evidence: question.evidence[0],
        }))}
      />
      <RecordSection
        title={ui.meeting.ideas.title}
        records={input.ideas.map((idea) => ({
          id: idea.id,
          title: idea.text,
          status: idea.status,
          person: input.nameOf(idea.proposedByPersonId),
          at: idea.raisedOn,
          evidence: idea.evidence[0],
        }))}
      />
      <RecordSection
        title={ui.export.printLabels.commitments}
        records={input.commitments.map((commitment) => ({
          id: commitment.id,
          title: commitment.text,
          status: commitment.status,
          person: input.nameOf(commitment.byPersonId),
          at: commitment.dueDate,
          evidence: commitment.evidence[0],
        }))}
      />

      {input.topics.length > 0 ? (
        <SectionCard title={ui.meeting.topics.title}>
          <ol className="space-y-1.5 text-[13px] text-slate-800">
            {input.topics.map((topic, index) => (
              <li key={topic.id} className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[11.5px] text-slate-400">{index + 1}</span>
                <span className="min-w-0 flex-1">{topic.title}</span>
                <span className="font-mono text-[11.5px] text-slate-500">
                  {formatTimestamp(topic.startMs)}–{formatTimestamp(topic.endMs)}
                </span>
                <span className="text-[11.5px] text-slate-400">
                  {topic.segmentIds.length} {ui.common.lines}
                </span>
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}

      {input.includeTranscript && input.transcript && input.transcript.segments.length > 0 ? (
        <SectionCard title={ui.meeting.transcript.title}>
          <p className="mb-2 text-[12px] text-slate-500">
            {input.transcript.segments.length} {ui.common.lines} ·{' '}
            {formatDuration(input.transcript.totalMs)} · {input.transcript.wordCount} words
          </p>
          <ol className="space-y-1.5 text-[12.5px] leading-relaxed text-slate-800">
            {input.transcript.segments.map((segment) => (
              <li key={segment.id} className="flex gap-2 break-inside-avoid">
                <span className="shrink-0 font-mono text-[11px] text-slate-400">
                  {formatTimestamp(segment.startMs)}
                </span>
                <span className="shrink-0 font-semibold text-slate-700">
                  {input.nameOf(segment.speakerPersonId) ?? segment.speakerLabel}
                </span>
                <span className="min-w-0 flex-1">{segment.text}</span>
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}

      <footer className="border-t border-slate-200 pt-2 text-[11.5px] text-slate-500">
        {ui.export.generatedFrom} {ui.export.disclaimer}
      </footer>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="truncate text-slate-800">{value}</dd>
    </div>
  );
}

type PrintableRecord = {
  id: string;
  title: string;
  status?: string;
  person?: string;
  at?: string | null;
  evidence?: { startMs: number; endMs: number };
};

function describeDecision(decision: Decision) {
  return {
    id: decision.id,
    title: `${decision.title} — ${decision.description}`,
    status: decision.status,
    at: decision.decidedOn,
    evidence: decision.evidence[0],
  };
}

function describeTask(task: Task, input: MeetingExportInput) {
  return {
    id: task.id,
    title: task.detail ? `${task.title} — ${task.detail}` : task.title,
    status: `${task.status} · ${task.priority}`,
    person: task.ownerLabel ?? input.nameOf(task.ownerPersonId),
    at: task.dueDate,
    evidence: task.evidence[0],
  };
}

/** A section of flat records: title, status, who, when, and the transcript range it came from. */
function RecordSection({ title, records }: { title: string; records: PrintableRecord[] }) {
  return (
    <SectionCard title={`${title} (${records.length})`}>
      {records.length === 0 ? (
        <p className="text-[13px] text-slate-500">
          No {title.toLowerCase()} recorded for this meeting.
        </p>
      ) : (
        <ul className="space-y-2">
          {records.map((record) => (
            <li key={record.id} className="break-inside-avoid">
              <p className="text-[13.5px] leading-snug text-slate-900">{record.title}</p>
              <Meta className="mt-0.5">
                {record.status ? <Badge tone="neutral">{record.status}</Badge> : null}
                {record.person ? <span>{record.person}</span> : null}
                {record.at ? <span className="font-mono text-[11.5px]">{record.at}</span> : null}
                {record.evidence ? (
                  <span className="font-mono text-[11.5px] text-slate-500">
                    {formatTimestamp(record.evidence.startMs)}–
                    {formatTimestamp(record.evidence.endMs)}
                  </span>
                ) : (
                  <span>no evidence range</span>
                )}
              </Meta>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
