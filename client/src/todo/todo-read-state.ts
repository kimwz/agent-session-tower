import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TodoWorld } from './todo-model';

/**
 * What the owner has seen of each todo on this browser, as the sessions' and Slack's read marks are kept: per todo, the
 * newest comment the owner did not write (`TodoWorld.outside`) when they last had its detail open. A todo whose newest
 * such comment is another is unread. Only comments count: who changed a task's fields is not recorded.
 */
export type TodoReadState = Record<string, string>;
export const TODO_READ_KEY = 'tower.todo-read.v1';
/** Marks of todos no longer open are kept (one reopened stays read), so they are bounded: the oldest written go first. */
export const TODO_READ_LIMIT = 3000;

export function parseTodoReadState(value: string | null): TodoReadState | null {
  if (value === null) return null;
  try {
    const saved: unknown = JSON.parse(value);
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') return {};
    return Object.fromEntries(Object.entries(saved).filter(([id, mark]) => id.length > 0 && typeof mark === 'string'));
  // best-effort: damaged marks start over as all unread rather than breaking the page.
  } catch { return {}; }
}

/** Marks `marks` (todo id → comment id) as read; the same state when nothing changes. */
export function acknowledgeTodos(state: TodoReadState, marks: Readonly<Record<string, string>>): TodoReadState {
  const changed = Object.entries(marks).filter(([id, mark]) => state[id] !== mark);
  if (!changed.length) return state;
  const ids = new Set(changed.map(([id]) => id));
  const kept = Object.entries(state).filter(([id]) => !ids.has(id));
  return Object.fromEntries([...kept.slice(Math.max(0, kept.length + changed.length - TODO_READ_LIMIT)), ...changed]);
}

/** The stored marks: null when none were ever written, undefined without browser storage. */
function stored(): TodoReadState | null | undefined {
  try { return parseTodoReadState(localStorage.getItem(TODO_READ_KEY)); }
  // best-effort: without browser storage the marks live in memory only.
  catch { return undefined; }
}

export function unreadTodos(outside: Readonly<Record<string, string>>, state: TodoReadState): Set<string> {
  return new Set(Object.entries(outside).filter(([id, mark]) => state[id] !== mark).map(([id]) => id));
}

/**
 * The page's unread todos. `openId` is the todo whose detail shows: it is read while the page is visible once its detail
 * holds the newest outside comment, including comments that arrive while it stays open (the overview names one before
 * the detail is read again). A browser with no marks yet (the first load after this came) starts with every todo read,
 * once the overview is in.
 */
export function useTodoReadState(world: Pick<TodoWorld, 'outside' | 'availability' | 'detail'>, ready: boolean, openId: string | null): ReadonlySet<string> {
  const [read, setRead] = useState<TodoReadState | null>(() => stored() ?? null);
  // Written over what is stored now, so marks another window wrote meanwhile stay.
  const save = useCallback((update: (previous: TodoReadState | null) => TodoReadState) => setRead(previous => {
    const latest = stored();
    const base = latest === undefined ? previous : latest;
    const next = update(base);
    // best-effort: the marks stay usable in memory when browser storage refuses them.
    if (next !== previous) try { localStorage.setItem(TODO_READ_KEY, JSON.stringify(next)); } catch { /* Memory state remains usable. */ }
    return next;
  }), []);
  const outside = world.outside;
  // An unavailable file shows no comments: what it holds is not known to be read.
  const known = ready && world.availability.state !== 'unavailable';
  useEffect(() => { if (read === null && known) save(base => base ?? acknowledgeTodos({}, outside)); }, [read, known, outside, save]);
  const newest = openId ? outside[openId] : undefined;
  const mark = newest && world.detail?.task.id === openId && world.detail.comments.some(comment => comment.id === newest) ? newest : undefined;
  const started = read !== null;
  useEffect(() => {
    if (!openId || !mark || !started) return;
    const acknowledge = () => { if (document.visibilityState === 'visible') save(previous => acknowledgeTodos(previous ?? {}, { [openId]: mark })); };
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [openId, mark, started, save]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === TODO_READ_KEY) setRead(parseTodoReadState(event.newValue) ?? {}); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return useMemo(() => read === null ? new Set<string>() : unreadTodos(outside, read), [outside, read]);
}
