'use client';

// v11.15.3: 1 Hz countdown helper for the Settings boot/connection
// rows. Pure UX — does not interact with polling. Returns the integer
// seconds remaining to `target` (clamped to >= 0). When target is null
// the hook still ticks at 1 Hz so calling components can render
// "Initializing…" placeholders that visibly animate.

import { useEffect, useState } from 'react';

export function useCountdown(target: Date | null): number {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!target) return 0;
  const remaining = Math.ceil((target.getTime() - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}
