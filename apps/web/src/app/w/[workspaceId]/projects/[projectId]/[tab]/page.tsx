import { redirect } from 'next/navigation';
import { EntityDetail } from '../../../../../components/entity/detail';
import { getRepositories } from '../../../../../../lib/repositories';
import { buildLookup } from '../../../../../../lib/lookup';
import { projectTabLabels, projectTabs, routes } from '@suhbat/product';

export default async function ProjectTabPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; tab: string }>;
}) {
  const { workspaceId, projectId, tab } = await params;
  if (!(projectTabs as readonly string[]).includes(tab)) {
    redirect(routes.project({ workspaceId, projectId }));
  }
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
      tab={tab}
      repositories={repositories}
      lookup={lookup}
      todayIsoDate={dashboard.generatedAt.slice(0, 10)}
    />
  );
}

export function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  return params.then(({ tab }) => ({
    title: `${projectTabLabels[tab as keyof typeof projectTabLabels] ?? tab}`,
  }));
}
