// Single source of truth for pattern code, gold interpretation, and
// invalidator copy used in the structured Pattern output (spec §8). UI
// components (ChartView markers, Dashboard cards, PatternDetail library,
// mobile Patterns screen) keep their own visual metadata for now and just
// add entries for the new kinds; this file feeds the data side only.

import type { PatternKind, RegimeId } from '@/types/gcp';

export const REGIME_NAME: Record<RegimeId, string> = {
  A: 'Silence',
  B: 'Ignition',
  C: 'Alignment',
  D: 'Synchronization',
  E: 'Climax',
  F: 'Shock',
};

export function regimeForValue(v: number): RegimeId {
  if (v < 50)  return 'A';
  if (v < 100) return 'B';
  if (v < 140) return 'C';
  if (v < 170) return 'D';
  if (v < 220) return 'E';
  return 'F';
}

export const PATTERN_CODE: Record<PatternKind, string> = {
  'Compression Coil':         'CC',
  'Alignment Ladder':         'AL',
  'Compression Release':      'CR',
  'Failed Alignment':         'FA',
  'Coherence Volcano':        'CV',
  'Ignition Drift':           'ID',
  'Shock Jump':               'SJ',
  'Ignition Rise':            'IR',
  'Pulse Train':              'PT',
  'Staircase Alignment':      'SA',
  'Dead Drift':               'DD',
  'Echo Spike':               'ES',
  'Discharge Break':          'DB',
  'Discharge Wave':           'DW',
  'Double Spike Exhaustion':  'DSE',
  'Synchronization Plateau':  'SP',
};

export const PATTERN_GLYPH: Record<PatternKind, string> = {
  'Compression Coil':         'AB# sustained',
  'Alignment Ladder':         'AB# → B↑ → C → D#',
  'Compression Release':      'AB# → B↑ → C',
  'Failed Alignment':         'AB# → B → C → B → A',
  'Coherence Volcano':        'A → B → C → B → A',
  'Ignition Drift':           'B ↔ B',
  'Shock Jump':               'B → F',
  'Ignition Rise':            'AB# → B↑',
  'Pulse Train':              'A → B → A → B …',
  'Staircase Alignment':      'B↑ → C↑',
  'Dead Drift':               'A chop',
  'Echo Spike':               'D/E peak → smaller D/E',
  'Discharge Break':          'D/E → B/A',
  'Discharge Wave':           'A → E → A',
  'Double Spike Exhaustion':  'A → E → A → E → A',
  'Synchronization Plateau':  'C → D# sustained',
};

export const PATTERN_GOLD_INTERP: Record<PatternKind, string> = {
  'Compression Coil':
    'Accumulation / liquidity building. No directional edge until release.',
  'Alignment Ladder':
    'Strongest trend-continuation setup. Favor directional entries with tight invalidation.',
  'Compression Release':
    'Breakout forming. Trend confirmation requires C hold or D move.',
  'Failed Alignment':
    'Fake breakout risk. Historically low continuation. Consider fading.',
  'Coherence Volcano':
    'Short impulse / reaction move. Trend unlikely; expect mean-reversion.',
  'Ignition Drift':
    'Indecision / range. Wait for C alignment before committing.',
  'Shock Jump':
    'Major news/geopolitical shock. Extreme volatility — trade reduced size.',
  'Ignition Rise':
    'Early breakout environment. Watch for C confirmation to size up.',
  'Pulse Train':
    'Repeated sync attempts. Pressure building; resolution likely.',
  'Staircase Alignment':
    'Stealth trend build. High-quality continuation precursor.',
  'Dead Drift':
    'Low signal environment. No GCP edge — defer to price-only setups.',
  'Echo Spike':
    'Aftershock / weaker continuation. Original move likely fading.',
  'Discharge Break':
    'Trend exhaustion. Momentum fading — watch for reversal.',
  'Discharge Wave':
    'Emotional move / volatility burst. Possible exhaustion event.',
  'Double Spike Exhaustion':
    'Coherence discharge complete. Likely post-event vacuum.',
  'Synchronization Plateau':
    'Strong gold trend continuation zone. One of the highest-quality setups.',
};

export const PATTERN_INVALIDATORS: Record<PatternKind, string[]> = {
  'Compression Coil': [
    'Sustained move above 100 (becomes Compression Release)',
    'Drop and stay below 30 with low CED (becomes Dead Drift)',
  ],
  'Alignment Ladder': [
    'Drop back below 100 within 30 minutes',
    'Failure to reach D regime',
    'Negative curvature after the climb',
  ],
  'Compression Release': [
    'Drop back below 50',
    'Negative curvature',
    'Failure to hold above 100',
  ],
  'Failed Alignment': [
    'Recovery back above 100 with positive slope',
    'New A/B compression resets the pattern',
  ],
  'Coherence Volcano': [
    'Reaches D and holds (becomes Alignment Ladder)',
    'Returns to A with rising baseline (becomes Staircase)',
  ],
  'Ignition Drift': [
    'Sustained move above 100',
    'Drop below 50 with structural compression',
  ],
  'Shock Jump': [
    'Single-bar artifact at a data boundary (false positive)',
    'Decay back below 170 within 5 minutes',
  ],
  'Ignition Rise': [
    'Drop back below 50',
    'Negative slope or flattening',
    'Failure to reach C in next 30 minutes',
  ],
  'Pulse Train': [
    'Sustained C hold (becomes Compression Release)',
    'Decay to flat A drift (becomes Dead Drift)',
  ],
  'Staircase Alignment': [
    'Lower low breaks the rising baseline',
    'Drop and hold below 50',
  ],
  'Dead Drift': [
    'CED rises (becomes Compression Coil)',
    'Sustained move above 50',
  ],
  'Echo Spike': [
    'Second peak exceeds first (no longer an echo)',
    'Third sustained peak (becomes Pulse Train)',
  ],
  'Discharge Break': [
    'Recovery back above 140',
    'New D run starts within 15 minutes',
  ],
  'Discharge Wave': [
    'Sustained D/E hold (becomes Synchronization Plateau)',
    'Second spike of similar size (becomes Double Spike Exhaustion)',
  ],
  'Double Spike Exhaustion': [
    'Third spike exceeds prior peaks',
    'D regime sustains after the second spike',
  ],
  'Synchronization Plateau': [
    'Drop below 100 within 30 minutes',
    'Spike to E (becomes Climax / Discharge Wave)',
  ],
};
