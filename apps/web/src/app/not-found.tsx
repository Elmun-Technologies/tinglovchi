import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fa] px-5 py-12">
      <div className="max-w-md text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-800">Not found</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
          Workspace unavailable
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          It may not exist, or your account may not have access.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-teal-800 hover:text-teal-950"
        >
          <ArrowLeft size={16} /> Return to your workspaces
        </Link>
      </div>
    </main>
  );
}
