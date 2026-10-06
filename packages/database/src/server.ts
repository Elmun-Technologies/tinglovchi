import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './database.types';
import { assertCanonicalAppUrlConfiguration, getSupabasePublicConfig } from './config';

export async function createSupabaseServerClient() {
  const config = getSupabasePublicConfig();
  if (!config)
    throw new Error('Supabase is not configured. Check the public Supabase environment values.');

  // Auth redirects share this origin; fail closed rather than fall back to an inferred host.
  assertCanonicalAppUrlConfiguration();

  const cookieStore = await cookies();

  return createServerClient<Database>(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies. Middleware/Server Actions refresh the session.
        }
      },
    },
  });
}
