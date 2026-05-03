'use client';

import { useEffect, useState } from 'react';
import { APP_VERSION, APP_MODEL } from '@/lib/version';
import { checkForUpdate, type UpdateCheckResult } from '@/lib/pwaUpdate';
import { PageHeader } from '@/components/gcp/Chrome';
import { PSS_THRESHOLD } from '@/lib/usePSSAlert';
import {
  loadSensitivity, saveSensitivity, SENSITIVITY_LABEL,
  type Sensitivity,
} from '@/lib/sensitivity';
import type { MarketSymbol, Timeframe } from '@/types/gcp';
import { symbolEnvLabel } from '@/types/gcp';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import { useCountdown } from '@/lib/useCountdown';
import Heartbeat, { type HeartbeatMode } from './Heartbeat';
import {
  AI_INTERVAL_OPTIONS, formatAiInterval, saveAiAnalysisInterval,
  type AiAnalysisInterval,
} from '@/lib/aiAnalysisInterval';
import { formatDurationSec, type GcpQuality } from '@/lib/alignGcp';

interface SettingsPanelProps {
  gcpLive:          boolean;
  gcpNetvar:        number | null;
  gcpScale:         number | null;
  gcpLastUpdate:    Date | null;
  gcpNextPollAt:    Date | null;
  goldStatus:       string;
  goldPrice:        number | null;
  goldSource:       string | null;
  symbol:           MarketSymbol;
  timeframe:        Timeframe;
  seriesLength:     number;
  historicalPoints: number;
  aiEnabled:        boolean;
  aiState:          GcpStateResponse | null;
  aiLastSuccess:    Date | null;
  aiLastError:      Date | null;
  aiNextPollAt:     Date | null;
  aiIntervalSec:    AiAnalysisInterval;
  aiStatus:         AiStatus;
  aiRunNow:         () => void;
  gcpQuality:       GcpQuality;
  onTestAlert:      () => Promise<'sent' | 'blocked' | 'focused'>;
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

function formatRelative(d: Date | null): string {
  if (!d) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
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

// v11.16.6: bumped sub color from var(--fg-3) (#464c56) to a readable
// blue-grey (#7F98A3) so Settings explanations don't read as disabled
// text. Labels stay subtle, values stay bright — only the helper text
// gets the boost.
function Row({
  label, value, sub, right,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  // v11.24.3: optional auxiliary slot rendered to the right of the
  // value column (used by the System row's "Check for Updates" button).
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '7px 0', borderBottom: '1px solid var(--line-0)', gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 2, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-0)', textAlign: 'right' }}>
          {value}
        </div>
        {right}
      </div>
    </div>
  );
}

// v11.24.3: manual update fallback. Calls registration.update() and
// gives the user immediate feedback. The toast itself is still driven
// by PWARegister's updatefound listener — this button just kicks the
// check off-cycle.
function UpdateCheckButton() {
  const [state, setState] = useState<'idle' | 'checking' | UpdateCheckResult>('idle');
  const click = async () => {
    setState('checking');
    const result = await checkForUpdate();
    setState(result);
    // Reset to idle after a moment so the row doesn't sit in the
    // "current/updated/unsupported" pose forever.
    if (result === 'current' || result === 'unsupported') {
      setTimeout(() => setState('idle'), 2_500);
    }
  };
  const label =
    state === 'checking'    ? 'CHECKING…'
  : state === 'updated'     ? 'UPDATE READY'
  : state === 'current'     ? 'UP TO DATE'
  : state === 'unsupported' ? 'UNSUPPORTED'
  :                           'CHECK FOR UPDATES';
  const accent =
    state === 'updated' ? 'var(--cyan)'
  : state === 'current' ? 'var(--green)'
  : state === 'unsupported' ? 'var(--fg-3)'
  : 'var(--fg-2)';
  return (
    <button
      onClick={click}
      disabled={state === 'checking'}
      style={{
        padding: '3px 9px',
        fontSize: 9, letterSpacing: '0.1em', fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        background: 'transparent',
        border: `1px solid ${state === 'updated' ? 'var(--cyan)' : 'var(--line-2)'}`,
        color: accent,
        borderRadius: 2,
        cursor: state === 'checking' ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
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

type ConnPhase = 'initial' | 'connected' | 'reconnecting' | 'disabled';

export default function SettingsPanel(props: SettingsPanelProps) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [notifStatus, setNotifStatus] = useState<'idle' | 'sent' | 'blocked' | 'focused'>('idle');
  const [sensitivity, setSensitivity] = useState<Sensitivity>('medium');
  // v11.19: Advanced section (auto-interval picker) collapsed by default.
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    setSensitivity(loadSensitivity());
  }, []);

  // v11.15.3: derive a clean state machine for both connection rows
  // and feed nextPollAt into a 1 Hz countdown. Boot state ("Initializing
  // …" / "Loading data…") removes the false-disconnected impression on
  // first load; reconnecting state distinguishes a transient failure
  // from a never-succeeded connection.
  // v11.19: aiPhase / aiNextSecs no longer needed at the SettingsPanel
  // level — AI section is rendered inline below from raw lastSuccess /
  // lastError. GCP coherence row still uses the connection-phase
  // machine + 1 Hz countdown.
  const gcpPhase: ConnPhase = props.gcpLive
    ? 'connected'
    : props.gcpLastUpdate
      ? 'reconnecting'
      : 'initial';

  const gcpNextSecs = useCountdown(props.gcpNextPollAt);

  const phaseToHeartbeat = (p: ConnPhase): HeartbeatMode =>
    p === 'connected'    ? 'live'
    : p === 'reconnecting' ? 'stale'
    : p === 'disabled'     ? 'disabled'
    : 'init';

  const goldHeartbeat: HeartbeatMode =
    props.goldStatus === 'error'  ? 'stale'
    : props.goldStatus === 'closed' ? 'disabled'
    : 'live';

  const updateSensitivity = (s: Sensitivity) => {
    setSensitivity(s);
    saveSensitivity(s);
    // Storage events don't fire in the same tab; nudge listeners directly.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new StorageEvent('storage', { key: PREFS_LS_KEY }));
    }
  };

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

        <Section title="Data Sources · Coherence + Price Feeds">
          <Row
            label="GCP2 Network Coherence"
            sub={
              gcpPhase === 'initial'      ? 'gcp2.net — 120s poll — fetching first sample…'
              : gcpPhase === 'reconnecting' ? 'gcp2.net — 120s poll — last fetch failed, will retry'
              : (() => {
                  // v11.23.1 quality diagnostic appended to the live row
                  const q = props.gcpQuality;
                  const ageStr = q.lastUpdateAgeSec >= 0 ? formatDurationSec(q.lastUpdateAgeSec) : '—';
                  const status = q.stale ? `Stale · last update ${ageStr} ago` : `Live · last update ${ageStr} ago`;
                  const gapStr = q.gapCount === 0
                    ? '0 gaps'
                    : `${q.gapCount} gap${q.gapCount === 1 ? '' : 's'} · largest ${formatDurationSec(q.largestGapSec)}`;
                  return `gcp2.net · ${status} · ${gapStr}`;
                })()
            }
            value={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Heartbeat mode={
                  gcpPhase === 'reconnecting' ? 'stale'
                  : props.gcpQuality.stale     ? 'stale'
                  : phaseToHeartbeat(gcpPhase)
                } />
                {gcpPhase === 'connected'      ? `${props.gcpNetvar?.toFixed(1)} NV` :
                 gcpPhase === 'reconnecting'   ? 'Reconnecting…' :
                                                 'Loading data…'}
              </span>
            }
          />
          <Row
            label="Last Update"
            sub={
              gcpPhase === 'initial'
                ? `Next update in ${gcpNextSecs}s`
                : `Last update ${formatRelative(props.gcpLastUpdate)} · Next update in ${gcpNextSecs}s`
            }
            value={
              gcpPhase === 'initial'
                ? '—'
                : formatRelative(props.gcpLastUpdate)
            }
          />
          <Row
            label="Gold / BTC / Silver Spot Price"
            sub={`gold-api → twelve-data → yahoo · 60s poll${props.goldSource ? ` · active: ${props.goldSource}` : ''}`}
            value={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Heartbeat mode={goldHeartbeat} />
                {props.goldStatus === 'error' ? 'Error' : props.goldStatus === 'closed' ? 'Closed' : 'Live'}
              </span>
            }
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

        {/* v11.19: AI Engine settings rewritten as a control panel.
            "Run when needed" rather than "manage a scheduler". The
            interval picker, countdowns, and current-interval row are
            gone from the primary view; the user sees Status, Mode,
            Cost, Run, and Last run only. Power users can still pick
            an auto interval under Advanced. */}
        <Section title={`AI Engine · GCP + ${symbolEnvLabel(props.symbol)} Environment`}>
          {(() => {
            const isManual  = props.aiIntervalSec === 'manual';
            const connected = props.aiLastSuccess != null
              && (!props.aiLastError || props.aiLastError <= props.aiLastSuccess);

            return (
              <>
                <Row
                  label="Status"
                  sub={
                    connected
                      ? '6away Engine · last response received'
                      : props.aiLastError
                        ? `Last error ${formatRelative(props.aiLastError)}`
                        : 'No analysis run yet — press RUN AI ANALYSIS'
                  }
                  value={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Heartbeat mode={connected ? 'live' : props.aiLastError ? 'stale' : 'init'} />
                      {connected ? 'Connected' : 'Disconnected'}
                    </span>
                  }
                />

                <Row
                  label="Mode"
                  sub={isManual
                    ? 'Auto-runs disabled. AI runs only when you press the button.'
                    : `Auto · runs every ${formatAiInterval(props.aiIntervalSec)} when conditions warrant`}
                  value={isManual ? 'Manual (recommended)' : 'Auto (advanced)'}
                />

                {/* Cost warning */}
                <div style={{
                  margin: '12px 0 8px',
                  padding: '10px 12px',
                  background: 'rgba(212, 160, 40, 0.06)',
                  border: '1px solid rgba(212, 160, 40, 0.35)',
                  borderRadius: 4,
                  fontSize: 11, color: '#d4a028', lineHeight: 1.5,
                }}>
                  AI analysis uses LLM tokens. Run when needed.
                </div>

                {/* Primary action — full-width, prominent. */}
                <button
                  onClick={() => props.aiRunNow()}
                  disabled={!props.aiEnabled || props.aiStatus === 'running'}
                  style={{
                    width: '100%', marginTop: 4, marginBottom: 8,
                    padding: '12px 16px',
                    fontSize: 12, letterSpacing: '0.12em', fontWeight: 600,
                    fontFamily: 'var(--font-mono)',
                    background: props.aiStatus === 'running' ? 'rgba(77,217,232,0.12)' : 'transparent',
                    border: `1px solid ${(!props.aiEnabled || props.aiStatus === 'running') ? 'var(--line-2)' : 'var(--cyan)'}`,
                    color: (!props.aiEnabled || props.aiStatus === 'running') ? 'var(--fg-3)' : 'var(--cyan)',
                    borderRadius: 4,
                    cursor: (!props.aiEnabled || props.aiStatus === 'running') ? 'default' : 'pointer',
                  }}
                >
                  {props.aiStatus === 'running' ? 'RUNNING…' : 'RUN AI ANALYSIS'}
                </button>

                <Row
                  label="Last run"
                  sub={props.aiLastSuccess ? 'Time since the last successful Engine response' : undefined}
                  value={props.aiLastSuccess ? formatRelative(props.aiLastSuccess) : 'never'}
                />

                {props.aiState && (
                  <>
                    <Row
                      label="Current State"
                      value={`${props.aiState.stateCode} · ${props.aiState.state}`}
                    />
                    <Row
                      label="Direction / Phase"
                      value={`${props.aiState.direction} · ${props.aiState.phase}`}
                    />
                    <Row
                      label="Strength / Confidence"
                      value={`${props.aiState.strength.toFixed(2)} · ${(props.aiState.confidence * 100).toFixed(0)}%`}
                    />
                  </>
                )}

                {/* Advanced — collapsed by default. Power users can
                    re-enable an auto-loop with a numeric interval, but
                    nothing in the primary view encourages it. */}
                <div style={{ marginTop: 14 }}>
                  <button
                    onClick={() => setShowAdvanced(s => !s)}
                    style={{
                      padding: 0, background: 'transparent', border: 'none',
                      color: '#7F98A3', cursor: 'pointer',
                      fontSize: 9, letterSpacing: '0.14em',
                      fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {showAdvanced ? '▾ Hide advanced' : '▸ Show advanced'}
                  </button>
                </div>

                {showAdvanced && (
                  <div style={{
                    padding: '10px 12px', marginTop: 8,
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line-1)',
                    borderRadius: 4,
                  }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>Auto-run interval</div>
                        <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 2, lineHeight: 1.5 }}>
                          Pick a non-Manual option to re-enable auto-runs. Each tick costs LLM tokens.
                        </div>
                      </div>
                      <select
                        value={String(props.aiIntervalSec)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          saveAiAnalysisInterval(raw === 'manual' ? 'manual' : (Number(raw) as AiAnalysisInterval));
                        }}
                        style={{
                          padding: '4px 8px',
                          fontSize: 11, fontFamily: 'var(--font-mono)',
                          background: 'var(--bg-1)',
                          color: 'var(--fg-1)',
                          border: '1px solid var(--line-2)',
                          borderRadius: 3,
                        }}
                      >
                        {AI_INTERVAL_OPTIONS.map(opt => (
                          <option key={String(opt)} value={String(opt)}>
                            {formatAiInterval(opt)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </Section>

        <Section title="Preferences">
          <div style={{
            padding: '10px 0', borderBottom: '1px solid var(--line-0)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1, paddingRight: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>Pattern Sensitivity</div>
                <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>
                  Low = fewer, higher-confidence patterns. High = early warnings, more noise.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 0 }}>
                {(['low','medium','high'] as Sensitivity[]).map(s => {
                  const active = sensitivity === s;
                  return (
                    <button
                      key={s}
                      onClick={() => updateSensitivity(s)}
                      style={{
                        padding: '4px 10px',
                        fontSize: 9, letterSpacing: '0.08em',
                        fontFamily: 'var(--font-mono)',
                        background: active ? 'var(--bg-3)' : 'transparent',
                        border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-2)'}`,
                        color: active ? 'var(--cyan)' : 'var(--fg-3)',
                        cursor: 'pointer',
                        marginLeft: -1,
                      }}
                    >
                      {SENSITIVITY_LABEL[s].toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
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
            <div style={{ borderBottom: '1px solid var(--line-0)', padding: '8px 0' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--fg-1)' }}>Test notification</div>
                  <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 2 }}>
                    Sends a sample alert to verify permissions are set
                  </div>
                </div>
                <button
                  onClick={async () => {
                    const result = await props.onTestAlert();
                    setNotifStatus(result);
                    setTimeout(() => setNotifStatus('idle'), 5_000);
                  }}
                  style={{
                    padding: '4px 12px', fontSize: 9, letterSpacing: '0.08em',
                    fontFamily: 'var(--font-mono)',
                    background:
                      notifStatus === 'sent'    ? 'rgba(34,197,94,0.12)' :
                      notifStatus === 'focused' ? 'rgba(212,160,40,0.14)' :
                      notifStatus === 'blocked' ? 'rgba(226,75,74,0.14)' :
                      'transparent',
                    border: `1px solid ${
                      notifStatus === 'sent'    ? 'var(--green)' :
                      notifStatus === 'focused' ? '#d4a028'      :
                      notifStatus === 'blocked' ? 'var(--red)'   :
                      'var(--line-2)'
                    }`,
                    borderRadius: 2,
                    color:
                      notifStatus === 'sent'    ? 'var(--green)' :
                      notifStatus === 'focused' ? '#d4a028'      :
                      notifStatus === 'blocked' ? 'var(--red)'   :
                      'var(--fg-2)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {notifStatus === 'sent'    ? 'SENT ✓'      :
                   notifStatus === 'focused' ? 'SWITCH TAB →' :
                   notifStatus === 'blocked' ? 'BLOCKED ✗'    :
                   'SEND TEST'}
                </button>
              </div>
              {notifStatus === 'focused' && (
                <div style={{ fontSize: 9, color: '#d4a028', marginTop: 6, lineHeight: 1.5 }}>
                  Browsers hide notifications when this tab is the active one.
                  Switch to another window or tab to see the alert pop up.
                </div>
              )}
              {notifStatus === 'blocked' && (
                <div style={{ fontSize: 9, color: 'var(--red)', marginTop: 6, lineHeight: 1.5 }}>
                  Notifications blocked. Enable them in your browser&rsquo;s site permissions
                  for this URL and try again.
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="Current Session">
          <Row label="Active Symbol"  value={props.symbol} />
          <Row label="Timeframe"      value={props.timeframe} />
          <Row label="Display Points" value={props.seriesLength.toLocaleString()} />
        </Section>

        <Section title="System">
          <Row
            label="Version"
            value={APP_VERSION}
            right={<UpdateCheckButton />}
          />
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
