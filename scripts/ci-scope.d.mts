export type Tier = 'quick' | 'related' | 'full';
export interface GateResult { passed: boolean; reason: string; id?: number }
export interface Scope { tier: Tier; reasons: string[]; files: string[]; version: { from?: string; to?: string } }
export interface Evidence { reused: boolean; reason: string; pr?: number; run?: number; tier?: Tier }
export interface CheckRun { id: number; name: string; status: string; conclusion: string | null; app?: { slug: string } }
export const TIERS: Tier[];
export const GATE: string;
export function atLeast(tier: string, floor: string): boolean;
export function pathTier(path: string): { tier: Tier; reason?: string };
export function versionOnly(path: string, before: string | null, after: string | null): boolean;
export function classify(input: { changes: string[]; content: (path: string, side: 'base' | 'head') => string | null; nextVersion?: string }): Scope;
export interface WorkflowRun { id: number; run_number: number; run_attempt: number; status: string; conclusion: string | null }
export function gatePassed(checkRuns: CheckRun[], workflowRuns: WorkflowRun[]): GateResult;
export function commitGate(sha: string, repo?: string): GateResult;
export function reuseEvidence(input: { head: string; tree: string; needed: Tier; repo: string; api: (path: string) => any; artifact: (id: number) => any }): Evidence;
export function planCi(input?: { scope?: any; api?: (path: string) => any; artifact?: (id: number) => any; repo?: string }): any;
export function ciScope(input?: { event?: string; before?: string; gate?: ((sha: string) => GateResult) | null; cwd?: string }): any;
export function localScope(): Scope;
export function ghJson(path: string): any;
export function ghArtifact(id: number): any;
