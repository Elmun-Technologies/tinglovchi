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

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("could not resolve the application data directory: {error}"))?;
            state::install(app.handle().clone(), &app_data)?;
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
