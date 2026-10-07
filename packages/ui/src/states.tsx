import {
  processingLabel,
  processingStepLabel,
  type MeetingProcessingState,
  type ProcessingTimeline,
} from '@suhbat/product';
import { meetingStateLabels } from '@suhbat/product';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { Badge, ButtonLink, Card, Dot, Meta } from './primitives';

/**
 * The three states every real product surface needs and most demos skip: nothing yet, something broke, and
 * something is happening. They are components here so no page invents its own version.
 */

export type NoticeTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

const noticeStyles: Record<NoticeTone, string> = {
  neutral: 'border-slate-200 bg-white text-slate-700',
  info: 'border-sky-200 bg-sky-50/60 text-sky-900',
  warning: 'border-amber-200 bg-amber-50/70 text-amber-900',
  danger: 'border-rose-200 bg-rose-50/70 text-rose-900',
  success: 'border-emerald-200 bg-emerald-50/70 text-emerald-900',
};

const noticeIcons: Record<NoticeTone, 'info' | 'alert' | 'check'> = {
  neutral: 'info',
  info: 'info',
  warning: 'alert',
  danger: 'alert',
  success: 'check',
};

export function Notice({
  tone = 'neutral',
  title,
  children,
  actions,
  className = '',
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 text-[13px] leading-relaxed ${noticeStyles[tone]} ${className}`}
    >
      <span className="mt-0.5 shrink-0 opacity-80">
        <Icon name={noticeIcons[tone]} />
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="text-[13.5px] font-semibold">{title}</p> : null}
        {children ? <div className="mt-0.5 space-y-1 opacity-95">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = 'layers',
  className = '',
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: 'layers' | 'search' | 'file' | 'check' | 'clock' | 'sparkles' | 'user' | 'mic';
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-2 px-6 py-12 text-center ${className}`}>
      <span className="rounded-full bg-slate-100 p-2.5 text-slate-500">
        <Icon name={icon} size={18} />
      </span>
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description ? (
        <p className="max-w-md text-[13px] leading-relaxed text-slate-500">{description}</p>
      ) : null}
      {action ? <div className="mt-2 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * A failed read. Kept separate from `EmptyState` on purpose: emptiness and breakage must never look alike, so
 * a provider outage is never silently rendered as "no meetings yet".
 */
export function ErrorState({
  title = 'This could not be loaded',
  message,
  code,
  detail,
  hint,
  retryHref,
  className = '',
}: {
  title?: ReactNode;
  message: ReactNode;
  code?: string;
  detail?: ReactNode;
  hint?: ReactNode;
  retryHref?: string;
  className?: string;
}) {
  return (
    <Card className={`border-rose-200 p-0 ${className}`}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span className="mt-0.5 rounded-full bg-rose-50 p-2 text-rose-700">
          <Icon name="alert" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{message}</p>
          {hint ? <p className="mt-1.5 text-[13px] text-slate-600">{hint}</p> : null}
          {code || detail ? (
            <Meta className="mt-2">
              {code ? (
                <Badge tone="outline">
                  <code className="font-mono text-[11px]">{code}</code>
                </Badge>
              ) : null}
              {detail ? (
                <span className="break-all">
                  <code className="font-mono text-[11.5px] text-slate-500">{detail}</code>
                </span>
              ) : null}
            </Meta>
          ) : null}
        </div>
        {retryHref ? (
          <ButtonLink href={retryHref} variant="secondary" size="sm">
            <Icon name="refresh" size={14} />
            Try again
          </ButtonLink>
        ) : null}
      </div>
    </Card>
  );
}

export function ErrorStateFromReason({
  reason,
  retryHref,
  resourceLabel,
}: {
  reason: { code?: string; message: string; detail?: string; hint?: string };
  retryHref?: string;
  resourceLabel?: string;
}) {
  const title =
    reason.code === 'not_found'
      ? `${resourceLabel ?? 'That'} was not found`
      : reason.code === 'unsupported_in_demo'
        ? 'Not available on demo data'
        : reason.code === 'data_inconsistent'
          ? 'The stored data disagrees with itself'
          : `${resourceLabel ?? 'This'} could not be loaded`;
  return (
    <ErrorState
      title={title}
      message={reason.message}
      code={reason.code}
      detail={reason.detail}
      hint={reason.hint}
      retryHref={retryHref}
    />
  );
}

/** Row placeholders while a read is in flight. Deliberately not a percentage bar. */
export function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-3"
        >
          <span className="size-8 rounded-full bg-slate-200/80" />
          <span className="h-3 flex-1 rounded bg-slate-200/80" />
          <span className="h-3 w-16 rounded bg-slate-200/70" />
        </div>
      ))}
    </div>
  );
}

const stepStyles = {
  done: { ring: 'bg-emerald-500 text-white', label: 'text-slate-700' },
  active: { ring: 'bg-teal-600 text-white', label: 'text-slate-900' },
  pending: { ring: 'bg-white text-slate-400 ring-1 ring-slate-200', label: 'text-slate-500' },
  failed: { ring: 'bg-rose-600 text-white', label: 'text-rose-900' },
} as const;

/**
 * Pipeline status as documented steps. No percentages: this build does not measure pipeline progress, and a
 * made-up number is worse than an honest "step 3 of 6".
 */
export function ProcessingState({
  timeline,
  stateLabel = true,
  retryHref,
  retryLabel = 'Retry failed step',
  footer,
  className = '',
}: {
  timeline: ProcessingTimeline;
  stateLabel?: boolean;
  /**
   * Where a retry goes. A link rather than a handler so the affordance works before any pipeline adapter
   * exists, and the server can decide whether retry is actually permitted.
   */
  retryHref?: string;
  retryLabel?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const label = processingLabel(timeline);
  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {stateLabel ? (
              <Badge
                tone={
                  timeline.state === 'failed' ||
                  timeline.state === 'transcription_failed' ||
                  timeline.state === 'analysis_failed'
                    ? 'danger'
                    : timeline.state === 'ready' ||
                        timeline.state === 'transcript_ready' ||
                        timeline.state === 'analysis_ready'
                      ? 'success'
                      : 'info'
                }
              >
                <Dot
                  tone={
                    timeline.state === 'failed' ||
                    timeline.state === 'transcription_failed' ||
                    timeline.state === 'analysis_failed'
                      ? 'danger'
                      : timeline.state === 'ready' ||
                          timeline.state === 'transcript_ready' ||
                          timeline.state === 'analysis_ready'
                        ? 'success'
                        : 'info'
                  }
                />
                {meetingStateLabels[timeline.state as MeetingProcessingState]}
              </Badge>
            ) : null}
            <p className="text-[13px] font-medium text-slate-700">{label}</p>
          </div>
          {timeline.error ? (
            <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[13px] text-rose-900">
              <p className="font-semibold">{timeline.error.message}</p>
              {timeline.error.hint ? (
                <p className="mt-0.5 opacity-90">{timeline.error.hint}</p>
              ) : null}
              <p className="mt-1 font-mono text-[11px] opacity-75">{timeline.error.code}</p>
            </div>
          ) : null}
        </div>
        {timeline.error?.retryable && retryHref ? (
          <ButtonLink href={retryHref} variant="secondary" size="sm">
            <Icon name="refresh" size={14} />
            {retryLabel}
          </ButtonLink>
        ) : null}
      </div>

      <ol className="mt-3 space-y-0.5">
        {timeline.steps.map((step) => {
          const style = stepStyles[step.state];
          return (
            <li key={step.key} className="flex items-start gap-2.5 py-1">
              <span
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${style.ring}`}
                aria-hidden="true"
              >
                {step.state === 'done' ? (
                  <Icon name="check" size={12} />
                ) : step.state === 'failed' ? (
                  <Icon name="alert" size={12} />
                ) : (
                  <span className="text-white/0">.</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] font-medium ${style.label}`}>
                  {processingStepLabel(step)}
                </span>
                {step.detail ? (
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                    {step.detail}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] text-slate-400">
                {step.state === 'pending' ? 'Waiting' : step.at ? formatTimeOfDay(step.at) : ''}
              </span>
            </li>
          );
        })}
      </ol>
      {footer ? (
        <div className="mt-3 border-t border-slate-100 pt-2.5 text-[12.5px] text-slate-500">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

function formatTimeOfDay(isoDateTime: string): string {
  const time = isoDateTime.split('T')[1];
  return time ? time.slice(0, 5) : '';
}

/**
 * A capability this build does not have. Used instead of a disabled-looking control that would silently do
 * nothing, or a placeholder that looks like a working feature.
 */
export function NotWiredState({
  title,
  reason,
  href,
  hrefLabel,
  tone = 'neutral',
  className = '',
}: {
  title: ReactNode;
  reason: ReactNode;
  href?: string;
  hrefLabel?: string;
  tone?: NoticeTone;
  className?: string;
}) {
  return (
    <Notice
      tone={tone}
      title={title}
      className={className}
      actions={
        href ? (
          <ButtonLink href={href} variant="secondary" size="sm">
            {hrefLabel ?? 'Open'}
          </ButtonLink>
        ) : undefined
      }
    >
      <p>{reason}</p>
    </Notice>
  );
}
