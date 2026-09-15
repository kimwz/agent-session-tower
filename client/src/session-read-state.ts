import type { Run, Session } from '../../shared/types';

export type ReadState = Record<string, string>;
export const readStateKey = 'agent-monitor.read-sessions.v1';

// Only conversation and task boundaries count as new activity. Process probes,
// titles, file mtimes, and graph positions do not make a conversation unread.
export function conversationRevision(session: Session, runs: readonly Run[] = []): string {
  const latest = runs.filter(run => run.sessionId === session.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
  const content = JSON.stringify([
    session.messageCount, session.lastMessage, session.lastRequestAt || '', session.lastCompletedAt || '',
    latest ? [latest.id, latest.status, latest.output, latest.error || ''] : null,
  ]);
  // Store compact change markers, not a second copy of conversations or output.
  let first = 2166136261;
  let second = 5381;
  for (let i = 0; i < content.length; i++) {
    const character = content.charCodeAt(i);
    first = Math.imul(first ^ character, 16777619);
    second = Math.imul(second, 33) ^ character;
  }
  return `${content.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function parseReadState(value: string | null): ReadState {
  if (!value) return {};
  try {
    const saved: unknown = JSON.parse(value);
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') return {};
    return Object.fromEntries(Object.entries(saved).filter(([id, revision]) => id.length > 0 && typeof revision === 'string'));
  } catch { return {}; }
}

export function acknowledgeSession(state: ReadState, id: string, revision: string): ReadState {
  return state[id] === revision ? state : { ...state, [id]: revision };
}

export function pruneReadState(state: ReadState, sessions: readonly Session[]): ReadState {
  const ids = new Set(sessions.map(session => session.id));
  const entries = Object.entries(state).filter(([id]) => ids.has(id));
  return entries.length === Object.keys(state).length ? state : Object.fromEntries(entries);
}
