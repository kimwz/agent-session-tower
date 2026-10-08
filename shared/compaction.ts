import type { Run, Session, SessionCompaction } from './types.js';

/**
 * Why a conversation cannot be compacted now. The worker decides with it (server/sessions/compaction/service.ts); the
 * chat's compact button says the same reason before anything is sent.
 */
export type CompactionRefusal = 'helper' | 'creating' | 'notResumable' | 'empty' | 'busy';

export function compactionRefusal(session: Session, runs: readonly Run[]): CompactionRefusal | undefined {
  if (session.master || session.isSubagent || session.launchedByAgent) return 'helper';
  if (session.creationPending) return 'creating';
  if (!session.resumable) return 'notResumable';
  if (session.messageCount === 0) return 'empty';
  if (session.status === 'working' || runs.some(run => run.sessionId === session.id && (run.status === 'running' || run.status === 'queued'))) return 'busy';
  return undefined;
}

/** A compaction still under way: reading, summarizing, or creating the new session. */
export const COMPACTION_ACTIVE: ReadonlySet<SessionCompaction['state']> = new Set(['reading', 'summarizing', 'creating']);
