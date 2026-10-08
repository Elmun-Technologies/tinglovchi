import Link from 'next/link';
import { ArrowLeft, Headphones, ShieldCheck } from 'lucide-react';
import { Button, Card, Field, Input, Notice, Select } from '@suhbat/ui';
import { authorizeDesktopConnectAction } from '../../actions/desktop';

/**
 * `/desktop/connect` — where a signed-in human approves a desktop pairing code.
 *
 * This page is the whole reason the desktop never needs to hold a Supabase credential: the browser
 * session that already exists does the trusting, once. The code itself is short-lived, single use, and
 * worthless until this form is submitted.
 */
export const metadata = {
  title: 'Connect the SUHBAT desktop recorder',
};

type SearchParams = {
  state?: string;
  workspace?: string;
  email?: string;
  reason?: string;
};

export default async function DesktopConnectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { createSupabaseServerClient } = await import('@suhbat/database/server');
  const supabase = await createSupabaseServerClient();
  const { data: authData } = await supabase.auth.getUser();
  const signedIn = Boolean(authData.user);

  const { data: memberships } = signedIn
    ? await supabase
        .from('workspace_members')
        .select('role, membership_status, workspaces ( id, name )')
        .eq('user_id', authData.user!.id)
        .eq('membership_status', 'active')
    : { data: [] };

  const workspaces = (memberships ?? [])
    .map((row) => {
      const workspace = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;
      return workspace && 'id' in workspace
        ? { id: String(workspace.id), name: String(workspace.name), role: String(row.role) }
        : null;
    })
    .filter((value): value is { id: string; name: string; role: string } => value !== null);

  const state = params.state ?? 'idle';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col justify-center px-6 py-12">
      <Link
        href="/"
        className="mb-8 inline-flex w-fit items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft size={16} /> Back to SUHBAT
      </Link>

      <div className="mb-7 flex h-11 w-11 items-center justify-center rounded-xl bg-teal-800 text-white">
        <Headphones size={21} />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
        Connect the desktop recorder
      </h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Enter the one-time code shown in the SUHBAT desktop app. Approving it lets that app record,
        upload, and follow processing for your account — no password is ever entered in the app.
      </p>

      {!signedIn ? (
        <div className="mt-6">
          <Notice tone="warning" title="Sign in first">
            <p>
              You need an active SUHBAT session before a desktop app can be paired.{' '}
              <Link href="/login?next=%2Fdesktop%2Fconnect" className="underline">
                Sign in
              </Link>
              , then return to this page — the code stays valid for ten minutes.
            </p>
          </Notice>
        </div>
      ) : null}

      {state === 'authorized' ? (
        <div className="mt-6">
          <Notice tone="success" title="Desktop app connected">
            <p>
              Approved{params.workspace ? ' for the selected workspace' : ''}. Return to the app — it
              will pick the session up within a couple of seconds.
            </p>
          </Notice>
        </div>
      ) : null}

      {state === 'invalid' ? (
        <div className="mt-6">
          <Notice tone="danger" title="That code is not valid">
            <p>
              Codes are 12 characters in three groups, for example <code>7K4M-9QXB-2T3V</code>. Check
              the app and try again.
            </p>
          </Notice>
        </div>
      ) : null}

      {state === 'expired' ? (
        <div className="mt-6">
          <Notice tone="danger" title="That code expired">
            <p>Codes last ten minutes. Request a new one in the desktop app and try again.</p>
          </Notice>
        </div>
      ) : null}

      {state === 'error' ? (
        <div className="mt-6">
          <Notice tone="danger" title="The code could not be approved">
            <p>
              Nothing was changed. Reason: <code>{params.reason ?? 'unknown'}</code>. Request a new
              code in the desktop app if this repeats.
            </p>
          </Notice>
        </div>
      ) : null}

      {signedIn && workspaces.length === 0 ? (
        <div className="mt-6">
          <Notice tone="warning" title="No active workspace">
            <p>You need an active workspace before the desktop recorder can save meetings into it.</p>
          </Notice>
        </div>
      ) : null}

      {signedIn && workspaces.length > 0 ? (
        <Card className="mt-6 p-5">
          <form action={authorizeDesktopConnectAction} className="space-y-4">
            <Field id="code" label="One-time code">
              <Input
                id="code"
                name="code"
                inputMode="text"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="7K4M-9QXB-2T3V"
                className="font-mono text-base tracking-[0.2em] uppercase"
                required
              />
            </Field>

            <Field id="workspaceId" label="Workspace">
              <Select id="workspaceId" name="workspaceId" defaultValue={params.workspace ?? ''}>
                <option value="">Use my default workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name} ({workspace.role})
                  </option>
                ))}
              </Select>
            </Field>

            <Button type="submit" className="w-full">
              <ShieldCheck size={16} /> Approve this device
            </Button>
          </form>
        </Card>
      ) : null}

      <p className="mt-6 text-xs leading-5 text-slate-500">
        Approving stores only a hash of the code and issues the app its own revocable session. You can
        revoke any device from workspace settings. SUHBAT never asks for your password inside the
        desktop app.
      </p>
    </main>
  );
}
