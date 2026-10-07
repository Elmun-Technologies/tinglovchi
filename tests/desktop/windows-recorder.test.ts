import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { permissionSnapshotSchema, recorderErrorSchema } from '@suhbat/contracts';

const ROOT = join(__dirname, '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const WIN_CRATE = join(DESKTOP, 'crates', 'capture-windows');
const CORE_CRATE = join(DESKTOP, 'crates', 'recorder-core');
const TAURI_CRATE = join(DESKTOP, 'src-tauri');

describe('Phase 10 — Windows Recorder (WASAPI Microphone & Loopback Bridge)', () => {
  it('includes capture-windows in workspace Cargo.toml and gates it in src-tauri/Cargo.toml', () => {
    const workspaceToml = readFileSync(join(DESKTOP, 'Cargo.toml'), 'utf8');
    expect(workspaceToml).toContain('"crates/capture-windows"');
    expect(workspaceToml).toContain('capture-windows = { path = "crates/capture-windows" }');

    const tauriToml = readFileSync(join(TAURI_CRATE, 'Cargo.toml'), 'utf8');
    expect(tauriToml).toContain('[target.\'cfg(target_os = "windows")\'.dependencies]');
    expect(tauriToml).toContain('capture-windows = { workspace = true }');

    const platformRs = readFileSync(join(TAURI_CRATE, 'src', 'platform.rs'), 'utf8');
    expect(platformRs).toContain('#[cfg(target_os = "windows")]');
    expect(platformRs).toContain(
      'pub type SystemBackend = capture_windows::WindowsCaptureBackend;',
    );
    expect(platformRs).toContain('cfg!(any(target_os = "macos", target_os = "windows"))');
  });

  it('verifies C ABI struct field parity between capture-windows/src/lib.rs and native/suhbat_capture_win.h', () => {
    const header = readFileSync(join(WIN_CRATE, 'native', 'suhbat_capture_win.h'), 'utf8');
    const rustLib = readFileSync(join(WIN_CRATE, 'src', 'lib.rs'), 'utf8');

    // DeviceInfo fields
    for (const field of [
      'uid',
      'name',
      'is_default',
      'is_available',
      'sample_rate_hz',
      'channels',
    ]) {
      expect(header).toContain(field);
      expect(rustLib).toContain(`pub ${field}:`);
    }

    // RawStreamConfig fields
    for (const field of [
      'kind',
      'sample_rate_hz',
      'channels',
      'device_uid',
      'user_data',
      'on_block',
      'on_overflow',
      'on_state',
    ]) {
      expect(header).toContain(field);
      expect(rustLib).toContain(`pub ${field}:`);
    }
  });

  it('shares QueryPerformanceCounter / QueryPerformanceFrequency nanosecond clock between recorder-core and capture-windows and uses WASAPI packet QPC timestamps', () => {
    const clockRs = readFileSync(join(CORE_CRATE, 'src', 'clock.rs'), 'utf8');
    const winCpp = readFileSync(join(WIN_CRATE, 'native', 'suhbat_capture_win.cpp'), 'utf8');
    const winRs = readFileSync(join(WIN_CRATE, 'src', 'lib.rs'), 'utf8');

    expect(clockRs).toContain('#[cfg(target_os = "windows")]');
    expect(clockRs).toContain('QueryPerformanceCounter');
    expect(clockRs).toContain('QueryPerformanceFrequency');
    expect(clockRs).toContain('1_000_000_000');

    expect(winCpp).toContain('QueryPerformanceCounter(&counter)');
    expect(winCpp).toContain('QueryPerformanceFrequency(&freq)');
    expect(winCpp).toContain('1000000000ull');
    expect(winCpp).toContain('AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR');
    expect(winCpp).toContain('qpc_position * 100ull');
    expect(winRs).toContain('suhbat_win_device_actual_format');
  });

  it('implements separate WASAPI eCapture microphone and eRender AUDCLNT_STREAMFLAGS_LOOPBACK system audio paths with silence keepalive and IMMNotificationClient', () => {
    const winCpp = readFileSync(join(WIN_CRATE, 'native', 'suhbat_capture_win.cpp'), 'utf8');

    // Separate flows: eCapture for microphone, eRender + AUDCLNT_STREAMFLAGS_LOOPBACK for system audio
    expect(winCpp).toContain(
      '(stream->kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) ? eRender : eCapture',
    );
    expect(winCpp).toContain('stream_flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;');
    expect(winCpp).toContain('AUDCLNT_STREAMFLAGS_EVENTCALLBACK');

    // Loopback silence keepalive on WAIT_TIMEOUT so silent output never stalls the canonical timeline
    expect(winCpp).toContain('WAIT_TIMEOUT');
    expect(winCpp).toContain('silent_keepalive_frames');

    // IMMNotificationClient endpoint hot-unplug and default-device switch detection (no silent device swap)
    expect(winCpp).toContain('class SuhbatEndpointObserver final : public IMMNotificationClient');
    expect(winCpp).toContain('OnDeviceStateChanged');
    expect(winCpp).toContain('OnDeviceRemoved');
    expect(winCpp).toContain('OnDefaultDeviceChanged');

    // Windows CapabilityAccessManager microphone privacy registry checks & ms-settings deep links
    expect(winCpp).toContain(
      'CapabilityAccessManager\\\\ConsentStore\\\\microphone\\\\NonPackaged',
    );
    expect(winCpp).toContain('LetAppsAccessMicrophone');
    expect(winCpp).toContain('ms-settings:privacy-microphone');
    expect(winCpp).toContain('ms-settings:sound');
    expect(winCpp).toContain('ShellExecuteW');
  });

  it('validates Windows PermissionSnapshot and RecorderError shapes against shared contracts and ships docs/windows-recorder-acceptance.md', () => {
    expect(existsSync(join(ROOT, 'docs', 'windows-recorder-acceptance.md'))).toBe(true);

    const winSnapshot = permissionSnapshotSchema.parse({
      microphone: 'permission_granted',
      systemAudio: 'permission_granted',
      availability: 'available',
      osVersion: 'Windows 11 (10.0.22631)',
      minimumMacosVersion: null,
      openSettingsSupported: true,
      detail: null,
      checkedAt: '2026-10-07T10:15:00Z',
    });
    expect(winSnapshot.osVersion).toContain('Windows 11');
    expect(winSnapshot.openSettingsSupported).toBe(true);

    const winDeniedError = recorderErrorSchema.parse({
      code: 'permission_denied',
      message: 'Windows microphone privacy access is disabled for desktop apps',
      retryable: false,
      sourceKind: 'microphone',
      openSettingsUrl: 'ms-settings:privacy-microphone',
    });
    expect(winDeniedError.openSettingsUrl).toBe('ms-settings:privacy-microphone');
  });
});
