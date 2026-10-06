//! Platform selection, kept out of `recorder-core` so the core never depends on a capture crate.
//!
//! macOS gets the ScreenCaptureKit/AVFoundation bridge. Every other target gets `UnavailableBackend`,
//! which answers `platform_unsupported` to any start attempt: the app builds and its UI runs, but it
//! says plainly that this platform cannot capture audio instead of pretending to record.

use recorder_core::capture::UnavailableBackend;
use std::sync::Arc;

#[cfg(target_os = "macos")]
pub type SystemBackend = capture_macos::MacosCaptureBackend;
#[cfg(not(target_os = "macos"))]
pub type SystemBackend = UnavailableBackend;

#[must_use]
pub fn backend() -> Arc<SystemBackend> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(SystemBackend::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(UnavailableBackend::new(
            "recording is implemented for macOS only in this phase; Windows capture is a later milestone",
        ))
    }
}

/// Whether the compiled target can capture audio at all. Used to label the window honestly.
#[must_use]
pub const fn capture_supported_on_this_target() -> bool {
    cfg!(target_os = "macos")
}
