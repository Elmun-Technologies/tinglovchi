import {
  CommitmentRow,
  DecisionCard,
  EmptyState,
  FactCard,
  FilterBar,
  FilterField,
  FilterSelect,
  IdeaCard,
  Notice,
  QuestionCard,
  SectionCard,
  TaskRow,
} from '@suhbat/ui';
import {
  decisionStatusLabels,
  factCategoryLabels,
  questionStatusLabels,
  routes,
  type DecisionStatus,
  type FactCategory,
  type MeetingTab,
  type ProductRepositories,
} from '@suhbat/product';
import type { Lookup } from '../../../lib/lookup';
import type { MeetingBundle } from '../../../lib/meeting-bundle';
import { ui } from '../../../copy/ui-copy';
import { setTaskStatusAction } from '../../actions/product';

/**
 * A meeting's decisions, tasks, facts, questions and ideas. Each list is filtered by the query string, so
 * "5 confirmed of 6 decisions" is a URL a colleague can open, not a screenshot of local state.
 */

/** The filter offers exactly the statuses the domain allows, with the shared label for each. */
const questionStatusOptions = Object.keys(
  questionStatusLabels,
) as (keyof typeof questionStatusLabels)[];
export async function MeetingRecords({
  tab,
  workspaceId,
  meetingId,
  bundle,
  lookup,
  repositories,
  todayIsoDate,
  searchParams,
}: {
  tab: Extract<MeetingTab, 'decisions' | 'tasks' | 'facts' | 'questions' | 'ideas'>;
  workspaceId: string;
  meetingId: string;
  bundle: MeetingBundle;
  lookup: Lookup;
  repositories: ProductRepositories;
  todayIsoDate: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const single = (key: string) => {
    const value = searchParams[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const baseHref = routes.meetingTab({ workspaceId, meetingId, tab });
  const topicTitleOf = (topicId: string | null) =>
    topicId ? bundle.topics.find((topic) => topic.id === topicId)?.title : undefined;
  const meeting = lookup.meetings.get(meetingId);

  if (tab === 'decisions') {
    const status = single('status');
    const decisions = bundle.decisions.filter((decision) => !status || decision.status === status);
    const ordered = orderDecisions(decisions);
    return (
      <div className="space-y-4">
        <FilterBar action={baseHref} resetHref={baseHref}>
          <FilterField label={ui.meeting.decisions.statusFilter} htmlFor="f-status">
            <FilterSelect
              id="f-status"
              name="status"
              value={status}
              options={[
                { value: '', label: ui.common.all },
                ...(
                  [
                    'confirmed',
                    'tentative',
                    'proposed',
                    'rejected',
                    'superseded',
                  ] as DecisionStatus[]
                ).map((value) => ({
                  value,
                  label: decisionStatusLabels[value],
                })),
              ]}
            />
          </FilterField>
        </FilterBar>
        <p className="text-[12.5px] text-slate-500">
          {decisions.length} of {bundle.decisions.length} decisions ·{' '}
          {bundle.decisions.filter((decision) => decision.status === 'confirmed').length} confirmed.{' '}
          {ui.meeting.decisions.supersededNotice}
        </p>
        {ordered.length === 0 ? (
          <EmptyBlock
            title={ui.meeting.decisions.emptyTitle}
            description={ui.meeting.decisions.emptyBody}
          />
        ) : (
          <div className="space-y-4">
            {ordered.map(([statusLabel, items]) => (
              <SectionCard
                key={statusLabel}
                title={statusLabel}
                description={`${items.length} recorded`}
              >
                <ul className="space-y-2.5">
                  {items.map((decision) => (
                    <li key={decision.id}>
                      <DecisionCard
                        decision={decision}
                        hrefOf={lookup.evidence.hrefOf}
                        namesOf={lookup.evidence.namesOf}
                        topicLabel={topicTitleOf(decision.topicId)}
                        participantNames={decision.participantPersonIds
                          .map((personId) => lookup.nameOf(personId))
                          .filter((name): name is string => Boolean(name))}
                        supersededBy={
                          decision.supersededByDecisionId
                            ? {
                                label:
                                  bundle.decisions.find(
                                    (item) => item.id === decision.supersededByDecisionId,
                                  )?.title ?? 'replacement decision',
                                href: `${baseHref}#decision-${decision.supersededByDecisionId}`,
                              }
                            : null
                        }
                        followUps={
                          decision.hasFollowUpTasks ? (
                            <ul className="space-y-1.5">
                              {bundle.tasks
                                .filter((task) => task.topicId === decision.topicId)
                                .slice(0, 3)
                                .map((task) => (
                                  <TaskRow
                                    key={task.id}
                                    task={task}
                                    todayIsoDate={todayIsoDate}
                                    variant="compact"
                                    hrefOf={lookup.evidence.hrefOf}
                                  />
                                ))}
                            </ul>
                          ) : undefined
                        }
                      />
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (tab === 'tasks') {
    const status = single('status');
    const tasks = bundle.tasks.filter((task) => !status || task.status === status);
    return (
      <div className="space-y-4">
        <FilterBar action={baseHref} resetHref={baseHref}>
          <FilterField label={ui.tasks.filters.status} htmlFor="f-status">
            <FilterSelect
              id="f-status"
              name="status"
              value={status}
              options={[
                { value: '', label: ui.common.all },
                ...(['open', 'in_progress', 'blocked', 'completed', 'cancelled'] as const).map(
                  (value) => ({ value, label: value.replace(/_/g, ' ') }),
                ),
              ]}
            />
          </FilterField>
        </FilterBar>
        <p className="text-[12.5px] text-slate-500">
          {tasks.length} of {bundle.tasks.length} tasks ·{' '}
          {
            bundle.tasks.filter(
              (task) => task.status !== 'completed' && task.status !== 'cancelled',
            ).length
          }{' '}
          still open.{' '}
          <a
            href={routes.tasks({ workspaceId }, { q: meeting?.title })}
            className="text-teal-800 hover:underline"
          >
            {ui.tasks.title} page
          </a>
        </p>
        {tasks.length === 0 ? (
          <EmptyBlock
            title={ui.meeting.tasks.emptyTitle}
            description={ui.meeting.tasks.emptyBody}
          />
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li key={task.id}>
                <TaskRow
                  task={task}
                  todayIsoDate={todayIsoDate}
                  hrefOf={lookup.evidence.hrefOf}
                  namesOf={lookup.evidence.namesOf}
                  companyName={lookup.companies.get(task.companyId ?? '')}
                  projectName={lookup.projects.get(task.projectId ?? '')}
                  updateAction={
                    repositories.capabilities.mode === 'demo'
                      ? { action: setTaskStatusAction, label: undefined }
                      : undefined
                  }
                  blockedReason={
                    repositories.capabilities.mode === 'demo' ? undefined : ui.tasks.updateBlocked
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (tab === 'facts') {
    const category = single('category');
    const facts = bundle.facts.filter((fact) => !category || fact.category === category);
    const categories = [...new Set(bundle.facts.map((fact) => fact.category))];
    return (
      <div className="space-y-4">
        <FilterBar action={baseHref} resetHref={baseHref}>
          <FilterField label={ui.meeting.facts.categoryFilter} htmlFor="f-category">
            <FilterSelect
              id="f-category"
              name="category"
              value={category}
              options={[
                { value: '', label: ui.common.all },
                ...categories
                  .sort()
                  .map((value: FactCategory) => ({ value, label: factCategoryLabels[value] })),
              ]}
            />
          </FilterField>
        </FilterBar>
        <Notice tone="neutral" title={ui.meeting.facts.intro}>
          <p>{ui.meeting.facts.confidenceNote}</p>
        </Notice>
        {facts.length === 0 ? (
          <EmptyBlock
            title={ui.meeting.facts.emptyTitle}
            description={ui.meeting.facts.emptyBody}
          />
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {facts.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                hrefOf={lookup.evidence.hrefOf}
                speakerName={lookup.nameOf(fact.speakerPersonId)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (tab === 'questions') {
    const status = single('status');
    const questions = bundle.questions.filter((question) => !status || question.status === status);
    const commitments = await repositories.meetings.commitmentsFor({ workspaceId, meetingId });
    const open = questions.filter((question) => question.status === 'open');
    return (
      <div className="space-y-4">
        <FilterBar action={baseHref} resetHref={baseHref}>
          <FilterField label={ui.meeting.questions.statusFilter} htmlFor="f-status">
            <FilterSelect
              id="f-status"
              name="status"
              value={status}
              options={[
                { value: '', label: ui.common.all },
                ...questionStatusOptions.map((status) => ({
                  value: status,
                  label: questionStatusLabels[status],
                })),
              ]}
            />
          </FilterField>
        </FilterBar>
        {questions.length === 0 ? (
          <EmptyBlock
            title={ui.meeting.questions.emptyTitle}
            description={ui.meeting.questions.emptyBody}
          />
        ) : (
          <div className="grid gap-2.5 lg:grid-cols-2">
            {questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                askedByName={lookup.nameOf(question.askedByPersonId)}
                answererName={
                  question.resolution
                    ? lookup.nameOf(question.resolution.answeredByPersonId)
                    : undefined
                }
                topicTitle={topicTitleOf(question.topicId)}
                topicHref={
                  question.topicId
                    ? `${routes.meetingTab({ workspaceId, meetingId, tab: 'topics' })}#topic-${question.topicId}`
                    : undefined
                }
                hrefOf={lookup.evidence.hrefOf}
                namesOf={lookup.evidence.namesOf}
              />
            ))}
          </div>
        )}
        {commitments.length > 0 ? (
          <SectionCard
            title="Commitments and objections"
            description="What each side said they would do, kept separate from tasks so a promise is not confused with an assignment."
            anchorId="commitments"
          >
            <ul>
              {commitments.map((commitment) => (
                <CommitmentRow
                  key={commitment.id}
                  commitment={commitment}
                  todayIsoDate={todayIsoDate}
                  personName={lookup.nameOf(commitment.byPersonId)}
                  hrefOf={lookup.evidence.hrefOf}
                />
              ))}
            </ul>
          </SectionCard>
        ) : null}
        {open.length > 0 ? (
          <p className="text-[12.5px] text-slate-500">
            {open.length} still open. Ask AI can list them:{' '}
            <a href={routes.ask({ workspaceId })} className="text-teal-800 hover:underline">
              {ui.ask.title}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  const ideas = bundle.ideas;
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-slate-500">{ui.meeting.ideas.intro}</p>
      {ideas.length === 0 ? (
        <EmptyBlock title={ui.meeting.ideas.emptyTitle} description={ui.meeting.ideas.emptyBody} />
      ) : (
        <div className="grid gap-2.5 lg:grid-cols-2">
          {ideas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              proposedByName={lookup.nameOf(idea.proposedByPersonId)}
              topicTitle={topicTitleOf(idea.topicId)}
              hrefOf={lookup.evidence.hrefOf}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Grouped so a reader sees what is settled before what is provisional. */
function orderDecisions(
  decisions: MeetingBundle['decisions'],
): [string, MeetingBundle['decisions']][] {
  const order: DecisionStatus[] = ['confirmed', 'tentative', 'proposed', 'superseded', 'rejected'];
  const groups = order
    .map(
      (status) =>
        [
          decisionStatusLabels[status],
          decisions.filter((decision) => decision.status === status),
        ] as const,
    )
    .filter(([, items]) => items.length > 0);
  return groups.map(([label, items]) => [label, [...items]]);
}

function EmptyBlock({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <EmptyState title={title} description={description} icon="check" />
    </div>
  );
}
