import { randomUUID } from 'node:crypto';
import { reorderDay } from '../../../shared/todo/day-order.js';
import { anchoredRecurrence, nextOccurrence } from '../../../shared/todo/recurrence.js';
import type { TodoOpOf } from '../../../shared/todo/ops.js';
import type { TodoPriority, TodoRecurrence } from '../../../shared/todo/types.js';
import { invalid, missing, stale, type TodoContext } from '../context.js';
import { liveProject, liveSection } from './projects.js';

/** Sub-tasks go at most this many levels below a top-level task. */
export const MAX_TASK_DEPTH = 4;
/** Walks up and down stop here even in a file that broke the rules (a cycle never hangs a query). */
const WALK_LIMIT = MAX_TASK_DEPTH + 2;
/** A copy holds at most this many tasks, sub-tasks included: one request's work stays small. */
export const MAX_DUPLICATE_TASKS = 500;

interface TaskRow {
  id: string; project_id: string; section_id: string | null; parent_id: string | null; due_date: string | null; due_time: string | null;
  recurrence: string | null; completed_at: string | null; deleted_at: string | null; deleted_with: string | null; sort_key: string;
  priority: number; day_order: string | null;
}

export function taskRow(ctx: TodoContext, id: string): TaskRow | undefined {
  return ctx.get<TaskRow>('SELECT * FROM todo_tasks WHERE id = ?', id);
}
export function liveTask(ctx: TodoContext, id: string): TaskRow {
  const task = taskRow(ctx, id);
  if (!task || task.deleted_at) throw missing('작업을 찾을 수 없습니다.');
  return task;
}

const ancestors = (ctx: TodoContext, id: string) => ctx.all<TaskRow>(`WITH RECURSIVE up(id, depth) AS (SELECT parent_id, 1 FROM todo_tasks WHERE id = ? AND parent_id IS NOT NULL
  UNION ALL SELECT t.parent_id, up.depth + 1 FROM todo_tasks t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL AND up.depth < ${WALK_LIMIT})
  SELECT t.* FROM up JOIN todo_tasks t ON t.id = up.id ORDER BY up.depth`, id);

/** Every task below `id` (not `id` itself), with how far below. */
const descendants = (ctx: TodoContext, id: string) => ctx.all<TaskRow & { depth: number }>(`WITH RECURSIVE down(id, depth) AS (SELECT id, 1 FROM todo_tasks WHERE parent_id = ?
  UNION ALL SELECT t.id, down.depth + 1 FROM todo_tasks t JOIN down ON t.parent_id = down.id WHERE down.depth < ${WALK_LIMIT})
  SELECT t.*, down.depth AS depth FROM down JOIN todo_tasks t ON t.id = down.id`, id);

function labelsOf(ctx: TodoContext, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) if (!ctx.get('SELECT 1 FROM todo_labels WHERE id = ? AND deleted_at IS NULL', id)) throw missing('라벨을 찾을 수 없습니다.');
  return unique;
}
function setLabels(ctx: TodoContext, taskId: string, ids: string[]): void {
  ctx.run('DELETE FROM todo_task_labels WHERE task_id = ?', taskId);
  for (const id of labelsOf(ctx, ids)) ctx.run('INSERT INTO todo_task_labels (task_id, label_id) VALUES (?, ?)', taskId, id);
}

/** A repeating rule needs a date, and is anchored on it; a time needs a date too. */
function schedule(dueDate: string | null, dueTime: string | null, recurrence: TodoRecurrence | null): { dueTime: string | null; recurrence: string | null } {
  if (!dueDate && dueTime) throw invalid('시간을 정하려면 날짜가 필요합니다.');
  if (!dueDate && recurrence) throw invalid('반복하려면 날짜가 필요합니다.');
  if (recurrence?.until && dueDate && recurrence.until < dueDate) throw invalid('반복 종료일이 작업 날짜보다 앞입니다.');
  return { dueTime, recurrence: recurrence && dueDate ? JSON.stringify(anchoredRecurrence(recurrence, dueDate)) : null };
}

/** Where a task lands: under a parent (taking its project and section), or in a project and section. */
/** An archived project (or one above it) or an archived section: shown read-only, so nothing is put in it. */
function shelved(ctx: TodoContext, projectId: string, sectionId: string | null): boolean {
  for (let id: string | null = projectId, count = 0; id && count < 8; count++) {
    const project: { parent_id: string | null; archived_at: string | null } | undefined = ctx.get('SELECT parent_id, archived_at FROM todo_projects WHERE id = ?', id);
    if (!project) break;
    if (project.archived_at) return true;
    id = project.parent_id;
  }
  return !!sectionId && !!ctx.get<{ archived_at: string | null }>('SELECT archived_at FROM todo_sections WHERE id = ?', sectionId)?.archived_at;
}

function destination(ctx: TodoContext, input: { projectId?: string; sectionId?: string | null; parentId?: string | null }, fallbackProject: string) {
  if (input.parentId) {
    const parent = liveTask(ctx, input.parentId);
    if (shelved(ctx, parent.project_id, parent.section_id)) throw invalid('보관된 프로젝트나 섹션의 작업 아래에는 넣을 수 없습니다.');
    const depth = ancestors(ctx, parent.id).length + 1;
    return { projectId: parent.project_id, sectionId: parent.section_id, parentId: parent.id, depth, parent };
  }
  const project = liveProject(ctx, input.projectId ?? fallbackProject);
  const sectionId = input.sectionId ?? null;
  if (shelved(ctx, project.id, sectionId)) throw invalid('보관된 프로젝트나 섹션에는 작업을 넣을 수 없습니다.');
  if (sectionId && liveSection(ctx, sectionId).project_id !== project.id) throw invalid('섹션이 그 프로젝트에 없습니다.');
  return { projectId: project.id, sectionId, parentId: null, depth: 0, parent: undefined };
}

const siblings = (projectId: string, sectionId: string | null, parentId: string | null) =>
  ['project_id = ? AND section_id IS ? AND parent_id IS ?', [projectId, sectionId, parentId]] as const;

export function createTask(ctx: TodoContext, op: TodoOpOf<'task.create'>, inbox: string): void {
  if (taskRow(ctx, op.id)) throw invalid('같은 id의 작업이 이미 있습니다.');
  const place = destination(ctx, op, inbox);
  if (place.depth > MAX_TASK_DEPTH) throw invalid(`하위 작업은 ${MAX_TASK_DEPTH}단계까지 만들 수 있습니다.`);
  if (place.parent?.completed_at) throw invalid('완료된 작업 아래에는 하위 작업을 만들 수 없습니다.');
  const dueDate = op.dueDate ?? null;
  const { dueTime, recurrence } = schedule(dueDate, op.dueTime ?? null, op.recurrence ?? null);
  const [where, params] = siblings(place.projectId, place.sectionId, place.parentId);
  const key = ctx.place('todo_tasks', where, [...params], op.afterId);
  ctx.run(`INSERT INTO todo_tasks (id, project_id, section_id, parent_id, content, description, priority, due_date, due_time, recurrence, duration_min, deadline_date, slack_thread, sort_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, op.id, place.projectId, place.sectionId, place.parentId, op.content, op.description ?? '', op.priority ?? 4,
  dueDate, dueTime, recurrence, op.durationMin ?? null, op.deadlineDate ?? null, op.slackThread ? JSON.stringify(op.slackThread) : null, key, ctx.now, ctx.now);
  if (op.labelIds?.length) setLabels(ctx, op.id, op.labelIds);
  ctx.touched.tasks.add(op.id);
  // Who made it, as the request's sender (TodoStore.apply): GitHub sync marks an agent's todo in its issue.
  ctx.event(op.id, 'created', ctx.by ? { by: ctx.by } : {});
}

export function updateTask(ctx: TodoContext, op: TodoOpOf<'task.update'>): void {
  const task = liveTask(ctx, op.id);
  const { patch } = op;
  const dueDate = patch.dueDate !== undefined ? patch.dueDate : task.due_date;
  // Clearing the date clears what depends on it.
  const dueTime = patch.dueTime !== undefined ? patch.dueTime : dueDate ? task.due_time : null;
  const current = task.recurrence ? JSON.parse(task.recurrence) as TodoRecurrence : null;
  const rule = patch.recurrence !== undefined ? patch.recurrence : dueDate ? current : null;
  // A saved rule is already anchored; only a new rule is anchored on the date it starts from.
  const scheduled = schedule(dueDate, dueTime, rule);
  const recurrence = patch.recurrence === undefined && rule ? task.recurrence : scheduled.recurrence;
  const columns: Record<string, unknown> = { due_date: dueDate, due_time: scheduled.dueTime, recurrence };
  if (patch.content !== undefined) columns.content = patch.content;
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.priority !== undefined) columns.priority = patch.priority;
  if (patch.durationMin !== undefined) columns.duration_min = patch.durationMin;
  if (patch.deadlineDate !== undefined) columns.deadline_date = patch.deadlineDate;
  if (patch.slackThread !== undefined) columns.slack_thread = patch.slackThread ? JSON.stringify(patch.slackThread) : null;
  const names = Object.keys(columns);
  ctx.run(`UPDATE todo_tasks SET ${names.map(name => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map(name => columns[name] as string | number | null), ctx.now, task.id);
  if (patch.labelIds !== undefined) setLabels(ctx, task.id, patch.labelIds);
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'updated', { fields: Object.keys(patch) });
}

/** Puts an open, dated task in order among the open tasks of its date (shared/todo/day-order.ts). */
function moveInDay(ctx: TodoContext, task: TaskRow, afterId: string | null): void {
  if (task.completed_at || !task.due_date) throw invalid('날짜가 있는 열린 작업만 날짜 안에서 순서를 바꿀 수 있습니다.');
  if (afterId === task.id) throw invalid('작업을 자기 뒤로 옮길 수 없습니다.');
  const rows = ctx.all<TaskRow>(`SELECT t.* FROM todo_tasks t JOIN todo_projects p ON p.id = t.project_id AND p.deleted_at IS NULL
    WHERE t.due_date = ? AND t.deleted_at IS NULL AND t.completed_at IS NULL`, task.due_date);
  const tasks = rows.map(row => ({ id: row.id, sortKey: row.sort_key, dueDate: row.due_date, dueTime: row.due_time, priority: Number(row.priority) as TodoPriority, dayOrder: row.day_order }));
  const before = new Map(tasks.map(item => [item.id, item.dayOrder]));
  for (const item of reorderDay(tasks, task.id, afterId)) {
    if (before.get(item.id) === item.dayOrder) continue;
    ctx.run('UPDATE todo_tasks SET day_order = ? WHERE id = ?', item.dayOrder, item.id);
    ctx.touched.tasks.add(item.id);
  }
  ctx.run('UPDATE todo_tasks SET updated_at = ? WHERE id = ?', ctx.now, task.id);
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'moved', { day: task.due_date });
}

export function moveTask(ctx: TodoContext, op: TodoOpOf<'task.move'>): void {
  const task = liveTask(ctx, op.id);
  if (op.dayAfterId !== undefined) {
    if (op.projectId !== undefined || op.sectionId !== undefined || op.parentId !== undefined || op.afterId !== undefined) throw invalid('날짜 안 순서는 다른 이동과 함께 바꿀 수 없습니다.');
    moveInDay(ctx, task, op.dayAfterId);
    return;
  }
  // Naming another project or section without a parent makes it a top-level task there.
  const target = op.parentId !== undefined || op.projectId !== undefined || op.sectionId !== undefined
    ? destination(ctx, { projectId: op.projectId ?? task.project_id, sectionId: op.sectionId !== undefined ? op.sectionId : op.projectId && op.projectId !== task.project_id ? null : task.section_id, parentId: op.parentId ?? null }, task.project_id)
    : { projectId: task.project_id, sectionId: task.section_id, parentId: task.parent_id, depth: ancestors(ctx, task.id).length, parent: task.parent_id ? taskRow(ctx, task.parent_id) : undefined };
  const below = descendants(ctx, task.id);
  if (target.parentId && (target.parentId === task.id || below.some(row => row.id === target.parentId))) throw invalid('작업을 자기 하위 작업 아래로 옮길 수 없습니다.');
  const height = below.reduce((max, row) => Math.max(max, row.depth), 0);
  if (target.depth + height > MAX_TASK_DEPTH) throw invalid(`하위 작업은 ${MAX_TASK_DEPTH}단계까지 만들 수 있습니다.`);
  if (target.parent?.completed_at && !task.completed_at) throw invalid('완료된 작업 아래로 옮길 수 없습니다.');
  const [where, params] = siblings(target.projectId, target.sectionId, target.parentId);
  const key = ctx.place('todo_tasks', where, [...params], op.afterId, task.id);
  ctx.run('UPDATE todo_tasks SET project_id = ?, section_id = ?, parent_id = ?, sort_key = ?, updated_at = ? WHERE id = ?', target.projectId, target.sectionId, target.parentId, key, ctx.now, task.id);
  if (task.parent_id && task.parent_id !== target.parentId) ctx.parents.add(task.parent_id);
  if (target.projectId !== task.project_id || target.sectionId !== task.section_id) {
    // Sub-tasks stay with their parent.
    for (const row of below) {
      ctx.run('UPDATE todo_tasks SET project_id = ?, section_id = ?, updated_at = ? WHERE id = ?', target.projectId, target.sectionId, ctx.now, row.id);
      ctx.touched.tasks.add(row.id);
    }
  }
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'moved', { projectId: target.projectId, sectionId: target.sectionId, parentId: target.parentId });
}

/**
 * Copies a task and its open sub-tasks in one go, parents first: the copy sits right after the task among its siblings,
 * and each sub-task's copy keeps its order under the copied parent. What it holds is copied (title, description,
 * priority, dates, repeat, duration, deadline, labels); comments, attachments, completions and links are not.
 */
export function duplicateTask(ctx: TodoContext, op: TodoOpOf<'task.duplicate'>): void {
  if (taskRow(ctx, op.copyId)) throw invalid('같은 id의 작업이 이미 있습니다.');
  const source = liveTask(ctx, op.id);
  const parent = source.parent_id ? taskRow(ctx, source.parent_id) : undefined;
  if (parent?.completed_at) throw invalid('완료된 작업 아래에는 복사할 수 없습니다.');
  if (shelved(ctx, source.project_id, source.section_id)) throw invalid('보관된 프로젝트나 섹션에는 작업을 넣을 수 없습니다.');
  // Open sub-tasks under open parents, nearest first; one below a task left out is left out with it.
  const copies = new Map([[source.id, op.copyId]]);
  const below: (TaskRow & { depth: number })[] = [];
  for (const row of descendants(ctx, source.id).sort((a, b) => a.depth - b.depth || (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0))) {
    if (row.deleted_at || row.completed_at || !copies.has(row.parent_id!)) continue;
    if (ctx.copied + copies.size >= MAX_DUPLICATE_TASKS) throw invalid(`한 번에 작업은 하위 작업을 합쳐 ${MAX_DUPLICATE_TASKS}개까지 복사할 수 있습니다.`);
    copies.set(row.id, randomUUID());
    below.push(row);
  }
  ctx.copied += copies.size;
  if (ctx.copied > MAX_DUPLICATE_TASKS) throw invalid(`한 번에 작업은 하위 작업을 합쳐 ${MAX_DUPLICATE_TASKS}개까지 복사할 수 있습니다.`);
  const [where, params] = siblings(source.project_id, source.section_id, source.parent_id);
  const key = ctx.place('todo_tasks', where, [...params], source.id);
  for (const row of [source, ...below]) {
    const id = copies.get(row.id)!;
    ctx.run(`INSERT INTO todo_tasks (id, project_id, section_id, parent_id, content, description, priority, due_date, due_time, recurrence, duration_min, deadline_date, slack_thread, sort_key, created_at, updated_at)
      SELECT ?, project_id, section_id, ?, content, description, priority, due_date, due_time, recurrence, duration_min, deadline_date, slack_thread, ?, ?, ? FROM todo_tasks WHERE id = ?`,
    id, row === source ? source.parent_id : copies.get(row.parent_id!)!, row === source ? key : row.sort_key, ctx.now, ctx.now, row.id);
    ctx.run(`INSERT INTO todo_task_labels (task_id, label_id) SELECT ?, tl.label_id FROM todo_task_labels tl JOIN todo_labels l ON l.id = tl.label_id AND l.deleted_at IS NULL
      WHERE tl.task_id = ?`, id, row.id);
    ctx.touched.tasks.add(id);
    ctx.event(id, 'created', { copyOf: row.id, ...(ctx.by ? { by: ctx.by } : {}) });
  }
}

function closeTask(ctx: TodoContext, task: TaskRow, completionId: string, causeId: string | null): void {
  ctx.run('UPDATE todo_tasks SET completed_at = ?, updated_at = ? WHERE id = ?', ctx.now, ctx.now, task.id);
  ctx.run('INSERT INTO todo_completions (id, task_id, occurrence_date, completed_at, cause_id) VALUES (?, ?, ?, ?, ?)', completionId, task.id, task.due_date, ctx.now, causeId);
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'completed', causeId ? { with: causeId } : {});
}

/** Closes every open task below `id` together with the completion `causeId`; a repeating one is closed, not moved on. */
function closeBelow(ctx: TodoContext, id: string, causeId: string): void {
  for (const row of descendants(ctx, id)) {
    if (!row.completed_at && !row.deleted_at) closeTask(ctx, row, randomUUID(), causeId);
  }
}

/** Completing a task, or one occurrence of a repeating one, completes every open task below it. */
export function completeTask(ctx: TodoContext, op: TodoOpOf<'task.complete'>): void {
  const done = ctx.get<{ task_id: string }>('SELECT task_id FROM todo_completions WHERE id = ?', op.completionId);
  if (done) { if (done.task_id !== op.id) throw invalid('완료 id가 다른 작업에 쓰였습니다.'); return; }
  const task = liveTask(ctx, op.id);
  if (task.completed_at) throw stale('이미 완료된 작업입니다.');
  if (task.recurrence) {
    if (task.due_date !== op.occurrence) throw stale('이 반복 작업은 이미 다른 화면에서 완료되었습니다.');
    const next = nextOccurrence(JSON.parse(task.recurrence) as TodoRecurrence, task.due_date!, op.today);
    if (next) {
      ctx.run('INSERT INTO todo_completions (id, task_id, occurrence_date, completed_at) VALUES (?, ?, ?, ?)', op.completionId, task.id, task.due_date, ctx.now);
      ctx.run('UPDATE todo_tasks SET due_date = ?, updated_at = ? WHERE id = ?', next, ctx.now, task.id);
      ctx.touched.tasks.add(task.id);
      ctx.event(task.id, 'completed', { occurrence: task.due_date, next });
      closeBelow(ctx, task.id, op.completionId);
      return;
    }
  }
  closeTask(ctx, task, op.completionId, null);
  closeBelow(ctx, task.id, op.completionId);
}

const latestCompletion = (ctx: TodoContext, taskId: string) =>
  ctx.get<{ id: string; occurrence_date: string | null; cause_id: string | null }>('SELECT id, occurrence_date, cause_id FROM todo_completions WHERE task_id = ? AND undone_at IS NULL ORDER BY completed_at DESC, rowid DESC LIMIT 1', taskId);

function reopen(ctx: TodoContext, task: TaskRow, completion: { id: string; occurrence_date: string | null }): void {
  ctx.run('UPDATE todo_completions SET undone_at = ? WHERE id = ?', ctx.now, completion.id);
  // A repeating task goes back to the occurrence that was done.
  const due = task.recurrence && completion.occurrence_date ? completion.occurrence_date : task.due_date;
  ctx.run('UPDATE todo_tasks SET completed_at = NULL, due_date = ?, updated_at = ? WHERE id = ?', due, ctx.now, task.id);
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'uncompleted', { completion: completion.id });
}

/** An open task never sits below a completed one: reopening a task reopens the completed tasks above it. */
function reopenAncestors(ctx: TodoContext, id: string): void {
  for (const row of ancestors(ctx, id)) {
    if (!row.completed_at) continue;
    const last = latestCompletion(ctx, row.id);
    if (last) reopen(ctx, row, last);
    else { ctx.run('UPDATE todo_tasks SET completed_at = NULL, updated_at = ? WHERE id = ?', ctx.now, row.id); ctx.touched.tasks.add(row.id); }
  }
}

/** Undoes one completion: only a task's latest, so another page's later completion is never undone by mistake. */
export function uncompleteTask(ctx: TodoContext, op: TodoOpOf<'task.uncomplete'>): void {
  const task = liveTask(ctx, op.id);
  const completion = ctx.get<{ id: string; task_id: string; occurrence_date: string | null; undone_at: string | null }>('SELECT * FROM todo_completions WHERE id = ?', op.completionId);
  if (!completion || completion.task_id !== task.id) throw missing('완료 기록을 찾을 수 없습니다.');
  if (completion.undone_at) return;
  if (latestCompletion(ctx, task.id)?.id !== completion.id) throw stale('그 뒤에 다시 완료된 작업입니다.');
  if (!task.recurrence && !task.completed_at) throw stale('이미 다시 열린 작업입니다.');
  reopen(ctx, task, completion);
  reopenAncestors(ctx, task.id);
  // Tasks still below it that this completion closed open again with it, nearest first. One moved elsewhere since, or
  // now below a task completed on its own, stays done: undoing this completion never undoes another.
  const depth = new Map(descendants(ctx, task.id).map(row => [row.id, row.depth]));
  const caused = ctx.all<{ id: string; task_id: string; occurrence_date: string | null }>('SELECT id, task_id, occurrence_date FROM todo_completions WHERE cause_id = ? AND undone_at IS NULL', completion.id)
    .filter(item => depth.has(item.task_id)).sort((a, b) => depth.get(a.task_id)! - depth.get(b.task_id)!);
  for (const item of caused) {
    const row = taskRow(ctx, item.task_id);
    if (!row || row.deleted_at || latestCompletion(ctx, row.id)?.id !== item.id) continue;
    if (ancestors(ctx, row.id).some(above => above.completed_at)) continue;
    reopen(ctx, row, item);
  }
}

export function deleteTask(ctx: TodoContext, op: TodoOpOf<'task.delete'>): void {
  const task = liveTask(ctx, op.id);
  const batch = randomUUID();
  for (const row of [task, ...descendants(ctx, task.id)]) {
    if (row.deleted_at) continue;
    ctx.run('UPDATE todo_tasks SET deleted_at = ?, deleted_with = ?, updated_at = ? WHERE id = ?', ctx.now, batch, ctx.now, row.id);
    ctx.touched.tasks.add(row.id);
  }
  ctx.event(task.id, 'deleted');
}

/**
 * Brings back a deleted task with the sub-tasks deleted with it, where its parent is now. Below a task completed
 * meanwhile, what comes back open is closed with that task's completion instead of reopening it.
 */
export function restoreTask(ctx: TodoContext, op: TodoOpOf<'task.restore'>): void {
  const task = taskRow(ctx, op.id);
  if (!task) throw missing('작업을 찾을 수 없습니다.');
  if (!task.deleted_at) return;
  const parent = task.parent_id ? taskRow(ctx, task.parent_id) : undefined;
  if (parent?.deleted_at) throw invalid('상위 작업을 먼저 복구하세요.');
  const projectId = parent ? parent.project_id : liveProject(ctx, task.project_id).id;
  const section = !parent && task.section_id ? ctx.get<{ deleted_at: string | null }>('SELECT deleted_at FROM todo_sections WHERE id = ?', task.section_id) : undefined;
  const sectionId = parent ? parent.section_id : section && !section.deleted_at ? task.section_id : null;
  const restored: TaskRow[] = [];
  for (const row of [task, ...descendants(ctx, task.id)]) {
    if (row.deleted_with !== task.deleted_with) continue;
    ctx.run('UPDATE todo_tasks SET deleted_at = NULL, deleted_with = NULL, project_id = ?, section_id = ?, updated_at = ? WHERE id = ?', projectId, sectionId, ctx.now, row.id);
    ctx.touched.tasks.add(row.id);
    restored.push(row);
  }
  const [where, params] = siblings(projectId, sectionId, task.parent_id);
  ctx.keepKeyUnique('todo_tasks', where, [...params], task.id);
  const closedAbove = ancestors(ctx, task.id).find(row => row.completed_at);
  if (closedAbove) {
    // The completion that closed that task, or the one above that closed it with its parent, as closeBelow records it.
    const last = latestCompletion(ctx, closedAbove.id);
    const cause = last ? last.cause_id ?? last.id : null;
    for (const row of restored) if (!row.completed_at) closeTask(ctx, row, randomUUID(), cause);
  }
  ctx.event(task.id, 'restored');
}
