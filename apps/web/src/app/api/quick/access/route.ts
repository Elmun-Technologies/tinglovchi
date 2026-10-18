import type { NextRequest } from 'next/server';
import { grantAccess } from '../../../../lib/quick/access';
import { error, json } from '../../../../lib/quick/http';

// In-memory per-client attempt budget; enough to stop guessing the shared code from one address.
const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: NextRequest): string {
  return (
    request.headers.get('fly-client-ip') ??
    request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() ??
    'local'
  );
}

export async function POST(request: NextRequest) {
  const key = clientKey(request);
  const now = Date.now();
  const entry = attempts.get(key);
  const budget = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + WINDOW_MS };
  if (budget.count >= MAX_ATTEMPTS)
    return error(429, 'Juda ko‘p urinish. 10 daqiqadan keyin qayta urining.');
  budget.count += 1;
  attempts.set(key, budget);

  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!code || !(await grantAccess(code))) return error(401, 'Kod noto‘g‘ri.');
  attempts.delete(key);
  return json({ ok: true });
}
