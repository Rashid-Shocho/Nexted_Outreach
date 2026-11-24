import type { Metadata } from 'next';
import { Outfit } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'nextED Outreach', template: '%s · nextED Outreach' },
  robots: { index: false, follow: false },
  icons: { icon: '/branding/nexted-icon-64.png', apple: '/branding/nexted-icon-180.png' },
};

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body>{children}</body>
    </html>
  );
}
