fn main() {
    // Tauri reads `tauri.conf.json`, the capabilities directory, and `Info.plist` (merged into the bundle's
    // Info.plist by tauri-build). Nothing else is generated here: the Objective-C shim is compiled by
    // `crates/capture-macos/build.rs`, which keeps all Apple-framework linking next to the code that needs it.
    tauri_build::build()
}
