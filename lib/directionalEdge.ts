// v13.6: Directional Edge descriptor.
//
// Translates the existing long/short pressure values + structural
// dominance + temporal momentum into a single readable label like
// "UP · MOD" or "DOWN · STRONG" so the SIMPLE-mode hero meter has a
// glance-readable summary instead of 57/43 percentages.
//
// The detailed LONG/SHORT numerals + the structural-dominance label
// + the alignment indicator all stay available in ANALYST / RESEARCH
// modes — this is just the simplified mode's shorthand.
//
// IMPORTANT: pure helper. Reads only fields already attached to
// GcpStateResponse (pressure + structure + momentum), so the SDK
// integration, math, and Engine prompt are untouched.

import type { GcpStateResponse } from '@/lib/engine-gcp';

export type EdgeDirection = 'up' | 'down' | 'flat';
export type EdgeStrength  = 'WEAK' | 'MOD' | 'STRONG';

export interface DirectionalEdge {
  direction:    EdgeDirection;
  strength:     EdgeStrength;
  /** Compact label suitable for the hero meter, e.g. "UP · MOD". */
  label:        string;
  /** 0..1 — magnitude of the skew. Drives the meter's progress bar. */
  bar:          number;
  /** Hex color matching the rest of the v13.4 palette. */
  color:        string;
  /** One-line elaboration shown under the label, e.g.
   *  "Bullish trend weakening · skew +14". */
  detail:       string;
}

export function deriveDirectionalEdge(
  aiState: GcpStateResponse | null,
): DirectionalEdge {
  if (!aiState) {
    return {
      direction: 'flat',
      strength:  'WEAK',
      label:     'NO READ',
      bar:       0,
      color:     'var(--fg-3)',
      detail:    'Awaiting Guru classification.',
    };
  }

  const long  = aiState.longPressure  ?? 50;
  const short = aiState.shortPressure ?? 50;
  const skew  = long - short;            // signed
  const absSkew = Math.abs(skew);

  // Direction from skew; flat band is intentional — < 8 absolute
  // points reads as "balanced" rather than "weak long" / "weak short".
  let direction: EdgeDirection;
  if (skew >=  8)      direction = 'up';
  else if (skew <= -8) direction = 'down';
  else                 direction = 'flat';

  // Strength tiers map to the expressive ranges from v13.1.1:
  //   weak     45-55 → |skew| <= 10  → WEAK
  //   moderate 60-40 → |skew| 11-25  → MOD
  //   strong   70-30 → |skew| 26+    → STRONG
  let strength: EdgeStrength;
  if (absSkew <= 10)      strength = 'WEAK';
  else if (absSkew <= 25) strength = 'MOD';
  else                    strength = 'STRONG';

  // Color from direction. Flat reads as neutral grey.
  const color =
    direction === 'up'   ? '#22c55e'
  : direction === 'down' ? '#c45a5a'
  :                        'var(--fg-3)';

  // Compact label.
  const dirToken = direction === 'up'   ? 'UP'
                 : direction === 'down' ? 'DOWN'
                 :                        'FLAT';
  const label = direction === 'flat' ? 'BALANCED' : `${dirToken} · ${strength}`;

  // Detail line. Prefer the structural-dominance label when present
  // because it adds context (e.g. "Bullish trend intact · skew +14"),
  // otherwise fall back to pressure explanation, otherwise generic.
  const domLabel =
    aiState.structureDominance === 'bullish'         ? 'Bullish trend intact'
  : aiState.structureDominance === 'fragile_bullish' ? 'Bullish trend weakening'
  : aiState.structureDominance === 'bearish'         ? 'Bearish structure intact'
  : aiState.structureDominance === 'fragile_bearish' ? 'Bearish structure weakening'
  :                                                     null;

  const detailParts: string[] = [];
  if (domLabel) detailParts.push(domLabel);
  else if (aiState.pressureExplanation) detailParts.push(aiState.pressureExplanation);
  if (skew !== 0) {
    detailParts.push(`skew ${skew > 0 ? '+' : ''}${skew}`);
  }
  const detail = detailParts.length > 0
    ? detailParts.join(' · ')
    : 'No structural edge detected.';

  return {
    direction,
    strength,
    label,
    bar: Math.min(1, absSkew / 35),  // 35-point skew → full bar
    color,
    detail,
  };
}
