import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  activeCaptureMs,
  canonicalDurationMs,
  estimatedGapRecord,
  meetingMsFromTicks,
  meetingMsOfSample,
  planChunks,
  sampleIndexAtOrAfter,
  ticksAtOrAfterMeetingMs,
  type ChunkRange,
  type SourceSampleMap,
  type TimelineOrigin,
} from '../../packages/shared/src/timeline';

interface FixtureVector {
  name: string;
  originTicks: string;
  tickFrequencyHz?: string;
  sampleRateHz?: number;
  segments?: { firstSampleIndex: number; firstSampleTicks: string; sampleCount: number }[];
  targetChunkMs?: number;
  activeIntervals?: { startTicks: string; endTicks: string | null }[];
  previousEpochId?: string;
  currentEpochId?: string;
  previousSegmentEndTicks?: string;
  nextSegmentStartTicks?: string;
  previousSegmentEndWallMs?: number;
  nextSegmentStartWallMs?: number;
  expected: {
    meetingMsOfFirstSample?: number;
    chunks?: ChunkRange[];
    queriesSampleToTime?: { sampleIndex: number; expected: unknown }[];
    queriesTimeToSample?: { meetingMs: number; expected: unknown }[];
    canonicalDurationMs?: number;
    canonicalDurationMsAtSegmentEnd?: number;
    activeCaptureMs?: number;
    pauseIntervals?: unknown[];
    gap?: unknown;
  };
}

const fixturePath = fileURLToPath(
  new URL('../fixtures/recorder-timeline-vectors.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { vectors: FixtureVector[] };

function originOf(vector: FixtureVector): TimelineOrigin {
  return {
    originTicks: BigInt(vector.originTicks),
    tickFrequencyHz: BigInt(vector.tickFrequencyHz ?? '1000000000'),
  };
}

function mapOf(vector: FixtureVector): SourceSampleMap {
  return {
    sampleRateHz: vector.sampleRateHz!,
    segments: (vector.segments ?? []).map((segment) => ({
      firstSampleIndex: segment.firstSampleIndex,
      firstSampleTicks: BigInt(segment.firstSampleTicks),
      sampleCount: segment.sampleCount,
    })),
  };
}

describe('canonical timeline golden vectors', () => {
  it('has the vectors both implementations must reproduce', () => {
    expect(fixture.vectors.map((vector) => vector.name)).toEqual([
      'mic-startup-latency-and-30s-chunks',
      'pause-resume-and-dropped-samples',
      '44100-rounding-partial-final-chunk',
      'thirty-minute-meeting-with-five-minute-pause',
      'sleep-wake-epoch-bridge',
    ]);
  });

  for (const vector of fixture.vectors) {
    it(`${vector.name}`, () => {
      const origin = originOf(vector);
      if (vector.segments) {
        const map = mapOf(vector);
        if (vector.expected.meetingMsOfFirstSample !== undefined) {
          expect(meetingMsOfSample(map, origin, map.segments[0]!.firstSampleIndex)).toEqual({
            kind: 'sample',
            segmentIndex: 0,
            meetingMs: vector.expected.meetingMsOfFirstSample,
          });
        }
        for (const query of vector.expected.queriesSampleToTime ?? []) {
          expect(meetingMsOfSample(map, origin, query.sampleIndex)).toEqual(query.expected);
        }
        for (const query of vector.expected.queriesTimeToSample ?? []) {
          expect(sampleIndexAtOrAfter(map, origin, query.meetingMs)).toEqual(query.expected);
        }
        if (vector.expected.chunks) {
          expect(planChunks(map, origin, vector.targetChunkMs!)).toEqual(vector.expected.chunks);
        }
        if (vector.expected.canonicalDurationMsAtSegmentEnd !== undefined) {
          expect(vector.expected.chunks!.at(-1)!.meetingEndMs).toBe(
            vector.expected.canonicalDurationMsAtSegmentEnd,
          );
        }
      }
      if (vector.activeIntervals) {
        expect(
          activeCaptureMs(
            vector.activeIntervals.map((interval) => ({
              startTicks: BigInt(interval.startTicks),
              endTicks: interval.endTicks === null ? null : BigInt(interval.endTicks),
            })),
            BigInt(vector.tickFrequencyHz ?? '1000000000'),
          ),
        ).toBe(vector.expected.activeCaptureMs);
        expect(canonicalDurationMs(origin, BigInt(vector.activeIntervals.at(-1)!.endTicks!))).toBe(
          vector.expected.canonicalDurationMs,
        );
      }
      if (vector.previousSegmentEndTicks) {
        expect(
          estimatedGapRecord({
            originEpochId: vector.currentEpochId!,
            previousEpochId: vector.previousEpochId!,
            previousSegmentEndTicks: BigInt(vector.previousSegmentEndTicks),
            nextSegmentStartTicks: BigInt(vector.nextSegmentStartTicks!),
            previousSegmentEndWallMs: vector.previousSegmentEndWallMs!,
            nextSegmentStartWallMs: vector.nextSegmentStartWallMs!,
            origin,
          }),
        ).toEqual(vector.expected.gap);
      }
    });
  }
});

describe('canonical timeline invariants', () => {
  const origin: TimelineOrigin = {
    originTicks: 1_000_000_000_000n,
    tickFrequencyHz: 1_000_000_000n,
  };

  it('treats meeting time as floored nanoseconds so a partial millisecond never rounds up', () => {
    expect(meetingMsFromTicks(origin, origin.originTicks + 999_999n)).toBe(0);
    expect(meetingMsFromTicks(origin, origin.originTicks + 1_000_000n)).toBe(1);
    expect(ticksAtOrAfterMeetingMs(origin, 1)).toBe(origin.originTicks + 1_000_000n);
  });

  it('never produces negative or reset times across pause/resume', () => {
    const map: SourceSampleMap = {
      sampleRateHz: 48_000,
      segments: [
        { firstSampleIndex: 0, firstSampleTicks: origin.originTicks, sampleCount: 480 },
        {
          firstSampleIndex: 480,
          firstSampleTicks: origin.originTicks + 65_000_000_000n,
          sampleCount: 480,
        },
      ],
    };
    const beforePause = meetingMsOfSample(map, origin, 479);
    const afterResume = meetingMsOfSample(map, origin, 480);
    expect(beforePause).toEqual({ kind: 'sample', segmentIndex: 0, meetingMs: 9 });
    expect(afterResume).toEqual({ kind: 'sample', segmentIndex: 1, meetingMs: 65_000 });
    expect((afterResume as { meetingMs: number }).meetingMs).toBeGreaterThan(
      (beforePause as { meetingMs: number }).meetingMs,
    );
    // t=0 is not reset by pause/resume, so the first sample keeps its original offset.
    expect(meetingMsOfSample(map, origin, 0)).toEqual({
      kind: 'sample',
      segmentIndex: 0,
      meetingMs: 0,
    });
  });

  it('reports gaps instead of inventing a time for samples that were never delivered', () => {
    const map: SourceSampleMap = {
      sampleRateHz: 48_000,
      segments: [
        { firstSampleIndex: 0, firstSampleTicks: origin.originTicks, sampleCount: 480 },
        {
          firstSampleIndex: 1_000,
          firstSampleTicks: origin.originTicks + 20_000_000_000n,
          sampleCount: 480,
        },
      ],
    };
    expect(meetingMsOfSample(map, origin, 500)).toEqual({
      kind: 'gap',
      segmentIndexBefore: 0,
      segmentIndexAfter: 1,
    });
    expect(meetingMsOfSample(map, origin, 2_000)).toEqual({ kind: 'unmapped' });
  });

  it('never plans a chunk that crosses a pause or a discontinuity', () => {
    const map: SourceSampleMap = {
      sampleRateHz: 48_000,
      segments: [
        { firstSampleIndex: 0, firstSampleTicks: origin.originTicks, sampleCount: 4_320_000 },
        {
          firstSampleIndex: 4_320_000,
          firstSampleTicks: origin.originTicks + 120_000_000_000n,
          sampleCount: 1_440_000,
        },
      ],
    };
    const chunks = planChunks(map, origin, 30_000);
    expect(chunks.map((chunk) => [chunk.meetingStartMs, chunk.meetingEndMs])).toEqual([
      [0, 30_000],
      [30_000, 60_000],
      [60_000, 90_000],
      [120_000, 150_000],
    ]);
    // The 30 s canonical gap [90000,120000) is an explicit silent interval, not compressed away.
    expect(chunks.at(-1)!.meetingStartMs).toBe(120_000);
    expect(chunks.reduce((total, chunk) => total + chunk.durationMs, 0)).toBe(120_000);
  });

  it('keeps playable duration distinct from the meeting interval', () => {
    const map: SourceSampleMap = {
      sampleRateHz: 48_000,
      segments: [
        {
          firstSampleIndex: 0,
          firstSampleTicks: origin.originTicks + 20_000_000n,
          sampleCount: 1_439_040,
        },
      ],
    };
    const [chunk] = planChunks(map, origin, 30_000)!;
    expect(chunk).toMatchObject({
      meetingStartMs: 20,
      meetingEndMs: 30_000,
      durationMs: 29_980,
      sampleCount: 1_439_040,
    });
  });

  it('counts active capture time once, excluding paused intervals', () => {
    const intervals = [
      { startTicks: origin.originTicks, endTicks: origin.originTicks + 600_000_000_000n },
      {
        startTicks: origin.originTicks + 900_000_000_000n,
        endTicks: origin.originTicks + 1_800_000_000_000n,
      },
    ];
    expect(activeCaptureMs(intervals)).toBe(1_500_000);
    expect(canonicalDurationMs(origin, origin.originTicks + 1_800_000_000_000n)).toBe(1_800_000);
    // An open interval (still capturing) contributes nothing until it closes.
    expect(activeCaptureMs([{ startTicks: origin.originTicks, endTicks: null }])).toBe(0);
  });

  it('rejects malformed inputs instead of silently computing nonsense', () => {
    const map: SourceSampleMap = {
      sampleRateHz: 48_000,
      segments: [{ firstSampleIndex: 0, firstSampleTicks: origin.originTicks, sampleCount: 480 }],
    };
    expect(() => planChunks(map, origin, 0)).toThrow(RangeError);
    expect(() => sampleIndexAtOrAfter(map, origin, -1)).toThrow(RangeError);
    expect(() => meetingMsOfSample(map, origin, 1.5)).toThrow(RangeError);
    expect(() =>
      planChunks(
        {
          sampleRateHz: 0,
          segments: [{ firstSampleIndex: 0, firstSampleTicks: 0n, sampleCount: 1 }],
        },
        origin,
        10,
      ),
    ).toThrow(RangeError);
  });
});
