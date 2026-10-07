import 'server-only';
import { cache as requestCache } from 'react';
import { assertDemoIntegrity, createDemoRepositories, demoDataset } from '@suhbat/product/demo';
import { RepositoryError, type DataCapabilities, type ProductRepositories } from '@suhbat/product';
import { createLiveRepositories, type LiveRepositoryContext } from './live-repositories';
import {
  createSupabaseLiveRepositories,
  createUnavailableLiveRepositories,
  type SupabaseLiveRepositoryContext,
} from './supabase-live-repositories';
import { resolveDataMode, type DataMode } from './data-mode';
import { isSupabaseConfigured } from '@suhbat/database/config';

/**
 * The single adapter-selection point for server components and server actions.
 *
 * Pages never import the demo fixtures, a database client, or an AI provider — they call
 * `getRepositories()` and read the typed contract.
 *
 * Adapter selection:
 * - `demo` → versioned fixtures.
 * - `live` + an explicitly registered context (tests, worker-side runtimes) → that context's adapter.
 * - `live` + Supabase configured → the session-bound Supabase adapter, which reads through PostgREST with
 *   the signed-in user's JWT so PostgreSQL RLS is the authorization boundary.
 * - `live` + Supabase missing → an adapter that rejects with an explicit configuration error. It never
 *   serves demo fixtures and never pretends the data is merely "not implemented yet".
 */

export type WorkspaceAccess = {
  ok: true;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: 'owner' | 'admin' | 'member';
  /** Person id for `Tasks → Mine`; `null` when the signed-in user has no profile in that workspace yet. */
  currentPersonId: string | null;
  /** Signed-in identity, when there is one. Demo mode has no account, and the UI says so. */
  email: string | null;
  mode: DataMode;
};

export type AccessFailureReason =
  'signed_out' | 'not_found' | 'no_membership' | 'provider_unavailable' | 'not_configured';

/**
 * Demo mutations live in one shared adapter instance so a dev server keeps a coherent story across requests
 * (advance a step, tick a task, map a speaker) instead of resetting on every navigation. It is per-process,
 * never persisted, and disappears on restart.
 */
const cache = globalThis as typeof globalThis & {
  __suhbatProductRepositories?: ProductRepositories;
  __suhbatDemoChecked?: boolean;
  __suhbatLiveRepositoryContext?: LiveRepositoryContext | SupabaseLiveRepositoryContext | null;
};

export function setLiveRepositoryContext(
  context: LiveRepositoryContext | SupabaseLiveRepositoryContext | null,
): void {
  cache.__suhbatLiveRepositoryContext = context;
}

function demoRepositories(): ProductRepositories {
  if (!cache.__suhbatDemoChecked) {
    // The fixtures are the product's own claims; a broken citation must fail here, not in a screenshot.
    assertDemoIntegrity(demoDataset);
    cache.__suhbatDemoChecked = true;
  }
  cache.__suhbatProductRepositories ??= createDemoRepositories(demoDataset);
  return cache.__suhbatProductRepositories;
}

export function dataMode(): DataMode {
  return resolveDataMode();
}

const missingLiveConfigurationMessage =
  'SUHBAT_DATA_MODE=live requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY. Without them the dashboard cannot read workspace data through the signed-in Supabase session.';

/**
 * Reads the signed-in Supabase session for the current request and returns the live repository context.
 *
 * Memoized per request with React `cache()`: one session lookup and one adapter build no matter how many
 * server components ask for repositories. The client is created by `@suhbat/database/server`, which is bound
 * to the request cookies and to the public anon key only — never the service-role key, whose absence is what
 * makes `RLS` the authorization boundary.
 */
const resolveSessionLiveContext = requestCache(async (): Promise<SupabaseLiveRepositoryContext> => {
  const { createSupabaseServerClient } = await import('@suhbat/database/server');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new RepositoryError(
      'unauthorized',
      'Sign in to read this workspace. No authenticated Supabase session was found for this request.',
    );
  }
  return {
    client: supabase as unknown as SupabaseLiveRepositoryContext['client'],
    userId: data.user.id,
    email: data.user.email ?? null,
  };
});

/**
 * One session-bound live adapter per request.
 *
 * React's `cache()` scopes the value to the current server request, so two components that both ask for
 * repositories share one adapter and one session lookup — and one signed-in user's adapter never becomes the
 * next request's answer. Outside a request scope (tests, scripts) it simply rebuilds.
 */
const sessionLiveRepositories = requestCache((): ProductRepositories =>
  createSupabaseLiveRepositories(resolveSessionLiveContext),
);

export function getRepositories(): ProductRepositories {
  if (dataMode() === 'demo') {
    return demoRepositories();
  }

  const context = cache.__suhbatLiveRepositoryContext;
  if (context) {
    return 'client' in context
      ? createSupabaseLiveRepositories(context)
      : createLiveRepositories(context);
  }

  if (!isSupabaseConfigured()) {
    return createUnavailableLiveRepositories(missingLiveConfigurationMessage);
  }

  return sessionLiveRepositories();
}

export function getCapabilities(): DataCapabilities {
  return getRepositories().capabilities;
}

export type Access =
  { ok: true; access: WorkspaceAccess } | { ok: false; reason: AccessFailureReason };

export async function resolveAccess(workspaceId: string): Promise<Access> {
  const mode = dataMode();
  if (mode === 'demo') {
    const workspace = demoDataset.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      access: {
        ok: true,
        workspaceId,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
        role: demoDataset.settings.currentRole,
        currentPersonId: demoDataset.currentPersonId,
        email: null,
        mode,
      },
    };
  }

  const liveCtx = cache.__suhbatLiveRepositoryContext;
  if (liveCtx && 'service' in liveCtx) {
    if (!liveCtx.principal?.userId) return { ok: false, reason: 'signed_out' };
    try {
      const res = await liveCtx.service.db.query<{
        role: 'owner' | 'admin' | 'member';
        workspace_id: string;
        workspace_name: string;
        workspace_slug: string;
        email: string | null;
      }>(
        `select wm.role::text as role,
                w.id as workspace_id,
                w.name as workspace_name,
                w.slug as workspace_slug,
                p.email
           from public.workspace_members wm
           join public.workspaces w on w.id = wm.workspace_id
           left join public.profiles p on p.id = wm.user_id
          where wm.workspace_id = $1
            and wm.user_id = $2
            and wm.membership_status = 'active'
            and w.deleted_at is null`,
        [workspaceId, liveCtx.principal.userId],
      );
      const row = res.rows[0];
      if (!row) return { ok: false, reason: 'no_membership' };
      return {
        ok: true,
        access: {
          ok: true,
          workspaceId: row.workspace_id,
          workspaceName: row.workspace_name,
          workspaceSlug: row.workspace_slug,
          role: row.role,
          currentPersonId: liveCtx.principal.userId,
          email: row.email,
          mode,
        },
      };
    } catch {
      return { ok: false, reason: 'provider_unavailable' };
    }
  }

  // Session-bound path: the same Supabase client the live repositories use, so the RLS policies decide
  // whether this workspace is visible to the signed-in user. No service-role access, no DB URL.
  let client: SupabaseLiveRepositoryContext['client'];
  let authenticatedUserId: string;
  let email: string | null = null;

  if (liveCtx && 'client' in liveCtx) {
    client = liveCtx.client;
    authenticatedUserId = liveCtx.userId;
    email = liveCtx.email ?? null;
  } else {
    if (!isSupabaseConfigured()) return { ok: false, reason: 'not_configured' };
    try {
      const session = await resolveSessionLiveContext();
      client = session.client;
      authenticatedUserId = session.userId;
      email = session.email ?? null;
    } catch {
      return { ok: false, reason: 'signed_out' };
    }
  }

  const { data: membership, error: membershipError } = await client
    .from('workspace_members')
    .select('role')
    .eq('user_id', authenticatedUserId)
    .eq('workspace_id', workspaceId)
    .eq('membership_status', 'active')
    .maybeSingle();
  if (membershipError) return { ok: false, reason: 'provider_unavailable' };
  if (!membership) return { ok: false, reason: 'no_membership' };

  const { data: workspace, error: workspaceError } = await client
    .from('workspaces')
    .select('id, name, slug')
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError) return { ok: false, reason: 'provider_unavailable' };
  if (!workspace) return { ok: false, reason: 'not_found' };

  return {
    ok: true,
    access: {
      ok: true,
      workspaceId,
      workspaceName: String(workspace['name'] ?? ''),
      workspaceSlug: String(workspace['slug'] ?? ''),
      role: (membership['role'] ?? 'member') as 'owner' | 'admin' | 'member',
      currentPersonId: authenticatedUserId,
      email,
      mode,
    },
  };
}
