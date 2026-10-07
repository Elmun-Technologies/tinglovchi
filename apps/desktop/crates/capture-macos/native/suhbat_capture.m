/*
 * SUHBAT macOS capture bridge (Phase 2).
 *
 * Two independent sources, deliberately never mixed into one canonical track:
 *   microphone   -> AVAudioEngine input-node tap
 *   system audio -> ScreenCaptureKit SCStream with `capturesAudio` (the output mix of the display)
 *
 * Why not `SCStreamConfiguration.capturesMicrophone`: that property requires macOS 15. Running the
 * microphone through AVFoundation keeps the floor at macOS 13.0 and keeps the two sources on genuinely
 * separate code paths, which is what docs/recording.md §5 requires.
 *
 * Realtime discipline: inside the tap and the SCK delegate the only work is float32 -> int16 conversion
 * and one call into Rust, which pushes into a bounded queue and returns. No file IO, no hashing, no
 * JSON, no waiting, no re-asking permissions, and no allocation in the common path (a reused scratch
 * buffer). Backpressure, chunk boundaries and drop accounting belong to the recorder core.
 *
 * VALIDATION STATUS: this file has never been compiled — the build environment has no Apple SDK. It is
 * written against public API signatures and every availability-sensitive call is guarded at runtime, but
 * the first real-Mac build may need corrections. See docs/mac-recorder-acceptance.md §"Build gates",
 * especially the two items that must be measured rather than assumed:
 *   * the exact sample format ScreenCaptureKit delivers for audio output (assumed interleaved float32
 *     because `SCStreamConfiguration` is configured with `sampleRate`/`channelCount`);
 *   * the offset between `CLOCK_MONOTONIC_RAW` here and the Rust clock reader (test B).
 */

#import "suhbat_capture.h"

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CoreAudioTypes.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CMFormatDescription.h>
#import <CoreMedia/CMSampleBuffer.h>
#import <Foundation/Foundation.h>
#import <time.h>

#if __has_include(<ScreenCaptureKit/ScreenCaptureKit.h>)
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#define SUHBAT_HAVE_SCREEN_CAPTURE_KIT 1
#else
#define SUHBAT_HAVE_SCREEN_CAPTURE_KIT 0
#endif

static uint64_t suhbat_host_time_ns(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) != 0) {
    return 0;
  }
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static void suhbat_write_text(const char *src, char *out, size_t out_len) {
  if (out == NULL || out_len == 0) {
    return;
  }
  if (src == NULL) {
    out[0] = '\0';
    return;
  }
  strncpy(out, src, out_len - 1);
  out[out_len - 1] = '\0';
}

static void suhbat_write_ns(NSString *message, char *out, size_t out_len) {
  suhbat_write_text(message == nil ? "" : message.UTF8String, out, out_len);
}

@interface SuhbatStream : NSObject {
@public
  /* Per-stream callbacks: the microphone and the system-audio stream each have their own sink and user
   * data, so a shared global would mix the two sources. */
  suhbat_block_cb onBlock;
  suhbat_overflow_cb onOverflow;
  suhbat_state_cb onState;
  void *userData;
}
@property(nonatomic, assign) suhbat_source_kind kind;
@property(nonatomic, assign) uint32_t sampleRate;
@property(nonatomic, assign) uint16_t channels;
@property(nonatomic, assign) volatile int stopped;
@property(nonatomic, assign) volatile int paused;
@property(nonatomic, assign) volatile int discontinuity;
@property(nonatomic, assign) volatile uint64_t droppedFrames;
@property(nonatomic, assign) int16_t *scratch;
@property(nonatomic, assign) size_t scratchCapacity;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) id delegate; /* retains the SCStream delegate below */
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
@property(nonatomic, strong) SCStream *stream;
#endif
@end

static void suhbat_report_dropped(SuhbatStream *stream, uint64_t frames) {
  stream.droppedFrames += frames;
  if (stream->onOverflow != NULL) {
    stream->onOverflow(stream->userData, frames);
  }
}

@implementation SuhbatStream

- (void)emitState:(suhbat_stream_state)state detail:(const char *)detail {
  if (self->onState != NULL) {
    self->onState(self->userData, state, detail == NULL ? "" : detail);
  }
}

- (int16_t *)scratchForFrames:(size_t)frames channels:(SInt32)channels {
  size_t needed = frames * (size_t)MAX(channels, 1);
  if (needed == 0) {
    return NULL;
  }
  if (needed > self.scratchCapacity) {
    free(self.scratch);
    self.scratch = (int16_t *)malloc(needed * sizeof(int16_t));
    self.scratchCapacity = self.scratch != NULL ? needed : 0;
    if (self.scratch == NULL) {
      suhbat_report_dropped(self, frames);
      return NULL;
    }
  }
  return self.scratch;
}

- (void)submit:(const float *)samples frames:(SInt32)frameCount channels:(SInt32)channelCount {
  if (self->onBlock == NULL || frameCount <= 0 || self.stopped || self.paused) {
    return;
  }
  SInt32 channels = channelCount > 0 ? channelCount : 1;
  int16_t *out = [self scratchForFrames:(size_t)frameCount channels:channels];
  if (out == NULL) {
    return;
  }
  size_t total = (size_t)frameCount * (size_t)channels;
  for (size_t i = 0; i < total; i++) {
    float value = samples[i];
    if (value > 1.0f) value = 1.0f;
    if (value < -1.0f) value = -1.0f;
    out[i] = (int16_t)lrintf(value * 32767.0f);
  }
  uint64_t host_time = suhbat_host_time_ns();
  int discontinuity = self.discontinuity ? 1 : 0;
  self.discontinuity = 0;
  if (!self->onBlock(self->userData, out, total / (size_t)channels, host_time, discontinuity)) {
    self.stopped = 1;
  }
}

- (void)teardown {
  self.stopped = 1;
  if (self.engine != nil) {
    [self.engine.inputNode removeTapOnBus:0];
    [self.engine stop];
    self.engine = nil;
  }
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  if (self.stream != nil) {
    [self.stream stopCaptureWithCompletionHandler:^(NSError *_Nullable stopError) { (void)stopError; }];
    self.stream = nil;
  }
#endif
  free(self.scratch);
  self.scratch = NULL;
  self.scratchCapacity = 0;
}

- (void)dealloc {
  [self teardown];
}

@end

/* ---------------------------------- microphone ---------------------------------- */

static BOOL suhbat_uid_is_current_default_input(NSString *uid) {
  if (uid.length == 0) {
    return YES;
  }
  AudioDeviceID deviceId = kAudioObjectUnknown;
  UInt32 size = sizeof(deviceId);
  AudioObjectPropertyAddress address = {kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &deviceId) != noErr) {
    return NO;
  }
  char actualUid[128] = {0};
  AudioObjectPropertyAddress uidAddress = {kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeInput,
                                          kAudioObjectPropertyElementMain};
  UInt32 propSize = sizeof(actualUid);
  if (AudioObjectGetPropertyData(deviceId, &uidAddress, 0, NULL, &propSize, actualUid) != noErr) {
    return NO;
  }
  return strncmp(actualUid, uid.UTF8String, sizeof(actualUid)) == 0;
}

static BOOL suhbat_set_default_input_device(NSString *uid, NSError **error) {
  AudioDeviceID target = kAudioObjectUnknown;
  UInt32 size = 0;
  AudioObjectPropertyAddress listAddress = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &listAddress, 0, NULL, &size) != noErr || size == 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"suhbat" code:-24
                             userInfo:@{NSLocalizedDescriptionKey : @"CoreAudio device list unavailable"}];
    }
    return NO;
  }
  size_t count = size / sizeof(AudioDeviceID);
  AudioDeviceID *devices = (AudioDeviceID *)calloc(count, sizeof(AudioDeviceID));
  if (devices == NULL) {
    return NO;
  }
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &listAddress, 0, NULL, &size, devices) == noErr) {
    for (size_t i = 0; i < count; i++) {
      char deviceUid[128] = {0};
      AudioObjectPropertyAddress uidAddress = {kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeInput,
                                              kAudioObjectPropertyElementMain};
      UInt32 propSize = sizeof(deviceUid);
      if (AudioObjectGetPropertyData(devices[i], &uidAddress, 0, NULL, &propSize, deviceUid) == noErr &&
          strncmp(deviceUid, uid.UTF8String, sizeof(deviceUid)) == 0) {
        target = devices[i];
        break;
      }
    }
  }
  free(devices);
  if (target == kAudioObjectUnknown) {
    if (error) {
      *error = [NSError errorWithDomain:@"suhbat" code:-25
                             userInfo:@{NSLocalizedDescriptionKey :
                                            @"the selected microphone is no longer present; no substitution is made"}];
    }
    return NO;
  }
  AudioObjectPropertyAddress setAddress = {kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain};
  OSStatus status = AudioObjectSetPropertyData(kAudioObjectSystemObject, &setAddress, 0, NULL, sizeof(target), &target);
  if (status != noErr) {
    if (error) {
      *error = [NSError errorWithDomain:@"suhbat" code:-26
                             userInfo:@{NSLocalizedDescriptionKey :
                                            @"macOS refused to change the default input device"}];
    }
    return NO;
  }
  return YES;
}

static BOOL suhbat_start_mic(SuhbatStream *stream, NSString *deviceUid, NSError **error) {
  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) {
    if (error) {
      *error = [NSError errorWithDomain:@"suhbat" code:-20
                             userInfo:@{NSLocalizedDescriptionKey : @"microphone permission is not granted"}];
    }
    return NO;
  }
  AVAudioEngine *engine = [[AVAudioEngine alloc] init];
  AVAudioInputNode *input = engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format == nil || format.sampleRate <= 0 || format.channelCount == 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"suhbat" code:-21
                             userInfo:@{NSLocalizedDescriptionKey : @"the input device reports no usable format"}];
    }
    return NO;
  }
  /* AVAudioEngine records the *system default* input device; there is no public API to point it at an
   * arbitrary device. When the caller chose one, the default is switched through the CoreAudio HAL first,
   * which is what the UI tells the user is happening, and the manifest records the uid that was selected. */
  if (deviceUid.length > 0 && !suhbat_uid_is_current_default_input(deviceUid)) {
    if (!suhbat_set_default_input_device(deviceUid, error)) {
      return NO;
    }
    /* The engine must be recreated after the default changes, otherwise it keeps the old format. */
    engine = [[AVAudioEngine alloc] init];
    input = engine.inputNode;
    format = [input outputFormatForBus:0];
    if (format == nil || format.sampleRate <= 0) {
      if (error) {
        *error = [NSError errorWithDomain:@"suhbat" code:-23
                               userInfo:@{NSLocalizedDescriptionKey : @"the selected input device reported no usable format"}];
      }
      return NO;
    }
  }
  stream.sampleRate = (uint32_t)lrint(format.sampleRate);
  stream.channels = (uint16_t)format.channelCount;

  __weak SuhbatStream *weakStream = stream;
  [input installTapOnBus:0 bufferSize:1024 format:format
                   block:^(AVAudioPCMBuffer *_Nonnull buffer, AVAudioTime *_Nonnull when) {
                     (void)when;
                     SuhbatStream *strong = weakStream;
                     if (strong == nil || buffer.floatChannelData == NULL) {
                       return;
                     }
                     SInt32 frames = (SInt32)buffer.frameLength;
                     SInt32 chans = (SInt32)buffer.format.channelCount;
                     if (chans <= 1) {
                       [strong submit:buffer.floatChannelData[0] frames:frames channels:1];
                       return;
                     }
                     float *interleaved = (float *)malloc((size_t)frames * (size_t)chans * sizeof(float));
                     if (interleaved == NULL) {
                       suhbat_report_dropped(strong, (uint64_t)frames);
                       return;
                     }
                     for (SInt32 frame = 0; frame < frames; frame++) {
                       for (SInt32 chan = 0; chan < chans; chan++) {
                         interleaved[(size_t)frame * (size_t)chans + (size_t)chan] = buffer.floatChannelData[chan][frame];
                       }
                     }
                     [strong submit:interleaved frames:frames channels:chans];
                     free(interleaved);
                   }];
  [engine prepare];
  NSError *startError = nil;
  if (![engine startAndReturnError:&startError]) {
    [input removeTapOnBus:0];
    if (error) {
      *error = startError ?: [NSError errorWithDomain:@"suhbat" code:-22
                                           userInfo:@{NSLocalizedDescriptionKey : @"AVAudioEngine failed to start"}];
    }
    return NO;
  }
  stream.engine = engine;
  [stream emitState:SUHBAT_STREAM_RUNNING detail:"microphone tap started"];
  return YES;
}

/* ---------------------------------- system audio ---------------------------------- */

#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
static void suhbat_deliver_sck(SuhbatStream *stream, CMSampleBufferRef sampleBuffer) {
  if (sampleBuffer == NULL || !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }
  CMFormatDescriptionRef description = CMSampleBufferGetFormatDescription(sampleBuffer);
  const AudioStreamBasicDescription *asbd =
      description != NULL ? CMAudioFormatDescriptionGetStreamBasicDescription(description) : NULL;
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sampleBuffer);
  if (block == NULL || asbd == NULL) {
    return;
  }
  size_t dataLength = 0;
  char *data = NULL;
  if (CMBlockBufferGetDataPointer(block, 0, NULL, &dataLength, &data) != kCMBlockBufferNoErr || data == NULL) {
    return;
  }
  UInt32 channelsPerFrame = asbd->mChannelsPerFrame > 0 ? asbd->mChannelsPerFrame : 2;
  CMItemCount numSamples = CMSampleBufferGetNumSamples(sampleBuffer);
  SInt32 frames = (SInt32)numSamples;
  if (frames <= 0) {
    UInt32 bytesPerSample = asbd->mBitsPerChannel > 0 ? (asbd->mBitsPerChannel / 8) : sizeof(float);
    UInt32 totalBytesPerFrame = channelsPerFrame * bytesPerSample;
    frames = totalBytesPerFrame > 0 ? (SInt32)(dataLength / totalBytesPerFrame) : 0;
  }
  if (frames <= 0) {
    return;
  }
  BOOL isFloat = asbd->mFormatID == kAudioFormatLinearPCM && (asbd->mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  if (isFloat) {
    size_t requiredBytes = (size_t)frames * (size_t)channelsPerFrame * sizeof(float);
    if (dataLength < requiredBytes) {
      suhbat_report_dropped(stream, (uint64_t)frames);
      return;
    }
    stream.channels = (uint16_t)channelsPerFrame;
    stream.sampleRate = (uint32_t)asbd->mSampleRate;
    BOOL isNonInterleaved = (asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0 && channelsPerFrame > 1;
    if (!isNonInterleaved) {
      [stream submit:(const float *)data frames:frames channels:(SInt32)channelsPerFrame];
      return;
    }
    float *interleaved = (float *)malloc(requiredBytes);
    if (interleaved == NULL) {
      suhbat_report_dropped(stream, (uint64_t)frames);
      return;
    }
    const float *planes = (const float *)data;
    for (SInt32 f = 0; f < frames; f++) {
      for (UInt32 ch = 0; ch < channelsPerFrame; ch++) {
        interleaved[(size_t)f * (size_t)channelsPerFrame + (size_t)ch] =
            planes[(size_t)ch * (size_t)frames + (size_t)f];
      }
    }
    [stream submit:interleaved frames:frames channels:(SInt32)channelsPerFrame];
    free(interleaved);
    return;
  }
  /* A non-float format would need its own path; refusing it is better than guessing a layout and writing
   * garbage into a chunk. The recorder core then reports the source as degraded. */
  suhbat_report_dropped(stream, (uint64_t)frames);
}

@interface SuhbatSckDelegate : NSObject <SCStreamDelegate, SCStreamOutput>
@property(nonatomic, weak) SuhbatStream *stream;
@end

@implementation SuhbatSckDelegate
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeAudio || self.stream == nil) {
    return;
  }
  suhbat_deliver_sck(self.stream, sampleBuffer);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  SuhbatStream *target = self.stream;
  if (target != nil) {
    target.stopped = 1;
    [target emitState:SUHBAT_STREAM_FAILED detail:error.localizedDescription.UTF8String];
  }
}
@end

/* One delegate per stream: keep it alive by hanging it on the stream object. */
static BOOL suhbat_attach_delegate(SCStream *stream, SuhbatStream *owner, NSError **error) {
  SuhbatSckDelegate *delegate = [[SuhbatSckDelegate alloc] init];
  delegate.stream = owner;
  owner.delegate = delegate; /* the SCStream API holds delegates weakly */
  return [stream addStreamOutput:delegate
                            type:SCStreamOutputTypeAudio
              sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0)
                           error:error];
}
#endif /* SUHBAT_HAVE_SCREEN_CAPTURE_KIT */

/* ---------------------------------- C ABI ---------------------------------- */

int suhbat_backend_available(void) {
  return 1;
}

int suhbat_system_audio_available(void) {
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  if (@available(macOS 13.0, *)) {
    return NSClassFromString(@"SCStream") != nil ? 1 : 0;
  }
  return 0;
#else
  return 0;
#endif
}

void suhbat_os_version(char *out, size_t out_len) {
  NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
  suhbat_write_ns([NSString stringWithFormat:@"%ld.%ld.%ld", (long)version.majorVersion, (long)version.minorVersion,
                                                   (long)version.patchVersion],
                  out, out_len);
}

suhbat_permission_state suhbat_permission_state_for(suhbat_source_kind kind) {
  if (kind == SUHBAT_SOURCE_MICROPHONE) {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
      case AVAuthorizationStatusAuthorized:
        return SUHBAT_PERMISSION_GRANTED;
      case AVAuthorizationStatusDenied:
      case AVAuthorizationStatusRestricted:
        return SUHBAT_PERMISSION_DENIED;
      case AVAuthorizationStatusNotDetermined:
      default:
        return SUHBAT_PERMISSION_UNKNOWN;
    }
  }
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  if (@available(macOS 11.0, *)) {
    /* CGPreflightScreenCaptureAccess tells us whether permission was granted; it does not distinguish
     * "never asked" from "refused", so the app treats the refused case as denied only after the user has
     * been asked once (see suhbat_request_permission). */
    if (CGPreflightScreenCaptureAccess()) {
      return SUHBAT_PERMISSION_GRANTED;
    }
    return gAskedScreenCapture ? SUHBAT_PERMISSION_DENIED : SUHBAT_PERMISSION_UNKNOWN;
  }
#endif
  return SUHBAT_PERMISSION_DEVICE_UNAVAILABLE;
}

static int gAskedMicrophone = 0;
static int gAskedScreenCapture = 0;

suhbat_permission_state suhbat_request_permission(suhbat_source_kind kind) {
  suhbat_permission_state current = suhbat_permission_state_for(kind);
  if (current == SUHBAT_PERMISSION_GRANTED || current == SUHBAT_PERMISSION_DEVICE_UNAVAILABLE) {
    return current;
  }
  if (kind == SUHBAT_SOURCE_MICROPHONE) {
    if (gAskedMicrophone) {
      /* Already asked and refused: never prompt again, the UI offers the settings pane instead. */
      return current;
    }
    gAskedMicrophone = 1;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) { (void)granted; }];
    return suhbat_permission_state_for(kind);
  }
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  if (gAskedScreenCapture) {
    return current;
  }
  gAskedScreenCapture = 1;
  if (@available(macOS 11.0, *)) {
    CGRequestScreenCaptureAccess();
  }
#endif
  return suhbat_permission_state_for(kind);
}

static NSArray<AVCaptureDevice *> *suhbat_input_devices(void) {
  return [AVCaptureDevice devicesWithMediaType:AVMediaTypeAudio] ?: @[];
}

size_t suhbat_device_count(suhbat_source_kind kind) {
  if (kind == SUHBAT_SOURCE_SYSTEM_AUDIO) {
    return 0;
  }
  return (size_t)suhbat_input_devices().count;
}

int suhbat_device_at(suhbat_source_kind kind, size_t index, suhbat_device_info *out) {
  if (out == NULL || kind != SUHBAT_SOURCE_MICROPHONE) {
    return -1;
  }
  NSArray<AVCaptureDevice *> *devices = suhbat_input_devices();
  if (index >= devices.count) {
    return -1;
  }
  AVCaptureDevice *device = devices[index];
  memset(out, 0, sizeof(*out));
  suhbat_write_text(device.uniqueID.UTF8String, out->uid, sizeof(out->uid));
  suhbat_write_text(device.localizedName.UTF8String, out->name, sizeof(out->name));
  out->is_available = device.isConnected ? 1 : 0;
  AVCaptureDevice *selected = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
  out->is_default = (selected != nil && [selected.uniqueID isEqualToString:device.uniqueID]) ? 1 : 0;
  out->sample_rate_hz = 0; /* filled by suhbat_device_actual_format from the live engine format */
  out->channels = 0;
  return 0;
}

void suhbat_device_actual_format(suhbat_source_kind kind, const char *device_uid, uint32_t *sample_rate,
                                uint16_t *channels) {
  if (sample_rate != NULL) *sample_rate = 0;
  if (channels != NULL) *channels = 0;
  if (kind != SUHBAT_SOURCE_MICROPHONE) {
    return;
  }
  (void)device_uid;
  AVAudioEngine *engine = [[AVAudioEngine alloc] init];
  AVAudioFormat *format = [engine.inputNode outputFormatForBus:0];
  if (format != nil && format.sampleRate > 0) {
    if (sample_rate != NULL) *sample_rate = (uint32_t)lrint(format.sampleRate);
    if (channels != NULL) *channels = (uint16_t)format.channelCount;
  }
}

suhbat_stream *suhbat_stream_start(const suhbat_stream_config *config, char *err, size_t err_len) {
  if (config == NULL) {
    suhbat_write_ns(@"null config", err, err_len);
    return NULL;
  }
  SuhbatStream *stream = [[SuhbatStream alloc] init];
  stream->onBlock = config->on_block;
  stream->onOverflow = config->on_overflow;
  stream->onState = config->on_state;
  stream->userData = config->user_data;
  stream.kind = config->kind;
  stream.sampleRate = config->sample_rate_hz;
  stream.channels = config->channels;
  NSError *error = nil;

  if (config->kind == SUHBAT_SOURCE_MICROPHONE) {
    if (!suhbat_start_mic(stream, config->device_uid == NULL ? nil : [NSString stringWithUTF8String:config->device_uid],
                          &error)) {
      suhbat_write_ns(error.localizedDescription ?: @"microphone start failed", err, err_len);
      return nil;
    }
    return (suhbat_stream *)(__bridge_retained void *)stream;
  }

#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  if (@available(macOS 13.0, *)) {
    if (!CGPreflightScreenCaptureAccess()) {
      suhbat_write_ns(@"screen recording permission is required to capture system audio", err, err_len);
      return nil;
    }
    __block SCShareableContent *content = nil;
    __block NSError *contentError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO
                                                 completionHandler:^(SCShareableContent *_Nullable found, NSError *_Nullable foundError) {
                                                   content = found;
                                                   contentError = foundError;
                                                   dispatch_semaphore_signal(semaphore);
                                                 }];
    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC))) != 0) {
      suhbat_write_ns(@"timed out enumerating shareable content", err, err_len);
      return nil;
    }
    if (contentError != nil || content.displays.count == 0) {
      suhbat_write_ns(contentError.localizedDescription ?: @"no display to capture", err, err_len);
      return nil;
    }
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject
                                                   excludingWindows:@[]];
    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
    configuration.capturesAudio = YES;
    configuration.sampleRate = config->sample_rate_hz > 0 ? config->sample_rate_hz : 48000;
    configuration.channelCount = config->channels > 0 ? config->channels : 2;
    configuration.queueDepth = 8;
    /* Excluding this app's own audio avoids feeding the recorder its own playback. The property needs
     * macOS 14; on 13.x it is genuinely not avoidable, which the acceptance doc records rather than hides. */
    if (@available(macOS 14.0, *)) {
      configuration.excludesCurrentProcessAudio = YES;
    }
    SuhbatSckDelegate *sckDelegate = [[SuhbatSckDelegate alloc] init];
    sckDelegate.stream = stream;
    stream.delegate = sckDelegate;
    SCStream *sck = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:sckDelegate];
    stream.stream = sck;
    NSError *addAudioError = nil;
    if (!suhbat_attach_delegate(sck, stream, &addAudioError)) {
      suhbat_write_ns(addAudioError.localizedDescription ?: @"could not add the audio output", err, err_len);
      [stream teardown];
      return nil;
    }
    __block NSError *startError = nil;
    dispatch_semaphore_t startSemaphore = dispatch_semaphore_create(0);
    [sck startCaptureWithCompletionHandler:^(NSError *_Nullable captureError) {
      startError = captureError;
      dispatch_semaphore_signal(startSemaphore);
    }];
    if (dispatch_semaphore_wait(startSemaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC))) != 0) {
      suhbat_write_ns(@"ScreenCaptureKit did not answer the start request", err, err_len);
      [stream teardown];
      return nil;
    }
    if (startError != nil) {
      suhbat_write_ns(startError.localizedDescription ?: @"startCapture failed", err, err_len);
      [stream teardown];
      return nil;
    }
    stream.sampleRate = (uint32_t)configuration.sampleRate;
    stream.channels = (uint16_t)configuration.channelCount;
    [stream emitState:SUHBAT_STREAM_RUNNING detail:"system audio stream started"];
    return (suhbat_stream *)(__bridge_retained void *)stream;
  }
  suhbat_write_ns(@"system audio capture requires macOS 13 or later", err, err_len);
  return nil;
#else
  suhbat_write_ns(@"this build has no ScreenCaptureKit support", err, err_len);
  return nil;
#endif
}

int suhbat_stream_pause(suhbat_stream *handle, char *err, size_t err_len) {
  if (handle == NULL) {
    return -1;
  }
  SuhbatStream *stream = (__bridge SuhbatStream *)(void *)handle;
  stream.paused = 1;
  NSError *error = nil;
  if (stream.kind == SUHBAT_SOURCE_MICROPHONE) {
    [stream.engine pause];
  }
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  else if (stream.stream != nil) {
    __block NSError *blockError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [stream.stream stopCaptureWithCompletionHandler:^(NSError *_Nullable captureError) {
      blockError = captureError;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)));
    error = blockError;
  }
#endif
  if (error != nil) {
    suhbat_write_ns(error.localizedDescription, err, err_len);
    return -2;
  }
  [stream emitState:SUHBAT_STREAM_PAUSED detail:"paused"];
  return 0;
}

int suhbat_stream_resume(suhbat_stream *handle, char *err, size_t err_len) {
  if (handle == NULL) {
    return -1;
  }
  SuhbatStream *stream = (__bridge SuhbatStream *)(void *)handle;
  NSError *error = nil;
#if SUHBAT_HAVE_SCREEN_CAPTURE_KIT
  if (stream.kind == SUHBAT_SOURCE_SYSTEM_AUDIO && stream.stream != nil) {
    __block NSError *blockError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [stream.stream startCaptureWithCompletionHandler:^(NSError *_Nullable captureError) {
      blockError = captureError;
      dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)));
    error = blockError;
  }
#endif
  if (error != nil) {
    suhbat_write_ns(error.localizedDescription, err, err_len);
    return -2;
  }
  if (stream.kind == SUHBAT_SOURCE_MICROPHONE) {
    NSError *engineError = nil;
    if (![stream.engine startAndReturnError:&engineError]) {
      suhbat_write_ns(engineError.localizedDescription ?: @"engine could not restart", err, err_len);
      return -3;
    }
  }
  /* The first block after a resume must begin a new segment in the sample map. */
  stream.discontinuity = 1;
  stream.paused = 0;
  [stream emitState:SUHBAT_STREAM_RUNNING detail:"resumed"];
  return 0;
}

void suhbat_stream_stop(suhbat_stream *handle) {
  if (handle == NULL) {
    return;
  }
  SuhbatStream *stream = (__bridge_transfer SuhbatStream *)(void *)handle;
  [stream teardown];
  [stream emitState:SUHBAT_STREAM_ENDED detail:"stopped"];
}

const char *suhbat_settings_url(suhbat_source_kind kind) {
  if (kind == SUHBAT_SOURCE_MICROPHONE) {
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  }
  return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
}

int suhbat_open_settings(suhbat_source_kind kind, char *err, size_t err_len) {
  NSString *urlText = [NSString stringWithUTF8String:suhbat_settings_url(kind)];
  NSURL *url = [NSURL URLWithString:urlText];
  if (url == nil || ![[NSWorkspace sharedWorkspace] openURL:url]) {
    suhbat_write_ns(@"System Settings could not be opened", err, err_len);
    return -1;
  }
  return 0;
}
