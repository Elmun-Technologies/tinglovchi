import { notFound } from 'next/navigation';
import { hasAccess } from '../../../lib/quick/access';
import { ensureProcessing } from '../../../lib/quick/pipeline';
import { readSession } from '../../../lib/quick/store';
import { AccessGate } from '../gate';
import { SessionView } from './session-view';

export const dynamic = 'force-dynamic';

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasAccess())) return <AccessGate>{null}</AccessGate>;
  const { id } = await params;
  const session = await readSession(id);
  if (!session) notFound();
  ensureProcessing(session);
  return <SessionView initial={session} />;
}
