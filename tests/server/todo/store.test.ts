import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TowerError } from '../../../shared/errors.js';
import type { TodoOp } from '../../../shared/todo/ops.js';
import { INBOX_ID, TODO_RETENTION_MS, TodoStore } from '../../../server/todo/store.js';
import { TODO_SCHEMA_STEP } from '../../../server/todo/schema.js';

async function fixture(t: TestContext, options: { runtime?: () => string | undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todos-'));
  let clock = new Date('2026-10-17T09:00:00.000Z');
  const make = () => new TodoStore(dir, { now: () => clock, ...options });
  const store = make();
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const apply = (...ops: TodoOp[]) => store.apply({ requestId: randomUUID(), ops });
  const tick = (ms = 1000) => { clock = new Date(clock.getTime() + ms); };
  const task = (id: string) => store.overview().tasks.find(item => item.id === id);
  return { dir, store, make, apply, tick, task };
}

const kind = (error: unknown) => error instanceof TowerError ? error.kind : undefined;

test('a new file is owner-only, has the inbox, and keeps what was saved across reopening', async t => {
  const { dir, store, make, apply } = await fixture(t);
  assert.deepEqual(store.availability(), { state: 'ready' });
  assert.equal((await stat(join(dir, 'todos.sqlite'))).mode & 0o777, 0o600);
  assert.equal(store.overview().projects.find(project => project.inbox)?.id, INBOX_ID);
  apply({ op: 'task.create', id: 'a', content: 'Write the report', priority: 1, dueDate: '2026-10-20', dueTime: '09:30', durationMin: 45, deadlineDate: '2026-10-24' });
  assert.equal(store.revision(), 1);
  store.close();
  const again = make();
  again.start();
  t.after(() => again.close());
  const saved = again.overview();
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.projects.filter(project => project.inbox).length, 1);
  const task = saved.tasks.find(item => item.id === 'a')!;
  assert.deepEqual({ projectId: task.projectId, priority: task.priority, dueDate: task.dueDate, dueTime: task.dueTime, durationMin: task.durationMin, deadlineDate: task.deadlineDate },
    { projectId: INBOX_ID, priority: 1, dueDate: '2026-10-20', dueTime: '09:30', durationMin: 45, deadlineDate: '2026-10-24' });
});

test('a request applies all of its operations or none, may refer to what it creates, and answers a retry the same way', async t => {
  const { store, apply } = await fixture(t);
  const changes = apply(
    { op: 'project.create', id: 'work', name: 'Work', color: 'blue' },
    { op: 'section.create', id: 'doing', projectId: 'work', name: 'Doing' },
    { op: 'label.create', id: 'urgent', name: 'urgent' },
    { op: 'task.create', id: 't1', projectId: 'work', sectionId: 'doing', content: 'Ship', labelIds: ['urgent'] },
  );
  assert.deepEqual(changes.tasks.map(task => [task.id, task.sectionId, task.labelIds]), [['t1', 'doing', ['urgent']]]);
  const before = store.overview();
  // The third operation fails, so the first two leave no trace.
  assert.throws(() => apply(
    { op: 'task.create', id: 't2', projectId: 'work', content: 'Second' },
    { op: 'task.update', id: 't1', patch: { content: 'Renamed' } },
    { op: 'task.create', id: 't3', projectId: 'work', content: 'Third', labelIds: ['missing'] },
  ), error => kind(error) === 'not-found');
  assert.deepEqual(store.overview(), before);
  const request = { requestId: randomUUID(), ops: [{ op: 'task.create', id: 't4', content: 'Once' }] as TodoOp[] };
  const first = store.apply(request);
  const second = store.apply(request);
  assert.deepEqual(second, first);
  assert.equal(store.overview().tasks.filter(task => task.id === 't4').length, 1);
  assert.equal(store.revision(), first.revision);
});

test('a repeating task moves on when completed, once per occurrence, and only its latest completion can be undone', async t => {
  const { apply, task, tick } = await fixture(t);
  apply({ op: 'task.create', id: 'water', content: 'Water plants', dueDate: '2026-10-17', recurrence: { freq: 'week', interval: 1 } });
  assert.deepEqual(task('water')?.recurrence, { freq: 'week', interval: 1, weekdays: [6] });
  apply({ op: 'task.complete', id: 'water', completionId: 'c1', occurrence: '2026-10-17', today: '2026-10-17' });
  assert.equal(task('water')?.dueDate, '2026-10-24');
  assert.equal(task('water')?.completedAt, null);
  // Another page completes the same occurrence: refused, not applied to the next one.
  assert.throws(() => apply({ op: 'task.complete', id: 'water', completionId: 'c2', occurrence: '2026-10-17', today: '2026-10-17' }), error => kind(error) === 'conflict');
  assert.equal(task('water')?.dueDate, '2026-10-24');
  tick();
  apply({ op: 'task.complete', id: 'water', completionId: 'c3', occurrence: '2026-10-24', today: '2026-10-24' });
  assert.equal(task('water')?.dueDate, '2026-10-31');
  assert.throws(() => apply({ op: 'task.uncomplete', id: 'water', completionId: 'c1' }), error => kind(error) === 'conflict');
  apply({ op: 'task.uncomplete', id: 'water', completionId: 'c3' });
  assert.equal(task('water')?.dueDate, '2026-10-24');
  // A rule that ends completes the task for good.
  apply({ op: 'task.create', id: 'short', content: 'Short run', dueDate: '2026-10-17', recurrence: { freq: 'day', interval: 1, until: '2026-10-17' } });
  apply({ op: 'task.complete', id: 'short', completionId: 'c4', occurrence: '2026-10-17', today: '2026-10-17' });
  assert.equal(task('short'), undefined);
});

test('a plain task completes once; completing a parent closes everything below, which reopens with it', async t => {
  const { store, apply, task } = await fixture(t);
  apply(
    { op: 'task.create', id: 'p', content: 'Parent' },
    { op: 'task.create', id: 'c', parentId: 'p', content: 'Child', dueDate: '2026-10-17', recurrence: { freq: 'day', interval: 1 } },
    { op: 'task.create', id: 'g', parentId: 'c', content: 'Grandchild' },
    { op: 'task.create', id: 'done', parentId: 'p', content: 'Already done' },
    { op: 'task.complete', id: 'done', completionId: 'd0', occurrence: null, today: '2026-10-17' },
  );
  apply({ op: 'task.complete', id: 'p', completionId: 'pc', occurrence: null, today: '2026-10-17' });
  assert.equal(store.overview().tasks.length, 0);
  // The repeating child was closed with its parent, not moved to tomorrow.
  const detail = store.detail('p');
  assert.deepEqual(detail.subtasks.map(item => [item.id, item.dueDate, Boolean(item.completedAt)]).sort(), [['c', '2026-10-17', true], ['done', null, true], ['g', null, true]]);
  assert.throws(() => apply({ op: 'task.complete', id: 'p', completionId: 'pc2', occurrence: null, today: '2026-10-17' }), error => kind(error) === 'conflict');
  assert.throws(() => apply({ op: 'task.create', id: 'x', parentId: 'p', content: 'Under a done task' }), error => kind(error) === 'invalid');
  apply({ op: 'task.uncomplete', id: 'p', completionId: 'pc' });
  // What the parent's completion closed opens again; what was done before stays done.
  assert.deepEqual(store.overview().tasks.map(item => item.id).sort(), ['c', 'g', 'p']);
  // Reopening a task below a completed one reopens the ones above.
  apply({ op: 'task.complete', id: 'p', completionId: 'pc3', occurrence: null, today: '2026-10-17' });
  apply({ op: 'task.uncomplete', id: 'g', completionId: 'pc3:g' as string });
  assert.ok(task('g') && task('c') && task('p'));
});

test('sub-tasks keep to four levels, never nest in themselves, and follow their parent between projects', async t => {
  const { store, apply, task } = await fixture(t);
  apply({ op: 'project.create', id: 'other', name: 'Other' }, { op: 'task.create', id: 'l0', content: 'Top' });
  for (let level = 1; level <= 4; level++) apply({ op: 'task.create', id: `l${level}`, parentId: `l${level - 1}`, content: `Level ${level}` });
  assert.throws(() => apply({ op: 'task.create', id: 'l5', parentId: 'l4', content: 'Too deep' }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'task.move', id: 'l1', parentId: 'l3' }), error => kind(error) === 'invalid');
  apply({ op: 'task.create', id: 'side', content: 'Side' }, { op: 'task.create', id: 'side2', parentId: 'side', content: 'Side child' });
  // l1 carries three levels below it: under a top-level task it fits, one level lower it does not.
  assert.throws(() => apply({ op: 'task.move', id: 'l1', parentId: 'side2' }), error => kind(error) === 'invalid');
  apply({ op: 'task.move', id: 'l1', parentId: 'side' });
  apply({ op: 'task.move', id: 'l1', parentId: 'l0' });
  apply({ op: 'task.move', id: 'l0', projectId: 'other' });
  assert.deepEqual(store.overview().tasks.filter(item => item.id.startsWith('l')).map(item => item.projectId), Array(5).fill('other'));
  // Naming a project without a parent makes a sub-task top-level there.
  apply({ op: 'task.move', id: 'l4', projectId: INBOX_ID });
  assert.equal(task('l4')?.parentId, null);
});

test('order keys are made by the store, so two pages moving cards to one place never collide', async t => {
  const { store, apply } = await fixture(t);
  apply(...['a', 'b', 'c', 'd'].map(id => ({ op: 'task.create', id, content: id }) as TodoOp));
  const order = () => store.overview().tasks.sort((x, y) => x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0).map(item => item.id);
  assert.deepEqual(order(), ['a', 'b', 'c', 'd']);
  apply({ op: 'task.move', id: 'c', afterId: 'a' });
  apply({ op: 'task.move', id: 'd', afterId: 'a' });
  assert.deepEqual(order(), ['a', 'd', 'c', 'b']);
  apply({ op: 'task.move', id: 'b', afterId: null });
  assert.deepEqual(order(), ['b', 'a', 'd', 'c']);
  const keys = store.overview().tasks.map(item => item.sortKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('next links are an order only: completing either task or moving it leaves both tasks and the link alone', async t => {
  const { store, apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'Draft' }, { op: 'task.create', id: 'b', content: 'Review' });
  assert.throws(() => apply({ op: 'link.create', id: 'self', fromTaskId: 'a', toTaskId: 'a' }), error => kind(error) === 'invalid');
  apply({ op: 'link.create', id: 'ab', fromTaskId: 'a', toTaskId: 'b' });
  assert.throws(() => apply({ op: 'link.create', id: 'ab2', fromTaskId: 'a', toTaskId: 'b' }), error => kind(error) === 'conflict');
  // The later task can be done first.
  apply({ op: 'task.complete', id: 'b', completionId: 'bc', occurrence: null, today: '2026-10-17' });
  assert.ok(task('a'));
  assert.deepEqual(store.overview().links.map(link => link.id), ['ab']);
  apply({ op: 'task.uncomplete', id: 'b', completionId: 'bc' });
  // A deleted task's link is hidden and comes back with the task.
  apply({ op: 'task.delete', id: 'b' });
  assert.deepEqual(store.overview().links, []);
  assert.deepEqual(store.detail('a').next, []);
  apply({ op: 'task.restore', id: 'b' });
  assert.deepEqual(store.detail('a').next.map(item => item.task.id), ['b']);
  assert.deepEqual(store.detail('b').previous.map(item => item.task.id), ['a']);
  const removed = apply({ op: 'link.delete', id: 'ab' });
  assert.deepEqual(removed.removedLinks, ['ab']);
  assert.deepEqual(store.overview().links, []);
});

test('"complete and add the next task" is one request: all of it happens, or none', async t => {
  const { store, apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'Draft' });
  const complete: TodoOp = { op: 'task.complete', id: 'a', completionId: 'ac', occurrence: null, today: '2026-10-17' };
  assert.throws(() => apply(complete, { op: 'task.create', id: 'b', content: 'Review', labelIds: ['nope'] }, { op: 'link.create', id: 'ab', fromTaskId: 'a', toTaskId: 'b' }));
  assert.ok(task('a'));
  assert.equal(task('b'), undefined);
  const request = { requestId: randomUUID(), ops: [complete, { op: 'task.create', id: 'b', content: 'Review' }, { op: 'link.create', id: 'ab', fromTaskId: 'a', toTaskId: 'b' }] as TodoOp[] };
  store.apply(request);
  store.apply(request);
  assert.equal(task('a'), undefined);
  assert.deepEqual(store.overview().tasks.map(item => item.id), ['b']);
  assert.deepEqual(store.detail('b').previous.map(item => [item.task.id, Boolean(item.task.completedAt)]), [['a', true]]);
});

test('deleted things come back together and are removed for good after 30 days', async t => {
  const { store, apply, tick } = await fixture(t);
  apply(
    { op: 'project.create', id: 'p', name: 'Project' }, { op: 'section.create', id: 's', projectId: 'p', name: 'Section' },
    { op: 'task.create', id: 't', projectId: 'p', sectionId: 's', content: 'Task' }, { op: 'task.create', id: 'u', parentId: 't', content: 'Sub' },
    { op: 'comment.create', id: 'm', taskId: 't', body: 'A note' }, { op: 'label.create', id: 'l', name: 'home' },
  );
  assert.throws(() => apply({ op: 'project.delete', id: INBOX_ID }), error => kind(error) === 'invalid');
  tick();
  apply({ op: 'project.delete', id: 'p' });
  assert.deepEqual(store.overview().tasks, []);
  assert.equal(store.overview().sections.length, 0);
  apply({ op: 'project.restore', id: 'p' });
  assert.deepEqual(store.overview().tasks.map(task => task.id).sort(), ['t', 'u']);
  assert.deepEqual(store.detail('t').comments.map(comment => comment.body), ['A note']);
  apply({ op: 'task.update', id: 't', patch: { labelIds: ['l'] } }, { op: 'label.delete', id: 'l' });
  assert.deepEqual(store.overview().tasks.find(task => task.id === 't')?.labelIds, []);
  apply({ op: 'label.restore', id: 'l' });
  assert.deepEqual(store.overview().tasks.find(task => task.id === 't')?.labelIds, ['l']);
  apply({ op: 'task.delete', id: 't' });
  store.purge();
  assert.throws(() => store.detail('t'), error => kind(error) === 'not-found');
  apply({ op: 'task.restore', id: 't' });
  apply({ op: 'task.delete', id: 't' });
  tick(TODO_RETENTION_MS + 1000);
  store.purge();
  assert.throws(() => apply({ op: 'task.restore', id: 't' }), error => kind(error) === 'not-found');
});

test('dates, times and repeating rules stay consistent', async t => {
  const { apply, task } = await fixture(t);
  assert.throws(() => apply({ op: 'task.create', id: 'x', content: 'Time only', dueTime: '10:00' }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'task.create', id: 'x', content: 'Rule only', recurrence: { freq: 'day', interval: 1 } }), error => kind(error) === 'invalid');
  apply({ op: 'task.create', id: 'r', content: 'Monthly', dueDate: '2026-01-31', dueTime: '08:00', recurrence: { freq: 'month', interval: 1 } });
  // Moving the date keeps the saved rule; clearing the date clears the time and the rule.
  apply({ op: 'task.update', id: 'r', patch: { dueDate: '2026-02-28' } });
  assert.deepEqual(task('r')?.recurrence, { freq: 'month', interval: 1, monthDays: [31] });
  apply({ op: 'task.update', id: 'r', patch: { dueDate: null } });
  assert.deepEqual([task('r')?.dueDate, task('r')?.dueTime, task('r')?.recurrence], [null, null, null]);
});

test('a file a newer Tower changed in meaning opens read-only; one it only added to stays writable but is not cleaned', async t => {
  const { dir, store, make } = await fixture(t);
  store.close();
  const db = new DatabaseSync(join(dir, 'todos.sqlite'));
  db.exec(`PRAGMA user_version = ${TODO_SCHEMA_STEP + 1}; CREATE TABLE todo_future (id TEXT); ALTER TABLE todo_tasks ADD COLUMN effort INTEGER NOT NULL DEFAULT 0;`);
  db.close();
  const additive = make();
  additive.start();
  assert.deepEqual(additive.availability(), { state: 'ready' });
  additive.apply({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'n', content: 'Written by an older build' }] });
  assert.equal(additive.overview().tasks.length, 1);
  additive.close();
  const raise = new DatabaseSync(join(dir, 'todos.sqlite'));
  raise.prepare("UPDATE todo_meta SET value = ? WHERE key = 'min_writer'").run(String(TODO_SCHEMA_STEP + 1));
  raise.close();
  const locked = make();
  locked.start();
  t.after(() => locked.close());
  assert.equal(locked.availability().state, 'read-only');
  assert.equal(locked.overview().tasks.length, 1);
  assert.throws(() => locked.apply({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'm', content: 'No' }] }), error => kind(error) === 'locked');
});

test('an unusable runtime, a symlink or another program holding the file makes only todos unavailable, at once', async t => {
  const { store: refused } = await fixture(t, { runtime: () => 'SQLite is too old.' });
  assert.deepEqual(refused.availability(), { state: 'unavailable', reason: 'SQLite is too old.' });
  assert.equal(refused.overview().availability.state, 'unavailable');
  assert.throws(() => refused.apply({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'No' }] }), error => kind(error) === 'unavailable');

  const linked = await mkdtemp(join(tmpdir(), 'tower-todos-link-'));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await writeFile(join(linked, 'elsewhere.sqlite'), '');
  await symlink(join(linked, 'elsewhere.sqlite'), join(linked, 'todos.sqlite'));
  const viaLink = new TodoStore(linked);
  viaLink.start();
  assert.equal(viaLink.availability().state, 'unavailable');

  const { dir, store } = await fixture(t);
  const other = new DatabaseSync(join(dir, 'todos.sqlite'));
  t.after(() => other.close());
  other.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  assert.throws(() => store.apply({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'Blocked' }] }), error => kind(error) === 'unavailable');
  assert.ok(Date.now() - started < 500, 'a held file is reported at once instead of stalling the web');
  other.exec('ROLLBACK');
  store.apply({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'Free again' }] });
});

test('completed tasks page newest first and search finds open tasks before done ones', async t => {
  const { store, apply, tick } = await fixture(t);
  for (const id of ['one', 'two', 'three']) {
    apply({ op: 'task.create', id, content: `Report ${id}` });
    tick();
    apply({ op: 'task.complete', id, completionId: `c-${id}`, occurrence: null, today: '2026-10-17' });
    tick();
  }
  apply({ op: 'task.create', id: 'open', content: 'Report open', description: '50% done' });
  const first = store.completed({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.task.id), ['three', 'two']);
  assert.deepEqual(store.completed({ limit: 2, before: first.before }).items.map(item => item.task.id), ['one']);
  assert.deepEqual(store.search('report').map(task => task.id), ['open']);
  assert.deepEqual(store.search('report', { completed: true })[0].id, 'open');
  assert.equal(store.search('report', { completed: true }).length, 4);
  assert.deepEqual(store.search('50%').map(task => task.id), ['open']);
});
