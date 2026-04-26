'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import type { DataPoint, Pattern } from '@/types/gcp';

function fmtTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_COLOR: Record<string, string> = {
  'Alignment Ladder':   'var(--cyan)',
  'Shock Jump':         'var(--red)',
  'Failed Alignment':   'var(--magenta)',
  'Coherence Volcano':  'var(--amber)',
};
const kindColor = (k: string) => KIND_COLOR[k] || 'var(--fg-2)';

interface GCPChartProps {
  series: DataPoint[];
  patterns: Pattern[];
  cursor: number;
  setCursor: (i: number) => void;
  selectedPatternId: string | null;
  onSelectPattern: (id: string) => void;
  width: number;
  height: number;
}

function GCPChart({
  series, patterns, cursor, setCursor,
  selectedPatternId, onSelectPattern,
  width: W, height: H,
}: GCPChartProps) {
  const padL = 50, padR = 16, padT = 24, padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const viewStart = 0, viewEnd = series.length - 1;
  const total = viewEnd - viewStart;

  const xOf = (i: number) => padL + ((i - viewStart) / total) * innerW;
  const yMin = 0, yMax = 260;
  const yOf = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const bands = useMemo(() => {
    const out: { s: number; e: number; r: string }[] = [];
    let s = 0;
    for (let i = 1; i <= series.length; i++) {
      if (i === series.length || series[i].r !== series[s].r) {
        out.push({ s, e: i - 1, r: series[s].r }); s = i;
      }
    }
    return out;
  }, [series]);

  const linePath = useMemo(() => {
    if (!series.length) return '';
    const step = Math.max(1, Math.floor(series.length / 1600));
    return series.reduce((d, s, i) => {
      if (i % step !== 0) return d;
      return d + (i === 0 ? 'M' : 'L') + xOf(i).toFixed(1) + ' ' + yOf(s.v).toFixed(1) + ' ';
    }, '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, W, H]);

  const svgRef = useRef<SVGSVGElement>(null);
  const handleMove = (e: React.MouseEvent) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < padL || x > W - padR) return;
    const i = Math.round(viewStart + ((x - padL) / innerW) * total);
    setCursor(Math.max(0, Math.min(series.length - 1, i)));
  };

  const yTicks = [0, 50, 100, 140, 170, 220];
  const yTickLabels: Record<number, string> = { 0:'A', 50:'B', 100:'C', 140:'D', 170:'E', 220:'F' };
  const tTicks = Array.from({ length: 9 }, (_, k) => {
    const i = Math.floor(viewStart + (k / 8) * total);
    return { i, x: xOf(i), t: series[i] ? fmtTime(series[i].t) : '' };
  });

  const cursorS = series[cursor];

  return (
    <svg
      ref={svgRef}
      width="100%" height="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onMouseMove={handleMove}
      style={{ display: 'block', cursor: 'crosshair', userSelect: 'none' }}
    >
      {bands.map((b, idx) => (
        <rect key={idx} x={xOf(b.s)} y={padT}
          width={Math.max(0.5, xOf(b.e) - xOf(b.s) + (xOf(1) - xOf(0)))}
          height={innerH} fill={`var(--r-${b.r.toLowerCase()}-bg)`} />
      ))}

      {yTicks.map(yv => (
        <line key={yv} x1={padL} x2={W - padR} y1={yOf(yv)} y2={yOf(yv)}
          stroke="var(--line-1)" strokeWidth={1} strokeDasharray="1 3" />
      ))}

      {yTicks.map((yv, idx) => {
        const next = yTicks[idx + 1] ?? 260;
        const midY = (yOf(yv) + yOf(next)) / 2;
        const letter = yTickLabels[yv];
        return (
          <g key={`ylabel${idx}`}>
            <text x={padL - 10} y={midY + 5} fill={`var(--r-${letter.toLowerCase()})`}
              fontSize={14} fontWeight={600} fontFamily="var(--font-mono)" textAnchor="end" opacity={0.85}>
              {letter}
            </text>
            <text x={padL - 10} y={yOf(yv) - 3} fill="var(--fg-3)" fontSize={9}
              fontFamily="var(--font-mono)" textAnchor="end">{yv}
            </text>
          </g>
        );
      })}

      {tTicks.map((t, idx) => (
        <g key={`tt${idx}`}>
          <line x1={t.x} x2={t.x} y1={H - padB} y2={H - padB + 4} stroke="var(--line-2)" />
          <text x={t.x} y={H - padB + 16} fill="var(--fg-2)" fontSize={9.5} textAnchor="middle" fontFamily="var(--font-mono)">{t.t}</text>
        </g>
      ))}

      {patterns.map((p, idx) => {
        const x1 = xOf(p.start), x2 = xOf(p.end);
        const isSel = selectedPatternId === p.id;
        const color = kindColor(p.kind);
        const abbr =
          p.kind === 'Alignment Ladder'    ? 'AL' :
          p.kind === 'Compression Coil'    ? 'CC' :
          p.kind === 'Compression Release' ? 'CR' :
          p.kind === 'Failed Alignment'    ? 'FA' :
          p.kind === 'Coherence Volcano'   ? 'CV' :
          p.kind === 'Ignition Drift'      ? 'ID' :
          p.kind === 'Shock Jump'          ? 'SJ' :
          (p.kind as string).slice(0, 2).toUpperCase();
        return (
          <g key={p.id} style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); onSelectPattern(p.id); }}>
            <rect x={x1} y={padT} width={x2 - x1} height={innerH}
              fill={isSel ? color : 'none'} fillOpacity={isSel ? 0.06 : 0}
              stroke={color} strokeOpacity={isSel ? 0.7 : 0.3}
              strokeWidth={1} strokeDasharray={isSel ? '0' : '2 2'} />
            <line x1={x1} x2={x2} y1={padT + 2} y2={padT + 2} stroke={color} strokeWidth={1} strokeOpacity={isSel ? 1 : 0.5} />
            {(x2 - x1) > 55 && (
              <text x={(x1 + x2) / 2} y={padT - 6 - (idx % 3) * 11} fill={color} fontSize={9} textAnchor="middle"
                fontFamily="var(--font-mono)" letterSpacing="0.06em" opacity={isSel ? 1 : 0.45}>
                {abbr}
              </text>
            )}
          </g>
        );
      })}

      <path d={linePath} stroke="var(--cyan)" strokeWidth={1.3} fill="none"
        style={{ filter: 'drop-shadow(0 0 3px oklch(0.78 0.14 210 / 0.5))' }} />

      {cursorS && (
        <g>
          <line x1={xOf(cursor)} x2={xOf(cursor)} y1={padT} y2={H - padB}
            stroke="var(--fg-1)" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
          <circle cx={xOf(cursor)} cy={yOf(cursorS.v)} r={3.5} fill="var(--cyan)" stroke="var(--bg-0)" strokeWidth={1.5} />
          <g>
            <rect x={Math.min(W - padR - 140, xOf(cursor) + 8)} y={padT + 6}
              width={132} height={40}
              fill="var(--bg-2)" stroke="var(--line-2)" strokeWidth={1} rx={2} />
            <text x={Math.min(W - padR - 140, xOf(cursor) + 8) + 8} y={padT + 20}
              fill="var(--fg-2)" fontSize={9} fontFamily="var(--font-mono)" letterSpacing="0.08em">
              T {fmtTime(cursorS.t)} · {cursorS.r}
            </text>
            <text x={Math.min(W - padR - 140, xOf(cursor) + 8) + 8} y={padT + 34}
              fill="var(--cyan)" fontSize={12} fontFamily="var(--font-mono)" fontWeight={600}>
              NV {cursorS.v.toFixed(1)}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

export default function GCPChartResponsive(props: Omit<GCPChartProps, 'width' | 'height'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 400 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setDims({ w: Math.max(400, r.width), h: Math.max(200, r.height) });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      <GCPChart {...props} width={dims.w} height={dims.h} />
    </div>
  );
}
