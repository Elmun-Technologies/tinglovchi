import {
  Badge,
  ButtonLink,
  EmptyState,
  PageHeader,
  SectionCard,
  Table,
  TableScroller,
  Td,
  Th,
  Tr,
  Input,
  Meta,
} from '@suhbat/ui';
import { routes, type SearchHit } from '@suhbat/product';
import { getRepositories } from '../../../../lib/repositories';
import { ui } from '../../../../copy/ui-copy';

export const metadata = { title: ui.nav.searchPlaceholder };

const kindLabels: Record<SearchHit['kind'], string> = {
  meeting: 'Meetings',
  company: 'Companies',
  project: 'Projects',
  person: 'People',
  decision: 'Decisions',
  task: 'Tasks',
};

/**
 * Global search over the records the workspace holds. It is a literal substring match — exactly what the label
 * promises — and it is a page rather than a dropdown so a result set is linkable and reloadable.
 *
 * Two states a search page usually fakes are handled here instead. Before anyone has typed, the page offers the
 * workspace's own recent records (derived from the data, not from a browsing history this build does not keep),
 * and when nothing matches it says what was searched and how, rather than showing an empty box that looks broken.
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const q = (Array.isArray(query.q) ? query.q[0] : query.q) ?? '';
  const repositories = getRepositories();
  const trimmed = q.trim();
  const searching = trimmed.length >= 2;
  const [hits, recent, openTasks] = await Promise.all([
    searching ? repositories.search.search(workspaceId, q) : Promise.resolve([]),
    searching
      ? Promise.resolve([])
      : repositories.search.recent(workspaceId, 8).catch(() => [] as SearchHit[]),
    // "Needs attention" is a query of the same records the task board reads, not a curated list.
    searching
      ? Promise.resolve([])
      : repositories.tasks
          .list(workspaceId, { bucket: 'open' })
          .then((tasks) => tasks.filter((task) => task.dueDate !== null).slice(0, 5))
          .catch(() => []),
  ]);
  const grouped = new Map<SearchHit['kind'], SearchHit[]>();
  for (const hit of hits) grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={ui.nav.searchPlaceholder}
        description="Matches across meetings, companies, projects, people, decisions and tasks in this workspace."
        meta={
          <span className="text-[12.5px] text-slate-500">
            {trimmed.length === 0
              ? ui.searchPage.tooShortBody
              : !searching
                ? ui.searchPage.tooShortTitle
                : `${hits.length} ${hits.length === 1 ? ui.searchPage.result : ui.searchPage.results} for “${trimmed}”`}
          </span>
        }
        actions={
          <ButtonLink href={routes.meetings({ workspaceId })} variant="ghost" size="sm">
            {ui.common.back}
          </ButtonLink>
        }
      />

      <form action={routes.search({ workspaceId }, '')} method="get" className="flex gap-2">
        <label htmlFor="search-again" className="sr-only">
          {ui.searchPage.focus}
        </label>
        <Input
          id="search-again"
          name="q"
          defaultValue={q}
          autoComplete="off"
          placeholder={ui.nav.searchPlaceholder}
          // An empty search box is the one place autofocus earns its keep: the reader arrived to type.
          autoFocus={trimmed.length === 0}
        />
        <button
          type="submit"
          className="inline-flex min-h-10 shrink-0 items-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
        >
          {ui.common.apply}
        </button>
      </form>

      {searching && hits.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="search"
            title={ui.searchPage.noResultsTitle}
            description={ui.searchPage.noResultsBody}
            action={
              <ButtonLink href={routes.search({ workspaceId }, '')} size="sm" variant="secondary">
                {ui.common.reset}
              </ButtonLink>
            }
          />
        </div>
      ) : null}

      {searching
        ? [...grouped.entries()].map(([kind, items]) => (
            <SectionCard
              key={kind}
              title={kindLabels[kind]}
              description={`${items.length} found`}
              flush
            >
              <TableScroller>
                <Table className="stacked">
                  <thead>
                    <tr>
                      <Th>Result</Th>
                      <Th className="w-64">Context</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((hit) => (
                      <Tr key={`${hit.kind}-${hit.id}`}>
                        <Td label={kindLabels[hit.kind]}>
                          <a
                            href={hit.href}
                            className="rounded text-[13.5px] font-semibold text-slate-900 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                          >
                            {hit.title}
                          </a>
                        </Td>
                        <Td className="text-[12.5px] text-slate-500" label="Context">
                          {hit.subtitle}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableScroller>
            </SectionCard>
          ))
        : null}

      {!searching ? (
        <SectionCard
          title={ui.searchPage.recent}
          description={ui.searchPage.recentHint}
          actions={
            <ButtonLink href={routes.meetings({ workspaceId })} size="sm" variant="ghost">
              {ui.nav.meetings}
            </ButtonLink>
          }
          flush
        >
          <ul className="divide-y divide-slate-100">
            {recent.map((hit) => (
              <li key={`${hit.kind}-${hit.id}`} className="px-4 py-2.5">
                <a
                  href={hit.href}
                  className="group flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded text-[13.5px] font-semibold text-slate-900 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  {hit.title}
                  <span className="text-[11.5px] font-normal text-slate-400 group-hover:text-slate-500">
                    {hit.subtitle}
                  </span>
                </a>
              </li>
            ))}
            {recent.length === 0 ? (
              <li className="px-4 py-3 text-[13px] text-slate-500">
                {ui.searchPage.noResultsTitle}
              </li>
            ) : null}
          </ul>
        </SectionCard>
      ) : null}

      {!searching && openTasks.length > 0 ? (
        <SectionCard
          title={ui.searchPage.attention}
          description={ui.searchPage.attentionHint}
          flush
        >
          <ul className="divide-y divide-slate-100">
            {openTasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <a
                  href={routes.meetingTab({
                    workspaceId,
                    meetingId: task.meetingId,
                    tab: 'tasks',
                  })}
                  className="min-w-0 flex-1 rounded text-[13.5px] font-semibold text-slate-900 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  {task.title}
                </a>
                <Badge tone="warning">
                  {ui.tasks.deadline} {task.dueDate}
                </Badge>
                <Meta className="w-full text-[11.5px]">
                  {task.ownerLabel} · {task.status.replace('_', ' ')}
                </Meta>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
