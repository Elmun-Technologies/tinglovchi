import {
  commitmentStatusLabels,
  decisionStatusLabels,
  decisionStatusNotes,
  ideaStatusLabels,
  languageShortLabels,
  meetingStateLabels,
  meetingStateNotes,
  participantKindLabels,
  questionStatusLabels,
  taskStatusLabels,
  type Commitment,
  type DecisionStatus,
  type Idea,
  type LanguageCode,
  type MeetingProcessingState,
  type Participant,
  type Question,
  type TaskStatus,
} from '@suhbat/product';
import { Badge, type BadgeTone, Dot } from './primitives';

/**
 * Vocabulary badges. Labels come from the product package, so a badge can never disagree with a page's own
 * wording, and status colour is always paired with text.
 */

const meetingStateTones: Record<MeetingProcessingState, BadgeTone> = {
  draft: 'neutral',
  recording: 'accent',
  queued: 'neutral',
  uploading: 'info',
  preparing_transcript: 'info',
  transcribing: 'info',
  analyzing: 'warning',
  indexing: 'warning',
  ready: 'success',
  failed: 'danger',
};

/** In-pipeline states get a dot so a dense table column can be scanned without reading every cell. */
const statesWithDot = new Set<MeetingProcessingState>([
  'recording',
  'queued',
  'uploading',
  'preparing_transcript',
  'transcribing',
  'analyzing',
  'indexing',
  'failed',
]);

export function MeetingStatusBadge({
  state,
  withNote = false,
}: {
  state: MeetingProcessingState;
  /** Adds the one-line explanation as a tooltip; detail headers use it, tables do not. */
  withNote?: boolean;
}) {
  const tone = meetingStateTones[state];
  const note = meetingStateNotes[state];
  return (
    <Badge tone={tone} title={withNote ? note : undefined}>
      {statesWithDot.has(state) ? <Dot tone={tone} /> : null}
      {meetingStateLabels[state]}
    </Badge>
  );
}

export function MeetingTypeBadge({ label, tone = 'outline' }: { label: string; tone?: BadgeTone }) {
  return <Badge tone={tone}>{label}</Badge>;
}

const decisionStatusTones: Record<DecisionStatus, BadgeTone> = {
  proposed: 'neutral',
  tentative: 'warning',
  confirmed: 'success',
  rejected: 'danger',
  superseded: 'info',
};

export function DecisionStatusBadge({ status }: { status: DecisionStatus }) {
  return (
    <Badge tone={decisionStatusTones[status]} title={decisionStatusNotes[status]}>
      {status === 'confirmed' ? <Dot tone="success" /> : null}
      {decisionStatusLabels[status]}
    </Badge>
  );
}

const taskStatusTones: Record<TaskStatus, BadgeTone> = {
  open: 'neutral',
  in_progress: 'info',
  blocked: 'warning',
  completed: 'success',
  cancelled: 'outline',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={taskStatusTones[status]}>{taskStatusLabels[status]}</Badge>;
}

export function QuestionStatusBadge({ status }: { status: Question['status'] }) {
  return (
    <Badge tone={status === 'open' ? 'warning' : status === 'answered' ? 'success' : 'neutral'}>
      {questionStatusLabels[status]}
    </Badge>
  );
}

export function IdeaStatusBadge({ status }: { status: Idea['status'] }) {
  return (
    <Badge tone={status === 'adopted' ? 'success' : status === 'dropped' ? 'outline' : 'neutral'}>
      {ideaStatusLabels[status]}
    </Badge>
  );
}

export function CommitmentStatusBadge({ status }: { status: Commitment['status'] }) {
  return (
    <Badge tone={status === 'met' ? 'success' : status === 'missed' ? 'danger' : 'neutral'}>
      {commitmentStatusLabels[status]}
    </Badge>
  );
}

export function LanguageBadges({
  languages,
  max = 3,
}: {
  languages: readonly LanguageCode[];
  max?: number;
}) {
  if (languages.length === 0) return null;
  const shown = languages.slice(0, max);
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`Languages: ${languages.join(', ')}`}
    >
      {shown.map((language) => (
        <span
          key={language}
          className="rounded border border-slate-200 bg-white px-1 py-px font-mono text-[10.5px] uppercase text-slate-600"
        >
          {languageShortLabels[language]}
        </span>
      ))}
      {languages.length > shown.length ? (
        <span className="text-[11px] text-slate-500">+{languages.length - shown.length}</span>
      ) : null}
    </span>
  );
}

const avatarTones: Record<Participant['kind'], string> = {
  internal: 'bg-slate-200 text-slate-700',
  client: 'bg-teal-100 text-teal-900',
  external: 'bg-white text-slate-600 ring-1 ring-slate-200',
};

export type AvatarSize = 'sm' | 'md' | 'lg';

const avatarSizes: Record<AvatarSize, string> = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-[11.5px]',
  lg: 'size-10 text-[13px]',
};

export function ParticipantAvatar({
  name,
  initials,
  kind = 'internal',
  size = 'md',
  unmapped = false,
  showName = false,
}: {
  name: string;
  initials: string;
  kind?: Participant['kind'];
  size?: AvatarSize;
  /** A diarization label with no person yet — drawn with a dashed ring instead of a colour the UI invented. */
  unmapped?: boolean;
  showName?: boolean;
}) {
  const label = unmapped
    ? `${name} — speaker not mapped yet`
    : `${name} · ${participantKindLabels[kind]}`;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        title={label}
        aria-label={label}
        className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight ${
          avatarSizes[size]
        } ${unmapped ? 'border border-dashed border-slate-300 bg-white text-slate-500' : avatarTones[kind]}`}
      >
        {initials}
      </span>
      {showName ? <span className="truncate text-[13px] text-slate-700">{name}</span> : null}
    </span>
  );
}

export function ParticipantStack({
  participants,
  max = 5,
  size = 'sm',
}: {
  participants: readonly Participant[];
  max?: number;
  size?: AvatarSize;
}) {
  const shown = participants.slice(0, max);
  const overflow = participants.length - shown.length;
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {shown.map((participant) => (
        <span key={participant.personId} className="ring-2 ring-white rounded-full">
          <ParticipantAvatar
            name={participant.name}
            initials={participant.initials}
            kind={participant.kind}
            size={size}
            unmapped={!participant.mapped}
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          title={participants
            .slice(max)
            .map((participant) => participant.name)
            .join(', ')}
          className={`inline-flex items-center justify-center rounded-full bg-slate-100 font-semibold text-slate-600 ring-2 ring-white ${avatarSizes[size]}`}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Where the data on screen comes from. Demo fixtures are labelled as such everywhere, so nobody mistakes a
 * populated screen for a connected pipeline.
 */
export function DataModeBadge({ mode, label }: { mode: 'demo' | 'live'; label: string }) {
  return (
    <Badge tone={mode === 'demo' ? 'outline' : 'success'} title={label}>
      {mode === 'demo' ? 'Demo data' : 'Live data'}
    </Badge>
  );
}
