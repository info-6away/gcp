'use client';

// Fixed-top banner that appears only when navigator.onLine is false.
// Driven by the browser's online / offline events plus an initial sync
// on mount. Renders nothing in the online state, so it has no layout
// cost during normal operation.

import { useEffect, useState } from 'react';

export default function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online',  update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online',  update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      style={{
        position:    'fixed',
        top:         0,
        left:        0,
        right:       0,
        zIndex:      9999,
        padding:     '4px 8px',
        background:  'rgba(239, 68, 68, 0.18)',
        borderBottom: '1px solid rgba(239, 68, 68, 0.5)',
        color:       '#ef4444',
        fontFamily:  "'IBM Plex Mono', ui-monospace, monospace",
        fontSize:    9,
        letterSpacing: '0.12em',
        textAlign:   'center',
        pointerEvents: 'none',
      }}
    >
      OFFLINE MODE — DATA DELAYED
    </div>
  );
}
