import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../../../lib/quick/http';
import { ensureProcessing } from '../../../../../../lib/quick/pipeline';
import { finishUpload, MissingPartsError, uploadExists } from '../../../../../../lib/quick/store';
import { analysisLanguageSchema, captureModeSchema } from '../../../../../../lib/quick/types';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id } = await context.params;
  if (!(await uploadExists(id))) return error(404, 'Yuklash topilmadi.');

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const partCount = Number(body?.partCount);
  if (!Number.isInteger(partCount) || partCount < 1) return error(400, 'Qismlar soni noto‘g‘ri.');
  const title =
    typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : null;

  try {
    const session = await finishUpload(id, {
      partCount,
      recordedMs: Math.max(0, Number(body?.recordedMs) || 0),
      title,
      language: analysisLanguageSchema.catch('uz').parse(body?.language),
      captureMode: captureModeSchema.catch('mic').parse(body?.captureMode),
    });
    ensureProcessing(session);
    return json({ id: session.id }, 201);
  } catch (cause) {
    if (cause instanceof MissingPartsError) {
      return json({ error: 'Ba’zi qismlar yetib kelmagan.', missing: cause.missing }, 409);
    }
    throw cause;
  }
}
