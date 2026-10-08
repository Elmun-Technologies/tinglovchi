'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { desktopConnectCodeSchema } from '@suhbat/contracts';
import { DesktopClientService } from '@suhbat/database/desktop';
import { createSupabaseServerClient } from '@suhbat/database/server';
import { createDesktopRpc } from '../../lib/desktop-rpc';

/**
 * Approving a desktop pairing code.
 *
 * The desktop app has no credential of its own, so a human has to bless it — and that human is
 * authenticated here with their normal browser session. Approval binds the code to *this* user and
 * (optionally) one workspace they are an active member of; the service re-checks membership, so a
 * code can never be pointed at a workspace the approver cannot see.
 */

export type DesktopConnectState = 'idle' | 'invalid' | 'expired' | 'authorized' | 'error';

function connectPath(state: DesktopConnectState, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ state, ...extra });
  return `/desktop/connect?${params.toString()}`;
}

export async function authorizeDesktopConnectAction(formData: FormData): Promise<void> {
  const rawCode = String(formData.get('code') ?? '').trim().toUpperCase();
  const rawWorkspace = String(formData.get('workspaceId') ?? '').trim();

  const parsed = desktopConnectCodeSchema.safeParse(rawCode);
  if (!parsed.success) redirect(connectPath('invalid'));

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    redirect(`/login?next=${encodeURIComponent('/desktop/connect')}`);
  }

  // Approval goes through a `security definer` RPC on the user's own Supabase session. This
  // process holds no direct database credential, by design.
  const service = new DesktopClientService({ rpc: createDesktopRpc(supabase) });
  try {
    const result = await service.authorizeConnectCode(
      { userId: authData.user.id },
      parsed.data,
      rawWorkspace || null,
    );
    revalidatePath('/desktop/connect');
    redirect(
      connectPath('authorized', {
        workspace: result.workspaceId ?? '',
        email: authData.user.email ?? '',
      }),
    );
  } catch (cause) {
    const code = (cause as { code?: unknown })?.code;
    if (code === 'not_found') redirect(connectPath('expired'));
    redirect(connectPath('error', { reason: typeof code === 'string' ? code : 'unknown' }));
  }
}
