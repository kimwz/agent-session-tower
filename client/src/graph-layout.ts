import type { Session } from '../../shared/types';
import { sortSessions } from './lib';

export function graphProjectKey(session: Session): string {
  return session.cwd || session.project || 'unknown';
}

export function graphProjectId(path: string): string {
  return `project:${encodeURIComponent(path)}`;
}

export function graphSessionGroups(sessions: Session[], limit: number, selectedId: string | null): [string, Session[]][] {
  const visible = [...sessions].sort(sortSessions).slice(0, limit);
  const selected = sessions.find(session => session.id === selectedId);
  if (selected && !visible.some(session => session.id === selected.id)) visible.push(selected);
  const groups = new Map<string, Session[]>();
  for (const session of visible.sort(sortSessions)) {
    const key = graphProjectKey(session);
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a, aSessions], [b, bSessions]) => sortSessions(aSessions[0], bSessions[0]) || a.localeCompare(b));
}
