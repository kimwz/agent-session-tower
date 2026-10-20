import type { TodoAgent, TodoAgentState, TodoComment, TodoCommentAuthor, TodoCompletion, TodoEvent, TodoEventKind, TodoFile, TodoGitHubBinding, TodoLabel, TodoLayout, TodoLink, TodoPriority, TodoProject, TodoRecurrence, TodoSection, TodoTask } from '../../shared/todo/types.js';

/** Each table's row and the value the page sees, converted in one place per table. */

type Row = Record<string, unknown>;
const text = (value: unknown) => value as string;
const maybe = (value: unknown) => (value ?? null) as string | null;
const flag = (value: unknown) => value === 1 || value === 1n;
const stamps = (row: Row) => ({ createdAt: text(row.created_at), updatedAt: text(row.updated_at), deletedAt: maybe(row.deleted_at) });

export const projectOf = (row: Row): TodoProject => ({
  id: text(row.id), parentId: maybe(row.parent_id), name: text(row.name), color: text(row.color), favorite: flag(row.favorite), inbox: flag(row.inbox),
  layout: text(row.layout) as TodoLayout, archivedAt: maybe(row.archived_at), sortKey: text(row.sort_key), ...stamps(row),
});

export const sectionOf = (row: Row): TodoSection => ({
  id: text(row.id), projectId: text(row.project_id), name: text(row.name), collapsed: flag(row.collapsed), archivedAt: maybe(row.archived_at),
  sortKey: text(row.sort_key), ...stamps(row),
});

export const labelOf = (row: Row): TodoLabel => ({
  id: text(row.id), name: text(row.name), color: text(row.color), favorite: flag(row.favorite), sortKey: text(row.sort_key), ...stamps(row),
});

/** `labels` is the task's label ids joined with commas (see TASK_COLUMNS). */
export const taskOf = (row: Row): TodoTask => ({
  id: text(row.id), projectId: text(row.project_id), sectionId: maybe(row.section_id), parentId: maybe(row.parent_id),
  content: text(row.content), description: text(row.description), priority: Number(row.priority) as TodoPriority,
  dueDate: maybe(row.due_date), dueTime: maybe(row.due_time), recurrence: row.recurrence ? JSON.parse(text(row.recurrence)) as TodoRecurrence : null,
  durationMin: row.duration_min === null || row.duration_min === undefined ? null : Number(row.duration_min), deadlineDate: maybe(row.deadline_date),
  labelIds: row.labels ? text(row.labels).split(',').sort() : [], sortKey: text(row.sort_key), dayOrder: maybe(row.day_order), completedAt: maybe(row.completed_at), ...stamps(row),
});

/** A task's columns with its live labels, for `SELECT ${TASK_COLUMNS} FROM todo_tasks t …`. */
export const TASK_COLUMNS = `t.*, (SELECT group_concat(tl.label_id) FROM todo_task_labels tl JOIN todo_labels l ON l.id = tl.label_id AND l.deleted_at IS NULL WHERE tl.task_id = t.id) AS labels`;

export const linkOf = (row: Row): TodoLink => ({
  id: text(row.id), fromTaskId: text(row.from_task_id), toTaskId: text(row.to_task_id), kind: text(row.kind) as 'next', createdAt: text(row.created_at),
});

/** `gh_login` and `gh_url` come with a comment GitHub sent (see COMMENT_COLUMNS). */
export const commentOf = (row: Row): TodoComment => ({
  id: text(row.id), taskId: text(row.task_id), body: text(row.body), author: row.author === 'owner' || row.author === 'agent' ? row.author as TodoCommentAuthor : null, ...stamps(row),
  ...(row.gh_login ? { external: { source: 'github' as const, login: text(row.gh_login), url: text(row.gh_url) } } : {}),
});

/** A comment's columns with where GitHub sent it from, for `SELECT ${COMMENT_COLUMNS} FROM todo_comments c …`. */
export const COMMENT_COLUMNS = `c.*, (SELECT g.login FROM todo_github_comments g WHERE g.comment_id = c.id AND g.origin = 'github') AS gh_login,
  (SELECT g.url FROM todo_github_comments g WHERE g.comment_id = c.id AND g.origin = 'github') AS gh_url`;

export const githubBindingOf = (row: Row): TodoGitHubBinding => ({
  id: text(row.id), scope: { kind: text(row.scope_kind) as TodoGitHubBinding['scope']['kind'], id: text(row.scope_id) }, repo: text(row.repo),
  account: text(row.account), error: maybe(row.error), createdAt: text(row.created_at),
});

export const completionOf = (row: Row): TodoCompletion => ({
  id: text(row.id), taskId: text(row.task_id), occurrenceDate: maybe(row.occurrence_date), completedAt: text(row.completed_at),
  ...(row.cause_id ? { causeId: text(row.cause_id) } : {}),
});

export const eventOf = (row: Row): TodoEvent => ({
  id: String(row.id), taskId: text(row.task_id), kind: text(row.kind) as TodoEventKind, detail: JSON.parse(text(row.detail)) as Record<string, unknown>, at: text(row.at),
});

export const fileOf = (row: Row): TodoFile => ({
  id: text(row.id), taskId: text(row.task_id), commentId: maybe(row.comment_id), name: text(row.name), mimeType: text(row.mime), size: Number(row.size),
  sha256: text(row.sha256), createdAt: text(row.created_at), deletedAt: maybe(row.deleted_at),
});

export const agentOf = (row: Row): TodoAgent => ({
  taskId: text(row.task_id), ...(row.session_id ? { sessionId: text(row.session_id) } : {}), provider: text(row.provider) as TodoAgent['provider'],
  state: text(row.state) as TodoAgentState, createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});

/** Files that show: not deleted, on a task not deleted, and on no comment or one not deleted (`f` the file, `c` its comment). */
export const VISIBLE_FILE = 'f.deleted_at IS NULL AND (f.comment_id IS NULL OR c.deleted_at IS NULL)';
