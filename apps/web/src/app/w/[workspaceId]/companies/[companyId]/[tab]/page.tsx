import { redirect } from 'next/navigation';
import { EntityDetail } from '../../../../../components/entity/detail';
import { getRepositories } from '../../../../../../lib/repositories';
import { buildLookup } from '../../../../../../lib/lookup';
import { companyTabLabels, companyTabs, routes } from '@suhbat/product';

export default async function CompanyTabPage({
  params,
}: {
  params: Promise<{ workspaceId: string; companyId: string; tab: string }>;
}) {
  const { workspaceId, companyId, tab } = await params;
  if (!(companyTabs as readonly string[]).includes(tab)) {
    redirect(routes.company({ workspaceId, companyId }));
  }
  const repositories = getRepositories();
  const [lookup, dashboard] = await Promise.all([
    buildLookup(repositories, workspaceId),
    repositories.meetings.dashboard(workspaceId),
  ]);
  return (
    <EntityDetail
      kind="company"
      workspaceId={workspaceId}
      entityId={companyId}
      tab={tab}
      repositories={repositories}
      lookup={lookup}
      todayIsoDate={dashboard.generatedAt.slice(0, 10)}
    />
  );
}

export function generateMetadata({
  params,
}: {
  params: Promise<{ companyId: string; tab: string }>;
}) {
  return params.then(({ tab }) => ({
    title: `${companyTabLabels[tab as keyof typeof companyTabLabels] ?? tab}`,
  }));
}
