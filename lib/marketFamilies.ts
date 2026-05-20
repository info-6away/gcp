// v15.0 — Phase 15: Symbol archetypes + market families.
//
// The Radar scans 10 symbols as equal isolated cards. This adds a
// contextual grouping layer so the field can be read as an
// ECOSYSTEM — is crypto waking up while FX lags? Are metals leading?
// — instead of ten unrelated reads.
//
// Pure derivation over RadarResults already in hand. NO Engine,
// payload, prompt, GO, action-ladder, pressure, classification or
// scan changes — and no extra Engine calls.

import type { MarketSymbol } from '@/types/gcp';
import type { RadarResult } from '@/lib/radarScan';

export type MarketFamily = 'metals' | 'crypto' | 'fx' | 'risk';

// 'risk' (SPX / NASDAQ / WTI / DXY) is declared for forward
// compatibility — no symbols map to it until that universe lands.
const SYMBOL_FAMILY: Record<MarketSymbol, MarketFamily> = {
  XAUUSD: 'metals', XAGUSD: 'metals',
  BTC:    'crypto', ETH:    'crypto',
  EURUSD: 'fx', GBPUSD: 'fx', AUDUSD: 'fx',
  USDCHF: 'fx', USDCAD: 'fx', USDJPY: 'fx',
};

export const FAMILY_LABEL: Record<MarketFamily, string> = {
  metals: 'Metals',
  crypto: 'Crypto',
  fx:     'Dollar FX',
  risk:   'Risk',
};

export const FAMILY_ORDER: MarketFamily[] = ['metals', 'crypto', 'fx', 'risk'];

export function familyOf(symbol: MarketSymbol): MarketFamily {
  return SYMBOL_FAMILY[symbol];
}

export type FamilyMood = 'strong' | 'improving' | 'mixed' | 'weak' | 'blocked';

export interface FamilyParticipation {
  family:         MarketFamily;
  total:          number;
  ready:          number;
  watch:          number;
  blocked:        number;
  go:             number;
  dominantState:  string;
  dominantAction: string;
  agreementPct:   number;
  mood:           FamilyMood;
}

function argmax(counts: Record<string, number>): { key: string; n: number } {
  let key = '', n = -1;
  for (const [k, v] of Object.entries(counts)) {
    if (v > n) { n = v; key = k; }
  }
  return { key, n };
}

function moodOf(ready: number, watch: number, blocked: number,
                go: number, total: number): FamilyMood {
  if (total === 0) return 'mixed';
  const positive = ready + go;
  if (positive >= Math.ceil(total * 0.5))           return 'strong';
  if (blocked === total)                            return 'blocked';
  if (blocked >= Math.ceil(total * 0.6))            return 'weak';
  if (positive + watch >= Math.ceil(total * 0.5))   return 'improving';
  return 'mixed';
}

export function deriveFamilyParticipation(
  results: RadarResult[],
): FamilyParticipation[] {
  const ok = results.filter(r => r.ok && r.aiState && r.action);
  const out: FamilyParticipation[] = [];

  for (const family of FAMILY_ORDER) {
    const members = ok.filter(r => familyOf(r.symbol) === family);
    if (members.length === 0) continue;
    const total = members.length;

    let ready = 0, watch = 0, blocked = 0, go = 0;
    const actionCounts: Record<string, number> = {};
    const stateCounts:  Record<string, number> = {};
    for (const r of members) {
      const a = r.action!.actionState;
      if      (a === 'READY')   ready++;
      else if (a === 'WATCH')   watch++;
      else if (a === 'BLOCKED') blocked++;
      else if (a === 'GO')      go++;
      actionCounts[a] = (actionCounts[a] ?? 0) + 1;
      const st = `${r.aiState!.stateCode} · ${r.aiState!.phase}`;
      stateCounts[st] = (stateCounts[st] ?? 0) + 1;
    }
    const domAction = argmax(actionCounts);
    const domState  = argmax(stateCounts);

    out.push({
      family, total, ready, watch, blocked, go,
      dominantState:  domState.key,
      dominantAction: domAction.key,
      agreementPct:   Math.round((domAction.n / total) * 100),
      mood:           moodOf(ready, watch, blocked, go, total),
    });
  }
  return out;
}

// ── cross-family divergence ─────────────────────────────────────────

export interface FamilyDivergence {
  detected: boolean;
  summary:  string;
}

const POSITIVE = new Set(['READY', 'GO']);

export function deriveFamilyDivergence(
  families: FamilyParticipation[],
): FamilyDivergence {
  if (families.length < 2) {
    return { detected: false, summary: 'Single family — no comparison.' };
  }
  const actions = new Set(families.map(f => f.dominantAction));
  if (actions.size === 1) {
    return {
      detected: false,
      summary: `Families aligned — all ${[...actions][0]}.`,
    };
  }
  // Strong divergence: one family leans positive while another is blocked.
  const leaders  = families.filter(f => POSITIVE.has(f.dominantAction));
  const laggards = families.filter(f => f.dominantAction === 'BLOCKED');
  if (leaders.length > 0 && laggards.length > 0) {
    const lead = leaders.map(f => `${FAMILY_LABEL[f.family]} ${f.dominantAction}`).join(', ');
    const lag  = laggards.map(f => FAMILY_LABEL[f.family]).join(', ');
    return {
      detected: true,
      summary:  `Cross-family divergence — ${lead}; ${lag} BLOCKED.`,
    };
  }
  // Mild divergence: families simply disagree on the dominant action.
  return {
    detected: true,
    summary:  'Families diverging — no shared dominant action.',
  };
}
