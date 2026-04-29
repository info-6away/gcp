'use client';

// Registers /sw.js after window.load so the SW install doesn't compete
// with the initial render. v11.13 will add an update toast that listens
// for `updatefound` on the registration; for now we silently install
// and activate.

import { useEffect } from 'react';

export default function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(reg => {
          console.log('[SW] registered, scope:', reg.scope);
        })
        .catch(e => {
          console.warn('[SW] registration failed', e);
        });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  return null;
}
