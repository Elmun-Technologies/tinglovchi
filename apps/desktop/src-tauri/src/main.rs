#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // All real work happens in the library target so that `cargo test` can exercise it without a window.
    suhb_desktop::run();
}
