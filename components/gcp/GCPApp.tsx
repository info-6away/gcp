'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { buildSeries, detectPatterns, processSeries } from '@/lib/gcp-data';
import { useGCPData } from '@/lib/useGCPData';
import { useGoldData } from '@/lib/useGoldData';
import { usePSSAlert } from '@/lib/usePSSAlert';
import { useMobile } from '@/lib/useMobile';
import MobileApp from './mobile/MobileApp';
import {
  loadSensitivity, SENSITIVITY_THRESHOLDS,
  type Sensitivity,
} from '@/lib/sensitivity';
import { useGcpState } from '@/lib/useGcpState';
import { useStableAiState } from '@/lib/aiState';
import type { GcpStateInputs } from '@/lib/gcp-state-payload';
import { buildTimeframeContext, AI_ANALYSIS_TF } from '@/lib/aiTimeframe';
import { useRecentCandles } from '@/lib/useRecentCandles';
import { readPriceStructure } from '@/lib/priceStructure';
import { computeGcpQuality, type GcpQuality } from '@/lib/alignGcp';
import { windowMetrics } from '@/lib/energy';
import { PATTERN_CODE, REGIME_NAME, regimeForValue } from '@/lib/patterns-meta';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import GuruView from './GuruView';
import PatternDetail from './PatternDetail';
import SettingsPanel from './SettingsPanel';
import ChartView from './ChartView';
import ResearchView from './ResearchView';
import TradingView from './TradingView';
import TradePanel from './TradePanel';
import { derivePosture } from '@/lib/aiAction';
import { deriveTradePlan } from '@/lib/tradePlan';
import { useAiPlanMemory } from '@/lib/useAiPlanMemory';
import { buildPlanSnapshot, buildPriorPlanContext } from '@/lib/aiPlanMemory';
import { derivePatternStory } from '@/lib/patternStory';
import type { CursorInfo, MarketSymbol, Timeframe, ViewWindow, AppPage } from '@/types/gcp';
import { formatPrice, TIMEFRAME_BARS, VIEW_MINUTES } from '@/types/gcp';

const PREFS_LS_KEY = 'gcpro-settings';

function readPssAlertsPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(PREFS_LS_KEY);
    if (!raw) return true;
    const obj = JSON.parse(raw);
    return obj.pssAlerts ?? true;
  } catch {
    return true;
  }
}

export default function GCPApp() {
  const [page, setPage] = useState<AppPage>('dashboard');
  const [live, setLive] = useState(true);
  const [selectedPatternKind, setSelectedPatternKind] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<MarketSymbol>('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [viewWindow, setViewWindow] = useState<ViewWindow>('24h');

  const gcpData = useGCPData();
  const {
    series: liveBaseSeries,
    liveNetvar,
    gcpLoading,
    gcpError,
    isLive: gcpIsLive,
    scaleFactor: gcpScaleFactor,
  } = gcpData;

  const fallbackSeries = useMemo(() => buildSeries().series, []);
  const baseSeries = liveBaseSeries.length > 0 ? liveBaseSeries : fallbackSeries;

  const [cursor, setCursor] = useState(0);
  const didInitCursor = useRef(false);
  useEffect(() => {
    if (baseSeries.length > 0 && !didInitCursor.current) {
      setCursor(baseSeries.length - 1);
      didInitCursor.current = true;
    }
  }, [baseSeries.length]);

  const goldData = useGoldData(symbol);
  const isMobile = useMobile();

  // Sensitivity: drives detector thresholds (v11.2+). v11.24.4 removed
  // the user-facing LOW / MEDIUM / HIGH control — defaults to 'medium'
  // and stays there for normal users. The localStorage hook still
  // reads gcpro-settings.sensitivity so a hidden dev override (set via
  // browser console) keeps working without exposing the dial in the UI.
  const [sensitivity, setSensitivity] = useState<Sensitivity>('medium');
  useEffect(() => {
    setSensitivity(loadSensitivity());
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'gcpro-settings') setSensitivity(loadSensitivity());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const sensitivityThresholds = SENSITIVITY_THRESHOLDS[sensitivity];

  // Dashboard is GCP-only. Price overlay lives on the Chart tab now;
  // ChartView consumes candleData directly so we don't need to merge
  // gold/BTC closes into the GCP series anymore.
  const windowedSeries = useMemo(() => {
    const mins = VIEW_MINUTES[viewWindow];
    const sliced = !Number.isFinite(mins) ? baseSeries : baseSeries.slice(-mins);
    return [...sliced].sort((a, b) => a.t - b.t);
  }, [baseSeries, viewWindow]);

  const { displaySeries, analysisSeries } = useMemo(() => {
    const bars = TIMEFRAME_BARS[timeframe];
    const { display, analysis } = processSeries(windowedSeries, bars);
    return { displaySeries: display, analysisSeries: analysis };
  }, [windowedSeries, timeframe]);

  // Pattern detection runs on the raw 1-minute windowedSeries. The
  // Compression Coil and Alignment Ladder algorithms are calibrated for
  // 1 m resolution (e.g. Compression Coil needs 80 sustained A/B bars =
  // 80 minutes); running them on TF-bucketed analysisSeries (24 h at
  // 15 m = 96 bars) starves the detector and yields zero patterns.
  const displayPatterns = useMemo(
    () => detectPatterns(windowedSeries, 1, sensitivityThresholds),
    [windowedSeries, sensitivityThresholds]
  );

  useEffect(() => {
    setCursor(displaySeries.length - 1);
  }, [timeframe, displaySeries.length]);

  // PSS Alert: browser notification when a new high-PSS pattern arrives.
  const [alertEnabled, setAlertEnabled] = useState<boolean>(true);
  useEffect(() => {
    setAlertEnabled(readPssAlertsPref());
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_LS_KEY) setAlertEnabled(readPssAlertsPref());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const [pssFlash, setPssFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Alert-freshness window scales with the active TF: tighter on 1m so
  // a single missed minute doesn't count as historical, looser on 5m and
  // above where each bar covers more wall-clock time.
  const alertRecentWindowMs = (() => {
    switch (timeframe) {
      case '1m': return 3  * 60_000;
      case '5m': return 10 * 60_000;
      default:   return 10 * 60_000;
    }
  })();

  const { testAlert } = usePSSAlert(
    displayPatterns,
    displaySeries,
    alertEnabled,
    () => {
      setPssFlash(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setPssFlash(false), 3_000);
    },
    alertRecentWindowMs,
  );

  // v11.23.1: GCP feed quality — recomputed on a slow 30 s cadence so
  // the age / gap counts in Settings stay fresh without a re-render
  // every minute when baseSeries changes. Used by both Settings
  // diagnostics and the AI payload's gcpQuality field.
  const [qualityNonce, setQualityNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQualityNonce(n => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const gcpQuality: GcpQuality = useMemo(
    () => computeGcpQuality(baseSeries),
    // qualityNonce in deps so the memo refreshes time-dependent values
    // (lastUpdateAgeSec) even when baseSeries hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseSeries, qualityNonce],
  );

  // v11.14: Engine AI state classification. Inputs assembled from the
  // existing live data; useGcpState polls /api/gcp-state on a 25 s
  // cadence with overlapping-request prevention. Result held but NOT
  // displayed yet -- v11.15 will surface it on the Dashboard.
  // v11.18.6: minimal payload at the source. Earlier the inputs sent
  // 100 series points and 3 patterns AND explicitly passed
  // windowMinutes: 100 — which overrode the payload builder's v11.18.4
  // default of 15 and defeated the trim. Now: 15 points slice, 1
  // pattern slice, and no windowMinutes override (let the builder
  // apply its own 15-point default). Energy metrics still derive from
  // the full local series so we don't degrade slope/curvature/PSS
  // accuracy — only the payload sent to the Engine is small.

  // v11.25: AI plan memory + lifecycle. Hoisted above aiStateInputs
  // so the engine payload can carry a compact priorPlan context based
  // on whatever the saved plan currently says (waiting / triggered /
  // invalidated / expired). Runs evaluation against goldData.price on
  // every tick and persists transitions back to localStorage.
  const planMemory      = useAiPlanMemory(symbol, AI_ANALYSIS_TF, goldData.price ?? null);
  const planMemoryPlan       = planMemory.plan;
  const planMemoryPlanId     = planMemoryPlan?.id;
  const planMemoryPlanStatus = planMemoryPlan?.status;

  const aiStateInputs = useMemo<GcpStateInputs | null>(() => {
    if (!baseSeries.length) return null;
    const last = baseSeries[baseSeries.length - 1];
    if (!last) return null;

    // Energy metrics computed over a generous local window so the
    // numbers stay stable / accurate. Engine receives the metric
    // results, not the window itself.
    const metricsWindow = baseSeries.slice(-100).map(p => p.v);
    if (metricsWindow.length < 10) return null;
    const m = windowMetrics(metricsWindow);

    // Engine-bound series tail: just enough to recognise local shape.
    // Builder also slices to 15, but trimming here means the inputs
    // object stays small in memory + cheaper to serialize.
    const engineTail = baseSeries.slice(-15).map(p => ({ t: p.t, v: p.v }));
    if (engineTail.length < 10) return null;

    const regimeCode = last.r ?? regimeForValue(last.v);
    const regimeName = REGIME_NAME[regimeCode] ?? '';

    // Most-recent pattern only — older patterns rarely change the
    // classification and inflated the payload by 2-3x previously.
    const recentPatterns = displayPatterns.slice(-1).map(p => ({
      patternCode: p.patternCode ?? PATTERN_CODE[p.kind] ?? '',
      patternName: p.patternName ?? p.kind,
      tStart:      p.tStart,
      confidence:  p.confidence ?? p.strength,
      pss:         p.pss,
    }));

    // Coarse short-term trend label from goldData.changePct. Engine
    // owns the actual interpretation; we just hand it a tag.
    const cp = goldData.changePct;
    const trend: 'up' | 'down' | 'sideways' | 'unknown' =
      cp == null ?  'unknown' :
      cp >  0.10 ?  'up'      :
      cp < -0.10 ?  'down'    :
                    'sideways';

    // v11.26: build the compact pattern story from the SAME visible /
    // resolved patterns the user sees in the dashboard pattern card +
    // Patterns tab. The Engine receives this as a cross-check signal
    // — it should not contradict the local interpretation unless
    // price/GCP metrics clearly justify doing so. Cost: 6 small
    // fields (~50-80 tokens). Skipped when no patterns are present
    // so the Engine never sees a stale "No dominant story" tag.
    //
    // Note: aiState is intentionally omitted here. stableState is
    // declared below this useMemo (it depends on aiStateInputs); a
    // forward reference would hit a TDZ. The bias field falls back
    // to 'neutral' for direction-aware states without that input —
    // acceptable for the cross-check signal.
    const story = derivePatternStory({
      patterns: displayPatterns,
      regime:   regimeCode,
    });
    const compactStory = displayPatterns.length > 0 ? {
      seq:     story.sequence,
      state:   story.state,
      bias:    story.bias,
      cycle:   story.activeCycle,
      dom:     story.dominantPattern
        ? (PATTERN_CODE[story.dominantPattern] ?? undefined)
        : undefined,
      posture: story.posture,
    } : undefined;

    return {
      symbol,
      timeframe,
      series:  engineTail,
      metrics: {
        slope:                m.slope,
        curvature:            m.curvature,
        ced:                  m.ced,
        compressionDuration:  m.compressionDuration,
        oscillationTightness: m.oscillationTightness,
        pss:                  m.pss,
      },
      regime:         { code: regimeCode, name: regimeName },
      recentPatterns,
      goldContext:    { trend },
      // v11.18.6: do NOT set windowMinutes — let the payload builder's
      // own 15-point default apply. Setting it here was overriding the
      // trim and shipping 100-point payloads.
      // v11.20: spot price at analysis time, used ONLY for the local
      // AI history ledger. Not forwarded to the Engine.
      priceAtAnalysis: goldData.price,
      // v11.21: timeframe context — what time scale the user has on
      // the chart vs what the AI is analysing. Locked to 15m / 1h
      // for now per spec; switcher comes later.
      timeframeContext: buildTimeframeContext(timeframe),
      // v11.23.1: GCP feed quality — stale / age / gap stats. Engine
      // can use this to lower confidence; UI surfaces it in Settings.
      gcpQuality,
      // v11.25: prior-plan context (compact). Reads the latest saved
      // plan for this (symbol, AI tf) and tells the Engine where the
      // last cycle ended up — waiting / triggered / invalidated /
      // expired — so the next analysis can avoid repeating itself.
      // Built fresh on every change to current price / saved plan.
      priorPlan: planMemoryPlan
        ? buildPriorPlanContext(planMemoryPlan, goldData.price ?? null)
        : undefined,
      // v11.26: compact pattern story (lib/patternStory). Forwarded
      // as a cross-check signal so the Engine's classification can
      // align with the same local pattern interpretation the user
      // sees on the Patterns tab.
      patternStory: compactStory,
    };
  }, [
    baseSeries[baseSeries.length - 1]?.t,
    baseSeries.length,
    symbol,
    timeframe,
    goldData.changePct,
    planMemoryPlanId,
    planMemoryPlanStatus,
    displayPatterns.length,
    displayPatterns[displayPatterns.length - 1]?.id,
    goldData.price,
    gcpQuality,
  ]);

  // v11.14b: connection meta is surfaced into Settings so the user can
  // see whether the Engine proxy chain is healthy.
  // v11.15: classification is also stabilised (only re-emits on
  // stateCode/phase change or >5% confidence delta) and threaded into
  // the header badge + Dashboard card so it becomes the primary
  // interpretation layer.
  const aiState     = useGcpState(aiStateInputs);
  const stableState = useStableAiState(aiState.state);

  // v11.22: Trade Plan candles. Structure is read on the AI's analysis
  // timeframe (15 m) so the plan and the AI signal are scaled the same
  // way. 50 candles ≈ 12 h of context — plenty to spot HH/HL or LH/LL
  // swings without a heavy fetch.
  const planCandles       = useRecentCandles(symbol, AI_ANALYSIS_TF, 50);
  const planStructure     = useMemo(() => readPriceStructure(planCandles), [planCandles]);
  // v11.22.1: anchor the trade plan to the most recent candle's OHLC
  // and surface the current live price for distance-from-analysis.
  const planAnalysisCandle = planCandles.length ? planCandles[planCandles.length - 1] : null;

  // Latest pattern + trade plan, kept at top level so both the
  // dashboard card and the plan-memory snapshot logic see the same
  // derivation.
  const latestPattern = displayPatterns[displayPatterns.length - 1] ?? null;
  const tradePlan = useMemo(() => {
    if (!stableState || !planStructure) return null;
    return deriveTradePlan({
      state:          stableState,
      structure:      planStructure,
      latestPattern,
      symbol,
      analysisCandle: planAnalysisCandle,
      analysisTf:     AI_ANALYSIS_TF,
      currentPrice:   goldData.price,
    });
  }, [stableState, planStructure, latestPattern, symbol, planAnalysisCandle, goldData.price]);

  // Snapshot save on AI success. Watching aiState.lastSuccessAt as a
  // primitive dep means this fires once per successful classification
  // (and not on every render). Skips when a triggered plan is still
  // active so the management view doesn't reset every time the user
  // re-runs analysis on top of an in-flight setup.
  useEffect(() => {
    if (!aiState.lastSuccessAt) return;
    if (!stableState || !tradePlan) return;
    const prior = planMemory.plan;
    if (prior && prior.status === 'triggered') {
      // Triggered + still active: keep the saved plan; the new
      // analysis just feeds priorPlan context to the engine on the
      // NEXT run.
      return;
    }
    const snap = buildPlanSnapshot({
      symbol,
      timeframe:    AI_ANALYSIS_TF,
      state:        stableState,
      plan:         tradePlan,
      currentPrice: goldData.price,
    });
    planMemory.saveSnapshot(snap);
    // Intentionally narrow deps — only react to a new success
    // timestamp. Re-running on every tradePlan or stableState delta
    // would clobber the saved snapshot mid-cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiState.lastSuccessAt]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      setCursor(c => {
        const maxI = displaySeries.length - 1;
        const minI = Math.floor(maxI * 0.25);
        const next = c + 1;
        return next > maxI ? minI : next;
      });
    }, 500);
    return () => clearInterval(id);
  }, [live, displaySeries.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      if (e.key === 'd') setPage('dashboard');
      if (e.key === 'g') setPage('guru');
      if (e.key === 'p') { setSelectedPatternKind(null); setPage('pattern'); }
      if (e.key === 'c') setPage('chart');
      if (e.key === 'r') setPage('research');
      if (e.key === 't') setPage('trading');
      if (e.key === 's') setPage('settings');
      if (e.key === ' ') { e.preventDefault(); setLive(l => !l); }
      if (e.key === 'ArrowLeft') setCursor(c => Math.max(0, c - 10));
      if (e.key === 'ArrowRight') setCursor(c => Math.min(displaySeries.length - 1, c + 10));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [displaySeries.length]);

  const effectiveCursor = Math.min(
    Math.max(0, cursor),
    Math.max(0, displaySeries.length - 1),
  );
  const cursorS = displaySeries[effectiveCursor] || displaySeries[0];
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date(cursorS.t);
  const cursorInfo: CursorInfo = {
    i: effectiveCursor,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
    v: cursorS.v.toFixed(1),
    r: cursorS.r,
    g: goldData.price
      ? `${formatPrice(goldData.price, symbol)} (live)`
      : '—',
  };

  const handleNav = (p: AppPage) => {
    if (p === 'pattern') setSelectedPatternKind(null);
    setPage(p);
  };

  const lastDataDate = useMemo(() => {
    if (!baseSeries.length) return null;
    return new Date(baseSeries[baseSeries.length - 1].t)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }, [baseSeries]);

  if (gcpLoading) {
    return (
      <div className="app">
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100vh', flexDirection: 'column', gap: 16,
        }}>
          <div style={{ color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.15em' }}>
            GCP PRO
          </div>
          <div style={{ color: 'var(--fg-2)', fontSize: 11, letterSpacing: '0.1em' }}>
            LOADING COHERENCE DATA…
          </div>
          <div style={{
            width: 200, height: 2, background: 'var(--bg-3)',
            borderRadius: 1, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', width: '40%',
              background: 'var(--cyan)',
              animation: 'scanline 1.2s ease-in-out infinite',
            }} />
          </div>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileApp
        gcpData={gcpData}
        baseSeries={baseSeries}
        displayPatterns={displayPatterns}
        goldData={goldData}
        symbol={symbol}
        setSymbol={setSymbol}
        aiState={stableState}
        aiEnabled={aiState.enabled}
        aiLastSuccess={aiState.lastSuccessAt}
        aiLastError={aiState.lastErrorAt}
        aiNextPollAt={aiState.nextPollAt}
        aiIntervalSec={aiState.intervalSec}
        aiStatus={aiState.aiStatus}
        aiRunNow={aiState.runNow}
        planStructure={planStructure}
        planAnalysisCandle={planAnalysisCandle}
        gcpQuality={gcpQuality}
      />
    );
  }

  return (
    <div className="app">
      <Chrome.Header
        page={page}
        onNav={handleNav}
        live={live}
        onToggleLive={() => setLive(l => !l)}
        symbol={symbol}
        onSymbolChange={setSymbol}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        viewWindow={viewWindow}
        onViewWindowChange={setViewWindow}
        goldPrice={goldData.price}
        goldLoading={goldData.loading}
        goldMarketStatus={goldData.marketStatus}
        goldSessionDate={null}
        goldSource={goldData.source}
        gcpLive={gcpIsLive}
        gcpNetvar={liveNetvar}
        gcpError={!!gcpError}
        aiState={stableState}
        aiEnabled={aiState.enabled}
        aiStatus={aiState.aiStatus}
      />
      <div className="app-body">
        <Chrome.LeftRail page={page} onNav={handleNav} lastDataDate={lastDataDate} />
        <main className="main">
          {page === 'dashboard' && (
            <Dashboard
              gcpData={gcpData}
              series={baseSeries}
              patterns={displayPatterns}
              symbol={symbol}
              symbolPrice={goldData.price}
              pssFlash={pssFlash}
              aiState={stableState}
              aiEnabled={aiState.enabled}
              aiRunNow={aiState.runNow}
              aiStatus={aiState.aiStatus}
              aiLastSuccess={aiState.lastSuccessAt}
              planStructure={planStructure}
              planAnalysisCandle={planAnalysisCandle}
              onNav={handleNav}
            />
          )}
          {page === 'guru' && (
            <GuruView
              symbol={symbol}
              symbolPrice={goldData.price}
              aiState={stableState}
              aiEnabled={aiState.enabled}
              aiStatus={aiState.aiStatus}
              aiRunNow={aiState.runNow}
              aiLastSuccess={aiState.lastSuccessAt}
              latestPattern={latestPattern}
              planStructure={planStructure}
              planAnalysisCandle={planAnalysisCandle}
            />
          )}
          {page === 'pattern' && (
            <PatternDetail
              kind={selectedPatternKind}
              series={displaySeries}
              patterns={displayPatterns}
              symbol={symbol}
              timeframe={timeframe}
              onBack={() => setPage('dashboard')}
              onNavToCursor={(i) => { setCursor(i); setPage('chart'); }}
              aiState={stableState}
              regime={baseSeries[baseSeries.length - 1]?.r ?? null}
              pss={latestPattern?.pss ?? latestPattern?.strength ?? null}
            />
          )}
          {page === 'chart' && (
            <ChartView
              series={baseSeries}
              patterns={displayPatterns}
              symbol={symbol}
              timeframe={timeframe}
              sensitivityThresholds={sensitivityThresholds}
              livePrice={goldData.price}
              livePriceTime={goldData.lastFetch}
            />
          )}
          {page === 'research' && (
            <ResearchView
              series={baseSeries}
              symbol={symbol}
            />
          )}
          {page === 'trading' && (() => {
            // v11.24: paper-trading layer. Live price, AI posture,
            // pattern, and trade plan are computed here so the panel
            // can snapshot the full context the moment the user opens
            // a trade. Pure local — no broker, no orders.
            // v11.33: TRD → TRADE rework. Layout is now top: chart,
            // bottom: 3-column TRADE module (Entry / Active / Guru).
            // The chart preserves the technical view; the TRADE
            // module sits below as the execution surface.
            const posture  = derivePosture(stableState, latestPattern);
            const lastBase = baseSeries[baseSeries.length - 1] ?? null;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                <div style={{ flex: '1 1 55%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <TradingView
                    symbol={symbol}
                    timeframe={timeframe}
                  />
                </div>
                <div style={{ flex: '1 1 45%', minHeight: 0, borderTop: '1px solid var(--line-1)' }}>
                  <TradePanel
                    symbol={symbol}
                    timeframe={timeframe}
                    currentPrice={goldData.price}
                    aiState={stableState}
                    posture={posture}
                    latestPattern={latestPattern}
                    tradePlan={tradePlan}
                    regime={lastBase?.r ?? null}
                    netVariance={lastBase?.v ?? null}
                  />
                </div>
              </div>
            );
          })()}
          {page === 'settings' && (
            <SettingsPanel
              gcpLive={gcpIsLive}
              gcpNetvar={liveNetvar}
              gcpScale={gcpScaleFactor}
              gcpLastUpdate={gcpData.lastUpdate}
              gcpNextPollAt={gcpData.nextPollAt}
              goldStatus={goldData.marketStatus}
              goldPrice={goldData.price}
              goldSource={goldData.source}
              symbol={symbol}
              timeframe={timeframe}
              seriesLength={displaySeries.length}
              historicalPoints={baseSeries.length}
              aiEnabled={aiState.enabled}
              aiState={aiState.state}
              aiLastSuccess={aiState.lastSuccessAt}
              aiLastError={aiState.lastErrorAt}
              aiNextPollAt={aiState.nextPollAt}
              aiIntervalSec={aiState.intervalSec}
              aiStatus={aiState.aiStatus}
              aiRunNow={aiState.runNow}
              gcpQuality={gcpQuality}
              onTestAlert={testAlert}
            />
          )}
        </main>
      </div>
      <Chrome.StatusBar
        cursorInfo={cursorInfo}
        series={displaySeries}
        symbol={symbol}
        timeframe={timeframe}
      />
    </div>
  );
}
