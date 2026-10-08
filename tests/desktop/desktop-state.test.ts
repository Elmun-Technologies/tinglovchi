import { describe, expect, it } from 'vitest';
import {
  type ChunkRecord,
  type RecorderStatus,
  type SourceLevel,
  type SourceStatus,
  recorderStatusSchema,
} from '@suhbat/contracts';
import { copy } from '../../apps/desktop/src/copy.ts';
import {
  MAX_RECENT_CHUNKS,
  controlsFor,
  durationSummary,
  formatBytes,
  formatClock,
  initialState,
  meterPercent,
  reduce,
  sourceRows,
  type UiState,
} from '../../apps/desktop/src/state.ts';

/**
 * Renderer logic tests. These are the UI-side half of the "recording is honest" requirement: the reducer
 * must never invent progress, must distinguish silence from absence, and must stop offering healthy-session
 * controls the moment persistence fails. They run without a Mac because the reducer is pure.
 *
 * The fixtures are validated against the shared contracts on the way in, so a fixture that stops matching
 * the wire format fails here rather than producing a misleading assertion.
 */

const MIC_ID = '11111111-1111-4111-8111-111111111111';
const SYSTEM_ID = '22222222-2222-4222-8222-222222222222';
const RECORDING_ID = '33333333-3333-4333-8333-333333333333';

function source(overrides: Partial<SourceStatus> = {}): SourceStatus {
  return {
    recordingSourceId: MIC_ID,
    kind: 'microphone',
    role: 'original',
    state: 'active',
    sampleRateHz: 48_000,
    channels: 1,
    codec: 'pcm_s16le',
    container: 'wav',
    format: 'wav_pcm_s16le',
    deviceUid: 'built-in-mic',
    deviceName: 'MacBook Pro Microphone',
    firstSampleIndex: 0,
    lastSampleIndexExclusive: 1_440_000,
    firstSampleMeetingMs: 0,
    lastSampleMeetingMs: 30_000,
    droppedSampleCount: 0,
    startedAtTicks: '1000000000000',
    endedAtTicks: null,
    sampleMap: [{ firstSampleIndex: 0, firstSampleTicks: '1000000000000', sampleCount: 1_440_000 }],
    ...overrides,
  };
}

function level(overrides: Partial<SourceLevel> = {}): SourceLevel {
  return {
    kind: 'microphone',
    peak: 0.5,
    rms: 0.25,
    peakDbfs: -6.02,
    clippingSamples: 0,
    blockSampleCount: 4_800,
    live: true,
    meetingMs: 12_000,
    ...overrides,
  };
}

function status(overrides: Partial<RecorderStatus> = {}): RecorderStatus {
  return {
    state: 'recording',
    canonicalElapsedMs: 61_000,
    activeCaptureMs: 61_000,
    recordingId: RECORDING_ID,
    sessionId: null,
    sessionDirectory: 'aaaa-bbbb',
    sources: [source()],
    levels: [level()],
    gaps: [],
    chunkCount: 2,
    finalizedChunkCount: 2,
    lastFinalizedChunkAt: '2026-10-06T10:01:01Z',
    persistenceFault: null,
    disk: {
      availableBytes: 40 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      projectedBytesPerHour: 1024 ** 3,
      sufficient: true,
      reserveBytes: 2 * 1024 ** 3,
    },
    clockEpochId: 'boot-1',
    ...overrides,
  };
}

function chunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    chunkId: '44444444-4444-4444-8444-444444444444',
    recordingId: RECORDING_ID,
    recordingSourceId: MIC_ID,
    sourceKind: 'microphone',
    sequenceNo: 0,
    idempotencyKey: 'mic-0',
    localFile: 'microphone/000000.wav',
    state: 'finalized',
    meetingStartMs: 0,
    meetingEndMs: 30_000,
    durationMs: 30_000,
    sourceFirstSampleIndex: 0,
    firstSampleMonotonicTicks: '1000000000000',
    sampleCount: 1_440_000,
    byteSize: 2_880_044,
    checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    codec: 'pcm_s16le',
    container: 'wav',
    sampleRateHz: 48_000,
    channels: 1,
    encoderDelaySamples: 0,
    encoderPaddingSamples: 0,
    segmentIndex: 0,
    finalizedAt: '2026-10-06T10:00:30Z',
    uploadState: 'pending',
    verificationState: 'pending',
    verifiedAt: null,
    storageKey: null,
    ...overrides,
  };
}

function state(overrides: Partial<UiState> = {}): UiState {
  return { ...initialState, bridgeKind: 'tauri', ...overrides };
}

describe('fixtures are contract-valid', () => {
  it('status and chunk fixtures parse', () => {
    expect(() => recorderStatusSchema.parse(status())).not.toThrow();
    expect(() => recorderStatusSchema.parse(status({ state: 'paused' }))).not.toThrow();
    expect(chunk()).toMatchObject({ state: 'finalized' });
  });
});

describe('controls follow the state machine', () => {
  it('enables Start only when ready, and never invents a start from idle', () => {
    expect(
      controlsFor(state({ status: status({ state: 'ready', sources: [], levels: [] }) })).canStart,
    ).toBe(true);
    const idle = controlsFor(
      state({
        status: status({
          state: 'idle',
          sources: [],
          levels: [],
          chunkCount: 0,
          finalizedChunkCount: 0,
        }),
      }),
    );
    expect(idle.canStart).toBe(false);
    expect(idle.canStop).toBe(false);
    expect(idle.canAnnotate).toBe(false);
  });

  it('offers pause/resume/stop exactly when legal', () => {
    const recording = controlsFor(state({ status: status() }));
    expect(recording).toMatchObject({
      canPause: true,
      canResume: false,
      canStop: true,
      canAnnotate: true,
    });
    const paused = controlsFor(state({ status: status({ state: 'paused' }) }));
    expect(paused).toMatchObject({
      canPause: false,
      canResume: true,
      canStop: true,
      canAnnotate: true,
    });
    const finalizing = controlsFor(state({ status: status({ state: 'finalizing' }) }));
    expect(finalizing).toMatchObject({ canPause: false, canResume: false, canAnnotate: false });
    const blocked = controlsFor(
      state({ status: status({ state: 'permission_blocked', sources: [], levels: [] }) }),
    );
    expect(blocked.canStart).toBe(false);
    expect(blocked.blockedReason).toBe(copy.errors.microphoneDeniedDetail);
  });

  it('disables healthy-session controls the moment persistence fails', () => {
    const faulted = state({
      status: status({
        // The coordinator itself already moved to `failed`; the reducer must not soften that.
        state: 'failed',
        persistenceFault: {
          code: 'writer_failed',
          message: 'chunk write failed',
          retryable: false,
        },
      }),
    });
    const controls = controlsFor(faulted);
    expect(controls).toMatchObject({ canPause: false, canResume: false, canAnnotate: false });
    expect(controls.blockedReason).toBe(copy.errors.persistenceFailed);
  });

  it('shows a plain, non-technical message when the native bridge is missing', () => {
    const next = reduce(initialState, { type: 'bridge', kind: 'unavailable' });
    expect(next.notice?.tone).toBe('info');
    expect(next.notice?.title).toBe(copy.errors.recorderUnavailable);
    expect(next.notice?.title).not.toMatch(/bridge|npm run|debug/i);
    expect(controlsFor(next).canStart).toBe(false);
    expect(controlsFor(next).blockedReason).toBe(copy.errors.recorderUnavailable);
    expect(reduce(next, { type: 'bridge', kind: 'tauri' }).notice).toBeNull();
  });
});

describe('timers and durations', () => {
  it('keeps canonical and captured time separate and says so', () => {
    // The worked example from docs/recording.md §3: a 30-minute meeting paused for five minutes.
    const summary = durationSummary(
      status({ canonicalElapsedMs: 30 * 60_000, activeCaptureMs: 25 * 60_000 }),
    );
    expect(summary).toEqual({
      canonical: '30:00',
      active: '25:00',
      deltaLabel: '05:00 paused or missing',
    });
  });

  it('reports no gap when none exists', () => {
    expect(
      durationSummary(status({ canonicalElapsedMs: 5_000, activeCaptureMs: 5_000 }))?.deltaLabel,
    ).toBe('no gaps yet');
    expect(durationSummary(null)).toBeNull();
  });

  it('a state event alone never advances the clock', () => {
    const base = reduce(state(), {
      type: 'status',
      status: status({ state: 'ready', canonicalElapsedMs: 0, activeCaptureMs: 0 }),
    });
    const next = reduce(base, { type: 'event', event: { type: 'state', state: 'recording' } });
    expect(next.status?.state).toBe('recording');
    expect(next.status?.canonicalElapsedMs).toBe(0);
    expect(next.status?.activeCaptureMs).toBe(0);
  });

  it('before any status arrives it shows zeros rather than a fake timer', () => {
    const next = reduce(state({ status: null }), {
      type: 'event',
      event: { type: 'state', state: 'recording' },
    });
    expect(next.status).toMatchObject({
      canonicalElapsedMs: 0,
      activeCaptureMs: 0,
      sources: [],
      levels: [],
    });
  });

  it('formats clocks and byte counts predictably', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(61_000)).toBe('01:01');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(-5)).toBe('00:00');
    expect(formatBytes(2_880_044)).toBe('2.7 MB');
    expect(formatBytes(512)).toBe('512 B');
  });
});

describe('source health and meters', () => {
  it('distinguishes an absent source from a silent one', () => {
    expect(meterPercent(null)).toBe(0);
    expect(meterPercent(level({ live: false, peak: 0, rms: 0, peakDbfs: -120 }))).toBe(0);
    expect(meterPercent(level({ peak: 0.5 }))).toBe(50);
    expect(meterPercent(level({ peak: 1 }))).toBe(100);
  });

  it('reports both sources, and says unavailable rather than inventing one', () => {
    const rows = sourceRows(
      status({
        sources: [
          source(),
          source({
            recordingSourceId: SYSTEM_ID,
            kind: 'system_audio',
            channels: 2,
            state: 'unavailable',
            lastSampleIndexExclusive: 0,
            sampleMap: [],
          }),
        ],
        levels: [level(), level({ kind: 'system_audio', live: false, peak: 0, rms: 0 })],
      }),
      null,
    );
    expect(rows.map((row) => row.kind)).toEqual(['microphone', 'system_audio']);
    const [mic, system] = rows;
    expect(mic.health).toBe('active');
    expect(mic.capturedSeconds).toBeCloseTo(30, 6);
    expect(system.health).toBe('unavailable');
    expect(system.capturedSeconds).toBe(0);
    expect(system.chunks).toBe(0);
    expect(meterPercent(system.level)).toBe(0);
  });

  it('counts chunks per source from the manifest, never from events', () => {
    const manifestStatus = status({
      sources: [
        source(),
        source({ recordingSourceId: SYSTEM_ID, kind: 'system_audio', channels: 2 }),
      ],
      levels: [],
    });
    const rows = sourceRows(manifestStatus, {
      ...recorderStatusSchema.parse(manifestStatus),
      schemaVersion: 1,
      revision: 3,
      workspaceId: null,
      meetingId: null,
      recordingId: RECORDING_ID,
      sessionId: '55555555-5555-4555-8555-555555555555',
      state: 'recording',
      startedAt: '2026-10-06T10:00:00Z',
      stoppedAt: null,
      timeline: {
        clock: 'platform_monotonic_continuous',
        clockEpochId: 'boot-1',
        originTicks: '1000000000000',
        originWallClockUtc: '2026-10-06T10:00:00Z',
        tickFrequencyHz: 1_000_000_000,
      },
      activeIntervals: [],
      pauseIntervals: [],
      consent: {
        acknowledgedAt: '2026-10-06T10:00:00Z',
        policyVersion: 'v1',
        participantNoticeShown: true,
      },
      storage: {
        layoutVersion: 1,
        directoryName: '55555555-5555-4555-8555-555555555555',
        localOnly: true,
        encryption: 'os_account_and_disk_protection',
      },
      chunks: [
        chunk(),
        chunk({
          chunkId: '66666666-6666-4666-8666-666666666666',
          sourceKind: 'system_audio',
          localFile: 'system-audio/000000.wav',
        }),
      ],
      markers: [],
      notes: [],
      lastUpdatedAt: '2026-10-06T10:01:00Z',
    });
    expect(rows.map((row) => row.chunks)).toEqual([1, 1]);
  });
});

describe('event folding', () => {
  it('collects finalized chunks newest-first and caps the list', () => {
    let next = state();
    for (let index = 0; index < MAX_RECENT_CHUNKS + 6; index += 1) {
      next = reduce(next, {
        type: 'event',
        event: {
          type: 'chunk_finalized',
          chunk: chunk({
            chunkId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
            sequenceNo: index,
          }),
        },
      });
    }
    expect(next.recentChunks).toHaveLength(MAX_RECENT_CHUNKS);
    expect(next.recentChunks[0]?.sequenceNo).toBe(MAX_RECENT_CHUNKS + 5);
  });

  it('a finalized chunk never changes the counters the UI reports', () => {
    const before = reduce(state(), { type: 'status', status: status() });
    const after = reduce(before, {
      type: 'event',
      event: { type: 'chunk_finalized', chunk: chunk() },
    });
    expect(after.status?.chunkCount).toBe(before.status?.chunkCount);
    expect(after.status?.finalizedChunkCount).toBe(before.status?.finalizedChunkCount);
  });

  it('levels arrive between polls without touching anything else', () => {
    const before = reduce(state(), { type: 'status', status: status({ levels: [] }) });
    const after = reduce(before, {
      type: 'event',
      event: { type: 'levels', levels: [level({ peak: 0.25 })] },
    });
    expect(after.status?.levels[0]?.peak).toBe(0.25);
    expect(after.status?.canonicalElapsedMs).toBe(before.status?.canonicalElapsedMs);
    expect(after.status?.sources).toEqual(before.status?.sources);
  });

  it('a fault event becomes a visible notice, and a persistence fault clears only when the status says so', () => {
    const withFault = reduce(state(), {
      type: 'event',
      event: {
        type: 'fault',
        error: { code: 'disk_full', message: 'no space left on device', retryable: false },
      },
    });
    expect(withFault.notice?.tone).toBe('error');
    expect(withFault.notice?.title).toBe('Audio saqlashda muammo');
    expect(withFault.notice?.detail).not.toContain('no space left on device');
    expect(withFault.notice?.title).not.toContain('disk_full');
    const stillBroken = reduce(withFault, {
      type: 'status',
      status: status({
        persistenceFault: {
          code: 'disk_full',
          message: 'no space left on device',
          retryable: false,
        },
      }),
    });
    expect(stillBroken.notice?.tone).toBe('error');
    const recovered = reduce(withFault, { type: 'status', status: status() });
    expect(recovered.notice).toBeNull();
  });

  it('the busy flag is released when a command errors', () => {
    const busy = reduce(state(), { type: 'busy', busy: true });
    expect(busy.busy).toBe(true);
    const errored = reduce(busy, {
      type: 'error',
      error: {
        code: 'permission_denied',
        message: 'microphone access denied',
        retryable: false,
        openSettingsUrl: 'x-apple.systempreferences:mic',
      },
    });
    expect(errored.busy).toBe(false);
    expect(errored.notice?.title).toBe(copy.errors.generic);
    expect(JSON.stringify(errored.notice)).not.toContain('permission_denied');
  });
});
