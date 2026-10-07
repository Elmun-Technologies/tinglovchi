# Windows Recorder Acceptance — Phase 10

This is the acceptance protocol for the Phase 10 goal: **SUHBAT can reliably capture a real meeting on
Windows 10/11 (microphone + system audio loopback), offline, behind the existing cross-platform desktop
command/domain APIs, and survive a crash.**

Read §1 first. It states what was verified in the Linux CI/implementation environment and what requires
a physical Windows 10 (version 2004 / Build 19041+) or Windows 11 machine with audio hardware.

---

## 1. Environment of record and what it proves

Implementation ran in a Linux (Debian 12, x86_64) sandbox:

| Fact                                                                                   | Consequence                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `rustc`, `cargo`, `rustup`, MSVC `cl.exe`, or Windows 10/11 SDK on the Linux host   | **No line of Rust or C++ in `crates/capture-windows` has been compiled against the Windows SDK in this sandbox.**                                                     |
| No Windows WASAPI audio endpoints (`MMDeviceEnumerator`, `IAudioClient`) on Linux      | Real WASAPI capture, loopback silence keepalive, endpoint hot-unplug notifications, and Windows Settings (`ms-settings:`) deep links require a physical Windows host. |
| Node 22 + Vitest + static structural/contract/boundary suites ran on every file change | TypeScript, `vite build`, `next build`, `vitest`, ESLint, and Prettier all ran and verified the cross-language contracts, FFI symbol parity, and platform gates.      |

---

## 2. What the Phase 10 Windows implementation provides

| Requirement                                                                                   | Mechanism (where it lives)                                                                                                                                                | Verified by                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Cross-platform command/domain API reuse (`recorder_*` Tauri commands, manifest, state, clock) | `apps/desktop/src-tauri/src/platform.rs` selects `capture_windows::WindowsCaptureBackend` under `#[cfg(target_os = "windows")]`; `recorder-core` is unchanged in contract | `tests/desktop/recorder-contract.test.ts`, `tests/desktop/rust-structure.test.ts`           |
| Two independent sources (`microphone` + `system_audio`), never mixed at capture time          | WASAPI `eCapture` stream for microphone + WASAPI `eRender` (`AUDCLNT_STREAMFLAGS_LOOPBACK`) stream for system audio; separate `ChunkWriter` and directories               | `crates/capture-windows/native/suhbat_capture_win.cpp`, `recorder-offline-boundary.test.ts` |
| Shared hardware monotonic clock (`QueryPerformanceCounter` / `QueryPerformanceFrequency`)     | `recorder_core::clock::SystemClock` (`#[cfg(target_os = "windows")]`) and `suhbat_win_host_time_ns()` both scale QPC ticks to nanoseconds (`TICK_FREQUENCY_HZ = 1e9`)     | `crates/recorder-core/src/clock.rs`, `crates/capture-windows/native/suhbat_capture_win.cpp` |
| Windows microphone privacy & group policy detection                                           | Reads `HKLM\...\AppPrivacy\LetAppsAccessMicrophone` and `HKCU\...\CapabilityAccessManager\ConsentStore\microphone\NonPackaged` + active endpoint checks                   | `suhbat_check_microphone_registry_consent` in `suhbat_capture_win.cpp`, **Test A**          |
| Actionable Windows Settings repair links                                                      | `ms-settings:privacy-microphone` (microphone) and `ms-settings:sound` (system audio) opened via `ShellExecuteW`                                                           | `suhbat_win_settings_url` / `suhbat_win_open_settings`, **Test A.3**                        |
| Endpoint hot-unplug & default-device change detection (no silent microphone substitution)     | `SuhbatEndpointObserver` (`IMMNotificationClient`) watches `OnDeviceStateChanged`, `OnDeviceRemoved`, and `OnDefaultDeviceChanged`, raising stream failure on change      | `SuhbatEndpointObserver` in `suhbat_capture_win.cpp`, **Test B**                            |
| Continuous loopback blocks during output silence                                              | 20 ms wait timeout emits zeroed PCM frames when WASAPI loopback receives no render packets during silence                                                                 | `suhbat_capture_worker_proc` in `suhbat_capture_win.cpp`, **Test C**                        |
| Strict platform isolation                                                                     | All Windows C++/FFI code is gated behind `#[cfg(target_os = "windows")]` in `crates/capture-windows` and `src-tauri/Cargo.toml`                                           | `tests/desktop/recorder-offline-boundary.test.ts`, `tests/desktop/rust-structure.test.ts`   |

---

## 3. Build gates on Windows 10 / 11

Run in a Developer PowerShell for Visual Studio 2022 on Windows 10 (Build 19041+) or Windows 11:

```powershell
cd apps/desktop
rustup show                                   # expect stable >= 1.82 (x86_64-pc-windows-msvc)
cargo --version; rustc --version
cl.exe                                        # expect Microsoft (R) C/C++ Optimizing Compiler

cargo fmt --all --check --manifest-path src-tauri/Cargo.toml   # G1
cargo clippy --workspace --all-targets -- -D warnings          # G2
cargo test --workspace --manifest-path src-tauri/Cargo.toml    # G3
npm run build                                                  # G4 (renderer)
npm run tauri -- build                                         # G5 (produces .msi / NSIS setup.exe)
```

---

## 4. Hardware & OS acceptance tests (Tests A–I)

### Test A — Windows Microphone Privacy & Settings Deep Link

1. Open **Settings → Privacy & security → Microphone** and toggle **Let desktop apps access your microphone** to **Off**.
2. Launch **SUHBAT Recorder** and click **Re-check permissions**.
   - **Expected**: `microphone = "permission_denied"`, `systemAudio = "permission_granted"`, `openSettingsSupported = true`, and the Start button is disabled.
3. Trigger `recorder_open_settings` for `microphone`.
   - **Expected**: Windows Settings opens directly to `ms-settings:privacy-microphone`.
4. Re-enable **Let desktop apps access your microphone** and click **Re-check permissions**.
   - **Expected**: `microphone = "permission_granted"` and Start becomes available once consent is checked.

### Test B — Device Enumeration & Hot-Unplug / Default-Device Change

1. Connect a USB or Bluetooth headset microphone alongside the built-in microphone array.
2. Verify `recorder_list_devices("microphone")` lists every active `eCapture` endpoint with its friendly name, `isDefault` flag, mix sample rate (`sampleRateHz`), and channel count (`channels`).
3. Start a recording using the default microphone, then unplug the active microphone (or change the Windows default input device in `ms-settings:sound`).
   - **Expected**: `SuhbatEndpointObserver` detects the change immediately; the microphone stream transitions to failed/degraded rather than silently switching to another microphone.

### Test C — Concurrent Microphone + WASAPI Loopback Capture (Including Silent Output)

1. Start a 90-second recording with `captureSystemAudio = true`.
2. Speak into the microphone for the first 30 seconds while playing a reference audio track on the system output, then mute/stop all system audio playback for 30 seconds while continuing to speak, then resume system audio playback for the final 30 seconds.
3. Stop and finalize the recording.
   - **Expected**:
     - `microphone/000000.wav`, `000001.wav`, `000002.wav` contain only microphone audio.
     - `system-audio/000000.wav`, `000001.wav`, `000002.wav` contain only system output audio, with continuous zeroed samples during the 30–60 s silent window (no stalled chunk writer or missing timeline interval).

### Test D — Pause / Resume & Monotonic QPC Timeline

1. Record for 20 seconds, pause for 15 seconds, resume for 20 seconds, and stop.
2. Inspect `manifest.json`:
   - **Expected**: `timeline.originTicks` and chunk `firstSampleMonotonicTicks` use the `QueryPerformanceCounter` nanosecond clock; `pauseIntervals` records the 15-second gap; `canonicalElapsedMs` is ~55,000 ms while `activeCaptureMs` is ~40,000 ms.

### Test E — Process Termination (`taskkill /F`) & Startup Crash Recovery

1. Start a recording, wait until at least one chunk is finalized and the next `.partial` chunk is being written, then run `taskkill /F /IM suhbat-desktop.exe`.
2. Relaunch **SUHBAT Recorder**.
   - **Expected**: Startup `scan_and_reconcile` surfaces the interrupted session in the recovery banner with all finalized chunks intact and the truncated `.partial` file salvaged or recorded as an explicit gap without deleting any user data.

---

## 5. Phase 12.1 Static Audit & Pre-Hardware Fixes

Before physical Windows 10/11 hardware compilation, the following static audit items were verified and hardened in `apps/desktop/crates/capture-windows`:

1. **Realized WASAPI Mix-Format Propagation (`src/lib.rs`)**: `WindowsCaptureBackend::open_stream` queries `suhbat_win_device_actual_format` before constructing `StreamContext` so `SampleBlock` and `ChunkWriter` always receive the endpoint's realized `sample_rate_hz` and `channels` (e.g., 48 kHz stereo on shared-mode loopback or multi-channel USB interfaces) rather than the nominal request hints.
2. **Hardware Packet QPC Timestamping (`native/suhbat_capture_win.cpp`)**: `suhbat_capture_worker_proc` uses the hardware packet timestamp `qpc_position * 100ull` from `IAudioCaptureClient::GetBuffer` whenever `qpc_position > 0` and `(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0`, falling back to `suhbat_win_host_time_ns()` only when the driver reports a timestamp error or during silent loopback keepalive ticks.
3. **Chunk Rotation Monotonic Ticks (`crates/recorder-core/src/writer.rs`)**: Shared `ChunkWriter::handle_block` advances `block_first_tick` by the exact sample offset consumed into the prior chunk when splitting a `SampleBlock` across a 30-second boundary, ensuring `firstSampleMonotonicTicks` on rotated chunks is strictly monotonic on Windows and macOS alike.
