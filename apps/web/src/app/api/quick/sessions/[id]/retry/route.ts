import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../../../lib/quick/http';
import { retrySession } from '../../../../../../lib/quick/pipeline';

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id } = await context.params;
  const session = await retrySession(id);
  if (!session) return error(404, 'Suhbat topilmadi.');
  return json({ session });
}
