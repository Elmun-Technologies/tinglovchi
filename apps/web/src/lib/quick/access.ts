import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * One shared access code (`SUHBAT_ACCESS_CODE`) guards the one-button flow: recordings are confidential
 * client conversations. The cookie holds an HMAC of the code, never the code itself.
 *
 * In production the code is mandatory; without it nothing is served. In development an unset code leaves
 * the flow open so it can be tried locally.
 */

export const ACCESS_COOKIE = 'suhbat_access';

function accessCode(): string | null {
  return process.env.SUHBAT_ACCESS_CODE?.trim() || null;
}

export type AccessState = 'open' | 'granted' | 'required' | 'not_configured';

function token(code: string): string {
  return createHmac('sha256', code).update('suhbat-access-v1').digest('hex');
}

export function tokenMatches(candidate: string | undefined, code: string): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(token(code));
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function accessState(): Promise<AccessState> {
  const code = accessCode();
  if (!code) return process.env.NODE_ENV === 'production' ? 'not_configured' : 'open';
  const store = await cookies();
  return tokenMatches(store.get(ACCESS_COOKIE)?.value, code) ? 'granted' : 'required';
}

export async function hasAccess(): Promise<boolean> {
  const state = await accessState();
  return state === 'open' || state === 'granted';
}

/** Checks a submitted code and, when it matches, sets the access cookie. */
export async function grantAccess(submitted: string): Promise<boolean> {
  const code = accessCode();
  if (!code) return false;
  const a = Buffer.from(submitted.trim());
  const b = Buffer.from(code);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const store = await cookies();
  store.set(ACCESS_COOKIE, token(code), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  });
  return true;
}
