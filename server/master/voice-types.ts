/** Types the voice's owners share, with no values, so no module needs another's runtime for them. */

export interface VoiceTiming {
  firstChunkMs: number; synthMs: number; playMs: number; resyncMs: number; waitMs: number; presenceMs: number; tickMs: number;
}

/** Audio being made (or made), as anyone but its store holds it: only its id. */
export interface AudioHandle { readonly id: string }

/** The tab where voice is on. Its id lives in memory only; pages know it by its digest. */
export interface VoiceSession {
  id: string;
  digest: string;
  tabId: string;
  local: boolean;
  listening: boolean;
  seenAt: number;
  activity?: { receivedAt: number; lastSpeechAt: number };
  /** How it ended (`endSession`), for what was still waiting on it. */
  ended?: 'stopped' | 'away' | 'restart';
}
