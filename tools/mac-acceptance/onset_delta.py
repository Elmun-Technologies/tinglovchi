#!/usr/bin/env python3
"""Onset-delta helper for docs/mac-recorder-acceptance.md (Test E).

Finds the first loud 10 ms window in each finalized chunk of a session and reports the time difference
between the microphone and the system-audio track in *canonical* meeting time. It reads only what the
recorder writes: manifest.json plus the per-source WAV chunks.

Usage:  ROOT="$HOME/Library/Application Support/ai.suhbat.desktop/recordings/sessions/<uuid>" \
            python3 tools/mac-acceptance/onset_delta.py

The tolerance for a real Mac is +-10 ms per mark (docs/recording.md does not allow deriving alignment from
cumulative durations, so alignment is measured acoustically, chunk by chunk).
"""

import array
import json
import os
import sys
import wave

THRESHOLD = 6000  # int16 amplitude, about -38 dBFS
MARKS_EXPECTED = 3


def onset_ms_of_first_loud_window(path, start_ms):
    """Return (canonical ms of onset, sample index, rate) for the first window over THRESHOLD."""
    with wave.open(path, "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
    samples = array.array("h")
    samples.frombytes(frames[: len(frames) - (len(frames) % (2 * channels))])
    if channels > 1:
        peak = [max(abs(samples[i]), abs(samples[i + 1])) for i in range(0, len(samples), channels)]
    else:
        peak = [abs(value) for value in samples]
    # 1 ms windows: whatever the device rate turned out to be. Onset resolution is therefore ~1 sample
    # group, so a reported |delta| of 1-2 ms is measurement granularity, not drift.
    window = max(1, rate // 1000)
    for index in range(0, len(peak) - window, window):
        if max(peak[index : index + window]) >= THRESHOLD:
            return start_ms + index * 1000 // rate, index, rate
    return None, None, rate


def onsets(root, manifest, kind, directory):
    found = []
    for chunk in sorted(
        (item for item in manifest["chunks"] if item["sourceKind"] == kind and item["state"] == "finalized"),
        key=lambda item: item["sequenceNo"],
    ):
        path = os.path.join(root, directory, os.path.basename(chunk["localFile"]))
        if not os.path.exists(path):
            continue
        meeting_ms, sample_index, rate = onset_ms_of_first_loud_window(path, chunk["meetingStartMs"])
        if meeting_ms is None:
            continue
        found.append({"chunk": chunk["sequenceNo"], "meetingMs": meeting_ms, "sample": sample_index, "rate": rate})
    return found


def main():
    root = os.environ.get("ROOT")
    if not root:
        print("set ROOT to the session directory", file=sys.stderr)
        return 2
    manifest = json.load(open(os.path.join(root, "manifest.json")))
    mic = onsets(root, manifest, "microphone", "microphone")
    system = onsets(root, manifest, "system_audio", "system-audio")
    print(f"microphone onsets: {[item['meetingMs'] for item in mic]} ms")
    print(f"system-audio onsets: {[item['meetingMs'] for item in system]} ms")
    if not mic or not system:
        print("could not find a mark in both sources; move closer to the mic or raise THRESHOLD's inverse")
        return 1
    deltas = []
    for index in range(min(len(mic), len(system))):
        delta = mic[index]["meetingMs"] - system[index]["meetingMs"]
        deltas.append(delta)
        print(
            f"mark {index + 1}: chunk {mic[index]['chunk']}/{system[index]['chunk']} "
            f"delta = {delta} ms (mic {mic[index]['meetingMs']} / system {system[index]['meetingMs']})"
        )
    spread = max(deltas) - min(deltas)
    print(f"count: {len(deltas)} of {MARKS_EXPECTED} expected | max |delta| = {max(abs(d) for d in deltas)} ms | spread = {spread} ms")
    print("PASS if |delta| <= 10 ms for every mark and spread <= 4 ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
