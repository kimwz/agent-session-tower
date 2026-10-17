import type { TodoOpOf } from '../../../shared/todo/ops.js';
import { invalid, missing, type TodoContext } from '../context.js';
import { liveTask } from './tasks.js';

/**
 * Attachment rows. A file belongs to a task, or to one of its comments; it shows while it, its task and its comment
 * are not deleted. Deleting a task or comment never touches its files, so restoring one brings its files back as they
 * were; only `file.delete` and `file.restore` change a file.
 */

export interface NewTodoFile { id: string; taskId: string; commentId: string | null; name: string; mimeType: string; size: number; sha256: string }
interface FileRow { id: string; task_id: string; comment_id: string | null; deleted_at: string | null }

/** Throws unless a file can go on this task and comment now: both exist, are not deleted, and the comment is the task's. */
export function checkAttachable(ctx: TodoContext, taskId: string, commentId: string | null): void {
  const task = liveTask(ctx, taskId);
  if (commentId === null) return;
  const comment = ctx.get<{ task_id: string; deleted_at: string | null }>('SELECT task_id, deleted_at FROM todo_comments WHERE id = ?', commentId);
  if (!comment || comment.deleted_at) throw missing('댓글을 찾을 수 없습니다.');
  if (comment.task_id !== task.id) throw invalid('댓글이 그 작업에 없습니다.');
}

/** Adds an uploaded file. Its id was fixed when the upload began, so adding it again changes nothing. */
export function attachFile(ctx: TodoContext, file: NewTodoFile): void {
  if (ctx.get('SELECT 1 FROM todo_files WHERE id = ?', file.id)) return;
  checkAttachable(ctx, file.taskId, file.commentId);
  ctx.run('INSERT INTO todo_files (id, task_id, comment_id, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    file.id, file.taskId, file.commentId, file.name, file.mimeType, file.size, file.sha256, ctx.now);
  ctx.touched.files.add(file.id);
  ctx.event(file.taskId, 'attached', { file: file.id, ...(file.commentId ? { comment: file.commentId } : {}) });
}

export function deleteFile(ctx: TodoContext, op: TodoOpOf<'file.delete'>): void {
  const row = ctx.get<FileRow>('SELECT id, task_id, comment_id, deleted_at FROM todo_files WHERE id = ?', op.id);
  if (!row) throw missing('첨부 파일을 찾을 수 없습니다.');
  if (row.deleted_at) return;
  ctx.run('UPDATE todo_files SET deleted_at = ? WHERE id = ?', ctx.now, row.id);
  ctx.touched.files.add(row.id);
}

/** Brings back a deleted file, while its task and comment are there to show it. */
export function restoreFile(ctx: TodoContext, op: TodoOpOf<'file.restore'>): void {
  const row = ctx.get<FileRow>('SELECT id, task_id, comment_id, deleted_at FROM todo_files WHERE id = ?', op.id);
  if (!row) throw missing('첨부 파일을 찾을 수 없습니다.');
  if (!row.deleted_at) return;
  checkAttachable(ctx, row.task_id, row.comment_id);
  ctx.run('UPDATE todo_files SET deleted_at = NULL WHERE id = ?', row.id);
  ctx.touched.files.add(row.id);
}
