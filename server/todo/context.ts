import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TowerError } from '../../shared/errors.js';
import { keyBetween, SORT_KEY_SPREAD_AT, spreadKeys } from '../../shared/todo/sort-key.js';
import type { TodoEventKind } from '../../shared/todo/types.js';

/** What one request's operations share inside its transaction: the connection, the time, and what they changed. */
export class TodoContext {
  readonly touched = { projects: new Set<string>(), sections: new Set<string>(), labels: new Set<string>(), tasks: new Set<string>(), links: new Set<string>(), comments: new Set<string>(), files: new Set<string>() };
  readonly removedLinks: string[] = [];
  /** Tasks a sub-task moved away from; the parents of touched tasks count as changed too (see TodoChanges.subtaskCounts). */
  readonly parents = new Set<string>();
  constructor(readonly db: DatabaseSync, readonly now: string) {}

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  event(taskId: string, kind: TodoEventKind, detail: Record<string, unknown> = {}): void {
    this.run('INSERT INTO todo_events (task_id, kind, detail, at) VALUES (?, ?, ?, ?)', taskId, kind, JSON.stringify(detail), this.now);
  }

  /** The changed-ids set of a table, so a rewrite of its keys reaches the page. */
  private touchedOf(table: string): Set<string> {
    const sets: Record<string, Set<string>> = { todo_projects: this.touched.projects, todo_sections: this.touched.sections, todo_labels: this.touched.labels, todo_tasks: this.touched.tasks };
    return sets[table];
  }

  /**
   * The order key for an item placed in a group of siblings: after `afterId` (when it is still one of them), first for
   * null, last when absent. `where` selects the live siblings, the moving item itself left out. When the new key would
   * grow long, the group's keys are spread out first.
   */
  place(table: string, where: string, params: SQLInputValue[], afterId: string | null | undefined, self?: string): string {
    const key = this.keyIn(table, where, params, afterId, self);
    if (key.length <= SORT_KEY_SPREAD_AT) return key;
    const rows = this.all<{ id: string }>(`SELECT id FROM ${table} WHERE deleted_at IS NULL AND ${where}${self ? ' AND id <> ?' : ''} ORDER BY sort_key, id`, ...params, ...(self ? [self] : []));
    spreadKeys(rows.length).forEach((spread, index) => {
      this.run(`UPDATE ${table} SET sort_key = ? WHERE id = ?`, spread, rows[index].id);
      this.touchedOf(table).add(rows[index].id);
    });
    return this.keyIn(table, where, params, afterId, self);
  }

  private keyIn(table: string, where: string, params: SQLInputValue[], afterId: string | null | undefined, self?: string): string {
    const scope = `deleted_at IS NULL AND ${where}${self ? ' AND id <> ?' : ''}`;
    const args = self ? [...params, self] : params;
    const edge = (order: 'MIN' | 'MAX') => this.get<{ key: string | null }>(`SELECT ${order}(sort_key) AS key FROM ${table} WHERE ${scope}`, ...args)?.key ?? null;
    if (afterId === null) return keyBetween(null, edge('MIN'));
    const anchor = afterId === undefined ? undefined : this.get<{ sort_key: string }>(`SELECT sort_key FROM ${table} WHERE id = ? AND ${scope}`, afterId, ...args);
    if (!anchor) return keyBetween(edge('MAX'), null);
    const next = this.get<{ key: string | null }>(`SELECT MIN(sort_key) AS key FROM ${table} WHERE ${scope} AND sort_key > ?`, ...args, anchor.sort_key)?.key ?? null;
    return keyBetween(anchor.sort_key, next);
  }

  /**
   * Gives a restored item a key of its own when another took its old key while it was deleted: right after that one,
   * so it comes back where it was.
   */
  keepKeyUnique(table: string, where: string, params: SQLInputValue[], id: string): void {
    const row = this.get<{ sort_key: string }>(`SELECT sort_key FROM ${table} WHERE id = ?`, id);
    const other = row && this.get<{ id: string }>(`SELECT id FROM ${table} WHERE deleted_at IS NULL AND ${where} AND id <> ? AND sort_key = ?`, ...params, id, row.sort_key);
    if (!other) return;
    this.run(`UPDATE ${table} SET sort_key = ? WHERE id = ?`, this.place(table, where, params, other.id, id), id);
    this.touchedOf(table).add(id);
  }
}

export const invalid = (message: string) => new TowerError('invalid', message);
export const missing = (message: string) => new TowerError('not-found', message);
/** Another page changed it first; the page reloads and shows what is there now. */
export const stale = (message: string) => new TowerError('conflict', message);
