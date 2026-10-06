import {
  Badge,
  ButtonLink,
  DecisionCard,
  EmptyState,
  ErrorState,
  FactCard,
  KnowledgeEntryRow,
  Metric,
  Notice,
  PageHeader,
  ParticipantAvatar,
  SectionCard,
  TabNav,
  TaskRow,
  type TabItem,
} from '@suhbat/ui';
import {
  clockTime,
  companyTabLabels,
  formatShortDate,
  knowledgeKindLabels,
  projectTabLabels,
  relativeDayLabel,
  RepositoryError,
  routes,
  type CompanyIntelligence,
  type CompanyTab,
  type MeetingListRow,
  type ProductRepositories,
  type ProjectTab,
} from '@suhbat/product';
import { can, projectStatusLabels, type Project } from '@suhbat/product';
import type { Lookup } from '../../../lib/lookup';
import { EntityListActions } from '../entity/list-actions';
import { ui } from '../../../copy/ui-copy';
import { MeetingTable } from '../meeting-table';
import { IntelligencePanel } from './intelligence';
import { CompanyProjects } from './projects';

/**
 * Company and project detail. Both are "a body of meetings plus what came out of them", so they share one
 * renderer and differ only in the sections specific to each side: a company carries its record and its projects,
 * a project carries its company and its deadlines.
 */
export type EntityKind = 'company' | 'project';

type EntityData = {
  name: string;
  description: string | undefined;
  meetingCount: number;
  openTaskCount: number;
  decisionCount: number;
  lastAt: string | null;
  extra: string;
  /** Lifecycle is part of the identity of the row: an archived record must say so wherever it is read. */
  status: string;
  projectCount: number;
};

export async function EntityDetail({
  kind,
  workspaceId,
  entityId,
  tab,
  repositories,
  lookup,
  todayIsoDate,
}: {
  kind: EntityKind;
  workspaceId: string;
  entityId: string;
  tab: string;
  repositories: ProductRepositories;
  lookup: Lookup;
  todayIsoDate: string;
}) {
  const scope =
    kind === 'company'
      ? { workspaceId, companyId: entityId }
      : { workspaceId, projectId: entityId };
  let data: EntityData;
  let intelligence: CompanyIntelligence | null = null;
  let rows: MeetingListRow[] = [];
  let tasks: Awaited<ReturnType<ProductRepositories['tasks']['list']>> = [];
  let decisions: Awaited<ReturnType<ProductRepositories['meetings']['decisionsFor']>> = [];
  let facts: Awaited<ReturnType<ProductRepositories['meetings']['factsFor']>> = [];
  let entries: Awaited<ReturnType<ProductRepositories['knowledge']['entries']>> = [];

  try {
    if (kind === 'company') {
      // A detail lookup always includes archived records: a link to a company someone archived must resolve,
      // and the page then states the status rather than pretending the record is in the default list.
      const overview = (
        await repositories.companies.overview(workspaceId, { includeArchived: true })
      ).find((row) => row.company.id === entityId);
      if (!overview) {
        throw new RepositoryError('not_found', 'No company with that id is in this workspace.', {
          detail: entityId,
        });
      }
      data = {
        name: overview.company.name,
        description: overview.company.description,
        meetingCount: overview.meetingCount,
        openTaskCount: overview.openTaskCount,
        decisionCount: overview.decisionCount,
        lastAt: overview.lastMeetingAt,
        extra: `${overview.activeProjectCount} ${overview.activeProjectCount === 1 ? 'active project' : 'active projects'}`,
        status: overview.company.status,
        projectCount: overview.activeProjectCount,
      };
      [intelligence, rows, tasks, decisions, facts, entries] = await Promise.all([
        repositories.companies.intelligence(entityId),
        repositories.meetings.list(workspaceId, { companyId: entityId }),
        repositories.tasks.list(workspaceId, { companyId: entityId }),
        repositories.meetings.decisionsFor(scope),
        repositories.meetings.factsFor(scope),
        repositories.knowledge.entries({ companyId: entityId }),
      ]);
    } else {
      const overview = (
        await repositories.projects.overview(workspaceId, { includeArchived: true })
      ).find((row) => row.project.id === entityId);
      if (!overview) {
        throw new RepositoryError('not_found', 'No project with that id is in this workspace.', {
          detail: entityId,
        });
      }
      data = {
        name: overview.project.name,
        description: overview.project.description,
        meetingCount: overview.meetingCount,
        openTaskCount: overview.openTaskCount,
        decisionCount: overview.decisionCount,
        lastAt: overview.lastActivityAt,
        extra: `${ui.projects.company}: ${overview.companyName ?? ui.common.none}`,
        status: overview.project.status,
        projectCount: 0,
      };
      [rows, tasks, decisions, facts, entries] = await Promise.all([
        repositories.meetings.list(workspaceId, { projectId: entityId }),
        repositories.tasks.list(workspaceId, { projectId: entityId }),
        repositories.meetings.decisionsFor(scope),
        repositories.meetings.factsFor(scope),
        repositories.knowledge.entries({ projectId: entityId }),
      ]);
    }
  } catch (cause) {
    const error =
      cause instanceof RepositoryError
        ? cause
        : new RepositoryError('provider_unavailable', 'This record could not be loaded.', {
            detail: cause instanceof Error ? cause.message : String(cause),
          });
    return (
      <div className="space-y-4">
        <PageHeader
          title={error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle}
          breadcrumbs={[
            {
              label: kind === 'company' ? ui.nav.companies : ui.nav.projects,
              href: routes[kind === 'company' ? 'companies' : 'projects']({ workspaceId }),
            },
            { label: entityId },
          ]}
        />
        <ErrorState
          title={error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle}
          message={error.message}
          code={error.code}
          detail={error.detail}
          hint={
            error.hint ?? 'These routes only resolve records that belong to the current workspace.'
          }
          retryHref={routes[kind === 'company' ? 'companies' : 'projects']({ workspaceId })}
        />
      </div>
    );
  }

  const hrefFor = (next: string) =>
    kind === 'company'
      ? routes.company({ workspaceId, companyId: entityId, tab: next })
      : routes.project({ workspaceId, projectId: entityId, tab: next as ProjectTab });

  const tabs: TabItem[] = (
    kind === 'company'
      ? (['overview', 'meetings', 'projects', 'tasks', 'decisions', 'knowledge'] as CompanyTab[])
      : (['overview', 'meetings', 'decisions', 'tasks', 'knowledge'] as ProjectTab[])
  ).map((key) => ({
    id: key,
    href: hrefFor(key),
    label: (kind === 'company' ? companyTabLabels : projectTabLabels)[key as never],
    count:
      key === 'meetings'
        ? rows.length
        : key === 'tasks'
          ? tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
              .length
          : key === 'decisions'
            ? decisions.length
            : key === 'knowledge'
              ? entries.length
              : key === 'projects' && kind === 'company'
                ? data.projectCount
                : undefined,
    active: key === tab,
  }));

  const openTasks = tasks.filter(
    (task) => task.status !== 'completed' && task.status !== 'cancelled',
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={data.name}
        description={data.description ?? undefined}
        breadcrumbs={[
          {
            label: kind === 'company' ? ui.nav.companies : ui.nav.projects,
            href: routes[kind === 'company' ? 'companies' : 'projects']({ workspaceId }),
          },
          { label: data.name },
        ]}
        meta={
          <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
            {data.status !== 'active' ? (
              <Badge tone={data.status === 'paused' ? 'info' : 'neutral'}>
                {data.status === 'archived'
                  ? ui.writes.archivedBadge
                  : (projectStatusLabels[data.status as Project['status']] ?? data.status)}
              </Badge>
            ) : null}
            <span>
              {data.meetingCount} {ui.common.meetings} · {data.openTaskCount}{' '}
              {ui.tasks.buckets.open.toLowerCase()} · {data.decisionCount}{' '}
              {ui.meeting.decisions.title.toLowerCase()} ·{' '}
              {data.lastAt
                ? `last activity ${relativeDayLabel(data.lastAt, todayIsoDate)}`
                : 'no meetings yet'}
            </span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href={hrefFor('meetings')} variant="ghost" size="sm">
              {ui.companies.detail.meetings}
            </ButtonLink>
            <EntityListActions
              workspaceId={workspaceId}
              kind={kind}
              id={entityId}
              status={data.status}
              nextHref={
                kind === 'company'
                  ? routes.company({ workspaceId, companyId: entityId })
                  : routes.project({ workspaceId, projectId: entityId })
              }
              canEdit={can(
                repositories.capabilities,
                kind === 'company' ? 'company.update' : 'project.update',
              )}
              canArchive={can(
                repositories.capabilities,
                kind === 'company' ? 'company.archive' : 'project.archive',
              )}
            />
          </div>
        }
      />

      <TabNav tabs={tabs} />

      {tab === 'meetings' ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <MeetingTable
            rows={rows}
            workspaceId={workspaceId}
            todayIsoDate={todayIsoDate}
            emptyTitle={ui.meetings.emptyAllTitle}
            emptyBody={`No meetings are linked to this ${kind} yet, so nothing has been analysed under it.`}
          />
        </div>
      ) : null}

      {tab === 'projects' && kind === 'company' ? (
        <CompanyProjects
          workspaceId={workspaceId}
          repositories={repositories}
          companyId={entityId}
        />
      ) : null}

      {tab === 'tasks' ? (
        <SectionCard
          title={ui.tasks.title}
          description={`${tasks.length} recorded under this ${kind}, ${openTasks.length} not yet done.`}
          actions={
            <ButtonLink
              href={routes.tasks({ workspaceId }, { [kind]: entityId })}
              size="sm"
              variant="ghost"
            >
              {ui.common.viewAll}
            </ButtonLink>
          }
        >
          {tasks.length === 0 ? (
            <EmptyState icon="check" title={ui.tasks.emptyTitle} description={ui.tasks.emptyBody} />
          ) : (
            <ul className="space-y-2">
              {tasks.map((task) => (
                <li key={task.id}>
                  <TaskRow
                    task={task}
                    todayIsoDate={todayIsoDate}
                    variant="compact"
                    showMeeting
                    companyName={task.companyId ? lookup.companies.get(task.companyId) : undefined}
                    projectName={task.projectId ? lookup.projects.get(task.projectId) : undefined}
                    meetingHref={routes.meeting({ workspaceId, meetingId: task.meetingId })}
                    hrefOf={lookup.evidence.hrefOf}
                    namesOf={lookup.evidence.namesOf}
                    blockedReason={ui.tasks.updateBlocked}
                  />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {tab === 'decisions' ? (
        decisions.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              icon="check"
              title={ui.meeting.decisions.emptyTitle}
              description={ui.meeting.decisions.emptyBody}
            />
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[12.5px] text-slate-500">
              {decisions.filter((decision) => decision.status === 'confirmed').length} of{' '}
              {decisions.length} {ui.meeting.decisions.title.toLowerCase()} are confirmed; the rest
              are still proposed, tentative, rejected or superseded.
            </p>
            <ul className="space-y-2.5">
              {decisions.map((decision) => (
                <li key={decision.id}>
                  <DecisionCard
                    decision={decision}
                    hrefOf={lookup.evidence.hrefOf}
                    namesOf={lookup.evidence.namesOf}
                    href={routes.meeting({ workspaceId, meetingId: decision.meetingId })}
                    topicLabel={lookup.meetings.get(decision.meetingId)?.title}
                    participantNames={decision.participantPersonIds
                      .map((personId) => lookup.nameOf(personId))
                      .filter((name): name is string => Boolean(name))}
                    supersededBy={
                      decision.supersededByDecisionId
                        ? { label: decision.supersededByDecisionId, href: hrefFor('decisions') }
                        : null
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {tab === 'knowledge' ? (
        <SectionCard title={ui.knowledge.title} description={ui.knowledge.note} flush>
          {entries.length === 0 ? (
            <EmptyState
              icon="search"
              title={ui.knowledge.emptyTitle}
              description={ui.knowledge.emptyBody}
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {entries.map((entry) => (
                <KnowledgeEntryRow
                  key={`${entry.kind}-${entry.id}`}
                  kind={entry.kind}
                  title={
                    <a
                      href={routes.meetingTab({
                        workspaceId,
                        meetingId: entry.meetingId,
                        tab: tabForKind(entry.kind),
                      })}
                      className="rounded hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                    >
                      {entry.title}
                    </a>
                  }
                  body={entry.body}
                  meta={
                    <>
                      <span>{relativeDayLabel(entry.at, todayIsoDate)}</span>
                      <span>{knowledgeKindLabels[entry.kind]}</span>
                      {entry.personIds.map((personId) => (
                        <span key={personId}>{lookup.nameOf(personId) ?? personId}</span>
                      ))}
                      {entry.statusLabel ? <Badge tone="outline">{entry.statusLabel}</Badge> : null}
                    </>
                  }
                  evidence={entry.evidence[0]}
                  hrefOf={lookup.evidence.hrefOf}
                  namesOf={lookup.evidence.namesOf}
                />
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {tab === 'overview' ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            {intelligence ? (
              <IntelligencePanel
                intelligence={intelligence}
                workspaceId={workspaceId}
                lookup={lookup}
                capabilities={repositories.capabilities}
              />
            ) : null}

            <SectionCard
              title={ui.companies.detail.meetings}
              description="Most recent first."
              flush
            >
              <MeetingTable
                rows={rows.slice(0, 4)}
                workspaceId={workspaceId}
                todayIsoDate={todayIsoDate}
                dense
                emptyTitle={ui.meetings.emptyAllTitle}
                emptyBody={`No meetings are linked to this ${kind} yet.`}
              />
            </SectionCard>

            {facts.length > 0 ? (
              <SectionCard
                title={ui.meeting.facts.title}
                description={`${facts.length} captured under this ${kind}, each from a spoken line.`}
              >
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {facts.slice(0, 6).map((fact) => (
                    <FactCard
                      key={fact.id}
                      fact={fact}
                      hrefOf={lookup.evidence.hrefOf}
                      speakerName={lookup.nameOf(fact.speakerPersonId)}
                    />
                  ))}
                </div>
                <p className="mt-2.5 text-[12px] text-slate-400">
                  <a href={hrefFor('knowledge')} className="text-teal-800 hover:underline">
                    {ui.knowledge.title}
                  </a>{' '}
                  holds the full set for this {kind}.
                </p>
              </SectionCard>
            ) : null}
          </div>

          <div className="space-y-5">
            <SectionCard title={ui.companies.detail.overview}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Metric label={ui.meetings.title} value={data.meetingCount} />
                <Metric
                  label={ui.companies.detail.openTasks}
                  value={data.openTaskCount}
                  tone={data.openTaskCount > 0 ? 'warning' : 'neutral'}
                />
                <Metric label={ui.meeting.decisions.title} value={data.decisionCount} />
                <Metric
                  label={ui.common.languages}
                  value={new Set(rows.flatMap((row) => row.meeting.languages)).size}
                  hint={data.extra}
                />
              </dl>
              {data.lastAt ? (
                <p className="mt-3 text-[12.5px] text-slate-500">
                  {ui.companies.columns.lastMeeting}: {formatShortDate(data.lastAt)} ·{' '}
                  {clockTime(data.lastAt)}
                </p>
              ) : null}
            </SectionCard>

            <SectionCard
              title={ui.companies.detail.team}
              description={`Everyone who appears in a meeting with this ${kind}.`}
            >
              {teamOf(rows).length === 0 ? (
                <EmptyState
                  icon="user"
                  title={ui.common.none}
                  description="No participants until a meeting is linked."
                />
              ) : (
                <ul className="space-y-1.5">
                  {teamOf(rows).map((participant) => (
                    <li key={participant.personId} className="flex items-center gap-2">
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
                      <span className="text-[11.5px] text-slate-400">
                        {
                          rows.filter((row) =>
                            row.meeting.participants.some(
                              (item) => item.personId === participant.personId,
                            ),
                          ).length
                        }{' '}
                        {ui.common.meetings}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <Notice
              tone={repositories.capabilities.writes ? 'neutral' : 'warning'}
              title={ui.writes.persistenceNote}
            >
              <p>{repositories.capabilities.persistenceLabel}</p>
              <p className="mt-1 text-slate-500">
                {kind === 'company' ? ui.companies.writeNote : ui.projects.writeNote}
              </p>
            </Notice>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Commitments are surfaced on the meeting Overview tab, where their evidence rows are rendered. */
function tabForKind(
  kind: 'decision' | 'fact' | 'topic' | 'commitment' | 'question',
): 'overview' | 'decisions' | 'facts' | 'topics' | 'questions' {
  if (kind === 'decision') return 'decisions';
  if (kind === 'fact') return 'facts';
  if (kind === 'topic') return 'topics';
  if (kind === 'question') return 'questions';
  return 'overview';
}

function teamOf(rows: MeetingListRow[]) {
  const seen = new Map<string, MeetingListRow['meeting']['participants'][number]>();
  for (const row of rows) {
    for (const participant of row.meeting.participants) {
      if (!seen.has(participant.personId)) seen.set(participant.personId, participant);
    }
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}
