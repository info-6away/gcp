// v11.26.1: AI State structural anchor (frontend post-processor).
//
// The Engine returns a classification, and v11.26 forwarded the
// compact pattern story so the Engine could cross-check. The Engine
// PROMPT update that enforces the cross-check is server-side and
// out of scope for this repo, so we add the anchor on the frontend
// as a safety net: if the Engine response contradicts the local
// pattern story without a clear data-side justification, override
// it (or at minimum dock the confidence).
//
// Philosophy:
//   Patterns describe WHAT is happening.
//   AI describes WHAT IT MEANS.
//   AI must not override structure without strong evidence.
//
// Implemented rules:
//
//   FA hard guard
//     The Engine may only return Failed Alignment when:
//       (a) story.state === 'Failed alignment'
//       (b) story.dom === 'FA'
//       (c) clear data-side divergence (GCP rising + gold falling, or
//           GCP falling + gold rising) — read from the same payload
//           we sent to the Engine.
//     Otherwise FA is overridden to a story-aligned state.
//
//   Pattern → State hard biases
//     Pressure / Compression / Plateau-forming   → CS / IS / DD / SS / AT
//     Post-shock recovery → never SH or DS (unless new collapse fires)
//     Discharge phase → DS preferred when Engine returned CS or FA
//     Compression released / Alignment forming → AT / IS preferred
//
//   Confidence adjust
//     Engine agrees with story  → +0.10 (capped at 1.0)
//     Engine contradicts story  → −0.20 (floored at 0.05)
//
// Dev logs at the call site help trace why a classification was
// kept / overridden / dampened.

import type { GcpStateResponse, GcpStatePayload } from '@/lib/engine-gcp';
import { deriveShockDecay } from '@/lib/shockDecay';

type StateCode = GcpStateResponse['stateCode'];

const STATE_LABELS: Record<StateCode, GcpStateResponse['state']> = {
  CS: 'Compression State',
  DD: 'Dead Drift',
  IS: 'Ignition State',
  AT: 'Alignment Trend',
  SS: 'Synchronization State',
  CL: 'Climax State',
  SH: 'Shock State',
  FA: 'Failed Alignment State',
  DS: 'Discharge State',
};

// Codes that are CONSISTENT with each story.state. If the Engine
// lands inside this set we treat the answer as "agreeing" and bump
// confidence up; otherwise we either override (when a hard rule
// applies) or dock confidence as a soft contradiction.
const STORY_AGREE: Record<string, ReadonlySet<StateCode>> = {
  'Pressure building':    new Set<StateCode>(['CS', 'IS', 'DD']),
  'Compression building': new Set<StateCode>(['CS', 'DD']),
  'Plateau forming':      new Set<StateCode>(['SS', 'AT', 'CS']),
  'Plateau decaying':     new Set<StateCode>(['DS', 'SS', 'CL']),
  'Discharge phase':      new Set<StateCode>(['DS', 'CL']),
  'Failed alignment':     new Set<StateCode>(['FA', 'DD']),
  'Alignment forming':    new Set<StateCode>(['AT', 'IS', 'SS']),
  'Compression released': new Set<StateCode>(['IS', 'CS', 'AT']),
  'Shock / exhaustion':   new Set<StateCode>(['SH', 'DS', 'CL']),
  'Post-shock recovery':  new Set<StateCode>(['CS', 'IS', 'DD']),
};

function applyOverride(resp: GcpStateResponse, code: StateCode): GcpStateResponse {
  return { ...resp, stateCode: code, state: STATE_LABELS[code] };
}

// Pick a story-aligned default when overriding the Engine. Used for
// FA guard rejection and the fallback path.
function fallbackForStory(state: string): StateCode {
  switch (state) {
    case 'Pressure building':
    case 'Compression building':  return 'CS';
    case 'Plateau forming':       return 'SS';
    case 'Plateau decaying':
    case 'Discharge phase':       return 'DS';
    case 'Alignment forming':     return 'AT';
    case 'Compression released':  return 'IS';
    case 'Shock / exhaustion':    return 'SH';
    case 'Post-shock recovery':   return 'CS';
    case 'Failed alignment':      return 'FA';
    default:                      return 'DD';
  }
}

// True when GCP slope and gold trend disagree clearly enough that FA
// is structurally justified. Slope is in NV-per-bar units; |slope| >
// 0.1 over the engine window is a meaningful directional move.
function hasDivergence(payload: GcpStatePayload): boolean {
  const slope = payload.metrics?.slope ?? 0;
  const trend = payload.goldContext?.trend ?? 'unknown';
  if (slope >  0.10 && trend === 'down') return true;
  if (slope < -0.10 && trend === 'up')   return true;
  return false;
}

export interface AnchorResult {
  response:    GcpStateResponse;
  overridden:  boolean;
  reasons:     string[];
  delta:       number;     // signed confidence adjustment applied
}

export function anchorAiState(
  raw:     GcpStateResponse,
  payload: GcpStatePayload,
): AnchorResult {
  const story = payload.patternStory ?? null;
  if (!story) {
    return { response: raw, overridden: false, reasons: [], delta: 0 };
  }

  let next = raw;
  let overridden = false;
  const reasons: string[] = [];

  // ── 1. FA hard guard ───────────────────────────────────────────
  if (next.stateCode === 'FA') {
    const allowFA =
      story.state === 'Failed alignment' ||
      story.dom   === 'FA' ||
      hasDivergence(payload);
    if (!allowFA) {
      const fallback = fallbackForStory(story.state);
      reasons.push(
        `FA blocked — story is "${story.state}", dom=${story.dom ?? '—'}; remapped to ${fallback}`,
      );
      next = applyOverride(next, fallback);
      overridden = true;
    }
  }

  // ── 2. Pressure / Compression / Plateau-forming bias ───────────
  if (
    (story.state === 'Pressure building' ||
     story.state === 'Compression building' ||
     story.state === 'Plateau forming')
    && !STORY_AGREE[story.state].has(next.stateCode)
  ) {
    const target = fallbackForStory(story.state);
    reasons.push(`Engine ${next.stateCode} → ${target} (story "${story.state}")`);
    next = applyOverride(next, target);
    overridden = true;
  }

  // ── 2b. Shock decay verdict (v11.26.3). Quantitative read on
  //         whether the recent shock event is still dominating
  //         (slope / curvature / regime) or has decayed in favour of
  //         rebuilt structure. Drives the SH / DS overrides below.
  const decay = deriveShockDecay({
    story,
    metrics:       payload.metrics,
    currentRegime: payload.current?.regime,
  });
  const dev = (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production');
  if (dev) {
    if (decay.shockActive) {
      console.log(`[SHOCK DECAY] active — ${decay.reason}`);
    } else if (decay.decayed) {
      console.log(`[SHOCK DECAY] decayed — ${decay.reason}`);
    }
  }

  if (next.stateCode === 'SH' && decay.decayed) {
    const target = decay.recommendedStateCode ?? 'CS';
    reasons.push(`Engine SH → ${target} (decay): ${decay.reason}`);
    next = applyOverride(next, target);
    overridden = true;
  }
  if (next.stateCode === 'DS' && decay.recoveryActive
      && story.state !== 'Discharge phase') {
    reasons.push(`Engine DS → CS (recovery): ${decay.reason}`);
    next = applyOverride(next, 'CS');
    overridden = true;
  }

  // ── 3. Post-shock recovery: never SH / DS unless new shock fires ─
  if (story.state === 'Post-shock recovery'
      && (next.stateCode === 'SH' || next.stateCode === 'DS')) {
    reasons.push(`Engine ${next.stateCode} → CS (story "Post-shock recovery")`);
    next = applyOverride(next, 'CS');
    overridden = true;
  }

  // ── 3b. Recency-based shock guard (v11.26.2). If the LATEST
  //        visible pattern is PT / CC / CR (i.e. structure has
  //        already transitioned past the shock event) AND there's
  //        no fresh GCP spike (slope not strongly positive), block
  //        SH / DS. Catches Engine residual-shock answers even when
  //        the story didn't tag Post-shock recovery (e.g. when the
  //        shock was farther back than 5 patterns).
  const latestSeqCode = story.seq[story.seq.length - 1];
  const isStructureLatest = latestSeqCode === 'PT' || latestSeqCode === 'CC' || latestSeqCode === 'CR';
  const slope = payload.metrics?.slope ?? 0;
  const noFreshSpike = slope <= 0.20;   // strong-positive slope = real spike
  if (isStructureLatest && noFreshSpike
      && (next.stateCode === 'SH' || next.stateCode === 'DS')) {
    reasons.push(
      `Engine ${next.stateCode} → CS (latest ${latestSeqCode}, no fresh GCP spike: slope ${slope.toFixed(3)})`,
    );
    next = applyOverride(next, 'CS');
    overridden = true;
  }

  // ── 4. Discharge phase: DS preferred when Engine returned CS / FA ─
  if (story.state === 'Discharge phase'
      && (next.stateCode === 'CS' || next.stateCode === 'FA')) {
    reasons.push(`Engine ${next.stateCode} → DS (story "Discharge phase")`);
    next = applyOverride(next, 'DS');
    overridden = true;
  }

  // ── 5. Compression released / Alignment forming bias ───────────
  if ((story.state === 'Alignment forming' || story.state === 'Compression released')
      && next.stateCode === 'FA') {
    const target = fallbackForStory(story.state);
    reasons.push(`Engine FA → ${target} (story "${story.state}")`);
    next = applyOverride(next, target);
    overridden = true;
  }

  // ── 6. Confidence adjust ───────────────────────────────────────
  let delta = 0;
  if (overridden) {
    // We rewrote the answer — keep confidence honest about that.
    delta = -0.20;
  } else {
    const allowed = STORY_AGREE[story.state];
    if (allowed && allowed.has(next.stateCode)) {
      delta = 0.10;
    } else if (allowed) {
      // Story has a confident state, Engine didn't agree, but no hard
      // rule fired — soft contradiction.
      delta = -0.15;
    }
  }
  if (delta !== 0) {
    const adjusted = Math.max(0.05, Math.min(1, (next.confidence ?? 0) + delta));
    next = { ...next, confidence: +adjusted.toFixed(3) };
  }

  return { response: next, overridden, reasons, delta };
}
