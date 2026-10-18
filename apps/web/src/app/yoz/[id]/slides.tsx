'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { formatDateTime, formatDuration } from '../../../lib/quick/format';
import type { Analysis, Session } from '../../../lib/quick/types';
import { speakerName } from './speakers';

type DeckSlide = { title: string; subtitle?: string; bullets: string[] };

/** The opening slides come from measured facts; the rest are the model's slides. */
export function buildDeck(session: Session, analysis: Analysis): DeckSlide[] {
  const durationMs = session.transcript?.durationMs || session.recordedMs;
  return [
    {
      title: session.title ?? analysis.title,
      subtitle: `${analysis.conversationType} · ${formatDateTime(session.createdAt)}`,
      bullets: [],
    },
    {
      title: 'Suhbat haqida',
      bullets: [
        `Davomiyligi: ${formatDuration(durationMs)}`,
        `Ishtirokchilar: ${session.speakerStats.length}`,
        ...session.speakerStats.map(
          (stat) =>
            `${speakerName(stat.speaker, analysis)} — ${Math.round(stat.share * 100)}% (${formatDuration(stat.talkMs)})`,
        ),
      ],
    },
    ...analysis.slides.map((slide) => ({ title: slide.title, bullets: slide.bullets })),
  ];
}

const ACCENT = '0F766E';

async function downloadPptx(deck: DeckSlide[], fileName: string) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  deck.forEach((entry, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: index === 0 ? ACCENT : 'FFFFFF' };
    if (index === 0) {
      slide.addText(entry.title, {
        x: 0.8,
        y: 2.3,
        w: 11.7,
        h: 1.6,
        fontSize: 40,
        bold: true,
        color: 'FFFFFF',
        fontFace: 'Arial',
      });
      if (entry.subtitle) {
        slide.addText(entry.subtitle, {
          x: 0.8,
          y: 3.9,
          w: 11.7,
          h: 0.6,
          fontSize: 18,
          color: 'CCFBF1',
          fontFace: 'Arial',
        });
      }
      return;
    }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: ACCENT } });
    slide.addText(entry.title, {
      x: 0.7,
      y: 0.5,
      w: 11.9,
      h: 0.9,
      fontSize: 30,
      bold: true,
      color: '0F172A',
      fontFace: 'Arial',
    });
    if (entry.bullets.length > 0) {
      slide.addText(
        entry.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        {
          x: 0.7,
          y: 1.6,
          w: 11.9,
          h: 5.3,
          fontSize: 20,
          color: '334155',
          fontFace: 'Arial',
          valign: 'top',
          paraSpaceAfter: 10,
        },
      );
    }
    slide.addText(`${index + 1}`, {
      x: 12.3,
      y: 6.9,
      w: 0.6,
      h: 0.4,
      fontSize: 11,
      color: '94A3B8',
      align: 'right',
    });
  });
  await pptx.writeFile({ fileName });
}

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
              await downloadPptx(deck, fileName);
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
