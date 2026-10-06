import { ButtonLink, SectionCard } from '@suhbat/ui';
import { exportFormatLabels, exportFormats, routes, type DataCapabilities } from '@suhbat/product';
import type { MeetingBundle } from '../../../lib/meeting-bundle';
import { exportHref } from '../../../lib/export-input';
import { ui } from '../../../copy/ui-copy';

/**
 * The export and print entry point on a meeting's overview.
 *
 * It lists what a document would contain *before* one is produced, from the counts the page already has — no
 * speculative read, and no file format that the product cannot actually build. If a transcript is attached, the
 * reader chooses whether it goes in; the default is without, because a transcript is the bulk of the document and
 * most readers want the decisions first.
 */
export function MeetingExportPanel({
  workspaceId,
  bundle,
  capabilities,
}: {
  workspaceId: string;
  bundle: MeetingBundle;
  capabilities: DataCapabilities;
}) {
  const { detail } = bundle;
  const meetingId = detail.id;
  const segments = detail.counts.segments;
  const recordCount =
    detail.stats.decisions +
    detail.stats.tasks +
    detail.stats.facts +
    detail.stats.questions +
    detail.stats.ideas;
  const printHref = routes.printMeeting({ workspaceId, meetingId });

  return (
    <SectionCard
      title={ui.export.title}
      description={ui.export.intro}
      anchorId="export"
      actions={
        <ButtonLink href={`${printHref}?transcript=1`} variant="secondary" size="sm">
          {ui.export.print}
        </ButtonLink>
      }
    >
      <p className="text-[13px] text-slate-600">
        {recordCount} {recordCount === 1 ? 'record' : 'records'}
        {segments > 0
          ? ` · ${segments} ${ui.common.lines} (${ui.export.transcriptOmitted})`
          : ` · ${ui.export.transcriptOmitted}`}
      </p>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {exportFormats.map((format) => (
          <li
            key={format}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2"
          >
            <span className="text-[13px] font-medium text-slate-900">
              {exportFormatLabels[format]}
            </span>
            <span className="min-w-0 flex-1 text-[11.5px] text-slate-500">
              {format === 'json'
                ? 'meeting, participants, records, evidence ranges'
                : format === 'csv'
                  ? 'one row per record'
                  : format === 'md'
                    ? 'sections with citations'
                    : 'readable in any editor'}
            </span>
            <ButtonLink
              href={exportHref(workspaceId, meetingId, format, false)}
              variant="ghost"
              size="sm"
              title={
                capabilities.writes
                  ? ui.export.formatHint
                  : `${ui.export.formatHint} · ${capabilities.provenanceLabel}`
              }
            >
              {ui.export.download}
            </ButtonLink>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-slate-500">
        {segments > 0 ? (
          <>
            <a
              href={exportHref(workspaceId, meetingId, 'md', true)}
              className="rounded underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              {ui.export.includeTranscript}
            </a>{' '}
            ·{' '}
          </>
        ) : (
          <span>No transcript is attached to this meeting, so none can be included. </span>
        )}
        <a
          href={printHref}
          className="rounded underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
        >
          {ui.export.openPrint}
        </a>
      </p>
    </SectionCard>
  );
}
