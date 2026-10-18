import 'server-only';
import { NextResponse } from 'next/server';
import { hasAccess } from './access';

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function error(status: number, message: string): NextResponse {
  return json({ error: message }, status);
}

/** Returns a 401 response when the caller has not entered the access code, otherwise null. */
export async function denyWithoutAccess(): Promise<NextResponse | null> {
  return (await hasAccess()) ? null : error(401, 'Kirish kodi talab qilinadi.');
}
