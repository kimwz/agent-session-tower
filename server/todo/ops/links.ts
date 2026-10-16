import type { TodoOpOf } from '../../../shared/todo/ops.js';
import { invalid, missing, stale, type TodoContext } from '../context.js';
import { liveTask } from './tasks.js';

/**
 * "Next" links between tasks: an order only. Neither task's state depends on the other, so completing, reopening or
 * moving one never touches a link; a link to a deleted task stays and is hidden until the task is restored.
 */

export function createLink(ctx: TodoContext, op: TodoOpOf<'link.create'>): void {
  if (op.fromTaskId === op.toTaskId) throw invalid('작업을 자기 자신의 다음 작업으로 연결할 수 없습니다.');
  if (ctx.get('SELECT 1 FROM todo_links WHERE id = ?', op.id)) throw invalid('같은 id의 연결이 이미 있습니다.');
  const from = liveTask(ctx, op.fromTaskId), to = liveTask(ctx, op.toTaskId);
  if (ctx.get('SELECT 1 FROM todo_links WHERE from_task_id = ? AND to_task_id = ? AND kind = ?', from.id, to.id, 'next')) throw stale('이미 연결된 작업입니다.');
  ctx.run('INSERT INTO todo_links (id, from_task_id, to_task_id, kind, created_at) VALUES (?, ?, ?, ?, ?)', op.id, from.id, to.id, 'next', ctx.now);
  ctx.touched.links.add(op.id);
  ctx.event(from.id, 'linked', { next: to.id });
  ctx.event(to.id, 'linked', { previous: from.id });
}

export function deleteLink(ctx: TodoContext, op: TodoOpOf<'link.delete'>): void {
  const link = ctx.get<{ id: string; from_task_id: string; to_task_id: string }>('SELECT * FROM todo_links WHERE id = ?', op.id);
  if (!link) throw missing('연결을 찾을 수 없습니다.');
  ctx.run('DELETE FROM todo_links WHERE id = ?', link.id);
  ctx.removedLinks.push(link.id);
  ctx.event(link.from_task_id, 'unlinked', { next: link.to_task_id });
  ctx.event(link.to_task_id, 'unlinked', { previous: link.from_task_id });
}
