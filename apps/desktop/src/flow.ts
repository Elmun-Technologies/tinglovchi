/**
 * The one-tap recorder flow: a pure reducer over what the recorder and the server have actually said.
 *
 * The whole product promise is "press one button, come back to a finished meeting". That only holds if
 * the screen never invents a step it has not been told about, so:
 *
 * * **No phase is reached by a timer.** Upload advances when the queue reports verified chunks;
 *   processing advances when `GET /meetings/{id}/processing` says so; `ready` is reached only when the
 *   canonical product state is `ready`.
 * * **No percentages.** There is no way to know how far along a transcription is, so the UI shows the
 *   step name instead of a fabricated number.
 * * **Stop is idempotent.** A second Stop while one is in flight is dropped, and a Stop after `stopped`
 *   is rejected — the recording is finalized exactly once.
 * * **Failure is a state, not a dead end.** A provider failure still leaves "Suhbat saqlandi"
 *   (the meeting is saved), because the audio is on the server and the dashboard can retry.
 */

export type FlowPhase =
  | 'booting'
  | 'signed_out'
  | 'consent'
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  /** Stopped and finalized locally; the network is unreachable so it stays on this device. */
  | 'saved_locally'
  /** Local finalize happened; chunks are being registered, uploaded and verified. */
  | 'uploading'
  /** Server verified and finalized; the worker is transcribing / analysing / indexing. */
  | 'processing'
  | 'ready'
  /** The meeting exists but transcription or analysis stopped without succeeding. */
  | 'analysis_failed';

export type FlowNotice = {
  tone: 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
};

export type ProcessingStep = {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending' | 'failed';
};

export type MeetingContext = {
  meetingId: string;
  workspaceId: string;
  title: string;
};

export type FlowState = {
  phase: FlowPhase;
  /** True while a command is in flight, which is what makes double-taps impossible. */
  busy: boolean;
  workspaceId: string | null;
  meeting: MeetingContext | null;
  recordingId: string | null;
  pairingCode: string | null;
  upload: { verified: number; total: number; failed: number } | null;
  processing: {
    productState: string;
    steps: ProcessingStep[];
    error: FlowNotice | null;
    /** Canonical duration the server finalized; null until it has one. */
    durationMs: number | null;
    /** Languages the transcription provider actually detected. Empty means "not detected". */
    languages: string[];
  } | null;
  /** Set when the user tries to close the window mid-capture. */
  closeRequested: boolean;
  notice: FlowNotice | null;
};

export const initialFlowState: FlowState = {
  phase: 'booting',
  busy: false,
  workspaceId: null,
  meeting: null,
  recordingId: null,
  pairingCode: null,
  upload: null,
  processing: null,
  closeRequested: false,
  notice: null,
};

export type FlowAction =
  | { type: 'booted'; signedIn: boolean; workspaceId: string | null; consented: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'pairing_code'; code: string | null }
  | { type: 'signed_in'; workspaceId: string | null }
  | { type: 'signed_out' }
  | { type: 'consent_acknowledged'; workspaceId: string | null }
  | { type: 'workspace_selected'; workspaceId: string }
  | { type: 'start_requested' }
  | { type: 'started'; recordingId: string | null }
  | { type: 'start_failed'; notice: FlowNotice }
  | { type: 'recorder_state'; state: 'recording' | 'paused' | 'stopped' | 'failed' }
  | { type: 'stop_requested' }
  | { type: 'stopped'; meeting: MeetingContext | null }
  | { type: 'offline_after_stop'; meeting: MeetingContext | null }
  | { type: 'upload_progress'; verified: number; total: number; failed: number }
  /** The pump could not reach the server. The meeting stays on disk and the pump keeps retrying. */
  | { type: 'upload_offline'; progress: { verified: number; total: number; failed: number } }
  | { type: 'upload_complete' }
  | {
      type: 'processing';
      productState: string;
      steps: ProcessingStep[];
      error: FlowNotice | null;
      durationMs: number | null;
      languages: string[];
    }
  /** A crash-recovered session is being drained through the same upload queue. */
  | { type: 'recovered_upload_started'; meeting: MeetingContext }
  | { type: 'ready'; meeting: MeetingContext | null }
  | { type: 'analysis_failed'; notice: FlowNotice }
  | { type: 'close_requested' }
  | { type: 'close_cancelled' }
  | { type: 'notice'; notice: FlowNotice | null }
  | { type: 'reset' };

const BUSY_PHASES = new Set<FlowPhase>(['starting', 'stopping']);

export function reduceFlow(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'booted':
      return {
        ...state,
        phase: action.signedIn ? (action.consented ? 'idle' : 'consent') : 'signed_out',
        workspaceId: action.workspaceId,
      };

    case 'busy':
      return { ...state, busy: action.busy };

    case 'pairing_code':
      return { ...state, pairingCode: action.code };

    case 'signed_in':
      return { ...state, phase: 'consent', workspaceId: action.workspaceId, pairingCode: null };

    case 'signed_out':
      return { ...initialFlowState, phase: 'signed_out', busy: false };

    case 'consent_acknowledged':
      return {
        ...state,
        phase: state.phase === 'consent' ? 'idle' : state.phase,
        workspaceId: action.workspaceId ?? state.workspaceId,
      };

    case 'workspace_selected':
      // Only ever valid while idle: switching mid-recording would orphan the chunks already uploaded
      // under a different workspace.
      return state.phase === 'idle' ? { ...state, workspaceId: action.workspaceId } : state;

    case 'start_requested':
      // Duplicate-start protection: ignored unless the recorder is genuinely idle, not busy, and has a
      // workspace to record into. Recording without a workspace would upload chunks to nowhere.
      if (state.phase !== 'idle' || state.busy || state.workspaceId === null) return state;
      return { ...state, phase: 'starting', busy: true, notice: null };

    case 'started':
      if (state.phase !== 'starting') return state;
      return { ...state, phase: 'recording', busy: false, recordingId: action.recordingId };

    case 'start_failed':
      if (state.phase !== 'starting') return state;
      return { ...state, phase: 'idle', busy: false, notice: action.notice };

    case 'recorder_state':
      return { ...state, phase: phaseFromRecorder(state.phase, action.state) };

    case 'stop_requested':
      // Duplicate-stop protection: only one stop can ever be in flight, and stopping something that
      // is not capturing is meaningless.
      if (state.busy) return state;
      if (state.phase !== 'recording' && state.phase !== 'paused') return state;
      return { ...state, phase: 'stopping', busy: true };

    case 'stopped':
      if (state.phase !== 'stopping') return state;
      return {
        ...state,
        phase: 'uploading',
        busy: false,
        meeting: action.meeting ?? state.meeting,
        closeRequested: false,
        upload: { verified: 0, total: 0, failed: 0 },
      };

    case 'offline_after_stop':
      if (state.phase !== 'stopping') return state;
      return {
        ...state,
        phase: 'saved_locally',
        busy: false,
        meeting: action.meeting ?? state.meeting,
        closeRequested: false,
      };

    case 'upload_progress':
      if (state.phase !== 'uploading' && state.phase !== 'saved_locally') return state;
      return {
        ...state,
        phase: 'uploading',
        upload: {
          verified: action.verified,
          total: action.total,
          failed: action.failed,
        },
      };

    case 'upload_offline':
      if (state.phase !== 'uploading' && state.phase !== 'saved_locally') return state;
      return { ...state, phase: 'saved_locally', upload: action.progress };

    case 'upload_complete':
      if (state.phase !== 'uploading') return state;
      return { ...state, phase: 'processing', upload: null };

    case 'processing':
      if (state.phase !== 'processing' && state.phase !== 'uploading' && state.phase !== 'saved_locally') {
        return state;
      }
      const failed =
        action.productState === 'failed' ||
        action.productState === 'transcription_failed' ||
        action.productState === 'analysis_failed';
      return {
        ...state,
        phase: action.productState === 'ready' ? 'ready' : failed ? 'analysis_failed' : 'processing',
        // A provider failure is not a lost meeting: the audio is on the server and the dashboard can
        // retry, so the notice says exactly that instead of implying the recording failed.
        notice: failed ? (action.error ?? state.notice) : state.notice,
        processing: {
          productState: action.productState,
          steps: action.steps,
          error: action.error,
          durationMs: action.durationMs,
          languages: action.languages,
        },
      };

    case 'recovered_upload_started':
      if (state.phase !== 'idle') return state;
      return {
        ...state,
        phase: 'uploading',
        meeting: action.meeting,
        upload: { verified: 0, total: 0, failed: 0 },
      };

    case 'ready':
      return {
        ...state,
        phase: 'ready',
        busy: false,
        meeting: action.meeting ?? state.meeting,
        upload: null,
      };

    case 'analysis_failed':
      return {
        ...state,
        phase: 'analysis_failed',
        busy: false,
        notice: action.notice,
      };

    case 'close_requested':
      return state.phase === 'recording' || state.phase === 'paused'
        ? { ...state, closeRequested: true }
        : state;

    case 'close_cancelled':
      return { ...state, closeRequested: false };

    case 'notice':
      return { ...state, notice: action.notice };

    case 'reset':
      return { ...initialFlowState, phase: 'idle', workspaceId: state.workspaceId };
  }
}

/** Phases in which a recording session actually exists, so a recorder event can mean something. */
const LIVE_PHASES = new Set<FlowPhase>(['starting', 'recording', 'paused', 'stopping']);

/**
 * The recorder's own state machine is the authority for `recording`/`paused`/`failed`.
 *
 * Events are only adopted while a session is live: a stray `recording` event arriving at `idle` cannot
 * invent a meeting, and a crash-recovered session is handled by the recovery path instead, because
 * capture is never silently resumed into an old session.
 *
 * `stopped` deliberately does *not* move the flow: the local finalize is done, but the flow's next
 * phase depends on whether the network is reachable, which the uploader decides.
 */
function phaseFromRecorder(current: FlowPhase, state: 'recording' | 'paused' | 'stopped' | 'failed'): FlowPhase {
  if (!LIVE_PHASES.has(current)) return current;
  if (state === 'recording') return current === 'starting' ? current : 'recording';
  if (state === 'paused') return 'paused';
  if (state === 'failed') return 'idle';
  return current;
}

/** Whether the big button means "start" right now. */
export function canStart(state: FlowState): boolean {
  return state.phase === 'idle' && !state.busy && state.workspaceId !== null;
}

export function canPause(state: FlowState): boolean {
  return state.phase === 'recording' && !BUSY_PHASES.has(state.phase);
}

export function canResume(state: FlowState): boolean {
  return state.phase === 'paused' && !state.busy;
}

export function canStop(state: FlowState): boolean {
  return (state.phase === 'recording' || state.phase === 'paused') && !state.busy;
}

export function isCapturing(state: FlowState): boolean {
  return state.phase === 'recording' || state.phase === 'paused' || state.phase === 'starting' || state.phase === 'stopping';
}

export type ProcessingHeadline = { title: string; detail: string | null };

/**
 * Maps the canonical product state onto the four sentences the user is allowed to see.
 *
 * Anything not listed is shown as the generic "tahlil qilinmoqda" rather than guessed at, and no step
 * ever claims a percentage.
 */
export function processingHeadline(
  productState: string,
  copy: { saving: string; uploading: string; transcribing: string; analyzing: string },
): ProcessingHeadline {
  switch (productState) {
    case 'recording':
      return { title: copy.saving, detail: null };
    case 'queued':
    case 'uploading':
      return { title: copy.uploading, detail: null };
    case 'preparing':
      return { title: copy.saving, detail: null };
    case 'ready_for_transcription':
    case 'preparing_transcript':
      return { title: copy.transcribing, detail: null };
    case 'transcribing':
    case 'normalizing_transcript':
    case 'transcript_ready':
      return { title: copy.transcribing, detail: null };
    case 'ready_for_analysis':
    case 'analyzing':
    case 'normalizing_analysis':
    case 'analysis_ready':
      return { title: copy.analyzing, detail: null };
    default:
      return { title: copy.analyzing, detail: null };
  }
}
