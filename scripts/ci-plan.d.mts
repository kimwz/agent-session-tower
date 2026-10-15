export interface Lane {
  id: string; os: string; node: string; major: string; kind: 'full' | 'compat'; files: string[];
  shard?: number; count?: number; large: boolean; sea: boolean; benchmark: boolean; foundation: boolean;
}
export interface Receipt {
  id: string; sha: string; node: string; platform: string; files: string[]; exit: number; large: boolean;
  started: number; finished: number; sea: boolean; benchmark: boolean; foundation: boolean;
  cap?: { canonicalBytes: number; count: number; large?: boolean };
  arch?: string; pathNode?: string; input?: { commit: string; tree: string; dirty: boolean };
}
export const versions: Record<string, string>;
export const largeFile: string;
export const offlineFile: string;
export function inventory(root?: string): string[];
export function shards(files: string[], costs: Record<string, number>, count: number, concurrency?: number, tails?: Record<string, number>): string[][];
export function plan(root?: string): Lane[];
export function lanesFor(tier: string, lanes?: Lane[]): Lane[];
export function validateReceipts(lanes: Lane[], receipts: Receipt[], sha: string): { testWindowSeconds: number; testRunnerSeconds: number };

export function projectedSeconds(files: string[], costs: Record<string, number>, concurrency: number, tails?: Record<string, number>): number;
