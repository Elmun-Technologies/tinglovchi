import { formatTimestamp, type EvidenceRef } from '@suhbat/product';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { Badge } from './primitives';

/**
 * Evidence is the product's promise: every decision, task, fact, commitment and objection can be traced back
 * to the moment it was said. These components render that trace, and the same markup works for canonical
 * segment ids from a real pipeline because nothing here knows where the id came from.
 */

export type EvidenceLinkProps = {
  evidence: EvidenceRef;
  /** Where the citation lands. Built by the app from `routes.evidence`, never here. */
  href?: string | null;
  speakerNames?: readonly string[];
  /** `block` shows the quote; `inline` is the compact form used inside table cells. */
  variant?: 'inline' | 'block' | 'chip';
  /** Explains why a citation is not clickable in this build, when there is no href. */
  unavailableNote?: string;
  /** Set when a cited segment id could not be found — surfaced instead of hiding the row. */
  missingSegmentIds?: readonly string[];
};

export function EvidenceLink({
  evidence,
  href,
  speakerNames = [],
  variant = 'inline',
  unavailableNote,
  missingSegmentIds = [],
}: EvidenceLinkProps) {
  const range = evidenceRangeLabel(evidence);
  const speakers = speakerNames.length > 0 ? speakerNames.join(', ') : null;
  const broken = missingSegmentIds.length > 0;

  if (variant === 'chip') {
    const chip = (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11.5px] text-slate-600 group-hover/evidence:border-teal-600/40 group-hover/evidence:text-teal-800">
        <Icon name="quote" size={12} className="text-slate-400" />
        {range}
      </span>
    );
    return href && !broken ? (
      <a
        href={href}
        title={evidence.quote ? `"${evidence.quote}"` : 'Open this moment in the transcript'}
        className="group/evidence rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
      >
        {chip}
      </a>
    ) : (
      <span title={broken ? missingEvidenceNote(missingSegmentIds) : unavailableNote}>{chip}</span>
    );
  }

  const body = (
    <>
      <span className="mt-px shrink-0 text-slate-400">
        <Icon name="quote" size={14} />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-[12.5px] tabular-nums text-slate-700">{range}</span>
          {speakers ? <span className="text-[12.5px] text-slate-500">{speakers}</span> : null}
          <span className="text-[12px] text-slate-400">{evidence.meetingTitle}</span>
        </span>
        {variant === 'block' && evidence.quote ? (
          <span className="mt-1 block border-l-2 border-slate-200 pl-2.5 text-[13px] italic leading-relaxed text-slate-600">
            “{evidence.quote}”
          </span>
        ) : null}
        {broken ? (
          <span className="mt-1 block text-[12px] text-amber-800">
            {missingEvidenceNote(missingSegmentIds)}
          </span>
        ) : null}
      </span>
    </>
  );

  if (href && !broken) {
    return (
      <a
        href={href}
        className="group/evidence flex items-start gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 hover:[&_span]:text-teal-900"
      >
        {body}
      </a>
    );
  }

  return (
    <span className="flex items-start gap-2" title={unavailableNote}>
      {body}
      {!broken && unavailableNote ? (
        <span className="text-[12px] text-slate-400">· {unavailableNote}</span>
      ) : null}
    </span>
  );
}

export function evidenceRangeLabel(evidence: EvidenceRef): string {
  return `${formatTimestamp(evidence.startMs)}–${formatTimestamp(evidence.endMs)}`;
}

function missingEvidenceNote(missingSegmentIds: readonly string[]): string {
  return `Cited segments are not in this transcript (${missingSegmentIds.slice(0, 3).join(', ')}${
    missingSegmentIds.length > 3 ? ', …' : ''
  }).`;
}

/** A list of citations under a card, so a decision that was settled across four lines shows all four. */
export function EvidenceList({
  items,
  hrefOf,
  namesOf,
  variant = 'inline',
  className = '',
  unavailableNote,
}: {
  items: readonly EvidenceRef[];
  hrefOf?: (evidence: EvidenceRef) => string | null | undefined;
  namesOf?: (evidence: EvidenceRef) => readonly string[];
  variant?: 'inline' | 'block' | 'chip';
  className?: string;
  unavailableNote?: string;
}) {
  if (items.length === 0) {
    return (
      <p className={`text-[12.5px] text-slate-500 ${className}`}>
        No transcript evidence is attached to this record.
      </p>
    );
  }
  return (
    <ul className={`space-y-1.5 ${className}`}>
      {items.map((evidence) => (
        <li key={`${evidence.meetingId}-${evidence.startMs}-${evidence.segmentIds.join('+')}`}>
          <EvidenceLink
            evidence={evidence}
            variant={variant}
            href={hrefOf?.(evidence)}
            speakerNames={namesOf?.(evidence)}
            unavailableNote={unavailableNote}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * A source card in the answer to an Ask AI question: meeting, date, the exact range, who spoke, and what was
 * said. Clicking it walks the person to the transcript line, which is what makes the answer checkable.
 */
export function SourceCard({
  position,
  kind,
  meetingTitle,
  dateLabel,
  rangeLabel,
  speakerNames,
  quote,
  href,
  footer,
}: {
  position: number;
  kind: string;
  meetingTitle: string;
  dateLabel: string;
  rangeLabel: string;
  speakerNames?: readonly string[];
  quote: ReactNode;
  href?: string | null;
  footer?: ReactNode;
}) {
  return (
    <li className="group/source relative rounded-lg border border-slate-200 bg-white p-3 pl-9 transition-colors hover:border-slate-300">
      <span
        aria-hidden="true"
        className="absolute left-2.5 top-3 font-mono text-[11px] font-semibold text-slate-400"
      >
        {position}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="outline">{kind}</Badge>
        <span className="font-mono text-[12px] tabular-nums text-teal-800">{rangeLabel}</span>
      </div>
      <p className="mt-1.5 text-[13px] font-semibold leading-snug text-slate-900">{meetingTitle}</p>
      <p className="text-[12px] text-slate-500">
        {dateLabel}
        {speakerNames && speakerNames.length > 0 ? ` · ${speakerNames.join(', ')}` : ''}
      </p>
      <blockquote className="mt-2 border-l-2 border-slate-200 pl-2.5 text-[13px] italic leading-relaxed text-slate-600">
        {quote}
      </blockquote>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {footer}
        {href ? (
          <a
            href={href}
            className="inline-flex items-center gap-1 rounded text-[12.5px] font-medium text-teal-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            Open in transcript
            <Icon name="arrowRight" size={13} />
          </a>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Marks search hits inside transcript text without rendering user input as HTML: the split is done on
 * normalized text and the pieces are returned as children.
 */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const haystack = text.toLocaleLowerCase();
  const wanted = needle.toLocaleLowerCase();
  if (!haystack.includes(wanted)) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let hit = haystack.indexOf(wanted);
  while (hit !== -1) {
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark
        key={`${hit}-${parts.length}`}
        className="rounded-sm bg-amber-100 px-0.5 text-slate-900"
      >
        {text.slice(hit, hit + wanted.length)}
      </mark>,
    );
    cursor = hit + wanted.length;
    hit = haystack.indexOf(wanted, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
