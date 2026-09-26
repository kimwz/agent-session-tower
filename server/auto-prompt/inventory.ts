import { basename, isAbsolute } from 'node:path';
import type { Provider, Session, Snapshot } from '../../shared/types.js';

/** A project folder work can be sent to, with the conversations started in it. */
export interface Directory { id: string; cwd: string; title: string; sessions: Session[] }

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** Folders with conversations of the owner's own, plus pinned or hidden ones; ids are d1, d2… in path order. */
export function directories(snapshot: Snapshot): Directory[] {
  const values = new Map<string, Directory>();
  const titles = new Map(snapshot.groups?.map(group => [group.cwd, group.title]));
  const add = (cwd: string) => {
    if (!isAbsolute(cwd) || cwd.includes('\0') || cwd.length > 4096) return undefined;
    let value = values.get(cwd);
    if (!value) { value = { id: '', cwd, title: titles.get(cwd) || basename(cwd) || cwd, sessions: [] }; values.set(cwd, value); }
    return value;
  };
  for (const session of snapshot.sessions) if (!session.isSubagent && !session.launchedByAgent && session.cwd) add(session.cwd)?.sessions.push(session);
  for (const group of snapshot.groups || []) if (group.pinned || group.hidden) add(group.cwd);
  return [...values.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)).map((value, index) => ({ ...value, id: `d${index + 1}` }));
}

/** A conversation of the owner's that new work for `provider` in `cwd` may continue. */
export function eligible(session: Session, provider: Provider, cwd: string): boolean {
  return session.provider === provider && session.cwd === cwd && !session.isSubagent && !session.launchedByAgent && !session.closed
    && !session.creationPending && session.resumable && UUID.test(session.nativeId);
}
