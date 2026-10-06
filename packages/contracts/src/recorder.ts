import { z } from 'zod';

/**
 * Recorder contracts for `apps/desktop` (Phase 2: local capture only).
 *
 * These schemas are the single wire contract between the Rust session coordinator and the React
 * renderer, and they mirror the versioned local manifest of docs/recording.md §4. Rust mirrors them in
 * `crates/recorder-core/src/{manifest,session,recovery}.rs`; `tests/desktop/recorder-contract.test.ts`
 * checks that the two definitions keep the same field names, and
 * `tests/fixtures/recorder-timeline-vectors.json` pins the timeline arithmetic for both languages.
 *
 * Two rules keep the bridge honest:
 * 1. **Tick readings are decimal strings; everything else is a JSON number.** Raw monotonic ticks exceed
 *    `Number.MAX_SAFE_INTEGER`, while sample indices/counts/durations/byte sizes do not (a century of
 *    48 kHz samples is ~1.7e12).
 * 2. **No cloud vocabulary.** Nothing here mentions upload targets, storage keys being issued,
 *    transcription, or a provider. `uploadState`/`verificationState` exist only because the approved
 *    manifest in docs/recording.md §4 includes them, and the recorder can only ever write `pending`.
 */

export const RESOURCE_ID_SCHEMA_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const resourceId = () => z.string().regex(RESOURCE_ID_SCHEMA_PATTERN, 'expected a lowercase UUID');

/** Monotonic tick values exceed JSON's safe integer range, so they travel as decimal strings. */
export const bigCountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'expected an unsigned decimal integer string');

/** Sample indices, counts, durations and byte sizes are always inside `Number.MAX_SAFE_INTEGER`. */
export const countSchema = z.number().int().nonnegative();
export const hzSchema = z.number().int().min(1).max(1_000_000_000);

export const permissionStateSchema = z.enum([
  'permission_unknown',
  'permission_granted',
  'permission_denied',
  'device_unavailable',
]);
export type PermissionState = z.infer<typeof permissionStateSchema>;

export const recorderStateSchema = z.enum([
  'idle',
  'permission_check',
  'ready',
  'recording',
  'paused',
  'finalizing',
  'stopped',
  'permission_blocked',
  'device_unavailable',
  'failed',
]);
export type RecorderState = z.infer<typeof recorderStateSchema>;

export const recordingSourceKindSchema = z.enum(['microphone', 'system_audio']);
export type RecordingSourceKind = z.infer<typeof recordingSourceKindSchema>;

export const sourceHealthSchema = z.enum(['starting', 'active', 'degraded', 'unavailable']);
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

/**
 * Capture-state machine as persisted in the manifest. `state` is the field name in both the manifest and
 * the live status payload — the same word for the same thing, deliberately, so a renderer cannot show a
 * healthy source for a session whose manifest says otherwise.
 */
export const manifestStateSchema = z.enum([
  'ready',
  'recording',
  'paused',
  'finalizing',
  'stopped',
  'interrupted',
  'failed',
]);
export type ManifestState = z.infer<typeof manifestStateSchema>;

export const chunkStateSchema = z.enum([
  'finalizing',
  'finalized',
  'reconciled_from_disk',
  'salvaged_truncated',
]);
export type ChunkState = z.infer<typeof chunkStateSchema>;

/** The only container implemented in this phase; see the codec evaluation in docs/mac-recorder-acceptance.md §4. */
export const containerFormatSchema = z.enum(['wav_pcm_s16le']);
export type ContainerFormat = z.infer<typeof containerFormatSchema>;

export const CHECKSUM_SCHEMA = z.object({
  algorithm: z.literal('sha256'),
  value: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Checksum = z.infer<typeof CHECKSUM_SCHEMA>;

export const backendAvailabilitySchema = z.enum([
  'available',
  'unsupported_platform',
  'unsupported_os_version',
]);
export type BackendAvailability = z.infer<typeof backendAvailabilitySchema>;

export const audioDeviceSchema = z.object({
  uid: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  isDefault: z.boolean(),
  isAvailable: z.boolean(),
  sampleRateHz: hzSchema.optional(),
  channels: z.number().int().positive().max(32).optional(),
});
export type AudioDevice = z.infer<typeof audioDeviceSchema>;

export const permissionSnapshotSchema = z.object({
  microphone: permissionStateSchema,
  systemAudio: permissionStateSchema,
  /** ScreenCaptureKit requires macOS 13; the microphone path (AVAudioEngine) has a lower requirement. */
  availability: backendAvailabilitySchema,
  osVersion: z.string().max(64),
  minimumMacosVersion: z.string().max(32).nullish(),
  openSettingsSupported: z.boolean(),
  /** Never contains audio content or user-specific paths; only a short human-readable note. */
  detail: z.string().max(400).nullish(),
  checkedAt: z.string(),
});
export type PermissionSnapshot = z.infer<typeof permissionSnapshotSchema>;

/** Flattened on the Rust side (`#[serde(flatten)]`), so one level of keys here. */
export const sourceLevelSchema = z.object({
  kind: recordingSourceKindSchema,
  /** Peak magnitude of the most recent analysed block, 0..1. Absence is signalled by `live`, not by 0. */
  peak: z.number().min(0).max(1),
  rms: z.number().min(0).max(1),
  /** Full-scale dBFS of the block, `-120` when the block is digital silence. */
  peakDbfs: z.number().min(-120).max(0),
  clippingSamples: countSchema,
  blockSampleCount: countSchema,
  /** Whether real captured audio fed the meter (never a synthetic filler). */
  live: z.boolean(),
  /** Canonical meeting time the measurement belongs to. */
  meetingMs: countSchema,
});
export type SourceLevel = z.infer<typeof sourceLevelSchema>;

/** One uninterrupted run of samples, used to map samples onto canonical time after a pause or stall. */
export const sourceSegmentSchema = z.object({
  firstSampleIndex: countSchema,
  firstSampleTicks: bigCountSchema,
  sampleCount: countSchema,
});
export type SourceSegment = z.infer<typeof sourceSegmentSchema>;

/**
 * One logical source. Identical in the manifest (`sources[]`) and in the live status payload, which is
 * what makes a UI claim falsifiable: every number shown can be found in the durable record.
 */
export const sourceStatusSchema = z.object({
  recordingSourceId: resourceId(),
  kind: recordingSourceKindSchema,
  role: z.literal('original'),
  state: sourceHealthSchema,
  sampleRateHz: hzSchema,
  channels: z.number().int().positive().max(32),
  codec: z.literal('pcm_s16le'),
  container: z.literal('wav'),
  format: containerFormatSchema,
  deviceUid: z.string().max(128).nullable(),
  deviceName: z.string().max(160).nullable(),
  firstSampleIndex: countSchema,
  lastSampleIndexExclusive: countSchema,
  firstSampleMeetingMs: countSchema,
  lastSampleMeetingMs: countSchema.nullable(),
  /** Delivered by the device but not persisted (queue overflow / stream stall). Never hidden. */
  droppedSampleCount: countSchema,
  startedAtTicks: bigCountSchema,
  endedAtTicks: bigCountSchema.nullable(),
  sampleMap: z.array(sourceSegmentSchema).default([]),
});
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const timelineOriginSchema = z.object({
  clock: z.literal('platform_monotonic_continuous'),
  /** Readings from different epochs are never subtracted; a change means an estimated bridge gap. */
  clockEpochId: z.string().min(1).max(64),
  originTicks: bigCountSchema,
  /** Metadata only: wall-clock UTC of the origin, never used for duration. */
  originWallClockUtc: z.string(),
  tickFrequencyHz: hzSchema,
});
export type TimelineOriginPayload = z.infer<typeof timelineOriginSchema>;

export const gapReasonSchema = z.enum([
  'paused',
  'source_stopped',
  'startup_latency',
  'sleep_detected',
  'clock_epoch_changed',
]);
export type GapReason = z.infer<typeof gapReasonSchema>;

export const gapRecordSchema = z.object({
  meetingStartMs: countSchema,
  meetingEndMs: countSchema,
  /** True when the gap is inferred (clock epoch change), never when a pause was commanded. */
  estimated: z.boolean(),
  reason: gapReasonSchema,
  sourceKind: recordingSourceKindSchema.nullable(),
});
export type GapRecord = z.infer<typeof gapRecordSchema>;

export const chunkRecordSchema = z.object({
  chunkId: resourceId(),
  recordingId: resourceId(),
  recordingSourceId: resourceId(),
  sourceKind: recordingSourceKindSchema,
  sequenceNo: countSchema,
  /** Derived from (recordingId, recordingSourceId, sequenceNo) — never from the file name. */
  idempotencyKey: z.string().min(1).max(256),
  /** Session-directory-relative path, e.g. `microphone/000000.wav`. */
  localFile: z.string().min(1).max(512),
  state: chunkStateSchema,
  /** Canonical meeting interval this chunk covers; not the playable duration. */
  meetingStartMs: countSchema,
  meetingEndMs: countSchema,
  /** Playable media duration from frame count / sample rate. */
  durationMs: countSchema,
  sourceFirstSampleIndex: countSchema,
  firstSampleMonotonicTicks: bigCountSchema,
  sampleCount: countSchema,
  byteSize: countSchema,
  /** Present only for frozen files; a `finalizing` chunk must never carry a checksum. */
  checksum: CHECKSUM_SCHEMA.nullable(),
  codec: z.literal('pcm_s16le'),
  container: z.literal('wav'),
  sampleRateHz: hzSchema,
  channels: z.number().int().positive().max(32),
  /** Zero for PCM; the fields exist so a future codec cannot silently shift the timeline. */
  encoderDelaySamples: countSchema,
  encoderPaddingSamples: countSchema,
  segmentIndex: countSchema,
  finalizedAt: z.string().nullable(),
  uploadState: z.literal('pending'),
  verificationState: z.literal('pending'),
  verifiedAt: z.string().nullable(),
  /** Always null in Phase 2: no object storage is contacted offline. */
  storageKey: z.string().nullable(),
});
export type ChunkRecord = z.infer<typeof chunkRecordSchema>;

export const markerRecordSchema = z.object({
  markerId: resourceId(),
  createdAt: z.string(),
  meetingMs: countSchema,
  label: z.string().min(1).max(120),
  authorUserId: z.string().max(64).nullable(),
});
export type MarkerRecord = z.infer<typeof markerRecordSchema>;

/** Manual annotations. A note is *not* a transcript segment and never becomes one in this phase. */
export const noteRecordSchema = z.object({
  noteId: resourceId(),
  createdAt: z.string(),
  meetingMs: countSchema,
  text: z.string().min(1).max(4000),
  authorUserId: z.string().max(64).nullable(),
  kind: z.literal('manual'),
});
export type NoteRecord = z.infer<typeof noteRecordSchema>;

export const recorderManifestSchema = z.object({
  schemaVersion: z.literal(1),
  revision: countSchema,
  workspaceId: resourceId().nullable(),
  meetingId: resourceId().nullable(),
  recordingId: resourceId(),
  sessionId: resourceId(),
  state: manifestStateSchema,
  startedAt: z.string(),
  stoppedAt: z.string().nullable(),
  timeline: timelineOriginSchema,
  activeIntervals: z
    .array(
      z.object({
        startTicks: bigCountSchema,
        endTicks: bigCountSchema.nullable(),
        meetingStartMs: countSchema,
        meetingEndMs: countSchema.nullable(),
      }),
    )
    .default([]),
  pauseIntervals: z.array(gapRecordSchema).default([]),
  consent: z.object({
    acknowledgedAt: z.string(),
    policyVersion: z.string().min(1).max(32),
    participantNoticeShown: z.boolean(),
  }),
  storage: z.object({
    layoutVersion: z.number().int().positive(),
    directoryName: z.string().min(1).max(128),
    localOnly: z.literal(true),
    encryption: z.literal('os_account_and_disk_protection'),
  }),
  sources: z.array(sourceStatusSchema),
  chunks: z.array(chunkRecordSchema),
  markers: z.array(markerRecordSchema).default([]),
  notes: z.array(noteRecordSchema).default([]),
  lastUpdatedAt: z.string(),
});
export type RecorderManifest = z.infer<typeof recorderManifestSchema>;

export const recorderErrorCodeSchema = z.enum([
  'platform_unsupported',
  'permission_denied',
  'permission_unknown',
  'device_unavailable',
  'device_lost',
  'invalid_state_transition',
  'capture_start_failed',
  'capture_stalled',
  'system_audio_unavailable',
  'writer_failed',
  'manifest_conflict',
  'manifest_unreadable',
  'disk_space_insufficient',
  'disk_full',
  'not_authenticated',
  'session_not_recoverable',
  'internal_error',
]);
export type RecorderErrorCode = z.infer<typeof recorderErrorCodeSchema>;

export const recorderErrorSchema = z.object({
  code: recorderErrorCodeSchema,
  message: z.string().max(600),
  retryable: z.boolean(),
  sourceKind: recordingSourceKindSchema.nullish(),
  /** Actionable pointer required for permission-shaped faults (docs/recording.md §2). */
  openSettingsUrl: z.string().max(256).nullish(),
});
export type RecorderError = z.infer<typeof recorderErrorSchema>;

export const diskPreflightSchema = z.object({
  availableBytes: countSchema,
  requiredBytes: countSchema,
  projectedBytesPerHour: countSchema,
  sufficient: z.boolean(),
  reserveBytes: countSchema,
});
export type DiskPreflight = z.infer<typeof diskPreflightSchema>;

export const recorderStatusSchema = z.object({
  state: recorderStateSchema,
  /** Canonical meeting-relative elapsed time; includes pauses and gaps. */
  canonicalElapsedMs: countSchema,
  /** Accumulated active-capture time, excluding `paused` intervals. Not interchangeable with the field above. */
  activeCaptureMs: countSchema,
  recordingId: resourceId().nullable(),
  sessionId: resourceId().nullable(),
  /** Session directory *name*; the absolute path stays inside the host application. */
  sessionDirectory: z.string().max(512).nullable(),
  sources: z.array(sourceStatusSchema),
  levels: z.array(sourceLevelSchema),
  gaps: z.array(gapRecordSchema),
  chunkCount: countSchema,
  finalizedChunkCount: countSchema,
  lastFinalizedChunkAt: z.string().nullable(),
  /** Set when persistence failed: the UI must stop presenting the session as a healthy recording. */
  persistenceFault: recorderErrorSchema.nullable(),
  disk: diskPreflightSchema.nullable(),
  clockEpochId: z.string().max(64).nullable(),
});
export type RecorderStatus = z.infer<typeof recorderStatusSchema>;

/** One session directory as reported by the startup scan. Nothing is ever auto-discarded. */
export const sessionSummarySchema = z.object({
  sessionId: resourceId(),
  recordingId: resourceId(),
  directoryName: z.string().min(1).max(128),
  state: manifestStateSchema,
  /** `true` when the previous process did not finalize; the audio is still usable. */
  interrupted: z.boolean(),
  startedAt: z.string(),
  stoppedAt: z.string().nullable(),
  canonicalDurationMs: countSchema,
  chunkCount: countSchema,
  durableChunkCount: countSchema,
  /** Files on disk with no manifest entry, adopted by reconciliation. */
  orphanChunks: countSchema,
  /** `.partial` files that decode but are known to be truncated. */
  salvagedChunks: countSchema,
  emptyPartialRemoved: countSchema,
  markerCount: countSchema,
  noteCount: countSchema,
  sources: z.array(recordingSourceKindSchema),
  /** Capture is never resumed into an old session; only its artifacts are recovered. */
  canResumeCapture: z.boolean(),
  recoverable: z.boolean(),
  warnings: z.array(z.string().max(300)).default([]),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const recoveryReportSchema = z.object({
  scannedAt: z.string(),
  sessions: z.array(sessionSummarySchema),
  /** Unreadable or newer-schema directories: reported and left byte-for-byte untouched. */
  rejected: z
    .array(
      z.object({
        directoryName: z.string().min(1).max(128),
        reason: z.string().max(300),
      }),
    )
    .default([]),
});
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;

export const startRecordingRequestSchema = z.object({
  /** Meeting linkage is optional in Phase 2: the recorder works fully offline and unauthenticated. */
  meetingId: resourceId().optional(),
  workspaceId: resourceId().optional(),
  microphoneDeviceUid: z.string().min(1).max(128).nullish(),
  captureSystemAudio: z.boolean(),
  /** Recorded consent to capture both sources on this machine; capture refuses to start without it. */
  consentAcknowledged: z.boolean(),
  chunkIntervalMs: z.number().int().min(5_000).max(600_000).default(30_000),
});
export type StartRecordingRequest = z.infer<typeof startRecordingRequestSchema>;
export type StartRecordingRequestInput = z.input<typeof startRecordingRequestSchema>;

/**
 * Coordinator → renderer events, forwarded verbatim over `recorder://event`. Internally tagged by
 * `type` (snake_case) to mirror `RecorderEvent` in `crates/recorder-core/src/session.rs`.
 */
export const recorderEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: recorderStateSchema }),
  z.object({ type: z.literal('permissions'), snapshot: permissionSnapshotSchema }),
  z.object({ type: z.literal('levels'), levels: z.array(sourceLevelSchema) }),
  z.object({ type: z.literal('chunk_finalized'), chunk: chunkRecordSchema }),
  z.object({
    type: z.literal('annotation'),
    marker: markerRecordSchema.nullable(),
    note: noteRecordSchema.nullable(),
  }),
  z.object({ type: z.literal('recovery'), report: recoveryReportSchema }),
  z.object({ type: z.literal('fault'), error: recorderErrorSchema }),
]);
export type RecorderEvent = z.infer<typeof recorderEventSchema>;

// The command layer is intentionally thin: `apps/desktop/src-tauri` commands return `Result<T,
// RecorderErrorJson>`, so `invoke` either resolves with `T` (validated by the matching schema above) or
// rejects with a payload validated by `recorderErrorSchema`. No envelope type, so the Rust commands and
// these schemas stay structurally identical.
