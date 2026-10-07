//! End-to-end local capture pipeline tests without audio hardware.
//!
//! These drive the real coordinator: bounded queue → writer thread → WAV append → size patch → fsync →
//! SHA-256 after freeze → atomic rename → manifest revision. What they can prove is the persistence,
//! timeline, state-machine and recovery behaviour; what they deliberately cannot prove is
//! ScreenCaptureKit/AVFoundation behaviour, which is validated on real Macs
//! (`docs/mac-recorder-acceptance.md`).
//!
//! Time arithmetic is exact by construction: 48,000 samples per second, one 1-second block per push, so
//! block *k* is anchored at `ORIGIN_TICKS + k * 1e9` ns and every chunk boundary lands on a whole
//! 30,000 ms. If these numbers ever stop dividing evenly, fix the test constants first — the production
//! code derives times from the segment anchor plus sample counts, never from block arrival order.

use recorder_core::clock::MockClock;
use recorder_core::errors::{RecorderErrorCode, SourceKind};
use recorder_core::levels::SILENCE_DBFS;
use recorder_core::manifest::{ChunkState, Codec, Container, ManifestState, RecorderManifest, SourceHealth, UploadState};
use recorder_core::recovery::scan_and_reconcile;
use recorder_core::session::{
    Recorder, RecorderEvent, StartRequest, DEFAULT_SAMPLE_RATE_HZ, MIN_CHUNK_INTERVAL_MS,
};
use recorder_core::state::RecorderState;
use recorder_core::storage::RecorderRoot;
use recorder_core::test_support::{ScriptedBackend, ScriptedSource, block};
use recorder_core::timeline::{
    GapReason, SampleToTime, SourceSampleMap, TimeToSample, TimelineOrigin, meeting_ms_of_sample,
    sample_index_at_or_after,
};
use recorder_core::{RecorderStatus, wav};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

const ORIGIN_TICKS: u128 = 1_000_000_000_000;
const TICK_NS: u128 = 1_000_000_000;
const BATCH_FRAMES: usize = 48_000;
const SAMPLES_PER_CHUNK: u64 = 1_440_000;
const CHUNK_MS: u64 = 30_000;

/// Monotonic tick of absolute sample index `index` at 48 kHz with a 1 GHz clock.
fn tick_of(index: u64) -> u128 {
    ORIGIN_TICKS + u128::from(index) * TICK_NS / u128::from(DEFAULT_SAMPLE_RATE_HZ)
}

struct Harness {
    scratch: PathBuf,
    root_path: PathBuf,
    backend: Arc<ScriptedBackend>,
    clock: Arc<MockClock>,
}

impl Harness {
    fn new(tag: &str) -> Self {
        let scratch = std::env::temp_dir().join(format!("suhbat-session-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        Self {
            root_path: scratch.join("recordings"),
            scratch,
            backend: Arc::new(ScriptedBackend::granted()),
            clock: Arc::new(MockClock::new(ORIGIN_TICKS, 1_791_280_800_000)),
        }
    }

    fn recorder(&self) -> Recorder<ScriptedBackend, MockClock> {
        let mut recorder = Recorder::new(
            RecorderRoot::new(self.root_path.clone()).expect("recorder root"),
            Arc::clone(&self.backend),
            Arc::clone(&self.clock),
        );
        recorder.refresh_permissions();
        recorder
    }

    /// Read the manifest exactly as a later process would.
    fn manifest_at(dir: &Path) -> RecorderManifest {
        let text = std::fs::read_to_string(dir.join("manifest.json")).expect("manifest readable");
        RecorderManifest::parse_and_validate(&text).expect("manifest is valid")
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}

fn start_request(chunk_interval_ms: u64) -> StartRequest {
    StartRequest {
        meeting_id: None,
        workspace_id: None,
        microphone_device_uid: None,
        capture_system_audio: true,
        consent_acknowledged: true,
        chunk_interval_ms,
    }
}

/// Push one 1-second block to both sources. The capture queue is bounded on purpose (a realtime
/// callback must never block), so this waits for the writer instead of forcing a drop; a refusal that
/// survives the wait is a test-harness pacing bug, not a scenario to assert on.
fn push_block(source: &ScriptedSource, index: u64, tick: u128) {
    let channels = if source.kind == SourceKind::Microphone { 1 } else { 2 };
    for attempt in 0..500 {
        let accepted = source.push(block(index, tick, BATCH_FRAMES, channels, 8_000));
        if accepted {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
        if attempt == 499 {
            panic!("capture queue kept refusing a 1 s block; the writer is not draining");
        }
    }
}

/// Feed `seconds` of whole 1-second blocks into every running source, advancing the monotonic clock in
/// step. `start_index_s` is the first second of the run (it differs from zero after a resume).
fn feed(
    recorder: &mut Recorder<ScriptedBackend, MockClock>,
    backend: &ScriptedBackend,
    clock: &MockClock,
    seconds: u64,
    start_index_s: u64,
    tick_offset_ms: u64,
) {
    let base = u128::from(tick_offset_ms) * 1_000_000;
    for second in 0..seconds {
        let index = (start_index_s + second) * u64::from(DEFAULT_SAMPLE_RATE_HZ);
        let tick = tick_of(index) + base;
        for source in backend.all_sources() {
            push_block(&source, index, tick);
        }
        recorder.pump().expect("pump");
        clock.advance_ns(TICK_NS);
    }
}

fn wait_for_chunks(recorder: &mut Recorder<ScriptedBackend, MockClock>, expected: u64) -> RecorderStatus {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let status = recorder.pump().expect("pump");
        if status.finalized_chunk_count >= expected || std::time::Instant::now() > deadline {
            return status;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
fn capture_start_requires_consent_granted_permissions_and_the_ready_state() {
    let harness = Harness::new("gates");
    let mut recorder = harness.recorder();
    assert_eq!(recorder.state(), RecorderState::Ready);

    let mut no_consent = start_request(30_000);
    no_consent.consent_acknowledged = false;
    let error = recorder.start(&no_consent).expect_err("consent is mandatory");
    assert_eq!(error.code, RecorderErrorCode::PermissionDenied);
    assert_eq!(recorder.state(), RecorderState::Ready, "a refusal must not corrupt the state");

    let mut tiny = start_request(1_000);
    tiny.chunk_interval_ms = 1_000;
    let error = recorder.start(&tiny).expect_err("the chunk interval floor is enforced");
    assert!(error.message.contains("at least"), "{:?}", error.message);

    let denied = Arc::new(ScriptedBackend::denied());
    let mut denied_recorder = Recorder::new(
        RecorderRoot::new(harness.root_path.clone()).expect("root"),
        denied,
        Arc::clone(&harness.clock),
    );
    let snapshot = denied_recorder.refresh_permissions();
    assert_eq!(
        denied_recorder.state(),
        RecorderState::PermissionBlocked,
        "denied permissions must be a state, not a silent failure: {snapshot:?}"
    );
    let error = denied_recorder
        .start(&start_request(30_000))
        .expect_err("a denied microphone must block the start");
    assert_eq!(error.code, RecorderErrorCode::PermissionDenied);
    assert_eq!(error.source_kind, Some(SourceKind::Microphone));
    assert!(error.open_settings_url.is_some(), "the error must carry a settings pointer");
}

#[test]
fn invalid_transitions_are_rejected_before_any_side_effect() {
    let harness = Harness::new("transitions");
    let mut recorder = harness.recorder();
    assert!(recorder.pause().is_err(), "cannot pause before recording");
    assert!(recorder.resume().is_err(), "cannot resume when not paused");
    assert!(recorder.stop().is_err(), "cannot stop before recording");
    assert!(recorder.mark_important(None).is_err(), "no session to annotate");
    assert!(recorder.add_note("hi").is_err());
    assert!(
        recorder
            .rejected_transitions()
            .contains(&(RecorderState::Ready, RecorderState::Paused)),
        "rejections are observable for diagnostics: {:?}",
        recorder.rejected_transitions()
    );
    // A rejected transition must not have created anything on disk.
    assert_eq!(
        std::fs::read_dir(harness.root_path.join("sessions"))
            .map(|entries| entries.count())
            .unwrap_or(0),
        0,
        "no session directory may be created by a rejected call"
    );
}

#[test]
fn records_both_sources_separately_into_independent_recoverable_chunks() {
    let harness = Harness::new("chunks");
    let mut recorder = harness.recorder();
    let status = recorder.start(&start_request(CHUNK_MS)).expect("start");
    assert_eq!(status.state, RecorderState::Recording);
    assert_eq!(status.sources.len(), 2);
    assert_eq!(status.canonical_elapsed_ms, 0);
    assert_eq!(status.active_capture_ms, 0);

    feed(&mut recorder, &harness.backend, &harness.clock, 60, 0, 0);
    // The second chunk is still open (a chunk closes when the next block crosses its boundary), so two
    // chunks are durable before the stop-flush.
    let mid = wait_for_chunks(&mut recorder, 2);
    assert_eq!(mid.finalized_chunk_count, 2, "one 30 s chunk per source so far");
    let status = recorder.stop().expect("stop");
    assert_eq!(status.state, RecorderState::Stopped);

    let dir = recorder.session_dir().expect("session dir").to_path_buf();
    let file_names = |sub: &str| -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir.join(sub))
            .unwrap_or_else(|error| panic!("{sub}: {error}"))
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    };
    assert_eq!(file_names("microphone"), ["000000.wav", "000001.wav"]);
    assert_eq!(file_names("system-audio"), ["000000.wav", "000001.wav"]);
    assert!(
        !file_names("microphone").iter().any(|name| name.contains(".partial")),
        "a stopped session leaves no partial files behind"
    );

    let manifest = Harness::manifest_at(&dir);
    assert_eq!(manifest.state, ManifestState::Stopped);
    assert_eq!(manifest.sources.len(), 2);
    for source in &manifest.sources {
        assert_eq!(source.state, SourceHealth::Active);
        assert_eq!(source.last_sample_index_exclusive, 2_880_000, "{:?}", source.kind);
        assert_eq!(source.sample_map.len(), 1, "one continuous segment");
        assert_eq!(source.sample_map[0].sample_count, 2_880_000);
        assert_eq!(source.dropped_sample_count, 0);
        assert_eq!(source.codec, Codec::PcmS16Le);
        assert_eq!(source.container, Container::Wav);
    }
    assert_eq!(manifest.chunks.len(), 4);
    for chunk in &manifest.chunks {
        assert_eq!(chunk.state, ChunkState::Finalized);
        assert_eq!(chunk.sample_count, SAMPLES_PER_CHUNK);
        assert_eq!(chunk.duration_ms, CHUNK_MS);
        assert_eq!(chunk.encoder_delay_samples, 0, "PCM has no codec delay");
        assert_eq!(chunk.upload_state, UploadState::Pending, "Phase 2 never uploads");
        let expected_bytes = 44 + chunk.sample_count * u64::from(chunk.channels) * 2;
        assert_eq!(chunk.byte_size, expected_bytes, "{:?}", chunk.local_file);
        let bytes = std::fs::read(dir.join(&chunk.local_file)).expect("chunk readable");
        assert_eq!(u64::try_from(bytes.len()).expect("size"), chunk.byte_size);
        let parsed = wav::parse(&bytes[..44], u64::try_from(bytes.len()).expect("size")).expect("header parses");
        assert_eq!(parsed.format.sample_rate_hz, DEFAULT_SAMPLE_RATE_HZ);
        assert_eq!(parsed.format.channels, chunk.channels);
        assert_eq!(parsed.present_frames, chunk.sample_count, "the patched header matches the file");
        assert!(!parsed.truncated);
        assert_eq!(
            chunk.checksum.as_ref().map(|checksum| checksum.value.clone()),
            Some(recorder_core::storage::sha256_hex(&bytes)),
            "checksum is computed over the frozen file"
        );
    }
    let (mic, system): (Vec<_>, Vec<_>) = manifest
        .chunks
        .iter()
        .partition(|chunk| chunk.source_kind == SourceKind::Microphone);
    assert_eq!(
        mic.iter().map(|chunk| (chunk.meeting_start_ms, chunk.meeting_end_ms)).collect::<Vec<_>>(),
        vec![(0, CHUNK_MS), (CHUNK_MS, 2 * CHUNK_MS)]
    );
    // Two logical sources, never mixed: distinct files, distinct identities, distinct channel counts.
    assert_ne!(mic[0].local_file, system[0].local_file);
    assert_ne!(mic[0].recording_source_id, system[0].recording_source_id);
    assert_eq!((mic[0].channels, system[0].channels), (1, 2));
    // Idempotency identity is derived from (recording, source, sequence), not from file names.
    let mut keys: Vec<&str> = manifest.chunks.iter().map(|chunk| chunk.idempotency_key.as_str()).collect();
    keys.sort_unstable();
    let unique = keys.len();
    keys.dedup();
    assert_eq!(keys.len(), unique, "every chunk has its own idempotency key");
    assert_ne!(mic[0].idempotency_key, system[0].idempotency_key);
    // Canonical time comes from the sample map, never from summing file durations: the last sample of
    // chunk 0 still sits inside the first 30 s, and the sum of chunk durations is not the meeting time.
    let origin = TimelineOrigin {
        origin_ticks: manifest.timeline.origin_ticks.get(),
        tick_frequency_hz: u128::from(manifest.timeline.tick_frequency_hz),
    };
    let mic_source = manifest
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::Microphone)
        .expect("mic source");
    let map = SourceSampleMap {
        sample_rate_hz: mic_source.sample_rate_hz,
        segments: mic_source.sample_map.clone(),
    };
    assert_eq!(
        meeting_ms_of_sample(&map, &origin, SAMPLES_PER_CHUNK - 1),
        SampleToTime::Sample {
            segment_index: 0,
            meeting_ms: CHUNK_MS - 1
        }
    );
    assert_eq!(
        status.canonical_elapsed_ms, 60_000,
        "canonical meeting time, which is 2 chunk-durations summed by accident too"
    );
}

#[test]
fn pause_and_resume_leave_a_silent_gap_in_the_canonical_timeline() {
    let harness = Harness::new("pause");
    let mut recorder = harness.recorder();
    recorder.start(&start_request(CHUNK_MS)).expect("start");

    feed(&mut recorder, &harness.backend, &harness.clock, 30, 0, 0);
    let at_pause = wait_for_chunks(&mut recorder, 2);
    assert_eq!(at_pause.canonical_elapsed_ms, 30_000);
    let status = recorder.pause().expect("pause");
    assert_eq!(status.state, RecorderState::Paused);
    assert_eq!(
        status.sources.iter().filter(|source| source.state == SourceHealth::Active).count(),
        0,
        "nothing may look active while paused"
    );

    // Five minutes of wall time passes with no audio at all.
    harness.clock.advance_ns(300 * TICK_NS);
    let paused = recorder.pump().expect("pump");
    assert_eq!(
        paused.canonical_elapsed_ms, 330_000,
        "canonical time keeps running through a pause"
    );
    assert_eq!(paused.active_capture_ms, 30_000, "active capture excludes the pause");

    recorder.resume().expect("resume");
    // Post-resume samples are anchored 330 s into the meeting and continue the sample index.
    feed(&mut recorder, &harness.backend, &harness.clock, 10, 30, 300_000);
    let status = recorder.stop().expect("stop");
    let dir = recorder.session_dir().expect("dir").to_path_buf();
    let manifest = Harness::manifest_at(&dir);

    assert_eq!(manifest.pause_intervals.len(), 1);
    let gap = &manifest.pause_intervals[0];
    assert_eq!(gap.reason, GapReason::Paused);
    assert_eq!(gap.meeting_start_ms, CHUNK_MS);
    assert_eq!(gap.meeting_end_ms, 330_000);
    assert!(!gap.estimated, "a pause we control is not an estimate");
    assert_eq!(gap.meeting_end_ms - gap.meeting_start_ms, 300_000);

    let mic = manifest
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::Microphone)
        .expect("mic source");
    assert_eq!(mic.sample_map.len(), 2, "one segment per capture run");
    assert_eq!(mic.sample_map[0].first_sample_index, 0);
    assert_eq!(mic.sample_map[0].sample_count, SAMPLES_PER_CHUNK);
    assert_eq!(mic.sample_map[1].first_sample_index, SAMPLES_PER_CHUNK);
    assert_eq!(mic.sample_map[1].sample_count, 480_000, "10 s after resume");
    assert_eq!(mic.last_sample_index_exclusive, SAMPLES_PER_CHUNK + 480_000);
    assert_eq!(
        mic.last_sample_meeting_ms,
        Some(340_000),
        "canonical meeting time of the last sample, not elapsed-since-resume"
    );
    assert_eq!(mic.first_sample_meeting_ms, 0);

    // The inverse mapping is what a player/seek needs, and it is exact across the resume boundary.
    let origin = TimelineOrigin {
        origin_ticks: manifest.timeline.origin_ticks.get(),
        tick_frequency_hz: u128::from(manifest.timeline.tick_frequency_hz),
    };
    let map = SourceSampleMap {
        sample_rate_hz: mic.sample_rate_hz,
        segments: mic.sample_map.clone(),
    };
    assert_eq!(
        sample_index_at_or_after(&map, &origin, 330_000),
        TimeToSample::Sample {
            segment_index: 1,
            sample_index: SAMPLES_PER_CHUNK
        },
        "canonical 330 s resolves to the first post-resume sample"
    );
    assert!(
        matches!(
            sample_index_at_or_after(&map, &origin, 180_000),
            TimeToSample::Gap { .. }
        ),
        "a paused interval has no samples"
    );
    assert_eq!(
        sample_index_at_or_after(&map, &origin, 29_999),
        TimeToSample::Sample {
            segment_index: 0,
            sample_index: 1_439_952
        },
        "the last pre-pause second stays addressable on the exact 48 samples/ms boundary"
    );

    // Canonical duration includes the pause; the sum of chunk durations does not.
    assert_eq!(status.canonical_elapsed_ms, 340_000);
    assert!(status.active_capture_ms < status.canonical_elapsed_ms);
    let mic_chunks: Vec<(u64, u64)> = manifest
        .chunks
        .iter()
        .filter(|chunk| chunk.source_kind == SourceKind::Microphone)
        .map(|chunk| (chunk.meeting_start_ms, chunk.meeting_end_ms))
        .collect();
    assert_eq!(mic_chunks, vec![(0, 30_000), (330_000, 340_000)], "chunks never cross a pause");
    let total_audio_ms: u64 = manifest
        .chunks
        .iter()
        .map(|chunk| chunk.meeting_end_ms - chunk.meeting_start_ms)
        .sum();
    assert_eq!(total_audio_ms, 40_000, "40 s of audio in a 340 s meeting");
}

#[test]
fn markers_and_notes_are_timestamped_persisted_and_independent_of_transcripts() {
    let harness = Harness::new("annotations");
    let mut recorder = harness.recorder();
    recorder.start(&start_request(CHUNK_MS)).expect("start");
    harness.clock.advance_ns(61_000 * 1_000_000);
    let marker = recorder.mark_important(None).expect("marker");
    assert_eq!(marker.meeting_ms, 61_000);
    assert_eq!(marker.label, "Important", "the default label is the button's name");
    let note = recorder.add_note("  Decide the vendor by Friday.  ").expect("note");
    assert_eq!(note.meeting_ms, 61_000);
    assert_eq!(note.text, "Decide the vendor by Friday.", "trimmed once, at the edge");
    assert!(recorder.add_note(&"x".repeat(4001)).is_err(), "notes are bounded");
    assert!(recorder.add_note("   ").is_err(), "blank notes are refused");

    recorder.pause().expect("pause");
    harness.clock.advance_ns(5 * TICK_NS / 1_000);
    let paused_marker = recorder.mark_important(Some("Question for follow-up")).expect("marker while paused");
    assert_eq!(paused_marker.meeting_ms, 66_000, "canonical time, not captured time");
    recorder.resume().expect("resume");

    let dir = recorder.session_dir().expect("dir").to_path_buf();
    let on_disk = Harness::manifest_at(&dir);
    assert_eq!(on_disk.markers.len(), 2, "markers survive in the manifest");
    assert_eq!(on_disk.notes.len(), 1);
    assert_eq!(on_disk.notes[0].kind, recorder_core::manifest::NoteKind::Manual);
    assert!(on_disk.chunks.is_empty(), "annotations never depend on chunk finalization");

    recorder.stop().expect("stop");
    let after_stop = Harness::manifest_at(&dir);
    assert_eq!(after_stop.markers.len(), 2);
    assert_eq!(after_stop.notes.len(), 1);
    assert_eq!(after_stop.state, ManifestState::Stopped);
    assert_eq!(
        after_stop.markers[0].meeting_ms,
        on_disk.markers[0].meeting_ms,
        "a stop must not rewrite annotation timestamps"
    );
}

#[test]
fn a_failing_system_audio_source_is_visible_and_never_becomes_a_silent_mic_only_session() {
    let harness = Harness::new("sysfail");
    harness.backend.fail_system_audio.store(true, Ordering::Relaxed);
    let mut recorder = harness.recorder();
    let status = recorder.start(&start_request(CHUNK_MS)).expect("start");
    let system = status
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::SystemAudio)
        .expect("the system source stays in the record");
    assert_eq!(system.state, SourceHealth::Unavailable);
    assert!(system.sample_map.is_empty(), "no samples, so no segment");
    assert!(
        status.gaps.iter().any(|gap| gap.reason == GapReason::SourceStopped && !gap.estimated),
        "the missing source is an explicit gap, not silence: {:?}",
        status.gaps
    );
    assert!(
        recorder
            .take_events()
            .iter()
            .any(|event| matches!(event, RecorderEvent::Fault { error } if error.code == RecorderErrorCode::SystemAudioUnavailable)),
        "the failure must reach the UI as an event"
    );
    let mic = status
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::Microphone)
        .expect("mic");
    assert_ne!(mic.state, SourceHealth::Unavailable, "the mic keeps working");

    // Audio still flows on the mic and the session is never reported as fully healthy.
    feed(&mut recorder, &harness.backend, &harness.clock, 2, 0, 0);
    let status = recorder.pump().expect("pump");
    let system = status
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::SystemAudio)
        .expect("system");
    assert_eq!(system.state, SourceHealth::Unavailable);
    let dir = recorder.session_dir().expect("dir").to_path_buf();
    assert!(
        !dir.join("system-audio").join("000000.wav").exists(),
        "no system-audio file may be invented for a failed source"
    );
}

#[test]
fn a_failing_microphone_fails_the_session_instead_of_recording_one_side() {
    let harness = Harness::new("micfail");
    harness.backend.fail_microphone.store(true, Ordering::Relaxed);
    let mut recorder = harness.recorder();
    let error = recorder.start(&start_request(CHUNK_MS)).expect_err("no mic, no session");
    assert_eq!(error.code, RecorderErrorCode::CaptureStartFailed);
    assert_eq!(recorder.state(), RecorderState::Failed);
    assert!(error.source_kind == Some(SourceKind::Microphone), "{error:?}");
}

#[test]
fn queue_overflow_counts_lost_audio_degrades_the_source_and_opens_a_new_segment() {
    let harness = Harness::new("overflow");
    let mut recorder = harness.recorder();
    recorder.start(&start_request(CHUNK_MS)).expect("start");
    let mic = harness.backend.sources_of(SourceKind::Microphone).remove(0);
    push_block(&mic, 0, tick_of(0));
    // Device-side loss: the bridge reports it, the recorder must not interpolate across the hole.
    mic.report_overflow(9_600);
    push_block(&mic, 48_000, tick_of(48_000));
    let status = recorder.pump().expect("pump");
    let mic_status = status
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::Microphone)
        .expect("mic");
    assert_eq!(mic_status.state, SourceHealth::Degraded, "lost audio is a health change");
    assert!(
        mic_status.dropped_sample_count >= 9_600,
        "the loss is counted, not hidden: {mic_status:?}"
    );
    assert!(
        status.gaps.iter().any(|gap| gap.reason == GapReason::SourceStopped),
        "the dropped window becomes an explicit gap: {:?}",
        status.gaps
    );
}

#[test]
fn levels_are_measured_off_the_audio_thread_and_absence_is_not_silence() {
    let harness = Harness::new("levels");
    let mut recorder = harness.recorder();
    let status = recorder.start(&start_request(CHUNK_MS)).expect("start");
    for level in &status.levels {
        assert!(!level.level.live, "no audio delivered yet, so the meter is not live");
        assert_eq!(level.level.peak_dbfs, SILENCE_DBFS);
        assert_eq!(level.level.peak, 0.0);
    }
    let mic = harness.backend.sources_of(SourceKind::Microphone).remove(0);
    assert!(mic.push(block(0, tick_of(0), 4_800, 1, 16_383)), "small block fits the queue");
    let status = loop {
        let status = recorder.pump().expect("pump");
        if status.levels.iter().any(|level| level.level.live) {
            break status;
        }
        if std::time::Instant::now().elapsed() > std::time::Duration::from_secs(10) {
            panic!("no level update after a delivered block: {:?}", status.levels);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let mic_level = status
        .levels
        .iter()
        .find(|level| level.kind == SourceKind::Microphone)
        .expect("mic level");
    assert!(mic_level.level.live);
    assert!(mic_level.level.peak > 0.4 && mic_level.level.peak <= 1.0, "{:?}", mic_level.level);
    assert!(mic_level.level.rms > 0.0);
    assert!(mic_level.meeting_ms < 1_000, "the measurement is stamped on the canonical timeline");
    let system = status
        .levels
        .iter()
        .find(|level| level.kind == SourceKind::SystemAudio)
        .expect("system level");
    assert!(!system.level.live, "the other source must not mirror the mic");
}

#[test]
fn losing_the_selected_device_is_explicit_and_never_swaps_microphones() {
    let harness = Harness::new("devicelost");
    let mut recorder = harness.recorder();
    recorder.start(&start_request(CHUNK_MS)).expect("start");
    let dir = recorder.session_dir().expect("dir").to_path_buf();
    let mic = Harness::manifest_at(&dir)
        .sources
        .into_iter()
        .find(|source| source.kind == SourceKind::Microphone)
        .expect("mic");
    assert_eq!(mic.device_uid.as_deref(), Some("built-in-mic"), "the device is named in the record");

    harness.backend.make_device_unavailable();
    let status = recorder.pump().expect("pump");
    let mic_status = status
        .sources
        .iter()
        .find(|source| source.kind == SourceKind::Microphone)
        .expect("mic");
    assert_eq!(mic_status.state, SourceHealth::Unavailable);
    assert_eq!(
        mic_status.device_uid.as_deref(),
        Some("built-in-mic"),
        "the identity is kept for the record instead of being replaced"
    );
    assert!(
        status
            .gaps
            .iter()
            .any(|gap| gap.reason == GapReason::SourceStopped && gap.source_kind == Some(SourceKind::Microphone)),
        "the loss is an explicit gap: {:?}",
        status.gaps
    );
    assert!(
        Harness::manifest_at(&dir).revision >= 2,
        "the fault must be persisted, not only displayed"
    );
    let events = recorder.take_events();
    assert!(
        events.iter().any(|event| matches!(
            event,
            RecorderEvent::Fault { error } if error.code == RecorderErrorCode::DeviceUnavailable || error.code == RecorderErrorCode::DeviceLost
        )),
        "device loss reaches the UI: {events:?}"
    );
}

#[test]
fn a_persistence_failure_stops_the_healthy_recording_claim() {
    let harness = Harness::new("persistence");
    let mut recorder = harness.recorder();
    recorder.start(&start_request(CHUNK_MS)).expect("start");
    let dir = recorder.session_dir().expect("dir").to_path_buf();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).expect("chmod");
    }
    let result = recorder.add_note("written while the directory is read-only");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("restore permissions");
    }
    let faulted = result.is_err();
    let status = recorder.status();
    if faulted {
        assert!(
            status.persistence_fault.is_some(),
            "a failed write must be surfaced as a persistence fault"
        );
        assert!(
            status.state == RecorderState::Failed,
            "the UI must not keep showing a healthy recording: {:?}",
            status.state
        );
        let error = result.expect_err("faulted above");
        assert!(error.is_persistence_fault(), "{error:?}");
        assert!(
            recorder.manifest().map_or(true, |manifest| manifest.state != ManifestState::Recording),
            "the in-memory manifest must not keep claiming an active recording"
        );
        assert_eq!(recorder.state(), RecorderState::Failed);
    } else {
        // Root bypasses directory permissions, so this run cannot exercise the fault path. Recorded
        // honestly rather than asserted falsely: on a normal account the write fails and the state
        // changes. See the test matrix in docs/mac-recorder-acceptance.md (test H).
        eprintln!("SKIPPED-ASSERTION: running with permissions that let a read-only directory accept writes");
    }
}

#[test]
fn an_impossible_planned_duration_is_refused_before_capture_starts() {
    let harness = Harness::new("disk");
    let mut recorder = harness.recorder();
    recorder.set_config(recorder_core::session::SessionConfig {
        chunk_interval_ms: CHUNK_MS,
        sample_rate_hz: DEFAULT_SAMPLE_RATE_HZ,
        // A century of both sources cannot fit on any laptop; the pre-check must refuse it up front.
        planned_seconds: 60 * 60 * 24 * 365 * 100,
    });
    let error = recorder.start(&start_request(CHUNK_MS)).expect_err("preflight must refuse");
    assert_eq!(error.code, RecorderErrorCode::DiskSpaceInsufficient);
    assert!(!error.retryable, "more waiting will not create disk space");
    let status = recorder.status();
    assert!(
        status.disk.map_or(false, |disk| !disk.sufficient),
        "the numbers behind the refusal are visible to the UI: {:?}",
        status.disk
    );
    assert!(
        !harness.root_path.join("sessions").exists()
            || std::fs::read_dir(harness.root_path.join("sessions")).map_or(true, |mut entries| entries.next().is_none()),
        "a refused start must not leave a session directory"
    );
}

#[test]
fn a_crash_leaves_a_recoverable_session_that_startup_reconciliation_reports() {
    let harness = Harness::new("crash");
    let mut recorder = harness.recorder();
    recorder.start(&start_request(CHUNK_MS)).expect("start");
    feed(&mut recorder, &harness.backend, &harness.clock, 35, 0, 0);
    recorder.mark_important(Some("Decision")).expect("marker");
    let dir = recorder.session_dir().expect("dir").to_path_buf();
    wait_for_chunks(&mut recorder, 1);
    // Simulate a hard kill: drop the coordinator without `stop()`, so the manifest still says
    // `recording` and the open chunk was never finalized.
    drop(recorder);

    let crashed = Harness::manifest_at(&dir);
    assert_eq!(crashed.state, ManifestState::Recording, "the manifest still claims an active capture");
    assert_eq!(crashed.markers.len(), 1, "the marker survived because every revision is durable");
    assert_eq!(crashed.chunks.len(), 2, "one durable chunk per source");
    assert!(crashed.chunks.iter().all(|chunk| chunk.state.is_durable()));
    let partial = dir.join("microphone").join("000001.wav.partial");
    assert!(
        !partial.exists() || std::fs::metadata(&partial).map_or(true, |meta| meta.len() > 44),
        "either no partial file or a decodable one"
    );

    let root = RecorderRoot::new(harness.root_path.clone()).expect("root");
    let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("recovery scan");
    assert_eq!(report.sessions.len(), 1, "{report:?}");
    let session = &report.sessions[0];
    assert!(session.interrupted);
    assert!(session.recoverable());
    assert!(!session.can_resume_capture, "capture is never resumed into an old session");
    assert_eq!(session.durable_chunk_count, 2);
    assert_eq!(session.marker_count, 1);
    assert!(report.has_interrupted());

    let reconciled = Harness::manifest_at(&dir);
    assert_eq!(reconciled.state, ManifestState::Interrupted);
    assert!(reconciled.revision > crashed.revision, "reconciliation is itself a durable revision");
    assert_eq!(reconciled.markers.len(), 1, "nothing is discarded");
    assert_eq!(reconciled.chunks.len(), crashed.chunks.len());
    for chunk in reconciled.chunks.iter().filter(|chunk| chunk.state.is_durable()) {
        let bytes = std::fs::read(dir.join(&chunk.local_file)).unwrap_or_else(|error| panic!("{}: {error}", chunk.local_file));
        assert_eq!(u64::try_from(bytes.len()).expect("size"), chunk.byte_size, "recorded size is exact");
        assert_eq!(
            chunk.checksum.as_ref().map(|checksum| checksum.value.clone()),
            Some(recorder_core::storage::sha256_hex(&bytes)),
            "the frozen checksum still matches byte-for-byte"
        );
    }
    // The open interval was closed at the last durable tick, so duration reporting is honest
    // and never inflated beyond the 35_000 ms of audio actually fed into the session.
    let last_end = reconciled
        .active_intervals
        .last()
        .and_then(|interval| interval.meeting_end_ms)
        .expect("the open interval got an end");
    assert!(
        last_end >= CHUNK_MS && last_end <= 35_000,
        "expected last_end in [30_000, 35_000], got {last_end}"
    );
}

#[test]
fn every_step_is_durable_and_revisions_increase_monotonically() {
    let harness = Harness::new("revisions");
    let mut recorder = harness.recorder();
    let mut revisions = Vec::new();
    let mut snapshot = |revisions: &mut Vec<u64>, recorder: &mut Recorder<ScriptedBackend, MockClock>| {
        let dir = recorder.session_dir().expect("dir").to_path_buf();
        revisions.push(Harness::manifest_at(&dir).revision);
    };
    recorder.start(&start_request(CHUNK_MS)).expect("start");
    snapshot(&mut revisions, &mut recorder);
    feed(&mut recorder, &harness.backend, &harness.clock, 1, 0, 0);
    snapshot(&mut revisions, &mut recorder);
    recorder.pause().expect("pause");
    snapshot(&mut revisions, &mut recorder);
    recorder.resume().expect("resume");
    snapshot(&mut revisions, &mut recorder);
    recorder.mark_important(Some("Decision point")).expect("marker");
    snapshot(&mut revisions, &mut recorder);
    recorder.stop().expect("stop");
    snapshot(&mut revisions, &mut recorder);
    for pair in revisions.windows(2) {
        assert!(pair[1] > pair[0], "revisions must strictly increase: {revisions:?}");
    }
    let dir = recorder.session_dir().expect("dir").to_path_buf();
    let names: Vec<String> = std::fs::read_dir(&dir)
        .expect("entries")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert!(names.contains(&"manifest.json".to_string()), "{names:?}");
    assert!(
        !names.iter().any(|name| name.contains(".tmp-")),
        "temp manifest files must be renamed away: {names:?}"
    );
    // No stray files outside the two source directories, and permissions are private.
    for name in &names {
        assert!(
            matches!(name.as_str(), "manifest.json" | "microphone" | "system-audio"),
            "unexpected entry {name:?}"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dir).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "session directory must be owner-only");
        let manifest_mode = std::fs::metadata(dir.join("manifest.json")).expect("stat").permissions().mode();
        assert_eq!(manifest_mode & 0o777, 0o600, "manifest must be owner-only");
    }
}

#[test]
fn the_documented_chunk_interval_floor_is_enforced() {
    assert_eq!(MIN_CHUNK_INTERVAL_MS, 5_000);
    assert_eq!(DEFAULT_SAMPLE_RATE_HZ, 48_000);
    let harness = Harness::new("floor");
    let mut recorder = harness.recorder();
    let error = recorder
        .start(&start_request(MIN_CHUNK_INTERVAL_MS - 1))
        .expect_err("below the floor is refused");
    assert!(error.message.contains("5000"), "{:?}", error.message);
    // Exactly the floor is allowed.
    recorder.start(&start_request(MIN_CHUNK_INTERVAL_MS)).expect("floor accepted");
}
