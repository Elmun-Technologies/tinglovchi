import type { ReactNode } from 'react';
import {
  ButtonLink,
  Disclosure,
  DisclosureItem,
  Dot,
  EmptyState,
  LanguageBadges,
  MeetingStatusBadge,
  MeetingTypeBadge,
  Notice,
  PageHeader,
  ParticipantStack,
  ProcessingState,
  TabNav,
  type TabItem,
} from '@suhbat/ui';
import {
  can,
  clockTime,
  formatDuration,
  meetingTabLabels,
  meetingTabs,
  routes,
  type DataCapabilities,
  type MeetingDetail,
  type MeetingTab,
} from '@suhbat/product';
import type { MeetingBundle } from '../../../lib/meeting-bundle';
import type { Flash } from '../../../lib/feedback';
import { ui } from '../../../copy/ui-copy';
import { advanceMeetingStateAction } from '../../actions/product';

/**
 * Meeting detail frame: header, actions and tabs, shared by all eight tab routes.
 *
 * Tabs are sub-routes rather than component state, which is what makes a deep view
 * (`…/transcript?seg=seg_018#seg_018`) linkable and keeps a tab switch a navigation instead of a re-render of a
 * giant client component.
 */
export function MeetingFrame({
  workspaceId,
  meetingId,
  tab,
  bundle,
  capabilities,
  children,
  notice = null,
}: {
  workspaceId: string;
  meetingId: string;
  tab: MeetingTab;
  bundle: MeetingBundle;
  capabilities: DataCapabilities;
  children: ReactNode;
  /** Result of a server action that redirected back here, already turned into a sentence. */
  notice?: Flash | null;
}) {
  const { detail, processing } = bundle;
  const notReady = detail.state !== 'ready';
  const tabs: TabItem[] = meetingTabs.map((key) => ({
    id: key,
    href:
      key === 'overview'
        ? routes.meeting({ workspaceId, meetingId })
        : routes.meetingTab({ workspaceId, meetingId, tab: key }),
    label: meetingTabLabels[key],
    count: tabCount(detail, key),
    active: key === tab,
  }));

  return (
    <div className="space-y-5">
      {notice ? (
        <Notice tone={notice.tone} title={notice.title}>
          <p>{notice.body}</p>
        </Notice>
      ) : null}
      <PageHeader
        headingId="meeting-title"
        title={detail.title}
        breadcrumbs={[
          { label: ui.nav.meetings, href: routes.meetings({ workspaceId }) },
          { label: detail.title },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px] text-slate-500">
            <MeetingStatusBadge state={detail.state} withNote />
            <MeetingTypeBadge label={detail.meetingTypeLabel} />
            {detail.companyId ? (
              <a
                href={routes.company({ workspaceId, companyId: detail.companyId })}
                className="inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                <Dot tone="accent" />
                {detail.companyName}
              </a>
            ) : (
              <span>{ui.common.noCompany}</span>
            )}
            {detail.projectId ? (
              <a
                href={routes.project({ workspaceId, projectId: detail.projectId })}
                className="rounded underline decoration-slate-300 underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                {detail.projectName}
              </a>
            ) : null}
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span>
              {detail.occurredAt.slice(0, 10)} · {clockTime(detail.occurredAt)}
            </span>
            <span>
              {ui.common.duration} {formatDuration(detail.durationMs)}
            </span>
            {detail.capturedMs !== null ? (
              <span title="Captured audio is shorter than the scheduled duration; the timeline stays canonical.">
                {ui.common.captured} {formatDuration(detail.capturedMs)}
              </span>
            ) : null}
            <LanguageBadges languages={detail.languages} />
            <span className="inline-flex items-center gap-1.5">
              <ParticipantStack participants={detail.participants} max={6} size="sm" />
              {detail.participants.length} {ui.common.participants}
            </span>
          </div>
        }
        actions={
          <MeetingActions workspaceId={workspaceId} detail={detail} capabilities={capabilities} />
        }
      />

      {notReady && processing ? (
        <ProcessingState
          timeline={processing}
          footer={
            capabilities.demoStateTransitions ? (
              <form
                action={advanceMeetingStateAction}
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="meetingId" value={meetingId} />
                <input
                  type="hidden"
                  name="next"
                  value={routes.meeting({ workspaceId, meetingId })}
                />
                <button
                  type="submit"
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-teal-700/30 bg-teal-50 px-2.5 text-[12.5px] font-semibold text-teal-900 hover:bg-teal-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  {ui.meeting.processing.demoAdvance}
                </button>
                <span className="max-w-md text-[12px] text-slate-500">
                  {ui.meeting.processing.demoAdvanceHint}
                </span>
              </form>
            ) : (
              <span>{ui.meeting.processing.noPercentages}</span>
            )
          }
        />
      ) : null}

      {!notReady && detail.unmappedSpeakers.length > 0 ? (
        <Notice
          tone="warning"
          title={`${detail.unmappedSpeakers.length} ${ui.speakers.unmappedCount}`}
          actions={
            <ButtonLink
              href={routes.meetingTab(
                { workspaceId, meetingId, tab: 'transcript' },
                { map: detail.unmappedSpeakers[0] },
              )}
              size="sm"
              variant="secondary"
            >
              {ui.meeting.transcript.mapSpeakers}
            </ButtonLink>
          }
        >
          <p>{ui.meeting.overview.unmappedBody}</p>
          <p className="text-slate-500">
            {detail.unmappedSpeakers.map((label) => `${ui.speakers.label} “${label}”`).join(' · ')}
          </p>
        </Notice>
      ) : null}

      <TabNav tabs={tabs} />
      {children}
    </div>
  );
}

/**
 * Header actions. Anything this build cannot do is present but inert, with the reason attached, rather than
 * hidden or animated as if it worked.
 */
function MeetingActions({
  workspaceId,
  detail,
  capabilities,
}: {
  workspaceId: string;
  detail: MeetingDetail;
  capabilities: DataCapabilities;
}) {
  const meetingId = detail.id;
  const playable = detail.recording.available && detail.recording.source !== 'none';
  // A draft is the only meeting this screen may change, and only when the data source can write one.
  const canEditDraft = detail.state === 'draft' && can(capabilities, 'meeting.draft.update');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonLink
        href={playable ? routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' }) : ''}
        variant={playable ? 'primary' : 'secondary'}
        disabled={!playable}
        title={playable ? detail.recording.note : ui.meeting.playbackUnavailable}
      >
        {ui.meeting.actions.play}
      </ButtonLink>
      {canEditDraft ? (
        <ButtonLink
          href={routes.editMeeting({ workspaceId, meetingId })}
          variant="secondary"
          title={ui.newMeeting.editIntro}
        >
          {ui.writes.edit}
        </ButtonLink>
      ) : null}
      <Disclosure label={ui.meeting.actions.more}>
        <DisclosureItem
          label={ui.meeting.actions.export}
          href={routes.printMeeting({ workspaceId, meetingId })}
          hint={ui.export.printNote}
          icon="file"
        />
        <DisclosureItem
          label={ui.meeting.actions.share}
          disabled
          hint={ui.common.shareNote}
          icon="link"
        />
        <DisclosureItem
          label={ui.speakers.dialogTitle}
          href={routes.meetingTab(
            { workspaceId, meetingId, tab: 'transcript' },
            { map: detail.unmappedSpeakers[0] ?? 'Speaker A' },
          )}
          hint={ui.speakers.mappedNotice}
          icon="user"
        />
        <DisclosureItem
          label={ui.meeting.transcript.title}
          href={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
          hint={`${detail.counts.segments} ${ui.meeting.transcript.lineCount}`}
          icon="link"
        />
      </Disclosure>
    </div>
  );
}

export function MeetingTabShell({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}

export function MeetingEmptyTab({
  title,
  description,
  href,
  hrefLabel,
}: {
  title: string;
  description: string;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <EmptyState
        title={title}
        description={description}
        icon="file"
        action={
          href ? (
            <ButtonLink href={href} size="sm" variant="secondary">
              {hrefLabel}
            </ButtonLink>
          ) : undefined
        }
      />
    </div>
  );
}

function tabCount(detail: MeetingDetail, tab: MeetingTab): number | undefined {
  if (tab === 'overview') return undefined;
  if (tab === 'transcript') return detail.counts.segments;
  return detail.counts[tab as keyof MeetingDetail['counts']];
}
