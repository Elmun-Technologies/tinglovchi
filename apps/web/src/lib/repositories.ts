import 'server-only';
import { createSupabaseServerClient } from '@suhbat/database/server';
import { assertDemoIntegrity, createDemoRepositories, demoDataset } from '@suhbat/product/demo';
import type { DataCapabilities, ProductRepositories } from '@suhbat/product';
import { createLivePlaceholderRepositories } from './live-repositories';
import { resolveDataMode, type DataMode } from './data-mode';

/**
 * The single adapter-selection point for server components and server actions.
 *
 * Pages never import the demo fixtures, a database client, or an AI provider — they call
 * `getRepositories()` and read the typed contract. Swapping the demo adapter for Supabase later touches this
 * file and `live-repositories.ts` only.
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
  'signed_out' | 'not_found' | 'no_membership' | 'provider_unavailable';

/**
 * Demo mutations live in one shared adapter instance so a dev server keeps a coherent story across requests
 * (advance a step, tick a task, map a speaker) instead of resetting on every navigation. It is per-process,
 * never persisted, and disappears on restart.
 */
const cache = globalThis as typeof globalThis & {
  __suhbatProductRepositories?: ProductRepositories;
  __suhbatDemoChecked?: boolean;
};

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

export function getRepositories(): ProductRepositories {
  return dataMode() === 'demo' ? demoRepositories() : createLivePlaceholderRepositories();
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

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return { ok: false, reason: 'signed_out' };
  const { data: membership, error: membershipError } = await supabase
    .from('workspace_members')
    .select('role, workspace:workspaces(id, name, slug)')
    .eq('user_id', authData.user.id)
    .eq('workspace_id', workspaceId)
    .eq('membership_status', 'active')
    .maybeSingle();
  if (membershipError) return { ok: false, reason: 'provider_unavailable' };
  const workspace = (
    membership as unknown as { workspace?: { id: string; name: string; slug: string } } | null
  )?.workspace;
  if (!membership || !workspace) return { ok: false, reason: 'no_membership' };
  return {
    ok: true,
    access: {
      ok: true,
      workspaceId,
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      role: membership.role as 'owner' | 'admin' | 'member',
      // Mapping a Supabase user to a workspace person profile is part of the live adapter, not of this gate.
      currentPersonId: null,
      email: authData.user.email ?? null,
      mode,
    },
  };
}
