import type { SupabaseClient } from '@supabase/supabase-js';
import type { DesktopRpc } from '@suhbat/database/desktop';

/**
 * The desktop service's only route to the database.
 *
 * `DesktopClientService` speaks one verb — call a named function with named arguments — and this is
 * the web implementation of it. It rides the Supabase client, which the web process may legitimately
 * hold: that is the public anon key plus whatever session the caller already has.
 *
 * Why this exists
 * ---------------
 * `docs/production-readiness.md` forbids `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
 * Web deployment. The desktop service therefore cannot open a direct connection. Instead every
 * statement lives in a narrowly scoped `security definer` function that does its own authorization,
 * and this adapter is the only thing in the web process that knows their names.
 *
 * There is deliberately no way to pass raw SQL through here.
 */

/**
 * Functions the desktop may call. Anything not in this list is rejected before a request is made, so
 * a caller-influenced function name can never reach the database.
 */
const ALLOWED_DESKTOP_FUNCTIONS = new Set([
  'desktop_create_connect_code',
  'desktop_connect_code_status',
  'desktop_authorize_connect_code',
  'desktop_exchange_connect_code',
  'desktop_refresh_session',
  'desktop_session_context',
  'desktop_revoke_session',
  'desktop_remember_workspace',
  'desktop_list_workspaces',
  'desktop_ensure_meeting',
]);

export function createDesktopRpc(client: Pick<SupabaseClient, 'rpc'>): DesktopRpc {
  return {
    async call(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
      if (!ALLOWED_DESKTOP_FUNCTIONS.has(fn)) {
        throw new Error(`Blocked call to a non-allowlisted database function: ${fn}`);
      }
      const { data, error } = await client.rpc(fn, args);
      if (error) throw error;
      return data;
    },
  };
}
