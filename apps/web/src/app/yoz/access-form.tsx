'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';

export function AccessForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mx-auto mt-16 max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const response = await fetch('/api/quick/access', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        }).catch(() => null);
        setBusy(false);
        if (response?.ok) router.refresh();
        else
          setError(
            ((await response?.json().catch(() => null)) as { error?: string } | null)?.error ??
              'Xatolik',
          );
      }}
    >
      <KeyRound className="h-8 w-8 text-teal-700" />
      <h1 className="mt-3 text-xl font-semibold text-slate-900">Kirish kodi</h1>
      <p className="mt-1 text-sm text-slate-500">Jamoangiz administratori bergan kodni kiriting.</p>
      <input
        type="password"
        autoFocus
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-teal-600"
        aria-label="Kirish kodi"
      />
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
      <button
        type="submit"
        disabled={busy || !code}
        className="mt-4 w-full rounded-lg bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-60"
      >
        Kirish
      </button>
    </form>
  );
}
