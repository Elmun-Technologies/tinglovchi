/**
 * Canonical meeting-timeline math (docs/recording.md §3).
 *
 * This module is the shared reference implementation of the recording timeline rules. It is
 * deliberately pure (no clocks, files, or Tauri) so it can be unit-tested with exact integers and
 * consumed by the desktop renderer for duration display and recovery summaries.
 * `apps/desktop/src-tauri/src/timeline.rs` implements the same rules in Rust against the same golden
 * vectors in `tests/fixtures/recorder-timeline-vectors.json`: a mismatch between the two is a
 * contract failure, not an implementation detail.
 *
 * Rules encoded here:
 * - `t=0` is the monotonic reading captured when the coordinator commits `ready -> recording`;
 *   pause/resume never reset or compress it.
 * - Every persisted interval is half-open `[startMs, endMs)`.
 * - `meetingMs = floor((ticks - originTicks) * 1000 / tickFrequencyHz)`.
 * - A source sample's tick is `firstSampleTicks + floor((n - firstSampleIndex) * tickFrequencyHz /
 *   sampleRateHz)`; the inverse mapping deterministically selects the first sample at/after a
 *   canonical time and reports gaps instead of interpolating across them.
 * - Playable `durationMs` is frame count / sample rate, never container metadata, and is not a
 *   substitute for the chunk's meeting interval.
 */

export const DEFAULT_TICK_FREQUENCY_HZ = 1_000_000_000n;

export interface TimelineOrigin {
  /** Monotonic tick reading captured at `ready -> recording` (`t=0`). */
  readonly originTicks: bigint;
  /** Ticks per second for `originTicks` and every sample tick used with it. */
  readonly tickFrequencyHz: bigint;
}

/**
 * One uninterrupted run of decoded samples for one source. A new segment starts after every pause,
 * device restart, stall, or other discontinuity; a chunk never spans two segments.
 */
export interface SourceSegment {
  /** Source-global index of this segment's first sample. */
  readonly firstSampleIndex: number;
  /** Host monotonic tick of this segment's first sample. */
  readonly firstSampleTicks: bigint;
  /** Number of contiguous decoded samples in this segment. */
  readonly sampleCount: number;
}

export interface SourceSampleMap {
  readonly sampleRateHz: number;
  readonly segments: readonly SourceSegment[];
}

export type SampleToTime =
  | { readonly kind: 'sample'; readonly segmentIndex: number; readonly meetingMs: number }
  | {
      readonly kind: 'gap';
      readonly segmentIndexBefore: number;
      readonly segmentIndexAfter: number;
    }
  | { readonly kind: 'unmapped' };

export type TimeToSample =
  | { readonly kind: 'sample'; readonly segmentIndex: number; readonly sampleIndex: number }
  | {
      readonly kind: 'gap';
      readonly segmentIndexBefore: number;
      readonly sampleIndexBefore: number;
    }
  | { readonly kind: 'beyondEnd'; readonly sampleIndexAfter: number };

export interface ChunkRange {
  readonly segmentIndex: number;
  readonly firstSampleIndex: number;
  readonly sampleCount: number;
  readonly meetingStartMs: number;
  readonly meetingEndMs: number;
  readonly durationMs: number;
}

/** Canonical meeting time of a raw monotonic tick; readings at or before `t=0` clamp to 0. */
export function meetingMsFromTicks(origin: TimelineOrigin, ticks: bigint): number {
  const delta = ticks - origin.originTicks;
  if (delta <= 0n) {
    return 0;
  }
  return Number((delta * 1000n) / origin.tickFrequencyHz);
}

/** Smallest tick whose canonical meeting time is at or after `meetingMs`. */
export function ticksAtOrAfterMeetingMs(origin: TimelineOrigin, meetingMs: number): bigint {
  assertNonNegativeInteger(meetingMs, 'meetingMs');
  return origin.originTicks + fdiv(BigInt(meetingMs) * origin.tickFrequencyHz, 1000n);
}

/** Host monotonic tick of `sampleIndex` within a segment (extrapolates past the segment end). */
export function sampleTicks(
  origin: TimelineOrigin,
  sampleRateHz: number,
  segment: SourceSegment,
  sampleIndex: number,
): bigint {
  assertPositiveInteger(sampleRateHz, 'sampleRateHz');
  const offset = BigInt(sampleIndex - segment.firstSampleIndex);
  return segment.firstSampleTicks + fdiv(offset * origin.tickFrequencyHz, BigInt(sampleRateHz));
}

/**
 * Canonical meeting time of one source sample. A sample index outside every segment is a gap
 * (paused, stalled, device restarted) and is reported as such rather than interpolated.
 */
export function meetingMsOfSample(
  map: SourceSampleMap,
  origin: TimelineOrigin,
  sampleIndex: number,
): SampleToTime {
  assertNonNegativeInteger(sampleIndex, 'sampleIndex');
  for (let i = 0; i < map.segments.length; i += 1) {
    const segment = map.segments[i]!;
    if (
      sampleIndex >= segment.firstSampleIndex &&
      sampleIndex < segment.firstSampleIndex + segment.sampleCount
    ) {
      const ticks = sampleTicks(origin, map.sampleRateHz, segment, sampleIndex);
      return { kind: 'sample', segmentIndex: i, meetingMs: meetingMsFromTicks(origin, ticks) };
    }
  }
  for (let i = 0; i + 1 < map.segments.length; i += 1) {
    const before = map.segments[i]!;
    const after = map.segments[i + 1]!;
    if (
      sampleIndex >= before.firstSampleIndex + before.sampleCount &&
      sampleIndex < after.firstSampleIndex
    ) {
      return { kind: 'gap', segmentIndexBefore: i, segmentIndexAfter: i + 1 };
    }
  }
  return { kind: 'unmapped' };
}

/**
 * Deterministic inverse map: the first source sample whose canonical time is at or after
 * `meetingMs`. Inside a gap it returns the last sample before the gap so callers can seek to
 * something real instead of inventing audio.
 */
export function sampleIndexAtOrAfter(
  map: SourceSampleMap,
  origin: TimelineOrigin,
  meetingMs: number,
): TimeToSample {
  assertNonNegativeInteger(meetingMs, 'meetingMs');
  const targetTicks = ticksAtOrAfterMeetingMs(origin, meetingMs);
  let lastEndSample = 0;
  for (let i = 0; i < map.segments.length; i += 1) {
    const segment = map.segments[i]!;
    const endSample = segment.firstSampleIndex + segment.sampleCount;
    const startTicks = sampleTicks(origin, map.sampleRateHz, segment, segment.firstSampleIndex);
    if (targetTicks < startTicks) {
      if (i === 0) {
        return { kind: 'gap', segmentIndexBefore: 0, sampleIndexBefore: segment.firstSampleIndex };
      }
      return { kind: 'gap', segmentIndexBefore: i - 1, sampleIndexBefore: lastEndSample - 1 };
    }
    const lastTicks = sampleTicks(origin, map.sampleRateHz, segment, endSample - 1);
    if (targetTicks <= lastTicks) {
      let candidate =
        segment.firstSampleIndex +
        Number(fdiv((targetTicks - startTicks) * BigInt(map.sampleRateHz), origin.tickFrequencyHz));
      while (
        candidate < endSample &&
        meetingMsFromTicks(origin, sampleTicks(origin, map.sampleRateHz, segment, candidate)) <
          meetingMs
      ) {
        candidate += 1;
      }
      while (
        candidate > segment.firstSampleIndex &&
        meetingMsFromTicks(origin, sampleTicks(origin, map.sampleRateHz, segment, candidate - 1)) >=
          meetingMs
      ) {
        candidate -= 1;
      }
      return { kind: 'sample', segmentIndex: i, sampleIndex: candidate };
    }
    lastEndSample = endSample;
  }
  return { kind: 'beyondEnd', sampleIndexAfter: lastEndSample };
}

/**
 * Split every source segment into independently recoverable chunks of at most `targetChunkMs` of
 * canonical time (docs/recording.md §4 configures 30 s). Chunks never cross a segment boundary, so
 * they never cross a pause or a discontinuity.
 *
 * Chunk boundaries are anchored to canonical multiples of `targetChunkMs` measured from `t=0`
 * (0, 30 000, 60 000, …) instead of each source's own first sample. Concurrent sources with
 * different startup latencies therefore share chunk boundaries, so per-source gaps stay comparable
 * and a source that starts late does not shift every later boundary.
 */
export function planChunks(
  map: SourceSampleMap,
  origin: TimelineOrigin,
  targetChunkMs: number,
  maxChunkSamples?: number,
): ChunkRange[] {
  assertPositiveInteger(targetChunkMs, 'targetChunkMs');
  const chunks: ChunkRange[] = [];
  for (let segmentIndex = 0; segmentIndex < map.segments.length; segmentIndex += 1) {
    const segment = map.segments[segmentIndex]!;
    const end = segment.firstSampleIndex + segment.sampleCount;
    let cursor = segment.firstSampleIndex;
    while (cursor < end) {
      const atCursor = meetingMsOfSample(map, origin, cursor);
      if (atCursor.kind !== 'sample') {
        throw new RangeError('timeline: chunk cursor fell outside every segment');
      }
      const boundaryEndMs =
        Math.floor(atCursor.meetingMs / targetChunkMs) * targetChunkMs + targetChunkMs;
      const limit = sampleIndexAtOrAfter(map, origin, boundaryEndMs);
      const proposed =
        limit.kind === 'sample' && limit.segmentIndex === segmentIndex ? limit.sampleIndex : end;
      let chunkEnd = Math.max(cursor + 1, Math.min(proposed, end));
      if (maxChunkSamples !== undefined) {
        assertPositiveInteger(maxChunkSamples, 'maxChunkSamples');
        chunkEnd = Math.max(cursor + 1, Math.min(chunkEnd, cursor + maxChunkSamples));
      }
      const sampleCount = chunkEnd - cursor;
      const endTicks = sampleTicks(origin, map.sampleRateHz, segment, chunkEnd);
      chunks.push({
        segmentIndex,
        firstSampleIndex: cursor,
        sampleCount,
        meetingStartMs: atCursor.meetingMs,
        meetingEndMs: meetingMsFromTicks(origin, endTicks),
        durationMs: floorDiv(BigInt(sampleCount) * 1000n, BigInt(map.sampleRateHz)),
      });
      cursor = chunkEnd;
    }
  }
  return chunks;
}

/** Canonical (meeting-relative) duration: includes pauses and gaps by contract. */
export function canonicalDurationMs(origin: TimelineOrigin, stopTicks: bigint): number {
  return meetingMsFromTicks(origin, stopTicks);
}

/**
 * Accumulated time the recorder spent actively capturing, counted once for the session and excluding
 * `paused` intervals. This is deliberately distinct from `canonicalDurationMs`.
 */
export function activeCaptureMs(
  intervals: readonly { startTicks: bigint; endTicks: bigint | null }[],
  tickFrequencyHz: bigint = DEFAULT_TICK_FREQUENCY_HZ,
): number {
  let total = 0n;
  for (const interval of intervals) {
    if (interval.endTicks !== null && interval.endTicks > interval.startTicks) {
      total += interval.endTicks - interval.startTicks;
    }
  }
  return floorDiv(total * 1000n, tickFrequencyHz);
}

/** True when both readings belong to the same monotonic epoch and may be subtracted. */
export function clocksComparable(
  a: { clockEpochId: string },
  b: { clockEpochId: string },
): boolean {
  return a.clockEpochId === b.clockEpochId;
}

/**
 * Gap record for recovery: a period where the monotonic clock did not advance while wall time did
 * (sleep/hibernate) or where epochs differ. Such gaps are always `estimated`: no sample-level audio
 * is claimed inside them.
 */
export function estimatedGapRecord(input: {
  originEpochId: string;
  previousEpochId: string;
  previousSegmentEndTicks: bigint;
  nextSegmentStartTicks: bigint;
  previousSegmentEndWallMs: number;
  nextSegmentStartWallMs: number;
  origin: TimelineOrigin;
}): {
  meetingStartMs: number;
  meetingEndMs: number;
  estimated: true;
  reason: 'clock_epoch_changed' | 'sleep_detected';
} {
  const epochsDiffer = input.originEpochId !== input.previousEpochId;
  const tickDelta = input.nextSegmentStartTicks - input.previousSegmentEndTicks;
  const wallDeltaMs = input.nextSegmentStartWallMs - input.previousSegmentEndWallMs;
  const meetingStartMs = meetingMsFromTicks(input.origin, input.previousSegmentEndTicks);
  const estimatedMeetingMs =
    epochsDiffer || tickDelta <= 0n
      ? meetingStartMs + Math.max(0, Math.round(wallDeltaMs))
      : meetingMsFromTicks(input.origin, input.nextSegmentStartTicks);
  return {
    meetingStartMs,
    meetingEndMs: Math.max(meetingStartMs, estimatedMeetingMs),
    estimated: true,
    reason: epochsDiffer ? 'clock_epoch_changed' : 'sleep_detected',
  };
}

/**
 * Playable duration in milliseconds for `sampleCount` frames at `sampleRateHz` using integer math.
 */
export function sourceSamplesToDurationMs(sampleCount: number, sampleRateHz: number): number {
  assertNonNegativeInteger(sampleCount, 'sampleCount');
  assertPositiveInteger(sampleRateHz, 'sampleRateHz');
  return floorDiv(BigInt(sampleCount) * 1000n, BigInt(sampleRateHz));
}

/**
 * Canonical meeting time in milliseconds for a sample offset from a source segment's first sample.
 */
export function meetingTimeMsFromSourceSamples(
  firstSampleMeetingMs: number,
  sampleOffsetFromFirst: number,
  sampleRateHz: number,
): number {
  assertNonNegativeInteger(firstSampleMeetingMs, 'firstSampleMeetingMs');
  assertNonNegativeInteger(sampleOffsetFromFirst, 'sampleOffsetFromFirst');
  assertPositiveInteger(sampleRateHz, 'sampleRateHz');
  return firstSampleMeetingMs + sourceSamplesToDurationMs(sampleOffsetFromFirst, sampleRateHz);
}

export type ChunkContinuityInput = {
  readonly sequence: number;
  readonly sampleRateHz: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly meetingStartMs: number;
  readonly meetingEndMs: number;
};

export type ChunkContinuityDiagnostic = {
  readonly chunkIndex: number;
  readonly kind: 'sequence_gap' | 'sample_gap' | 'meeting_time_gap';
  readonly delta: number;
};

/**
 * Validates sequence, sample-range, and meeting-time continuity across ordered chunks of a source.
 */
export function validateChunkContinuity(
  chunks: readonly ChunkContinuityInput[],
): ChunkContinuityDiagnostic[] {
  const diagnostics: ChunkContinuityDiagnostic[] = [];
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = chunks[i - 1]!;
    const curr = chunks[i]!;
    const seqDelta = curr.sequence - prev.sequence;
    if (seqDelta !== 1) {
      diagnostics.push({
        chunkIndex: i,
        kind: 'sequence_gap',
        delta: seqDelta,
      });
    }
    const sampleDelta = curr.sampleStart - prev.sampleEnd;
    if (sampleDelta !== 0) {
      diagnostics.push({
        chunkIndex: i,
        kind: 'sample_gap',
        delta: sampleDelta,
      });
    }
    const meetingDelta = curr.meetingStartMs - prev.meetingEndMs;
    if (meetingDelta !== 0) {
      diagnostics.push({
        chunkIndex: i,
        kind: 'meeting_time_gap',
        delta: meetingDelta,
      });
    }
  }
  return diagnostics;
}

function floorDiv(numerator: bigint, denominator: bigint): number {
  return Number(fdiv(numerator, denominator));
}

/** Floored bigint division (truncation toward -Infinity). */
function fdiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('timeline: division by zero frequency or sample rate');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const quotient = numerator / denominator;
  return negative && quotient * denominator !== numerator ? quotient - 1n : quotient;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`timeline: ${name} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`timeline: ${name} must be a positive integer`);
  }
}
