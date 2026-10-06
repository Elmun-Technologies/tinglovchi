//! Scripted backend used by unit tests, integration tests, and the macOS acceptance harness.
//!
//! It exists so the *persistence* pipeline — chunk boundaries, pause gaps, manifest revisions,
//! recovery, level metering, fault propagation — can be exercised deterministically without audio
//! hardware. It deliberately proves nothing about ScreenCaptureKit or AVFoundation: those paths are
//! validated on real Macs per `docs/mac-recorder-acceptance.md`.

use crate::capture::{
    AudioBlock, BackendAvailability, CaptureBackend, CaptureCallback, CaptureStream, SourceConfig, StreamState,
};
use crate::errors::{RecorderError, RecorderErrorCode, SourceKind};
use crate::platform::{AudioDevice, PermissionSnapshot, PermissionState};
use crate::session::DEFAULT_SAMPLE_RATE_HZ;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A scripted source: a test pushes blocks through the callback the coordinator installed, exactly as
/// a native bridge would.
#[derive(Debug)]
pub struct ScriptedSource {
    pub kind: SourceKind,
    pub sample_rate_hz: u32,
    pub channels: u16,
    /// Reports a format different from the request, exercising the "record reality, not the request"
    /// path. `None` keeps the requested format.
    pub actual_sample_rate_hz: Option<u32>,
    callback: Mutex<Option<Arc<dyn CaptureCallback>>>,
    state: Mutex<StreamState>,
}

impl ScriptedSource {
    #[must_use]
    pub fn new(kind: SourceKind, sample_rate_hz: u32, channels: u16) -> Self {
        Self {
            kind,
            sample_rate_hz,
            channels,
            actual_sample_rate_hz: None,
            callback: Mutex::new(None),
            state: Mutex::new(StreamState::Starting),
        }
    }

    pub fn install_callback(&self, callback: Arc<dyn CaptureCallback>) {
        if let Ok(mut guard) = self.callback.lock() {
            *guard = Some(callback);
        }
    }

    /// Deliver one block. Returns `false` when the sink is closed (the coordinator stopped accepting).
    pub fn push(&self, block: AudioBlock) -> bool {
        match self.callback.lock() {
            Ok(guard) => guard.as_ref().map(|callback| callback.on_block(block)).unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Deliver `frames` samples of constant amplitude starting at `first_sample_index`.
    pub fn push_frames(&self, first_sample_index: u64, first_tick: u128, frames: usize, value: i16) -> bool {
        self.push(AudioBlock {
            first_sample_index,
            first_tick,
            samples: vec![value; frames * usize::from(self.channels)],
            discontinuity: false,
        })
    }

    /// Report that the backend itself had to drop samples.
    pub fn report_overflow(&self, dropped_samples: u64) {
        if let Ok(guard) = self.callback.lock() {
            if let Some(callback) = guard.as_ref() {
                callback.on_overflow(dropped_samples);
            }
        }
    }

    #[must_use]
    pub fn state(&self) -> StreamState {
        self.state.lock().map(|guard| *guard).unwrap_or(StreamState::Failed)
    }

    #[must_use]
    pub fn callback_present(&self) -> bool {
        self.callback.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }

    fn set_state(&self, state: StreamState) {
        if let Ok(mut guard) = self.state.lock() {
            *guard = state;
        }
    }
}

/// Handle handed to the coordinator, sharing state with the [`ScriptedSource`] the test holds.
#[derive(Debug, Clone)]
pub struct ScriptedStream {
    source: Arc<ScriptedSource>,
}

impl CaptureStream for ScriptedStream {
    fn pause(&mut self) -> Result<(), RecorderError> {
        self.source.set_state(StreamState::Paused);
        Ok(())
    }

    fn resume(&mut self) -> Result<(), RecorderError> {
        self.source.set_state(StreamState::Running);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), RecorderError> {
        self.source.set_state(StreamState::Ended);
        Ok(())
    }

    fn state(&self) -> StreamState {
        self.source.state()
    }

    fn dropped_frames(&self) -> u64 {
        0
    }

    fn actual_format(&self) -> Option<(u32, u16)> {
        self.source
            .actual_sample_rate_hz
            .map(|rate| (rate, self.source.channels))
    }
}

/// Deterministic backend: granted permissions, one input device, scripted blocks. No hardware and no
/// OS APIs are involved.
#[derive(Clone, Default)]
pub struct ScriptedBackend {
    pub granted: Arc<AtomicBool>,
    pub system_audio_granted: Arc<AtomicBool>,
    pub devices: Arc<Mutex<Vec<AudioDevice>>>,
    pub fail_system_audio: Arc<AtomicBool>,
    pub fail_microphone: Arc<AtomicBool>,
    pub sources: Arc<Mutex<Vec<Arc<ScriptedSource>>>>,
}

impl ScriptedBackend {
    /// Granted microphone and system audio, with one available built-in input device.
    #[must_use]
    pub fn granted() -> Self {
        Self {
            granted: Arc::new(AtomicBool::new(true)),
            system_audio_granted: Arc::new(AtomicBool::new(true)),
            devices: Arc::new(Mutex::new(vec![AudioDevice {
                uid: "built-in-mic".into(),
                name: "MacBook Pro Microphone".into(),
                is_default: true,
                is_available: true,
                sample_rate_hz: Some(DEFAULT_SAMPLE_RATE_HZ),
                channels: Some(1),
            }])),
            fail_system_audio: Arc::new(AtomicBool::new(false)),
            fail_microphone: Arc::new(AtomicBool::new(false)),
            sources: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// A backend with nothing granted, to exercise the `permission_denied` path.
    #[must_use]
    pub fn denied() -> Self {
        let backend = Self::granted();
        backend.granted.store(false, Ordering::Relaxed);
        backend.system_audio_granted.store(false, Ordering::Relaxed);
        backend
    }

    #[must_use]
    pub fn sources_of(&self, kind: SourceKind) -> Vec<Arc<ScriptedSource>> {
        self.sources
            .lock()
            .map(|guard| guard.iter().filter(|source| source.kind == kind).cloned().collect())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn all_sources(&self) -> Vec<Arc<ScriptedSource>> {
        self.sources.lock().map(|guard| guard.clone()).unwrap_or_default()
    }

    /// Simulate unplugging the input device: it stays listed but unusable.
    pub fn make_device_unavailable(&self) {
        if let Ok(mut guard) = self.devices.lock() {
            for device in &mut *guard {
                device.is_available = false;
            }
        }
    }

    pub fn set_granted(&self, kind: SourceKind, granted: bool) {
        match kind {
            SourceKind::Microphone => self.granted.store(granted, Ordering::Relaxed),
            SourceKind::SystemAudio => self.system_audio_granted.store(granted, Ordering::Relaxed),
        }
    }
}

impl CaptureBackend for ScriptedBackend {
    fn availability(&self) -> BackendAvailability {
        BackendAvailability::Available
    }

    fn permission_snapshot(&self) -> PermissionSnapshot {
        PermissionSnapshot {
            microphone: if self.granted.load(Ordering::Relaxed) {
                PermissionState::Granted
            } else {
                PermissionState::Denied
            },
            system_audio: if self.system_audio_granted.load(Ordering::Relaxed) {
                PermissionState::Granted
            } else {
                PermissionState::Denied
            },
            availability: BackendAvailability::Available,
            os_version: "scripted".into(),
            minimum_macos_version: Some("13.0".into()),
            open_settings_supported: true,
            detail: None,
            checked_at: "2026-10-06T10:00:00Z".into(),
        }
    }

    fn request_permissions(&self, _kinds: &[SourceKind]) -> Result<PermissionSnapshot, RecorderError> {
        // A test that wants the prompt to be refused flips the flags back afterwards.
        self.granted.store(true, Ordering::Relaxed);
        self.system_audio_granted.store(true, Ordering::Relaxed);
        Ok(self.permission_snapshot())
    }

    fn devices(&self, kind: SourceKind) -> Result<Vec<AudioDevice>, RecorderError> {
        if kind == SourceKind::SystemAudio {
            return Ok(Vec::new());
        }
        Ok(self
            .devices
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| vec![AudioDevice {
                uid: "built-in-mic".into(),
                name: "MacBook Pro Microphone".into(),
                is_default: true,
                is_available: true,
                sample_rate_hz: Some(DEFAULT_SAMPLE_RATE_HZ),
                channels: Some(1),
            }]))
    }

    fn settings_url(&self, kind: SourceKind) -> Option<String> {
        Some(match kind {
            SourceKind::Microphone => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone".into(),
            SourceKind::SystemAudio => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture".into(),
        })
    }

    fn start(&self, config: SourceConfig, callback: Arc<dyn CaptureCallback>) -> Result<Box<dyn CaptureStream>, RecorderError> {
        if config.kind == SourceKind::Microphone && self.fail_microphone.load(Ordering::Relaxed) {
            return Err(RecorderError::new(
                RecorderErrorCode::CaptureStartFailed,
                "scripted microphone start failure",
                false,
            ));
        }
        if config.kind == SourceKind::SystemAudio && self.fail_system_audio.load(Ordering::Relaxed) {
            return Err(RecorderError::new(
                RecorderErrorCode::SystemAudioUnavailable,
                "scripted system-audio failure",
                true,
            ));
        }
        let source = Arc::new(ScriptedSource {
            kind: config.kind,
            sample_rate_hz: config.sample_rate_hz,
            channels: config.channels,
            actual_sample_rate_hz: None,
            callback: Mutex::new(Some(callback)),
            state: Mutex::new(StreamState::Running),
        });
        self.sources
            .lock()
            .map(|mut guard| guard.push(Arc::clone(&source)))
            .map_err(|_| RecorderError::new(RecorderErrorCode::InternalError, "source list poisoned", false))?;
        Ok(Box::new(ScriptedStream { source }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::QueueCallback;

    #[test]
    fn scripted_source_delivers_into_the_queue_the_writer_reads() {
        let backend = ScriptedBackend::granted();
        let queue = Arc::new(crate::capture::BoundedBlockQueue::new(8, 1024 * 1024));
        let callback: Arc<dyn CaptureCallback> = Arc::new(QueueCallback::new(Arc::clone(&queue)));
        let stream = backend
            .start(
                SourceConfig {
                    kind: SourceKind::Microphone,
                    sample_rate_hz: 48_000,
                    channels: 1,
                    device_uid: Some("built-in-mic".into()),
                    required: true,
                },
                Arc::clone(&callback),
            )
            .expect("start");
        let _ = stream;
        let source = backend.sources_of(SourceKind::Microphone).remove(0);
        assert!(source.push_frames(0, 1_000, 480, 1_000));
        assert_eq!(queue.pending_blocks(), 1);
        let mut batch = Vec::new();
        assert!(queue.pop_batch(8, &mut batch));
        assert_eq!(batch[0].samples.len(), 480);
        assert_eq!(source.state(), StreamState::Running);
    }

    #[test]
    fn stream_controls_change_the_shared_state() {
        let source = Arc::new(ScriptedSource::new(SourceKind::Microphone, 48_000, 1));
        let mut stream = ScriptedStream {
            source: Arc::clone(&source),
        };
        stream.pause().expect("pause");
        assert_eq!(source.state(), StreamState::Paused);
        stream.resume().expect("resume");
        assert_eq!(source.state(), StreamState::Running);
        stream.stop().expect("stop");
        assert_eq!(source.state(), StreamState::Ended);
        assert_eq!(stream.actual_format(), None, "no override configured");
    }

    #[test]
    fn permissions_and_devices_are_scriptable() {
        let backend = ScriptedBackend::denied();
        let snapshot = backend.permission_snapshot();
        assert_eq!(snapshot.microphone, PermissionState::Denied);
        assert_eq!(snapshot.system_audio, PermissionState::Denied);
        assert_eq!(
            backend.settings_url(SourceKind::SystemAudio).expect("url"),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(backend.devices(SourceKind::Microphone).expect("devices").len(), 1);
        backend.make_device_unavailable();
        assert!(
            !backend.devices(SourceKind::Microphone).expect("devices")[0].is_available,
            "the device stays listed but unusable so the coordinator can report device loss"
        );
        backend.set_granted(SourceKind::Microphone, true);
        assert_eq!(
            backend.permission_snapshot().microphone,
            PermissionState::Granted,
            "re-checks see updates without any OS dialog"
        );
    }
}
