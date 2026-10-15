export interface Lane {
  id: string; os: string; node: string; major: string; kind: 'full' | 'compat'; files: string[];
  shard?: number; count?: number; sea: boolean; foundation: boolean;
}
/** A test of a lane that took a second or more (scripts/test-durations.mjs). */
export interface SlowTest { file?: string; name: string; ms: number; ok?: boolean }
export interface Receipt {
  id: string; sha: string; node: string; platform: string; files: string[]; exit: number;
  started: number; finished: number; sea: boolean; foundation: boolean; slow?: SlowTest[];
  arch?: string; pathNode?: string; input?: { commit: string; tree: string; dirty: boolean };
}
export interface SlowTestEntry { file?: string; name: string; maxMs: number; lanes: Record<string, number> }
export const versions: Record<string, string>;
export function inventory(root?: string): string[];
export function shards(files: string[], costs: Record<string, number>, count: number, concurrency?: number): string[][];
export function plan(root?: string): Lane[];
export function lanesFor(tier: string, lanes?: Lane[]): Lane[];
export function validateReceipts(lanes: Lane[], receipts: Receipt[], sha: string): { testWindowSeconds: number; testRunnerSeconds: number };
/** The checks job's receipt, written once its checks and quick suite passed. */
export interface ChecksReceipt {
  id: string; sha: string; input?: { commit: string; tree: string; dirty: boolean }; admitted?: number; ready?: number;
  started: number; finished: number; exit: 0; quick: true;
}
export function checksReceipt(setup: { id: string; sha: string; input?: ChecksReceipt['input']; admitted?: number; ready?: number }, started: number, finished: number): ChecksReceipt;
export function slowTestReport(receipts: ReadonlyArray<Partial<Receipt> & { id: string }>): SlowTestEntry[];

export function projectedSeconds(files: string[], costs: Record<string, number>, concurrency: number): number;
