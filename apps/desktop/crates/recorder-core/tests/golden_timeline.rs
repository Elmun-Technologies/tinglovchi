//! Cross-language contract test: the Rust timeline implementation must reproduce the same golden
//! vectors as `packages/shared/src/timeline.ts`.
//!
//! The fixture lives at the repository root (`tests/fixtures/recorder-timeline-vectors.json`) because
//! it is shared by both languages. Expected values were produced by integer (floored) nanosecond
//! arithmetic and hand-checked; a change here that makes Rust disagree with the fixture — or with the
//! TypeScript test that reads the same file — is a canonical-timeline contract failure, not a
//! formatting difference.

use recorder_core::timeline::{
    active_capture_ms, estimated_gap_record, meeting_ms_of_sample, plan_chunks, sample_index_at_or_after, EpochBridgeInput,
    GapReason, SampleToTime, SourceSampleMap, SourceSegment, TimeToSample, TimelineOrigin,
};
use serde_json::Value;
use std::path::PathBuf;

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../tests/fixtures/recorder-timeline-vectors.json"
);

fn fixture() -> Value {
    let path = PathBuf::from(FIXTURE);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing shared golden fixture at {}: {error}", path.display()));
    serde_json::from_str(&text).expect("fixture is valid JSON")
}

fn origin(vector: &Value) -> TimelineOrigin {
    TimelineOrigin {
        origin_ticks: vector["originTicks"].as_str().expect("originTicks string").parse().expect("u128"),
        tick_frequency_hz: vector["tickFrequencyHz"]
            .as_str()
            .map(|text| text.parse::<u128>().expect("u128"))
            .unwrap_or(1_000_000_000),
    }
}

fn sample_map(vector: &Value) -> SourceSampleMap {
    let segments = vector["segments"].as_array().expect("segments array");
    SourceSampleMap {
        sample_rate_hz: vector["sampleRateHz"].as_u64().expect("sampleRateHz") as u32,
        segments: segments
            .iter()
            .map(|segment| SourceSegment {
                first_sample_index: segment["firstSampleIndex"].as_u64().expect("firstSampleIndex"),
                first_sample_ticks: segment["firstSampleTicks"].as_str().expect("ticks string").parse().expect("u128"),
                sample_count: segment["sampleCount"].as_u64().expect("sampleCount"),
            })
            .collect(),
    }
}

fn expected_chunk(chunk: &Value) -> (usize, u64, u64, u64, u64, u64) {
    (
        chunk["segmentIndex"].as_u64().expect("segmentIndex") as usize,
        chunk["firstSampleIndex"].as_u64().expect("firstSampleIndex"),
        chunk["sampleCount"].as_u64().expect("sampleCount"),
        chunk["meetingStartMs"].as_u64().expect("meetingStartMs"),
        chunk["meetingEndMs"].as_u64().expect("meetingEndMs"),
        chunk["durationMs"].as_u64().expect("durationMs"),
    )
}

fn sample_to_time(value: &Value) -> SampleToTime {
    match value["kind"].as_str().expect("kind") {
        "sample" => SampleToTime::Sample {
            segment_index: value["segmentIndex"].as_u64().expect("segmentIndex") as usize,
            meeting_ms: value["meetingMs"].as_u64().expect("meetingMs"),
        },
        "gap" => SampleToTime::Gap {
            segment_index_before: value["segmentIndexBefore"].as_u64().expect("segmentIndexBefore") as usize,
            segment_index_after: value["segmentIndexAfter"].as_u64().expect("segmentIndexAfter") as usize,
        },
        _ => SampleToTime::Unmapped,
    }
}

#[test]
fn every_golden_vector_is_reproduced() {
    let fixture = fixture();
    let vectors = fixture["vectors"].as_array().expect("vectors array");
    assert_eq!(vectors.len(), 5, "the fixture grew: mirror the new vector in the TS test too");
    for vector in vectors {
        let name = vector["name"].as_str().expect("name");
        let origin = origin(vector);
        if vector.get("segments").is_some() {
            let map = sample_map(vector);
            if let Some(expected) = vector["expected"]["meetingMsOfFirstSample"].as_u64() {
                let first = map.segments.first().expect("segment");
                assert_eq!(
                    meeting_ms_of_sample(&map, &origin, first.first_sample_index),
                    SampleToTime::Sample {
                        segment_index: 0,
                        meeting_ms: expected
                    },
                    "{name}: meetingMsOfFirstSample"
                );
            }
            for query in vector["expected"]["queriesSampleToTime"].as_array().into_iter().flatten() {
                let index = query["sampleIndex"].as_u64().expect("sampleIndex");
                assert_eq!(
                    meeting_ms_of_sample(&map, &origin, index),
                    sample_to_time(&query["expected"]),
                    "{name}: sample {index} -> time"
                );
            }
            for query in vector["expected"]["queriesTimeToSample"].as_array().into_iter().flatten() {
                let ms = query["meetingMs"].as_u64().expect("meetingMs");
                let expected = &query["expected"];
                let actual = sample_index_at_or_after(&map, &origin, ms);
                let expected = match expected["kind"].as_str().expect("kind") {
                    "sample" => TimeToSample::Sample {
                        segment_index: expected["segmentIndex"].as_u64().expect("segmentIndex") as usize,
                        sample_index: expected["sampleIndex"].as_u64().expect("sampleIndex"),
                    },
                    "gap" => TimeToSample::Gap {
                        segment_index_before: expected["segmentIndexBefore"].as_u64().expect("segmentIndexBefore") as usize,
                        sample_index_before: expected["sampleIndexBefore"].as_u64().expect("sampleIndexBefore"),
                    },
                    _ => TimeToSample::BeyondEnd {
                        sample_index_after: expected["sampleIndexAfter"].as_u64().expect("sampleIndexAfter"),
                    },
                };
                assert_eq!(actual, expected, "{name}: time {ms} -> sample");
            }
            if let Some(chunks) = vector["expected"]["chunks"].as_array() {
                let planned = plan_chunks(&map, &origin, vector["targetChunkMs"].as_u64().expect("targetChunkMs"), None);
                let actual: Vec<(usize, u64, u64, u64, u64, u64)> = planned
                    .iter()
                    .map(|chunk| {
                        (
                            chunk.segment_index,
                            chunk.first_sample_index,
                            chunk.sample_count,
                            chunk.meeting_start_ms,
                            chunk.meeting_end_ms,
                            chunk.duration_ms,
                        )
                    })
                    .collect();
                let expected: Vec<(usize, u64, u64, u64, u64, u64)> = chunks.iter().map(expected_chunk).collect();
                assert_eq!(actual, expected, "{name}: chunk plan");
            }
        }
        if let Some(intervals) = vector["activeIntervals"].as_array() {
            let parsed: Vec<recorder_core::timeline::ActiveInterval> = intervals
                .iter()
                .map(|interval| recorder_core::timeline::ActiveInterval {
                    start_ticks: interval["startTicks"].as_str().expect("startTicks").parse().expect("u128"),
                    end_ticks: interval["endTicks"]
                        .as_str()
                        .map(|text| text.parse::<u128>().expect("u128")),
                })
                .collect();
            assert_eq!(
                active_capture_ms(&parsed, origin.tick_frequency_hz),
                vector["expected"]["activeCaptureMs"].as_u64().expect("activeCaptureMs"),
                "{name}: active capture duration"
            );
            let last_end = intervals
                .last()
                .and_then(|interval| interval["endTicks"].as_str())
                .expect("last end tick")
                .parse::<u128>()
                .expect("u128");
            assert_eq!(
                recorder_core::timeline::canonical_duration_ms(&origin, last_end),
                vector["expected"]["canonicalDurationMs"].as_u64().expect("canonicalDurationMs"),
                "{name}: canonical duration"
            );
            let gaps = vector["expected"]["pauseIntervals"].as_array().expect("pauseIntervals");
            assert_eq!(gaps.len(), 1, "{name}: one pause gap expected");
            assert_eq!(gaps[0]["meetingStartMs"].as_u64().expect("start"), 600_000);
            assert_eq!(gaps[0]["meetingEndMs"].as_u64().expect("end"), 900_000);
            assert_eq!(gaps[0]["estimated"].as_bool().expect("estimated"), false);
        }
        if vector.get("previousSegmentEndTicks").is_some() {
            let input = EpochBridgeInput {
                origin_epoch_id: vector["currentEpochId"].as_str().expect("currentEpochId").into(),
                previous_epoch_id: vector["previousEpochId"].as_str().expect("previousEpochId").into(),
                previous_segment_end_ticks: vector["previousSegmentEndTicks"]
                    .as_str()
                    .expect("previousSegmentEndTicks")
                    .parse()
                    .expect("u128"),
                next_segment_start_ticks: vector["nextSegmentStartTicks"]
                    .as_str()
                    .expect("nextSegmentStartTicks")
                    .parse()
                    .expect("u128"),
                previous_segment_end_wall_ms: vector["previousSegmentEndWallMs"].as_u64().expect("wall"),
                next_segment_start_wall_ms: vector["nextSegmentStartWallMs"].as_u64().expect("wall"),
            };
            let expected = &vector["expected"]["gap"];
            let actual = estimated_gap_record(&origin, &input);
            assert_eq!(actual.0, expected["meetingStartMs"].as_u64().expect("start"), "{name}");
            assert_eq!(actual.1, expected["meetingEndMs"].as_u64().expect("end"), "{name}");
            assert!(actual.2, "{name}: the gap must be marked estimated");
            let reason = expected["reason"].as_str().expect("reason");
            let expected_reason = if reason == "sleep_detected" { GapReason::SleepDetected } else { GapReason::ClockEpochChanged };
            assert_eq!(actual.3, expected_reason, "{name}");
        }
    }
}

#[test]
fn the_acceptance_scenario_numbers_match_the_documented_example() {
    // 30-minute meeting, paused 10:00-15:00: canonical 30:00, active 25:00. Conflating the two is the
    // failure mode docs/recording.md §3 calls out explicitly.
    let origin = TimelineOrigin {
        origin_ticks: 10_000_000_000_000,
        tick_frequency_hz: 1_000_000_000,
    };
    let intervals = vec![
        recorder_core::timeline::ActiveInterval {
            start_ticks: origin.origin_ticks,
            end_ticks: Some(origin.origin_ticks + 600_000_000_000),
        },
        recorder_core::timeline::ActiveInterval {
            start_ticks: origin.origin_ticks + 900_000_000_000,
            end_ticks: Some(origin.origin_ticks + 1_800_000_000_000),
        },
    ];
    assert_eq!(active_capture_ms(&intervals, 1_000_000_000), 1_500_000);
    assert_eq!(
        recorder_core::timeline::canonical_duration_ms(&origin, origin.origin_ticks + 1_800_000_000_000),
        1_800_000
    );
}
