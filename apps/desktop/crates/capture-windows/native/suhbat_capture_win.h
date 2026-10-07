/*
 * C ABI between Rust (`crates/capture-windows`) and the Windows WASAPI capture implementation.
 *
 * Design rules:
 *  - Audio is delivered as signed 16-bit interleaved PCM. Float32 -> int16 conversion happens on the
 *    WASAPI capture thread (a cheap linear pass into a reused scratch buffer) and nothing else does:
 *    no file IO, no hashing, no JSON, no blocking waits (docs/recording.md §3).
 *  - `host_time_ns` is derived from `QueryPerformanceCounter` / `QueryPerformanceFrequency` scaled to
 *    nanoseconds, i.e. the exact monotonic clock `recorder_core::clock::SystemClock` reads on Windows,
 *    so microphone, system-audio loopback, and the session origin share one epoch.
 *  - Every function returning `int` yields 0 on success and a negative error code with a message written
 *    into the caller-provided buffer. No C++ exceptions cross the C ABI boundary.
 */
#ifndef SUHBAT_CAPTURE_WIN_H
#define SUHBAT_CAPTURE_WIN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  SUHBAT_WIN_SOURCE_MICROPHONE = 0,
  SUHBAT_WIN_SOURCE_SYSTEM_AUDIO = 1,
} suhbat_win_source_kind;

/* Mirrors recorder_core::platform::PermissionState. */
typedef enum {
  SUHBAT_WIN_PERMISSION_UNKNOWN = 0,
  SUHBAT_WIN_PERMISSION_GRANTED = 1,
  SUHBAT_WIN_PERMISSION_DENIED = 2,
  SUHBAT_WIN_PERMISSION_DEVICE_UNAVAILABLE = 3,
} suhbat_win_permission_state;

/* Mirrors recorder_core::capture::StreamState. */
typedef enum {
  SUHBAT_WIN_STREAM_STARTING = 0,
  SUHBAT_WIN_STREAM_RUNNING = 1,
  SUHBAT_WIN_STREAM_PAUSED = 2,
  SUHBAT_WIN_STREAM_ENDED = 3,
  SUHBAT_WIN_STREAM_FAILED = 4,
} suhbat_win_stream_state;

/*
 * Called on the WASAPI capture thread with `frame_count` frames of interleaved int16 audio.
 * `host_time_ns` is the QueryPerformanceCounter nanosecond reading taken as early as possible in the
 * packet loop. Returning 0 from the callback means "the sink is closing, stop this stream".
 */
typedef int (*suhbat_win_block_cb)(void *user_data, const int16_t *samples, size_t frame_count,
                                   uint64_t host_time_ns, int discontinuity);

/* Called when the backend had to drop frames (device-side), before any Rust-side queue limits. */
typedef void (*suhbat_win_overflow_cb)(void *user_data, uint64_t dropped_frame_count);

typedef void (*suhbat_win_state_cb)(void *user_data, suhbat_win_stream_state state, const char *detail);

typedef struct {
  suhbat_win_source_kind kind;
  uint32_t sample_rate_hz;
  uint16_t channels;
  /* NULL means "the system default capture device". Ignored for system audio loopback. */
  const char *device_uid;
  void *user_data;
  suhbat_win_block_cb on_block;
  suhbat_win_overflow_cb on_overflow;
  suhbat_win_state_cb on_state;
} suhbat_win_stream_config;

typedef struct suhbat_win_stream suhbat_win_stream;

/* 1 when this build can capture on this machine, 0 otherwise (checks OS build >= 19041 and WASAPI
 * COM enumerator availability at runtime). */
int suhbat_win_backend_available(void);
/* 1 when WASAPI loopback system-audio capture is usable on this machine (Windows 10 build 19041+ and
 * an active render endpoint present). */
int suhbat_win_system_audio_available(void);

/* Copies a human-readable OS version (e.g. "Windows 10.0.22631") into `out`. */
void suhbat_win_os_version(char *out, size_t out_len);

suhbat_win_permission_state suhbat_win_permission_state_for(suhbat_win_source_kind kind);

/*
 * Check or request OS permission. On Windows desktop (Win32/unpackaged), microphone privacy is
 * governed by CapabilityAccessManager (`ConsentStore\microphone\NonPackaged`). Returns the resolved
 * permission state without spamming modal dialogs.
 */
suhbat_win_permission_state suhbat_win_request_permission(suhbat_win_source_kind kind);

/* Number of enumerable capture devices for a kind (system audio returns 0: it captures default render mix). */
size_t suhbat_win_device_count(suhbat_win_source_kind kind);

typedef struct {
  char uid[128];
  char name[160];
  int is_default;
  int is_available;
  uint32_t sample_rate_hz;
  uint16_t channels;
} suhbat_win_device_info;

/* 0 on success; -1 when `index` is out of range. */
int suhbat_win_device_at(suhbat_win_source_kind kind, size_t index, suhbat_win_device_info *out);

/* Mix format the WASAPI endpoint actually delivers (sample rate and channel count). */
void suhbat_win_device_actual_format(suhbat_win_source_kind kind, const char *device_uid,
                                     uint32_t *sample_rate, uint16_t *channels);

suhbat_win_stream *suhbat_win_stream_start(const suhbat_win_stream_config *config, char *err, size_t err_len);
int suhbat_win_stream_pause(suhbat_win_stream *stream, char *err, size_t err_len);
int suhbat_win_stream_resume(suhbat_win_stream *stream, char *err, size_t err_len);
/* Stops the capture thread, releases WASAPI COM interfaces, and frees the stream. Safe to call twice. */
void suhbat_win_stream_stop(suhbat_win_stream *stream);

/* Windows Settings deep links (`ms-settings:privacy-microphone` / `ms-settings:sound`). */
const char *suhbat_win_settings_url(suhbat_win_source_kind kind);
/* 0 when the Windows Settings URI was opened via ShellExecuteW; negative on failure. */
int suhbat_win_open_settings(suhbat_win_source_kind kind, char *err, size_t err_len);

#ifdef __cplusplus
}
#endif

#endif /* SUHBAT_CAPTURE_WIN_H */
