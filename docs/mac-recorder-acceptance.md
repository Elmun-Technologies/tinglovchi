# macOS Recorder Acceptance — Phase 2

This is the acceptance protocol for the Phase 2 goal: **SUHBAT can reliably capture a real meeting on a
Mac, offline, and survive a crash.** It is written for a person holding a physical Mac with a terminal open.
Every step has an observable outcome and a place to record the measurement, because Phase 2 is not accepted
by reading code.

Read §1 first. It states exactly what was and was not verified during implementation, so nothing below can
be mistaken for a completed claim.

---

## 1. Environment of record and what it proves

Implementation ran in a Linux (Debian 12, x86_64) sandbox:

| Fact                                                                                  | Consequence                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `rustc`, `cargo`, `rustup` available; crates.io / static.rust-lang.org unreachable | **No line of Rust in this phase has ever been compiled or run.** Not `recorder-core`, not `capture-macos`, not the Tauri shell.                                |
| No Apple SDK, no `xcrun`, no `clang` Objective-C framework headers                    | `crates/capture-macos/native/suhbat_capture.{h,m}` has never been through a compiler. ScreenCaptureKit and AVAudioEngine usage is unverified at the API level. |
| No audio hardware, no `/dev/snd`                                                      | No real capture, no real device enumeration, no TCC prompt, no CoreAudio device-churn observation is possible.                                                 |
| Node 22 + npm registry reachable                                                      | TypeScript, `vite build`, `vitest`, ESLint, Prettier all ran for real (see §3.1).                                                                              |

What the sandbox **did** verify, and it is not nothing: canonical timeline arithmetic against a checked-in
vector file shared by both languages; manifest serde shape and validation rules; the state-machine
transition table; atomic write and recovery-scan logic; error taxonomy; and 91 TypeScript tests that
cross-check the Rust declarations against the zod contracts and against the offline/privacy boundary.
See §3.1 for the exact numbers.

What the sandbox **cannot** verify, and therefore this document exists: that the app builds, that
permissions can be granted, that two sources are actually captured, that audio is audible and aligned,
that a kill survives, that disk-full is graceful, that resources are sane over an hour, and that no
network traffic leaves the machine.

**No item in §4–§12 may be marked pass by inspection of this repository.**

---

## 2. What the implementation claims

| Requirement                                                                                            | Mechanism (where it lives)                                                                                                     | Verified by                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Two sources, never permanently mixed                                                                   | One `CaptureStream` + one `ChunkWriter` + one directory per source (`microphone/`, `system-audio/`); no mixing function exists | `tests/desktop/recorder-offline-boundary.test.ts`, `crates/recorder-core/src/writer.rs` tests, **Test C** |
| Canonical `t = 0` on a monotonic clock, never reset                                                    | `TimelineOrigin` captured once at `ready → recording`; wall clock is metadata only                                             | `timeline.rs`, `tests/fixtures/recorder-timeline-vectors.json` (both languages), **Test E**               |
| Pause = explicit silent gap                                                                            | `pauseIntervals` + per-source `sampleMap` segments; chunks never cross a pause                                                 | `plan_chunks` tests, vectors, **Test E.3**                                                                |
| ~30 s independently recoverable chunks with sequence, sample range, byte size, checksum, format, state | `ChunkRecord` (28 fields), checksum computed only after the file is frozen                                                     | `manifest.rs`/`writer.rs` tests, **Test F**                                                               |
| Crash-recoverable session directory + versioned manifest                                               | `manifest.json.tmp-<revision>` → fsync → rename → dir fsync; startup `scan_and_reconcile`                                      | `storage.rs`/`recovery.rs` tests, **Test G**                                                              |
| Codec chosen, not assumed                                                                              | `Codec::PcmS16Le` + `Container::Wav` decided in §3.2 below; Opus-in-Ogg recorded as the candidate to benchmark                 | this document                                                                                             |
| System-audio health visible, never silent mic-only fallback                                            | `SourceStatus.state = unavailable` + `SystemAudioUnavailable` error + `degraded` on stall                                      | `session.rs` stall logic, **Test C.4**                                                                    |
| Device enumeration, active device, no silent substitution                                              | `suhbat_list_devices` + `AudioDevice.is_default`; a default-input change mid-run raises `DeviceLost`                           | `capture-macos`, **Test B**                                                                               |
| Permission states unknown/granted/denied/unavailable, re-checkable, no dialog spam                     | `PermissionSnapshot` + per-process "already asked" flag in the shim                                                            | `permission_snapshot`, **Test A**                                                                         |
| Non-blocking meters                                                                                    | Capture callback only `try_push`es into a bounded queue (128 blocks / 4 MiB); levels are computed on the writer thread         | `capture.rs` queue tests, **Test I.3**                                                                    |
| Persisted markers and timestamped notes that are not transcript segments                               | `MarkerRecord`/`NoteRecord` in the manifest, `noteText` never in an audio file                                                 | `session.rs` annotation tests, **Test D.4**                                                               |
| Disk pre-flight and graceful disk-full                                                                 | `preflight_disk` (`available ≥ projected × 3/2 + 2 GiB`) and `ENOSPC → disk_full`                                              | `storage.rs` tests, **Test G.3**                                                                          |
| No cloud, no DB, no provider                                                                           | No HTTP client, no SQL, no Supabase dependency in the Rust workspace; CSP `self`; capabilities without `http`/`fs`/`shell`     | `recorder-offline-boundary.test.ts` (static), **Test H**                                                  |

---

## 3. Before test A: build gates

These are the things the sandbox could not check. Run them first; each one is a gate on the tests below.

### 3.1 Automated checks that already ran (for the record)

```
npm install          → added 1 package (the new workspace link), audited 246 packages, 0 vulnerabilities
npm run lint         → clean (eslint apps packages tests, now including apps/desktop)
npm run typecheck    → clean (tsc --noEmit -p tsconfig.json)
npm test             → see the number you get; on the implementation box: 4 files in tests/desktop, 91 tests
npm run format:check → All matched files use Prettier code style!
cd apps/desktop && npx vite build → 115 modules transformed, dist/ emitted
```

Coverage of those 91 tests: 35 offline/privacy boundary, 28 cross-language contract (field names, JSON
kinds, enum values compared against the Rust `#[serde]` declarations), 10 Rust-structure (module
declarations, `crate::` paths resolve, FFI symbol parity, balanced delimiters, no `todo!`/`unimplemented!`,
unsafe blocks documented, command lists in sync), 18 renderer reducer/state tests.

The Rust workspace contains **99 `#[test]` functions** (`recorder-core` unit tests + `tests/golden_timeline.rs`

- `tests/session_pipeline.rs`) — **none of them has run yet.**

### 3.2 Codec decision (recorded, because the docs left it open)

`docs/recording.md` §4 lists Opus-in-Ogg as a _proposed, unverified_ candidate. Phase 2 ships
**PCM s16le in WAV** (48 kHz, mic mono, system stereo) because:

1. the phase forbids transcription/AI work, so compression buys nothing but risk inside the capture engine;
2. chunk-boundary independence is exact (no codec state carries across chunks: `encoderDelaySamples` and
   `encoderPaddingSamples` are 0 and the manifest says so);
3. checksums, sample counts and the timeline map mean exactly what they say;
4. it is verifiable with tools already on a Mac (`afinfo`) instead of requiring an Ogg/Opus reader;
5. the cost is bounded and pre-flight-checked: 96,000 B/s mic + 192,000 B/s system = **1,036,800,000 B
   per hour (~0.97 GiB)**, and `preflight_disk` refuses to start rather than fill the volume.

Gate for the _next_ phase: if a compressed format is wanted, benchmark `libopus` at 48 kHz stereo, 64 kb/s,
`push` encode with `OPUS_SET_SIGNAL=VOICE` and re-run Test E and Test I; adopt only if CPU/quality/drop
numbers beat WAV and the manifest can record real encoder delay/padding. Do not swap the codec without a
migration note in `manifest.json` (`codec`/`container` are per-chunk fields on purpose).

### 3.3 Build gates on the Mac

```bash
cd apps/desktop
rustup show                                   # expect stable ≥ 1.82 (workspace rust-version = "1.82")
cargo --version && rustc --version
xcode-select -p                               # expect /Applications/Xcode.app or /Library/Developer/CommandLineTools
xcrun --sdk macosx --show-sdk-version         # must be ≥ 13

cargo fmt --all --check --manifest-path src-tauri/Cargo.toml   # G1
cargo clippy --workspace --all-targets -- -D warnings          # G2
cargo test --workspace --manifest-path src-tauri/Cargo.toml    # G3  (this is the first-ever Rust execution)
npm run build                                                  # G4  (renderer)
npm run tauri -- build 2>&1 | tail -30                         # G5  (bundled .app; needs `npm i -D @tauri-apps/cli` — see G5 note)
```

Note on G5: the sandbox deliberately added **no** new npm packages, so `@tauri-apps/cli` is not in
`package-lock.json`. Install it on the Mac (`npm i -D @tauri-apps/cli@^2`) or use `cargo install tauri-cli`
and run `cargo tauri build`. Whichever is used, record the version here: CLI ______ , Tauri crate ______.

Then record the compiler-visible surprises we could not see. Expect these to need edits, and write the
results into this file:

| Gate                  | Command                                                              | Result                    | Notes                |
| --------------------- | -------------------------------------------------------------------- | ------------------------- | -------------------- |
| G1 fmt                | `cargo fmt --all --check`                                            | ☐ pass ☐ fail             |                      |
| G2 clippy             | `-D warnings`                                                        | ☐ pass ☐ fail             |                      |
| G3 Rust tests         | `cargo test --workspace`                                             | ☐ ___ passed ☐ ___ failed | first execution ever |
| G4 renderer build     | `vite build`                                                         | ☐ pass ☐ fail             |                      |
| G5 bundle             | `tauri build`                                                        | ☐ pass ☐ fail             |                      |
| G6 `Info.plist` merge | `plutil -p SUHBAT*.app/Contents/Info.plist \| grep -A1 NSMicrophone` | ☐ present ☐ missing       |                      |
| G7 entitlements       | `codesign -d --entitlements - --xml <path>.app 2>&1`                 | ☐ audio-input only        |                      |

G6/G7 matter because `tauri dev` on macOS may run the bare binary in `target/debug/`, and TCC attributes a
prompt to the _responsible process_ (your terminal) when there is no signed bundle. If the microphone prompt
never appears in dev, do not conclude the code is broken: run

```bash
open "$(find target -name '*.app' -maxdepth 4 | head -1)"   # the bundled app is the permission-correct target
```

and re-run Test A. Record which of the two you used; a permission result obtained from a bare dev binary is
not a result.

Also listed here because they are compile-time-only risks: `Failure` as a `Serialize`-only command error
type; `tauri::State<'_, Arc<AppState>>`; `app.path().app_data_dir()`; the `tauri.conf.json` keys
(`bundle.targets`, `withGlobalTauri`, `bundle.macOS.entitlements`, `minimumSystemVersion`); and the
Objective-C declarations in `suhbat_capture.m` (`SCStreamConfiguration.capturesAudio`,
`excludesCurrentProcessAudio`, `CGPreflightScreenCaptureAccess`, `AVCaptureDevice.authorizationStatusForMediaType:`).

---

## 4. Test A — Permissions

Objective: exercise `unknown → granted | denied | unavailable`, the re-check path, the Settings deep link,
and the no-spam rule.

```bash
# Terminal 1: watch TCC decisions as they happen.
log stream --style compact --predicate 'subsystem == "com.apple.TCC"' 2>&1 | tee /tmp/tcc.log
# Terminal 2: confirm the recorder root exists and is private.
ls -ld "$HOME/Library/Application Support/ai.suhbat.desktop/recordings"        # expect drwx------  (0700)
```

| Step | Do                                                                                                                                                                                                                                 | Pass when                                                                                                                                      | Record                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A.1  | Remove both grants: `tccutil reset Microphone ai.suhbat.desktop && tccutil reset ScreenCapture ai.suhbat.desktop` (then `tccutil reset ScreenCapture com.apple.suhbat-desktop` if the bundle id differs — read it from the bundle) | App opens, shows both sources as **Unknown**, Start disabled                                                                                   | ☐                            |
| A.2  | Click **Grant microphone**                                                                                                                                                                                                         | Exactly one system prompt, wording = `NSMicrophoneUsageDescription`                                                                            | prompts seen: ___            |
| A.3  | Deny the second prompt (**Screen Recording**)                                                                                                                                                                                      | State = `permission_blocked`; UI says system audio is unavailable; mic still shows unknown/granted correctly                                   | ☐                            |
| A.4  | Click **Grant microphone** again                                                                                                                                                                                                   | **No new dialog** — the reply must come back as denied with a "open System Settings" action. Dialog spam is a failure.                         | dialogs on repeat click: ___ |
| A.5  | Use the Settings shortcut                                                                                                                                                                                                          | System Settings opens on Privacy → Screen Capture (URL scheme `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`) | ☐                            |
| A.6  | Grant, then click **Re-check** (no restart)                                                                                                                                                                                        | Snapshot flips to granted without a prompt; Start enabled                                                                                      | ☐                            |
| A.7  | On macOS 13.x only: confirm the app reports `systemAudio = unavailable` rather than pretending                                                                                                                                     | UI shows unavailable, `SystemAudioUnavailable` error text is user-visible                                                                      | macOS version: ___           |
| A.8  | Quit, relaunch                                                                                                                                                                                                                     | Permission state read from TCC, not cached optimistically; no prompt at launch                                                                 | ☐                            |

Evidence to keep: `/tmp/tcc.log` and a screenshot of the denied state. Failure to attach a log is a fail for
this test.

## 5. Test B — Devices

| Step | Do                                                                        | Pass when                                                                                                                        | Record               |
| ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| B.1  | Open the device picker                                                    | Every CoreAudio input listed; exactly one marked **active/default**; the built-in mic is present                                 | devices: ___         |
| B.2  | Select a different input, start, then unplug/quit that device             | Recorder reports `device_lost` and **stops**; it does **not** silently resume on the built-in mic                                | ☐ substitute? yes/no |
| B.3  | Change the _system_ default input mid-recording (e.g. plug in headphones) | A `device_changed`/`degraded` notice appears; captured sample rate/channels for the open chunk do not silently change            | ☐                    |
| B.4  | Read the manifest of that session                                         | `sampleRateHz`/`channels` per source equal the device's actual format (`suhbat_device_actual_format`), not the requested 48k/1/2 | actual rate: ___     |
| B.5  | Start with a device at 44.1 kHz (set it in Audio MIDI Setup)              | Either it records at 44.1 kHz honestly or start is refused with a typed error — never 48k metadata on a 44.1k file               | ☐                    |

## 6. Test C — Two sources, really captured

```bash
SESSION=$(ls -1t "$HOME/Library/Application Support/ai.suhbat.desktop/recordings/sessions" | head -1)
ROOT="$HOME/Library/Application Support/ai.suhbat.desktop/recordings/sessions/$SESSION"
ls -l "$ROOT"/microphone "$ROOT"/system-audio
for f in "$ROOT"/microphone/*.wav; do afinfo "$f"; done | grep -E "Data format|Duration" | sort -u
```

| Step | Do                                                                                        | Pass when                                                                                                                                    | Record                      |
| ---- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| C.1  | Record 3 minutes while talking _and_ playing a YouTube video through the Mac's own output | Both directories contain `.wav` files of comparable duration                                                                                 | mic secs: ___ sys secs: ___ |
| C.2  | Play the mic-only file back                                                               | Your voice audible, **no** the YouTube audio (proves no mixing into the mic track)                                                           | ☐                           |
| C.3  | Play the system-only file back                                                            | YouTube audible, **your voice absent or bleed-through only via the speakers** (that bleed is expected and is itself proof they are separate) | ☐                           |
| C.4  | Mute the system output mid-run                                                            | System source health changes visibly (degraded/unavailable); UI never shows both healthy                                                     | ☐                           |
| C.5  | Start with system audio denied in A.3 conditions                                          | Mic-only start is **refused** unless the operator explicitly accepts a mic-only session; no silent fallback                                  | ☐                           |
| C.6  | `afinfo` each source                                                                      | mic: 1 ch, system: 2 ch, both the rate in B.4; no resampling applied                                                                         | channels: _**/**_           |
| C.7  | Count samples                                                                             | `du -h "$ROOT"` ≈ 1.04 GB/hour × duration; a 3-min session ≈ 52 MB                                                                           | size: ___                   |

## 7. Test D — Transport, state machine, annotations

| Step | Do                                                                                     | Pass when                                                                                                                                                            | Record              |
| ---- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| D.1  | `idle → ready → recording → paused → recording → finalizing → stopped` via the UI      | Each transition reflected in the header, and window title changes with state                                                                                         | ☐                   |
| D.2  | Attempt illegal transitions (click Start while recording; call `recorder_pause` twice) | Rejected with `invalid_state_transition`; nothing else changes. The second pause is idempotent-visible, not a double gap                                             | ☐                   |
| D.3  | Watch the two timers during a 90 s record with a 30 s pause                            | Canonical ≈ 2:00, captured ≈ 1:30, and the difference is labelled as paused/missing, not hidden                                                                      | canon: ___ cap: ___ |
| D.4  | **Mark Important** at a known moment, add a note with text `phase-2-marker-Δ`          | Both appear immediately in the UI _from the manifest_, with `meetingMs` matching the moment (±1 chunk)                                                               | marker ms: ___      |
| D.5  | `grep -r "phase-2-marker-Δ" "$ROOT"`                                                   | The note text appears only in `manifest.json`, never in a `.wav` or a log                                                                                            | ☐                   |
| D.6  | Stop                                                                                   | `.partial` files are gone; every chunk is `finalized`; `stoppedAt` set; app stays usable                                                                             | ☐                   |
| D.7  | Read `manifest.json` with any JSON parser                                              | `schemaVersion: 1`, `revision` ≥ chunk count, camelCase keys, `state: "stopped"`, `localOnly: true`, `uploadState: "pending"` on every chunk (Phase 2 never uploads) | ☐                   |

## 8. Test E — Timeline sync and drift (the test that matters most)

Method: generate an event that both sources capture at a known instant — a sharp clap is enough, but a
generated click is measurable:

```bash
# 3 short clicks through the Mac's own speakers; speak/shout "MARK" into the mic at the same time.
python3 - <<'PY'
import struct, subprocess, wave, math, os
p='/tmp/mark.wav'
with wave.open(p,'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
    data=bytearray()
    for i in range(48000):           # 1 second
        v = 12000 if i % 16000 < 300 else 0
        data += struct.pack('<hh', v, v)
    w.writeframes(bytes(data))
subprocess.run(['afplay', p], check=True)
PY
```

Do this at the **beginning** (t ≈ 5 s), the **middle** (t ≈ 30 s of a 60 s run) and the **end** (t ≈ 55 s).
Then find the onset in each source independently and compare in canonical time:

Detect the onset of the mark in each source independently and compare in canonical time. Use the helper in
this repository — it reads only what the recorder writes (`manifest.json` + the per-source WAV chunks) and
needs no third-party tool, because the audio is plain interleaved int16 PCM:

```bash
ROOT="$ROOT" python3 tools/mac-acceptance/onset_delta.py
```

It prints, per mark, the detected onset in each source and the difference. How to read it:

- The comparison is **within the same chunk index** on each side, so a lost chunk shows up as a mismatched
  chunk pair and is visible in the printout, not silently averaged away.
- Timestamps are quantised to the source's own sample grid (1 ms at 48 kHz), so 1–2 ms is measurement
  granularity rather than drift.
- If a mark is not found in both sources, the helper says so and exits non-zero — move closer to the
  microphone or lower `THRESHOLD` (it is `6000` int16 ≈ −38 dBFS).
- The helper itself was exercised against a synthetic session whose injected offset was known (5 ms): it
  recovered −5 ms on all three marks with zero spread. That validates the _measurement method_, not the
  recorder.

| Criterion                                                      | Pass when                                                                                                                                               | Recorded |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| E.1 onset delta, beginning                                     | \|Δ\| ≤ 10 ms                                                                                                                                           | ___ ms   |
| E.2 onset delta, middle                                        | \|Δ\| ≤ 10 ms                                                                                                                                           | ___ ms   |
| E.3 onset delta after a pause (pause 20 s, resume, mark again) | \|Δ\| ≤ 10 ms — proves the post-resume sample→timestamp mapping, not just the pre-pause one                                                             | ___ ms   |
| E.4 drift growth                                               | max(Δ) − min(Δ) over the run ≤ 4 ms (both tracks are one clock; growth would mean a resample or a lost-block lie)                                       | ___ ms   |
| E.5 gap accounting                                             | `sum(chunk.durationMs)` per source + every gap = `canonicalElapsedMs` exactly; the two are never conflated in the UI                                    | ☐        |
| E.6 no summed sync                                             | Deleting one chunk from the manifest and re-reading the file must still give correct timestamps for the rest (timestamps are per-chunk, not cumulative) | ☐        |
| E.7 clock epoch change                                         | Sleep/wake mid-run: manifest shows a `gap` with `reason = clockEpochDiscontinuity` and `estimatedBridgeGapMs`, and the UI says the bridge is estimated  | ☐        |

## 9. Test F — Chunks and manifest integrity

```bash
python3 - "$ROOT" <<'PY'
import hashlib, json, os, sys
root = sys.argv[1]
man = json.load(open(os.path.join(root, "manifest.json")))
bad = []
for c in man["chunks"]:
    p = os.path.join(root, c["localFile"])   # localFile is source-directory-relative
    if not os.path.exists(p):
        bad.append((c["sequenceNo"], "missing")); continue
    raw = open(p, "rb").read()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != c["checksum"]["value"]:
        bad.append((c["sequenceNo"], "checksum"))
    if len(raw) != c["byteSize"]:
        bad.append((c["sequenceNo"], "size"))
print("chunks:", len(man["chunks"]), "mismatched:", bad)
PY
```

| Criterion | Pass when                                                                                                                         | Recorded        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| F.1       | Every chunk in the manifest exists, byte size and sha256 match exactly                                                            | mismatches: ___ |
| F.2       | `sequenceNo` per source is 0..N-1 with no holes                                                                                   | ☐               |
| F.3       | Each chunk covers ≈ 30 s of _captured_ audio (`durationMs` between 29,000 and 31,000 unless the session ended early)              | p50: ___ s      |
| F.4       | `meetingEndMs` of chunk k ≤ `meetingStartMs` of chunk k+1, and no chunk spans a pause                                             | ☐               |
| F.5       | The first bytes of every chunk are a valid RIFF/WAVE header whose sizes match the file                                            | ☐               |
| F.6       | `manifest.json.revision` equals the number of committed changes; a `*.tmp-*` file may exist mid-write but must be gone after stop | leftovers: ___  |
| F.7       | Every file mode is 0600/0700 and the tree is `ai.suhbat.desktop`-owned                                                            | ☐               |

## 10. Test G — Crash, kill, and a full disk

| Step | Do                                                                                                         | Pass when                                                                                                                                                                                                     | Record           |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| G.1  | Record 60 s, then `kill -9` the process mid-chunk                                                          | On relaunch, the session appears in the recovery panel as `recoverable`, with N finalized chunks + 1 `partial`/`salvaged` — **nothing was deleted**, and the UI says which chunks are safe                    | chunks kept: ___ |
| G.2  | Play the salvaged truncated chunk                                                                          | It decodes and is audible up to the truncation point                                                                                                                                                          | ☐                |
| G.3  | Fill the volume (`mkfile 5g /tmp/filler`, repeat until `preflight` reports insufficient) then press Start  | Start refused with `disk_space_insufficient` and the numbers it used; then start a session _before_ filling and drive it into `ENOSPC`: state → `failed`, writers stopped, "Recording" disappears immediately | ☐                |
| G.4  | After G.3: confirm the UI does not keep saying "Recording" and the note field is disabled for that session | ☐                                                                                                                                                                                                             |
| G.5  | Corrupt a manifest (`python3 -c "p='<path>/manifest.json';open(p,'a').write('{')"`), relaunch              | Scan reports the directory as **rejected with a reason**, and it is _not_ rewritten or deleted                                                                                                                | ☐                |
| G.6  | Delete one `.wav` (keep the manifest), relaunch                                                            | Recovery says exactly one chunk is unrecoverable, the rest are usable, and the session state is `recoverable`                                                                                                 | ☐                |
| G.7  | `sudo fsck`-free crash: force a power loss during a write (hold the power button) once                     | On boot, at most the last chunk is lost; manifest still parses (atomic rename)                                                                                                                                | ☐                |

## 11. Test H — Offline and privacy boundary

```bash
# No listeners, no outbound connections, no DNS.
lsof -nP -i -a -p "$(pgrep -f 'SUHBAT|suhb' | head -1)" ; echo "listeners above must be empty"
nettop -P -x -l 3 -p "$(pgrep -f 'SUHBAT|suhb' | head -1)" 2>&1 | tail -20
# The hard version: revoke network entirely for the duration of a session.
networksetup -setairportpower en0 off   # or: sudo pfctl -e with a block rule for the uid
```

| Criterion | Pass when                                                                                                                                                                                                                                                               | Record                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| H.1       | Recording a full 3-minute session with Wi-Fi off works end to end                                                                                                                                                                                                       | ☐                                                                                                                                                    |
| H.2       | `lsof`/`nettop` show zero sockets for the app, ever                                                                                                                                                                                                                     | sockets: ___                                                                                                                                         |
| H.3       | No local HTTP server: `curl -s localhost:1420` (dev only) never reaches audio; release bundle listens on nothing                                                                                                                                                        | ☐                                                                                                                                                    |
| H.4       | `grep -R "https\?://" "$ROOT"` → only the `originWallClockUtc`-style metadata, no upload endpoint; `uploadState` stays `pending`                                                                                                                                        | ☐                                                                                                                                                    |
| H.5       | Nothing outside the app data directory is created (no `/tmp` spill, no symlink out); `..`, `/`, `\0` in a note body stays inside the session file as text                                                                                                               | ☐                                                                                                                                                    |
| H.6       | Logs (`log show --last 10m --predicate 'process == "SUHBAT"'`) contain no raw audio bytes and no note bodies at info level                                                                                                                                              | ☐                                                                                                                                                    |
| H.7       | Record the documented privacy boundary as-is: files are protected by the OS account + FileVault, **not** by app-level encryption; `storage.encryption = "os_account_and_disk_protection"`, and Keychain-based key custody remains a _future_ item in `docs/security.md` | ☐                                                                                                                                                    |
| H.8       | Quit the app while recording                                                                                                                                                                                                                                            | The stop path finalizes (no `.partial` left) and the app exits within the flush timeout; if it does not, that is a bug in the `stop` flush (see §13) | exit secs: ___ |

## 12. Test I — 60-minute soak with recorded metrics

One continuous 60-minute session, both sources, default 30 s chunks, a real meeting with speech and media
playback. Sample the resources every 5 s from a second terminal:

```bash
PID=$(pgrep -f 'SUHBAT|suhb' | head -1)
while kill -0 "$PID" 2>/dev/null; do
  ps -o pid,%cpu,rss,vsz,etime -p "$PID" | tail -1
  sleep 5
done | tee /tmp/soak-ps.log
iostat -d -w 5 >> /tmp/soak-iostat.log &     # stop with Ctrl-C afterwards
df -m "$HOME/Library/Application Support/ai.suhbat.desktop" | tee -a /tmp/soak-df.log
```

| Metric                                                   | Target                                                                              | Recorded  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------- |
| I.1 duration actually captured                           | ≥ 59:30 of 60:00 canonical                                                          | ___       |
| I.2 chunk count                                          | ≈ 120 per source (240 total), all `finalized`                                       | ___       |
| I.3 dropped samples, total across sources                | 0 (any non-zero must be visible in the UI as degraded, with the count shown)        | ___       |
| I.4 CPU, p50 / p95 (whole process, incl. writer threads) | ≤ 12 % / ≤ 25 % on Apple Silicon                                                    | ___ / ___ |
| I.5 RSS growth after the first 5 minutes                 | ≤ 30 MB over the remaining 55 min (leak check)                                      | ___       |
| I.6 bytes written                                        | ≈ 1.04 GB ± 3 %                                                                     | ___       |
| I.7 peak `df` delta vs estimate                          | estimate must never _under_-promise (free space ≥ reserve at stop)                  | ___       |
| I.8 longest write stall                                  | a chunk finalize must not block capture: writer queue never hit capacity            | ☐         |
| I.9 manifest integrity at the end                        | F.1–F.6 all pass on the soaked session                                              | ☐         |
| I.10 UI responsiveness while recording                   | 500 ms poll + level meters update while typing a note; no beachball                 | ☐         |
| I.11 audio quality                                       | both sources play back clean at 55 min; no wraparound, no silence, no clipping wall | ☐         |
| I.12 thermal/noise side effects noted                    |                                                                                     | ___       |

Attach `/tmp/soak-ps.log`, `/tmp/soak-iostat.log`, the soaked `manifest.json`, and this file with the
blanks filled in. A soak with no logs attached is not a pass.

## 13. Known limitations and required follow-ups

1. **`recorder_stop` finalizes synchronously.** `FLUSH_TIMEOUT` is 10 s, so a pathological disk can make
   the command block up to that long while holding the state lock. It cannot lose audio (writers are already
   frozen), but it can make the UI wait. Follow-up (do it in Phase 3, not here): run the flush in
   `spawn_blocking` and let the renderer observe `finalizing → stopped` via events. This is why the commands
   are otherwise deliberately synchronous.
2. **No `@tauri-apps/api` in the renderer.** It talks to the native layer through `window.__TAURI__`
   (`withGlobalTauri: true`) so that the sandbox needed no extra npm package. On the Mac this works, but
   swapping to `@tauri-apps/api` is the cleaner long-term seam; `bridge.ts` is the only file to change.
3. **No mock/dev capture mode.** `--mock` was _not_ wired into the Tauri entry point, so a browser preview
   shows the honest "native bridge unavailable" notice instead of fake audio. If a scripted backend becomes
   worth having, expose `ScriptedBackend` behind a debug-only command rather than a CLI flag nobody reads.
4. **No audio resampling.** Phase 2 records the device's actual rate and reports it. A device pinned to
   44.1 kHz therefore produces a 44.1 kHz manifest. That is correct but not yet _convenient_; resampling
   belongs with the codec decision in §3.2.
5. **Docs contradictions found while implementing (flagged, not silently changed):**
   - `docs/architecture.md:101` requires a versioned `/api/v1` before the desktop client exists. Phase 2's
     mandate forbids desktop↔cloud access. Resolution: the desktop app ships with **zero** network code, and
     the API boundary stays unbuilt until Phase 3. Nothing was added to satisfy §101.
   - The Phase 2 brief's manifest sketch is snake_case and omits fields; `docs/recording.md` §4 (the source
     of truth) is camelCase and richer. Implementation follows the docs.
   - The brief says `stopping`/`completed`; `docs/recording.md` §2 says `finalizing`/`stopped`.
     Implementation follows the docs.
   - `SourceRecord` (persisted) carries `state`, while the live status event carries `health`. Both names are
     kept — one is durable, one is transient — and the contract test pins both.
6. **Everything in §3.3 that has never been compiled.** Until G1–G5 pass, treat the Rust tree as a design
   with tests written for it, not as a working program.

## 14. Sign-off

Phase 2 is accepted only when **all** of A–I pass with metrics recorded, §3.3 gates are green, and the
evidence files are attached. Partial results are reported as partial: e.g. "A–H pass, I.3 has 4 dropped
blocks at the 40-minute mark — not accepted until explained."

```
Date: ______   Mac model/OS: ______   Rust: ______   Tauri CLI: ______
Tester: ______
A ☐  B ☐  C ☐  D ☐  E ☐  F ☐  G ☐  H ☐  I ☐
```
