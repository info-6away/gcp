import type { MetadataRoute } from 'next';

// Web App Manifest for GCP Pro. Next.js App Router serves this at /manifest.webmanifest
// automatically (the route is wired up by the framework when this file exists).
//
// v11.10 scope: installability shell only. Service worker, offline cache, and
// API fallbacks come in v11.11+. Existing v11.9 local notifications continue to
// work in standalone mode without any push infrastructure.
//
// Icons referenced below must exist at /public/icon-192.png and /public/icon-512.png.
// SVG icon (app/icon.svg, app/apple-icon.svg) stays in place for browser tab + iOS
// touch icon; manifest just adds the raster sizes Android / Chrome installer wants.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'GCP Pro',
    short_name:       'GCP',
    description:      'Coherence regime terminal — XAUUSD / BTC / XAGUSD',
    start_url:        '/',
    scope:            '/',
    display:          'standalone',
    orientation:      'any',
    background_color: '#07080a',
    theme_color:      '#07080a',
    categories:       ['finance', 'productivity'],
    icons: [
      {
        src:     '/icon-192.png',
        sizes:   '192x192',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/icon-512.png',
        sizes:   '512x512',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/icon-512.png',
        sizes:   '512x512',
        type:    'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
