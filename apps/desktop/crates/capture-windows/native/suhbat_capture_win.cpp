/*
 * SUHBAT Windows WASAPI capture bridge (Phase 10).
 *
 * Two independent logical sources, never mixed into a single track at capture time:
 *   microphone   -> WASAPI shared-mode event-driven capture (`eCapture`)
 *   system audio -> WASAPI shared-mode event-driven loopback capture (`eRender`, AUDCLNT_STREAMFLAGS_LOOPBACK)
 *
 * Realtime discipline:
 *   - Capture runs on a dedicated MMCSS "Pro Audio" worker thread per stream.
 *   - Inside the packet loop, the only work is float32/int16 conversion into a reused `int16_t`
 *     scratch buffer and one non-blocking call into the Rust trampoline (`on_block`).
 *   - `QueryPerformanceCounter` / `QueryPerformanceFrequency` provides nanosecond monotonic timestamps
 *     matching `recorder_core::clock::SystemClock` on Windows.
 *   - Endpoint hot-unplug or default-device changes are detected via `IMMNotificationClient`; the stream
 *     reports failure (`SUHBAT_WIN_STREAM_FAILED`) rather than silently swapping to a different microphone.
 *   - Loopback capture emits zeroed frames across render-idle intervals when the output endpoint is quiet
 *     so the canonical timeline and chunk writer receive continuous time-aligned blocks.
 *
 * VALIDATION STATUS: compiled only on Windows targets (`#[cfg(target_os = "windows")]` in `build.rs`).
 * See `docs/windows-recorder-acceptance.md` for the Windows hardware & build gate protocol.
 */

#include "suhbat_capture_win.h"

#ifdef _WIN32

#include <windows.h>
#include <avrt.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <shellapi.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

typedef LONG NTSTATUS;
typedef NTSTATUS(WINAPI *RtlGetVersionPtr)(PRTL_OSVERSIONINFOW);

static uint64_t suhbat_win_host_time_ns(void) {
  LARGE_INTEGER counter;
  LARGE_INTEGER freq;
  if (!QueryPerformanceCounter(&counter) || !QueryPerformanceFrequency(&freq) ||
      counter.QuadPart <= 0 || freq.QuadPart <= 0) {
    return 0;
  }
  const uint64_t ticks = static_cast<uint64_t>(counter.QuadPart);
  const uint64_t hz = static_cast<uint64_t>(freq.QuadPart);
  const uint64_t whole_seconds = ticks / hz;
  const uint64_t remainder_ticks = ticks % hz;
  return whole_seconds * 1000000000ull + (remainder_ticks * 1000000000ull) / hz;
}

static void suhbat_win_write_text(const char *src, char *out, size_t out_len) {
  if (out == nullptr || out_len == 0) {
    return;
  }
  if (src == nullptr) {
    out[0] = '\0';
    return;
  }
  std::strncpy(out, src, out_len - 1);
  out[out_len - 1] = '\0';
}

static std::string suhbat_wide_to_utf8(const wchar_t *wide) {
  if (wide == nullptr || wide[0] == L'\0') {
    return std::string();
  }
  int bytes = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (bytes <= 1) {
    return std::string();
  }
  std::string out(static_cast<size_t>(bytes - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, &out[0], bytes, nullptr, nullptr);
  return out;
}

static std::wstring suhbat_utf8_to_wide(const char *utf8) {
  if (utf8 == nullptr || utf8[0] == '\0') {
    return std::wstring();
  }
  int chars = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
  if (chars <= 1) {
    return std::wstring();
  }
  std::wstring out(static_cast<size_t>(chars - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &out[0], chars);
  return out;
}

struct ScopedComInit {
  HRESULT hr;
  bool should_uninit;

  ScopedComInit() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)), should_uninit(false) {
    if (hr == S_OK || hr == S_FALSE) {
      should_uninit = true;
    }
  }

  ~ScopedComInit() {
    if (should_uninit) {
      CoUninitialize();
    }
  }

  bool ok() const {
    return SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
  }
};

static bool suhbat_get_os_build(DWORD *major_out, DWORD *minor_out, DWORD *build_out) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr) {
    return false;
  }
  auto fn = reinterpret_cast<RtlGetVersionPtr>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (fn == nullptr) {
    return false;
  }
  RTL_OSVERSIONINFOW info;
  std::memset(&info, 0, sizeof(info));
  info.dwOSVersionInfoSize = sizeof(info);
  if (fn(&info) != 0) {
    return false;
  }
  if (major_out != nullptr) *major_out = info.dwMajorVersion;
  if (minor_out != nullptr) *minor_out = info.dwMinorVersion;
  if (build_out != nullptr) *build_out = info.dwBuildNumber;
  return true;
}

/* Minimum supported Windows 10 release: version 2004 (Build 19041). */
static bool suhbat_os_build_supported(void) {
  DWORD major = 0;
  DWORD minor = 0;
  DWORD build = 0;
  if (!suhbat_get_os_build(&major, &minor, &build)) {
    return false;
  }
  return major > 10 || (major == 10 && build >= 19041);
}

static bool suhbat_is_float_wave_format(const WAVEFORMATEX *wf) {
  if (wf == nullptr) {
    return false;
  }
  if (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT && wf->wBitsPerSample == 32) {
    return true;
  }
  if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22) {
    const auto *ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE *>(wf);
    return IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) && wf->wBitsPerSample == 32;
  }
  return false;
}

static bool suhbat_is_pcm16_wave_format(const WAVEFORMATEX *wf) {
  if (wf == nullptr) {
    return false;
  }
  if (wf->wFormatTag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 16) {
    return true;
  }
  if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22) {
    const auto *ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE *>(wf);
    return IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM) && wf->wBitsPerSample == 16;
  }
  return false;
}

static std::wstring suhbat_default_endpoint_id(IMMDeviceEnumerator *enumerator, EDataFlow flow) {
  if (enumerator == nullptr) {
    return std::wstring();
  }
  IMMDevice *device = nullptr;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, &device)) || device == nullptr) {
    return std::wstring();
  }
  LPWSTR raw_id = nullptr;
  std::wstring result;
  if (SUCCEEDED(device->GetId(&raw_id)) && raw_id != nullptr) {
    result.assign(raw_id);
    CoTaskMemFree(raw_id);
  }
  device->Release();
  return result;
}

static void suhbat_query_endpoint_mix_format(IMMDevice *device, uint32_t *sample_rate, uint16_t *channels) {
  if (sample_rate != nullptr) *sample_rate = 48000;
  if (channels != nullptr) *channels = 1;
  if (device == nullptr) {
    return;
  }
  IAudioClient *client = nullptr;
  if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void **>(&client))) ||
      client == nullptr) {
    return;
  }
  WAVEFORMATEX *mix = nullptr;
  if (SUCCEEDED(client->GetMixFormat(&mix)) && mix != nullptr) {
    if (sample_rate != nullptr) *sample_rate = mix->nSamplesPerSec;
    if (channels != nullptr) *channels = mix->nChannels;
    CoTaskMemFree(mix);
  }
  client->Release();
}

static std::string suhbat_endpoint_friendly_name(IMMDevice *device) {
  if (device == nullptr) {
    return "Unknown input";
  }
  IPropertyStore *props = nullptr;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &props)) || props == nullptr) {
    return "Unknown input";
  }
  PROPVARIANT var;
  PropVariantInit(&var);
  std::string name = "Unknown input";
  if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &var))) {
    if (var.vt == VT_LPWSTR && var.pwszVal != nullptr) {
      std::string converted = suhbat_wide_to_utf8(var.pwszVal);
      if (!converted.empty()) {
        name = converted;
      }
    }
  }
  PropVariantClear(&var);
  props->Release();
  return name;
}

/*
 * Reads Windows CapabilityAccessManager registry state for microphone access.
 * Checks:
 *  1. Group policy `HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy\LetAppsAccessMicrophone` (2 == ForceDeny)
 *  2. Machine-wide consent `HKLM\...\CapabilityAccessManager\ConsentStore\microphone\Value`
 *  3. Per-user unpackaged desktop consent `HKCU\...\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\Value`
 *  4. Per-user global consent `HKCU\...\CapabilityAccessManager\ConsentStore\microphone\Value`
 */
static suhbat_win_permission_state suhbat_check_microphone_registry_consent(void) {
  DWORD policy_val = 0;
  DWORD policy_size = sizeof(policy_val);
  if (RegGetValueW(HKEY_LOCAL_MACHINE,
                   L"SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy",
                   L"LetAppsAccessMicrophone",
                   RRF_RT_REG_DWORD,
                   nullptr,
                   &policy_val,
                   &policy_size) == ERROR_SUCCESS) {
    if (policy_val == 2) {
      return SUHBAT_WIN_PERMISSION_DENIED;
    }
  }

  const wchar_t *subkeys[] = {
      L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged",
      L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone",
  };

  for (const wchar_t *subkey : subkeys) {
    wchar_t buffer[64] = {0};
    DWORD byte_len = sizeof(buffer);
    if (RegGetValueW(HKEY_CURRENT_USER,
                     subkey,
                     L"Value",
                     RRF_RT_REG_SZ,
                     nullptr,
                     buffer,
                     &byte_len) == ERROR_SUCCESS) {
      if (_wcsicmp(buffer, L"Deny") == 0) {
        return SUHBAT_WIN_PERMISSION_DENIED;
      }
      if (_wcsicmp(buffer, L"Allow") == 0) {
        return SUHBAT_WIN_PERMISSION_GRANTED;
      }
      if (_wcsicmp(buffer, L"Prompt") == 0) {
        return SUHBAT_WIN_PERMISSION_UNKNOWN;
      }
    }
  }

  wchar_t hklm_buffer[64] = {0};
  DWORD hklm_len = sizeof(hklm_buffer);
  if (RegGetValueW(HKEY_LOCAL_MACHINE,
                   L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone",
                   L"Value",
                   RRF_RT_REG_SZ,
                   nullptr,
                   hklm_buffer,
                   &hklm_len) == ERROR_SUCCESS) {
    if (_wcsicmp(hklm_buffer, L"Deny") == 0) {
      return SUHBAT_WIN_PERMISSION_DENIED;
    }
  }

  return SUHBAT_WIN_PERMISSION_GRANTED;
}

class SuhbatEndpointObserver final : public IMMNotificationClient {
 public:
  SuhbatEndpointObserver(std::wstring bound_endpoint_id, EDataFlow bound_flow, bool follows_default,
                         std::atomic<bool> *device_lost_flag)
      : ref_count_(1),
        bound_endpoint_id_(std::move(bound_endpoint_id)),
        bound_flow_(bound_flow),
        follows_default_(follows_default),
        device_lost_flag_(device_lost_flag) {}

  ULONG STDMETHODCALLTYPE AddRef() override {
    return InterlockedIncrement(&ref_count_);
  }

  ULONG STDMETHODCALLTYPE Release() override {
    ULONG count = InterlockedDecrement(&ref_count_);
    if (count == 0) {
      delete this;
    }
    return count;
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, VOID **ppvObject) override {
    if (ppvObject == nullptr) {
      return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *ppvObject = static_cast<IMMNotificationClient *>(this);
      AddRef();
      return S_OK;
    }
    *ppvObject = nullptr;
    return E_NOINTERFACE;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR pwstrDeviceId, DWORD dwNewState) override {
    if (pwstrDeviceId != nullptr && bound_endpoint_id_ == pwstrDeviceId &&
        dwNewState != DEVICE_STATE_ACTIVE && device_lost_flag_ != nullptr) {
      device_lost_flag_->store(true, std::memory_order_release);
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override {
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR pwstrDeviceId) override {
    if (pwstrDeviceId != nullptr && bound_endpoint_id_ == pwstrDeviceId &&
        device_lost_flag_ != nullptr) {
      device_lost_flag_->store(true, std::memory_order_release);
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role,
                                                   LPCWSTR pwstrDefaultDeviceId) override {
    /* Never silently swap devices mid-recording: if the stream was bound to the default endpoint
     * and the OS default changes, flag device loss immediately so the coordinator records an
     * explicit fault/discontinuity instead of mixing two physical microphones in one track. */
    if (follows_default_ && flow == bound_flow_ && role == eConsole && device_lost_flag_ != nullptr) {
      if (pwstrDefaultDeviceId == nullptr || bound_endpoint_id_ != pwstrDefaultDeviceId) {
        device_lost_flag_->store(true, std::memory_order_release);
      }
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override {
    return S_OK;
  }

 private:
  LONG ref_count_;
  std::wstring bound_endpoint_id_;
  EDataFlow bound_flow_;
  bool follows_default_;
  std::atomic<bool> *device_lost_flag_;
};

struct suhbat_win_stream {
  suhbat_win_source_kind kind;
  uint32_t actual_sample_rate_hz;
  uint16_t actual_channels;
  std::wstring device_uid;
  bool follows_default;
  void *user_data;
  suhbat_win_block_cb on_block;
  suhbat_win_overflow_cb on_overflow;
  suhbat_win_state_cb on_state;

  std::atomic<bool> stop_requested{false};
  std::atomic<bool> paused{false};
  std::atomic<bool> discontinuity{false};
  std::atomic<bool> device_lost{false};

  HANDLE stop_event{nullptr};
  HANDLE ready_event{nullptr};
  HANDLE worker_thread{nullptr};
  HRESULT start_hr{S_OK};
  char start_error[512]{0};
};

static void suhbat_emit_state(suhbat_win_stream *stream, suhbat_win_stream_state state, const char *detail) {
  if (stream != nullptr && stream->on_state != nullptr) {
    stream->on_state(stream->user_data, state, detail == nullptr ? "" : detail);
  }
}

static void suhbat_convert_to_i16(const BYTE *packet_data, UINT32 num_frames, UINT16 channels,
                                  bool is_float32, DWORD flags, std::vector<int16_t> *scratch) {
  const size_t total_samples = static_cast<size_t>(num_frames) * static_cast<size_t>(channels);
  if (scratch->size() < total_samples) {
    scratch->resize(total_samples);
  }
  if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || packet_data == nullptr) {
    std::memset(scratch->data(), 0, total_samples * sizeof(int16_t));
    return;
  }
  if (is_float32) {
    const auto *src = reinterpret_cast<const float *>(packet_data);
    int16_t *dst = scratch->data();
    for (size_t i = 0; i < total_samples; ++i) {
      float sample = src[i];
      if (sample > 1.0f) sample = 1.0f;
      if (sample < -1.0f) sample = -1.0f;
      dst[i] = static_cast<int16_t>(std::lrintf(sample * 32767.0f));
    }
  } else {
    std::memcpy(scratch->data(), packet_data, total_samples * sizeof(int16_t));
  }
}

static DWORD WINAPI suhbat_capture_worker_proc(LPVOID param) {
  auto *stream = static_cast<suhbat_win_stream *>(param);
  ScopedComInit com;
  if (!com.ok()) {
    stream->start_hr = com.hr;
    suhbat_win_write_text("CoInitializeEx failed on WASAPI capture thread", stream->start_error,
                          sizeof(stream->start_error));
    SetEvent(stream->ready_event);
    return 1;
  }

  DWORD mmcss_task_index = 0;
  HANDLE mmcss_handle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &mmcss_task_index);

  IMMDeviceEnumerator *enumerator = nullptr;
  IMMDevice *device = nullptr;
  IAudioClient *audio_client = nullptr;
  IAudioCaptureClient *capture_client = nullptr;
  WAVEFORMATEX *mix_format = nullptr;
  HANDLE sample_event = nullptr;
  SuhbatEndpointObserver *observer = nullptr;

  auto cleanup = [&]() {
    if (audio_client != nullptr) {
      audio_client->Stop();
    }
    if (enumerator != nullptr && observer != nullptr) {
      enumerator->UnregisterEndpointNotificationCallback(observer);
    }
    if (observer != nullptr) {
      observer->Release();
      observer = nullptr;
    }
    if (sample_event != nullptr) {
      CloseHandle(sample_event);
      sample_event = nullptr;
    }
    if (mix_format != nullptr) {
      CoTaskMemFree(mix_format);
      mix_format = nullptr;
    }
    if (capture_client != nullptr) {
      capture_client->Release();
      capture_client = nullptr;
    }
    if (audio_client != nullptr) {
      audio_client->Release();
      audio_client = nullptr;
    }
    if (device != nullptr) {
      device->Release();
      device = nullptr;
    }
    if (enumerator != nullptr) {
      enumerator->Release();
      enumerator = nullptr;
    }
    if (mmcss_handle != nullptr) {
      AvRevertMmThreadCharacteristics(mmcss_handle);
      mmcss_handle = nullptr;
    }
  };

  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void **>(&enumerator));
  if (FAILED(hr) || enumerator == nullptr) {
    stream->start_hr = FAILED(hr) ? hr : E_FAIL;
    suhbat_win_write_text("MMDeviceEnumerator creation failed", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  const EDataFlow data_flow =
      (stream->kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) ? eRender : eCapture;
  if (!stream->device_uid.empty() && stream->kind == SUHBAT_WIN_SOURCE_MICROPHONE) {
    hr = enumerator->GetDevice(stream->device_uid.c_str(), &device);
  } else {
    hr = enumerator->GetDefaultAudioEndpoint(data_flow, eConsole, &device);
  }
  if (FAILED(hr) || device == nullptr) {
    stream->start_hr = FAILED(hr) ? hr : E_NOTFOUND;
    suhbat_win_write_text("requested WASAPI audio endpoint is unavailable", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  DWORD endpoint_state = 0;
  if (FAILED(device->GetState(&endpoint_state)) || endpoint_state != DEVICE_STATE_ACTIVE) {
    stream->start_hr = E_NOTFOUND;
    suhbat_win_write_text("selected WASAPI audio endpoint is not active", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  LPWSTR raw_endpoint_id = nullptr;
  std::wstring bound_id;
  if (SUCCEEDED(device->GetId(&raw_endpoint_id)) && raw_endpoint_id != nullptr) {
    bound_id.assign(raw_endpoint_id);
    CoTaskMemFree(raw_endpoint_id);
  }

  observer = new SuhbatEndpointObserver(bound_id, data_flow, stream->follows_default,
                                        &stream->device_lost);
  enumerator->RegisterEndpointNotificationCallback(observer);

  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                        reinterpret_cast<void **>(&audio_client));
  if (FAILED(hr) || audio_client == nullptr) {
    stream->start_hr = FAILED(hr) ? hr : E_FAIL;
    suhbat_win_write_text("IAudioClient activation failed", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  hr = audio_client->GetMixFormat(&mix_format);
  if (FAILED(hr) || mix_format == nullptr) {
    stream->start_hr = FAILED(hr) ? hr : E_FAIL;
    suhbat_win_write_text("IAudioClient::GetMixFormat failed", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  const bool is_float32 = suhbat_is_float_wave_format(mix_format);
  const bool is_pcm16 = suhbat_is_pcm16_wave_format(mix_format);
  if (!is_float32 && !is_pcm16) {
    stream->start_hr = AUDCLNT_E_UNSUPPORTED_FORMAT;
    suhbat_win_write_text("WASAPI endpoint mix format is neither IEEE float32 nor PCM int16",
                          stream->start_error, sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  stream->actual_sample_rate_hz = mix_format->nSamplesPerSec;
  stream->actual_channels = mix_format->nChannels;

  sample_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (sample_event == nullptr) {
    stream->start_hr = HRESULT_FROM_WIN32(GetLastError());
    suhbat_win_write_text("failed to create WASAPI sample event", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  DWORD stream_flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  if (stream->kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) {
    stream_flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
  }

  /* 20 ms shared-mode buffer duration (in 100-ns units). */
  const REFERENCE_TIME buffer_duration = 200000;
  hr = audio_client->Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags, buffer_duration, 0,
                                mix_format, nullptr);
  if (FAILED(hr)) {
    stream->start_hr = hr;
    std::snprintf(stream->start_error, sizeof(stream->start_error),
                  "IAudioClient::Initialize failed (HRESULT 0x%08lx)",
                  static_cast<unsigned long>(hr));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  hr = audio_client->SetEventHandle(sample_event);
  if (FAILED(hr)) {
    stream->start_hr = hr;
    suhbat_win_write_text("IAudioClient::SetEventHandle failed", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  hr = audio_client->GetService(__uuidof(IAudioCaptureClient),
                                reinterpret_cast<void **>(&capture_client));
  if (FAILED(hr) || capture_client == nullptr) {
    stream->start_hr = FAILED(hr) ? hr : E_FAIL;
    suhbat_win_write_text("IAudioClient::GetService(IAudioCaptureClient) failed",
                          stream->start_error, sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  hr = audio_client->Start();
  if (FAILED(hr)) {
    stream->start_hr = hr;
    suhbat_win_write_text("IAudioClient::Start failed", stream->start_error,
                          sizeof(stream->start_error));
    cleanup();
    SetEvent(stream->ready_event);
    return 1;
  }

  stream->start_hr = S_OK;
  suhbat_emit_state(stream, SUHBAT_WIN_STREAM_RUNNING, "");
  SetEvent(stream->ready_event);

  std::vector<int16_t> scratch(static_cast<size_t>(stream->actual_sample_rate_hz / 10) *
                               static_cast<size_t>(stream->actual_channels));
  const UINT32 silent_keepalive_frames = stream->actual_sample_rate_hz / 50; /* 20 ms */
  HANDLE wait_handles[2] = {stream->stop_event, sample_event};

  while (!stream->stop_requested.load(std::memory_order_acquire)) {
    if (stream->device_lost.load(std::memory_order_acquire)) {
      suhbat_emit_state(stream, SUHBAT_WIN_STREAM_FAILED,
                        "WASAPI endpoint was disconnected or default device changed mid-capture");
      break;
    }

    const DWORD wait_rc = WaitForMultipleObjects(2, wait_handles, FALSE, 20);
    if (wait_rc == WAIT_OBJECT_0) {
      break;
    }

    if (stream->device_lost.load(std::memory_order_acquire)) {
      suhbat_emit_state(stream, SUHBAT_WIN_STREAM_FAILED,
                        "WASAPI endpoint was disconnected or default device changed mid-capture");
      break;
    }

    UINT32 packet_length = 0;
    hr = capture_client->GetNextPacketSize(&packet_length);
    if (FAILED(hr)) {
      suhbat_emit_state(stream, SUHBAT_WIN_STREAM_FAILED,
                        "IAudioCaptureClient::GetNextPacketSize failed (device invalidated)");
      break;
    }

    /* When WASAPI loopback is capturing a silent render endpoint, Windows may not signal
     * `sample_event` until an application plays audio. Emit a 20 ms silent frame block on timeout
     * so loopback stays continuous on the canonical timeline. */
    if (packet_length == 0 && wait_rc == WAIT_TIMEOUT &&
        stream->kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO &&
        !stream->paused.load(std::memory_order_acquire)) {
      const size_t total_silent =
          static_cast<size_t>(silent_keepalive_frames) * static_cast<size_t>(stream->actual_channels);
      if (scratch.size() < total_silent) {
        scratch.resize(total_silent);
      }
      std::memset(scratch.data(), 0, total_silent * sizeof(int16_t));
      const uint64_t host_time = suhbat_win_host_time_ns();
      const int disc = stream->discontinuity.exchange(false, std::memory_order_acq_rel) ? 1 : 0;
      if (stream->on_block != nullptr) {
        if (!stream->on_block(stream->user_data, scratch.data(), silent_keepalive_frames,
                              host_time, disc)) {
          stream->stop_requested.store(true, std::memory_order_release);
          break;
        }
      }
      continue;
    }

    while (packet_length > 0) {
      BYTE *data = nullptr;
      UINT32 frames_available = 0;
      DWORD flags = 0;
      UINT64 device_position = 0;
      UINT64 qpc_position = 0;

      hr = capture_client->GetBuffer(&data, &frames_available, &flags, &device_position,
                                     &qpc_position);
      if (FAILED(hr)) {
        suhbat_emit_state(stream, SUHBAT_WIN_STREAM_FAILED,
                          "IAudioCaptureClient::GetBuffer failed");
        stream->stop_requested.store(true, std::memory_order_release);
        break;
      }

      if (frames_available > 0 && !stream->paused.load(std::memory_order_acquire)) {
        suhbat_convert_to_i16(data, frames_available, stream->actual_channels, is_float32, flags,
                              &scratch);
        const uint64_t host_time =
            (qpc_position > 0 && (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0)
                ? (qpc_position * 100ull)
                : suhbat_win_host_time_ns();
        int disc = stream->discontinuity.exchange(false, std::memory_order_acq_rel) ? 1 : 0;
        if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
          disc = 1;
          if (stream->on_overflow != nullptr) {
            stream->on_overflow(stream->user_data, frames_available);
          }
        }
        if (stream->on_block != nullptr) {
          if (!stream->on_block(stream->user_data, scratch.data(), frames_available, host_time,
                                disc)) {
            capture_client->ReleaseBuffer(frames_available);
            stream->stop_requested.store(true, std::memory_order_release);
            break;
          }
        }
      }

      capture_client->ReleaseBuffer(frames_available);
      hr = capture_client->GetNextPacketSize(&packet_length);
      if (FAILED(hr)) {
        suhbat_emit_state(stream, SUHBAT_WIN_STREAM_FAILED,
                          "IAudioCaptureClient::GetNextPacketSize failed after ReleaseBuffer");
        stream->stop_requested.store(true, std::memory_order_release);
        break;
      }
    }
  }

  cleanup();
  if (!stream->device_lost.load(std::memory_order_acquire)) {
    suhbat_emit_state(stream, SUHBAT_WIN_STREAM_ENDED, "");
  }
  return 0;
}

extern "C" {

int suhbat_win_backend_available(void) {
  if (!suhbat_os_build_supported()) {
    return 0;
  }
  ScopedComInit com;
  if (!com.ok()) {
    return 0;
  }
  IMMDeviceEnumerator *enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void **>(&enumerator));
  if (FAILED(hr) || enumerator == nullptr) {
    return 0;
  }
  enumerator->Release();
  return 1;
}

int suhbat_win_system_audio_available(void) {
  if (!suhbat_os_build_supported()) {
    return 0;
  }
  ScopedComInit com;
  if (!com.ok()) {
    return 0;
  }
  IMMDeviceEnumerator *enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void **>(&enumerator))) ||
      enumerator == nullptr) {
    return 0;
  }
  IMMDevice *render_device = nullptr;
  HRESULT hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &render_device);
  if (SUCCEEDED(hr) && render_device != nullptr) {
    render_device->Release();
    enumerator->Release();
    return 1;
  }
  enumerator->Release();
  return 0;
}

void suhbat_win_os_version(char *out, size_t out_len) {
  DWORD major = 0;
  DWORD minor = 0;
  DWORD build = 0;
  if (!suhbat_get_os_build(&major, &minor, &build)) {
    suhbat_win_write_text("Windows (unknown build)", out, out_len);
    return;
  }
  char formatted[64] = {0};
  const char *family = (major == 10 && build >= 22000) ? "Windows 11" : "Windows 10";
  std::snprintf(formatted, sizeof(formatted), "%s (%lu.%lu.%lu)", family,
                static_cast<unsigned long>(major), static_cast<unsigned long>(minor),
                static_cast<unsigned long>(build));
  suhbat_win_write_text(formatted, out, out_len);
}

suhbat_win_permission_state suhbat_win_permission_state_for(suhbat_win_source_kind kind) {
  ScopedComInit com;
  if (!com.ok()) {
    return SUHBAT_WIN_PERMISSION_DEVICE_UNAVAILABLE;
  }
  IMMDeviceEnumerator *enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void **>(&enumerator))) ||
      enumerator == nullptr) {
    return SUHBAT_WIN_PERMISSION_DEVICE_UNAVAILABLE;
  }

  if (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) {
    IMMDevice *render_endpoint = nullptr;
    HRESULT hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &render_endpoint);
    if (FAILED(hr) || render_endpoint == nullptr) {
      enumerator->Release();
      return SUHBAT_WIN_PERMISSION_DEVICE_UNAVAILABLE;
    }
    render_endpoint->Release();
    enumerator->Release();
    return SUHBAT_WIN_PERMISSION_GRANTED;
  }

  const suhbat_win_permission_state consent = suhbat_check_microphone_registry_consent();
  if (consent == SUHBAT_WIN_PERMISSION_DENIED || consent == SUHBAT_WIN_PERMISSION_UNKNOWN) {
    enumerator->Release();
    return consent;
  }

  IMMDeviceCollection *collection = nullptr;
  UINT count = 0;
  if (SUCCEEDED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection)) &&
      collection != nullptr) {
    collection->GetCount(&count);
    collection->Release();
  }
  enumerator->Release();
  if (count == 0) {
    return SUHBAT_WIN_PERMISSION_DEVICE_UNAVAILABLE;
  }
  return SUHBAT_WIN_PERMISSION_GRANTED;
}

suhbat_win_permission_state suhbat_win_request_permission(suhbat_win_source_kind kind) {
  return suhbat_win_permission_state_for(kind);
}

size_t suhbat_win_device_count(suhbat_win_source_kind kind) {
  if (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) {
    return 0;
  }
  ScopedComInit com;
  if (!com.ok()) {
    return 0;
  }
  IMMDeviceEnumerator *enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void **>(&enumerator))) ||
      enumerator == nullptr) {
    return 0;
  }
  IMMDeviceCollection *collection = nullptr;
  UINT count = 0;
  if (SUCCEEDED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection)) &&
      collection != nullptr) {
    collection->GetCount(&count);
    collection->Release();
  }
  enumerator->Release();
  return static_cast<size_t>(count);
}

int suhbat_win_device_at(suhbat_win_source_kind kind, size_t index, suhbat_win_device_info *out) {
  if (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO || out == nullptr) {
    return -1;
  }
  std::memset(out, 0, sizeof(*out));
  ScopedComInit com;
  if (!com.ok()) {
    return -1;
  }
  IMMDeviceEnumerator *enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void **>(&enumerator))) ||
      enumerator == nullptr) {
    return -1;
  }
  const std::wstring default_id = suhbat_default_endpoint_id(enumerator, eCapture);
  IMMDeviceCollection *collection = nullptr;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection)) ||
      collection == nullptr) {
    enumerator->Release();
    return -1;
  }
  UINT count = 0;
  collection->GetCount(&count);
  if (index >= static_cast<size_t>(count)) {
    collection->Release();
    enumerator->Release();
    return -1;
  }
  IMMDevice *device = nullptr;
  if (FAILED(collection->Item(static_cast<UINT>(index), &device)) || device == nullptr) {
    collection->Release();
    enumerator->Release();
    return -1;
  }
  LPWSTR raw_id = nullptr;
  std::wstring id_wide;
  if (SUCCEEDED(device->GetId(&raw_id)) && raw_id != nullptr) {
    id_wide.assign(raw_id);
    CoTaskMemFree(raw_id);
  }
  const std::string uid = suhbat_wide_to_utf8(id_wide.c_str());
  const std::string name = suhbat_endpoint_friendly_name(device);
  uint32_t rate = 48000;
  uint16_t ch = 1;
  suhbat_query_endpoint_mix_format(device, &rate, &ch);

  suhbat_win_write_text(uid.c_str(), out->uid, sizeof(out->uid));
  suhbat_win_write_text(name.c_str(), out->name, sizeof(out->name));
  out->is_default = (!id_wide.empty() && id_wide == default_id) ? 1 : 0;
  out->is_available = 1;
  out->sample_rate_hz = rate;
  out->channels = ch;

  device->Release();
  collection->Release();
  enumerator->Release();
  return 0;
}

void suhbat_win_device_actual_format(suhbat_win_source_kind kind, const char *device_uid,
                                     uint32_t *sample_rate, uint16_t *channels) {
  if (sample_rate != nullptr) *sample_rate = 48000;
  if (channels != nullptr) *channels = (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) ? 2 : 1;
  ScopedComInit com;
  if (!com.ok()) {
    return;
  }
  IMMDeviceEnumerator *enumerator = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void **>(&enumerator))) ||
      enumerator == nullptr) {
    return;
  }
  IMMDevice *device = nullptr;
  if (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) {
    enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  } else if (device_uid != nullptr && device_uid[0] != '\0') {
    const std::wstring wide_uid = suhbat_utf8_to_wide(device_uid);
    enumerator->GetDevice(wide_uid.c_str(), &device);
  } else {
    enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
  }
  if (device != nullptr) {
    suhbat_query_endpoint_mix_format(device, sample_rate, channels);
    device->Release();
  }
  enumerator->Release();
}

suhbat_win_stream *suhbat_win_stream_start(const suhbat_win_stream_config *config, char *err,
                                           size_t err_len) {
  if (config == nullptr) {
    suhbat_win_write_text("null stream config", err, err_len);
    return nullptr;
  }
  auto *stream = new suhbat_win_stream();
  stream->kind = config->kind;
  stream->actual_sample_rate_hz = config->sample_rate_hz > 0 ? config->sample_rate_hz : 48000;
  stream->actual_channels = config->channels > 0 ? config->channels : 1;
  stream->device_uid = suhbat_utf8_to_wide(config->device_uid);
  stream->follows_default = stream->device_uid.empty();
  stream->user_data = config->user_data;
  stream->on_block = config->on_block;
  stream->on_overflow = config->on_overflow;
  stream->on_state = config->on_state;

  stream->stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  stream->ready_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (stream->stop_event == nullptr || stream->ready_event == nullptr) {
    suhbat_win_write_text("failed to create stream synchronization events", err, err_len);
    if (stream->stop_event != nullptr) CloseHandle(stream->stop_event);
    if (stream->ready_event != nullptr) CloseHandle(stream->ready_event);
    delete stream;
    return nullptr;
  }

  suhbat_emit_state(stream, SUHBAT_WIN_STREAM_STARTING, "");
  stream->worker_thread = CreateThread(nullptr, 0, suhbat_capture_worker_proc, stream, 0, nullptr);
  if (stream->worker_thread == nullptr) {
    suhbat_win_write_text("failed to spawn WASAPI capture worker thread", err, err_len);
    CloseHandle(stream->stop_event);
    CloseHandle(stream->ready_event);
    delete stream;
    return nullptr;
  }

  WaitForSingleObject(stream->ready_event, 5000);
  if (FAILED(stream->start_hr)) {
    suhbat_win_write_text(
        stream->start_error[0] != '\0' ? stream->start_error : "WASAPI stream failed to start", err,
        err_len);
    WaitForSingleObject(stream->worker_thread, 2000);
    CloseHandle(stream->worker_thread);
    CloseHandle(stream->stop_event);
    CloseHandle(stream->ready_event);
    delete stream;
    return nullptr;
  }

  return stream;
}

int suhbat_win_stream_pause(suhbat_win_stream *stream, char *err, size_t err_len) {
  if (stream == nullptr) {
    suhbat_win_write_text("stream is null", err, err_len);
    return -1;
  }
  stream->paused.store(true, std::memory_order_release);
  suhbat_emit_state(stream, SUHBAT_WIN_STREAM_PAUSED, "");
  return 0;
}

int suhbat_win_stream_resume(suhbat_win_stream *stream, char *err, size_t err_len) {
  if (stream == nullptr) {
    suhbat_win_write_text("stream is null", err, err_len);
    return -1;
  }
  stream->discontinuity.store(true, std::memory_order_release);
  stream->paused.store(false, std::memory_order_release);
  suhbat_emit_state(stream, SUHBAT_WIN_STREAM_RUNNING, "");
  return 0;
}

void suhbat_win_stream_stop(suhbat_win_stream *stream) {
  if (stream == nullptr) {
    return;
  }
  stream->stop_requested.store(true, std::memory_order_release);
  if (stream->stop_event != nullptr) {
    SetEvent(stream->stop_event);
  }
  if (stream->worker_thread != nullptr) {
    WaitForSingleObject(stream->worker_thread, 5000);
    CloseHandle(stream->worker_thread);
    stream->worker_thread = nullptr;
  }
  if (stream->stop_event != nullptr) {
    CloseHandle(stream->stop_event);
    stream->stop_event = nullptr;
  }
  if (stream->ready_event != nullptr) {
    CloseHandle(stream->ready_event);
    stream->ready_event = nullptr;
  }
  delete stream;
}

const char *suhbat_win_settings_url(suhbat_win_source_kind kind) {
  if (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO) {
    return "ms-settings:sound";
  }
  return "ms-settings:privacy-microphone";
}

int suhbat_win_open_settings(suhbat_win_source_kind kind, char *err, size_t err_len) {
  const wchar_t *uri = (kind == SUHBAT_WIN_SOURCE_SYSTEM_AUDIO)
                           ? L"ms-settings:sound"
                           : L"ms-settings:privacy-microphone";
  HINSTANCE res = ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
  if (reinterpret_cast<INT_PTR>(res) <= 32) {
    suhbat_win_write_text("ShellExecuteW failed to open ms-settings URI", err, err_len);
    return -1;
  }
  return 0;
}

} /* extern "C" */

#endif /* _WIN32 */
