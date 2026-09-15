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
