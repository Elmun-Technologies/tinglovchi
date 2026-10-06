import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { exchangeCodeForSession } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn<() => Promise<{ error: Error | null }>>(),
}));

vi.mock('@suhbat/database/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession },
  }),
}));

const environmentKeys = [
  'NODE_ENV',
  'APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const;

type EnvironmentKey = (typeof environmentKeys)[number];

const originalEnvironment = new Map<EnvironmentKey, string | undefined>(
  environmentKeys.map((key) => [key, process.env[key]]),
);

function setEnvironment(values: Partial<Record<EnvironmentKey, string>>): void {
  for (const key of environmentKeys) {
    const value = values[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
}

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  exchangeCodeForSession.mockResolvedValue({ error: null });
  setEnvironment({
    NODE_ENV: 'production',
    APP_URL: 'https://app.example.test',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-test-key',
  });
});

afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
});

describe('auth callback redirect destination', () => {
  it('redirects to the canonical app origin, not the request host', async () => {
    const { GET } = await import('../../apps/web/src/app/auth/callback/route');
    const request = new Request('http://attacker.example/auth/callback?code=one-time-code', {
      headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
    });

    const response = await GET(request as unknown as NextRequest);

    expect(exchangeCodeForSession).toHaveBeenCalledWith('one-time-code');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.test/');
  });

  it('returns exchange failures to the canonical login page', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ error: new Error('invalid code') });
    const { GET } = await import('../../apps/web/src/app/auth/callback/route');
    const request = new Request('http://attacker.example/auth/callback?code=bad-code');

    const response = await GET(request as unknown as NextRequest);

    expect(response.headers.get('location')).toBe(
      'https://app.example.test/login?error=auth-callback',
    );
  });

  it('fails closed when the configured APP_URL is not a valid canonical origin', async () => {
    setEnvironment({ APP_URL: 'http://attacker.example' });
    const { GET } = await import('../../apps/web/src/app/auth/callback/route');
    const request = new Request('http://legit-host.example/auth/callback?code=one-time-code');

    await expect(GET(request as unknown as NextRequest)).rejects.toThrow(/HTTPS/);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
