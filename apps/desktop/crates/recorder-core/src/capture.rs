//! Capture-backend boundary.
//!
//! The recorder core knows nothing about AVFoundation or ScreenCaptureKit: it talks to a
//! [`CaptureBackend`] trait. The macOS implementation lives in `crates/capture-macos`; every other
//! target gets [`UnavailableBackend`], which fails closed with an explicit typed error instead of
//! pretending a microphone-only session is a complete recording.
//!
//! The contract for backends:
//! * a block is delivered to [`CaptureCallback::on_block`] with the host monotonic tick of its first
//!   sample, so both sources are timestamped against one clock;
//! * callbacks must never block: they push into a bounded queue and return;
//! * if the queue is full, `on_overflow` is called with the number of samples that will be lost, and
//!   the source is marked degraded by the coordinator (no unbounded memory growth, no silent loss).

use crate::errors::{RecorderError, RecorderErrorCode, SourceKind};
use crate::platform::{AudioDevice, PermissionSnapshot, PermissionState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// One contiguous block of interleaved signed 16-bit PCM from one source.
#[derive(Debug, Clone)]
pub struct AudioBlock {
    /// Source-global index of this block's first sample.
    pub first_sample_index: u64,
    /// Host monotonic tick of this block's first sample.
    pub first_tick: u128,
    /// Interleaved samples (`sample_count * channels` entries).
    pub samples: Vec<i16>,
    /// True when the block follows a stall/restart, i.e. it begins a new segment.
    pub discontinuity: bool,
}

impl AudioBlock {
    #[must_use]
    pub fn sample_count(&self, channels: u16) -> u64 {
        u64::try_from(self.samples.len()).unwrap_or(0) / u64::from(channels.max(1))
    }
}

/// Sink the backend pushes into. Implementations must be cheap and non-blocking.
pub trait CaptureCallback: Send + Sync {
    /// Deliver a block. Returning `false` means the sink is closing; the backend must stop.
    fn on_block(&self, block: AudioBlock) -> bool;
    /// Report samples the backend could not deliver (device stall, dropped packet window).
    fn on_overflow(&self, dropped_samples: u64);
}

/// Health of one logical stream as reported by the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamState {
    Starting,
    Running,
    Paused,
    Ended,
    Failed,
}

/// A running capture stream.
pub trait CaptureStream: Send {
    /// Request a pause. Audio delivery must stop; `t = 0` is unaffected.
    fn pause(&mut self) -> Result<(), RecorderError>;
    /// Request a resume. The next delivered block must be marked as a discontinuity.
    fn resume(&mut self) -> Result<(), RecorderError>;
    /// Stop and release the stream. Idempotent.
    fn stop(&mut self) -> Result<(), RecorderError>;
    fn state(&self) -> StreamState;
    /// Frames the backend itself had to drop (device-side), separate from queue overflow.
    fn dropped_frames(&self) -> u64;
    /// The format actually produced, when the device differs from the request. The coordinator records
    /// what the hardware delivered instead of what it asked for, so the manifest never lies about the
    /// sample rate or channel count that a chunk was written with.
    #[must_use]
    fn actual_format(&self) -> Option<(u32, u16)> {
        None
    }
}

/// How the platform backend is currently usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendAvailability {
    /// The native bridge compiled in and the OS version supports the required APIs.
    Available,
    /// This OS has no implemented backend (for example Windows in this phase).
    UnsupportedPlatform,
    /// The OS is supported but a required API is missing (for example macOS < 13 for system audio).
    UnsupportedOsVersion,
}

/// Configuration for one requested source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceConfig {
    pub kind: SourceKind,
    pub sample_rate_hz: u32,
    pub channels: u16,
    /// `None` means the system default input device.
    pub device_uid: Option<String>,
    /// When false, system audio is not captured at all and the UI must say so.
    pub required: bool,
}

/// A platform capture implementation.
pub trait CaptureBackend: Send + Sync {
    fn availability(&self) -> BackendAvailability;
    fn permission_snapshot(&self) -> PermissionSnapshot;
    /// Trigger the OS prompt if the state is `permission_unknown`; never spam it when already denied.
    fn request_permissions(&self, kinds: &[SourceKind]) -> Result<PermissionSnapshot, RecorderError>;
    fn devices(&self, kind: SourceKind) -> Result<Vec<AudioDevice>, RecorderError>;
    /// Start one logical source. `device_changed` notifications are delivered through the callback's
    /// overflow/discontinuity signalling, never by silently swapping devices.
    fn start(&self, config: SourceConfig, callback: Arc<dyn CaptureCallback>) -> Result<Box<dyn CaptureStream>, RecorderError>;

    /// Deep link that would let the user fix this permission, when the OS offers one.
    #[must_use]
    fn settings_url(&self, _kind: SourceKind) -> Option<String> {
        None
    }

    /// Open the relevant System Settings pane. Default: unsupported (docs/recording.md §2 wants an
    /// actionable path where the OS supports one, not a generic error).
    fn open_settings_for(&self, kind: SourceKind) -> Result<(), RecorderError> {
        Err(RecorderError::new(
            RecorderErrorCode::PlatformUnsupported,
            "this platform cannot open a settings pane for permission repair",
            false,
        )
        .with_settings_hint(self.settings_url(kind)))
    }
}

/// Fail-closed backend used on every non-macOS target and whenever the native bridge is absent.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableBackend {
    reason: &'static str,
}

impl UnavailableBackend {
    #[must_use]
    pub const fn new(reason: &'static str) -> Self {
        Self { reason }
    }
}

impl CaptureBackend for UnavailableBackend {
    fn availability(&self) -> BackendAvailability {
        BackendAvailability::UnsupportedPlatform
    }

    fn permission_snapshot(&self) -> PermissionSnapshot {
        PermissionSnapshot {
            microphone: PermissionState::DeviceUnavailable,
            system_audio: PermissionState::DeviceUnavailable,
            availability: BackendAvailability::UnsupportedPlatform,
            os_version: std::env::consts::OS.to_string(),
            minimum_macos_version: None,
            open_settings_supported: false,
            detail: Some(self.reason.to_string()),
            checked_at: crate::clock::now_utc_rfc3339(),
        }
    }

    fn request_permissions(&self, _kinds: &[SourceKind]) -> Result<PermissionSnapshot, RecorderError> {
        Err(RecorderError::new(
            RecorderErrorCode::PlatformUnsupported,
            self.reason,
            false,
        ))
    }

    fn devices(&self, _kind: SourceKind) -> Result<Vec<AudioDevice>, RecorderError> {
        Err(RecorderError::new(RecorderErrorCode::PlatformUnsupported, self.reason, false))
    }

    fn start(&self, _config: SourceConfig, _callback: Arc<dyn CaptureCallback>) -> Result<Box<dyn CaptureStream>, RecorderError> {
        Err(RecorderError::new(RecorderErrorCode::PlatformUnsupported, self.reason, false))
    }
}

/// Bounded, non-blocking producer queue used between capture callbacks and the writer thread.
///
/// Backpressure policy (documented, deliberate): when the queue is full the newest block is refused,
/// the dropped-sample counter increases, and the writer is told the stream has a discontinuity. The
/// queue never grows without bound, and dropped audio is reported rather than hidden.
pub struct BoundedBlockQueue {
    inner: Mutex<QueueState>,
    not_empty: Condvar,
    capacity_blocks: usize,
    capacity_bytes: usize,
    dropped_samples: AtomicU64,
    closed: AtomicBool,
}

#[derive(Default)]
struct QueueState {
    blocks: std::collections::VecDeque<AudioBlock>,
    bytes: usize,
}

impl BoundedBlockQueue {
    #[must_use]
    pub fn new(capacity_blocks: usize, capacity_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(QueueState::default()),
            not_empty: Condvar::new(),
            capacity_blocks: capacity_blocks.max(1),
            capacity_bytes: capacity_bytes.max(4096),
            dropped_samples: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    /// Non-blocking push. Returns `false` when the block was refused (full queue or closed stream).
    pub fn try_push(&self, block: AudioBlock) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        let size = block.samples.len() * std::mem::size_of::<i16>();
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if state.blocks.len() >= self.capacity_blocks || state.bytes + size > self.capacity_bytes {
            let dropped = u64::try_from(block.samples.len()).unwrap_or(0);
            self.dropped_samples.fetch_add(dropped, Ordering::Relaxed);
            return false;
        }
        state.blocks.push_back(block);
        state.bytes += size;
        drop(state);
        self.not_empty.notify_one();
        true
    }

    /// Like [`Self::pop_batch`] but bounded by `timeout`, so a writer thread can also poll its control
    /// channel while the source is idle (paused, or between blocks).
    pub fn pop_batch_timeout(&self, max_blocks: usize, out: &mut Vec<AudioBlock>, timeout: std::time::Duration) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if state.blocks.is_empty() && !self.closed.load(Ordering::Acquire) {
            let next = match self.not_empty.wait_timeout(state, timeout) {
                Ok((next, _wait_result)) => next,
                Err(_) => return false,
            };
            state = next;
        }
        if state.blocks.is_empty() {
            return false;
        }
        let mut bytes = 0usize;
        while out.len() < max_blocks {
            let Some(block) = state.blocks.pop_front() else { break };
            bytes += block.samples.len() * std::mem::size_of::<i16>();
            out.push(block);
        }
        state.bytes = state.bytes.saturating_sub(bytes);
        true
    }

    /// Block until a batch is available or the queue is closed. Called only on the writer thread.
    pub fn pop_batch(&self, max_blocks: usize, out: &mut Vec<AudioBlock>) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        while state.blocks.is_empty() && !self.closed.load(Ordering::Acquire) {
            let Ok(next) = self.not_empty.wait(state) else {
                return false;
            };
            state = next;
        }
        if state.blocks.is_empty() {
            return false;
        }
        let mut bytes = 0usize;
        while out.len() < max_blocks {
            let Some(block) = state.blocks.pop_front() else { break };
            bytes += block.samples.len() * std::mem::size_of::<i16>();
            out.push(block);
        }
        state.bytes = state.bytes.saturating_sub(bytes);
        true
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _guard = self.inner.lock();
        self.not_empty.notify_all();
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn dropped_samples(&self) -> u64 {
        self.dropped_samples.swap(0, Ordering::Relaxed)
    }

    #[must_use]
    pub fn pending_blocks(&self) -> usize {
        self.inner.lock().map(|state| state.blocks.len()).unwrap_or(0)
    }
}

/// A queue-backed [`CaptureCallback`]: the realtime side only pushes and counts.
#[derive(Debug, Clone)]
pub struct QueueCallback {
    queue: Arc<BoundedBlockQueue>,
    stopped: Arc<AtomicBool>,
}

impl QueueCallback {
    #[must_use]
    pub fn new(queue: Arc<BoundedBlockQueue>) -> Self {
        Self {
            queue,
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Shared flag the coordinator flips to stop delivery without touching the backend.
    #[must_use]
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stopped)
    }
}

impl CaptureCallback for QueueCallback {
    fn on_block(&self, block: AudioBlock) -> bool {
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        self.queue.try_push(block)
    }

    fn on_overflow(&self, dropped_samples: u64) {
        // Device-side drops use the same counter as queue overflow so the coordinator sees one number.
        self.queue.dropped_samples.fetch_add(dropped_samples, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{AudioDevice, PermissionState};

    fn block(first_sample_index: u64, samples: usize) -> AudioBlock {
        AudioBlock {
            first_sample_index,
            first_tick: 1_000,
            samples: vec![0i16; samples],
            discontinuity: false,
        }
    }

    #[test]
    fn queue_accepts_until_full_then_refuses_and_counts() {
        let queue = Arc::new(BoundedBlockQueue::new(2, 4 * 1024));
        assert!(queue.try_push(block(0, 128)));
        assert!(queue.try_push(block(128, 128)));
        assert!(!queue.try_push(block(256, 128)), "third block must be refused");
        assert_eq!(queue.dropped_samples(), 128);
        assert_eq!(queue.pending_blocks(), 2);
        assert_eq!(queue.dropped_samples(), 0, "counter drains so it is never double counted");
    }

    #[test]
    fn byte_budget_also_bounds_the_queue() {
        let queue = Arc::new(BoundedBlockQueue::new(100, 256));
        assert!(queue.try_push(block(0, 64)));
        assert!(!queue.try_push(block(64, 64)), "256 bytes holds exactly 64 samples");
    }

    #[test]
    fn writer_wakes_on_push_and_on_close() {
        let queue = Arc::new(BoundedBlockQueue::new(8, 8 * 1024));
        let producer = Arc::clone(&queue);
        let handle = std::thread::spawn(move || {
            producer.try_push(block(0, 480));
            std::thread::sleep(std::time::Duration::from_millis(20));
            producer.close();
        });
        let mut batch = Vec::new();
        assert!(queue.pop_batch(8, &mut batch), "must wake for the pushed block");
        assert_eq!(batch.len(), 1);
        batch.clear();
        assert!(!queue.pop_batch(8, &mut batch), "closed queue returns false instead of hanging");
        assert!(batch.is_empty());
        handle.join().expect("producer");
    }

    #[test]
    fn callback_reports_refused_blocks_without_blocking() {
        let queue = Arc::new(BoundedBlockQueue::new(1, 1024));
        let callback = QueueCallback::new(Arc::clone(&queue));
        assert!(callback.on_block(block(0, 32)));
        assert!(!callback.on_block(block(32, 32)));
        callback.on_overflow(16);
        assert_eq!(queue.dropped_samples(), 48);
        callback.stop_flag().store(true, std::sync::atomic::Ordering::Release);
        assert!(!callback.on_block(block(64, 32)), "a stopped callback stops accepting");
    }

    #[test]
    fn unavailable_backend_fails_closed_everywhere_but_here() {
        let backend = UnavailableBackend::new("recording requires the macOS capture bridge");
        assert_eq!(backend.availability(), BackendAvailability::UnsupportedPlatform);
        let snapshot = backend.permission_snapshot();
        assert_eq!(snapshot.microphone, PermissionState::DeviceUnavailable);
        assert_eq!(snapshot.system_audio, PermissionState::DeviceUnavailable);
        assert!(!snapshot.open_settings_supported);
        let error = backend
            .start(
                SourceConfig {
                    kind: SourceKind::Microphone,
                    sample_rate_hz: 48_000,
                    channels: 1,
                    device_uid: None,
                    required: true,
                },
                Arc::new(QueueCallback::new(Arc::new(BoundedBlockQueue::new(1, 1024)))),
            )
            .expect_err("no capture may silently proceed");
        assert_eq!(error.code, RecorderErrorCode::PlatformUnsupported);
        assert!(matches!(
            backend.devices(SourceKind::Microphone),
            Err(RecorderError { .. })
        ));
        let _: Vec<AudioDevice> = Vec::new();
    }

    #[test]
    fn block_sample_count_uses_the_channel_count() {
        assert_eq!(block(0, 960).sample_count(2), 480);
        assert_eq!(block(0, 480).sample_count(1), 480);
        assert_eq!(block(0, 0).sample_count(0), 0);
    }
}
