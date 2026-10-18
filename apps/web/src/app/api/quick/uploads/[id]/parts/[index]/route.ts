import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../../../../lib/quick/http';
import { uploadExists, writeUploadPart } from '../../../../../../../lib/quick/store';

// The recorder sends 4 MB parts; the cap leaves headroom without letting one request grow unbounded.
const MAX_PART_BYTES = 16 * 1024 * 1024;

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string; index: string }> },
) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id, index } = await context.params;
  const partIndex = Number(index);
  if (!/^\d+$/.test(index) || !Number.isSafeInteger(partIndex)) {
    return error(400, 'Qism raqami noto‘g‘ri.');
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_PART_BYTES) {
    return error(413, 'Qism juda katta.');
  }
  if (!(await uploadExists(id))) return error(404, 'Yuklash topilmadi.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return error(400, 'Qism bo‘sh.');
  if (bytes.byteLength > MAX_PART_BYTES) return error(413, 'Qism juda katta.');
  await writeUploadPart(id, partIndex, bytes);
  return json({ ok: true });
}
