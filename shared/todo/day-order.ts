import { keyBetween, SORT_KEY_SPREAD_AT, spreadKeys, validSortKey } from './sort-key.js';
import type { TodoTask } from './types.js';

/**
 * The order of the tasks of one date, put by hand in the date lists (today, upcoming, a label's dates). A task keeps
 * it as `<YYYY-MM-DD>|<key>` in `dayOrder`, and the key counts only while that date is the task's date: a task whose
 * date changed since (moved, a repeat moved on or back, or changed by a build that knows nothing of it) simply has
 * none, so nothing has to clear it. The server, the page's immediate change and its undo all use these functions, so
 * they put tasks in the same order.
 */

export type DayTask = Pick<TodoTask, 'id' | 'sortKey' | 'dueDate' | 'dueTime' | 'priority' | 'dayOrder'>;

/** The task's key among the tasks of its date, or null when it has none that counts. */
export function dayKey(task: Pick<TodoTask, 'dueDate' | 'dayOrder'>): string | null {
  if (!task.dueDate || !task.dayOrder) return null;
  const bar = task.dayOrder.indexOf('|');
  if (bar < 0 || task.dayOrder.slice(0, bar) !== task.dueDate) return null;
  const key = task.dayOrder.slice(bar + 1);
  return validSortKey(key) ? key : null;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * The order of a date column: tasks put in order by hand first, in that order (by date first where a column spans
 * several); then timed tasks by time, then by priority, then in their own order.
 */
export function compareDay(a: DayTask, b: DayTask): number {
  const first = dayKey(a), second = dayKey(b);
  if (first !== null || second !== null) {
    if (first === null) return 1;
    if (second === null) return -1;
    const order = compare(a.dueDate!, b.dueDate!) || compare(first, second);
    if (order) return order;
  }
  return compare(a.dueTime ?? '99', b.dueTime ?? '99') || a.priority - b.priority || compare(a.sortKey, b.sortKey) || compare(a.id, b.id);
}

/** The task before `id` among the tasks of its date (null when it is first): where an undo puts it back. */
export function dayBefore(tasks: readonly DayTask[], id: string): string | null {
  const date = tasks.find(task => task.id === id)?.dueDate;
  const list = tasks.filter(task => task.dueDate === date).sort(compareDay);
  const index = list.findIndex(task => task.id === id);
  return index > 0 ? list[index - 1].id : null;
}

/**
 * The `dayOrder` of every task of the moved task's date, in their new order, after `id` moves after `afterId` (first
 * for null, last when `afterId` is not a task of that date). `tasks` are the open tasks of that date, in any order.
 * While every other task has a key, only the moved one gets a new key between its neighbours; the first move on a
 * date (or one after a task joined it, or once keys grew long) keys the whole date again in its new order.
 */
export function reorderDay(tasks: readonly DayTask[], id: string, afterId: string | null): { id: string; dayOrder: string }[] {
  const moved = tasks.find(task => task.id === id);
  const date = moved?.dueDate;
  if (!moved || !date) return [];
  const others = tasks.filter(task => task.id !== id && task.dueDate === date).sort(compareDay);
  const anchor = afterId === null ? -1 : others.findIndex(task => task.id === afterId);
  const index = afterId === null ? 0 : anchor < 0 ? others.length : anchor + 1;
  const order = [...others.slice(0, index), moved, ...others.slice(index)];
  if (others.every(task => dayKey(task) !== null)) {
    try {
      const key = keyBetween(index > 0 ? dayKey(others[index - 1]) : null, index < others.length ? dayKey(others[index]) : null);
      if (key.length <= SORT_KEY_SPREAD_AT) return order.map(task => ({ id: task.id, dayOrder: task === moved ? `${date}|${key}` : task.dayOrder! }));
    } catch { /* best-effort: two tasks share a key (two pages put them there at once), so the date is keyed again below. */ }
  }
  const keys = spreadKeys(order.length);
  return order.map((task, index) => ({ id: task.id, dayOrder: `${date}|${keys[index]}` }));
}
