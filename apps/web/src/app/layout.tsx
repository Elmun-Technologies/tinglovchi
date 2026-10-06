import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

const productName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'SUHBAT AI';

export const metadata: Metadata = {
  title: {
    default: productName,
    template: `%s · ${productName}`,
  },
  description: 'A secure workspace for company meeting memory.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
