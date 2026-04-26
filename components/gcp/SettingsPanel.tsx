'use client';

import { useEffect, useState } from 'react';
import { APP_VERSION, APP_MODEL } from '@/lib/version';
import { PageHeader } from '@/components/gcp/Chrome';
import { PSS_THRESHOLD } from '@/lib/usePSSAlert';
import type { MarketSymbol, Timeframe } from '@/types/gcp';

interface SettingsPanelProps {
  gcpLive:          boolean;
  gcpNetvar:        number | null;
  gcpScale:         number | null;
  goldStatus:       string;
  goldPrice:        number | null;
  goldSource:       string | null;
  symbol:           MarketSymbol;
  timeframe:        Timeframe;
  seriesLength:     number;
  historicalPoints: number;
  onTestAlert:      () => void | Promise<void>;
}

const PREFS_LS_KEY = 'gcpro-settings';

interface Prefs {
  showRegimeBands:    boolean;
  showPatternMarkers: boolean;
  showNewsFeed:       boolean;
  pssAlerts:          boolean;
}

const DEFAULT_PREFS: Prefs = {
  showRegimeBands:    true,
  showPatternMarkers: true,
  showNewsFeed:       true,
  pssAlerts:          true,
};

function loadPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_LS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 7, height: 7, borderRadius: '50%',
      background: ok ? 'var(--green)' : 'var(--red)',
      marginRight: 6,
      boxShadow: ok ? '0 0 5px var(--green)' : 'none',
    }} />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.15em', color: 'var(--fg-3)',
        textTransform: 'uppercase', marginBottom: 12,
        paddingBottom: 6, borderBottom: '1px solid var(--line-1)',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '7px 0', borderBottom: '1px solid var(--line-0)',
    }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-0)', textAlign: 'right' }}>
        {value}
      </div>
    </div>
  );
}

function ToggleRow({
  label, sub, value, onChange,
}: {
  label: string; sub: string; value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: '1px solid var(--line-0)',
    }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>{sub}</div>
      </div>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 36, height: 20, borderRadius: 10,
          background: value ? 'var(--cyan)' : 'var(--bg-3)',
          border: '1px solid var(--line-2)',
          cursor: 'pointer',
          position: 'relative', transition: 'background 0.15s',
          flexShrink: 0,
          padding: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 1, borderRadius: '50%',
          width: 16, height: 16, background: value ? '#0f1114' : 'var(--fg-1)',
          left: value ? 18 : 2, transition: 'left 0.15s, background 0.15s',
        }} />
      </button>
    </div>
  );
}

export default function SettingsPanel(props: SettingsPanelProps) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [testFired, setTestFired] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  const setPref = (key: keyof Prefs, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try { window.localStorage.setItem(PREFS_LS_KEY, JSON.stringify(next)); } catch {}
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
    }}>
      <PageHeader crumbs={[{ label: 'SETTINGS' }]} />

      <div style={{
        flex: 1, overflowY: 'auto',
        padding: '20px 24px',
        fontFamily: 'var(--font-mono)',
      }}>

        <Section title="Data Sources">
          <Row
            label="GCP2 Network Coherence"
            sub="gcp2.net — 120s poll — browser direct"
            value={<><StatusDot ok={props.gcpLive} />{props.gcpLive ? `${props.gcpNetvar?.toFixed(1)} NV` : 'Disconnected'}</>}
          />
          <Row
            label="Gold / BTC / Silver Spot Price"
            sub={`gold-api → twelve-data → yahoo · 60s poll${props.goldSource ? ` · active: ${props.goldSource}` : ''}`}
            value={<><StatusDot ok={props.goldStatus !== 'error'} />{props.goldStatus === 'error' ? 'Error' : props.goldStatus === 'closed' ? 'Closed' : 'Live'}</>}
          />
          <Row
            label="OHLCV Candles"
            sub="twelvedata.com — fetched on the Chart tab, 60s refresh"
            value="On demand"
          />
          <Row
            label="Historical GCP"
            sub="Jan 1 – Apr 24 2026 · local JSON"
            value={`${props.historicalPoints.toLocaleString()} min`}
          />
        </Section>

        <Section title="Preferences">
          <ToggleRow
            label="Regime color bands"
            sub="Show colored bands behind Dashboard widgets"
            value={prefs.showRegimeBands}
            onChange={v => setPref('showRegimeBands', v)}
          />
          <ToggleRow
            label="Pattern markers on Chart"
            sub="Show AL / SJ / FA markers above the candles"
            value={prefs.showPatternMarkers}
            onChange={v => setPref('showPatternMarkers', v)}
          />
          <ToggleRow
            label="News feed on Dashboard"
            sub="Reuters / AP / BBC headlines tagged by regime"
            value={prefs.showNewsFeed}
            onChange={v => setPref('showNewsFeed', v)}
          />
          <ToggleRow
            label="PSS Alerts"
            sub={`Browser notification when PSS crosses ${PSS_THRESHOLD} — works in background tabs`}
            value={prefs.pssAlerts}
            onChange={v => setPref('pssAlerts', v)}
          />
          {prefs.pssAlerts && (
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', padding: '8px 0',
              borderBottom: '1px solid var(--line-0)',
            }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>Test notification</div>
                <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>
                  Sends a sample alert to verify permissions are set
                </div>
              </div>
              <button
                onClick={async () => {
                  await props.onTestAlert();
                  setTestFired(true);
                  setTimeout(() => setTestFired(false), 3_000);
                }}
                style={{
                  padding: '4px 12px', fontSize: 9, letterSpacing: '0.08em',
                  fontFamily: 'var(--font-mono)',
                  background: testFired ? 'rgba(34,197,94,0.12)' : 'transparent',
                  border: `1px solid ${testFired ? 'var(--green)' : 'var(--line-2)'}`,
                  borderRadius: 2,
                  color: testFired ? 'var(--green)' : 'var(--fg-2)',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {testFired ? 'SENT ✓' : 'SEND TEST'}
              </button>
            </div>
          )}
        </Section>

        <Section title="Current Session">
          <Row label="Active Symbol"  value={props.symbol} />
          <Row label="Timeframe"      value={props.timeframe} />
          <Row label="Display Points" value={props.seriesLength.toLocaleString()} />
        </Section>

        <Section title="System">
          <Row label="Version"     value={APP_VERSION} />
          <Row label="Model"       value={APP_MODEL} />
          <Row
            label="GCP Scale"
            sub="sum_sq × 0.46 per 60s bucket, calibrated to live API"
            value={
              props.gcpScale != null
                ? `× 0.46 × ${props.gcpScale.toFixed(3)}`
                : '× 0.46 (calibrating…)'
            }
          />
          <Row label="Regime A"    value="0 – 50 NV" />
          <Row label="Regime B"    value="50 – 100 NV" />
          <Row label="Regime C"    value="100 – 140 NV" />
          <Row label="Regime D"    value="140 – 170 NV" />
          <Row label="Regime E"    value="170 – 220 NV" />
          <Row label="Regime F"    value="220+ NV" />
        </Section>

        <Section title="Attribution">
          <div style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 1.7 }}>
            GCP 2.0 data sourced from the <span style={{ color: 'var(--cyan)' }}>HeartMath Institute</span> Global Consciousness Project 2.0 network.
            Gold, Silver, and Bitcoin spot prices via <span style={{ color: 'var(--amber)' }}>gold-api.com</span>, <span style={{ color: 'var(--amber)' }}>Twelve Data</span>, and Yahoo Finance.
            News feed via Reuters, AP, and BBC RSS. GCP Pro is an independent analytical tool and is not affiliated with HeartMath Institute.
          </div>
        </Section>

      </div>
    </div>
  );
}
