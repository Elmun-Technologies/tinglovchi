import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { can, meetingTabLabels, meetingTabs, routes, type MeetingTab } from '@suhbat/product';
import { MeetingFrame } from '../../../../../components/meeting/meeting-frame';
import { MeetingTopics } from '../../../../../components/meeting/topics-tab';
import {
  MeetingTranscript,
  type TranscriptQuery,
} from '../../../../../components/meeting/transcript-tab';
import { MeetingRecords } from '../../../../../components/meeting/records-tab';
import { MeetingRouteFailure } from '../../../../../components/meeting/route-failure';
import { prepareMeetingPage } from '../../../../../../lib/meeting-page';
import { readFlash } from '../../../../../../lib/feedback';
import { transcriptPagingFromQuery } from '../../../../../../lib/transcript-window';

/**
 * One route segment carries every non-default tab: `/transcript`, `/topics`, `/decisions`, `/tasks`, `/facts`,
 * `/questions`, `/ideas`. The segment is validated against the product's own tab list, so an unknown tab is a
 * 404-shaped redirect to Overview rather than a silently blank page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspaceId: string; meetingId: string; tab: string }>;
}): Promise<Metadata> {
  const { tab } = await params;
  const label = (meetingTabs as readonly string[]).includes(tab)
    ? meetingTabLabels[tab as MeetingTab]
    : meetingTabLabels.overview;
  return { title: label };
}

export default async function MeetingTabRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; meetingId: string; tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await params;
  if (!(meetingTabs as readonly string[]).includes(raw.tab) || raw.tab === 'overview') {
    // Overview is its own route; anything else in the segment is not a tab at all.
    redirect(routes.meeting({ workspaceId: raw.workspaceId, meetingId: raw.meetingId }));
  }

  const prepared = await prepareMeetingPage(params, searchParams, 'overview');
  if (!prepared.ok) return <MeetingRouteFailure failure={prepared.failure} />;
  const { ctx } = prepared;
  const single = (key: string) => {
    const value = ctx.searchParams[key];
    return Array.isArray(value) ? value[0] : value;
  };

  let content: ReactNode;
  if (ctx.tab === 'transcript') {
    const query: TranscriptQuery = {
      q: single('q'),
      speaker: single('speaker'),
      topic: single('topic'),
      seg: single('seg'),
      t: single('t'),
      map: single('map'),
      // Paging is part of the URL, so "page 3 of the search results" is linkable and survives a reload.
      offset: single('offset'),
      span: single('span'),
    };
    const settings = await ctx.repositories.settings.get(ctx.workspaceId);
    // The screen lists a window, never the whole transcript: the adapter filters, then slices, and a cited
    // line (`?seg=`) is allowed to pull its own window forward.
    const transcriptWindow = await ctx.repositories.transcripts.window({
      meetingId: ctx.meetingId,
      query: query.q ?? '',
      ...(query.speaker ? { speaker: query.speaker } : {}),
      ...(query.topic ? { topicId: query.topic } : {}),
      ...(query.seg ? { focusSegmentId: query.seg } : {}),
      ...transcriptPagingFromQuery(query),
    });
    content = (
      <MeetingTranscript
        workspaceId={ctx.workspaceId}
        meetingId={ctx.meetingId}
        bundle={ctx.bundle}
        lookup={ctx.lookup}
        query={query}
        window={transcriptWindow}
        members={settings.members.map((member) => ({
          personId: member.personId,
          name: member.name,
        }))}
        canMapSpeakers={can(ctx.repositories.capabilities, 'transcript.speakerMapping')}
      />
    );
  } else if (ctx.tab === 'topics') {
    content = (
      <MeetingTopics
        workspaceId={ctx.workspaceId}
        meetingId={ctx.meetingId}
        bundle={ctx.bundle}
        lookup={ctx.lookup}
        todayIsoDate={ctx.todayIsoDate}
      />
    );
  } else if (
    ctx.tab === 'decisions' ||
    ctx.tab === 'tasks' ||
    ctx.tab === 'facts' ||
    ctx.tab === 'questions' ||
    ctx.tab === 'ideas'
  ) {
    content = (
      <MeetingRecords
        tab={ctx.tab}
        workspaceId={ctx.workspaceId}
        meetingId={ctx.meetingId}
        bundle={ctx.bundle}
        lookup={ctx.lookup}
        repositories={ctx.repositories}
        todayIsoDate={ctx.todayIsoDate}
        searchParams={ctx.searchParams}
      />
    );
  } else {
    content = null;
  }

  return (
    <MeetingFrame
      workspaceId={ctx.workspaceId}
      meetingId={ctx.meetingId}
      tab={ctx.tab}
      bundle={ctx.bundle}
      capabilities={ctx.repositories.capabilities}
      notice={readFlash(ctx.searchParams)}
    >
      {content}
    </MeetingFrame>
  );
}
