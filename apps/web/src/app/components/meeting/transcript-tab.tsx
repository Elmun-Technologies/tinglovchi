import {
  ButtonLink,
  EmptyState,
  FilterBar,
  FilterField,
  FilterSelect,
  FilterTextInput,
  LanguageBadges,
  Notice,
  PlaybackBar,
  SectionCard,
  TranscriptList,
  TranscriptMetaBar,
} from '@suhbat/ui';
import {
  defaultTranscriptSpan,
  formatDuration,
  formatTimestamp,
  routes,
  speakingStats,
  transcriptWindowSpans,
  windowRangeLabel,
  type TranscriptWindow,
} from '@suhbat/product';
import type { Lookup } from '../../../lib/lookup';
import type { MeetingBundle } from '../../../lib/meeting-bundle';
import { ui } from '../../../copy/ui-copy';
import { SpeakerMapDialog } from './speaker-map-dialog';

export type TranscriptQuery = {
  q?: string;
  speaker?: string;
  topic?: string;
  seg?: string;
  t?: string;
  map?: string;
  /** Paging lives in the URL, so a window of a filtered transcript is a addressable view. */
  offset?: string;
  span?: string;
};

/**
 * Transcript screen.
 *
 * Rendering: the rows come from the adapter's *windowed* read (`transcripts.window`), so a three-hour meeting
 * never becomes one enormous response, and each row is `content-visibility`-contained on top of that. Filtering
 * happens before the slice — in the adapter, not here — which is why the "3 of 59 lines" count, the pager and the
 * rows can never disagree. No client virtualizer means no scroll listener, no measurement pass and no re-render
 * storm.
 *
 * Highlighting: `?seg=<id>` marks the row and `#<id>` lets the browser scroll it into view — a citation click
 * works with JS disabled and does not depend on an animation.
 *
 * Search: literal substring match on normalized text, so `bo‘laymiz` and `bo'laymiz` behave alike. It is
 * deliberately not semantic search; nothing here pretends to embed anything.
 */
export function MeetingTranscript({
  workspaceId,
  meetingId,
  bundle,
  lookup,
  query,
  canMapSpeakers,
  members,
  window,
}: {
  workspaceId: string;
  meetingId: string;
  bundle: MeetingBundle;
  lookup: Lookup;
  query: TranscriptQuery;
  canMapSpeakers: boolean;
  /** Roster the mapping dialog offers, from workspace settings. */
  members: { personId: string; name: string }[];
  /** The adapter's windowed, filtered read — the only transcript rows this screen renders. */
  window: TranscriptWindow;
}) {
  const { transcript, detail } = bundle;
  const q = query.q ?? '';
  const speaker = query.speaker ?? '';
  const topic = query.topic ?? '';
  const activeSegmentId = query.seg ?? '';
  const positionMs = readPosition(
    query,
    transcript.segments.find((segment) => segment.id === activeSegmentId)?.startMs,
  );

  const topicById = new Map(transcript.topics.map((item) => [item.id, item]));
  // The window already carries the filtered slice; re-filtering here would be a second, divergent implementation.
  const filtered = window.segments;
  const filtering = Boolean(q || speaker || topic);
  const pageHref = (offset: number, span: number) =>
    routes.meetingTab(
      { workspaceId, meetingId, tab: 'transcript' },
      {
        ...(q ? { q } : {}),
        ...(speaker ? { speaker } : {}),
        ...(topic ? { topic } : {}),
        ...(offset > 0 ? { offset: String(offset) } : {}),
        ...(span !== defaultTranscriptSpan ? { span: String(span) } : {}),
      },
    );
  const spanOptions = transcriptWindowSpans.map((span) => ({
    span,
    label: String(span),
    active: window.span === span,
  }));
  const stats = speakingStats(transcript.segments);
  const unmapped = detail.unmappedSpeakers;

  const hrefWith = (extra: Partial<TranscriptQuery>) =>
    routes.meetingTab(
      { workspaceId, meetingId, tab: 'transcript' },
      {
        q: extra.q !== undefined ? extra.q : q,
        speaker: extra.speaker !== undefined ? extra.speaker : speaker,
        topic: extra.topic !== undefined ? extra.topic : topic,
        seg: extra.seg !== undefined ? extra.seg : activeSegmentId,
        t: extra.t !== undefined ? extra.t : query.t,
      },
    );

  if (transcript.segments.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState
          title={ui.meeting.transcript.emptyTitle}
          description={ui.meeting.transcript.emptyBody}
          icon="mic"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PlaybackBar
        transcript={transcript}
        positionMs={positionMs}
        reason={detail.recording.available ? detail.recording.note : ui.meeting.playbackUnavailable}
        seekHref={hrefWith({})}
      />

      <FilterBar
        action={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
        resetHref={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
      >
        <FilterField
          label={ui.meeting.transcript.search}
          htmlFor="f-tq"
          className="min-w-[14rem] flex-[2]"
        >
          <FilterTextInput
            id="f-tq"
            name="q"
            value={q}
            placeholder={ui.meeting.transcript.searchPlaceholder}
          />
        </FilterField>
        <FilterField label={ui.meeting.transcript.speaker} htmlFor="f-speaker">
          <FilterSelect
            id="f-speaker"
            name="speaker"
            value={speaker}
            options={[
              { value: '', label: ui.meeting.transcript.allSpeakers },
              ...transcript.speakerMappings.map((mapping) => ({
                value: mapping.personId ?? `label:${mapping.label}`,
                label: `${mapping.personId ? (lookup.nameOf(mapping.personId) ?? mapping.label) : mapping.label} · ${mapping.segmentCount}`,
              })),
              // A diarization label nobody has claimed yet still needs to be reachable in the filter, otherwise
              // the only way to read those lines one at a time is to map them first.
              ...unmapped
                .filter(
                  (label) => !transcript.speakerMappings.some((mapping) => mapping.label === label),
                )
                .map((label) => ({
                  value: `label:${label}`,
                  label: `${label} · ${countLinesByLabel(transcript.segments, label)}`,
                })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.meeting.transcript.topic} htmlFor="f-topic">
          <FilterSelect
            id="f-topic"
            name="topic"
            value={topic}
            options={[
              { value: '', label: ui.meeting.transcript.allTopics },
              ...transcript.topics.map((item) => ({
                value: item.id,
                label: `${item.title} · ${item.segmentIds.length}`,
              })),
            ]}
          />
        </FilterField>
      </FilterBar>

      <TranscriptMetaBar className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <span>
          {ui.meeting.transcript.resultsFor}:{' '}
          <strong className="font-semibold text-slate-800 tabular-nums">
            {window.filteredCount}
          </strong>{' '}
          / {window.totalCount} {ui.meeting.transcript.lineCount}
        </span>
        <span className="tabular-nums text-slate-500">{windowRangeLabel(window)}</span>
        <span>{formatDuration(transcript.totalMs)}</span>
        <span>
          {transcript.wordCount} {ui.meeting.overview.words}
        </span>
        <LanguageBadges languages={detail.languages} />
        {unmapped.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-amber-900">
            {unmapped.length} {ui.meeting.transcript.unmapped}
            {canMapSpeakers ? (
              <a
                href={hrefWith({ map: unmapped[0] })}
                className="rounded underline decoration-amber-400 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                {ui.meeting.transcript.mapSpeakers}
              </a>
            ) : null}
          </span>
        ) : null}
        {filtering ? (
          <ButtonLink
            href={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
            size="sm"
            variant="ghost"
            className="ml-auto"
          >
            {ui.meeting.transcript.clearFilters}
          </ButtonLink>
        ) : null}
      </TranscriptMetaBar>

      {activeSegmentId ? (
        <Notice tone="info" title={ui.meeting.transcript.highlightNote}>
          <p>
            {ui.meeting.transcript.position}: {formatTimestamp(positionMs ?? 0)}
            {window.focusedSegmentId
              ? ` · ${ui.transcript.jumped} (${windowRangeLabel(window)})`
              : ''}
          </p>
        </Notice>
      ) : null}

      {window.filteredCount === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="search"
            title={ui.transcript.noMatchesTitle}
            description={ui.transcript.noMatchesBody}
            action={
              <ButtonLink
                href={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
                size="sm"
                variant="secondary"
              >
                {ui.transcript.clearFilters}
              </ButtonLink>
            }
          />
        </div>
      ) : null}

      <SectionCard flush className="overflow-hidden">
        <TranscriptList
          segments={filtered}
          speakers={lookup.participants}
          topicOf={(segment) => {
            const item = segment.topicId ? topicById.get(segment.topicId) : undefined;
            return item
              ? {
                  title: item.title,
                  href: `${routes.meetingTab({ workspaceId, meetingId, tab: 'topics' })}#topic-${item.id}`,
                }
              : null;
          }}
          permalinkOf={(segment) =>
            routes.evidence({
              workspaceId,
              meetingId,
              segmentId: segment.id,
              startMs: segment.startMs,
            })
          }
          activeSegmentId={activeSegmentId}
          query={q}
          mapSpeakerHref={
            canMapSpeakers && unmapped.length > 0 ? (label) => hrefWith({ map: label }) : undefined
          }
          emptyState={
            <EmptyState
              icon="search"
              title={
                q ? ui.meeting.transcript.noResultsTitle : ui.meeting.transcript.emptyAfterFilter
              }
              description={
                q ? ui.meeting.transcript.noResultsBody : ui.meeting.transcript.emptyBody
              }
              action={
                <ButtonLink
                  href={routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' })}
                  size="sm"
                  variant="secondary"
                >
                  {ui.meeting.transcript.clearFilters}
                </ButtonLink>
              }
            />
          }
          footer={
            stats.length > 1 ? (
              <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2">
                <p className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">
                  {ui.meeting.overview.speakingShare}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  {stats.map((stat) => (
                    <li key={stat.personId ?? stat.label} className="text-[12.5px] text-slate-600">
                      {lookup.nameOf(stat.personId) ?? stat.label} · {Math.round(stat.share * 100)}%
                      · {formatDuration(stat.spokenMs)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          }
        />
      </SectionCard>

      {window.filteredCount > 0 ? (
        <nav
          aria-label={ui.transcript.paging}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm"
        >
          {window.hasPrevious ? (
            <ButtonLink
              href={pageHref(Math.max(0, window.offset - window.span), window.span)}
              variant="secondary"
              size="sm"
              rel="prev"
            >
              {ui.transcript.previous}
            </ButtonLink>
          ) : (
            <span
              className="inline-flex min-h-8 items-center rounded-lg border border-slate-100 px-2.5 text-[13px] text-slate-300"
              aria-disabled="true"
            >
              {ui.transcript.previous}
            </span>
          )}
          <span className="text-[12.5px] text-slate-500 tabular-nums">
            {windowRangeLabel(window)}
          </span>
          {window.hasNext ? (
            <ButtonLink
              href={pageHref(window.offset + window.span, window.span)}
              variant="secondary"
              size="sm"
              rel="next"
            >
              {ui.transcript.next}
            </ButtonLink>
          ) : (
            <span
              className="inline-flex min-h-8 items-center rounded-lg border border-slate-100 px-2.5 text-[13px] text-slate-300"
              aria-disabled="true"
            >
              {ui.transcript.next}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {ui.transcript.linesPerPage}
            </span>
            {spanOptions.map((option) =>
              option.active ? (
                <span
                  key={option.span}
                  aria-current="page"
                  className="inline-flex min-h-7 items-center rounded-lg bg-slate-100 px-2 text-[12.5px] font-semibold text-slate-800"
                >
                  {option.label}
                </span>
              ) : (
                <a
                  key={option.span}
                  href={pageHref(0, option.span)}
                  className="inline-flex min-h-7 items-center rounded-lg px-2 text-[12.5px] text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  {option.label}
                </a>
              ),
            )}
          </span>
        </nav>
      ) : null}

      {query.map ? (
        <SpeakerMapDialog
          workspaceId={workspaceId}
          meetingId={meetingId}
          label={query.map}
          people={members}
          closeHref={hrefWith({ map: '' })}
          canWrite={canMapSpeakers}
        />
      ) : null}
    </div>
  );
}

function readPosition(query: TranscriptQuery, fallback: number | undefined): number | null {
  const raw = query.t !== undefined ? Number(query.t) : fallback;
  if (raw === undefined || raw === null || Number.isNaN(raw)) return null;
  return Math.max(0, Math.round(raw));
}

function countLinesByLabel(segments: { speakerLabel?: string }[], label: string): number {
  return segments.filter((segment) => segment.speakerLabel === label).length;
}
