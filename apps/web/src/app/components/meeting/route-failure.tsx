import { ErrorState, PageHeader } from '@suhbat/ui';
import { routes } from '@suhbat/product';
import type { MeetingPageFailure } from '../../../lib/meeting-page';
import { ui } from '../../../copy/ui-copy';

/**
 * A meeting route that could not be served. `not_found` and a provider failure read differently on purpose: a
 * missing record is a fact about the URL, a failed read is a fact about the data source, and collapsing the two
 * is how a product hides an outage inside an empty state.
 */
export function MeetingRouteFailure({ failure }: { failure: MeetingPageFailure }) {
  const { workspaceId, meetingId, error } = failure;
  return (
    <div className="space-y-4">
      <PageHeader
        title={error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle}
        breadcrumbs={[
          { label: ui.nav.meetings, href: routes.meetings({ workspaceId }) },
          { label: meetingId },
        ]}
      />
      <ErrorState
        title={error.code === 'not_found' ? ui.errors.notFoundTitle : ui.errors.providerTitle}
        message={error.message}
        code={error.code}
        detail={meetingId}
        hint={
          error.hint ??
          (error.code === 'not_found'
            ? 'Workspace routes only resolve records that belong to them, so an id from another workspace reads as missing.'
            : undefined)
        }
        retryHref={routes.meetings({ workspaceId })}
      />
    </div>
  );
}
