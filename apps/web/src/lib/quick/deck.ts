import { formatDateTime, formatDuration } from './format';
import { speakerName } from './speakers';
import type { Analysis, Session } from './types';

/**
 * The presentation for one conversation: a title slide and a slide of measured facts (duration, who spoke
 * how much), then the model's slides, the mind map and the roadmap. Shared by the slide preview, the
 * browser download and the .pptx the Telegram bot sends.
 */

export type DeckSlide = { title: string; subtitle?: string; bullets: string[] };

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
    ...(analysis.mindMap.branches.length > 0
      ? [
          {
            title: `Mind map: ${analysis.mindMap.center}`,
            bullets: analysis.mindMap.branches.map((branch) =>
              branch.children.length > 0
                ? `${branch.title}: ${branch.children.join(', ')}`
                : branch.title,
            ),
          },
        ]
      : []),
    ...(analysis.roadmap.length > 0
      ? [
          {
            title: 'Roadmap',
            bullets: analysis.roadmap.map(
              (phase, index) =>
                `${index + 1}. ${phase.phase}${phase.timeframe ? ` (${phase.timeframe})` : ''}: ${phase.items.join('; ')}`,
            ),
          },
        ]
      : []),
  ];
}

const ACCENT = '0F766E';

/**
 * Builds the .pptx. In the browser it downloads `fileName`; on the server (Telegram) it returns the bytes.
 */
export async function writePptx(deck: DeckSlide[], target: { fileName: string }): Promise<void>;
export async function writePptx(deck: DeckSlide[], target: 'buffer'): Promise<Buffer>;
export async function writePptx(
  deck: DeckSlide[],
  target: { fileName: string } | 'buffer',
): Promise<Buffer | void> {
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
  if (target === 'buffer') return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  await pptx.writeFile({ fileName: target.fileName });
}
