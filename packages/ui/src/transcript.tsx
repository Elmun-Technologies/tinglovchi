import {
  formatDuration,
  formatTimestamp,
  type MeetingTranscript,
  type Participant,
  type Topic,
  type TranscriptSegment as Segment,
} from '@suhbat/product';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { Badge, ButtonLink, Dot } from './primitives';
import { HighlightedText } from './evidence';

/**
 * Transcript surface. Two decisions matter here:
 *
 * 1. Performance. The list is plain server-rendered markup with `content-visibility` on each row (see the
 *    `transcript-row` rule in the app stylesheet), so a 90-minute meeting costs the same as a 5-minute one to
 *    the browser. No client virtualizer, no re-render on scroll.
 * 2. Highlighting without JS. A cited line carries `id={segment.id}` and is targeted by URL fragment, so the
 *    browser scrolls it into view and `:target`/`data-active` marks it. Nothing depends on an animation.
 */

export type TranscriptSegmentProps = {
  segment: Segment;
  /** Resolved from `speakerPersonId`; `null` while a diarization label is unattributed. */
  speaker: Participant | null;
  /** The raw label, always shown when there is no person yet. */
  speakerLabel: string;
  topic: { title: string; href: string } | null;
  /** Deep link that reopens this exact line highlighted — what a timestamp click does in this build. */
  permalink: string;
  active?: boolean;
  query?: string;
  /** Opens the speaker-mapping dialog for this label. Absent means mapping is not available here. */
  mapSpeakerHref?: string;
};

export function TranscriptSegment({
  segment,
  speaker,
  speakerLabel,
  topic,
  permalink,
  active = false,
  query = '',
  mapSpeakerHref,
}: TranscriptSegmentProps) {
  return (
    <li
      id={segment.id}
      data-active={active ? 'true' : undefined}
      className={`transcript-row group/segment flex scroll-mt-28 gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0 focus-within:bg-teal-50/40 data-[active=true]:bg-teal-50 data-[active=true]:ring-1 data-[active=true]:ring-teal-600/30 ${
        active ? 'animate-none' : ''
      }`}
    >
      <a
        href={permalink}
        title={`Open this line at ${formatTimestamp(segment.startMs)}`}
        className="mt-px shrink-0 rounded font-mono text-[12px] tabular-nums text-slate-500 hover:bg-slate-100 hover:text-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
      >
        {formatTimestamp(segment.startMs)}
      </a>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {speaker ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-flex size-5 items-center justify-center rounded-full bg-slate-200 text-[9.5px] font-semibold text-slate-700"
              >
                {speaker.initials}
              </span>
              <span className="text-[13px] font-semibold text-slate-900">{speaker.name}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-slate-300 text-[9px] font-semibold text-slate-400"
              >
                ?
              </span>
              <span className="text-[13px] font-semibold text-slate-500">{speakerLabel}</span>
              {mapSpeakerHref ? (
                <a
                  href={mapSpeakerHref}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-px text-[11px] font-medium text-slate-600 hover:border-teal-600/40 hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  <Icon name="user" size={11} />
                  Map speaker
                </a>
              ) : null}
            </span>
          )}
          <span className="font-mono text-[11px] text-slate-400">{segment.language}</span>
          {typeof segment.confidence === 'number' ? (
            <span
              className="text-[11px] text-slate-400"
              title="Transcription confidence, as reported by the engine"
            >
              {Math.round(segment.confidence * 100)}%
            </span>
          ) : null}
          {topic ? (
            <a
              href={topic.href}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-px text-[11px] text-slate-600 hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              <Icon name="layers" size={11} className="text-slate-400" />
              {topic.title}
            </a>
          ) : null}
          <span className="ml-auto text-[11px] text-slate-300 group-hover/segment:text-slate-400">
            {formatDuration(segment.endMs - segment.startMs)}
          </span>
        </div>
        <p className="mt-1 text-[14px] leading-[1.55] text-slate-800">
          <HighlightedText text={segment.text} query={query} />
        </p>
      </div>
    </li>
  );
}

export type TranscriptListProps = {
  segments: Segment[];
  speakers: Map<string, Participant | null>;
  topicOf: (segment: Segment) => { title: string; href: string } | null;
  permalinkOf: (segment: Segment) => string;
  activeSegmentId?: string | null;
  query?: string;
  mapSpeakerHref?: (label: string) => string;
  emptyState?: ReactNode;
  /** Rendered once after the list, e.g. a "900 more lines exist in the real product" note. */
  footer?: ReactNode;
};

export function TranscriptList({
  segments,
  speakers,
  topicOf,
  permalinkOf,
  activeSegmentId,
  query = '',
  mapSpeakerHref,
  emptyState,
  footer,
}: TranscriptListProps) {
  if (segments.length === 0) return <>{emptyState}</>;
  return (
    <>
      <ol className="divide-y divide-slate-100">
        {segments.map((segment) => (
          <TranscriptSegment
            key={segment.id}
            segment={segment}
            speaker={
              segment.speakerPersonId ? (speakers.get(segment.speakerPersonId) ?? null) : null
            }
            speakerLabel={segment.speakerLabel}
            topic={topicOf(segment)}
            permalink={permalinkOf(segment)}
            active={segment.id === activeSegmentId}
            query={query}
            mapSpeakerHref={mapSpeakerHref?.(segment.speakerLabel)}
          />
        ))}
      </ol>
      {footer}
    </>
  );
}

/**
 * Playback contract, honestly rendered. This build has no audio bridge, so the bar shows position, offers the
 * controls in a disabled state, and says why — instead of shipping a player that cannot play.
 */
export function PlaybackBar({
  transcript,
  positionMs,
  reason,
  seekHref,
  actions,
}: {
  transcript: Pick<MeetingTranscript, 'totalMs'>;
  positionMs: number | null;
  reason: string;
  /** Where the "jump to time" form submits. Position, not play. */
  seekHref: string;
  actions?: ReactNode;
}) {
  const position = positionMs ?? 0;
  const ratio = transcript.totalMs > 0 ? Math.min(1, position / transcript.totalMs) : 0;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
      <span className="inline-flex items-center gap-2">
        <span
          aria-disabled="true"
          title={reason}
          className="inline-flex size-8 cursor-not-allowed items-center justify-center rounded-full bg-slate-100 text-slate-400"
        >
          <Icon name="play" size={14} />
        </span>
        <span className="font-mono text-[12.5px] tabular-nums text-slate-700">
          {formatTimestamp(position)} <span className="text-slate-300">/</span>{' '}
          {formatTimestamp(transcript.totalMs)}
        </span>
      </span>
      <form action={seekHref} method="get" className="flex min-w-[12rem] flex-1 items-center gap-2">
        <label htmlFor="playback-seek" className="sr-only">
          Jump to time in the transcript
        </label>
        <input
          id="playback-seek"
          name="t"
          type="range"
          min={0}
          max={Math.max(1, Math.round(transcript.totalMs))}
          step={1000}
          defaultValue={Math.round(position)}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-teal-700"
          aria-describedby="playback-seek-note"
        />
        <span id="playback-seek-note" className="sr-only">
          {reason}
        </span>
        <span
          aria-hidden="true"
          className="pointer-events-none -ml-1 hidden h-1.5 rounded-full bg-teal-600/70 sm:block"
          style={{ width: `${Math.round(ratio * 100)}%`, maxWidth: '40%' }}
        />
        <ButtonLink href={seekHref} variant="secondary" size="sm">
          Jump
        </ButtonLink>
      </form>
      <span className="inline-flex items-center gap-1.5 text-[12px] text-slate-500" title={reason}>
        <Dot tone="warning" />
        No audio in this build
      </span>
      {actions}
    </div>
  );
}

/**
 * One topic on the topic map. Topics are sections, not a graph: the hierarchy is real (parent → child by
 * transcript order) and each section states the time range it covers and what came out of it.
 */
export function TopicSection({
  topic,
  depth = 0,
  participants,
  transcriptHref,
  expanded = depth === 0,
  related,
  note,
}: {
  topic: Topic;
  depth?: number;
  participants: readonly Participant[];
  transcriptHref: string;
  expanded?: boolean;
  related?: { label: string; items: ReactNode[] }[];
  note?: ReactNode;
}) {
  const hasChildren = (related?.length ?? 0) > 0;
  return (
    <details
      open={expanded}
      id={`topic-${topic.id}`}
      className={`group/topic rounded-xl border border-slate-200 bg-white shadow-sm ${
        depth > 0 ? 'border-l-2 border-l-teal-600/25' : ''
      }`}
      style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 [&::-webkit-details-marker]:hidden">
        <span
          className={`mt-0.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90 ${hasChildren ? '' : 'opacity-0'}`}
        >
          <Icon name="chevronRight" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span
              className={`font-semibold tracking-tight text-slate-900 ${depth > 0 ? 'text-[13.5px]' : 'text-[14.5px]'}`}
            >
              {topic.title}
            </span>
            <span className="font-mono text-[11.5px] tabular-nums text-slate-500">
              {formatTimestamp(topic.startMs)}–{formatTimestamp(topic.endMs)}
            </span>
            <span className="text-[11.5px] text-slate-400">
              {formatDuration(topic.endMs - topic.startMs)}
            </span>
            <Badge tone="outline">{topic.segmentIds.length} lines</Badge>
          </span>
          <span className="mt-1 block text-[13px] leading-relaxed text-slate-600">
            {topic.summary}
          </span>
          {topic.keywords.length > 0 ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {topic.keywords.map((keyword) => (
                <span
                  key={keyword}
                  className="rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-600"
                >
                  {keyword}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </summary>
      <div className="border-t border-slate-100 px-4 py-3">
        {participants.length > 0 ? (
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Spoke
            </span>
            {participants.map((participant) => (
              <span
                key={participant.personId}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] text-slate-700"
              >
                <span aria-hidden="true" className="text-[9.5px] font-semibold">
                  {participant.initials}
                </span>
                {participant.name}
              </span>
            ))}
          </div>
        ) : null}
        {note}
        {related && related.length > 0 ? (
          <dl className="space-y-2.5">
            {related.map((group) => (
              <div key={group.label}>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {group.label}
                </dt>
                <dd className="mt-1 space-y-1.5">
                  {group.items.map((item, index) => (
                    <div key={index}>{item}</div>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-[13px] text-slate-500">
            No decisions or follow-ups were recorded under this topic.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2.5">
          <ButtonLink href={transcriptHref} variant="secondary" size="sm">
            <Icon name="file" size={13} />
            Show {topic.segmentIds.length} transcript lines
          </ButtonLink>
        </div>
      </div>
    </details>
  );
}

/** Header strip above the transcript list: who spoke how much, plus the filters already applied. */
export function TranscriptMetaBar({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-[12.5px] text-slate-600 ${className}`}
    >
      {children}
    </div>
  );
}
