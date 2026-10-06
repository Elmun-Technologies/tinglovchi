import { meetingTabs, RepositoryError, toRepositoryError, type MeetingTab } from '@suhbat/product';
import { getRepositories } from './repositories';
import { buildLookup, type Lookup } from './lookup';
import { loadMeetingBundle, type MeetingBundle } from './meeting-bundle';
import { readFlash, type Flash } from './feedback';

/**
 * Shared preparation for every meeting route: resolve the tab, load the bundle and the display lookups once, and
 * normalize any adapter failure into one typed error the frame can render. Pages stay declarative because the
 * same reads do not need to be re-derived per tab.
 */
export type MeetingPageContext = {
  workspaceId: string;
  meetingId: string;
  tab: MeetingTab;
  bundle: MeetingBundle;
  lookup: Lookup;
  repositories: ReturnType<typeof getRepositories>;
  flash: Flash | null;
  searchParams: Record<string, string | string[] | undefined>;
  /** The demo dataset's own "today", so deadline copy is stable instead of drifting with the clock. */
  todayIsoDate: string;
};

export type MeetingPageFailure = {
  workspaceId: string;
  meetingId: string;
  tab: MeetingTab;
  error: RepositoryError;
};

export async function prepareMeetingPage(
  params: Promise<{ workspaceId: string; meetingId: string; tab?: string }>,
  searchParamsPromise: Promise<Record<string, string | string[] | undefined>>,
  defaultTab: MeetingTab = 'overview',
): Promise<{ ok: true; ctx: MeetingPageContext } | { ok: false; failure: MeetingPageFailure }> {
  const { workspaceId, meetingId, tab: tabParam } = await params;
  const searchParams = await searchParamsPromise;
  const tab = (meetingTabs as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as MeetingTab)
    : defaultTab;
  const repositories = getRepositories();

  try {
    const [bundleResult, lookup, snapshot] = await Promise.all([
      loadMeetingBundle(repositories, workspaceId, meetingId),
      buildLookup(repositories, workspaceId),
      repositories.meetings.dashboard(workspaceId),
    ]);
    if (!bundleResult.ok) {
      return { ok: false, failure: { workspaceId, meetingId, tab, error: bundleResult.error } };
    }
    return {
      ok: true,
      ctx: {
        workspaceId,
        meetingId,
        tab,
        bundle: bundleResult.bundle,
        lookup,
        repositories,
        flash: readFlash(searchParams),
        searchParams,
        todayIsoDate: snapshot.generatedAt.slice(0, 10),
      },
    };
  } catch (cause) {
    return { ok: false, failure: { workspaceId, meetingId, tab, error: toRepositoryError(cause) } };
  }
}
