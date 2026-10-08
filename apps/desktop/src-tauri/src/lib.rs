//! Tauri shell for the SUHBAT local recorder.
//!
//! This layer is deliberately thin: it owns the window, the session root directory, and the mapping from
//! recorder-core's typed API to IPC payloads. No capture logic, no manifest logic, no timeline arithmetic
//! lives here — those are in `recorder-core` so they can be unit-tested without a window or hardware.
//!
//! Phase 2 boundary (docs/architecture.md): this crate does not depend on `@suhbat/database`, does not
//! contain an HTTP client, and does not talk to Supabase or any provider. `tests/desktop/` enforces that
//! statically.

mod commands;
mod error;
mod platform;
mod state;

use std::sync::Arc;
use tauri::Manager;

/// Prevents an accidental window close from discarding a live recording.
///
/// While capture is running the close is blocked and the renderer is asked to show its own
/// confirmation, which stops and finalizes the session first. Nothing is flushed, deleted, or
/// shortened here: the session state machine owns all of that, and the renderer decides.
fn install_close_guard(app: &mut tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.handle().clone();
    let shared: Option<state::Shared> = app
        .try_state::<state::Shared>()
        .map(|value| Arc::clone(value.inner()));
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let recording = shared
                .as_ref()
                .map(|state| state::is_capturing(state))
                .unwrap_or(false);
            if recording {
                api.prevent_close();
                state::emit_close_requested(&handle);
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("could not resolve the application data directory: {error}"))?;
            state::install(app.handle().clone(), &app_data)?;
            install_close_guard(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::recorder_refresh_permissions,
            commands::recorder_request_permissions,
            commands::recorder_list_devices,
            commands::recorder_open_settings,
            commands::recorder_preflight,
            commands::recorder_start,
            commands::recorder_pause,
            commands::recorder_resume,
            commands::recorder_stop,
            commands::recorder_status,
            commands::recorder_manifest,
            commands::recorder_mark_important,
            commands::recorder_add_note,
            commands::recorder_scan_sessions,
            commands::recorder_link_meeting,
            commands::recorder_read_chunk_bytes,
            commands::recorder_read_session_chunk,
            commands::recorder_prepare_recovered_upload,
            commands::recorder_open_external,
            commands::recorder_finish_close,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the SUHBAT desktop window")
        .run(|_app, event| {
            // The recorder is single-writer and the renderer polls, so there is no background thread to
            // tear down here. `RunEvent::Exit` would be where a graceful flush belongs if a menu-driven
            // quit path is added later.
            let _ = event;
        });
}
