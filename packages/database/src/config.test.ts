import { afterEach, describe, expect, it } from 'vitest';
import { getCanonicalAppUrl, getSupabasePublicConfig, isSupabaseConfigured } from './config';

const originalAppUrl = process.env.APP_URL;
const originalNodeEnv = process.env.NODE_ENV;
const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalSupabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else Reflect.set(process.env, 'NODE_ENV', value);
}

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  setNodeEnv(originalNodeEnv);
  if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalSupabaseKey;
});

describe('canonical application URL configuration', () => {
  it('uses the localhost default only in development', () => {
    setNodeEnv('development');
    delete process.env.APP_URL;

    expect(getCanonicalAppUrl().origin).toBe('http://localhost:3000');
  });

  it('requires an explicit HTTPS origin outside development', () => {
    setNodeEnv('production');
    delete process.env.APP_URL;

    expect(() => getCanonicalAppUrl()).toThrow(/APP_URL must be explicitly configured/);
  });

  it('uses the configured canonical origin for callback paths', () => {
    setNodeEnv('production');
    process.env.APP_URL = ' https://app.example.test/ ';

    expect(new URL('/auth/callback', getCanonicalAppUrl()).href).toBe(
      'https://app.example.test/auth/callback',
    );
  });

  it('allows an explicitly configured loopback HTTP origin in development', () => {
    setNodeEnv('development');
    process.env.APP_URL = 'http://127.0.0.1:3000';

    expect(getCanonicalAppUrl().origin).toBe('http://127.0.0.1:3000');
  });

  it.each([
    'http://app.example.test',
    'ftp://app.example.test',
    'https://user:secret@app.example.test',
    'https://app.example.test/untrusted/path',
    'https://app.example.test/?next=https://attacker.example',
  ])('rejects unsafe or non-canonical APP_URL values: %s', (appUrl) => {
    setNodeEnv('production');
    process.env.APP_URL = appUrl;

    expect(() => getCanonicalAppUrl()).toThrow();
  });

  it('does not allow loopback HTTP as a production URL', () => {
    setNodeEnv('production');
    process.env.APP_URL = 'http://localhost:3000';

    expect(() => getCanonicalAppUrl()).toThrow(/HTTPS/);
  });
});

describe('Supabase public configuration', () => {
  it('accepts a hosted HTTPS URL', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-test-key';
    expect(getSupabasePublicConfig()).toEqual({
      url: 'https://project.example.supabase.co',
      anonKey: 'public-test-key',
    });
  });

  it('accepts loopback URLs used by local Supabase', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-test-key';
    expect(isSupabaseConfigured()).toBe(true);
  });

  it('rejects non-loopback insecure URLs and incomplete configuration', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.example.com';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-test-key';
    expect(getSupabasePublicConfig()).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.example.supabase.co';
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(isSupabaseConfigured()).toBe(false);
  });
});
