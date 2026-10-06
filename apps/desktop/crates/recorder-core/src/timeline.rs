//! Canonical meeting-timeline math (docs/recording.md §3).
//!
//! This module is the Rust mirror of `packages/shared/src/timeline.ts`. Both must reproduce
//! `tests/fixtures/recorder-timeline-vectors.json` exactly (see `tests/golden_timeline.rs` here and
//! `tests/unit/shared-timeline.test.ts` in the repository). Rules:
//!
//! * `t = 0` is the monotonic reading taken when the coordinator commits `ready -> recording`. It is
//!   never reset by pause/resume and never derived from the first non-silent sample.
//! * `meeting_ms = floor((ticks - origin_ticks) * 1000 / tick_frequency_hz)`.
//! * A sample's tick is `first_sample_ticks + floor((n - first_sample_index) * tick_frequency_hz /
//!   sample_rate_hz)`. The inverse map selects the first sample at/after a canonical time.
//! * Gaps (pauses, stalls, startup latency) stay in the timeline as explicit intervals; nothing is
//!   compressed, shifted, or interpolated.
//! * Playable `duration_ms` is frame count / sample rate, never container metadata, and never a
//!   substitute for the `[start_ms, end_ms)` interval.
//!
//! All arithmetic is integer (`i128`), so no float rounding can move a boundary.

use serde::{Deserialize, Serialize};

/// Nominal frequency of the host monotonic clock used by the coordinator (nanoseconds).
pub const TICK_FREQUENCY_HZ: u128 = 1_000_000_000;

/// Floored integer division (rounds toward minus infinity, unlike Rust's truncating `/`).
pub fn floor_div(numerator: i128, denominator: i128) -> i128 {
    assert_ne!(denominator, 0, "timeline: division by zero frequency or sample rate");
    let quotient = numerator / denominator;
    if numerator % denominator != 0 && (numerator < 0) != (denominator < 0) {
        quotient - 1
    } else {
        quotient
    }
}

/// Ceiled integer division.
pub fn ceil_div(numerator: i128, denominator: i128) -> i128 {
    assert_ne!(denominator, 0, "timeline: division by zero frequency or sample rate");
    let quotient = numerator / denominator;
    if numerator % denominator != 0 && (numerator < 0) != (denominator < 0) {
        quotient + 1
    } else {
        quotient
    }
}

/// Persisted clock block of a session manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineOrigin {
    pub origin_ticks: u128,
    pub tick_frequency_hz: u128,
}

impl TimelineOrigin {
    #[must_use]
    pub const fn with_default_frequency(origin_ticks: u128) -> Self {
        Self {
            origin_ticks,
            tick_frequency_hz: TICK_FREQUENCY_HZ,
        }
    }
}

/// Serializes `u128` tick readings as decimal strings. A JSON number that large loses precision in
/// `JSON.parse`, and tick readings are never used for arithmetic in the renderer, so the string form is
/// the wire contract for every raw tick (docs/recording.md §4).
mod decimal_ticks {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse::<u128>().map_err(D::Error::custom)
    }
}

/// One uninterrupted run of decoded samples for one source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSegment {
    /// Source-global index of this segment's first sample.
    pub first_sample_index: u64,
    /// Host monotonic tick of this segment's first sample.
    #[serde(with = "decimal_ticks")]
    pub first_sample_ticks: u128,
    /// Contiguous decoded samples in this segment.
    pub sample_count: u64,
}

impl SourceSegment {
    #[must_use]
    pub fn end_sample_index(&self) -> u64 {
        self.first_sample_index + self.sample_count
    }
}

/// Everything needed to map one source's samples onto the meeting timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSampleMap {
    pub sample_rate_hz: u32,
    pub segments: Vec<SourceSegment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleToTime {
    Sample { segment_index: usize, meeting_ms: u64 },
    /// The sample index lies between two segments: audio was never delivered for it.
    Gap {
        segment_index_before: usize,
        segment_index_after: usize,
    },
    /// The sample index lies outside every segment of this source.
    Unmapped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeToSample {
    Sample { segment_index: usize, sample_index: u64 },
    /// The requested time falls in a gap; the caller should seek to `sample_index_before`.
    Gap {
        segment_index_before: usize,
        sample_index_before: u64,
    },
    /// The requested time is past the last delivered sample of this source.
    BeyondEnd { sample_index_after: u64 },
}

/// A chunk boundary produced by [`plan_chunks`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRange {
    pub segment_index: usize,
    pub first_sample_index: u64,
    pub sample_count: u64,
    pub meeting_start_ms: u64,
    pub meeting_end_ms: u64,
    pub duration_ms: u64,
}

/// Canonical meeting time of a raw monotonic tick; readings at or before `t = 0` clamp to 0.
#[must_use]
pub fn meeting_ms_from_ticks(origin: &TimelineOrigin, ticks: u128) -> u64 {
    if ticks <= origin.origin_ticks {
        return 0;
    }
    let delta = (ticks - origin.origin_ticks) as i128;
    let frequency = i128::try_from(origin.tick_frequency_hz).expect("tick frequency fits i128");
    (delta * 1000 / frequency) as u64
}

/// Smallest tick whose canonical meeting time is at or after `meeting_ms`.
#[must_use]
pub fn ticks_at_or_after_meeting_ms(origin: &TimelineOrigin, meeting_ms: u64) -> u128 {
    let frequency = i128::try_from(origin.tick_frequency_hz).expect("tick frequency fits i128");
    let delta = ceil_div(i128::try_from(meeting_ms).expect("meeting ms fits i128") * frequency, 1000);
    origin.origin_ticks + u128::try_from(delta).unwrap_or(0)
}

/// Host monotonic tick of `sample_index` within a segment (linear extrapolation outside it).
#[must_use]
pub fn sample_ticks(
    origin: &TimelineOrigin,
    sample_rate_hz: u32,
    segment: &SourceSegment,
    sample_index: i128,
) -> i128 {
    assert_ne!(sample_rate_hz, 0, "timeline: zero sample rate");
    let frequency = i128::try_from(origin.tick_frequency_hz).expect("tick frequency fits i128");
    let offset = sample_index - i128::try_from(segment.first_sample_index).expect("sample index fits i128");
    let base = i128::try_from(segment.first_sample_ticks).expect("tick value fits i128");
    base + floor_div(offset * frequency, i128::from(sample_rate_hz))
}

/// Canonical meeting time of one source sample; sample indices inside a gap are reported as gaps.
#[must_use]
pub fn meeting_ms_of_sample(map: &SourceSampleMap, origin: &TimelineOrigin, sample_index: u64) -> SampleToTime {
    for (index, segment) in map.segments.iter().enumerate() {
        if sample_index >= segment.first_sample_index && sample_index < segment.end_sample_index() {
            let ticks = sample_ticks(
                origin,
                map.sample_rate_hz,
                segment,
                i128::try_from(sample_index).expect("sample index fits i128"),
            );
            return SampleToTime::Sample {
                segment_index: index,
                meeting_ms: meeting_ms_from_ticks(origin, u128::try_from(ticks).unwrap_or(0)),
            };
        }
    }
    for index in 0..map.segments.len().saturating_sub(1) {
        let before = &map.segments[index];
        let after = &map.segments[index + 1];
        if sample_index >= before.end_sample_index() && sample_index < after.first_sample_index {
            return SampleToTime::Gap {
                segment_index_before: index,
                segment_index_after: index + 1,
            };
        }
    }
    SampleToTime::Unmapped
}

/// Deterministic inverse map: the first source sample whose canonical time is at or after
/// `meeting_ms`. Inside a gap it reports the last sample before the gap so playback can seek to
/// something real instead of inventing audio.
#[must_use]
pub fn sample_index_at_or_after(
    map: &SourceSampleMap,
    origin: &TimelineOrigin,
    meeting_ms: u64,
) -> TimeToSample {
    let target_ticks = i128::try_from(ticks_at_or_after_meeting_ms(origin, meeting_ms)).expect("tick fits i128");
    let mut last_end_sample: u64 = 0;
    for (index, segment) in map.segments.iter().enumerate() {
        let end_sample = segment.end_sample_index();
        let start_ticks = sample_ticks(
            origin,
            map.sample_rate_hz,
            segment,
            i128::try_from(segment.first_sample_index).expect("sample index fits i128"),
        );
        if target_ticks < start_ticks {
            if index == 0 {
                return TimeToSample::Gap {
                    segment_index_before: 0,
                    sample_index_before: segment.first_sample_index,
                };
            }
            return TimeToSample::Gap {
                segment_index_before: index - 1,
                sample_index_before: last_end_sample - 1,
            };
        }
        let last_ticks = sample_ticks(
            origin,
            map.sample_rate_hz,
            segment,
            i128::try_from(end_sample.saturating_sub(1)).expect("sample index fits i128"),
        );
        if target_ticks <= last_ticks {
            let rate = i128::from(map.sample_rate_hz);
            let frequency = i128::try_from(origin.tick_frequency_hz).expect("tick frequency fits i128");
            let mut candidate = i128::try_from(segment.first_sample_index).expect("sample index fits i128")
                + floor_div((target_ticks - start_ticks) * rate, frequency);
            let end_i = i128::try_from(end_sample).expect("sample index fits i128");
            let first_i = i128::try_from(segment.first_sample_index).expect("sample index fits i128");
            let ms_of = |index: i128| {
                meeting_ms_from_ticks(
                    origin,
                    u128::try_from(sample_ticks(origin, map.sample_rate_hz, segment, index)).unwrap_or(0),
                )
            };
            while candidate < end_i && ms_of(candidate) < meeting_ms {
                candidate += 1;
            }
            while candidate > first_i && ms_of(candidate - 1) >= meeting_ms {
                candidate -= 1;
            }
            return TimeToSample::Sample {
                segment_index: index,
                sample_index: u128::try_from(candidate).unwrap_or(0) as u64,
            };
        }
        last_end_sample = end_sample;
    }
    TimeToSample::BeyondEnd {
        sample_index_after: last_end_sample,
    }
}

/// Split every source segment into independently recoverable chunks of at most `target_chunk_ms` of
/// canonical time, anchored to multiples of `target_chunk_ms` from `t = 0` so concurrent sources share
/// boundaries. A chunk never spans a segment, so it never crosses a pause or a discontinuity.
#[must_use]
pub fn plan_chunks(
    map: &SourceSampleMap,
    origin: &TimelineOrigin,
    target_chunk_ms: u64,
    max_chunk_samples: Option<u64>,
) -> Vec<ChunkRange> {
    assert!(target_chunk_ms > 0, "timeline: chunk target must be positive");
    let mut chunks = Vec::new();
    for (segment_index, segment) in map.segments.iter().enumerate() {
        let end = segment.end_sample_index();
        let mut cursor = segment.first_sample_index;
        while cursor < end {
            let at_cursor = meeting_ms_of_sample(map, origin, cursor);
            let SampleToTime::Sample { meeting_ms, .. } = at_cursor else {
                panic!("timeline: chunk cursor fell outside every segment");
            };
            let boundary_end_ms = meeting_ms / target_chunk_ms * target_chunk_ms + target_chunk_ms;
            let proposed = match sample_index_at_or_after(map, origin, boundary_end_ms) {
                TimeToSample::Sample {
                    segment_index: hit,
                    sample_index,
                } if hit == segment_index => sample_index,
                _ => end,
            };
            let mut chunk_end = cursor + 1;
            if proposed > chunk_end {
                chunk_end = if proposed < end { proposed } else { end };
            }
            if let Some(max) = max_chunk_samples {
                let capped = cursor + max;
                if capped < chunk_end {
                    chunk_end = capped;
                }
            }
            let sample_count = chunk_end - cursor;
            let end_ticks = sample_ticks(
                origin,
                map.sample_rate_hz,
                segment,
                i128::try_from(chunk_end).expect("sample index fits i128"),
            );
            chunks.push(ChunkRange {
                segment_index,
                first_sample_index: cursor,
                sample_count,
                meeting_start_ms: meeting_ms,
                // Exclusive ceiling: the tick of the first sample *after* this chunk.
                meeting_end_ms: meeting_ms_from_ticks(origin, u128::try_from(end_ticks).unwrap_or(u64::MAX as u128)),
                duration_ms: sample_count * 1_000 / u64::from(map.sample_rate_hz),
            });
            cursor = chunk_end;
        }
    }
    chunks
}

/// Canonical (meeting-relative) duration: includes pauses and gaps by contract.
#[must_use]
pub fn canonical_duration_ms(origin: &TimelineOrigin, stop_ticks: u128) -> u64 {
    meeting_ms_from_ticks(origin, stop_ticks)
}

/// Accumulated active-capture time, counted once for the session and excluding `paused` intervals.
/// Deliberately not interchangeable with [`canonical_duration_ms`].
#[must_use]
pub fn active_capture_ms(intervals: &[ActiveInterval], tick_frequency_hz: u128) -> u64 {
    let mut total: i128 = 0;
    for interval in intervals {
        if let Some(end) = interval.end_ticks {
            if end > interval.start_ticks {
                total += i128::try_from(end - interval.start_ticks).unwrap_or(0);
            }
        }
    }
    u64::try_from(total * 1000 / i128::try_from(tick_frequency_hz).expect("tick frequency fits i128")).unwrap_or(0)
}

/// A period during which the recorder was in the `recording` state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActiveInterval {
    pub start_ticks: u128,
    pub end_ticks: Option<u128>,
}

/// Whether two persisted tick readings may be subtracted at all.
#[must_use]
pub fn clocks_comparable(a_epoch_id: &str, b_epoch_id: &str) -> bool {
    a_epoch_id == b_epoch_id
}

/// Reason recorded for an estimated (non-sample-accurate) gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    Paused,
    SourceStopped,
    StartupLatency,
    SleepDetected,
    ClockEpochChanged,
}

/// Input for reconstructing a gap across a restart. Never claim sample-level audio inside it.
#[derive(Debug, Clone, Copy)]
pub struct EpochBridgeInput {
    pub origin_epoch_id: String,
    pub previous_epoch_id: String,
    pub previous_segment_end_ticks: u128,
    pub next_segment_start_ticks: u128,
    pub previous_segment_end_wall_ms: u64,
    pub next_segment_start_wall_ms: u64,
}

/// Estimated gap record for an epoch bridge / sleep window.
#[must_use]
pub fn estimated_gap_record(origin: &TimelineOrigin, input: &EpochBridgeInput) -> (u64, u64, bool, GapReason) {
    let epochs_differ = input.origin_epoch_id != input.previous_epoch_id;
    let tick_delta = input.next_segment_start_ticks as i128 - input.previous_segment_end_ticks as i128;
    let wall_delta_ms = input
        .next_segment_start_wall_ms
        .saturating_sub(input.previous_segment_end_wall_ms);
    let meeting_start_ms = meeting_ms_from_ticks(origin, input.previous_segment_end_ticks);
    let estimated = if epochs_differ || tick_delta <= 0 {
        meeting_start_ms + u64::try_from(wall_delta_ms).unwrap_or(0)
    } else {
        meeting_ms_from_ticks(origin, input.next_segment_start_ticks)
    };
    let reason = if epochs_differ {
        GapReason::ClockEpochChanged
    } else {
        GapReason::SleepDetected
    };
    (
        meeting_start_ms,
        estimated.max(meeting_start_ms),
        true,
        reason,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> TimelineOrigin {
        TimelineOrigin::with_default_frequency(1_000_000_000_000)
    }

    #[test]
    fn meeting_time_floors_partial_milliseconds() {
        let origin = origin();
        assert_eq!(meeting_ms_from_ticks(&origin, origin.origin_ticks + 999_999), 0);
        assert_eq!(meeting_ms_from_ticks(&origin, origin.origin_ticks + 1_000_000), 1);
        assert_eq!(ticks_at_or_after_meeting_ms(&origin, 1), origin.origin_ticks + 1_000_000);
        assert_eq!(meeting_ms_from_ticks(&origin, origin.origin_ticks - 5), 0);
    }

    #[test]
    fn floor_and_ceil_division_agree_with_the_reference() {
        assert_eq!(floor_div(-3, 2), -2);
        assert_eq!(floor_div(3, 2), 1);
        assert_eq!(ceil_div(3, 2), 2);
        assert_eq!(ceil_div(-3, 2), -1);
        assert_eq!(floor_div(4, 2), 2);
    }

    #[test]
    fn startup_latency_stays_an_explicit_gap_and_duration_differs_from_the_interval() {
        let origin = TimelineOrigin::with_default_frequency(1_000_000_000_000);
        let map = SourceSampleMap {
            sample_rate_hz: 48_000,
            segments: vec![SourceSegment {
                first_sample_index: 0,
                first_sample_ticks: origin.origin_ticks + 20_000_000,
                sample_count: 1_439_040,
            }],
        };
        assert_eq!(
            meeting_ms_of_sample(&map, &origin, 0),
            SampleToTime::Sample {
                segment_index: 0,
                meeting_ms: 20
            }
        );
        let chunks = plan_chunks(&map, &origin, 30_000, None);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].meeting_start_ms, 20);
        assert_eq!(chunks[0].meeting_end_ms, 30_000);
        assert_eq!(chunks[0].duration_ms, 29_980);
        assert_eq!(chunks[0].sample_count, 1_439_040);
    }

    #[test]
    fn chunks_never_cross_a_pause_and_gaps_are_not_compressed() {
        let origin = origin();
        let map = SourceSampleMap {
            sample_rate_hz: 48_000,
            segments: vec![
                SourceSegment {
                    first_sample_index: 0,
                    first_sample_ticks: origin.origin_ticks,
                    sample_count: 4_320_000,
                },
                SourceSegment {
                    first_sample_index: 4_320_000,
                    first_sample_ticks: origin.origin_ticks + 120_000_000_000,
                    sample_count: 1_440_000,
                },
            ],
        };
        let chunks = plan_chunks(&map, &origin, 30_000, None);
        let intervals: Vec<(u64, u64)> = chunks
            .iter()
            .map(|chunk| (chunk.meeting_start_ms, chunk.meeting_end_ms))
            .collect();
        assert_eq!(
            intervals,
            vec![(0, 30_000), (30_000, 60_000), (60_000, 90_000), (120_000, 150_000)]
        );
    }

    #[test]
    fn seeking_into_a_gap_returns_the_last_real_sample() {
        let origin = TimelineOrigin::with_default_frequency(5_000_000_000_000);
        let map = SourceSampleMap {
            sample_rate_hz: 48_000,
            segments: vec![
                SourceSegment {
                    first_sample_index: 0,
                    first_sample_ticks: origin.origin_ticks,
                    sample_count: 1_440_000,
                },
                SourceSegment {
                    first_sample_index: 1_500_000,
                    first_sample_ticks: origin.origin_ticks + 90_000_000_000,
                    sample_count: 1_440_000,
                },
            ],
        };
        assert_eq!(
            sample_index_at_or_after(&map, &origin, 60_000),
            TimeToSample::Gap {
                segment_index_before: 0,
                sample_index_before: 1_439_999
            }
        );
        assert_eq!(
            sample_index_at_or_after(&map, &origin, 90_000),
            TimeToSample::Sample {
                segment_index: 1,
                sample_index: 1_500_000
            }
        );
        assert_eq!(
            sample_index_at_or_after(&map, &origin, 120_000),
            TimeToSample::BeyondEnd {
                sample_index_after: 2_940_000
            }
        );
        assert_eq!(
            meeting_ms_of_sample(&map, &origin, 1_445_000),
            SampleToTime::Gap {
                segment_index_before: 0,
                segment_index_after: 1
            }
        );
    }

    #[test]
    fn active_duration_excludes_pauses_while_canonical_duration_includes_them() {
        let origin = TimelineOrigin::with_default_frequency(10_000_000_000_000);
        let intervals = vec![
            ActiveInterval {
                start_ticks: origin.origin_ticks,
                end_ticks: Some(origin.origin_ticks + 600_000_000_000),
            },
            ActiveInterval {
                start_ticks: origin.origin_ticks + 900_000_000_000,
                end_ticks: Some(origin.origin_ticks + 1_800_000_000_000),
            },
        ];
        assert_eq!(active_capture_ms(&intervals, TICK_FREQUENCY_HZ), 1_500_000);
        assert_eq!(
            canonical_duration_ms(&origin, origin.origin_ticks + 1_800_000_000_000),
            1_800_000
        );
        assert_eq!(
            active_capture_ms(
                &[ActiveInterval {
                    start_ticks: origin.origin_ticks,
                    end_ticks: None
                }],
                TICK_FREQUENCY_HZ
            ),
            0
        );
    }

    #[test]
    fn epoch_bridge_marks_sleep_gaps_as_estimated() {
        let origin = TimelineOrigin::with_default_frequency(20_000_000_000_000);
        let previous_end = origin.origin_ticks + 3_600_000_000_000;
        let same_epoch = estimated_gap_record(
            &origin,
            &EpochBridgeInput {
                origin_epoch_id: "boot-1759787000".into(),
                previous_epoch_id: "boot-1759787000".into(),
                previous_segment_end_ticks: previous_end,
                next_segment_start_ticks: previous_end,
                previous_segment_end_wall_ms: 1_759_790_600_000,
                next_segment_start_wall_ms: 1_759_794_200_000,
            },
        );
        assert_eq!(same_epoch.0, 3_600_000);
        assert_eq!(same_epoch.1, 7_200_000);
        assert!(same_epoch.2);
        assert_eq!(same_epoch.3, GapReason::SleepDetected);
        assert!(!clocks_comparable("boot-1", "boot-2"));
        assert!(clocks_comparable("boot-1", "boot-1"));
    }

    #[test]
    #[should_panic(expected = "zero sample rate")]
    fn zero_sample_rate_is_rejected() {
        let origin = origin();
        let segment = SourceSegment {
            first_sample_index: 0,
            first_sample_ticks: origin.origin_ticks,
            sample_count: 10,
        };
        sample_ticks(&origin, 0, &segment, 1);
    }
}
