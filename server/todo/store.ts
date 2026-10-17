import { randomBytes } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fchmodSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TowerError } from '../../shared/errors.js';
import type { TodoOp, TodoOpName, TodoOpOf, TodoRequest } from '../../shared/todo/ops.js';
import type { TodoAvailability, TodoChanges, TodoCompletedPage, TodoFile, TodoOverview, TodoRestoreProgress, TodoTask, TodoTaskDetail } from '../../shared/todo/types.js';
import { nodeVerified, sqlitePatched } from '../storage/runtime.js';
import { TodoContext } from './context.js';
import { checkTodoFileRow, todoFilePath, usableContent } from './files.js';
import { createComment, deleteComment, updateComment } from './ops/comments.js';
import { attachFile, checkAttachable, deleteFile, restoreFile, type NewTodoFile } from './ops/files.js';
import { createLink, deleteLink } from './ops/links.js';
import { MAX_PROJECT_LEVELS, createLabel, createProject, createSection, deleteLabel, deleteProject, deleteSection, moveLabel, moveProject, moveSection, restoreLabel, restoreProject, restoreSection, updateLabel, updateProject, updateSection } from './ops/projects.js';
import { MAX_TASK_DEPTH, completeTask, createTask, deleteTask, moveTask, restoreTask, uncompleteTask, updateTask } from './ops/tasks.js';
import { TASK_COLUMNS, VISIBLE_FILE, commentOf, completionOf, eventOf, fileOf, labelOf, linkOf, projectOf, sectionOf, taskOf } from './rows.js';
import { TODO_DATA_TABLES, TODO_SCHEMA, TODO_SCHEMA_STEP, minWriterAt } from './schema.js';

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
  'file.delete': handler(deleteFile),
  'file.restore': handler(restoreFile),
};

/** The copies a restore makes of the file it replaces; only the newest few are kept. */
const RESTORE_COPIES_KEPT = 3;
const RESTORE_COPY = /^todo-restore-before-\d{8}T\d{6}\d{3}Z(?:-[0-9a-f]{6})?\.sqlite$/;

/** A backup's rows, by table; see `TODO_DATA_TABLES`. */
export type TodoTables = Record<string, Record<string, unknown>[]>;
/** Where attachments sealed with a key are in a backup bucket, and the key (base64url). */
export interface TodoFileKey { namespace: string; key: string }
/** Both lists, each namespace once (the first one's entry wins). */
export const mergeKeys = (first: TodoFileKey[], second: TodoFileKey[]): TodoFileKey[] =>
  [...first, ...second].filter((item, index, all) => all.findIndex(other => other.namespace === item.namespace) === index).map(({ namespace, key }) => ({ namespace, key }));

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
  private readonly stateDir: string;
  private db?: DatabaseSync;
  private sqlite?: Sqlite;
  private restoreProgress?: TodoRestoreProgress;
  private state: TodoAvailability = { state: 'unavailable', reason: '할 일 저장소를 아직 열지 않았습니다.' };
  private revisionValue = 0;
  /** The steps the open file has, which may be more than this build knows. */
  private fileStep = 0;

  constructor(stateDir: string, private readonly options: TodoStoreOptions = {}) { this.stateDir = stateDir; this.path = join(stateDir, 'todos.sqlite'); }

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
    this.sqlite = sqlite;
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
      this.transaction(() => this.ensureInbox());
    }
    // The key a backup encrypts this computer's attachments with (see server/todo/backup.ts); a new file makes a new one.
    if (this.state.state === 'ready' && !this.meta('files_key')) this.transaction(() => this.setMeta('files_key', randomBytes(32).toString('base64url')));
  }

  private ensureInbox(): void {
    if (this.get('SELECT 1 FROM todo_projects WHERE inbox = 1')) return;
    this.run('INSERT INTO todo_projects (id, name, inbox, sort_key, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)', INBOX_ID, 'Inbox', 'V', this.now(), this.now());
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
    if (!this.db || this.state.state === 'unavailable') return { availability: this.state, revision: this.revisionValue, projects: [], sections: [], labels: [], tasks: [], links: [], commentCounts: {}, fileCounts: {} };
    const tasks = this.all(`SELECT ${TASK_COLUMNS} FROM todo_tasks t JOIN todo_projects p ON p.id = t.project_id AND p.deleted_at IS NULL WHERE t.deleted_at IS NULL AND t.completed_at IS NULL`).map(taskOf);
    const links = this.all(`SELECT k.* FROM todo_links k JOIN todo_tasks a ON a.id = k.from_task_id AND a.deleted_at IS NULL JOIN todo_tasks b ON b.id = k.to_task_id AND b.deleted_at IS NULL
      WHERE a.completed_at IS NULL OR b.completed_at IS NULL`).map(linkOf);
    const commentCounts = Object.fromEntries(this.all<{ task_id: string; n: number }>(`SELECT c.task_id, COUNT(*) AS n FROM todo_comments c JOIN todo_tasks t ON t.id = c.task_id
      WHERE c.deleted_at IS NULL AND t.deleted_at IS NULL AND t.completed_at IS NULL GROUP BY c.task_id`).map(row => [row.task_id, Number(row.n)]));
    const fileCounts = Object.fromEntries(this.all<{ task_id: string; n: number }>(`SELECT f.task_id, COUNT(*) AS n FROM todo_files f JOIN todo_tasks t ON t.id = f.task_id
      LEFT JOIN todo_comments c ON c.id = f.comment_id WHERE ${VISIBLE_FILE} AND t.deleted_at IS NULL AND t.completed_at IS NULL GROUP BY f.task_id`).map(row => [row.task_id, Number(row.n)]));
    return {
      availability: this.state, revision: this.revisionValue,
      projects: this.all('SELECT * FROM todo_projects WHERE deleted_at IS NULL ORDER BY sort_key').map(projectOf),
      sections: this.all('SELECT * FROM todo_sections WHERE deleted_at IS NULL ORDER BY sort_key').map(sectionOf),
      labels: this.all('SELECT * FROM todo_labels WHERE deleted_at IS NULL ORDER BY sort_key').map(labelOf),
      tasks, links, commentCounts, fileCounts, ...(this.restoreProgress ? { restore: { ...this.restoreProgress } } : {}),
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
    const subtasks = this.all(`WITH RECURSIVE down(id, depth) AS (SELECT id, 1 FROM todo_tasks WHERE parent_id = ? UNION ALL SELECT t.id, down.depth + 1 FROM todo_tasks t JOIN down ON t.parent_id = down.id WHERE down.depth < ${MAX_TASK_DEPTH + 2})
      SELECT ${TASK_COLUMNS} FROM todo_tasks t JOIN down ON down.id = t.id WHERE t.deleted_at IS NULL ORDER BY t.sort_key`, id).map(taskOf);
    const related = (column: 'from_task_id' | 'to_task_id', other: 'from_task_id' | 'to_task_id') =>
      this.all<Record<string, unknown> & { other: string }>(`SELECT k.*, k.${other} AS other FROM todo_links k JOIN todo_tasks o ON o.id = k.${other} AND o.deleted_at IS NULL WHERE k.${column} = ? ORDER BY k.created_at`, id)
        .map(row => ({ link: linkOf(row), task: this.task(row.other)! }));
    return {
      task, subtasks,
      comments: this.all('SELECT * FROM todo_comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at', id).map(commentOf),
      files: this.all(`SELECT f.* FROM todo_files f LEFT JOIN todo_comments c ON c.id = f.comment_id WHERE f.task_id = ? AND ${VISIBLE_FILE} ORDER BY f.created_at, f.rowid`, id)
        .map(fileOf).map(file => usableContent(lstatSync(todoFilePath(this.stateDir, file.sha256), { throwIfNoEntry: false }), file.size) ? file : { ...file, missing: true as const }),
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
    return this.commit(ctx => {
      const earlier = this.get<{ result: string }>('SELECT result FROM todo_requests WHERE id = ?', request.requestId);
      // An answer kept by an earlier build lacks what was added since.
      if (earlier) return { ...this.emptyChanges(0), ...JSON.parse(earlier.result) as TodoChanges };
      for (const op of request.ops) OPERATIONS[op.op](ctx, op);
      const changes = this.changes(ctx, this.nextRevision());
      this.run('INSERT INTO todo_requests (id, result, at) VALUES (?, ?, ?)', request.requestId, JSON.stringify(changes), ctx.now);
      return changes;
    });
  }

  /** One write transaction of the store's rules, whose answer carries the revision it made. */
  private commit(work: (ctx: TodoContext) => TodoChanges): TodoChanges {
    this.writable();
    const changes = this.transaction(() => {
      if (Number(this.meta('min_writer') ?? 1) > TODO_SCHEMA_STEP) throw new TowerError('locked', '더 새로운 Tower가 바꾼 할 일 저장소입니다.');
      return work(new TodoContext(this.db!, this.now()));
    });
    // Only a committed change moves the revision pages see.
    this.revisionValue = Math.max(this.revisionValue, changes.revision);
    return changes;
  }

  private nextRevision(): number {
    const revision = this.revisionValue + 1;
    this.setMeta('revision', String(revision));
    return revision;
  }

  /** Throws unless a file can be attached to this task and comment now. */
  attachable(taskId: string, commentId: string | null): void {
    this.writable();
    checkAttachable(new TodoContext(this.db!, this.now()), taskId, commentId);
  }

  /**
   * Adds the row of an uploaded file whose contents are already in place, checking again that its task and comment
   * are there. The id was fixed when the upload began: a file already added answers its row and changes nothing.
   */
  attach(file: NewTodoFile): { file: TodoFile; changes: TodoChanges } {
    const changes = this.commit(ctx => {
      if (this.get('SELECT 1 FROM todo_files WHERE id = ?', file.id)) return { ...this.emptyChanges(this.revisionValue), files: [this.fileRow(file.id)!] };
      attachFile(ctx, file);
      return this.changes(ctx, this.nextRevision());
    });
    return { file: changes.files.find(item => item.id === file.id)!, changes };
  }

  private fileRow(id: string): TodoFile | undefined {
    const row = this.get('SELECT * FROM todo_files WHERE id = ?', id);
    return row ? fileOf(row) : undefined;
  }

  /** A file that shows (see TodoFile), for serving it. */
  visibleFile(id: string): TodoFile | undefined {
    this.readable();
    const row = this.get(`SELECT f.* FROM todo_files f JOIN todo_tasks t ON t.id = f.task_id AND t.deleted_at IS NULL LEFT JOIN todo_comments c ON c.id = f.comment_id
      WHERE f.id = ? AND ${VISIBLE_FILE}`, id);
    return row ? fileOf(row) : undefined;
  }

  /**
   * The contents every file row names, deleted ones included, so nothing a row may still show is removed. Undefined
   * when this build must not remove contents: the file is unusable or newer than this build (a table it does not know
   * may name contents too).
   */
  fileContents(): Map<string, number> | undefined {
    if (!this.db || this.state.state !== 'ready' || this.fileStep !== TODO_SCHEMA_STEP) return undefined;
    return new Map(this.all<{ sha256: string; size: number }>('SELECT sha256, MAX(size) AS size FROM todo_files GROUP BY sha256').map(row => [row.sha256, Number(row.size)]));
  }

  private emptyChanges(revision: number): TodoChanges {
    return { revision, projects: [], sections: [], labels: [], tasks: [], links: [], removedLinks: [], comments: [], files: [] };
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
      files: rows('todo_files', ctx.touched.files).map(fileOf),
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
        // Removing a task or comment removes its files with it (foreign keys); contents no row names go afterwards (TodoFiles).
        for (const table of ['todo_files', 'todo_comments', 'todo_tasks', 'todo_sections', 'todo_labels', 'todo_projects']) {
          this.run(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff);
        }
        this.run('DELETE FROM todo_requests WHERE at < ?', new Date(now.getTime() - REQUEST_RETENTION_MS).toISOString());
      });
    } catch (error) { console.error(`Todo cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  // ---- Backup ---------------------------------------------------------------------------------------

  /**
   * Everything a backup keeps, read at one moment: the data tables' rows, the step of the schema this build writes, the
   * attachments' key, and the contents the rows name. Undefined when the file cannot be read.
   */
  backupData(): { schema: number; tables: TodoTables; key?: string; contents: Map<string, number>; newer: boolean } | undefined {
    if (!this.db || this.state.state === 'unavailable') return undefined;
    const columns = this.schemaColumns();
    this.db.exec('BEGIN');
    try {
      const tables: TodoTables = {};
      // In the order rows were added, which lists of one moment keep (rowid); a table without one by its key.
      for (const table of TODO_DATA_TABLES) {
        const rowid = !this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND sql LIKE '%WITHOUT ROWID%'", table);
        tables[table] = this.all(`SELECT ${[...columns.get(table)!].join(', ')} FROM ${table} ORDER BY ${rowid ? 'rowid' : '1, 2'}`);
      }
      const contents = new Map(this.all<{ sha256: string; size: number }>('SELECT sha256, MAX(size) AS size FROM todo_files GROUP BY sha256').map(row => [row.sha256, Number(row.size)]));
      const key = this.meta('files_key');
      // A file a newer build changed may hold more than this build's columns and tables: `newer` says so.
      return { schema: TODO_SCHEMA_STEP, tables, ...(key ? { key } : {}), contents, newer: this.fileStep > TODO_SCHEMA_STEP };
    } finally { if (this.db.isTransaction) this.db.exec('COMMIT'); }
  }

  /**
   * Replaces every data table with a backup's rows, in one transaction, after copying the file aside (WAL included).
   * `todo_meta` stays this file's own; the revision moves past the one before, so open pages load again. A build
   * older than the file, or a backup of a newer schema, is refused: rows of what it does not know would be lost.
   * Answers where the copy is.
   */
  restoreData(schema: number, tables: TodoTables, keys: TodoFileKey[] = []): string {
    this.writable();
    if (this.fileStep !== TODO_SCHEMA_STEP) throw new TowerError('locked', '더 새로운 Tower가 만든 할 일 저장소라 복원하지 않았습니다. Tower를 업데이트한 뒤 복원하세요.');
    if (schema > TODO_SCHEMA_STEP) throw new TowerError('conflict', '더 새로운 Tower의 할 일 백업입니다. Tower를 업데이트한 뒤 복원하세요.');
    const columns = this.schemaColumns();
    for (const [table, rows] of Object.entries(tables)) {
      const known = columns.get(table);
      if (!known) throw new TowerError('invalid', `할 일 백업에 알 수 없는 표가 있습니다: ${table}`);
      for (const row of rows) {
        for (const [name, value] of Object.entries(row)) {
          if (!known.has(name)) throw new TowerError('invalid', `할 일 백업에 알 수 없는 열이 있습니다: ${table}.${name}`);
          if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new TowerError('invalid', `할 일 백업의 값이 올바르지 않습니다: ${table}.${name}`);
        }
      }
    }
    // Contents are found by a row's hash and shown under its name: nothing but what an upload makes goes in.
    for (const row of tables.todo_files ?? []) checkTodoFileRow(row);
    checkTrees(tables);
    const before = this.copyAside();
    this.revisionValue = this.transaction(() => {
      // Checked when the transaction commits, so rows go in table by table whatever points at what.
      this.db!.exec('PRAGMA defer_foreign_keys = ON');
      for (const table of [...TODO_DATA_TABLES].reverse()) this.run(`DELETE FROM ${table}`);
      for (const table of TODO_DATA_TABLES) {
        for (const row of tables[table] ?? []) {
          const names = Object.keys(row);
          if (!names.length) continue;
          this.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, ...names.map(name => row[name] as string | number | null));
        }
      }
      this.ensureInbox();
      // The keys that open the restored attachments where the bucket holds them stay with this file from now on.
      this.setMeta('files_keys', JSON.stringify(mergeKeys(this.fileKeys(), keys)));
      if ((this.all('PRAGMA foreign_key_check') as unknown[]).length) throw new TowerError('invalid', '할 일 백업의 항목이 서로 맞지 않습니다.');
      return this.nextRevision();
    });
    return before;
  }

  /** The columns of each data table as this build's schema makes them, whatever a newer build added to the file. */
  private schemaColumns(): Map<string, Set<string>> {
    if (!schemaColumns) {
      const memory = new this.sqlite!.DatabaseSync(':memory:');
      try {
        for (const step of TODO_SCHEMA) memory.exec(step.sql);
        schemaColumns = new Map(TODO_DATA_TABLES.map(table => [table, new Set((memory.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name))]));
      } finally { memory.close(); }
    }
    return schemaColumns;
  }

  /** A consistent copy of the file as it is now, kept beside it (the newest few). */
  private copyAside(): string {
    const stamp = new Date(this.now()).toISOString().replace(/[-:.]/g, '');
    // A random part too, so two restores in one millisecond never meet.
    const path = join(this.stateDir, `todo-restore-before-${stamp}-${randomBytes(3).toString('hex')}.sqlite`);
    // Made owner-only and empty first: VACUUM INTO writes into an empty file it finds.
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    try { this.db!.prepare('VACUUM INTO ?').run(path); }
    catch (error) { rmSync(path, { force: true }); throw error; }
    const copies = readdirSync(this.stateDir).filter(name => RESTORE_COPY.test(name)).sort();
    for (const name of copies.slice(0, Math.max(0, copies.length - RESTORE_COPIES_KEPT))) rmSync(join(this.stateDir, name), { force: true });
    return path;
  }

  /** Keys of attachments sealed elsewhere (other computers, earlier keys of this one) that restores brought here. */
  fileKeys(): TodoFileKey[] {
    if (!this.db || this.state.state === 'unavailable') return [];
    const value = this.meta('files_keys');
    const list: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(list) ? list.filter((item): item is TodoFileKey => !!item && typeof item.namespace === 'string' && typeof item.key === 'string') : [];
  }

  /** The key this computer's attachments are encrypted with in backups (base64url), when the file has one. */
  filesKey(): string | undefined {
    return this.db && this.state.state !== 'unavailable' ? this.meta('files_key') : undefined;
  }

  /** The contents the kept copies of the file before restores name (see copyAside), read without changing them. */
  restoreCopyContents(): Set<string> {
    const named = new Set<string>();
    if (!this.sqlite) return named;
    for (const name of readdirSync(this.stateDir).filter(item => RESTORE_COPY.test(item))) {
      // A copy that cannot be read (cut short while it was made) names nothing it can bring back; the others still count.
      try {
        const copy = new this.sqlite.DatabaseSync(join(this.stateDir, name), { readOnly: true });
        try {
          if (!copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todo_files'").get()) continue;
          for (const row of copy.prepare('SELECT DISTINCT sha256 FROM todo_files').all() as { sha256: string }[]) named.add(row.sha256);
        } finally { copy.close(); }
      } catch (error) { console.warn(`The todo copy ${name} could not be read and protects no attachments: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return named;
  }

  /** What the page shows about bringing back a restored backup's attachments. */
  setRestoreProgress(progress: TodoRestoreProgress | undefined): void { this.restoreProgress = progress && { state: progress.state, total: progress.total, missing: progress.missing }; }

  /** Moves the revision so open pages load again (attachments brought back after a restore). */
  touch(): void {
    if (!this.db || this.state.state !== 'ready') return;
    this.revisionValue = this.transaction(() => this.nextRevision());
  }
}

let schemaColumns: Map<string, Set<string>> | undefined;

/**
 * Throws unless a backup's projects and tasks form the trees the operations keep: no parent cycles, projects at most
 * MAX_PROJECT_LEVELS levels and sub-tasks MAX_TASK_DEPTH below a top task, a sub-task in its parent's project, and a
 * task's section in its project. A file that broke them would make the store's walks up and down never end.
 */
function checkTrees(tables: TodoTables): void {
  const wrong = (what: string) => new TowerError('invalid', `할 일 백업의 구조가 올바르지 않습니다: ${what}`);
  const byId = (rows: Record<string, unknown>[] | undefined) => new Map((rows ?? []).map(row => [String(row.id), row]));
  const projects = byId(tables.todo_projects), sections = byId(tables.todo_sections), tasks = byId(tables.todo_tasks);
  /** How many parents above `id`, refusing a cycle or a chain longer than `most`. */
  const above = (rows: Map<string, Record<string, unknown>>, id: string, most: number, what: string) => {
    let count = 0;
    for (let parent = rows.get(id)?.parent_id; parent !== null && parent !== undefined; parent = rows.get(String(parent))?.parent_id) {
      if (++count > most) throw wrong(`${what} ${id}`);
    }
    return count;
  };
  for (const id of projects.keys()) above(projects, id, MAX_PROJECT_LEVELS - 1, '프로젝트 단계');
  for (const [id, task] of tasks) {
    above(tasks, id, MAX_TASK_DEPTH, '하위 작업 단계');
    const parent = task.parent_id === null || task.parent_id === undefined ? undefined : tasks.get(String(task.parent_id));
    if (parent && parent.project_id !== task.project_id) throw wrong(`하위 작업 ${id}의 프로젝트`);
    const section = task.section_id === null || task.section_id === undefined ? undefined : sections.get(String(task.section_id));
    if (section && section.project_id !== task.project_id) throw wrong(`작업 ${id}의 섹션`);
  }
}

/** SQLite's "busy" and "locked": another connection holds the file, which only happens outside Tower's own use. */
function busy(error: unknown): unknown {
  const code = (error as { errcode?: number }).errcode;
  if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) return new TowerError('unavailable', '할 일 저장소를 다른 프로그램이 사용 중입니다. 잠시 후 다시 시도하세요.', { cause: error });
  return error;
}
