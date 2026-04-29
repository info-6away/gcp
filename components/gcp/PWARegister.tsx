'use client';

// Registers /sw.js after window.load AND surfaces an update toast when
// a new service worker is installed but waiting. Click REFRESH ->
// postMessage SKIP_WAITING to the waiting SW -> browser fires
// controllerchange -> we reload so the new bundle takes over.
// No auto-refresh: the user must click.

import { useEffect, useState } from 'react';

export default function PWARegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const watchInstalling = (sw: ServiceWorker | null) => {
      if (!sw) return;
      const onState = () => {
        // 'installed' + an existing controller means this is an UPDATE,
        // not the first ever install. (First install has no controller
        // yet -- we don't want to prompt on initial visit.)
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          console.log('[SW] update available, showing toast');
          setWaiting(sw);
        }
      };
      sw.addEventListener('statechange', onState);
    };

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(reg => {
          console.log('[SW] registered, scope:', reg.scope);

          // A waiting worker may already exist if the user reloaded
          // twice quickly or if a previous tab installed the new SW.
          if (reg.waiting && navigator.serviceWorker.controller) {
            setWaiting(reg.waiting);
          }

          // Future updates: updatefound fires when registration.installing
          // becomes non-null, before it transitions to installed/waiting.
          reg.addEventListener('updatefound', () => watchInstalling(reg.installing));
        })
        .catch(e => console.warn('[SW] registration failed', e));
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    // Reload exactly once after a new SW takes control. Guard prevents
    // a controllerchange storm from looping reloads if the user has
    // multiple tabs open and a different one initiated the activation.
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  if (!waiting) return null;

  const refresh = () => {
    // Tell the waiting SW to skipWaiting; the controllerchange listener
    // above will reload the page once activation completes.
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <div
      role="status"
      style={{
        position:    'fixed',
        bottom:      16,
        left:        '50%',
        transform:   'translateX(-50%)',
        zIndex:      9998,
        background:  'rgba(13, 15, 18, 0.96)',
        border:      '1px solid #4dd9e8',
        borderRadius: 4,
        padding:     '8px 12px 8px 14px',
        fontFamily:  "'IBM Plex Mono', ui-monospace, monospace",
        fontSize:    10,
        color:       '#aeb4bf',
        display:     'flex',
        alignItems:  'center',
        gap:         12,
        boxShadow:   '0 4px 14px rgba(0, 0, 0, 0.45)',
        letterSpacing: '0.04em',
      }}
    >
      <span>New version available</span>
      <button
        onClick={refresh}
        style={{
          padding:       '3px 12px',
          background:    'transparent',
          border:        '1px solid #4dd9e8',
          color:         '#4dd9e8',
          fontFamily:    'inherit',
          fontSize:      9,
          letterSpacing: '0.12em',
          borderRadius:  2,
          cursor:        'pointer',
        }}
      >
        REFRESH
      </button>
    </div>
  );
}
