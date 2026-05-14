// v13.0: Trade module — pure execution intelligence helpers.
//
// Three deterministic derivations the Trade view consumes:
//
//   deriveEnvironmentRisk()  → Stable / Fragile / Transitional / Volatile / Exhausted
//   deriveHistoricalAnalog() → "Last N <state>-<phase>: ↑/↓ avg X% / N samples"
//   deriveThesisIntegrity()  → 'intact' | 'drift' | 'invalidated' for an open position
//
// All pure functions. No DOM, no React. Inputs are already-resolved
// GcpStateResponse + aiStateHistory + open-position context — same
// shapes everything else in the Trade module already reads.

import type { GcpStateResponse } from '@/lib/engine-gcp';
import type { AiStateHistoryRecord } from '@/lib/aiStateHistory';

// ──────────────────────────────────────────────────────────────────
// 1. Environment risk
// ──────────────────────────────────────────────────────────────────

export type EnvironmentRisk =
  | 'Stable'
  | 'Fragile'
  | 'Transitional'
  | 'Volatile'
  | 'Exhausted';

export interface EnvironmentRiskRead {
  label:   EnvironmentRisk;
  /** Hex color matching the rest of the GCP Pro palette. */
  color:   string;
  /** One-line explanation surfaced under the chip. */
  hint:    string;
}

/**
 * Project the current AI state + transition + pressure into a coarse
 * "how dangerous is this environment" label.
 *
 *   Stable        — clean trend / sync, strong skew, no transition
 *                   warning. Low chop risk.
 *   Transitional  — anchored state has a non-trivial transition target
 *                   (next likely state). Edges might flip soon.
 *   Fragile       — low read clarity AND/OR weak pressure.
 *                   Reads can degrade without warning.
 *   Volatile      — Shock / Climax / Failed-Alignment states. Whip
 *                   risk + headline event risk dominate.
 *   Exhausted     — Late / Exhausted phase of a directional state, or
 *                   active Plateau State / Discharge. Trend energy
 *                   has run out; new entries are off the table.
 */
export function deriveEnvironmentRisk(
  aiState: GcpStateResponse | null,
): EnvironmentRiskRead {
  if (!aiState) {
    return { label: 'Fragile', color: '#7F98A3',
             hint: 'No Guru read yet — environment unread.' };
  }
  const code = aiState.stateCode;
  const phase = aiState.phase;
  const conf  = aiState.confidence;
  const skew = (typeof aiState.longPressure === 'number'
             && typeof aiState.shortPressure === 'number')
    ? Math.abs(aiState.longPressure - aiState.shortPressure)
    : null;
  const band = aiState.pressureBand;
  const next = aiState.nextLikelyState;
  const nextConf = aiState.transitionConfidence ?? 0;

  // Volatile — explicit risk states + raw shock/climax/FA dominate.
  if (code === 'SH' || code === 'CL' || code === 'FA') {
    return {
      label: 'Volatile',
      color: '#c45a5a',
      hint:  code === 'SH' ? 'Shock event — extreme volatility either way.'
           : code === 'CL' ? 'Climax burst — exhaustion possible.'
           :                 'Failed alignment — fade / reversal risk.',
    };
  }

  // Exhausted — Plateau / Discharge / Late-or-Exhausted phase of any
  // directional state. New entries are off the table either way.
  if (code === 'PS' || code === 'DS') {
    return {
      label: 'Exhausted',
      color: '#b87838',
      hint:  code === 'PS'
        ? 'Plateau — synchronized coherence has run out of edge.'
        : 'Discharge — trend energy releasing; fresh entries off the table.',
    };
  }
  if ((code === 'AT' || code === 'SS')
      && (phase === 'Late' || phase === 'Exhausted')) {
    return {
      label: 'Exhausted',
      color: '#b87838',
      hint:  `${code} is ${phase} — manage existing exposure, avoid fresh entries.`,
    };
  }

  // Directional Decay — coherence weak but price keeps moving.
  if (code === 'DC') {
    return {
      label: 'Fragile',
      color: '#b06b58',
      hint:  'Coherence weak under directional move — respect the trend.',
    };
  }

  // Transitional — non-trivial transition target with material
  // confidence. Edges may flip soon.
  if (next && nextConf >= 0.55) {
    return {
      label: 'Transitional',
      color: '#7a9bd4',
      hint:  `Transition likely → ${next} (${Math.round(nextConf * 100)}%).`,
    };
  }

  // Fragile — low read clarity OR weak directional skew while in
  // CS / DD / IS / AT.
  const weakBand   = band === 'weak';
  const lowSkew    = skew != null && skew < 15;
  const lowConf    = conf < 0.40;
  if (weakBand || lowSkew || lowConf) {
    return {
      label: 'Fragile',
      color: '#d4a028',
      hint:  lowConf
        ? `Read clarity low (${Math.round(conf * 100)}%) — pace down.`
        : 'Weak directional pressure — reads can degrade fast.',
    };
  }

  // Stable — anything left over reads as clean enough to participate.
  return {
    label: 'Stable',
    color: '#22c55e',
    hint:  'Clean structural read — participation is favored within the stance.',
  };
}

// ──────────────────────────────────────────────────────────────────
// 2. Historical analog
// ──────────────────────────────────────────────────────────────────

export interface HistoricalAnalog {
  /** Sample count matching (stateCode, phase) on this symbol. */
  samples:        number;
  /** Average forward move %, signed. null when we can't compute
   *  (e.g. no forward observations within the window). */
  forwardMovePct: number | null;
  /** The horizon we measured against, in minutes. Fixed at 4h for
   *  this v1 to match the spec's "average 4h move" copy. */
  horizonMinutes: number;
  /** Human-readable summary line. Always present even when sample
   *  count is 0 ("No prior samples for FA Late on XAUUSD."). */
  summary:        string;
}

const ANALOG_HORIZON_MIN = 240;            // 4h forward window
const ANALOG_HORIZON_MS  = ANALOG_HORIZON_MIN * 60_000;

/**
 * Compare each (stateCode, phase, symbol) entry in history against
 * a future record on the same symbol that lands roughly 4h later;
 * compute the % change between the priceAtAnalysis fields. This is
 * a coarse "what does this environment typically resolve into"
 * read — NOT a backtest. Returns null forwardMove if we don't have
 * enough forward samples yet.
 */
export function deriveHistoricalAnalog(
  records: AiStateHistoryRecord[],
  symbol:  string,
  current: GcpStateResponse | null,
): HistoricalAnalog {
  if (!current) {
    return {
      samples: 0, forwardMovePct: null, horizonMinutes: ANALOG_HORIZON_MIN,
      summary: 'No current state — historical analog unavailable.',
    };
  }
  const code  = current.stateCode;
  const phase = current.phase;

  // Filter to the same symbol + matching (stateCode, phase). Sort
  // ascending so we can scan forward for the nearest 4h-later
  // observation efficiently.
  const symbolRecords = records
    .filter(r => r.symbol === symbol)
    .sort((a, b) => a.timestamp - b.timestamp);
  const matches = symbolRecords.filter(r =>
    r.stateCode === code && r.phase === phase,
  );
  const samples = matches.length;

  if (samples === 0) {
    return {
      samples: 0, forwardMovePct: null, horizonMinutes: ANALOG_HORIZON_MIN,
      summary: `No prior ${code} · ${phase} samples on ${symbol}.`,
    };
  }

  const moves: number[] = [];
  for (const m of matches) {
    if (m.priceAtAnalysis == null || m.priceAtAnalysis <= 0) continue;
    const targetTs = m.timestamp + ANALOG_HORIZON_MS;
    // Find the symbolRecord whose timestamp is closest to targetTs
    // AND >= m.timestamp + 1h (so we don't compare to the same row).
    let best: AiStateHistoryRecord | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const r of symbolRecords) {
      if (r.timestamp <= m.timestamp + 60 * 60_000) continue;
      if (r.priceAtAnalysis == null || r.priceAtAnalysis <= 0) continue;
      const d = Math.abs(r.timestamp - targetTs);
      // Hard cap — only count rows within ±2h of the target.
      if (d > 2 * 60 * 60_000) continue;
      if (d < bestDelta) {
        best = r;
        bestDelta = d;
      }
    }
    if (best) {
      const pct = ((best.priceAtAnalysis as number) - m.priceAtAnalysis)
                / m.priceAtAnalysis * 100;
      moves.push(pct);
    }
  }

  if (moves.length === 0) {
    return {
      samples, forwardMovePct: null, horizonMinutes: ANALOG_HORIZON_MIN,
      summary: `${samples} prior ${code} · ${phase} samples on ${symbol} — none with 4h-forward observation yet.`,
    };
  }

  const avg = moves.reduce((acc, m) => acc + m, 0) / moves.length;
  const arrow = avg >= 0.05 ? '↑' : avg <= -0.05 ? '↓' : '→';
  return {
    samples,
    forwardMovePct: +avg.toFixed(2),
    horizonMinutes: ANALOG_HORIZON_MIN,
    summary: `Last ${samples} ${code} · ${phase} on ${symbol}: ${arrow} avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% over 4h (n=${moves.length}).`,
  };
}

// ──────────────────────────────────────────────────────────────────
// 3. Thesis integrity (for open positions)
// ──────────────────────────────────────────────────────────────────

export type ThesisStatus = 'intact' | 'drift' | 'invalidated' | 'unknown';

export interface ThesisIntegrity {
  status:  ThesisStatus;
  /** Hex color matching the status. */
  color:   string;
  /** One-line explanation. */
  hint:    string;
}

/**
 * Compare the AI state at the moment a position was opened with the
 * CURRENT AI state and decide whether the original thesis still
 * stands.
 *
 *   intact       — same stateCode, similar phase, direction unchanged
 *   drift        — same stateCode but phase / direction has rotated
 *   invalidated  — stateCode flipped INTO a state that contradicts
 *                  the original side (e.g. long opened in IS Up but
 *                  current is FA or DS), OR Guru certainty has
 *                  collapsed (confidence -25% absolute or more)
 *
 * Inputs:
 *   openSide          — 'long' | 'short' (the position direction)
 *   openContextState  — stateCode at open time (snapshotted in
 *                       demoAccount.TradeContext)
 *   openContextPhase  — phase at open time
 *   openContextConf   — confidence at open time
 *   currentState      — live aiState
 */
export function deriveThesisIntegrity(
  openSide:         'long' | 'short' | null,
  openContextState: string | null,
  openContextPhase: string | null,
  openContextConf:  number | null,
  currentState:     GcpStateResponse | null,
): ThesisIntegrity {
  if (!openSide || !openContextState || !currentState) {
    return { status: 'unknown', color: '#7F98A3',
             hint: 'Open a position to track thesis integrity.' };
  }

  const curCode = currentState.stateCode;
  const curPhase = currentState.phase;
  const curConf = currentState.confidence;
  const curDir = currentState.direction;

  // Hard contradictions — flipping into these states invalidates a
  // long bias / short bias respectively.
  const longInvalidators  = new Set(['FA', 'DS', 'CL']);
  const shortInvalidators = new Set(['IS', 'AT', 'SS']);
  const invalidatedByState =
    (openSide === 'long'  && longInvalidators.has(curCode))
 || (openSide === 'short' && shortInvalidators.has(curCode));
  if (invalidatedByState) {
    return {
      status: 'invalidated',
      color:  '#c45a5a',
      hint:   `Current state ${curCode} contradicts the ${openSide.toUpperCase()} entry — thesis invalidated.`,
    };
  }

  // Direction flip — if the current state is directional and the
  // direction opposes the side, that's also invalidation.
  const dirInvalidates =
    (openSide === 'long'  && curDir === 'Down')
 || (openSide === 'short' && curDir === 'Up');
  if (dirInvalidates && (curCode === 'AT' || curCode === 'SS' || curCode === 'IS' || curCode === 'DS')) {
    return {
      status: 'invalidated',
      color:  '#c45a5a',
      hint:   `Direction has rotated to ${curDir} — thesis no longer holds.`,
    };
  }

  // Certainty collapse — when state stayed the same but confidence
  // dropped materially, the thesis is degrading even if the label
  // hasn't flipped yet.
  if (openContextConf != null && curConf < openContextConf - 0.25) {
    return {
      status: 'drift',
      color:  '#d4a028',
      hint:   `Read clarity fell ${Math.round(openContextConf * 100)}% → ${Math.round(curConf * 100)}% — thesis drifting.`,
    };
  }

  // Phase rotation — same state but moved into Late/Exhausted.
  if (curCode === openContextState
      && curPhase !== openContextPhase
      && (curPhase === 'Late' || curPhase === 'Exhausted')) {
    return {
      status: 'drift',
      color:  '#d4a028',
      hint:   `${curCode} rotated to ${curPhase} since entry — manage exposure.`,
    };
  }

  // State change without invalidation → drift.
  if (curCode !== openContextState) {
    return {
      status: 'drift',
      color:  '#d4a028',
      hint:   `State shifted ${openContextState} → ${curCode} since entry.`,
    };
  }

  return {
    status: 'intact',
    color:  '#22c55e',
    hint:   'Thesis intact — original conditions still in place.',
  };
}
