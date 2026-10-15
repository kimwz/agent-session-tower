import type { Lane, Receipt } from './ci-plan.mjs';
import type { Evidence, GateResult } from './ci-scope.mjs';
export function gateVerdict(input: {
  needs: Record<string, { result: string } | undefined>;
  planned: { tier: string; execution: string; head: string; tree: string; lanes: string[] } | undefined;
  pathTier: string; baseGate?: GateResult; evidence?: Evidence;
  receipts: (Partial<Receipt> & { id: string; [key: string]: unknown })[];
  sha: string; tree: string; lanes?: Lane[];
}): { problems: string[]; timing: { testWindowSeconds?: number; testRunnerSeconds?: number } };
export function rereadClaims(input: {
  planned: { tier: string; execution: string } | undefined; path: { base: string; head: string; tree: string };
  gate?: (sha: string) => GateResult; reuse?: (input: any) => Evidence; repo?: string;
}): { baseGate?: GateResult; evidence?: Evidence };
