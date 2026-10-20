import type { TodoOpOf } from '../../../shared/todo/ops.js';
import { invalid, missing, type TodoContext } from '../context.js';
import { liveTask } from './tasks.js';

interface CommentRow { id: string; task_id: string; deleted_at: string | null }

const comment = (ctx: TodoContext, id: string) => ctx.get<CommentRow>('SELECT id, task_id, deleted_at FROM todo_comments WHERE id = ?', id);
/** A comment GitHub sync brought in is someone else's words on GitHub: it changes only from there. */
const fromGitHub = (ctx: TodoContext, id: string) => !!ctx.get("SELECT 1 FROM todo_github_comments WHERE comment_id = ? AND origin = 'github'", id);

export function createComment(ctx: TodoContext, op: TodoOpOf<'comment.create'>): void {
  if (comment(ctx, op.id)) throw invalid('같은 id의 댓글이 이미 있습니다.');
  const task = liveTask(ctx, op.taskId);
  ctx.run('INSERT INTO todo_comments (id, task_id, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', op.id, task.id, op.body, ctx.by, ctx.now, ctx.now);
  ctx.touched.comments.add(op.id);
  ctx.event(task.id, 'commented', { comment: op.id });
}

export function updateComment(ctx: TodoContext, op: TodoOpOf<'comment.update'>): void {
  const row = comment(ctx, op.id);
  if (!row || row.deleted_at) throw missing('댓글을 찾을 수 없습니다.');
  if (fromGitHub(ctx, row.id)) throw invalid('GitHub에서 온 댓글은 GitHub에서만 고칠 수 있습니다.');
  ctx.run('UPDATE todo_comments SET body = ?, updated_at = ? WHERE id = ?', op.body, ctx.now, row.id);
  ctx.touched.comments.add(row.id);
}

export function deleteComment(ctx: TodoContext, op: TodoOpOf<'comment.delete'>, restore = false): void {
  const row = comment(ctx, op.id);
  if (!row) throw missing('댓글을 찾을 수 없습니다.');
  if (Boolean(row.deleted_at) === !restore) return;
  if (fromGitHub(ctx, row.id)) throw invalid('GitHub에서 온 댓글은 GitHub에서만 지울 수 있습니다.');
  ctx.run('UPDATE todo_comments SET deleted_at = ?, updated_at = ? WHERE id = ?', restore ? null : ctx.now, ctx.now, row.id);
  ctx.touched.comments.add(row.id);
}
