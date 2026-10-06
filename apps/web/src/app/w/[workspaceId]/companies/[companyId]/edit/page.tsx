import { ButtonLink, Notice, PageHeader, SectionCard } from '@suhbat/ui';
import { can, formatShortDate, routes, toRepositoryError } from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../../../lib/repositories';
import { FlashNotice } from '../../../../../components/flash-notice';
import { WriteForm } from '../../../../../components/write-form';
import { CompanyFields } from '../../../../../components/entity/form-fields';
import { EntityListActions } from '../../../../../components/entity/list-actions';
import { saveCompanyAction } from '../../../../../actions/product';
import { ui } from '../../../../../../copy/ui-copy';

export const metadata = { title: ui.writes.editCompany };

/**
 * Editing a company: the same two questions as creation, answered again.
 *
 * The lifecycle control sits beside the form rather than behind a menu, because archiving is the reversible half
 * of the pair — and it is where a reader who is already changing the name can see that "archive" keeps the
 * record and its meetings instead of removing them.
 */
export default async function EditCompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, companyId } = await params;
  const query = await searchParams;
  const repositories = getRepositories();
  const capabilities = getCapabilities();
  const canWrite = can(capabilities, 'company.update');
  const canArchive = can(capabilities, 'company.archive');
  const loaded = await Promise.all([
    repositories.companies.get(companyId),
    repositories.companies
      .overview(workspaceId, { includeArchived: true })
      .then((rows) => rows.find((row) => row.company.id === companyId)),
  ]).then(
    ([company, overview]) => ({ ok: true as const, company, overview }),
    (cause) => ({ ok: false as const, error: toRepositoryError(cause) }),
  );

  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader title={ui.writes.editCompany} />
        <Notice tone="danger" title={ui.errors.notFoundTitle}>
          <p>{loaded.error.message}</p>
          {loaded.error.detail ? (
            <p className="font-mono text-[11.5px] text-slate-500">{loaded.error.detail}</p>
          ) : null}
        </Notice>
        <ButtonLink href={routes.companies({ workspaceId })} variant="secondary" size="sm">
          {ui.writes.back}
        </ButtonLink>
      </div>
    );
  }

  const { company, overview } = loaded;
  const detailHref = routes.company({ workspaceId, companyId });

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={company.name}
        description={ui.writes.editCompany}
        breadcrumbs={[
          { label: ui.nav.companies, href: routes.companies({ workspaceId }) },
          { label: company.name, href: detailHref },
          { label: ui.writes.edit },
        ]}
        actions={
          <ButtonLink href={detailHref} variant="ghost" size="sm">
            {ui.writes.back}
          </ButtonLink>
        }
      />
      <FlashNotice params={query} />
      <WriteForm
        title={ui.writes.editCompany}
        description={ui.writes.duplicateHint}
        action={saveCompanyAction}
        next={detailHref}
        submitLabel={ui.writes.save}
        capabilities={capabilities}
        canWrite={canWrite}
        aside={
          <SectionCard title={ui.companies.detail.overview}>
            <dl className="space-y-1.5 text-[12.5px]">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">{ui.companies.columns.meetings}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {overview?.meetingCount ?? 0}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">{ui.companies.columns.openTasks}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {overview?.openTaskCount ?? 0}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Created</dt>
                <dd className="font-mono text-[11.5px] text-slate-600">
                  {formatShortDate(company.createdAt)}
                </dd>
              </div>
            </dl>
          </SectionCard>
        }
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="companyId" value={company.id} />
        <CompanyFields company={company} canWrite={canWrite} />
      </WriteForm>

      <SectionCard
        title={company.status === 'active' ? ui.writes.archive : ui.writes.restore}
        description={ui.writes.archiveExplain}
        actions={
          <EntityListActions
            workspaceId={workspaceId}
            kind="company"
            id={company.id}
            status={company.status}
            nextHref={detailHref}
            canEdit={false}
            canArchive={canArchive}
            size="md"
          />
        }
      >
        <p className="text-[13px] text-slate-600">
          {company.status === 'active'
            ? `Currently active. Its ${overview?.meetingCount ?? 0} meetings stay readable either way.`
            : 'Currently archived, so it is hidden from the default list. Its meetings still name it.'}
        </p>
      </SectionCard>
    </div>
  );
}
