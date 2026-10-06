import { EntityDetail } from '../../../../components/entity/detail';
import { getRepositories } from '../../../../../lib/repositories';
import { buildLookup } from '../../../../../lib/lookup';
import { companyTabs } from '@suhbat/product';

export default async function CompanyOverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string; companyId: string }>;
}) {
  const { workspaceId, companyId } = await params;
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
      tab={companyTabs[0]}
      repositories={repositories}
      lookup={lookup}
      todayIsoDate={dashboard.generatedAt.slice(0, 10)}
    />
  );
}
