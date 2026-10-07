import { isSupabaseConfigured } from '@suhbat/database/config';

/**
 * Which data source the product surfaces read from.
 *
 * This is the only place that decides it, so no page branches on the environment itself. `demo` stays the
 * default: an operator has to ask for live explicitly, and a live deployment without Supabase configuration
 * fails with an explicit configuration error instead of quietly serving fixtures.
 */
export type DataMode = 'demo' | 'live';

export const dataModeEnvVar = 'SUHBAT_DATA_MODE';

export function resolveDataMode(): DataMode {
  const flag = process.env[dataModeEnvVar]?.trim().toLowerCase();
  if (flag === 'demo' || flag === 'live') return flag;
  return 'demo';
}

/**
 * What `live` means in this build: the routes are wired to the repository contract, and the live adapter is the
 * session-bound Supabase repository, which reads through PostgREST with the signed-in user's JWT so PostgreSQL
 * RLS remains the authorization boundary. Reported as a fact, never hidden behind demo data in a live
 * deployment.
 */
export function liveAdapterStatus(): {
  configured: boolean;
  implemented: boolean;
  adapter: 'supabase-session';
  requiresSession: true;
} {
  return {
    configured: isSupabaseConfigured(),
    implemented: true,
    adapter: 'supabase-session',
    requiresSession: true,
  };
}
