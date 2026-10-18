import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { denyWithoutAccess, error } from '../../../../../../lib/quick/http';
import { audioPath, readSession } from '../../../../../../lib/quick/store';

/** Parses a single `bytes=start-end` range; null when absent or not satisfiable. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await denyWithoutAccess();
  if (denied) return denied;
  const { id } = await context.params;
  const session = await readSession(id);
  if (!session) return error(404, 'Suhbat topilmadi.');
  const { path, size } = await audioPath(session);

  // Range support lets the player seek, which the transcript's timestamps rely on.
  const range = parseRange(request.headers.get('range'), size);
  const headers: Record<string, string> = {
    'Content-Type': session.audioMimeType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="suhbat-${session.id.slice(0, 8)}.${session.audioFile.split('.').pop()}"`,
    'Cache-Control': 'private, no-store',
  };
  if (request.headers.has('range') && !range) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const stream = Readable.toWeb(
    createReadStream(path, { start, end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}
