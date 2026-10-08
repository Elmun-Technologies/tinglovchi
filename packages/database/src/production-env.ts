import { getCanonicalAppUrl } from './config.ts';

/**
 * The three deployable runtime roles, plus `'all'` for the combined check a single-process
 * deployment used to run.
 *
 *   web            — public dashboard, Supabase Auth, the desktop gateway. No database credential.
 *   recording-api  — private, privileged. Owns Phase 4 recording writes. Storage only, no providers.
 *   worker         — private, privileged. Owns the processing pipeline and every provider client.
 */
export type ProductionEnvironmentRole = 'web' | 'recording-api' | 'worker' | 'all';

export type ProductionEnvironmentValidationResult = {
  ok: boolean;
  role: ProductionEnvironmentRole;
  errors: string[];
};

export class ProductionConfigError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Production configuration validation failed: ${errors.join(' ')}`);
    this.name = 'ProductionConfigError';
    this.errors = errors;
  }
}

/**
 * Fail-closed production environment audit.
 * Rejects missing credentials, non-HTTPS endpoints, fake/memory providers, and accidental secret exposure in NEXT_PUBLIC_*.
 */
export function validateProductionEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: {
    role?: ProductionEnvironmentRole;
    requireTelegram?: boolean;
    requireAutomation?: boolean;
    throwOnError?: boolean;
  } = {},
): ProductionEnvironmentValidationResult {
  const role = options.role ?? 'all';
  const errors: string[] = [];

  // What the process says it is. When it disagrees with the role being audited, the web-specific
  // rules follow the *declaration*, because that is the deployment an operator actually built.
  const declaredRole = (env.SUHBAT_RUNTIME_ROLE ?? '').trim().toLowerCase();
  const isWebDeployment = role === 'web' || declaredRole === 'web';

  // 1. Audit NEXT_PUBLIC_* for forbidden secret names or leaked secret values
  const serverSecretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_DB_URL,
    env.R2_SECRET_ACCESS_KEY,
    env.ASSEMBLYAI_API_KEY,
    env.OPENAI_API_KEY,
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.AUTOMATION_WEBHOOK_SECRET,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v && v.length >= 8));

  for (const [key, rawVal] of Object.entries(env)) {
    if (!key.startsWith('NEXT_PUBLIC_')) continue;
    if (/SECRET|SERVICE_ROLE|PRIVATE|API_KEY|PASSWORD|BOT_TOKEN/i.test(key)) {
      errors.push(`Forbidden public environment variable name "${key}" may expose server secrets.`);
    }
    const val = rawVal?.trim();
    if (val && serverSecretValues.includes(val)) {
      errors.push(`Public variable "${key}" contains a value matching a private server secret.`);
    }
  }

  // 2. Canonical APP_URL must be HTTPS in production
  try {
    const appUrl = getCanonicalAppUrl({ ...env, NODE_ENV: 'production' });
    if (appUrl.protocol !== 'https:') {
      errors.push('APP_URL must use HTTPS in production.');
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'APP_URL is invalid.');
  }

  // 3. Supabase configuration
  //
  // The anon key and project URL exist so a *browser* can establish a session under RLS. The
  // recording API and the worker connect with SUPABASE_DB_URL and never serve a browser, so
  // demanding them there would be demanding a credential those deployments have no use for.
  const needsBrowserAuth = isWebDeployment || role === 'all';
  const supaUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supaAnon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (needsBrowserAuth && !supaUrl) {
    errors.push('NEXT_PUBLIC_SUPABASE_URL is required in production.');
  } else if (supaUrl) {
    try {
      const parsed = new URL(supaUrl);
      if (parsed.protocol !== 'https:') {
        errors.push('NEXT_PUBLIC_SUPABASE_URL must use HTTPS in production.');
      }
    } catch {
      errors.push('NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL.');
    }
  }
  if (needsBrowserAuth && !supaAnon) {
    errors.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is required in production.');
  }
  // The reverse: a private service must not be handed the browser credentials either.
  if (!needsBrowserAuth && (supaUrl || supaAnon)) {
    errors.push(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are web-only. The ' +
        'recording-api and worker deployments connect with SUPABASE_DB_URL and must not hold them.',
    );
  }

  if (role === 'web' || role === 'all') {
    const dataMode = (env.SUHBAT_DATA_MODE ?? '').trim().toLowerCase();
    if (dataMode !== 'live') {
      errors.push('SUHBAT_DATA_MODE must be set to "live" in production.');
    }
  }

  if (role === 'recording-api') {
    if (!env.SUPABASE_DB_URL?.trim()) {
      errors.push('recording-api requires SUPABASE_DB_URL in production.');
    }
    // The whole point of the split: this service must not be holding processing credentials. If it
    // has them, someone has merged the recording API back into the worker.
    for (const forbidden of [
      'ASSEMBLYAI_API_KEY',
      'OPENAI_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'AUTOMATION_WEBHOOK_SECRET',
    ]) {
      if (env[forbidden]?.trim()) {
        errors.push(
          `${forbidden} must not be set on the recording-api deployment: it performs no ` +
            'processing. Move it to the worker.',
        );
      }
    }
    if (!env.SUHBAT_INTERNAL_API_SECRET?.trim() && !env.SUHBAT_INTERNAL_API_SECRETS?.trim()) {
      errors.push(
        'recording-api requires SUHBAT_INTERNAL_API_SECRET (or SUHBAT_INTERNAL_API_SECRETS) so it ' +
          'can authenticate requests from the Web gateway.',
      );
    }
  }

  if (role === 'worker' || role === 'all') {
    if (!env.SUPABASE_DB_URL?.trim() && !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      errors.push('Worker requires SUPABASE_DB_URL or SUPABASE_SERVICE_ROLE_KEY in production.');
    }
  }

  // 3b. Trust boundary: the reverse of the check above.
  //
  // `docs/production-readiness.md` marks the database URL and the service-role key as
  // "No (Forbidden in Web)". The web process talks to Postgres only through the anon-key Supabase
  // client, under RLS; privileged SQL lives in the worker. A deployment that hands the web a
  // database credential has silently widened the blast radius of every web vulnerability, so it is
  // rejected loudly rather than tolerated.
  if (isWebDeployment) {
    if (env.SUPABASE_DB_URL?.trim()) {
      errors.push(
        'SUPABASE_DB_URL is forbidden in the Web deployment: it is an owner credential that ' +
          'bypasses RLS. See docs/production-readiness.md.',
      );
    }
    if (env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      errors.push(
        'SUPABASE_SERVICE_ROLE_KEY is forbidden in the Web deployment: it bypasses RLS. ' +
          'See docs/production-readiness.md.',
      );
    }
  }

  // 3c. Role declaration must match the role being validated.
  //
  // A deployment that sets SUHBAT_RUNTIME_ROLE=web and is then audited as the worker would pass a
  // check it cannot satisfy. Refuse the mismatch rather than rubber-stamp it.
  if (role !== 'all' && declaredRole && declaredRole !== role) {
    errors.push(
      `SUHBAT_RUNTIME_ROLE is "${declaredRole}" but this deployment is being validated as ` +
        `"${role}". The two must agree.`,
    );
  }

  // 4. Storage / Cloudflare R2
  //
  // Storage is a recording-api and worker dependency, not a dashboard dependency. The web process
  // never signs an object URL — it forwards to the recording API, which does. So requiring an R2
  // bucket in the web deployment would be requiring a credential it has no use for (and one that
  // would enlarge the blast radius of a web compromise for nothing).
  const needsStorage =
    role === 'recording-api' || role === 'worker' || role === 'all' || declaredRole === 'worker';
  const storageProvider = (env.STORAGE_PROVIDER ?? '').trim().toLowerCase();
  if (needsStorage && storageProvider !== 'r2') {
    errors.push('STORAGE_PROVIDER must be "r2" in production (local/memory storage is forbidden).');
  }
  if (needsStorage && !env.R2_ACCOUNT_ID?.trim()) {
    errors.push('R2_ACCOUNT_ID is required in production.');
  }
  if (needsStorage && !env.R2_BUCKET?.trim()) errors.push('R2_BUCKET is required in production.');
  if (needsStorage && !env.R2_ACCESS_KEY_ID?.trim()) {
    errors.push('R2_ACCESS_KEY_ID is required in production.');
  }
  if (needsStorage && !env.R2_SECRET_ACCESS_KEY?.trim()) {
    errors.push('R2_SECRET_ACCESS_KEY is required in production.');
  }
  if (env.R2_ENDPOINT?.trim()) {
    try {
      const parsedR2 = new URL(env.R2_ENDPOINT.trim());
      if (parsedR2.protocol !== 'https:') {
        errors.push('R2_ENDPOINT must use HTTPS in production.');
      }
    } catch {
      errors.push('R2_ENDPOINT must be a valid HTTPS URL.');
    }
  }

  // 4b. Web → Recording API wiring.
  if (isWebDeployment) {
    if (!env.SUHBAT_RECORDING_API_URL?.trim()) {
      errors.push(
        'SUHBAT_RECORDING_API_URL is required in production: the Web gateway forwards recording ' +
          'requests to the private Recording API.',
      );
    } else {
      const recordingApi = env.SUHBAT_RECORDING_API_URL.trim();
      let parsed: URL | null = null;
      try {
        parsed = new URL(recordingApi);
      } catch {
        errors.push('SUHBAT_RECORDING_API_URL must be a valid URL.');
      }
      if (parsed) {
        // The private network is the whole point. A public URL means the privileged service is
        // reachable from the internet, and the only thing standing between it and an attacker is a
        // shared secret we would then be relying on alone.
        const host = parsed.hostname.toLowerCase();
        const isPrivateNetwork =
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host.endsWith('.internal') ||
          host.endsWith('.flycast');
        if (!isPrivateNetwork) {
          errors.push(
            'SUHBAT_RECORDING_API_URL must point at a private-network host (.internal or ' +
              '.flycast on Fly, or loopback for local development). The Recording API must not be ' +
              'publicly reachable.',
          );
        }
      }
    }
    if (!env.SUHBAT_INTERNAL_API_SECRET?.trim() && !env.SUHBAT_INTERNAL_API_SECRETS?.trim()) {
      errors.push(
        'Web requires SUHBAT_INTERNAL_API_SECRET (or SUHBAT_INTERNAL_API_SECRETS) to authenticate ' +
          'requests it forwards to the Recording API.',
      );
    }
  }

  // 5. Worker providers: Transcription, Intelligence, Embeddings, Telegram, Automation
  if (role === 'worker' || role === 'all') {
    const transcriptionProvider = (env.TRANSCRIPTION_PROVIDER ?? '').trim().toLowerCase();
    if (transcriptionProvider !== 'assemblyai') {
      errors.push(
        'TRANSCRIPTION_PROVIDER must be "assemblyai" in production (fake provider is forbidden).',
      );
    }
    if (!env.ASSEMBLYAI_API_KEY?.trim()) {
      errors.push('ASSEMBLYAI_API_KEY is required in production.');
    }

    const intelligenceProvider = (
      env.SUHBAT_INTELLIGENCE_PROVIDER ??
      env.INTELLIGENCE_PROVIDER ??
      ''
    )
      .trim()
      .toLowerCase();
    if (intelligenceProvider !== 'openai') {
      errors.push(
        'SUHBAT_INTELLIGENCE_PROVIDER must be "openai" in production (fake provider is forbidden).',
      );
    }

    const embeddingProvider = (env.SUHBAT_EMBEDDING_PROVIDER ?? env.EMBEDDING_PROVIDER ?? '')
      .trim()
      .toLowerCase();
    if (embeddingProvider !== 'openai') {
      errors.push(
        'SUHBAT_EMBEDDING_PROVIDER must be "openai" in production (fake provider is forbidden).',
      );
    }

    if (!env.OPENAI_API_KEY?.trim()) {
      errors.push('OPENAI_API_KEY is required in production.');
    }

    const telegramProvider = (env.SUHBAT_TELEGRAM_PROVIDER ?? env.TELEGRAM_PROVIDER ?? '')
      .trim()
      .toLowerCase();
    if (telegramProvider === 'fake') {
      errors.push('SUHBAT_TELEGRAM_PROVIDER cannot be "fake" in production.');
    }
    if (telegramProvider === 'telegram' || options.requireTelegram) {
      if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
        errors.push('TELEGRAM_BOT_TOKEN is required when Telegram provider is enabled.');
      }
      if (!env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
        errors.push('TELEGRAM_WEBHOOK_SECRET is required when Telegram provider is enabled.');
      }
    }

    const automationProvider = (env.SUHBAT_AUTOMATION_PROVIDER ?? env.AUTOMATION_PROVIDER ?? '')
      .trim()
      .toLowerCase();
    if (automationProvider === 'fake') {
      errors.push('SUHBAT_AUTOMATION_PROVIDER cannot be "fake" in production.');
    }
    if (automationProvider === 'webhook' || options.requireAutomation) {
      if (!env.AUTOMATION_WEBHOOK_SECRET?.trim()) {
        errors.push('AUTOMATION_WEBHOOK_SECRET is required when webhook automation is enabled.');
      }
    }
  }

  const result: ProductionEnvironmentValidationResult = {
    ok: errors.length === 0,
    role,
    errors,
  };

  if (!result.ok && (options.throwOnError ?? true)) {
    throw new ProductionConfigError(errors);
  }

  return result;
}
