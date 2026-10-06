import { ButtonLink, PageHeader } from '@suhbat/ui';
import { can, routes } from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../../lib/repositories';
import { FlashNotice } from '../../../../components/flash-notice';
import { WriteForm } from '../../../../components/write-form';
import { ProjectFields } from '../../../../components/entity/form-fields';
import { saveProjectAction } from '../../../../actions/product';
import { ui } from '../../../../../copy/ui-copy';

export const metadata = { title: ui.writes.newProject };

/**
 * Creating a project. `?company=` pre-fills the link when the form was opened from a company page, because the
 * reader already said which company they meant; it is a default, not a lock, and a project may belong to none.
 */
export default async function NewProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const repositories = getRepositories();
  const capabilities = getCapabilities();
  const canWrite = can(capabilities, 'project.create');
  const single = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const preselect = single('company') ?? '';
  const companies = await repositories.companies.list(workspaceId, { includeArchived: true });

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={ui.writes.newProject}
        description={ui.projects.intro}
        breadcrumbs={[
          { label: ui.nav.projects, href: routes.projects({ workspaceId }) },
          { label: ui.writes.newProject },
        ]}
        actions={
          <ButtonLink href={routes.projects({ workspaceId })} variant="ghost" size="sm">
            {ui.common.back}
          </ButtonLink>
        }
      />
      <FlashNotice params={query} />
      <WriteForm
        title={ui.writes.newProject}
        description={ui.writes.duplicateHint}
        action={saveProjectAction}
        next={routes.projects({ workspaceId })}
        submitLabel={ui.writes.create}
        capabilities={capabilities}
        canWrite={canWrite}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value="" />
        <ProjectFields companies={companies} defaultCompanyId={preselect} canWrite={canWrite} />
      </WriteForm>
      <p className="text-[12px] text-slate-400">{ui.projects.writeNote}</p>
    </div>
  );
}
