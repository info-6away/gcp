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

export function lttbDownsample(series: DataPoint[], threshold: number): DataPoint[] {
  const n = series.length;
  if (n <= threshold) return series;

  const sampled: DataPoint[] = [series[0]];
  const bucketSize = (n - 2) / (threshold - 2);

  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgEnd   = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    let avgV = 0;
    for (let j = avgStart; j < avgEnd; j++) avgV += series[j].v;
    avgV /= (avgEnd - avgStart);
    const avgI = (avgStart + avgEnd - 1) / 2;

    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd   = Math.min(Math.floor((i + 1) * bucketSize) + 1, n);

    const ax = a;
    const ay = series[a].v;

    let maxArea  = -1;
    let maxIndex = rangeStart;

    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (ax - avgI) * (series[j].v - ay) -
        (ax - j)    * (avgV - ay)
      );
      if (area > maxArea) {
        maxArea  = area;
        maxIndex = j;
      }
    }

    sampled.push({ ...series[maxIndex], i: sampled.length });
    a = maxIndex;
  }

  sampled.push({ ...series[n - 1], i: sampled.length });
  return sampled;
}

const LTTB_TARGET = 2000;

export interface ProcessedSeries {
  display:  DataPoint[];
  analysis: DataPoint[];
}

// Returns both:
//   display  — bucketed + LTTB-downsampled for chart rendering (~1200 pts)
//   analysis — bucketed only (no LTTB), for pattern detection
// LTTB scatters points for visual fidelity; that destroys the consecutive
// regime sequences pattern detection relies on. Patterns must run on the
// pre-LTTB series.
export function processSeries(series: DataPoint[], barsPerBucket: number): ProcessedSeries {
  const sorted = [...series].sort((a, b) => a.t - b.t);

  if (barsPerBucket <= 1) {
    const display = sorted.length > LTTB_TARGET
      ? lttbDownsample(sorted, LTTB_TARGET)
      : sorted;
    return { display, analysis: sorted };
  }

  const bucketed: DataPoint[] = [];
  for (let i = 0; i < sorted.length; i += barsPerBucket) {
    const bucket = sorted.slice(i, i + barsPerBucket);
    if (!bucket.length) break;

    let maxV = -Infinity;
    for (const p of bucket) if (p.v > maxV) maxV = p.v;

    const sortedV = bucket.map(p => p.v).sort((a, b) => a - b);
    const vMedian = sortedV[Math.floor(sortedV.length / 2)];

    const last    = bucket[bucket.length - 1];
    const hasReal = bucket.some(p => p.gReal);

    bucketed.push({
      i:     bucketed.length,
      t:     last.t,
      v:     +maxV.toFixed(2),
      r:     regimeFor(vMedian),
      g:     last.g,
      gReal: hasReal || undefined,
    });
  }

  const display = bucketed.length > LTTB_TARGET
    ? lttbDownsample(bucketed, LTTB_TARGET).map((p, i) => ({ ...p, i }))
    : bucketed;

  return { display, analysis: bucketed };
}

export function resampleSeries(series: DataPoint[], barsPerBucket: number): DataPoint[] {
  return processSeries(series, barsPerBucket).display;
}

export function detectPatterns(series: DataPoint[], barsPerMinute = 1): Pattern[] {
  const regs = series.map(s => s.r);
  const patterns: Pattern[] = [];

  // Threshold defaults are tuned for 1m. Scale them down for coarser TFs
  // so the same regime sequences become detectable at e.g. 15m or 4h.
  const scale = (n: number, min: number) => Math.max(min, Math.round(n / barsPerMinute));

  const MIN_COMPRESSION = scale(80, 5);

  const AL_WINDOW    = scale(300, 20);
  const AL_LOOP_END  = scale(250, 15);
  const AL_MAX_SPAN  = scale(280, 20);
  const AL_MIN_AB    = scale(60, 4);
  const AL_TAIL      = scale(40, 3);

  const FA_WINDOW    = scale(240, 18);
  const FA_LOOP_END  = scale(200, 15);
  const FA_AB_END    = scale(80, 6);
  const FA_C_START   = scale(60, 4);
  const FA_C_END     = scale(160, 12);
  const FA_B_START   = scale(120, 9);
  const FA_B_END     = scale(200, 15);
  const FA_A_START   = scale(160, 12);
  const FA_A_END     = scale(240, 18);
  const FA_SPAN      = scale(220, 16);

  const SH_BUFFER    = scale(20, 2);

  const CV_HALF      = scale(40, 3);
  const CV_LOOP_END  = scale(80, 6);
  const CV_MIN_A     = scale(25, 2);
  const CV_PRE_PAD   = scale(20, 2);
  const CV_POST_PAD  = scale(60, 4);
  const CV_SKIP      = scale(80, 6);

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

  const compressions = runs(r => r === 'A' || r === 'B').filter(([a, b]) => b - a >= MIN_COMPRESSION);
  for (const [a, b] of compressions) {
    patterns.push({ id: `cc-${a}`, kind: 'Compression Coil', start: a, end: b, tStart: 0, tEnd: 0, glyph: 'AB#', strength: 0.55 + Math.min(0.3, (b - a) / Math.max(1, 400 / barsPerMinute)) });
  }

  for (let i = 0; i < regs.length - AL_LOOP_END; i++) {
    const w = regs.slice(i, i + AL_WINDOW);
    const idxAB = w.findIndex(r => r === 'A' || r === 'B');
    let abEnd = idxAB;
    while (abEnd < w.length && (w[abEnd] === 'A' || w[abEnd] === 'B')) abEnd++;
    const idxC = w.indexOf('C', abEnd);
    const idxD = idxC >= 0 ? w.indexOf('D', idxC) : -1;
    if (idxAB >= 0 && idxC > 0 && idxD > 0 && (idxD - idxAB) < AL_MAX_SPAN && abEnd - idxAB > AL_MIN_AB) {
      patterns.push({ id: `al-${i + idxAB}`, kind: 'Alignment Ladder', start: i + idxAB, end: i + idxD + AL_TAIL, tStart: 0, tEnd: 0, glyph: 'AB# → B↑ → C → D#', strength: 0.82 });
      i += idxD + AL_TAIL;
    }
  }

  for (let i = 0; i < regs.length - FA_LOOP_END; i++) {
    const w = regs.slice(i, i + FA_WINDOW);
    const hasAB = w.slice(0, FA_AB_END).some(r => r === 'A' || r === 'B');
    const hasC  = w.slice(FA_C_START, FA_C_END).includes('C');
    const backB = w.slice(FA_B_START, FA_B_END).includes('B');
    const backA = w.slice(FA_A_START, FA_A_END).includes('A');
    if (hasAB && hasC && backB && backA) {
      patterns.push({ id: `fa-${i}`, kind: 'Failed Alignment', start: i, end: i + FA_SPAN, tStart: 0, tEnd: 0, glyph: 'AB# → B → C → B → A', strength: 0.28 });
      i += FA_SPAN;
    }
  }

  const fruns = runs(r => r === 'F');
  for (const [a, b] of fruns) {
    patterns.push({ id: `sh-${a}`, kind: 'Shock Jump', start: Math.max(0, a - SH_BUFFER), end: b + SH_BUFFER, tStart: 0, tEnd: 0, glyph: 'B → F', strength: 0.95 });
  }

  for (let i = CV_HALF; i < regs.length - CV_LOOP_END; i++) {
    const left  = regs.slice(i - CV_HALF, i).filter(r => r === 'A').length;
    const peak  = regs.slice(i, i + CV_HALF);
    const right = regs.slice(i + CV_HALF, i + CV_LOOP_END).filter(r => r === 'A').length;
    if (left > CV_MIN_A && right > CV_MIN_A && peak.includes('C') && !peak.includes('D')) {
      patterns.push({ id: `cv-${i}`, kind: 'Coherence Volcano', start: i - CV_PRE_PAD, end: i + CV_POST_PAD, tStart: 0, tEnd: 0, glyph: 'A → B → C → B → A', strength: 0.38 });
      i += CV_SKIP;
    }
  }

  // Compression Release: any sustained A/B base that is followed within
  // a few bars by a C bar (i.e. the coil starts to release upward).
  // Loose by design — the analytical signal is "compression ended in C".
  const CR_LOOKAHEAD = scale(5, 2);
  for (const [a, b] of compressions) {
    if (b + 1 >= regs.length) continue;
    let cIdx = -1;
    for (let j = b + 1; j < Math.min(b + 1 + CR_LOOKAHEAD, regs.length); j++) {
      if (regs[j] === 'C') { cIdx = j; break; }
    }
    if (cIdx < 0) continue;
    const baseLen = b - a + 1;
    const tail    = Math.min(scale(3, 1), regs.length - 1 - cIdx);
    const strength = Math.min(0.9, 0.6 + (baseLen / Math.max(1, 400 / barsPerMinute)) * 0.3);
    patterns.push({
      id:    `cr-${a}`,
      kind:  'Compression Release',
      start: a,
      end:   cIdx + tail,
      tStart: 0, tEnd: 0,
      glyph: 'AB# → C',
      strength,
    });
  }

  // Ignition Drift: long A/B run that's predominantly B (>=70%) and never
  // escapes to C/D/E/F. Skips runs that already match a Compression Coil
  // (>= MIN_COMPRESSION) — those are coils, not drifts.
  const ID_MIN     = scale(40, 4);
  const abRuns     = runs(r => r === 'A' || r === 'B');
  for (const [a, b] of abRuns) {
    const len = b - a + 1;
    if (len < ID_MIN || len >= MIN_COMPRESSION) continue;
    let bCount = 0;
    for (let k = a; k <= b; k++) if (regs[k] === 'B') bCount++;
    if (bCount / len < 0.7) continue;
    const strength = Math.min(0.75, 0.45 + (len / Math.max(1, 200 / barsPerMinute)) * 0.3);
    patterns.push({
      id:    `id-${a}`,
      kind:  'Ignition Drift',
      start: a,
      end:   b,
      tStart: 0, tEnd: 0,
      glyph: 'B ↔ B',
      strength,
    });
  }

  patterns.sort((a, b) => a.start - b.start);

  // Stamp absolute timestamps from the series so callers can fetch price
  // candles for the pattern window without having to keep the series array
  // around. Clamp end to the last valid index — some patterns extend a few
  // bars past the detected region and may overflow the series.
  const lastIdx = series.length - 1;
  const fallbackT = lastIdx >= 0 ? series[lastIdx]?.t ?? Date.now() : Date.now();
  for (const p of patterns) {
    const sIdx = Math.max(0, Math.min(p.start, lastIdx));
    const eIdx = Math.max(0, Math.min(p.end,   lastIdx));
    p.tStart = series[sIdx]?.t ?? fallbackT;
    p.tEnd   = series[eIdx]?.t ?? fallbackT;
  }

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
