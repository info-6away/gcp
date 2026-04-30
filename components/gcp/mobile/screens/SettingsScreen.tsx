'use client';

import type { ReactNode } from 'react';
import { C } from '../colors';
import { MobileStatus } from '../MobileChrome';
import { APP_VERSION } from '@/lib/version';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { useCountdown } from '@/lib/useCountdown';
import Heartbeat, { type HeartbeatMode } from '../../Heartbeat';
import {
  AI_INTERVAL_OPTIONS, formatAiInterval, saveAiAnalysisInterval,
  type AiAnalysisInterval,
} from '@/lib/aiAnalysisInterval';

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
  aiState, aiEnabled, aiLastSuccess, aiLastError, aiNextPollAt,
  aiIntervalSec, aiInflight, aiRunNow,
  gcpLastUpdate, gcpNextPollAt,
}: {
  liveNV: number | null; liveRegime: string | null; connected: boolean;
  settings: Record<string, boolean>; updateSetting: (k: string, v: boolean) => void;
  seriesLength: number;
  aiState:       GcpStateResponse | null;
  aiEnabled:     boolean;
  aiLastSuccess: Date | null;
  aiLastError:   Date | null;
  aiNextPollAt:  Date | null;
  aiIntervalSec: AiAnalysisInterval;
  aiInflight:    boolean;
  aiRunNow:      () => void;
  gcpLastUpdate: Date | null;
  gcpNextPollAt: Date | null;
}) {
  // v11.15.3: state-machine derivation + 1 Hz countdowns shared across
  // both connection rows. The countdown hook re-renders this screen
  // every second; that's fine for a tab-level surface and avoids any
  // bespoke timer plumbing on top of the polling loops.
  const aiNextSecs  = useCountdown(aiNextPollAt);
  const gcpNextSecs = useCountdown(gcpNextPollAt);

  const aiPhase: ConnPhase = !aiEnabled
    ? 'disabled'
    : aiLastError && (!aiLastSuccess || aiLastError > aiLastSuccess)
      ? 'reconnecting'
      : aiLastSuccess
        ? 'connected'
        : 'initial';

  const gcpPhase: ConnPhase = connected
    ? 'connected'
    : gcpLastUpdate
      ? 'reconnecting'
      : 'initial';

  const aiStatusLabel = aiPhase === 'initial' ? 'Initializing…'
    : aiPhase === 'connected' ? 'Connected'
    : aiPhase === 'reconnecting' ? 'Reconnecting…'
    : 'Disabled';
  const aiStatusColor = aiPhase === 'connected' ? C.green
    : aiPhase === 'reconnecting' ? C.red
    : C.fg3;

  const gcpStatusLabel = gcpPhase === 'initial' ? 'Loading data…'
    : gcpPhase === 'connected' ? 'Live'
    : 'Reconnecting…';
  const gcpStatusColor = gcpPhase === 'connected' ? C.green
    : gcpPhase === 'reconnecting' ? C.red
    : C.fg3;

  const prefRows = [
    { key: 'pssAlerts',          label: 'PSS Alerts',         sub: 'Notify when PSS ≥ 70' },
    { key: 'showNewsFeed',       label: 'News feed',          sub: 'Reuters / AP / BBC / Guardian / Al Jazeera' },
    { key: 'showPatternMarkers', label: 'Pattern markers',    sub: 'Show on chart panes' },
  ];

  const aiRows: { label: string; val: ReactNode; valColor: string; sub?: string }[] = [
    {
      label: 'Status',
      val: valueWithHeartbeat(phaseToHeartbeat(aiPhase), aiStatusLabel, aiStatusColor),
      valColor: aiStatusColor,
      sub: aiPhase === 'initial'      ? '6away Engine · waiting for first response'
         : aiPhase === 'reconnecting' ? '6away Engine · keeping prior state'
         : aiPhase === 'disabled'     ? 'Polling is off'
         : '6away Engine · /v1/coherence/gcp-state',
    },
    {
      label: 'Current interval',
      val: formatAiInterval(aiIntervalSec),
      valColor: aiIntervalSec === 'manual' ? C.amber : C.fg1,
    },
  ];
  if (aiIntervalSec === 'manual') {
    aiRows.push({
      label: 'Next analysis in', val: '—', valColor: C.fg3,
      sub: 'Auto-loop is off — press Run Now',
    });
  } else if (aiNextPollAt == null) {
    // v11.16.6: no attempt yet. Don't show a misleading short
    // countdown; surface "Ready now" so the user sees they're
    // about to get data on the next decide tick.
    aiRows.push({
      label: 'Next analysis in', val: 'Ready now', valColor: C.fg1,
      sub: 'First decide tick will fire as soon as inputs are ready',
    });
  } else if (aiPhase === 'reconnecting') {
    aiRows.push(
      { label: 'Last error', val: formatRelative(aiLastError), valColor: C.red,
        sub: aiLastSuccess ? `Last success ${formatRelative(aiLastSuccess)}` : 'No successful classification yet' },
      { label: 'Retry in',   val: `${aiNextSecs}s`,            valColor: C.fg1 },
    );
  } else {
    aiRows.push({ label: 'Next analysis in', val: `${aiNextSecs}s`, valColor: C.fg1 });
  }
  aiRows.push({
    label: 'Last classification',
    val: formatRelative(aiLastSuccess),
    valColor: C.fg2,
    sub: aiLastSuccess ? undefined : 'No successful classification yet',
  });
  if (aiState) {
    aiRows.push(
      { label: 'Current State',         val: `${aiState.stateCode} · ${aiState.state}`,                              valColor: C.fg1 },
      { label: 'Direction / Phase',     val: `${aiState.direction} · ${aiState.phase}`,                              valColor: C.fg1 },
      { label: 'Strength / Confidence', val: `${aiState.strength.toFixed(2)} · ${(aiState.confidence * 100).toFixed(0)}%`, valColor: C.fg1 },
    );
  }

  const cohRows: { label: string; val: ReactNode; valColor: string; sub?: string }[] = [
    {
      label: 'Status',
      val: valueWithHeartbeat(phaseToHeartbeat(gcpPhase), gcpStatusLabel, gcpStatusColor),
      valColor: gcpStatusColor,
      sub: gcpPhase === 'initial'      ? 'gcp2.net · 120s poll · fetching first sample'
         : gcpPhase === 'reconnecting' ? 'gcp2.net · 120s poll · last fetch failed, will retry'
         : 'gcp2.net · 120s poll · browser direct',
    },
    { label: 'Last update',
      val:  gcpPhase === 'initial' ? '—' : formatRelative(gcpLastUpdate),
      valColor: C.fg2 },
    { label: 'Next update in', val: `${gcpNextSecs}s`, valColor: C.fg1 },
  ];
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
        aiState={aiState} aiEnabled={aiEnabled} />

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

        {/* v11.18.3 cost warning — manual is the default */}
        <div style={{
          marginBottom: 8,
          padding: '8px 10px',
          background: 'rgba(212, 160, 40, 0.06)',
          border: '1px solid rgba(212, 160, 40, 0.35)',
          borderRadius: 3,
          fontSize: 10, color: '#d4a028', lineHeight: 1.5,
        }}>
          AI analysis uses LLM tokens. Run manually to control cost.
        </div>

        {/* v11.16.4 interval picker — saved to gcpro-ai-analysis-interval */}
        <div style={{
          background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3,
          padding: '10px 12px', marginBottom: 8,
        }}>
          <div style={{ fontSize: 11, color: C.fg1, marginBottom: 3 }}>AI Analysis Interval</div>
          <div style={{ fontSize: 10, color: '#7F98A3', marginBottom: 8, lineHeight: 1.5 }}>
            Minimum gap between Engine calls. Manual disables the auto-loop.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {AI_INTERVAL_OPTIONS.map(opt => {
              const active = aiIntervalSec === opt;
              return (
                <button
                  key={String(opt)}
                  onClick={() => saveAiAnalysisInterval(opt)}
                  style={{
                    padding: '5px 10px',
                    fontSize: 9, letterSpacing: '0.06em',
                    background: active ? C.bg3 : 'transparent',
                    border: `1px solid ${active ? C.cyan : C.line2}`,
                    color: active ? C.cyan : C.fg2,
                    borderRadius: 2,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {opt === 'manual' ? 'MANUAL' : `${opt}S`}
                </button>
              );
            })}
          </div>
        </div>

        {/* v11.16.4 manual override button */}
        <button
          onClick={() => aiRunNow()}
          disabled={!aiEnabled || aiInflight}
          style={{
            width: '100%', padding: '12px 14px', marginBottom: 16,
            background: aiInflight ? `${C.cyan}1f` : 'transparent',
            border: `1px solid ${
              !aiEnabled || aiInflight ? C.line2 : C.cyan
            }`,
            borderRadius: 3,
            color: !aiEnabled || aiInflight ? C.fg3 : C.cyan,
            fontFamily: 'inherit',
            fontSize: 11, letterSpacing: '0.1em', fontWeight: 600,
            cursor: !aiEnabled || aiInflight ? 'default' : 'pointer',
          }}
        >
          {aiInflight ? 'RUNNING…' : 'RUN AI ANALYSIS NOW'}
        </button>

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
