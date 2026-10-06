import {
  deadlineLabel,
  decisionStatusNotes,
  factCategoryLabels,
  formatTimestamp,
  isTaskOverdue,
  knowledgeKindLabels,
  type Commitment,
  type Decision,
  type EvidenceRef,
  type Fact,
  type Idea,
  type Question,
  type Task,
} from '@suhbat/product';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { Badge, Dot, Meta, type FormAction } from './primitives';
import { EvidenceLink } from './evidence';
import {
  CommitmentStatusBadge,
  DecisionStatusBadge,
  IdeaStatusBadge,
  QuestionStatusBadge,
  TaskStatusBadge,
} from './badges';

/**
 * Analysis records: the things a meeting produced. Every card here carries its own evidence and every action
 * that is not wired in this build renders as a link or a stated limitation, never as a button that lies.
 */

export type RecordLinkProps = {
  hrefOf?: (evidence: EvidenceRef) => string | null | undefined;
  namesOf?: (evidence: EvidenceRef) => readonly string[];
  /** Shown on the citation when the transcript is not reachable from this surface. */
  evidenceUnavailableNote?: string;
};

export type DecisionCardProps = RecordLinkProps & {
  decision: Decision;
  /** Person names for the `participantPersonIds`, resolved by the page. */
  participantNames?: readonly string[];
  /** Label of the decision that replaced this one, when `supersededByDecisionId` is set. */
  supersededBy?: { label: string; href: string } | null;
  href?: string;
  followUps?: ReactNode;
  variant?: 'card' | 'row' | 'compact';
  topicLabel?: string;
};

export function DecisionCard({
  decision,
  participantNames = [],
  supersededBy,
  href,
  followUps,
  variant = 'card',
  topicLabel,
  hrefOf,
  namesOf,
  evidenceUnavailableNote,
}: DecisionCardProps) {
  const evidence = decision.evidence[0];
  const shell =
    variant === 'compact'
      ? 'rounded-lg border border-slate-200 bg-white px-3 py-2'
      : 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm';

  return (
    <article className={shell} data-status={decision.status}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug tracking-tight text-slate-900">
          {href ? (
            <a
              href={href}
              className="rounded hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              {decision.title}
            </a>
          ) : (
            decision.title
          )}
        </h3>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <DecisionStatusBadge status={decision.status} />
          {decision.hasFollowUpTasks ? (
            <Badge tone="outline" title="This decision produced follow-up tasks">
              <Icon name="check" size={11} />
              Follow-ups
            </Badge>
          ) : null}
        </div>
      </div>

      <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-700">{decision.description}</p>

      {variant !== 'compact' && evidence ? (
        <div className="mt-2.5">
          <EvidenceLink
            evidence={evidence}
            variant="block"
            href={hrefOf?.(evidence)}
            speakerNames={namesOf?.(evidence)}
            unavailableNote={evidenceUnavailableNote}
          />
        </div>
      ) : null}

      <Meta className="mt-2.5">
        {variant === 'compact' && evidence ? (
          <EvidenceLink
            evidence={evidence}
            variant="chip"
            href={hrefOf?.(evidence)}
            unavailableNote={evidenceUnavailableNote}
          />
        ) : null}
        <span title="Date the decision was taken in the meeting">{decision.decidedOn}</span>
        {topicLabel ? (
          <span className="inline-flex items-center gap-1">
            <Icon name="layers" size={12} className="text-slate-400" />
            {topicLabel}
          </span>
        ) : null}
        {participantNames.length > 0 ? <span>{participantNames.join(', ')}</span> : null}
      </Meta>

      {decision.status === 'superseded' && supersededBy ? (
        <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50/70 px-2.5 py-1.5 text-[12.5px] text-sky-900">
          Superseded — see{' '}
          <a
            href={supersededBy.href}
            className="font-medium underline decoration-sky-300 underline-offset-2"
          >
            {supersededBy.label}
          </a>
          . {decisionStatusNotes.superseded}
        </p>
      ) : null}

      {followUps ? <div className="mt-3 border-t border-slate-100 pt-2.5">{followUps}</div> : null}
    </article>
  );
}

export type TaskRowProps = RecordLinkProps & {
  task: Task;
  todayIsoDate: string;
  companyName?: string;
  projectName?: string;
  meetingHref?: string;
  /**
   * When the adapter can persist a status change, the page passes the form action and the row renders a real
   * control. Otherwise the status is text only — no optimistic checkbox.
   */
  updateAction?: { action: FormAction; status?: Task['status']; label?: string };
  blockedReason?: string;
  variant?: 'card' | 'compact';
  showMeeting?: boolean;
};

export function TaskRow({
  task,
  todayIsoDate,
  companyName,
  projectName,
  meetingHref,
  updateAction,
  blockedReason,
  variant = 'card',
  showMeeting = false,
  hrefOf,
  namesOf,
  evidenceUnavailableNote,
}: TaskRowProps) {
  const deadline = deadlineLabel(task, todayIsoDate);
  const overdue = isTaskOverdue(task, todayIsoDate);
  const evidence = task.evidence[0];
  const tone =
    deadline.tone === 'overdue'
      ? 'text-rose-800'
      : deadline.tone === 'soon'
        ? 'text-amber-900'
        : deadline.tone === 'done'
          ? 'text-slate-400'
          : 'text-slate-600';

  return (
    <article
      className={`group/task flex gap-3 rounded-xl border bg-white px-3.5 py-3 shadow-sm transition-colors ${
        overdue ? 'border-rose-200/80' : 'border-slate-200'
      } ${task.status === 'completed' ? 'opacity-80' : ''} ${variant === 'compact' ? 'py-2' : ''}`}
      data-status={task.status}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          {task.priority === 'high' && task.status !== 'completed' ? (
            <span title="Marked high priority in the meeting" className="mt-1 text-rose-600">
              <Dot tone="danger" />
            </span>
          ) : null}
          <h3
            className={`min-w-0 flex-1 text-[13.5px] font-semibold leading-snug text-slate-900 ${task.status === 'completed' ? 'text-slate-500 line-through decoration-slate-300' : ''}`}
          >
            {task.title}
          </h3>
          {task.status !== 'completed' ? (
            <Badge tone={overdue ? 'danger' : 'neutral'} className="shrink-0">
              {deadline.text}
            </Badge>
          ) : (
            <span className="shrink-0 text-[12px] text-slate-400">
              {task.completedAt?.slice(0, 10) ?? 'Completed'}
            </span>
          )}
        </div>
        {task.detail ? (
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{task.detail}</p>
        ) : null}
        <Meta className="mt-1.5">
          <span className="inline-flex items-center gap-1" title="Owner recorded from the meeting">
            <Icon name="user" size={12} className="text-slate-400" />
            {task.ownerLabel}
          </span>
          <span className={tone}>{task.dueDate ? `due ${task.dueDate}` : 'no deadline set'}</span>
          <TaskStatusBadge status={task.status} />
          {companyName ? <span>{companyName}</span> : null}
          {projectName ? <span>{projectName}</span> : null}
          {showMeeting && meetingHref ? (
            <a
              href={meetingHref}
              className="rounded text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
            >
              from meeting
            </a>
          ) : null}
          {evidence ? (
            <EvidenceLink
              evidence={evidence}
              variant="chip"
              href={hrefOf?.(evidence)}
              unavailableNote={evidenceUnavailableNote}
              speakerNames={namesOf?.(evidence)}
            />
          ) : null}
        </Meta>
      </div>

      <div className="flex shrink-0 flex-col items-end justify-start gap-1.5">
        {updateAction ? (
          <form action={updateAction.action}>
            <input type="hidden" name="taskId" value={task.id} />
            <input
              type="hidden"
              name="status"
              value={updateAction.status ?? (task.status === 'completed' ? 'open' : 'completed')}
            />
            <button
              type="submit"
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2 py-1 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
                task.status === 'completed'
                  ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
              }`}
            >
              <Icon name="check" size={13} />
              {updateAction.label ?? (task.status === 'completed' ? 'Reopen' : 'Complete')}
            </button>
          </form>
        ) : blockedReason ? (
          <span
            title={blockedReason}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-2 py-1 text-[12.5px] text-slate-500"
          >
            <Icon name="check" size={13} className="text-slate-400" />
            {task.status === 'completed' ? 'Completed' : 'Cannot update here'}
          </span>
        ) : null}
      </div>
    </article>
  );
}

export type FactCardProps = RecordLinkProps & {
  fact: Fact;
  speakerName?: string;
  /** Confidence is de-emphasised by design: shown as a tooltip and a faint bar, never as a verdict. */
  variant?: 'card' | 'compact';
};

export function FactCard({
  fact,
  speakerName,
  variant = 'card',
  hrefOf,
  evidenceUnavailableNote,
}: FactCardProps) {
  const evidence = fact.evidence[0]!;
  const value = fact.unit ? `${fact.value} ${fact.unit}` : fact.value;
  if (variant === 'compact') {
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-100 py-1.5 last:border-b-0">
        <span className="text-[13px] text-slate-600">{fact.label}</span>
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold tabular-nums text-slate-900">{value}</span>
          <EvidenceLink
            evidence={evidence}
            variant="chip"
            href={hrefOf?.(evidence)}
            unavailableNote={evidenceUnavailableNote}
          />
        </span>
      </div>
    );
  }
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="outline">{factCategoryLabels[fact.category]}</Badge>
        <span className="text-[12px] text-slate-500">{fact.label}</span>
      </div>
      <p className="mt-1.5 text-[15px] font-semibold tabular-nums leading-tight text-slate-900">
        {value}
      </p>
      <div className="mt-2">
        <EvidenceLink
          evidence={evidence}
          variant="block"
          href={hrefOf?.(evidence)}
          unavailableNote={evidenceUnavailableNote}
        />
      </div>
      <Meta className="mt-2">
        {speakerName ? <span>{speakerName}</span> : null}
        <span>{fact.capturedAt.slice(0, 10)}</span>
        {typeof fact.confidence === 'number' ? (
          <span
            title={`Transcription confidence ${Math.round(fact.confidence * 100)}%. Not a judgement about whether the fact is true.`}
            className="inline-flex items-center gap-1 text-slate-400"
          >
            <span
              aria-hidden="true"
              className="inline-block h-1 w-8 overflow-hidden rounded-full bg-slate-200"
            >
              <span
                className="block h-full rounded-full bg-slate-400"
                style={{ width: `${Math.round(fact.confidence * 100)}%` }}
              />
            </span>
            asr {Math.round(fact.confidence * 100)}%
          </span>
        ) : null}
      </Meta>
    </article>
  );
}

export function QuestionCard({
  question,
  askedByName,
  answererName,
  topicHref,
  topicTitle,
  hrefOf,
  namesOf,
  evidenceUnavailableNote,
}: {
  question: Question;
  askedByName?: string;
  answererName?: string;
  topicHref?: string;
  topicTitle?: string;
} & RecordLinkProps) {
  const evidence = question.evidence[0]!;
  return (
    <article
      className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm"
      data-status={question.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-slate-900">
          {question.text}
        </p>
        <QuestionStatusBadge status={question.status} />
      </div>
      {question.resolution ? (
        <div className="mt-2 rounded-lg border-l-2 border-emerald-500/60 bg-emerald-50/50 px-3 py-2">
          <p className="text-[13px] leading-relaxed text-emerald-950">
            {question.resolution.answer}
          </p>
          <Meta className="mt-1.5">
            <span className="font-mono text-[11.5px]">
              {formatTimestamp(question.resolution.evidence[0]!.startMs)}–
              {formatTimestamp(question.resolution.evidence[0]!.endMs)}
            </span>
            <span>resolved {question.resolution.answeredOn}</span>
            {answererName ? <span>{answererName}</span> : null}
          </Meta>
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] text-slate-500">
          Still open — nothing in the captured meetings answered it.
        </p>
      )}
      <div className="mt-2">
        <EvidenceLink
          evidence={evidence}
          href={hrefOf?.(evidence)}
          speakerNames={namesOf?.(evidence)}
          unavailableNote={evidenceUnavailableNote}
        />
      </div>
      <Meta className="mt-2">
        {askedByName ? (
          <span>asked by {askedByName}</span>
        ) : (
          <span>asked by an unmapped speaker</span>
        )}
        <span>raised {question.raisedOn}</span>
        {topicTitle && topicHref ? (
          <a
            href={topicHref}
            className="inline-flex items-center gap-1 rounded text-slate-500 hover:text-slate-900"
          >
            <Icon name="layers" size={12} className="text-slate-400" />
            {topicTitle}
          </a>
        ) : null}
      </Meta>
    </article>
  );
}

export function IdeaCard({
  idea,
  proposedByName,
  topicTitle,
  hrefOf,
  evidenceUnavailableNote,
}: {
  idea: Idea;
  proposedByName?: string;
  topicTitle?: string;
} & RecordLinkProps) {
  const evidence = idea.evidence[0]!;
  return (
    <article className="rounded-xl border border-dashed border-slate-300 bg-slate-50/40 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <Icon name="sparkles" size={13} className="text-slate-400" />
          Idea
        </span>
        <IdeaStatusBadge status={idea.status} />
      </div>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-800">{idea.text}</p>
      <div className="mt-2">
        <EvidenceLink
          evidence={evidence}
          href={hrefOf?.(evidence)}
          unavailableNote={evidenceUnavailableNote}
        />
      </div>
      <Meta className="mt-2">
        {proposedByName ? <span>{proposedByName}</span> : null}
        <span>{idea.raisedOn}</span>
        {topicTitle ? <span>{topicTitle}</span> : null}
      </Meta>
    </article>
  );
}

export function CommitmentRow({
  commitment,
  personName,
  todayIsoDate,
  hrefOf,
  evidenceUnavailableNote,
}: {
  commitment: Commitment;
  personName?: string;
  todayIsoDate: string;
} & RecordLinkProps) {
  const evidence = commitment.evidence[0]!;
  const missed =
    commitment.status === 'pending' &&
    commitment.dueDate !== null &&
    commitment.dueDate < todayIsoDate;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 py-2 last:border-b-0">
      <span
        aria-hidden="true"
        className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
          commitment.status === 'met'
            ? 'border-emerald-500 bg-emerald-500 text-white'
            : missed
              ? 'border-rose-400 bg-rose-50 text-rose-700'
              : 'border-slate-300 bg-white text-slate-400'
        }`}
      >
        <Icon name={commitment.status === 'met' ? 'check' : 'clock'} size={12} />
      </span>
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-slate-800">
        {commitment.text}
      </span>
      {personName ? (
        <span className="shrink-0 text-[12px] text-slate-500">{personName}</span>
      ) : null}
      <span className={`shrink-0 text-[12px] ${missed ? 'text-rose-800' : 'text-slate-500'}`}>
        {commitment.dueDate ?? 'no date'}
      </span>
      <CommitmentStatusBadge status={missed ? 'missed' : commitment.status} />
      <EvidenceLink
        evidence={evidence}
        variant="chip"
        href={hrefOf?.(evidence)}
        unavailableNote={evidenceUnavailableNote}
      />
    </li>
  );
}

/** A knowledge-list row: the kind badge is what makes a mixed Decisions/Facts/Topics stream readable. */
export function KnowledgeEntryRow({
  kind,
  title,
  body,
  meta,
  evidence,
  hrefOf,
  namesOf,
  evidenceUnavailableNote,
}: {
  kind: keyof typeof knowledgeKindLabels;
  title: ReactNode;
  body: ReactNode;
  meta?: ReactNode;
  evidence?: EvidenceRef;
} & RecordLinkProps) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50/60">
      <Badge tone="outline" className="mt-0.5 shrink-0">
        {knowledgeKindLabels[kind]}
      </Badge>
      <div className="min-w-[16rem] flex-1">
        <p className="text-[13.5px] font-semibold leading-snug text-slate-900">{title}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{body}</p>
        {meta ? <Meta className="mt-1.5">{meta}</Meta> : null}
      </div>
      {evidence ? (
        <div className="shrink-0">
          <EvidenceLink
            evidence={evidence}
            variant="chip"
            href={hrefOf?.(evidence)}
            unavailableNote={evidenceUnavailableNote}
            speakerNames={namesOf?.(evidence)}
          />
        </div>
      ) : null}
    </li>
  );
}

/** Small inline link used on cards where the full evidence row would dominate. */
export function EvidenceChip({
  evidence,
  href,
  note,
}: {
  evidence: EvidenceRef;
  href?: string | null;
  note?: string;
}) {
  return <EvidenceLink evidence={evidence} variant="chip" href={href} unavailableNote={note} />;
}

export function SectionEmpty({ label }: { label: string }) {
  return (
    <p className="text-[13px] italic text-slate-400">
      No {label.toLowerCase()} recorded in this meeting.
    </p>
  );
}
