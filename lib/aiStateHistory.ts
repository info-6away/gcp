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
}

// Append a single record. Returns the new history. Dedupes against
// the most recent entry: same stateCode + phase + direction within
// the last 60 s collapses (we just refresh the timestamp / price /
// pss / confidence rather than appending a duplicate row). Cap at
// 500; oldest first when over.
export function appendAiStateHistory(input: AiStateHistoryInput): AiStateHistoryRecord[] {
  const history = loadAiStateHistory();

  const last = history[history.length - 1];
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
    return history;
  }

  const record: AiStateHistoryRecord = {
    id: `${input.timestamp}-${input.stateCode}-${input.phase}-${input.direction}`,
    ...input,
  };
  history.push(record);

  while (history.length > AI_HISTORY_MAX) history.shift();
  saveAiStateHistory(history);
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
