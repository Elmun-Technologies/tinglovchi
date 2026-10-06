'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  CheckSquare,
  FolderKanban,
  Headphones,
  LayoutDashboard,
  Library,
  MessageSquareText,
  Settings2,
} from 'lucide-react';
import { routes } from '@suhbat/product';
import { ui } from '../../copy/ui-copy';

/**
 * The navigation island. It is the one client component in the shell because "which item is current" depends on
 * the rendered route; everything else around it is server-rendered markup. The list is static, so a route change
 * re-renders these few nodes and nothing else.
 */

export function appNavItems(workspaceId: string) {
  return [
    { key: 'home', href: routes.home({ workspaceId }), label: ui.nav.home, icon: LayoutDashboard },
    {
      key: 'meetings',
      href: routes.meetings({ workspaceId }),
      label: ui.nav.meetings,
      icon: Headphones,
    },
    {
      key: 'companies',
      href: routes.companies({ workspaceId }),
      label: ui.nav.companies,
      icon: Building2,
    },
    {
      key: 'projects',
      href: routes.projects({ workspaceId }),
      label: ui.nav.projects,
      icon: FolderKanban,
    },
    { key: 'tasks', href: routes.tasks({ workspaceId }), label: ui.nav.tasks, icon: CheckSquare },
    {
      key: 'knowledge',
      href: routes.knowledge({ workspaceId }),
      label: ui.nav.knowledge,
      icon: Library,
    },
    { key: 'ask', href: routes.ask({ workspaceId }), label: ui.nav.ask, icon: MessageSquareText },
    {
      key: 'settings',
      href: routes.settings({ workspaceId }),
      label: ui.nav.settings,
      icon: Settings2,
    },
  ] as const;
}

/**
 * Longest-prefix match, so `/w/x/meetings/<id>/transcript` marks Meetings and not Home. `tasks` and `knowledge`
 * are exact-match-only below their own segment to keep nested tab routes from stealing the highlight.
 */
function isActive(pathname: string, href: string, key: string): boolean {
  if (pathname === href) return true;
  if (key === 'home') return false;
  if (key === 'settings') return pathname.startsWith(`${href}/`) || pathname.startsWith(`${href}?`);
  return pathname === href || pathname.startsWith(`${href}/`) || pathname.startsWith(`${href}?`);
}

export function AppNav({ workspaceId, collapsed }: { workspaceId: string; collapsed: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label={ui.a11y.nav} className="px-3 py-3">
      <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {appNavItems(workspaceId).map((item) => {
          const active = isActive(pathname, item.href, item.key);
          return (
            <li key={item.key} className="shrink-0 lg:shrink">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
                  active
                    ? 'bg-teal-50 text-teal-950 ring-1 ring-teal-600/15'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                } ${collapsed ? 'lg:justify-center lg:px-2' : ''}`}
              >
                <item.icon
                  size={17}
                  strokeWidth={1.9}
                  className={active ? 'text-teal-800' : 'text-slate-400'}
                />
                <span className={collapsed ? 'lg:hidden' : undefined}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
