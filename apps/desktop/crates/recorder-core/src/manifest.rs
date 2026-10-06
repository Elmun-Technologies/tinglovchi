//! Versioned, validated session manifest (docs/recording.md §4).
//!
//! The manifest is the only durable description of a local recording session: state, timeline
//! origin, per-source metadata, finalized chunks, markers, and notes. Field names are camelCase to
//! match the approved example in the docs; `packages/contracts/src/recorder.ts` defines the same wire
//! shape for the renderer, and `tests/desktop/recorder-contract.test.ts` fails if the two drift.
//!
//! Enforced invariants (see [`RecorderManifest::validate`]): UUID identity and ownership, one logical
//! record per source kind, strictly increasing per-source chunk sequences, non-overlapping half-open
//! meeting intervals, duration derived only from frame count / sample rate, checksum present exactly
//! when a chunk is durable, session-relative file paths only, and rejection of identity reuse with
//! different metadata.

use crate::errors::{RecorderError, RecorderErrorCode, SourceKind};
use crate::timeline::GapReason;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Manifest layout this build writes. Unknown higher versions are read and reported, never rewritten.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
/// Consent/notice policy version stamped into every new session.
pub const CONSENT_POLICY_VERSION: &str = "v1";
/// Local protection recorded in the manifest. Per-chunk Keychain-backed encryption is a documented
/// future boundary (docs/recording.md §7), not something this phase claims to provide.
pub const LOCAL_ENCRYPTION_MODE: &str = "os_account_and_disk_protection";
/// Smallest possible finalized chunk: a WAV header with zero audio frames is still not accepted.
pub const MIN_CHUNK_BYTES: u64 = 44;

/// Tick values and sample counts exceed JSON's safe integer range, so they travel as decimal
/// strings. A JSON number here is a hard deserialization error instead of silent precision loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DecimalU128(pub u128);

impl DecimalU128 {
    #[must_use]
    pub const fn get(self) -> u128 {
        self.0
    }
}

impl Serialize for DecimalU128 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for DecimalU128 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(serde::de::Error::custom(format!(
                "expected an unsigned decimal integer string, got {text:?}"
            )));
        }
        text.parse::<u128>()
            .map(DecimalU128)
            .map_err(serde::de::Error::custom)
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestState {
    Ready,
    Recording,
    Paused,
    Finalizing,
    Stopped,
    /// Assigned only by startup reconciliation for a session whose previous process did not finalize.
    Interrupted,
    Failed,
}

impl ManifestState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ManifestState::Ready => "ready",
            ManifestState::Recording => "recording",
            ManifestState::Paused => "paused",
            ManifestState::Finalizing => "finalizing",
            ManifestState::Stopped => "stopped",
            ManifestState::Interrupted => "interrupted",
            ManifestState::Failed => "failed",
        }
    }

    /// Sessions in these states must be offered for recovery, never auto-discarded.
    #[must_use]
    pub const fn is_non_terminal(self) -> bool {
        !matches!(self, ManifestState::Stopped | ManifestState::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    Original,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceHealth {
    Starting,
    Active,
    Degraded,
    Unavailable,
}

impl SourceHealth {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            SourceHealth::Starting => "starting",
            SourceHealth::Active => "active",
            SourceHealth::Degraded => "degraded",
            SourceHealth::Unavailable => "unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkState {
    /// File is open, or closed but not yet durable; a checksum is not allowed in this state.
    Finalizing,
    Finalized,
    /// A file present on disk without a manifest entry, adopted by startup reconciliation.
    ReconciledFromDisk,
    /// A `.partial` file that is decodable but known to be truncated.
    SalvagedTruncated,
}

impl ChunkState {
    #[must_use]
    pub const fn is_durable(self) -> bool {
        !matches!(self, ChunkState::Finalizing)
    }
}

/// The single fixed-point container implemented in this phase. Rationale, and why Opus/Ogg is a
/// measured follow-up rather than an assumed default, is recorded in `docs/mac-recorder-acceptance.md`
/// §4 and docs/recording.md §4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CaptureFormat {
    // Renamed explicitly rather than relying on `rename_all = "snake_case"`, whose digit handling
    // ("s16le" vs "s16_le") is exactly the kind of detail a cross-language contract must not guess.
    #[serde(rename = "wav_pcm_s16le")]
    WavPcmS16Le,
}

impl CaptureFormat {
    #[must_use]
    pub const fn codec(self) -> Codec {
        match self {
            CaptureFormat::WavPcmS16Le => Codec::PcmS16Le,
        }
    }

    #[must_use]
    pub const fn container(self) -> Container {
        match self {
            CaptureFormat::WavPcmS16Le => Container::Wav,
        }
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            CaptureFormat::WavPcmS16Le => "wav",
        }
    }

    #[must_use]
    pub const fn bytes_per_sample(self) -> u64 {
        match self {
            CaptureFormat::WavPcmS16Le => 2,
        }
    }

    /// Uncompressed PCM has no coding delay; a lossy encoder would have to record priming/padding.
    #[must_use]
    pub const fn has_coding_delay(self) -> bool {
        match self {
            CaptureFormat::WavPcmS16Le => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Codec {
    #[serde(rename = "pcm_s16le")]
    PcmS16Le,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Container {
    #[serde(rename = "wav")]
    Wav,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChecksumAlgorithm {
    #[serde(rename = "sha256")]
    Sha256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClockKind {
    #[serde(rename = "platform_monotonic_continuous")]
    PlatformMonotonicContinuous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoteKind {
    /// Manual annotation. Notes are never transcript segments (docs/recording.md §5).
    #[serde(rename = "manual")]
    Manual,
}

/// Phase 3 owns upload; this phase can only ever write `pending`. The enum is closed on purpose so
/// the desktop app cannot accidentally claim progress it did not make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UploadState {
    #[serde(rename = "pending")]
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerificationState {
    #[serde(rename = "pending")]
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBlock {
    pub clock: ClockKind,
    /// Identifies the monotonic epoch. Readings from different epochs are never subtracted.
    pub clock_epoch_id: String,
    pub origin_ticks: DecimalU128,
    pub origin_wall_clock_utc: String,
    /// Sample indices/counts fit `u64` comfortably and are JSON numbers, matching the docs example.
    /// Only raw tick readings need the decimal-string treatment.
    pub tick_frequency_hz: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveIntervalRecord {
    pub start_ticks: DecimalU128,
    #[serde(default)]
    pub end_ticks: Option<DecimalU128>,
    pub meeting_start_ms: u64,
    #[serde(default)]
    pub meeting_end_ms: Option<u64>,
}

/// Explicit silent/unavailable interval on the canonical timeline. `estimated` marks gaps whose
/// length came from wall time (sleep, clock-epoch change) rather than measured samples.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapRecord {
    pub meeting_start_ms: u64,
    pub meeting_end_ms: u64,
    pub estimated: bool,
    pub reason: GapReason,
    #[serde(default)]
    pub source_kind: Option<SourceKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRecord {
    pub acknowledged_at: String,
    pub policy_version: String,
    pub participant_notice_shown: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRecord {
    pub layout_version: u32,
    pub directory_name: String,
    /// Always true in this phase: local paths only, no network egress.
    #[serde(default = "default_true")]
    pub local_only: bool,
    pub encryption: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub recording_source_id: String,
    pub kind: SourceKind,
    pub role: SourceRole,
    /// Named `state` to match the approved manifest example in docs/recording.md §4.
    pub state: SourceHealth,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub codec: Codec,
    pub container: Container,
    pub format: CaptureFormat,
    #[serde(default)]
    pub device_uid: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    pub first_sample_index: u64,
    pub last_sample_index_exclusive: u64,
    pub first_sample_meeting_ms: u64,
    #[serde(default)]
    pub last_sample_meeting_ms: Option<u64>,
    /// Samples the capture API delivered but the pipeline could not persist (bounded queue overflow).
    pub dropped_sample_count: u64,
    pub started_at_ticks: DecimalU128,
    #[serde(default)]
    pub ended_at_ticks: Option<DecimalU128>,
    /// Piecewise sample→tick map. A new segment starts after every pause, stall, or device restart.
    #[serde(default)]
    pub sample_map: Vec<crate::timeline::SourceSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checksum {
    pub algorithm: ChecksumAlgorithm,
    pub value: String,
}

/// One independently recoverable chunk of one source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRecord {
    pub chunk_id: String,
    pub recording_id: String,
    pub recording_source_id: String,
    pub source_kind: SourceKind,
    pub sequence_no: u64,
    /// Derived from `(recording_id, recording_source_id, sequence_no)`, the canonical idempotency
    /// identity (docs/recording.md §4, §6). Never derived from the file name.
    pub idempotency_key: String,
    /// Session-directory-relative path, e.g. `microphone/000000.wav`.
    pub local_file: String,
    pub state: ChunkState,
    pub meeting_start_ms: u64,
    pub meeting_end_ms: u64,
    /// Playable media duration from frame count / sample rate; not the meeting interval.
    pub duration_ms: u64,
    pub source_first_sample_index: u64,
    pub first_sample_monotonic_ticks: DecimalU128,
    pub sample_count: u64,
    pub byte_size: u64,
    /// Computed only after the file is frozen; never on a still-mutating file.
    #[serde(default)]
    pub checksum: Option<Checksum>,
    pub codec: Codec,
    pub container: Container,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub encoder_delay_samples: u32,
    pub encoder_padding_samples: u32,
    pub segment_index: u32,
    #[serde(default)]
    pub finalized_at: Option<String>,
    pub upload_state: UploadState,
    pub verification_state: VerificationState,
    #[serde(default)]
    pub verified_at: Option<String>,
    /// Reserved for Phase 3; `None` here because no storage key is issued offline.
    #[serde(default)]
    pub storage_key: Option<String>,
}

#[must_use]
pub fn idempotency_key(recording_id: &str, recording_source_id: &str, sequence_no: u64) -> String {
    format!("{recording_id}:{recording_source_id}:{sequence_no}")
}

#[must_use]
pub fn chunk_file_name(source_kind: SourceKind, sequence_no: u64, format: CaptureFormat) -> String {
    format!(
        "{}/{:06}.{}",
        source_kind.directory_name(),
        sequence_no,
        format.extension()
    )
}

#[must_use]
pub fn partial_file_name(source_kind: SourceKind, sequence_no: u64, format: CaptureFormat) -> String {
    format!("{}.partial", chunk_file_name(source_kind, sequence_no, format))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerRecord {
    pub marker_id: String,
    pub created_at: String,
    pub meeting_ms: u64,
    pub label: String,
    #[serde(default)]
    pub author_user_id: Option<String>,
}

/// A manual note. It is an annotation record, never a transcript segment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub note_id: String,
    pub created_at: String,
    pub meeting_ms: u64,
    pub text: String,
    pub kind: NoteKind,
    #[serde(default)]
    pub author_user_id: Option<String>,
}

/// The durable session manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderManifest {
    pub schema_version: u32,
    pub revision: u64,
    /// Meeting linkage is optional in Phase 2: capture works fully offline and unauthenticated.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub meeting_id: Option<String>,
    pub recording_id: String,
    pub session_id: String,
    pub state: ManifestState,
    pub started_at: String,
    #[serde(default)]
    pub stopped_at: Option<String>,
    pub timeline: TimelineBlock,
    #[serde(default)]
    pub active_intervals: Vec<ActiveIntervalRecord>,
    #[serde(default)]
    pub pause_intervals: Vec<GapRecord>,
    pub consent: ConsentRecord,
    pub storage: StorageRecord,
    pub sources: Vec<SourceRecord>,
    #[serde(default)]
    pub chunks: Vec<ChunkRecord>,
    #[serde(default)]
    pub markers: Vec<MarkerRecord>,
    #[serde(default)]
    pub notes: Vec<NoteRecord>,
    pub last_updated_at: String,
    /// Unknown fields written by a newer build survive a rewrite instead of being dropped.
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

impl RecorderManifest {
    pub fn to_json_string(&self) -> Result<String, RecorderError> {
        serde_json::to_string_pretty(self).map_err(|error| {
            RecorderError::new(
                RecorderErrorCode::InternalError,
                format!("manifest could not be serialized ({error})"),
                false,
            )
        })
    }

    /// Parse without validation so recovery can report on a damaged manifest instead of losing it.
    pub fn parse_unvalidated(text: &str) -> Result<Self, RecorderError> {
        serde_json::from_str(text).map_err(|error| {
            RecorderError::new(
                RecorderErrorCode::ManifestUnreadable,
                format!("manifest could not be parsed ({error})"),
                false,
            )
        })
    }

    pub fn parse_and_validate(text: &str) -> Result<Self, RecorderError> {
        let manifest = Self::parse_unvalidated(text)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Reject reused identities and lost history (docs/recording.md §4: a conflict, never an overwrite).
    pub fn ensure_compatible_with(&self, previous: &Self) -> Result<(), RecorderError> {
        if previous.recording_id != self.recording_id || previous.session_id != self.session_id {
            return Err(conflict("recordingId/sessionId changed between revisions"));
        }
        if self.revision < previous.revision {
            return Err(conflict("manifest revision went backwards"));
        }
        for old_chunk in &previous.chunks {
            let Some(new_chunk) = self.chunks.iter().find(|chunk| {
                chunk.recording_source_id == old_chunk.recording_source_id && chunk.sequence_no == old_chunk.sequence_no
            }) else {
                return Err(conflict(format!(
                    "chunk {} disappeared from a later revision",
                    old_chunk.idempotency_key
                )));
            };
            let compatible = new_chunk.chunk_id == old_chunk.chunk_id
                && new_chunk.idempotency_key == old_chunk.idempotency_key
                && new_chunk.local_file == old_chunk.local_file
                && new_chunk.meeting_start_ms == old_chunk.meeting_start_ms
                && new_chunk.meeting_end_ms == old_chunk.meeting_end_ms
                && new_chunk.byte_size == old_chunk.byte_size
                && new_chunk.sample_count == old_chunk.sample_count
                && new_chunk.checksum == old_chunk.checksum;
            if !compatible {
                return Err(conflict(format!(
                    "chunk {} was reused with conflicting metadata",
                    old_chunk.idempotency_key
                )));
            }
        }
        Ok(())
    }

    /// Insert or replace a chunk by its canonical identity. A durable chunk is never overwritten with
    /// different bytes: that is reported as a conflict by [`Self::ensure_compatible_with`] upstream.
    pub fn apply_chunk(&mut self, chunk: &ChunkRecord) {
        if let Some(existing) = self
            .chunks
            .iter()
            .position(|candidate| candidate.recording_source_id == chunk.recording_source_id && candidate.sequence_no == chunk.sequence_no)
        {
            self.chunks[existing] = chunk.clone();
        } else {
            self.chunks.push(chunk.clone());
            self.chunks.sort_by_key(|candidate| (candidate.source_kind.as_str().to_string(), candidate.sequence_no));
        }
    }

    pub fn validate(&self) -> Result<(), RecorderError> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(RecorderError::new(
                RecorderErrorCode::ManifestUnreadable,
                format!("unsupported manifest schemaVersion {}", self.schema_version),
                false,
            ));
        }
        validate_uuid("recordingId", &self.recording_id)?;
        validate_uuid("sessionId", &self.session_id)?;
        for value in [self.workspace_id.as_deref(), self.meeting_id.as_deref()]
            .into_iter()
            .flatten()
        {
            validate_uuid("workspaceId/meetingId", value)?;
        }
        if self.revision == 0 {
            return Err(conflict("manifest revision must start at 1"));
        }
        if self.storage.encryption != LOCAL_ENCRYPTION_MODE {
            return Err(conflict("manifest claims an encryption mode this build does not provide"));
        }
        if !self.storage.local_only {
            return Err(conflict("storage.localOnly must be true in this phase"));
        }
        if self.storage.layout_version != 1 {
            return Err(conflict("unsupported storage.layoutVersion"));
        }
        validate_safe_directory_name("storage.directoryName", &self.storage.directory_name)?;
        if self.timeline.tick_frequency_hz == 0 {
            return Err(conflict("timeline.tickFrequencyHz must be positive"));
        }
        if self.timeline.clock != ClockKind::PlatformMonotonicContinuous {
            return Err(conflict("timeline.clock must be platform_monotonic_continuous"));
        }
        if self.timeline.clock_epoch_id.trim().is_empty() || self.timeline.clock_epoch_id.len() > 64 {
            return Err(conflict("timeline.clockEpochId is required and bounded"));
        }
        if self.consent.policy_version != CONSENT_POLICY_VERSION || !self.consent.participant_notice_shown {
            return Err(conflict(
                "consent acknowledgement and participant notice are required before capture",
            ));
        }
        if self.sources.is_empty() {
            return Err(conflict("a manifest must describe at least one captured source"));
        }

        let mut seen_source_ids = BTreeSet::new();
        let mut seen_kinds = BTreeSet::new();
        for source in &self.sources {
            validate_uuid("sources[].recordingSourceId", &source.recording_source_id)?;
            if !seen_source_ids.insert(source.recording_source_id.clone()) {
                return Err(conflict("duplicate sources[].recordingSourceId"));
            }
            if !seen_kinds.insert(source.kind) {
                return Err(conflict(
                    "more than one source of the same kind; microphone and system audio stay distinct logical sources",
                ));
            }
            if source.sample_rate_hz == 0 || source.channels == 0 {
                return Err(conflict("sources[].sampleRateHz and channels must be positive"));
            }
            if source.format != CaptureFormat::WavPcmS16Le
                || source.codec != source.format.codec()
                || source.container != source.format.container()
            {
                return Err(conflict("sources[] codec/container must match the implemented capture format"));
            }
            if source.last_sample_index_exclusive < source.first_sample_index {
                return Err(conflict("sources[] sample index range is inverted"));
            }
            if let Some(ended) = source.ended_at_ticks {
                if ended.get() <= source.started_at_ticks.get() {
                    return Err(conflict("sources[].endedAtTicks must be after startedAtTicks"));
                }
            }
            if source.sample_map.is_empty() {
                return Err(conflict("sources[].sampleMap must contain the delivered segments"));
            }
            let mut previous_end: u64 = 0;
            for segment in &source.sample_map {
                if segment.sample_count == 0 {
                    return Err(conflict("sources[].sampleMap contains an empty segment"));
                }
                if segment.first_sample_index < previous_end {
                    return Err(conflict("sources[].sampleMap segments overlap or are unordered"));
                }
                previous_end = segment.first_sample_index + segment.sample_count;
            }
            if source.first_sample_index != source.sample_map[0].first_sample_index {
                return Err(conflict("sources[].firstSampleIndex disagrees with the first mapped segment"));
            }
            if source.last_sample_index_exclusive != previous_end {
                return Err(conflict("sources[].lastSampleIndexExclusive disagrees with the mapped segments"));
            }
        }

        let mut last_sequence: BTreeMap<String, u64> = BTreeMap::new();
        let mut last_end_ms: BTreeMap<String, u64> = BTreeMap::new();
        let mut seen_chunk_ids = BTreeSet::new();
        let mut seen_keys = BTreeSet::new();
        for chunk in &self.chunks {
            validate_uuid("chunks[].chunkId", &chunk.chunk_id)?;
            validate_uuid("chunks[].recordingSourceId", &chunk.recording_source_id)?;
            if chunk.recording_id != self.recording_id {
                return Err(conflict("chunks[].recordingId does not own this manifest"));
            }
            let Some(source) = self
                .sources
                .iter()
                .find(|candidate| candidate.recording_source_id == chunk.recording_source_id)
            else {
                return Err(conflict("chunk references an unknown recordingSourceId"));
            };
            if source.kind != chunk.source_kind {
                return Err(conflict("chunk sourceKind disagrees with its source record"));
            }
            if chunk.idempotency_key != idempotency_key(&chunk.recording_id, &chunk.recording_source_id, chunk.sequence_no) {
                return Err(conflict(
                    "chunks[].idempotencyKey must be recordingId:recordingSourceId:sequenceNo",
                ));
            }
            if !seen_chunk_ids.insert(chunk.chunk_id.clone()) {
                return Err(conflict("duplicate chunks[].chunkId"));
            }
            if !seen_keys.insert(chunk.idempotency_key.clone()) {
                return Err(conflict("duplicate chunks[].idempotencyKey"));
            }
            if chunk.meeting_end_ms <= chunk.meeting_start_ms {
                return Err(conflict("chunk meeting interval must be a non-empty half-open range"));
            }
            if chunk.sample_count == 0 {
                return Err(conflict("chunk sampleCount must be positive"));
            }
            let expected_duration = chunk.sample_count * 1_000 / u64::from(chunk.sample_rate_hz);
            if chunk.duration_ms != expected_duration {
                return Err(conflict(
                    "chunk durationMs must equal floor(sampleCount * 1000 / sampleRateHz); container metadata is not a timeline source",
                ));
            }
            if chunk.codec != Codec::PcmS16Le || chunk.container != Container::Wav {
                return Err(conflict("chunk codec/container must match the implemented capture format"));
            }
            if chunk.local_file != chunk_file_name(chunk.source_kind, chunk.sequence_no, CaptureFormat::WavPcmS16Le) {
                return Err(conflict("chunk localFile must be the deterministic session-relative path for its sequence"));
            }
            if chunk.byte_size < MIN_CHUNK_BYTES {
                return Err(conflict("chunk byteSize is smaller than a valid container header"));
            }
            match &chunk.checksum {
                Some(checksum) => {
                    if checksum.algorithm != ChecksumAlgorithm::Sha256 || !is_lower_hex64(&checksum.value) {
                        return Err(conflict("chunk checksum must be sha256 with 64 lowercase hex characters"));
                    }
                    if !chunk.state.is_durable() {
                        return Err(conflict("a finalizing chunk must not carry a checksum yet"));
                    }
                }
                None => {
                    if chunk.state.is_durable() {
                        return Err(conflict("a durable chunk requires a checksum computed after finalization"));
                    }
                }
            }
            if chunk.state == ChunkState::Finalizing {
                if chunk.finalized_at.is_some() {
                    return Err(conflict("a finalizing chunk cannot report finalizedAt"));
                }
            } else if chunk.finalized_at.is_none() {
                return Err(conflict("a durable chunk must record finalizedAt"));
            }
            // Uncompressed PCM has no coding delay. When a lossy encoder is introduced (docs/recording.md
            // §4 codec benchmark), it must record priming/padding instead of relying on container duration.
            if chunk.encoder_delay_samples != 0 || chunk.encoder_padding_samples != 0 {
                return Err(conflict("uncompressed PCM chunks must record zero encoder delay and padding"));
            }
            if chunk.upload_state != UploadState::Pending
                || chunk.verification_state != VerificationState::Pending
                || chunk.verified_at.is_some()
                || chunk.storage_key.is_some()
            {
                return Err(conflict(
                    "upload/verification state is owned by a later phase and must stay pending locally",
                ));
            }
            if chunk.sample_rate_hz != source.sample_rate_hz || chunk.channels != source.channels {
                return Err(conflict("chunk codec metadata disagrees with its source record"));
            }
            if let Some(previous) = last_sequence.insert(chunk.recording_source_id.clone(), chunk.sequence_no) {
                if chunk.sequence_no <= previous {
                    return Err(conflict("chunks[].sequenceNo must strictly increase per source"));
                }
            }
            if let Some(previous_end) = last_end_ms.insert(chunk.recording_source_id.clone(), chunk.meeting_end_ms) {
                if chunk.meeting_start_ms < previous_end {
                    return Err(conflict("chunk meeting intervals overlap; record an explicit gap instead"));
                }
            }
        }

        let mut open_intervals = 0usize;
        for interval in &self.active_intervals {
            if let Some(end) = interval.end_ticks {
                if end.get() <= interval.start_ticks.get() {
                    return Err(conflict("activeIntervals must end after they start"));
                }
            } else {
                open_intervals += 1;
            }
            if let Some(end_ms) = interval.meeting_end_ms {
                if end_ms <= interval.meeting_start_ms {
                    return Err(conflict("activeIntervals meeting range is inverted"));
                }
            }
        }
        if open_intervals > 1 {
            return Err(conflict("at most one active interval may be open"));
        }
        for gap in &self.pause_intervals {
            if gap.meeting_end_ms <= gap.meeting_start_ms {
                return Err(conflict("pauseIntervals must be non-empty half-open ranges"));
            }
        }

        let mut marker_ids = BTreeSet::new();
        for marker in &self.markers {
            validate_uuid("markers[].markerId", &marker.marker_id)?;
            if marker.label.trim().is_empty() || marker.label.chars().count() > 120 {
                return Err(conflict("markers[].label must be 1..=120 characters"));
            }
            if !marker_ids.insert(marker.marker_id.clone()) {
                return Err(conflict("duplicate markers[].markerId"));
            }
        }
        let mut note_ids = BTreeSet::new();
        for note in &self.notes {
            validate_uuid("notes[].noteId", &note.note_id)?;
            if note.text.trim().is_empty() || note.text.chars().count() > 4000 {
                return Err(conflict("notes[].text must be 1..=4000 characters"));
            }
            if note.kind != NoteKind::Manual {
                return Err(conflict("notes[].kind must be manual: notes are never transcript segments"));
            }
            if !note_ids.insert(note.note_id.clone()) {
                return Err(conflict("duplicate notes[].noteId"));
            }
        }
        Ok(())
    }
}

fn conflict(message: impl Into<String>) -> RecorderError {
    RecorderError::new(RecorderErrorCode::ManifestConflict, message, false)
}

fn validate_uuid(field: &str, value: &str) -> Result<(), RecorderError> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| invalid(format!("{field} must be a lowercase UUID")))?;
    if parsed.to_string() != value {
        return Err(invalid(format!("{field} must be a canonical lowercase UUID")));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> RecorderError {
    RecorderError::new(RecorderErrorCode::ManifestConflict, message, false)
}

/// Session directory names are generated from UUIDs, never from user text. Enforcing the character
/// set here means a mistaken or hostile name cannot escape the recorder root.
fn validate_safe_directory_name(field: &str, value: &str) -> Result<(), RecorderError> {
    let allowed = value.len() <= 128
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !allowed {
        return Err(invalid(format!(
            "{field} must be a lowercase alphanumeric-or-dash name without separators"
        )));
    }
    Ok(())
}

#[must_use]
fn is_lower_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::timeline::SourceSegment;

    /// 48 kHz mono/stereo 30 s chunk values that match `mic-startup-latency-and-30s-chunks` in
    /// `tests/fixtures/recorder-timeline-vectors.json`.
    pub const TEST_SAMPLES: u64 = 1_439_040;
    pub const TEST_ORIGIN_TICKS: u128 = 1_000_000_000_000;

    #[must_use]
    pub fn valid_manifest() -> RecorderManifest {
        let recording_id = "3f2a1c4b-5d6e-4f70-8a9b-0c1d2e3f4a5b".to_string();
        let mic_id = "11111111-1111-4111-8111-111111111111".to_string();
        let system_id = "22222222-2222-4222-8222-222222222222".to_string();
        let now = "2026-10-06T10:00:00Z".to_string();
        let sample_rate = 48_000u32;
        let mic_start = TEST_ORIGIN_TICKS + 20_000_000;
        let system_start = TEST_ORIGIN_TICKS + 35_000_000;
        let chunk_ids = [
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666",
        ];
        let mut chunks = Vec::new();
        for (index, (source_id, kind, channels, start_ticks, first_ms)) in [
            (mic_id.clone(), SourceKind::Microphone, 1u16, mic_start, 20u64),
            (system_id.clone(), SourceKind::SystemAudio, 2u16, system_start, 35),
        ]
        .into_iter()
        .enumerate()
        {
            chunks.push(ChunkRecord {
                chunk_id: chunk_ids[index].to_string(),
                recording_id: recording_id.clone(),
                recording_source_id: source_id.clone(),
                source_kind: kind,
                sequence_no: 0,
                idempotency_key: idempotency_key(&recording_id, &source_id, 0),
                local_file: chunk_file_name(kind, 0, CaptureFormat::WavPcmS16Le),
                state: ChunkState::Finalized,
                meeting_start_ms: first_ms,
                meeting_end_ms: 30_000,
                duration_ms: TEST_SAMPLES * 1000 / u64::from(sample_rate),
                source_first_sample_index: 0,
                first_sample_monotonic_ticks: DecimalU128(start_ticks),
                sample_count: TEST_SAMPLES,
                byte_size: MIN_CHUNK_BYTES + TEST_SAMPLES * u64::from(channels) * 2,
                checksum: Some(Checksum {
                    algorithm: ChecksumAlgorithm::Sha256,
                    value: format!("{:064x}", index + 1),
                }),
                codec: Codec::PcmS16Le,
                container: Container::Wav,
                sample_rate_hz: sample_rate,
                channels,
                encoder_delay_samples: 0,
                encoder_padding_samples: 0,
                segment_index: 0,
                finalized_at: Some(now.clone()),
                upload_state: UploadState::Pending,
                verification_state: VerificationState::Pending,
                verified_at: None,
                storage_key: None,
            });
        }
        RecorderManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            revision: 1,
            workspace_id: None,
            meeting_id: None,
            recording_id,
            session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            state: ManifestState::Recording,
            started_at: now.clone(),
            stopped_at: None,
            timeline: TimelineBlock {
                clock: ClockKind::PlatformMonotonicContinuous,
                clock_epoch_id: "boot-1759787000".into(),
                origin_ticks: DecimalU128(TEST_ORIGIN_TICKS),
                origin_wall_clock_utc: now.clone(),
                tick_frequency_hz: 1_000_000_000,
            },
            active_intervals: vec![ActiveIntervalRecord {
                start_ticks: DecimalU128(TEST_ORIGIN_TICKS),
                end_ticks: None,
                meeting_start_ms: 0,
                meeting_end_ms: None,
            }],
            pause_intervals: vec![],
            consent: ConsentRecord {
                acknowledged_at: now.clone(),
                policy_version: CONSENT_POLICY_VERSION.into(),
                participant_notice_shown: true,
            },
            storage: StorageRecord {
                layout_version: 1,
                directory_name: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                local_only: true,
                encryption: LOCAL_ENCRYPTION_MODE.into(),
            },
            sources: vec![
                SourceRecord {
                    recording_source_id: mic_id,
                    kind: SourceKind::Microphone,
                    role: SourceRole::Original,
                    state: SourceHealth::Active,
                    sample_rate_hz: sample_rate,
                    channels: 1,
                    codec: Codec::PcmS16Le,
                    container: Container::Wav,
                    format: CaptureFormat::WavPcmS16Le,
                    device_uid: Some("AppleHDAEngineInput:1B,0,1,0:1".into()),
                    device_name: Some("MacBook Pro Microphone".into()),
                    first_sample_index: 0,
                    last_sample_index_exclusive: TEST_SAMPLES,
                    first_sample_meeting_ms: 20,
                    last_sample_meeting_ms: Some(29_999),
                    dropped_sample_count: 0,
                    started_at_ticks: DecimalU128(TEST_ORIGIN_TICKS),
                    ended_at_ticks: None,
                    sample_map: vec![SourceSegment {
                        first_sample_index: 0,
                        first_sample_ticks: mic_start,
                        sample_count: TEST_SAMPLES,
                    }],
                },
                SourceRecord {
                    recording_source_id: system_id,
                    kind: SourceKind::SystemAudio,
                    role: SourceRole::Original,
                    state: SourceHealth::Active,
                    sample_rate_hz: sample_rate,
                    channels: 2,
                    codec: Codec::PcmS16Le,
                    container: Container::Wav,
                    format: CaptureFormat::WavPcmS16Le,
                    device_uid: None,
                    device_name: Some("Built-in Output".into()),
                    first_sample_index: 0,
                    last_sample_index_exclusive: TEST_SAMPLES,
                    first_sample_meeting_ms: 35,
                    last_sample_meeting_ms: Some(29_999),
                    dropped_sample_count: 0,
                    started_at_ticks: DecimalU128(TEST_ORIGIN_TICKS),
                    ended_at_ticks: None,
                    sample_map: vec![SourceSegment {
                        first_sample_index: 0,
                        first_sample_ticks: system_start,
                        sample_count: TEST_SAMPLES,
                    }],
                },
            ],
            chunks,
            markers: vec![MarkerRecord {
                marker_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                created_at: now.clone(),
                meeting_ms: 12_345,
                label: "Important".into(),
                author_user_id: None,
            }],
            notes: vec![NoteRecord {
                note_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                created_at: now.clone(),
                meeting_ms: 12_400,
                text: "Owner will send the revised quote on Monday".into(),
                kind: NoteKind::Manual,
                author_user_id: None,
            }],
            last_updated_at: now,
            extra: Map::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn the_reference_fixture_manifest_is_valid() {
        valid_manifest().validate().expect("fixture manifest must validate");
    }

    #[test]
    fn rejects_traversal_and_absolute_paths_in_chunk_records() {
        for path in ["../escape.wav", "/tmp/absolute.wav", "microphone/../000000.wav", "..", ""] {
            let mut manifest = valid_manifest();
            manifest.chunks[0].local_file = path.into();
            assert!(manifest.validate().is_err(), "must reject {path:?}");
        }
        let mut manifest = valid_manifest();
        manifest.chunks[0].local_file = "microphone/000001.wav".into();
        assert!(
            manifest.validate().is_err(),
            "path must stay consistent with sequenceNo and source kind"
        );
    }

    #[test]
    fn rejects_reused_identity_with_different_checksum_and_keeps_identical_retries() {
        let previous = valid_manifest();
        let mut next = valid_manifest();
        next.revision = 2;
        next.chunks[0].checksum = Some(Checksum {
            algorithm: ChecksumAlgorithm::Sha256,
            value: "f".repeat(64),
        });
        let error = next
            .ensure_compatible_with(&previous)
            .expect_err("identity reuse with different bytes must conflict");
        assert_eq!(error.code, RecorderErrorCode::ManifestConflict);
        assert!(previous.ensure_compatible_with(&previous).is_ok(), "identical retry is fine");

        let mut lost = valid_manifest();
        lost.revision = 2;
        lost.chunks.remove(0);
        assert!(lost.ensure_compatible_with(&previous).is_err(), "history cannot be dropped");
        let mut regressed = valid_manifest();
        regressed.revision = 0;
        assert!(regressed.ensure_compatible_with(&previous).is_err());
    }

    #[test]
    fn requires_checksum_exactly_when_durable() {
        let mut manifest = valid_manifest();
        manifest.chunks[0].state = ChunkState::Finalizing;
        manifest.chunks[0].checksum = None;
        manifest.chunks[0].finalized_at = None;
        manifest.validate().expect("a finalizing chunk may not have a checksum yet");
        manifest.chunks[0].checksum = Some(Checksum {
            algorithm: ChecksumAlgorithm::Sha256,
            value: "0".repeat(64),
        });
        assert!(manifest.validate().is_err(), "finalizing must not claim a checksum");
    }

    #[test]
    fn duration_must_come_from_sample_count_not_the_meeting_interval() {
        let mut manifest = valid_manifest();
        manifest.chunks[0].duration_ms = manifest.chunks[0].meeting_end_ms - manifest.chunks[0].meeting_start_ms;
        let error = manifest.validate().expect_err("durationMs is frame arithmetic only");
        assert!(error.message.contains("durationMs"));
    }

    #[test]
    fn strictly_increasing_sequences_and_non_overlapping_intervals() {
        let mut manifest = valid_manifest();
        let mut duplicate = manifest.chunks[0].clone();
        duplicate.chunk_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into();
        manifest.chunks.push(duplicate);
        assert!(manifest.validate().is_err(), "duplicate sequence for one source");

        let mut manifest = valid_manifest();
        manifest.chunks[0].meeting_end_ms = 60_000;
        assert!(manifest.validate().is_err(), "overlapping chunk intervals");
    }

    #[test]
    fn unknown_schema_versions_are_readable_but_never_validated_as_ours() {
        let mut manifest = valid_manifest();
        manifest.schema_version = 7;
        let text = manifest.to_json_string().expect("serializable");
        let unvalidated = RecorderManifest::parse_unvalidated(&text).expect("a newer manifest still parses");
        assert_eq!(unvalidated.schema_version, 7);
        let error = RecorderManifest::parse_and_validate(&text).expect_err("future schema must be refused");
        assert_eq!(error.code, RecorderErrorCode::ManifestUnreadable);
        assert!(error.message.contains("schemaVersion"));
    }

    #[test]
    fn preserves_unknown_fields_across_a_rewrite() {
        let mut value = serde_json::to_value(valid_manifest()).expect("serializable");
        value
            .as_object_mut()
            .expect("manifest object")
            .insert("addedByANewerBuild".into(), Value::String("keep me".into()));
        let text = serde_json::to_string(&value).expect("string");
        let manifest = RecorderManifest::parse_and_validate(&text).expect("must parse");
        assert_eq!(manifest.extra["addedByANewerBuild"], Value::String("keep me".into()));
        assert!(manifest.to_json_string().expect("rewritable").contains("addedByANewerBuild"));
    }

    #[test]
    fn big_integers_are_decimal_strings_and_not_json_numbers() {
        let json = serde_json::to_value(valid_manifest()).expect("serializable");
        assert!(json["timeline"]["originTicks"].is_string());
        assert!(json["chunks"][0]["sampleCount"].is_string());
        assert!(json["sources"][0]["droppedSampleCount"].is_string());
        let mut object = json.as_object().expect("manifest object").clone();
        object.insert(
            "timeline".into(),
            serde_json::json!({
                "clock": "platform_monotonic_continuous",
                "clockEpochId": "boot-1",
                "originTicks": 9_007_199_254_740_993u64,
                "originWallClockUtc": "2026-10-06T10:00:00Z",
                "tickFrequencyHz": "1000000000"
            }),
        );
        let error = serde_json::from_str::<RecorderManifest>(&serde_json::to_string(&object).expect("string"))
            .expect_err("numeric ticks must be rejected rather than rounded");
        assert!(error.to_string().contains("decimal integer string"));
    }

    #[test]
    fn one_source_per_kind_and_sample_map_consistency() {
        let mut manifest = valid_manifest();
        let mut duplicate = manifest.sources[0].clone();
        duplicate.recording_source_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee".into();
        manifest.sources.push(duplicate);
        let error = manifest.validate().expect_err("two microphone sources are not allowed");
        assert!(error.message.contains("same kind"));

        let mut manifest = valid_manifest();
        manifest.sources[0].last_sample_index_exclusive = TEST_SAMPLES + 1;
        assert!(manifest.validate().is_err(), "sample map must agree with the declared range");
    }

    #[test]
    fn upload_and_verification_state_are_frozen_in_this_phase() {
        let mut manifest = valid_manifest();
        manifest.chunks[0].storage_key = Some("tenants/x/chunks/0.wav".into());
        let error = manifest.validate().expect_err("no storage key may be issued offline");
        assert!(error.message.contains("later phase"));
    }

    #[test]
    fn annotations_are_bounded_and_manual() {
        let mut manifest = valid_manifest();
        manifest.notes[0].text = "   ".into();
        assert!(manifest.validate().is_err());
        let mut manifest = valid_manifest();
        manifest.notes[0].kind = NoteKind::Manual;
        manifest.notes[0].text = "x".repeat(4001);
        assert!(manifest.validate().is_err());
        let mut manifest = valid_manifest();
        manifest.markers[0].label = "x".repeat(121);
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn file_names_and_keys_are_deterministic() {
        assert_eq!(
            chunk_file_name(SourceKind::Microphone, 7, CaptureFormat::WavPcmS16Le),
            "microphone/000007.wav"
        );
        assert_eq!(
            partial_file_name(SourceKind::SystemAudio, 12, CaptureFormat::WavPcmS16Le),
            "system-audio/000012.wav.partial"
        );
        assert_eq!(
            idempotency_key("rec", "src", 3),
            "rec:src:3",
            "identity is the DB barrier, not the file name"
        );
    }

    #[test]
    fn directory_names_reject_separators_and_case() {
        for name in ["..", "a/b", "C:\\evil", "with space", "UPPER", ""] {
            assert!(
                validate_safe_directory_name("storage.directoryName", name).is_err(),
                "must reject {name:?}"
            );
        }
        assert!(validate_safe_directory_name("storage.directoryName", "session-2f4a1c").is_ok());
    }

    #[test]
    fn hex_checksums_are_strictly_lowercase_sha256() {
        assert!(is_lower_hex64(&"0".repeat(64)));
        assert!(!is_lower_hex64(&"A".repeat(64)));
        assert!(!is_lower_hex64(&"0".repeat(63)));
        assert!(!is_lower_hex64("z".repeat(64).as_str()));
    }

    #[test]
    fn manifest_states_expose_recovery_relevance() {
        assert!(ManifestState::Recording.is_non_terminal());
        assert!(ManifestState::Paused.is_non_terminal());
        assert!(ManifestState::Finalizing.is_non_terminal());
        assert!(!ManifestState::Stopped.is_non_terminal());
        assert!(!ManifestState::Failed.is_non_terminal());
        assert!(ManifestState::Interrupted.is_non_terminal());
    }
}
