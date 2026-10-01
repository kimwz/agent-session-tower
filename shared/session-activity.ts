import type { Session } from './types.js';

export function sessionActivityAt(session: Session) {
  const request = Date.parse(session.lastRequestAt || '');
  const completed = Date.parse(session.lastCompletedAt || '');
  if (Number.isFinite(request) && (!Number.isFinite(completed) || request >= completed)) return session.lastRequestAt!;
  if (Number.isFinite(completed)) return session.lastCompletedAt!;
  return session.createdAt;
}

export function sortSessions(a: Session, b: Session) {
  const aTime = Date.parse(sessionActivityAt(a)) || 0;
  const bTime = Date.parse(sessionActivityAt(b)) || 0;
  return bTime - aTime || a.id.localeCompare(b.id);
}

/**
 * A conversation whose last turn was judged to end in anything but finished work: it waits for the owner, broke off,
 * or said it carries on. It stays on the canvas however old it gets, until its work is done or the owner closes it.
 */
export function sessionStaysShown(session: Pick<Session, 'status' | 'outcome'>) {
  return session.status !== 'working' && session.outcome !== undefined && session.outcome !== 'done';
}

/**
 * Whether the session list shows an open main session with the time window starting at `cutoff`. The server sends a
 * page exactly the sessions this rule may show (shared/session-scope.ts), so the two never disagree.
 */
export function listShows(session: Session, cutoff: number): boolean {
  return session.status === 'working' || Boolean(session.activeProcess) || sessionStaysShown(session) || Date.parse(sessionActivityAt(session)) >= cutoff;
}
