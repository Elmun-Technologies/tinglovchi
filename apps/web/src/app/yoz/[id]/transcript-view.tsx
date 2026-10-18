import { formatTimestamp } from '../../../lib/quick/format';
import type { Analysis, Transcript } from '../../../lib/quick/types';
import { speakerColor, speakerName } from '../../../lib/quick/speakers';

export function TranscriptView({
  transcript,
  analysis,
  onSeek,
}: {
  transcript: Transcript;
  analysis: Analysis | null;
  onSeek: (ms: number) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <p className="border-b border-slate-100 px-5 py-3 text-xs text-slate-500">
        Avtomatik transkript — ayrim so‘zlar noto‘g‘ri tanilgan bo‘lishi mumkin. Vaqtni bossangiz
        audio shu joydan boshlanadi.
      </p>
      <ol className="divide-y divide-slate-50">
        {transcript.utterances.map((utterance, index) => (
          <li key={index} className="grid grid-cols-[4rem_1fr] gap-3 px-5 py-3">
            <button
              type="button"
              onClick={() => onSeek(utterance.startMs)}
              className="self-start font-mono text-xs text-teal-700 hover:underline"
            >
              {formatTimestamp(utterance.startMs)}
            </button>
            <div>
              <p
                className="text-xs font-semibold"
                style={{ color: speakerColor(utterance.speaker) }}
              >
                {speakerName(utterance.speaker, analysis)}
              </p>
              <p className="mt-0.5 text-sm leading-relaxed text-slate-800">{utterance.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
