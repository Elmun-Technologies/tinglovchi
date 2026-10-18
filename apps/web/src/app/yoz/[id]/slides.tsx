'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { Analysis, Session } from '../../../lib/quick/types';
import { buildDeck, writePptx } from '../../../lib/quick/deck';

export function Slides({ session, analysis }: { session: Session; analysis: Analysis }) {
  const deck = buildDeck(session, analysis);
  const [busy, setBusy] = useState(false);
  const fileName = `${(session.title ?? analysis.title).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'suhbat'}.pptx`;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {deck.length} slayd · PowerPoint, Keynote va Google Slides’da ochiladi
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await writePptx(deck, { fileName });
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          PowerPoint yuklab olish
        </button>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {deck.map((slide, index) =>
          index === 0 ? (
            <div
              key={index}
              className="flex aspect-video flex-col justify-center rounded-xl bg-teal-700 p-8 text-white shadow-sm"
            >
              <p className="text-2xl font-bold leading-tight">{slide.title}</p>
              {slide.subtitle ? (
                <p className="mt-2 text-sm text-teal-100">{slide.subtitle}</p>
              ) : null}
            </div>
          ) : (
            <div
              key={index}
              className="relative aspect-video overflow-hidden rounded-xl border border-slate-200 bg-white p-6 pl-8 shadow-sm"
            >
              <span className="absolute inset-y-0 left-0 w-1.5 bg-teal-700" aria-hidden />
              <p className="text-lg font-bold text-slate-900">{slide.title}</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {slide.bullets.map((bullet, bulletIndex) => (
                  <li key={bulletIndex}>{bullet}</li>
                ))}
              </ul>
              <span className="absolute bottom-3 right-4 text-xs text-slate-400">{index + 1}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
