/**
 * Product vocabulary → human labels, in one module.
 *
 * This is the swap point for localization: components and pages look a label up by enum value instead of
 * carrying per-language conditionals or string literals. Nothing here does I/O, and no label is derived from
 * a value the UI invented.
 */
import type {
  Commitment,
  DecisionStatus,
  Project,
  FactCategory,
  Idea,
  KnowledgeKind,
  LanguageCode,
  MeetingProcessingState,
  Participant,
  ProcessingStep,
  Question,
  TaskStatus,
} from './domain';
import type { CompanyTab, MeetingTab, ProjectTab } from './query';

export const meetingStateLabels: Record<MeetingProcessingState, string> = {
  draft: 'Draft',
  recording: 'Recording',
  queued: 'Queued',
  uploading: 'Uploading',
  preparing: 'Preparing',
  ready_for_transcription: 'Ready for transcription',
  preparing_transcript: 'Preparing transcript',
  transcribing: 'Transcribing',
  normalizing_transcript: 'Normalizing transcript',
  transcript_ready: 'Transcript ready',
  transcription_failed: 'Transcription failed',
  ready_for_analysis: 'Ready for analysis',
  analyzing: 'Analyzing',
  normalizing_analysis: 'Normalizing analysis',
  analysis_ready: 'Analysis ready',
  analysis_failed: 'Analysis failed',
  indexing: 'Indexing',
  ready: 'Ready',
  failed: 'Needs attention',
};

/**
 * What each state means to the person looking at it. `state` and `step` stay separate on purpose: the badge
 * says where things are, this sentence says what happens next.
 */
export const meetingStateNotes: Record<MeetingProcessingState, string> = {
  draft: 'Nothing has been captured yet.',
  recording: 'The desktop recorder holds this session on the recording machine.',
  queued: 'Waiting for the next step in the pipeline.',
  uploading: 'Sending captured audio to the workspace store.',
  preparing: 'Verifying uploaded recording chunks and preparing canonical audio assets.',
  ready_for_transcription:
    'Recording chunks are verified and prepared. Transcription has not started yet.',
  preparing_transcript: 'Aligning captured audio into one timeline per speaker.',
  transcribing: 'Converting speech into timestamped segments.',
  normalizing_transcript:
    'Aligning provider speech segments and speaker labels onto the canonical meeting timeline.',
  transcript_ready:
    'Canonical transcript and speaker segments are ready. AI meeting analysis has not run yet.',
  transcription_failed:
    'Transcription or canonical alignment reported a failure. Verified recording chunks are preserved.',
  ready_for_analysis:
    'Canonical transcript is finalized and queued for structured AI meeting intelligence.',
  analyzing: 'Extracting decisions, tasks, facts, questions and ideas.',
  normalizing_analysis:
    'Validating transcript evidence references and persisting structured meeting intelligence.',
  analysis_ready:
    'Structured meeting intelligence and evidence links are validated and ready to finalize.',
  analysis_failed:
    'AI meeting analysis or evidence validation reported a failure. Canonical transcript is preserved.',
  indexing: 'Making the content searchable across the workspace.',
  ready: 'Transcript, topics and analysis are available.',
  failed: 'A step reported a failure. The steps already completed are kept.',
};

/** Keyed by `ProcessingStep.key`; `step.label` wins when a fixture is more specific. */
export const processingStepLabels: Record<string, string> = {
  capture: 'Captured on device',
  upload: 'Uploaded',
  verify: 'Chunks verified',
  prepare_recording: 'Recording prepared',
  ready_for_transcription: 'Ready for transcription',
  prepare: 'Transcript prepared',
  transcript: 'Transcript prepared',
  transcribe: 'Transcribed',
  transcribing: 'Transcribed',
  normalize_transcript: 'Transcript aligned to canonical timeline',
  transcript_ready: 'Transcript ready',
  diarize: 'Speakers separated',
  ready_for_analysis: 'Ready for analysis',
  analyze: 'Analyzed',
  analyze_meeting: 'Structured intelligence extracted',
  normalize_intelligence: 'Intelligence evidence validated',
  finalize_analysis: 'Meeting intelligence finalized',
  analysis_ready: 'Analysis ready',
  index: 'Indexed',
};

export function processingStepLabel(step: ProcessingStep): string {
  return step.label || processingStepLabels[step.key] || step.key;
}

export const decisionStatusLabels: Record<DecisionStatus, string> = {
  proposed: 'Proposed',
  tentative: 'Tentative',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

export const decisionStatusNotes: Record<DecisionStatus, string> = {
  proposed: 'Raised in the meeting, not agreed yet.',
  tentative: 'Agreed in principle, still conditional.',
  confirmed: 'Agreed and treated as settled.',
  rejected: 'Explicitly decided against.',
  superseded: 'Replaced by a later decision.',
};

export const taskStatusLabels: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const questionStatusLabels: Record<Question['status'], string> = {
  open: 'Open',
  answered: 'Answered',
  deferred: 'Deferred',
};

export const ideaStatusLabels: Record<Idea['status'], string> = {
  new: 'New',
  considering: 'Considering',
  adopted: 'Adopted',
  dropped: 'Dropped',
};

export const commitmentStatusLabels: Record<Commitment['status'], string> = {
  pending: 'Pending',
  met: 'Met',
  missed: 'Missed',
};

export const factCategoryLabels: Record<FactCategory, string> = {
  metric: 'Metric',
  target: 'Target',
  budget: 'Budget',
  team: 'Team',
  tooling: 'Tooling',
  timeline: 'Timeline',
  constraint: 'Constraint',
  preference: 'Preference',
};

export const knowledgeKindLabels: Record<KnowledgeKind, string> = {
  decision: 'Decision',
  fact: 'Fact',
  topic: 'Topic',
  commitment: 'Commitment',
  question: 'Question',
};

export const participantKindLabels: Record<Participant['kind'], string> = {
  internal: 'Team',
  client: 'Client',
  external: 'External',
};

export const languageLabels: Record<LanguageCode, string> = {
  uz: 'Uzbek (Latin)',
  ru: 'Russian',
  en: 'English',
  tr: 'Turkish',
  kk: 'Kazakh',
};

/** Short form for dense rows, where three badges already compete for width. */
export const languageShortLabels: Record<LanguageCode, string> = {
  uz: 'uz',
  ru: 'ru',
  en: 'en',
  tr: 'tr',
  kk: 'kk',
};

export const meetingTabLabels: Record<MeetingTab, string> = {
  overview: 'Overview',
  topics: 'Topics',
  transcript: 'Transcript',
  decisions: 'Decisions',
  tasks: 'Tasks',
  facts: 'Facts',
  questions: 'Questions',
  ideas: 'Ideas',
};

export const companyTabLabels: Record<CompanyTab, string> = {
  overview: 'Overview',
  meetings: 'Meetings',
  projects: 'Projects',
  tasks: 'Tasks',
  decisions: 'Decisions',
  knowledge: 'Knowledge',
};

export const projectTabLabels: Record<ProjectTab, string> = {
  overview: 'Overview',
  meetings: 'Meetings',
  decisions: 'Decisions',
  tasks: 'Tasks',
  knowledge: 'Knowledge',
};

export const intelligenceSectionLabels = {
  goals: 'Goals',
  painPoints: 'Pain points',
  importantFacts: 'Important facts',
  decisionMakers: 'Decision makers',
  objections: 'Objections',
  commitments: 'Commitments',
} as const;
export type IntelligenceSectionKey = keyof typeof intelligenceSectionLabels;

/** Project lifecycle labels. Kept here so a page never maps an enum to English inline. */
export const projectStatusLabels: Record<Project['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  closed: 'Closed',
};

/**
 * Deadline copy for a task row. Overdue is stated as a fact with a count of days, never as a colour alone, so
 * the meaning survives print, colour-blind users and a screen reader.
 */
export function deadlineLabel(
  task: { dueDate: string | null; status: TaskStatus },
  todayIsoDate: string,
): { text: string; tone: 'overdue' | 'soon' | 'normal' | 'done' | 'none' } {
  if (task.status === 'completed') return { text: 'Completed', tone: 'done' };
  if (task.status === 'cancelled') return { text: 'Cancelled', tone: 'none' };
  if (!task.dueDate) return { text: 'No deadline', tone: 'none' };
  const days = daysBetween(todayIsoDate, task.dueDate);
  if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} overdue`, tone: 'overdue' };
  if (days === 0) return { text: 'Due today', tone: 'soon' };
  if (days <= 2) return { text: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: 'soon' };
  return { text: `Due ${formatShortDate(task.dueDate)}`, tone: 'normal' };
}

/** Whole-day difference between two `YYYY-MM-DD` strings, without touching the host timezone. */
export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  return toDayNumber(toIsoDate) - toDayNumber(fromIsoDate);
}

function toDayNumber(isoDate: string): number {
  const [year = 1970, month = 1, day = 1] = isoDate
    .split('-')
    .map((part) => Number.parseInt(part, 10));
  // Days since epoch computed from UTC parts only: no `Date.now()`, so results are reproducible in tests.
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function formatShortDate(isoDateTime: string): string {
  const [datePart] = isoDateTime.split('T');
  const [, month = '01', day = '01'] = (datePart ?? '').split('-');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const index = Math.max(0, Math.min(11, Number.parseInt(month, 10) - 1));
  return `${months[index]} ${Number.parseInt(day, 10)}`;
}

/** `Today` / `Yesterday` / `Sep 2` relative to an explicit "today", so rendering never depends on the clock. */
export function relativeDayLabel(isoDateTime: string, todayIsoDate: string): string {
  const [datePart] = isoDateTime.split('T');
  const day = daysBetween(todayIsoDate, datePart ?? todayIsoDate);
  if (day === 0) return 'Today';
  if (day === -1) return 'Yesterday';
  if (day === 1) return 'Tomorrow';
  return formatShortDate(datePart ?? isoDateTime);
}

export function clockTime(isoDateTime: string): string {
  const time = isoDateTime.split('T')[1];
  if (!time) return '';
  return time.slice(0, 5);
}
