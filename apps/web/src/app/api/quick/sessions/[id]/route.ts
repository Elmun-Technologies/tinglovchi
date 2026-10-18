import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../../lib/quick/http';
import { ensureProcessing } from '../../../../../lib/quick/pipeline';
import { deleteSession, readSession } from '../../../../../lib/quick/store';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id } = await context.params;
  const session = await readSession(id);
  if (!session) return error(404, 'Suhbat topilmadi.');
  // Resumes work a restart interrupted; a no-op while this process is already on it.
  ensureProcessing(session);
  return json({ session });
}

export async function DELETE(_request: NextRequest, context: Context) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id } = await context.params;
  if (!(await readSession(id))) return error(404, 'Suhbat topilmadi.');
  await deleteSession(id);
  return json({ deleted: true });
}
