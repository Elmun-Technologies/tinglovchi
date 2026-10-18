import { formatDateTime, formatDuration } from './format';
import type { Session } from './types';

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
