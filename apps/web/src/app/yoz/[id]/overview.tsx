import type { ReactNode } from 'react';
import { CheckCircle2, CircleDashed } from 'lucide-react';
import { formatDateTime, formatDuration } from '../../../lib/quick/format';
import type { Analysis, Session } from '../../../lib/quick/types';
import { speakerColor, speakerName } from './speakers';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Bullets({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">{empty ?? 'Aytilmagan'}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function BriefRow({ label, value }: { label: string; value: string | string[] | null }) {
  const text = Array.isArray(value) ? value.join(', ') : value;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className={text ? 'text-slate-900' : 'text-slate-400'}>{text || 'Aytilmagan'}</dd>
    </div>
  );
}

export function Overview({ session, analysis }: { session: Session; analysis: Analysis }) {
  const brief = analysis.clientBrief;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Section title="Umumiy xulosa">
          <p className="text-[15px] leading-relaxed text-slate-800">{analysis.summary}</p>
          {analysis.keyPoints.length > 0 ? (
            <div className="mt-4">
              <Bullets items={analysis.keyPoints} />
            </div>
          ) : null}
        </Section>

        <Section title="Nimalar haqida gaplashildi">
          <div className="space-y-3">
            {analysis.topics.map((topic, index) => (
              <div key={index}>
                <p className="font-medium text-slate-900">{topic.title}</p>
                <p className="text-sm text-slate-600">{topic.summary}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Qarorlar">
          {analysis.decisions.length === 0 ? (
            <p className="text-sm text-slate-400">Aniq qaror qabul qilinmagan</p>
          ) : (
            <ul className="space-y-2">
              {analysis.decisions.map((decision, index) => (
                <li key={index} className="flex gap-2 text-sm text-slate-800">
                  {decision.confirmed ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                  ) : (
                    <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  )}
                  <span>
                    {decision.text}
                    {decision.confirmed ? null : (
                      <span className="ml-2 text-xs text-amber-700">(taklif, kelishilmagan)</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Vazifalar">
          {analysis.tasks.length === 0 ? (
            <p className="text-sm text-slate-400">Vazifa belgilanmagan</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Vazifa</th>
                    <th className="py-2 pr-3 font-medium">Kim</th>
                    <th className="py-2 font-medium">Muddat</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {analysis.tasks.map((task, index) => (
                    <tr key={index}>
                      <td className="py-2 pr-3 text-slate-900">{task.task}</td>
                      <td className="py-2 pr-3 text-slate-600">{task.owner ?? '—'}</td>
                      <td className="py-2 text-slate-600">{task.deadline ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <div className="grid gap-5 md:grid-cols-2">
          <Section title="Keyingi qadamlar">
            <Bullets items={analysis.nextSteps} />
          </Section>
          <Section title="Ochiq savollar">
            <Bullets items={analysis.openQuestions} empty="Yo‘q" />
          </Section>
        </div>
      </div>

      <div className="space-y-5">
        <Section title="Kim qancha gapirdi">
          <ul className="space-y-3">
            {session.speakerStats.map((stat) => (
              <li key={stat.speaker}>
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-slate-900">
                    {speakerName(stat.speaker, analysis)}
                  </span>
                  <span className="text-slate-500">
                    {formatDuration(stat.talkMs)} · {Math.round(stat.share * 100)}%
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${stat.share * 100}%`,
                      background: speakerColor(stat.speaker),
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Mijoz brifi">
          <dl className="divide-y divide-slate-100">
            <BriefRow label="Kompaniya" value={brief.company} />
            <BriefRow label="Mahsulot" value={brief.product} />
            <BriefRow label="Maqsadlar" value={brief.goals} />
            <BriefRow label="Auditoriya" value={brief.targetAudience} />
            <BriefRow label="Byudjet" value={brief.budget} />
            <BriefRow label="KPI" value={brief.kpis} />
            <BriefRow label="Kanallar" value={brief.channels} />
            <BriefRow label="Muddatlar" value={brief.deadlines} />
            <BriefRow label="Cheklovlar" value={brief.constraints} />
          </dl>
        </Section>

        <Section title="Risklar">
          <Bullets items={analysis.risks} empty="Aniqlanmagan" />
        </Section>
      </div>
    </div>
  );
}

/** Plain-text version for pasting into Telegram, email or a CRM note. */
export function summaryAsText(session: Session): string {
  const analysis = session.analysis;
  if (!analysis) return '';
  const durationMs = session.transcript?.durationMs || session.recordedMs;
  const lines: string[] = [
    `📝 ${session.title ?? analysis.title}`,
    `${formatDateTime(session.createdAt)} · ${formatDuration(durationMs)}`,
    '',
    analysis.summary,
  ];
  const block = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push('', `${title}:`, ...items.map((item) => `• ${item}`));
  };
  block(
    'Qarorlar',
    analysis.decisions.map(
      (decision) => `${decision.text}${decision.confirmed ? '' : ' (taklif)'}`,
    ),
  );
  block(
    'Vazifalar',
    analysis.tasks.map((task) =>
      [task.task, task.owner ? `— ${task.owner}` : '', task.deadline ? `(${task.deadline})` : '']
        .filter(Boolean)
        .join(' '),
    ),
  );
  block('Keyingi qadamlar', analysis.nextSteps);
  block('Ochiq savollar', analysis.openQuestions);
  return lines.join('\n');
}
