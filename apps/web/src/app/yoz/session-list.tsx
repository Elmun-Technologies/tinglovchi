import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { formatDateTime, formatDuration } from '../../lib/quick/format';
import type { SessionSummary } from '../../lib/quick/types';

const STATUS_LABELS: Record<SessionSummary['status'], string> = {
  uploaded: 'Navbatda',
  transcribing: 'Matnga aylantirilmoqda',
  analyzing: 'Tahlil qilinmoqda',
  ready: 'Tayyor',
  failed: 'Xatolik',
};

export function SessionList({ sessions }: { sessions: SessionSummary[] }) {
  if (sessions.length === 0) {
    return <p className="text-sm text-slate-500">Hali suhbat yozilmagan.</p>;
  }
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
      {sessions.map((session) => (
        <li key={session.id}>
          <Link
            href={`/yoz/${session.id}`}
            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium text-slate-900">
                {session.title ?? 'Nomsiz suhbat'}
              </span>
              <span className="text-xs text-slate-500">
                {formatDateTime(session.createdAt)} · {formatDuration(session.recordedMs)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs">
              <span
                className={
                  session.status === 'ready'
                    ? 'rounded-full bg-teal-50 px-2 py-0.5 text-teal-800'
                    : session.status === 'failed'
                      ? 'rounded-full bg-red-50 px-2 py-0.5 text-red-700'
                      : 'rounded-full bg-amber-50 px-2 py-0.5 text-amber-800'
                }
              >
                {STATUS_LABELS[session.status]}
              </span>
              <ChevronRight className="h-4 w-4 text-slate-400" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
