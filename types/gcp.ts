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
