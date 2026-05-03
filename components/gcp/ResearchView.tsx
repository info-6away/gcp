'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import type { DataPoint, MarketSymbol } from '@/types/gcp';
import { fetchCandlesForWindow, type Candle } from '@/lib/fetchCandles';
import { detectPatterns } from '@/lib/gcp-data';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

type ResearchMode = 'regime' | 'pattern' | 'aistate';

interface RegimePoint {
  kind:   'regime';
  regime: string;
  fwdPct: number;
  t:      number;
  nv:     number;
}

interface PatternPoint {
  kind:    'pattern';
  pattern: string;
  fwdPct:  number;
  t:       number;
  pss:     number;
}

interface AiStatePoint {
  kind:       'aistate';
  stateCode:  string;
  state:      string;
  phase:      string;
  direction:  string;
  confidence: number;
  fwdPct:     number;
  t:          number;
}

type Hovered = RegimePoint | PatternPoint | AiStatePoint;

const REGIME_META: Record<string, { label: string; color: string; x: number }> = {
  A: { label: 'A · Silence',         color: '#4a72c4', x: 1 },
  B: { label: 'B · Ignition',        color: '#4dd9e8', x: 2 },
  C: { label: 'C · Alignment',       color: '#2db8b4', x: 3 },
  D: { label: 'D · Synchronization', color: '#d4a028', x: 4 },
  E: { label: 'E · Climax',          color: '#d46428', x: 5 },
  F: { label: 'F · Shock',           color: '#e24b4a', x: 6 },
};

const PATTERN_META: Record<string, { label: string; abbr: string; color: string; x: number }> = {
  'Alignment Ladder':    { label: 'Alignment Ladder',    abbr: 'AL', color: '#4dd9e8', x: 1 },
  'Compression Coil':    { label: 'Compression Coil',    abbr: 'CC', color: '#6b7280', x: 2 },
  'Compression Release': { label: 'Compression Release', abbr: 'CR', color: '#22c55e', x: 3 },
  'Failed Alignment':    { label: 'Failed Alignment',    abbr: 'FA', color: '#d946ef', x: 4 },
  'Coherence Volcano':   { label: 'Coherence Volcano',   abbr: 'CV', color: '#f59e0b', x: 5 },
  'Ignition Drift':      { label: 'Ignition Drift',      abbr: 'ID', color: '#888780', x: 6 },
  'Shock Jump':          { label: 'Shock Jump',          abbr: 'SJ', color: '#e24b4a', x: 7 },
};
const PATTERN_COLS = 7;

// v11.20: AI State columns. Order roughly follows the lifecycle —
// compression building → ignition → trend → climax / discharge / shock,
// with dead-drift on the left as the no-signal baseline. State labels
// match GcpStateResponse['state']; abbr is the literal stateCode.
const AI_STATE_META: Record<string, { label: string; abbr: string; color: string; x: number }> = {
  DD: { label: 'Dead Drift',         abbr: 'DD', color: '#6b7280', x: 1 },
  CS: { label: 'Compression',        abbr: 'CS', color: '#4dd9e8', x: 2 },
  IS: { label: 'Ignition',           abbr: 'IS', color: '#22c55e', x: 3 },
  AT: { label: 'Alignment Trend',    abbr: 'AT', color: '#2db8b4', x: 4 },
  SS: { label: 'Synchronization',    abbr: 'SS', color: '#d4a028', x: 5 },
  CL: { label: 'Climax',             abbr: 'CL', color: '#d46428', x: 6 },
  DS: { label: 'Discharge',          abbr: 'DS', color: '#fb923c', x: 7 },
  FA: { label: 'Failed Alignment',   abbr: 'FA', color: '#d946ef', x: 8 },
  SH: { label: 'Shock',              abbr: 'SH', color: '#e24b4a', x: 9 },
};
const AI_STATE_COLS = 9;
const AI_STATE_MIN_COUNT = 10;

function regimeFor(v: number): string {
  if (v < 50)  return 'A';
  if (v < 100) return 'B';
  if (v < 140) return 'C';
  if (v < 170) return 'D';
  if (v < 220) return 'E';
  return 'F';
}

const FWD_LABEL: Record<number, string> = {
  1: '15m', 2: '30m', 4: '1h', 8: '2h', 16: '4h',
};

interface ResearchViewProps {
  series: DataPoint[];
  symbol: MarketSymbol;
}

export default function ResearchView({ series, symbol }: ResearchViewProps) {
  const [candles, setCandles] = useState<Candle[]>([]);
  // v11.23.4: track which symbol the loaded candles correspond to so
  // we can guard the memos against a brief render where `candles` is
  // still XAUUSD but `symbol` has flipped to BTC. Also surfaces in dev
  // logs for the symbol-mismatch warning.
  const [candleSymbol, setCandleSymbol] = useState<MarketSymbol | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [fwdBars, setFwdBars] = useState(4);
  const [mode,    setMode]    = useState<ResearchMode>('regime');
  const [hovered, setHovered] = useState<Hovered | null>(null);

  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const [H, setH] = useState(400);

  // Re-run when loading/error flips because the chart container only mounts
  // once we leave the loading/error branch — observing it on initial mount
  // (when the ref is still null) silently no-ops and leaves the SVG stuck
  // at its initial size.
  useEffect(() => {
    if (!svgContainerRef.current) return;
    const el = svgContainerRef.current;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setW(Math.max(360, Math.floor(width)));
      setH(Math.max(260, Math.floor(height)));
    });
    ro.observe(el);
    // Seed once synchronously in case ResizeObserver doesn't fire immediately.
    const rect = el.getBoundingClientRect();
    setW(Math.max(360, Math.floor(rect.width)));
    setH(Math.max(260, Math.floor(rect.height)));
    return () => ro.disconnect();
  }, [loading, error]);

  // v11.19.4: align the candle fetch with the GCP coverage window.
  // Previous code fetched 500 candles ending Date.now(), but the GCP
  // historical JSON only covers Jan 1 – Apr 24 2026 and live polling
  // only appends the last ~24h. So 5 days of candles ending today
  // overlapped with GCP for a single 24h window — ~96 candles total
  // across 6 regimes — and every row showed Insufficient data.
  // Now: fetch candles ending at the last available GCP timestamp
  // (so the candle window is inside the historical coverage), and
  // pull 2000 of them for ~21 days of overlap.
  //
  // v11.23.4: two bug fixes for symbol awareness:
  //   1) Old XAUUSD candles persisted in state during a symbol switch
  //      to BTC, so the regime scatter rendered "BTC" copy over gold
  //      data until the BTC fetch resolved. Now setCandles([]) clears
  //      the array immediately on the deps trigger, and candleSymbol
  //      tracks which symbol the loaded array belongs to.
  //   2) Deps were [symbol] only with `lastGcpTs` referenced inside
  //      the body. If Research mounted before the GCP series loaded,
  //      lastGcpTs was 0, the early-return fired, and the effect never
  //      re-ran — so no candles ever loaded until the user manually
  //      switched symbols. Adding `gcpReady` (a boolean) to deps fires
  //      the fetch exactly once when the series first appears, and
  //      again on every symbol change, without re-firing on each new
  //      GCP minute (the boolean stays true).
  const lastGcpTs = series.length ? series[series.length - 1].t : 0;
  const gcpReady  = lastGcpTs > 0;
  useEffect(() => {
    // Always reset on the deps trigger so a stale symbol's candles
    // never paint under the new symbol's title.
    setCandles([]);
    setCandleSymbol(null);
    setLoading(true);
    setError(null);

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Research] symbol: ${symbol}`);
      console.log(`[Research] candles source: ${TD_SYMBOLS[symbol]}`);
    }

    if (!gcpReady) return; // wait for GCP series; effect re-fires when ready

    let cancelled = false;
    fetchCandlesForWindow(TD_SYMBOLS[symbol], '15m', 2000, lastGcpTs)
      .then(data => {
        if (cancelled) return;
        setCandles(data);
        setCandleSymbol(symbol);
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[Research] candles loaded for ${symbol}: ${data.length} bars`);
        }
      })
      .catch(e   => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, gcpReady]);

  // ── Regime scatter (one dot per candle) ─────────────────────────────────────
  // v11.19.3: allow partial forward windows + bar-OPEN entry. The
  // previous loop ran `i < candles.length - fwdBars` which dropped the
  // last fwdBars samples entirely; for short candle histories this
  // could leave each regime with single-digit counts. Now we clamp the
  // forward index to the last available bar and require at least one
  // bar of forward window. Entry uses c.o (bar open) per the
  // "regime taken at bar OPEN" spec; exit is the close fwdBars later.
  // taggedByRegime / survivedByRegime are exposed via regimeData so
  // the sidebar can flag "Insufficient data" without re-walking the
  // candle array.
  const regimeData = useMemo(() => {
    const empty = {
      points: [] as RegimePoint[],
      taggedByRegime:   { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<string, number>,
      survivedByRegime: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<string, number>,
    };
    if (!candles.length || !series.length) return empty;
    // v11.23.4: refuse to compute when the loaded candles belong to a
    // different symbol than the one the user has selected. Without this
    // guard, a symbol flip from XAUUSD → BTC would render gold-derived
    // regime points under the BTC label for one render cycle.
    if (candleSymbol && candleSymbol !== symbol) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[Research] symbol mismatch — selected ${symbol} but candles ${candleSymbol}`);
      }
      return empty;
    }

    const gcpByTs = new Map<number, { v: number; r: string }>();
    series.forEach(p => gcpByTs.set(Math.floor(p.t / 1000), { v: p.v, r: p.r ?? regimeFor(p.v) }));

    const taggedByRegime:   Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    const survivedByRegime: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };

    const points: RegimePoint[] = [];
    const lastIdx = candles.length - 1;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      // Need a positive open price to compute a meaningful return.
      if (!c || c.o <= 0) continue;

      // Regime is read at the bar OPEN — look up GCP at the bar's
      // timestamp (with up to 5 min slack to handle slightly off-grid
      // GCP samples).
      const ts = Math.floor(c.t / 1000);
      let gcpPt = gcpByTs.get(ts);
      if (!gcpPt) {
        for (let d = 60; d <= 300; d += 60) {
          gcpPt = gcpByTs.get(ts - d) ?? gcpByTs.get(ts + d);
          if (gcpPt) break;
        }
      }
      if (!gcpPt) continue;

      if (taggedByRegime[gcpPt.r] != null) taggedByRegime[gcpPt.r]++;

      // Allow partial forward windows: clamp the exit index to the
      // last available candle. The last fwdBars bars get progressively
      // shorter windows but are still counted, which is what the
      // "remove over-filtering" spec wants.
      const fwdIdx = Math.min(i + fwdBars, lastIdx);
      if (fwdIdx === i) continue;       // need at least 1 forward bar
      const cFwd = candles[fwdIdx];
      if (!cFwd || cFwd.c <= 0) continue;

      // Entry at bar OPEN; exit at close of the forward bar.
      const fwdPct = ((cFwd.c - c.o) / c.o) * 100;
      points.push({
        kind:   'regime',
        regime: gcpPt.r,
        fwdPct: +fwdPct.toFixed(3),
        t:      c.t,
        nv:     gcpPt.v,
      });
      if (survivedByRegime[gcpPt.r] != null) survivedByRegime[gcpPt.r]++;
    }

    if (process.env.NODE_ENV !== 'production') {
      const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
      const cFirst = candles[0]?.t ?? 0;
      const cLast  = candles[candles.length - 1]?.t ?? 0;
      const gFirst = series[0]?.t ?? 0;
      const gLast  = series[series.length - 1]?.t ?? 0;
      const overlapStart = Math.max(cFirst, gFirst);
      const overlapEnd   = Math.min(cLast, gLast);
      const overlapMs    = Math.max(0, overlapEnd - overlapStart);
      const overlapHours = (overlapMs / 3_600_000).toFixed(1);
      console.log(`[Research] candles ${candles.length} from ${fmt(cFirst)} to ${fmt(cLast)}`);
      console.log(`[Research] GCP series ${series.length} from ${fmt(gFirst)} to ${fmt(gLast)}`);
      console.log(`[Research] overlap window: ${overlapHours}h (${fmt(overlapStart)} → ${fmt(overlapEnd)})`);
      console.log('[Research] tagged per regime:',          taggedByRegime);
      console.log('[Research] survived forward-return:',     survivedByRegime);
      const totalSurvived = Object.values(survivedByRegime).reduce((a, b) => a + b, 0);
      const totalTagged   = Object.values(taggedByRegime).reduce((a, b) => a + b, 0);
      console.log(`[Research] totals — tagged ${totalTagged}, survived ${totalSurvived}, points ${points.length}`);
      console.log(`[Research] regime samples: ${points.length}`);
    }

    return { points, taggedByRegime, survivedByRegime };
  }, [candles, candleSymbol, symbol, series, fwdBars]);

  const regimePoints = regimeData.points;

  // ── Pattern scatter (one dot per pattern occurrence) ────────────────────────
  const patternPoints = useMemo<PatternPoint[]>(() => {
    if (!candles.length || !series.length) return [];
    // v11.23.4: same symbol-mismatch guard as regimeData.
    if (candleSymbol && candleSymbol !== symbol) return [];

    const candleStart = candles[0].t;
    const candleEnd   = candles[candles.length - 1].t;
    const windowSeries = series.filter(p => p.t >= candleStart - 3_600_000 && p.t <= candleEnd);
    if (windowSeries.length < 50) return [];

    const patterns = detectPatterns(windowSeries, 1);

    const fwdMs = fwdBars * 15 * 60_000;
    const points: PatternPoint[] = [];
    for (const p of patterns) {
      const entryCandle = candles.find(c => c.t >= p.tEnd);
      if (!entryCandle || entryCandle.c <= 0) continue;
      const exitTime = entryCandle.t + fwdMs;
      const exitCandle = candles.find(c => c.t >= exitTime);
      if (!exitCandle || exitCandle.c <= 0) continue;

      const fwdPct = ((exitCandle.c - entryCandle.c) / entryCandle.c) * 100;
      points.push({
        kind:    'pattern',
        pattern: p.kind,
        fwdPct:  +fwdPct.toFixed(3),
        t:       p.tStart,
        pss:     Math.round(p.strength * 100),
      });
    }
    return points;
  }, [candles, candleSymbol, symbol, series, fwdBars]);

  // ── Stats per axis ──────────────────────────────────────────────────────────
  // v11.19.3: stats include `tagged` (raw per-regime count before
  // forward-return filtering) and an `insufficient` flag the sidebar
  // uses to surface "Insufficient data" when the regime has fewer
  // than 50 samples.
  const regimeStats = useMemo(() => {
    const map: Record<string, {
      pts:           RegimePoint[];
      tagged:        number;
      avg:           number;
      bull:          number;
      bear:          number;
      insufficient:  boolean;
    }> = {};
    for (const r of 'ABCDEF') {
      const pts    = regimePoints.filter(p => p.regime === r);
      const avg    = pts.length ? pts.reduce((s, p) => s + p.fwdPct, 0) / pts.length : 0;
      const bull   = pts.filter(p => p.fwdPct >  0.05).length;
      const bear   = pts.filter(p => p.fwdPct < -0.05).length;
      const tagged = regimeData.taggedByRegime[r] ?? 0;
      map[r] = { pts, tagged, avg, bull, bear, insufficient: pts.length < 50 };
    }
    return map;
  }, [regimePoints, regimeData]);

  const patternStats = useMemo(() => {
    const map: Record<string, { pts: PatternPoint[]; avg: number; bull: number; bear: number }> = {};
    for (const kind of Object.keys(PATTERN_META)) {
      const pts  = patternPoints.filter(p => p.pattern === kind);
      const avg  = pts.length ? pts.reduce((s, p) => s + p.fwdPct, 0) / pts.length : 0;
      const bull = pts.filter(p => p.fwdPct >  0.05).length;
      const bear = pts.filter(p => p.fwdPct < -0.05).length;
      map[kind] = { pts, avg, bull, bear };
    }
    return map;
  }, [patternPoints]);

  // ── AI State history (local-only ledger, v11.20) ────────────────────────────
  // Loaded once on mount and kept fresh via the same-tab + cross-tab
  // storage event the appendAiStateHistory helper dispatches. No
  // network calls here — just localStorage.
  const [aiHistory, setAiHistory] = useState<AiStateHistoryRecord[]>([]);
  useEffect(() => {
    setAiHistory(loadAiStateHistory());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_HISTORY_LS_KEY) setAiHistory(loadAiStateHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Forward returns for each AI history record. Entry uses the open
  // of the candle at-or-after the record timestamp; exit uses the
  // close fwdBars later (clamped to the last candle so partial windows
  // are still counted).
  // v11.20.1: records that don't have a forward candle yet are
  // counted separately as `pendingByState` so the sidebar can show
  // the user "you ran AI X times but the forward window hasn't fully
  // played out yet" instead of dropping them silently.
  const aiStateData = useMemo(() => {
    const points: AiStatePoint[] = [];
    const pendingByState: Record<string, number> = {};
    const totalForSymbol = aiHistory.filter(r => r.symbol === symbol).length;
    if (!aiHistory.length || !candles.length) {
      return { points, pendingByState, totalForSymbol, pendingTotal: totalForSymbol };
    }
    // v11.23.4: same symbol-mismatch guard as regimeData / patternPoints.
    if (candleSymbol && candleSymbol !== symbol) {
      return { points, pendingByState, totalForSymbol, pendingTotal: totalForSymbol };
    }
    const lastIdx = candles.length - 1;
    let pendingTotal = 0;
    const markPending = (code: string) => {
      pendingByState[code] = (pendingByState[code] ?? 0) + 1;
      pendingTotal++;
    };
    for (const rec of aiHistory) {
      if (rec.symbol !== symbol) continue;
      // Find the first candle at-or-after the record timestamp.
      let entryIdx = -1;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i].t >= rec.timestamp) { entryIdx = i; break; }
      }
      if (entryIdx === -1)         { markPending(rec.stateCode); continue; }
      const entry = candles[entryIdx];
      const entryPrice = entry.o > 0 ? entry.o : entry.c;
      if (entryPrice <= 0)         { markPending(rec.stateCode); continue; }
      const exitIdx = Math.min(entryIdx + fwdBars, lastIdx);
      if (exitIdx === entryIdx)    { markPending(rec.stateCode); continue; }
      const exit = candles[exitIdx];
      if (!exit || exit.c <= 0)    { markPending(rec.stateCode); continue; }
      const fwdPct = ((exit.c - entryPrice) / entryPrice) * 100;
      points.push({
        kind:       'aistate',
        stateCode:  rec.stateCode,
        state:      rec.state,
        phase:      rec.phase,
        direction:  rec.direction,
        confidence: rec.confidence,
        fwdPct:     +fwdPct.toFixed(3),
        t:          rec.timestamp,
      });
    }
    return { points, pendingByState, totalForSymbol, pendingTotal };
  }, [aiHistory, candles, candleSymbol, fwdBars, symbol]);

  const aiStatePoints = aiStateData.points;

  const aiStateStats = useMemo(() => {
    const map: Record<string, {
      pts:          AiStatePoint[];
      pending:      number;
      avg:          number;
      bull:         number;
      bear:         number;
      avgConf:      number;
      topPhase:     string;
      topDir:       string;
      insufficient: boolean;
    }> = {};
    for (const code of Object.keys(AI_STATE_META)) {
      const pts     = aiStatePoints.filter(p => p.stateCode === code);
      const pending = aiStateData.pendingByState[code] ?? 0;
      const avg     = pts.length ? pts.reduce((s, p) => s + p.fwdPct, 0) / pts.length : 0;
      const bull    = pts.filter(p => p.fwdPct >  0.05).length;
      const bear    = pts.filter(p => p.fwdPct < -0.05).length;
      const avgConf = pts.length ? pts.reduce((s, p) => s + p.confidence, 0) / pts.length : 0;
      // Mode of phase / direction within the group.
      const tally = (key: 'phase' | 'direction'): string => {
        const c: Record<string, number> = {};
        for (const p of pts) c[p[key]] = (c[p[key]] ?? 0) + 1;
        let best = '—', n = 0;
        for (const [k, v] of Object.entries(c)) if (v > n) { best = k; n = v; }
        return best;
      };
      map[code] = {
        pts, pending, avg, bull, bear,
        avgConf,
        topPhase: pts.length ? tally('phase')     : '—',
        topDir:   pts.length ? tally('direction') : '—',
        insufficient: pts.length < AI_STATE_MIN_COUNT,
      };
    }
    return map;
  }, [aiStatePoints, aiStateData]);

  // ── Geometry ────────────────────────────────────────────────────────────────
  const PAD = { l: 56, r: 24, t: 24, b: 60 };
  const IW  = Math.max(80, W - PAD.l - PAD.r);
  const IH  = Math.max(80, H - PAD.t - PAD.b);

  const Y_MAX = 3, Y_MIN = -3;
  const yOf = (pct: number) =>
    PAD.t + (1 - (Math.max(Y_MIN, Math.min(Y_MAX, pct)) - Y_MIN) / (Y_MAX - Y_MIN)) * IH;

  const cols =
    mode === 'regime'  ? 6 :
    mode === 'pattern' ? PATTERN_COLS :
                         AI_STATE_COLS;
  const colMeta =
    mode === 'regime'  ? REGIME_META :
    mode === 'pattern' ? PATTERN_META :
                         AI_STATE_META;

  const xOfRegime = (regime: string) => {
    const meta = REGIME_META[regime];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / 6) * IW;
  };
  const xOfPattern = (kind: string) => {
    const meta = PATTERN_META[kind];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / PATTERN_COLS) * IW;
  };
  const xOfAiState = (code: string) => {
    const meta = AI_STATE_META[code];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / AI_STATE_COLS) * IW;
  };
  const xOfPoint = (pt: RegimePoint | PatternPoint | AiStatePoint) =>
    pt.kind === 'regime'  ? xOfRegime(pt.regime)
  : pt.kind === 'pattern' ? xOfPattern(pt.pattern)
  :                         xOfAiState(pt.stateCode);

  const jitter = (i: number) => (Math.sin(i * 9301 + 49297) * 0.5) * (IW / cols) * 0.35;

  const visiblePoints: (RegimePoint | PatternPoint | AiStatePoint)[] =
    mode === 'regime'  ? regimePoints  :
    mode === 'pattern' ? patternPoints :
                         aiStatePoints;
  const totalLabel =
    mode === 'regime'  ? `${regimePoints.length} bars`        :
    mode === 'pattern' ? `${patternPoints.length} occurrences`:
    aiStateData.pendingTotal > 0
      ? `${aiStateData.totalForSymbol} analyses · ${aiStateData.pendingTotal} pending`
      : `${aiStateData.totalForSymbol} analyses`;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--line-1)',
        display: 'flex', alignItems: 'center', gap: 12,
        flexShrink: 0, fontSize: 10,
      }}>
        <span style={{ color: 'var(--fg-0)', fontWeight: 600, letterSpacing: '0.04em' }}>
          RESEARCH
        </span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-2)' }}>
          {mode === 'regime'  ? 'GCP Regime → Price'         :
           mode === 'pattern' ? 'GCP Pattern → Forward Price' :
                                'AI State → Forward Price'}
        </span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-3)' }}>{symbol}</span>

        <div style={{ display: 'flex', gap: 1, marginLeft: 12 }}>
          {(['regime', 'pattern', 'aistate'] as ResearchMode[]).map(m => (
            <button key={m}
              onClick={() => { setMode(m); setHovered(null); }}
              style={{
                padding: '2px 10px', fontSize: 9, letterSpacing: '0.08em',
                fontFamily: 'var(--font-mono)',
                background: mode === m ? 'var(--bg-2)' : 'transparent',
                border: `1px solid ${mode === m ? 'var(--line-2)' : 'transparent'}`,
                borderRadius: 2,
                color: mode === m ? 'var(--fg-0)' : 'var(--fg-3)',
                cursor: 'pointer',
              }}
            >
              {m === 'regime'  ? 'BY REGIME'  :
               m === 'pattern' ? 'BY PATTERN' :
                                 'BY AI STATE'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <span style={{ color: 'var(--fg-4)', fontSize: 9 }}>FORWARD</span>
        {[1, 2, 4, 8, 16].map(n => (
          <button key={n}
            onClick={() => setFwdBars(n)}
            style={{
              padding: '2px 7px', fontSize: 9,
              fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
              background: fwdBars === n ? 'var(--bg-3)' : 'transparent',
              border: `1px solid ${fwdBars === n ? 'var(--line-2)' : 'transparent'}`,
              borderRadius: 2,
              color: fwdBars === n ? 'var(--fg-0)' : 'var(--fg-3)',
              cursor: 'pointer',
            }}
          >
            {FWD_LABEL[n]}
          </button>
        ))}

        <span style={{ color: 'var(--fg-4)', fontSize: 9, marginLeft: 8 }}>
          {totalLabel}
        </span>
      </div>

      {loading && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: 'var(--fg-4)', letterSpacing: '0.1em',
        }}>
          LOADING PRICE DATA…
        </div>
      )}

      {error && !loading && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, color: 'var(--red)', letterSpacing: '0.08em',
        }}>
          PRICE FETCH ERROR · {error.slice(0, 100)}
        </div>
      )}

      {!loading && !error && (
        <>
          <div style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--line-0)',
            fontSize: 9, lineHeight: 1.6, color: 'var(--fg-2)',
            flexShrink: 0,
          }}>
            <span style={{ color: 'var(--fg-0)', fontWeight: 600 }}>How to read this: </span>
            {mode === 'regime' && (
              <>
                Each dot = one 15 m price bar, colored by whether price went{' '}
                <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
                <span style={{ color: '#ef4444' }}>down ↓</span> over the next {FWD_LABEL[fwdBars]}.
                X-axis is the GCP regime active when the bar opened; the horizontal line per column
                is the average move in that regime.{' '}
                <span style={{ color: '#d4a028' }}>
                  D regime trending positive = GCP synchronization tends to precede upward price moves.
                </span>
              </>
            )}
            {mode === 'pattern' && (
              <>
                Each dot = one pattern occurrence, colored by whether price went{' '}
                <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
                <span style={{ color: '#ef4444' }}>down ↓</span> in the {FWD_LABEL[fwdBars]} after the pattern ended.
                X-axis is which GCP pattern fired; the horizontal line per column is the average outcome.{' '}
                <span style={{ color: '#d4a028' }}>
                  AL trending positive = Alignment Ladder reliably precedes upward moves.
                </span>
              </>
            )}
            {mode === 'aistate' && (
              <>
                Each dot = one manual AI analysis, colored by whether price went{' '}
                <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
                <span style={{ color: '#ef4444' }}>down ↓</span> in the {FWD_LABEL[fwdBars]} after the
                AI State was reported. Positive averages mean that state historically preceded upward moves.{' '}
                <span style={{ color: '#d4a028' }}>
                  AT trending positive = Alignment Trend reliably precedes upward moves.
                </span>
              </>
            )}
          </div>

          <div style={{
            flex: 1, minHeight: 0,
            display: 'flex', overflow: 'hidden',
          }}>
            <div
              ref={svgContainerRef}
              style={{
                flex: 1, minWidth: 0, minHeight: 0,
                position: 'relative', overflow: 'hidden',
              }}
            >
              <svg
                width={W} height={H}
                style={{ display: 'block' }}
                onMouseLeave={() => setHovered(null)}
              >
                {[-2, -1, 0, 1, 2].map(pct => (
                  <g key={pct}>
                    <line
                      x1={PAD.l} x2={W - PAD.r}
                      y1={yOf(pct)} y2={yOf(pct)}
                      stroke={pct === 0 ? '#2a2f37' : '#15181d'}
                      strokeWidth={pct === 0 ? 1 : 0.5}
                      strokeDasharray={pct === 0 ? '' : '2 4'}
                    />
                    <text
                      x={PAD.l - 6} y={yOf(pct) + 3}
                      textAnchor="end"
                      fontSize={9} fill="#464c56"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {pct > 0 ? '+' : ''}{pct}%
                    </text>
                  </g>
                ))}

                {Object.entries(colMeta).map(([k, meta]) => {
                  const cx = PAD.l + ((meta.x - 0.5) / cols) * IW;
                  const bw = IW / cols;
                  return (
                    <rect key={k}
                      x={cx - bw / 2} y={PAD.t}
                      width={bw} height={IH}
                      fill={`${meta.color}08`}
                    />
                  );
                })}

                {visiblePoints.map((pt, i) => {
                  const x = xOfPoint(pt) + jitter(i);
                  const y = yOf(pt.fwdPct);
                  const isUp   = pt.fwdPct >  0.05;
                  const isFlat = Math.abs(pt.fwdPct) <= 0.05;
                  const col    = isUp ? '#22c55e' : isFlat ? '#464c56' : '#ef4444';
                  return (
                    <circle key={i}
                      cx={x} cy={y} r={mode === 'pattern' ? 3 : 2.5}
                      fill={col} opacity={mode === 'pattern' ? 0.65 : 0.5}
                      style={{ cursor: 'crosshair' }}
                      onMouseEnter={() => setHovered(pt)}
                    />
                  );
                })}

                {mode === 'regime' && Object.entries(regimeStats).map(([r, s]) => {
                  if (s.pts.length < 3) return null;
                  const cx  = xOfRegime(r);
                  const y   = yOf(s.avg);
                  const col = REGIME_META[r]?.color ?? '#fff';
                  return (
                    <g key={r}>
                      <line x1={cx - 20} x2={cx + 20} y1={y} y2={y} stroke={col} strokeWidth={2} />
                      <text x={cx} y={y - 6} textAnchor="middle" fontSize={8} fill={col}
                        fontFamily="IBM Plex Mono, monospace">
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </text>
                    </g>
                  );
                })}

                {mode === 'pattern' && Object.entries(patternStats).map(([kind, s]) => {
                  if (s.pts.length < 2) return null;
                  const cx  = xOfPattern(kind);
                  const y   = yOf(s.avg);
                  const col = PATTERN_META[kind]?.color ?? '#fff';
                  return (
                    <g key={kind}>
                      <line x1={cx - 18} x2={cx + 18} y1={y} y2={y} stroke={col} strokeWidth={2} />
                      <text x={cx} y={y - 6} textAnchor="middle" fontSize={8} fill={col}
                        fontFamily="IBM Plex Mono, monospace">
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </text>
                    </g>
                  );
                })}

                {mode === 'aistate' && Object.entries(aiStateStats).map(([code, s]) => {
                  if (s.pts.length < 2) return null;
                  const cx  = xOfAiState(code);
                  const y   = yOf(s.avg);
                  const col = AI_STATE_META[code]?.color ?? '#fff';
                  return (
                    <g key={code}>
                      <line x1={cx - 16} x2={cx + 16} y1={y} y2={y} stroke={col} strokeWidth={2} />
                      <text x={cx} y={y - 6} textAnchor="middle" fontSize={8} fill={col}
                        fontFamily="IBM Plex Mono, monospace">
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </text>
                    </g>
                  );
                })}

                {mode === 'regime' && Object.entries(REGIME_META).map(([r, meta]) => (
                  <g key={r}>
                    <text
                      x={PAD.l + ((meta.x - 0.5) / 6) * IW}
                      y={H - PAD.b + 16}
                      textAnchor="middle"
                      fontSize={9} fill={meta.color}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {r}
                    </text>
                    <text
                      x={PAD.l + ((meta.x - 0.5) / 6) * IW}
                      y={H - PAD.b + 28}
                      textAnchor="middle"
                      fontSize={8} fill="#2a2f37"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.label.split('·')[1]?.trim()}
                    </text>
                  </g>
                ))}

                {mode === 'pattern' && Object.entries(PATTERN_META).map(([kind, meta]) => (
                  <g key={kind}>
                    <text
                      x={xOfPattern(kind)}
                      y={H - PAD.b + 16}
                      textAnchor="middle"
                      fontSize={10} fill={meta.color} fontWeight={600}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.abbr}
                    </text>
                    <text
                      x={xOfPattern(kind)}
                      y={H - PAD.b + 28}
                      textAnchor="middle"
                      fontSize={7} fill="#2a2f37"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.label.split(' ').slice(-1)[0]}
                    </text>
                  </g>
                ))}

                {mode === 'aistate' && Object.entries(AI_STATE_META).map(([code, meta]) => (
                  <g key={code}>
                    <text
                      x={xOfAiState(code)}
                      y={H - PAD.b + 16}
                      textAnchor="middle"
                      fontSize={10} fill={meta.color} fontWeight={600}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.abbr}
                    </text>
                    <text
                      x={xOfAiState(code)}
                      y={H - PAD.b + 28}
                      textAnchor="middle"
                      fontSize={7} fill="#2a2f37"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.label.split(' ').slice(-1)[0]}
                    </text>
                  </g>
                ))}

                <text
                  x={14} y={PAD.t + IH / 2}
                  textAnchor="middle" fontSize={8} fill="#464c56"
                  fontFamily="IBM Plex Mono, monospace"
                  transform={`rotate(-90, 14, ${PAD.t + IH / 2})`}
                >
                  PRICE CHANGE {FWD_LABEL[fwdBars]} FORWARD
                </text>

                {hovered && (
                  <circle
                    cx={xOfPoint(hovered) + jitter(visiblePoints.indexOf(hovered))}
                    cy={yOf(hovered.fwdPct)}
                    r={5}
                    fill="none" stroke="white" strokeWidth={1.5}
                  />
                )}
              </svg>

              {hovered && (
                <div style={{
                  position: 'absolute', top: 20, right: 20,
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 3, padding: '6px 10px',
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                }}>
                  {hovered.kind === 'regime' && (
                    <>
                      <div style={{ color: REGIME_META[hovered.regime]?.color, marginBottom: 3 }}>
                        {REGIME_META[hovered.regime]?.label}
                      </div>
                      <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                        {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                        NV {hovered.nv.toFixed(1)}
                      </div>
                      <div style={{ color: 'var(--fg-4)' }}>
                        {new Date(hovered.t).toLocaleDateString()} {new Date(hovered.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                      </div>
                    </>
                  )}
                  {hovered.kind === 'pattern' && (
                    <>
                      <div style={{ color: PATTERN_META[hovered.pattern]?.color, marginBottom: 3 }}>
                        {hovered.pattern}
                      </div>
                      <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                        {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                        PSS {hovered.pss}
                      </div>
                      <div style={{ color: 'var(--fg-4)' }}>
                        {new Date(hovered.t).toLocaleDateString()} {new Date(hovered.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                      </div>
                    </>
                  )}
                  {hovered.kind === 'aistate' && (
                    <>
                      <div style={{ color: AI_STATE_META[hovered.stateCode]?.color, marginBottom: 3 }}>
                        {hovered.stateCode} · {hovered.state}
                      </div>
                      <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                        {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                        {hovered.phase} · {hovered.direction}
                      </div>
                      <div style={{ color: 'var(--fg-4)' }}>
                        Conf {(hovered.confidence * 100).toFixed(0)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)' }}>
                        {new Date(hovered.t).toLocaleDateString()} {new Date(hovered.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div style={{
              width: 200, borderLeft: '1px solid var(--line-1)',
              padding: '16px 14px', overflow: 'auto',
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: 8, letterSpacing: '0.12em',
                color: 'var(--fg-4)', marginBottom: 12,
              }}>
                {mode === 'regime'  ? 'REGIME SUMMARY'  :
                 mode === 'pattern' ? 'PATTERN SUMMARY' :
                                      'AI STATE SUMMARY'}
              </div>

              {mode === 'regime' && Object.entries(REGIME_META).map(([r, meta]) => {
                const s = regimeStats[r];
                if (!s) return null;
                const bullPct = s.pts.length ? (s.bull / s.pts.length * 100) : 0;
                return (
                  <div key={r} style={{
                    marginBottom: 12, paddingBottom: 12,
                    borderBottom: '1px solid var(--line-0)',
                    opacity: s.insufficient ? 0.55 : 1,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{r}</span>
                      <span style={{
                        fontSize: 10, fontVariantNumeric: 'tabular-nums',
                        color: s.insufficient
                          ? 'var(--fg-3)'
                          : s.avg > 0.02 ? '#22c55e' : s.avg < -0.02 ? '#ef4444' : 'var(--fg-3)',
                      }}>
                        {s.pts.length === 0 ? '—' : `${s.avg > 0 ? '+' : ''}${s.avg.toFixed(2)}%`}
                      </span>
                    </div>
                    <div style={{
                      display: 'flex', gap: 6,
                      fontSize: 8, color: 'var(--fg-4)',
                      flexWrap: 'wrap',
                    }}>
                      <span>{s.pts.length} samples</span>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span>{s.pts.length ? `${bullPct.toFixed(0)}% bull` : '—'}</span>
                    </div>
                    {/* v11.19.3: dev sees the tagged count too, so the
                        gap between "tagged" and "survived" is visible
                        when a regime has bars but they all fail the
                        forward-window filter. */}
                    {s.tagged !== s.pts.length && (
                      <div style={{ fontSize: 8, color: 'var(--fg-4)', marginTop: 2 }}>
                        {s.tagged} tagged · {s.pts.length} with forward return
                      </div>
                    )}
                    {s.insufficient ? (
                      <div style={{
                        marginTop: 4,
                        fontSize: 8, color: '#d4a028',
                        letterSpacing: '0.04em',
                      }}>
                        Insufficient data
                      </div>
                    ) : (
                      <div style={{
                        height: 3, background: '#ef4444',
                        borderRadius: 1, marginTop: 4, overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%', background: '#22c55e',
                          width: `${bullPct}%`, borderRadius: 1,
                        }} />
                      </div>
                    )}
                  </div>
                );
              })}

              {mode === 'pattern' && Object.entries(PATTERN_META).map(([kind, meta]) => {
                const s = patternStats[kind];
                if (!s || s.pts.length === 0) {
                  return (
                    <div key={kind} style={{
                      marginBottom: 8, paddingBottom: 8, opacity: 0.45,
                      borderBottom: '1px solid var(--line-0)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{meta.abbr}</span>
                        <span style={{ color: 'var(--fg-4)', fontSize: 9 }}>no data</span>
                      </div>
                      <div style={{ fontSize: 8, color: 'var(--fg-4)', marginTop: 2 }}>
                        {meta.label}
                      </div>
                    </div>
                  );
                }
                const bullPct = s.pts.length ? (s.bull / s.pts.length * 100) : 0;
                return (
                  <div key={kind} style={{
                    marginBottom: 10, paddingBottom: 10,
                    borderBottom: '1px solid var(--line-0)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{meta.abbr}</span>
                      <span style={{
                        fontSize: 11, fontVariantNumeric: 'tabular-nums',
                        color: s.avg > 0.05 ? '#22c55e' : s.avg < -0.05 ? '#ef4444' : 'var(--fg-3)',
                      }}>
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--fg-4)', marginBottom: 3 }}>
                      {meta.label} · {s.pts.length} occurrences
                    </div>
                    <div style={{ display: 'flex', gap: 6, fontSize: 8, color: 'var(--fg-4)', marginBottom: 4 }}>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span>{bullPct.toFixed(0)}% bullish</span>
                    </div>
                    <div style={{ height: 3, background: '#ef4444', borderRadius: 1, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#22c55e', width: `${bullPct}%`, borderRadius: 1 }} />
                    </div>
                  </div>
                );
              })}

              {/* v11.20.1: empty state only when there is genuinely
                  no history. If the user has run analyses but their
                  forward windows haven't fully played out, we show
                  the records as pending instead of pretending the
                  ledger is empty. */}
              {mode === 'aistate' && aiStateData.totalForSymbol === 0 && (
                <div style={{
                  padding: '14px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  borderRadius: 4,
                  fontSize: 10, color: '#7F98A3', lineHeight: 1.55,
                }}>
                  <div style={{ color: 'var(--fg-1)', fontWeight: 600, marginBottom: 6, fontSize: 11 }}>
                    No AI State history yet.
                  </div>
                  Run AI Analysis from the Dashboard to start collecting outcomes.
                </div>
              )}

              {mode === 'aistate' && aiStateData.totalForSymbol > 0 && Object.entries(AI_STATE_META).map(([code, meta]) => {
                const s = aiStateStats[code];
                if (!s) return null;
                const total = s.pts.length + s.pending;
                if (total === 0) {
                  return (
                    <div key={code} style={{
                      marginBottom: 8, paddingBottom: 8, opacity: 0.45,
                      borderBottom: '1px solid var(--line-0)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{meta.abbr}</span>
                        <span style={{ color: 'var(--fg-4)', fontSize: 9 }}>no data</span>
                      </div>
                      <div style={{ fontSize: 8, color: 'var(--fg-4)', marginTop: 2 }}>
                        {meta.label}
                      </div>
                    </div>
                  );
                }
                // v11.20.1: groups with only-pending records (no
                // forward outcome yet) get their own treatment so the
                // user sees the analysis was logged but the window
                // hasn't finished.
                if (s.pts.length === 0 && s.pending > 0) {
                  return (
                    <div key={code} style={{
                      marginBottom: 10, paddingBottom: 10,
                      borderBottom: '1px solid var(--line-0)',
                      opacity: 0.85,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{meta.abbr}</span>
                        <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>pending</span>
                      </div>
                      <div style={{ fontSize: 8, color: 'var(--fg-4)', marginBottom: 3 }}>
                        {meta.label} · {s.pending} pending outcome{s.pending === 1 ? '' : 's'}
                      </div>
                      <div style={{ fontSize: 8, color: '#7F98A3', lineHeight: 1.5 }}>
                        Forward window not yet available
                      </div>
                    </div>
                  );
                }
                const bullPct = s.pts.length ? (s.bull / s.pts.length * 100) : 0;
                return (
                  <div key={code} style={{
                    marginBottom: 10, paddingBottom: 10,
                    borderBottom: '1px solid var(--line-0)',
                    opacity: s.insufficient ? 0.65 : 1,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{meta.abbr}</span>
                      <span style={{
                        fontSize: 11, fontVariantNumeric: 'tabular-nums',
                        color: s.insufficient
                          ? 'var(--fg-3)'
                          : s.avg > 0.05 ? '#22c55e' : s.avg < -0.05 ? '#ef4444' : 'var(--fg-3)',
                      }}>
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--fg-4)', marginBottom: 3 }}>
                      {meta.label} · {s.pts.length} analyses
                      {s.pending > 0 && ` · ${s.pending} pending`}
                    </div>
                    <div style={{ display: 'flex', gap: 6, fontSize: 8, color: 'var(--fg-4)', marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span>{bullPct.toFixed(0)}% bullish</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, fontSize: 8, color: 'var(--fg-4)', flexWrap: 'wrap' }}>
                      <span>conf {(s.avgConf * 100).toFixed(0)}%</span>
                      <span>· phase {s.topPhase}</span>
                      <span>· dir {s.topDir}</span>
                    </div>
                    {s.insufficient ? (
                      <div style={{
                        marginTop: 4,
                        fontSize: 8, color: '#d4a028',
                        letterSpacing: '0.04em',
                      }}>
                        Insufficient data
                      </div>
                    ) : (
                      <div style={{ height: 3, background: '#ef4444', borderRadius: 1, marginTop: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: '#22c55e', width: `${bullPct}%`, borderRadius: 1 }} />
                      </div>
                    )}
                  </div>
                );
              })}

              <div style={{
                fontSize: 8, color: 'var(--fg-4)',
                lineHeight: 1.5, marginTop: 8,
              }}>
                Avg line = mean price change.
                Bull/bear bar = % of{' '}
                {mode === 'regime'  ? 'bars' :
                 mode === 'pattern' ? 'occurrences' :
                                      'analyses'} with positive outcome.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
