import { Badge, EmptyState, Metric, PageHeader, SectionCard } from '@suhbat/ui';
import { formatShortDate, routes, type ProductRepositories } from '@suhbat/product';
import { ui } from '../../../copy/ui-copy';

export async function CompanyProjects({
  workspaceId,
  repositories,
  companyId,
}: {
  workspaceId: string;
  repositories: ProductRepositories;
  companyId: string;
}) {
  // Archived projects still belong to the company, so this panel reads every lifecycle state and labels them.
  const overviews = (
    await repositories.projects.overview(workspaceId, { includeArchived: true })
  ).filter((row) => row.project.companyId === companyId);
  if (overviews.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState
          icon="file"
          title={ui.projects.emptyTitle}
          description={ui.projects.emptyBody}
        />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <PageHeader title={ui.companies.detail.projects} description={ui.projects.intro} />
      <ul className="grid gap-2.5 lg:grid-cols-2">
        {overviews.map((row) => (
          <li key={row.project.id}>
            <SectionCard
              title={
                <a
                  href={routes.project({ workspaceId, projectId: row.project.id })}
                  className="rounded hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  {row.project.name}
                </a>
              }
              description={row.project.description ?? undefined}
              actions={
                <Badge tone={row.project.status === 'active' ? 'accent' : 'neutral'}>
                  {row.project.status}
                </Badge>
              }
            >
              <dl className="grid grid-cols-3 gap-x-3">
                <Metric label={ui.meetings.title} value={row.meetingCount} />
                <Metric label={ui.companies.detail.openTasks} value={row.openTaskCount} />
                <Metric label={ui.meeting.decisions.title} value={row.decisionCount} />
              </dl>
              {row.lastActivityAt ? (
                <p className="mt-2.5 text-[12px] text-slate-400">
                  {ui.companies.columns.lastMeeting}: {formatShortDate(row.lastActivityAt)}
                </p>
              ) : null}
            </SectionCard>
          </li>
        ))}
      </ul>
    </div>
  );
}
