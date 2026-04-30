'use client';

// v11.15.4: a single dot used across Settings, Header, and the mobile
// status bar to communicate that a feed is alive without requiring the
// user to read text. Three modes:
//
//   live   — green pulse at 1.6 s, the same gentle rhythm livepulse has
//            been using. Means the feed produced data within the last
//            poll cycle.
//   init   — grey pulse at 2.4 s. Boot phase, before the first response.
//            Slow enough to read as "settling" rather than "broken".
//   stale  — red slow pulse at 3 s. Means the feed previously worked
//            but the most recent attempt failed; we're still retrying.
//
// `disabled` (no animation, dim grey) is for feeds that are switched
// off via settings, not for transient outages.

import { memo } from 'react';

export type HeartbeatMode = 'live' | 'init' | 'stale' | 'disabled';

interface Props {
  mode:   HeartbeatMode;
  size?:  number;
  glow?:  boolean;
  title?: string;
}

const MODE_COLOUR: Record<HeartbeatMode, string> = {
  live:     'var(--green)',
  init:     'var(--fg-3)',
  stale:    'var(--red)',
  disabled: 'var(--fg-4)',
};

const MODE_ANIMATION: Record<HeartbeatMode, string> = {
  live:     'livepulse 1.6s ease-in-out infinite',
  init:     'heartbeat-init 2.4s ease-in-out infinite',
  stale:    'heartbeat-stale 3s ease-in-out infinite',
  disabled: 'none',
};

function Heartbeat({ mode, size = 7, glow = true, title }: Props) {
  const colour = MODE_COLOUR[mode];
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        width: size, height: size, borderRadius: '50%',
        background: colour,
        boxShadow: glow && mode === 'live'
          ? `0 0 5px ${colour}` : 'none',
        animation: MODE_ANIMATION[mode],
        flexShrink: 0,
      }}
    />
  );
}

export default memo(Heartbeat);
