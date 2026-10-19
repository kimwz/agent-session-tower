import type { Provider } from './types.js';
export interface RetentionCandidate {
  rootId: string; ids: string[];
  reason: 'child-expired' | 'explicit-archive' | 'parent-limit';
  revisions: Record<string, number>;
}
export interface RetentionFileManifest { name: string; originalPath: string; root: string; nativeId: string; provider: Provider; bytes: number; sha256: string }
export interface RetentionManifest {
  version: 1; id: string; createdAt: string; reason: RetentionCandidate['reason'];
  sessions: { id: string; nativeId: string; provider: Provider; parentId?: string; title: string; endedAt?: string }[];
  files: RetentionFileManifest[];
}
export type RetentionPhase = 'planned' | 'backup-verified' | 'blocked-provider' | 'removing' | 'archived' | 'conflict' | 'missing-backup' | 'restored-awaiting-start';
/** Proven relationship metadata only; it conveys no file ownership or move authority. */
export interface RetentionRelationship {
  id: string; provider: Provider; nativeId: string; parentId: string;
  isSubagent: true; parentLink?: 'exec'; createdAt: string;
}
export interface RetentionNode {
  id: string; provider: Provider; nativeId: string; parentId?: string;
  isSubagent?: boolean; parentLink?: 'exec'; createdAt?: string;
}
export interface RetentionMember {
  sessionId: string; provider: Provider; nativeId: string; parentId?: string;
  isSubagent?: boolean; parentLink?: 'exec'; createdAt?: string; relationships?: RetentionRelationship[];
  originalPath: string; coldPath?: string; operationId: string;
  state: 'intent' | 'cold' | 'restored' | 'conflict';
  identity: { dev: number; ino: number; size: number; mtimeMs: number };
  sidecars?: { originalPath: string; coldPath: string; identity: { dev: number; ino: number; size: number; mtimeMs: number } }[];
  error?: string;
}
export interface RetentionJournalEntry {
  id: string; candidate: RetentionCandidate; phase: RetentionPhase; updatedAt: string;
  error?: string;
  members?: RetentionMember[];
  backupError?: string; restoredAt?: string; restoreOperationId?: string;
}
export interface RetentionCapability { status: 'supported' | 'blocked'; reason?: string }

export interface RetentionOverview {
  migratedAt: string;
  lastCheckedAt?: string;
  metricError?: string;
  running: boolean;
  observationComplete?: boolean;
  deferredReasons?: Record<string, number>;
  observationIssues?: string[];
  verification?: 'pending' | 'running' | 'complete';
  candidates: number;
  deferred: number;
  archived: number;
  archivedMembers?: number;
  backupFailures?: number;
  blockedProvider: number;
  backupOnly: number;
  failures: number;
  coldBytes: number;
  originalBytes: number;
  providers: Record<Provider, RetentionCapability>;
  entries: RetentionJournalEntry[];
  temporary?: { checkedAt?: string; examined: number; removedEmpty: number; releasedOwned: number; deferredActive: number; deferredUnproven: number; failed: number; issues: string[] };
  /** The latest cycles, newest last (see RetentionCycleRecord). */
  recentCycles?: RetentionCycleRecord[];
}

/**
 * One retention cycle, as kept for tracing: `check` is the owner's "현재 기록 확인·정리", `scheduled` the service's own,
 * with what it was scheduled for (`request`: an archive request came; `waiting`: a requested session was still at work;
 * `catch-up`: the last one ran out of budget; `resume`: requests were waiting when maintenance resumed; `hourly`).
 */
export interface RetentionCycleRecord {
  trigger: 'scheduled' | 'check';
  reason?: RetentionCycleReason;
  startedAt: string;
  endedAt: string;
  ms: number;
  observationComplete?: boolean;
  candidates: number;
  /** Session ids moved to cold storage in this cycle. */
  archived: string[];
  /** Candidates that ended in conflict. */
  conflicts: number;
  deferredReasons: Record<string, number>;
  error?: string;
}
export type RetentionCycleReason = 'request' | 'waiting' | 'catch-up' | 'resume' | 'hourly';
