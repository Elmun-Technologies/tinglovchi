'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ClipboardCopy,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { formatDateTime, formatDuration } from '../../../lib/quick/format';
import type { Session } from '../../../lib/quick/types';
import { MindMap } from './mind-map';
import { Overview, summaryAsText } from './overview';
import { Roadmap } from './roadmap';
import { Slides } from './slides';
import { TranscriptView } from './transcript-view';

const STEPS: Array<{ status: Session['status']; label: string }> = [
  { status: 'uploaded', label: 'Yozuv qabul qilindi' },
  { status: 'transcribing', label: 'Nutq matnga aylantirilmoqda' },
  { status: 'analyzing', label: 'Suhbat tahlil qilinmoqda' },
  { status: 'ready', label: 'Tayyor' },
];

const TABS = [
  { key: 'overview', label: 'Xulosa' },
  { key: 'mindmap', label: 'Mind map' },
  { key: 'roadmap', label: 'Roadmap' },
  { key: 'slides', label: 'Prezentatsiya' },
  { key: 'transcript', label: 'Transkript' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function unfinished(session: Session): boolean {
  return session.status !== 'ready' && session.status !== 'failed';
}

export function SessionView({ initial }: { initial: Session }) {
  const router = useRouter();
  const [session, setSession] = useState(initial);
  const [tab, setTab] = useState<TabKey>('overview');
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!unfinished(session)) return;
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/quick/sessions/${session.id}`, {
        cache: 'no-store',
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { session?: Session } | null;
      // A failed poll keeps the current state; the timer fires again because `session` is reset.
      setSession((current) => body?.session ?? { ...current });
    }, 3_000);
    return () => clearTimeout(timer);
  }, [session]);

  const retry = async () => {
    const response = await fetch(`/api/quick/sessions/${session.id}/retry`, { method: 'POST' });
    const body = (await response.json().catch(() => null)) as { session?: Session } | null;
    if (body?.session) setSession(body.session);
  };

  const remove = async () => {
    if (!window.confirm('Suhbat, audio va tahlil butunlay o‘chirilsinmi?')) return;
    await fetch(`/api/quick/sessions/${session.id}`, { method: 'DELETE' });
    router.push('/yoz');
    router.refresh();
  };

  const seek = (ms: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = ms / 1000;
    void audio.play().catch(() => undefined);
  };

  const durationMs = session.transcript?.durationMs || session.recordedMs;
  const analysis = session.analysis;

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">
            {analysis?.conversationType ?? 'Suhbat'}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            {session.title ?? analysis?.title ?? 'Nomsiz suhbat'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {formatDateTime(session.createdAt)} · {formatDuration(durationMs)}
            {session.speakerStats.length > 0 ? ` · ${session.speakerStats.length} ishtirokchi` : ''}
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          {analysis ? (
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(summaryAsText(session));
                setCopied(true);
                setTimeout(() => setCopied(false), 2_000);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ClipboardCopy className="h-4 w-4" /> {copied ? 'Nusxalandi' : 'Xulosani nusxalash'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={remove}
            className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-500 hover:bg-slate-50"
            aria-label="O‘chirish"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      <audio
        ref={audioRef}
        controls
        preload="none"
        src={`/api/quick/sessions/${session.id}/audio`}
        className="mt-5 w-full print:hidden"
      />

      {unfinished(session) ? <Progress session={session} /> : null}

      {session.status === 'failed' ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-5">
          <p className="flex items-center gap-2 font-semibold text-red-800">
            <AlertTriangle className="h-5 w-5" /> Tahlil tugallanmadi
          </p>
          <p className="mt-2 text-sm text-red-800">{session.error ?? 'Noma’lum xato.'}</p>
          <p className="mt-2 text-sm text-red-700">
            Audio saqlangan — qayta urinib ko‘rishingiz mumkin.
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
          >
            <RotateCcw className="h-4 w-4" /> Qayta urinish
          </button>
        </div>
      ) : null}

      {analysis ? (
        <>
          <nav
            className="mt-8 flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden"
            role="tablist"
          >
            {TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                onClick={() => setTab(entry.key)}
                className={
                  tab === entry.key
                    ? '-mb-px whitespace-nowrap border-b-2 border-teal-700 px-4 py-2 text-sm font-semibold text-teal-800'
                    : 'whitespace-nowrap px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-800'
                }
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="mt-6">
            {tab === 'overview' ? <Overview session={session} analysis={analysis} /> : null}
            {tab === 'mindmap' ? <MindMap map={analysis.mindMap} /> : null}
            {tab === 'roadmap' ? <Roadmap phases={analysis.roadmap} /> : null}
            {tab === 'slides' ? <Slides session={session} analysis={analysis} /> : null}
            {tab === 'transcript' && session.transcript ? (
              <TranscriptView transcript={session.transcript} analysis={analysis} onSeek={seek} />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Progress({ session }: { session: Session }) {
  const current = STEPS.findIndex((step) => step.status === session.status);
  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
      <ol className="space-y-3">
        {STEPS.map((step, index) => (
          <li key={step.status} className="flex items-center gap-3 text-sm">
            {index < current ? (
              <CheckCircle2 className="h-5 w-5 text-teal-700" />
            ) : index === current ? (
              <Loader2 className="h-5 w-5 animate-spin text-teal-700" />
            ) : (
              <Circle className="h-5 w-5 text-slate-300" />
            )}
            <span className={index <= current ? 'text-slate-900' : 'text-slate-400'}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-slate-500">
        Bir soatlik suhbat odatda bir necha daqiqada tayyor bo‘ladi. Sahifani yopishingiz mumkin —
        natija «Barcha suhbatlar»da paydo bo‘ladi.
      </p>
      {session.error ? (
        <p className="mt-2 text-xs text-amber-700">
          Oxirgi urinishda xato: {session.error}. Qayta urinilmoqda…
        </p>
      ) : null}
    </div>
  );
}
