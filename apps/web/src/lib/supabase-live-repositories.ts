import {
  RepositoryError,
  disabledWriteActions,
  filterKnowledge,
  filterMeetings,
  filterTasks,
  readTranscriptWindowRequest,
  routes,
  windowTranscript,
  type AskAiAnswer,
  type Company,
  type CompanyIntelligence,
  type Commitment,
  type DashboardSnapshot,
  type DataCapabilities,
  type Decision,
  type EvidenceRef,
  type Fact,
  type Idea,
  type KnowledgeEntry,
  type KnowledgeFilter,
  type LanguageCode,
  type MeetingDetail,
  type MeetingFilter,
  type MeetingListRow,
  type MeetingSummary,
  type MeetingTranscript,
  type MeetingType,
  type Participant,
  type ProcessingStep,
  type ProcessingTimeline,
  type ProductRepositories,
  type Project,
  type Question,
  type SearchHit,
  type SettingsSnapshot,
  type SpeakerMapping,
  type Task,
  type TranscriptSegment,
  type Topic,
  type WorkspaceMember,
  type WorkspaceSummary,
} from '@suhbat/product';

import 'server-only';

import { unavailableNamespace } from './repository-unavailable';

/**
 * Live repository adapter for the authenticated web dashboard.
 *
 * This is the web counterpart of `live-repositories.ts`: instead of a privileged PostgreSQL connection it
 * uses the signed-in user's Supabase session (public anon key + the user's JWT) through PostgREST, so every
 * read and write is authorized by the existing PostgreSQL RLS policies. It never uses the service-role key,
 * never opens a direct database connection, and never falls back to demo fixtures.
 *
 * Data flow: `getRepositories()` (live mode) → session context → these namespace implementations → PostgREST.
 * The repository interfaces in `@suhbat/product` are unchanged, so pages and components need no changes.
 */

/* ------------------------------------------------------------------ PostgREST seam */

export type PostgrestErrorLike = {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
} | null;

export type PostgrestRows<Row> = { data: Row[] | null; error: PostgrestErrorLike };
export type PostgrestRow<Row> = { data: Row | null; error: PostgrestErrorLike };

/**
 * The subset of the `@supabase/supabase-js` query builder this adapter uses.
 *
 * Declared structurally rather than importing the generated `Database` type so that (a) the adapter can be
 * exercised in unit tests with a small in-memory client and (b) Phase 6 tables that are missing from the
 * generated types file do not silently become `never`.
 */
export interface PostgrestQuery<Row> extends PromiseLike<PostgrestRows<Row>> {
  select(
    columns?: string,
    options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean },
  ): PostgrestQuery<Row>;
  eq(column: string, value: unknown): PostgrestQuery<Row>;
  neq(column: string, value: unknown): PostgrestQuery<Row>;
  in(column: string, values: readonly unknown[]): PostgrestQuery<Row>;
  is(column: string, value: boolean | null): PostgrestQuery<Row>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): PostgrestQuery<Row>;
  limit(count: number): PostgrestQuery<Row>;
  maybeSingle(): PromiseLike<PostgrestRow<Row>>;
}

/** A PostgREST client, e.g. the Supabase JS client bound to the user's session cookies. */
export interface PostgrestDataClient {
  from(table: string): PostgrestQuery<Record<string, unknown>>;
}

export type SupabaseLiveRepositoryContext = {
  /** Session-bound client. Must carry the signed-in user's access token, never a service-role key. */
  client: PostgrestDataClient;
  /** The authenticated user id (`auth.users.id`) the session resolved to. */
  userId: string;
  /** Signed-in email, for the shell's account label. Never used for authorization. */
  email?: string | null;
};

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(row: Row, key: string): boolean {
  return row[key] === true;
}

function toIso(value: unknown, fallback?: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback ?? new Date().toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return toIso(value);
}

function toTextArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** PostgREST/JWT failures are mapped onto the product's repository error codes; internals stay in `detail`. */
function mapPostgrestError(error: PostgrestErrorLike, method: string): RepositoryError {
  const code = error?.code ?? '';
  const message = error?.message ?? 'Unknown PostgREST error';
  if (code === 'PGRST301' || code === '42501' || code === '401') {
    return new RepositoryError('unauthorized', 'This signed-in user may not read this workspace.', {
      detail: `${method}: ${message}`,
    });
  }
  if (code === '42P01') {
    return new RepositoryError(
      'not_configured',
      'The live Supabase schema is missing a table this screen needs.',
      {
        detail: `${method}: ${message}`,
        hint: 'Apply the Supabase migrations to the project this deployment points at, then retry.',
      },
    );
  }
  return new RepositoryError('provider_unavailable', 'Live workspace data could not be loaded.', {
    detail: `${method}: ${message}`,
  });
}

async function readRows<RowType extends Row>(
  query: PostgrestQuery<Row>,
  method: string,
): Promise<RowType[]> {
  const { data, error } = await query;
  if (error) throw mapPostgrestError(error, method);
  return (data ?? []) as unknown as RowType[];
}

async function readMaybeRow<RowType extends Row>(
  query: PostgrestQuery<Row>,
  method: string,
): Promise<RowType | null> {
  const { data, error } = await query.maybeSingle();
  if (error) throw mapPostgrestError(error, method);
  return (data ?? null) as unknown as RowType | null;
}

/* ------------------------------------------------------------------ row shapes (subset used here) */

type WorkspaceRow = { id: string; name: string; slug: string; created_at: string } & Row;
type MembershipRow = { workspace_id: string; role: 'owner' | 'admin' | 'member' } & Row;
type MeetingTypeRow = {
  id: string;
  workspace_id: string;
  key: string;
  display_name: string;
  sort_order: number;
  template_key: string | null;
  is_active: boolean;
} & Row;
type CompanyRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
} & Row;
type ProjectRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
} & Row;
type MeetingRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  project_id: string | null;
  meeting_type_id: string;
  title: string;
  status: string;
  processing_status: string | null;
  started_at: string | null;
  created_at: string;
  created_by: string;
  timeline_duration_ms: number | null;
  active_capture_duration_ms: number | null;
  detected_languages: string[] | null;
  current_transcription_run_id: string | null;
  latest_transcription_run_id: string | null;
  current_analysis_run_id: string | null;
  latest_analysis_run_id: string | null;
  deleted_at: string | null;
  purge_status: string | null;
} & Row;
type ParticipantRow = {
  id: string;
  meeting_id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  is_external: boolean;
  sort_order: number;
} & Row;
type SpeakerRow = {
  id: string;
  meeting_id: string;
  transcription_run_id: string;
  provider_speaker_label: string;
  display_label: string;
  participant_id: string | null;
  segment_count: number;
} & Row;
type SegmentRow = {
  id: string;
  meeting_id: string;
  transcription_run_id: string;
  sequence_no: number;
  speaker_id: string;
  provider_speaker_label: string;
  start_ms: number;
  end_ms: number;
  text: string;
  language: string;
  confidence: number | null;
  word_count: number;
  alignment_status: string;
} & Row;
type RecordingRow = {
  id: string;
  meeting_id: string;
  status: string;
  session_id: string;
  canonical_duration_ms: number | null;
  active_capture_ms: number | null;
  created_at: string;
  deleted_at: string | null;
} & Row;
type EvidenceRow = {
  analysis_run_id: string;
  entity_type: string;
  entity_id: string;
  transcript_segment_id: string;
  evidence_order: number;
  start_ms: number;
  end_ms: number;
  speaker_display_label: string;
  excerpt: string;
  confidence: number | null;
} & Row;
type TopicRow = {
  id: string;
  meeting_id: string;
  analysis_run_id: string;
  sequence_no: number;
  title: string;
  summary: string;
  keywords: string[] | null;
  participant_ids: string[] | null;
  start_ms: number;
  end_ms: number;
  source_segment_ids: string[] | null;
} & Row;
type DecisionRow = {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  sequence_no: number;
  statement: string;
  rationale: string | null;
  status: string;
  owner_participant_id: string | null;
  owner_label: string | null;
  source_segment_ids: string[] | null;
  created_at: string;
} & Row;
type ActionItemRow = {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  decision_id: string | null;
  sequence_no: number;
  title: string;
  owner_participant_id: string | null;
  owner_label: string | null;
  due_hint: string | null;
  due_date: string | null;
  status: string;
  source_segment_ids: string[] | null;
  created_at: string;
} & Row;
type FactRow = {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  category: string;
  label: string;
  value_text: string;
  unit: string | null;
  speaker_participant_id: string | null;
  confidence: number | null;
  source_segment_ids: string[] | null;
  created_at: string;
} & Row;
type QuestionRow = {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  question: string;
  status: string;
  asked_by_participant_id: string | null;
  owner_participant_id: string | null;
  answer_summary: string | null;
  source_segment_ids: string[] | null;
  created_at: string;
} & Row;
type IdeaRow = {
  id: string;
  meeting_id: string;
  topic_id: string | null;
  idea: string;
  notes: string | null;
  status: string;
  proposed_by_participant_id: string | null;
  source_segment_ids: string[] | null;
  created_at: string;
} & Row;
type CommitmentRow = {
  id: string;
  meeting_id: string;
  commitment: string;
  owner_participant_id: string | null;
  due_label: string | null;
  status: string;
  source_segment_ids: string[] | null;
  created_at: string;
} & Row;
type SummaryRow = {
  meeting_id: string;
  headline: string | null;
  tl_dr: string;
  why_meeting_happened: string;
  major_discussions: unknown;
  unresolved_points: unknown;
} & Row;

/* ------------------------------------------------------------------ product mapping helpers */

const PIPELINE_STEPS = [
  'draft',
  'recording',
  'uploading',
  'preparing',
  'ready_for_transcription',
  'transcribing',
  'normalizing_transcript',
  'transcript_ready',
  'ready_for_analysis',
  'analyzing',
  'normalizing_analysis',
  'analysis_ready',
  'indexing',
  'ready',
] as const;

type PipelineStep = (typeof PIPELINE_STEPS)[number];
type FailureState = 'transcription_failed' | 'analysis_failed' | 'failed';
type CanonicalState = PipelineStep | FailureState;

const PIPELINE_STEP_LABELS: Record<PipelineStep, string> = {
  draft: 'Draft',
  recording: 'Recording',
  uploading: 'Uploading',
  preparing: 'Preparing audio',
  ready_for_transcription: 'Ready for transcription',
  transcribing: 'Transcribing',
  normalizing_transcript: 'Aligning transcript',
  transcript_ready: 'Transcript ready',
  ready_for_analysis: 'Ready for analysis',
  analyzing: 'Analyzing',
  normalizing_analysis: 'Normalizing analysis',
  analysis_ready: 'Analysis ready',
  indexing: 'Indexing knowledge',
  ready: 'Ready',
};

function isPipelineStep(value: string): value is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(value);
}

function isFailureState(value: string): value is FailureState {
  return (
    value === 'failed' || value === 'transcription_failed' || value === 'analysis_failed'
  );
}

/** `uploaded` is a database-only label between `uploading` and `preparing`; the product has no such step. */
function normalizeDatabaseState(value: string): CanonicalState | null {
  if (value === 'uploaded') return 'uploading';
  if (value === 'processing') return 'preparing';
  if (isPipelineStep(value)) return value;
  if (isFailureState(value)) return value;
  return null;
}

/**
 * Meeting lifecycle as the database records it, presented in the product's own vocabulary.
 *
 * The database keeps two columns (`status` and `processing_status`); the more advanced one wins, exactly as
 * the Phase 4 backbone derives it for the worker-side adapter. Unknown or empty values degrade to `draft`,
 * never to an invented success state.
 */
function productStateOf(meeting: MeetingRow): CanonicalState {
  const processing = (meeting.processing_status ?? '').trim();
  if (processing && processing !== 'idle') {
    const normalized = normalizeDatabaseState(processing);
    if (normalized) return normalized;
  }
  const status = (meeting.status ?? '').trim();
  const normalizedStatus = normalizeDatabaseState(status);
  if (normalizedStatus) return normalizedStatus;
  return 'draft';
}

function buildTimeline(meetingId: string, state: CanonicalState): ProcessingTimeline {
  const failure = isFailureState(state);
  const activeIndex = failure ? PIPELINE_STEPS.length - 1 : PIPELINE_STEPS.indexOf(state);
  const steps: ProcessingStep[] = PIPELINE_STEPS.filter((step) => step !== 'indexing').map((step) => {
    const index = PIPELINE_STEPS.indexOf(step);
    const stepState: ProcessingStep['state'] = failure
      ? index < activeIndex
        ? 'done'
        : 'pending'
      : index < activeIndex
        ? 'done'
        : index === activeIndex
          ? 'active'
          : 'pending';
    return { state: stepState, key: step, label: PIPELINE_STEP_LABELS[step] };
  });
  if (failure) {
    return {
      meetingId,
      state,
      steps: steps.map((step, index) =>
        index === steps.length - 1 && state === 'failed'
          ? { ...step, state: 'failed' as const, detail: 'Processing failed.' }
          : step,
      ),
    };
  }
  return { meetingId, state, steps };
}

function languageOf(value: string): LanguageCode {
  if (value === 'ru') return 'ru';
  if (value === 'en') return 'en';
  if (value === 'tr') return 'tr';
  if (value === 'kk') return 'kk';
  return 'uz';
}

function normalizeLanguages(values: readonly string[]): LanguageCode[] {
  const result = new Set<LanguageCode>();
  for (const value of values) {
    if (value === 'mixed') {
      result.add('uz');
      result.add('ru');
      result.add('en');
    } else if (value === 'unknown') {
      continue;
    } else {
      result.add(languageOf(value));
    }
  }
  return [...result];
}

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'S';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.slice(0, 3).toUpperCase();
}

function mapFactCategory(value: string): Fact['category'] {
  switch (value) {
    case 'budget':
    case 'commercial':
      return 'budget';
    case 'metric':
      return 'metric';
    case 'timeline':
      return 'timeline';
    case 'team':
      return 'team';
    case 'technical':
    case 'tooling':
      return 'tooling';
    case 'legal':
    case 'operations':
    case 'constraint':
      return 'constraint';
    case 'preference':
      return 'preference';
    case 'target':
    default:
      return 'target';
  }
}

function mapDecisionStatus(value: string): Decision['status'] {
  if (value === 'proposed' || value === 'tentative' || value === 'confirmed' || value === 'rejected') {
    return value;
  }
  if (value === 'superseded') return 'superseded';
  return 'proposed';
}

function mapTaskStatus(value: string): Task['status'] {
  if (value === 'in_progress' || value === 'blocked' || value === 'completed' || value === 'cancelled') {
    return value;
  }
  return 'open';
}

function mapIdeaStatus(value: string): Idea['status'] {
  if (value === 'accepted' || value === 'adopted') return 'adopted';
  if (value === 'rejected') return 'dropped';
  if (value === 'exploring' || value === 'parked' || value === 'considering') return 'considering';
  return 'new';
}

function mapCommitmentStatus(value: string): Commitment['status'] {
  if (value === 'kept' || value === 'met') return 'met';
  if (value === 'broken' || value === 'missed' || value === 'at_risk') return 'missed';
  return 'pending';
}

function mapQuestionStatus(value: string): Question['status'] {
  if (value === 'answered' || value === 'deferred') return value;
  return 'open';
}

/* ------------------------------------------------------------------ bundle assembly */

type MeetingBundle = {
  row: MeetingRow;
  meetingType: MeetingTypeRow | null;
  companyName: string | null;
  projectName: string | null;
  recording: RecordingRow | null;
  participants: Participant[];
  unmappedSpeakers: string[];
  speakerMappings: SpeakerMapping[];
  segments: TranscriptSegment[];
  topics: Topic[];
  summaryRow: SummaryRow | null;
  summary: MeetingSummary;
  detail: MeetingDetail;
  transcript: MeetingTranscript;
  decisions: Decision[];
  tasks: Task[];
  facts: Fact[];
  questions: Question[];
  ideas: Idea[];
  commitments: Commitment[];
  objectionTexts: { text: string; personId: string | null; evidence: EvidenceRef | null }[];
  riskTexts: { text: string; personId: string | null; evidence: EvidenceRef | null }[];
};

/**
 * Builds the session-scoped live repositories.
 *
 * `input` is either an already resolved session context (tests, callers that already have a user) or a
 * resolver that reads the signed-in Supabase session for the current request. Resolution is lazy so the
 * demo code path and pages that never touch live data pay nothing, and memoized so one request builds the
 * adapter at most once.
 */
export function createSupabaseLiveRepositories(
  input: SupabaseLiveRepositoryContext | (() => Promise<SupabaseLiveRepositoryContext>),
): ProductRepositories {
  const resolveContext = typeof input === 'function' ? input : async () => input;
  let built: ProductRepositories | null = null;
  const ensureBuilt = async (): Promise<ProductRepositories> => {
    if (built) return built;
    let resolved: SupabaseLiveRepositoryContext;
    try {
      resolved = await resolveContext();
    } catch (cause) {
      // A missing session, an unreadable cookie store or an unconfigured deployment all fail here. They are
      // reported as repository errors so pages render a state instead of a generic server error.
      if (cause instanceof RepositoryError) throw cause;
      throw new RepositoryError(
        'provider_unavailable',
        'The signed-in Supabase session could not be read for this request.',
        { detail: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    built = buildSupabaseLiveRepositories(resolved);
    return built;
  };

  const namespaces = new Map<string, object>();
  return new Proxy({ capabilities: sessionLiveCapabilities } as ProductRepositories, {
    get(target, property) {
      if (property === 'capabilities') return target.capabilities;
      if (typeof property !== 'string') return undefined;
      const existing = namespaces.get(property);
      if (existing) return existing;
      const created = new Proxy(
        {},
        {
          get(_namespaceTarget, method) {
            if (typeof method !== 'string') return undefined;
            return async (...args: unknown[]) => {
              const repositories = await ensureBuilt();
              const namespace = (repositories as unknown as Record<string, Record<string, unknown>>)[
                property
              ];
              const fn = namespace?.[method];
              if (typeof fn !== 'function') {
                throw new RepositoryError(
                  'provider_unavailable',
                  'This live repository operation is not available.',
                  { detail: `${property}.${method}` },
                );
              }
              return (fn as (...callArgs: unknown[]) => Promise<unknown>).apply(namespace, args);
            };
          },
        },
      );
      namespaces.set(property, created);
      return created;
    },
  });
}

/** Capabilities that hold before the session is resolved: reads are live, writes stay off. */
export const sessionLiveCapabilities: DataCapabilities = {
  mode: 'live',
  reads: 'live',
  writes: false,
  pipeline: 'live',
  demoStateTransitions: false,
  playback: 'none',
  actions: disabledWriteActions,
  persistence: 'workspace_database',
  persistenceLabel:
    'Workspace data is read from PostgreSQL through the signed-in user’s Supabase session (RLS enforced).',
  provenanceLabel:
    'Live workspace database — meeting, transcript and intelligence records come from authorized backend rows.',
};

function buildSupabaseLiveRepositories(context: SupabaseLiveRepositoryContext): ProductRepositories {
  const { client, userId } = context;

  const capabilities = sessionLiveCapabilities;

  /* ---------------- workspace access ---------------- */

  async function membershipOf(workspaceId: string) {
    return readMaybeRow<MembershipRow>(
      client
        .from('workspace_members')
        .select('workspace_id, role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('membership_status', 'active'),
      'workspaces.access',
    );
  }

  /** Fails closed with a typed error instead of letting a cross-workspace read reach the page. */
  async function requireMembership(workspaceId: string): Promise<MembershipRow> {
    const membership = await membershipOf(workspaceId);
    if (!membership) {
      throw new RepositoryError(
        'not_found',
        'This workspace does not exist, or this account is not an active member of it.',
        { detail: workspaceId },
      );
    }
    return membership;
  }

  async function workspaceRowsForUser(): Promise<
    { workspace: WorkspaceRow; membership: MembershipRow }[]
  > {
    const memberships = await readRows<MembershipRow>(
      client
        .from('workspace_members')
        .select('workspace_id, role')
        .eq('user_id', userId)
        .eq('membership_status', 'active'),
      'workspaces.list',
    );
    if (memberships.length === 0) return [];
    const workspaces = await readRows<WorkspaceRow>(
      client
        .from('workspaces')
        .select('id, name, slug, created_at')
        .in(
          'id',
          memberships.map((membership) => membership.workspace_id),
        ),
      'workspaces.list',
    );
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    return memberships
      .map((membership) => {
        const workspace = byId.get(membership.workspace_id);
        return workspace ? { workspace, membership } : null;
      })
      .filter((entry): entry is { workspace: WorkspaceRow; membership: MembershipRow } =>
        Boolean(entry),
      );
  }

  /* ---------------- meeting bundles ---------------- */

  async function loadBundles(
    workspaceId: string,
    options: { meetingId?: string; requireAccess?: boolean } = {},
  ): Promise<MeetingBundle[]> {
    if (options.requireAccess !== false) {
      await requireMembership(workspaceId);
    }

    const meetingQuery = client
      .from('meetings')
      .select(
        'id, workspace_id, company_id, project_id, meeting_type_id, title, status, processing_status, started_at, created_at, created_by, timeline_duration_ms, active_capture_duration_ms, detected_languages, current_transcription_run_id, latest_transcription_run_id, current_analysis_run_id, latest_analysis_run_id, deleted_at, purge_status',
      )
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    const meetingRows = await readRows<MeetingRow>(
      options.meetingId ? meetingQuery.eq('id', options.meetingId) : meetingQuery,
      options.meetingId ? 'meetings.detail' : 'meetings.list',
    );
    if (meetingRows.length === 0) return [];

    const meetingIds = meetingRows.map((meeting) => meeting.id);
    const transcriptionRunIds = [
      ...new Set(
        meetingRows
          .map((meeting) => meeting.current_transcription_run_id ?? meeting.latest_transcription_run_id)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const analysisRunIds = [
      ...new Set(
        meetingRows
          .map((meeting) => meeting.current_analysis_run_id ?? meeting.latest_analysis_run_id)
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    const [
      meetingTypes,
      companies,
      projects,
      recordings,
      participantRows,
      speakerRows,
      segmentRows,
      summaryRows,
      topicRows,
      decisionRows,
      actionRows,
      factRows,
      questionRows,
      ideaRows,
      commitmentRows,
      evidenceRows,
    ] = await Promise.all([
      readRows<MeetingTypeRow>(
        client.from('meeting_types').select('*').eq('workspace_id', workspaceId),
        'meetings.meetingTypes',
      ),
      readRows<CompanyRow>(
        client.from('companies').select('id, name').eq('workspace_id', workspaceId),
        'companies.list',
      ),
      readRows<ProjectRow>(
        client.from('projects').select('id, name').eq('workspace_id', workspaceId),
        'projects.list',
      ),
      readRows<RecordingRow>(
        client
          .from('recordings')
          .select('id, meeting_id, status, session_id, canonical_duration_ms, active_capture_ms, created_at, deleted_at')
          .eq('workspace_id', workspaceId)
          .in('meeting_id', meetingIds)
          .is('deleted_at', null)
          .order('created_at', { ascending: false }),
        'meetings.detail',
      ),
      readRows<ParticipantRow>(
        client
          .from('meeting_participants')
          .select('id, meeting_id, user_id, display_name, email, is_external, sort_order')
          .eq('workspace_id', workspaceId)
          .in('meeting_id', meetingIds)
          .order('sort_order', { ascending: true }),
        'meetings.participants',
      ),
      transcriptionRunIds.length > 0
        ? readRows<SpeakerRow>(
            client
              .from('meeting_speakers')
              .select(
                'id, meeting_id, transcription_run_id, provider_speaker_label, display_label, participant_id, segment_count',
              )
              .eq('workspace_id', workspaceId)
              .in('transcription_run_id', transcriptionRunIds),
            'transcripts.forMeeting',
          )
        : Promise.resolve([] as SpeakerRow[]),
      transcriptionRunIds.length > 0
        ? readRows<SegmentRow>(
            client
              .from('transcript_segments')
              .select(
                'id, meeting_id, transcription_run_id, sequence_no, speaker_id, provider_speaker_label, start_ms, end_ms, text, language, confidence, word_count, alignment_status',
              )
              .eq('workspace_id', workspaceId)
              .in('transcription_run_id', transcriptionRunIds)
              .order('sequence_no', { ascending: true }),
            'transcripts.forMeeting',
          )
        : Promise.resolve([] as SegmentRow[]),
      analysisRunIds.length > 0
        ? readRows<SummaryRow>(
            client
              .from('meeting_summaries')
              .select(
                'meeting_id, headline, tl_dr, why_meeting_happened, major_discussions, unresolved_points',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds),
            'meetings.detail',
          )
        : Promise.resolve([] as SummaryRow[]),
      analysisRunIds.length > 0
        ? readRows<TopicRow>(
            client
              .from('meeting_topics')
              .select(
                'id, meeting_id, analysis_run_id, sequence_no, title, summary, keywords, participant_ids, start_ms, end_ms, source_segment_ids',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'transcripts.forMeeting',
          )
        : Promise.resolve([] as TopicRow[]),
      analysisRunIds.length > 0
        ? readRows<DecisionRow>(
            client
              .from('meeting_decisions')
              .select(
                'id, meeting_id, topic_id, sequence_no, statement, rationale, status, owner_participant_id, owner_label, source_segment_ids, created_at',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'meetings.decisionsFor',
          )
        : Promise.resolve([] as DecisionRow[]),
      analysisRunIds.length > 0
        ? readRows<ActionItemRow>(
            client
              .from('meeting_action_items')
              .select(
                'id, meeting_id, topic_id, decision_id, sequence_no, title, owner_participant_id, owner_label, due_hint, due_date, status, source_segment_ids, created_at',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'tasks.list',
          )
        : Promise.resolve([] as ActionItemRow[]),
      analysisRunIds.length > 0
        ? readRows<FactRow>(
            client
              .from('meeting_facts')
              .select(
                'id, meeting_id, topic_id, category, label, value_text, unit, speaker_participant_id, confidence, source_segment_ids, created_at',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'meetings.factsFor',
          )
        : Promise.resolve([] as FactRow[]),
      analysisRunIds.length > 0
        ? readRows<QuestionRow>(
            client
              .from('meeting_questions')
              .select(
                'id, meeting_id, topic_id, question, status, asked_by_participant_id, owner_participant_id, answer_summary, source_segment_ids, created_at',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'meetings.questionsFor',
          )
        : Promise.resolve([] as QuestionRow[]),
      analysisRunIds.length > 0
        ? readRows<IdeaRow>(
            client
              .from('meeting_ideas')
              .select(
                'id, meeting_id, topic_id, idea, notes, status, proposed_by_participant_id, source_segment_ids, created_at',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'meetings.ideasFor',
          )
        : Promise.resolve([] as IdeaRow[]),
      analysisRunIds.length > 0
        ? readRows<CommitmentRow>(
            client
              .from('meeting_commitments')
              .select(
                'id, meeting_id, commitment, owner_participant_id, due_label, status, source_segment_ids, created_at',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('sequence_no', { ascending: true }),
            'meetings.commitmentsFor',
          )
        : Promise.resolve([] as CommitmentRow[]),
      analysisRunIds.length > 0
        ? readRows<EvidenceRow>(
            client
              .from('intelligence_evidence')
              .select(
                'analysis_run_id, entity_type, entity_id, transcript_segment_id, evidence_order, start_ms, end_ms, speaker_display_label, excerpt, confidence',
              )
              .eq('workspace_id', workspaceId)
              .in('analysis_run_id', analysisRunIds)
              .order('evidence_order', { ascending: true }),
            'meetings.evidence',
          )
        : Promise.resolve([] as EvidenceRow[]),
    ]);

    const meetingTypeById = new Map(meetingTypes.map((type) => [type.id, type]));
    const companyNameById = new Map(companies.map((company) => [company.id, company.name]));
    const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
    const recordingByMeetingId = new Map<string, RecordingRow>();
    for (const recording of recordings) {
      if (!recordingByMeetingId.has(recording.meeting_id)) {
        recordingByMeetingId.set(recording.meeting_id, recording);
      }
    }

    const participantsByMeeting = new Map<string, ParticipantRow[]>();
    for (const participant of participantRows) {
      const list = participantsByMeeting.get(participant.meeting_id) ?? [];
      list.push(participant);
      participantsByMeeting.set(participant.meeting_id, list);
    }
    const speakersByMeeting = new Map<string, SpeakerRow[]>();
    for (const speaker of speakerRows) {
      const list = speakersByMeeting.get(speaker.meeting_id) ?? [];
      list.push(speaker);
      speakersByMeeting.set(speaker.meeting_id, list);
    }
    const segmentsByMeeting = new Map<string, SegmentRow[]>();
    for (const segment of segmentRows) {
      if (segment.alignment_status === 'quarantined') continue;
      const list = segmentsByMeeting.get(segment.meeting_id) ?? [];
      list.push(segment);
      segmentsByMeeting.set(segment.meeting_id, list);
    }
    const summaryByMeeting = new Map<string, SummaryRow>();
    for (const summary of summaryRows) summaryByMeeting.set(summary.meeting_id, summary);

    // `intelligence_evidence` is keyed by (entity_type, entity_id): group so one read serves every card.
    const evidenceByEntity = new Map<string, EvidenceRow[]>();
    for (const evidence of evidenceRows) {
      const key = `${evidence.entity_type}:${evidence.entity_id}`;
      const list = evidenceByEntity.get(key) ?? [];
      list.push(evidence);
      evidenceByEntity.set(key, list);
    }

    const bundles: MeetingBundle[] = [];

    for (const meeting of meetingRows) {
      const meetingParticipants = participantsByMeeting.get(meeting.id) ?? [];
      const meetingSpeakers = speakersByMeeting.get(meeting.id) ?? [];
      const meetingSegments = (segmentsByMeeting.get(meeting.id) ?? [])
        .slice()
        .sort((left, right) => left.sequence_no - right.sequence_no);
      const meetingType = meetingTypeById.get(meeting.meeting_type_id) ?? null;
      const recording = recordingByMeetingId.get(meeting.id) ?? null;
      const occurredAt = toIso(meeting.started_at ?? meeting.created_at);

      const participantProductIdByRowId = new Map<string, string>();
      for (const participant of meetingParticipants) {
        participantProductIdByRowId.set(participant.id, participant.id);
      }

      const participants: Participant[] = meetingParticipants.map((participant) => {
        const speaker = meetingSpeakers.find((item) => item.participant_id === participant.id);
        return {
          personId: participant.id,
          name: participant.display_name,
          initials: computeInitials(participant.display_name),
          kind: participant.is_external ? 'external' : 'internal',
          ...(speaker ? { speakerLabel: speaker.provider_speaker_label } : {}),
          mapped: true,
          spokeInMeeting: (speaker?.segment_count ?? 0) > 0,
        };
      });

      const speakerMappings: SpeakerMapping[] = meetingSpeakers.map((speaker) => ({
        label: speaker.provider_speaker_label,
        personId: speaker.participant_id,
        confirmed: speaker.participant_id !== null,
        segmentCount: speaker.segment_count,
      }));
      const unmappedSpeakers = meetingSpeakers
        .filter((speaker) => speaker.participant_id === null)
        .map((speaker) => speaker.display_label || speaker.provider_speaker_label);

      const speakerById = new Map(meetingSpeakers.map((speaker) => [speaker.id, speaker]));
      const speakerPersonBySegmentId = new Map<string, string>();
      const segments: TranscriptSegment[] = meetingSegments.map((segment) => {
        const speaker = speakerById.get(segment.speaker_id);
        const participantId = speaker?.participant_id ?? null;
        if (participantId) speakerPersonBySegmentId.set(segment.id, participantId);
        return {
          id: segment.id,
          meetingId: segment.meeting_id,
          index: segment.sequence_no,
          speakerPersonId: participantId,
          speakerLabel: speaker?.display_label || segment.provider_speaker_label,
          startMs: segment.start_ms,
          endMs: segment.end_ms,
          text: segment.text,
          language: languageOf(segment.language),
          topicId: null,
          ...(segment.confidence !== null ? { confidence: segment.confidence } : {}),
        };
      });

      function evidenceRefs(entityType: string, entityId: string): EvidenceRef[] {
        const rows = evidenceByEntity.get(`${entityType}:${entityId}`) ?? [];
        return rows.map((row) => ({
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          occurredAt,
          startMs: row.start_ms,
          endMs: row.end_ms,
          segmentIds: [row.transcript_segment_id],
          speakerPersonIds: speakerPersonBySegmentId.has(row.transcript_segment_id)
            ? [speakerPersonBySegmentId.get(row.transcript_segment_id)!]
            : [],
          quote: row.excerpt || undefined,
        }));
      }

      function participantText(value: string | null): string | null {
        if (!value) return null;
        return participantProductIdByRowId.get(value) ?? null;
      }

      const meetingId = meeting.id;

      const decisions: Decision[] = decisionRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => {
          const evidence = evidenceRefs('decision', row.id);
          return {
            id: row.id,
            workspaceId,
            meetingId,
            companyId: meeting.company_id,
            projectId: meeting.project_id,
            topicId: row.topic_id,
            title: row.statement,
            description: row.rationale ?? row.statement,
            status: mapDecisionStatus(row.status),
            participantPersonIds: [
              ...new Set(
                [
                  participantText(row.owner_participant_id),
                  ...evidence.flatMap((ref) => ref.speakerPersonIds),
                ].filter((value): value is string => Boolean(value)),
              ),
            ],
            evidence,
            decidedOn: toIso(row.created_at).slice(0, 10),
            supersededByDecisionId: null,
            hasFollowUpTasks: actionRows.some(
              (action) => action.meeting_id === meetingId && action.decision_id === row.id,
            ),
          };
        });

      const tasks: Task[] = actionRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => ({
          id: row.id,
          workspaceId,
          meetingId,
          companyId: meeting.company_id,
          projectId: meeting.project_id,
          topicId: row.topic_id,
          title: row.title,
          ...(row.due_hint ? { detail: `Due hint: ${row.due_hint}` } : {}),
          ownerPersonId: participantText(row.owner_participant_id),
          ownerLabel: row.owner_label ?? 'Unassigned',
          dueDate: row.due_date,
          status: mapTaskStatus(row.status),
          priority: 'normal',
          evidence: evidenceRefs('action_item', row.id),
          createdAt: toIso(row.created_at),
        }));

      const facts: Fact[] = factRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => ({
          id: row.id,
          workspaceId,
          meetingId,
          companyId: meeting.company_id,
          projectId: meeting.project_id,
          category: mapFactCategory(row.category),
          label: row.label,
          value: row.value_text,
          ...(row.unit ? { unit: row.unit } : {}),
          speakerPersonId: participantText(row.speaker_participant_id),
          evidence: evidenceRefs('fact', row.id),
          ...(row.confidence !== null ? { confidence: row.confidence } : {}),
          capturedAt: toIso(row.created_at),
        }));

      const questions: Question[] = questionRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => {
          const evidence = evidenceRefs('question', row.id);
          const status = mapQuestionStatus(row.status);
          return {
            id: row.id,
            workspaceId,
            meetingId,
            companyId: meeting.company_id,
            projectId: meeting.project_id,
            topicId: row.topic_id,
            text: row.question,
            askedByPersonId: participantText(row.asked_by_participant_id),
            status,
            raisedOn: toIso(row.created_at).slice(0, 10),
            ...(status === 'answered' && row.answer_summary
              ? {
                  resolution: {
                    answer: row.answer_summary,
                    answeredOn: toIso(row.created_at).slice(0, 10),
                    answeredByPersonId: participantText(row.owner_participant_id),
                    evidence,
                  },
                }
              : {}),
            evidence,
          };
        });

      const ideas: Idea[] = ideaRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => {
          const evidence = evidenceRefs('idea', row.id);
          return {
            id: row.id,
            workspaceId,
            meetingId,
            companyId: meeting.company_id,
            projectId: meeting.project_id,
            topicId: row.topic_id,
            text: row.notes ? `${row.idea} — ${row.notes}` : row.idea,
            proposedByPersonId:
              participantText(row.proposed_by_participant_id) ??
              evidence[0]?.speakerPersonIds[0] ??
              meeting.created_by,
            status: mapIdeaStatus(row.status),
            raisedOn: toIso(row.created_at).slice(0, 10),
            evidence,
          };
        });

      const commitments: Commitment[] = commitmentRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => {
          const evidence = evidenceRefs('commitment', row.id);
          return {
            id: row.id,
            workspaceId,
            meetingId,
            companyId: meeting.company_id,
            text: row.due_label ? `${row.commitment} (${row.due_label})` : row.commitment,
            byPersonId:
              participantText(row.owner_participant_id) ??
              evidence[0]?.speakerPersonIds[0] ??
              meeting.created_by,
            dueDate: null,
            status: mapCommitmentStatus(row.status),
            evidence,
          };
        });

      const topics: Topic[] = topicRows
        .filter((row) => row.meeting_id === meetingId)
        .map((row) => ({
          id: row.id,
          workspaceId,
          meetingId,
          parentId: null,
          title: row.title,
          summary: row.summary,
          keywords: toTextArray(row.keywords),
          startMs: row.start_ms,
          endMs: row.end_ms,
          participantPersonIds: toTextArray(row.participant_ids),
          segmentIds: toTextArray(row.source_segment_ids),
          decisionIds: decisions.filter((decision) => decision.topicId === row.id).map((d) => d.id),
          taskIds: tasks.filter((task) => task.topicId === row.id).map((task) => task.id),
          questionIds: questions
            .filter((question) => question.topicId === row.id)
            .map((question) => question.id),
          ideaIds: ideas.filter((idea) => idea.topicId === row.id).map((idea) => idea.id),
        }));

      const topicIdBySegmentId = new Map<string, string>();
      for (const topic of topics) {
        for (const segmentId of topic.segmentIds) {
          if (!topicIdBySegmentId.has(segmentId)) topicIdBySegmentId.set(segmentId, topic.id);
        }
      }
      for (const segment of segments) {
        segment.topicId = topicIdBySegmentId.get(segment.id) ?? null;
      }

      const summaryRow = summaryByMeeting.get(meetingId) ?? null;
      const state = productStateOf(meeting);
      const processing = buildTimeline(meetingId, state);
      const durationMs =
        meeting.timeline_duration_ms ??
        recording?.canonical_duration_ms ??
        (segments.length > 0 ? segments[segments.length - 1]!.endMs : 0);
      const capturedMs = meeting.active_capture_duration_ms ?? recording?.active_capture_ms ?? null;
      const languages = normalizeLanguages(toTextArray(meeting.detected_languages));
      const wordCount = meetingSegments.reduce((sum, segment) => sum + segment.word_count, 0);
      const recordingAvailable = Boolean(recording && recording.status === 'finalized');

      const summary: MeetingSummary = {
        id: meetingId,
        workspaceId,
        title: meeting.title,
        companyId: meeting.company_id,
        ...(meeting.company_id && companyNameById.get(meeting.company_id)
          ? { companyName: companyNameById.get(meeting.company_id)! }
          : {}),
        projectId: meeting.project_id,
        ...(meeting.project_id && projectNameById.get(meeting.project_id)
          ? { projectName: projectNameById.get(meeting.project_id)! }
          : {}),
        meetingTypeId: meeting.meeting_type_id,
        meetingTypeKey: meetingType?.key ?? 'meeting',
        meetingTypeLabel: meetingType?.display_name ?? 'Meeting',
        occurredAt,
        durationMs,
        capturedMs,
        state,
        languages,
        participants,
        origin: recording ? 'desktop' : 'draft',
        recordingAvailable,
        counts: {
          topics: topics.length,
          decisions: decisions.length,
          tasks: tasks.length,
          facts: facts.length,
          questions: questions.length,
          ideas: ideas.length,
          segments: segments.length,
        },
      };

      const summaryBullets: string[] = [];
      if (summaryRow) {
        const rawBullets = [
          summaryRow.tl_dr,
          summaryRow.why_meeting_happened,
          ...toTextArray(summaryRow.major_discussions),
          ...toTextArray(summaryRow.unresolved_points),
        ];
        for (const bullet of rawBullets) {
          const trimmed = (bullet ?? '').trim();
          if (trimmed.length > 0 && !summaryBullets.includes(trimmed)) summaryBullets.push(trimmed);
        }
      }

      const openTasks = tasks.filter(
        (task) => task.status === 'open' || task.status === 'in_progress',
      ).length;

      const detail: MeetingDetail = {
        ...summary,
        executiveSummary: summaryBullets,
        ...(summaryRow?.headline ? { keyOutcome: summaryRow.headline } : {}),
        unmappedSpeakers,
        recording: {
          available: recordingAvailable,
          source: recordingAvailable ? 'object_storage' : 'none',
          note: recording
            ? `Recording ${recording.session_id} is ${recording.status}.`
            : 'No recording attached to this meeting.',
          ...(recording ? { manifestSessionId: recording.session_id } : {}),
        },
        stats: {
          speakingParticipants: meetingSpeakers.filter((speaker) => speaker.segment_count > 0).length,
          topics: topics.length,
          decisions: decisions.length,
          confirmedDecisions: decisions.filter((decision) => decision.status === 'confirmed').length,
          tasks: tasks.length,
          openTasks,
          questions: questions.length,
          openQuestions: questions.filter((question) => question.status === 'open').length,
          facts: facts.length,
          ideas: ideas.length,
          words: wordCount,
        },
        processing,
      };

      const transcript: MeetingTranscript = {
        meetingId,
        segments,
        topics,
        participants,
        speakerMappings,
        totalMs: durationMs,
        wordCount,
      };

      bundles.push({
        row: meeting,
        meetingType,
        companyName: meeting.company_id ? (companyNameById.get(meeting.company_id) ?? null) : null,
        projectName: meeting.project_id ? (projectNameById.get(meeting.project_id) ?? null) : null,
        recording,
        participants,
        unmappedSpeakers,
        speakerMappings,
        segments,
        topics,
        summaryRow,
        summary,
        detail,
        transcript,
        decisions,
        tasks,
        facts,
        questions,
        ideas,
        commitments,
        objectionTexts: [],
        riskTexts: [],
      });
    }

    return bundles;
  }

  function rowOf(bundle: MeetingBundle): MeetingListRow {
    const todayIsoDate = new Date().toISOString().slice(0, 10);
    const overdueTaskCount = bundle.tasks.filter(
      (task) =>
        (task.status === 'open' || task.status === 'in_progress') &&
        Boolean(task.dueDate) &&
        task.dueDate! < todayIsoDate,
    ).length;
    return {
      meeting: bundle.summary,
      openTaskCount: bundle.tasks.filter(
        (task) => task.status === 'open' || task.status === 'in_progress',
      ).length,
      overdueTaskCount,
    };
  }

  /* ---------------- namespaces ---------------- */

  const workspacesRepo: ProductRepositories['workspaces'] = {
    async list(): Promise<WorkspaceSummary[]> {
      const entries = await workspaceRowsForUser();
      if (entries.length === 0) return [];
      return entries
        .sort((left, right) => left.workspace.created_at.localeCompare(right.workspace.created_at))
        .map(({ workspace, membership }) => ({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          role: membership.role,
          // RLS exposes only the caller's own membership rows, so this is the roster this session can
          // see — never an invented number.
          memberCount: 1,
          demo: false,
        }));
    },
    async get(workspaceId: string): Promise<WorkspaceSummary> {
      const list = await workspacesRepo.list();
      const found = list.find((workspace) => workspace.id === workspaceId);
      if (!found) {
        throw new RepositoryError(
          'not_found',
          'This workspace does not exist, or this account is not an active member of it.',
          { detail: workspaceId },
        );
      }
      return found;
    },
    async currentPersonId(workspaceId: string): Promise<string | null> {
      await requireMembership(workspaceId);
      return userId;
    },
    async members(workspaceId: string): Promise<WorkspaceMember[]> {
      const membership = await requireMembership(workspaceId);
      const [profile, participantRows] = await Promise.all([
        readMaybeRow<Row>(
          client.from('profiles').select('id, display_name').eq('id', userId),
          'workspaces.members',
        ),
        readRows<ParticipantRow>(
          client
            .from('meeting_participants')
            .select('id, meeting_id, user_id, display_name, email, is_external, sort_order')
            .eq('workspace_id', workspaceId),
          'workspaces.members',
        ),
      ]);

      const members = new Map<string, WorkspaceMember>();
      members.set(userId, {
        personId: userId,
        name: (profile ? textOrNull(profile, 'display_name') : null) ?? 'Workspace Member',
        role: membership.role,
        status: 'active',
        openTaskCount: 0,
        meetingCount: 0,
      });
      for (const participant of participantRows) {
        if (members.has(participant.id)) continue;
        members.set(participant.id, {
          personId: participant.id,
          name: participant.display_name,
          ...(participant.email ? { email: participant.email } : {}),
          role: 'member',
          status: 'active',
          openTaskCount: 0,
          meetingCount: 1,
        });
      }
      return [...members.values()];
    },
  };

  const companiesRepo: ProductRepositories['companies'] = {
    async list(workspaceId, filter): Promise<Company[]> {
      await requireMembership(workspaceId);
      const includeArchived = filter?.includeArchived ?? false;
      const rows = await readRows<CompanyRow>(
        client
          .from('companies')
          .select('id, workspace_id, name, description, archived_at, created_at')
          .eq('workspace_id', workspaceId)
          .order('name', { ascending: true }),
        'companies.list',
      );
      const needle = (filter?.query ?? '').trim().toLowerCase();
      return rows
        .filter((row) => includeArchived || row.archived_at === null)
        .filter(
          (row) =>
            needle.length === 0 ||
            row.name.toLowerCase().includes(needle) ||
            (row.description ?? '').toLowerCase().includes(needle),
        )
        .map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          status: row.archived_at ? 'archived' : 'active',
          createdAt: toIso(row.created_at),
        }));
    },
    async get(companyId: string): Promise<Company> {
      const row = await readMaybeRow<CompanyRow>(
        client
          .from('companies')
          .select('id, workspace_id, name, description, archived_at, created_at')
          .eq('id', companyId),
        'companies.get',
      );
      if (!row) throw new RepositoryError('not_found', 'Company was not found.');
      await requireMembership(row.workspace_id);
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        status: row.archived_at ? 'archived' : 'active',
        createdAt: toIso(row.created_at),
      };
    },
    async overview(workspaceId, filter) {
      const [companies, projects, bundles] = await Promise.all([
        companiesRepo.list(workspaceId, filter),
        projectsRepo.list(workspaceId, { includeArchived: true }),
        loadBundles(workspaceId),
      ]);
      return companies.map((company) => {
        const companyBundles = bundles.filter((bundle) => bundle.row.company_id === company.id);
        const activeProjects = projects.filter(
          (project) => project.companyId === company.id && project.status === 'active',
        );
        return {
          company,
          activeProjectCount: activeProjects.length,
          meetingCount: companyBundles.length,
          openTaskCount: companyBundles.reduce(
            (sum, bundle) =>
              sum +
              bundle.tasks.filter((task) => task.status === 'open' || task.status === 'in_progress')
                .length,
            0,
          ),
          decisionCount: companyBundles.reduce((sum, bundle) => sum + bundle.decisions.length, 0),
          lastMeetingAt:
            companyBundles
              .map((bundle) => bundle.summary.occurredAt)
              .sort()
              .at(-1) ?? null,
        };
      });
    },
    async intelligence(companyId: string): Promise<CompanyIntelligence> {
      const company = await companiesRepo.get(companyId);
      const bundles = await loadBundles(company.workspaceId);
      const companyBundles = bundles.filter((bundle) => bundle.row.company_id === company.id);

      const goals: CompanyIntelligence['goals'] = [];
      const painPoints: CompanyIntelligence['painPoints'] = [];
      const importantFacts: CompanyIntelligence['importantFacts'] = [];
      const decisionMakers: CompanyIntelligence['decisionMakers'] = [];
      const objections: CompanyIntelligence['objections'] = [];
      const commitments: CompanyIntelligence['commitments'] = [];

      for (const bundle of companyBundles) {
        for (const decision of bundle.decisions) {
          if (
            decision.status === 'confirmed' ||
            decision.status === 'proposed' ||
            decision.status === 'tentative'
          ) {
            goals.push({
              text: decision.title,
              personId: decision.participantPersonIds[0] ?? null,
              ...(decision.evidence[0] ? { evidence: decision.evidence[0] } : {}),
            });
          }
          if (decision.status === 'confirmed' && decision.participantPersonIds[0]) {
            decisionMakers.push({
              text: decision.title,
              personId: decision.participantPersonIds[0],
              ...(decision.evidence[0] ? { evidence: decision.evidence[0] } : {}),
            });
          }
        }
        for (const fact of bundle.facts) {
          importantFacts.push({
            text: `${fact.label}: ${fact.value}`,
            personId: fact.speakerPersonId,
            ...(fact.evidence[0] ? { evidence: fact.evidence[0] } : {}),
          });
        }
        for (const commitment of bundle.commitments) {
          commitments.push({
            text: commitment.text,
            personId: commitment.byPersonId,
            ...(commitment.evidence[0] ? { evidence: commitment.evidence[0] } : {}),
          });
        }
        for (const objection of bundle.objectionTexts) {
          objections.push({
            text: objection.text,
            personId: objection.personId,
            ...(objection.evidence ? { evidence: objection.evidence } : {}),
          });
        }
        for (const risk of bundle.riskTexts) {
          painPoints.push({
            text: risk.text,
            personId: risk.personId,
            ...(risk.evidence ? { evidence: risk.evidence } : {}),
          });
        }
      }

      return {
        companyId: company.id,
        updatedAt: new Date().toISOString(),
        derivedFrom: 'analysis_pipeline',
        goals,
        painPoints,
        importantFacts,
        decisionMakers,
        objections,
        commitments,
      };
    },
  };

  const projectsRepo: ProductRepositories['projects'] = {
    async list(workspaceId, filter): Promise<Project[]> {
      await requireMembership(workspaceId);
      const includeArchived = filter?.includeArchived ?? false;
      const rows = await readRows<ProjectRow>(
        client
          .from('projects')
          .select('id, workspace_id, company_id, name, description, archived_at, created_at')
          .eq('workspace_id', workspaceId)
          .order('name', { ascending: true }),
        'projects.list',
      );
      return rows
        .filter((row) => includeArchived || row.archived_at === null)
        .map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          companyId: row.company_id,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          status: row.archived_at ? 'closed' : 'active',
          createdAt: toIso(row.created_at),
        }));
    },
    async get(projectId: string): Promise<Project> {
      const row = await readMaybeRow<ProjectRow>(
        client
          .from('projects')
          .select('id, workspace_id, company_id, name, description, archived_at, created_at')
          .eq('id', projectId),
        'projects.get',
      );
      if (!row) throw new RepositoryError('not_found', 'Project was not found.');
      await requireMembership(row.workspace_id);
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        companyId: row.company_id,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        status: row.archived_at ? 'closed' : 'active',
        createdAt: toIso(row.created_at),
      };
    },
    async overview(workspaceId, filter) {
      const [projects, companies, bundles] = await Promise.all([
        projectsRepo.list(workspaceId, filter),
        companiesRepo.list(workspaceId, { includeArchived: true }),
        loadBundles(workspaceId),
      ]);
      const companyNameById = new Map(companies.map((company) => [company.id, company.name]));
      return projects.map((project) => {
        const projectBundles = bundles.filter((bundle) => bundle.row.project_id === project.id);
        return {
          project,
          companyName: project.companyId ? (companyNameById.get(project.companyId) ?? null) : null,
          meetingCount: projectBundles.length,
          openTaskCount: projectBundles.reduce(
            (sum, bundle) =>
              sum +
              bundle.tasks.filter((task) => task.status === 'open' || task.status === 'in_progress')
                .length,
            0,
          ),
          decisionCount: projectBundles.reduce((sum, bundle) => sum + bundle.decisions.length, 0),
          lastActivityAt:
            projectBundles
              .map((bundle) => bundle.summary.occurredAt)
              .sort()
              .at(-1) ?? null,
        };
      });
    },
  };

  const meetingsRepo: ProductRepositories['meetings'] = {
    async list(workspaceId: string, filter?: MeetingFilter): Promise<MeetingListRow[]> {
      const bundles = await loadBundles(workspaceId);
      const rows = bundles.map(rowOf);
      const summaries = filterMeetings(
        rows.map((row) => row.meeting),
        filter,
      );
      const byId = new Map(rows.map((row) => [row.meeting.id, row]));
      return summaries
        .map((meeting) => byId.get(meeting.id))
        .filter((row): row is MeetingListRow => Boolean(row));
    },
    async detail(meetingId: string): Promise<MeetingDetail> {
      const [bundle] = await loadBundlesForMeeting(meetingId);
      return bundle.detail;
    },
    async participants(meetingId: string) {
      const [bundle] = await loadBundlesForMeeting(meetingId);
      return bundle.participants;
    },
    async meetingTypes(workspaceId: string): Promise<MeetingType[]> {
      await requireMembership(workspaceId);
      const rows = await readRows<MeetingTypeRow>(
        client
          .from('meeting_types')
          .select('id, workspace_id, key, display_name, template_key, sort_order, is_active')
          .eq('workspace_id', workspaceId)
          .order('sort_order', { ascending: true }),
        'meetings.meetingTypes',
      );
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        key: row.key,
        displayName: row.display_name,
        sortOrder: row.sort_order,
        builtIn: row.template_key !== null,
        active: row.is_active,
      }));
    },
    async dashboard(workspaceId: string): Promise<DashboardSnapshot> {
      const [bundles, companies] = await Promise.all([
        loadBundles(workspaceId),
        companiesRepo.list(workspaceId),
      ]);
      const rows = bundles.map(rowOf);
      const tasks = bundles.flatMap((bundle) => bundle.tasks);
      const decisions = bundles.flatMap((bundle) => bundle.decisions);
      const questions = bundles.flatMap((bundle) => bundle.questions);
      const openTasks = tasks.filter(
        (task) => task.status === 'open' || task.status === 'in_progress',
      );
      const todayIsoDate = new Date().toISOString().slice(0, 10);
      const recentDecisions = decisions
        .slice()
        .sort((left, right) => right.decidedOn.localeCompare(left.decidedOn))
        .slice(0, 8);
      const summaries = rows.map((row) => row.meeting);
      const todayMeetings = summaries.filter(
        (meeting) => meeting.occurredAt.slice(0, 10) === todayIsoDate,
      );

      return {
        workspaceId,
        generatedAt: new Date().toISOString(),
        todayMeetings,
        openTaskCount: openTasks.length,
        overdueTaskCount: rows.reduce((sum, row) => sum + row.overdueTaskCount, 0),
        decisionCount7d: decisions.length,
        openQuestionCount: questions.filter((question) => question.status === 'open').length,
        recentMeetings: rows.slice(0, 8),
        upcomingOrToday: todayMeetings,
        recentActions: openTasks.slice(0, 8),
        recentDecisions,
        processing: bundles
          .map((bundle) => bundle.detail.processing)
          .filter((timeline): timeline is ProcessingTimeline => Boolean(timeline))
          .filter((timeline) => timeline.state !== 'draft'),
        meetingCount: rows.length,
        companyCount: companies.length,
      };
    },
    async processing(meetingId: string): Promise<ProcessingTimeline> {
      const [bundle] = await loadBundlesForMeeting(meetingId);
      return bundle.detail.processing ?? buildTimeline(meetingId, bundle.summary.state as CanonicalState);
    },
    async decisionsFor(scope) {
      const bundles = await loadScoped(scope);
      return bundles.flatMap((bundle) => bundle.decisions);
    },
    async factsFor(scope) {
      const bundles = await loadScoped(scope);
      return bundles.flatMap((bundle) => bundle.facts);
    },
    async questionsFor(scope) {
      const bundles = await loadScoped(scope);
      return bundles.flatMap((bundle) => bundle.questions);
    },
    async ideasFor(scope) {
      const bundles = await loadScoped(scope);
      return bundles.flatMap((bundle) => bundle.ideas);
    },
    async commitmentsFor(scope) {
      const bundles = await loadScoped(scope);
      return bundles.flatMap((bundle) => bundle.commitments);
    },
  };

  /** Loads one meeting and enforces that it belongs to the workspace its own row declares. */
  async function loadBundlesForMeeting(meetingId: string): Promise<MeetingBundle[]> {
    const row = await readMaybeRow<MeetingRow>(
      client
        .from('meetings')
        .select('workspace_id')
        .eq('id', meetingId)
        .is('deleted_at', null),
      'meetings.detail',
    );
    if (!row) throw new RepositoryError('not_found', 'Meeting was not found.');
    const bundles = await loadBundles(row.workspace_id, { meetingId });
    if (bundles.length === 0) throw new RepositoryError('not_found', 'Meeting was not found.');
    return bundles;
  }

  async function loadScoped(scope: {
    workspaceId: string;
    companyId?: string | null;
    projectId?: string | null;
    meetingId?: string | null;
  }): Promise<MeetingBundle[]> {
    const bundles = scope.meetingId
      ? await loadBundlesForMeeting(scope.meetingId)
      : await loadBundles(scope.workspaceId);
    const check = await requireMembership(scope.workspaceId);
    if (!check) return [];
    return bundles.filter((bundle) => {
      if (bundle.row.workspace_id !== scope.workspaceId) return false;
      if (scope.companyId && bundle.row.company_id !== scope.companyId) return false;
      if (scope.projectId && bundle.row.project_id !== scope.projectId) return false;
      return true;
    });
  }

  const transcriptsRepo: ProductRepositories['transcripts'] = {
    async forMeeting(meetingId: string): Promise<MeetingTranscript> {
      const [bundle] = await loadBundlesForMeeting(meetingId);
      return bundle.transcript;
    },
    async window(request) {
      const normalized = readTranscriptWindowRequest(request);
      const [bundle] = await loadBundlesForMeeting(normalized.meetingId);
      return windowTranscript(bundle.transcript.segments, normalized, {
        totalMs: bundle.transcript.totalMs,
        wordCount: bundle.transcript.wordCount,
      });
    },
    async segmentsForTopic(topicId: string) {
      const topic = await readMaybeRow<TopicRow>(
        client.from('meeting_topics').select('id, meeting_id, source_segment_ids').eq('id', topicId),
        'transcripts.segmentsForTopic',
      );
      if (!topic) return [];
      const [bundle] = await loadBundlesForMeeting(topic.meeting_id);
      const wanted = new Set(toTextArray(topic.source_segment_ids));
      return bundle.transcript.segments
        .filter((segment) => wanted.has(segment.id))
        .sort((left, right) => left.index - right.index);
    },
    async segmentsByIds(meetingId: string, segmentIds: string[]) {
      const [bundle] = await loadBundlesForMeeting(meetingId);
      if (segmentIds.length === 0) return [];
      const wanted = new Set(segmentIds);
      return bundle.transcript.segments
        .filter((segment) => wanted.has(segment.id))
        .sort((left, right) => left.index - right.index);
    },
    async confirmSpeakerMapping() {
      throw new RepositoryError(
        'provider_unavailable',
        'Speaker mapping is applied by the processing service, not by the dashboard session.',
        { hint: 'Mapping writes require the server-side pipeline; this read-only session cannot change it.' },
      );
    },
  };

  const tasksRepo: ProductRepositories['tasks'] = {
    async list(workspaceId: string, filter) {
      const bundles = await loadBundles(workspaceId);
      const tasks = bundles.flatMap((bundle) => bundle.tasks);
      return filterTasks(tasks, filter, {
        currentPersonId: userId,
        todayIsoDate: new Date().toISOString().slice(0, 10),
      });
    },
  };

  const knowledgeRepo: ProductRepositories['knowledge'] = {
    async entries(filter: KnowledgeFilter): Promise<KnowledgeEntry[]> {
      const entries = await workspaceRowsForUser();
      const bundlesPerWorkspace = await Promise.all(
        entries.map((entry) => loadBundles(entry.workspace.id)),
      );
      const entriesAll: KnowledgeEntry[] = [];
      for (const bundle of bundlesPerWorkspace.flat()) {
        for (const decision of bundle.decisions) {
          entriesAll.push({
            kind: 'decision',
            id: decision.id,
            workspaceId: decision.workspaceId,
            meetingId: decision.meetingId,
            companyId: decision.companyId,
            projectId: decision.projectId,
            title: decision.title,
            body: decision.description,
            at: bundle.summary.occurredAt,
            personIds: decision.participantPersonIds,
            tags: [decision.status],
            statusLabel: decision.status,
            evidence: decision.evidence,
          });
        }
        for (const fact of bundle.facts) {
          entriesAll.push({
            kind: 'fact',
            id: fact.id,
            workspaceId: fact.workspaceId,
            meetingId: fact.meetingId,
            companyId: fact.companyId,
            projectId: fact.projectId,
            title: `${fact.label}: ${fact.value}`,
            body: fact.evidence[0]?.quote ?? `${fact.label} = ${fact.value}`,
            at: fact.capturedAt,
            personIds: fact.speakerPersonId ? [fact.speakerPersonId] : [],
            tags: [fact.category],
            statusLabel: fact.category,
            evidence: fact.evidence,
          });
        }
        for (const topic of bundle.topics) {
          entriesAll.push({
            kind: 'topic',
            id: topic.id,
            workspaceId: topic.workspaceId,
            meetingId: topic.meetingId,
            companyId: bundle.row.company_id,
            projectId: bundle.row.project_id,
            title: topic.title,
            body: topic.summary,
            at: bundle.summary.occurredAt,
            personIds: topic.participantPersonIds,
            tags: topic.keywords.length > 0 ? topic.keywords : ['topic'],
            statusLabel: 'discussed',
            evidence: [],
          });
        }
        for (const commitment of bundle.commitments) {
          entriesAll.push({
            kind: 'commitment',
            id: commitment.id,
            workspaceId: commitment.workspaceId,
            meetingId: commitment.meetingId,
            companyId: commitment.companyId,
            projectId: bundle.row.project_id,
            title: commitment.text,
            body: commitment.evidence[0]?.quote ?? commitment.text,
            at: bundle.summary.occurredAt,
            personIds: [commitment.byPersonId],
            tags: [commitment.status],
            statusLabel: commitment.status,
            evidence: commitment.evidence,
          });
        }
        for (const question of bundle.questions) {
          entriesAll.push({
            kind: 'question',
            id: question.id,
            workspaceId: question.workspaceId,
            meetingId: question.meetingId,
            companyId: question.companyId,
            projectId: question.projectId,
            title: question.text,
            body: question.resolution?.answer ?? question.evidence[0]?.quote ?? question.text,
            at: bundle.summary.occurredAt,
            personIds: question.askedByPersonId ? [question.askedByPersonId] : [],
            tags: [question.status],
            statusLabel: question.status,
            evidence: question.evidence,
          });
        }
      }
      return filterKnowledge(entriesAll, filter);
    },
  };

  const askAiRepo: ProductRepositories['askAi'] = {
    async ask(workspaceId: string, question: string): Promise<AskAiAnswer> {
      await requireMembership(workspaceId);
      const trimmed = question.trim();
      if (!trimmed) {
        throw new RepositoryError(
          'validation_failed',
          'Ask a question to see a retrieval-backed answer.',
        );
      }
      throw new RepositoryError(
        'provider_unavailable',
        'Ask AI retrieval runs in the processing service and is not enabled for this deployment.',
        {
          detail: 'askAi.ask',
          hint: 'Knowledge embeddings and the answer model are worker-side; the dashboard session never holds provider credentials.',
        },
      );
    },
    async suggestions(workspaceId: string): Promise<string[]> {
      await requireMembership(workspaceId);
      const companies = await companiesRepo.list(workspaceId);
      const companyName = companies[0]?.name;
      return [
        companyName
          ? `${companyName} bilan budget haqida nima kelishganmiz?`
          : 'Budget haqida nima kelishganmiz?',
        'Qanday ochiq vazifalar va muddatlar qolgan?',
        'Oxirgi yig‘ilishlarda qanday qarorlar tasdiqlangan?',
        'Mijoz tomonidan qanday e’tiroz yoki savollar ko‘tarilgan?',
        'What commitments and deadlines were agreed?',
        'Какие ключевые факты и метрики были зафиксированы?',
      ];
    },
  };

  const searchRepo: ProductRepositories['search'] = {
    async search(workspaceId: string, query: string): Promise<SearchHit[]> {
      const needle = query.trim().toLowerCase();
      if (needle.length < 2) return [];
      const [bundles, companies, projects, members] = await Promise.all([
        loadBundles(workspaceId),
        companiesRepo.list(workspaceId, { includeArchived: true }),
        projectsRepo.list(workspaceId, { includeArchived: true }),
        workspacesRepo.members(workspaceId),
      ]);

      const hits: SearchHit[] = [];
      const add = (hit: SearchHit) => {
        if (!hits.some((existing) => existing.href === hit.href && existing.title === hit.title)) {
          hits.push(hit);
        }
      };

      for (const bundle of bundles) {
        const meeting = bundle.summary;
        if (
          `${meeting.title} ${meeting.companyName ?? ''} ${meeting.projectName ?? ''}`
            .toLowerCase()
            .includes(needle)
        ) {
          add({
            kind: 'meeting',
            id: meeting.id,
            title: meeting.title,
            subtitle: `${meeting.companyName ?? 'No company'} · ${new Date(meeting.occurredAt).toLocaleDateString('en', { dateStyle: 'medium' })}`,
            href: routes.meeting({ workspaceId, meetingId: meeting.id }),
          });
        }
        for (const decision of bundle.decisions) {
          if (`${decision.title} ${decision.description}`.toLowerCase().includes(needle)) {
            add({
              kind: 'decision',
              id: decision.id,
              title: decision.title,
              subtitle: `Decision · ${decision.status}`,
              href: routes.meetingTab({
                workspaceId,
                meetingId: decision.meetingId,
                tab: 'decisions',
              }),
            });
          }
        }
        for (const task of bundle.tasks) {
          if (`${task.title} ${task.detail ?? ''} ${task.ownerLabel}`.toLowerCase().includes(needle)) {
            add({
              kind: 'task',
              id: task.id,
              title: task.title,
              subtitle: `Task · ${task.ownerLabel}`,
              href: routes.meetingTab({ workspaceId, meetingId: task.meetingId, tab: 'tasks' }),
            });
          }
        }
      }

      for (const company of companies) {
        if (`${company.name} ${company.description ?? ''}`.toLowerCase().includes(needle)) {
          add({
            kind: 'company',
            id: company.id,
            title: company.name,
            subtitle: company.description ?? 'Company',
            href: routes.company({ workspaceId, companyId: company.id }),
          });
        }
      }
      for (const project of projects) {
        if (`${project.name} ${project.description ?? ''}`.toLowerCase().includes(needle)) {
          add({
            kind: 'project',
            id: project.id,
            title: project.name,
            subtitle: project.description ?? 'Project',
            href: routes.project({ workspaceId, projectId: project.id }),
          });
        }
      }
      for (const member of members) {
        if (`${member.name} ${member.email ?? ''}`.toLowerCase().includes(needle)) {
          add({
            kind: 'person',
            id: member.personId,
            title: member.name,
            subtitle: `Workspace ${member.role}`,
            href: routes.tasks({ workspaceId }, { person: member.personId }),
          });
        }
      }

      return hits.slice(0, 12);
    },
    async recent(workspaceId: string, limit = 12) {
      const bundles = await loadBundles(workspaceId);
      const hits: SearchHit[] = bundles
        .map((bundle) => bundle.summary)
        .slice()
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, Math.max(1, Math.min(limit, 8)))
        .map((meeting) => ({
          kind: 'meeting' as const,
          id: meeting.id,
          title: meeting.title,
          subtitle: `${meeting.state === 'draft' ? 'Draft' : meeting.meetingTypeLabel} · ${meeting.companyName ?? 'No company'}`,
          href: routes.meeting({ workspaceId, meetingId: meeting.id }),
        }));

      const openTasks = bundles
        .flatMap((bundle) => bundle.tasks)
        .filter((task) => task.status === 'open' || task.status === 'in_progress')
        .sort((left, right) => (left.dueDate ?? '9999').localeCompare(right.dueDate ?? '9999'))
        .slice(0, Math.max(0, limit - hits.length));

      for (const task of openTasks) {
        hits.push({
          kind: 'task',
          id: task.id,
          title: task.title,
          subtitle: `Open task · ${task.ownerLabel}${task.dueDate ? ` · due ${task.dueDate}` : ''}`,
          href: routes.meetingTab({ workspaceId, meetingId: task.meetingId, tab: 'tasks' }),
        });
      }
      return hits;
    },
  };

  const settingsRepo: ProductRepositories['settings'] = {
    async get(workspaceId: string): Promise<SettingsSnapshot> {
      const membership = await requireMembership(workspaceId);
      const [workspace, members, meetingTypes, participantRows] = await Promise.all([
        readMaybeRow<WorkspaceRow>(
          client.from('workspaces').select('id, name, slug, created_at').eq('id', workspaceId),
          'settings.get',
        ),
        workspacesRepo.members(workspaceId),
        meetingsRepo.meetingTypes(workspaceId),
        readRows<ParticipantRow>(
          client
            .from('meeting_participants')
            .select('id, display_name, is_external')
            .eq('workspace_id', workspaceId),
          'settings.get',
        ),
      ]);
      if (!workspace) {
        throw new RepositoryError('not_found', 'This workspace does not exist.', {
          detail: workspaceId,
        });
      }

      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
        currentRole: membership.role,
        members: members.map((member) => ({
          personId: member.personId,
          name: member.name,
          ...(member.email ? { email: member.email } : {}),
          role: member.role,
          status: member.status,
        })),
        meetingTypes,
        vocabulary: [],
        recording: {
          preferredInputLabel: 'Default system microphone & system audio',
          captureSystemAudio: true,
          retentionLabel:
            'Keep verified audio chunks and canonical transcripts in workspace storage',
          screenContextDefault: 'never',
          audioFormatLabel: 'Opus / WAV 48kHz',
          chunkLengthSeconds: 30,
          storageRootLabel: 'Private workspace object storage',
        },
        ai: {
          transcriptionLanguages: ['uz', 'ru', 'en'],
          speakerLanguageGuessing: true,
          summaryStyle: 'executive_brief',
          analysisDepth: 'standard',
          providerNote:
            'Transcription, meeting intelligence and embeddings run in the isolated processing service; this dashboard session holds no provider credentials.',
        },
        integrations: [
          {
            key: 'telegram',
            label: 'Telegram Companion',
            state: 'not_connected',
            detail:
              'Linking a Telegram account issues a single-use token through the processing service, not from this session.',
          },
          {
            key: 'google_calendar',
            label: 'Google Calendar',
            state: 'not_connected',
            detail:
              'Requires explicit user confirmation and auditable idempotency before scheduling follow-ups.',
          },
          {
            key: 'amocrm',
            label: 'amoCRM',
            state: 'not_connected',
            detail:
              'Requires explicit user confirmation and auditable idempotency before syncing summaries or tasks.',
          },
          {
            key: 'google_docs',
            label: 'Google Docs',
            state: 'not_connected',
            detail:
              'Requires explicit user confirmation and auditable idempotency before publishing meeting briefs.',
          },
        ],
      };
    },
    async vocabulary(workspaceId: string) {
      await requireMembership(workspaceId);
      return [];
    },
  };

  const desktopRepo: ProductRepositories['desktop'] = {
    async status() {
      return {
        state: 'not_validated',
        detail:
          'Local-first recorder uploads are verified through the Phase 4 API; live dashboard reads are session-scoped.',
        deepLink: 'suhbat://recorder',
      };
    },
  };

  const namespaces = new Map<string, object>([
    ['workspaces', workspacesRepo],
    ['companies', companiesRepo],
    ['projects', projectsRepo],
    ['meetings', meetingsRepo],
    ['transcripts', transcriptsRepo],
    ['tasks', tasksRepo],
    ['knowledge', knowledgeRepo],
    ['askAi', askAiRepo],
    ['search', searchRepo],
    ['settings', settingsRepo],
    ['desktop', desktopRepo],
  ]);

  return new Proxy({ capabilities } as ProductRepositories, {
    get(target, property) {
      if (property === 'capabilities') return target.capabilities;
      if (typeof property !== 'string') return undefined;
      const existing = namespaces.get(property);
      if (existing) return existing;
      const created = unavailableNamespace(
        property,
        'This dashboard namespace has no live Supabase implementation yet.',
      );
      namespaces.set(property, created);
      return created;
    },
  });
}

/**
 * The adapter used when `SUHBAT_DATA_MODE=live` but no session/adapter configuration exists.
 *
 * This deliberately does not read demo fixtures and does not claim a feature is "not implemented yet": it
 * states exactly which configuration is missing, so a misconfigured deployment fails loudly instead of
 * looking like an empty workspace.
 */
export function createUnavailableLiveRepositories(reason: string): ProductRepositories {
  const namespaces = new Map<string, object>();
  return new Proxy({ capabilities: unavailableCapabilities } as ProductRepositories, {
    get(target, property) {
      if (property === 'capabilities') return target.capabilities;
      if (typeof property !== 'string') return undefined;
      const existing = namespaces.get(property);
      if (existing) return existing;
      const created = unavailableNamespace(property, reason, 'not_configured');
      namespaces.set(property, created);
      return created;
    },
  });
}

const unavailableCapabilities: DataCapabilities = {
  mode: 'live',
  reads: 'live',
  writes: false,
  pipeline: 'none',
  demoStateTransitions: false,
  playback: 'none',
  actions: disabledWriteActions,
  persistence: 'none',
  persistenceLabel: 'No data source is connected in this deployment.',
  provenanceLabel: 'Live data mode is enabled, but the live adapter is not configured.',
};
