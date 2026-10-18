import type { ReactNode } from 'react';
import { accessState } from '../../lib/quick/access';
import { AccessForm } from './access-form';

/** Renders the children only for callers who passed the access code. */
export async function AccessGate({ children }: { children: ReactNode }) {
  const state = await accessState();
  if (state === 'open' || state === 'granted') return <>{children}</>;
  if (state === 'required') return <AccessForm />;
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-900">
      <h1 className="text-lg font-semibold">Server sozlanmagan</h1>
      <p className="mt-2 text-sm">
        Yozuvlar maxfiy bo‘lgani uchun serverda <code>SUHBAT_ACCESS_CODE</code> o‘rnatilishi shart.
        Uni o‘rnatib, serverni qayta ishga tushiring.
      </p>
    </div>
  );
}
