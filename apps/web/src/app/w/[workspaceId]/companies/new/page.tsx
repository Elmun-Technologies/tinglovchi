import { ButtonLink, PageHeader } from '@suhbat/ui';
import { can, routes } from '@suhbat/product';
import { getCapabilities } from '../../../../../lib/repositories';
import { FlashNotice } from '../../../../components/flash-notice';
import { WriteForm } from '../../../../components/write-form';
import { CompanyFields } from '../../../../components/entity/form-fields';
import { saveCompanyAction } from '../../../../actions/product';
import { ui } from '../../../../../copy/ui-copy';

export const metadata = { title: ui.writes.newCompany };

/**
 * Creating a company. One field pair, because that is what a company *is* in this product: a name, and what it
 * does. The rules belong to the adapter (`@suhbat/product/writes`); `minLength`/`maxLength` here only move the
 * same rule earlier so a mistake shows before a round trip, and a browser limit is never the check. A duplicate
 * name is refused by the adapter rather than merged, so no screen has to guess which record won.
 */
export default async function NewCompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const capabilities = getCapabilities();
  const canWrite = can(capabilities, 'company.create');

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={ui.writes.newCompany}
        description={ui.companies.intro}
        breadcrumbs={[
          { label: ui.nav.companies, href: routes.companies({ workspaceId }) },
          { label: ui.writes.newCompany },
        ]}
        actions={
          <ButtonLink href={routes.companies({ workspaceId })} variant="ghost" size="sm">
            {ui.common.back}
          </ButtonLink>
        }
      />
      <FlashNotice params={query} />
      <WriteForm
        title={ui.writes.newCompany}
        description={ui.writes.duplicateHint}
        action={saveCompanyAction}
        next={routes.companies({ workspaceId })}
        submitLabel={ui.writes.create}
        capabilities={capabilities}
        canWrite={canWrite}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        {/* An empty id is how this form says "create"; the same action edits when the id is present. */}
        <input type="hidden" name="companyId" value="" />
        <CompanyFields canWrite={canWrite} />
      </WriteForm>
      <p className="text-[12px] text-slate-400">{ui.companies.writeNote}</p>
    </div>
  );
}
