import {
  clockTime,
  formatDuration,
  relativeDayLabel,
  routes,
  type MeetingListRow,
} from '@suhbat/product';
import {
  ButtonLink,
  EmptyState,
  LanguageBadges,
  MeetingStatusBadge,
  MeetingTypeBadge,
  ParticipantStack,
  Table,
  TableScroller,
  Td,
  Th,
  Tr,
} from '@suhbat/ui';
import { ui } from '../../copy/ui-copy';

/**
 * The meetings table, shared by the dashboard, the meetings page and the company/project tabs so a meeting row
 * means the same thing everywhere. Table-first on desktop; the scroller keeps it readable rather than crushing
 * seven columns into a phone.
 */
export function MeetingTable({
  rows,
  workspaceId,
  todayIsoDate,
  emptyTitle = ui.meetings.emptyAllTitle,
  emptyBody = ui.meetings.emptyAllBody,
  emptyAction,
  dense = false,
}: {
  rows: MeetingListRow[];
  workspaceId: string;
  todayIsoDate?: string;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: { href: string; label: string };
  dense?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyBody}
        icon="search"
        action={
          emptyAction ? (
            <ButtonLink href={emptyAction.href}>{emptyAction.label}</ButtonLink>
          ) : undefined
        }
      />
    );
  }

  return (
    <TableScroller>
      <Table>
        <caption className="sr-only">{ui.meetings.title}</caption>
        <thead>
          <tr>
            <Th>{ui.meetings.columns.meeting}</Th>
            <Th>{ui.meetings.columns.when}</Th>
            <Th>{ui.meetings.columns.type}</Th>
            <Th>{ui.meetings.columns.status}</Th>
            <Th align="right">{ui.meetings.columns.decisions}</Th>
            <Th align="right">{ui.meetings.columns.tasks}</Th>
            <Th>{ui.meetings.columns.languages}</Th>
            {!dense ? <Th>{ui.meetings.columns.duration}</Th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { meeting } = row;
            const href = routes.meeting({ workspaceId, meetingId: meeting.id });
            return (
              <Tr key={meeting.id}>
                <Td className="max-w-[26rem]">
                  <div className="min-w-0">
                    <a
                      href={href}
                      className="rounded text-[14px] font-semibold leading-snug text-slate-900 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                    >
                      {meeting.title}
                    </a>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-slate-500">
                      <span>{meeting.companyName ?? ui.common.noCompany}</span>
                      {meeting.projectName ? (
                        <>
                          <span className="text-slate-300">·</span>
                          <span>{meeting.projectName}</span>
                        </>
                      ) : null}
                    </p>
                    {!dense ? (
                      <p className="mt-1.5 flex items-center gap-2">
                        <ParticipantStack participants={meeting.participants} max={4} />
                        <span className="text-[11.5px] text-slate-400">
                          {meeting.participants.length} {ui.common.participants}
                        </span>
                      </p>
                    ) : null}
                  </div>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="block text-[13px] font-medium text-slate-800">
                    {todayIsoDate
                      ? relativeDayLabel(meeting.occurredAt, todayIsoDate)
                      : meeting.occurredAt.slice(0, 10)}
                  </span>
                  <span className="block font-mono text-[11.5px] text-slate-500">
                    {clockTime(meeting.occurredAt)}
                  </span>
                </Td>
                <Td>
                  <MeetingTypeBadge label={meeting.meetingTypeLabel} />
                </Td>
                <Td>
                  <MeetingStatusBadge state={meeting.state} withNote />
                </Td>
                <Td align="right">
                  <span className="text-[13px] font-semibold tabular-nums text-slate-800">
                    {meeting.counts.decisions}
                  </span>
                </Td>
                <Td align="right">
                  <span className="inline-flex items-center gap-1.5">
                    {row.overdueTaskCount > 0 ? (
                      <span className="rounded-full bg-rose-50 px-1.5 py-px text-[11px] font-semibold text-rose-800">
                        {row.overdueTaskCount} late
                      </span>
                    ) : null}
                    <span className="text-[13px] font-semibold tabular-nums text-slate-800">
                      {row.openTaskCount}
                    </span>
                  </span>
                </Td>
                <Td>
                  <LanguageBadges languages={meeting.languages} />
                </Td>
                {!dense ? (
                  <Td className="whitespace-nowrap">
                    <span className="text-[13px] tabular-nums text-slate-700">
                      {formatDuration(meeting.durationMs)}
                    </span>
                    {meeting.capturedMs !== null && meeting.capturedMs !== meeting.durationMs ? (
                      <span
                        className="block text-[11px] text-slate-400"
                        title="Captured audio is shorter than the scheduled duration; the timeline is canonical."
                      >
                        {ui.common.captured} {formatDuration(meeting.capturedMs)}
                      </span>
                    ) : null}
                  </Td>
                ) : null}
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableScroller>
  );
}
