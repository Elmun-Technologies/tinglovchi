//! Compiles `native/suhbat_capture_win.cpp` into a static library for the Windows WASAPI FFI shim.
//!
//! Only Windows builds link anything. On every other host this script is a no-op and `src/lib.rs`
//! compiles to a stub, which is what lets `cargo test -p recorder-core` and macOS/Linux builds
//! succeed without a Windows SDK.
//!
//! Deliberate choice: a self-contained C++17 WASAPI shim built with `cc`, linking only standard
//! Windows system libraries (`ole32`, `mmdevapi`, `avrt`, `uuid`, `shell32`, `advapi32`, `ntdll`).
//! It converts WASAPI event-driven microphone and loopback capture into the C ABI in
//! `native/suhbat_capture_win.h`, adding zero third-party crate dependencies to `recorder-core`.

fn main() {
    println!("cargo:rerun-if-changed=native/suhbat_capture_win.cpp");
    println!("cargo:rerun-if-changed=native/suhbat_capture_win.h");
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(target_os = "windows")]
    {
        let mut build = cc::Build::new();
        build
            .cpp(true)
            .file("native/suhbat_capture_win.cpp")
            .include("native")
            .define("UNICODE", None)
            .define("_UNICODE", None)
            .define("NOMINMAX", None)
            .define("WIN32_LEAN_AND_MEAN", None)
            .define("_WIN32_WINNT", Some("0x0A00"));

        if build.get_compiler().is_like_msvc() {
            build.flag("/std:c++17").flag("/EHsc").flag("/W4");
        } else {
            build.flag("-std=c++17").flag("-fno-exceptions");
        }

        build.compile("suhbat_capture_win");

        println!("cargo:rustc-link-lib=ole32");
        println!("cargo:rustc-link-lib=mmdevapi");
        println!("cargo:rustc-link-lib=avrt");
        println!("cargo:rustc-link-lib=uuid");
        println!("cargo:rustc-link-lib=shell32");
        println!("cargo:rustc-link-lib=advapi32");
        println!("cargo:rustc-link-lib=ntdll");
    }
}
