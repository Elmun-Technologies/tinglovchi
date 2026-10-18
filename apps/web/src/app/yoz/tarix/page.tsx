import { hasAccess } from '../../../lib/quick/access';
import { formatDuration, formatUsd, totalCostUsd } from '../../../lib/quick/format';
import { listSessions } from '../../../lib/quick/store';
import { AccessGate } from '../gate';
import { SessionList } from '../session-list';

export const dynamic = 'force-dynamic';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export default async function HistoryPage() {
  const sessions = (await hasAccess()) ? await listSessions() : [];
  const now = new Date();
  const thisMonth = sessions.filter((session) => {
    const created = new Date(session.createdAt);
    return created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth();
  });
  const monthMs = thisMonth.reduce((sum, session) => sum + session.recordedMs, 0);
  const monthCost = thisMonth.reduce((sum, session) => sum + (totalCostUsd(session.usage) ?? 0), 0);

  return (
    <AccessGate>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-slate-900">
        Barcha suhbatlar
      </h1>
      {sessions.length > 0 ? (
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Shu oy suhbatlar" value={String(thisMonth.length)} />
          <Stat label="Shu oy yozilgan vaqt" value={formatDuration(monthMs)} />
          <Stat label="Shu oy tannarx (taxminiy)" value={formatUsd(monthCost)} />
        </div>
      ) : null}
      <SessionList sessions={sessions} />
    </AccessGate>
  );
}
