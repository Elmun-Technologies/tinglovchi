import Link from 'next/link';
import { Building2, FolderKanban, Headphones, Home, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { signOutAction } from '../actions/auth';

const navigation = [
  { label: 'Home', icon: Home, anchor: '' },
  { label: 'Meetings', icon: Headphones, anchor: '#meetings' },
  { label: 'Companies', icon: Building2, anchor: '#companies' },
  { label: 'Projects', icon: FolderKanban, anchor: '#projects' },
  { label: 'Settings', icon: Settings2, anchor: '#settings' },
];

export function WorkspaceShell({
  children,
  workspaceId,
  workspaceName,
  userEmail,
}: {
  children: ReactNode;
  workspaceId?: string;
  workspaceName?: string;
  userEmail: string;
}) {
  const basePath = workspaceId ? `/w/${workspaceId}` : '/';
  const visibleNavigation = workspaceId ? navigation : navigation.slice(0, 1);

  return (
    <div className="min-h-screen bg-[#f7f8fa] lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-white lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col">
          <div className="flex h-[76px] items-center gap-3 border-b border-slate-100 px-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-800 text-white">
              <Headphones size={18} strokeWidth={2.2} />
            </div>
            <div>
              <p className="text-sm font-bold tracking-tight text-slate-950">
                {process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'SUHBAT AI'}
              </p>
              <p className="text-[11px] font-medium text-slate-500">Meeting memory</p>
            </div>
          </div>

          <div className="px-4 pt-5">
            <p className="px-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
              Workspace
            </p>
            <Link
              href="/"
              className="mt-2 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 hover:bg-slate-100"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-sm font-bold text-teal-800 shadow-sm ring-1 ring-slate-200">
                {(workspaceName || 'W').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">
                  {workspaceName || 'All workspaces'}
                </p>
                <p className="text-xs text-slate-500">Company memory</p>
              </div>
            </Link>
          </div>

          <nav
            className="flex gap-1 overflow-x-auto px-4 py-5 lg:flex-col"
            aria-label="Main navigation"
          >
            {visibleNavigation.map(({ label, icon: Icon, anchor }, index) => (
              <Link
                key={label}
                href={`${basePath}${anchor}`}
                aria-current={index === 0 ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  index === 0
                    ? 'bg-teal-50 text-teal-900'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                }`}
              >
                <Icon size={17} strokeWidth={1.8} />
                {label}
              </Link>
            ))}
          </nav>

          <div className="mt-auto hidden border-t border-slate-100 p-4 lg:block">
            <div className="mb-3 truncate px-2 text-xs text-slate-500" title={userEmail}>
              {userEmail}
            </div>
            <form action={signOutAction}>
              <button className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-2.5 lg:hidden">
          <span className="min-w-0 truncate text-xs text-slate-500">{userEmail}</span>
          <form action={signOutAction}>
            <button className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
              Sign out
            </button>
          </form>
        </div>
        <div className="mx-auto w-full max-w-[1440px] px-5 py-7 sm:px-8 lg:px-10 lg:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
