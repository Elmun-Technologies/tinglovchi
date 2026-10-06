import type {
  AskAiAnswer,
  CompanyOverview,
  ProjectOverview,
  Company,
  CompanyIntelligence,
  Commitment,
  DashboardSnapshot,
  Decision,
  Fact,
  Idea,
  KnowledgeEntry,
  MeetingDetail,
  MeetingFilter,
  MeetingListRow,
  MeetingSummary,
  MeetingTranscript,
  MeetingType,
  Participant,
  ProcessingTimeline,
  Project,
  Question,
  SearchHit,
  SettingsSnapshot,
  Task,
  TaskFilter,
  KnowledgeFilter,
  VocabularyTerm,
  WorkspaceSummary,
  WorkspaceMember,
  SpeakerMapping,
  TranscriptWindow,
  TranscriptWindowRequest,
} from './domain';
import type {
  CompanyCreateInput,
  CompanyUpdateInput,
  MeetingDraftCreateInput,
  MeetingDraftUpdateInput,
  MeetingTypeCreateInput,
  MeetingTypeUpdateInput,
  MemberInviteInput,
  MemberRemoveInput,
  MemberRoleUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  SpeakerMappingCommit,
  VocabularyCreateInput,
  VocabularyUpdateInput,
  WorkspaceRenameInput,
  EntityListFilter,
} from './writes';

/**
 * The seam between product UI and data. Pages depend on these interfaces and on nothing else, so the demo
 * adapter, a Supabase/PostgREST adapter, and a future API adapter are interchangeable.
 *
 * Failure model: adapters **throw `RepositoryError`**. Pages catch it through `loadRepositories()` in the
 * web app and render the error state, so "could not load" is never displayed as "nothing exists".
 */

export const repositoryErrorCodeSchemaValues = [
  'not_configured',
  'unauthorized',
  'validation_failed',
  'not_found',
  'unsupported_in_demo',
  'data_inconsistent',
  'provider_unavailable',
] as const;

export type RepositoryErrorCode = (typeof repositoryErrorCodeSchemaValues)[number];

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly detail: string | undefined;
  readonly hint: string | undefined;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    options: { detail?: string; hint?: string } = {},
  ) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.detail = options.detail;
    this.hint = options.hint;
  }
}

/**
 * What the current adapter can actually do. The UI reads this instead of guessing, which is what keeps
 * demo mode from looking like a finished integration.
 */
/**
 * Every write the UI can attempt, named. The UI asks this instead of probing for the presence of a method,
 * because an adapter that cannot persist must be able to say so per action: a demo adapter may keep task
 * status in memory while refusing to invite a member, and a partially wired live adapter must never be
 * guessed at from the outside.
 */
export const writeActions = [
  'company.create',
  'company.update',
  'company.archive',
  'project.create',
  'project.update',
  'project.archive',
  'meeting.draft.create',
  'meeting.draft.update',
  'meeting.draft.delete',
  'meetingType.create',
  'meetingType.update',
  'vocabulary.create',
  'vocabulary.update',
  'vocabulary.delete',
  'workspace.rename',
  'workspace.members.invite',
  'workspace.members.role',
  'workspace.members.remove',
  'task.status',
  'transcript.speakerMapping',
  'demo.pipeline',
] as const;
export type WriteActionKey = (typeof writeActions)[number];

export type DataCapabilities = {
  mode: 'demo' | 'live';
  /** Where reads come from. `demo` is always labelled as such in the shell. */
  reads: 'demo' | 'live';
  /** Whether any create/update method is wired. When false, forms must not pretend to save. */
  writes: boolean;
  /** Per-action truth. `writes` is the umbrella; this is what each control consults. */
  actions: Record<WriteActionKey, boolean>;
  /** How a successful write is kept. `in_memory` means a restart loses it, and the UI must say so. */
  persistence: 'none' | 'in_memory' | 'workspace_database';
  /** Human explanation of write behaviour, shown next to every form that writes. */
  persistenceLabel: string;
  /** Processing states: `simulated` means only development fixtures advance them. */
  pipeline: 'none' | 'simulated' | 'live';
  /** Whether the fixtures deliberately move a meeting one step forward on demand (demo only). */
  demoStateTransitions: boolean;
  /** Audio playback availability for the web surface. `none` means the UI shows the contract, not a player. */
  playback: 'none' | 'local_desktop' | 'streamed';
  /** Short human explanation of where data lives, shown in the demo banner and settings. */
  provenanceLabel: string;
};

/**
 * The capability record for a build that cannot persist anything: every action off by construction, so adding
 * a new write to `writeActions` cannot accidentally inherit an enabled flag in live mode.
 */
export const disabledWriteActions = Object.fromEntries(
  writeActions.map((key) => [key, false]),
) as Record<WriteActionKey, boolean>;

/** The one way a page asks "may I show this control as enabled?". */
export function can(capabilities: DataCapabilities, action: WriteActionKey): boolean {
  return capabilities.writes && capabilities.actions[action];
}

export type MeetingScope = {
  workspaceId: string;
  companyId?: string | null;
  projectId?: string | null;
  /** A single meeting's tab reads this way; a company/project page leaves it out. */
  meetingId?: string | null;
};

export type WorkspaceRepository = {
  list(): Promise<WorkspaceSummary[]>;
  get(workspaceId: string): Promise<WorkspaceSummary>;
  /** Person id the current (possibly demo) user maps to, used by `Tasks → Mine`. */
  currentPersonId(workspaceId: string): Promise<string | null>;
  /**
   * Roster with role and invitation state. Members are people *plus* their access, which is why the roster is
   * a workspace read and not a settings echo: an invited person has no profile yet.
   */
  members(workspaceId: string): Promise<WorkspaceMember[]>;
  rename?(input: WorkspaceRenameInput): Promise<WorkspaceSummary>;
  inviteMember?(input: MemberInviteInput): Promise<WorkspaceMember>;
  /** Cancels an unanswered invitation or removes a member. Refusals carry the reason. */
  removeMember?(input: MemberRemoveInput): Promise<WorkspaceMember[]>;
  setMemberRole?(input: MemberRoleUpdateInput): Promise<WorkspaceMember[]>;
};

export type CompanyRepository = {
  /** Archived companies are excluded unless asked for; they never disappear from a lookup. */
  list(workspaceId: string, filter?: EntityListFilter): Promise<Company[]>;
  /** Row aggregates for the companies table, computed by the adapter rather than by the page. */
  overview(workspaceId: string, filter?: EntityListFilter): Promise<CompanyOverview[]>;
  get(companyId: string): Promise<Company>;
  intelligence(companyId: string): Promise<CompanyIntelligence>;
  create?(input: CompanyCreateInput): Promise<Company>;
  update?(companyId: string, input: CompanyUpdateInput): Promise<Company>;
  /**
   * Archive is the product's only "delete" for a company: meetings and decisions keep pointing at it, so a
   * hard delete would rewrite history. Absent means the adapter cannot archive, and the UI says so.
   */
  setArchived?(companyId: string, archived: boolean): Promise<Company>;
};

export type ProjectRepository = {
  list(workspaceId: string, filter?: EntityListFilter): Promise<Project[]>;
  overview(workspaceId: string, filter?: EntityListFilter): Promise<ProjectOverview[]>;
  get(projectId: string): Promise<Project>;
  create?(input: ProjectCreateInput): Promise<Project>;
  update?(projectId: string, input: ProjectUpdateInput): Promise<Project>;
  setArchived?(projectId: string, archived: boolean): Promise<Project>;
};

export type MeetingRepository = {
  list(workspaceId: string, filter?: MeetingFilter): Promise<MeetingListRow[]>;
  detail(meetingId: string): Promise<MeetingDetail>;
  participants(meetingId: string): Promise<Participant[]>;
  meetingTypes(workspaceId: string): Promise<MeetingType[]>;
  dashboard(workspaceId: string): Promise<DashboardSnapshot>;
  processing(meetingId: string): Promise<ProcessingTimeline>;
  decisionsFor(scope: MeetingScope): Promise<Decision[]>;
  factsFor(scope: MeetingScope): Promise<Fact[]>;
  questionsFor(scope: MeetingScope): Promise<Question[]>;
  ideasFor(scope: MeetingScope): Promise<Idea[]>;
  commitmentsFor(scope: MeetingScope): Promise<Commitment[]>;
  /**
   * A draft reserves a place for a meeting that has not been recorded. It never implies capture: the record
   * starts with no transcript, no recording and a `draft` state, and the desktop app is what later attaches
   * audio.
   */
  createDraft?(input: MeetingDraftCreateInput): Promise<MeetingSummary>;
  updateDraft?(meetingId: string, input: MeetingDraftUpdateInput): Promise<MeetingSummary>;
  /** Only an unrecorded draft can be deleted; anything with a transcript or records is refused, not erased. */
  deleteDraft?(meetingId: string): Promise<{ id: string }>;
  /** Demo-only affordance; guarded by `capabilities.demoStateTransitions`. */
  advanceDemoState?(meetingId: string): Promise<ProcessingTimeline>;
};

export type TranscriptRepository = {
  forMeeting(meetingId: string): Promise<MeetingTranscript>;
  /**
   * Paged, filtered read of a transcript. Every transcript the UI lists goes through this, so a 3-hour meeting
   * is never delivered whole, and search + paging are resolved by the adapter rather than re-implemented per
   * page. `focusSegmentId` lets an evidence link pick the window that contains the cited line.
   */
  window(request: TranscriptWindowRequest): Promise<TranscriptWindow>;
  segmentsForTopic(topicId: string): Promise<MeetingTranscript['segments']>;
  /** Returns the segment ids that exist so evidence can be resolved and highlighted. */
  segmentsByIds(meetingId: string, segmentIds: string[]): Promise<MeetingTranscript['segments']>;
  /**
   * Persists one diarization label → person assignment for one meeting and returns the resulting mappings.
   * Absent when the adapter cannot store it. There is no voice-identity API on purpose: nothing here may
   * imply that a speaker was recognized rather than declared.
   */
  confirmSpeakerMapping?(input: SpeakerMappingCommit): Promise<SpeakerMapping[]>;
};

export type TaskRepository = {
  list(workspaceId: string, filter?: TaskFilter): Promise<Task[]>;
  updateStatus?(taskId: string, status: Task['status']): Promise<Task>;
};

export type KnowledgeRepository = {
  entries(filter: KnowledgeFilter): Promise<KnowledgeEntry[]>;
};

export type AskAiRepository = {
  ask(workspaceId: string, question: string): Promise<AskAiAnswer>;
  suggestions(workspaceId: string): Promise<string[]>;
};

export type SearchRepository = {
  search(workspaceId: string, query: string): Promise<SearchHit[]>;
  /**
   * What to offer before anyone has typed: the most recently active records in this workspace. Derived from
   * data the workspace already holds — there is no client-side "history" claim in a build that stores nothing.
   */
  recent(workspaceId: string, limit?: number): Promise<SearchHit[]>;
};

export type SettingsRepository = {
  get(workspaceId: string): Promise<SettingsSnapshot>;
  vocabulary(workspaceId: string): Promise<VocabularyTerm[]>;
  /**
   * Absent when the adapter cannot persist a meeting type; the UI then says so instead of showing a form that
   * quietly does nothing. A created type appears in `meetings.meetingTypes` immediately, because both read the
   * same workspace record.
   */
  createMeetingType?(input: MeetingTypeCreateInput): Promise<MeetingType[]>;
  updateMeetingType?(meetingTypeId: string, input: MeetingTypeUpdateInput): Promise<MeetingType[]>;
  createVocabulary?(input: VocabularyCreateInput): Promise<VocabularyTerm[]>;
  updateVocabulary?(termId: string, input: VocabularyUpdateInput): Promise<VocabularyTerm[]>;
  deleteVocabulary?(termId: string): Promise<VocabularyTerm[]>;
};

/**
 * Probe used by the recording entry point. It must never claim a recording started: it only reports whether
 * a native recorder is reachable from this surface.
 */
export type DesktopBridgeRepository = {
  status(): Promise<{
    state: 'available' | 'unavailable' | 'not_validated' | 'unsupported_platform';
    detail: string;
    /** Deep-link placeholder contract for the desktop app; not a claim that it is handled. */
    deepLink: string;
  }>;
};

export type ProductRepositories = {
  capabilities: DataCapabilities;
  workspaces: WorkspaceRepository;
  companies: CompanyRepository;
  projects: ProjectRepository;
  meetings: MeetingRepository;
  transcripts: TranscriptRepository;
  tasks: TaskRepository;
  knowledge: KnowledgeRepository;
  askAi: AskAiRepository;
  search: SearchRepository;
  settings: SettingsRepository;
  desktop: DesktopBridgeRepository;
};

/** Convenience for pages: run several reads, keep typed errors, and never render a failure as emptiness. */
export async function loadAll<Results extends Record<string, Promise<unknown>>>(
  reads: Results,
): Promise<
  | { ok: true; data: { [Key in keyof Results]: Awaited<Results[Key]> } }
  | { ok: false; error: RepositoryError }
> {
  const keys = Object.keys(reads);
  try {
    const values = await Promise.all(
      keys.map((key) => (reads as Record<string, Promise<unknown>>)[key] as Promise<unknown>),
    );
    const data: Record<string, unknown> = {};
    keys.forEach((key, index) => {
      data[key] = values[index];
    });
    return { ok: true, data: data as { [Key in keyof Results]: Awaited<Results[Key]> } };
  } catch (cause) {
    if (cause instanceof RepositoryError) return { ok: false, error: cause };
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: new RepositoryError('provider_unavailable', 'Data could not be loaded.', {
        detail: message,
      }),
    };
  }
}

/** Normalizes `RepositoryError` from any thrown value, for the same single catch site. */
export function toRepositoryError(cause: unknown): RepositoryError {
  if (cause instanceof RepositoryError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RepositoryError('provider_unavailable', 'Data could not be loaded.', {
    detail: message,
  });
}
