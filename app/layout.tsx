import type { Metadata, Viewport } from 'next';
import './globals.css';
import PWARegister  from '@/components/gcp/PWARegister';
import OfflineBanner from '@/components/gcp/OfflineBanner';

export const metadata: Metadata = {
  title:       'GCP Pro — Coherence Regime Terminal',
  description: 'Global Consciousness Project regime analysis for XAUUSD',
  applicationName: 'GCP Pro',
  appleWebApp: {
    capable:        true,
    title:          'GCP Pro',
    statusBarStyle: 'black-translucent',
  },
  // Manifest is wired up automatically by Next.js once app/manifest.ts
  // exists, but declaring it explicitly here is harmless and keeps the
  // intent visible in one place.
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor:       '#07080a',
  // Stops iOS Safari from auto-zooming on input focus and prevents the
  // user pinch-zooming the chart out of position when running as PWA.
  width:            'device-width',
  initialScale:     1,
  viewportFit:      'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <PWARegister />
        <OfflineBanner />
        {children}
      </body>
    </html>
  );
}
