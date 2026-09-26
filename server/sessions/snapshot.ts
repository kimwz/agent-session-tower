import type { Run, Session } from '../../shared/types.js';

function latestTime(previous: string | undefined, candidate: string | undefined): string | undefined {
  const at = candidate ? Date.parse(candidate) : NaN;
  if (!Number.isFinite(at)) return previous;
  return !previous || !Number.isFinite(Date.parse(previous)) || at > Date.parse(previous) ? new Date(at).toISOString() : previous;
}

/** Combine native activity with stronger evidence from a turn this monitor owns. */
export function projectSessionStates(sessions: readonly Session[], runs: readonly Run[], settledRunIds: ReadonlySet<string> = new Set()): Session[] {
  const latest = new Map<string, Run>();
  const running = new Set<string>();
  const waiting = new Set<string>();
  const activity = new Map<string, { lastRequestAt?: string; lastCompletedAt?: string }>();
  for (const run of runs) {
    if (run.status === 'running') running.add(run.sessionId);
    if (run.status === 'running' && run.backgroundWait) waiting.add(run.sessionId);
    const previous = latest.get(run.sessionId);
    if (!previous || run.createdAt >= previous.createdAt) latest.set(run.sessionId, run);
    const times = activity.get(run.sessionId) ?? {};
    times.lastRequestAt = latestTime(times.lastRequestAt, run.createdAt);
    // Restart recovery manufactures a finishedAt for lost running jobs. Only a
    // confirmed completion or a process settled in this runtime proves it ended.
    if (run.startedAt && Number.isFinite(Date.parse(run.startedAt)) && (run.status === 'completed' || (settledRunIds.has(run.id) && ['cancelled', 'error'].includes(run.status)))) {
      times.lastCompletedAt = latestTime(times.lastCompletedAt, run.finishedAt);
    }
    activity.set(run.sessionId, times);
  }
  return sessions.map((nativeSession) => {
    const times = activity.get(nativeSession.id);
    const session = times ? {
      ...nativeSession,
      lastRequestAt: latestTime(nativeSession.lastRequestAt, times.lastRequestAt),
      lastCompletedAt: latestTime(nativeSession.lastCompletedAt, times.lastCompletedAt),
    } : nativeSession;
    if (running.has(session.id)) return { ...session, status: 'working', statusReason: waiting.has(session.id) ? '백그라운드 작업이 끝나기를 기다리는 중' : 'Agent Session Tower에서 작업 중' };
    const run = latest.get(session.id);
    // A queued cancellation says nothing about the independent CLI's current task.
    if (session.status !== 'working' || !run?.startedAt || !run.finishedAt || !settledRunIds.has(run.id) || !['cancelled', 'error'].includes(run.status)) return session;
    const finishedAt = Date.parse(run.finishedAt);
    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(finishedAt) || !Number.isFinite(updatedAt) || updatedAt > finishedAt) return session;
    return {
      ...session,
      status: 'error',
      statusReason: run.status === 'cancelled' ? 'Agent Session Tower에서 시작한 작업을 중단했습니다.' : 'Agent Session Tower에서 시작한 작업이 오류로 종료되었습니다.',
    };
  });
}
