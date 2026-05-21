// v18.3 — Phase 18.3: Trigger Engine.
//
// Converts a Guru read into actionable activation conditions. Sits
// between Guru's "WAIT / WATCH / READY / GO" verdict and Trade's
// order entry, answering the question:
//
//   "What specifically must happen for me to act?"
//
// Pure downstream derivation. The Engine, prompts, payloads, Radar
// scan logic, Research persistence, GO thresholds, action ladder,
// pressure / dominance calculations and trade math are all unchanged.
// This module only relabels the existing read in trade-actionable form.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { PriceStructureRead } from '@/lib/priceStructureConfirmation';
import type { MarketSymbol } from '@/types/gcp';
import { formatPrice } from '@/types/gcp';

export type TriggerStatus =
  | 'waiting'      // setup forming; activation not yet possible
  | 'armed'        // activation imminent; one or two checks short
  | 'triggered'    // activation conditions met; trade thesis live
  | 'invalidated'; // setup broken or shock event; stand down

export type TriggerType =
  | 'breakout'
  | 'continuation'
  | 'reversal'
  | 'compression'
  | 'shock';

export interface TriggerCondition {
  /** Short label, e.g. "Price > 4512" or "Clarity > 55%". */
  text: string;
  /** Whether this condition is currently satisfied. `undefined` when
   *  the helper can't evaluate it (e.g. no candle / price context). */
  met?: boolean;
}

export interface TriggerState {
  /** Headline stance the trigger projects to Trade ("WAIT", "BREAK",
   *  "TREND ON", "FADE", "STAND DOWN", "WATCH"). One word, large. */
  stance:        string;
  status:        TriggerStatus;
  triggerType:   TriggerType;
  /** What needs to happen for the trigger to fire. */
  activation:    TriggerCondition[];
  /** What invalidates the setup. */
  invalidation:  TriggerCondition[];
  /** 0-100 confidence in the trigger. Drives PLAN-mode UI weight. */
  confidence:    number;
  /** Plain-English trigger description. One short sentence. */
  triggerText:   string;
  /** Why this trigger fits the current read. One short sentence. */
  triggerReason: string;
  /** Hex color matching the status. */
  color:         string;
}

const STATUS_COLOR: Record<TriggerStatus, string> = {
  waiting:     '#d4a028',
  armed:       '#4dd9e8',
  triggered:   '#22c55e',
  invalidated: '#c45a5a',
};

const STATES_INVALIDATING = new Set(['SH', 'DS', 'FA']);

function fmt(price: number | undefined, symbol: MarketSymbol): string {
  if (price == null) return '—';
  return formatPrice(price, symbol);
}

function ensureMet(cond: boolean | undefined): boolean | undefined {
  return cond === undefined ? undefined : cond;
}

function awaiting(): TriggerState {
  return {
    stance:        'WATCH',
    status:        'waiting',
    triggerType:   'compression',
    activation:    [],
    invalidation:  [],
    confidence:    0,
    triggerText:   'Awaiting Guru classification.',
    triggerReason: 'No read yet — Ask Guru to seed a trigger.',
    color:         STATUS_COLOR.waiting,
  };
}

// ────────────────────────────────────────────────────────────────────
// Public: deriveTriggerState
// ────────────────────────────────────────────────────────────────────

export function deriveTriggerState(args: {
  aiState:        GcpStateResponse | null;
  priceStructure: PriceStructureRead | null;
  currentPrice:   number | null;
  symbol:         MarketSymbol;
}): TriggerState {
  const { aiState, priceStructure: ps, currentPrice, symbol } = args;
  if (!aiState) return awaiting();

  const code   = aiState.stateCode;
  const phase  = aiState.phase;
  const dir    = aiState.direction;
  const conf   = aiState.confidence ?? 0;
  const clarPc = Math.round(conf * 100);
  const invs   = aiState.invalidators ?? [];
  const rh     = ps?.levels.rangeHigh;
  const rl     = ps?.levels.rangeLow;
  const cl     = currentPrice;

  // Shared activation builders.
  const clarityCond = (threshold: number): TriggerCondition => ({
    text: `Clarity > ${threshold}%`,
    met:  conf * 100 > threshold,
  });

  // ── SH (Shock) — invalidated, wait for stabilization ───
  if (code === 'SH') {
    return {
      stance:        'STAND DOWN',
      status:        'invalidated',
      triggerType:   'shock',
      activation:    [
        { text: 'Wait for CS / DS to anchor', met: undefined },
        { text: 'Volatility settles', met: undefined },
      ],
      invalidation:  [],
      confidence:    clarPc,
      triggerText:   'Shock event — no trigger active.',
      triggerReason: 'Stabilization must form before any entry can be evaluated.',
      color:         STATUS_COLOR.invalidated,
    };
  }

  // ── DS (Discharge) — unwinding; treat as invalidated ───
  if (code === 'DS') {
    return {
      stance:        'STAND DOWN',
      status:        'invalidated',
      triggerType:   'shock',
      activation:    [
        { text: 'Wait for recompression (CS)', met: undefined },
      ],
      invalidation:  [],
      confidence:    clarPc,
      triggerText:   'Discharge in progress — no clean trigger.',
      triggerReason: 'Energy unwinding; wait for a fresh compression.',
      color:         STATUS_COLOR.invalidated,
    };
  }

  // ── FA (Failed Alignment) — reversal setup, short side ───
  if (code === 'FA') {
    const supportText = rl ? `Price < ${fmt(rl, symbol)}` : 'Price loses local support';
    const supportMet  = (rl != null && cl != null) ? cl < rl : undefined;
    const armed = invs.length <= 1 && supportMet === true;
    return {
      stance:        armed ? 'FADE' : 'FADE PENDING',
      status:        armed ? 'armed' : 'waiting',
      triggerType:   'reversal',
      activation:    [
        { text: supportText, met: supportMet },
        clarityCond(50),
        { text: 'Bearish structure confirmed', met: ps?.structure === 'bearish' },
      ],
      invalidation:  [
        rh ? { text: `Reclaim ${fmt(rh, symbol)}`, met: (cl != null && rh != null) ? cl > rh : undefined }
           : { text: 'Range high reclaimed', met: undefined },
      ],
      confidence:    clarPc,
      triggerText:   armed
        ? 'Short bias active — entry on local support break.'
        : 'Watching for short bias below local support.',
      triggerReason: 'Failed alignment — fade / reversal regime.',
      color:         armed ? STATUS_COLOR.armed : STATUS_COLOR.waiting,
    };
  }

  // ── CL (Climax) — reversal setup; positional fade ───
  if (code === 'CL') {
    return {
      stance:        'FADE PENDING',
      status:        'waiting',
      triggerType:   'reversal',
      activation:    [
        { text: 'Reversal candle confirms', met: undefined },
        clarityCond(50),
      ],
      invalidation:  [
        rh ? { text: `Continuation > ${fmt(rh, symbol)}`, met: (cl != null && rh != null) ? cl > rh : undefined }
           : { text: 'Trend extends without pause', met: undefined },
      ],
      confidence:    clarPc,
      triggerText:   'Climax — awaiting reversal confirmation.',
      triggerReason: 'Late move; reversion risk elevated.',
      color:         STATUS_COLOR.waiting,
    };
  }

  // ── DD (Dead Drift) — no signal, hard waiting ───
  if (code === 'DD' || code === 'DC') {
    return {
      stance:        'WAIT',
      status:        'waiting',
      triggerType:   'compression',
      activation:    [
        { text: 'New compression (CS) forms', met: undefined },
        { text: 'Directional edge appears', met: undefined },
      ],
      invalidation:  [],
      confidence:    clarPc,
      triggerText:   code === 'DC' ? 'Directional decay — no edge.' : 'Dead drift — no signal.',
      triggerReason: 'Field flat. Stand by until a fresh compression seeds a trigger.',
      color:         STATUS_COLOR.waiting,
    };
  }

  // ── CS (Compression) — WAITING for breakout. Spec default. ───
  if (code === 'CS') {
    const breakHi = rh && cl != null ? cl > rh : undefined;
    const breakLo = rl && cl != null ? cl < rl : undefined;
    const upActivation: TriggerCondition[] = [
      rh
        ? { text: `Price > ${fmt(rh, symbol)}`, met: breakHi }
        : { text: 'Break above local resistance', met: undefined },
      clarityCond(55),
      { text: 'NV slope ↑ positive', met: undefined },
    ];
    const downActivation: TriggerCondition[] = [
      rl
        ? { text: `Price < ${fmt(rl, symbol)}`, met: breakLo }
        : { text: 'Break below local support', met: undefined },
      clarityCond(55),
      { text: 'NV slope ↓ negative', met: undefined },
    ];
    // Direction-biased activation, but show both legs when neutral.
    const activation =
        dir === 'Up'   ? upActivation
      : dir === 'Down' ? downActivation
      :                  [...upActivation, ...downActivation];
    const invalidation: TriggerCondition[] = [];
    if (dir === 'Up' && rl) {
      invalidation.push({
        text: `Loses ${fmt(rl, symbol)}`,
        met:  breakLo,
      });
    } else if (dir === 'Down' && rh) {
      invalidation.push({
        text: `Reclaims ${fmt(rh, symbol)}`,
        met:  breakHi,
      });
    }
    const armed = breakHi === true || breakLo === true;
    return {
      stance:        armed ? 'BREAK' : 'WAIT',
      status:        armed ? 'armed' : 'waiting',
      triggerType:   'breakout',
      activation,
      invalidation,
      confidence:    clarPc,
      triggerText:   armed
        ? 'Compression breaking — entry window opening.'
        : (rh && dir === 'Up')   ? `Breakout above ${fmt(rh, symbol)} arms the long.`
        : (rl && dir === 'Down') ? `Break below ${fmt(rl, symbol)} arms the short.`
        :                          'Awaiting compression breakout.',
      triggerReason: phase === 'Late' || phase === 'Exhausted'
        ? 'Compression aging — decay risk if no breakout soon.'
        : 'Compression unresolved.',
      color:         armed ? STATUS_COLOR.armed : STATUS_COLOR.waiting,
    };
  }

  // ── IS (Ignition) — ARMED. Confirmation pending. ───
  if (code === 'IS') {
    const confirmed = ps?.confirmation === 'confirmed';
    const activation: TriggerCondition[] = [
      { text: dir === 'Up' ? 'Bullish confirmation candle'
            : dir === 'Down' ? 'Bearish confirmation candle'
            : 'Directional confirmation candle',
        met:  confirmed },
      clarityCond(50),
      { text: 'No invalidator triggered', met: invs.length === 0 },
    ];
    const invalidation: TriggerCondition[] = [];
    if (dir === 'Up' && rl) {
      invalidation.push({
        text: `Loses ${fmt(rl, symbol)}`,
        met:  (cl != null && rl != null) ? cl < rl : undefined,
      });
    } else if (dir === 'Down' && rh) {
      invalidation.push({
        text: `Reclaims ${fmt(rh, symbol)}`,
        met:  (cl != null && rh != null) ? cl > rh : undefined,
      });
    }
    const status: TriggerStatus =
      confirmed && conf >= 0.50 && invs.length === 0 ? 'triggered' : 'armed';
    return {
      stance:        status === 'triggered' ? 'IGNITE' : 'IGNITE PENDING',
      status,
      triggerType:   'breakout',
      activation,
      invalidation,
      confidence:    clarPc,
      triggerText:   status === 'triggered'
        ? 'Ignition confirmed — entry permitted.'
        : 'Ignition forming — confirmation pending.',
      triggerReason: 'Compression resolved; pressure now directional.',
      color:         STATUS_COLOR[status],
    };
  }

  // ── AT (Alignment Trend) — TRIGGERED. Trend in progress. ───
  if (code === 'AT') {
    const phaseLate = phase === 'Late' || phase === 'Exhausted';
    const activation: TriggerCondition[] = [
      { text: 'Continuation active', met: !phaseLate },
      clarityCond(50),
    ];
    const invalidation: TriggerCondition[] = [];
    if (dir === 'Up' && rl) {
      invalidation.push({
        text: `Trend break — loses ${fmt(rl, symbol)}`,
        met:  (cl != null && rl != null) ? cl < rl : undefined,
      });
    } else if (dir === 'Down' && rh) {
      invalidation.push({
        text: `Trend break — reclaims ${fmt(rh, symbol)}`,
        met:  (cl != null && rh != null) ? cl > rh : undefined,
      });
    }
    const status: TriggerStatus = phaseLate ? 'armed' : 'triggered';
    return {
      stance:        status === 'triggered' ? 'TREND ON' : 'TREND AGING',
      status,
      triggerType:   'continuation',
      activation,
      invalidation,
      confidence:    clarPc,
      triggerText:   status === 'triggered'
        ? 'Trend in motion — ride continuation.'
        : 'Trend in late phase — tighten stops.',
      triggerReason: phaseLate
        ? 'Alignment aging; reversion risk rising.'
        : 'Alignment trend — directional persistence high.',
      color:         STATUS_COLOR[status],
    };
  }

  // ── SS (Synchronization) — ARMED. Extension confirmation. ───
  if (code === 'SS') {
    const activation: TriggerCondition[] = [
      { text: 'Extension confirms', met: ps?.confirmation === 'confirmed' },
      clarityCond(55),
    ];
    const invalidation: TriggerCondition[] = [];
    if (dir === 'Up' && rl) {
      invalidation.push({
        text: `Sync breaks — loses ${fmt(rl, symbol)}`,
        met:  (cl != null && rl != null) ? cl < rl : undefined,
      });
    } else if (dir === 'Down' && rh) {
      invalidation.push({
        text: `Sync breaks — reclaims ${fmt(rh, symbol)}`,
        met:  (cl != null && rh != null) ? cl > rh : undefined,
      });
    }
    return {
      stance:        'EXTEND',
      status:        'armed',
      triggerType:   'continuation',
      activation,
      invalidation,
      confidence:    clarPc,
      triggerText:   'Sync holding — entry on extension confirmation.',
      triggerReason: 'Multi-bar alignment; trade with the persistence.',
      color:         STATUS_COLOR.armed,
    };
  }

  // ── Fallback for any state not explicitly mapped. ──────
  void ensureMet; // referenced for type guard symmetry in future maps.
  void STATES_INVALIDATING;
  return {
    stance:        'WAIT',
    status:        'waiting',
    triggerType:   'compression',
    activation:    [{ text: 'Clearer Guru read', met: undefined }],
    invalidation:  [],
    confidence:    clarPc,
    triggerText:   `${code} · ${phase} — no specific trigger mapped.`,
    triggerReason: 'Hold off until the state resolves into a recognised setup.',
    color:         STATUS_COLOR.waiting,
  };
}

// ────────────────────────────────────────────────────────────────────
// Stage progression — drives the [ENVIRONMENT] → [TRIGGER] → [EXECUTION] visual
// ────────────────────────────────────────────────────────────────────

export type TriggerStage = 'environment' | 'trigger' | 'execution';

/** Which stage the user is currently in, given a trigger state. */
export function activeStage(status: TriggerStatus): TriggerStage {
  if (status === 'invalidated') return 'environment';
  if (status === 'triggered')   return 'execution';
  if (status === 'armed')       return 'trigger';
  return 'environment';
}

export const STAGE_LABEL: Record<TriggerStage, string> = {
  environment: 'ENVIRONMENT',
  trigger:     'TRIGGER',
  execution:   'EXECUTION',
};

export { STATUS_COLOR };
