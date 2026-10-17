import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TowerError } from '../../../shared/errors.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import { INBOX_ID, TODO_RETENTION_MS, TodoStore } from '../../../server/todo/store.js';
import { TODO_DATA_TABLES, TODO_SCHEMA_STEP } from '../../../server/todo/schema.js';

async function fixture(t: TestContext, options: { runtime?: () => string | undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todos-'));
  let clock = new Date('2026-10-17T09:00:00.000Z');
  const make = () => new TodoStore(dir, { now: () => clock, ...options });
  const store = make();
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  // Every request goes through the schema the HTTP route applies, so tests send only what the page can send.
  const apply = (...ops: TodoOp[]) => store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }));
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
  const closedWith = store.detail('g').completions[0].id;
  apply({ op: 'task.uncomplete', id: 'g', completionId: closedWith });
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
  apply({ op: 'task.create', id: 'a', content: 'Draft' }, { op: 'task.create', id: 'b', content: 'Review' }, { op: 'project.create', id: 'elsewhere', name: 'Elsewhere' });
  assert.throws(() => apply({ op: 'link.create', id: 'self', fromTaskId: 'a', toTaskId: 'a' }), error => kind(error) === 'invalid');
  apply({ op: 'link.create', id: 'ab', fromTaskId: 'a', toTaskId: 'b' });
  assert.throws(() => apply({ op: 'link.create', id: 'ab2', fromTaskId: 'a', toTaskId: 'b' }), error => kind(error) === 'conflict');
  // The later task can be done first.
  apply({ op: 'task.complete', id: 'b', completionId: 'bc', occurrence: null, today: '2026-10-17' });
  assert.ok(task('a'));
  assert.deepEqual(store.overview().links.map(link => link.id), ['ab']);
  apply({ op: 'task.uncomplete', id: 'b', completionId: 'bc' });
  apply({ op: 'task.move', id: 'a', projectId: 'elsewhere' });
  apply({ op: 'task.complete', id: 'a', completionId: 'ac', occurrence: null, today: '2026-10-17' });
  assert.ok(task('b'));
  assert.deepEqual(store.detail('b').previous.map(item => [item.task.id, item.task.projectId, Boolean(item.task.completedAt)]), [['a', 'elsewhere', true]]);
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'ac' });
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
  // Undoing the removal is creating the same link again.
  apply({ op: 'link.create', id: 'ab', fromTaskId: 'a', toTaskId: 'b' });
  assert.deepEqual(store.overview().links.map(link => link.id), ['ab']);
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
  assert.ok(Date.now() - started < 900, 'a held file is reported at once instead of stalling the web');
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

test('a repeating parent closes its open sub-tasks with each occurrence, and undoing it reopens those still below it', async t => {
  const { store, apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'p', content: 'Weekly review', dueDate: '2026-10-17', recurrence: { freq: 'week', interval: 1 } },
    { op: 'task.create', id: 'c', parentId: 'p', content: 'Inbox zero' }, { op: 'task.create', id: 'other', content: 'Other' });
  apply({ op: 'task.complete', id: 'p', completionId: 'pc', occurrence: '2026-10-17', today: '2026-10-17' });
  assert.equal(task('p')?.dueDate, '2026-10-24');
  assert.equal(task('c'), undefined);
  apply({ op: 'task.uncomplete', id: 'p', completionId: 'pc' });
  assert.equal(task('p')?.dueDate, '2026-10-17');
  assert.ok(task('c'));
  // A sub-task closed with its parent and then moved below another completed task is no longer below it.
  apply({ op: 'task.create', id: 'a', content: 'A' }, { op: 'task.create', id: 'ac', parentId: 'a', content: 'Below A' }, { op: 'task.create', id: 'b', content: 'B' });
  apply({ op: 'task.complete', id: 'a', completionId: 'acx', occurrence: null, today: '2026-10-17' }, { op: 'task.complete', id: 'b', completionId: 'bcx', occurrence: null, today: '2026-10-17' });
  apply({ op: 'task.move', id: 'ac', parentId: 'b' });
  // A sub-task moved below another task since stays done, and that other task's completion is left alone.
  apply({ op: 'task.uncomplete', id: 'a', completionId: 'acx' });
  assert.ok(task('a'));
  assert.equal(task('ac'), undefined);
  assert.equal(task('b'), undefined);
  assert.equal(store.detail('ac').task.parentId, 'b');
  // Moved below a sibling completed on its own, a sub-task stays done too, so nothing open sits below a done task.
  apply({ op: 'task.create', id: 'q', content: 'Q' }, { op: 'task.create', id: 'qa', parentId: 'q', content: 'QA' }, { op: 'task.create', id: 'qb', parentId: 'q', content: 'QB' });
  apply({ op: 'task.complete', id: 'qa', completionId: 'qac', occurrence: null, today: '2026-10-17' });
  apply({ op: 'task.complete', id: 'q', completionId: 'qc', occurrence: null, today: '2026-10-17' });
  apply({ op: 'task.move', id: 'qb', parentId: 'qa' });
  apply({ op: 'task.uncomplete', id: 'q', completionId: 'qc' });
  assert.ok(task('q'));
  assert.deepEqual([task('qa'), task('qb')], [undefined, undefined]);
  // A chain closed together opens together, parents before children.
  apply({ op: 'task.create', id: 'x', content: 'X' }, { op: 'task.create', id: 'xy', parentId: 'x', content: 'XY' }, { op: 'task.create', id: 'xyz', parentId: 'xy', content: 'XYZ' });
  apply({ op: 'task.complete', id: 'x', completionId: 'xc', occurrence: null, today: '2026-10-17' });
  apply({ op: 'task.uncomplete', id: 'x', completionId: 'xc' });
  assert.ok(task('x') && task('xy') && task('xyz'));
});

test('counting from completion always moves on, even when done before its date', async t => {
  const { apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'r', content: 'Stretch', dueDate: '2026-10-17', recurrence: { freq: 'day', interval: 1, fromCompletion: true } });
  apply({ op: 'task.complete', id: 'r', completionId: 'c1', occurrence: '2026-10-17', today: '2026-10-17' });
  assert.equal(task('r')?.dueDate, '2026-10-18');
  apply({ op: 'task.complete', id: 'r', completionId: 'c2', occurrence: '2026-10-18', today: '2026-10-17' });
  assert.equal(task('r')?.dueDate, '2026-10-19');
  apply({ op: 'task.complete', id: 'r', completionId: 'c3', occurrence: '2026-10-19', today: '2026-10-19' });
  assert.equal(task('r')?.dueDate, '2026-10-20');
  // At the last possible date a repeating task ends instead of moving past it.
  apply({ op: 'task.create', id: 'end', content: 'End', dueDate: '9999-12-31', recurrence: { freq: 'day', interval: 1, fromCompletion: true } });
  apply({ op: 'task.complete', id: 'end', completionId: 'c4', occurrence: '9999-12-31', today: '9999-12-31' });
  assert.equal(task('end'), undefined);
});

test('a long list keeps short, distinct keys however often items are added at its ends or at one place', async t => {
  const { store, apply } = await fixture(t);
  for (let batch = 0; batch < 15; batch++) apply(...Array.from({ length: 100 }, (_, index) => ({ op: 'task.create', id: `end-${batch}-${index}`, content: 'x' }) as TodoOp));
  apply({ op: 'task.create', id: 'top', content: 'Top', afterId: null });
  for (let index = 0; index < 300; index++) apply({ op: 'task.create', id: `mid-${index}`, content: 'x', afterId: 'top' });
  const tasks = store.overview().tasks;
  assert.equal(tasks.length, 1801);
  assert.ok(tasks.every(task => task.sortKey.length <= 24), `longest key ${Math.max(...tasks.map(task => task.sortKey.length))}`);
  assert.equal(new Set(tasks.map(task => task.sortKey)).size, tasks.length);
  const ordered = tasks.sort((a, b) => a.sortKey < b.sortKey ? -1 : 1).map(task => task.id);
  // Each insert right after "top" lands before the previous one.
  assert.deepEqual(ordered.slice(0, 3), ['top', 'mid-299', 'mid-298']);
  assert.deepEqual([ordered[301], ordered[1800]], ['end-0-0', 'end-14-99']);
});

test('a restored item whose key another took meanwhile comes back with a key of its own', async t => {
  const { store, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A' });
  apply({ op: 'task.delete', id: 'a' });
  apply({ op: 'task.create', id: 'b', content: 'B' });
  apply({ op: 'task.restore', id: 'a' });
  const keys = store.overview().tasks.map(task => task.sortKey);
  assert.equal(new Set(keys).size, 2);
  apply({ op: 'label.create', id: 'l1', name: 'one' }, { op: 'label.delete', id: 'l1' }, { op: 'label.create', id: 'l2', name: 'two' }, { op: 'label.restore', id: 'l1' });
  assert.equal(new Set(store.overview().labels.map(label => label.sortKey)).size, 2);
});

test('completions of one moment page without losing any', async t => {
  const { store, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'p', content: 'P' }, ...['a', 'b', 'c'].map(id => ({ op: 'task.create', id, parentId: 'p', content: id }) as TodoOp));
  apply({ op: 'task.complete', id: 'p', completionId: 'pc', occurrence: null, today: '2026-10-17' });
  const seen: string[] = [];
  let before: string | undefined;
  do {
    const page = store.completed({ limit: 2, before });
    seen.push(...page.items.map(item => item.task.id));
    before = page.before;
  } while (before);
  assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'p']);
  assert.throws(() => store.completed({ before: '2026-10-17' }), error => kind(error) === 'invalid');
});

test('restoring brings back exactly what one delete took, where its parent is now, and keeps done tasks done', async t => {
  const { store, apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'p', content: 'Parent' }, { op: 'task.create', id: 'c', parentId: 'p', content: 'Child' });
  // Deleted separately in one request: restoring the parent leaves the child deleted.
  apply({ op: 'task.delete', id: 'c' }, { op: 'task.complete', id: 'p', completionId: 'pc', occurrence: null, today: '2026-10-17' }, { op: 'task.delete', id: 'p' });
  apply({ op: 'task.restore', id: 'p' });
  assert.throws(() => store.detail('c'), error => kind(error) === 'not-found');
  assert.equal(store.detail('p').task.completedAt !== null, true);
  // The child restored below the completed parent is closed with it, and the parent stays done.
  apply({ op: 'task.restore', id: 'c' });
  assert.equal(task('p'), undefined);
  assert.equal(task('c'), undefined);
  assert.ok(store.detail('c').task.completedAt);
  apply({ op: 'task.uncomplete', id: 'p', completionId: 'pc' });
  assert.ok(task('p') && task('c'), 'undoing the parent reopens the child closed with it');

  // A section and a task deleted in one request come back separately.
  apply({ op: 'project.create', id: 'w', name: 'Work' }, { op: 'section.create', id: 's1', projectId: 'w', name: 'One' }, { op: 'section.create', id: 's2', projectId: 'w', name: 'Two' },
    { op: 'task.create', id: 'k1', projectId: 'w', sectionId: 's1', content: 'K1' }, { op: 'task.create', id: 'k2', projectId: 'w', sectionId: 's2', content: 'K2' });
  apply({ op: 'task.delete', id: 'k1' }, { op: 'section.delete', id: 's2' });
  apply({ op: 'section.restore', id: 's2' });
  assert.ok(task('k2'));
  assert.equal(task('k1'), undefined);

  // A sub-task comes back in its parent's section, not the one it had.
  apply({ op: 'section.create', id: 's', projectId: 'w', name: 'S' }, { op: 'task.create', id: 'sp', projectId: 'w', sectionId: 's', content: 'SP' }, { op: 'task.create', id: 'sc', parentId: 'sp', content: 'SC' });
  apply({ op: 'task.delete', id: 'sc' });
  apply({ op: 'section.delete', id: 's' });
  apply({ op: 'task.restore', id: 'sp' });
  apply({ op: 'section.restore', id: 's' });
  apply({ op: 'task.restore', id: 'sc' });
  assert.deepEqual([task('sp')?.sectionId, task('sc')?.sectionId], [null, null]);
  apply({ op: 'section.delete', id: 's' });
  assert.ok(task('sc'), 'deleting the section leaves a sub-task whose parent is outside it');
});

test('a task whose date went back to an occurrence already done can be completed again', async t => {
  const { apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'r', content: 'Daily', dueDate: '2026-10-17', recurrence: { freq: 'day', interval: 1 } },
    { op: 'task.create', id: 'p', content: 'Parent' }, { op: 'task.create', id: 'c', parentId: 'p', content: 'Child', dueDate: '2026-10-17', recurrence: { freq: 'day', interval: 1 } });
  apply({ op: 'task.complete', id: 'r', completionId: 'r1', occurrence: '2026-10-17', today: '2026-10-17' });
  apply({ op: 'task.update', id: 'r', patch: { dueDate: '2026-10-17' } });
  apply({ op: 'task.complete', id: 'r', completionId: 'r2', occurrence: '2026-10-17', today: '2026-10-17' });
  assert.equal(task('r')?.dueDate, '2026-10-18');
  // Turned into a one-off task on a date once done as a repeat.
  apply({ op: 'task.update', id: 'r', patch: { dueDate: '2026-10-17', recurrence: null } });
  apply({ op: 'task.complete', id: 'r', completionId: 'r3', occurrence: null, today: '2026-10-17' });
  assert.equal(task('r'), undefined);
  // A repeating sub-task in that state does not keep its parent from being completed.
  apply({ op: 'task.complete', id: 'c', completionId: 'c1', occurrence: '2026-10-17', today: '2026-10-17' });
  apply({ op: 'task.update', id: 'c', patch: { dueDate: '2026-10-17' } });
  apply({ op: 'task.complete', id: 'p', completionId: 'p1', occurrence: null, today: '2026-10-17' });
  assert.equal(task('p'), undefined);
});

test('every column a delete cascades through is indexed, so removing old rows never scans a table', async t => {
  const { dir, store } = await fixture(t);
  store.close();
  const db = new DatabaseSync(join(dir, 'todos.sqlite'), { readOnly: true });
  t.after(() => db.close());
  for (const [table, column] of [['todo_completions', 'task_id'], ['todo_tasks', 'project_id'], ['todo_tasks', 'section_id'], ['todo_tasks', 'parent_id'],
    ['todo_sections', 'project_id'], ['todo_projects', 'parent_id'], ['todo_task_labels', 'label_id'], ['todo_task_labels', 'task_id'], ['todo_links', 'from_task_id'],
    ['todo_links', 'to_task_id'], ['todo_comments', 'task_id'], ['todo_events', 'task_id'], ['todo_files', 'task_id'], ['todo_files', 'comment_id'], ['todo_files', 'sha256']]) {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = ?`).all('x') as { detail: string }[]).map(row => row.detail).join(' ');
    assert.match(plan, /USING (COVERING )?INDEX|USING PRIMARY KEY/, `${table}.${column}: ${plan}`);
  }
  // Every column a foreign key points from is in the list above.
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
  for (const table of tables) {
    for (const key of db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { from: string }[]) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${key.from} = ?`).all('x') as { detail: string }[]).map(row => row.detail).join(' ');
      assert.match(plan, /USING (COVERING )?INDEX|USING PRIMARY KEY/, `${table}.${key.from}: ${plan}`);
    }
  }
});

test('a backup holds every table but the file’s own bookkeeping', async t => {
  const { dir, store } = await fixture(t);
  store.close();
  const db = new DatabaseSync(join(dir, 'todos.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name).sort();
  assert.deepEqual(tables, [...TODO_DATA_TABLES, 'todo_meta', 'todo_requests'].sort());
});

test('restoring below a task closed with its parent ties the restored task to the top completion', async t => {
  const { apply, task } = await fixture(t);
  apply({ op: 'task.create', id: 'g', content: 'G' }, { op: 'task.create', id: 'p', parentId: 'g', content: 'P' }, { op: 'task.create', id: 'c', parentId: 'p', content: 'C' });
  apply({ op: 'task.delete', id: 'c' });
  apply({ op: 'task.complete', id: 'g', completionId: 'gc', occurrence: null, today: '2026-10-17' });
  apply({ op: 'task.restore', id: 'c' });
  assert.equal(task('c'), undefined);
  apply({ op: 'task.uncomplete', id: 'g', completionId: 'gc' });
  assert.ok(task('g') && task('p') && task('c'));
});

test('projects keep to three levels, never nest in themselves, and restore only what their delete took', async t => {
  const { store, apply } = await fixture(t);
  apply({ op: 'project.create', id: 'a', name: 'A' }, { op: 'project.create', id: 'b', name: 'B', parentId: 'a' }, { op: 'project.create', id: 'c', name: 'C', parentId: 'b' });
  assert.throws(() => apply({ op: 'project.create', id: 'd', name: 'D', parentId: 'c' }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'project.move', id: 'a', parentId: 'c' }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'project.create', id: 'x', name: 'X', parentId: INBOX_ID }), error => kind(error) === 'invalid');
  apply({ op: 'project.create', id: 'e', name: 'E' });
  // B carries C below it: under E it fits (E > B > C), under a level-two project it would not.
  apply({ op: 'project.move', id: 'b', parentId: 'e' });
  assert.equal(store.overview().projects.find(project => project.id === 'b')?.parentId, 'e');
  apply({ op: 'task.create', id: 'k', projectId: 'c', content: 'K' }, { op: 'task.create', id: 'm', projectId: 'c', content: 'M' });
  apply({ op: 'task.delete', id: 'k' }, { op: 'project.delete', id: 'b' });
  apply({ op: 'project.restore', id: 'b' });
  const tasks = store.overview().tasks.map(item => item.id);
  assert.ok(tasks.includes('m'));
  assert.ok(!tasks.includes('k'));
});
