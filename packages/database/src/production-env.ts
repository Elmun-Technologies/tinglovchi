import { getCanonicalAppUrl } from './config.ts';

export type ProductionEnvironmentRole = 'web' | 'worker' | 'all';

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
  const supaUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supaAnon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supaUrl) {
    errors.push('NEXT_PUBLIC_SUPABASE_URL is required in production.');
  } else {
    try {
      const parsed = new URL(supaUrl);
      if (parsed.protocol !== 'https:') {
        errors.push('NEXT_PUBLIC_SUPABASE_URL must use HTTPS in production.');
      }
    } catch {
      errors.push('NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL.');
    }
  }
  if (!supaAnon) {
    errors.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is required in production.');
  }

  if (role === 'web' || role === 'all') {
    const dataMode = (env.SUHBAT_DATA_MODE ?? '').trim().toLowerCase();
    if (dataMode !== 'live') {
      errors.push('SUHBAT_DATA_MODE must be set to "live" in production.');
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
  if (role === 'web') {
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

  // 4. Storage / Cloudflare R2
  const storageProvider = (env.STORAGE_PROVIDER ?? '').trim().toLowerCase();
  if (storageProvider !== 'r2') {
    errors.push('STORAGE_PROVIDER must be "r2" in production (local/memory storage is forbidden).');
  }
  if (!env.R2_ACCOUNT_ID?.trim()) errors.push('R2_ACCOUNT_ID is required in production.');
  if (!env.R2_BUCKET?.trim()) errors.push('R2_BUCKET is required in production.');
  if (!env.R2_ACCESS_KEY_ID?.trim()) errors.push('R2_ACCESS_KEY_ID is required in production.');
  if (!env.R2_SECRET_ACCESS_KEY?.trim()) {
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
