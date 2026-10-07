//! Platform selection, kept out of `recorder-core` so the core never depends on a capture crate.
//!
//! macOS gets the ScreenCaptureKit/AVFoundation bridge (`capture-macos`).
//! Windows gets the WASAPI event-driven microphone + loopback bridge (`capture-windows`).
//! Every other target gets `UnavailableBackend`, which answers `platform_unsupported` to any start
//! attempt: the app builds and its UI runs, but it says plainly that this platform cannot capture
//! audio instead of pretending to record.

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use recorder_core::capture::UnavailableBackend;
use std::sync::Arc;

#[cfg(target_os = "macos")]
pub type SystemBackend = capture_macos::MacosCaptureBackend;
#[cfg(target_os = "windows")]
pub type SystemBackend = capture_windows::WindowsCaptureBackend;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub type SystemBackend = UnavailableBackend;

#[must_use]
pub fn backend() -> Arc<SystemBackend> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(SystemBackend::new())
    }
    #[cfg(target_os = "windows")]
    {
        Arc::new(SystemBackend::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Arc::new(UnavailableBackend::new(
            "recording is supported on macOS and Windows only; this target has no native capture backend",
        ))
    }
}

/// Whether the compiled target can capture audio at all. Used to label the window honestly.
#[must_use]
pub const fn capture_supported_on_this_target() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}
