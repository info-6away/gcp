'use client';

import { useState, useEffect, useMemo } from 'react';
import { BottomNav, type MobilePage } from './MobileChrome';
import { MobileDrawer } from './MobileDrawer';
import { DashboardScreen } from './screens/DashboardScreen';
import { GuruScreen }      from './screens/GuruScreen';
import { ChartScreen }     from './screens/ChartScreen';
import { PatternsScreen }  from './screens/PatternsScreen';
import { ResearchScreen }  from './screens/ResearchScreen';
import { SettingsScreen }  from './screens/SettingsScreen';
import { TradeScreen }     from './screens/TradeScreen';
import type { DataPoint, Pattern, MarketSymbol, Timeframe } from '@/types/gcp';
import type { GCPDataState } from '@/lib/useGCPData';
import type { GoldState } from '@/lib/useGoldData';
import type { GcpStateResponse, ClassifyErrorEnvelope } from '@/lib/engine-gcp';
import type { AiAnalysisInterval } from '@/lib/aiAnalysisInterval';
import type { AiStatus } from '@/lib/useGcpState';
import type { StructureRead } from '@/lib/priceStructure';
import type { Candle } from '@/lib/fetchCandles';
import type { GcpQuality } from '@/lib/alignGcp';
import { derivePosture } from '@/lib/aiAction';
import { deriveTradePlan } from '@/lib/tradePlan';
import { AI_ANALYSIS_TF } from '@/lib/aiTimeframe';

const PREFS_LS_KEY = 'gcpro-settings';
const DEFAULT_PREFS: Record<string, boolean> = {
  pssAlerts:          true,
  showNewsFeed:       true,
  showPatternMarkers: true,
  showRegimeBands:    true,
};

function loadPrefs(): Record<string, boolean> {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_LS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface MobileAppProps {
  gcpData:         GCPDataState;
  baseSeries:      DataPoint[];
  displayPatterns: Pattern[];
  goldData:        GoldState;
  symbol:          MarketSymbol;
  setSymbol:       (s: MarketSymbol) => void;
  // v11.35: chart timeframe lives in GCPApp, threaded through here
  // so the new mobile drawer can flip it from the menu.
  timeframe:       Timeframe;
  setTimeframe:    (tf: Timeframe) => void;
  aiState:         GcpStateResponse | null;
  aiEnabled:       boolean;
  aiLastSuccess:   Date | null;
  aiLastError:     Date | null;
  // v12.0.3: structured envelope of the last proxy failure.
  aiLastErrorEnvelope?: ClassifyErrorEnvelope | null;
  aiNextPollAt:    Date | null;
  aiIntervalSec:   AiAnalysisInterval;
  aiStatus:        AiStatus;
  aiRunNow:        (options?: { force?: boolean; source?: string }) => void;
  planStructure:   StructureRead;
  planAnalysisCandle: Candle | null;
  gcpQuality:      GcpQuality;
}

export default function MobileApp({
  gcpData, baseSeries, displayPatterns, goldData, symbol, setSymbol,
  timeframe, setTimeframe,
  aiState, aiEnabled, aiLastSuccess, aiLastError, aiLastErrorEnvelope = null, aiNextPollAt,
  aiIntervalSec, aiStatus, aiRunNow, planStructure, planAnalysisCandle,
  gcpQuality,
}: MobileAppProps) {
  const [page, setPage]       = useState<MobilePage>('dashboard');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settings, setSettings] = useState<Record<string, boolean>>(DEFAULT_PREFS);

  useEffect(() => { setSettings(loadPrefs()); }, []);

  const updateSetting = (k: string, v: boolean) => {
    const next = { ...settings, [k]: v };
    setSettings(next);
    try { window.localStorage.setItem(PREFS_LS_KEY, JSON.stringify(next)); } catch {}
  };

  const cycleSymbol = () => {
    const order: MarketSymbol[] = ['XAUUSD', 'BTC', 'XAGUSD'];
    const i = order.indexOf(symbol);
    setSymbol(order[(i + 1) % order.length]);
  };

  const shared = {
    liveNV:     gcpData.liveNetvar,
    liveRegime: gcpData.liveRegime,
    connected:  gcpData.isLive && !gcpData.gcpError,
    aiState,
    aiEnabled,
    aiStatus,
  };

  // v11.35: posture + tradePlan derived locally (same inputs the
  // desktop GCPApp uses) so the mobile Trade screen has the full
  // execution context.
  const latestPattern = displayPatterns[displayPatterns.length - 1] ?? null;
  const posture = useMemo(
    () => derivePosture(aiState, latestPattern),
    [aiState, latestPattern],
  );
  const tradePlan = useMemo(() => {
    if (!aiState || !planStructure) return null;
    return deriveTradePlan({
      state:          aiState,
      structure:      planStructure,
      latestPattern,
      symbol,
      analysisCandle: planAnalysisCandle,
      analysisTf:     AI_ANALYSIS_TF,
      currentPrice:   goldData.price,
    });
  }, [aiState, planStructure, latestPattern, symbol, planAnalysisCandle, goldData.price]);

  const openMenu = () => setDrawerOpen(true);

  const screen = (() => {
    switch (page) {
      case 'dashboard': return (
        <DashboardScreen {...shared}
          series={baseSeries} patterns={displayPatterns}
          symbol={symbol} price={goldData.price}
          onSymbolPress={cycleSymbol}
          aiRunNow={aiRunNow}
          aiStatus={aiStatus}
          aiLastSuccess={aiLastSuccess}
          planStructure={planStructure}
          planAnalysisCandle={planAnalysisCandle}
        />
      );
      case 'guru': return (
        <GuruScreen
          symbol={symbol}
          price={goldData.price}
          liveNV={shared.liveNV}
          liveRegime={shared.liveRegime}
          connected={shared.connected}
          aiState={aiState}
          aiEnabled={aiEnabled}
          aiStatus={aiStatus}
          aiRunNow={aiRunNow}
          aiLastSuccess={aiLastSuccess}
          latestPattern={latestPattern}
          planStructure={planStructure}
          planAnalysisCandle={planAnalysisCandle}
        />
      );
      case 'trading': return (
        <TradeScreen
          symbol={symbol}
          timeframe={timeframe}
          price={goldData.price}
          liveNV={shared.liveNV}
          liveRegime={shared.liveRegime}
          connected={shared.connected}
          aiState={aiState}
          aiEnabled={aiEnabled}
          aiStatus={aiStatus}
          posture={posture}
          latestPattern={latestPattern}
          tradePlan={tradePlan}
          netVariance={baseSeries[baseSeries.length - 1]?.v ?? null}
        />
      );
      case 'chart': return (
        <ChartScreen {...shared}
          series={baseSeries} patterns={displayPatterns}
          symbol={symbol} price={goldData.price}
          onSymbolPress={cycleSymbol}
        />
      );
      case 'pattern': return (
        <PatternsScreen {...shared} patterns={displayPatterns} />
      );
      case 'research': return (
        <ResearchScreen {...shared}
          series={baseSeries}
          patterns={displayPatterns}
        />
      );
      case 'settings': return (
        <SettingsScreen {...shared}
          settings={settings} updateSetting={updateSetting}
          seriesLength={baseSeries.length}
          aiLastSuccess={aiLastSuccess}
          aiLastError={aiLastError}
          aiLastErrorEnvelope={aiLastErrorEnvelope}
          aiNextPollAt={aiNextPollAt}
          aiIntervalSec={aiIntervalSec}
          aiStatus={aiStatus}
          aiRunNow={aiRunNow}
          gcpLastUpdate={gcpData.lastUpdate}
          gcpNextPollAt={gcpData.nextPollAt}
          gcpQuality={gcpQuality}
        />
      );
    }
  })();

  return (
    <div style={{
      width: '100%', height: '100dvh',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      background: '#07080a',
      position: 'relative',
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {screen}
      </div>

      {/* v11.35: floating menu button at top-right. Positioned over
          the screen chrome so we don't have to thread an onOpenMenu
          prop through every <MobileStatus> caller. The bottom nav
          gets aria precedence; this is just a context-actions
          escape hatch. */}
      <button
        onClick={openMenu}
        aria-label="Open menu"
        style={{
          position: 'absolute', top: 8, right: 10, zIndex: 50,
          background: 'rgba(13,15,18,0.85)',
          border: '1px solid #1c2026',
          color: '#aeb4bf',
          padding: '4px 7px',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(2px)',
        }}
      >
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
          <path d="M2 4 H14 M2 8 H14 M2 12 H14"
            stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
      </button>

      <BottomNav active={page} onNav={setPage} aiLastSuccess={aiLastSuccess} />
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onNav={setPage}
        symbol={symbol}
        setSymbol={setSymbol}
        timeframe={timeframe}
        setTimeframe={setTimeframe}
      />
    </div>
  );
}
