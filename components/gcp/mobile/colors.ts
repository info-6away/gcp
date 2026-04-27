export const C = {
  bg:    '#07080a',
  bg1:   '#0d0f12',
  bg2:   '#131619',
  bg3:   '#1a1e24',
  line0: '#0f1114',
  line1: '#15181d',
  line2: '#1c2026',
  fg0:   '#e7eaf0',
  fg1:   '#aeb4bf',
  fg2:   '#6b7280',
  fg3:   '#464c56',
  fg4:   '#2a2f37',
  cyan:  '#4dd9e8',
  amber: '#d4a028',
  green: '#22c55e',
  red:   '#ef4444',
  purple:'#d946ef',
  rA: '#4a72c4', rB: '#4dd9e8', rC: '#2db8b4',
  rD: '#d4a028', rE: '#d46428', rF: '#e24b4a',
} as const;

export const regimeColor = (r: string): string =>
  (C[('r' + r) as keyof typeof C] as string) ?? C.fg2;

export const regimeBg: Record<string, string> = {
  A: 'rgba(59,90,160,0.13)',
  B: 'rgba(50,130,180,0.13)',
  C: 'rgba(40,180,175,0.13)',
  D: 'rgba(200,160,40,0.16)',
  E: 'rgba(210,100,40,0.16)',
  F: 'rgba(220,50,50,0.20)',
};
