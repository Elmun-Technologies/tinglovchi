import Link from 'next/link';
import { ChevronsLeft, ChevronsRight, Headphones, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { routes, type DataCapabilities, type WorkspaceSummary } from '@suhbat/product';
import { Badge, ButtonLink, Disclosure, DisclosureItem, Dot, Notice } from '@suhbat/ui';
import { ui } from '../../copy/ui-copy';
import { toggleSidebarAction } from '../actions/product';
import { AppNav } from './app-nav';

/**
 * Application frame: sidebar navigation, workspace selector, global search, account control.
 *
 * Everything here is server-rendered. The collapse toggle is a form that writes a cookie, and the workspace
 * selector is a disclosure of links — so the frame needs no state manager, works with JS disabled, and cannot
 * flash the wrong layout on first paint.
 */
export function AppShell({
  workspaceId,
  workspaceName,
  workspaces,
  capabilities,
  account,
  collapsed,
  recorder,
  children,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaces: WorkspaceSummary[];
  capabilities: DataCapabilities;
  account: { email: string | null; role: string };
  collapsed: boolean;
  recorder?: { state: string; detail: string };
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f7f8fa] lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-slate-950 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        {ui.a11y.skip}
      </a>
      <aside className="border-b border-slate-200 bg-white lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col">
          <div
            className={`flex h-[60px] items-center gap-2.5 border-b border-slate-100 px-4 ${collapsed ? 'lg:justify-center lg:px-2' : ''}`}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-800 text-white">
              <Headphones size={16} strokeWidth={2.1} />
            </span>
            <span className={`min-w-0 ${collapsed ? 'lg:hidden' : ''}`}>
              <span className="block truncate text-[13.5px] font-bold tracking-tight text-slate-950">
                {ui.brand.name}
              </span>
              <span className="block text-[11px] font-medium text-slate-500">Meeting memory</span>
            </span>
            <form action={toggleSidebarAction} className="ml-auto hidden lg:block">
              <input type="hidden" name="next" value={routes.home({ workspaceId })} />
              <button
                type="submit"
                aria-label={collapsed ? ui.nav.expand : ui.nav.collapse}
                title={collapsed ? ui.nav.expand : ui.nav.collapse}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
              </button>
            </form>
          </div>

          <div className={`border-b border-slate-100 px-3 py-3 ${collapsed ? 'lg:px-2' : ''}`}>
            <WorkspaceSelector
              collapsed={collapsed}
              currentId={workspaceId}
              currentName={workspaceName}
              workspaces={workspaces}
            />
          </div>

          <AppNav workspaceId={workspaceId} collapsed={collapsed} />

          <div className={`px-3 pb-3 ${collapsed ? 'lg:flex lg:justify-center lg:px-2' : ''}`}>
            <ButtonLink
              href={routes.newMeeting({ workspaceId })}
              variant="secondary"
              size="sm"
              className={collapsed ? 'lg:w-8 lg:px-0' : 'w-full'}
              title={ui.nav.newMeeting}
            >
              <Plus size={15} />
              <span className={collapsed ? 'lg:hidden' : undefined}>{ui.nav.newMeeting}</span>
            </ButtonLink>
          </div>

          <div className="mt-auto hidden border-t border-slate-100 p-3 lg:block">
            {recorder ? (
              <div
                title={`${ui.newMeeting.recordTitle} — ${recorder.detail}`}
                className={`mb-2.5 flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-[12px] text-slate-600 ${
                  collapsed ? 'lg:justify-center' : ''
                }`}
              >
                <Dot
                  tone={
                    recorder.state === 'not_validated'
                      ? 'warning'
                      : recorder.state === 'available'
                        ? 'success'
                        : 'neutral'
                  }
                />
                <span className={`min-w-0 truncate ${collapsed ? 'lg:hidden' : ''}`}>
                  Desktop recorder: {recorder.state.replace(/_/g, ' ')}
                </span>
              </div>
            ) : null}
            <div
              className={`flex items-center justify-between gap-2 ${collapsed ? 'lg:justify-center' : ''}`}
            >
              <span
                className={`min-w-0 truncate text-[12px] text-slate-500 ${collapsed ? 'lg:hidden' : ''}`}
                title={account.email ?? 'demo session'}
              >
                {account.email ?? 'No signed-in account'}
              </span>
              <Badge
                tone={capabilities.mode === 'demo' ? 'outline' : 'success'}
                title={capabilities.provenanceLabel}
              >
                {capabilities.mode === 'demo' ? ui.demo.badge : 'Live'}
              </Badge>
            </div>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
          <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
            <form
              action={routes.search({ workspaceId }, '')}
              method="get"
              role="search"
              className="relative min-w-0 flex-1 max-w-lg"
            >
              <label htmlFor="global-search" className="sr-only">
                {ui.nav.searchPlaceholder}
              </label>
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Search size={15} />
              </span>
              <input
                id="global-search"
                name="q"
                type="search"
                placeholder={ui.nav.searchPlaceholder}
                className="min-h-9 w-full rounded-lg border border-slate-200 bg-slate-50/70 py-1.5 pl-8 pr-3 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus-visible:border-teal-700 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-teal-600/20"
              />
            </form>
            <div className="ml-auto flex items-center gap-2 lg:hidden">
              <Badge tone="outline" title={capabilities.provenanceLabel}>
                {capabilities.mode === 'demo' ? ui.demo.badge : 'Live'}
              </Badge>
            </div>
            <div className="hidden lg:block">
              <AccountControl email={account.email} role={account.role} workspaceId={workspaceId} />
            </div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="outline-none">
          <div className="mx-auto w-full max-w-[1420px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {capabilities.mode === 'demo' ? (
              <Notice tone="neutral" title={ui.demo.bannerTitle} className="mb-6">
                <p>{ui.demo.bannerBody}</p>
                <p className="text-slate-500">
                  {ui.demo.bannerProvenance}:{' '}
                  <span className="font-medium text-slate-700">{capabilities.provenanceLabel}</span>
                </p>
              </Notice>
            ) : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function WorkspaceSelector({
  currentId,
  currentName,
  workspaces,
  collapsed,
}: {
  currentId: string;
  currentName: string;
  workspaces: WorkspaceSummary[];
  collapsed: boolean;
}) {
  const others = workspaces.filter((workspace) => workspace.id !== currentId);
  return (
    <Disclosure
      align="left"
      className="w-full"
      label={
        <span className={`flex min-w-0 items-center gap-2 ${collapsed ? 'lg:hidden' : ''}`}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white text-[11px] font-bold text-teal-800 ring-1 ring-slate-200">
            {currentName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-slate-800">
            {currentName}
          </span>
        </span>
      }
    >
      <div className="px-1 pb-1 pt-0.5">
        <p className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {ui.nav.switchWorkspace}
        </p>
        <ul className="space-y-0.5">
          <li>
            <span className="flex items-center gap-2 rounded-md bg-slate-100 px-2 py-1.5 text-[12.5px] font-medium text-slate-800">
              <Dot tone="accent" />
              {currentName}
            </span>
          </li>
          {others.map((workspace) => (
            <li key={workspace.id}>
              <Link
                href={routes.home({ workspaceId: workspace.id })}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                <Dot tone="neutral" />
                {workspace.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Disclosure>
  );
}

function AccountControl({
  email,
  role,
  workspaceId,
}: {
  email: string | null;
  role: string;
  workspaceId: string;
}) {
  return (
    <Disclosure
      label={
        <span className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-700">
            {(email ?? 'D').slice(0, 1).toUpperCase()}
          </span>
          <span className="text-[12.5px] font-medium text-slate-700">{role}</span>
        </span>
      }
    >
      <div className="px-1 py-1">
        <p className="px-1.5 text-[12px] text-slate-500">{email ?? ui.demo.badge}</p>
      </div>
      <DisclosureItem
        label={ui.nav.settings}
        href={routes.settings({ workspaceId })}
        icon="refresh"
      />
      <DisclosureItem
        label={ui.nav.signOut}
        href={email ? '/login?notice=signed-out' : '/'}
        hint={email ? undefined : 'No account is signed in during demo review.'}
      />
    </Disclosure>
  );
}
