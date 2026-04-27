'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import type { DataPoint, MarketSymbol } from '@/types/gcp';
import { fetchCandlesForWindow, type Candle } from '@/lib/fetchCandles';

const TD_SYMBOLS: Record<MarketSymbol, string> = {
  XAUUSD: 'XAU/USD',
  BTC:    'BTC/USD',
  XAGUSD: 'XAG/USD',
};

interface ScatterPoint {
  regime: string;
  fwdPct: number;
  t:      number;
  nv:     number;
}

const REGIME_META: Record<string, { label: string; color: string; x: number }> = {
  A: { label: 'A · Silence',         color: '#4a72c4', x: 1 },
  B: { label: 'B · Ignition',        color: '#4dd9e8', x: 2 },
  C: { label: 'C · Alignment',       color: '#2db8b4', x: 3 },
  D: { label: 'D · Synchronization', color: '#d4a028', x: 4 },
  E: { label: 'E · Climax',          color: '#d46428', x: 5 },
  F: { label: 'F · Shock',           color: '#e24b4a', x: 6 },
};

function regimeFor(v: number): string {
  if (v < 50)  return 'A';
  if (v < 100) return 'B';
  if (v < 140) return 'C';
  if (v < 170) return 'D';
  if (v < 220) return 'E';
  return 'F';
}

const FWD_LABEL: Record<number, string> = {
  1: '15m', 2: '30m', 4: '1h', 8: '2h', 16: '4h',
};

interface ResearchViewProps {
  series: DataPoint[];
  symbol: MarketSymbol;
}

export default function ResearchView({ series, symbol }: ResearchViewProps) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [fwdBars, setFwdBars] = useState(4);
  const [hovered, setHovered] = useState<ScatterPoint | null>(null);
  const svgRef          = useRef<SVGSVGElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [W, setW]       = useState(720);

  useEffect(() => {
    if (!svgContainerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      setW(Math.max(420, Math.floor(w) - 16));
    });
    ro.observe(svgContainerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCandlesForWindow(TD_SYMBOLS[symbol], '15m', 500, Date.now())
      .then(data => { if (!cancelled) setCandles(data); })
      .catch(e   => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol]);

  const scatterPoints = useMemo<ScatterPoint[]>(() => {
    if (!candles.length || !series.length) return [];

    const gcpByTs = new Map<number, { v: number; r: string }>();
    series.forEach(p => {
      gcpByTs.set(Math.floor(p.t / 1000), { v: p.v, r: p.r ?? regimeFor(p.v) });
    });

    const points: ScatterPoint[] = [];
    for (let i = 0; i < candles.length - fwdBars; i++) {
      const c    = candles[i];
      const cFwd = candles[i + fwdBars];
      if (c.c <= 0) continue;

      const ts = Math.floor(c.t / 1000);
      let gcpPt = gcpByTs.get(ts);
      if (!gcpPt) {
        for (let d = 60; d <= 300; d += 60) {
          gcpPt = gcpByTs.get(ts - d) ?? gcpByTs.get(ts + d);
          if (gcpPt) break;
        }
      }
      if (!gcpPt) continue;

      const fwdPct = ((cFwd.c - c.c) / c.c) * 100;
      points.push({
        regime: gcpPt.r,
        fwdPct: +fwdPct.toFixed(3),
        t:      c.t,
        nv:     gcpPt.v,
      });
    }
    return points;
  }, [candles, series, fwdBars]);

  const stats = useMemo(() => {
    const map: Record<string, { pts: ScatterPoint[]; avg: number; bull: number; bear: number }> = {};
    for (const r of 'ABCDEF') {
      const pts  = scatterPoints.filter(p => p.regime === r);
      const avg  = pts.length ? pts.reduce((s, p) => s + p.fwdPct, 0) / pts.length : 0;
      const bull = pts.filter(p => p.fwdPct >  0.05).length;
      const bear = pts.filter(p => p.fwdPct < -0.05).length;
      map[r] = { pts, avg, bull, bear };
    }
    return map;
  }, [scatterPoints]);

  const H = 400;
  const PAD = { l: 56, r: 24, t: 24, b: 60 };
  const IW  = W - PAD.l - PAD.r;
  const IH  = H - PAD.t - PAD.b;

  const Y_MAX = 3, Y_MIN = -3;
  const yOf = (pct: number) =>
    PAD.t + (1 - (Math.max(Y_MIN, Math.min(Y_MAX, pct)) - Y_MIN) / (Y_MAX - Y_MIN)) * IH;

  const xOf = (regime: string) => {
    const meta = REGIME_META[regime];
    if (!meta) return PAD.l;
    return PAD.l + ((meta.x - 0.5) / 6) * IW;
  };

  const jitter = (i: number) => (Math.sin(i * 9301 + 49297) * 0.5) * (IW / 6) * 0.35;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
    }}>
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--line-1)',
        display: 'flex', alignItems: 'center', gap: 12,
        flexShrink: 0, fontSize: 10,
      }}>
        <span style={{ color: 'var(--fg-0)', fontWeight: 600, letterSpacing: '0.04em' }}>
          RESEARCH
        </span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-2)' }}>GCP Regime → Price Correlation</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span style={{ color: 'var(--fg-3)' }}>{symbol}</span>

        <div style={{ flex: 1 }} />

        <span style={{ color: 'var(--fg-4)', fontSize: 9 }}>FORWARD</span>
        {[1, 2, 4, 8, 16].map(n => (
          <button key={n}
            onClick={() => setFwdBars(n)}
            style={{
              padding: '2px 7px', fontSize: 9,
              fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
              background: fwdBars === n ? 'var(--bg-3)' : 'transparent',
              border: `1px solid ${fwdBars === n ? 'var(--line-2)' : 'transparent'}`,
              borderRadius: 2,
              color: fwdBars === n ? 'var(--fg-0)' : 'var(--fg-3)',
              cursor: 'pointer',
            }}
          >
            {FWD_LABEL[n]}
          </button>
        ))}

        <span style={{ color: 'var(--fg-4)', fontSize: 9, marginLeft: 8 }}>
          {scatterPoints.length} bars
        </span>
      </div>

      {loading && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: 'var(--fg-4)', letterSpacing: '0.1em',
        }}>
          LOADING PRICE DATA…
        </div>
      )}

      {error && !loading && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, color: 'var(--red)', letterSpacing: '0.08em',
        }}>
          PRICE FETCH ERROR · {error.slice(0, 100)}
        </div>
      )}

      {!loading && !error && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--line-0)',
            fontSize: 9, lineHeight: 1.6, color: 'var(--fg-2)',
            flexShrink: 0,
          }}>
            <span style={{ color: 'var(--fg-0)', fontWeight: 600 }}>How to read this: </span>
            Each dot = one 15 m price bar, colored by whether price went{' '}
            <span style={{ color: '#22c55e' }}>up ↑</span> or{' '}
            <span style={{ color: '#ef4444' }}>down ↓</span> over the next {FWD_LABEL[fwdBars]}.
            X-axis is the GCP regime active when the bar opened; the horizontal line per column
            is the average move in that regime.{' '}
            <span style={{ color: '#d4a028' }}>
              D regime trending positive would mean GCP synchronization tends to precede upward price moves.
            </span>
          </div>

          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', gap: 0 }}>
          <div ref={svgContainerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', padding: '16px 0 0 0' }}>
            <svg
              ref={svgRef}
              width={W} height={H}
              style={{ display: 'block' }}
              onMouseLeave={() => setHovered(null)}
            >
              {[-2, -1, 0, 1, 2].map(pct => (
                <g key={pct}>
                  <line
                    x1={PAD.l} x2={W - PAD.r}
                    y1={yOf(pct)} y2={yOf(pct)}
                    stroke={pct === 0 ? '#2a2f37' : '#15181d'}
                    strokeWidth={pct === 0 ? 1 : 0.5}
                    strokeDasharray={pct === 0 ? '' : '2 4'}
                  />
                  <text
                    x={PAD.l - 6} y={yOf(pct) + 3}
                    textAnchor="end"
                    fontSize={9} fill="#464c56"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {pct > 0 ? '+' : ''}{pct}%
                  </text>
                </g>
              ))}

              {Object.entries(REGIME_META).map(([r, meta]) => {
                const cx = PAD.l + ((meta.x - 0.5) / 6) * IW;
                const bw = IW / 6;
                return (
                  <rect key={r}
                    x={cx - bw / 2} y={PAD.t}
                    width={bw} height={IH}
                    fill={`${meta.color}08`}
                  />
                );
              })}

              {scatterPoints.map((pt, i) => {
                const x = xOf(pt.regime) + jitter(i);
                const y = yOf(pt.fwdPct);
                const isUp   = pt.fwdPct >  0.05;
                const isFlat = Math.abs(pt.fwdPct) <= 0.05;
                const col    = isUp ? '#22c55e' : isFlat ? '#464c56' : '#ef4444';
                return (
                  <circle key={i}
                    cx={x} cy={y} r={2.5}
                    fill={col} opacity={0.5}
                    style={{ cursor: 'crosshair' }}
                    onMouseEnter={() => setHovered(pt)}
                  />
                );
              })}

              {Object.entries(stats).map(([r, s]) => {
                if (s.pts.length < 3) return null;
                const cx  = xOf(r);
                const y   = yOf(s.avg);
                const col = REGIME_META[r]?.color ?? '#fff';
                return (
                  <g key={r}>
                    <line
                      x1={cx - 20} x2={cx + 20}
                      y1={y} y2={y}
                      stroke={col} strokeWidth={2}
                    />
                    <text
                      x={cx} y={y - 6}
                      textAnchor="middle"
                      fontSize={8} fill={col}
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                    </text>
                  </g>
                );
              })}

              {Object.entries(REGIME_META).map(([r, meta]) => (
                <text key={r}
                  x={PAD.l + ((meta.x - 0.5) / 6) * IW}
                  y={H - PAD.b + 16}
                  textAnchor="middle"
                  fontSize={9} fill={meta.color}
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {r}
                </text>
              ))}
              {Object.entries(REGIME_META).map(([r, meta]) => (
                <text key={`${r}-label`}
                  x={PAD.l + ((meta.x - 0.5) / 6) * IW}
                  y={H - PAD.b + 28}
                  textAnchor="middle"
                  fontSize={8} fill="#2a2f37"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {meta.label.split('·')[1]?.trim()}
                </text>
              ))}

              <text
                x={14} y={PAD.t + IH / 2}
                textAnchor="middle" fontSize={8} fill="#464c56"
                fontFamily="IBM Plex Mono, monospace"
                transform={`rotate(-90, 14, ${PAD.t + IH / 2})`}
              >
                PRICE CHANGE {FWD_LABEL[fwdBars]} FORWARD
              </text>

              {hovered && (
                <circle
                  cx={xOf(hovered.regime) + jitter(scatterPoints.indexOf(hovered))}
                  cy={yOf(hovered.fwdPct)}
                  r={5}
                  fill="none" stroke="white" strokeWidth={1.5}
                />
              )}
            </svg>

            {hovered && (
              <div style={{
                position: 'absolute', top: 20, right: 20,
                background: 'var(--bg-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 3, padding: '6px 10px',
                fontSize: 9, fontFamily: 'var(--font-mono)',
              }}>
                <div style={{ color: REGIME_META[hovered.regime]?.color, marginBottom: 3 }}>
                  {REGIME_META[hovered.regime]?.label}
                </div>
                <div style={{ color: hovered.fwdPct > 0 ? '#22c55e' : '#ef4444' }}>
                  {hovered.fwdPct > 0 ? '+' : ''}{hovered.fwdPct.toFixed(3)}%
                </div>
                <div style={{ color: 'var(--fg-4)', marginTop: 2 }}>
                  NV {hovered.nv.toFixed(1)}
                </div>
                <div style={{ color: 'var(--fg-4)' }}>
                  {new Date(hovered.t).toLocaleDateString()} {new Date(hovered.t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
                </div>
              </div>
            )}
          </div>

          <div style={{
            width: 200, borderLeft: '1px solid var(--line-1)',
            padding: '16px 14px', overflow: 'auto',
            flexShrink: 0,
          }}>
            <div style={{
              fontSize: 8, letterSpacing: '0.12em',
              color: 'var(--fg-4)', marginBottom: 12,
            }}>
              REGIME SUMMARY
            </div>

            {Object.entries(REGIME_META).map(([r, meta]) => {
              const s = stats[r];
              if (!s) return null;
              const bullPct = s.pts.length ? (s.bull / s.pts.length * 100) : 0;
              return (
                <div key={r} style={{
                  marginBottom: 12, paddingBottom: 12,
                  borderBottom: '1px solid var(--line-0)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: meta.color, fontSize: 10, fontWeight: 600 }}>{r}</span>
                    <span style={{
                      fontSize: 10, fontVariantNumeric: 'tabular-nums',
                      color: s.avg > 0.02 ? '#22c55e' : s.avg < -0.02 ? '#ef4444' : 'var(--fg-3)',
                    }}>
                      {s.avg > 0 ? '+' : ''}{s.avg.toFixed(2)}%
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, fontSize: 8, color: 'var(--fg-4)' }}>
                    <span>{s.pts.length} bars</span>
                    <span style={{ color: '#22c55e' }}>{s.bull}↑</span>
                    <span style={{ color: '#ef4444' }}>{s.bear}↓</span>
                    <span>{bullPct.toFixed(0)}% bull</span>
                  </div>
                  <div style={{
                    height: 3, background: '#ef4444',
                    borderRadius: 1, marginTop: 4, overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%', background: '#22c55e',
                      width: `${bullPct}%`, borderRadius: 1,
                    }} />
                  </div>
                </div>
              );
            })}

            <div style={{
              fontSize: 8, color: 'var(--fg-4)',
              lineHeight: 1.5, marginTop: 8,
            }}>
              Avg line = mean price change across all bars in that regime.
              Bull/bear bar = % of bars with positive outcome.
            </div>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
