import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../lib/quick/http';
import { audioExtension, startUpload } from '../../../../lib/quick/store';

/** Starts a chunked upload: the recorder then PUTs parts and finishes with `/finish`. */
export async function POST(request: NextRequest) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { mimeType?: unknown } | null;
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : '';
  if (!audioExtension(mimeType)) {
    return error(415, `Bu audio formati qo‘llab-quvvatlanmaydi: ${mimeType || 'noma’lum'}`);
  }
  return json({ uploadId: await startUpload(mimeType) }, 201);
}
