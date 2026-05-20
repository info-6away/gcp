'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import type { DataPoint, MarketSymbol } from '@/types/gcp';
import { fetchCandlesForWindow, type Candle } from '@/lib/fetchCandles';
import { detectPatterns } from '@/lib/gcp-data';
import {
  AI_HISTORY_LS_KEY, loadAiStateHistory,
  type AiStateHistoryRecord,
} from '@/lib/aiStateHistory';
import { sampleConfidence, SAMPLE_COLOR } from '@/lib/sampleConfidence';
import {
  signatureMatchesFilter, FILTER_LABEL, FILTER_PHRASE,
  type FieldContextFilter,
} from '@/lib/fieldSignature';
import {
  FAMILY_LABEL, FAMILY_ORDER, familyOf, type MarketFamily,
} from '@/lib/marketFamilies';
import { findLiveMatches, type LiveMatch } from '@/lib/liveMatch';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
  EURUSD: 'EUR/USD',
  USDJPY: 'USD/JPY',
  ETH:    'ETH/USD',
  GBPUSD: 'GBP/USD',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
};

// v17.0: 'regime' tab replaced with 'opportunity'. Regime alone has
// weak explanatory power on its own; opportunity distance (the radar
// closeness-to-GO bucket) answers "do NEAR opportunities actually
// become winners?" which is the question that matters for trading.
// v17.3: 'family' tab added. Coherence-rotation analytics — what
// happens to each symbol when a given family is leading the field.
type ResearchMode =
  'opportunity' | 'pattern' | 'aistate' | 'transition' | 'family';

interface OpportunityPoint {
  kind:    'opportunity';
  status:  'far' | 'building' | 'near' | 'imminent' | 'go';
  score:   number;
  fwdPct:  number;
  t:       number;
  stateCode: string;
}

// v17.3: one dot per radar observation that carries a fieldSignature.
// X-axis = which family was leading the field at scan time. Color =
// up / down. Sidebar slices each leading-family bucket further by the
// observation's OWN symbol so the user can read "When metals lead,
// gold averages +0.4% but BTC averages -0.2%".
interface FamilyPoint {
  kind:        'family';
  /** Which family was leading the field at the time of this read. */
  leadFamily:  MarketFamily;
  /** Top family's mood at scan time. */
  leadMood:    string;
  /** Symbol this observation belongs to. */
  symbol:      MarketSymbol;
  /** That symbol's own family — drives the per-symbol breakdown. */
  symbolFamily: MarketFamily;
  fwdPct:      number;
  t:           number;
  stateCode:   string;
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
  // v17.0: opportunity bucket persisted on the record (when present).
  // Older history rows (pre-v17) won't have these — they'll appear in
  // BY AI STATE but not in BY OPPORTUNITY.
  opportunityStatus?: 'far' | 'building' | 'near' | 'imminent' | 'go';
  opportunityScore?:  number;
}

// v11.32: transitions are state-pair events captured from
// aiStateHistory. fwdPct measures the forward price move from the
// new-state timestamp; stable=true when the next analysis stayed in
// the same toCode (used for the Transition Stability metric).
interface TransitionPoint {
  kind:           'transition';
  fromCode:       string;
  toCode:         string;
  /** "CS→IS" — used as the column key in TRANSITION_META */
  transitionKey:  string;
  fwdPct:         number;
  t:              number;
  fromConfidence: number;
  toConfidence:   number;
  /** next analysis after this transition stayed in toCode */
  stable:         boolean;
}

type Hovered =
  OpportunityPoint | PatternPoint | AiStatePoint | TransitionPoint | FamilyPoint;

// v17.0: opportunity buckets — far/building/near/imminent/go. Colors
// mirror the radar's OPP_STATUS_COLOR palette so the same value reads
// the same way wherever it appears.
const OPPORTUNITY_META: Record<string, {
  label: string; abbr: string; color: string; x: number;
}> = {
  far:      { label: 'Far',      abbr: 'FAR',  color: '#7F98A3', x: 1 },
  building: { label: 'Building', abbr: 'BLD',  color: '#d4a028', x: 2 },
  near:     { label: 'Near',     abbr: 'NEAR', color: '#4dd9e8', x: 3 },
  imminent: { label: 'Imminent', abbr: 'IMM',  color: '#22c55e', x: 4 },
  go:       { label: 'Go',       abbr: 'GO',   color: '#22c55e', x: 5 },
};
const OPPORTUNITY_COLS = 5;
const OPPORTUNITY_ORDER: Array<keyof typeof OPPORTUNITY_META> =
  ['far', 'building', 'near', 'imminent', 'go'];

// v17.3: family-leadership columns. X-axis = which family was leading
// the field when the observation was captured. Colors echo the radar
// palette so a quick glance maps across surfaces.
const FAMILY_META: Record<MarketFamily, {
  label: string; abbr: string; color: string; x: number;
}> = {
  metals: { label: 'Metals',    abbr: 'METALS', color: '#d4a028', x: 1 },
  crypto: { label: 'Crypto',    abbr: 'CRYPTO', color: '#22c55e', x: 2 },
  fx:     { label: 'Dollar FX', abbr: 'FX',     color: '#4dd9e8', x: 3 },
  risk:   { label: 'Risk',      abbr: 'RISK',   color: '#fb923c', x: 4 },
};
const FAMILY_COLS = 4;

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

// v11.32: priority transitions for the State Transition Matrix.
// Each entry maps a "FROM→TO" key to its column metadata. Only these
// transitions occupy a column in the BY TRANSITION view; rarer pairs
// are tallied as "OTHER" so the x-axis stays readable.
//
// v17.1 — Transition Research Rebuild. Expanded the priority set with
// three more high-value pairs that complete the success ladder past
// ignition (CS→AT, AT→SS, SS→CL). Sample-count gate lowered to 1 so
// even single observations appear with a LOW SampleBadge — the badge
// communicates uncertainty without hiding the row.
//
//   Compression cycle   CS→IS, CS→AT, IS→AT, AT→SS, SS→CL
//   Failure pivots      AT→FA, FA→CS
//   Recompression       AT→CS, IS→CS
//   Shock ladder        SH→CS, DS→CS, SH→DS
const TRANSITION_META: Record<string, {
  abbr: string; label: string; color: string; x: number;
}> = {
  'CS→IS': { abbr: 'CS→IS', label: 'Compression → Ignition',   color: '#4dd9e8', x: 1 },
  'CS→AT': { abbr: 'CS→AT', label: 'Compression → Alignment',  color: '#2db8b4', x: 2 },
  'IS→AT': { abbr: 'IS→AT', label: 'Ignition → Alignment',     color: '#22c55e', x: 3 },
  'AT→SS': { abbr: 'AT→SS', label: 'Alignment → Sync',         color: '#d4a028', x: 4 },
  'SS→CL': { abbr: 'SS→CL', label: 'Sync → Climax',            color: '#d46428', x: 5 },
  'AT→FA': { abbr: 'AT→FA', label: 'Alignment → Failed',       color: '#ef4444', x: 6 },
  'FA→CS': { abbr: 'FA→CS', label: 'Failed → Compression',     color: '#7F98A3', x: 7 },
  'AT→CS': { abbr: 'AT→CS', label: 'Alignment → Recompress',   color: '#7F98A3', x: 8 },
  'IS→CS': { abbr: 'IS→CS', label: 'Ignition → Recompress',    color: '#7F98A3', x: 9 },
  'SH→CS': { abbr: 'SH→CS', label: 'Shock → Compression',      color: '#fb923c', x: 10 },
  'DS→CS': { abbr: 'DS→CS', label: 'Discharge → Compression',  color: '#fb923c', x: 11 },
  'SH→DS': { abbr: 'SH→DS', label: 'Shock → Discharge',        color: '#e24b4a', x: 12 },
};
const TRANSITION_COLS = 12;
// v17.1: drop the 3-sample gate. The SampleBadge already conveys
// LOW/MEDIUM/HIGH reliability, so a single observation can show with
// a LOW badge instead of being hidden as "Insufficient".
const TRANSITION_MIN_COUNT = 1;

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
  // v11.31: default tab flipped from 'regime' → 'aistate'. The system
  // is now state-driven (Guru = primary read), so the AI State view
  // is the validation surface. Pattern + Regime modes remain
  // available but are framed as legacy / context.
  const [mode,    setMode]    = useState<ResearchMode>('aistate');
  const [hovered, setHovered] = useState<Hovered | null>(null);
  // v17.2: field-context filter. 'all' keeps every record; the four
  // mood filters keep only records whose persisted fieldSignature
  // matches. Records without a signature (pre-v17.2 / manual Ask Guru)
  // never match a specific filter — see signatureMatchesFilter.
  const [contextFilter, setContextFilter] = useState<FieldContextFilter>('all');

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

  // ── v17.0: BY OPPORTUNITY — radar-native bucketing ──────────────
  // Replaces the v11.x "By Regime" tab. Each history record carries
  // an opportunityStatus (far / building / near / imminent / go) at
  // write time (v17+); older rows simply don't appear here. Forward
  // returns are reused from aiStateData so we don't walk candles twice.
  // The question this tab answers: do NEAR opportunities actually
  // turn into winners, or is that label just optics?

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
  //
  // v11.31 note: this ledger holds the POST-ANCHOR / POST-DECAY
  // classification (recorded in lib/useGcpState.ts after the v11.26.1
  // anchor pass). Research statistics here therefore reflect what the
  // user actually saw on the dashboard, not the raw Engine answer —
  // which is the canonical reading per the v11.31 spec.
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
      // v17.2: apply the field-context filter. Records whose persisted
      // fieldSignature doesn't match the active filter are skipped so
      // averages reflect the chosen context instead of being washed
      // out by mixing opportunity-window and defensive-market reads.
      if (!signatureMatchesFilter(rec.fieldSignature, contextFilter)) continue;
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
        opportunityStatus: rec.opportunityStatus,
        opportunityScore:  rec.opportunityScore,
      });
    }
    return { points, pendingByState, totalForSymbol, pendingTotal };
  }, [aiHistory, candles, candleSymbol, fwdBars, symbol, contextFilter]);

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

  // ── Transition data (v11.32) ────────────────────────────────────────────────
  // Walks aiHistory chronologically, identifies stateCode changes, and
  // computes forward returns from the new-state timestamp. CRITICAL:
  // aiHistory is the POST-ANCHOR / POST-DECAY ledger (v11.26.1+), so
  // transitions reflect what the user actually saw — not raw Engine
  // output. Same symbol-mismatch + candle-availability guards as
  // aiStateData.
  //
  // v11.33.1 fix: only points whose transitionKey is in
  // TRANSITION_META are returned. Unrecognized pairs (e.g. CS→AT,
  // DD→CS, IS→FA) used to stack at the y-axis edge because
  // xOfTransition fell back to PAD.l for missing keys. We now bucket
  // them as `otherCount` so the chart only renders the priority
  // columns and the total-label can show "X priority + Y other".
  const transitionData = useMemo(() => {
    const points: TransitionPoint[] = [];
    let otherCount = 0;
    if (!aiHistory.length || !candles.length) return { points, otherCount };
    if (candleSymbol && candleSymbol !== symbol) return { points, otherCount };

    // Filter to current symbol + context, then sort oldest → newest.
    // v17.2: the context filter applies BEFORE the transition pair is
    // identified — a CS→IS transition that happened during a defensive
    // market is excluded from the OPPORTUNITY filter, exactly as the
    // user expects ("CS→IS during opportunity windows").
    const ordered = aiHistory
      .filter(r => r.symbol === symbol
                && signatureMatchesFilter(r.fieldSignature, contextFilter))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (ordered.length < 2) return { points, otherCount };

    const lastIdx = candles.length - 1;
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      if (prev.stateCode === curr.stateCode) continue;   // not a transition

      // Find first candle at-or-after the new-state timestamp; entry
      // uses bar OPEN (or close fallback when open is bad).
      let entryIdx = -1;
      for (let k = 0; k < candles.length; k++) {
        if (candles[k].t >= curr.timestamp) { entryIdx = k; break; }
      }
      if (entryIdx === -1) continue;
      const entry = candles[entryIdx];
      const entryPrice = entry.o > 0 ? entry.o : entry.c;
      if (entryPrice <= 0) continue;
      const exitIdx = Math.min(entryIdx + fwdBars, lastIdx);
      if (exitIdx === entryIdx) continue;
      const exit = candles[exitIdx];
      if (!exit || exit.c <= 0) continue;

      const transitionKey = `${prev.stateCode}→${curr.stateCode}`;
      // v11.33.1: drop non-priority transitions from the scatter
      // (they have no x-column and were stacking at the left edge).
      if (!TRANSITION_META[transitionKey]) {
        otherCount++;
        continue;
      }

      const fwdPct = ((exit.c - entryPrice) / entryPrice) * 100;
      const next   = ordered[i + 1];
      // Stability: did the next analysis hold the same toCode?
      const stable = !!next && next.stateCode === curr.stateCode;

      points.push({
        kind:           'transition',
        fromCode:       prev.stateCode,
        toCode:         curr.stateCode,
        transitionKey,
        fwdPct:         +fwdPct.toFixed(3),
        t:              curr.timestamp,
        fromConfidence: prev.confidence,
        toConfidence:   curr.confidence,
        stable,
      });
    }
    return { points, otherCount };
  }, [aiHistory, candles, candleSymbol, fwdBars, symbol, contextFilter]);

  const transitionPoints = transitionData.points;

  const transitionStats = useMemo(() => {
    const map: Record<string, {
      pts:          TransitionPoint[];
      avg:          number;
      bull:         number;
      bear:         number;
      avgConf:      number;
      stableCount:  number;
      stability:    number;   // 0..1 — fraction of next-analysis-held
      reliability:  number;   // 0..100 — bullish% × |avgMove| × sample weight
      insufficient: boolean;
    }> = {};
    for (const key of Object.keys(TRANSITION_META)) {
      const pts = transitionPoints.filter(p => p.transitionKey === key);
      const n   = pts.length;
      const avg = n ? pts.reduce((s, p) => s + p.fwdPct, 0) / n : 0;
      const bull = pts.filter(p => p.fwdPct >  0.05).length;
      const bear = pts.filter(p => p.fwdPct < -0.05).length;
      const avgConf = n ? pts.reduce((s, p) => s + p.toConfidence, 0) / n : 0;
      const stableCount = pts.filter(p => p.stable).length;
      const stability   = n ? stableCount / n : 0;
      const bullishPct  = n ? bull / n : 0;
      // Reliability = bullishPct × min(1, |avg|/0.5) × sampleWeight
      // sampleWeight saturates at 20 occurrences.
      const sampleWeight = Math.min(1, n / 20);
      const moveScore    = Math.min(1, Math.abs(avg) / 0.5);
      const reliability  = +(bullishPct * moveScore * sampleWeight * 100).toFixed(1);
      map[key] = {
        pts, avg, bull, bear, avgConf,
        stableCount, stability, reliability,
        insufficient: n < TRANSITION_MIN_COUNT,
      };
    }
    return map;
  }, [transitionPoints]);

  // ── v17.3: Family-leadership points + stats ──────────────────────
  // For every aiHistory record that carries a fieldSignature (v17.2+),
  // compute its forward return and tag it with which family was
  // LEADING the field at scan time. The scatter then answers:
  // "When metals lead, what tends to happen to each symbol?"
  //
  // Note: filtered by symbol === current symbol per the global
  // convention. Use the SYMBOL FILTER toggle to see cross-symbol
  // texture; the sidebar still aggregates across all symbols (joined
  // separately so the per-symbol breakdown is meaningful even when
  // the user is sitting on a specific asset).
  const familyData = useMemo(() => {
    const symbolPoints: FamilyPoint[]    = [];   // current symbol only
    const allPoints:    FamilyPoint[]    = [];   // every symbol (sidebar)
    if (!aiHistory.length || !candles.length) return { symbolPoints, allPoints };
    if (candleSymbol && candleSymbol !== symbol) return { symbolPoints, allPoints };

    const lastIdx = candles.length - 1;
    for (const rec of aiHistory) {
      // v17.3: needs a field signature to know which family was leading.
      const sig = rec.fieldSignature;
      if (!sig) continue;
      if (!signatureMatchesFilter(sig, contextFilter)) continue;
      const leadFamily = sig.topFamily as MarketFamily;
      if (!FAMILY_META[leadFamily]) continue;

      // Forward-return computation. Mirrors aiStateData except we want
      // observations from EVERY symbol (not just current) so the
      // sidebar can show "When metals lead: gold +0.4%, BTC -0.2%".
      // For the scatter we only show the current symbol's dots —
      // looking at one asset at a time keeps the chart readable.
      let entryIdx = -1;
      // The current-symbol candle stream only covers the current
      // symbol. Other symbols' forward returns would need separate
      // candle fetches — out of scope here. So aggregate-side dots
      // for non-current symbols are dropped, and the sidebar carries
      // only current-symbol data too. Same trade-off as aiStateData.
      if (rec.symbol !== symbol) continue;
      for (let k = 0; k < candles.length; k++) {
        if (candles[k].t >= rec.timestamp) { entryIdx = k; break; }
      }
      if (entryIdx === -1) continue;
      const entry = candles[entryIdx];
      const entryPrice = entry.o > 0 ? entry.o : entry.c;
      if (entryPrice <= 0) continue;
      const exitIdx = Math.min(entryIdx + fwdBars, lastIdx);
      if (exitIdx === entryIdx) continue;
      const exit = candles[exitIdx];
      if (!exit || exit.c <= 0) continue;
      const fwdPct = ((exit.c - entryPrice) / entryPrice) * 100;
      const point: FamilyPoint = {
        kind:        'family',
        leadFamily,
        leadMood:    sig.topFamilyMood,
        symbol:      rec.symbol as MarketSymbol,
        symbolFamily: familyOf(rec.symbol as MarketSymbol),
        fwdPct:      +fwdPct.toFixed(3),
        t:           rec.timestamp,
        stateCode:   rec.stateCode,
      };
      symbolPoints.push(point);
      allPoints.push(point);
    }
    return { symbolPoints, allPoints };
  }, [aiHistory, candles, candleSymbol, fwdBars, symbol, contextFilter]);

  const familyPoints = familyData.symbolPoints;

  // Per-leading-family aggregate + symbol breakdown for the sidebar.
  const familyStats = useMemo(() => {
    const map: Record<MarketFamily, {
      pts:    FamilyPoint[];
      avg:    number;
      bull:   number;
      bear:   number;
      /** Per-symbol drilldown — symbol → { n, avg } sorted by |avg|. */
      bySymbol: Array<{ symbol: MarketSymbol; n: number; avg: number }>;
    }> = {
      metals: { pts: [], avg: 0, bull: 0, bear: 0, bySymbol: [] },
      crypto: { pts: [], avg: 0, bull: 0, bear: 0, bySymbol: [] },
      fx:     { pts: [], avg: 0, bull: 0, bear: 0, bySymbol: [] },
      risk:   { pts: [], avg: 0, bull: 0, bear: 0, bySymbol: [] },
    };
    for (const fam of FAMILY_ORDER) {
      const pts  = familyData.symbolPoints.filter(p => p.leadFamily === fam);
      const avg  = pts.length ? pts.reduce((s, p) => s + p.fwdPct, 0) / pts.length : 0;
      const bull = pts.filter(p => p.fwdPct >  0.05).length;
      const bear = pts.filter(p => p.fwdPct < -0.05).length;
      // Per-symbol aggregate within this leading-family bucket.
      const bySym: Record<string, { n: number; sum: number }> = {};
      for (const p of pts) {
        const k = p.symbol;
        if (!bySym[k]) bySym[k] = { n: 0, sum: 0 };
        bySym[k].n += 1;
        bySym[k].sum += p.fwdPct;
      }
      const bySymbol = Object.entries(bySym)
        .map(([sym, v]) => ({
          symbol: sym as MarketSymbol,
          n:      v.n,
          avg:    +(v.sum / v.n).toFixed(3),
        }))
        .sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
      map[fam] = { pts, avg, bull, bear, bySymbol };
    }
    return map;
  }, [familyData]);

  // ── v17.0: Opportunity points + stats ────────────────────────────
  // Derived from aiStatePoints — every aiStatePoint that carries an
  // opportunityStatus (v17+ writes do; older rows skip) becomes one
  // dot in the opportunity scatter, keyed by its bucket.
  const opportunityPoints = useMemo<OpportunityPoint[]>(() => {
    const out: OpportunityPoint[] = [];
    for (const p of aiStatePoints) {
      if (!p.opportunityStatus) continue;
      out.push({
        kind:      'opportunity',
        status:    p.opportunityStatus,
        score:     p.opportunityScore ?? 0,
        fwdPct:    p.fwdPct,
        t:         p.t,
        stateCode: p.stateCode,
      });
    }
    return out;
  }, [aiStatePoints]);

  const opportunityStats = useMemo(() => {
    const map: Record<string, {
      pts:    OpportunityPoint[];
      avg:    number;
      bull:   number;
      bear:   number;
      avgScore: number;
    }> = {};
    for (const key of OPPORTUNITY_ORDER) {
      const pts  = opportunityPoints.filter(p => p.status === key);
      const avg  = pts.length ? pts.reduce((s, p) => s + p.fwdPct, 0) / pts.length : 0;
      const bull = pts.filter(p => p.fwdPct >  0.05).length;
      const bear = pts.filter(p => p.fwdPct < -0.05).length;
      const avgScore = pts.length ? pts.reduce((s, p) => s + p.score, 0) / pts.length : 0;
      map[key] = { pts, avg, bull, bear, avgScore };
    }
    return map;
  }, [opportunityPoints]);

  // ── v17.4: Current resemblance ────────────────────────────────────
  // The active symbol's most-recent ledger entry is the anchor; we
  // hunt the rest of history (any symbol) for the closest matches and
  // attach forward returns from aiStatePoints when available. This is
  // the bridge from "what is happening right now" to "what happened
  // last time the system saw a read like this".
  const liveResemblance = useMemo(() => {
    if (aiHistory.length === 0) return null;
    // Most-recent record for the current symbol.
    let anchor: AiStateHistoryRecord | null = null;
    for (let i = aiHistory.length - 1; i >= 0; i--) {
      if (aiHistory[i].symbol === symbol) { anchor = aiHistory[i]; break; }
    }
    if (!anchor) return null;

    const matches = findLiveMatches(anchor, aiHistory, {
      // v17.4.3: limit=4 to show the full depth diversity
      // (1 today / 1 this-week / 2 older). Smaller numbers crowd out
      // the older analogues that carry the most information.
      limit:    4,
      minScore: 50,
      // Anchor is itself in history — exclude same-scan siblings only.
      // Keep the looser 60s window here (Research is the place to see
      // EVERY analogue including yesterday's); the radar uses the
      // stricter 4h default to suppress mirror reflections.
      excludeWithinMs: 60_000,
    });
    if (matches.length === 0) return { anchor, matches: [] as Array<LiveMatch & { fwdPct?: number }> };

    // Cross-reference each match against aiStatePoints (which carries
    // computed fwdPct) by exact timestamp. aiStatePoints is current-
    // symbol only — matches on OTHER symbols simply won't have an
    // outcome attached here; v17.5 will widen this with multi-symbol
    // candle fetch.
    const tsToFwd = new Map<number, number>();
    for (const p of aiStatePoints) tsToFwd.set(p.t, p.fwdPct);

    const enriched = matches.map(m => ({
      ...m,
      fwdPct: tsToFwd.get(m.record.timestamp),
    }));
    return { anchor, matches: enriched };
  }, [aiHistory, aiStatePoints, symbol]);

  // ── v17.0: Field Insight ──────────────────────────────────────────
  // One-sentence headline for the active tab — picks the category with
  // the strongest edge (|avg| × sample-strength) among those with at
  // least 10 observations. Anything below medium-confidence is noise
  // and gets suppressed. Replaces the v11 "No AI state history" slot
  // with actual evidence-backed copy when evidence exists.
  const fieldInsight = useMemo<{
    abbr:    string;
    label:   string;
    avg:     number;
    n:       number;
    bullPct: number;
    color:   string;
  } | null>(() => {
    type Row = {
      abbr: string; label: string; avg: number; n: number;
      bullPct: number; color: string;
    };
    const candidates: Row[] = [];
    if (mode === 'opportunity') {
      for (const k of OPPORTUNITY_ORDER) {
        const s = opportunityStats[k]; if (!s) continue;
        const n = s.pts.length;
        candidates.push({
          abbr:   OPPORTUNITY_META[k].abbr,
          label:  OPPORTUNITY_META[k].label,
          avg:    s.avg,  n,
          bullPct: n ? (s.bull / n) * 100 : 0,
          color:  OPPORTUNITY_META[k].color,
        });
      }
    } else if (mode === 'aistate') {
      for (const code of Object.keys(AI_STATE_META)) {
        const s = aiStateStats[code]; if (!s) continue;
        const n = s.pts.length;
        candidates.push({
          abbr:   AI_STATE_META[code].abbr,
          label:  AI_STATE_META[code].label,
          avg:    s.avg,  n,
          bullPct: n ? (s.bull / n) * 100 : 0,
          color:  AI_STATE_META[code].color,
        });
      }
    } else if (mode === 'transition') {
      for (const key of Object.keys(TRANSITION_META)) {
        const s = transitionStats[key]; if (!s) continue;
        const n = s.pts.length;
        candidates.push({
          abbr:   TRANSITION_META[key].abbr,
          label:  TRANSITION_META[key].label,
          avg:    s.avg,  n,
          bullPct: n ? (s.bull / n) * 100 : 0,
          color:  TRANSITION_META[key].color,
        });
      }
    } else if (mode === 'family') {
      for (const fam of FAMILY_ORDER) {
        const s = familyStats[fam]; if (!s) continue;
        const n = s.pts.length;
        candidates.push({
          abbr:   FAMILY_META[fam].abbr + ' lead',
          label:  `${FAMILY_LABEL[fam]} leading`,
          avg:    s.avg,  n,
          bullPct: n ? (s.bull / n) * 100 : 0,
          color:  FAMILY_META[fam].color,
        });
      }
    } else {
      for (const kind of Object.keys(PATTERN_META)) {
        const s = patternStats[kind]; if (!s) continue;
        const n = s.pts.length;
        candidates.push({
          abbr:   PATTERN_META[kind].abbr,
          label:  PATTERN_META[kind].label,
          avg:    s.avg,  n,
          bullPct: n ? (s.bull / n) * 100 : 0,
          color:  PATTERN_META[kind].color,
        });
      }
    }
    // Insufficient evidence — anything below MEDIUM is noise.
    const eligible = candidates.filter(c => c.n >= 10);
    if (eligible.length === 0) return null;
    // Score = |edge| weighted by sample strength (saturates at 30).
    eligible.sort((a, b) =>
      Math.abs(b.avg) * Math.min(b.n / 30, 1)
      - Math.abs(a.avg) * Math.min(a.n / 30, 1));
    return eligible[0];
  }, [mode, opportunityStats, aiStateStats, transitionStats, patternStats, familyStats]);

  // ── Geometry ────────────────────────────────────────────────────────────────
  // v11.25.3: side paddings equalised so the plot area sits visually
  // centered inside the main research panel (the right summary sidebar
  // is a separate sibling, so this svg lives in its own measured
  // container; symmetry is purely about the L/R inner margins). The
  // y-axis labels need ≈ 22 px to render "+2%" / "-2%" at fontSize 9,
  // so 48 px on each side keeps a comfortable margin without
  // off-center drift. Previously L was 56 / R was 24 and the column
  // bands clearly hugged the right edge.
  const PAD = { l: 48, r: 48, t: 24, b: 60 };
  const IW  = Math.max(80, W - PAD.l - PAD.r);
  const IH  = Math.max(80, H - PAD.t - PAD.b);

  const Y_MAX = 3, Y_MIN = -3;
  const yOf = (pct: number) =>
    PAD.t + (1 - (Math.max(Y_MIN, Math.min(Y_MAX, pct)) - Y_MIN) / (Y_MAX - Y_MIN)) * IH;

  const cols =
    mode === 'opportunity' ? OPPORTUNITY_COLS :
    mode === 'pattern'     ? PATTERN_COLS :
    mode === 'transition'  ? TRANSITION_COLS :
    mode === 'family'      ? FAMILY_COLS :
                             AI_STATE_COLS;

  const xOfOpportunity = (status: string) => {
    const meta = OPPORTUNITY_META[status];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / OPPORTUNITY_COLS) * IW;
  };
  const xOfFamily = (family: MarketFamily) => {
    const meta = FAMILY_META[family];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / FAMILY_COLS) * IW;
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
  const xOfTransition = (key: string) => {
    const meta = TRANSITION_META[key];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / TRANSITION_COLS) * IW;
  };
  type AnyPoint =
    OpportunityPoint | PatternPoint | AiStatePoint | TransitionPoint | FamilyPoint;
  const xOfPoint = (pt: AnyPoint): number =>
    pt.kind === 'opportunity' ? xOfOpportunity(pt.status)
  : pt.kind === 'pattern'     ? xOfPattern(pt.pattern)
  : pt.kind === 'transition'  ? xOfTransition(pt.transitionKey)
  : pt.kind === 'family'      ? xOfFamily(pt.leadFamily)
  :                             xOfAiState(pt.stateCode);

  const jitter = (i: number) => (Math.sin(i * 9301 + 49297) * 0.5) * (IW / cols) * 0.35;

  const visiblePoints: AnyPoint[] =
    mode === 'opportunity' ? opportunityPoints :
    mode === 'pattern'     ? patternPoints     :
    mode === 'transition'  ? transitionPoints  :
    mode === 'family'      ? familyPoints     :
                             aiStatePoints;
  const totalLabel =
    mode === 'opportunity' ? `${opportunityPoints.length} reads`         :
    mode === 'pattern'     ? `${patternPoints.length} occurrences`       :
    mode === 'family'      ? `${familyPoints.length} reads`              :
    mode === 'transition' ? (
      transitionData.otherCount > 0
        ? `${transitionPoints.length} priority · ${transitionData.otherCount} other`
        : `${transitionPoints.length} transitions`
    ) :
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
          {mode === 'opportunity' ? 'Opportunity Bucket → Forward Price' :
           mode === 'pattern'     ? 'GCP Pattern → Forward Price'         :
           mode === 'transition'  ? 'State Transition → Forward Price'    :
           mode === 'family'      ? 'Family Leadership → Forward Price'   :
                                    'AI State → Forward Price'}
        </span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-3)' }}>{symbol}</span>

        <div style={{ display: 'flex', gap: 1, marginLeft: 12 }}>
          {(['aistate', 'transition', 'opportunity', 'family', 'pattern'] as ResearchMode[]).map(m => (
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
              {m === 'opportunity' ? 'BY OPPORTUNITY' :
               m === 'pattern'     ? 'BY PATTERN'     :
               m === 'transition'  ? 'BY TRANSITION'  :
               m === 'family'      ? 'BY FAMILY'      :
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

      {/* v17.2: FIELD CONTEXT filter row. Filters the active research
          surface by the macro field conditions at scan-time. ALL keeps
          everything; the four mood filters restrict to records whose
          persisted fieldSignature matches. Pattern tab is unaffected
          (it derives from candles/series, not radar history). */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--line-0)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 9, flexShrink: 0,
        background: contextFilter === 'all' ? 'transparent' : 'rgba(77, 217, 232, 0.04)',
      }}>
        <span style={{
          color: 'var(--fg-4)', letterSpacing: '0.14em', fontWeight: 600,
        }}>
          FIELD CONTEXT
        </span>
        <div style={{ display: 'flex', gap: 1 }}>
          {(['all', 'opportunity', 'defensive', 'synchronized', 'fragmented'] as FieldContextFilter[])
            .map(f => (
              <button key={f}
                onClick={() => setContextFilter(f)}
                title={mode === 'pattern' ? 'Pattern tab is not field-context filtered' : undefined}
                style={{
                  padding: '2px 8px', fontSize: 9, letterSpacing: '0.08em',
                  fontFamily: 'var(--font-mono)',
                  background: contextFilter === f ? 'var(--bg-3)' : 'transparent',
                  border: `1px solid ${contextFilter === f ? 'var(--cyan)' : 'transparent'}`,
                  borderRadius: 2,
                  color: contextFilter === f ? 'var(--cyan)'
                       : mode === 'pattern' ? 'var(--fg-4)' : 'var(--fg-3)',
                  cursor: 'pointer',
                  opacity: mode === 'pattern' && f !== 'all' ? 0.45 : 1,
                }}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
        </div>
        {mode === 'pattern' && contextFilter !== 'all' && (
          <span style={{ color: 'var(--fg-4)', fontStyle: 'italic' }}>
            (pattern tab ignores context)
          </span>
        )}
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
          {/* v11.31: legacy banner. Pattern + Regime views predate the
              Guru / state-driven system and may not reflect what the
              user actually sees on the dashboard. AI State view is the
              canonical validation surface. */}
          {mode === 'pattern' && (
            <div style={{
              padding: '8px 16px',
              borderBottom: '1px solid var(--line-0)',
              background: 'rgba(212, 160, 40, 0.06)',
              fontSize: 10, color: '#d4a028', lineHeight: 1.5,
              display: 'flex', alignItems: 'baseline', gap: 8,
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 11 }}>⚠</span>
              <span>
                Pattern-based research is legacy and may not reflect current system behavior. Use{' '}
                <button
                  onClick={() => { setMode('aistate'); setHovered(null); }}
                  style={{
                    background: 'transparent', border: 'none',
                    color: '#d4a028', textDecoration: 'underline',
                    fontSize: 'inherit', fontFamily: 'inherit',
                    cursor: 'pointer', padding: 0,
                  }}
                >
                  By AI State
                </button>{' '}
                for the canonical (post-anchor) Guru validation view.
              </span>
            </div>
          )}

          <div style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--line-0)',
            fontSize: 9, lineHeight: 1.6, color: 'var(--fg-2)',
            flexShrink: 0,
          }}>
            <span style={{ color: 'var(--fg-0)', fontWeight: 600 }}>How to read this: </span>
            {mode === 'opportunity' && (
              <>
                Each dot = one radar / Guru read, colored by whether price went{' '}
                <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
                <span style={{ color: '#ef4444' }}>down ↓</span> over the next {FWD_LABEL[fwdBars]}.
                X-axis is the opportunity bucket (closeness to a GO) at the time of the read.{' '}
                <span style={{ color: '#d4a028' }}>
                  Validates the radar: do NEAR / IMMINENT reads actually outperform FAR ones?
                </span>
              </>
            )}
            {mode === 'family' && (
              <>
                Each dot = one radar read for <b>{symbol}</b>, colored by whether price went{' '}
                <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
                <span style={{ color: '#ef4444' }}>down ↓</span> over the next {FWD_LABEL[fwdBars]}.
                X-axis is which family was LEADING the coherence field at the time of the read.{' '}
                <span style={{ color: '#d4a028' }}>
                  Coherence rotation: when metals lead, does this symbol benefit or fade?
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
            {mode === 'transition' && (
              <>
                <span style={{ color: 'var(--cyan)' }}>Guru is a state machine.</span>{' '}
                This view measures how environments evolve — not just isolated states.
                Each dot = one state-change event from your post-anchor history;
                forward price is measured from the new-state timestamp over the next {FWD_LABEL[fwdBars]}.{' '}
                <span style={{ color: '#d4a028' }}>
                  CS → IS positive = compression-to-ignition transitions historically precede upward moves.
                </span>
              </>
            )}
            {mode === 'aistate' && (
              <>
                Each dot = one manual AI analysis, colored by whether price went{' '}
                <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
                <span style={{ color: '#ef4444' }}>down ↓</span> in the {FWD_LABEL[fwdBars]} after the
                AI State was reported. Positive averages mean that state historically preceded upward moves.
                {' '}
                <span style={{ color: 'var(--cyan)' }}>
                  Research validates what Guru actually reported after anchoring and post-processing — not raw Engine outputs.
                </span>{' '}
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
                {/* v11.25.3: dev-only layout debug. Faint cyan outlines
                    the plot area; faint grey outlines the container.
                    Surfaces L/R margin asymmetry at a glance. Hidden in
                    production via the NODE_ENV gate; remove the gate
                    locally to inspect when tuning padding. */}
                {process.env.NODE_ENV !== 'production' && (
                  <>
                    <rect
                      x={0.5} y={0.5}
                      width={Math.max(0, W - 1)} height={Math.max(0, H - 1)}
                      fill="none" stroke="#1c2026" strokeWidth={1}
                      strokeDasharray="2 4"
                    />
                    <rect
                      x={PAD.l} y={PAD.t}
                      width={IW} height={IH}
                      fill="none" stroke="rgba(77,217,232,0.18)" strokeWidth={1}
                    />
                  </>
                )}
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

                {Object.entries(
                  mode === 'opportunity' ? OPPORTUNITY_META :
                  mode === 'pattern'     ? PATTERN_META     :
                  mode === 'transition'  ? TRANSITION_META  :
                  mode === 'family'      ? FAMILY_META      :
                                           AI_STATE_META
                ).map(([k, meta]) => {
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

                {mode === 'opportunity' && Object.entries(opportunityStats).map(([k, s]) => {
                  if (s.pts.length < 3) return null;
                  const cx  = xOfOpportunity(k);
                  const y   = yOf(s.avg);
                  const col = OPPORTUNITY_META[k]?.color ?? '#fff';
                  return (
                    <g key={k}>
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

                {mode === 'family' && Object.entries(familyStats).map(([k, s]) => {
                  if (s.pts.length < 3) return null;
                  const fam = k as MarketFamily;
                  const cx  = xOfFamily(fam);
                  const y   = yOf(s.avg);
                  const col = FAMILY_META[fam].color;
                  return (
                    <g key={k}>
                      <line x1={cx - 20} x2={cx + 20} y1={y} y2={y} stroke={col} strokeWidth={2} />
                      <text x={cx} y={y - 6} textAnchor="middle" fontSize={8} fill={col}
                        fontFamily="IBM Plex Mono, monospace">
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </text>
                    </g>
                  );
                })}

                {mode === 'transition' && Object.entries(transitionStats).map(([key, s]) => {
                  if (s.pts.length < 2) return null;
                  const cx  = xOfTransition(key);
                  const y   = yOf(s.avg);
                  const col = TRANSITION_META[key]?.color ?? '#fff';
                  return (
                    <g key={key}>
                      <line x1={cx - 16} x2={cx + 16} y1={y} y2={y} stroke={col} strokeWidth={2} />
                      <text x={cx} y={y - 6} textAnchor="middle" fontSize={8} fill={col}
                        fontFamily="IBM Plex Mono, monospace">
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </text>
                    </g>
                  );
                })}

                {mode === 'opportunity' && Object.entries(OPPORTUNITY_META).map(([k, meta]) => (
                  <g key={k}>
                    <text
                      x={xOfOpportunity(k)}
                      y={H - PAD.b + 16}
                      textAnchor="middle"
                      fontSize={10} fill={meta.color} fontWeight={600}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.abbr}
                    </text>
                    <text
                      x={xOfOpportunity(k)}
                      y={H - PAD.b + 28}
                      textAnchor="middle"
                      fontSize={7} fill="#2a2f37"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.label}
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

                {mode === 'transition' && Object.entries(TRANSITION_META).map(([key, meta]) => (
                  <g key={key}>
                    <text
                      x={xOfTransition(key)}
                      y={H - PAD.b + 16}
                      textAnchor="middle"
                      fontSize={9} fill={meta.color} fontWeight={600}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.abbr}
                    </text>
                  </g>
                ))}

                {mode === 'family' && Object.entries(FAMILY_META).map(([k, meta]) => (
                  <g key={k}>
                    <text
                      x={xOfFamily(k as MarketFamily)}
                      y={H - PAD.b + 16}
                      textAnchor="middle"
                      fontSize={10} fill={meta.color} fontWeight={600}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {meta.abbr}
                    </text>
                    <text
                      x={xOfFamily(k as MarketFamily)}
                      y={H - PAD.b + 28}
                      textAnchor="middle"
                      fontSize={8} fill="#2a2f37"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      leading
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
                  {hovered.kind === 'opportunity' && (
                    <>
                      <div style={{ color: OPPORTUNITY_META[hovered.status]?.color, marginBottom: 3 }}>
                        {OPPORTUNITY_META[hovered.status]?.label} · {hovered.stateCode}
                      </div>
                      <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                        {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                        opp score {hovered.score}%
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
                  {hovered.kind === 'family' && (
                    <>
                      <div style={{ color: FAMILY_META[hovered.leadFamily].color, marginBottom: 3 }}>
                        {FAMILY_LABEL[hovered.leadFamily]} leading · {hovered.symbol}
                      </div>
                      <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                        {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                        {hovered.stateCode} · mood {hovered.leadMood}
                      </div>
                      <div style={{ color: 'var(--fg-4)' }}>
                        {new Date(hovered.t).toLocaleDateString()} {new Date(hovered.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                      </div>
                    </>
                  )}
                  {hovered.kind === 'transition' && (
                    <>
                      <div style={{ color: TRANSITION_META[hovered.transitionKey]?.color ?? 'var(--fg-1)', marginBottom: 3 }}>
                        {hovered.fromCode} → {hovered.toCode}
                      </div>
                      <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                        {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                      </div>
                      <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                        Conf {(hovered.toConfidence * 100).toFixed(0)}%
                        {hovered.stable ? ' · held next' : ''}
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
                {mode === 'opportunity' ? 'OPPORTUNITY SUMMARY' :
                 mode === 'pattern'     ? 'PATTERN SUMMARY'     :
                 mode === 'transition'  ? 'TRANSITION SUMMARY'  :
                 mode === 'family'      ? 'FAMILY LEADERSHIP'   :
                                          'AI STATE SUMMARY'}
              </div>

              {/* v17.4: CURRENT RESEMBLANCE — the active symbol's
                  most-recent read vs. the rest of history. Outcomes
                  attach only for current-symbol matches today; cross-
                  symbol outcomes are coming with v17.5's multi-symbol
                  candle fetch. */}
              {liveResemblance && liveResemblance.matches.length > 0 && (() => {
                const withOutcome = liveResemblance.matches.filter(m => m.fwdPct != null);
                const avgOutcome = withOutcome.length
                  ? withOutcome.reduce((s, m) => s + (m.fwdPct ?? 0), 0) / withOutcome.length
                  : null;
                return (
                  <div style={{
                    marginBottom: 14, padding: '10px 12px',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line-1)',
                    borderLeft: '2px solid var(--cyan)',
                    borderRadius: 3,
                  }}>
                    <div style={{
                      fontSize: 8, letterSpacing: '0.16em', fontWeight: 700,
                      color: 'var(--fg-4)', marginBottom: 6,
                    }}>
                      CURRENT RESEMBLANCE
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--fg-3)', marginBottom: 6 }}>
                      {symbol} ·{' '}
                      <b style={{ color: 'var(--fg-1)' }}>
                        {liveResemblance.anchor.stateCode}
                      </b>{' '}
                      · {liveResemblance.anchor.phase} ·{' '}
                      {(liveResemblance.anchor.confidence * 100).toFixed(0)}% clarity
                    </div>
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}>
                      {liveResemblance.matches.map((m) => {
                        const d = new Date(m.record.timestamp);
                        const dateStr = d.toLocaleDateString(undefined,
                          { month: 'short', day: 'numeric' });
                        const fwdColor =
                            m.fwdPct == null      ? 'var(--fg-4)'
                          : m.fwdPct >  0.05      ? '#22c55e'
                          : m.fwdPct < -0.05      ? '#ef4444'
                          :                          'var(--fg-3)';
                        // v17.4.2: depth tag — older analogues stand
                        // out (amber); recent reads stay muted.
                        const depthLabel =
                            m.depth === 'today'     ? 'today'
                          : m.depth === 'this-week' ? 'this wk'
                          :                            'older';
                        const depthColor =
                            m.depth === 'older' ? '#d4a028' : 'var(--fg-4)';
                        return (
                          <div key={m.record.id} style={{
                            display: 'flex', flexDirection: 'column', gap: 1,
                            fontFamily: 'IBM Plex Mono, monospace', fontSize: 9,
                          }}>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between',
                              alignItems: 'baseline',
                            }}>
                              <span style={{ color: 'var(--fg-2)' }}>
                                {dateStr} <span style={{ color: 'var(--fg-4)' }}>
                                  {m.record.symbol}
                                </span>{' '}
                                <span style={{
                                  fontSize: 7, color: depthColor,
                                  letterSpacing: '0.1em', fontWeight: 700,
                                }}>
                                  · {depthLabel.toUpperCase()}
                                </span>
                              </span>
                              <span style={{
                                color: 'var(--cyan)', fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                              }}>{m.similarity}%</span>
                            </div>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between',
                              fontSize: 8, color: 'var(--fg-4)',
                            }}>
                              <span>{m.matchedOn.slice(0, 3).join(' · ')}</span>
                              <span style={{
                                color: fwdColor,
                                fontVariantNumeric: 'tabular-nums',
                              }}>
                                {m.fwdPct == null ? 'n/a'
                                  : `${m.fwdPct > 0 ? '+' : ''}${m.fwdPct.toFixed(2)}%`}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {avgOutcome != null && (
                      <div style={{
                        fontSize: 9, color: 'var(--fg-3)', marginTop: 6,
                        paddingTop: 6, borderTop: '1px solid var(--line-0)',
                      }}>
                        Avg outcome{' '}
                        <b style={{
                          color: avgOutcome > 0.05 ? '#22c55e'
                               : avgOutcome < -0.05 ? '#ef4444'
                               : 'var(--fg-2)',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {avgOutcome > 0 ? '+' : ''}{avgOutcome.toFixed(2)}%
                        </b>{' '}
                        <span style={{ color: 'var(--fg-4)' }}>
                          (n={withOutcome.length})
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* v17.0: FIELD INSIGHT — surfaces the strongest evidence-
                  backed finding for the current tab. Only renders when
                  at least one category has n ≥ 10 (medium sample) so
                  we don't quote anecdote as insight. */}
              {fieldInsight && (
                <div style={{
                  marginBottom: 14, padding: '10px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  borderLeft: `2px solid ${fieldInsight.color}`,
                  borderRadius: 3,
                }}>
                  <div style={{
                    fontSize: 8, letterSpacing: '0.16em', fontWeight: 700,
                    color: 'var(--fg-4)', marginBottom: 6,
                  }}>
                    FIELD INSIGHT
                  </div>
                  <div style={{
                    fontSize: 10, color: 'var(--fg-1)', lineHeight: 1.5,
                  }}>
                    Historically{' '}
                    <b style={{ color: fieldInsight.color }}>{fieldInsight.abbr}</b>{' '}
                    {mode === 'transition' ? 'transitions'
                      : mode === 'pattern' ? 'patterns'
                      : 'reads'}{' '}
                    {/* v17.2: filter context phrase. ALL → "globally";
                        others → "during opportunity windows" etc. */}
                    <span style={{ color: contextFilter === 'all' ? 'var(--fg-4)' : 'var(--cyan)' }}>
                      {FILTER_PHRASE[contextFilter]}
                    </span>{' '}
                    averaged{' '}
                    <b style={{
                      color: fieldInsight.avg > 0 ? '#22c55e'
                           : fieldInsight.avg < 0 ? '#ef4444'
                           : 'var(--fg-3)',
                    }}>
                      {fieldInsight.avg > 0 ? '+' : ''}{fieldInsight.avg.toFixed(2)}%
                    </b>{' '}
                    over {FWD_LABEL[fwdBars]} ({fieldInsight.bullPct.toFixed(0)}% positive,
                    n={fieldInsight.n}).
                  </div>
                </div>
              )}

              {mode === 'opportunity' && opportunityPoints.length === 0 && (
                <div style={{
                  padding: '14px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  borderRadius: 4,
                  fontSize: 10, color: '#7F98A3', lineHeight: 1.55,
                }}>
                  <div style={{ color: 'var(--fg-1)', fontWeight: 600, marginBottom: 6, fontSize: 11 }}>
                    No opportunity history yet.
                  </div>
                  Run a radar scan or Ask Guru to collect reads — opportunity buckets are persisted on every classification.
                </div>
              )}

              {mode === 'opportunity' && opportunityPoints.length > 0
                && OPPORTUNITY_ORDER.map((k) => {
                const meta = OPPORTUNITY_META[k];
                const s    = opportunityStats[k];
                if (!s) return null;
                const total = s.pts.length;
                const bullPct = total ? (s.bull / total * 100) : 0;
                const sc = sampleConfidence(total);
                return (
                  <div key={k} style={{
                    marginBottom: 12, paddingBottom: 12,
                    borderBottom: '1px solid var(--line-0)',
                    opacity: total === 0 ? 0.45 : 1,
                  }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      marginBottom: 4, alignItems: 'baseline',
                    }}>
                      <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>
                        {meta.abbr}
                      </span>
                      <span style={{
                        fontSize: 11, fontVariantNumeric: 'tabular-nums',
                        color: total === 0
                          ? 'var(--fg-4)'
                          : s.avg > 0.05 ? '#22c55e'
                          : s.avg < -0.05 ? '#ef4444'
                          : 'var(--fg-3)',
                      }}>
                        {total === 0 ? '—' : `${s.avg > 0 ? '+' : ''}${s.avg.toFixed(2)}%`}
                      </span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--fg-4)', marginBottom: 3 }}>
                      {meta.label} · {total} reads
                      {total > 0 && ` · avg score ${s.avgScore.toFixed(0)}%`}
                    </div>
                    {total > 0 && (
                      <div style={{ display: 'flex', gap: 6, fontSize: 8, marginBottom: 4 }}>
                        <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                        <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                        <span style={{ color: 'var(--fg-4)' }}>
                          {bullPct.toFixed(0)}% bull
                        </span>
                        <span style={{
                          fontSize: 7, fontWeight: 700, letterSpacing: '0.1em',
                          padding: '0 4px', borderRadius: 2,
                          color: SAMPLE_COLOR[sc],
                          border: `1px solid ${SAMPLE_COLOR[sc]}55`,
                          background: `${SAMPLE_COLOR[sc]}11`,
                          marginLeft: 'auto',
                        }}>{sc}</span>
                      </div>
                    )}
                    {total > 0 && (
                      <div style={{
                        height: 3, background: '#ef4444',
                        borderRadius: 1, overflow: 'hidden',
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
                    <div style={{ display: 'flex', gap: 6, fontSize: 8, color: 'var(--fg-4)', marginBottom: 4, alignItems: 'center' }}>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span>{bullPct.toFixed(0)}% bullish</span>
                      <span style={{ marginLeft: 'auto' }}>
                        <SampleBadge n={s.pts.length} />
                      </span>
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
                  Click <b>Ask Guru</b> or run a <b>radar scan</b> — both feed this surface (v17+).
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
                    <div style={{ display: 'flex', gap: 6, fontSize: 8, color: 'var(--fg-4)', marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span>{bullPct.toFixed(0)}% bullish</span>
                      <span style={{ marginLeft: 'auto' }}>
                        <SampleBadge n={s.pts.length} />
                      </span>
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

              {/* v11.32: transition sidebar — one card per priority
                  transition. Cards show count, bullish %, avg move,
                  avg confidence, plus a stability bar (fraction of
                  next-analysis-held) and a reliability score. */}
              {mode === 'transition' && transitionPoints.length === 0 && (
                <div style={{
                  padding: '14px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  borderRadius: 4,
                  fontSize: 10, color: '#7F98A3', lineHeight: 1.55,
                }}>
                  <div style={{ color: 'var(--fg-1)', fontWeight: 600, marginBottom: 6, fontSize: 11 }}>
                    {transitionData.otherCount > 0
                      ? 'No priority transitions yet.'
                      : 'No transitions captured yet.'}
                  </div>
                  {transitionData.otherCount > 0
                    ? `${transitionData.otherCount} other state changes recorded but they don't fall into the priority compression / shock / discharge ladder shown here.`
                    : 'Run more Guru analyses on this symbol — transitions appear once the state changes between successive runs.'}
                </div>
              )}

              {/* v17.1: transitions sorted by reliability descending so
                  the strongest evidence-backed pairs appear first. Cards
                  with no observations sink to the bottom (rendered with
                  reduced opacity as placeholders) so the user knows
                  which priority pairs are still being collected. */}
              {mode === 'transition' && transitionPoints.length > 0
                && Object.entries(TRANSITION_META)
                  .map(([key, meta]) => ({
                    key, meta,
                    stats: transitionStats[key],
                  }))
                  .sort((a, b) => {
                    const an = a.stats?.pts.length ?? 0;
                    const bn = b.stats?.pts.length ?? 0;
                    if ((an === 0) !== (bn === 0)) return an === 0 ? 1 : -1;
                    const ar = a.stats?.reliability ?? 0;
                    const br = b.stats?.reliability ?? 0;
                    return br - ar;
                  })
                  .map(({ key, meta, stats }) => {
                const s = stats;
                if (!s) return null;
                const n = s.pts.length;
                if (n === 0) {
                  return (
                    <div key={key} style={{
                      marginBottom: 8, paddingBottom: 8, opacity: 0.4,
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
                const winPct  = (s.bull / n) * 100;
                const stableW = Math.round(s.stability * 100);
                const avgCol  =
                    s.avg >  0.05 ? '#22c55e'
                  : s.avg < -0.05 ? '#ef4444'
                  :                  'var(--fg-3)';
                return (
                  <div key={key} style={{
                    marginBottom: 12, paddingBottom: 12,
                    borderBottom: '1px solid var(--line-0)',
                  }}>
                    {/* Header — ABBR + average return */}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      marginBottom: 3, alignItems: 'baseline',
                    }}>
                      <span style={{ color: meta.color, fontSize: 11, fontWeight: 700 }}>
                        {meta.abbr}
                      </span>
                      <span style={{
                        fontSize: 12, fontWeight: 700, color: avgCol,
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--fg-4)', marginBottom: 5 }}>
                      {meta.label} · {n} transition{n === 1 ? '' : 's'}
                    </div>
                    {/* v17.1: stat row — WIN / CONF / STAB as labelled
                        mini-stats so the user can compare across cards
                        without parsing the chip soup. */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: 4, marginBottom: 6,
                    }}>
                      <Stat label="WIN"  value={`${winPct.toFixed(0)}%`}
                        color={winPct >= 60 ? '#22c55e' : winPct <= 40 ? '#ef4444' : 'var(--fg-2)'} />
                      <Stat label="CONF" value={`${(s.avgConf * 100).toFixed(0)}%`}
                        color="var(--fg-2)" />
                      <Stat label="STAB" value={`${stableW}%`}
                        color={stableW >= 60 ? '#4dd9e8' : 'var(--fg-2)'} />
                    </div>
                    <div style={{
                      display: 'flex', gap: 6, fontSize: 8,
                      color: 'var(--fg-4)', marginBottom: 4,
                      alignItems: 'center',
                    }}>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span>reliability {s.reliability.toFixed(0)}</span>
                      <span style={{ marginLeft: 'auto' }}>
                        <SampleBadge n={n} />
                      </span>
                    </div>
                    <div style={{ height: 3, background: '#ef4444', borderRadius: 1, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#22c55e', width: `${winPct}%`, borderRadius: 1 }} />
                    </div>
                  </div>
                );
              })}

              {/* v17.3: Family Leadership cards. One per leading
                  family, each with a per-symbol breakdown showing how
                  individual assets behaved during that family's lead.
                  Empty state appears when no observations carry a
                  fieldSignature yet (v17.2+ scans only). */}
              {mode === 'family' && familyPoints.length === 0 && (
                <div style={{
                  padding: '14px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  borderRadius: 4,
                  fontSize: 10, color: '#7F98A3', lineHeight: 1.55,
                }}>
                  <div style={{ color: 'var(--fg-1)', fontWeight: 600, marginBottom: 6, fontSize: 11 }}>
                    No family-context history yet.
                  </div>
                  Family Leadership uses the field signature stored on
                  every radar scan (v17.2+). Run a scan to start
                  collecting — older records without a signature don't
                  appear here.
                </div>
              )}

              {mode === 'family' && familyPoints.length > 0
                && FAMILY_ORDER
                  .filter(fam => familyStats[fam].pts.length > 0)
                  .sort((a, b) => familyStats[b].pts.length - familyStats[a].pts.length)
                  .map(fam => {
                const meta = FAMILY_META[fam];
                const s    = familyStats[fam];
                const n    = s.pts.length;
                const winPct = n ? (s.bull / n) * 100 : 0;
                const avgCol =
                    s.avg >  0.05 ? '#22c55e'
                  : s.avg < -0.05 ? '#ef4444'
                  :                  'var(--fg-3)';
                return (
                  <div key={fam} style={{
                    marginBottom: 14, paddingBottom: 12,
                    borderBottom: '1px solid var(--line-0)',
                  }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      marginBottom: 3, alignItems: 'baseline',
                    }}>
                      <span style={{ color: meta.color, fontSize: 11, fontWeight: 700 }}>
                        {meta.abbr} leading
                      </span>
                      <span style={{
                        fontSize: 12, fontWeight: 700, color: avgCol,
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--fg-4)', marginBottom: 5 }}>
                      {n} read{n === 1 ? '' : 's'} for {symbol} · {winPct.toFixed(0)}% bullish
                    </div>
                    <div style={{
                      display: 'flex', gap: 6, fontSize: 8,
                      color: 'var(--fg-4)', marginBottom: 6,
                      alignItems: 'center',
                    }}>
                      <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                      <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                      <span style={{ marginLeft: 'auto' }}>
                        <SampleBadge n={n} />
                      </span>
                    </div>
                    <div style={{ height: 3, background: '#ef4444', borderRadius: 1, overflow: 'hidden', marginBottom: 8 }}>
                      <div style={{ height: '100%', background: '#22c55e', width: `${winPct}%`, borderRadius: 1 }} />
                    </div>
                    {/* Per-symbol breakdown — "When metals lead: gold +0.4%,
                        silver +0.7%, BTC -0.2%". Listed in order of
                        |avg| so the biggest movers (positive or
                        negative) show first. Filtered to the current
                        symbol's family-mates would be cleaner but the
                        spec wants ALL symbols visible. */}
                    {s.bySymbol.length > 0 && (
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: 2,
                        marginTop: 2,
                      }}>
                        {s.bySymbol.slice(0, 5).map(row => (
                          <div key={row.symbol} style={{
                            display: 'flex', justifyContent: 'space-between',
                            fontSize: 9, fontFamily: 'IBM Plex Mono, monospace',
                            color: 'var(--fg-3)',
                          }}>
                            <span>
                              {row.symbol}
                              <span style={{ color: 'var(--fg-4)', marginLeft: 4 }}>
                                ×{row.n}
                              </span>
                            </span>
                            <span style={{
                              color: row.avg > 0.05 ? '#22c55e'
                                   : row.avg < -0.05 ? '#ef4444'
                                   : 'var(--fg-3)',
                              fontVariantNumeric: 'tabular-nums',
                            }}>
                              {row.avg > 0 ? '+' : ''}{row.avg.toFixed(2)}%
                            </span>
                          </div>
                        ))}
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
                {mode === 'opportunity' ? 'reads' :
                 mode === 'pattern'     ? 'occurrences' :
                 mode === 'transition'  ? 'transitions' :
                 mode === 'family'      ? 'reads' :
                                          'analyses'} with positive outcome.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// v17.1: labelled mini-stat used in the transition cards. Sits in a
// 3-column grid (WIN / CONF / STAB) so the user can compare across
// cards without parsing chip soup. Centered, monospace, very small —
// the color is the only thing that pops.
function Stat({ label, value, color }: {
  label: string; value: string; color: string;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '3px 0',
      background: 'var(--bg-2)',
      border: '1px solid var(--line-0)',
      borderRadius: 2,
    }}>
      <span style={{
        fontSize: 7, letterSpacing: '0.14em', color: 'var(--fg-4)',
        fontFamily: 'IBM Plex Mono, monospace', fontWeight: 700,
      }}>{label}</span>
      <span style={{
        fontSize: 11, fontWeight: 700, color,
        fontVariantNumeric: 'tabular-nums',
        fontFamily: 'IBM Plex Mono, monospace',
      }}>{value}</span>
    </div>
  );
}

// v17.0: tiny reliability chip used across every Research card.
// Reads are LOW (< 10), MEDIUM (10-29), HIGH (30+) — anything labelled
// LOW should be treated as anecdote, not evidence.
function SampleBadge({ n }: { n: number }) {
  const sc = sampleConfidence(n);
  return (
    <span style={{
      fontSize: 7, fontWeight: 700, letterSpacing: '0.1em',
      padding: '0 4px', borderRadius: 2,
      color: SAMPLE_COLOR[sc],
      border: `1px solid ${SAMPLE_COLOR[sc]}55`,
      background: `${SAMPLE_COLOR[sc]}11`,
      fontFamily: 'IBM Plex Mono, monospace',
    }}>{sc}</span>
  );
}
