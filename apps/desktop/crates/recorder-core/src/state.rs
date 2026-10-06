//! Explicit recorder capture-state machine (docs/recording.md §3).
//!
//! ```text
//! idle → permission_check → ready → recording ⇄ paused → finalizing → stopped
//!                   ↘ permission_blocked / device_unavailable / failed
//! ```
//!
//! Upload/processing state is a separate background machine and is deliberately absent here (Phase 3).
//! Invalid transitions are rejected with a typed error instead of being coerced, so the UI can never
//! display a state the coordinator did not actually enter.

use crate::errors::{RecorderError, RecorderErrorCode};
use crate::manifest::ManifestState;
use serde::{Deserialize, Serialize};

/// Capture states, including the three explicit fault states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecorderState {
    Idle,
    PermissionCheck,
    Ready,
    Recording,
    Paused,
    Finalizing,
    Stopped,
    PermissionBlocked,
    DeviceUnavailable,
    Failed,
}

impl RecorderState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            RecorderState::Idle => "idle",
            RecorderState::PermissionCheck => "permission_check",
            RecorderState::Ready => "ready",
            RecorderState::Recording => "recording",
            RecorderState::Paused => "paused",
            RecorderState::Finalizing => "finalizing",
            RecorderState::Stopped => "stopped",
            RecorderState::PermissionBlocked => "permission_blocked",
            RecorderState::DeviceUnavailable => "device_unavailable",
            RecorderState::Failed => "failed",
        }
    }

    /// True while audio capture is expected to be running.
    #[must_use]
    pub const fn is_capturing(self) -> bool {
        matches!(self, RecorderState::Recording)
    }

    #[must_use]
    pub const fn is_terminal_for_session(self) -> bool {
        matches!(self, RecorderState::Stopped | RecorderState::Failed)
    }

    /// A session left in one of these states must be surfaced by startup recovery, never discarded.
    #[must_use]
    pub const fn is_non_terminal(self) -> bool {
        !self.is_terminal_for_session() && !matches!(self, RecorderState::Idle)
    }
}

/// Legal transitions. Anything not listed here is rejected.
const TRANSITIONS: &[(RecorderState, &[RecorderState])] = &[
    (
        RecorderState::Idle,
        &[RecorderState::PermissionCheck, RecorderState::Failed],
    ),
    (
        RecorderState::PermissionCheck,
        &[
            RecorderState::Ready,
            RecorderState::PermissionBlocked,
            RecorderState::DeviceUnavailable,
            RecorderState::Failed,
        ],
    ),
    (
        RecorderState::Ready,
        &[
            RecorderState::Recording,
            RecorderState::PermissionCheck,
            RecorderState::PermissionBlocked,
            RecorderState::DeviceUnavailable,
            RecorderState::Failed,
        ],
    ),
    (
        RecorderState::Recording,
        &[
            RecorderState::Paused,
            RecorderState::Finalizing,
            RecorderState::DeviceUnavailable,
            RecorderState::Failed,
        ],
    ),
    (
        RecorderState::Paused,
        &[
            RecorderState::Recording,
            RecorderState::Finalizing,
            RecorderState::DeviceUnavailable,
            RecorderState::Failed,
        ],
    ),
    (RecorderState::Finalizing, &[RecorderState::Stopped, RecorderState::Failed]),
    (
        RecorderState::PermissionBlocked,
        &[RecorderState::PermissionCheck, RecorderState::Idle],
    ),
    (
        RecorderState::DeviceUnavailable,
        &[RecorderState::PermissionCheck, RecorderState::Idle],
    ),
    (RecorderState::Failed, &[RecorderState::Idle]),
    (RecorderState::Stopped, &[RecorderState::Idle]),
];

#[must_use]
pub fn allowed_targets(from: RecorderState) -> &'static [RecorderState] {
    TRANSITIONS
        .iter()
        .find(|(source, _)| *source == from)
        .map_or(&[] as &[RecorderState], |(_, targets)| *targets)
}

#[must_use]
pub fn can_transition(from: RecorderState, to: RecorderState) -> bool {
    allowed_targets(from).contains(&to)
}

/// The mutable capture state plus an audit log of rejected attempts, so a misbehaving caller is
/// visible rather than silently ignored.
#[derive(Debug, Clone, Default)]
pub struct StateMachine {
    state: RecorderState,
    rejected_attempts: Vec<(RecorderState, RecorderState)>,
}

impl StateMachine {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: RecorderState::Idle,
            rejected_attempts: Vec::new(),
        }
    }

    #[must_use]
    pub const fn state(&self) -> RecorderState {
        self.state
    }

    #[must_use]
    pub fn rejected_attempts(&self) -> &[(RecorderState, RecorderState)] {
        &self.rejected_attempts
    }

    /// Move to `to`, or return the typed error for the rejected transition (and record the attempt).
    pub fn transition(&mut self, to: RecorderState) -> Result<RecorderState, RecorderError> {
        if can_transition(self.state, to) {
            let previous = self.state;
            self.state = to;
            Ok(previous)
        } else {
            self.rejected_attempts.push((self.state, to));
            Err(RecorderError::new(
                RecorderErrorCode::InvalidStateTransition,
                format!("recorder state {} cannot move to {}", self.state.as_str(), to.as_str()),
                false,
            ))
        }
    }

    /// Replay a persisted state during recovery, or force a fault state when the machine cannot move
    /// legally anymore (for example a writer fault while already `finalizing`).
    pub fn restore(&mut self, state: RecorderState) {
        self.state = state;
    }
}

/// Map the live capture state onto the durable manifest state. Pre-session states never reach a
/// manifest (a session directory only exists from `ready` onward), so they map to `ready`.
#[must_use]
pub const fn manifest_state_of(state: RecorderState) -> ManifestState {
    match state {
        RecorderState::Recording => ManifestState::Recording,
        RecorderState::Paused => ManifestState::Paused,
        RecorderState::Finalizing => ManifestState::Finalizing,
        RecorderState::Stopped => ManifestState::Stopped,
        RecorderState::Failed => ManifestState::Failed,
        RecorderState::Idle
        | RecorderState::PermissionCheck
        | RecorderState::Ready
        | RecorderState::PermissionBlocked
        | RecorderState::DeviceUnavailable => ManifestState::Ready,
    }
}

/// Interpret a persisted state as a live capture state for reporting.
#[must_use]
pub const fn state_from_manifest(state: ManifestState) -> RecorderState {
    match state {
        ManifestState::Ready => RecorderState::Ready,
        ManifestState::Recording => RecorderState::Recording,
        ManifestState::Paused => RecorderState::Paused,
        ManifestState::Finalizing => RecorderState::Finalizing,
        ManifestState::Stopped => RecorderState::Stopped,
        ManifestState::Failed => RecorderState::Failed,
        // Reconciled as interrupted: surfaced to the user, never auto-discarded, and never resumed
        // into the same session in this phase.
        ManifestState::Interrupted => RecorderState::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_is_walkable() {
        let mut machine = StateMachine::new();
        for state in [
            RecorderState::PermissionCheck,
            RecorderState::Ready,
            RecorderState::Recording,
            RecorderState::Paused,
            RecorderState::Recording,
            RecorderState::Finalizing,
            RecorderState::Stopped,
            RecorderState::Idle,
        ] {
            machine.transition(state).expect("legal transition");
        }
        assert!(machine.rejected_attempts().is_empty());
    }

    #[test]
    fn invalid_transitions_are_rejected_without_mutating_state() {
        let mut machine = StateMachine::new();
        let error = machine
            .transition(RecorderState::Recording)
            .expect_err("idle -> recording must be rejected");
        assert_eq!(error.code, RecorderErrorCode::InvalidStateTransition);
        assert_eq!(machine.state(), RecorderState::Idle);
        assert_eq!(machine.rejected_attempts(), &[(RecorderState::Idle, RecorderState::Recording)]);

        assert!(!can_transition(RecorderState::PermissionCheck, RecorderState::Recording));
        assert!(!can_transition(RecorderState::Recording, RecorderState::Ready));
        assert!(!can_transition(RecorderState::Finalizing, RecorderState::Recording));
        assert!(!can_transition(RecorderState::Stopped, RecorderState::Recording));
        // Paused cannot jump to stopped: finalization must run first.
        assert!(!can_transition(RecorderState::Paused, RecorderState::Stopped));
        assert!(can_transition(RecorderState::Paused, RecorderState::Finalizing));
    }

    #[test]
    fn every_active_state_can_fail() {
        for state in [
            RecorderState::Idle,
            RecorderState::PermissionCheck,
            RecorderState::Ready,
            RecorderState::Recording,
            RecorderState::Paused,
            RecorderState::Finalizing,
        ] {
            assert!(can_transition(state, RecorderState::Failed), "{state:?} must be able to fail");
        }
    }

    #[test]
    fn fault_states_are_reachable_and_recoverable() {
        assert!(can_transition(RecorderState::PermissionCheck, RecorderState::PermissionBlocked));
        assert!(can_transition(RecorderState::Ready, RecorderState::PermissionBlocked));
        assert!(can_transition(RecorderState::Recording, RecorderState::DeviceUnavailable));
        assert!(can_transition(RecorderState::PermissionBlocked, RecorderState::PermissionCheck));
        assert!(can_transition(RecorderState::DeviceUnavailable, RecorderState::PermissionCheck));
    }

    #[test]
    fn every_declared_state_has_a_transition_row() {
        let states = [
            RecorderState::Idle,
            RecorderState::PermissionCheck,
            RecorderState::Ready,
            RecorderState::Recording,
            RecorderState::Paused,
            RecorderState::Finalizing,
            RecorderState::Stopped,
            RecorderState::PermissionBlocked,
            RecorderState::DeviceUnavailable,
            RecorderState::Failed,
        ];
        for state in states {
            assert!(
                TRANSITIONS.iter().any(|(source, _)| *source == state),
                "{state:?} has no transition row"
            );
        }
    }

    #[test]
    fn non_terminal_states_drive_recovery_reporting() {
        assert!(RecorderState::Recording.is_non_terminal());
        assert!(RecorderState::Paused.is_non_terminal());
        assert!(RecorderState::Finalizing.is_non_terminal());
        assert!(RecorderState::PermissionCheck.is_non_terminal());
        assert!(!RecorderState::Stopped.is_non_terminal());
        assert!(!RecorderState::Failed.is_non_terminal());
        assert!(!RecorderState::Idle.is_non_terminal());
    }

    #[test]
    fn manifest_and_live_states_round_trip_consistently() {
        for state in [
            RecorderState::Recording,
            RecorderState::Paused,
            RecorderState::Finalizing,
            RecorderState::Stopped,
            RecorderState::Failed,
        ] {
            assert_eq!(state_from_manifest(manifest_state_of(state)), state);
        }
        assert_eq!(manifest_state_of(RecorderState::Idle), ManifestState::Ready);
        assert_eq!(manifest_state_of(RecorderState::Ready), ManifestState::Ready);
        assert_eq!(state_from_manifest(ManifestState::Interrupted), RecorderState::Failed);
    }

    #[test]
    fn serializes_with_the_contracts_wire_names() {
        for (state, name) in [
            (RecorderState::Idle, "idle"),
            (RecorderState::PermissionCheck, "permission_check"),
            (RecorderState::Ready, "ready"),
            (RecorderState::Recording, "recording"),
            (RecorderState::Paused, "paused"),
            (RecorderState::Finalizing, "finalizing"),
            (RecorderState::Stopped, "stopped"),
            (RecorderState::PermissionBlocked, "permission_blocked"),
            (RecorderState::DeviceUnavailable, "device_unavailable"),
            (RecorderState::Failed, "failed"),
        ] {
            assert_eq!(
                serde_json::to_string(&state).expect("serializable"),
                format!("\"{name}\"")
            );
        }
    }
}
