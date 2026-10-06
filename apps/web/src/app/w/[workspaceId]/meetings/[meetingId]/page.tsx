import { MeetingFrame } from '../../../../components/meeting/meeting-frame';
import { MeetingOverview } from '../../../../components/meeting/overview-tab';
import { MeetingRouteFailure } from '../../../../components/meeting/route-failure';
import { prepareMeetingPage } from '../../../../../lib/meeting-page';
import { readFlash } from '../../../../../lib/feedback';

/** Meeting Overview — the default view of `[meetingId]`, with every other tab one segment away. */
export default async function MeetingOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; meetingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const prepared = await prepareMeetingPage(params, searchParams, 'overview');
  if (!prepared.ok) return <MeetingRouteFailure failure={prepared.failure} />;
  const { ctx } = prepared;

  return (
    <MeetingFrame
      workspaceId={ctx.workspaceId}
      meetingId={ctx.meetingId}
      tab="overview"
      bundle={ctx.bundle}
      capabilities={ctx.repositories.capabilities}
      notice={readFlash(ctx.searchParams)}
    >
      <MeetingOverview
        workspaceId={ctx.workspaceId}
        bundle={ctx.bundle}
        lookup={ctx.lookup}
        todayIsoDate={ctx.todayIsoDate}
        capabilities={ctx.repositories.capabilities}
      />
    </MeetingFrame>
  );
}
