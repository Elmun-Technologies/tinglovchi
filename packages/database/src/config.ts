const developmentAppUrl = 'http://localhost:3000';

export type SupabasePublicConfig = {
  url: string;
  anonKey: string;
};

/**
 * Return the single trusted origin used for email links and auth callback redirects.
 * Never derive this value from an incoming request's Host or forwarded headers.
 */
export function getCanonicalAppUrl(): URL {
  const configuredUrl = process.env.APP_URL?.trim();
  if (!configuredUrl) {
    if (process.env.NODE_ENV === 'development') return new URL(developmentAppUrl);
    throw new Error('APP_URL must be explicitly configured outside development.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error(
      'APP_URL must be a valid HTTPS origin (or a loopback HTTP origin in development).',
    );
  }

  const isLoopbackHttp =
    process.env.NODE_ENV === 'development' &&
    parsedUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error('APP_URL must use HTTPS outside a loopback development URL.');
  }
  if (
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== '/' ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error('APP_URL must contain only the canonical application origin.');
  }

  return new URL(parsedUrl.origin);
}

export function assertCanonicalAppUrlConfiguration(): void {
  getCanonicalAppUrl();
}

export function getSupabasePublicConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) return null;

  try {
    const parsed = new URL(url);
    const isLocalHttp =
      parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isLocalHttp) return null;
  } catch {
    return null;
  }

  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabasePublicConfig() !== null;
}
