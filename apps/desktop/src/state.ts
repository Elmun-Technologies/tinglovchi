/**
 * Renderer state: a pure reducer over recorder status, coordinator events, and bridge failures.
 *
 * It is deliberately dumb. Every number displayed comes from the Rust coordinator's status payload or
 * the durable manifest — the reducer never adds elapsed time itself, never estimates a duration from
 * chunk counts, and never converts a missing level into "silence". `tests/desktop/desktop-state.test.ts`
 * pins those rules.
 */

import type {
  AudioDevice,
  ChunkRecord,
  PermissionSnapshot,
  RecorderError,
  RecorderEvent,
  RecorderManifest,
  RecorderState,
  RecorderStatus,
  RecoveryReport,
  SourceLevel,
  SourceStatus,
} from '@suhbat/contracts';

export const MAX_RECENT_CHUNKS = 12;

export type Notice = { tone: 'info' | 'warn' | 'error'; title: string; detail?: string };

export type UiState = {
  bridgeKind: 'tauri' | 'unavailable' | 'injected';
  status: RecorderStatus | null;
  permissions: PermissionSnapshot | null;
  devices: AudioDevice[];
  manifest: RecorderManifest | null;
  recovery: RecoveryReport | null;
  /** Most recently finalized chunks, newest first. Display only: never a source of truth for totals. */
  recentChunks: ChunkRecord[];
  notice: Notice | null;
  /** True while a command is in flight, so buttons cannot double-fire. */
  busy: boolean;
};

export const initialState: UiState = {
  bridgeKind: 'unavailable',
  status: null,
  permissions: null,
  devices: [],
  manifest: null,
  recovery: null,
  recentChunks: [],
  notice: null,
  busy: false,
};

export type Action =
  | { type: 'bridge'; kind: UiState['bridgeKind'] }
  | { type: 'status'; status: RecorderStatus }
  | { type: 'permissions'; snapshot: PermissionSnapshot }
  | { type: 'devices'; devices: AudioDevice[] }
  | { type: 'manifest'; manifest: RecorderManifest | null }
  | { type: 'recovery'; report: RecoveryReport }
  | { type: 'event'; event: RecorderEvent }
  | { type: 'busy'; busy: boolean }
  | { type: 'notice'; notice: Notice | null }
  | { type: 'error'; error: RecorderError };

export function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'bridge':
      if (action.kind === 'unavailable') {
        return {
          ...state,
          bridgeKind: action.kind,
          notice: {
            tone: 'warn',
            title: 'Native recorder bridge unavailable',
            detail:
              'This renderer is not running inside the Tauri shell, so no microphone or system-audio command can reach the recorder and nothing is being captured. Start the app with `npm run tauri:dev` from apps/desktop on a Mac; opening this folder in a browser can only ever show this message.',
          },
        };
      }
      // Restoring the bridge clears only its own notice; a real error notice stays until the fault clears.
      return state.notice?.title === 'Native recorder bridge unavailable'
        ? { ...state, bridgeKind: action.kind, notice: null }
        : { ...state, bridgeKind: action.kind };
    case 'status':
      return {
        ...state,
        status: action.status,
        notice: clearIfResolved(state.notice, action.status),
      };
    case 'permissions':
      return { ...state, permissions: action.snapshot };
    case 'devices':
      return { ...state, devices: action.devices };
    case 'manifest':
      return { ...state, manifest: action.manifest };
    case 'recovery':
      return { ...state, recovery: action.report };
    case 'busy':
      return { ...state, busy: action.busy };
    case 'notice':
      return { ...state, notice: action.notice };
    case 'error':
      return { ...state, busy: false, notice: noticeFromError(action.error) };
    case 'event':
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: UiState, event: RecorderEvent): UiState {
  switch (event.type) {
    case 'state':
      // Only the state is adopted from the event; timers and source health come from status payloads so
      // the UI cannot drift from the durable record between polls.
      return state.status
        ? { ...state, status: { ...state.status, state: event.state } }
        : { ...state, status: syntheticPending(event.state) };
    case 'permissions':
      return { ...state, permissions: event.snapshot };
    case 'levels':
      return state.status ? { ...state, status: withLevels(state.status, event.levels) } : state;
    case 'chunk_finalized':
      return {
        ...state,
        recentChunks: [event.chunk, ...state.recentChunks].slice(0, MAX_RECENT_CHUNKS),
      };
    case 'annotation':
      // Annotations are shown from the manifest; a poll refreshes them. Nothing is appended locally,
      // so the list can never claim an annotation the manifest does not contain.
      return { ...state, busy: false };
    case 'recovery':
      return { ...state, recovery: event.report };
    case 'close_requested':
      // Owned by the one-tap flow reducer, not the recorder panel: a close attempt changes nothing
      // about capture, and the close was already prevented before this event was emitted.
      return state;
    case 'fault':
      return { ...state, notice: noticeFromError(event.error) };
  }
}

function syntheticPending(state: RecorderState): RecorderStatus {
  return {
    state,
    canonicalElapsedMs: 0,
    activeCaptureMs: 0,
    recordingId: null,
    sessionId: null,
    sessionDirectory: null,
    sources: [],
    levels: [],
    gaps: [],
    chunkCount: 0,
    finalizedChunkCount: 0,
    lastFinalizedChunkAt: null,
    persistenceFault: null,
    disk: null,
    clockEpochId: null,
  };
}

function withLevels(status: RecorderStatus, levels: SourceLevel[]): RecorderStatus {
  return { ...status, levels };
}

/** Codes that mean "audio is being lost or the record is not durable" — the fault the operator must act on. */
const PERSISTENCE_CODES = new Set([
  'writer_failed',
  'manifest_conflict',
  'manifest_unreadable',
  'disk_full',
  'disk_space_insufficient',
]);

function clearIfResolved(notice: Notice | null, status: RecorderStatus): Notice | null {
  if (!notice || notice.tone === 'info') return notice;
  // A persistence notice is dismissed only by evidence, i.e. a status that no longer reports a fault.
  if (status.persistenceFault === null && notice.title.startsWith('Persistence failed'))
    return null;
  return notice;
}

export function noticeFromError(error: RecorderError): Notice {
  const detail = [
    error.message,
    error.sourceKind ? `source: ${error.sourceKind}` : null,
    error.retryable ? 'retryable' : null,
    error.openSettingsUrl ? 'System Settings shortcut available' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const title = PERSISTENCE_CODES.has(error.code)
    ? `Persistence failed: ${error.code}`
    : `${error.code} — see the details below`;
  return { tone: 'error', title, detail };
}

/** The visible health of a source: never worse than the truth, never better than the record. */
export type SourceRow = {
  kind: 'microphone' | 'system_audio';
  label: string;
  health: SourceStatus['state'];
  device: string;
  level: SourceLevel | null;
  capturedSeconds: number;
  droppedSamples: number;
  chunks: number;
  segmentCount: number;
};

export function sourceRows(
  status: RecorderStatus | null,
  manifest: RecorderManifest | null,
): SourceRow[] {
  const chunks = manifest?.chunks ?? [];
  return (['microphone', 'system_audio'] as const).map((kind) => {
    const source = status?.sources.find((candidate) => candidate.kind === kind) ?? null;
    const level = status?.levels.find((candidate) => candidate.kind === kind) ?? null;
    const ownChunks = chunks.filter((chunk) => chunk.sourceKind === kind);
    return {
      kind,
      label: kind === 'microphone' ? 'Microphone' : 'System audio',
      health: source?.state ?? 'unavailable',
      device: source?.deviceName ?? (source?.deviceUid ? source.deviceUid : 'not selected'),
      level,
      capturedSeconds: source
        ? source.lastSampleIndexExclusive / Math.max(1, source.sampleRateHz)
        : 0,
      droppedSamples: source?.droppedSampleCount ?? 0,
      chunks: ownChunks.length,
      segmentCount: source?.sampleMap.length ?? 0,
    };
  });
}

/**
 * Meter height in percent. `live === false` renders an empty meter with a "no audio" caption rather than a
 * zeroed meter, because absence and silence are different facts (docs/recording.md §3).
 */
export function meterPercent(level: SourceLevel | null): number {
  if (!level || !level.live) return 0;
  return Math.max(0, Math.min(100, Math.round(level.peak * 100)));
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Buttons are enabled by the state machine, not by optimism. `finalizing` and `failed` deliberately offer
 * nothing but a reset, and no control is enabled while a persistence fault is unresolved.
 */
export type Controls = {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
  canAnnotate: boolean;
  blockedReason: string | null;
};

export function controlsFor(state: UiState): Controls {
  const status = state.status;
  const recorderState: RecorderState = status?.state ?? 'idle';
  const faulted = status?.persistenceFault != null;
  const blockedReason =
    state.bridgeKind === 'unavailable'
      ? 'The native bridge is not available.'
      : faulted
        ? 'Persistence failed: stop this session and start a new one. Audio captured before the fault stays recoverable.'
        : recorderState === 'permission_blocked'
          ? 'Grant microphone and screen-capture permission in System Settings, then re-check.'
          : recorderState === 'device_unavailable'
            ? 'No usable input device is selected.'
            : null;
  return {
    // The Rust state machine only allows `ready -> recording`, so the button is enabled exactly then.
    canStart: recorderState === 'ready' && !blockedReason,
    canPause: recorderState === 'recording' && !faulted,
    canResume: recorderState === 'paused' && !faulted,
    canStop: recorderState === 'recording' || recorderState === 'paused',
    canAnnotate: (recorderState === 'recording' || recorderState === 'paused') && !faulted,
    blockedReason,
  };
}

export function isCapturing(state: RecorderState): boolean {
  return state === 'recording' || state === 'paused' || state === 'finalizing';
}

/** Human summary of the pause arithmetic, so the two clocks can never be conflated on screen. */
export function durationSummary(
  status: RecorderStatus | null,
): { canonical: string; active: string; deltaLabel: string } | null {
  if (!status) return null;
  const pausedMs = Math.max(0, status.canonicalElapsedMs - status.activeCaptureMs);
  return {
    canonical: formatClock(status.canonicalElapsedMs),
    active: formatClock(status.activeCaptureMs),
    deltaLabel: pausedMs > 0 ? `${formatClock(pausedMs)} paused or missing` : 'no gaps yet',
  };
}
