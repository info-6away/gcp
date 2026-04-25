import type {
  RegimeId, RegimeDef, DataPoint, Dataset,
  Pattern, EnergyMetrics, PersistenceInfo,
} from '@/types/gcp';

export const REGIMES: RegimeDef[] = [
  { id: 'A', name: 'Silence',         min: 0,   max: 50,  color: 'var(--r-a)' },
  { id: 'B', name: 'Ignition',        min: 50,  max: 100, color: 'var(--r-b)' },
  { id: 'C', name: 'Alignment',       min: 100, max: 140, color: 'var(--r-c)' },
  { id: 'D', name: 'Synchronization', min: 140, max: 170, color: 'var(--r-d)' },
  { id: 'E', name: 'Climax',          min: 170, max: 220, color: 'var(--r-e)' },
  { id: 'F', name: 'Shock',           min: 220, max: 320, color: 'var(--r-f)' },
];

export function regimeFor(v: number): RegimeId {
  for (const r of REGIMES) if (v >= r.min && v < r.max) return r.id;
  return 'F';
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCRIPT = [
  { anchor: 35,  dur: 120 }, { anchor: 45,  dur: 90  }, { anchor: 55,  dur: 60  },
  { anchor: 72,  dur: 80  }, { anchor: 95,  dur: 50  }, { anchor: 120, dur: 90  },
  { anchor: 135, dur: 70  }, { anchor: 152, dur: 110 }, { anchor: 160, dur: 90  },
  { anchor: 195, dur: 40  }, { anchor: 210, dur: 30  }, { anchor: 155, dur: 30  },
  { anchor: 125, dur: 40  }, { anchor: 90,  dur: 60  }, { anchor: 45,  dur: 80  },
  { anchor: 62,  dur: 40  }, { anchor: 108, dur: 35  }, { anchor: 70,  dur: 30  },
  { anchor: 35,  dur: 100 }, { anchor: 68,  dur: 160 }, { anchor: 72,  dur: 100 },
  { anchor: 245, dur: 12  }, { anchor: 180, dur: 35  }, { anchor: 130, dur: 80  },
  { anchor: 55,  dur: 60  }, { anchor: 88,  dur: 50  }, { anchor: 118, dur: 70  },
  { anchor: 148, dur: 90  }, { anchor: 158, dur: 120 }, { anchor: 140, dur: 60  },
  { anchor: 95,  dur: 80  }, { anchor: 55,  dur: 100 }, { anchor: 42,  dur: 140 },
];

export function buildSeries(): Dataset {
  const rand  = mulberry32(1337);
  const rand2 = mulberry32(9001);
  const gvals: number[] = [];

  for (const seg of SCRIPT) {
    for (let k = 0; k < seg.dur; k++) {
      const prev = gvals.length ? gvals[gvals.length - 1] : seg.anchor;
      const next = prev + (seg.anchor - prev) * 0.08 + (rand() - 0.5) * 14;
      gvals.push(Math.max(0, next));
    }
  }

  let price = 2340.0;
  const gold: number[] = [];
  let trendDir = 1;
  let lastReg: RegimeId = 'A';

  for (let j = 0; j < gvals.length; j++) {
    const v = gvals[j];
    const r = regimeFor(v);
    let drift = 0, vol = 0.25;
    if (r === 'A') { drift = 0; vol = 0.3; }
    if (r === 'B') { drift = 0; vol = 0.55; }
    if (r === 'C') {
      if (lastReg !== 'C' && lastReg !== 'D') trendDir = rand2() > 0.4 ? 1 : -1;
      drift = 0.35 * trendDir; vol = 0.6;
    }
    if (r === 'D') { drift = 0.55 * trendDir; vol = 0.5; }
    if (r === 'E') { drift = 1.1 * trendDir; vol = 1.4; }
    if (r === 'F') { drift = (rand2() - 0.5) * 6; vol = 2.2; }
    price += drift + (rand2() - 0.5) * 2 * vol;
    lastReg = r;
    gold.push(price);
  }

  const candles = [];
  for (let k = 0; k < gold.length; k += 5) {
    const slice = gold.slice(k, k + 5);
    if (!slice.length) break;
    candles.push({ i: k, o: slice[0], c: slice[slice.length - 1], h: Math.max(...slice), l: Math.min(...slice) });
  }

  const startTs = new Date('2026-04-24T00:00:00Z').getTime();
  const series: DataPoint[] = gvals.map((v, idx) => ({
    i: idx, t: startTs + idx * 60_000, v, r: regimeFor(v), g: gold[idx],
  }));

  return { series, candles };
}

export function resampleSeries(series: DataPoint[], barsPerBucket: number): DataPoint[] {
  if (barsPerBucket <= 1) return series;

  const out: DataPoint[] = [];

  for (let i = 0; i < series.length; i += barsPerBucket) {
    const bucket = series.slice(i, i + barsPerBucket);
    if (!bucket.length) break;

    const avgV = bucket.reduce((sum, p) => sum + p.v, 0) / bucket.length;
    const last = bucket[bucket.length - 1];
    const hasReal = bucket.some(p => p.gReal);

    out.push({
      i:     out.length,
      t:     last.t,
      v:     +avgV.toFixed(2),
      r:     regimeFor(avgV),
      g:     last.g,
      gReal: hasReal || undefined,
    });
  }

  return out;
}

export function detectPatterns(series: DataPoint[]): Pattern[] {
  const regs = series.map(s => s.r);
  const patterns: Pattern[] = [];

  function runs(pred: (r: RegimeId) => boolean): [number, number][] {
    const out: [number, number][] = [];
    let s = -1;
    for (let i = 0; i < regs.length; i++) {
      if (pred(regs[i])) { if (s < 0) s = i; }
      else if (s >= 0) { out.push([s, i - 1]); s = -1; }
    }
    if (s >= 0) out.push([s, regs.length - 1]);
    return out;
  }

  const compressions = runs(r => r === 'A' || r === 'B').filter(([a, b]) => b - a >= 80);
  for (const [a, b] of compressions) {
    patterns.push({ id: `cc-${a}`, kind: 'Compression Coil', start: a, end: b, glyph: 'AB#', strength: 0.55 + Math.min(0.3, (b - a) / 400) });
  }

  for (let i = 0; i < regs.length - 250; i++) {
    const w = regs.slice(i, i + 300);
    const idxAB = w.findIndex(r => r === 'A' || r === 'B');
    let abEnd = idxAB;
    while (abEnd < w.length && (w[abEnd] === 'A' || w[abEnd] === 'B')) abEnd++;
    const idxC = w.indexOf('C', abEnd);
    const idxD = idxC >= 0 ? w.indexOf('D', idxC) : -1;
    if (idxAB >= 0 && idxC > 0 && idxD > 0 && (idxD - idxAB) < 280 && abEnd - idxAB > 60) {
      patterns.push({ id: `al-${i + idxAB}`, kind: 'Alignment Ladder', start: i + idxAB, end: i + idxD + 40, glyph: 'AB# → B↑ → C → D#', strength: 0.82 });
      i += idxD + 40;
    }
  }

  for (let i = 0; i < regs.length - 200; i++) {
    const w = regs.slice(i, i + 240);
    const hasAB = w.slice(0, 80).some(r => r === 'A' || r === 'B');
    const hasC  = w.slice(60, 160).includes('C');
    const backB = w.slice(120, 200).includes('B');
    const backA = w.slice(160, 240).includes('A');
    if (hasAB && hasC && backB && backA) {
      patterns.push({ id: `fa-${i}`, kind: 'Failed Alignment', start: i, end: i + 220, glyph: 'AB# → B → C → B → A', strength: 0.28 });
      i += 220;
    }
  }

  const fruns = runs(r => r === 'F');
  for (const [a, b] of fruns) {
    patterns.push({ id: `sh-${a}`, kind: 'Shock Jump', start: Math.max(0, a - 20), end: b + 20, glyph: 'B → F', strength: 0.95 });
  }

  for (let i = 40; i < regs.length - 80; i++) {
    const left  = regs.slice(i - 40, i).filter(r => r === 'A').length;
    const peak  = regs.slice(i, i + 40);
    const right = regs.slice(i + 40, i + 80).filter(r => r === 'A').length;
    if (left > 25 && right > 25 && peak.includes('C') && !peak.includes('D')) {
      patterns.push({ id: `cv-${i}`, kind: 'Coherence Volcano', start: i - 20, end: i + 60, glyph: 'A → B → C → B → A', strength: 0.38 });
      i += 80;
    }
  }

  patterns.sort((a, b) => a.start - b.start);
  return patterns;
}

export function energyAt(series: DataPoint[], i: number, window = 30): EnergyMetrics {
  if (!series.length) return { slope: 0, curv: 0, ced: 0, pss: 0 };
  const idx = Math.max(0, Math.min(i, series.length - 1));
  const a = Math.max(0, idx - window);
  const slice = series.slice(a, idx + 1);
  if (slice.length < 3) return { slope: 0, curv: 0, ced: 0, pss: 0 };
  const xs = slice.map(s => s.v);
  const n = xs.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) { sx += k; sy += xs[k]; sxy += k * xs[k]; sxx += k * k; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  let curv = 0;
  for (let k = 2; k < n; k++) curv += xs[k] - 2 * xs[k - 1] + xs[k - 2];
  curv /= (n - 2);
  let ced = 0;
  for (let k = 1; k < n; k++) ced += Math.abs(xs[k] - xs[k - 1]);
  ced = Math.min(1, ced / 400);
  const compDur = Math.min(1, window / 60);
  const osc = 1 - Math.min(1, Math.abs(slope) / 2);
  const pss = 0.35 * compDur + 0.25 * osc + 0.25 * ced + 0.15 * Math.min(1, Math.abs(curv) / 0.5);
  return {
    slope: +slope.toFixed(3), curv: +curv.toFixed(3),
    ced: +ced.toFixed(3), pss: +Math.max(0, Math.min(1, pss)).toFixed(3),
  };
}

export function persistenceAt(series: DataPoint[], i: number): PersistenceInfo {
  if (!series.length) return { tag: '', label: '', duration: 0 };
  const idx = Math.max(0, Math.min(i, series.length - 1));
  const r = series[idx].r;
  let k = idx;
  while (k > 0 && series[k - 1].r === r) k--;
  const dur = idx - k + 1;
  const tag = (r === 'A' || r === 'B') ? 'AB#' : r === 'C' ? 'C#' : r === 'D' ? 'D#' : r === 'E' ? 'E#' : 'F!';
  const label = r === 'A' || r === 'B' ? 'Compression' : r === 'C' ? 'Alignment Hold' : r === 'D' ? 'Synchronization Lock' : r === 'E' ? 'Climax Plateau' : 'Shock Window';
  return { tag, label, duration: dur };
}

export const INTERP: Record<string, string> = {
  'Compression Coil':   'Energy accumulating. Range-building. Expansion likely if PSS > 0.7.',
  'Alignment Ladder':   'Trend environment forming. High continuation probability. Favor directional entries.',
  'Failed Alignment':   'Fake breakout. Low continuation probability. Fade or stand aside.',
  'Shock Jump':         'Extreme coherence event. News/geopolitical reaction. Expect volatility spike in gold.',
  'Coherence Volcano':  'Temporary spike, no sustained trend. Revert to compression likely.',
  'Ignition Drift':     'Indecision. Wait for alignment confirmation.',
  'Compression Release': 'Breakout forming. Requires confirmation at C regime.',
};
