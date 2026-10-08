//! Process-wide application state: the recorder, its session root, and the event pump.
//!
//! There is exactly one recorder, one mutex, and one writer-thread set. The renderer polls
//! `recorder_status`, and that poll *is* the pump: each call drains writer outcomes, refreshes disk
//! headroom, and checks device presence before answering. That keeps the UI honest without a background
//! timer that could race the state machine.

use crate::platform::SystemBackend;
use recorder_core::clock::{Clock, SystemClock};
use recorder_core::errors::RecorderError;
use recorder_core::manifest::RecorderManifest;
use recorder_core::recovery::{RecoveredSession, RecoveryReport};
use recorder_core::session::{Recorder, RecorderEvent};
use recorder_core::storage::RecorderRoot;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const EVENT_NAME: &str = "recorder://event";

pub struct AppState {
    pub recorder: Mutex<Recorder<SystemBackend, SystemClock>>,
    pub root: RecorderRoot,
}

pub type Shared = Arc<AppState>;

/// Wire form of a recovered session: the recorder-core report plus the `recoverable` verdict, so the
/// renderer never has to re-derive "is this worth keeping" from counters.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(flatten)]
    pub session: RecoveredSession,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReportDto {
    pub scanned_at: String,
    pub sessions: Vec<SessionSummary>,
    pub rejected: Vec<RejectedDirectory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedDirectory {
    pub directory_name: String,
    pub reason: String,
}

#[must_use]
pub fn recovery_dto(report: &RecoveryReport) -> RecoveryReportDto {
    RecoveryReportDto {
        scanned_at: report.scanned_at.clone(),
        sessions: report
            .sessions
            .iter()
            .map(|session| SessionSummary {
                session: session.clone(),
                recoverable: session.recoverable(),
            })
            .collect(),
        rejected: report
            .rejected
            .iter()
            .map(|rejected| RejectedDirectory {
                directory_name: rejected.directory_name.clone(),
                reason: rejected.reason.clone(),
            })
            .collect(),
    }
}

/// Builds the state and runs the startup scan. Recovery runs *before* the window can start a capture:
/// an interrupted session must be visible immediately, and it is never auto-discarded.
pub fn install(app: tauri::AppHandle, app_data: &Path) -> Result<(), String> {
    let root = RecorderRoot::new(app_data.join("recordings")).map_err(|error| error.message)?;
    let recorder = Recorder::new(
        RecorderRoot::new(app_data.join("recordings")).map_err(|error| error.message)?,
        crate::platform::backend(),
        Arc::new(SystemClock::new()),
    );
    let state: Shared = Arc::new(AppState {
        recorder: Mutex::new(recorder),
        root: root.clone(),
    });
    app.manage(Arc::clone(&state));

    let clock = SystemClock::new();
    let now = clock.wall_clock_rfc3339(clock.wall_clock_ms());
    match recorder_core::recovery::scan_and_reconcile(&state.root, &now, true) {
        Ok(report) => {
            if !report.sessions.is_empty() || !report.rejected.is_empty() {
                let payload = serde_json::json!({ "type": "recovery", "report": recovery_dto(&report) });
                emit_payload(&app, payload);
            }
        }
        // A scan that could not even run must be reported, not swallowed: the UI shows the fault and the
        // operator decides. Nothing is deleted on the way to that decision.
        Err(error) => {
            let payload = event_payload(&RecorderEvent::Fault { error }).unwrap_or_else(|| {
                serde_json::json!({ "type": "fault", "error": { "code": "internal_error", "message": "recovery scan failed", "retryable": true } })
            });
            emit_payload(&app, payload);
        }
    }
    Ok(())
}

pub fn emit_events(app: &tauri::AppHandle, events: Vec<RecorderEvent>) {
    for event in events {
        match event_payload(&event) {
            Some(payload) => emit_payload(app, payload),
            None => {
                let _ = app.emit(
                    EVENT_NAME,
                    &serde_json::json!({
                        "type": "fault",
                        "error": {
                            "code": "internal_error",
                            "message": "a recorder event could not be serialized for the renderer",
                            "retryable": false
                        }
                    }),
                );
            }
        }
    }
}

/// `RecorderEvent` already serializes into the contracted shape, except for the recovery variant, whose
/// payload carries the extra `recoverable` field computed here.
fn event_payload(event: &RecorderEvent) -> Option<serde_json::Value> {
    match event {
        RecorderEvent::Recovery { report } => Some(serde_json::json!({
            "type": "recovery",
            "report": recovery_dto(report),
        })),
        other => serde_json::to_value(other).ok(),
    }
}

fn emit_payload(app: &tauri::AppHandle, payload: serde_json::Value) {
    use tauri::Emitter;
    // `serde_json::Value` is `Clone + Serialize`, which is all `emit` requires.
    let _ = app.emit(EVENT_NAME, &payload);
}

/// True while audio is still being captured or the session is mid-finalize.
///
/// Read from the close-request handler so an accidental window close can never drop a recording: the
/// close is prevented and the renderer is asked to show the "stop and save" confirmation instead.
#[must_use]
pub fn is_capturing(state: &AppState) -> bool {
    let guard = crate::error::lock(&state.recorder);
    matches!(
        guard.recorder.state(),
        recorder_core::session::RecorderState::Recording
            | recorder_core::session::RecorderState::Paused
            | recorder_core::session::RecorderState::Finalizing
    )
}

/// Asks the renderer to confirm quitting. Emitted only when capture is live, and only ever alongside a
/// prevented close — the app never quits behind the user's back while a meeting is being recorded.
pub fn emit_close_requested(app: &tauri::AppHandle) {
    emit_payload(app, serde_json::json!({ "type": "close_requested" }));
}

/// Read-only view of the manifest for the renderer, straight from the coordinator's memory (which the
/// coordinator keeps in sync with the durable file after every revision).
pub fn current_manifest(state: &AppState) -> Option<RecorderManifest> {
    let guard = crate::error::lock(&state.recorder);
    guard.recorder.manifest().cloned()
}

#[must_use]
pub fn recorder_error(message: impl Into<String>) -> RecorderError {
    RecorderError::new(
        recorder_core::errors::RecorderErrorCode::InternalError,
        message,
        false,
    )
}
