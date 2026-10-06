import { isSupabaseConfigured } from '@suhbat/database/config';

/**
 * Which data source the product surfaces read from.
 *
 * This is the only place that decides it, so no page branches on the environment itself. `demo` is the
 * default even when Supabase is configured, because the product routes have a demo adapter and not yet a
 * Supabase one: silently claiming "live" would be the worst of both worlds.
 */
export type DataMode = 'demo' | 'live';

export const dataModeEnvVar = 'SUHBAT_DATA_MODE';

export function resolveDataMode(): DataMode {
  const flag = process.env[dataModeEnvVar]?.trim().toLowerCase();
  if (flag === 'demo' || flag === 'live') return flag;
  return 'demo';
}

/**
 * What `live` means in this build: the routes are wired to the repository contract, and the contract's Supabase
 * implementation is the missing piece. Reported as a fact, never hidden behind demo data in a live deployment.
 */
export function liveAdapterStatus(): { configured: boolean; implemented: boolean } {
  return { configured: isSupabaseConfigured(), implemented: false };
}
