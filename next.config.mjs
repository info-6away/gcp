/** @type {import('next').NextConfig} */
const nextConfig = {
  // v11.16.1: force /sw.js to always revalidate. Vercel's default
  // static-asset caching would let the browser serve a stale copy of
  // the service worker for hours, so reg.update() (60 s poll in
  // PWARegister) would never see the new file. With max-age=0 the
  // browser performs a conditional fetch each time, the SW file lands
  // fresh, and the update toast surfaces.
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
