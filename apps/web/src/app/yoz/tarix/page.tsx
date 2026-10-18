import { hasAccess } from '../../../lib/quick/access';
import { listSessions } from '../../../lib/quick/store';
import { AccessGate } from '../gate';
import { SessionList } from '../session-list';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  return (
    <AccessGate>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-slate-900">
        Barcha suhbatlar
      </h1>
      <SessionList sessions={(await hasAccess()) ? await listSessions() : []} />
    </AccessGate>
  );
}
