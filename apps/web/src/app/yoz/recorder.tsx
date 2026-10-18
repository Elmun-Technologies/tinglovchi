'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Mic,
  MonitorSpeaker,
  Pause,
  Play,
  Square,
  Trash2,
  UploadCloud,
  Users,
} from 'lucide-react';
import { formatDateTime, formatTimestamp } from '../../lib/quick/format';
import {
  appendLocalChunk,
  deleteLocalRecording,
  listLocalRecordings,
  loadLocalRecording,
  saveLocalRecordingMeta,
  type LocalRecording,
  type LocalRecordingMeta,
} from '../../lib/quick/local-recordings';
import { uploadRecording } from '../../lib/quick/upload-client';

type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'uploading';
type Language = 'uz' | 'ru' | 'en';
type CaptureMode = 'mic' | 'mic_and_system';

// MediaRecorder delivers a piece this often; each piece is also saved locally.
const SLICE_MS = 5_000;

const LANGUAGES: Array<{ value: Language; label: string }> = [
  { value: 'uz', label: 'O‘zbekcha' },
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
];

// Some systems hand over a file with no type (often .m4a on Windows); the name tells it instead.
const EXTENSION_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  amr: 'audio/amr',
  '3gp': 'audio/3gpp',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

function fileType(file: File): string {
  if (file.type) return file.type;
  return EXTENSION_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

/* ------------------------------------------------------ remembered choices */

const PREFERENCE_EVENT = 'suhbat-preference';

function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice simply is not remembered.
  }
  window.dispatchEvent(new Event(PREFERENCE_EVENT));
}

function subscribePreference(onChange: () => void): () => void {
  window.addEventListener(PREFERENCE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(PREFERENCE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function usePreference<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const value = useSyncExternalStore(
    subscribePreference,
    () => readPreference(key, allowed, fallback),
    () => fallback,
  );
  const set = useCallback((next: T) => writePreference(key, next), [key]);
  return [value, set] as const;
}

// Recording a call's sound needs screen-share with audio, which phones' browsers do not offer.
const noSubscription = () => () => undefined;
function useCanCaptureSystemAudio(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () =>
      typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
      !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
    () => false,
  );
}

/* ---------------------------------------------------------------- component */

export function Recorder({ warnings }: { warnings: string[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState<LocalRecordingMeta[]>([]);
  const [language, setLanguage] = usePreference<Language>(
    'suhbat.language',
    ['uz', 'ru', 'en'],
    'uz',
  );
  const [captureMode, setCaptureMode] = usePreference<CaptureMode>(
    'suhbat.captureMode',
    ['mic', 'mic_and_system'],
    'mic',
  );
  const canCaptureSystemAudio = useCanCaptureSystemAudio();
  const effectiveMode: CaptureMode = canCaptureSystemAudio ? captureMode : 'mic';

  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
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
    streamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    streamsRef.current = [];
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
        const id = await uploadRecording(recording, {
          onProgress: setProgress,
          onUploadId: async (uploadId) => {
            recording.uploadId = uploadId;
            // A picked file is not kept on the device by us; there is nothing to resume from.
            if (recording.captureMode === 'file') return;
            await saveLocalRecordingMeta({
              id: recording.id,
              startedAt: recording.startedAt,
              mimeType: recording.mimeType,
              recordedMs: recording.recordedMs,
              chunkCount: recording.chunks.length,
              language: recording.language,
              captureMode: recording.captureMode,
              uploadId,
            }).catch(() => undefined);
          },
        });
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

  /** Sends an existing recording — a phone dictaphone file, a Telegram voice note, a video. */
  const uploadFile = useCallback(
    async (file: File) => {
      const type = fileType(file);
      if (!type) {
        setError('Bu fayl turini tanib bo‘lmadi. Audio yoki video fayl tanlang.');
        return;
      }
      await send({
        id: crypto.randomUUID(),
        startedAt: new Date(file.lastModified || Date.now()).toISOString(),
        mimeType: type,
        recordedMs: 0,
        language,
        captureMode: 'file',
        uploadId: null,
        chunks: [file],
      });
    },
    [language, send],
  );

  /** Asks for the call's sound through the browser's share dialog; null if the user declined. */
  const requestSystemAudio = async (): Promise<MediaStream | null> => {
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        // Chrome: offer whole-system audio on Windows, and pre-select sharing a tab's sound.
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
    } catch {
      return null;
    }
    // Only the sound is recorded; the picture is dropped immediately.
    display.getVideoTracks().forEach((track) => track.stop());
    if (display.getAudioTracks().length === 0) {
      display.getTracks().forEach((track) => track.stop());
      return null;
    }
    return display;
  };

  const start = useCallback(async () => {
    setError(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(
        'Bu brauzer ovoz yozishni qo‘llab-quvvatlamaydi. Chrome yoki Safari’ning yangi versiyasini oching.',
      );
      return;
    }
    setPhase('starting');
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError(
        'Mikrofonga ruxsat berilmadi. Brauzer sozlamalarida mikrofonni yoqing va qayta urining.',
      );
      setPhase('idle');
      return;
    }
    streamsRef.current = [mic];

    let system: MediaStream | null = null;
    if (effectiveMode === 'mic_and_system') {
      system = await requestSystemAudio();
      if (!system) {
        releaseDevices();
        setError(
          'Qo‘ng‘iroq ovozi ulashilmadi. Oynada qo‘ng‘iroq tabini (yoki butun ekranni) tanlang va «Ovozni ham ulashish» katakchasini belgilang.',
        );
        setPhase('idle');
        return;
      }
      streamsRef.current.push(system);
    }

    // The microphone and the call's sound are mixed into one track; the meter listens to the mix.
    let recordStream: MediaStream = mic;
    let analyser: AnalyserNode | null = null;
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      if (system) {
        const destination = context.createMediaStreamDestination();
        context.createMediaStreamSource(mic).connect(destination);
        context.createMediaStreamSource(system).connect(destination);
        context.createMediaStreamSource(destination.stream).connect(analyser);
        recordStream = destination.stream;
      } else {
        context.createMediaStreamSource(mic).connect(analyser);
      }
    } catch {
      if (system) {
        releaseDevices();
        setError('Bu brauzerda qo‘ng‘iroq ovozini aralashtirib bo‘lmadi. Chrome’ni yangilang.');
        setPhase('idle');
        return;
      }
      // Without an AudioContext only the meter is lost; the microphone still records.
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(recordStream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 48_000,
    });
    const recording: LocalRecording = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      mimeType: recorder.mimeType || mimeType,
      recordedMs: 0,
      language,
      captureMode: effectiveMode,
      uploadId: null,
      chunks: [],
    };
    recorderRef.current = recorder;

    const meta = (): LocalRecordingMeta => ({
      id: recording.id,
      startedAt: recording.startedAt,
      mimeType: recording.mimeType,
      recordedMs: recording.recordedMs,
      chunkCount: recording.chunks.length,
      language: recording.language,
      captureMode: recording.captureMode,
      uploadId: null,
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
    // cleanly so everything recorded until then is uploaded, and say why. Ending the call's screen
    // share only removes the call's sound; the microphone keeps recording.
    mic.getAudioTracks().forEach((track) => {
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

    if (analyser) {
      const meter = analyser;
      const samples = new Uint8Array(meter.fftSize);
      const tick = () => {
        meter.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    }

    clockRef.current = { runningSince: performance.now(), accumulated: 0 };
    setElapsedMs(0);
    recorder.start(SLICE_MS);
    void acquireWakeLock();
    setPhase('recording');
  }, [acquireWakeLock, effectiveMode, language, releaseDevices, send]);

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

      {phase === 'idle' ? (
        <div className="mb-6 flex w-full flex-col gap-3">
          {canCaptureSystemAudio ? (
            <div
              className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1"
              role="radiogroup"
              aria-label="Uchrashuv turi"
            >
              {(
                [
                  { value: 'mic', label: 'Xonada', hint: 'mikrofon', icon: Users },
                  {
                    value: 'mic_and_system',
                    label: 'Onlayn qo‘ng‘iroq',
                    hint: 'Zoom/Meet ovozi ham',
                    icon: MonitorSpeaker,
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={captureMode === option.value}
                  onClick={() => setCaptureMode(option.value)}
                  className={
                    captureMode === option.value
                      ? 'flex flex-col items-center rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm'
                      : 'flex flex-col items-center rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800'
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <option.icon className="h-4 w-4" /> {option.label}
                  </span>
                  <span className="text-xs font-normal text-slate-500">{option.hint}</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="flex items-center justify-center gap-2 text-sm text-slate-600">
            Tahlil tili:
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as Language)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-slate-900"
            >
              {LANGUAGES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
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
      <p className="mt-2 text-center text-sm text-slate-500">
        {phase === 'recording'
          ? effectiveMode === 'mic_and_system'
            ? 'Yozilmoqda — mikrofon va qo‘ng‘iroq ovozi'
            : 'Yozilmoqda — ekranni yopmang, telefonni stol ustiga qo‘ying'
          : phase === 'paused'
            ? 'Pauza'
            : phase === 'uploading'
              ? `Yuborilmoqda… ${Math.round(progress * 100)}%`
              : 'Suhbat boshlanishidan oldin bir marta bosing'}
      </p>

      {phase === 'idle' ? (
        <>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-teal-800 hover:underline"
          >
            <UploadCloud className="h-4 w-4" /> yoki tayyor yozuvni yuklang (diktofon, video)
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/*,.m4a,.amr,.opus"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void uploadFile(file);
            }}
          />
        </>
      ) : null}

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
