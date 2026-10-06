import {
  Badge,
  ButtonLink,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterField,
  FilterSelect,
  FilterTextInput,
  PageHeader,
  SectionCard,
  Table,
  TableScroller,
  Td,
  Th,
  Tr,
} from '@suhbat/ui';
import {
  can,
  formatShortDate,
  projectStatusLabels,
  relativeDayLabel,
  routes,
  toRepositoryError,
  type Project,
} from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../lib/repositories';
import { EntityListActions } from '../../../components/entity/list-actions';
import { ui } from '../../../../copy/ui-copy';

export const metadata = { title: ui.projects.title };

/**
 * Projects, scoped by company when one is chosen. A project row is deliberately thin — the value is on its
 * detail page — but it answers "how much of this is open" without a click.
 */
export default async function ProjectsPage({
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
  const q = single('q') ?? '';
  const companyId = single('company') || '';
  const status = single('status') || '';
  const includeArchived = single('archived') === 'true';
  const repositories = getRepositories();
  const capabilities = getCapabilities();
  const canCreate = can(capabilities, 'project.create');
  const canEdit = can(capabilities, 'project.update');
  const canArchive = can(capabilities, 'project.archive');
  const loaded = await Promise.all([
    // Every facet is handed to the adapter, so the rows, the counts and the filter box describe one query.
    repositories.projects.overview(workspaceId, {
      includeArchived,
      query: q,
      ...(companyId ? { companyId } : {}),
      ...(status ? { status } : {}),
    }),
    repositories.companies.list(workspaceId, { includeArchived: true }),
    repositories.meetings.dashboard(workspaceId),
  ]).then(
    ([overview, companies, dashboard]) => ({
      ok: true as const,
      overview,
      companies,
      todayIsoDate: dashboard.generatedAt.slice(0, 10),
    }),
    (cause) => ({ ok: false as const, error: toRepositoryError(cause) }),
  );

  if (!loaded.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title={ui.projects.title} description={ui.projects.intro} />
        <ErrorState
          title={
            loaded.error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle
          }
          message={loaded.error.message}
          code={loaded.error.code}
          detail={loaded.error.detail}
          retryHref={routes.projects({ workspaceId })}
        />
      </div>
    );
  }

  const rows = loaded.overview;
  const hasFilters = Boolean(q.trim() || companyId || status || includeArchived);
  const facetParams = new URLSearchParams();
  if (q.trim()) facetParams.set('q', q.trim());
  if (companyId) facetParams.set('company', companyId);
  if (status) facetParams.set('status', status);
  if (includeArchived) facetParams.set('archived', 'true');
  const listHref = `${routes.projects({ workspaceId })}${
    facetParams.toString() ? `?${facetParams}` : ''
  }`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={ui.projects.title}
        description={ui.projects.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {rows.length} {rows.length === 1 ? 'project' : 'projects'}
            {hasFilters ? ` ${ui.common.showing} ${ui.common.of} ${loaded.overview.length}` : ''}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canCreate ? (
              <ButtonLink href={routes.newProject({ workspaceId })} variant="primary" size="sm">
                {ui.writes.newProject}
              </ButtonLink>
            ) : null}
            <ButtonLink href={routes.companies({ workspaceId })} variant="ghost" size="sm">
              {ui.nav.companies}
            </ButtonLink>
          </div>
        }
      />

      <FilterBar
        action={routes.projects({ workspaceId })}
        resetHref={routes.projects({ workspaceId })}
      >
        <FilterField label={ui.projects.search} htmlFor="f-q" className="min-w-[15rem] flex-[2]">
          <FilterTextInput id="f-q" name="q" value={q} placeholder={ui.projects.search} />
        </FilterField>
        <FilterField label={ui.projects.company} htmlFor="f-company">
          <FilterSelect
            id="f-company"
            name="company"
            value={companyId}
            options={[
              { value: '', label: ui.common.all },
              ...loaded.companies.map((company) => ({ value: company.id, label: company.name })),
            ]}
          />
        </FilterField>
        <FilterField label="Status" htmlFor="f-status">
          <FilterSelect
            id="f-status"
            name="status"
            value={status}
            options={[
              { value: '', label: ui.common.all },
              ...(Object.keys(projectStatusLabels) as Project['status'][]).map((key) => ({
                value: key,
                label: projectStatusLabels[key],
              })),
            ]}
          />
        </FilterField>
        <FilterField
          label={ui.writes.showArchived}
          htmlFor="p-archived"
          className="flex-none self-end pb-1"
        >
          {/* hidden default + checkbox: an unchecked box submits `false` rather than nothing. */}
          <input type="hidden" name="archived" value="false" />
          <label className="inline-flex min-h-10 items-center gap-2 text-[13px] text-slate-700">
            <input
              id="p-archived"
              type="checkbox"
              name="archived"
              value="true"
              defaultChecked={includeArchived}
              className="size-4 rounded border-slate-300 text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            />
            {ui.writes.showArchived}
          </label>
        </FilterField>
      </FilterBar>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="file"
            title={hasFilters ? ui.meetings.emptyTitle : ui.projects.emptyTitle}
            description={
              hasFilters ? 'No project matches this combination of filters.' : ui.projects.emptyBody
            }
            action={
              hasFilters ? (
                <ButtonLink href={routes.projects({ workspaceId })} size="sm" variant="secondary">
                  {ui.common.reset}
                </ButtonLink>
              ) : canCreate ? (
                <ButtonLink href={routes.newProject({ workspaceId })} size="sm" variant="primary">
                  {ui.writes.newProject}
                </ButtonLink>
              ) : undefined
            }
          />
        </div>
      ) : (
        <SectionCard flush title={`${rows.length} ${rows.length === 1 ? 'project' : 'projects'}`}>
          <TableScroller>
            <Table className="stacked">
              <caption className="sr-only">{ui.projects.title}</caption>
              <thead>
                <tr>
                  <Th>{ui.projects.title}</Th>
                  <Th>{ui.projects.company}</Th>
                  <Th align="right">{ui.companies.columns.meetings}</Th>
                  <Th align="right">{ui.companies.columns.openTasks}</Th>
                  <Th align="right">{ui.companies.columns.decisions}</Th>
                  <Th>{ui.companies.columns.lastMeeting}</Th>
                  {canEdit || canArchive ? (
                    <Th align="right" className="print:hidden">
                      <span className="sr-only">{ui.common.actions}</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Tr key={row.project.id}>
                    <Td className="max-w-[22rem]">
                      <div className="min-w-0">
                        <a
                          href={routes.project({ workspaceId, projectId: row.project.id })}
                          className="rounded text-[14px] font-semibold leading-snug text-slate-900 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                        >
                          {row.project.name}
                        </a>
                        {row.project.status !== 'active' ? (
                          <Badge
                            tone={row.project.status === 'closed' ? 'neutral' : 'info'}
                            className="ml-2 align-middle"
                          >
                            {projectStatusLabels[row.project.status]}
                          </Badge>
                        ) : null}
                        {row.project.description ? (
                          <p className="mt-0.5 line-clamp-1 text-[12.5px] text-slate-500">
                            {row.project.description}
                          </p>
                        ) : null}
                      </div>
                    </Td>
                    <Td label={ui.projects.company}>
                      {row.project.companyId ? (
                        <a
                          href={routes.company({ workspaceId, companyId: row.project.companyId })}
                          className="rounded text-[13px] text-slate-700 hover:text-teal-900"
                        >
                          {row.companyName ??
                            loaded.companies.find((company) => company.id === row.project.companyId)
                              ?.name}
                        </a>
                      ) : (
                        <span className="text-[12.5px] text-slate-400">{ui.common.noCompany}</span>
                      )}
                    </Td>
                    <Td align="right" label={ui.companies.columns.meetings}>
                      <span className="text-[13px] font-semibold tabular-nums text-slate-800">
                        {row.meetingCount}
                      </span>
                    </Td>
                    <Td align="right" label={ui.companies.columns.openTasks}>
                      {row.openTaskCount > 0 ? (
                        <Badge tone="warning">{row.openTaskCount}</Badge>
                      ) : (
                        <span className="text-[13px] tabular-nums text-slate-400">0</span>
                      )}
                    </Td>
                    <Td align="right" label={ui.companies.columns.decisions}>
                      <a
                        href={routes.project({
                          workspaceId,
                          projectId: row.project.id,
                          tab: 'decisions',
                        })}
                        className="rounded text-[13px] font-semibold tabular-nums text-slate-800 hover:text-teal-900"
                      >
                        {row.decisionCount}
                      </a>
                    </Td>
                    <Td className="whitespace-nowrap" label={ui.companies.columns.lastMeeting}>
                      {row.lastActivityAt ? (
                        <>
                          <span className="block text-[13px] text-slate-700">
                            {relativeDayLabel(row.lastActivityAt, loaded.todayIsoDate)}
                          </span>
                          <span className="block font-mono text-[11.5px] text-slate-400">
                            {formatShortDate(row.lastActivityAt)}
                          </span>
                        </>
                      ) : (
                        <span className="text-[12.5px] text-slate-400">{ui.common.none}</span>
                      )}
                    </Td>
                    {canEdit || canArchive ? (
                      <Td align="right" className="print:hidden">
                        <EntityListActions
                          workspaceId={workspaceId}
                          kind="project"
                          id={row.project.id}
                          status={row.project.status}
                          nextHref={listHref}
                          canEdit={canEdit}
                          canArchive={canArchive}
                        />
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroller>
        </SectionCard>
      )}

      <p className="text-[12px] text-slate-400">{ui.projects.writeNote}</p>
    </div>
  );
}
