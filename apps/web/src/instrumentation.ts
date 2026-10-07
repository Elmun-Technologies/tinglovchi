/**
 * Next.js server startup hook. Configuration that affects security-sensitive redirects is
 * validated here so a misconfigured deployment fails before serving traffic instead of silently
 * using an attacker-influenced origin.
 *
 * Live data mode is checked here for the same reason: `SUHBAT_DATA_MODE=live` without the public Supabase
 * values would answer every workspace screen with `not_configured`, and a worker/heartbeat would see a
 * healthy process. Failing at boot makes the misconfiguration obvious in the deploy logs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertCanonicalAppUrlConfiguration, isSupabaseConfigured } = await import(
    '@suhbat/database/config'
  );
  assertCanonicalAppUrlConfiguration();

  const dataMode = process.env.SUHBAT_DATA_MODE?.trim().toLowerCase();
  if (dataMode !== 'live') return;
  if (isSupabaseConfigured()) return;

  throw new Error(
    'SUHBAT_DATA_MODE=live requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Without them the dashboard cannot read workspace data through the signed-in Supabase session ' +
      '(PostgREST + RLS). Set them for the runtime environment, or set SUHBAT_DATA_MODE=demo.',
  );
}
