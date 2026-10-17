import type { TodoOp } from './ops.js';
import type { QuickAddResult } from './quick-add.js';
import type { TodoTask } from './types.js';

/**
 * The operations behind a change made in words: adding a task (from Quick Add or an agent), completing one, and the
 * two in one request ("complete and add the next"). The page and the agents' tools build them here, so both make
 * exactly the same requests.
 */

/** A task being added after `taskId`, completing that one too when `complete`. */
export interface FollowUp { taskId: string; complete: boolean }

export interface QuickAddDraft {
  content: string;
  description: string;
  /** A section of null puts it outside any section. */
  result: Omit<QuickAddResult, 'content' | 'tokens' | 'sectionId'> & { sectionId?: string | null };
}

export type NewId = () => string;
const randomId: NewId = () => crypto.randomUUID();

/** Neither completed nor deleted. */
export const isOpenTask = (task: Pick<TodoTask, 'completedAt' | 'deletedAt'> | undefined): boolean => !!task && !task.completedAt && !task.deletedAt;

/** Completes a task; a repeating one completes its current date and moves on to the next. */
export function completeOp(task: Pick<TodoTask, 'id' | 'recurrence' | 'dueDate'>, today: string, newId: NewId = randomId): TodoOp {
  return { op: 'task.complete', id: task.id, completionId: newId(), occurrence: task.recurrence ? task.dueDate : null, today };
}

/** A new task, with the labels it names that do not exist yet created first. */
export function createTaskOps(draft: QuickAddDraft, place: { afterId?: string | null; parentId?: string | null } = {}, newId: NewId = randomId): { ops: TodoOp[]; id: string } {
  const id = newId();
  const ops: TodoOp[] = draft.result.newLabels.map(name => ({ op: 'label.create', id: newId(), name }));
  const labelIds = [...draft.result.labelIds, ...ops.map(op => op.id)];
  const { result } = draft;
  ops.push({
    op: 'task.create', id, content: draft.content,
    ...(place.parentId ? { parentId: place.parentId } : { ...(result.projectId ? { projectId: result.projectId } : {}), ...(result.sectionId !== undefined ? { sectionId: result.sectionId } : {}) }),
    ...(place.afterId !== undefined ? { afterId: place.afterId } : {}),
    ...(draft.description.trim() ? { description: draft.description } : {}),
    ...(result.priority ? { priority: result.priority } : {}),
    ...(result.dueDate ? { dueDate: result.dueDate, ...(result.dueTime ? { dueTime: result.dueTime } : {}), ...(result.recurrence ? { recurrence: result.recurrence } : {}) } : {}),
    ...(result.durationMin ? { durationMin: result.durationMin } : {}),
    ...(result.deadlineDate ? { deadlineDate: result.deadlineDate } : {}),
    ...(labelIds.length ? { labelIds } : {}),
  });
  return { ops, id };
}

/** Adding a task: alone, after another task, or completing that one too, in one request. */
export function quickAddOps(draft: QuickAddDraft, follow: FollowUp | null, before: TodoTask | undefined, today: string,
  place: { parentId?: string | null } = {}, newId: NewId = randomId): { ops: TodoOp[]; id: string } {
  const created = createTaskOps(draft, place, newId);
  if (!follow || !before) return created;
  return { id: created.id, ops: [
    ...(follow.complete && isOpenTask(before) ? [completeOp(before, today, newId)] : []),
    ...created.ops,
    { op: 'link.create', id: newId(), fromTaskId: follow.taskId, toTaskId: created.id },
  ] };
}
