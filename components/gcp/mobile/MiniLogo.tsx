import { C } from './colors';

export function MiniLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-30 -30 60 60">
      <circle r={26} fill="none" stroke={C.cyan} strokeWidth={0.6}
        strokeDasharray="1.5 3" opacity={0.7} />
      <circle r={18} fill="none" stroke={C.cyan} strokeWidth={0.9} />
      <path d="M -22 0 Q -16 0 -10 0 T -5 -1 Q -2 -3 0 -22 Q 2 -3 5 -1 T 10 0 T 22 0"
        fill="none" stroke={C.cyan} strokeWidth={1.4} />
      <circle cx={0} cy={-22} r={1.8} fill={C.amber} />
      <circle r={1.6} fill={C.cyan} />
    </svg>
  );
}
