import { constants, lstatSync, openSync, closeSync, fchmodSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TowerError } from '../../shared/errors.js';
import type { TodoOp, TodoOpName, TodoOpOf, TodoRequest } from '../../shared/todo/ops.js';
import type { TodoAvailability, TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../shared/todo/types.js';
import { nodeVerified, sqlitePatched } from '../storage/runtime.js';
import { TodoContext } from './context.js';
import { createComment, deleteComment, updateComment } from './ops/comments.js';
import { createLink, deleteLink } from './ops/links.js';
import { createLabel, createProject, createSection, deleteLabel, deleteProject, deleteSection, moveLabel, moveProject, moveSection, restoreLabel, restoreProject, restoreSection, updateLabel, updateProject, updateSection } from './ops/projects.js';
import { completeTask, createTask, deleteTask, moveTask, restoreTask, uncompleteTask, updateTask } from './ops/tasks.js';
import { TASK_COLUMNS, commentOf, completionOf, eventOf, labelOf, linkOf, projectOf, sectionOf, taskOf } from './rows.js';
import { TODO_SCHEMA, TODO_SCHEMA_STEP, minWriterAt } from './schema.js';

/** The completed list's page cursor: the last completion's time and row. */
export const TODO_COMPLETED_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~(\d{1,15})$/;
/** The fixed id of the one project that always exists. */
export const INBOX_ID = 'inbox';
/** Deleted things can be restored this long, then they are removed for good. */
export const TODO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

type Handler = (ctx: TodoContext, op: TodoOp) => void;
const handler = <N extends TodoOpName>(apply: (ctx: TodoContext, op: TodoOpOf<N>) => void) => apply as Handler;

/** Each operation and the one function that applies it. */
const OPERATIONS: { [N in TodoOpName]: Handler } = {
  'task.create': handler<'task.create'>((ctx, op) => createTask(ctx, op, INBOX_ID)),
  'task.update': handler(updateTask),
  'task.move': handler(moveTask),
  'task.complete': handler(completeTask),
  'task.uncomplete': handler(uncompleteTask),
  'task.delete': handler(deleteTask),
  'task.restore': handler(restoreTask),
  'link.create': handler(createLink),
  'link.delete': handler(deleteLink),
  'project.create': handler(createProject),
  'project.update': handler(updateProject),
  'project.move': handler(moveProject),
  'project.delete': handler(deleteProject),
  'project.restore': handler(restoreProject),
  'section.create': handler(createSection),
  'section.update': handler(updateSection),
  'section.move': handler(moveSection),
  'section.delete': handler(deleteSection),
  'section.restore': handler(restoreSection),
  'label.create': handler(createLabel),
  'label.update': handler(updateLabel),
  'label.move': handler(moveLabel),
  'label.delete': handler(deleteLabel),
  'label.restore': handler(restoreLabel),
  'comment.create': handler(createComment),
  'comment.update': handler(updateComment),
  'comment.delete': handler(deleteComment),
  'comment.restore': handler<'comment.restore'>((ctx, op) => deleteComment(ctx, { op: 'comment.delete', id: op.id }, true)),
};

type Sqlite = typeof import('node:sqlite');

export interface TodoStoreOptions {
  now?: () => Date;
  /** Replaces the runtime check (tests). */
  runtime?: () => string | undefined;
}

/** Why this process cannot use SQLite safely, if it cannot (the same rule the worker's store follows). */
function runtimeProblem(sqlite: Sqlite | undefined, version: string | undefined): string | undefined {
  if (!sqlite?.DatabaseSync) return 'node:sqlite를 사용할 수 없습니다.';
  if (!version || !sqlitePatched(version)) return `SQLite ${version ?? '?'}에는 필요한 WAL 수정이 없습니다.`;
  if (!nodeVerified(process.version)) return `Node.js ${process.version}는 검증된 저장소 런타임이 아닙니다.`;
  return undefined;
}

/**
 * The owner's todos in `<state>/todos.sqlite`, owned by the web process (which holds the state directory's lock) and
 * apart from the worker's `state.sqlite`. Every change is one request applied in one transaction. Anything wrong with
 * the file makes only the Todo page unavailable; the rest of Tower does not depend on it.
 */
export class TodoStore {
  readonly path: string;
  private db?: DatabaseSync;
  private state: TodoAvailability = { state: 'unavailable', reason: '할 일 저장소를 아직 열지 않았습니다.' };
  private revisionValue = 0;
  /** The steps the open file has, which may be more than this build knows. */
  private fileStep = 0;

  constructor(stateDir: string, private readonly options: TodoStoreOptions = {}) { this.path = join(stateDir, 'todos.sqlite'); }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  /** Opens (creating or bringing up to date) the file. Never throws: a failure leaves the store unavailable. */
  start(): void {
    try { this.open(); }
    catch (error) {
      this.close();
      this.state = { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
      console.error(`Todo storage is unavailable: ${this.state.reason}`);
    }
  }

  private open(): void {
    const sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') as Sqlite | undefined : undefined;
    // The file is made owner-only before SQLite opens it; its -wal and -shm files take the same mode.
    try {
      const info = lstatSync(this.path);
      if (!info.isFile()) throw new Error(`${this.path}는 일반 파일이 아닙니다.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      closeSync(openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    }
    const handle = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fchmodSync(handle, 0o600); } finally { closeSync(handle); }
    if (!sqlite?.DatabaseSync) throw new Error(runtimeProblem(sqlite, undefined));
    const db = new sqlite.DatabaseSync(this.path);
    this.db = db;
    const problem = this.options.runtime ? this.options.runtime() : runtimeProblem(sqlite, (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
    if (problem) throw new Error(problem);
    // Only this process writes, under the state lock: waiting for a lock would only stall the web, so none is waited for.
    db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.fileStep = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (this.fileStep < TODO_SCHEMA_STEP) this.migrate();
    const minWriter = Number(this.meta('min_writer') ?? 1);
    this.state = minWriter > TODO_SCHEMA_STEP
      ? { state: 'read-only', reason: '더 새로운 Tower가 바꾼 할 일 저장소입니다. Tower를 업데이트하면 다시 편집할 수 있습니다.' }
      : { state: 'ready' };
    this.revisionValue = Number(this.meta('revision') ?? 0);
    if (this.state.state === 'ready' && !this.get('SELECT 1 FROM todo_projects WHERE inbox = 1')) {
      this.transaction(() => this.run('INSERT INTO todo_projects (id, name, inbox, sort_key, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)', INBOX_ID, 'Inbox', 'V', this.now(), this.now()));
    }
  }

  private migrate(): void {
    this.transaction(() => {
      for (let step = this.fileStep; step < TODO_SCHEMA_STEP; step++) this.db!.exec(TODO_SCHEMA[step].sql);
      this.db!.exec(`PRAGMA user_version = ${TODO_SCHEMA_STEP}`);
      this.setMeta('min_writer', String(minWriterAt(TODO_SCHEMA_STEP)));
    });
    this.fileStep = TODO_SCHEMA_STEP;
  }

  close(): void {
    try { this.db?.close(); } catch (error) { console.error(`Todo storage did not close cleanly: ${error instanceof Error ? error.message : String(error)}`); }
    this.db = undefined;
    if (this.state.state !== 'unavailable') this.state = { state: 'unavailable', reason: '할 일 저장소가 닫혔습니다.' };
  }

  availability(): TodoAvailability { return this.state; }
  revision(): number { return this.revisionValue; }

  private get<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db!.prepare(sql).get(...params) as T | undefined;
  }
  private all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db!.prepare(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: (string | number | null)[]): void { this.db!.prepare(sql).run(...params); }
  private meta(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM todo_meta WHERE key = ?', key)?.value; }
  private setMeta(key: string, value: string): void { this.run('INSERT INTO todo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  private transaction<T>(work: () => T): T {
    const db = this.db!;
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) { throw busy(error); }
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw busy(error);
    }
  }

  private readable(): void {
    if (!this.db || this.state.state === 'unavailable') throw new TowerError('unavailable', `할 일을 사용할 수 없습니다: ${this.state.state === 'unavailable' ? this.state.reason : ''}`);
  }
  private writable(): void {
    this.readable();
    if (this.state.state === 'read-only') throw new TowerError('locked', this.state.reason);
  }

  overview(): TodoOverview {
    if (!this.db || this.state.state === 'unavailable') return { availability: this.state, revision: this.revisionValue, projects: [], sections: [], labels: [], tasks: [], links: [], commentCounts: {} };
    const tasks = this.all(`SELECT ${TASK_COLUMNS} FROM todo_tasks t JOIN todo_projects p ON p.id = t.project_id AND p.deleted_at IS NULL WHERE t.deleted_at IS NULL AND t.completed_at IS NULL`).map(taskOf);
    const links = this.all(`SELECT k.* FROM todo_links k JOIN todo_tasks a ON a.id = k.from_task_id AND a.deleted_at IS NULL JOIN todo_tasks b ON b.id = k.to_task_id AND b.deleted_at IS NULL
      WHERE a.completed_at IS NULL OR b.completed_at IS NULL`).map(linkOf);
    const commentCounts = Object.fromEntries(this.all<{ task_id: string; n: number }>(`SELECT c.task_id, COUNT(*) AS n FROM todo_comments c JOIN todo_tasks t ON t.id = c.task_id
      WHERE c.deleted_at IS NULL AND t.deleted_at IS NULL AND t.completed_at IS NULL GROUP BY c.task_id`).map(row => [row.task_id, Number(row.n)]));
    return {
      availability: this.state, revision: this.revisionValue,
      projects: this.all('SELECT * FROM todo_projects WHERE deleted_at IS NULL ORDER BY sort_key').map(projectOf),
      sections: this.all('SELECT * FROM todo_sections WHERE deleted_at IS NULL ORDER BY sort_key').map(sectionOf),
      labels: this.all('SELECT * FROM todo_labels WHERE deleted_at IS NULL ORDER BY sort_key').map(labelOf),
      tasks, links, commentCounts,
    };
  }

  private task(id: string): TodoTask | undefined {
    const row = this.get(`SELECT ${TASK_COLUMNS} FROM todo_tasks t WHERE t.id = ?`, id);
    return row ? taskOf(row) : undefined;
  }

  detail(id: string): TodoTaskDetail {
    this.readable();
    const task = this.task(id);
    if (!task || task.deletedAt) throw new TowerError('not-found', '작업을 찾을 수 없습니다.');
    const subtasks = this.all(`WITH RECURSIVE down(id) AS (SELECT id FROM todo_tasks WHERE parent_id = ? UNION ALL SELECT t.id FROM todo_tasks t JOIN down ON t.parent_id = down.id)
      SELECT ${TASK_COLUMNS} FROM todo_tasks t JOIN down ON down.id = t.id WHERE t.deleted_at IS NULL ORDER BY t.sort_key`, id).map(taskOf);
    const related = (column: 'from_task_id' | 'to_task_id', other: 'from_task_id' | 'to_task_id') =>
      this.all<Record<string, unknown> & { other: string }>(`SELECT k.*, k.${other} AS other FROM todo_links k JOIN todo_tasks o ON o.id = k.${other} AND o.deleted_at IS NULL WHERE k.${column} = ? ORDER BY k.created_at`, id)
        .map(row => ({ link: linkOf(row), task: this.task(row.other)! }));
    return {
      task, subtasks,
      comments: this.all('SELECT * FROM todo_comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at', id).map(commentOf),
      completions: this.all('SELECT * FROM todo_completions WHERE task_id = ? AND undone_at IS NULL ORDER BY completed_at DESC LIMIT 50', id).map(completionOf),
      events: this.all('SELECT * FROM todo_events WHERE task_id = ? ORDER BY id DESC LIMIT 100', id).map(eventOf),
      previous: related('to_task_id', 'from_task_id'), next: related('from_task_id', 'to_task_id'),
    };
  }

  /** Completions newest first. `before` is the cursor a page answered (`<time>~<row>`), so rows of one time never fall between pages. */
  completed(input: { projectId?: string; before?: string; limit?: number }): TodoCompletedPage {
    this.readable();
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const cursor = input.before ? TODO_COMPLETED_CURSOR.exec(input.before) : undefined;
    if (input.before && !cursor) throw new TowerError('invalid', '완료 목록 커서가 올바르지 않습니다.');
    const [at, row] = cursor ? [cursor[1], Number(cursor[2])] : [null, null];
    const rows = this.all<Record<string, unknown>>(`SELECT c.rowid AS c_row, c.id AS c_id, c.task_id AS c_task_id, c.occurrence_date AS c_occurrence_date, c.completed_at AS c_completed_at, ${TASK_COLUMNS}
      FROM todo_completions c JOIN todo_tasks t ON t.id = c.task_id JOIN todo_projects p ON p.id = t.project_id AND p.deleted_at IS NULL
      WHERE c.undone_at IS NULL AND t.deleted_at IS NULL AND (? IS NULL OR t.project_id = ?)
        AND (? IS NULL OR c.completed_at < ? OR (c.completed_at = ? AND c.rowid < ?))
      ORDER BY c.completed_at DESC, c.rowid DESC LIMIT ?`, input.projectId ?? null, input.projectId ?? null, at, at, at, row, limit + 1);
    const page = rows.slice(0, limit);
    const items = page.map(item => ({
      completion: completionOf({ id: item.c_id, task_id: item.c_task_id, occurrence_date: item.c_occurrence_date, completed_at: item.c_completed_at }), task: taskOf(item),
    }));
    const last = page[page.length - 1];
    return { items, ...(rows.length > limit && last ? { before: `${String(last.c_completed_at)}~${Number(last.c_row)}` } : {}) };
  }

  /** Tasks whose title or description contains `query`, open ones first. */
  search(query: string, input: { completed?: boolean; limit?: number } = {}): TodoTask[] {
    this.readable();
    const pattern = `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    return this.all(`SELECT ${TASK_COLUMNS} FROM todo_tasks t JOIN todo_projects p ON p.id = t.project_id AND p.deleted_at IS NULL
      WHERE t.deleted_at IS NULL AND (? = 1 OR t.completed_at IS NULL) AND (t.content LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')
      ORDER BY t.completed_at IS NOT NULL, t.updated_at DESC LIMIT ?`, input.completed ? 1 : 0, pattern, pattern, limit).map(taskOf);
  }

  /** Applies a request's operations together, or none of them. A request sent again answers what it answered first. */
  apply(request: TodoRequest): TodoChanges {
    this.writable();
    return this.transaction(() => {
      const earlier = this.get<{ result: string }>('SELECT result FROM todo_requests WHERE id = ?', request.requestId);
      if (earlier) return JSON.parse(earlier.result) as TodoChanges;
      if (Number(this.meta('min_writer') ?? 1) > TODO_SCHEMA_STEP) throw new TowerError('locked', '더 새로운 Tower가 바꾼 할 일 저장소입니다.');
      const ctx = new TodoContext(this.db!, this.now());
      for (const op of request.ops) OPERATIONS[op.op](ctx, op);
      const revision = this.revisionValue + 1;
      this.setMeta('revision', String(revision));
      const changes = this.changes(ctx, revision);
      this.run('INSERT INTO todo_requests (id, result, at) VALUES (?, ?, ?)', request.requestId, JSON.stringify(changes), ctx.now);
      this.revisionValue = revision;
      return changes;
    });
  }

  private changes(ctx: TodoContext, revision: number): TodoChanges {
    const rows = (table: string, ids: Set<string>) => [...ids].map(id => this.get(`SELECT * FROM ${table} WHERE id = ?`, id)).filter((row): row is Record<string, unknown> => !!row);
    return {
      revision,
      projects: rows('todo_projects', ctx.touched.projects).map(projectOf),
      sections: rows('todo_sections', ctx.touched.sections).map(sectionOf),
      labels: rows('todo_labels', ctx.touched.labels).map(labelOf),
      tasks: [...ctx.touched.tasks].map(id => this.task(id)).filter((task): task is TodoTask => !!task),
      links: rows('todo_links', ctx.touched.links).map(linkOf),
      removedLinks: ctx.removedLinks,
      comments: rows('todo_comments', ctx.touched.comments).map(commentOf),
    };
  }

  /**
   * Removes for good what was deleted more than 30 days ago, and old request answers. A build older than the file
   * skips it: rows of tables it does not know may hang on what it would remove.
   */
  purge(): void {
    if (!this.db || this.state.state !== 'ready' || this.fileStep !== TODO_SCHEMA_STEP) return;
    const now = this.options.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - TODO_RETENTION_MS).toISOString();
    try {
      this.transaction(() => {
        for (const table of ['todo_comments', 'todo_tasks', 'todo_sections', 'todo_labels', 'todo_projects']) {
          this.run(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff);
        }
        this.run('DELETE FROM todo_requests WHERE at < ?', new Date(now.getTime() - REQUEST_RETENTION_MS).toISOString());
      });
    } catch (error) { console.error(`Todo cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/** SQLite's "busy" and "locked": another connection holds the file, which only happens outside Tower's own use. */
function busy(error: unknown): unknown {
  const code = (error as { errcode?: number }).errcode;
  if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) return new TowerError('unavailable', '할 일 저장소를 다른 프로그램이 사용 중입니다. 잠시 후 다시 시도하세요.', { cause: error });
  return error;
}
