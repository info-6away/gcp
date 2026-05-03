export type AppPage = 'dashboard' | 'pattern' | 'chart' | 'research' | 'trading' | 'settings';

export interface GCPEntry {
  t: number;
  v: number;
}

export type ViewWindow = '24h' | '7d' | '30d' | 'all';

export const VIEW_MINUTES: Record<ViewWindow, number> = {
  '24h':  1_440,
  '7d':   10_080,
  '30d':  43_200,
  'all':  Number.POSITIVE_INFINITY,
};

export const VIEW_LABELS: ViewWindow[] = ['24h', '7d', '30d', 'all'];

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

export const TIMEFRAME_BARS: Record<Timeframe, number> = {
  '1m':  1,
  '5m':  5,
  '15m': 15,
  '1h':  60,
  '4h':  240,
  '1D':  1440,
};

export const TIMEFRAME_LABELS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D'];

export function barDuration(bars: number, tf: Timeframe): string {
  const mins = bars * TIMEFRAME_BARS[tf];
  if (mins < 60)   return `${mins}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1).replace('.0', '')}h`;
  return `${(mins / 1440).toFixed(1).replace('.0', '')}d`;
}

export type MarketSymbol = 'XAUUSD' | 'BTC' | 'XAGUSD';

export interface SymbolMeta {
  id:          MarketSymbol;
  label:       string;
  yahooTicker: string;
  prefix:      string;
  decimals:    number;
  color:       string;
}

export const SYMBOLS: SymbolMeta[] = [
  {
    id:          'XAUUSD',
    label:       'Gold Spot',
    yahooTicker: 'XAUUSD=X',
    prefix:      '$',
    decimals:    2,
    color:       'var(--amber)',
  },
  {
    id:          'BTC',
    label:       'Bitcoin',
    yahooTicker: 'BTC-USD',
    prefix:      '$',
    decimals:    0,
    color:       'oklch(0.75 0.18 55)',
  },
  {
    id:          'XAGUSD',
    label:       'Silver Spot',
    yahooTicker: 'XAGUSD=X',
    prefix:      '$',
    decimals:    3,
    color:       'oklch(0.80 0.04 220)',
  },
];

export function getSymbolMeta(id: MarketSymbol): SymbolMeta {
  return SYMBOLS.find(s => s.id === id) ?? SYMBOLS[0];
}

// v11.23.3: short uppercase label used in AI-context titles. The full
// `label` (e.g. "Gold Spot") is too long; the AI card / settings need
// a one-word environment tag. BTC stays "BTC" because the symbol IS
// the brand; gold/silver collapse to their commodity name.
const SYMBOL_ENV_LABEL: Record<MarketSymbol, string> = {
  XAUUSD: 'GOLD',
  BTC:    'BTC',
  XAGUSD: 'SILVER',
};

export function symbolEnvLabel(id: MarketSymbol): string {
  return SYMBOL_ENV_LABEL[id] ?? id;
}

export function formatPrice(price: number, symbol: MarketSymbol): string {
  const meta = getSymbolMeta(symbol);
  return meta.prefix + price.toLocaleString('en-US', {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  });
}

export type RegimeId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface RegimeDef {
  id: RegimeId;
  name: string;
  min: number;
  max: number;
  color: string;
}

export interface DataPoint {
  i: number;
  t: number;
  v: number;
  r: RegimeId;
  g: number;
  gReal?: boolean;
}

export interface Candle {
  i: number;
  o: number;
  c: number;
  h: number;
  l: number;
}

export interface Dataset {
  series: DataPoint[];
  candles: Candle[];
}

export type PatternKind =
  | 'Compression Coil'
  | 'Alignment Ladder'
  | 'Compression Release'
  | 'Failed Alignment'
  | 'Coherence Volcano'
  | 'Ignition Drift'
  | 'Shock Jump'
  | 'Ignition Rise'
  | 'Pulse Train'
  | 'Staircase Alignment'
  | 'Dead Drift'
  | 'Echo Spike'
  | 'Discharge Break'
  | 'Discharge Wave'
  | 'Double Spike Exhaustion'
  | 'Synchronization Plateau'
  // v11.24.2: intermediate state between Synchronization Plateau and
  // Discharge Break. Fires when a sustained D run flattens out without
  // the slope / curvature / volatility / structure expansion that
  // confirms an actual energy release. Sits in the SP → PD → DB chain.
  | 'Plateau Decay';

export type SlopeLabel     = 'positive' | 'negative' | 'flat';
export type CurvatureLabel = 'positive' | 'negative' | 'flat';

export interface Pattern {
  // Original fields (kept for back-compat with all existing consumers).
  id: string;
  kind: PatternKind;
  start: number;
  end: number;
  tStart: number;
  tEnd: number;
  glyph: string;
  strength: number;            // 0..1, mirrors `confidence` for back-compat

  // v11.3 structured fields (per spec §8). All optional so the existing
  // Pattern shape still type-checks; populated by enrich() in gcp-data.ts.
  patternCode?:        string;        // 'AL', 'CC', 'CR', ...
  patternName?:        string;        // human-readable kind
  regime?:             RegimeId;      // regime at pattern start
  regimeName?:         string;        // 'Silence', 'Ignition', ...
  persistence?:        string;        // 'AB#' | 'C#' | 'D#' | 'E#' | ''
  confidence?:         number;        // 0..1 -- strength of the shape match
  pss?:                number;        // 0..1 -- composite from windowMetrics
  slope?:              SlopeLabel;
  curvature?:          CurvatureLabel;
  ced?:                number;        // raw CED value over the window
  goldInterpretation?: string;
  invalidators?:       string[];
}

export interface EnergyMetrics {
  slope: number;
  curv: number;
  ced: number;
  pss: number;
}

export interface PersistenceInfo {
  tag: string;
  label: string;
  duration: number;
}

export interface CursorInfo {
  i: number;
  time: string;
  v: string;
  r: RegimeId;
  g: string;
}
