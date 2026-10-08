/**
 * The only seam between the renderer and the native recorder.
 *
 * There is no HTTP client and no Supabase import here by design: Phase 2 is local-first, so every call
 * goes through Tauri IPC to `apps/desktop/src-tauri`. The renderer never touches the filesystem, never
 * receives an absolute path it must interpret, and never talks to the network.
 *
 * Two honest constraints:
 * * The Tauri global API (`window.__TAURI__`) is used instead of the `@tauri-apps/api` package, so this
 *   workspace adds no new dependency to the lockfile. `withGlobalTauri: true` is set in `tauri.conf.json`.
 * * When the bridge is absent — a plain browser tab, `vite build`, or a unit test — every call rejects
 *   with `bridge_unavailable`. The UI then says so. It never fabricates a status to look functional.
 */

import {
  type AudioDevice,
  type PermissionSnapshot,
  type RecorderError,
  type RecorderEvent,
  type RecorderManifest,
  type RecorderStatus,
  type RecoveryReport,
  type StartRecordingRequest,
  audioDeviceSchema,
  permissionSnapshotSchema,
  recorderErrorSchema,
  recorderEventSchema,
  recorderManifestSchema,
  recorderStatusSchema,
  recoveryReportSchema,
  startRecordingRequestSchema,
} from '@suhbat/contracts';
import { z } from 'zod';

/** Command names, kept in one object so the Rust `generate_handler!` list and the UI cannot drift apart. */
export const COMMANDS = {
  refreshPermissions: 'recorder_refresh_permissions',
  requestPermissions: 'recorder_request_permissions',
  listDevices: 'recorder_list_devices',
  openSettings: 'recorder_open_settings',
  preflight: 'recorder_preflight',
  start: 'recorder_start',
  pause: 'recorder_pause',
  resume: 'recorder_resume',
  stop: 'recorder_stop',
  status: 'recorder_status',
  manifest: 'recorder_manifest',
  markImportant: 'recorder_mark_important',
  addNote: 'recorder_add_note',
  scanSessions: 'recorder_scan_sessions',
  linkMeeting: 'recorder_link_meeting',
  readChunkBytes: 'recorder_read_chunk_bytes',
  readSessionChunk: 'recorder_read_session_chunk',
  prepareRecoveredUpload: 'recorder_prepare_recovered_upload',
  openExternal: 'recorder_open_external',
  finishClose: 'recorder_finish_close',
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

export const EVENT_NAME = 'recorder://event';

export class BridgeUnavailableError extends Error {
  readonly code = 'bridge_unavailable';
  constructor(command: string) {
    super(
      `The native recorder bridge is not available, so "${command}" cannot run. Run this UI inside the Tauri shell.`,
    );
    this.name = 'BridgeUnavailableError';
  }
}

export class ContractViolationError extends Error {
  readonly code = 'contract_violation';
  constructor(
    readonly what: string,
    readonly received: unknown,
    cause: unknown,
  ) {
    super(
      `${what} did not match the shared contract: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'This is a Rust/TypeScript drift bug, not a user error.',
      { cause },
    );
    this.name = 'ContractViolationError';
  }
}

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type ListenFn = (
  event: string,
  handler: (message: { payload: unknown }) => void,
) => Promise<() => void>;

type TauriGlobal = {
  core?: { invoke?: InvokeFn };
  event?: { listen?: ListenFn };
};

function tauriGlobal(): TauriGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** Structured error shape returned by every Rust command on failure. */
function toRecorderError(error: unknown): RecorderError {
  if (error instanceof BridgeUnavailableError) {
    return { code: 'internal_error', message: error.message, retryable: false };
  }
  const parsed = recorderErrorSchema.safeParse(typeof error === 'string' ? tryJson(error) : error);
  if (parsed.success) return parsed.data;
  const message =
    typeof error === 'string'
      ? error
      : ((error as Error | undefined)?.message ?? 'unknown native error');
  return { code: 'internal_error', message: message.slice(0, 600), retryable: false };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(encoded: string): Uint8Array {
  const text = encoded.replace(/[\s=]/g, '');
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bitBuffer = 0;
  let bitCount = 0;
  let cursor = 0;
  for (const character of text) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) {
      throw new ContractViolationError('chunk bytes', encoded, new Error('invalid base64 character'));
    }
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[cursor] = (bitBuffer >> bitCount) & 0xff;
      cursor += 1;
    }
  }
  return bytes.subarray(0, cursor);
}

function validate<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ContractViolationError(what, value, parsed.error);
  }
  return parsed.data;
}

/**
 * Typed recorder bridge. `subscribe` returns an unsubscribe function and validates every payload: an
 * event that fails the schema is surfaced as a contract violation instead of being dropped quietly.
 */
export function createBridge() {
  const injected =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { __recorderBridge?: RecorderBridge }).__recorderBridge;
  const bridge: RecorderBridge = injected ?? createTauriBridge();
  return bridge;
}

export interface RecorderBridge {
  readonly kind: 'tauri' | 'unavailable' | 'injected';
  refreshPermissions(): Promise<PermissionSnapshot>;
  requestPermissions(): Promise<PermissionSnapshot>;
  listDevices(kind: 'microphone' | 'system_audio'): Promise<AudioDevice[]>;
  openSettings(kind: 'microphone' | 'system_audio'): Promise<void>;
  preflight(plannedSeconds: number): Promise<RecorderStatus>;
  start(request: StartRecordingRequest): Promise<RecorderStatus>;
  pause(): Promise<RecorderStatus>;
  resume(): Promise<RecorderStatus>;
  stop(): Promise<RecorderStatus>;
  status(): Promise<RecorderStatus>;
  manifest(): Promise<RecorderManifest | null>;
  markImportant(label: string | null): Promise<unknown>;
  addNote(text: string): Promise<unknown>;
  scanSessions(): Promise<RecoveryReport>;
  /**
   * Attaches the running (or already stopped) session to a server-side meeting. Recording starts
   * unlinked on purpose, so the desktop can create the meeting once it can reach the server.
   */
  linkMeeting(workspaceId: string | null, meetingId: string | null): Promise<RecorderStatus>;
  /**
   * Reads one finalized chunk as bytes so it can be uploaded. The path is validated in Rust against
   * the active session directory; the renderer cannot choose an arbitrary file.
   */
  readChunkBytes(localFile: string): Promise<Uint8Array>;
  /** Reads a chunk from a named past session, which is how a crash-recovered recording is uploaded. */
  readSessionChunk(sessionId: string, localFile: string): Promise<Uint8Array>;
  /**
   * Closes a crash-interrupted session (`interrupted` → `stopped`) and attaches it to a meeting,
   * returning its manifest so the upload queue can drain it. Audio is never touched.
   */
  prepareRecoveredUpload(
    sessionId: string,
    workspaceId: string | null,
    meetingId: string | null,
  ): Promise<RecorderManifest>;
  /** Opens an https URL in the system browser, which is where sign-in always happens. */
  openExternal(url: string): Promise<void>;
  /** Quits the app. Only callable once capture has stopped, so a live recording is never dropped. */
  finishClose(): Promise<void>;
  subscribe(
    next: (event: RecorderEvent) => void,
    onError: (error: RecorderError) => void,
  ): () => void;
}

function createTauriBridge(): RecorderBridge {
  const global = tauriGlobal();
  const invoke = global?.core?.invoke;
  const listen = global?.event?.listen;
  if (!invoke || !listen) {
    return unavailableBridge();
  }
  const call = async <T>(
    command: CommandName,
    args: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T> => {
    const value = await invoke(command, args);
    return validate(schema, what, value);
  };
  return {
    kind: 'tauri',
    refreshPermissions: () =>
      call(COMMANDS.refreshPermissions, undefined, permissionSnapshotSchema, 'permission snapshot'),
    requestPermissions: () =>
      call(COMMANDS.requestPermissions, undefined, permissionSnapshotSchema, 'permission snapshot'),
    listDevices: (kind) =>
      call(COMMANDS.listDevices, { kind }, z.array(audioDeviceSchema), 'device list'),
    openSettings: (kind) => call<void>(COMMANDS.openSettings, { kind }, z.void(), 'open settings'),
    preflight: (plannedSeconds) =>
      call(COMMANDS.preflight, { plannedSeconds }, recorderStatusSchema, 'preflight status'),
    start: (request) => {
      const parsed = validate(startRecordingRequestSchema, 'start request', request);
      return call(COMMANDS.start, { request: parsed }, recorderStatusSchema, 'status');
    },
    pause: () => call(COMMANDS.pause, undefined, recorderStatusSchema, 'status'),
    resume: () => call(COMMANDS.resume, undefined, recorderStatusSchema, 'status'),
    stop: () => call(COMMANDS.stop, undefined, recorderStatusSchema, 'status'),
    status: () => call(COMMANDS.status, undefined, recorderStatusSchema, 'status'),
    manifest: () =>
      call(COMMANDS.manifest, undefined, z.union([recorderManifestSchema, z.null()]), 'manifest'),
    markImportant: (label) => call(COMMANDS.markImportant, { label }, z.unknown(), 'marker'),
    addNote: (text) => call(COMMANDS.addNote, { text }, z.unknown(), 'note'),
    scanSessions: () =>
      call(COMMANDS.scanSessions, undefined, recoveryReportSchema, 'recovery report'),
    linkMeeting: (workspaceId, meetingId) =>
      call(
        COMMANDS.linkMeeting,
        { payload: { workspaceId, meetingId } },
        recorderStatusSchema,
        'status',
      ),
    readChunkBytes: (localFile) =>
      call(COMMANDS.readChunkBytes, { localFile }, z.string(), 'chunk bytes').then((encoded) =>
        decodeBase64(encoded),
      ),
    readSessionChunk: (sessionId, localFile) =>
      call(
        COMMANDS.readSessionChunk,
        { sessionId, localFile },
        z.string(),
        'recovered chunk bytes',
      ).then((encoded) => decodeBase64(encoded)),
    prepareRecoveredUpload: (sessionId, workspaceId, meetingId) =>
      call(
        COMMANDS.prepareRecoveredUpload,
        { payload: { sessionId, workspaceId, meetingId } },
        recorderManifestSchema,
        'recovered manifest',
      ),
    openExternal: (url) => call<void>(COMMANDS.openExternal, { url }, z.void(), 'open browser'),
    finishClose: () => call<void>(COMMANDS.finishClose, undefined, z.void(), 'close app'),
    subscribe: (next, onError) => {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void listen(EVENT_NAME, (message) => {
        if (disposed) return;
        try {
          next(validate(recorderEventSchema, 'recorder event', message.payload));
        } catch (error) {
          onError(toRecorderError(error));
        }
      })
        .then((dispose) => {
          if (disposed) dispose();
          else unlisten = dispose;
        })
        .catch((error: unknown) => onError(toRecorderError(error)));
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}

/** Everything a renderer can do without the shell: refuse, clearly. */
function unavailableBridge(): RecorderBridge {
  const fail = async (): Promise<never> => {
    throw new BridgeUnavailableError('any command');
  };
  return {
    kind: 'unavailable',
    refreshPermissions: fail,
    requestPermissions: fail,
    listDevices: fail,
    openSettings: fail,
    preflight: fail,
    start: fail,
    pause: fail,
    resume: fail,
    stop: fail,
    status: fail,
    manifest: fail,
    markImportant: fail,
    addNote: fail,
    scanSessions: fail,
    linkMeeting: fail,
    readChunkBytes: fail,
    readSessionChunk: fail,
    prepareRecoveredUpload: fail,
    openExternal: fail,
    finishClose: fail,
    subscribe: () => () => undefined,
  };
}

/** Exported for tests: a bridge the renderer can drive without a Mac. */
export function withInjectedBridge(bridge: RecorderBridge): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __recorderBridge?: RecorderBridge }).__recorderBridge = bridge;
}

export { toRecorderError, validate };
