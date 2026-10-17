import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TowerError } from '../../../shared/errors.js';
import { compareDay, dayKey } from '../../../shared/todo/day-order.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import type { TodoTask } from '../../../shared/todo/types.js';
import { TODO_SCHEMA, TODO_SCHEMA_STEP, minWriterAt } from '../../../server/todo/schema.js';
import { TodoStore } from '../../../server/todo/store.js';

async function fixture(t: TestContext, prepare?: (dir: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-day-'));
  prepare?.(dir);
  const make = () => new TodoStore(dir, { now: () => new Date('2026-10-17T09:00:00.000Z') });
  const store = make();
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const apply = (...ops: TodoOp[]) => store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }));
  /** The open tasks of `date` in the order a date column shows them. */
  const day = (date: string) => store.overview().tasks.filter(task => task.dueDate === date).sort(compareDay).map(task => task.id);
  const task = (id: string) => store.overview().tasks.find(item => item.id === id) as TodoTask;
  return { dir, store, make, apply, day, task };
}

const kind = (error: unknown) => error instanceof TowerError ? error.kind : undefined;
const D = '2026-10-17';

test('the first move on a date keys every task of it in the order shown, and later moves change only the moved task', async t => {
  const { apply, day, task } = await fixture(t);
  apply(
    { op: 'task.create', id: 'a', content: 'A', dueDate: D, dueTime: '09:00' },
    { op: 'task.create', id: 'b', content: 'B', dueDate: D, priority: 1 },
    { op: 'task.create', id: 'c', content: 'C', dueDate: D },
    { op: 'task.create', id: 'd', content: 'D', dueDate: D },
    { op: 'task.create', id: 'other', content: 'Another date', dueDate: '2026-10-18' },
  );
  assert.deepEqual(day(D), ['a', 'b', 'c', 'd']);
  const first = apply({ op: 'task.move', id: 'd', dayAfterId: 'a' });
  assert.deepEqual(day(D), ['a', 'd', 'b', 'c']);
  assert.deepEqual(first.tasks.map(item => item.id).sort(), ['a', 'b', 'c', 'd']);
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(task(id).dayOrder?.startsWith(`${D}|`), id);
  assert.equal(task('other').dayOrder, null);
  const second = apply({ op: 'task.move', id: 'c', dayAfterId: null });
  assert.deepEqual(day(D), ['c', 'a', 'd', 'b']);
  assert.deepEqual(second.tasks.map(item => item.id), ['c']);
  // A task new to the date comes after those put in order, until it is moved too, which keys the date again.
  apply({ op: 'task.create', id: 'e', content: 'E', dueDate: D, dueTime: '07:00' });
  assert.deepEqual(day(D), ['c', 'a', 'd', 'b', 'e']);
  apply({ op: 'task.move', id: 'b', dayAfterId: 'e' });
  assert.deepEqual(day(D), ['c', 'a', 'd', 'e', 'b']);
  // An anchor that is no longer of the date puts it last.
  apply({ op: 'task.move', id: 'c', dayAfterId: 'other' });
  assert.deepEqual(day(D), ['a', 'd', 'e', 'b', 'c']);
});

test('a key stops counting when the date changes, a repeat moves on, or an older build changes the date', async t => {
  const { dir, store, apply, day, task } = await fixture(t);
  apply(
    { op: 'task.create', id: 'a', content: 'A', dueDate: D },
    { op: 'task.create', id: 'b', content: 'B', dueDate: D },
    { op: 'task.create', id: 'r', content: 'Weekly', dueDate: D, recurrence: { freq: 'week', interval: 1 } },
  );
  apply({ op: 'task.move', id: 'a', dayAfterId: 'r' });
  assert.deepEqual(day(D), ['b', 'r', 'a']);
  apply({ op: 'task.update', id: 'b', patch: { dueDate: '2026-10-18' } });
  assert.equal(dayKey(task('b')), null);
  assert.equal(task('b').dayOrder?.startsWith(`${D}|`), true, 'the value stays; it only stops counting');
  apply({ op: 'task.complete', id: 'r', completionId: 'c1', occurrence: D, today: D });
  assert.equal(task('r').dueDate, '2026-10-24');
  assert.equal(dayKey(task('r')), null);
  // Reopening the occurrence brings the task back to the date and to its place in it.
  apply({ op: 'task.uncomplete', id: 'r', completionId: 'c1' });
  assert.deepEqual(day(D), ['r', 'a']);
  // A build that knows nothing of the order changes the date and leaves the value behind.
  store.close();
  const db = new DatabaseSync(join(dir, 'todos.sqlite'));
  db.prepare('UPDATE todo_tasks SET due_date = ? WHERE id = ?').run('2026-10-19', 'a');
  db.close();
  const again = new TodoStore(dir);
  again.start();
  t.after(() => again.close());
  const moved = again.overview().tasks.find(item => item.id === 'a')!;
  assert.equal(dayKey(moved), null);
});

test('only an open, dated task is put in order within its date, and never together with another move', async t => {
  const { apply } = await fixture(t);
  apply(
    { op: 'task.create', id: 'a', content: 'A', dueDate: D },
    { op: 'task.create', id: 'undated', content: 'No date' },
    { op: 'task.create', id: 'done', content: 'Done', dueDate: D },
  );
  apply({ op: 'task.complete', id: 'done', completionId: 'c', occurrence: D, today: D });
  assert.throws(() => apply({ op: 'task.move', id: 'undated', dayAfterId: null }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'task.move', id: 'done', dayAfterId: null }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'task.move', id: 'a', dayAfterId: 'a' }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'task.move', id: 'a', projectId: 'inbox', dayAfterId: null }), error => kind(error) === 'invalid');
});

test('the order column is an additive step: older builds keep writing, an older file is brought up to date, and backups carry it', async t => {
  assert.equal(minWriterAt(TODO_SCHEMA_STEP), minWriterAt(TODO_SCHEMA_STEP - 1));
  // A file of the step before, as the previous release left it.
  const { store, apply, task } = await fixture(t, dir => {
    const db = new DatabaseSync(join(dir, 'todos.sqlite'));
    for (const step of TODO_SCHEMA.slice(0, TODO_SCHEMA_STEP - 1)) db.exec(step.sql);
    db.exec(`PRAGMA user_version = ${TODO_SCHEMA_STEP - 1}`);
    db.prepare("INSERT INTO todo_meta (key, value) VALUES ('min_writer', '1')").run();
    db.prepare("INSERT INTO todo_projects (id, name, inbox, sort_key, created_at, updated_at) VALUES ('inbox', 'Inbox', 1, 'V', 'x', 'x')").run();
    db.prepare("INSERT INTO todo_tasks (id, project_id, content, due_date, sort_key, created_at, updated_at) VALUES ('old', 'inbox', 'Old', ?, 'V', 'x', 'x')").run(D);
    db.close();
  });
  assert.deepEqual(store.availability(), { state: 'ready' });
  assert.equal(task('old').dayOrder, null);
  apply({ op: 'task.create', id: 'new', content: 'New', dueDate: D });
  apply({ op: 'task.move', id: 'new', dayAfterId: null });
  const backup = store.backupData()!;
  assert.ok(backup.tables.todo_tasks.every(row => 'day_order' in row));
  const ordered = { new: task('new').dayOrder, old: task('old').dayOrder };
  store.restoreData(backup.schema, backup.tables);
  assert.deepEqual({ new: task('new').dayOrder, old: task('old').dayOrder }, ordered);
  // A backup of the step before has no such column, and restores without an order.
  const older = { ...backup.tables, todo_tasks: backup.tables.todo_tasks.map(({ day_order: _, ...row }) => row) };
  store.restoreData(TODO_SCHEMA_STEP - 1, older);
  assert.equal(task('new').dayOrder, null);
});
