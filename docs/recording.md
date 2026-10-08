# Recording architecture

**Status:** the Rust session coordinator, macOS and Windows capture modules, the local manifest/recovery protocol, and the Tauri command layer are implemented. The desktop renderer is a one-tap appliance (see §9). Nothing in this document has been verified on real macOS or Windows hardware from this repository: the execution host used for development is Linux with no Rust toolchain, so `cargo test --workspace --manifest-path apps/desktop/src-tauri/Cargo.toml` has never been run here and every acceptance gate in §8 remains open.

## 1. Reliability contract

A meeting may continue recording when the network is absent. Local capture is independent of upload and cloud processing:

```text
audio capture → local per-source chunks → durable manifest
             → resumable background upload → server verification → finalize
```

An upload attempt never deletes or truncates the only local copy. A chunk is eligible for local retention cleanup only after the server has acknowledged the matching recording/source/sequence/checksum and the configured retention policy permits deletion.

## 2. Ownership and platform boundary

- Tauri/React presents a typed command interface (`start`, `pause`, `resume`, `stop`, duration, levels, device/permission state, upload progress, marker, note). UI does not own capture buffers or the manifest.
- Rust is the session coordinator: validates the selected meeting and consent, owns the state machine and monotonic meeting clock, serializes manifest updates, finalizes chunks, performs recovery, and schedules upload reconciliation.
- A small macOS-native bridge owns capture APIs: AVFoundation/CoreAudio for the microphone and ScreenCaptureKit for system/display audio as supported by the selected macOS version and permission state. Keep microphone and system audio as distinct logical sources; do not mix at capture time. Later Windows capture belongs behind the same Rust command/domain interface but in a Windows-native module.
- macOS minimum version, ScreenCaptureKit entitlements/permission behavior, App Sandbox distribution mode, and hardware-device switching must be verified on real supported Macs before choosing production defaults. Permission detection should expose an actionable “open System Settings” path where the OS supports it, not report a silent generic error.

## 3. Capture session, canonical meeting timeline, and state

### Normative timeline contract

There is **one authoritative relative timeline per meeting**, shared by every original recording source, transcript segment, note, manual marker, topic, evidence link, and playback view. Every persisted interval is half-open `[start_ms, end_ms)` on that timeline. Database millisecond offsets are for stable interchange/display; sample/tick mappings retain the precision needed to seek to an exact decoded sample.

- **`t=0`:** when the first recording session has passed permission checks and the recorder coordinator commits `ready → recording`, it captures and persists the monotonic clock reading immediately before requesting source streams to start. It also records a separate UTC wall-clock anchor. `t=0` is not the first non-silent sample and is never reset by pause/resume. Source startup latency is represented by each source's actual first-sample offset/gap.
- **Clock:** use one platform monotonic/continuous host clock for the capture coordinator and timestamp every microphone/system-audio buffer against it. If a capture API exposes a device/sample clock, persist its calibration to the host clock and refresh it to account for drift. Wall-clock/NTP/DST changes never alter meeting offsets or reorder evidence. Store the clock epoch/frequency or equivalent mapping metadata needed to interpret raw ticks.
- **Wall time:** `started_at`, `ended_at`, consent timestamps, and audit timestamps are UTC wall-clock metadata. They are not used as `start_ms`/`end_ms`. A wall-time estimate may be displayed as metadata, but canonical playback and evidence navigation use only the meeting timeline and persisted source maps.
- **Pause/resume:** pause and resume events are timestamped on the same monotonic clock. The interval `[pause_t, resume_t)` remains in the canonical timeline as a silent/unavailable gap; it is **not removed or compressed**. Resuming appends at the new meeting-relative time and does not shift earlier segments. Active capture duration is accumulated recorder `recording`-state time excluding `paused` intervals (counted once, not once per concurrent source); per-source decoded/playable durations are stored separately. Elapsed meeting duration includes pauses and gaps. If a process/OS restart changes the monotonic clock epoch, never compare unrelated raw ticks: append an explicit epoch bridge/gap from the last durable meeting offset, mark any wall-time-derived gap as estimated, and do not claim sample-level audio exists in it.
- **Source alignment:** microphone and system audio remain separate tracks. Their buffers use the same host monotonic clock; each source persists first/last sample ticks, sample rate/count, drift calibration, and discontinuities. Simultaneous buffers therefore overlap at the same meeting offsets; one track is never shifted by comparing file lengths. Missing source intervals remain explicit gaps.
- **Chunk-local mapping:** each chunk has a canonical meeting start/end and a decoded-sample origin/time base. Given a source-global sample index `n`, the persisted clock map computes its host monotonic tick (nominally `first_sample_ticks + (n - source_first_sample_index) × tick_frequency_hz / sample_rate_hz`, adjusted by recorded drift calibration), then computes `meeting_ms = (sample_tick - origin_ticks) × 1000 / tick_frequency_hz`. The inverse map deterministically chooses the source sample at/after a canonical `start_ms`; higher-resolution ticks/sample indices are retained for exact seeks. `start_ms` is the floor and `end_ms` the exclusive ceiling of sample boundaries; encoder delay/padding and any trim are recorded, not guessed from container duration. Chunks do not cross pauses/discontinuities; a gap is an absent interval or explicit gap record. `duration_ms` describes playable media duration and is not a substitute for its meeting interval/sample map.
- **Playback/evidence invariant:** given an evidence segment's canonical `start_ms`, locate the source chunk/map whose meeting interval contains that point, then seek to the corresponding decoded sample. A rendered/mixed track carries its own versioned piecewise map back to original source samples. If multiple original tracks cover the point, playback can select a source or the mapped mix. Never derive synchronization by summing chunk/file durations or concatenating files without a timeline map.
- **Meeting with another capture session:** the first session establishes the meeting origin. A later session/source must register an explicit mapping onto the existing meeting timeline; it cannot define a new `t=0`. Independent devices require a calibrated/shared-clock bridge before their audio can be treated as exactly synchronized.

The detailed database fields and provider-time conversion rules are cross-referenced in [database.md](database.md) and [ai-pipeline.md](ai-pipeline.md).

### Recorder state and events

The capture state machine is separate from upload/processing state:

```text
idle → permission_check → ready → recording ⇄ paused → finalizing → stopped
                   ↘ permission_blocked / device_unavailable / failed
stopped → uploading (independent background state; capture is already finalized)
uploading → uploaded | upload_retrying | failed_retryable
```

Capture failure is explicit and surfaced with source-specific state; it must not masquerade as a successful full recording if microphone or required system audio stopped. UI always shows a visible recording indicator. Consent acknowledgement and responsible-participant notice are required before the first applicable recording/policy-controlled start and are persisted with an audit reference. Notes and markers (and their authorship) use the same meeting-relative monotonic clock, including while paused if annotation is allowed; they are never merged into transcript text.

Permission/device states use the required values: `permission_unknown`, `permission_granted`, `permission_denied`, `device_unavailable`. Upload state is separate from capture state so a network outage never blocks `pause`, `resume`, or `stop`.

## 4. Local durable layout and manifest

Store session artifacts under the OS application-support directory, partitioned by workspace/meeting/session UUIDs and protected with user-only filesystem permissions. The exact absolute path is OS-derived; it is never supplied by a web page. Use an explicit versioned manifest and self-contained per-source chunk files. A representative schema (illustrative, not a committed JSON schema) is:

```json
{
  "schemaVersion": 1,
  "revision": 27,
  "workspaceId": "uuid",
  "meetingId": "uuid",
  "recordingId": "uuid",
  "sessionId": "uuid",
  "state": "recording",
  "startedAt": "2026-10-06T10:00:00Z",
  "timeline": {
    "clock": "platform_monotonic_continuous",
    "clockEpochId": "boot-epoch-id",
    "originTicks": "monotonic-tick-value",
    "originWallClockUtc": "2026-10-06T10:00:00Z",
    "tickFrequencyHz": 1000000000
  },
  "consent": { "acknowledgedAt": "2026-10-06T09:59:58Z", "policyVersion": "v1" },
  "sources": [
    {
      "recordingSourceId": "uuid",
      "kind": "microphone",
      "role": "original",
      "state": "active",
      "sampleRateHz": 48000,
      "channels": 1,
      "codec": "opus",
      "container": "ogg"
    },
    {
      "recordingSourceId": "uuid",
      "kind": "system_audio",
      "role": "original",
      "state": "active",
      "sampleRateHz": 48000,
      "channels": 2,
      "codec": "opus",
      "container": "ogg"
    }
  ],
  "chunks": [
    {
      "chunkId": "uuid",
      "recordingId": "uuid",
      "recordingSourceId": "uuid",
      "sequenceNo": 0,
      "idempotencyKey": "recording-uuid:source-uuid:0",
      "localFile": "microphone/000000.ogg",
      "storageKey": null,
      "meetingStartMs": 0,
      "meetingEndMs": 30000,
      "durationMs": 30000,
      "sourceFirstSampleIndex": 0,
      "firstSampleMonotonicTicks": "monotonic-tick-value",
      "sampleCount": 1440000,
      "byteSize": 0,
      "checksum": { "algorithm": "sha256", "value": "hex" },
      "codec": "opus",
      "container": "ogg",
      "sampleRateHz": 48000,
      "channels": 1,
      "encoderDelaySamples": 0,
      "encoderPaddingSamples": 0,
      "uploadState": "pending",
      "verificationState": "pending",
      "verifiedAt": null
    }
  ],
  "markers": [],
  "notes": [],
  "lastUpdatedAt": "2026-10-06T10:00:30Z"
}
```

The real Rust type must validate version, UUID ownership, recording/source relationship, strictly ordered non-negative sequence/time ranges, unique `(recordingId, recordingSourceId, sequenceNo)` identities, checksum/sample metadata, file containment within the session directory, and legal state transitions. Reusing an identity with a different checksum is a conflict, never an overwrite. `revision` is monotonic; unknown future schema versions are not destructively rewritten.

### Safe write/finalize protocol

1. Capture into a temporary chunk file for one source and configured interval.
2. Flush the encoder/container, `fsync` file, compute checksum/byte count and monotonic bounds.
3. Atomically rename to the final deterministic path; sync the containing directory where supported.
4. Atomically write the next manifest revision to a sibling temp file, flush/sync, rename, then sync its directory.
5. On startup, validate the manifest and rescan the session directory. A finalized file missing from the manifest is reconciled from a validated header/checksum; a `.partial` file is salvaged only if the codec safely supports it, otherwise recorded as an explicit gap and retained for diagnostics.

Chunk intervals should start at a configurable **30 seconds**. Independently decodable Opus-in-Ogg chunks at 48 kHz are the initial codec candidate (microphone mono, system audio channel layout preserved). This is a proposed default to limit storage while keeping self-contained recoverable files, not a verified AssemblyAI requirement. Benchmark speech intelligibility, diarization, file finalization, CPU use, and provider compatibility on Mac hardware before freezing it. The original per-source chunks remain immutable; any mixdown/resampling is a derived, versioned processing artifact.

## 5. Time alignment and separate tracks

The common monotonic meeting-time definition in §3 is normative. Both source adapters map buffer/sample timestamps to that host clock and persist per-chunk `[start_ms, end_ms)`, sample counts, sample rate, first-sample clock mapping/calibration, and discontinuities. Use explicit gaps rather than shifting later audio to hide missing samples. Keep original microphone and system-audio channels separate through upload. A future `mixed_rendered` source is a derived source with immutable input-source/chunk IDs, renderer/version metadata, and a versioned piecewise `asset_time → meeting_time → source_sample` map. Playback and provider synchronization resolve through those maps; container/file duration is used only as a consistency check, not to assign timeline offsets.

Markers and manual notes are separate annotation records with meeting time and author. `Mark important` creates a marker; `Add note` creates note text. Neither is merged into the spoken transcript. Manual markers can be given higher retrieval/analysis priority through explicit context metadata, while their origin remains visibly user-authored.

## 6. Upload and offline recovery protocol

For each finalized chunk the client holds stable `(recording_id, recording_source_id, sequence_no, byte_size, checksum)` metadata, a client chunk UUID, and an idempotency key derived from `(recording_id, recording_source_id, sequence_no)`. The verification checksum is SHA-256 over the exact uploaded object bytes (ciphertext if client-side encryption is introduced); any plaintext digest is a separate integrity field. The database enforces `UNIQUE(recording_source_id, sequence_no)` (each source belongs to one recording) and `UNIQUE(recording_id, idempotency_key)`; these are the canonical duplicate barriers, not an in-memory upload cache. An identical retry returns the existing logical chunk; a retry with conflicting checksum, time range, or size returns a conflict and never overwrites the canonical row/object. Storage keys are deterministic/opaque and unique per backend.

The API:

1. Authenticates the user and confirms active membership plus ownership of the meeting/recording session.
2. Issues/refreshes a short-lived signed upload target for that canonical chunk identity, or accepts a streamed upload through a controlled endpoint if provider constraints require it.
3. Accepts upload completion as **provisional only**, then independently verifies the stored object's expected key, actual byte size, and checksum (client completion/metadata alone is not trusted).
4. Sets server-controlled `verification_state=verified` only after verification and returns that durable acknowledgement. The client cannot mark a chunk verified. Identical verified retries are idempotent; conflicting bytes for a finalized sequence are rejected and audited.
5. Exposes reconciliation of missing, provisional, rejected, or unverified chunks after app restart or network return.
6. Accepts finalization only when the stop manifest's required sources/chunk ranges are complete and all required objects are server-verified. Only then set processing state to `uploaded` and enqueue assembly idempotently for that generation.

The desktop retry loop uses bounded exponential backoff with jitter and server reconciliation; upload failures are visible/actionable but do not stop or corrupt local recording. A 30-minute outage is the explicit acceptance scenario: capture and chunking continue locally, application restart recovers the manifest, reconnection fills only missing sequences, and finalization starts processing once. Local data remains until each needed chunk has confirmed server acknowledgement and retention permits cleanup.

## 7. Local privacy and retention

Audio and manifest data are sensitive. Keep files out of cloud-synced temporary folders, use restrictive OS permissions, avoid logging file contents/paths with user names, and use a Keychain-backed device key for per-chunk authenticated encryption before production if the key lifecycle and upload streaming are validated. Key material must not live in `.env`, Tauri frontend bundles, or the manifest. Local encryption does not protect against a compromised unlocked account; document FileVault expectations and test recovery behavior before release. Until the key lifecycle is implemented, a prototype must clearly state that local files rely on OS account/disk protection.

Retention policy is separate from upload acknowledgement. Provide future settings such as `keep_forever`, `90_days`, `30_days`, or `delete_after_transcript`; record object and local-copy policy independently. A server acknowledgement is necessary but does not itself authorize immediate local deletion.

## 8. Phase 2 verification gates

On real macOS devices, verify microphone and system audio independently and concurrently; permission unknown/granted/denied flows; absent or unplugged device; pause/resume gaps; audio level; stop/finalization; multiple chunks; long-run clock drift; sleep/wake; app crash at each file/manifest commit point; restart recovery; offline 30-minute capture/upload recovery; checksum mismatch/retry; explicit consent; usable audio playback; storage pressure; and resource use. Keep sample recordings in an approved external test location, not Git. These are future tests, not claims made by this repository.

## 9. One-tap desktop client

The desktop app is an appliance, not a dashboard. It has exactly one primary control and no forms.

### 9.1 Screens

| Phase | What the user sees | What it is allowed to say |
| --- | --- | --- |
| `signed_out` | Connect code, "Brauzerda tasdiqlash" | Nothing else. No email field, no password field. |
| `consent` | One sentence about what is recorded, "Tushunarli" | Consent must be acknowledged once per device. |
| `idle` | Logo, workspace name, one large mic button, "Suhbatni boshlash", device status, a small settings affordance | No analytics, no navigation, no cards. |
| `starting` | Button is busy, nothing else changes | Never a fake spinner that finishes before the recorder does. |
| `recording` | Red state, large elapsed timer, live waveform, "Suhbat yozilmoqda", Pause, Stop, mic + system-audio indicators | Timer is canonical: it includes pauses and gaps (§3). |
| `paused` | Timer frozen, "PAUSED", Resume, Stop | The timer does not reset. |
| `stopping` | Busy; the recorder is finalizing chunk files | Nothing is claimed about the server yet. |
| `uploading` | "Yuklanmoqda" with **verified / total chunk counts** | Counts only. Never a percentage. |
| `processing` | "Audio saqlanmoqda" → "Yuklanmoqda" → "Transkripsiya qilinmoqda" → "Tahlil qilinmoqda" | The four headlines are chosen from the server's real `productState`; there is no fifth, invented state. |
| `ready` | "Suhbat tayyor", title, duration, detected languages, "Natijani ko‘rish" | Duration and languages come from the pipeline, not from the local clock. |
| `saved_locally` | "Internet yo‘q. Suhbat qurilmada xavfsiz saqlandi." | Honest: the audio is on disk and the queue will retry. |
| `analysis_failed` | "Suhbat saqlandi. Tahlil vaqtincha bajarilmadi." | The meeting is not lost; the dashboard can retry. |

### 9.2 Start → Stop → Ready

```text
press mic ──▶ recorder_start ──▶ Rust validates consent + meeting, opens the session
                                │
                                ├─ capture (mic + system audio, separate tracks) ──▶ chunk files + manifest
                                │
press stop ─▶ recorder_stop ────┴─▶ finalize_open: last chunk sealed, manifest committed
                                    │
                                    ├─ online?  upload queue: authorize → PUT bytes at signed URL → verify
                                    │            └─ duplicate barrier: UNIQUE(recording_source_id, sequence_no)
                                    │               and the idempotency key (§6) make a re-send a no-op
                                    └─ offline? saved_locally; bytes stay on disk and the queue keeps retrying
                                                 │
                          POST /api/v1/recordings/{id}/finalize ──▶ server verification gate
                                                 │
                                    prepare transcription asset → AssemblyAI → diarization
                                                 │
                                    canonical transcript → AI analysis → knowledge indexing
                                                 │
                     desktop polls GET /api/v1/meetings/{id}/processing ──▶ "ready"
                                                 │
                                    "Natijani ko‘rish" → /w/{workspaceId}/meetings/{meetingId}
```

The desktop **initiates and observes**. It never transcribes, never analyses, and never decides a
meeting is finished — every processing word it renders is a value the server produced. The only
exception is the local finalize, which is the recorder's own job and predates this phase.

### 9.3 Automatic meeting creation

Recording is never blocked by a form. The desktop calls `POST /api/v1/meetings` with a workspace id
and nothing else:

* no `title` → `Suhbat — 8 Oct, 14:32`, generated in local time;
* no `meetingTypeId` → the workspace's own default type (lowest active sort order);
* no company/project → both stay `null`, editable from the dashboard.

The response reports which defaults were applied (`defaultsApplied`), so the UI can tell the user the
title was chosen for them rather than pretending they typed it.

### 9.4 Sign-in: connect code, not credentials in the app

```text
desktop: POST /api/v1/desktop/connect-codes      →  code "AB12-CDEF-GH34"
desktop: opens {APP_URL}/desktop/connect         →  browser, real Supabase session
browser: user signs in, picks a workspace, confirms
desktop: GET  /api/v1/desktop/connect-codes      →  authorized
desktop: POST /api/v1/desktop/sessions           →  long-lived bearer token (90 days)
```

* The code is single-use and expires in 10 minutes. Only its SHA-256 is stored.
* The session token is returned exactly once and only its SHA-256 is stored. It lives in the
  renderer's `localStorage` (`suhbat.desktop.v1`), which holds **no** credential beyond it.
* The token is sent only to the API origin named by `VITE_SUHBAT_API_BASE_URL`. Chunk bytes go to a
  short-lived signed storage URL that is fetched **without** the token — see §9.5.
* Email/password never touches the desktop app, and no provider secret ever does.

### 9.5 The network seam

`apps/desktop/src/cloud.ts` is the only module in the renderer allowed to touch the network.
`tests/desktop/cloud-boundary.test.ts` fails the build if any other renderer file calls `fetch`, builds
an absolute URL, imports a Supabase client, or reads an environment variable other than
`VITE_SUHBAT_API_BASE_URL`. The Rust crates contain no HTTP client at all — they stay offline and the
TypeScript client drives uploads.

Two doors, and only two:

1. **API calls** — `https://{VITE_SUHBAT_API_BASE_URL}/api/v1/…`, always with the session token.
2. **Chunk bytes** — a signed URL the server issues per chunk, fetched without the session token. A
   signed URL is a bearer capability; sending the long-lived token to a storage host would leak it
   into that host's logs.

Rust's contribution is a single-purpose command, `recorder_read_chunk_bytes`, which reads sealed chunk
bytes from the session directory so the TypeScript client can upload them. It does not know what an
HTTP request is.

### 9.6 Never deletes a recording

No code path in `recorder-core` removes audio. The only `remove_file` calls are:

* `writer.rs` — a zero-sample chunk that was never written to (`sample_count == 0 || data_bytes == 0`);
* `storage.rs` — a `manifest.json.tmp-*` temp file left by an interrupted atomic manifest write;
* `recovery.rs` — a `.wav.partial` shell smaller than one chunk header, i.e. a file that holds no audio.

`remove_dir_all` appears only inside `#[cfg(test)]` modules. `tests/desktop/cloud-boundary.test.ts`
enforces all of the above so a future change cannot quietly start deleting recordings.

### 9.7 Close guard

While capture is live, the Tauri shell intercepts the window close request and emits
`close_requested` to the renderer instead of closing. The renderer shows a confirm sheet with two
choices — keep recording, or stop and save (which runs the same finalize + upload path as pressing
Stop). A crash is different and needs no consent: on next launch, recovery finds the interrupted
session, closes its manifest, and offers to upload it.

### 9.8 Test coverage

| Suite | Covers |
| --- | --- |
| `tests/desktop/one-tap-flow.test.ts` | Every transition above, duplicate start/stop, workspace switch guard, close guard, crash-recovery entry |
| `tests/desktop/cloud-client.test.ts` | Endpoint routing, error classification, credential containment, base-URL validation |
| `tests/desktop/upload-runner.test.ts` | Offline classification, exactly-once upload, resume, no fabricated progress |
| `tests/desktop/cloud-boundary.test.ts` | The network seam and the never-deletes guarantee |
| `tests/desktop/recorder-contract.test.ts` | Rust ↔ TypeScript field-by-field agreement |
| `tests/desktop/rust-structure.test.ts` | `generate_handler!` ↔ `commands.rs` ↔ `bridge.ts` stay in sync |
| `tests/rls/phase13-desktop-client.test.ts` | Connect codes, session hashing/revocation/expiry, workspace isolation, RLS posture |
