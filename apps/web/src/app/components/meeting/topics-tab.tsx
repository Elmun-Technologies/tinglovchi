import {
  Badge,
  ButtonLink,
  DecisionCard,
  EmptyState,
  SectionCard,
  TaskRow,
  TopicSection,
} from '@suhbat/ui';
import type { ReactNode } from 'react';
import { formatDuration, routes, topicTree, type Participant } from '@suhbat/product';
import type { Lookup } from '../../../lib/lookup';
import type { MeetingBundle } from '../../../lib/meeting-bundle';
import { ui } from '../../../copy/ui-copy';

/**
 * Topic map as a sectioned outline: parents and children in transcript order, each stating the range it covers,
 * who spoke, and what came out of it. A mind-map is not used because the useful question is "what happened when",
 * and a graph of bubbles does not answer it.
 */
export function MeetingTopics({
  workspaceId,
  meetingId,
  bundle,
  lookup,
  todayIsoDate,
}: {
  workspaceId: string;
  meetingId: string;
  bundle: MeetingBundle;
  lookup: Lookup;
  todayIsoDate: string;
}) {
  const nodes = topicTree(bundle.topics);
  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState
          title={ui.meeting.topics.emptyTitle}
          description={ui.meeting.topics.emptyBody}
          icon="layers"
        />
      </div>
    );
  }

  const decisionById = new Map(bundle.decisions.map((decision) => [decision.id, decision]));
  const taskById = new Map(bundle.tasks.map((task) => [task.id, task]));
  const covered = new Set(bundle.topics.flatMap((topic) => topic.segmentIds));
  const span = bundle.topics.reduce(
    (acc, topic) => ({
      start: Math.min(acc.start, topic.startMs),
      end: Math.max(acc.end, topic.endMs),
    }),
    { start: Number.POSITIVE_INFINITY, end: 0 },
  );

  const renderNode = (node: (typeof nodes)[number]): ReactNode => {
    const decisions = node.decisionIds.map((id) => decisionById.get(id)).filter(Boolean);
    const tasks = node.taskIds.map((id) => taskById.get(id)).filter(Boolean);
    const firstSegment = node.segmentIds[0];
    const participants = node.participantPersonIds
      .map((personId) => lookup.participants.get(personId))
      .filter((participant): participant is Participant => Boolean(participant));
    return (
      <div key={node.id} className="space-y-2">
        <TopicSection
          topic={node}
          depth={node.depth}
          participants={participants}
          transcriptHref={
            firstSegment
              ? routes.evidence({
                  workspaceId,
                  meetingId,
                  segmentId: firstSegment,
                  startMs: node.startMs,
                })
              : routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' }, { topic: node.id })
          }
          note={
            <p className="mb-2.5 text-[11.5px] text-slate-400">
              {ui.meeting.topics.keywordHint} · {ui.meeting.transcript.topic}:{' '}
              {node.keywords.length > 0 ? node.keywords.join(', ') : '—'}
            </p>
          }
          related={[
            {
              label: `${ui.meeting.decisions.title} · ${decisions.length}`,
              items: decisions.map((decision) => (
                <DecisionCard
                  key={decision!.id}
                  decision={decision!}
                  variant="compact"
                  hrefOf={lookup.evidence.hrefOf}
                  namesOf={lookup.evidence.namesOf}
                />
              )),
            },
            {
              label: `${ui.meeting.tasks.title} · ${tasks.length}`,
              items: tasks.map((task) => (
                <TaskRow
                  key={task!.id}
                  task={task!}
                  todayIsoDate={todayIsoDate}
                  variant="compact"
                  hrefOf={lookup.evidence.hrefOf}
                />
              )),
            },
          ].filter((group) => group.items.length > 0)}
        />
        {node.children.map(renderNode)}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[12.5px] text-slate-600 shadow-sm">
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="outline">{nodes.length} sections</Badge>
          <Badge tone="outline">{bundle.topics.length} topics</Badge>
        </span>
        <span>
          {ui.meeting.topics.segmentsCovered}: {covered.size} / {bundle.transcript.segments.length}
        </span>
        <span>
          {ui.meeting.topics.coverage}: {formatDuration(Math.max(0, span.end - span.start))}
        </span>
        <ButtonLink
          href={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
          size="sm"
          variant="ghost"
          className="ml-auto"
        >
          {ui.meeting.transcript.title}
        </ButtonLink>
      </div>
      <SectionCard
        title={ui.meeting.topics.mapTitle}
        description={ui.meeting.topics.intro}
        flush
        className="border-0 bg-transparent p-0 shadow-none"
      >
        <div className="space-y-2">{nodes.map(renderNode)}</div>
      </SectionCard>
    </div>
  );
}
