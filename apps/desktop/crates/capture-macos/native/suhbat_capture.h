/*
 * C ABI between Rust (`crates/capture-macos`) and the Objective-C capture implementation.
 *
 * Design rules:
 *  - Audio is delivered as signed 16-bit interleaved PCM. Float32 -> int16 conversion happens on the
 *    capture thread (a cheap linear pass) and nothing else does: no file IO, no hashing, no JSON, no
 *    allocation beyond the sample copy the callback needs (docs/recording.md §3).
 *  - `first_tick_ns` is `clock_gettime(CLOCK_MONOTONIC_RAW)`, i.e. exactly the clock
 *    `recorder_core::clock::SystemClock` reads, so both sources and the origin share one epoch. The
 *    acceptance harness measures the delta between the two on a real Mac (docs/mac-recorder-acceptance.md
 *    test B) because the two APIs must not be assumed identical.
 *  - Every function returning `int` yields 0 on success and a negative error code with a message written
 *    into the caller-provided buffer. No C++ exceptions, no Objective-C exceptions cross the boundary.
 */
#ifndef SUHBAT_CAPTURE_H
#define SUHBAT_CAPTURE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  SUHBAT_SOURCE_MICROPHONE = 0,
  SUHBAT_SOURCE_SYSTEM_AUDIO = 1,
} suhbat_source_kind;

/* Mirrors recorder_core::platform::PermissionState. */
typedef enum {
  SUHBAT_PERMISSION_UNKNOWN = 0,
  SUHBAT_PERMISSION_GRANTED = 1,
  SUHBAT_PERMISSION_DENIED = 2,
  SUHBAT_PERMISSION_DEVICE_UNAVAILABLE = 3,
} suhbat_permission_state;

/* Mirrors recorder_core::capture::StreamState. */
typedef enum {
  SUHBAT_STREAM_STARTING = 0,
  SUHBAT_STREAM_RUNNING = 1,
  SUHBAT_STREAM_PAUSED = 2,
  SUHBAT_STREAM_ENDED = 3,
  SUHBAT_STREAM_FAILED = 4,
} suhbat_stream_state;

/*
 * Called on the capture thread with `frame_count` frames of interleaved int16 audio. `host_time_ns` is
 * the CLOCK_MONOTONIC_RAW reading taken as early as possible in the callback. Returning 0 from the
 * callback means "the sink is closing, stop this stream".
 */
typedef int (*suhbat_block_cb)(void *user_data, const int16_t *samples, size_t frame_count,
                              uint64_t host_time_ns, int discontinuity);

/* Called when the backend had to drop frames (device-side), before any Rust-side queue limits. */
typedef void (*suhbat_overflow_cb)(void *user_data, uint64_t dropped_frame_count);

typedef void (*suhbat_state_cb)(void *user_data, suhbat_stream_state state, const char *detail);

typedef struct {
  suhbat_source_kind kind;
  uint32_t sample_rate_hz;
  uint16_t channels;
  /* NULL means "the system default input device". Ignored for system audio. */
  const char *device_uid;
  void *user_data;
  suhbat_block_cb on_block;
  suhbat_overflow_cb on_overflow;
  suhbat_state_cb on_state;
} suhbat_stream_config;

typedef struct suhbat_stream suhbat_stream;

/* 1 when this build can capture on this machine, 0 otherwise (never a guess: checks @available plus
 * class existence at runtime, and is 0 for non-macOS builds because nothing is compiled in). */
int suhbat_backend_available(void);
/* 1 when ScreenCaptureKit system-audio capture is usable here (macOS 13+ and the framework present). */
int suhbat_system_audio_available(void);

/* Copies a human-readable OS version (e.g. "25.0.0") into `out`. */
void suhbat_os_version(char *out, size_t out_len);

suhbat_permission_state suhbat_permission_state_for(suhbat_source_kind kind);

/*
 * Ask the OS for permission. Only prompts when the current state is UNKNOWN: a denied state is answered
 * by pointing at System Settings instead of re-asking (docs/recording.md §2 forbids dialog spam).
 * Returns the state after the request.
 */
suhbat_permission_state suhbat_request_permission(suhbat_source_kind kind);

/* Number of enumerable devices for a kind (system audio has none: it is the whole output mix). */
size_t suhbat_device_count(suhbat_source_kind kind);

typedef struct {
  char uid[128];
  char name[160];
  int is_default;
  int is_available;
  uint32_t sample_rate_hz;
  uint16_t channels;
} suhbat_device_info;

/* 0 on success; -1 when `index` is out of range. */
int suhbat_device_at(suhbat_source_kind kind, size_t index, suhbat_device_info *out);

/* Format the device actually delivers, which may differ from the request (no resampling in this phase). */
void suhbat_device_actual_format(suhbat_source_kind kind, const char *device_uid, uint32_t *sample_rate,
                                uint16_t *channels);

suhbat_stream *suhbat_stream_start(const suhbat_stream_config *config, char *err, size_t err_len);
int suhbat_stream_pause(suhbat_stream *stream, char *err, size_t err_len);
int suhbat_stream_resume(suhbat_stream *stream, char *err, size_t err_len);
/* Stops and frees the stream. Safe to call twice. */
void suhbat_stream_stop(suhbat_stream *stream);

/* Settings deep links, for the "Open System Settings" button. */
const char *suhbat_settings_url(suhbat_source_kind kind);
/* 0 when the pane was opened; negative when unsupported (the Rust layer then surfaces the URL only). */
int suhbat_open_settings(suhbat_source_kind kind, char *err, size_t err_len);

#ifdef __cplusplus
}
#endif

#endif /* SUHBAT_CAPTURE_H */
