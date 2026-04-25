export type MarketSymbol = 'XAUUSD' | 'BTC';

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
