'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { buildSeries, detectPatterns, processSeries } from '@/lib/gcp-data';
import { useGCPData } from '@/lib/useGCPData';
import { useGoldData } from '@/lib/useGoldData';
import { usePSSAlert } from '@/lib/usePSSAlert';
import { useMobile } from '@/lib/useMobile';
import MobileApp from './mobile/MobileApp';
import {
  loadSensitivity, SENSITIVITY_THRESHOLDS, SENSITIVITY_LABEL,
  type Sensitivity,
} from '@/lib/sensitivity';
import { useGcpState } from '@/lib/useGcpState';
import { useStableAiState } from '@/lib/aiState';
import type { GcpStateInputs } from '@/lib/gcp-state-payload';
import { windowMetrics } from '@/lib/energy';
import { PATTERN_CODE, REGIME_NAME, regimeForValue } from '@/lib/patterns-meta';
import Chrome from './Chrome';
import Dashboard from './Dashboard';
import PatternDetail from './PatternDetail';
import SettingsPanel from './SettingsPanel';
import ChartView from './ChartView';
import ResearchView from './ResearchView';
import TradingView from './TradingView';
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

  // Sensitivity: drives detector thresholds (v11.2+) and is shown in the
  // status bar. Persisted to gcpro-settings.sensitivity. Re-read on the
  // browser `storage` event so changes propagate across tabs and from
  // SettingsPanel without a full reload.
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

  // v11.14: Engine AI state classification. Inputs assembled from the
  // existing live data; useGcpState polls /api/gcp-state on a 25 s
  // cadence with overlapping-request prevention. Result held but NOT
  // displayed yet -- v11.15 will surface it on the Dashboard.
  const aiStateInputs = useMemo<GcpStateInputs | null>(() => {
    if (!baseSeries.length) return null;
    const last = baseSeries[baseSeries.length - 1];
    if (!last) return null;

    // Recent series tail (per spec: last 50-100 points). 100 keeps
    // enough context for the Engine to see a real window without
    // bloating the request body.
    const tail = baseSeries.slice(-100).map(p => ({ t: p.t, v: p.v }));
    if (tail.length < 10) return null; // engine validates >= 10

    // Energy metrics computed locally so the Engine sees the same
    // numbers the chart / detector see. Window covers the recent slice.
    const slice = tail.map(p => p.v);
    const m     = windowMetrics(slice);

    const regimeCode = last.r ?? regimeForValue(last.v);
    const regimeName = REGIME_NAME[regimeCode] ?? '';

    const recentPatterns = displayPatterns.slice(-3).map(p => ({
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

    return {
      symbol,
      timeframe,
      series:  tail,
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
      windowMinutes:  100,
    };
  }, [
    baseSeries[baseSeries.length - 1]?.t,
    baseSeries.length,
    symbol,
    timeframe,
    goldData.changePct,
    displayPatterns.length,
  ]);

  // v11.14b: connection meta is surfaced into Settings so the user can
  // see whether the Engine proxy chain is healthy.
  // v11.15: classification is also stabilised (only re-emits on
  // stateCode/phase change or >5% confidence delta) and threaded into
  // the header badge + Dashboard card so it becomes the primary
  // interpretation layer.
  const aiState     = useGcpState(aiStateInputs);
  const stableState = useStableAiState(aiState.state);

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
          {page === 'trading' && (
            <TradingView
              symbol={symbol}
              timeframe={timeframe}
            />
          )}
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
        sensitivityLabel={SENSITIVITY_LABEL[sensitivity]}
      />
    </div>
  );
}
