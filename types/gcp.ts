export type AppPage = 'dashboard' | 'pattern' | 'chart' | 'settings';

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
  | 'Shock Jump';

export interface Pattern {
  id: string;
  kind: PatternKind;
  start: number;
  end: number;
  glyph: string;
  strength: number;
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
