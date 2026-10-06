//! Startup recovery: find, validate, and reconcile local sessions (docs/recording.md §4 step 5).
//!
//! Rules:
//! * a session whose manifest is non-terminal (`ready|recording|paused|finalizing`) means the previous
//!   process did not finish. It is marked `interrupted`, its durable chunks are kept, and it is
//!   *reported* — never auto-discarded;
//! * a chunk file on disk that the manifest does not list is adopted after validating its container
//!   header (`reconciledFromDisk`), with its checksum computed from the frozen bytes;
//! * a `.partial` file is only kept as `salvagedTruncated` when it contains decodable audio; an empty
//!   shell is removed because it holds no data to recover;
//! * a manifest that fails validation, or whose `schemaVersion` is newer than this build, is reported
//!   as unreadable and left byte-for-byte untouched;
//! * monotonic ticks from a different clock epoch are never subtracted from current readings: the gap
//!   is recorded as estimated (see `timeline::estimated_gap_record`).

use crate::errors::{RecorderError, RecorderErrorCode, SourceKind};
use crate::manifest::{
    chunk_file_name, idempotency_key, CaptureFormat, ChunkRecord, ChunkState, Checksum, ChecksumAlgorithm, DecimalU128,
    ManifestState, RecorderManifest, SourceHealth, UploadState, VerificationState, MIN_CHUNK_BYTES,
};
use crate::storage::{join_within, set_private_file, sync_dir, write_manifest_atomic, RecorderRoot};
use crate::timeline::{meeting_ms_from_ticks, sample_ticks, TimelineOrigin};
use crate::wav;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What one session looks like after a startup scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredSession {
    pub session_id: String,
    pub recording_id: String,
    pub directory_name: String,
    /// The manifest's own state value. Named `state` (not `manifestState`) so the renderer's session
    /// summary and the session manifest use one word for one thing.
    pub state: ManifestState,
    /// `true` when the previous process did not finalize; audio is still usable.
    pub interrupted: bool,
    pub started_at: String,
    pub stopped_at: Option<String>,
    pub canonical_duration_ms: u64,
    pub chunk_count: u64,
    pub durable_chunk_count: u64,
    pub orphan_chunks: u64,
    pub salvaged_chunks: u64,
    pub empty_partial_removed: u64,
    pub marker_count: u64,
    pub note_count: u64,
    pub sources: Vec<String>,
    pub can_resume_capture: bool,
    pub warnings: Vec<String>,
}

impl RecoveredSession {
    /// Recovery is always "keep and report"; a session is recoverable even when capture cannot resume.
    #[must_use]
    pub const fn recoverable(&self) -> bool {
        self.durable_chunk_count > 0 || self.salvaged_chunks > 0 || self.marker_count > 0 || self.note_count > 0
    }
}

/// A directory the scan refused to touch, with the reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedSession {
    pub directory_name: String,
    pub reason: String,
}

/// Result of a startup scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub scanned_at: String,
    pub sessions: Vec<RecoveredSession>,
    pub rejected: Vec<RejectedSession>,
}

impl RecoveryReport {
    #[must_use]
    pub fn has_interrupted(&self) -> bool {
        self.sessions.iter().any(|session| session.interrupted)
    }
}

/// Scan the recorder root and reconcile every session directory.
///
/// `wall_clock_ms` supplies the timestamp used for `reconciledAt`-style metadata; `manifest_writer`
/// controls whether a reconciled manifest revision is persisted (it always is, except in dry runs used
/// by the UI before the user confirms).
///
/// # Errors
/// Returns [`RecorderError`] when the recorder root cannot be read.
pub fn scan_and_reconcile(
    root: &RecorderRoot,
    now_rfc3339: &str,
    persist: bool,
) -> Result<RecoveryReport, RecorderError> {
    let (session_dirs, stray) = root.candidate_session_dirs()?;
    let mut sessions = Vec::new();
    let mut rejected = Vec::new();
    for stray in stray {
        rejected.push(RejectedSession {
            directory_name: stray,
            reason: "not a session directory (name is not a session UUID or not a directory); left untouched".into(),
        });
    }
    for dir in session_dirs {
        let directory_name = dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.exists() {
            // No manifest at all: report the folder and its loose files instead of inventing a session.
            let loose = count_files(&dir);
            rejected.push(RejectedSession {
                directory_name,
                reason: format!("no manifest.json in this session directory ({loose} file(s) found); nothing was deleted"),
            });
            continue;
        }
        let text = std::fs::read_to_string(&manifest_path).map_err(RecorderError::from)?;
        let mut manifest = match RecorderManifest::parse_unvalidated(&text) {
            Ok(manifest) => manifest,
            Err(error) => {
                rejected.push(RejectedSession {
                    directory_name,
                    reason: error.message,
                });
                continue;
            }
        };
        if manifest.schema_version > crate::manifest::MANIFEST_SCHEMA_VERSION {
            rejected.push(RejectedSession {
                directory_name,
                reason: format!(
                    "manifest schemaVersion {} is newer than this build; left untouched",
                    manifest.schema_version
                ),
            });
            continue;
        }
        if let Err(error) = manifest.validate() {
            // A manifest that fails validation is reported, never rewritten: a repair could destroy
            // the only description of the audio on disk.
            rejected.push(RejectedSession {
                directory_name,
                reason: format!("manifest failed validation and was not rewritten: {}", error.message),
            });
            continue;
        }
        if manifest.revision == 0 {
            manifest.revision = 1;
        }
        let interrupted = manifest.state.is_non_terminal();
        let mut warnings = Vec::new();

        let adopted = adopt_orphan_chunks(&dir, &mut manifest, now_rfc3339, &mut warnings)?;
        let salvaged = salvage_partial_files(&dir, &mut manifest, now_rfc3339, &mut warnings)?;
        let removed = remove_empty_partials(&dir, &mut warnings);

        // Reconcile the clock epoch: a restart may have changed the monotonic epoch, in which case the
        // gap is estimated and no sample-level audio is claimed inside it.
        let current_epoch = crate::clock::SystemClock::new().epoch_id();
        if interrupted && manifest.timeline.clock_epoch_id != current_epoch {
            warnings.push(format!(
                "clock epoch changed ({} -> {}): the gap after the last durable offset is estimated from wall time",
                manifest.timeline.clock_epoch_id, current_epoch
            ));
            let last = manifest
                .sources
                .iter()
                .filter_map(|source| source.ended_at_ticks.map(|ticks| ticks.get()).or(Some(source.started_at_ticks.get())))
                .max()
                .unwrap_or(0);
            manifest.pause_intervals.push(crate::manifest::GapRecord {
                meeting_start_ms: meeting_ms_from_ticks(
                    &origin_of(&manifest),
                    u128::try_from(last).unwrap_or(0),
                ),
                meeting_end_ms: meeting_ms_from_ticks(
                    &origin_of(&manifest),
                    u128::try_from(last).unwrap_or(0),
                ),
                estimated: true,
                reason: crate::timeline::GapReason::ClockEpochChanged,
                source_kind: None,
            });
        }

        let canonical_duration_ms = if interrupted {
            // The true end is unknown: report the last durable offset, never a wall-time guess.
            last_durable_end_ms(&manifest)
        } else {
            last_durable_end_ms(&manifest)
        };
        let durable_chunk_count = manifest.chunks.iter().filter(|chunk| chunk.state.is_durable()).count() as u64;
        let session_id = manifest.session_id.clone();
        let recording_id = manifest.recording_id.clone();
        let started_at = manifest.started_at.clone();
        let stopped_at = manifest.stopped_at.clone();
        let sources = manifest
            .sources
            .iter()
            .map(|source| format!("{:?}:{}", source.kind, source.state.as_str()))
            .collect();
        let marker_count = manifest.markers.len() as u64;
        let note_count = manifest.notes.len() as u64;
        let chunk_count = manifest.chunks.len() as u64;

        if interrupted {
            manifest.state = ManifestState::Interrupted;
            manifest.revision = manifest.revision.saturating_add(1);
            manifest.last_updated_at = now_rfc3339.to_string();
            if let Some(interval) = manifest.active_intervals.last_mut() {
                if interval.end_ticks.is_none() {
                    // Close the open interval at the last durable sample time so the accounting is finite.
                    let last_ticks = manifest
                        .sources
                        .iter()
                        .filter_map(|source| source.ended_at_ticks.map(|ticks| ticks.get()))
                        .max();
                    interval.end_ticks = last_ticks.map(DecimalU128);
                    if let Some(ticks) = last_ticks {
                        interval.meeting_end_ms = Some(meeting_ms_from_ticks(&origin_of(&manifest), ticks));
                    }
                }
            }
        }
        let summary = RecoveredSession {
            session_id,
            recording_id,
            directory_name,
            state: manifest.state,
            interrupted,
            started_at,
            stopped_at,
            canonical_duration_ms,
            chunk_count,
            durable_chunk_count,
            orphan_chunks: adopted,
            salvaged_chunks: salvaged,
            empty_partial_removed: removed,
            marker_count,
            note_count,
            sources,
            // Capture is never resumed into an interrupted session in this phase: the meeting timeline
            // origin and the writer threads of the old process are gone.
            can_resume_capture: false,
            warnings,
        };
        if interrupted || adopted > 0 || salvaged > 0 || removed > 0 {
            if persist {
                manifest.validate()?;
                write_manifest_atomic(&dir, &manifest)?;
                sync_dir(&dir);
            }
        }
        sessions.push(summary);
    }
    Ok(RecoveryReport {
        scanned_at: now_rfc3339.to_string(),
        sessions,
        rejected,
    })
}

fn origin_of(manifest: &RecorderManifest) -> TimelineOrigin {
    TimelineOrigin {
        origin_ticks: manifest.timeline.origin_ticks.get(),
        tick_frequency_hz: u128::from(manifest.timeline.tick_frequency_hz),
    }
}

#[must_use]
fn last_durable_end_ms(manifest: &RecorderManifest) -> u64 {
    let origin = origin_of(manifest);
    let from_chunks = manifest.chunks.iter().map(|chunk| chunk.meeting_end_ms).max().unwrap_or(0);
    let from_intervals = manifest
        .active_intervals
        .iter()
        .map(|interval| interval.meeting_end_ms.unwrap_or(interval.meeting_start_ms))
        .max()
        .unwrap_or(0);
    from_chunks.max(from_intervals)
}

fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| entries.filter_map(Result::ok).filter(|entry| entry.path().is_file()).count())
        .unwrap_or(0)
}

/// Adopt chunk files that exist on disk but are missing from the manifest.
fn adopt_orphan_chunks(
    session_dir: &Path,
    manifest: &mut RecorderManifest,
    now_rfc3339: &str,
    warnings: &mut Vec<String>,
) -> Result<u64, RecorderError> {
    let mut adopted = 0u64;
    for kind in [SourceKind::Microphone, SourceKind::SystemAudio] {
        let directory = session_dir.join(kind.directory_name());
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut found: Vec<(u64, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|name| name.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };
            let Some(stem) = name.strip_suffix(".wav") else {
                continue;
            };
            let Ok(sequence_no) = stem.parse::<u64>() else {
                warnings.push(format!("{name}: file name is not a chunk sequence; ignored"));
                continue;
            };
            if manifest
                .chunks
                .iter()
                .any(|chunk| chunk.source_kind == kind && chunk.sequence_no == sequence_no)
            {
                continue;
            }
            found.push((sequence_no, path));
        }
        found.sort_by_key(|(sequence_no, _)| *sequence_no);
        let origin = origin_of(manifest);
        for (sequence_no, path) in found {
            let bytes = std::fs::read(&path)?;
            let file_len = u64::try_from(bytes.len()).unwrap_or(0);
            if file_len < MIN_CHUNK_BYTES {
                warnings.push(format!(
                    "{}: orphaned file is smaller than a container header; kept, not adopted",
                    path.file_name().and_then(|name| name.to_str()).unwrap_or("file")
                ));
                continue;
            }
            let parsed = match wav::parse(&bytes[..MIN_CHUNK_BYTES as usize], file_len) {
                Ok(parsed) => parsed,
                Err(error) => {
                    warnings.push(format!(
                        "{}: orphaned file is not a decodable container ({}); kept for diagnostics",
                        path.file_name().and_then(|name| name.to_str()).unwrap_or("file"),
                        error.message
                    ));
                    continue;
                }
            };
            let Some(source) = manifest.sources.iter().find(|source| source.kind == kind).cloned() else {
                warnings.push(format!(
                    "{}: no source record of this kind in the manifest; file kept",
                    path.file_name().and_then(|name| name.to_str()).unwrap_or("file")
                ));
                continue;
            };
            if parsed.format.sample_rate_hz != source.sample_rate_hz || parsed.format.channels != source.channels {
                warnings.push(format!(
                    "{}: container format disagrees with the source record; file kept, not adopted",
                    path.file_name().and_then(|name| name.to_str()).unwrap_or("file")
                ));
                continue;
            }
            let frames = parsed.present_frames;
            if frames == 0 {
                warnings.push(format!(
                    "{}: no decodable frames; file kept",
                    path.file_name().and_then(|name| name.to_str()).unwrap_or("file")
                ));
                continue;
            }
            let first_sample_index = source.last_sample_index_exclusive.max(source.first_sample_index);
            let segment_index = source.sample_map.len() as u32;
            let first_tick = sample_ticks(
                &origin,
                source.sample_rate_hz,
                &crate::timeline::SourceSegment {
                    first_sample_index,
                    first_sample_ticks: source.started_at_ticks.get(),
                    sample_count: 1,
                },
                i128::try_from(first_sample_index).unwrap_or(0),
            );
            let end_ticks = sample_ticks(
                &origin,
                source.sample_rate_hz,
                &crate::timeline::SourceSegment {
                    first_sample_index,
                    first_sample_ticks: source.started_at_ticks.get(),
                    sample_count: frames + 1,
                },
                i128::try_from(first_sample_index + frames).unwrap_or(0),
            );
            let digest = sha256_of(&bytes);
            let expected_name = chunk_file_name(kind, sequence_no, CaptureFormat::WavPcmS16Le);
            let relative = PathBuf::from(expected_name.clone());
            // Only adopt into the canonical path; if the file sits somewhere else it stays untouched.
            let on_disk_relative = path.strip_prefix(session_dir).unwrap_or(Path::new("?")).to_path_buf();
            if join_within(session_dir, &relative).is_err() || on_disk_relative != relative {
                warnings.push(format!("{expected_name}: unexpected location; file kept"));
                continue;
            }
            manifest.chunks.push(ChunkRecord {
                chunk_id: uuid::Uuid::new_v4().to_string(),
                recording_id: manifest.recording_id.clone(),
                recording_source_id: source.recording_source_id.clone(),
                source_kind: kind,
                sequence_no,
                idempotency_key: idempotency_key(&manifest.recording_id, &source.recording_source_id, sequence_no),
                local_file: expected_name,
                state: ChunkState::ReconciledFromDisk,
                meeting_start_ms: meeting_ms_from_ticks(&origin, u128::try_from(first_tick).unwrap_or(0)),
                meeting_end_ms: meeting_ms_from_ticks(&origin, u128::try_from(end_ticks).unwrap_or(0)),
                duration_ms: frames * 1_000 / u64::from(source.sample_rate_hz),
                source_first_sample_index: first_sample_index,
                first_sample_monotonic_ticks: DecimalU128(u128::try_from(first_tick).unwrap_or(0)),
                sample_count: frames,
                byte_size: file_len,
                checksum: Some(Checksum {
                    algorithm: ChecksumAlgorithm::Sha256,
                    value: digest,
                }),
                codec: crate::manifest::Codec::PcmS16Le,
                container: crate::manifest::Container::Wav,
                sample_rate_hz: source.sample_rate_hz,
                channels: source.channels,
                encoder_delay_samples: 0,
                encoder_padding_samples: 0,
                segment_index,
                finalized_at: Some(now_rfc3339.to_string()),
                upload_state: UploadState::Pending,
                verification_state: VerificationState::Pending,
                verified_at: None,
                storage_key: None,
            });
            manifest
                .sources
                .iter_mut()
                .find(|candidate| candidate.kind == kind)
                .map(|candidate| {
                    candidate.last_sample_index_exclusive = candidate.last_sample_index_exclusive.max(first_sample_index + frames);
                });
            warnings.push(format!(
                "{}: adopted orphaned chunk from disk ({} frames) and recorded it as reconciledFromDisk",
                relative.display(),
                frames
            ));
            adopted += 1;
        }
    }
    Ok(adopted)
}

/// Keep `.partial` files that contain audio, flagged as truncated. Empty shells carry no data.
fn salvage_partial_files(
    session_dir: &Path,
    manifest: &mut RecorderManifest,
    now_rfc3339: &str,
    warnings: &mut Vec<String>,
) -> Result<u64, RecorderError> {
    let mut salvaged = 0u64;
    for kind in [SourceKind::Microphone, SourceKind::SystemAudio] {
        let directory = session_dir.join(kind.directory_name());
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut partials: Vec<(u64, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(stem) = name.strip_suffix(".wav.partial") else {
                continue;
            };
            let Ok(sequence_no) = stem.parse::<u64>() else { continue };
            if manifest
                .chunks
                .iter()
                .any(|chunk| chunk.source_kind == kind && chunk.sequence_no == sequence_no)
            {
                continue;
            }
            partials.push((sequence_no, path));
        }
        partials.sort_by_key(|(sequence_no, _)| *sequence_no);
        for (sequence_no, path) in partials {
            let bytes = std::fs::read(&path)?;
            let file_len = u64::try_from(bytes.len()).unwrap_or(0);
            if file_len < MIN_CHUNK_BYTES {
                continue;
            }
            let parsed = wav::parse(&bytes[..MIN_CHUNK_BYTES as usize], file_len).ok();
            let Some(parsed) = parsed.filter(|parsed| parsed.present_frames > 0) else {
                warnings.push(format!(
                    "{}: no decodable audio in the partial file; kept for diagnostics",
                    path.file_name().and_then(|name| name.to_str()).unwrap_or("file")
                ));
                continue;
            };
            let Some(source) = manifest.sources.iter().find(|source| source.kind == kind).cloned() else {
                continue;
            };
            let frames = parsed.present_frames;
            let origin = origin_of(manifest);
            let first_sample_index = source.last_sample_index_exclusive.max(source.first_sample_index);
            let segment = crate::timeline::SourceSegment {
                first_sample_index,
                first_sample_ticks: source.started_at_ticks.get(),
                sample_count: frames + 1,
            };
            let first_tick = sample_ticks(
                &origin,
                source.sample_rate_hz,
                &segment,
                i128::try_from(first_sample_index).unwrap_or(0),
            );
            let end_tick = sample_ticks(
                &origin,
                source.sample_rate_hz,
                &segment,
                i128::try_from(first_sample_index + frames).unwrap_or(0),
            );
            // Rename in place so the artifact is clearly not a finalized chunk, then record it.
            let salvaged_name = format!("{sequence_no:06}-truncated.wav");
            let salvaged_path = path
                .parent()
                .map(|parent| parent.join(&salvaged_name))
                .ok_or_else(|| RecorderError::new(RecorderErrorCode::InternalError, "unexpected partial path", false))?;
            std::fs::rename(&path, &salvaged_path)?;
            set_private_file(&salvaged_path)?;
            let relative = salvaged_path
                .strip_prefix(session_dir)
                .unwrap_or(Path::new("?"))
                .to_path_buf();
            let digest = sha256_of(&std::fs::read(&salvaged_path)?);
            manifest.chunks.push(ChunkRecord {
                chunk_id: uuid::Uuid::new_v4().to_string(),
                recording_id: manifest.recording_id.clone(),
                recording_source_id: source.recording_source_id.clone(),
                source_kind: kind,
                sequence_no,
                idempotency_key: idempotency_key(&manifest.recording_id, &source.recording_source_id, sequence_no),
                local_file: relative.to_string_lossy().to_string(),
                state: ChunkState::SalvagedTruncated,
                meeting_start_ms: meeting_ms_from_ticks(&origin, u128::try_from(first_tick).unwrap_or(0)),
                meeting_end_ms: meeting_ms_from_ticks(&origin, u128::try_from(end_tick).unwrap_or(0)),
                duration_ms: frames * 1_000 / u64::from(source.sample_rate_hz),
                source_first_sample_index: first_sample_index,
                first_sample_monotonic_ticks: DecimalU128(u128::try_from(first_tick).unwrap_or(0)),
                sample_count: frames,
                byte_size: u64::try_from(std::fs::metadata(&salvaged_path).map(|metadata| metadata.len()).unwrap_or(0))
                    .unwrap_or(0),
                checksum: Some(Checksum {
                    algorithm: ChecksumAlgorithm::Sha256,
                    value: digest,
                }),
                codec: crate::manifest::Codec::PcmS16Le,
                container: crate::manifest::Container::Wav,
                sample_rate_hz: source.sample_rate_hz,
                channels: source.channels,
                encoder_delay_samples: 0,
                encoder_padding_samples: 0,
                segment_index: source.sample_map.len() as u32,
                finalized_at: Some(now_rfc3339.to_string()),
                upload_state: UploadState::Pending,
                verification_state: VerificationState::Pending,
                verified_at: None,
                storage_key: None,
            });
            warnings.push(format!(
                "{}: salvaged a truncated partial chunk ({} frames); the remainder is an explicit gap",
                relative.display(),
                frames
            ));
            manifest.pause_intervals.push(crate::manifest::GapRecord {
                meeting_start_ms: meeting_ms_from_ticks(&origin, u128::try_from(end_tick).unwrap_or(0)),
                meeting_end_ms: meeting_ms_from_ticks(&origin, u128::try_from(end_tick).unwrap_or(0)),
                estimated: true,
                reason: crate::timeline::GapReason::SourceStopped,
                source_kind: Some(kind),
            });
            salvaged += 1;
        }
    }
    Ok(salvaged)
}

/// Delete only zero-payload `.partial` shells; audio-bearing files are never removed.
fn remove_empty_partials(session_dir: &Path, warnings: &mut Vec<String>) -> u64 {
    let mut removed = 0u64;
    for kind in [SourceKind::Microphone, SourceKind::SystemAudio] {
        let Ok(entries) = std::fs::read_dir(session_dir.join(kind.directory_name())) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_partial = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".wav.partial"));
            if !is_partial {
                continue;
            }
            let len = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(u64::MAX);
            if len <= MIN_CHUNK_BYTES {
                if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                    warnings.push(format!(
                        "{}: removed an empty partial file (no audio samples were ever written)",
                        path.file_name().and_then(|name| name.to_str()).unwrap_or("file")
                    ));
                }
            }
        }
    }
    removed
}

fn sha256_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::fixtures::valid_manifest;
    use crate::storage::write_manifest_atomic;
    use crate::wav::WavFormat;

    /// Removes the scratch directory when the test finishes.
    struct Scratch {
        dir: PathBuf,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_root(tag: &str) -> (Scratch, RecorderRoot) {
        let dir = std::env::temp_dir().join(format!("suhbat-recovery-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp root");
        let root = RecorderRoot::new(&dir).expect("root");
        (Scratch { dir: dir.clone() }, root)
    }

    fn session(root: &RecorderRoot, manifest: &RecorderManifest) -> PathBuf {
        let dir = root.session_dir(&manifest.session_id).expect("session dir");
        root.prepare_session_dir(&dir).expect("prepare");
        write_manifest_atomic(&dir, manifest).expect("write manifest");
        dir
    }

    fn write_chunk(dir: &Path, relative: &str, format: WavFormat, frames: u64) -> Vec<u8> {
        let header = wav::header(format, frames * format.bytes_per_frame());
        let mut bytes = header.to_vec();
        for frame in 0..frames {
            let value = (frame % 1000) as i16;
            for _ in 0..format.channels {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        std::fs::write(dir.join(relative), &bytes).expect("write chunk");
        bytes
    }

    #[test]
    fn an_untouched_root_produces_an_empty_report() {
        let (_guard, root) = temp_root("empty");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert!(report.sessions.is_empty());
        assert!(report.rejected.is_empty());
    }

    #[test]
    fn a_non_terminal_session_is_marked_interrupted_and_never_discarded() {
        let (_guard, root) = temp_root("interrupted");
        let manifest = valid_manifest();
        let dir = session(&root, &manifest);
        write_chunk(&dir, "microphone/000000.wav", WavFormat { sample_rate_hz: 48_000, channels: 1 }, 1_439_040);
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert_eq!(report.sessions.len(), 1);
        let recovered = &report.sessions[0];
        assert!(recovered.interrupted);
        assert_eq!(recovered.state, ManifestState::Interrupted);
        assert!(recovered.recoverable());
        assert!(!recovered.can_resume_capture);
        assert_eq!(recovered.chunk_count, 2, "the two manifest chunks stay listed");
        // The files are all still there.
        assert!(dir.join("microphone/000000.wav").exists());
        assert!(dir.join("manifest.json").exists());
        let persisted = std::fs::read_to_string(dir.join("manifest.json")).expect("read");
        let updated = RecorderManifest::parse_and_validate(&persisted).expect("still valid");
        assert_eq!(updated.state, ManifestState::Interrupted);
        assert_eq!(updated.revision, manifest.revision + 1);
        assert_eq!(updated.chunks.len(), 2);
    }

    #[test]
    fn orphan_files_are_adopted_from_validated_headers() {
        let (_guard, root) = temp_root("orphan");
        let mut manifest = valid_manifest();
        manifest.state = ManifestState::Stopped;
        manifest.chunks.retain(|chunk| chunk.source_kind != SourceKind::SystemAudio);
        let dir = session(&root, &manifest);
        write_chunk(
            &dir,
            "system-audio/000000.wav",
            WavFormat {
                sample_rate_hz: 48_000,
                channels: 2,
            },
            1_440_000,
        );
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        let recovered = report.sessions.first().expect("one session");
        assert_eq!(recovered.orphan_chunks, 1);
        assert!(!recovered.interrupted);
        let adopted = recovered.chunk_count;
        assert_eq!(adopted, 2, "the manifest chunk plus the adopted file");
        let on_disk = RecorderManifest::parse_and_validate(&std::fs::read_to_string(dir.join("manifest.json")).expect("read"))
            .expect("valid");
        let chunk = on_disk
            .chunks
            .iter()
            .find(|chunk| chunk.source_kind == SourceKind::SystemAudio)
            .expect("adopted chunk recorded");
        assert_eq!(chunk.state, ChunkState::ReconciledFromDisk);
        assert_eq!(chunk.sample_count, 1_440_000);
        assert_eq!(chunk.duration_ms, 30_000);
        assert_eq!(chunk.checksum.as_ref().map(|c| c.value.len()), Some(64));
        assert_eq!(chunk.byte_size, 44 + 1_440_000 * 4);
    }

    #[test]
    fn partial_files_are_salvaged_or_kept_never_silently_deleted() {
        let (_guard, root) = temp_root("partial");
        let mut manifest = valid_manifest();
        manifest.state = ManifestState::Stopped;
        manifest.chunks.retain(|chunk| chunk.source_kind != SourceKind::SystemAudio);
        let dir = session(&root, &manifest);
        // A partial with real audio frames in it.
        let header = wav::header(
            WavFormat {
                sample_rate_hz: 48_000,
                channels: 2,
            },
            999_999,
        );
        let mut bytes = header.to_vec();
        bytes.extend_from_slice(&vec![0i16; 4_800 * 2]);
        std::fs::write(dir.join("system-audio/000000.wav.partial"), &bytes).expect("partial");
        // An empty shell.
        std::fs::write(dir.join("microphone/000009.wav.partial"), &header[..]).expect("empty partial");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        let recovered = report.sessions.first().expect("session");
        assert_eq!(recovered.salvaged_chunks, 1);
        assert_eq!(recovered.empty_partial_removed, 1);
        assert!(dir.join("system-audio/000000-truncated.wav").exists(), "salvaged copy is kept");
        assert!(
            !dir.join("system-audio/000000.wav.partial").exists(),
            "the partial is renamed, not duplicated"
        );
        assert!(!dir.join("microphone/000009.wav.partial").exists(), "an empty shell holds no data");
        let warnings = recovered.warnings.join("\n");
        assert!(warnings.contains("salvaged a truncated partial chunk"), "{warnings}");
    }

    #[test]
    fn corrupt_and_future_manifests_are_reported_and_left_untouched() {
        let (_guard, root) = temp_root("corrupt");
        let manifest = valid_manifest();
        let dir = session(&root, &manifest);
        let corrupt = dir.join("manifest.json");
        let original = std::fs::read_to_string(&corrupt).expect("read");
        std::fs::write(&corrupt, "{ this is not json").expect("corrupt");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert!(report.sessions.is_empty());
        assert_eq!(report.rejected.len(), 1);
        assert!(std::fs::read_to_string(&corrupt).expect("still corrupt") == "{ this is not json");

        // A newer schema version is refused without rewriting.
        let mut future = valid_manifest();
        future.session_id = uuid::Uuid::new_v4().to_string();
        future.storage.directory_name = future.session_id.clone();
        future.schema_version = 9;
        let future_dir = session(&root, &future);
        let future_text = std::fs::read_to_string(future_dir.join("manifest.json")).expect("read");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert_eq!(report.rejected.len(), 2);
        assert!(
            report
                .rejected
                .iter()
                .any(|rejected| rejected.reason.contains("newer than this build")),
            "{:?}",
            report.rejected
        );
        assert_eq!(std::fs::read_to_string(future_dir.join("manifest.json")).expect("read"), future_text);
        assert!(original.contains("schemaVersion"));
    }

    #[test]
    fn validation_failures_are_not_repaired() {
        let (_guard, root) = temp_root("invalid");
        let mut manifest = valid_manifest();
        manifest.session_id = uuid::Uuid::new_v4().to_string();
        manifest.storage.directory_name = manifest.session_id.clone();
        manifest.chunks[0].local_file = "microphone/999999.wav".into();
        let dir = root.session_dir(&manifest.session_id).expect("dir");
        root.prepare_session_dir(&dir).expect("prepare");
        std::fs::write(dir.join("manifest.json"), manifest.to_json_string().expect("json")).expect("write");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert_eq!(report.rejected.len(), 1);
        assert!(report.rejected[0].reason.contains("not rewritten"));
        assert_eq!(
            std::fs::read_to_string(dir.join("manifest.json")).expect("read"),
            manifest.to_json_string().expect("json")
        );
    }

    #[test]
    fn stray_directories_are_reported_not_deleted() {
        let (_guard, root) = temp_root("stray");
        std::fs::create_dir(root.sessions_dir().join("not-a-session")).expect("stray");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert_eq!(report.rejected.len(), 1);
        assert!(root.sessions_dir().join("not-a-session").exists());
    }

    #[test]
    fn missing_manifest_reports_loose_files() {
        let (_guard, root) = temp_root("nomanifest");
        let session_id = uuid::Uuid::new_v4().to_string();
        let dir = root.session_dir(&session_id).expect("dir");
        root.prepare_session_dir(&dir).expect("prepare");
        write_chunk(&dir, "microphone/000000.wav", WavFormat { sample_rate_hz: 48_000, channels: 1 }, 480);
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert_eq!(report.sessions.len(), 0);
        assert_eq!(report.rejected.len(), 1);
        assert!(report.rejected[0].reason.contains("no manifest.json"));
        assert!(dir.join("microphone/000000.wav").exists(), "audio is never deleted by recovery");
    }

    #[test]
    fn reports_interrupted_flag_through_has_interrupted() {
        let (_guard, root) = temp_root("flag");
        let mut manifest = valid_manifest();
        manifest.state = ManifestState::Stopped;
        session(&root, &manifest);
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert!(!report.has_interrupted());
        let mut manifest = valid_manifest();
        manifest.session_id = uuid::Uuid::new_v4().to_string();
        manifest.storage.directory_name = manifest.session_id.clone();
        manifest.state = ManifestState::Paused;
        session(&root, &manifest);
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", true).expect("scan");
        assert!(report.has_interrupted());
        assert_eq!(report.sessions.len(), 2);
    }

    #[test]
    fn dry_run_persists_nothing() {
        let (_guard, root) = temp_root("dryrun");
        let manifest = valid_manifest();
        let dir = session(&root, &manifest);
        let before = std::fs::read_to_string(dir.join("manifest.json")).expect("read");
        let report = scan_and_reconcile(&root, "2026-10-06T11:00:00Z", false).expect("scan");
        assert!(report.sessions[0].interrupted, "still reported");
        assert_eq!(std::fs::read_to_string(dir.join("manifest.json")).expect("read"), before);
    }
}
