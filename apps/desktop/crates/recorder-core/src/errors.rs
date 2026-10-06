//! Typed recorder errors (docs/recording.md §3: failures are explicit, never masked).

use serde::{Deserialize, Serialize};

/// Stable error codes shared with the renderer. Names match `recorderErrorCodeSchema` in
/// `packages/contracts/src/recorder.ts`; adding a code here requires adding it there too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecorderErrorCode {
    /// This OS/platform has no implemented capture backend (Windows in Phase 2).
    PlatformUnsupported,
    PermissionDenied,
    PermissionUnknown,
    DeviceUnavailable,
    DeviceLost,
    InvalidStateTransition,
    CaptureStartFailed,
    CaptureStalled,
    SystemAudioUnavailable,
    WriterFailed,
    ManifestConflict,
    ManifestUnreadable,
    DiskSpaceInsufficient,
    DiskFull,
    NotAuthenticated,
    SessionNotRecoverable,
    InternalError,
}

/// Which logical source a fault belongs to, so a system-audio failure is never reported as a
/// microphone failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Microphone,
    SystemAudio,
}

impl SourceKind {
    #[must_use]
    pub const fn directory_name(self) -> &'static str {
        match self {
            SourceKind::Microphone => "microphone",
            SourceKind::SystemAudio => "system-audio",
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            SourceKind::Microphone => "microphone",
            SourceKind::SystemAudio => "system_audio",
        }
    }
}

/// A recorder failure with an actionable retry/permission hint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderError {
    pub code: RecorderErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_kind: Option<SourceKind>,
    /// OS settings deep link, when the fault is permission-shaped (docs/recording.md §2 requires an
    /// actionable path rather than a generic error).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub open_settings_url: Option<String>,
}

impl RecorderError {
    #[must_use]
    pub fn new(code: RecorderErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            source_kind: None,
            open_settings_url: None,
        }
    }

    #[must_use]
    pub fn with_source(mut self, source_kind: SourceKind) -> Self {
        self.source_kind = Some(source_kind);
        self
    }

    #[must_use]
    pub fn with_settings_url(mut self, url: impl Into<String>) -> Self {
        self.open_settings_url = Some(url.into());
        self
    }

    /// Attach a settings deep link when the platform offered one.
    #[must_use]
    pub fn with_settings_hint(mut self, url: Option<String>) -> Self {
        if let Some(url) = url {
            self.open_settings_url = Some(url);
        }
        self
    }

    /// Persistence faults must never be presented as a healthy recording.
    #[must_use]
    pub fn is_persistence_fault(&self) -> bool {
        matches!(
            self.code,
            RecorderErrorCode::WriterFailed
                | RecorderErrorCode::ManifestConflict
                | RecorderErrorCode::ManifestUnreadable
                | RecorderErrorCode::DiskFull
                | RecorderErrorCode::DiskSpaceInsufficient
        )
    }
}

impl std::fmt::Display for RecorderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl RecorderErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            RecorderErrorCode::PlatformUnsupported => "platform_unsupported",
            RecorderErrorCode::PermissionDenied => "permission_denied",
            RecorderErrorCode::PermissionUnknown => "permission_unknown",
            RecorderErrorCode::DeviceUnavailable => "device_unavailable",
            RecorderErrorCode::DeviceLost => "device_lost",
            RecorderErrorCode::InvalidStateTransition => "invalid_state_transition",
            RecorderErrorCode::CaptureStartFailed => "capture_start_failed",
            RecorderErrorCode::CaptureStalled => "capture_stalled",
            RecorderErrorCode::SystemAudioUnavailable => "system_audio_unavailable",
            RecorderErrorCode::WriterFailed => "writer_failed",
            RecorderErrorCode::ManifestConflict => "manifest_conflict",
            RecorderErrorCode::ManifestUnreadable => "manifest_unreadable",
            RecorderErrorCode::DiskSpaceInsufficient => "disk_space_insufficient",
            RecorderErrorCode::DiskFull => "disk_full",
            RecorderErrorCode::NotAuthenticated => "not_authenticated",
            RecorderErrorCode::SessionNotRecoverable => "session_not_recoverable",
            RecorderErrorCode::InternalError => "internal_error",
        }
    }
}

impl From<std::io::Error> for RecorderError {
    fn from(error: std::io::Error) -> Self {
        // No path or user data in the message: the OS error string can contain a session directory
        // name, so only the coarse kind and errno are retained.
        let code = match error.raw_os_error() {
            // ENOSPC on macOS/Linux; EDQUOT (69) also means the quota/space is exhausted.
            Some(28) | Some(69) => RecorderErrorCode::DiskFull,
            _ => RecorderErrorCode::WriterFailed,
        };
        RecorderError::new(code, format!("local storage failed ({})", error.kind()), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_the_contracts_wire_names() {
        let error = RecorderError::new(RecorderErrorCode::SystemAudioUnavailable, "no audio for this session", false)
            .with_source(SourceKind::SystemAudio)
            .with_settings_url("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        let json = serde_json::to_value(&error).expect("serializable");
        assert_eq!(json["code"], "system_audio_unavailable");
        assert_eq!(json["sourceKind"], "system_audio");
        assert_eq!(json["openSettingsUrl"], error.open_settings_url.as_deref().unwrap());
        assert_eq!(json["retryable"], false);
    }

    #[test]
    fn persistence_faults_are_classified_for_the_ui() {
        for code in [
            RecorderErrorCode::DiskFull,
            RecorderErrorCode::WriterFailed,
            RecorderErrorCode::ManifestConflict,
            RecorderErrorCode::ManifestUnreadable,
            RecorderErrorCode::DiskSpaceInsufficient,
        ] {
            assert!(RecorderError::new(code, "fault", false).is_persistence_fault(), "{code:?}");
        }
        for code in [
            RecorderErrorCode::DeviceLost,
            RecorderErrorCode::PermissionDenied,
            RecorderErrorCode::CaptureStalled,
            RecorderErrorCode::InvalidStateTransition,
        ] {
            assert!(!RecorderError::new(code, "fault", false).is_persistence_fault(), "{code:?}");
        }
    }

    #[test]
    fn enospc_maps_to_a_disk_full_code() {
        let error = std::io::Error::from_raw_os_error(28);
        let mapped = RecorderError::from(error);
        assert_eq!(mapped.code, RecorderErrorCode::DiskFull);
        assert!(mapped.is_persistence_fault());
        let other = RecorderError::from(std::io::Error::new(std::io::ErrorKind::Other, "bad"));
        assert_eq!(other.code, RecorderErrorCode::WriterFailed);
    }

    #[test]
    fn source_directories_are_stable_and_traversal_free() {
        assert_eq!(SourceKind::Microphone.directory_name(), "microphone");
        assert_eq!(SourceKind::SystemAudio.directory_name(), "system-audio");
        assert_eq!(SourceKind::SystemAudio.as_str(), "system_audio");
    }
}
