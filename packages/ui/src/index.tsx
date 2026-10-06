/**
 * Shared product UI. The rule for this package: components take typed product objects and hrefs, never fetch
 * data, never decide what a status means (that lives in `@suhbat/product`), and never pretend an unwired
 * capability works.
 */
export * from './primitives';
export * from './badges';
export * from './states';
export * from './structure';
export * from './evidence';
export * from './transcript';
export * from './analysis';
export * from './icons';
export { Modal } from './modal';

import type { ReactNode } from 'react';

/**
 * Kept for the Phase 1 screens, which render a plain status pill from raw database values. New screens use
 * the vocabulary badges, which cannot drift from the domain.
 */
export function StatusBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
      {children}
    </span>
  );
}
