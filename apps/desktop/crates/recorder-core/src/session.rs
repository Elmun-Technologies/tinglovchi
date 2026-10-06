//! Session coordinator: the single owner of capture state, the canonical timeline, and the manifest.
//!
//! Threading model (docs/recording.md §3 forbids file, hash, JSON, and UI work inside realtime
//! callbacks):
//!
//! ```text
//! native capture callback ──► BoundedBlockQueue ──► writer thread ──► outcome channel ──► coordinator
//!     no FS, no hash,          (bounded blocks,      (append WAV,       (chunk finalized,  manifest
//!     no JSON, no UI            non-blocking)         fsync, sha256,     progress, fault)   revision,
//!                                                     atomic rename)                          atomic write)
//! ```
//!
//! Only this module writes the manifest, so revisions are serialized and the identity rules
//! (`ensure_compatible_with`) are enforced in one place. The renderer never touches capture buffers or
//! files: it reads [`Recorder::status`] and the events queued by [`Recorder::take_events`].

use crate::capture::{
    BackendAvailability, BoundedBlockQueue, CaptureBackend, CaptureCallback, CaptureStream, QueueCallback, SourceConfig,
};
use crate::clock::{Clock, SystemClock, TICK_FREQUENCY_HZ};
use crate::errors::{RecorderError, RecorderErrorCode, SourceKind};
use crate::levels::{LevelSnapshot, SILENCE_DBFS};
use crate::manifest::{
    ActiveIntervalRecord, ChunkRecord, ConsentRecord, DecimalU128, GapRecord, ManifestState, MarkerRecord, NoteRecord,
    RecorderManifest, SourceHealth, SourceRecord, StorageRecord, TimelineBlock, CONSENT_POLICY_VERSION,
    LOCAL_ENCRYPTION_MODE, MANIFEST_SCHEMA_VERSION,
};
use crate::platform::{AudioDevice, PermissionSnapshot};
use crate::state::{manifest_state_of, RecorderState, StateMachine};
use crate::storage::{preflight_disk, write_manifest_atomic, RecorderRoot};
use crate::timeline::{
    canonical_duration_ms, meeting_ms_from_ticks, ActiveInterval, GapReason, SourceSegment, TimelineOrigin,
};
use crate::writer::{ChunkWriter, WriterCommand, WriterOutcome, WriterSpec};
use crate::wav::WavFormat;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Sample rate the macOS bridge is asked for. The realized rate per source is persisted from the first
/// delivered block, never assumed.
pub const DEFAULT_SAMPLE_RATE_HZ: u32 = 48_000;
pub const DEFAULT_CHUNK_INTERVAL_MS: u64 = 30_000;
pub const MIN_CHUNK_INTERVAL_MS: u64 = 5_000;
/// ~4 s of 48 kHz stereo audio, at most 128 blocks. Bounded on purpose: overflow is reported and turns
/// into an explicit discontinuity instead of unbounded memory growth.
pub const QUEUE_CAPACITY_BLOCKS: usize = 128;
pub const QUEUE_CAPACITY_BYTES: usize = 4 * 1024 * 1024;
/// How long a source may deliver nothing while `recording` before the UI is told it is not live.
pub const STALL_THRESHOLD_MS: u64 = 2_000;
/// Planning horizon for the disk pre-check when the caller supplies no estimate.
pub const DEFAULT_PLANNED_SECONDS: u64 = 3 * 60 * 60;
/// How long the coordinator waits for a writer to acknowledge a flush (pause/stop).
pub const FLUSH_TIMEOUT: Duration = Duration::from_secs(10);
/// Poll interval used while waiting for writer acknowledgement.
pub const FLUSH_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Everything the renderer supplies when starting a session. It carries no filesystem path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StartRequest {
    pub meeting_id: Option<String>,
    pub workspace_id: Option<String>,
    pub microphone_device_uid: Option<String>,
    pub capture_system_audio: bool,
    pub consent_acknowledged: bool,
    pub chunk_interval_ms: u64,
}

impl Default for StartRequest {
    fn default() -> Self {
        Self {
            meeting_id: None,
            workspace_id: None,
            microphone_device_uid: None,
            capture_system_audio: true,
            consent_acknowledged: false,
            chunk_interval_ms: DEFAULT_CHUNK_INTERVAL_MS,
        }
    }
}

/// Per-source meter reading for the UI. `live == false` distinguishes "no audio" from silence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLevel {
    pub kind: SourceKind,
    /// Flattened so the renderer receives one flat object (`peak`, `rms`, …) instead of a nested
    /// `level`, matching `sourceLevelSchema` in `packages/contracts/src/recorder.ts`.
    #[serde(flatten)]
    pub level: LevelSnapshot,
    /// Canonical meeting time the measurement belongs to.
    pub meeting_ms: u64,
}

/// Messages the coordinator queues for the UI/Tauri layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum RecorderEvent {
    #[serde(rename_all = "camelCase")]
    State { state: RecorderState },
    #[serde(rename_all = "camelCase")]
    Permissions { snapshot: PermissionSnapshot },
    #[serde(rename_all = "camelCase")]
    Levels { levels: Vec<SourceLevel> },
    #[serde(rename_all = "camelCase")]
    ChunkFinalized { chunk: Box<ChunkRecord> },
    #[serde(rename_all = "camelCase")]
    Annotation {
        marker: Option<Box<MarkerRecord>>,
        note: Option<Box<NoteRecord>>,
    },
    #[serde(rename_all = "camelCase")]
    Recovery { report: Box<crate::recovery::RecoveryReport> },
    #[serde(rename_all = "camelCase")]
    Fault { error: RecorderError },
}

/// Display state, derived only from coordinator state — never from file sizes or summed durations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub state: RecorderState,
    /// Canonical meeting-relative elapsed time; includes pauses and gaps.
    pub canonical_elapsed_ms: u64,
    /// Accumulated active-capture time, excluding `paused` intervals.
    pub active_capture_ms: u64,
    pub recording_id: Option<String>,
    pub session_id: Option<String>,
    /// Session directory *name*; the absolute path is owned by the host application.
    pub session_directory: Option<String>,
    pub sources: Vec<SourceRecord>,
    pub levels: Vec<SourceLevel>,
    pub gaps: Vec<GapRecord>,
    pub chunk_count: u64,
    pub finalized_chunk_count: u64,
    pub last_finalized_chunk_at: Option<String>,
    /// Set when persistence failed: the UI must stop presenting the session as a healthy recording.
    pub persistence_fault: Option<RecorderError>,
    pub disk: Option<DiskState>,
    pub clock_epoch_id: Option<String>,
}

/// Disk capacity information for the UI (pre-check plus live headroom).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskState {
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub projected_bytes_per_hour: u64,
    pub sufficient: bool,
    pub reserve_bytes: u64,
}

/// Tunables, in one place so tests can shorten them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionConfig {
    pub chunk_interval_ms: u64,
    pub sample_rate_hz: u32,
    pub planned_seconds: u64,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            chunk_interval_ms: DEFAULT_CHUNK_INTERVAL_MS,
            sample_rate_hz: DEFAULT_SAMPLE_RATE_HZ,
            planned_seconds: DEFAULT_PLANNED_SECONDS,
        }
    }
}

struct WriterHandle {
    control: Sender<WriterCommand>,
    queue: Arc<BoundedBlockQueue>,
    /// Flipped by the coordinator so the callback drops blocks without touching the backend.
    callback_stopped: Arc<AtomicBool>,
    /// Set by the writer once the current chunk is durable (pause/stop handshake).
    flush_ack: Arc<AtomicBool>,
    /// Forces the next delivered block to open a new segment (pause → resume boundary).
    new_segment_pending: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// Tracks the segment a source is currently in, so the manifest map is exact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CurrentSegment {
    index: u32,
    first_sample_index: u64,
    first_tick: u128,
}

/// The recorder. Generic over clock and backend so the pipeline is testable without hardware.
pub struct Recorder<B: CaptureBackend, C: Clock = SystemClock> {
    backend: Arc<B>,
    clock: Arc<C>,
    root: RecorderRoot,
    state: StateMachine,
    config: SessionConfig,
    manifest: Option<RecorderManifest>,
    origin: Option<TimelineOrigin>,
    session_dir: Option<PathBuf>,
    active_intervals: Vec<ActiveInterval>,
    writers: BTreeMap<SourceKind, WriterHandle>,
    streams: BTreeMap<SourceKind, Mutex<Box<dyn CaptureStream>>>,
    outcome_tx: Sender<WriterOutcome>,
    outcomes: Arc<Mutex<Receiver<WriterOutcome>>>,
    levels: BTreeMap<SourceKind, LevelSnapshot>,
    level_meeting_ms: BTreeMap<SourceKind, u64>,
    segments: BTreeMap<SourceKind, CurrentSegment>,
    persistence_fault: Option<RecorderError>,
    disk: Option<DiskState>,
    last_finalized_chunk_at: Option<String>,
    events: Vec<RecorderEvent>,
}

// Platform selection deliberately does NOT live here. `recorder-core` must not depend on the macOS
// capture crate (that crate depends on this one), so the host application defines the alias and builds
// the recorder:
//
// ```ignore
// #[cfg(target_os = "macos")]
// pub type SystemBackend = capture_macos::MacosCaptureBackend;
// #[cfg(not(target_os = "macos"))]
// pub type SystemBackend = recorder_core::capture::UnavailableBackend;
//
// Recorder::new(root, Arc::new(SystemBackend::default()), Arc::new(SystemClock::new()))
// ```
//
// See `apps/desktop/src-tauri/src/platform.rs`. On non-macOS targets the backend fails every start with
// `platform_unsupported`, which is the required fail-closed behaviour.

impl<B: CaptureBackend + 'static, C: Clock + 'static> Recorder<B, C> {
    #[must_use]
    pub fn new(root: RecorderRoot, backend: Arc<B>, clock: Arc<C>) -> Self {
        let (outcome_tx, outcomes) = channel();
        Self {
            backend,
            clock,
            root,
            state: StateMachine::new(),
            config: SessionConfig::default(),
            manifest: None,
            origin: None,
            session_dir: None,
            active_intervals: Vec::new(),
            writers: BTreeMap::new(),
            streams: BTreeMap::new(),
            outcome_tx,
            outcomes: Arc::new(Mutex::new(outcomes)),
            levels: BTreeMap::new(),
            level_meeting_ms: BTreeMap::new(),
            segments: BTreeMap::new(),
            persistence_fault: None,
            disk: None,
            last_finalized_chunk_at: None,
            events: Vec::new(),
        }
    }

    #[must_use]
    pub fn state(&self) -> RecorderState {
        self.state.state()
    }

    #[must_use]
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: SessionConfig) {
        self.config = config;
    }

    #[must_use]
    pub fn manifest(&self) -> Option<&RecorderManifest> {
        self.manifest.as_ref()
    }

    #[must_use]
    pub fn session_dir(&self) -> Option<&std::path::Path> {
        self.session_dir.as_deref()
    }

    #[must_use]
    pub fn rejected_transitions(&self) -> &[(RecorderState, RecorderState)] {
        self.state.rejected_attempts()
    }

    #[must_use]
    pub fn persistence_fault(&self) -> Option<&RecorderError> {
        self.persistence_fault.as_ref()
    }

    /// Events queued since the last call; the Tauri layer turns each one into a UI event.
    pub fn take_events(&mut self) -> Vec<RecorderEvent> {
        std::mem::take(&mut self.events)
    }

    #[must_use]
    pub fn backend_availability(&self) -> BackendAvailability {
        self.backend.availability()
    }

    /// Re-read permission state without prompting the OS.
    pub fn refresh_permissions(&mut self) -> PermissionSnapshot {
        let snapshot = self.backend.permission_snapshot();
        self.apply_permission_snapshot(&snapshot);
        self.events.push(RecorderEvent::Permissions {
            snapshot: snapshot.clone(),
        });
        snapshot
    }

    /// Ask the OS for permissions still in `permission_unknown`. Already-denied permissions are never
    /// re-prompted; the reply carries the settings pointer instead.
    pub fn request_permissions(&mut self, kinds: &[SourceKind]) -> Result<PermissionSnapshot, RecorderError> {
        let snapshot = self.backend.request_permissions(kinds)?;
        self.apply_permission_snapshot(&snapshot);
        self.events.push(RecorderEvent::Permissions {
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    fn apply_permission_snapshot(&mut self, snapshot: &PermissionSnapshot) {
        if matches!(self.state.state(), RecorderState::Idle | RecorderState::Ready) {
            let _ = self.state.transition(RecorderState::PermissionCheck);
        }
        if self.state.state() != RecorderState::PermissionCheck {
            return;
        }
        let target = if snapshot.availability != BackendAvailability::Available {
            RecorderState::DeviceUnavailable
        } else if snapshot.microphone.is_granted() {
            RecorderState::Ready
        } else {
            RecorderState::PermissionBlocked
        };
        let _ = self.state.transition(target);
    }

    /// Enumerate input devices for a source kind. `Err(device_unavailable)` means "no usable device",
    /// which the UI must show rather than quietly using a different microphone.
    pub fn devices(&self, kind: SourceKind) -> Result<Vec<AudioDevice>, RecorderError> {
        self.backend.devices(kind)
    }

    /// Open the relevant System Settings pane when the bridge supports it.
    pub fn open_settings_for(&self, kind: SourceKind) -> Result<(), RecorderError> {
        self.backend.open_settings_for(kind)
    }

    /// Commit `ready -> recording`: capture `t = 0`, create the session directory, write manifest
    /// revision 1, then start capture and the writer threads.
    pub fn start(&mut self, request: &StartRequest) -> Result<RecorderStatus, RecorderError> {
        if self.state.state() != RecorderState::Ready {
            return Err(RecorderError::new(
                RecorderErrorCode::InvalidStateTransition,
                format!("recording may only start from ready (currently {})", self.state.state().as_str()),
                true,
            ));
        }
        if !request.consent_acknowledged {
            return Err(RecorderError::new(
                RecorderErrorCode::PermissionDenied,
                "consent acknowledgement is required before capture",
                true,
            ));
        }
        if request.chunk_interval_ms < MIN_CHUNK_INTERVAL_MS {
            return Err(RecorderError::new(
                RecorderErrorCode::InternalError,
                format!("chunk interval must be at least {MIN_CHUNK_INTERVAL_MS} ms"),
                false,
            ));
        }
        self.config.chunk_interval_ms = request.chunk_interval_ms;

        let snapshot = self.backend.permission_snapshot();
        if self.backend.availability() != BackendAvailability::Available {
            let error = RecorderError::new(
                RecorderErrorCode::PlatformUnsupported,
                "no capture backend is available in this build",
                false,
            );
            self.enter_fault(&error);
            return Err(error);
        }
        if !snapshot.microphone.is_granted() {
            let error = RecorderError::new(RecorderErrorCode::PermissionDenied, "microphone permission is not granted", true)
                .with_source(SourceKind::Microphone)
                .with_settings_hint(self.backend.settings_url(SourceKind::Microphone));
            self.enter_fault(&error);
            return Err(error);
        }
        if request.capture_system_audio && !snapshot.system_audio.is_granted() {
            let error = RecorderError::new(
                RecorderErrorCode::SystemAudioUnavailable,
                "system audio capture was requested but is not available; the session was NOT started as a microphone-only recording",
                true,
            )
            .with_source(SourceKind::SystemAudio)
                .with_settings_hint(self.backend.settings_url(SourceKind::SystemAudio));
            self.enter_fault(&error);
            return Err(error);
        }

        let devices = self.backend.devices(SourceKind::Microphone).unwrap_or_default();
        let selected = resolve_device(&devices, request.microphone_device_uid.as_deref())?;

        let session_id = uuid::Uuid::new_v4();
        let recording_id = uuid::Uuid::new_v4();
        let session_dir = self.root.session_dir(&session_id.to_string())?;
        self.root.prepare_session_dir(&session_dir)?;

        // `t = 0`: the reading taken now, before the streams are requested. Never reset later.
        let origin_ticks = self.clock.monotonic_ticks();
        let origin = TimelineOrigin::with_default_frequency(origin_ticks);
        let timestamp = self.clock.wall_clock_rfc3339(self.clock.wall_clock_ms());
        let sample_rate = self.config.sample_rate_hz;

        let mut sources = vec![SourceRecord {
            recording_source_id: uuid::Uuid::new_v4().to_string(),
            kind: SourceKind::Microphone,
            role: crate::manifest::SourceRole::Original,
            state: SourceHealth::Starting,
            sample_rate_hz: sample_rate,
            channels: 1,
            codec: crate::manifest::Codec::PcmS16Le,
            container: crate::manifest::Container::Wav,
            format: crate::manifest::CaptureFormat::WavPcmS16Le,
            device_uid: selected.as_ref().map(|device| device.uid.clone()),
            device_name: selected.as_ref().map(|device| device.name.clone()),
            first_sample_index: 0,
            last_sample_index_exclusive: 0,
            first_sample_meeting_ms: 0,
            last_sample_meeting_ms: None,
            dropped_sample_count: 0,
            started_at_ticks: DecimalU128(origin_ticks),
            ended_at_ticks: None,
            sample_map: Vec::new(),
        }];
        if request.capture_system_audio {
            sources.push(SourceRecord {
                recording_source_id: uuid::Uuid::new_v4().to_string(),
                kind: SourceKind::SystemAudio,
                role: crate::manifest::SourceRole::Original,
                state: SourceHealth::Starting,
                sample_rate_hz: sample_rate,
                channels: 2,
                codec: crate::manifest::Codec::PcmS16Le,
                container: crate::manifest::Container::Wav,
                format: crate::manifest::CaptureFormat::WavPcmS16Le,
                device_uid: None,
                device_name: Some("system output".into()),
                first_sample_index: 0,
                last_sample_index_exclusive: 0,
                first_sample_meeting_ms: 0,
                last_sample_meeting_ms: None,
                dropped_sample_count: 0,
                started_at_ticks: DecimalU128(origin_ticks),
                ended_at_ticks: None,
                sample_map: Vec::new(),
            });
        }

        let bytes_per_second: u64 = sources
            .iter()
            .map(|source| crate::storage::bytes_per_second(source.sample_rate_hz, source.channels, 2))
            .sum();
        let preflight = preflight_disk(&self.root, bytes_per_second, self.config.planned_seconds)?;
        self.disk = Some(DiskState {
            available_bytes: preflight.available_bytes,
            required_bytes: preflight.required_bytes,
            projected_bytes_per_hour: preflight.projected_bytes_per_hour,
            sufficient: preflight.sufficient,
            reserve_bytes: preflight.reserve_bytes,
        });
        if !preflight.sufficient {
            let error = RecorderError::new(
                RecorderErrorCode::DiskSpaceInsufficient,
                format!(
                    "not enough free space: {} bytes required for the planned session, {} available",
                    preflight.required_bytes, preflight.available_bytes
                ),
                true,
            );
            self.enter_fault(&error);
            return Err(error);
        }

        let mut manifest = RecorderManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            revision: 1,
            workspace_id: request.workspace_id.clone(),
            meeting_id: request.meeting_id.clone(),
            recording_id: recording_id.to_string(),
            session_id: session_id.to_string(),
            state: ManifestState::Recording,
            started_at: timestamp.clone(),
            stopped_at: None,
            timeline: TimelineBlock {
                clock: crate::manifest::ClockKind::PlatformMonotonicContinuous,
                clock_epoch_id: self.clock.epoch_id(),
                origin_ticks: DecimalU128(origin_ticks),
                origin_wall_clock_utc: timestamp.clone(),
                tick_frequency_hz: u64::try_from(TICK_FREQUENCY_HZ).unwrap_or(1_000_000_000),
            },
            active_intervals: vec![ActiveIntervalRecord {
                start_ticks: DecimalU128(origin_ticks),
                end_ticks: None,
                meeting_start_ms: 0,
                meeting_end_ms: None,
            }],
            pause_intervals: Vec::new(),
            consent: ConsentRecord {
                acknowledged_at: timestamp.clone(),
                policy_version: CONSENT_POLICY_VERSION.into(),
                participant_notice_shown: true,
            },
            storage: StorageRecord {
                layout_version: 1,
                directory_name: session_id.to_string(),
                local_only: true,
                encryption: LOCAL_ENCRYPTION_MODE.into(),
            },
            sources,
            chunks: Vec::new(),
            markers: Vec::new(),
            notes: Vec::new(),
            last_updated_at: timestamp,
            extra: serde_json::Map::new(),
        };
        manifest.validate()?;
        write_manifest_atomic(&session_dir, &manifest)?;

        self.origin = Some(origin);
        self.session_dir = Some(session_dir.clone());
        self.active_intervals = vec![ActiveInterval {
            start_ticks: origin_ticks,
            end_ticks: None,
        }];
        self.manifest = Some(manifest);
        if let Err(error) = self.state.transition(RecorderState::Recording) {
            self.persistence_fault = Some(error.clone());
            return Err(error);
        }
        self.events.push(RecorderEvent::State {
            state: RecorderState::Recording,
        });

        if let Err(error) = self.spawn_writers(session_dir, origin) {
            self.persistence_fault = Some(error.clone());
            self.events.push(RecorderEvent::Fault { error: error.clone() });
            let _ = self.persist(ManifestState::Failed);
            self.state.restore(RecorderState::Failed);
            return Err(error);
        }
        Ok(self.status())
    }

    fn spawn_writers(&mut self, session_dir: PathBuf, origin: TimelineOrigin) -> Result<(), RecorderError> {
        let (sources, recording_id) = {
            let manifest = self.manifest.as_ref().ok_or_else(not_started)?;
            (manifest.sources.clone(), manifest.recording_id.clone())
        };
        for source in sources {
            let queue = Arc::new(BoundedBlockQueue::new(QUEUE_CAPACITY_BLOCKS, QUEUE_CAPACITY_BYTES));
            let callback = Arc::new(QueueCallback::new(Arc::clone(&queue)));
            let config = SourceConfig {
                kind: source.kind,
                sample_rate_hz: source.sample_rate_hz,
                channels: source.channels,
                device_uid: source.device_uid.clone(),
                required: true,
            };
            let stream = match self.backend.start(config, Arc::clone(&callback) as Arc<dyn CaptureCallback>) {
                Ok(stream) => stream,
                Err(error) => {
                    let error = error.with_source(source.kind);
                    if source.kind == SourceKind::Microphone {
                        // No microphone audio at all: fail visibly instead of starting a one-sided session.
                        self.events.push(RecorderEvent::Fault { error: error.clone() });
                        self.stop_all_writers();
                        return Err(error);
                    }
                    // System audio unavailable is a visible health state, never a silent mic-only fallback.
                    self.events.push(RecorderEvent::Fault {
                        error: error.clone(),
                    });
                    if let Some(manifest) = self.manifest.as_mut() {
                        if let Some(record) = manifest
                            .sources
                            .iter_mut()
                            .find(|record| record.kind == SourceKind::SystemAudio)
                        {
                            record.state = SourceHealth::Unavailable;
                            record.ended_at_ticks = Some(DecimalU128(self.clock.monotonic_ticks()));
                        }
                        let now = meeting_ms_from_ticks(&origin, self.clock.monotonic_ticks());
                        manifest.pause_intervals.push(GapRecord {
                            meeting_start_ms: now,
                            meeting_end_ms: now,
                            estimated: false,
                            reason: GapReason::SourceStopped,
                            source_kind: Some(SourceKind::SystemAudio),
                        });
                    }
                    continue;
                }
            };
            // The bridge reports the format it actually produced; the manifest records that, not the
            // requested value. A sample-rate mismatch must never be hidden.
            let source = if let Some((actual_rate, actual_channels)) = stream.actual_format() {
                let mut corrected = source.clone();
                corrected.sample_rate_hz = actual_rate;
                corrected.channels = actual_channels;
                if let Some(manifest) = self.manifest.as_mut() {
                    if let Some(record) = manifest
                        .sources
                        .iter_mut()
                        .find(|record| record.recording_source_id == corrected.recording_source_id)
                    {
                        record.sample_rate_hz = actual_rate;
                        record.channels = actual_channels;
                    }
                }
                corrected
            } else {
                source
            };
            let (control_tx, control_rx) = channel::<WriterCommand>();
            let flush_ack = Arc::new(AtomicBool::new(false));
            let new_segment_pending = Arc::new(AtomicBool::new(true));
            let device_changed_pending = Arc::new(AtomicBool::new(false));
            let spec = WriterSpec {
                kind: source.kind,
                recording_id: recording_id.clone(),
                recording_source_id: source.recording_source_id.clone(),
                session_dir: session_dir.clone(),
                origin,
                chunk_interval_ms: self.config.chunk_interval_ms,
                wav: WavFormat {
                    sample_rate_hz: source.sample_rate_hz,
                    channels: source.channels,
                },
            };
            let writer = ChunkWriter::new(
                spec,
                Arc::clone(&queue),
                control_rx,
                Arc::clone(&flush_ack),
                Arc::clone(&new_segment_pending),
                device_changed_pending,
                self.outcome_tx.clone(),
            );
            let thread = std::thread::spawn(move || writer.run());
            self.writers.insert(
                source.kind,
                WriterHandle {
                    control: control_tx,
                    queue,
                    callback_stopped: callback.stop_flag(),
                    flush_ack,
                    new_segment_pending,
                    thread: Some(thread),
                },
            );
            self.streams.insert(source.kind, Mutex::new(stream));
        }
        Ok(())
    }

    /// `recording -> paused`: stop delivery, make the open chunk durable, and keep the canonical
    /// timeline intact — the paused interval stays as an explicit silent gap.
    pub fn pause(&mut self) -> Result<RecorderStatus, RecorderError> {
        self.transition(RecorderState::Paused)?;
        let ticks = self.clock.monotonic_ticks();
        let origin = self.origin.ok_or_else(not_started)?;
        let meeting_ms = meeting_ms_from_ticks(&origin, ticks);
        for handle in self.writers.values() {
            handle.callback_stopped.store(true, Ordering::Release);
        }
        for (kind, stream) in &self.streams {
            if let Ok(mut guard) = stream.lock() {
                if let Err(error) = guard.pause() {
                    self.events.push(RecorderEvent::Fault {
                        error: error.with_source(*kind),
                    });
                }
            }
        }
        self.flush_writers()?;
        self.drain_outcomes();
        if let Some(interval) = self.active_intervals.last_mut() {
            interval.end_ticks = Some(ticks);
        }
        if let Some(manifest) = self.manifest.as_mut() {
            manifest.pause_intervals.push(GapRecord {
                meeting_start_ms: meeting_ms,
                meeting_end_ms: meeting_ms,
                estimated: false,
                reason: GapReason::Paused,
                source_kind: None,
            });
        }
        self.persist(ManifestState::Paused)
            .map(|()| self.drain_outcomes())?;
        Ok(self.status())
    }

    /// `paused -> recording`: audio appends at the new canonical time. `t = 0` is not reset and earlier
    /// chunks/segments are never shifted.
    pub fn resume(&mut self) -> Result<RecorderStatus, RecorderError> {
        self.transition(RecorderState::Recording)?;
        let origin = self.origin.ok_or_else(not_started)?;
        let ticks = self.clock.monotonic_ticks();
        let meeting_ms = meeting_ms_from_ticks(&origin, ticks);
        let mut resume_errors = Vec::new();
        for (kind, stream) in &self.streams {
            if let Ok(mut guard) = stream.lock() {
                if let Err(error) = guard.resume() {
                    resume_errors.push(error.with_source(*kind));
                }
            }
        }
        for handle in self.writers.values() {
            // The next block must open a new segment so nothing is interpolated across the pause.
            handle.new_segment_pending.store(true, Ordering::Release);
            handle.callback_stopped.store(false, Ordering::Release);
        }
        if let Some(manifest) = self.manifest.as_mut() {
            if let Some(gap) = manifest.pause_intervals.last_mut() {
                if gap.reason == GapReason::Paused && gap.meeting_end_ms <= gap.meeting_start_ms {
                    gap.meeting_end_ms = meeting_ms;
                }
            }
        }
        self.active_intervals.push(ActiveInterval {
            start_ticks: ticks,
            end_ticks: None,
        });
        for error in resume_errors {
            self.events.push(RecorderEvent::Fault { error });
        }
        self.persist(ManifestState::Recording)?;
        Ok(self.status())
    }

    /// `recording|paused -> finalizing -> stopped`: drain and finalize every open chunk, then write the
    /// final manifest revision. Upload state is untouched; a later phase owns it.
    pub fn stop(&mut self) -> Result<RecorderStatus, RecorderError> {
        // Closing an already-faulted session is idempotent: release the writers and report the truth,
        // without pretending the finalization succeeded or resurrecting a "healthy" recording.
        if self.state.state() == RecorderState::Failed {
            self.stop_all_writers();
            let _ = self.persist(ManifestState::Failed);
            self.drain_outcomes();
            return Ok(self.status());
        }
        self.transition(RecorderState::Finalizing)?;
        let origin = self.origin.ok_or_else(not_started)?;
        for handle in self.writers.values() {
            handle.callback_stopped.store(true, Ordering::Release);
        }
        for (kind, stream) in &self.streams {
            if let Ok(mut guard) = stream.lock() {
                if let Err(error) = guard.stop() {
                    self.events.push(RecorderEvent::Fault {
                        error: error.with_source(*kind),
                    });
                }
            }
        }
        let ticks = self.clock.monotonic_ticks();
        self.flush_writers()?;
        self.drain_outcomes();
        for handle in self.writers.values_mut() {
            let _ = handle.control.send(WriterCommand::Abort);
            handle.queue.close();
        }
        for handle in self.writers.values_mut() {
            if let Some(thread) = handle.thread.take() {
                if thread.join().is_err() {
                    let error = RecorderError::new(
                        RecorderErrorCode::WriterFailed,
                        "a chunk writer panicked while finalizing",
                        false,
                    );
                    self.persistence_fault = Some(error.clone());
                    self.events.push(RecorderEvent::Fault { error });
                }
            }
        }
        self.drain_outcomes();
        if let Some(manifest) = self.manifest.as_mut() {
            for source in &mut manifest.sources {
                source.ended_at_ticks = Some(DecimalU128(ticks));
                if source.state == SourceHealth::Unavailable {
                    // A source that failed stays failed.
                } else if source.sample_map.is_empty() {
                    source.state = SourceHealth::Unavailable;
                } else {
                    source.state = SourceHealth::Active;
                }
                source.last_sample_meeting_ms = last_sample_meeting_ms(source, origin);
            }
            if let Some(gap) = manifest.pause_intervals.last_mut() {
                if gap.meeting_end_ms <= gap.meeting_start_ms {
                    gap.meeting_end_ms = meeting_ms_from_ticks(&origin, ticks);
                }
            }
            manifest.stopped_at = Some(self.clock.wall_clock_rfc3339(self.clock.wall_clock_ms()));
        }
        if let Some(interval) = self.active_intervals.last_mut() {
            if interval.end_ticks.is_none() {
                interval.end_ticks = Some(ticks);
            }
        }
        self.transition(RecorderState::Stopped)?;
        self.persist(ManifestState::Stopped)?;
        self.drain_outcomes();
        self.join_writers();
        Ok(self.status())
    }

    /// `Mark important`: a timestamped marker on the canonical timeline. Allowed while paused.
    pub fn mark_important(&mut self, label: Option<&str>) -> Result<MarkerRecord, RecorderError> {
        self.require_open_session()?;
        let origin = self.origin.ok_or_else(not_started)?;
        let meeting_ms = meeting_ms_from_ticks(&origin, self.clock.monotonic_ticks());
        let label = label.map(str::to_string).unwrap_or_else(|| "Important".to_string());
        if label.trim().is_empty() || label.chars().count() > 120 {
            return Err(RecorderError::new(
                RecorderErrorCode::InternalError,
                "marker label must be 1..=120 characters",
                true,
            ));
        }
        let marker = MarkerRecord {
            marker_id: uuid::Uuid::new_v4().to_string(),
            created_at: self.clock.wall_clock_rfc3339(self.clock.wall_clock_ms()),
            meeting_ms,
            label,
            author_user_id: None,
        };
        if let Some(manifest) = self.manifest.as_mut() {
            manifest.markers.push(marker.clone());
        }
        self.drain_outcomes();
        self.persist_current_state()?;
        self.events.push(RecorderEvent::Annotation {
            marker: Some(Box::new(marker.clone())),
            note: None,
        });
        Ok(marker)
    }

    /// Add a timestamped manual note. Notes are annotation records, never transcript segments.
    pub fn add_note(&mut self, text: &str) -> Result<NoteRecord, RecorderError> {
        self.require_open_session()?;
        let trimmed = text.trim();
        let chars = trimmed.chars().count();
        if chars == 0 || chars > 4000 {
            return Err(RecorderError::new(
                RecorderErrorCode::InternalError,
                "note text must be 1..=4000 characters",
                true,
            ));
        }
        let origin = self.origin.ok_or_else(not_started)?;
        let meeting_ms = meeting_ms_from_ticks(&origin, self.clock.monotonic_ticks());
        let note = NoteRecord {
            note_id: uuid::Uuid::new_v4().to_string(),
            created_at: self.clock.wall_clock_rfc3339(self.clock.wall_clock_ms()),
            meeting_ms,
            text: trimmed.to_string(),
            kind: crate::manifest::NoteKind::Manual,
            author_user_id: None,
        };
        if let Some(manifest) = self.manifest.as_mut() {
            manifest.notes.push(note.clone());
        }
        self.drain_outcomes();
        self.persist_current_state()?;
        self.events.push(RecorderEvent::Annotation {
            marker: None,
            note: Some(Box::new(note.clone())),
        });
        Ok(note)
    }

    /// Pull writer outcomes into the manifest, refresh disk headroom, and detect a removed device.
    /// The UI calls this on a timer; the Tauri layer also pumps before answering any command.
    pub fn pump(&mut self) -> Result<RecorderStatus, RecorderError> {
        self.drain_outcomes();
        self.check_device_presence()?;
        self.check_stall();
        self.refresh_disk_state();
        Ok(self.status())
    }

    fn refresh_disk_state(&mut self) {
        let Some(manifest) = self.manifest.as_ref() else {
            return;
        };
        let bytes_per_second: u64 = manifest
            .sources
            .iter()
            .filter(|source| source.state != SourceHealth::Unavailable)
            .map(|source| crate::storage::bytes_per_second(source.sample_rate_hz, source.channels, 2))
            .sum();
        if bytes_per_second == 0 {
            return;
        }
        let Ok(preflight) = preflight_disk(&self.root, bytes_per_second, self.config.planned_seconds) else {
            return;
        };
        let was_sufficient = self.disk.map_or(true, |disk| disk.sufficient);
        self.disk = Some(DiskState {
            available_bytes: preflight.available_bytes,
            required_bytes: preflight.required_bytes,
            projected_bytes_per_hour: preflight.projected_bytes_per_hour,
            sufficient: preflight.sufficient,
            reserve_bytes: preflight.reserve_bytes,
        });
        if was_sufficient && !preflight.sufficient && self.state.state().is_capturing() {
            self.events.push(RecorderEvent::Fault {
                error: RecorderError::new(
                    RecorderErrorCode::DiskSpaceInsufficient,
                    "free space dropped below the reserve needed to finish this session safely",
                    true,
                ),
            });
        }
    }

    fn check_stall(&mut self) {
        if !self.state.state().is_capturing() {
            return;
        }
        let now_ms = self.clock.monotonic_ticks() / 1_000_000;
        let stalled: Vec<SourceKind> = self
            .levels
            .iter()
            .filter_map(|(kind, level)| {
                let last = self.level_meeting_ms.get(kind).copied().unwrap_or(0);
                (level.live && now_ms.saturating_sub(last) > u128::from(STALL_THRESHOLD_MS)).then_some(*kind)
            })
            .collect();
        for kind in stalled {
            if let Some(level) = self.levels.get_mut(&kind) {
                level.live = false;
                level.peak_dbfs = SILENCE_DBFS;
            }
            if let Some(manifest) = self.manifest.as_mut() {
                if let Some(source) = manifest.sources.iter_mut().find(|source| source.kind == kind) {
                    if source.state == SourceHealth::Active {
                        source.state = SourceHealth::Degraded;
                    }
                }
            }
            self.events.push(RecorderEvent::Fault {
                error: RecorderError::new(
                    RecorderErrorCode::CaptureStalled,
                    "no audio blocks arrived from this source recently",
                    true,
                )
                .with_source(kind),
            });
        }
    }

    /// Detect that the selected input device disappeared. The response is explicit and visible; another
    /// microphone is never substituted mid-capture.
    fn check_device_presence(&mut self) -> Result<(), RecorderError> {
        if !matches!(self.state.state(), RecorderState::Recording | RecorderState::Paused) {
            return Ok(());
        }
        let Some(manifest) = self.manifest.as_ref() else {
            return Ok(());
        };
        let Some(mic) = manifest.sources.iter().find(|source| source.kind == SourceKind::Microphone) else {
            return Ok(());
        };
        if mic.state == SourceHealth::Unavailable {
            return Ok(());
        }
        let Some(expected_uid) = mic.device_uid.clone() else {
            return Ok(());
        };
        let devices = match self.backend.devices(SourceKind::Microphone) {
            Ok(devices) => devices,
            // A backend that cannot enumerate devices must not be read as "device lost".
            Err(_) => return Ok(()),
        };
        if devices.is_empty() || devices.iter().any(|device| device.uid == expected_uid && device.is_available) {
            return Ok(());
        }
        let error = RecorderError::new(
            RecorderErrorCode::DeviceLost,
            "the selected microphone is no longer present; no other device was substituted",
            true,
        )
        .with_source(SourceKind::Microphone);
        let now = self
            .origin
            .map(|origin| meeting_ms_from_ticks(&origin, self.clock.monotonic_ticks()))
            .unwrap_or(0);
        let ticks = self.clock.monotonic_ticks();
        let mut live_sources = 0usize;
        if let Some(manifest) = self.manifest.as_mut() {
            for source in &mut manifest.sources {
                if source.kind == SourceKind::Microphone {
                    source.state = SourceHealth::Unavailable;
                    source.ended_at_ticks = Some(DecimalU128(ticks));
                    if let Some(handle) = self.writers.get(&SourceKind::Microphone) {
                        handle.new_segment_pending.store(true, Ordering::Release);
                    }
                }
                if source.state != SourceHealth::Unavailable {
                    live_sources += 1;
                }
            }
            manifest.pause_intervals.push(GapRecord {
                meeting_start_ms: now,
                meeting_end_ms: now,
                estimated: false,
                reason: GapReason::SourceStopped,
                source_kind: Some(SourceKind::Microphone),
            });
        }
        self.events.push(RecorderEvent::Fault { error });
        if live_sources == 0 {
            // Nothing is being captured any more: stop claiming a healthy recording.
            if self.state.transition(RecorderState::DeviceUnavailable).is_err() {
                self.state.restore(RecorderState::DeviceUnavailable);
            }
            self.events.push(RecorderEvent::State {
                state: RecorderState::DeviceUnavailable,
            });
            self.persist(ManifestState::Failed)?;
        } else {
            self.persist_current_state()?;
        }
        Ok(())
    }

    fn flush_writers(&mut self) -> Result<(), RecorderError> {
        for handle in self.writers.values() {
            handle.flush_ack.store(false, Ordering::Release);
            let _ = handle.control.send(WriterCommand::Flush);
        }
        let deadline = std::time::Instant::now() + FLUSH_TIMEOUT;
        let mut pending: Vec<SourceKind> = self.writers.keys().copied().collect();
        while !pending.is_empty() && std::time::Instant::now() < deadline {
            for kind in pending.clone() {
                let Some(handle) = self.writers.get(&kind) else { continue };
                if handle.flush_ack.load(Ordering::Acquire) {
                    pending.retain(|pending_kind| *pending_kind != kind);
                }
            }
            if pending.is_empty() {
                break;
            }
            std::thread::sleep(FLUSH_POLL_INTERVAL);
        }
        if pending.is_empty() {
            return Ok(());
        }
        let error = RecorderError::new(
            RecorderErrorCode::WriterFailed,
            format!("chunk writers did not acknowledge finalization for {pending:?}"),
            false,
        );
        self.persistence_fault = Some(error.clone());
        self.events.push(RecorderEvent::Fault { error: error.clone() });
        Err(error)
    }

    fn stop_all_writers(&mut self) {
        for handle in self.writers.values() {
            handle.callback_stopped.store(true, Ordering::Release);
            let _ = handle.control.send(WriterCommand::Abort);
            handle.queue.close();
        }
        self.join_writers();
        for (kind, stream) in &self.streams {
            if let Ok(mut guard) = stream.lock() {
                let _ = guard.stop();
            }
            let _ = kind;
        }
    }

    fn join_writers(&mut self) {
        for handle in self.writers.values_mut() {
            if let Some(thread) = handle.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn drain_outcomes(&mut self) {
        let mut applied = false;
        let mut events = Vec::new();
        loop {
            let outcome = match self.outcomes.lock() {
                Ok(mut receiver) => receiver.try_recv(),
                Err(_) => break,
            };
            let Ok(outcome) = outcome else { break };
            applied = true;
            match outcome {
                WriterOutcome::ChunkFinalized { chunk, .. } => {
                    if let Some(manifest) = self.manifest.as_mut() {
                        manifest.apply_chunk(&chunk);
                    }
                    self.last_finalized_chunk_at = chunk.finalized_at.clone();
                    events.push(RecorderEvent::ChunkFinalized { chunk });
                }
                WriterOutcome::Progress {
                    kind,
                    last_sample_index_exclusive,
                    last_tick,
                    meeting_ms,
                    level,
                } => {
                    self.levels.insert(kind, level);
                    self.level_meeting_ms.insert(kind, meeting_ms);
                    let _ = last_tick;
                    if let Some(manifest) = self.manifest.as_mut() {
                        if let Some(source) = manifest.sources.iter_mut().find(|source| source.kind == kind) {
                            source.last_sample_index_exclusive = source
                                .last_sample_index_exclusive
                                .max(last_sample_index_exclusive);
                            source.last_sample_meeting_ms = Some(meeting_ms);
                            if let Some(current) = self.segments.get(&kind) {
                                upsert_segment(source, current);
                            }
                            if source.state != SourceHealth::Unavailable {
                                source.state = if source.dropped_sample_count > 0 {
                                    SourceHealth::Degraded
                                } else {
                                    SourceHealth::Active
                                };
                            }
                        }
                    }
                }
                WriterOutcome::SegmentStarted {
                    kind,
                    segment_index,
                    first_sample_index,
                    first_tick,
                    meeting_ms,
                    reason,
                } => {
                    self.segments.insert(
                        kind,
                        CurrentSegment {
                            index: segment_index,
                            first_sample_index,
                            first_tick,
                        },
                    );
                    if let Some(manifest) = self.manifest.as_mut() {
                        if let Some(source) = manifest.sources.iter_mut().find(|source| source.kind == kind) {
                            if source.sample_map.is_empty() {
                                source.first_sample_index = first_sample_index;
                                source.first_sample_meeting_ms = meeting_ms;
                            }
                            if segment_index > 0 {
                                source.sample_map.push(SourceSegment {
                                    first_sample_index,
                                    first_sample_ticks: first_tick,
                                    sample_count: 0,
                                });
                            } else if let Some(last) = source.sample_map.last_mut() {
                                last.first_sample_ticks = first_tick;
                                last.first_sample_index = first_sample_index;
                            }
                            let _ = reason;
                        }
                    }
                }
                WriterOutcome::Overflow { kind, dropped_samples } => {
                    if let Some(manifest) = self.manifest.as_mut() {
                        if let Some(source) = manifest.sources.iter_mut().find(|source| source.kind == kind) {
                            source.dropped_sample_count = source.dropped_sample_count.saturating_add(dropped_samples);
                            source.state = SourceHealth::Degraded;
                        }
                        let now = self
                            .origin
                            .map(|origin| meeting_ms_from_ticks(&origin, self.clock.monotonic_ticks()))
                            .unwrap_or(0);
                        manifest.pause_intervals.push(GapRecord {
                            meeting_start_ms: now,
                            meeting_end_ms: now,
                            estimated: false,
                            reason: GapReason::SourceStopped,
                            source_kind: Some(kind),
                        });
                    }
                    if let Some(level) = self.levels.get_mut(&kind) {
                        level.live = false;
                    }
                    events.push(RecorderEvent::Fault {
                        error: RecorderError::new(
                            RecorderErrorCode::CaptureStalled,
                            format!("{dropped_samples} samples were refused by the capture queue"),
                            true,
                        )
                        .with_source(kind),
                    });
                }
                WriterOutcome::Flushed { .. } => {}
                WriterOutcome::Fault { kind, error } => {
                    let error = error.with_source(kind);
                    self.persistence_fault = Some(error.clone());
                    events.push(RecorderEvent::Fault { error });
                    if self.state.state().is_capturing() || self.state.state() == RecorderState::Paused {
                        self.state.restore(RecorderState::Failed);
                        events.push(RecorderEvent::State {
                            state: RecorderState::Failed,
                        });
                    }
                }
            }
        }
        if applied {
            let _ = self.persist_current_state();
        }
        self.events.append(&mut events);
    }

    fn require_open_session(&self) -> Result<(), RecorderError> {
        match self.state.state() {
            RecorderState::Recording | RecorderState::Paused => Ok(()),
            other => Err(RecorderError::new(
                RecorderErrorCode::InvalidStateTransition,
                format!("no open recording session (state {})", other.as_str()),
                true,
            )),
        }
    }

    fn transition(&mut self, to: RecorderState) -> Result<(), RecorderError> {
        self.state.transition(to)?;
        self.events.push(RecorderEvent::State { state: to });
        Ok(())
    }

    fn enter_fault(&mut self, error: &RecorderError) {
        self.events.push(RecorderEvent::Fault { error: error.clone() });
        let blocked = matches!(
            error.code,
            RecorderErrorCode::PermissionDenied | RecorderErrorCode::PermissionUnknown
        );
        let unavailable = matches!(
            error.code,
            RecorderErrorCode::DeviceUnavailable
                | RecorderErrorCode::DeviceLost
                | RecorderErrorCode::PlatformUnsupported
                | RecorderErrorCode::SystemAudioUnavailable
        );
        let target = if blocked {
            RecorderState::PermissionBlocked
        } else if unavailable {
            RecorderState::DeviceUnavailable
        } else {
            RecorderState::Failed
        };
        if self.state.transition(target).is_err() {
            self.state.restore(target);
        }
    }

    /// Write the next manifest revision. A failure becomes a persistence fault, after which the session
    /// is never presented as a healthy recording again.
    fn persist(&mut self, state: ManifestState) -> Result<(), RecorderError> {
        let Some(manifest) = self.manifest.as_mut() else {
            return Ok(());
        };
        manifest.state = state;
        manifest.revision = manifest.revision.saturating_add(1);
        manifest.last_updated_at = self.clock.wall_clock_rfc3339(self.clock.wall_clock_ms());
        manifest.active_intervals = self
            .active_intervals
            .iter()
            .map(|interval| {
                let origin = self.origin.unwrap_or_else(|| TimelineOrigin::with_default_frequency(0));
                ActiveIntervalRecord {
                    start_ticks: DecimalU128(interval.start_ticks),
                    end_ticks: interval.end_ticks.map(DecimalU128),
                    meeting_start_ms: meeting_ms_from_ticks(&origin, interval.start_ticks),
                    meeting_end_ms: interval.end_ticks.map(|ticks| meeting_ms_from_ticks(&origin, ticks)),
                }
            })
            .collect();
        for source in &mut manifest.sources {
            if let Some(current) = self.segments.get(&source.kind) {
                upsert_segment(source, current);
            }
        }
        let result = (|| {
            manifest.validate()?;
            if let Some(dir) = self.session_dir.as_ref() {
                write_manifest_atomic(dir, manifest)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.persistence_fault = Some(error.clone());
            self.events.push(RecorderEvent::Fault {
                error: error.clone(),
            });
            // A session the UI still shows as healthy would be a lie. Any manifest write that fails
            // while capturing (or paused) stops the writers so no more audio is claimed, then moves to
            // `failed`. `docs/recording.md` §3 treats persistence as part of the state machine.
            if self.state.state().is_capturing() || self.state.state() == RecorderState::Paused {
                self.stop_all_writers();
                self.state.restore(RecorderState::Failed);
            }
            return Err(error);
        }
        Ok(())
    }

    fn persist_current_state(&mut self) -> Result<(), RecorderError> {
        let state = manifest_state_of(self.state.state());
        self.persist(state)
    }

    /// Snapshot for the renderer. Reads no files and never derives a duration from byte sizes.
    #[must_use]
    pub fn status(&self) -> RecorderStatus {
        let now = self.clock.monotonic_ticks();
        let origin = self.origin;
        let canonical_elapsed_ms = origin.map_or(0, |origin| canonical_duration_ms(&origin, now));
        let tick_frequency = origin.map_or(TICK_FREQUENCY_HZ, |origin| origin.tick_frequency_hz);
        let manifest = self.manifest.as_ref();
        let (recording_id, session_id, session_directory, chunk_count, finalized_chunk_count, sources, gaps, epoch) =
            match manifest {
                Some(manifest) => (
                    Some(manifest.recording_id.clone()),
                    Some(manifest.session_id.clone()),
                    Some(manifest.storage.directory_name.clone()),
                    manifest.chunks.len() as u64,
                    manifest.chunks.iter().filter(|chunk| chunk.state.is_durable()).count() as u64,
                    manifest.sources.clone(),
                    manifest.pause_intervals.clone(),
                    Some(manifest.timeline.clock_epoch_id.clone()),
                ),
                None => (
                    None,
                    None,
                    None,
                    0,
                    0,
                    Vec::new(),
                    Vec::new(),
                    Some(self.clock.epoch_id()),
                ),
            };
        let levels = sources
            .iter()
            .map(|source| SourceLevel {
                kind: source.kind,
                level: self
                    .levels
                    .get(&source.kind)
                    .copied()
                    .filter(|_| source.state != SourceHealth::Unavailable)
                    .unwrap_or_else(LevelSnapshot::silent),
                meeting_ms: self.level_meeting_ms.get(&source.kind).copied().unwrap_or(0),
            })
            .collect();
        RecorderStatus {
            state: self.state.state(),
            canonical_elapsed_ms,
            active_capture_ms: crate::timeline::active_capture_ms(&self.active_intervals, tick_frequency),
            recording_id,
            session_id,
            session_directory,
            sources,
            levels,
            gaps,
            chunk_count,
            finalized_chunk_count,
            last_finalized_chunk_at: self.last_finalized_chunk_at.clone(),
            persistence_fault: self.persistence_fault.clone(),
            disk: self.disk,
            clock_epoch_id: epoch,
        }
    }
}

/// Keep the source's current segment in step with the writer's progress. The count is always derived
/// from the *delivered sample indices*, so a device stall shows up as a hole rather than as stretched
/// audio.
fn upsert_segment(source: &mut SourceRecord, current: &CurrentSegment) {
    let samples = source.last_sample_index_exclusive.saturating_sub(current.first_sample_index);
    if let Some(last) = source.sample_map.last_mut() {
        if last.first_sample_index == current.first_sample_index {
            last.sample_count = samples;
            last.first_sample_ticks = current.first_tick;
            return;
        }
    }
    source.sample_map.push(SourceSegment {
        first_sample_index: current.first_sample_index,
        first_sample_ticks: current.first_tick,
        sample_count: samples,
    });
}

fn last_sample_meeting_ms(source: &SourceRecord, origin: TimelineOrigin) -> Option<u64> {
    let last = source.sample_map.iter().filter(|segment| segment.sample_count > 0).last()?;
    let map = crate::timeline::SourceSampleMap {
        sample_rate_hz: source.sample_rate_hz,
        segments: vec![*last],
    };
    let index = last.first_sample_index + last.sample_count - 1;
    match crate::timeline::meeting_ms_of_sample(&map, &origin, index) {
        crate::timeline::SampleToTime::Sample { meeting_ms, .. } => Some(meeting_ms),
        _ => None,
    }
}

fn not_started() -> RecorderError {
    RecorderError::new(RecorderErrorCode::InvalidStateTransition, "no recording session is open", true)
}

fn resolve_device(devices: &[AudioDevice], requested: Option<&str>) -> Result<Option<AudioDevice>, RecorderError> {
    if devices.is_empty() {
        return Ok(None);
    }
    if let Some(uid) = requested {
        return devices
            .iter()
            .find(|device| device.uid == uid && device.is_available)
            .cloned()
            .map(Some)
            .ok_or_else(|| {
                RecorderError::new(
                    RecorderErrorCode::DeviceUnavailable,
                    "the selected microphone is unavailable; no substitution was made",
                    true,
                )
                .with_source(SourceKind::Microphone)
            });
    }
    Ok(devices
        .iter()
        .find(|device| device.is_default && device.is_available)
        .or_else(|| devices.iter().find(|device| device.is_available))
        .cloned())
}
