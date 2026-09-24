import type { Session } from '../../../shared/types';
import { sortSessions } from '../common/lib';
import { scopedId } from '../remote/scope';

export function graphProjectKey(session: Session): string {
  return session.cwd || scopedId(session.node, session.project || 'unknown');
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

export const HOST_HEIGHT = 145;
/** Reserve room for account usage without rewriting saved folder or card positions. */
export function clearHostPosition(host: { x: number; y: number }, projects: Array<{ position: { x: number; y: number }; width: number; height: number }>) {
  let y = host.y;
  const gap = 16;
  for (let pass = 0; pass <= projects.length; pass++) {
    const collisions = projects.filter(project => host.x < project.position.x + project.width + gap && host.x + 256 + gap > project.position.x
      && y < project.position.y + project.height + gap && y + HOST_HEIGHT + gap > project.position.y);
    if (!collisions.length) break;
    y = Math.min(...collisions.map(project => project.position.y - HOST_HEIGHT - gap));
  }
  return { x: host.x, y };
}
