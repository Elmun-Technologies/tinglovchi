import {
  ButtonLink,
  DecisionCard,
  EmptyState,
  FactCard,
  Metric,
  Notice,
  ParticipantAvatar,
  QuestionCard,
  SectionCard,
  TaskRow,
} from '@suhbat/ui';
import {
  formatDuration,
  participantKindLabels,
  routes,
  speakingStats,
  type DataCapabilities,
} from '@suhbat/product';
import type { Lookup } from '../../../lib/lookup';
import type { MeetingBundle } from '../../../lib/meeting-bundle';
import { ui } from '../../../copy/ui-copy';
import { MeetingExportPanel } from './export-panel';

/**
 * Meeting overview: what the meeting decided and owed, with the evidence one click away. Numbers here are the
 * same arrays the other tabs render, so a count on this page can never disagree with its tab.
 */
export function MeetingOverview({
  workspaceId,
  bundle,
  lookup,
  todayIsoDate,
  capabilities,
}: {
  workspaceId: string;
  bundle: MeetingBundle;
  lookup: Lookup;
  todayIsoDate: string;
  capabilities: DataCapabilities;
}) {
  const { detail, decisions, tasks, facts, questions, transcript } = bundle;
  const meetingId = detail.id;
  const openQuestions = questions.filter((question) => question.status === 'open');
  const stats = speakingStats(transcript.segments);
  const linesOf = (personId: string) =>
    stats.find((stat) => stat.personId === personId)?.segments ?? 0;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <SectionCard
          title={ui.meeting.overview.summary}
          anchorId="summary"
          description="Written from the captured lines of this meeting. No model was called for this demo."
        >
          {detail.executiveSummary.length === 0 ? (
            <p className="text-[13px] text-slate-500">{ui.meeting.overview.summaryEmpty}</p>
          ) : (
            <ul className="space-y-2.5">
              {detail.executiveSummary.map((line, index) => (
                <li key={index} className="flex gap-2.5 text-[14px] leading-relaxed text-slate-800">
                  <span
                    className="mt-2 size-1.5 shrink-0 rounded-full bg-teal-600"
                    aria-hidden="true"
                  />
                  {line}
                </li>
              ))}
            </ul>
          )}
          {detail.keyOutcome ? (
            <p className="mt-3 rounded-lg border-l-2 border-teal-700 bg-teal-50/60 px-3 py-2 text-[13.5px] text-teal-950">
              {detail.keyOutcome}
            </p>
          ) : null}
        </SectionCard>

        <SectionCard
          title={ui.meeting.overview.keyDecisions}
          anchorId="key-decisions"
          description={`${detail.stats.confirmedDecisions} confirmed of ${detail.stats.decisions} ${ui.meeting.overview.decisions}.`}
          actions={
            <ButtonLink
              href={routes.meetingTab({ workspaceId, meetingId, tab: 'decisions' })}
              size="sm"
              variant="ghost"
            >
              {ui.common.viewAll}
            </ButtonLink>
          }
        >
          {decisions.length === 0 ? (
            <EmptyState
              title={ui.meeting.decisions.emptyTitle}
              description={ui.meeting.decisions.emptyBody}
              icon="check"
            />
          ) : (
            <ul className="space-y-2.5">
              {decisions.slice(0, 4).map((decision) => (
                <li key={decision.id}>
                  <DecisionCard
                    decision={decision}
                    variant="compact"
                    hrefOf={lookup.evidence.hrefOf}
                    namesOf={lookup.evidence.namesOf}
                    participantNames={decision.participantPersonIds
                      .map((personId) => lookup.nameOf(personId))
                      .filter((name): name is string => Boolean(name))}
                  />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title={ui.meeting.overview.actionItems}
          anchorId="action-items"
          description="Owner and deadline as they were stated in the room."
          actions={
            <ButtonLink
              href={routes.meetingTab({ workspaceId, meetingId, tab: 'tasks' })}
              size="sm"
              variant="ghost"
            >
              {ui.common.viewAll}
            </ButtonLink>
          }
        >
          {tasks.length === 0 ? (
            <EmptyState
              title={ui.meeting.tasks.emptyTitle}
              description={ui.meeting.tasks.emptyBody}
              icon="check"
            />
          ) : (
            <ul className="space-y-2">
              {tasks.slice(0, 5).map((task) => (
                <li key={task.id}>
                  <TaskRow
                    task={task}
                    todayIsoDate={todayIsoDate}
                    variant="compact"
                    hrefOf={lookup.evidence.hrefOf}
                    namesOf={lookup.evidence.namesOf}
                    blockedReason={ui.tasks.updateBlocked}
                  />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {openQuestions.length > 0 ? (
          <SectionCard
            title={ui.meeting.overview.openQuestions}
            anchorId="open-questions"
            description="Left unanswered in the meeting, in the words used there."
            actions={
              <ButtonLink
                href={routes.meetingTab({ workspaceId, meetingId, tab: 'questions' })}
                size="sm"
                variant="ghost"
              >
                {ui.common.viewAll}
              </ButtonLink>
            }
          >
            <ul className="space-y-2.5">
              {openQuestions.map((question) => (
                <li key={question.id}>
                  <QuestionCard
                    question={question}
                    askedByName={lookup.nameOf(question.askedByPersonId)}
                    hrefOf={lookup.evidence.hrefOf}
                    namesOf={lookup.evidence.namesOf}
                  />
                </li>
              ))}
            </ul>
          </SectionCard>
        ) : null}
      </div>

      <div className="space-y-5">
        <SectionCard
          title={ui.meeting.overview.stats}
          anchorId="stats"
          description={ui.meeting.overview.statsNote}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-2">
            <Metric label={ui.common.duration} value={formatDuration(detail.durationMs)} />
            <Metric label={ui.meeting.overview.words} value={detail.stats.words} />
            <Metric
              label={ui.meeting.topics.coverage}
              value={detail.counts.topics}
              hint={ui.meeting.overview.topics}
            />
            <Metric label={ui.meeting.decisions.title} value={detail.stats.decisions} />
            <Metric
              label={ui.tasks.buckets.open}
              value={detail.stats.openTasks}
              hint={`${detail.stats.tasks} total`}
              tone={detail.stats.openTasks > 0 ? 'warning' : 'neutral'}
            />
            <Metric
              label={ui.dashboard.openQuestions}
              value={detail.stats.openQuestions}
              tone={detail.stats.openQuestions > 0 ? 'warning' : 'neutral'}
              hint={`${detail.stats.questions} raised`}
            />
          </dl>
        </SectionCard>

        <SectionCard title={ui.meeting.overview.speakingShare} anchorId="speaking">
          <ul className="space-y-1.5">
            {stats.map((stat) => {
              const person = stat.personId ? lookup.participants.get(stat.personId) : undefined;
              const key = stat.personId ?? `label:${stat.label}`;
              return (
                <li key={key} className="flex items-center gap-2 text-[12.5px]">
                  {person ? (
                    <ParticipantAvatar
                      name={person.name}
                      initials={person.initials}
                      kind={person.kind}
                      size="sm"
                    />
                  ) : (
                    <ParticipantAvatar name={stat.label} initials="?" size="sm" unmapped />
                  )}
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {person?.name ?? stat.label}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-slate-500">
                    {formatDuration(stat.spokenMs)}
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-slate-500">
                    {Math.round(stat.share * 100)}%
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11.5px] text-slate-400">{ui.meeting.transcript.mappedNotice}</p>
        </SectionCard>

        <SectionCard
          title={ui.meeting.overview.participants}
          anchorId="participants"
          actions={
            <ButtonLink
              href={routes.meetingTab(
                { workspaceId, meetingId, tab: 'transcript' },
                { map: detail.unmappedSpeakers[0] },
              )}
              size="sm"
              variant="ghost"
              disabled={detail.unmappedSpeakers.length === 0}
              title={detail.unmappedSpeakers.length > 0 ? ui.speakers.dialogTitle : undefined}
            >
              {ui.meeting.transcript.mapSpeakers}
            </ButtonLink>
          }
        >
          <ul className="space-y-1.5">
            {detail.participants.map((participant) => (
              <li key={participant.personId} className="flex items-center gap-2.5">
                <ParticipantAvatar
                  name={participant.name}
                  initials={participant.initials}
                  kind={participant.kind}
                  size="sm"
                  unmapped={!participant.mapped}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-800">
                  {participant.name}
                </span>
                <span className="shrink-0 text-[11.5px] text-slate-500">
                  {participantKindLabels[participant.kind]}
                </span>
                <span className="shrink-0 text-[11.5px] text-slate-400">
                  {participant.spokeInMeeting
                    ? `${linesOf(participant.personId)} ${ui.meeting.transcript.lineCount}`
                    : 'no lines'}
                </span>
              </li>
            ))}
          </ul>
          {detail.unmappedSpeakers.length > 0 ? (
            <Notice tone="warning" className="mt-3" title={ui.meeting.overview.unmappedTitle}>
              <p>{ui.meeting.overview.unmappedBody}</p>
            </Notice>
          ) : null}
        </SectionCard>

        <SectionCard title={ui.meeting.actions.play} anchorId="recording">
          <p className="text-[13px] leading-relaxed text-slate-600">{detail.recording.note}</p>
          <p className="mt-1.5 text-[12px] text-slate-500">{ui.meeting.playbackUnavailable}</p>
          {detail.recording.manifestSessionId ? (
            <p className="mt-2 font-mono text-[11.5px] text-slate-400">
              session {detail.recording.manifestSessionId}
            </p>
          ) : null}
        </SectionCard>

        {facts.length > 0 ? (
          <SectionCard
            title={ui.meeting.facts.title}
            anchorId="facts-preview"
            actions={
              <ButtonLink
                href={routes.meetingTab({ workspaceId, meetingId, tab: 'facts' })}
                size="sm"
                variant="ghost"
              >
                {ui.common.viewAll}
              </ButtonLink>
            }
          >
            <div className="space-y-1.5">
              {facts.slice(0, 3).map((fact) => (
                <FactCard
                  key={fact.id}
                  fact={fact}
                  variant="compact"
                  hrefOf={lookup.evidence.hrefOf}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        <MeetingExportPanel workspaceId={workspaceId} bundle={bundle} capabilities={capabilities} />
      </div>
    </div>
  );
}
