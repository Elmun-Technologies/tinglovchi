import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../../lib/quick/http';
import { uploadExists, uploadedParts } from '../../../../../lib/quick/store';

/** Lists the parts already received, so an interrupted upload resumes instead of restarting. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id } = await context.params;
  if (!(await uploadExists(id))) return error(404, 'Yuklash topilmadi.');
  return json({ parts: await uploadedParts(id) });
}
