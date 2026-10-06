import {
  Badge,
  ButtonLink,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterField,
  FilterTextInput,
  PageHeader,
  Table,
  TableScroller,
  Td,
  Th,
  Tr,
} from '@suhbat/ui';
import { can, formatShortDate, relativeDayLabel, routes, toRepositoryError } from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../lib/repositories';
import { EntityListActions } from '../../../components/entity/list-actions';
import { ui } from '../../../../copy/ui-copy';

export const metadata = { title: ui.companies.title };

/**
 * Companies, table-first: what each relationship consists of and how much of it is still open. The counts come
 * from the adapter's `overview` read rather than being recomputed in the page, so a company row means the same
 * thing here as it does on its own detail page.
 */
export default async function CompaniesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const q = (Array.isArray(query.q) ? query.q[0] : query.q) ?? '';
  // Archived companies are a deliberate view, not a hidden state: the toggle is in the URL, so the filtered
  // list can be linked and reloaded like any other.
  const includeArchived =
    query.archived === 'true' || (Array.isArray(query.archived) && query.archived[0] === 'true');
  const repositories = getRepositories();
  const capabilities = getCapabilities();
  const canCreate = can(capabilities, 'company.create');
  const canEdit = can(capabilities, 'company.update');
  const canArchive = can(capabilities, 'company.archive');
  const loaded = await Promise.all([
    repositories.companies.overview(workspaceId, { includeArchived, query: q }),
    repositories.meetings.dashboard(workspaceId),
  ]).then(
    ([overview, dashboard]) => ({
      ok: true as const,
      overview,
      todayIsoDate: dashboard.generatedAt.slice(0, 10),
    }),
    (cause) => ({ ok: false as const, error: toRepositoryError(cause) }),
  );

  if (!loaded.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title={ui.companies.title} description={ui.companies.intro} />
        <ErrorState
          title={
            loaded.error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle
          }
          message={loaded.error.message}
          code={loaded.error.code}
          detail={loaded.error.detail}
          retryHref={routes.companies({ workspaceId })}
        />
      </div>
    );
  }

  // The adapter owns name/description matching and the archived toggle, so this count and the filter box above
  // cannot drift apart.
  const needle = q.trim();
  const rows = loaded.overview;
  const listHref = `${routes.companies({ workspaceId })}${
    needle || includeArchived
      ? `?${new URLSearchParams({ ...(needle ? { q: needle } : {}), ...(includeArchived ? { archived: 'true' } : {}) })}`
      : ''
  }`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={ui.companies.title}
        description={ui.companies.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {rows.length} {rows.length === 1 ? 'company' : 'companies'}
            {needle ? ` ${ui.transcript.filtered}` : ''}
            {includeArchived ? ` · ${ui.writes.archived} included` : ''}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canCreate ? (
              <ButtonLink href={routes.newCompany({ workspaceId })} variant="primary" size="sm">
                {ui.writes.newCompany}
              </ButtonLink>
            ) : null}
            <ButtonLink href={routes.newMeeting({ workspaceId })} variant="secondary" size="sm">
              {ui.nav.newMeeting}
            </ButtonLink>
          </div>
        }
      />

      <FilterBar
        action={routes.companies({ workspaceId })}
        resetHref={routes.companies({ workspaceId })}
      >
        <FilterField label={ui.companies.search} htmlFor="f-q" className="min-w-[16rem] flex-[2]">
          <FilterTextInput id="f-q" name="q" value={q} placeholder={ui.companies.search} />
        </FilterField>
        <FilterField
          label={ui.writes.showArchived}
          htmlFor="f-archived"
          className="flex-none self-end pb-1"
        >
          {/* hidden default + checkbox: an unchecked box submits `false` rather than nothing. */}
          <input type="hidden" name="archived" value="false" />
          <label className="inline-flex min-h-10 items-center gap-2 text-[13px] text-slate-700">
            <input
              id="f-archived"
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
            title={needle || !canCreate ? ui.companies.emptyTitle : 'No companies yet'}
            description={
              needle
                ? 'No company name or note matches that wording.'
                : canCreate
                  ? 'Create the first company to group its meetings, projects and decisions.'
                  : ui.companies.emptyBody
            }
            action={
              needle ? (
                <ButtonLink href={routes.companies({ workspaceId })} size="sm" variant="secondary">
                  {ui.common.reset}
                </ButtonLink>
              ) : canCreate ? (
                <ButtonLink href={routes.newCompany({ workspaceId })} size="sm" variant="primary">
                  {ui.writes.newCompany}
                </ButtonLink>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <TableScroller>
            <Table className="stacked">
              <caption className="sr-only">{ui.companies.title}</caption>
              <thead>
                <tr>
                  <Th>{ui.companies.columns.company}</Th>
                  <Th align="right">{ui.companies.columns.projects}</Th>
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
                  <Tr key={row.company.id}>
                    <Td className="max-w-[24rem]">
                      <div className="min-w-0">
                        <a
                          href={routes.company({ workspaceId, companyId: row.company.id })}
                          className="rounded text-[14px] font-semibold leading-snug text-slate-900 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                        >
                          {row.company.name}
                        </a>
                        {row.company.status !== 'active' ? (
                          <Badge tone="neutral" className="ml-2 align-middle">
                            {ui.writes.archivedBadge}
                          </Badge>
                        ) : null}
                        {row.company.description ? (
                          <p className="mt-0.5 line-clamp-1 text-[12.5px] text-slate-500">
                            {row.company.description}
                          </p>
                        ) : null}
                      </div>
                    </Td>
                    <Td align="right" label={ui.companies.columns.projects}>
                      <span className="text-[13px] font-semibold tabular-nums text-slate-800">
                        {row.activeProjectCount}
                      </span>
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
                        href={routes.company({
                          workspaceId,
                          companyId: row.company.id,
                          tab: 'decisions',
                        })}
                        className="rounded text-[13px] font-semibold tabular-nums text-slate-800 hover:text-teal-900"
                      >
                        {row.decisionCount}
                      </a>
                    </Td>
                    <Td className="whitespace-nowrap" label={ui.companies.columns.lastMeeting}>
                      {row.lastMeetingAt ? (
                        <>
                          <span className="block text-[13px] text-slate-700">
                            {relativeDayLabel(row.lastMeetingAt, loaded.todayIsoDate)}
                          </span>
                          <span className="block font-mono text-[11.5px] text-slate-400">
                            {formatShortDate(row.lastMeetingAt)}
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
                          kind="company"
                          id={row.company.id}
                          status={row.company.status}
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
        </div>
      )}

      <p className="text-[12px] text-slate-400">{ui.companies.writeNote}</p>
    </div>
  );
}
