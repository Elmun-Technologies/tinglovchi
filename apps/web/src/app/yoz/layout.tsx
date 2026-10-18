import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Mic } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Suhbatni yozish',
  description:
    'Bitta tugma: suhbat yoziladi va oxirida tahlil, mind map, roadmap va prezentatsiya tayyor bo‘ladi.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f766e' };

export default function QuickLayout({ children }: { children: ReactNode }) {
  return (
    <div lang="uz" className="min-h-screen">
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/yoz" className="flex items-center gap-2 font-semibold text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-700 text-white">
              <Mic className="h-4 w-4" />
            </span>
            Suhbat AI
          </Link>
          <Link
            href="/yoz/tarix"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Barcha suhbatlar
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
