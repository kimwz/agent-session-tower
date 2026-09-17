import type { Run, Session } from '../../../shared/types';
import { computeConversationRevision } from '../../../shared/conversation-revision';

export type ReadState = Record<string, string>;
export const readStateKey = 'agent-monitor.read-sessions.v1';

// Only conversation and task boundaries count as new activity. Process probes,
// titles, file mtimes, and graph positions do not make a conversation unread.
export function conversationRevision(session: Session, runs: readonly Run[] = []): string {
  return session.readRevision ?? computeConversationRevision(session, runs);
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
