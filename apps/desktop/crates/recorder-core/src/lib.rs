//! SUHBAT local-first recorder core (Phase 2).
//!
//! This crate owns everything about capturing a meeting on disk that does not depend on a specific
//! audio API: the canonical meeting timeline, the capture state machine, the versioned session
//! manifest, the atomic write/finalize protocol, startup recovery, level metering, and typed errors.
//!
//! Deliberate boundaries for this phase:
//! * **No network, no database, no provider.** There is no HTTP client, no Supabase import, and no
//!   transcription call anywhere in this crate; `uploadState`/`verificationState` exist in the
//!   manifest only because the approved schema includes them, and the recorder can only ever write
//!   `pending`. A static guard test enforces this (`tests/desktop/recorder-offline-boundary.test.ts`).
//! * **Platform capture is isolated.** Only [`capture`] traits live here; the ScreenCaptureKit and
//!   AVFoundation bridge lives in `crates/capture-macos`, and non-macOS builds get
//!   [`capture::UnavailableBackend`], which fails closed rather than pretending to record.
//! * **Microphone and system audio stay separate logical sources**, mapped onto one canonical
//!   timeline by [`timeline`]; they are never permanently mixed at capture time.
//!
//! Docs cross-references: `docs/recording.md` §3 (timeline/state), §4 (manifest/protocol), §5
//! (separate tracks), §7 (local privacy).

pub mod capture;
pub mod clock;
pub mod errors;
pub mod levels;
pub mod manifest;
pub mod platform;
pub mod recovery;
pub mod session;
pub mod state;
pub mod storage;
pub mod timeline;
pub mod wav;
pub mod writer;

/// Scripted backend for tests and for the acceptance harness on a real Mac.
///
/// Always compiled (it has no dependencies and no side effects) so integration tests and the
/// `src-tauri` harness can both reach it without feature plumbing.
pub mod test_support;

pub use errors::{RecorderError, RecorderErrorCode, SourceKind};
pub use manifest::{RecorderManifest, MANIFEST_SCHEMA_VERSION};
pub use session::{Recorder, RecorderStatus, StartRequest};
pub use state::RecorderState;
pub use storage::RecorderRoot;
pub use timeline::TimelineOrigin;

/// Manifest/container layout version written by this build.
pub const LAYOUT_VERSION: u32 = 1;
/// Semantic version of the recorder core, surfaced in the manifest-adjacent telemetry of later phases.
pub const RECORDER_CORE_VERSION: &str = "0.1.0";
