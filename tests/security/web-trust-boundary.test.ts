import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProductionEnvironment } from '../../packages/database/src/production-env';

/**
 * The web deployment's trust boundary, asserted statically.
 *
 * `docs/production-readiness.md` says it plainly:
 *
 *   | Supabase | `SUPABASE_DB_URL` / `SUPABASE_SERVICE_ROLE_KEY` | **No (Forbidden in Web)** | Yes |
 *
 * A rule in a markdown table is easy to drift away from. These tests make it structural: the web
 * application cannot reach a privileged database credential, because nothing in `apps/web` is
 * written to look for one, and the module that would hand one over refuses unless it is told it is
 * the worker.
 *
 * What replaces the direct connection is the pattern this repository already used for
 * `create_workspace`: narrowly scoped `security definer` functions called through the Supabase
 * client, which carries the caller's own session.
 */

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'apps', 'web');

/** Every source file in the web app. */
function webFiles(): string[] {
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const output = execSync(
    `find apps/web/src apps/web/*.ts apps/web/*.mjs apps/web/*.js -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \\) 2>/dev/null || true`,
    { cwd: ROOT, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const FILES = webFiles();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/** Comments and block comments stripped, so prose about a rule cannot satisfy the rule. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the web app never reaches for a privileged database credential', () => {
  it('found the web sources (a broken glob must fail loudly, not pass silently)', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('no web file reads SUPABASE_DB_URL', () => {
    const offenders = FILES.filter((file) =>
      /SUPABASE_DB_URL/.test(code(read(file))),
    );
    expect(offenders).toEqual([]);
  });

  it('no web file reads SUPABASE_SERVICE_ROLE_KEY', () => {
    const offenders = FILES.filter((file) =>
      /SUPABASE_SERVICE_ROLE_KEY/.test(code(read(file))),
    );
    expect(offenders).toEqual([]);
  });

  it('no web file imports the privileged worker executor', () => {
    const offenders = FILES.filter((file) =>
      /worker-executor|getWorkerExecutor|createWorkerExecutor/.test(code(read(file))),
    );
    expect(offenders).toEqual([]);
  });

  it('no web file imports the pg driver directly', () => {
    const offenders = FILES.filter((file) =>
      /from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)|from\s+['"]postgres['"]/.test(code(read(file))),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the privileged executor refuses to be built by the web', () => {
  it('has no default role: a caller must state it is the worker', async () => {
    const source = read('packages/database/src/worker-executor.ts');
    // `getWorkerExecutor()` with no argument must not typecheck, so the signature has no default.
    expect(source).toMatch(
      /export async function getWorkerExecutor\(\s*request: WorkerExecutorRequest\s*,?\s*\)/,
    );
    expect(source).not.toMatch(/role:\s*PrivilegedRuntimeRole\s*=/);
  });

  it('rejects a non-worker role at runtime', async () => {
    const { getWorkerExecutor } = await import('../../packages/database/src/worker-executor');
    await expect(
      // @ts-expect-error deliberately passing a role that must never be accepted
      getWorkerExecutor({ role: 'web' }),
    ).rejects.toThrow(/Only the worker runtime may create a privileged database executor/);
  });

  it('refuses in production when the process declares itself the web role', async () => {
    const { getWorkerExecutor } = await import('../../packages/database/src/worker-executor');
    await expect(
      getWorkerExecutor({ role: 'worker', env: { NODE_ENV: 'production', SUHBAT_RUNTIME_ROLE: 'web' } }),
    ).rejects.toThrow(/SUHBAT_RUNTIME_ROLE=web, which forbids SUPABASE_DB_URL/);
  });

  it('returns null, never throws, when the worker simply has no database configured', async () => {
    const { getWorkerExecutor } = await import('../../packages/database/src/worker-executor');
    await expect(getWorkerExecutor({ role: 'worker', env: {} })).resolves.toBeNull();
  });
});

describe('production validation forbids the database credential in the web role', () => {
  const base = {
    NODE_ENV: 'production',
    APP_URL: 'https://app.suhbat.uz',
    SUHBAT_DATA_MODE: 'live',
    NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    STORAGE_PROVIDER: 'r2',
    R2_ACCOUNT_ID: 'acc',
    R2_BUCKET: 'bucket',
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    SUHBAT_EMBEDDING_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-openai',
  };

  it('fails a web deployment that has SUPABASE_DB_URL set', () => {
    const result = validateProductionEnvironment(
      { ...base, SUPABASE_DB_URL: 'postgresql://owner:pw@db.proj.supabase.co:5432/postgres' },
      { role: 'web', throwOnError: false },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/SUPABASE_DB_URL/);
    expect(result.errors.join(' ')).toMatch(/forbidden/i);
  });

  it('fails a web deployment that has SUPABASE_SERVICE_ROLE_KEY set', () => {
    const result = validateProductionEnvironment(
      { ...base, SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' },
      { role: 'web', throwOnError: false },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('still accepts a web deployment with only the public anon key', () => {
    const result = validateProductionEnvironment(base, { role: 'web', throwOnError: false });
    // No database credential, no worker-only provider: this is exactly the intended web shape.
    expect(result.errors.filter((error) => /SUPABASE_DB_URL|SERVICE_ROLE/.test(error))).toEqual([]);
  });

  it('does not disturb the combined (role=all) validation the worker relies on', () => {
    const result = validateProductionEnvironment(
      {
        ...base,
        SUPABASE_DB_URL: 'postgresql://worker:pw@db.proj.supabase.co:5432/postgres',
        TRANSCRIPTION_PROVIDER: 'assemblyai',
        ASSEMBLYAI_API_KEY: 'aai',
        SUHBAT_INTELLIGENCE_PROVIDER: 'openai',
      },
      { role: 'worker', throwOnError: false },
    );
    expect(result.ok).toBe(true);
  });
});

describe('the desktop RPC boundary is allow-listed', () => {
  it('refuses to call anything outside the allow-list', async () => {
    const { createDesktopRpc } = await import('../../apps/web/src/lib/desktop-rpc');
    const calls: string[] = [];
    const rpc = createDesktopRpc({
      rpc: (async (fn: string) => {
        calls.push(fn);
        return { data: [], error: null };
      }) as never,
    });

    await rpc.call('desktop_list_workspaces', { p_access_token_hash: null });
    expect(calls).toEqual(['desktop_list_workspaces']);

    await expect(rpc.call('pg_read_file', {})).rejects.toThrow(/non-allowlisted/);
    await expect(rpc.call('desktop_sessions', {})).rejects.toThrow(/non-allowlisted/);
    // Nothing outside the list ever reached the client.
    expect(calls).toEqual(['desktop_list_workspaces']);
  });

  it('only names functions that exist in the migration', () => {
    const source = read('apps/web/src/lib/desktop-rpc.ts');
    const migration = read('supabase/migrations/202610080002_phase13_desktop_session_rotation.sql');
    const listed = [...source.matchAll(/'([a-z_]+)'/g)]
      .map((match) => match[1]!)
      .filter((name) => name.startsWith('desktop_'));
    expect(listed.length).toBeGreaterThan(5);
    for (const fn of listed) {
      expect(migration, `${fn} is called but never created`).toMatch(
        new RegExp(`create function public\\.${fn}\\(`),
      );
      expect(migration, `${fn} must be security definer`).toMatch(
        new RegExp(`create function public\\.${fn}\\([\\s\\S]*?security definer`),
      );
    }
  });

  it('every desktop function sets an empty search_path and revokes the default grant', () => {
    const migration = read('supabase/migrations/202610080002_phase13_desktop_session_rotation.sql');
    const declared = [...migration.matchAll(/create function public\.(desktop_[a-z_]+)\(/g)].map(
      (match) => match[1]!,
    );
    expect(declared.length).toBeGreaterThan(8);
    for (const fn of declared) {
      const body = new RegExp(`create function public\\.${fn}\\([\\s\\S]*?\\$\\$;`).exec(migration);
      expect(body, `${fn} body not found`).toBeTruthy();
      expect(body![0], `${fn} must pin search_path`).toMatch(/set search_path = ''/);
      expect(body![0], `${fn} must be security definer`).toMatch(/security definer/);
      expect(migration, `${fn} must revoke the default public grant`).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\(`),
      );
    }
  });
});

describe('the runtime resolver is split by capability', () => {
  const runtime = read('apps/web/src/lib/api-v1-runtime.ts');

  it('exposes a desktop resolver and a pipeline resolver', () => {
    expect(runtime).toMatch(/export async function resolveDesktopContext\(/);
    expect(runtime).toMatch(/export async function resolvePipelineContext\(/);
  });

  it('the desktop resolver never constructs storage or provider clients', () => {
    const start = runtime.indexOf('export async function resolveDesktopContext(');
    const end = runtime.indexOf('export async function resolvePipelineContext(');
    const body = runtime.slice(start, end);
    for (const forbidden of [
      'createStorageProviderFromEnv',
      'createTranscriptionProviderFromEnv',
      'createMeetingIntelligenceProviderFromEnv',
      'createEmbeddingProviderFromEnv',
      'createTelegramBotProviderFromEnv',
      'createBusinessAutomationProviderFromEnv',
      'Phase5TranscriptionService',
      'Phase6IntelligenceService',
      'Phase7KnowledgeService',
      'Phase9AutomationService',
      'worker-executor',
    ]) {
      expect(body, `resolveDesktopContext must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the desktop pairing endpoints use the desktop resolver, not the pipeline one', () => {
    const authRoutes = [
      'apps/web/src/app/api/v1/desktop/connect-codes/route.ts',
      'apps/web/src/app/api/v1/desktop/sessions/route.ts',
      'apps/web/src/app/api/v1/desktop/sessions/refresh/route.ts',
      'apps/web/src/app/api/v1/desktop/session/workspace/route.ts',
      'apps/web/src/app/api/v1/meetings/route.ts',
      'apps/web/src/app/api/v1/workspaces/route.ts',
    ];
    for (const route of authRoutes) {
      const source = code(read(route));
      expect(source, `${route} must use resolveDesktopContext`).toMatch(/resolveDesktopContext/);
      expect(source, `${route} must not use resolveApiContext`).not.toMatch(/resolveApiContext/);
      expect(source, `${route} must not use resolvePipelineContext`).not.toMatch(
        /resolvePipelineContext/,
      );
    }
  });
});
