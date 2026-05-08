'use client';

// v11.20: local-only AI State outcome ledger. Every successful Engine
// classification gets appended here so the Research → By AI State view
// can correlate AI environments with subsequent price moves. Stays in
// localStorage; nothing is sent to the Engine, no extra calls fire,
// nothing automatic. Capped at 500 records and deduped within 60 s of
// the last identical (stateCode + phase + direction) entry to keep
// rapid-fire manual runs from spamming.

export const AI_HISTORY_LS_KEY = 'gcpro-ai-state-history';
export const AI_HISTORY_MAX    = 500;
const DEDUP_WINDOW_MS = 60_000;

export interface AiStateHistoryRecord {
  id:               string;
  timestamp:        number;
  symbol:           string;
  timeframe:        string;

  state:            string;
  stateCode:        string;
  phase:            string;
  direction:        string;
  confidence:       number;
  marketBias?:      string;

  regime:           string;
  netVariance:      number;

  patternCode?:     string;
  patternName?:     string;
  pss?:             number;

  priceAtAnalysis:  number | null;

  // v11.36: directional pressure snapshot. Kept optional so older
  // localStorage entries written before v11.36 still validate.
  longPressure?:    number;
  shortPressure?:   number;
  pressureBand?:    'weak' | 'moderate' | 'strong';
}

export function loadAiStateHistory(): AiStateHistoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(AI_HISTORY_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as AiStateHistoryRecord[];
  } catch {
    return [];
  }
}

function saveAiStateHistory(records: AiStateHistoryRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AI_HISTORY_LS_KEY, JSON.stringify(records));
    // Same-tab listeners (Research view) get a manual nudge — storage
    // events only fire across tabs.
    window.dispatchEvent(new StorageEvent('storage', { key: AI_HISTORY_LS_KEY }));
  } catch {
    /* quota / serialization — drop silently */
  }
}

export interface AiStateHistoryInput {
  timestamp:        number;
  symbol:           string;
  timeframe:        string;

  state:            string;
  stateCode:        string;
  phase:            string;
  direction:        string;
  confidence:       number;
  marketBias?:      string;

  regime:           string;
  netVariance:      number;

  patternCode?:     string;
  patternName?:     string;
  pss?:             number;

  priceAtAnalysis:  number | null;

  // v11.36: directional pressure snapshot at the time of classification.
  longPressure?:    number;
  shortPressure?:   number;
  pressureBand?:    'weak' | 'moderate' | 'strong';
}

// Append a single record. Returns the new history. Dedupes against
// the most recent entry: same stateCode + phase + direction within
// the last 60 s collapses (we just refresh the timestamp / price /
// pss / confidence rather than appending a duplicate row). Cap at
// 500; oldest first when over.
//
// v11.20.1: dev logs at save time so the user can verify in the
// browser console that the manual run is actually persisting.
export function appendAiStateHistory(input: AiStateHistoryInput): AiStateHistoryRecord[] {
  const history = loadAiStateHistory();
  const isDev = typeof process !== 'undefined' && process.env.NODE_ENV !== 'production';

  if (isDev) {
    console.log('[AI HISTORY] saving classification', {
      stateCode:  input.stateCode,
      state:      input.state,
      phase:      input.phase,
      direction:  input.direction,
      confidence: input.confidence,
      timestamp:  input.timestamp,
    });
  }

  const last = history[history.length - 1];
  // Dedup ONLY against the most-recent record. The first record
  // always falls through this guard (last is undefined on empty
  // history), guaranteeing the first save lands.
  if (last
      && input.timestamp - last.timestamp < DEDUP_WINDOW_MS
      && last.stateCode === input.stateCode
      && last.phase     === input.phase
      && last.direction === input.direction) {
    // Refresh in place so we still capture the most recent confidence
    // / price / pss but don't grow the history with near-duplicates.
    last.timestamp       = input.timestamp;
    last.confidence      = input.confidence;
    last.netVariance     = input.netVariance;
    last.priceAtAnalysis = input.priceAtAnalysis;
    last.pss             = input.pss;
    last.patternCode     = input.patternCode;
    last.patternName     = input.patternName;
    saveAiStateHistory(history);
    if (isDev) console.log(`[AI HISTORY] deduped (refreshed in place) — total records: ${history.length}`);
    return history;
  }

  const record: AiStateHistoryRecord = {
    id: `${input.timestamp}-${input.stateCode}-${input.phase}-${input.direction}`,
    ...input,
  };
  history.push(record);

  while (history.length > AI_HISTORY_MAX) history.shift();
  saveAiStateHistory(history);
  if (isDev) console.log(`[AI HISTORY] total records: ${history.length}`);
  return history;
}

export function clearAiStateHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(AI_HISTORY_LS_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: AI_HISTORY_LS_KEY }));
  } catch {
    /* ignore */
  }
}
