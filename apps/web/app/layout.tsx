import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Rajdhani, DM_Sans, JetBrains_Mono } from 'next/font/google';
import './styles.css';

/*
 * Font mechanism matches the legacy BharatStudio Alerts dashboard
 * (apps/web/src/app/globals.css: --font-display/--font-sans/--font-mono
 * injected by next/font) and the already-restored bharatstudio-marketing
 * site. next/font/google self-hosts the font files at build time.
 */
const rajdhani = Rajdhani({
  weight: ['600', '700'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-rajdhani',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dm-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  title: 'BharatStudio Alerts',
  description: 'Creator-controlled tipping and stream alerts.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${rajdhani.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
