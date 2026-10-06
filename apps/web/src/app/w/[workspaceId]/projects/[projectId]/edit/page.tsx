import { ButtonLink, Notice, PageHeader, SectionCard } from '@suhbat/ui';
import { can, formatShortDate, routes, toRepositoryError } from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../../../lib/repositories';
import { FlashNotice } from '../../../../../components/flash-notice';
import { WriteForm } from '../../../../../components/write-form';
import { ProjectFields } from '../../../../../components/entity/form-fields';
import { EntityListActions } from '../../../../../components/entity/list-actions';
import { saveProjectAction } from '../../../../../actions/product';
import { ui } from '../../../../../../copy/ui-copy';

export const metadata = { title: ui.writes.editProject };

/**
 * Editing a project. The company link is editable only while no recorded meeting contradicts it — the adapter
 * refuses the move and says how many meetings are in the way, because silently re-parenting a project would
 * rewrite which relationship those meetings happened under.
 */
export default async function EditProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, projectId } = await params;
  const query = await searchParams;
  const repositories = getRepositories();
  const capabilities = getCapabilities();
  const canWrite = can(capabilities, 'project.update');
  const canArchive = can(capabilities, 'project.archive');
  const loaded = await Promise.all([
    repositories.projects.get(projectId),
    repositories.companies.list(workspaceId, { includeArchived: true }),
    repositories.projects
      .overview(workspaceId, { includeArchived: true })
      .then((rows) => rows.find((row) => row.project.id === projectId)),
  ]).then(
    ([project, companies, overview]) => ({ ok: true as const, project, companies, overview }),
    (cause) => ({ ok: false as const, error: toRepositoryError(cause) }),
  );
  const detailHref = routes.project({ workspaceId, projectId });

  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader title={ui.writes.editProject} />
        <Notice tone="danger" title={ui.errors.notFoundTitle}>
          <p>{loaded.error.message}</p>
          {loaded.error.detail ? (
            <p className="font-mono text-[11.5px] text-slate-500">{loaded.error.detail}</p>
          ) : null}
        </Notice>
        <ButtonLink href={routes.projects({ workspaceId })} variant="secondary" size="sm">
          {ui.writes.back}
        </ButtonLink>
      </div>
    );
  }

  const { project, companies, overview } = loaded;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={project.name}
        description={ui.writes.editProject}
        breadcrumbs={[
          { label: ui.nav.projects, href: routes.projects({ workspaceId }) },
          { label: project.name, href: detailHref },
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
        title={ui.writes.editProject}
        description={ui.projects.writeNote}
        action={saveProjectAction}
        next={detailHref}
        submitLabel={ui.writes.save}
        capabilities={capabilities}
        canWrite={canWrite}
        aside={
          <SectionCard title={ui.projects.detail.overview}>
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
                <dt className="text-slate-500">Last activity</dt>
                <dd className="font-mono text-[11.5px] text-slate-600">
                  {overview?.lastActivityAt
                    ? formatShortDate(overview.lastActivityAt)
                    : ui.common.none}
                </dd>
              </div>
            </dl>
          </SectionCard>
        }
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value={project.id} />
        <ProjectFields project={project} companies={companies} canWrite={canWrite} />
      </WriteForm>

      <SectionCard
        title={project.status === 'active' ? ui.writes.archive : ui.writes.restore}
        description={ui.writes.archiveExplain}
        actions={
          <EntityListActions
            workspaceId={workspaceId}
            kind="project"
            id={project.id}
            status={project.status}
            nextHref={detailHref}
            canEdit={false}
            canArchive={canArchive}
            size="md"
          />
        }
      >
        <p className="text-[13px] text-slate-600">
          {project.status === 'active'
            ? `Active, with ${overview?.meetingCount ?? 0} ${
                (overview?.meetingCount ?? 0) === 1 ? 'meeting' : 'meetings'
              } recorded against it.`
            : 'Not in the default list. Its meetings and decisions stay exactly where they are.'}
        </p>
      </SectionCard>
    </div>
  );
}
