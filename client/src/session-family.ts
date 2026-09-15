import type { Session } from '../../shared/types';

function familyIndex(sessions: Session[]) {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const roots = new Map<string, string>();
  for (const session of sessions) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current = session;
    let root: string;
    while (true) {
      const resolved = roots.get(current.id);
      if (resolved) { root = resolved; break; }
      const cycleStart = positions.get(current.id);
      if (cycleStart !== undefined) {
        root = path.slice(cycleStart).sort()[0];
        break;
      }
      positions.set(current.id, path.length);
      path.push(current.id);
      // A user-created fork starts a separate family even when it has a parent.
      const parent = current.isSubagent && current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent) { root = current.id; break; }
      current = parent;
    }
    for (const id of path) roots.set(id, root);
  }
  return { byId, roots };
}

export function getMainSessions(sessions: Session[]): Session[] {
  const { roots } = familyIndex(sessions);
  return sessions.filter(session => roots.get(session.id) === session.id);
}

export function getMainSessionId(sessions: Session[], selectedId: string | null): string | null {
  if (!selectedId) return null;
  return familyIndex(sessions).roots.get(selectedId) || null;
}

export function getSessionFamily(sessions: Session[], selectedId: string | null): { root?: Session; members: Session[] } {
  const { byId, roots } = familyIndex(sessions);
  const rootId = selectedId ? roots.get(selectedId) : undefined;
  const root = rootId ? byId.get(rootId) : undefined;
  if (!root) return { members: [] };
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.id === rootId || roots.get(session.id) !== rootId || !session.parentId) continue;
    const siblings = children.get(session.parentId) || [];
    siblings.push(session);
    children.set(session.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id));
  }
  const members: Session[] = [];
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const session = pending.pop()!;
    if (visited.has(session.id)) continue;
    visited.add(session.id);
    members.push(session);
    pending.push(...[...(children.get(session.id) || [])].reverse());
  }
  return { root, members };
}
