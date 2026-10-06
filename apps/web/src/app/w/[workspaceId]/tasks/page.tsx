import {
  ButtonLink,
  EmptyState,
  FilterBar,
  FilterField,
  FilterSelect,
  FilterTextInput,
  Notice,
  PageHeader,
  TabNav,
  TaskRow,
  type TabItem,
} from '@suhbat/ui';
import { isTaskOverdue, routes, taskFilterSchema, type TaskFilter } from '@suhbat/product';
import { getRepositories } from '../../../../lib/repositories';
import { buildLookup } from '../../../../lib/lookup';
import { readFlash } from '../../../../lib/feedback';
import { setTaskStatusAction } from '../../../actions/product';
import { ui } from '../../../../copy/ui-copy';

export const metadata = { title: ui.tasks.title };

const buckets = ['mine', 'open', 'overdue', 'completed', 'all'] as const;

/**
 * The workspace-wide task list. Deadlines are evaluated against the data source's own reference day rather than
 * the visitor's clock, so "overdue" means the same thing to everyone reviewing the same snapshot.
 */
export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const single = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const bucket = (single('bucket') ?? 'open') as (typeof buckets)[number];
  const raw = {
    bucket: (buckets as readonly string[]).includes(bucket) ? bucket : 'open',
    query: single('q') ?? '',
    companyId: single('company') || undefined,
    projectId: single('project') || undefined,
    personId: single('person') || undefined,
  };
  const parsed = taskFilterSchema.safeParse(raw);
  const filter: TaskFilter | undefined = parsed.success ? parsed.data : undefined;

  const repositories = getRepositories();
  const [tasks, allTasks, lookup, dashboard, settings, currentPersonId] = await Promise.all([
    repositories.tasks.list(workspaceId, filter),
    repositories.tasks.list(workspaceId, { bucket: 'all' }),
    buildLookup(repositories, workspaceId),
    repositories.meetings.dashboard(workspaceId),
    repositories.settings.get(workspaceId),
    repositories.workspaces.currentPersonId(workspaceId),
  ]);
  const flash = readFlash(query);
  const today = dashboard.generatedAt.slice(0, 10);
  // Every tab badge is counted from the same unfiltered read, so a count can never disagree with its list.
  const isOpen = (task: (typeof allTasks)[number]) =>
    task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked';
  const counts = {
    mine: allTasks.filter(
      (task) => currentPersonId !== null && task.ownerPersonId === currentPersonId,
    ).length,
    open: allTasks.filter(isOpen).length,
    overdue: allTasks.filter((task) => isTaskOverdue(task, today)).length,
    completed: allTasks.filter((task) => task.status === 'completed').length,
    all: allTasks.length,
  };
  const canWrite = repositories.capabilities.mode === 'demo';
  const overdueHere = tasks.filter((task) => isTaskOverdue(task, today)).length;

  const tabs: TabItem[] = buckets.map((key) => ({
    id: key,
    href: routes.tasks(
      { workspaceId },
      key === 'open' ? {} : { bucket: key, q: raw.query || undefined },
    ),
    label: ui.tasks.buckets[key],
    count: counts[key],
    active: key === raw.bucket,
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title={ui.tasks.title}
        description={ui.tasks.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {tasks.length} {ui.tasks.counts} · {overdueHere} overdue in view · reference day {today}
          </span>
        }
      />
      {flash ? (
        <Notice tone={flash.tone} title={flash.title}>
          {flash.body}
        </Notice>
      ) : null}
      {!parsed.success ? (
        <Notice tone="warning" title="Filter values were ignored">
          <p>
            At least one filter in the address bar is not accepted here, so the default view is
            shown.
          </p>
        </Notice>
      ) : null}

      <TabNav tabs={tabs} />

      <FilterBar
        action={routes.tasks({ workspaceId })}
        resetHref={routes.tasks({ workspaceId }, { bucket: raw.bucket })}
      >
        <FilterField
          label={ui.tasks.filters.search}
          htmlFor="f-q"
          className="min-w-[14rem] flex-[2]"
        >
          <FilterTextInput
            id="f-q"
            name="q"
            value={raw.query}
            placeholder={ui.tasks.searchPlaceholder}
          />
        </FilterField>
        <FilterField label={ui.tasks.filters.company} htmlFor="f-company">
          <FilterSelect
            id="f-company"
            name="company"
            value={raw.companyId}
            options={[
              { value: '', label: ui.common.all },
              ...[...lookup.companies].map(([value, label]) => ({ value, label })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.tasks.filters.project} htmlFor="f-project">
          <FilterSelect
            id="f-project"
            name="project"
            value={raw.projectId}
            options={[
              { value: '', label: ui.common.all },
              ...[...lookup.projects].map(([value, label]) => ({ value, label })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.tasks.filters.owner} htmlFor="f-person">
          <FilterSelect
            id="f-person"
            name="person"
            value={raw.personId}
            options={[
              { value: '', label: ui.common.all },
              ...settings.members.map((member) => ({ value: member.personId, label: member.name })),
            ]}
          />
        </FilterField>
      </FilterBar>

      {tasks.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="check"
            title={ui.tasks.emptyTitle}
            description={ui.tasks.emptyBody}
            action={
              <ButtonLink
                href={routes.tasks({ workspaceId }, { bucket: 'all' })}
                size="sm"
                variant="secondary"
              >
                {ui.tasks.buckets.all}
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskRow
                task={task}
                todayIsoDate={today}
                showMeeting
                meetingHref={routes.meeting({ workspaceId, meetingId: task.meetingId })}
                companyName={lookup.companies.get(task.companyId ?? '')}
                projectName={lookup.projects.get(task.projectId ?? '')}
                hrefOf={lookup.evidence.hrefOf}
                namesOf={lookup.evidence.namesOf}
                updateAction={canWrite ? { action: setTaskStatusAction } : undefined}
                blockedReason={canWrite ? undefined : ui.tasks.updateBlocked}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
