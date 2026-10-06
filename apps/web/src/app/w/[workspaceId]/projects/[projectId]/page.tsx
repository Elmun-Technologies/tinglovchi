import { EntityDetail } from '../../../../components/entity/detail';
import { getRepositories } from '../../../../../lib/repositories';
import { buildLookup } from '../../../../../lib/lookup';
import { projectTabs } from '@suhbat/product';

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const repositories = getRepositories();
  const [lookup, dashboard] = await Promise.all([
    buildLookup(repositories, workspaceId),
    repositories.meetings.dashboard(workspaceId),
  ]);
  return (
    <EntityDetail
      kind="project"
      workspaceId={workspaceId}
      entityId={projectId}
      tab={projectTabs[0]}
      repositories={repositories}
      lookup={lookup}
      todayIsoDate={dashboard.generatedAt.slice(0, 10)}
    />
  );
}
