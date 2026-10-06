/**
 * Next.js server startup hook. Configuration that affects security-sensitive redirects is
 * validated here so a misconfigured deployment fails before serving traffic instead of silently
 * using an attacker-influenced origin.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertCanonicalAppUrlConfiguration } = await import('@suhbat/database/config');
  assertCanonicalAppUrlConfiguration();
}
