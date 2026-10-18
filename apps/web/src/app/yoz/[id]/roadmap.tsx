import type { Analysis } from '../../../lib/quick/types';

export function Roadmap({ phases }: { phases: Analysis['roadmap'] }) {
  if (phases.length === 0) {
    return <p className="text-sm text-slate-500">Suhbatdan keyingi ishlar rejasi chiqmadi.</p>;
  }
  return (
    <ol className="relative space-y-6 border-l-2 border-teal-200 pl-8">
      {phases.map((phase, index) => (
        <li key={index} className="relative">
          <span className="absolute -left-[2.6rem] flex h-8 w-8 items-center justify-center rounded-full bg-teal-700 text-sm font-semibold text-white">
            {index + 1}
          </span>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold text-slate-900">{phase.phase}</p>
              {phase.timeframe ? (
                <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-800">
                  {phase.timeframe}
                </span>
              ) : null}
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {phase.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ol>
  );
}
