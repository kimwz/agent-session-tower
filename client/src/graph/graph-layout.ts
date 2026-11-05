import type { Session } from '../../../shared/types';
import { sessionStaysShown, sortSessions } from '../common/lib';
import { scopedId } from '../remote/scope';

export function graphProjectKey(session: Pick<Session, 'cwd' | 'node' | 'project'>): string {
  return session.cwd || scopedId(session.node, session.project || 'unknown');
}

export function graphProjectId(path: string): string {
  return `project:${encodeURIComponent(path)}`;
}

/** The folder key a canvas project id was made from. */
export function graphProjectPath(id: string): string {
  return decodeURIComponent(id.slice('project:'.length));
}

export function graphSessionGroups(sessions: Session[], limit: number, selectedId: string | null): [string, Session[]][] {
  const visible = [...sessions].sort(sortSessions).slice(0, limit);
  const selected = sessions.find(session => session.id === selectedId);
  if (selected && !visible.some(session => session.id === selected.id)) visible.push(selected);
  // Conversations that still need something are never pushed off by newer ones.
  for (const session of sessions) if (sessionStaysShown(session) && !visible.includes(session)) visible.push(session);
  const groups = new Map<string, Session[]>();
  for (const session of visible.sort(sortSessions)) {
    const key = graphProjectKey(session);
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a, aSessions], [b, bSessions]) => sortSessions(aSessions[0], bSessions[0]) || a.localeCompare(b));
}

export const HOST_WIDTH = 256;
export const HOST_HEIGHT = 169;
/** The room a computer card keeps around folders. */
export const HOST_CLEARANCE = 16;
type PlacedBox = { position: { x: number; y: number }; width: number; height: number };
/** Where the card of a computer nobody placed by hand sits: above its top-left folder. */
export function hostAboveFolders(folders: PlacedBox[]) {
  return { x: Math.min(...folders.map(folder => folder.position.x)), y: Math.min(...folders.map(folder => folder.position.y)) - HOST_HEIGHT - 40 };
}

/** Reserve room for account usage without rewriting saved folder or card positions. */
export function clearHostPosition(host: { x: number; y: number }, projects: PlacedBox[]) {
  let y = host.y;
  const gap = HOST_CLEARANCE;
  for (let pass = 0; pass <= projects.length; pass++) {
    const collisions = projects.filter(project => host.x < project.position.x + project.width + gap && host.x + HOST_WIDTH + gap > project.position.x
      && y < project.position.y + project.height + gap && y + HOST_HEIGHT + gap > project.position.y);
    if (!collisions.length) break;
    y = Math.min(...collisions.map(project => project.position.y - HOST_HEIGHT - gap));
  }
  return { x: host.x, y };
}
