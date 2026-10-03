/** Types the voice's owners share, with no values, so no module needs another's runtime for them. */

export interface VoiceTiming {
  firstChunkMs: number; synthMs: number; playMs: number; resyncMs: number; waitMs: number; presenceMs: number; tickMs: number;
}

/** Audio being made (or made), as anyone but its store holds it: only its id. */
export interface AudioHandle { readonly id: string }
