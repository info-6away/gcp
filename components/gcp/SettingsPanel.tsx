'use client';

import { APP_VERSION, APP_MODEL } from '@/lib/version';
import type { MarketSymbol, Timeframe } from '@/types/gcp';

interface SettingsPanelProps {
  gcpLive:          boolean;
  gcpNetvar:        number | null;
  gcpScale:         number | null;
  goldStatus:       string;
  goldPrice:        number | null;
  goldSource:       string | null;
  candleLoading:    boolean;
  candleError:      string | null;
  symbol:           MarketSymbol;
  timeframe:        Timeframe;
  seriesLength:     number;
  historicalPoints: number;
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

export default function SettingsPanel(props: SettingsPanelProps) {
  return (
    <div style={{
      maxWidth: 560, margin: '0 auto', padding: '28px 32px',
      fontFamily: 'var(--font-mono)',
      height: '100%', overflowY: 'auto',
    }}>

      <Section title="Data Sources">
        <Row
          label="GCP2 Network Coherence"
          sub="gcp2.net — 60s poll — browser direct"
          value={<><StatusDot ok={props.gcpLive} />{props.gcpLive ? `${props.gcpNetvar?.toFixed(1)} NV` : 'Disconnected'}</>}
        />
        <Row
          label="Gold / BTC Spot Price"
          sub={`gold-api → twelve-data → yahoo · 60s poll${props.goldSource ? ` · active: ${props.goldSource}` : ''}`}
          value={<><StatusDot ok={props.goldStatus !== 'error'} />{props.goldStatus === 'error' ? 'Error' : props.goldStatus === 'closed' ? 'Closed' : 'Live'}</>}
        />
        <Row
          label="OHLCV Candles"
          sub="twelvedata.com — 60s poll — Grow plan"
          value={<><StatusDot ok={!props.candleError && !props.candleLoading} />{props.candleLoading ? 'Loading…' : props.candleError ? 'Error' : 'Live'}</>}
        />
        <Row
          label="Historical GCP"
          sub="Feb 1 – Apr 24 2026 · local JSON"
          value={`${props.historicalPoints.toLocaleString()} min`}
        />
      </Section>

      <Section title="Current Session">
        <Row label="Active Symbol"   value={props.symbol} />
        <Row label="Timeframe"       value={props.timeframe} />
        <Row label="Display Points"  value={props.seriesLength.toLocaleString()} />
      </Section>

      <Section title="System">
        <Row
          label="Net Variance (NV)"
          sub="GCP2 network coherence score — higher = more synchronized global attention"
          value="0 – 320+ NV"
        />
        <Row
          label="Status bar NV"
          sub="Updates every 60s from live API · matches cursor in history mode"
          value="Live ↻"
        />
        <Row label="Version"     value={APP_VERSION} />
        <Row label="Model"       value={APP_MODEL} />
        <Row
          label="GCP Scale"
          sub="sum_sq × 0.46 per 60s bucket, calibrated to live API"
          value={`× 0.46 × ${props.gcpScale?.toFixed(3) ?? '…'}`}
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
          Gold and Bitcoin data via <span style={{ color: 'var(--amber)' }}>gold-api.com</span> and <span style={{ color: 'var(--amber)' }}>Twelve Data</span>.
          GCP Pro is an independent analytical tool and is not affiliated with HeartMath Institute.
        </div>
      </Section>

    </div>
  );
}
