//! Permission and device state reported by the platform bridge.
//!
//! Permission values are exactly the four states required by docs/recording.md §3. The bridge must be
//! able to distinguish "not asked yet" from "refused", and the app must never re-ask a refused
//! permission on every button press: `request_permissions` only triggers an OS prompt when the state
//! is `permission_unknown`, and a denied state is answered with an actionable settings pointer.

use crate::capture::BackendAvailability;
use serde::{Deserialize, Serialize};

/// Permission states, named exactly as in the approved contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionState {
    #[serde(rename = "permission_unknown")]
    Unknown,
    #[serde(rename = "permission_granted")]
    Granted,
    #[serde(rename = "permission_denied")]
    Denied,
    #[serde(rename = "device_unavailable")]
    DeviceUnavailable,
}

impl PermissionState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            PermissionState::Unknown => "permission_unknown",
            PermissionState::Granted => "permission_granted",
            PermissionState::Denied => "permission_denied",
            PermissionState::DeviceUnavailable => "device_unavailable",
        }
    }

    /// True only when capture may proceed.
    #[must_use]
    pub const fn is_granted(self) -> bool {
        matches!(self, PermissionState::Granted)
    }

    /// Whether an OS prompt may be raised: denied/unknown-only prompting prevents dialog spam.
    #[must_use]
    pub const fn may_prompt(self) -> bool {
        matches!(self, PermissionState::Unknown)
    }
}

/// One selectable audio device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub uid: String,
    pub name: String,
    pub is_default: bool,
    pub is_available: bool,
    #[serde(default)]
    pub sample_rate_hz: Option<u32>,
    #[serde(default)]
    pub channels: Option<u16>,
}

/// Full permission/device picture the UI renders, including the actionable settings pointer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub microphone: PermissionState,
    pub system_audio: PermissionState,
    /// Whether this target has an implemented capture backend at all.
    pub availability: BackendAvailability,
    /// Human-readable OS version string reported by the bridge (for the acceptance log).
    pub os_version: String,
    /// Minimum macOS version the selected APIs require, when applicable.
    #[serde(default)]
    pub minimum_macos_version: Option<String>,
    /// True when the bridge can open the relevant System Settings pane.
    pub open_settings_supported: bool,
    /// Optional extra detail (never contains paths with user names or audio content).
    #[serde(default)]
    pub detail: Option<String>,
    /// RFC 3339 UTC timestamp of the check; metadata only.
    pub checked_at: String,
}

impl PermissionSnapshot {
    /// States that must be resolved before `ready` can be committed.
    #[must_use]
    pub fn blocking_kinds(&self, system_audio_required: bool) -> Vec<(&'static str, PermissionState)> {
        let mut blocking = Vec::new();
        if !self.microphone.is_granted() {
            blocking.push(("microphone", self.microphone));
        }
        if system_audio_required && !self.system_audio.is_granted() {
            blocking.push(("system_audio", self.system_audio));
        }
        blocking
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_states_use_the_contract_wire_names() {
        for (state, name) in [
            (PermissionState::Unknown, "permission_unknown"),
            (PermissionState::Granted, "permission_granted"),
            (PermissionState::Denied, "permission_denied"),
            (PermissionState::DeviceUnavailable, "device_unavailable"),
        ] {
            assert_eq!(state.as_str(), name);
            let json = serde_json::to_string(&state).expect("serializable");
            assert_eq!(json, format!("\"{name}\""));
        }
    }

    #[test]
    fn only_unknown_may_prompt_and_only_granted_may_capture() {
        assert!(PermissionState::Unknown.may_prompt());
        assert!(!PermissionState::Denied.may_prompt(), "a denial must not be re-asked on every click");
        assert!(!PermissionState::Granted.may_prompt());
        assert!(PermissionState::Granted.is_granted());
        assert!(!PermissionState::Denied.is_granted());
        assert!(!PermissionState::DeviceUnavailable.is_granted());
    }

    #[test]
    fn blocking_kinds_respect_the_system_audio_choice() {
        let snapshot = PermissionSnapshot {
            microphone: PermissionState::Granted,
            system_audio: PermissionState::Denied,
            availability: BackendAvailability::Available,
            os_version: "macOS 26.0".into(),
            minimum_macos_version: Some("13.0".into()),
            open_settings_supported: true,
            detail: None,
            checked_at: "2026-10-06T10:00:00Z".into(),
        };
        assert!(snapshot.blocking_kinds(false).is_empty(), "mic-only sessions ignore the SCK denial");
        assert_eq!(snapshot.blocking_kinds(true), vec![("system_audio", PermissionState::Denied)]);
        let both_bad = PermissionSnapshot {
            microphone: PermissionState::DeviceUnavailable,
            ..snapshot
        };
        assert_eq!(
            both_bad.blocking_kinds(true),
            vec![
                ("microphone", PermissionState::DeviceUnavailable),
                ("system_audio", PermissionState::Denied)
            ]
        );
    }

    #[test]
    fn devices_and_snapshots_serialize_with_camel_case_keys() {
        let device = AudioDevice {
            uid: "AppleHDA:1".into(),
            name: "MacBook Pro Microphone".into(),
            is_default: true,
            is_available: true,
            sample_rate_hz: Some(48_000),
            channels: Some(1),
        };
        let json = serde_json::to_value(&device).expect("serializable");
        assert_eq!(json["isDefault"], true);
        assert_eq!(json["sampleRateHz"], 48_000);
        let snapshot = PermissionSnapshot {
            microphone: PermissionState::Granted,
            system_audio: PermissionState::Unknown,
            availability: BackendAvailability::UnsupportedOsVersion,
            os_version: "26.0".into(),
            minimum_macos_version: None,
            open_settings_supported: false,
            detail: Some("requires macOS 13".into()),
            checked_at: "2026-10-06T10:00:00Z".into(),
        };
        let json = serde_json::to_value(&snapshot).expect("serializable");
        assert_eq!(json["systemAudio"], "permission_unknown");
        assert_eq!(json["availability"], "unsupported_os_version");
        assert_eq!(json["openSettingsSupported"], false);
        assert!(json.get("minimumMacOSVersion").is_some());
    }
}
