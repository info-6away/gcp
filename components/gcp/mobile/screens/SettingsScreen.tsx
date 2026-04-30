'use client';

import { C } from '../colors';
import { MobileStatus } from '../MobileChrome';
import { APP_VERSION } from '@/lib/version';
import type { GcpStateResponse } from '@/lib/engine-gcp';
import { useCountdown } from '@/lib/useCountdown';

type ConnPhase = 'initial' | 'connected' | 'reconnecting' | 'disabled';

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

  const aiRows: { label: string; val: string; valColor: string; sub?: string }[] = [
    { label: 'Status', val: aiStatusLabel, valColor: aiStatusColor,
      sub: aiPhase === 'initial'      ? '6away Engine · 25s poll · waiting for first response'
         : aiPhase === 'reconnecting' ? '6away Engine · 25s poll · keeping prior state'
         : aiPhase === 'disabled'     ? 'Polling is off'
         : '6away Engine · /v1/coherence/gcp-state' },
  ];
  if (aiPhase === 'initial') {
    aiRows.push({ label: 'Next check in', val: `${aiNextSecs}s`, valColor: C.fg1,
      sub: 'First Engine classification will arrive shortly' });
  } else if (aiPhase === 'connected') {
    aiRows.push(
      { label: 'Last update',    val: formatRelative(aiLastSuccess), valColor: C.fg2 },
      { label: 'Next update in', val: `${aiNextSecs}s`,              valColor: C.fg1 },
    );
  } else if (aiPhase === 'reconnecting') {
    aiRows.push(
      { label: 'Last error', val: formatRelative(aiLastError), valColor: C.red,
        sub: aiLastSuccess ? `Last success ${formatRelative(aiLastSuccess)}` : 'No successful classification yet' },
      { label: 'Retry in',   val: `${aiNextSecs}s`,            valColor: C.fg1 },
    );
  }
  if (aiState) {
    aiRows.push(
      { label: 'Current State',         val: `${aiState.stateCode} · ${aiState.state}`,                              valColor: C.fg1 },
      { label: 'Direction / Phase',     val: `${aiState.direction} · ${aiState.phase}`,                              valColor: C.fg1 },
      { label: 'Strength / Confidence', val: `${aiState.strength.toFixed(2)} · ${(aiState.confidence * 100).toFixed(0)}%`, valColor: C.fg1 },
    );
  }

  const cohRows: { label: string; val: string; valColor: string; sub?: string }[] = [
    { label: 'Status', val: gcpStatusLabel, valColor: gcpStatusColor,
      sub: gcpPhase === 'initial'      ? 'gcp2.net · 120s poll · fetching first sample'
         : gcpPhase === 'reconnecting' ? 'gcp2.net · 120s poll · last fetch failed, will retry'
         : 'gcp2.net · 120s poll · browser direct' },
    { label: 'Last update',
      val:  gcpPhase === 'initial' ? '—' : formatRelative(gcpLastUpdate),
      valColor: C.fg2 },
    { label: 'Next update in', val: `${gcpNextSecs}s`, valColor: C.fg1 },
  ];
  if (liveNV != null) {
    cohRows.push({ label: 'Net Variance', val: `${liveNV.toFixed(1)} NV`, valColor: C.fg1 });
  }

  const sysRows = [
    { label: 'Historical GCP',  val: `${seriesLength.toLocaleString()} pts`, valColor: C.fg2 },
    { label: 'Version',         val: APP_VERSION, valColor: C.fg2 },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MobileStatus nv={liveNV} regime={liveRegime} connected={connected}
        aiState={aiState} aiEnabled={aiEnabled} />

      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.line1}`, background: C.bg, flexShrink: 0 }}>
        <div style={{ fontSize: 8, letterSpacing: '0.18em', color: C.fg3 }}>SYSTEM</div>
        <div style={{ fontSize: 18, color: C.fg0, fontWeight: 600, marginTop: 2 }}>SETTINGS</div>
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
                <div style={{ fontSize: 9, color: C.fg4, marginTop: 2 }}>{row.sub}</div>
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
                  <div style={{ fontSize: 9, color: C.fg4, marginTop: 2 }}>{row.sub}</div>
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
        <div style={{ background: C.bg1, border: `1px solid ${C.line1}`, borderRadius: 3, marginBottom: 16 }}>
          {aiRows.map((row, i) => (
            <div key={row.label} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 14px', gap: 10,
              borderBottom: i < aiRows.length - 1 ? `1px solid ${C.line0}` : 'none',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: C.fg1 }}>{row.label}</div>
                {row.sub && (
                  <div style={{ fontSize: 9, color: C.fg4, marginTop: 2 }}>{row.sub}</div>
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
