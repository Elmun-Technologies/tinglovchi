//! Compiles `native/suhbat_capture.m` into a static library for the FFI shim.
//!
//! Only macOS builds link anything. On every other host this script is a no-op and `src/lib.rs`
//! compiles to a stub, which is what lets `cargo test -p recorder-core` run in CI on Linux.
//!
//! Deliberate choice: a hand-written Objective-C shim built with `cc`, not `objc2`/`block2` crates.
//! The shim's whole job is to convert one AVFoundation tap and one ScreenCaptureKit stream into the
//! tiny C ABI in `native/suhbat_capture.h`, so it adds no dependency-graph risk to the recorder core.

fn main() {
    println!("cargo:rerun-if-changed=native/suhbat_capture.m");
    println!("cargo:rerun-if-changed=native/suhbat_capture.h");
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(target_os = "macos")]
    {
        let mut build = cc::Build::new();
        build
            .file("native/suhbat_capture.m")
            .include("native")
            .flag("-fobjc-arc")
            .flag("-fno-objc-arc-exceptions")
            .flag("-Wno-deprecated-declarations")
            // Deployment target matches `bundle.macOS.minimumSystemVersion` in tauri.conf.json.
            .flag("-mmacosx-version-min=13.0")
            .compile("suhbat_capture");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
    }
}
