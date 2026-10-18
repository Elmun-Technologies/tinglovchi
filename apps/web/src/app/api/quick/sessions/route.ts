import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error, json } from '../../../../lib/quick/http';
import { ensureProcessing } from '../../../../lib/quick/pipeline';
import { audioExtension, createSession, listSessions } from '../../../../lib/quick/store';

// Two hours of compressed speech is well under this; anything larger is not a meeting recording.
const MAX_AUDIO_BYTES = 300 * 1024 * 1024;

export async function GET() {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  return json({ sessions: await listSessions() });
}

export async function POST(request: NextRequest) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) return error(413, 'Audio fayl juda katta.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error(400, 'So‘rov audio faylni o‘z ichiga olmagan.');
  }
  const audio = form.get('audio');
  if (!(audio instanceof Blob) || audio.size === 0) return error(400, 'Audio fayl bo‘sh.');
  if (audio.size > MAX_AUDIO_BYTES) return error(413, 'Audio fayl juda katta.');
  const mimeType = audio.type || 'audio/webm';
  if (!audioExtension(mimeType))
    return error(415, `Bu audio formati qo‘llab-quvvatlanmaydi: ${mimeType}`);

  const recordedMs = Math.max(0, Number(form.get('recordedMs') ?? 0) || 0);
  const rawTitle = form.get('title');
  const title =
    typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 200) : null;

  const session = await createSession({
    audio: new Uint8Array(await audio.arrayBuffer()),
    mimeType,
    recordedMs,
    title,
  });
  ensureProcessing(session);
  return json({ id: session.id }, 201);
}
