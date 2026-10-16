import { randomUUID } from 'node:crypto';
import { anchoredRecurrence, nextOccurrence } from '../../../shared/todo/recurrence.js';
import type { TodoOpOf } from '../../../shared/todo/ops.js';
import type { TodoRecurrence } from '../../../shared/todo/types.js';
import { invalid, missing, stale, type TodoContext } from '../context.js';
import { liveProject, liveSection } from './projects.js';

/** Sub-tasks go at most this many levels below a top-level task. */
export const MAX_TASK_DEPTH = 4;

interface TaskRow {
  id: string; project_id: string; section_id: string | null; parent_id: string | null; due_date: string | null; due_time: string | null;
  recurrence: string | null; completed_at: string | null; deleted_at: string | null; sort_key: string;
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
  UNION ALL SELECT t.parent_id, up.depth + 1 FROM todo_tasks t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL)
  SELECT t.* FROM up JOIN todo_tasks t ON t.id = up.id ORDER BY up.depth`, id);

/** Every task below `id` (not `id` itself), with how far below. */
const descendants = (ctx: TodoContext, id: string) => ctx.all<TaskRow & { depth: number }>(`WITH RECURSIVE down(id, depth) AS (SELECT id, 1 FROM todo_tasks WHERE parent_id = ?
  UNION ALL SELECT t.id, down.depth + 1 FROM todo_tasks t JOIN down ON t.parent_id = down.id)
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
function destination(ctx: TodoContext, input: { projectId?: string; sectionId?: string | null; parentId?: string | null }, fallbackProject: string) {
  if (input.parentId) {
    const parent = liveTask(ctx, input.parentId);
    const depth = ancestors(ctx, parent.id).length + 1;
    return { projectId: parent.project_id, sectionId: parent.section_id, parentId: parent.id, depth, parent };
  }
  const project = liveProject(ctx, input.projectId ?? fallbackProject);
  if (project.archived_at) throw invalid('보관된 프로젝트에는 작업을 넣을 수 없습니다.');
  const sectionId = input.sectionId ?? null;
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
  ctx.run(`INSERT INTO todo_tasks (id, project_id, section_id, parent_id, content, description, priority, due_date, due_time, recurrence, duration_min, deadline_date, sort_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, op.id, place.projectId, place.sectionId, place.parentId, op.content, op.description ?? '', op.priority ?? 4,
  dueDate, dueTime, recurrence, op.durationMin ?? null, op.deadlineDate ?? null, key, ctx.now, ctx.now);
  if (op.labelIds?.length) setLabels(ctx, op.id, op.labelIds);
  ctx.touched.tasks.add(op.id);
  ctx.event(op.id, 'created');
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
  const names = Object.keys(columns);
  ctx.run(`UPDATE todo_tasks SET ${names.map(name => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map(name => columns[name] as string | number | null), ctx.now, task.id);
  if (patch.labelIds !== undefined) setLabels(ctx, task.id, patch.labelIds);
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'updated', { fields: Object.keys(patch) });
}

export function moveTask(ctx: TodoContext, op: TodoOpOf<'task.move'>): void {
  const task = liveTask(ctx, op.id);
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
  ctx.get<{ id: string; occurrence_date: string | null }>('SELECT id, occurrence_date FROM todo_completions WHERE task_id = ? AND undone_at IS NULL ORDER BY completed_at DESC, rowid DESC LIMIT 1', taskId);

function reopen(ctx: TodoContext, task: TaskRow, completion: { id: string; occurrence_date: string | null }): void {
  ctx.run('UPDATE todo_completions SET undone_at = ? WHERE id = ?', ctx.now, completion.id);
  // A repeating task goes back to the occurrence that was done.
  const due = task.recurrence && completion.occurrence_date ? completion.occurrence_date : task.due_date;
  ctx.run('UPDATE todo_tasks SET completed_at = NULL, due_date = ?, updated_at = ? WHERE id = ?', due, ctx.now, task.id);
  ctx.touched.tasks.add(task.id);
  ctx.event(task.id, 'uncompleted', { completion: completion.id });
}

/** An open task never sits below a completed one: reopening a task reopens the completed tasks above it. */
export function reopenAncestors(ctx: TodoContext, id: string): void {
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
  // Tasks below that this completion closed open again with it.
  for (const caused of ctx.all<{ id: string; task_id: string; occurrence_date: string | null }>('SELECT id, task_id, occurrence_date FROM todo_completions WHERE cause_id = ? AND undone_at IS NULL', completion.id)) {
    const row = taskRow(ctx, caused.task_id);
    if (!row || row.deleted_at || latestCompletion(ctx, row.id)?.id !== caused.id) continue;
    reopen(ctx, row, caused);
    // It may have been moved below another completed task since.
    reopenAncestors(ctx, row.id);
  }
}

export function deleteTask(ctx: TodoContext, op: TodoOpOf<'task.delete'>): void {
  const task = liveTask(ctx, op.id);
  for (const row of [task, ...descendants(ctx, task.id)]) {
    if (row.deleted_at) continue;
    ctx.run('UPDATE todo_tasks SET deleted_at = ?, updated_at = ? WHERE id = ?', ctx.now, ctx.now, row.id);
    ctx.touched.tasks.add(row.id);
  }
  ctx.event(task.id, 'deleted');
}

/** Brings back a deleted task with the sub-tasks deleted with it. */
export function restoreTask(ctx: TodoContext, op: TodoOpOf<'task.restore'>): void {
  const task = taskRow(ctx, op.id);
  if (!task) throw missing('작업을 찾을 수 없습니다.');
  if (!task.deleted_at) return;
  const parent = task.parent_id ? taskRow(ctx, task.parent_id) : undefined;
  if (parent?.deleted_at) throw invalid('상위 작업을 먼저 복구하세요.');
  liveProject(ctx, task.project_id);
  const section = task.section_id ? ctx.get<{ deleted_at: string | null }>('SELECT deleted_at FROM todo_sections WHERE id = ?', task.section_id) : undefined;
  const sectionId = section && !section.deleted_at ? task.section_id : null;
  const stamp = task.deleted_at;
  for (const row of [task, ...descendants(ctx, task.id)]) {
    if (row.deleted_at !== stamp) continue;
    ctx.run('UPDATE todo_tasks SET deleted_at = NULL, section_id = ?, updated_at = ? WHERE id = ?', sectionId, ctx.now, row.id);
    ctx.touched.tasks.add(row.id);
  }
  const [where, params] = siblings(task.project_id, sectionId, task.parent_id);
  ctx.keepKeyUnique('todo_tasks', where, [...params], task.id);
  if (!task.completed_at) reopenAncestors(ctx, task.id);
  ctx.event(task.id, 'restored');
}
