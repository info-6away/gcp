'use client';

// Registers /sw.js after window.load AND surfaces an update toast when
// a new service worker is installed but waiting. Click REFRESH ->
// postMessage SKIP_WAITING to the waiting SW -> browser fires
// controllerchange -> we reload so the new bundle takes over.
// No auto-refresh: the user must click.
//
// v11.24.3: full audit pass for update detection.
//   - reg.update() runs every 60 s, on visibilitychange, and on focus.
//   - updatefound listener watches the installing worker through to
//     the 'installed' state; if a controller exists, surface the toast.
//   - registration is published to lib/pwaUpdate so the Settings
//     "Check for Updates" button can call reg.update() on demand.
//   - Dev logs use the spec'd `[PWA] ...` strings so the upgrade flow
//     can be traced in the browser console end-to-end.

import { useEffect, useState } from 'react';
import { setRegistration } from '@/lib/pwaUpdate';

export default function PWARegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const watchInstalling = (sw: ServiceWorker | null) => {
      if (!sw) return;
      const onState = () => {
        if (sw.state === 'installed') {
          console.log('[PWA] worker installed');
          // 'installed' + an existing controller means this is an UPDATE,
          // not the first ever install. (First install has no controller
          // yet -- we don't want to prompt on initial visit.)
          if (navigator.serviceWorker.controller) {
            console.log('[PWA] waiting worker available');
            setWaiting(sw);
          }
        }
      };
      sw.addEventListener('statechange', onState);
    };

    let registration: ServiceWorkerRegistration | null = null;
    let updateInterval: ReturnType<typeof setInterval> | null = null;

    // v11.16.1: previously the toast only surfaced if the user navigated
    // (page load triggered the SW fetch) or the browser happened to do
    // its own update check. On a long-open desktop tab nothing kicked
    // reg.update(), so a deploy could sit unnoticed for hours. Add a
    // 60 s heartbeat plus a visibility-change check so the next time the
    // user looks at the tab, we've already noticed the new SW. Network
    // cost is one HEAD-equivalent fetch of /sw.js per minute.
    const POLL_MS = 60_000;

    const checkForUpdate = () => {
      if (!registration) return;
      console.log('[PWA] checking for update');
      registration.update().catch(e => console.debug('[PWA] update check failed', e));
    };

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(reg => {
          registration = reg;
          setRegistration(reg);
          console.log('[PWA] registered, scope:', reg.scope);

          // A waiting worker may already exist if the user reloaded
          // twice quickly or if a previous tab installed the new SW.
          if (reg.waiting && navigator.serviceWorker.controller) {
            console.log('[PWA] waiting worker available (already present)');
            setWaiting(reg.waiting);
          }

          // Future updates: updatefound fires when registration.installing
          // becomes non-null, before it transitions to installed/waiting.
          reg.addEventListener('updatefound', () => {
            console.log('[PWA] updatefound');
            watchInstalling(reg.installing);
          });

          // Kick the first poll so a deploy that happened seconds ago
          // is found before the user notices the page is "old".
          checkForUpdate();
          updateInterval = setInterval(checkForUpdate, POLL_MS);
        })
        .catch(e => console.warn('[PWA] registration failed', e));
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    // Visibility heartbeat: when the tab gains focus after being hidden
    // (unlocked phone, switched back to the tab, woke from sleep), check
    // immediately rather than waiting for the next 60 s tick.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Belt-and-braces: some browsers fire focus but not visibilitychange
    // when switching between windows on the same monitor.
    window.addEventListener('focus', checkForUpdate);

    // Reload exactly once after a new SW takes control. Guard prevents
    // a controllerchange storm from looping reloads if the user has
    // multiple tabs open and a different one initiated the activation.
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      console.log('[PWA] controller changed — reloading');
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', checkForUpdate);
      if (updateInterval !== null) clearInterval(updateInterval);
      setRegistration(null);
    };
  }, []);

  if (!waiting) return null;

  const refresh = () => {
    console.log('[PWA] refresh clicked');
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
