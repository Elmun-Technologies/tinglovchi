import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@suhbat/ui';
import { RepositoryError } from '@suhbat/product';
import {
  dataMode,
  getRepositories,
  resolveAccess,
  type AccessFailureReason,
} from '../../../lib/repositories';
import { isSidebarCollapsed, SIDEBAR_COOKIE } from '../../../lib/sidebar';
import { AppShell } from '../../components/app-shell';
import { ui } from '../../../copy/ui-copy';

/**
 * Every product screen hangs off this layout: access check, data-mode selection, adapter read for the frame,
 * then the shell. A page never opens a database client or a provider connection of its own.
 */
export default async function WorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>;
  children: ReactNode;
}) {
  const { workspaceId } = await params;
  const access = await resolveAccess(workspaceId);

  if (!access.ok) {
    return <WorkspaceUnavailable reason={access.reason} />;
  }

  const repositories = getRepositories();
  let workspaces: Awaited<ReturnType<typeof repositories.workspaces.list>>;
  let recorder: Awaited<ReturnType<typeof repositories.desktop.status>>;
  try {
    [workspaces, recorder] = await Promise.all([
      repositories.workspaces.list(),
      repositories.desktop.status(),
    ]);
  } catch (cause) {
    // A repository failure is a page-level state, not a crash: membership checks, RLS and a missing
    // Supabase configuration all fail closed, and the shell says which of them happened.
    return <WorkspaceUnavailable reason={reasonOf(cause)} />;
  }

  const store = await cookies();

  return (
    <AppShell
      workspaceId={workspaceId}
      workspaceName={access.access.workspaceName}
      workspaces={workspaces}
      capabilities={repositories.capabilities}
      account={{ email: access.access.email, role: access.access.role }}
      collapsed={isSidebarCollapsed(store.get(SIDEBAR_COOKIE)?.value)}
      recorder={{ state: recorder.state, detail: recorder.detail }}
    >
      {children}
    </AppShell>
  );
}

/** Maps a thrown repository error onto the same vocabulary the access check uses. */
function reasonOf(cause: unknown): AccessFailureReason {
  if (cause instanceof RepositoryError) {
    if (cause.code === 'unauthorized') return 'signed_out';
    if (cause.code === 'not_configured') return 'not_configured';
    if (cause.code === 'not_found') return 'not_found';
  }
  return 'provider_unavailable';
}

function WorkspaceUnavailable({ reason }: { reason: AccessFailureReason }) {
  const notConfigured = reason === 'not_configured';
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fa] px-5 py-12">
      <Card className="w-full max-w-xl p-7 sm:p-9">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-800">
          {notConfigured ? ui.errors.notConfiguredTitle : ui.errors.workspaceUnavailableTitle}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          {notConfigured ? ui.errors.notConfiguredTitle : ui.errors.workspaceUnavailableTitle}
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {notConfigured ? ui.errors.notConfiguredBody : ui.errors.workspaceUnavailableBody}
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Reason code: <code className="font-mono">{reason}</code>
          {dataMode() === 'demo' ? ' · demo data source' : ''}
        </p>
        <div className="mt-6 flex items-center gap-2">
          <Link
            href="/"
            className="inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
          >
            {ui.common.back}
          </Link>
          <Link
            href="/login"
            className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {ui.errors.signedOut}
          </Link>
        </div>
      </Card>
    </main>
  );
}
