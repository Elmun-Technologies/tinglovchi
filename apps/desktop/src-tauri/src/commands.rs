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

/// Attach the running (or already stopped) session to a server-side meeting.
///
/// One-tap recording cannot demand a meeting before the button is pressed — the user may be offline,
/// and a title/type form first is the friction the product removes. Capture therefore starts unlinked
/// and the desktop creates the meeting as soon as it can reach the server.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkMeetingPayload {
    pub workspace_id: Option<String>,
    pub meeting_id: Option<String>,
}

#[tauri::command]
pub fn recorder_link_meeting(
    payload: LinkMeetingPayload,
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<RecorderStatus, Failure> {
    let LinkMeetingPayload {
        workspace_id,
        meeting_id,
    } = payload;
    command(&app, state.inner(), move |recorder| {
        recorder.link_meeting(workspace_id.as_deref(), meeting_id.as_deref())
    })
}

/// Reads one finalized chunk's bytes so the renderer can upload them.
///
/// Two properties matter here, because this is the only command that turns a caller-supplied string
/// into a filesystem read:
/// * `validate_relative_path` accepts exactly `microphone/<digits>.wav` and
///   `system-audio/<digits>.wav` — no separators that climb, no absolute paths, no symlink-ish names.
/// * The read is confined to the current session directory, and the bytes are handed back as base64 so
///   nothing about the on-disk layout leaks into the renderer.
///
/// The file is opened read-only and never truncated, moved, or deleted: an upload attempt must not be
/// able to destroy the only copy of someone's meeting.
#[tauri::command]
pub fn recorder_read_chunk_bytes(
    local_file: String,
    state: State<'_, Shared>,
) -> Result<String, Failure> {
    let guard = crate::error::lock(&state.recorder);
    let session_dir = guard
        .recorder
        .session_dir()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| {
            Failure::new(
                RecorderErrorCode::InvalidStateTransition,
                "no recording session is open, so no chunk can be read",
                true,
            )
        })?;
    drop(guard);
    Ok(base64_encode(&read_chunk_bytes(&session_dir, &local_file)?))
}

/// Reads a chunk from a *named* past session, which is how a crash-recovered recording gets uploaded.
///
/// The session id goes through the same directory-name validation as the recorder root uses, and the
/// relative path through `validate_relative_path`, so this command can only ever read
/// `<root>/<session-uuid>/{microphone,system-audio}/<digits>.wav`.
#[tauri::command]
pub fn recorder_read_session_chunk(
    session_id: String,
    local_file: String,
    state: State<'_, Shared>,
) -> Result<String, Failure> {
    let session_dir = state.root.session_dir(&session_id)?;
    Ok(base64_encode(&read_chunk_bytes(&session_dir, &local_file)?))
}

/// Makes a crash-recovered session uploadable and returns its manifest.
///
/// Recovery never resumes capture into an old session (docs/recording.md §3): it adopts orphan chunks,
/// salvages truncated-but-decodable ones, and marks the session `interrupted`. Uploading needs a
/// terminal manifest, so this closes the session for good — sets `stopped`, fills `stoppedAt`, and
/// attaches the workspace/meeting the desktop has since created — and hands the manifest back.
///
/// The audio is never touched. Only `manifest.json` is rewritten, atomically, and the revision is
/// bumped so the change is visible in the durable record.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRecoveredUploadPayload {
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub meeting_id: Option<String>,
}

#[tauri::command]
pub fn recorder_prepare_recovered_upload(
    payload: PrepareRecoveredUploadPayload,
    state: State<'_, Shared>,
) -> Result<RecorderManifest, Failure> {
    let session_dir = state.root.session_dir(&payload.session_id)?;
    let manifest = recorder_core::recovery::close_interrupted_session(
        &session_dir,
        payload.workspace_id.as_deref(),
        payload.meeting_id.as_deref(),
    )?;
    Ok(manifest)
}

/// Reads one chunk file, refusing any path that is not a session-relative WAV.
fn read_chunk_bytes(session_dir: &std::path::Path, local_file: &str) -> Result<Vec<u8>, Failure> {
    let relative = recorder_core::storage::validate_relative_path(local_file)?;
    let path = recorder_core::storage::join_within(session_dir, &relative)?;
    Ok(std::fs::read(&path)?)
}

/// Opens a URL in the user's default browser.
///
/// The desktop never authenticates inside its own webview, so sign-in happens in a real browser the
/// user already trusts. Only `http:` and `https:` URLs are accepted, and the URL is passed as a single
/// argument with no shell involved, so a crafted string cannot become a command.
#[tauri::command]
pub fn recorder_open_external(url: String) -> Result<(), Failure> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(Failure::new(
            RecorderErrorCode::InternalError,
            "only http and https URLs can be opened",
            false,
        ));
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", trimmed])
        .status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(trimmed).status();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let status: Result<std::process::ExitStatus, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opening a browser is not supported on this target",
    ));

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(Failure::new(
            RecorderErrorCode::InternalError,
            "the browser could not be opened",
            false,
        )),
        Err(error) => Err(Failure::new(
            RecorderErrorCode::InternalError,
            format!("the browser could not be opened ({error})"),
            false,
        )),
    }
}

/// Quits the app *after* the renderer has stopped and finalized the session.
///
/// Only ever called from the "stop and save" button in the close confirmation, so a recording is never
/// dropped by an accidental window close. Closing while idle still exits immediately in the window
/// event handler — this command exists purely for the guarded path.
#[tauri::command]
pub fn recorder_finish_close(app: AppHandle, state: State<'_, Shared>) -> Result<(), Failure> {
    if crate::state::is_capturing(state.inner()) {
        return Err(Failure::new(
            RecorderErrorCode::InvalidStateTransition,
            "the session is still capturing; stop it before closing",
            true,
        ));
    }
    app.exit(0);
    Ok(())
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) & 63] as char);
        out.push(ALPHABET[(triple >> 12) & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple & 63] as char
        } else {
            '='
        });
    }
    out
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
