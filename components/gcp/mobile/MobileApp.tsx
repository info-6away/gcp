'use client';

import { useState, useEffect } from 'react';
import { BottomNav, type MobilePage } from './MobileChrome';
import { DashboardScreen } from './screens/DashboardScreen';
import { ChartScreen }     from './screens/ChartScreen';
import { PatternsScreen }  from './screens/PatternsScreen';
import { ResearchScreen }  from './screens/ResearchScreen';
import { SettingsScreen }  from './screens/SettingsScreen';
import type { DataPoint, Pattern, MarketSymbol } from '@/types/gcp';
import type { GCPDataState } from '@/lib/useGCPData';
import type { GoldState } from '@/lib/useGoldData';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiAnalysisInterval } from '@/lib/aiAnalysisInterval';
import type { StructureRead } from '@/lib/priceStructure';

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
  aiState:         GcpStateResponse | null;
  aiEnabled:       boolean;
  aiLastSuccess:   Date | null;
  aiLastError:     Date | null;
  aiNextPollAt:    Date | null;
  aiIntervalSec:   AiAnalysisInterval;
  aiInflight:      boolean;
  aiRunNow:        () => void;
  planStructure:   StructureRead;
}

export default function MobileApp({
  gcpData, baseSeries, displayPatterns, goldData, symbol, setSymbol,
  aiState, aiEnabled, aiLastSuccess, aiLastError, aiNextPollAt,
  aiIntervalSec, aiInflight, aiRunNow, planStructure,
}: MobileAppProps) {
  const [page, setPage] = useState<MobilePage>('dashboard');
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
  };

  const screen = (() => {
    switch (page) {
      case 'dashboard': return (
        <DashboardScreen {...shared}
          series={baseSeries} patterns={displayPatterns}
          symbol={symbol} price={goldData.price}
          onSymbolPress={cycleSymbol}
          aiRunNow={aiRunNow}
          aiInflight={aiInflight}
          aiLastSuccess={aiLastSuccess}
          planStructure={planStructure}
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
          aiNextPollAt={aiNextPollAt}
          aiIntervalSec={aiIntervalSec}
          aiInflight={aiInflight}
          aiRunNow={aiRunNow}
          gcpLastUpdate={gcpData.lastUpdate}
          gcpNextPollAt={gcpData.nextPollAt}
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
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {screen}
      </div>
      <BottomNav active={page} onNav={setPage} />
    </div>
  );
}
