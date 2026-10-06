//! IPC surface. Each command maps one-to-one onto a recorder-core call, then forwards the events the
//! coordinator queued while it ran.
//!
//! Commands are synchronous on purpose. The only multi-second operation is the final flush in
//! `recorder_stop` (bounded by `session::FLUSH_TIMEOUT`), which happens after the user asked to stop; the
//! normal path returns in a few milliseconds. `docs/mac-recorder-acceptance.md` lists the follow-up
//! (wrap the flush in `spawn_blocking`) if test F shows the window ever stalling.
//!
//! `recorder_status` doubles as the pump: it drains writer outcomes, refreshes disk headroom, and checks
//! device presence before answering, so the renderer's polling interval is also the health-check interval.

use crate::error::{lock, Failure};
use crate::platform::SystemBackend;
use crate::state::{self, Shared};
use recorder_core::clock::{Clock, SystemClock};
use recorder_core::errors::{RecorderError, RecorderErrorCode, SourceKind};
use recorder_core::manifest::RecorderManifest;
use recorder_core::platform::{AudioDevice, PermissionSnapshot};
use recorder_core::session::{Recorder, RecorderStatus, StartRequest, MIN_CHUNK_INTERVAL_MS};
use tauri::{AppHandle, State};

type RecorderHandle = Recorder<SystemBackend, SystemClock>;

/// Runs one coordinator call, then emits whatever events it queued (chunk finalized, fault, level
/// snapshot, state change). Events are emitted *after* the lock is released so a slow renderer can never
/// block capture.
fn command<T>(
    app: &AppHandle,
    state: &Shared,
    run: impl FnOnce(&mut RecorderHandle) -> Result<T, RecorderError>,
) -> Result<T, Failure> {
    let (value, events) = {
        let mut guard = lock(&state.recorder);
        let value = run(&mut guard.recorder)?;
        (value, guard.recorder.take_events())
    };
    state::emit_events(app, events);
    Ok(value)
}

fn parse_kind(raw: &str) -> Result<SourceKind, Failure> {
    match raw {
        "microphone" => Ok(SourceKind::Microphone),
        "system_audio" => Ok(SourceKind::SystemAudio),
        other => Err(Failure::new(
            RecorderErrorCode::InternalError,
            format!("unknown source kind {other:?}; expected \"microphone\" or \"system_audio\""),
            false,
        )),
    }
}

#[tauri::command]
pub fn recorder_refresh_permissions(app: AppHandle, state: State<'_, Shared>) -> Result<PermissionSnapshot, Failure> {
    command(&app, state.inner(), |recorder| Ok(recorder.refresh_permissions()))
}

#[tauri::command]
pub fn recorder_request_permissions(app: AppHandle, state: State<'_, Shared>) -> Result<PermissionSnapshot, Failure> {
    command(&app, state.inner(), |recorder| {
        recorder.request_permissions(&[SourceKind::Microphone, SourceKind::SystemAudio])
    })
}

#[tauri::command]
pub fn recorder_list_devices(kind: String, app: AppHandle, state: State<'_, Shared>) -> Result<Vec<AudioDevice>, Failure> {
    let kind = parse_kind(&kind)?;
    command(&app, state.inner(), move |recorder| recorder.devices(kind))
}

#[tauri::command]
pub fn recorder_open_settings(kind: String, app: AppHandle, state: State<'_, Shared>) -> Result<(), Failure> {
    let kind = parse_kind(&kind)?;
    command(&app, state.inner(), move |recorder| recorder.open_settings_for(kind))
}

/// Re-runs the disk pre-check for a different planned duration and answers with the numbers behind it.
/// A refusal here happens *before* capture starts, which is the point of the pre-check.
#[tauri::command]
pub fn recorder_preflight(
    planned_seconds: u64,
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<RecorderStatus, Failure> {
    command(&app, state.inner(), move |recorder| {
        let mut config = recorder.config().clone();
        config.planned_seconds = planned_seconds.max(1);
        if config.chunk_interval_ms < MIN_CHUNK_INTERVAL_MS {
            config.chunk_interval_ms = MIN_CHUNK_INTERVAL_MS;
        }
        recorder.set_config(config);
        Ok(recorder.status())
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartPayload {
    #[serde(default)]
    pub meeting_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub microphone_device_uid: Option<String>,
    pub capture_system_audio: bool,
    pub consent_acknowledged: bool,
    #[serde(default)]
    pub chunk_interval_ms: Option<u64>,
}

#[tauri::command]
pub fn recorder_start(
    request: StartPayload,
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<RecorderStatus, Failure> {
    let StartPayload {
        meeting_id,
        workspace_id,
        microphone_device_uid,
        capture_system_audio,
        consent_acknowledged,
        chunk_interval_ms,
    } = request;
    command(&app, state.inner(), move |recorder| {
        recorder.start(&StartRequest {
            meeting_id,
            workspace_id,
            microphone_device_uid,
            capture_system_audio,
            consent_acknowledged,
            chunk_interval_ms: chunk_interval_ms.unwrap_or(30_000),
        })
    })
}

#[tauri::command]
pub fn recorder_pause(app: AppHandle, state: State<'_, Shared>) -> Result<RecorderStatus, Failure> {
    command(&app, state.inner(), Recorder::pause)
}

#[tauri::command]
pub fn recorder_resume(app: AppHandle, state: State<'_, Shared>) -> Result<RecorderStatus, Failure> {
    command(&app, state.inner(), Recorder::resume)
}

#[tauri::command]
pub fn recorder_stop(app: AppHandle, state: State<'_, Shared>) -> Result<RecorderStatus, Failure> {
    command(&app, state.inner(), Recorder::stop)
}

#[tauri::command]
pub fn recorder_status(app: AppHandle, state: State<'_, Shared>) -> Result<RecorderStatus, Failure> {
    command(&app, state.inner(), |recorder| recorder.pump())
}

#[tauri::command]
pub fn recorder_manifest(state: State<'_, Shared>) -> Result<Option<RecorderManifest>, Failure> {
    Ok(state::current_manifest(state.inner()))
}

#[tauri::command]
pub fn recorder_mark_important(
    label: Option<String>,
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<serde_json::Value, Failure> {
    command(&app, state.inner(), move |recorder| {
        let marker = recorder.mark_important(label.as_deref())?;
        serde_json::to_value(marker).map_err(|error| RecorderError::new(
            RecorderErrorCode::InternalError,
            format!("marker could not be serialized: {error}"),
            false,
        ))
    })
}

#[tauri::command]
pub fn recorder_add_note(text: String, app: AppHandle, state: State<'_, Shared>) -> Result<serde_json::Value, Failure> {
    command(&app, state.inner(), move |recorder| {
        let note = recorder.add_note(&text)?;
        serde_json::to_value(note).map_err(|error| RecorderError::new(
            RecorderErrorCode::InternalError,
            format!("note could not be serialized: {error}"),
            false,
        ))
    })
}

/// Startup scan, re-runnable from the UI. Non-terminal sessions are reported and left in place; nothing
/// here deletes or discards audio (docs/recording.md §3).
#[tauri::command]
pub fn recorder_scan_sessions(state: State<'_, Shared>) -> Result<serde_json::Value, Failure> {
    let clock = SystemClock::new();
    let now = clock.wall_clock_rfc3339(clock.wall_clock_ms());
    let report = recorder_core::recovery::scan_and_reconcile(&state.root, &now, true)?;
    serde_json::to_value(state::recovery_dto(&report)).map_err(|error| {
        RecorderError::new(
            RecorderErrorCode::InternalError,
            format!("recovery report could not be serialized: {error}"),
            false,
        )
        .into()
    })
}
