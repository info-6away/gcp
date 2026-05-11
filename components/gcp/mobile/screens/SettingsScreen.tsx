'use client';

import { useState, type ReactNode } from 'react';
import { C } from '../colors';
import { MobileStatus } from '../MobileChrome';
import { APP_VERSION } from '@/lib/version';
import type { GcpStateResponse, ClassifyErrorEnvelope } from '@/lib/engine-gcp';
import type { AiStatus } from '@/lib/useGcpState';
import { useCountdown } from '@/lib/useCountdown';
import Heartbeat, { type HeartbeatMode } from '../../Heartbeat';
import {
  AI_INTERVAL_OPTIONS, formatAiInterval, saveAiAnalysisInterval,
  type AiAnalysisInterval,
} from '@/lib/aiAnalysisInterval';
import { formatDurationSec, type GcpQuality } from '@/lib/alignGcp';
import EngineDiagnostics from '../../EngineDiagnostics';

type ConnPhase = 'initial' | 'connected' | 'reconnecting' | 'disabled';

function phaseToHeartbeat(p: ConnPhase): HeartbeatMode {
  if (p === 'connected')    return 'live';
  if (p === 'reconnecting') return 'stale';
  if (p === 'disabled')     return 'disabled';
  return 'init';
}

function valueWithHeartbeat(mode: HeartbeatMode, label: string, color: string): ReactNode {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color }}>
      <Heartbeat mode={mode} size={6} />
      {label}
    </span>
  );
}

function formatRelative(d: Date | null): string {
  if (!d) return '—';
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width: 36, height: 20, borderRadius: 10, position: 'relative',
      background: value ? C.cyan : C.bg3, border: 'none', cursor: 'pointer',
      flexShrink: 0, transition: 'background 0.15s',
    }}>
      <span style={{
        position: 'absolute', top: 2, borderRadius: '50%',
        width: 16, height: 16, background: '#fff',
        left: value ? 18 : 2, transition: 'left 0.15s',
      }} />
    </button>
  );
}

export function SettingsScreen({
  liveNV, liveRegime, connected, settings, updateSetting, seriesLength,
  aiState, aiEnabled, aiLastSuccess, aiLastError, aiLastErrorEnvelope = null, aiNextPollAt,
  aiIntervalSec, aiStatus, aiRunNow,
  gcpLastUpdate, gcpNextPollAt, gcpQuality,
}: {
  liveNV: number | null; liveRegime: string | null; connected: boolean;
  settings: Record<string, boolean>; updateSetting: (k: string, v: boolean) => void;
  seriesLength: number;
  aiState:       GcpStateResponse | null;
  aiEnabled:     boolean;
  aiLastSuccess: Date | null;
  aiLastError:   Date | null;
  aiLastErrorEnvelope?: ClassifyErrorEnvelope | null;
  aiNextPollAt:  Date | null;
  aiIntervalSec: AiAnalysisInterval;
  aiStatus:      AiStatus;
  aiRunNow:      (options?: { force?: boolean; source?: string }) => void;
  gcpLastUpdate: Date | null;
  gcpNextPollAt: Date | null;
  gcpQuality:    GcpQuality;
}) {
  const isRunning = aiStatus === 'running';
  // v11.19: AI section is now a control panel — Status / Mode / Run /
  // Last run only. Removed: interval picker buttons, Current interval,
  // Next analysis countdown. GCP coherence row still uses the
  // connection-phase machine + 1 Hz countdown.
  const gcpNextSecs = useCountdown(gcpNextPollAt);

  const gcpPhase: ConnPhase = connected
    ? 'connected'
    : gcpLastUpdate
      ? 'reconnecting'
      : 'initial';

  const gcpStatusLabel = gcpPhase === 'initial' ? 'Loading data…'
    : gcpPhase === 'connected' ? 'Live'
    : 'Reconnecting…';
  const gcpStatusColor = gcpPhase === 'connected' ? C.green
    : gcpPhase === 'reconnecting' ? C.red
    : C.fg3;

  // AI binary status — Connected when there's a recent success that
  // hasn't been superseded by an error; Disconnected otherwise.
  const aiConnected = aiLastSuccess != null
    && (!aiLastError || aiLastError <= aiLastSuccess);
  const aiStatusLabel = aiConnected ? 'Connected' : 'Disconnected';
  const aiStatusColor = aiConnected ? C.green : (aiLastError ? C.red : C.fg3);
  const aiHeartbeatMode = aiConnected ? 'live' : (aiLastError ? 'stale' : 'init');
  const isManualMode = aiIntervalSec === 'manual';

  // Advanced section is collapsed by default — interval picker hides
  // behind this so the primary view stays focused on Run.
  const [showAdvanced, setShowAdvanced] = useState(false);

  const prefRows = [
    { key: 'pssAlerts',          label: 'PSS Alerts',         sub: 'Notify when PSS ≥ 70' },
    { key: 'showNewsFeed',       label: 'News feed',          sub: 'Reuters / AP / BBC / Guardian / Al Jazeera' },
    { key: 'showPatternMarkers', label: 'Pattern markers',    sub: 'Show on chart panes' },
  ];

  const aiRows: { label: string; val: ReactNode; valColor: string; sub?: string }[] = [
    {
      label: 'Status',
      val: valueWithHeartbeat(aiHeartbeatMode, aiStatusLabel, aiStatusColor),
      valColor: aiStatusColor,
      sub: aiConnected
        ? '6away Engine · last response received'
        : aiLastError
          ? `Last error ${formatRelative(aiLastError)}`
          : 'No analysis run yet',
    },
    {
      label: 'Mode',
      val:      isManualMode ? 'Manual (recommended)' : 'Auto (advanced)',
      valColor: isManualMode ? C.fg1 : C.amber,
      sub:      isManualMode
        ? 'AI runs only when you press the button'
        : `Auto · ${formatAiInterval(aiIntervalSec)}`,
    },
    {
      label: 'Last run',
      val: formatRelative(aiLastSuccess),
      valColor: C.fg2,
      sub: aiLastSuccess ? undefined : 'No successful classification yet',
    },
  ];
  if (aiState) {
    aiRows.push(
      { label: 'Current State',         val: `${aiState.stateCode} · ${aiState.state}`,                              valColor: C.fg1 },
      { label: 'Direction / Phase',     val: `${aiState.direction} · ${aiState.phase}`,                              valColor: C.fg1 },
      { label: 'Strength / Confidence', val: `${aiState.strength.toFixed(2)} · ${(aiState.confidence * 100).toFixed(0)}%`, valColor: C.fg1 },
    );
  }

  // v11.23.1: Coherence status sub-line includes feed quality so the
  // user sees stale / gap conditions inline instead of having to dig.
  const qualityStatusSub = (() => {
    const q = gcpQuality;
    const ageStr = q.lastUpdateAgeSec >= 0 ? formatDurationSec(q.lastUpdateAgeSec) : '—';
    const status = q.stale ? `Stale · last update ${ageStr} ago` : `Live · last update ${ageStr} ago`;
    const gapStr = q.gapCount === 0
      ? '0 gaps'
      : `${q.gapCount} gap${q.gapCount === 1 ? '' : 's'} · largest ${formatDurationSec(q.largestGapSec)}`;
    return `${status} · ${gapStr}`;
  })();

  const cohRows: { label: string; val: ReactNode; valColor: string; sub?: string }[] = [
    {
      label: 'Status',
      val: valueWithHeartbeat(
        gcpQuality.stale ? 'stale' : phaseToHeartbeat(gcpPhase),
        gcpStatusLabel,
        gcpStatusColor,
      ),
      valColor: gcpStatusColor,
      sub: gcpPhase === 'initial'      ? 'gcp2.net · 120s poll · fetching first sample'
         : gcpPhase === 'reconnecting' ? 'gcp2.net · 120s poll · last fetch failed, will retry'
         : `gcp2.net · 120s poll · ${qualityStatusSub}`,
    },
    { label: 'Last update',
      val:  gcpPhase === 'initial' ? '—' : formatRelative(gcpLastUpdate),
      valColor: C.fg2 },
    { label: 'Next update in', val: `${gcpNextSecs}s`, valColor: C.fg1 },
  ];
  if (gcpQuality.gapCount > 0) {
    cohRows.push({
      label: 'Gaps in window',
      val: `${gcpQuality.gapCount} · largest ${formatDurationSec(gcpQuality.largestGapSec)}`,
      valColor: C.amber,
    });
  }
  if (liveNV != null) {
    cohRows.push({ label: 'Net Variance', val: `${liveNV.toFixed(1)} NV`, valColor: C.fg1 });
  }

  // v11.18.2: Version row removed from sysRows — now displayed
  // prominently in the page header.
  const sysRows = [
    { label: 'Historical GCP',  val: `${seriesLength.toLocaleString()} pts`, valColor: C.fg2 },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} aiStatus={aiStatus} />

      {/* v11.18.2: version now visible in the page header. The "Hard
          to find on mobile" complaint was real — the Version row was
          buried at the bottom of the SYSTEM table. Putting it here
          (and slightly brighter) means the user can confirm which
          build they're running without scrolling. The "Check for
          updates" button forces the SW to re-fetch /sw.js — useful
          if the auto-poll hasn't surfaced the latest deploy yet. */}
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${C.line1}`,
        background: C.bg, flexShrink: 0,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10,
      }}>
        <div>
          <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3 }}>SYSTEM</div>
          <div style={{ fontSize: 18, color: C.fg0, fontWeight: 600, marginTop: 2 }}>SETTINGS</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 8, letterSpacing: '0.16em', color: C.fg3 }}>VERSION</div>
          <div style={{
            fontSize: 13, color: C.cyan, fontFamily: 'inherit',
            fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2,
          }}>
            v{APP_VERSION}
          </div>
          <button
            onClick={() => {
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistration().then(reg => {
                  if (reg) reg.update().catch(() => {});
                });
              }
              setTimeout(() => window.location.reload(), 600);
            }}
            style={{
              marginTop: 4,
              padding: '3px 8px',
              background: 'transparent',
              border: `1px solid ${C.line2}`,
              borderRadius: 2,
              color: C.fg2,
              fontSize: 8, letterSpacing: '0.1em',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            CHECK FOR UPDATES
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3, marginBottom: 6 }}>PREFERENCES</div>
        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, marginBottom: 16 }}>
          {prefRows.map((row, i) => (
            <div key={row.key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px',
              borderBottom: i < prefRows.length - 1 ? `1px solid ${C.line0}` : 'none',
            }}>
              <div style={{ flex: 1, paddingRight: 12 }}>
                <div style={{ fontSize: 12, color: C.fg1 }}>{row.label}</div>
                <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 2, lineHeight: 1.5 }}>{row.sub}</div>
              </div>
              <Toggle
                value={settings[row.key] ?? true}
                onChange={v => updateSetting(row.key, v)}
              />
            </div>
          ))}
        </div>

        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3, marginBottom: 6 }}>COHERENCE (GCP)</div>
        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, marginBottom: 16 }}>
          {cohRows.map((row, i) => (
            <div key={row.label} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px', gap: 10,
              borderBottom: i < cohRows.length - 1 ? `1px solid ${C.line0}` : 'none',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: C.fg1 }}>{row.label}</div>
                {row.sub && (
                  <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 2, lineHeight: 1.5 }}>{row.sub}</div>
                )}
              </div>
              <div style={{
                fontSize: 11, color: row.valColor,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right', flexShrink: 0,
              }}>
                {row.val}
              </div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3, marginBottom: 6 }}>AI ENGINE</div>

        {/* v11.19 cost warning — pinned above the rows */}
        <div style={{
          marginBottom: 8,
          padding: '8px 10px',
          background: 'rgba(212, 160, 40, 0.06)',
          border: '1px solid rgba(212, 160, 40, 0.35)',
          borderRadius: 3,
          fontSize: 10, color: '#d4a028', lineHeight: 1.5,
        }}>
          AI analysis uses LLM tokens. Run when needed.
        </div>

        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, marginBottom: 8 }}>
          {aiRows.map((row, i) => (
            <div key={row.label} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px', gap: 10,
              borderBottom: i < aiRows.length - 1 ? `1px solid ${C.line0}` : 'none',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: C.fg1 }}>{row.label}</div>
                {row.sub && (
                  <div style={{ fontSize: 10, color: '#7F98A3', marginTop: 2, lineHeight: 1.5 }}>{row.sub}</div>
                )}
              </div>
              <div style={{
                fontSize: 11, color: row.valColor,
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right', flexShrink: 0,
              }}>
                {row.val}
              </div>
            </div>
          ))}
        </div>

        {/* v11.19 primary action — full-width prominent RUN button */}
        {/* v12.0.4: pass { force, source } so cost gate accepts the call. */}
        <button
          onClick={() => {
            if (process.env.NODE_ENV !== 'production') {
              console.log('[ASK GURU CLICK]', {
                aiStatus, force: true, source: 'mobile_settings_button',
                hasRunNow: typeof aiRunNow === 'function', reason: 'ok',
              });
            }
            aiRunNow({ force: true, source: 'mobile_settings_button' });
          }}
          disabled={!aiEnabled || isRunning}
          style={{
            width: '100%', padding: '14px 16px', marginBottom: 8,
            background: isRunning ? `${C.cyan}1f` : 'transparent',
            border: `1px solid ${
              !aiEnabled || isRunning ? C.line2 : C.cyan
            }`,
            borderRadius: 4,
            color: !aiEnabled || isRunning ? C.fg3 : C.cyan,
            fontFamily: 'inherit',
            fontSize: 12, letterSpacing: '0.12em', fontWeight: 600,
            cursor: !aiEnabled || isRunning ? 'default' : 'pointer',
          }}
        >
          {isRunning ? 'RUNNING…' : 'RUN AI ANALYSIS'}
        </button>

        {/* v11.19 Advanced — collapsed by default. Auto interval lives
            here, behind a toggle, so the primary view stays manual-first. */}
        <button
          onClick={() => setShowAdvanced(s => !s)}
          style={{
            padding: '6px 0', marginBottom: 4,
            background: 'transparent', border: 'none',
            color: '#7F98A3', cursor: 'pointer',
            fontSize: 9, letterSpacing: '0.14em',
            fontFamily: 'inherit', textTransform: 'uppercase',
            textAlign: 'left', width: '100%',
          }}
        >
          {showAdvanced ? '▾ Hide advanced' : '▸ Show advanced'}
        </button>
        {showAdvanced && (
          <div style={{
            background: C.bg2, border: `1px solid ${C.line1}`, borderRadius: 3,
            padding: '10px 12px', marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, color: C.fg1, marginBottom: 3 }}>Auto-run interval</div>
            <div style={{ fontSize: 10, color: '#7F98A3', marginBottom: 8, lineHeight: 1.5 }}>
              Pick a non-Manual option to re-enable auto-runs. Each tick costs LLM tokens.
            </div>
            <select
              value={String(aiIntervalSec)}
              onChange={(e) => {
                const raw = e.target.value;
                saveAiAnalysisInterval(raw === 'manual' ? 'manual' : (Number(raw) as AiAnalysisInterval));
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 12, fontFamily: 'inherit',
                background: C.bg1,
                color: C.fg1,
                border: `1px solid ${C.line2}`,
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
        )}

        {/* v12.0.0: Engine integration diagnostics block — additive,
            sits between AI Engine and System on the mobile settings
            screen. Polls /api/engine-status every 60s. */}
        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3, marginBottom: 6, marginTop: 16 }}>ENGINE INTEGRATION</div>
        <div style={{ marginBottom: 16 }}>
          <EngineDiagnostics aiLastError={aiLastErrorEnvelope} />
        </div>

        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3, marginBottom: 6 }}>SYSTEM</div>
        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3 }}>
          {sysRows.map((row, i) => (
            <div key={row.label} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px',
              borderBottom: i < sysRows.length - 1 ? `1px solid ${C.line0}` : 'none',
            }}>
              <div style={{ fontSize: 12, color: C.fg1 }}>{row.label}</div>
              <div style={{ fontSize: 11, color: row.valColor, fontVariantNumeric: 'tabular-nums' }}>{row.val}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
