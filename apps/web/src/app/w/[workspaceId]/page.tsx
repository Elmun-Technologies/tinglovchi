import {
  DecisionCard,
  EmptyState,
  Metric,
  ProcessingState,
  SectionCard,
  TaskRow,
  PageHeader,
  ButtonLink,
  Notice,
} from '@suhbat/ui';
import { clockTime, formatDuration, relativeDayLabel, routes } from '@suhbat/product';
import { loadAll, type ProcessingTimeline } from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../lib/repositories';
import { buildLookup } from '../../../lib/lookup';
import { readFlash } from '../../../lib/feedback';
import { advanceMeetingStateAction, setTaskStatusAction } from '../../actions/product';
import { ui } from '../../../copy/ui-copy';
import { MeetingTable } from '../../components/meeting-table';

/**
 * The workspace home: what happened today, what is stuck, and what is owed. Deliberately no charts — a meeting
 * product earns trust with counts that resolve to records, not with a sparkline of an invented series.
 */
export default async function WorkspaceDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const flash = readFlash(await searchParams);
  const repositories = getRepositories();
  const loaded = await loadAll({
    dashboard: repositories.meetings.dashboard(workspaceId),
    tasks: repositories.tasks.list(workspaceId, { bucket: 'open' }),
  });
  if (!loaded.ok) {
    return (
      <div className="space-y-4">
        <PageHeader title={ui.dashboard.title} />
        <Notice tone="danger" title={ui.errors.providerTitle}>
          <p>{loaded.error.message}</p>
          {loaded.error.hint ? <p className="text-slate-500">{loaded.error.hint}</p> : null}
        </Notice>
      </div>
    );
  }
  const { dashboard } = loaded.data;
  const lookup = await buildLookup(repositories, workspaceId);
  const capabilities = getCapabilities();
  const today = dashboard.generatedAt.slice(0, 10);
  const attention = dashboard.processing.filter(
    (timeline) => timeline.state !== 'ready' && timeline.state !== 'draft',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={ui.dashboard.title}
        description={ui.dashboard.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {dashboard.meetingCount} {ui.common.meetings} · {dashboard.companyCount} companies ·{' '}
            snapshot {dashboard.generatedAt.slice(0, 16).replace('T', ' ')}
          </span>
        }
        actions={
          <ButtonLink href={routes.newMeeting({ workspaceId })}>
            {ui.dashboard.emptyAction}
          </ButtonLink>
        }
      />
      {flash ? (
        <Notice tone={flash.tone} title={flash.title}>
          {flash.body}
        </Notice>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
        <Metric
          label={ui.dashboard.today}
          value={dashboard.todayMeetings.length}
          hint="meetings captured"
        />
        <Metric
          label={ui.tasks.buckets.open}
          value={dashboard.openTaskCount}
          hint="across all meetings"
        />
        <Metric
          label={ui.dashboard.overdueTasks}
          value={dashboard.overdueTaskCount}
          tone={dashboard.overdueTaskCount > 0 ? 'danger' : 'neutral'}
          hint="past their deadline"
        />
        <Metric
          label={ui.dashboard.decisions7d}
          value={dashboard.decisionCount7d}
          hint="recorded"
        />
        <Metric
          label={ui.dashboard.openQuestions}
          value={dashboard.openQuestionCount}
          tone={dashboard.openQuestionCount > 0 ? 'warning' : 'neutral'}
          hint="still unanswered"
        />
        <Metric
          label={ui.dashboard.companies}
          value={dashboard.companyCount}
          hint="with meetings"
        />
      </dl>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <SectionCard
            title={ui.meetings.title}
            description="Most recent captures, with what each one produced."
            anchorId="meetings"
            flush
            actions={
              <ButtonLink href={routes.meetings({ workspaceId })} size="sm" variant="ghost">
                {ui.common.viewAll}
              </ButtonLink>
            }
          >
            <MeetingTable
              rows={dashboard.recentMeetings}
              workspaceId={workspaceId}
              todayIsoDate={today}
              dense
              emptyTitle={ui.dashboard.emptyTitle}
              emptyBody={ui.dashboard.emptyBody}
              emptyAction={{
                href: routes.newMeeting({ workspaceId }),
                label: ui.dashboard.emptyAction,
              }}
            />
          </SectionCard>

          {attention.length > 0 ? (
            <SectionCard
              title={ui.dashboard.attention}
              description="Pipeline steps that have not finished. Progress is reported as steps, never as a percentage."
              anchorId="processing"
            >
              <ul className="space-y-3">
                {attention.map((timeline) => (
                  <PipelineCard
                    key={timeline.meetingId}
                    timeline={timeline}
                    workspaceId={workspaceId}
                    allowDemoTransition={capabilities.demoStateTransitions}
                  />
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <SectionCard
            title={ui.dashboard.recentDecisions}
            description="Decisions as recorded, including the ones still provisional or decided against."
            anchorId="decisions"
            actions={
              <ButtonLink
                href={routes.knowledge({ workspaceId }, { kind: 'decision' })}
                size="sm"
                variant="ghost"
              >
                {ui.common.viewAll}
              </ButtonLink>
            }
          >
            {dashboard.recentDecisions.length === 0 ? (
              <EmptyState
                title={ui.meeting.decisions.emptyTitle}
                description={ui.meeting.decisions.emptyBody}
                icon="check"
              />
            ) : (
              <ul className="grid gap-2.5 lg:grid-cols-2">
                {dashboard.recentDecisions.slice(0, 4).map((decision) => (
                  <li key={decision.id}>
                    <DecisionCard
                      decision={decision}
                      variant="compact"
                      hrefOf={lookup.evidence.hrefOf}
                      namesOf={lookup.evidence.namesOf}
                      topicLabel={lookup.meetings.get(decision.meetingId)?.title}
                    />
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard
            title={ui.dashboard.recentTasks}
            anchorId="tasks"
            description="Follow-ups with an owner and a deadline, straight from the transcript."
            actions={
              <ButtonLink href={routes.tasks({ workspaceId })} size="sm" variant="ghost">
                {ui.common.viewAll}
              </ButtonLink>
            }
          >
            {loaded.data.tasks.length === 0 ? (
              <EmptyState
                title={ui.tasks.emptyTitle}
                description={ui.tasks.emptyBody}
                icon="check"
              />
            ) : (
              <ul className="space-y-2">
                {loaded.data.tasks.slice(0, 6).map((task) => (
                  <li key={task.id}>
                    <TaskRow
                      task={task}
                      todayIsoDate={today}
                      variant="compact"
                      showMeeting
                      meetingHref={routes.meeting({ workspaceId, meetingId: task.meetingId })}
                      companyName={lookup.companies.get(task.companyId ?? '')}
                      projectName={lookup.projects.get(task.projectId ?? '')}
                      hrefOf={lookup.evidence.hrefOf}
                      namesOf={lookup.evidence.namesOf}
                      updateAction={
                        capabilities.mode === 'demo'
                          ? {
                              action: setTaskStatusAction,
                              status: task.status === 'completed' ? 'open' : 'completed',
                            }
                          : undefined
                      }
                      blockedReason={
                        capabilities.mode === 'demo' ? undefined : ui.tasks.updateBlocked
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title={ui.dashboard.today}
            anchorId="today"
            description="Meetings captured on the dashboard’s reference day."
          >
            {dashboard.todayMeetings.length === 0 ? (
              <p className="text-[13px] text-slate-500">{ui.dashboard.todayEmpty}</p>
            ) : (
              <ul className="space-y-2">
                {dashboard.todayMeetings.map((meeting) => (
                  <li
                    key={meeting.id}
                    className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <a
                        href={routes.meeting({ workspaceId, meetingId: meeting.id })}
                        className="block truncate text-[13.5px] font-semibold text-slate-900 hover:text-teal-900"
                      >
                        {meeting.title}
                      </a>
                      <span className="mt-0.5 block text-[12px] text-slate-500">
                        {relativeDayLabel(meeting.occurredAt, today)} ·{' '}
                        {formatDuration(meeting.durationMs)} · {meeting.counts.decisions} decisions
                        · {meeting.counts.tasks} tasks
                      </span>
                    </span>
                    <span className="shrink-0 text-[11.5px] font-mono text-slate-400">
                      {clockTime(meeting.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {dashboard.upcomingOrToday.some((meeting) => meeting.state === 'draft') ? (
              <p className="mt-2.5 text-[12.5px] text-slate-500">
                {dashboard.upcomingOrToday.filter((meeting) => meeting.state === 'draft').length}{' '}
                draft
                {dashboard.upcomingOrToday.filter((meeting) => meeting.state === 'draft').length ===
                1
                  ? ''
                  : 's'}{' '}
                hold a place for a meeting that has not been captured.
              </p>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function PipelineCard({
  timeline,
  workspaceId,
  allowDemoTransition,
}: {
  timeline: ProcessingTimeline;
  workspaceId: string;
  allowDemoTransition: boolean;
}) {
  const meetingHref = routes.meeting({ workspaceId, meetingId: timeline.meetingId });
  return (
    <li>
      <ProcessingState
        timeline={timeline}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a
              href={meetingHref}
              className="rounded text-[12.5px] font-medium text-teal-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              {ui.common.back} to meeting
            </a>
            {allowDemoTransition ? (
              <form action={advanceMeetingStateAction} className="flex items-center gap-2">
                <input type="hidden" name="meetingId" value={timeline.meetingId} />
                <input type="hidden" name="next" value={routes.home({ workspaceId })} />
                <button
                  type="submit"
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-teal-700/30 bg-teal-50 px-2.5 text-[12.5px] font-semibold text-teal-900 hover:bg-teal-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                  title={ui.meeting.processing.demoAdvanceHint}
                >
                  {ui.meeting.processing.demoAdvance}
                </button>
              </form>
            ) : null}
          </div>
        }
      />
    </li>
  );
}
