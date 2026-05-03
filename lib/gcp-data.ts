import type {
  RegimeId, RegimeDef, DataPoint, Dataset,
  Pattern, EnergyMetrics, PersistenceInfo,
} from '@/types/gcp';
import { windowMetrics, ced, dischargeConfirmation } from '@/lib/energy';
import {
  PATTERN_CODE, PATTERN_GOLD_INTERP, PATTERN_INVALIDATORS,
  REGIME_NAME, regimeForValue,
} from '@/lib/patterns-meta';

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

// v11.1: thresholds is accepted as the third arg (sensitivity wiring) but
// not yet read by the detection logic. v11.2 will plug it in once energy
// metrics are split out.
export function detectPatterns(
  series: DataPoint[],
  barsPerMinute = 1,
  _thresholds?: import('./sensitivity').SensitivityThresholds,
): Pattern[] {
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
      patterns.push({ id: `fa-${i}`, kind: 'Failed Alignment', start: i, end: i + FA_SPAN, tStart: 0, tEnd: 0, glyph: 'AB# → B → C → B → A', strength: 0.62 });
      i += FA_SPAN;
    }
  }

  const fruns = runs(r => r === 'F');
  for (const [a, b] of fruns) {
    // Skip boundary artifacts: a single F-regime point that sits next to a
    // > 5 minute data gap (e.g. historical/live boundary) is almost always
    // an interpolation jump, not a real shock event. Real shocks span at
    // least a couple of bars and have continuous data either side.
    const prevT = a > 0 ? series[a - 1]?.t : null;
    const currT = series[a]?.t;
    const gapBefore = prevT != null && currT != null ? currT - prevT : 0;
    const isSinglePoint = a === b;
    if (isSinglePoint && gapBefore > 300_000) continue;

    // Require the F run's actual NV to clear the F threshold. Cheap guard
    // against detector noise where a regime label disagrees with the value.
    if (series[a] && series[a].v < 220) continue;

    patterns.push({ id: `sh-${a}`, kind: 'Shock Jump', start: Math.max(0, a - SH_BUFFER), end: b + SH_BUFFER, tStart: 0, tEnd: 0, glyph: 'B → F', strength: 0.95 });
  }

  for (let i = CV_HALF; i < regs.length - CV_LOOP_END; i++) {
    const left  = regs.slice(i - CV_HALF, i).filter(r => r === 'A').length;
    const peak  = regs.slice(i, i + CV_HALF);
    const right = regs.slice(i + CV_HALF, i + CV_LOOP_END).filter(r => r === 'A').length;
    if (left > CV_MIN_A && right > CV_MIN_A && peak.includes('C') && !peak.includes('D')) {
      patterns.push({ id: `cv-${i}`, kind: 'Coherence Volcano', start: i - CV_PRE_PAD, end: i + CV_POST_PAD, tStart: 0, tEnd: 0, glyph: 'A → B → C → B → A', strength: 0.62 });
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

  // ── v11.3 new patterns ───────────────────────────────────────────────────

  // Synchronization Plateau: sustained D regime (140-170) of >= minCOrDHold.
  // The spec calls this one of the most important patterns -- gold trend
  // continuation zone.
  const SP_MIN = scale(_thresholds?.minCOrDHold ?? 10, 2);
  const dRuns  = runs(r => r === 'D');
  for (const [a, b] of dRuns) {
    const len = b - a + 1;
    if (len < SP_MIN) continue;
    const strength = Math.min(0.92, 0.6 + (len / Math.max(1, 60 / barsPerMinute)) * 0.3);
    patterns.push({
      id: `sp-${a}`, kind: 'Synchronization Plateau',
      start: a, end: b, tStart: 0, tEnd: 0,
      glyph: 'C → D# sustained', strength,
    });
  }

  // Ignition Rise: AB# base followed by upward push into B but NOT into C.
  // Half-step of Compression Release; fires when the coil started releasing
  // but hasn't confirmed alignment yet.
  const IR_LOOKAHEAD = scale(8, 2);
  for (const [a, b] of compressions) {
    if (b + 1 >= regs.length) continue;
    // Skip if a CR already fires here (CR detector above looks ahead 5 bars
    // for a C; if there's a C within IR_LOOKAHEAD it's a CR, not an IR).
    let sawC = false;
    let sawRising = false;
    let endIdx = b;
    const stop = Math.min(b + 1 + IR_LOOKAHEAD, regs.length);
    for (let j = b + 1; j < stop; j++) {
      if (regs[j] === 'C') { sawC = true; break; }
      if (regs[j] === 'B' && series[j].v > 60) { sawRising = true; endIdx = j; }
    }
    if (sawC || !sawRising) continue;
    const baseLen = b - a + 1;
    const strength = Math.min(0.7, 0.45 + (baseLen / Math.max(1, 400 / barsPerMinute)) * 0.25);
    patterns.push({
      id: `ir-${a}`, kind: 'Ignition Rise',
      start: a, end: endIdx, tStart: 0, tEnd: 0,
      glyph: 'AB# → B↑', strength,
    });
  }

  // Discharge Wave: A → E → A short-duration spike, similar to CV but at E
  // (climax) range and with rapid collapse on both sides.
  const DW_HALF = scale(15, 2);
  const DW_SKIP = scale(60, 5);
  for (let i = DW_HALF; i < regs.length - DW_HALF; i++) {
    if (regs[i] !== 'E' && regs[i] !== 'F') continue;
    const left  = regs.slice(Math.max(0, i - DW_HALF), i)
      .filter(r => r === 'A' || r === 'B').length;
    const right = regs.slice(i + 1, Math.min(regs.length, i + 1 + DW_HALF))
      .filter(r => r === 'A' || r === 'B').length;
    if (left < DW_HALF * 0.6 || right < DW_HALF * 0.6) continue;
    // Strength scales with how clean the surrounding A/B walls are.
    // A "structurally clean" wave (both halves >=80% low-regime) sits at
    // ~0.68; a borderline match at the 60% floor stays at ~0.55. Floor
    // bumped to 0.60 per spec so a clean wave survives Medium sensitivity.
    const wallRatio = (left + right) / (DW_HALF * 2);
    const dwStrength = Math.max(0.60, Math.min(0.78, 0.55 + (wallRatio - 0.6) * 0.6));
    patterns.push({
      id: `dw-${i}`, kind: 'Discharge Wave',
      start: Math.max(0, i - DW_HALF), end: Math.min(regs.length - 1, i + DW_HALF),
      tStart: 0, tEnd: 0, glyph: 'A → E → A', strength: dwStrength,
    });
    i += DW_SKIP;
  }

  // Double Spike Exhaustion: two E-or-higher peaks within proximity, each
  // surrounded by A/B, with the second of similar magnitude to the first.
  const DSE_GAP_MIN = scale(20, 3);
  const DSE_GAP_MAX = scale(180, 12);
  const ePeaks: number[] = [];
  for (let i = 1; i < regs.length - 1; i++) {
    if ((regs[i] === 'E' || regs[i] === 'F') && regs[i - 1] !== regs[i]) ePeaks.push(i);
  }
  for (let k = 1; k < ePeaks.length; k++) {
    const i1 = ePeaks[k - 1];
    const i2 = ePeaks[k];
    const gap = i2 - i1;
    if (gap < DSE_GAP_MIN || gap > DSE_GAP_MAX) continue;
    const v1 = series[i1].v, v2 = series[i2].v;
    if (v1 < 170 || v2 < 170) continue;
    const ratio = v2 / v1;
    if (ratio < 0.7 || ratio > 1.3) continue;
    patterns.push({
      id: `dse-${i1}`, kind: 'Double Spike Exhaustion',
      start: Math.max(0, i1 - DSE_GAP_MIN), end: Math.min(regs.length - 1, i2 + DSE_GAP_MIN),
      tStart: 0, tEnd: 0, glyph: 'A → E → A → E → A',
      strength: Math.min(0.85, 0.6 + (1 - Math.abs(1 - ratio)) * 0.2),
    });
  }

  // Echo Spike: a D/E/F peak followed by a smaller (and meaningfully so)
  // D-or-higher peak. Ratio-bound below DSE so the two don't double-tag.
  const ES_GAP_MIN = scale(15, 2);
  const ES_GAP_MAX = scale(240, 15);
  const dePeaks: number[] = [];
  for (let i = 1; i < regs.length - 1; i++) {
    const r = regs[i];
    if ((r === 'D' || r === 'E' || r === 'F') && regs[i - 1] !== r) dePeaks.push(i);
  }
  for (let k = 1; k < dePeaks.length; k++) {
    const i1 = dePeaks[k - 1];
    const i2 = dePeaks[k];
    const gap = i2 - i1;
    if (gap < ES_GAP_MIN || gap > ES_GAP_MAX) continue;
    const v1 = series[i1].v, v2 = series[i2].v;
    if (v1 < 140 || v2 < 100) continue;
    if (v2 >= v1 * 0.85) continue;       // not enough decay -> let DSE handle
    if (v2 < v1 * 0.45) continue;        // too small a relative echo, noisy
    patterns.push({
      id: `es-${i1}`, kind: 'Echo Spike',
      start: i1, end: i2, tStart: 0, tEnd: 0, glyph: 'peak → smaller peak',
      strength: Math.min(0.7, 0.45 + (1 - v2 / v1) * 0.4),
    });
  }

  // Discharge Break: D or E run that ends abruptly with a strong drop into
  // A/B within a few bars (negative slope, alignment lost).
  //
  // v11.24.2: regime-only gating produced a false positive every time
  // a Synchronization Plateau flattened down without an actual energy
  // release. Now we require the dischargeConfirmation() layer to
  // confirm at least 2 of 4 quantitative conditions (slope drop,
  // curvature spike, volatility expansion, structure break). If <2
  // fire, we still record the event — but as a softer "Plateau Decay"
  // pattern so the user sees that the plateau is fading without the
  // misleading "discharge in progress" framing.
  const DB_DROP = scale(8, 2);
  for (const [a, b] of [...dRuns, ...runs(r => r === 'E')]) {
    if (b - a + 1 < scale(8, 2)) continue;
    const after = regs.slice(b + 1, Math.min(regs.length, b + 1 + DB_DROP));
    const lowAfter = after.filter(r => r === 'A' || r === 'B').length;
    if (lowAfter < after.length * 0.6 || after.length === 0) continue;

    // Confirmation windows:
    //   drop  = NV values during the post-run drop (the candidate event)
    //   prior = NV values across the run itself (baseline volatility +
    //           structure reference for localMin / std comparison).
    const dropEnd  = Math.min(regs.length, b + 1 + DB_DROP);
    const drop     = series.slice(b + 1, dropEnd).map(p => p.v);
    const prior    = series.slice(a, b + 1).map(p => p.v);
    const conf     = dischargeConfirmation(drop, prior);

    if (conf.conditionsMet >= 2) {
      // Strength leans on how many conditions confirmed (2/4 = 0.55,
      // 4/4 = 0.85) so a weakly-confirmed break ranks below a clean one.
      const strength = Math.min(0.85, 0.45 + 0.1 * conf.conditionsMet);
      patterns.push({
        id: `db-${b}`, kind: 'Discharge Break',
        start: a, end: Math.min(regs.length - 1, b + DB_DROP),
        tStart: 0, tEnd: 0, glyph: 'D/E → B/A', strength,
      });
    } else {
      // No real release — the plateau is just decaying. PD strength
      // tracks how close the run came to confirming so the user can
      // tell a "barely 1/4" decay from a "0/4 just drifting" decay.
      const strength = Math.max(0.40, Math.min(0.60, 0.40 + 0.1 * conf.conditionsMet));
      patterns.push({
        id: `pd-${b}`, kind: 'Plateau Decay',
        start: a, end: Math.min(regs.length - 1, b + DB_DROP),
        tStart: 0, tEnd: 0, glyph: 'D# fading', strength,
      });
    }
  }

  // Pulse Train: 3+ alternating low/mid pulses (A->B->A->B...) within a
  // window, each failing to reach C. Watches for repeated sync attempts.
  const PT_WINDOW = scale(60, 5);
  const PT_MIN_PULSES = 3;
  for (let i = 0; i < regs.length - PT_WINDOW; i += scale(15, 3)) {
    const w = regs.slice(i, i + PT_WINDOW);
    if (w.some(r => r === 'C' || r === 'D' || r === 'E' || r === 'F')) continue;
    let pulses = 0;
    let last = '';
    for (const r of w) {
      if ((r === 'A' || r === 'B') && r !== last) {
        if (last === 'A' && r === 'B') pulses++;
        last = r;
      }
    }
    if (pulses < PT_MIN_PULSES) continue;
    patterns.push({
      id: `pt-${i}`, kind: 'Pulse Train',
      start: i, end: i + PT_WINDOW - 1, tStart: 0, tEnd: 0,
      glyph: 'A → B → A → B …',
      strength: Math.min(0.7, 0.4 + pulses * 0.06),
    });
    i += PT_WINDOW; // dedupe
  }

  // Staircase Alignment: rolling-mean baseline rises monotonically across
  // sub-windows and eventually reaches C without a violent spike.
  const SA_WIN  = scale(80, 6);
  const SA_STEP = scale(20, 3);
  for (let i = 0; i < regs.length - SA_WIN; i += SA_STEP) {
    const slice = series.slice(i, i + SA_WIN);
    if (slice.some(s => s.r === 'E' || s.r === 'F')) continue;
    const buckets = 4;
    const bucketLen = Math.floor(SA_WIN / buckets);
    if (bucketLen < 5) continue;
    let monotonic = true;
    let prevAvg = -Infinity;
    let endsHigh = false;
    for (let bi = 0; bi < buckets; bi++) {
      const bucket = slice.slice(bi * bucketLen, (bi + 1) * bucketLen);
      const avg = bucket.reduce((s, p) => s + p.v, 0) / bucket.length;
      if (avg <= prevAvg) { monotonic = false; break; }
      prevAvg = avg;
      if (bi === buckets - 1 && avg >= 100) endsHigh = true;
    }
    if (!monotonic || !endsHigh) continue;
    patterns.push({
      id: `sa-${i}`, kind: 'Staircase Alignment',
      start: i, end: i + SA_WIN - 1, tStart: 0, tEnd: 0,
      glyph: 'B↑ → C↑', strength: 0.78,
    });
    i += SA_WIN;
  }

  // Dead Drift: long A regime with low CED. No tension, no slope — distinct
  // from a Compression Coil (which has energy accumulation).
  const DD_MIN = scale(40, 4);
  const aRuns  = runs(r => r === 'A');
  for (const [a, b] of aRuns) {
    const len = b - a + 1;
    if (len < DD_MIN) continue;
    const slice = series.slice(a, b + 1).map(s => s.v);
    const cedRaw = ced(slice);
    const cedPerBar = cedRaw / Math.max(1, len);
    if (cedPerBar > 4) continue;        // too much movement to be drift
    patterns.push({
      id: `dd-${a}`, kind: 'Dead Drift',
      start: a, end: b, tStart: 0, tEnd: 0, glyph: 'A chop',
      strength: Math.min(0.6, 0.35 + (1 - cedPerBar / 4) * 0.25),
    });
  }

  patterns.sort((a, b) => a.start - b.start);

  // Stamp absolute timestamps + enrich each pattern with the structured
  // fields from spec §8 (patternCode, regime, persistence, slope label,
  // gold interpretation, invalidators, etc.). Existing visual fields
  // (kind, start, end, glyph, strength) are preserved so all current UI
  // consumers keep working.
  const lastIdx = series.length - 1;
  const fallbackT = lastIdx >= 0 ? series[lastIdx]?.t ?? Date.now() : Date.now();
  for (const p of patterns) {
    const sIdx = Math.max(0, Math.min(p.start, lastIdx));
    const eIdx = Math.max(0, Math.min(p.end,   lastIdx));
    p.tStart = series[sIdx]?.t ?? fallbackT;
    p.tEnd   = series[eIdx]?.t ?? fallbackT;

    // Window metrics over the pattern's own slice.
    const slice = series.slice(sIdx, eIdx + 1).map(s => s.v);
    const m     = slice.length >= 3
      ? windowMetrics(slice)
      : { slope: 0, curvature: 0, ced: 0, compressionDuration: 0, oscillationTightness: 0, pss: 0 };

    const startV  = series[sIdx]?.v ?? 0;
    const regime  = series[sIdx]?.r ?? regimeForValue(startV);
    const persist =
      regime === 'A' || regime === 'B' ? 'AB#' :
      regime === 'C' ? 'C#' :
      regime === 'D' ? 'D#' :
      regime === 'E' ? 'E#' : '';

    const slopeLabel: 'positive' | 'negative' | 'flat' =
      m.slope >  0.05 ? 'positive' :
      m.slope < -0.05 ? 'negative' : 'flat';
    const curvLabel: 'positive' | 'negative' | 'flat' =
      m.curvature >  0.02 ? 'positive' :
      m.curvature < -0.02 ? 'negative' : 'flat';

    p.patternCode        = PATTERN_CODE[p.kind];
    p.patternName        = p.kind;
    p.regime             = regime;
    p.regimeName         = REGIME_NAME[regime];
    p.persistence        = persist;
    p.confidence         = +Math.max(0, Math.min(1, p.strength)).toFixed(3);
    p.pss                = +m.pss.toFixed(3);
    p.slope              = slopeLabel;
    p.curvature          = curvLabel;
    p.ced                = +m.ced.toFixed(2);
    p.goldInterpretation = PATTERN_GOLD_INTERP[p.kind];
    p.invalidators       = PATTERN_INVALIDATORS[p.kind] ?? [];
  }

  // Sensitivity threshold: drop patterns below the configured minimum
  // confidence. Default to Medium (0.60) when no thresholds passed.
  const minConf = _thresholds?.minPatternConfidence ?? 0.60;
  const filtered = patterns.filter(p => (p.confidence ?? p.strength) >= minConf);

  return filtered;
}

// v11.2: delegates to lib/energy.ts. Public API and EnergyMetrics shape
// preserved so existing callers (none active today, but the export is
// part of the surface) keep working. PSS now uses the spec §6 formula
// with real compression duration / oscillation tightness rather than
// the window-size approximation we had before.
export function energyAt(series: DataPoint[], i: number, window = 30): EnergyMetrics {
  if (!series.length) return { slope: 0, curv: 0, ced: 0, pss: 0 };
  const idx = Math.max(0, Math.min(i, series.length - 1));
  const a   = Math.max(0, idx - window);
  const xs  = series.slice(a, idx + 1).map(s => s.v);
  if (xs.length < 3) return { slope: 0, curv: 0, ced: 0, pss: 0 };
  const m = windowMetrics(xs);
  // Match the historical EnergyMetrics shape: slope/curv unscaled, ced
  // normalized to 0-1 (callers expected that), pss already 0-1.
  return {
    slope: +m.slope.toFixed(3),
    curv:  +m.curvature.toFixed(3),
    ced:   +Math.min(1, m.ced / 400).toFixed(3),
    pss:   +m.pss.toFixed(3),
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
