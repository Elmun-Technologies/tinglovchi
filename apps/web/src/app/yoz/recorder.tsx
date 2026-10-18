'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mic, Pause, Play, Square, UploadCloud, Trash2, AlertTriangle } from 'lucide-react';
import { formatTimestamp, formatDateTime } from '../../lib/quick/format';
import {
  deleteLocalRecording,
  listLocalRecordings,
  loadLocalRecording,
  saveLocalRecordingMeta,
  appendLocalChunk,
  type LocalRecording,
  type LocalRecordingMeta,
} from '../../lib/quick/local-recordings';

type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'uploading';

// MediaRecorder delivers a piece this often; each piece is also saved locally.
const SLICE_MS = 5_000;

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function uploadRecording(
  recording: LocalRecording,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const type = recording.mimeType || recording.chunks[0]?.type || 'audio/webm';
  const form = new FormData();
  form.append('audio', new Blob(recording.chunks, { type }), 'suhbat');
  form.append('recordedMs', String(Math.round(recording.recordedMs)));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/quick/sessions');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { id?: string; error?: string };
        if (xhr.status === 201 && body.id) resolve(body.id);
        else reject(new Error(body.error ?? `Server xatosi (${xhr.status})`));
      } catch {
        reject(new Error(`Server xatosi (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Internet aloqasi yo‘q. Yozuv telefonda saqlandi.'));
    xhr.send(form);
  });
}

export function Recorder({ warnings }: { warnings: string[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState<LocalRecordingMeta[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingRef = useRef<LocalRecording | null>(null);
  const clockRef = useRef<{ runningSince: number | null; accumulated: number }>({
    runningSince: null,
    accumulated: 0,
  });
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const frameRef = useRef<number | null>(null);

  const refreshPending = useCallback(async () => {
    setPending(await listLocalRecordings());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listLocalRecordings().then((recordings) => {
      if (!cancelled) setPending(recordings);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentElapsed = () => {
    const clock = clockRef.current;
    return (
      clock.accumulated + (clock.runningSince === null ? 0 : performance.now() - clock.runningSince)
    );
  };

  // Timer.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'paused') return;
    const timer = setInterval(() => setElapsedMs(currentElapsed()), 250);
    return () => clearInterval(timer);
  }, [phase]);

  // Leaving the page while recording loses nothing already saved, but warn anyway.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'paused' && phase !== 'uploading') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  // Keeps a phone's screen (and so the recording) from going to sleep mid-meeting.
  const acquireWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (phase !== 'recording' && phase !== 'paused') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [phase, acquireWakeLock]);

  const releaseDevices = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => releaseDevices, [releaseDevices]);

  const send = useCallback(
    async (recording: LocalRecording) => {
      setPhase('uploading');
      setProgress(0);
      setError(null);
      try {
        const id = await uploadRecording(recording, setProgress);
        await deleteLocalRecording(recording.id).catch(() => undefined);
        router.push(`/yoz/${id}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase('idle');
        await refreshPending();
      }
    },
    [router, refreshPending],
  );

  const start = useCallback(async () => {
    setError(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(
        'Bu brauzer ovoz yozishni qo‘llab-quvvatlamaydi. Chrome yoki Safari’ning yangi versiyasini oching.',
      );
      return;
    }
    setPhase('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError(
        'Mikrofonga ruxsat berilmadi. Brauzer sozlamalarida mikrofonni yoqing va qayta urining.',
      );
      setPhase('idle');
      return;
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 48_000,
    });
    const recording: LocalRecording = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      mimeType: recorder.mimeType || mimeType,
      recordedMs: 0,
      chunks: [],
    };
    recordingRef.current = recording;
    recorderRef.current = recorder;

    const meta = (): LocalRecordingMeta => ({
      id: recording.id,
      startedAt: recording.startedAt,
      mimeType: recording.mimeType,
      recordedMs: recording.recordedMs,
      chunkCount: recording.chunks.length,
    });
    // Writes are chained so pieces land in IndexedDB in order and the final details come last.
    let saved: Promise<unknown> = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      recording.chunks.push(event.data);
      recording.recordedMs = currentElapsed();
      const snapshot = meta();
      saved = saved.then(() => appendLocalChunk(snapshot, event.data)).catch(() => undefined);
    };
    recorder.onstop = () => {
      recording.recordedMs = currentElapsed();
      releaseDevices();
      const snapshot = meta();
      saved = saved.then(() => saveLocalRecordingMeta(snapshot)).catch(() => undefined);
      void saved.then(() => send(recording));
    };
    // The microphone can be taken away mid-meeting (a phone call, another app, a lost headset). Stop
    // cleanly so everything recorded until then is uploaded, and say why.
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (recorder.state === 'inactive') return;
        setError(
          'Mikrofon uzilib qoldi (qo‘ng‘iroq yoki boshqa ilova). Shu paytgacha yozilgani yuborildi.',
        );
        const clock = clockRef.current;
        clock.accumulated = currentElapsed();
        clock.runningSince = null;
        setPhase('uploading');
        recorder.stop();
      };
    });

    // Level meter.
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // The meter is cosmetic; recording works without it.
    }

    clockRef.current = { runningSince: performance.now(), accumulated: 0 };
    setElapsedMs(0);
    recorder.start(SLICE_MS);
    void acquireWakeLock();
    setPhase('recording');
  }, [acquireWakeLock, releaseDevices, send]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
    const clock = clockRef.current;
    clock.accumulated = currentElapsed();
    clock.runningSince = null;
    setPhase('paused');
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    recorder.resume();
    clockRef.current.runningSince = performance.now();
    setPhase('recording');
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    const clock = clockRef.current;
    clock.accumulated = currentElapsed();
    clock.runningSince = null;
    setPhase('uploading');
    recorder.stop();
  }, []);

  const active = phase === 'recording' || phase === 'paused';

  return (
    <div className="flex flex-col items-center">
      {warnings.length > 0 ? (
        <div className="mb-6 w-full rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Sozlash tugallanmagan
          </p>
          <ul className="mt-2 list-disc pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <p className="mt-2">
            Yozib olish ishlaydi, lekin tahlil kalitlar qo‘shilgandan keyin bajariladi.
          </p>
        </div>
      ) : null}

      <div className="relative flex h-64 w-64 items-center justify-center">
        {phase === 'recording' ? (
          <span
            className="absolute inset-0 rounded-full bg-red-500/20 transition-transform duration-100"
            style={{ transform: `scale(${0.82 + level * 0.35})` }}
            aria-hidden
          />
        ) : null}
        {!active ? (
          <button
            type="button"
            onClick={start}
            disabled={phase !== 'idle'}
            className="relative flex h-56 w-56 flex-col items-center justify-center rounded-full bg-teal-700 text-white shadow-xl transition hover:bg-teal-800 active:scale-95 disabled:opacity-60"
            aria-label="Yozishni boshlash"
          >
            <Mic className="h-20 w-20" />
            <span className="mt-3 text-lg font-semibold">
              {phase === 'starting'
                ? 'Tayyorlanmoqda…'
                : phase === 'uploading'
                  ? 'Yuborilmoqda…'
                  : 'Boshlash'}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="relative flex h-56 w-56 flex-col items-center justify-center rounded-full bg-red-600 text-white shadow-xl transition hover:bg-red-700 active:scale-95"
            aria-label="Yozishni tugatish"
          >
            <Square className="h-16 w-16 fill-current" />
            <span className="mt-3 text-lg font-semibold">Tugatish</span>
          </button>
        )}
      </div>

      <p
        className="mt-6 font-mono text-5xl font-semibold tabular-nums text-slate-900"
        aria-live="polite"
      >
        {formatTimestamp(elapsedMs)}
      </p>
      <p className="mt-2 text-sm text-slate-500">
        {phase === 'recording'
          ? 'Yozilmoqda — telefonni stol ustiga qo‘ying'
          : phase === 'paused'
            ? 'Pauza'
            : phase === 'uploading'
              ? `Yuborilmoqda… ${Math.round(progress * 100)}%`
              : 'Suhbat boshlanishidan oldin bir marta bosing'}
      </p>

      {active ? (
        <button
          type="button"
          onClick={phase === 'recording' ? pause : resume}
          className="mt-6 inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-6 py-3 font-medium text-slate-700 hover:bg-slate-50"
        >
          {phase === 'recording' ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          {phase === 'recording' ? 'Pauza' : 'Davom ettirish'}
        </button>
      ) : null}

      {error ? (
        <p
          className="mt-6 max-w-md rounded-lg bg-red-50 px-4 py-3 text-center text-sm text-red-800"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {phase === 'idle' && pending.length > 0 ? (
        <div className="mt-8 w-full rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold text-slate-900">Yuborilmagan yozuvlar</p>
          <p className="mt-1 text-xs text-slate-500">
            Bu yozuvlar shu qurilmada saqlangan, lekin serverga yetib bormagan.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
            {pending.map((recording) => (
              <li
                key={recording.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="text-slate-700">
                  {formatDateTime(recording.startedAt)} · {formatTimestamp(recording.recordedMs)}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const stored = await loadLocalRecording(recording.id);
                      if (stored && stored.chunks.length > 0) await send(stored);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-teal-700 px-3 py-1.5 font-medium text-white hover:bg-teal-800"
                  >
                    <UploadCloud className="h-4 w-4" /> Yuborish
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.confirm('Bu yozuv butunlay o‘chirilsinmi?')) return;
                      await deleteLocalRecording(recording.id);
                      await refreshPending();
                    }}
                    className="inline-flex items-center rounded-lg border border-slate-200 px-2 py-1.5 text-slate-500 hover:bg-slate-50"
                    aria-label="O‘chirish"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
