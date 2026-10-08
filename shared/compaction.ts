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

/** The reason in words, as both the worker and the page say it (pages translate it). */
export const REFUSAL_MESSAGES: Readonly<Record<CompactionRefusal, string>> = {
  helper: '소유자가 직접 이어가는 세션만 압축할 수 있습니다. 하위 세션, 에이전트가 시작한 실행, 마스터 대화는 압축하지 않습니다.',
  creating: '세션을 만드는 중입니다. 첫 응답이 끝난 뒤 압축할 수 있습니다.',
  notResumable: '이어서 작업할 수 없는 세션은 압축할 수 없습니다.',
  empty: '압축할 대화가 없습니다.',
  busy: '작업 중이거나 대기·예약된 요청이 있는 세션은 압축할 수 없습니다. 끝나거나 취소된 뒤 다시 시도하세요.',
};

/** A compaction still under way: reading, summarizing, or creating the new session. */
export const COMPACTION_ACTIVE: ReadonlySet<SessionCompaction['state']> = new Set(['reading', 'summarizing', 'creating']);
