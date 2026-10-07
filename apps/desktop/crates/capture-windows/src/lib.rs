//! Windows capture bridge: the Rust side of the WASAPI FFI shim in `native/suhbat_capture_win.cpp`.
//!
//! This crate is the only place in the desktop app that knows Windows Core Audio / WASAPI exists.
//! It converts C callbacks into [`recorder_core::capture::CaptureCallback`] calls and refuses clearly
//! when the OS or audio hardware cannot support a source — it never substitutes another microphone
//! and never reports a microphone-only session as "both sources captured".
//!
//! Availability is *checked*, never assumed: `suhbat_win_backend_available()` and
//! `suhbat_win_system_audio_available()` verify Windows 10 build 19041+ and active WASAPI COM
//! endpoint availability at runtime, and the build fails closed on non-Windows hosts where no
//! Windows native code is compiled (see `build.rs`).
//!
//! # Safety
//! Every `unsafe` block here exists to cross the C ABI boundary. The invariants that make them sound:
//! * the boxed [`StreamContext`] is created in `start` and freed only after `suhbat_win_stream_stop`
//!   returns, which is when the native worker thread has been joined and no further callback can run;
//! * the sample pointer is valid only for the duration of `on_block_trampoline`, and we copy it immediately;
//! * fixed-size `char` arrays written by the native side are NUL-terminated by contract; we read them
//!   through `CStr::from_ptr` on a zero-initialized buffer.

#![cfg_attr(not(target_os = "windows"), allow(dead_code, unused_imports))]

/// Fail-closed stand-in used on every non-Windows target so the workspace still builds and
/// `recorder-core`'s tests still run there.
#[cfg(not(target_os = "windows"))]
pub use recorder_core::capture::UnavailableBackend as WindowsCaptureBackend;

/// On Windows the backend is the real WASAPI bridge; the alias keeps call sites uniform.
#[cfg(target_os = "windows")]
pub use bridge::WindowsCaptureBackend;

#[cfg(target_os = "windows")]
mod bridge {
    use recorder_core::capture::{
        AudioBlock, BackendAvailability, CaptureBackend, CaptureCallback, CaptureStream,
        SourceConfig, StreamState,
    };
    use recorder_core::clock::{Clock, SystemClock};
    use recorder_core::errors::{RecorderError, RecorderErrorCode, SourceKind};
    use recorder_core::platform::{AudioDevice, PermissionSnapshot, PermissionState};
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::ptr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct DeviceInfo {
        pub uid: [c_char; 128],
        pub name: [c_char; 160],
        pub is_default: i32,
        pub is_available: i32,
        pub sample_rate_hz: u32,
        pub channels: u16,
    }

    pub const SOURCE_MICROPHONE: i32 = 0;
    pub const SOURCE_SYSTEM_AUDIO: i32 = 1;

    /// Layout the native side reads. Field order must stay identical to `suhbat_win_stream_config`
    /// in `native/suhbat_capture_win.h`.
    #[repr(C)]
    pub struct RawStreamConfig {
        pub kind: i32,
        pub sample_rate_hz: u32,
        pub channels: u16,
        pub device_uid: *const c_char,
        pub user_data: *mut c_void,
        pub on_block: Option<extern "C" fn(*mut c_void, *const i16, usize, u64, i32) -> i32>,
        pub on_overflow: Option<extern "C" fn(*mut c_void, u64)>,
        pub on_state: Option<extern "C" fn(*mut c_void, i32, *const c_char)>,
    }

    unsafe extern "C" {
        fn suhbat_win_backend_available() -> i32;
        fn suhbat_win_system_audio_available() -> i32;
        fn suhbat_win_os_version(out: *mut c_char, out_len: usize);
        fn suhbat_win_permission_state_for(kind: i32) -> i32;
        fn suhbat_win_request_permission(kind: i32) -> i32;
        fn suhbat_win_device_count(kind: i32) -> usize;
        fn suhbat_win_device_at(kind: i32, index: usize, out: *mut DeviceInfo) -> i32;
        fn suhbat_win_device_actual_format(
            kind: i32,
            device_uid: *const c_char,
            sample_rate: *mut u32,
            channels: *mut u16,
        );
        fn suhbat_win_stream_start(
            config: *const RawStreamConfig,
            err: *mut c_char,
            err_len: usize,
        ) -> *mut c_void;
        fn suhbat_win_stream_pause(stream: *mut c_void, err: *mut c_char, err_len: usize) -> i32;
        fn suhbat_win_stream_resume(stream: *mut c_void, err: *mut c_char, err_len: usize) -> i32;
        fn suhbat_win_stream_stop(stream: *mut c_void);
        fn suhbat_win_settings_url(kind: i32) -> *const c_char;
        fn suhbat_win_open_settings(kind: i32, err: *mut c_char, err_len: usize) -> i32;
    }

    fn ffi_int(kind: SourceKind) -> i32 {
        match kind {
            SourceKind::Microphone => SOURCE_MICROPHONE,
            SourceKind::SystemAudio => SOURCE_SYSTEM_AUDIO,
        }
    }

    fn read_c_buffer(raw: *const c_char) -> String {
        if raw.is_null() {
            return String::new();
        }
        // SAFETY: the C++ side writes NUL-terminated text into fixed-size arrays and returns static strings;
        // we only read.
        unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned()
    }

    fn c_string(text: &str) -> Result<CString, RecorderError> {
        CString::new(text).map_err(|_| {
            RecorderError::new(
                RecorderErrorCode::InternalError,
                "a device identifier contained a NUL byte",
                false,
            )
        })
    }

    /// Shared between the boxed context the native side holds and the stream handle Rust owns.
    #[derive(Clone, Default)]
    struct SharedState {
        state: Arc<Mutex<StreamState>>,
        dropped_samples: Arc<AtomicU64>,
        delivered_frames: Arc<AtomicU64>,
    }

    struct StreamContext {
        callback: Arc<dyn CaptureCallback>,
        channels: u16,
        shared: SharedState,
    }

    extern "C" fn on_block_trampoline(
        user_data: *mut c_void,
        samples: *const i16,
        frame_count: usize,
        host_time_ns: u64,
        discontinuity: i32,
    ) -> i32 {
        if user_data.is_null() || samples.is_null() || frame_count == 0 {
            return 0;
        }
        // SAFETY: `user_data` is the `Box::into_raw` context created in `start`; it is only freed after
        // `suhbat_win_stream_stop`, and no callback runs after that point.
        let context = unsafe { &*(user_data as *const StreamContext) };
        let channels = usize::from(context.channels.max(1));
        let len = frame_count.saturating_mul(channels);
        // SAFETY: the native contract is `frame_count * channels` int16 values, valid for this call only,
        // so we copy immediately into an owned Vec.
        let copied = unsafe { std::slice::from_raw_parts(samples, len) }.to_vec();
        let first_sample_index = context
            .shared
            .delivered_frames
            .fetch_add(frame_count as u64, Ordering::Relaxed);
        let block = AudioBlock {
            first_sample_index,
            first_tick: u128::from(host_time_ns),
            samples: copied,
            discontinuity: discontinuity != 0,
        };
        if context.callback.on_block(block) {
            1
        } else {
            0
        }
    }

    extern "C" fn on_overflow_trampoline(user_data: *mut c_void, dropped_frame_count: u64) {
        if user_data.is_null() {
            return;
        }
        // SAFETY: see `on_block_trampoline`.
        let context = unsafe { &*(user_data as *const StreamContext) };
        let samples = dropped_frame_count.saturating_mul(u64::from(context.channels.max(1)));
        context
            .shared
            .dropped_samples
            .fetch_add(samples, Ordering::Relaxed);
        context.callback.on_overflow(samples);
    }

    extern "C" fn on_state_trampoline(user_data: *mut c_void, state: i32, detail: *const c_char) {
        if user_data.is_null() {
            return;
        }
        // SAFETY: see `on_block_trampoline`.
        let context = unsafe { &*(user_data as *const StreamContext) };
        let mapped = match state {
            0 => StreamState::Starting,
            1 => StreamState::Running,
            2 => StreamState::Paused,
            3 => StreamState::Ended,
            _ => StreamState::Failed,
        };
        if let Ok(mut guard) = context.shared.state.lock() {
            *guard = mapped;
        }
        if mapped == StreamState::Failed {
            let detail_text = read_c_buffer(detail);
            if !detail_text.is_empty() {
                eprintln!("suhbat windows capture: {detail_text}");
            }
        }
    }

    /// A live Windows WASAPI stream. Stopping is idempotent and frees the context box.
    pub struct WindowsCaptureStream {
        kind: SourceKind,
        handle: *mut c_void,
        context: *mut StreamContext,
        shared: SharedState,
        actual: Option<(u32, u16)>,
    }

    // SAFETY: the raw handle is only mutated behind `&mut self`, and the native worker thread reaches
    // the context through atomics/mutexes. `suhbat_win_stream_stop` joins the worker thread before the
    // context box is freed.
    unsafe impl Send for WindowsCaptureStream {}

    impl WindowsCaptureStream {
        fn command(&mut self, pause: bool) -> Result<(), RecorderError> {
            if self.handle.is_null() {
                return Ok(());
            }
            let mut err = [0 as c_char; 256];
            let rc = if pause {
                // SAFETY: `handle` is live until `stop`/`Drop`; `err` is a writable buffer of `err.len()`.
                unsafe { suhbat_win_stream_pause(self.handle, err.as_mut_ptr(), err.len()) }
            } else {
                // SAFETY: same as above.
                unsafe { suhbat_win_stream_resume(self.handle, err.as_mut_ptr(), err.len()) }
            };
            if rc == 0 {
                return Ok(());
            }
            let detail = read_c_buffer(err.as_ptr());
            Err(RecorderError::new(
                RecorderErrorCode::CaptureStalled,
                format!(
                    "native {} failed: {}",
                    if pause { "pause" } else { "resume" },
                    if detail.is_empty() { "no detail" } else { &detail }
                ),
                true,
            )
            .with_source(self.kind))
        }
    }

    impl CaptureStream for WindowsCaptureStream {
        fn pause(&mut self) -> Result<(), RecorderError> {
            self.command(true)
        }

        fn resume(&mut self) -> Result<(), RecorderError> {
            self.command(false)
        }

        fn stop(&mut self) -> Result<(), RecorderError> {
            if !self.handle.is_null() {
                let handle = self.handle;
                self.handle = ptr::null_mut();
                // SAFETY: stops the WASAPI worker thread and joins it before returning, making it safe
                // to free the context box immediately afterwards.
                unsafe { suhbat_win_stream_stop(handle) };
            }
            if !self.context.is_null() {
                let raw = std::ptr::replace(&mut self.context, ptr::null_mut());
                // SAFETY: the box was created in `start` and no callback can be in flight after stop.
                drop(unsafe { Box::from_raw(raw) });
            }
            Ok(())
        }

        fn state(&self) -> StreamState {
            self.shared
                .state
                .lock()
                .map(|guard| *guard)
                .unwrap_or(StreamState::Failed)
        }

        fn dropped_frames(&self) -> u64 {
            self.shared.dropped_samples.load(Ordering::Relaxed)
        }

        fn actual_format(&self) -> Option<(u32, u16)> {
            self.actual
        }
    }

    impl Drop for WindowsCaptureStream {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    /// The Windows WASAPI backend. Stateless: each `start` owns its stream and context.
    #[derive(Clone, Copy, Default)]
    pub struct WindowsCaptureBackend;

    impl WindowsCaptureBackend {
        #[must_use]
        pub const fn new() -> Self {
            Self
        }

        #[must_use]
        pub fn system_audio_supported() -> bool {
            // SAFETY: pure runtime queries into the WASAPI bridge.
            unsafe {
                suhbat_win_backend_available() == 1 && suhbat_win_system_audio_available() == 1
            }
        }

        fn availability() -> BackendAvailability {
            // SAFETY: pure runtime query.
            if unsafe { suhbat_win_backend_available() } != 1 {
                return BackendAvailability::UnsupportedOsVersion;
            }
            if Self::system_audio_supported() {
                BackendAvailability::Available
            } else {
                BackendAvailability::UnsupportedOsVersion
            }
        }

        fn os_version() -> String {
            let mut buffer = [0 as c_char; 64];
            // SAFETY: fixed buffer of the advertised length; the C++ side NUL-terminates.
            unsafe { suhbat_win_os_version(buffer.as_mut_ptr(), buffer.len()) };
            read_c_buffer(buffer.as_ptr())
        }

        fn permission(kind: SourceKind) -> PermissionState {
            // SAFETY: pure runtime query.
            match unsafe { suhbat_win_permission_state_for(ffi_int(kind)) } {
                1 => PermissionState::Granted,
                2 => PermissionState::Denied,
                3 => PermissionState::DeviceUnavailable,
                _ => PermissionState::Unknown,
            }
        }

        fn settings_url(kind: SourceKind) -> Option<String> {
            // SAFETY: returns a static string owned by the native library.
            let text = read_c_buffer(unsafe { suhbat_win_settings_url(ffi_int(kind)) });
            (!text.is_empty()).then_some(text)
        }

        fn checked_at() -> String {
            let clock = SystemClock::new();
            clock.wall_clock_rfc3339(clock.wall_clock_ms())
        }
    }

    impl CaptureBackend for WindowsCaptureBackend {
        fn availability(&self) -> BackendAvailability {
            Self::availability()
        }

        fn permission_snapshot(&self) -> PermissionSnapshot {
            let availability = Self::availability();
            let microphone = Self::permission(SourceKind::Microphone);
            let system_audio = match availability {
                BackendAvailability::Available => Self::permission(SourceKind::SystemAudio),
                _ => PermissionState::DeviceUnavailable,
            };
            PermissionSnapshot {
                microphone,
                system_audio,
                availability,
                os_version: Self::os_version(),
                minimum_macos_version: None,
                open_settings_supported: true,
                detail: (availability == BackendAvailability::UnsupportedOsVersion).then(|| {
                    "WASAPI loopback capture requires Windows 10 version 2004 (Build 19041) or later and an active audio output endpoint"
                        .to_string()
                }),
                checked_at: Self::checked_at(),
            }
        }

        fn request_permissions(
            &self,
            kinds: &[SourceKind],
        ) -> Result<PermissionSnapshot, RecorderError> {
            for kind in kinds {
                // SAFETY: pure query/check in the WASAPI bridge; never spams modal dialogs.
                unsafe { suhbat_win_request_permission(ffi_int(*kind)) };
            }
            Ok(self.permission_snapshot())
        }

        fn devices(&self, kind: SourceKind) -> Result<Vec<AudioDevice>, RecorderError> {
            if kind == SourceKind::SystemAudio {
                return Ok(Vec::new());
            }
            // SAFETY: pure WASAPI endpoint count query.
            let count = unsafe { suhbat_win_device_count(ffi_int(kind)) }.min(64);
            let mut devices = Vec::with_capacity(count);
            for index in 0..count {
                let mut raw = DeviceInfo {
                    uid: [0 as c_char; 128],
                    name: [0 as c_char; 160],
                    is_default: 0,
                    is_available: 0,
                    sample_rate_hz: 0,
                    channels: 0,
                };
                // SAFETY: `raw` is a valid writable pointer to the plain-data struct the C++ side fills.
                if unsafe { suhbat_win_device_at(ffi_int(kind), index, &mut raw) } != 0 {
                    continue;
                }
                let uid = read_c_buffer(raw.uid.as_ptr());
                if uid.is_empty() {
                    continue;
                }
                let name = read_c_buffer(raw.name.as_ptr());
                let mut sample_rate = raw.sample_rate_hz;
                let mut channels = raw.channels;
                if (sample_rate == 0 || channels == 0) && !uid.is_empty() {
                    if let Ok(uid_cstring) = c_string(&uid) {
                        // SAFETY: two writable scalars, filled by the C++ side.
                        unsafe {
                            suhbat_win_device_actual_format(
                                ffi_int(kind),
                                uid_cstring.as_ptr(),
                                &mut sample_rate,
                                &mut channels,
                            )
                        };
                    }
                }
                devices.push(AudioDevice {
                    uid,
                    name: if name.is_empty() {
                        "Unknown input".into()
                    } else {
                        name
                    },
                    is_default: raw.is_default == 1,
                    is_available: raw.is_available == 1,
                    sample_rate_hz: (sample_rate > 0).then_some(sample_rate),
                    channels: (channels > 0).then_some(channels),
                });
            }
            Ok(devices)
        }

        fn settings_url(&self, kind: SourceKind) -> Option<String> {
            Self::settings_url(kind)
        }

        fn open_settings_for(&self, kind: SourceKind) -> Result<(), RecorderError> {
            let mut err = [0 as c_char; 256];
            // SAFETY: opens a `ms-settings:` URI via ShellExecuteW; writes at most `err.len()` bytes.
            let rc = unsafe { suhbat_win_open_settings(ffi_int(kind), err.as_mut_ptr(), err.len()) };
            if rc == 0 {
                return Ok(());
            }
            Err(RecorderError::new(
                RecorderErrorCode::PlatformUnsupported,
                format!(
                    "could not open Windows Settings: {}",
                    read_c_buffer(err.as_ptr())
                ),
                false,
            )
            .with_settings_hint(Self::settings_url(kind)))
        }

        fn start(
            &self,
            config: SourceConfig,
            callback: Arc<dyn CaptureCallback>,
        ) -> Result<Box<dyn CaptureStream>, RecorderError> {
            let availability = Self::availability();
            if availability == BackendAvailability::UnsupportedPlatform {
                return Err(RecorderError::new(
                    RecorderErrorCode::PlatformUnsupported,
                    "this build has no capture backend for the current platform",
                    false,
                )
                .with_source(config.kind));
            }
            if config.kind == SourceKind::SystemAudio && availability != BackendAvailability::Available
            {
                return Err(RecorderError::new(
                    RecorderErrorCode::SystemAudioUnavailable,
                    "WASAPI loopback system-audio capture requires Windows 10 version 2004 (Build 19041+) and an active audio output device",
                    false,
                )
                .with_source(config.kind)
                .with_settings_hint(Self::settings_url(config.kind)));
            }
            let device_uid = match config.device_uid.as_deref() {
                None | Some("") => None,
                Some(uid) => Some(c_string(uid)?),
            };
            let mut actual_rate = 0u32;
            let mut actual_channels = 0u16;
            // SAFETY: queries WASAPI mix format before starting so `StreamContext.channels` matches
            // the hardware's actual channel layout.
            unsafe {
                suhbat_win_device_actual_format(
                    ffi_int(config.kind),
                    device_uid
                        .as_ref()
                        .map_or_else(ptr::null, |value| value.as_ptr()),
                    &mut actual_rate,
                    &mut actual_channels,
                );
            }
            let effective_rate = if actual_rate > 0 {
                actual_rate
            } else {
                config.sample_rate_hz
            };
            let effective_channels = if actual_channels > 0 {
                actual_channels
            } else {
                config.channels.max(1)
            };

            let shared = SharedState::default();
            if let Ok(mut guard) = shared.state.lock() {
                *guard = StreamState::Starting;
            }
            let context = Box::new(StreamContext {
                callback,
                channels: effective_channels,
                shared: shared.clone(),
            });
            let raw_context = Box::into_raw(context);
            let raw = RawStreamConfig {
                kind: ffi_int(config.kind),
                sample_rate_hz: effective_rate,
                channels: effective_channels,
                device_uid: device_uid
                    .as_ref()
                    .map_or_else(ptr::null, |value| value.as_ptr()),
                user_data: raw_context as *mut c_void,
                on_block: Some(on_block_trampoline),
                on_overflow: Some(on_overflow_trampoline),
                on_state: Some(on_state_trampoline),
            };
            let mut err = [0 as c_char; 512];
            // SAFETY: `raw` borrows `device_uid` (alive for this call) and passes `raw_context` ownership
            // to the native stream until `suhbat_win_stream_stop`.
            let handle = unsafe { suhbat_win_stream_start(&raw, err.as_mut_ptr(), err.len()) };
            if handle.is_null() {
                let message = read_c_buffer(err.as_ptr());
                // SAFETY: no native stream was started, so we reclaim the context box immediately.
                drop(unsafe { Box::from_raw(raw_context) });
                let code = if config.kind == SourceKind::SystemAudio {
                    RecorderErrorCode::SystemAudioUnavailable
                } else {
                    RecorderErrorCode::CaptureStartFailed
                };
                return Err(RecorderError::new(
                    code,
                    if message.is_empty() {
                        "WASAPI capture start failed".to_string()
                    } else {
                        message
                    },
                    config.kind == SourceKind::SystemAudio,
                )
                .with_source(config.kind)
                .with_settings_hint(Self::settings_url(config.kind)));
            }
            Ok(Box::new(WindowsCaptureStream {
                kind: config.kind,
                handle,
                context: raw_context,
                shared,
                actual: Some((effective_rate, effective_channels)),
            }))
        }
    }
}
