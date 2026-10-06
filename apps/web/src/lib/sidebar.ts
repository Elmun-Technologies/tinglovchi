/**
 * The sidebar preference, shared by the action that writes it and the layout that reads it.
 *
 * It lives outside `actions/product.ts` on purpose: a `'use server'` module may only export async functions, so
 * anything else the shell needs has to come from a plain module.
 */
export const SIDEBAR_COOKIE = 'suhbat_sidebar';
export const SIDEBAR_COLLAPSED = 'collapsed';

export function isSidebarCollapsed(value: string | undefined | null): boolean {
  return value === SIDEBAR_COLLAPSED;
}
