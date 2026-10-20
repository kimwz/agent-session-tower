import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TowerError } from '../../../shared/errors.js';
import { TodoRequestSchema, type TodoOp } from '../../../shared/todo/ops.js';
import { MAX_DUPLICATE_TASKS } from '../../../server/todo/ops/tasks.js';
import { TodoStore } from '../../../server/todo/store.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-copies-'));
  let clock = new Date('2026-10-17T09:00:00.000Z');
  const store = new TodoStore(dir, { now: () => clock });
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const apply = (...ops: TodoOp[]) => store.apply(TodoRequestSchema.parse({ requestId: randomUUID(), ops }), 'owner');
  const tick = () => { clock = new Date(clock.getTime() + 1000); };
  return { store, apply, tick };
}

const kind = (error: unknown) => error instanceof TowerError ? error.kind : undefined;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

test('a copy holds the task and its open sub-tasks, right after it, without comments, completions or links', async t => {
  const { store, apply } = await fixture(t);
  apply(
    { op: 'project.create', id: 'work', name: 'Work' },
    { op: 'section.create', id: 'doing', projectId: 'work', name: 'Doing' },
    { op: 'label.create', id: 'urgent', name: 'urgent' },
    { op: 'task.create', id: 'p', projectId: 'work', sectionId: 'doing', content: 'Plan', description: 'Steps', priority: 2, dueDate: '2026-10-19', dueTime: '10:00',
      recurrence: { freq: 'week', interval: 1 }, durationMin: 30, deadlineDate: '2026-10-30', labelIds: ['urgent'] },
    { op: 'task.create', id: 'q', projectId: 'work', sectionId: 'doing', content: 'After' },
    { op: 'task.create', id: 'c1', parentId: 'p', content: 'First' },
    { op: 'task.create', id: 'c1a', parentId: 'c1', content: 'First, part' },
    { op: 'task.create', id: 'c2', parentId: 'p', content: 'Done one' },
    { op: 'task.create', id: 'c3', parentId: 'p', content: 'Deleted one' },
    { op: 'task.create', id: 'c4', parentId: 'p', content: 'Last' },
    { op: 'comment.create', id: 'note', taskId: 'p', body: 'A comment' },
    { op: 'link.create', id: 'l', fromTaskId: 'p', toTaskId: 'q' },
  );
  apply({ op: 'task.complete', id: 'c2', completionId: 'done', occurrence: null, today: '2026-10-17' }, { op: 'task.delete', id: 'c3' });
  const changes = apply({ op: 'task.duplicate', id: 'p', copyId: 'p2' });
  const copy = changes.tasks.find(task => task.id === 'p2')!;
  const original = store.overview().tasks.find(task => task.id === 'p')!;
  const same = ({ projectId, sectionId, parentId, content, description, priority, dueDate, dueTime, recurrence, durationMin, deadlineDate, labelIds }: typeof copy) =>
    ({ projectId, sectionId, parentId, content, description, priority, dueDate, dueTime, recurrence, durationMin, deadlineDate, labelIds });
  assert.deepEqual(same(copy), same(original));
  const order = store.overview().tasks.filter(task => task.sectionId === 'doing' && !task.parentId).sort((a, b) => a.sortKey < b.sortKey ? -1 : 1).map(task => task.id);
  assert.deepEqual(order, ['p', 'p2', 'q']);
  const detail = store.detail('p2');
  assert.deepEqual(detail.subtasks.map(task => task.content), ['First', 'First, part', 'Last']);
  for (const task of detail.subtasks) assert.match(task.id, ID);
  assert.equal(detail.subtasks.find(task => task.content === 'First, part')!.parentId, detail.subtasks.find(task => task.content === 'First')!.id);
  assert.deepEqual([detail.comments, detail.completions, detail.previous, detail.next], [[], [], [], []]);
  assert.deepEqual(detail.events.map(event => [event.kind, event.detail]), [['created', { copyOf: 'p' }]]);
  assert.deepEqual(changes.subtaskCounts?.p2, { done: 0, total: 2 });
  assert.throws(() => apply({ op: 'task.duplicate', id: 'q', copyId: 'p2' }), error => kind(error) === 'invalid');
  assert.throws(() => apply({ op: 'task.duplicate', id: 'missing', copyId: 'x' }), error => kind(error) === 'not-found');
});

test(`a copy holds at most ${MAX_DUPLICATE_TASKS} tasks`, async t => {
  const { apply, store } = await fixture(t);
  apply({ op: 'task.create', id: 'big', content: 'Big' });
  const children = (from: number, count: number) => Array.from({ length: count }, (_, index): TodoOp => ({ op: 'task.create', id: `c${from + index}`, parentId: 'big', content: `Child ${from + index}` }));
  for (let from = 0; from < MAX_DUPLICATE_TASKS - 1; from += 100) apply(...children(from, Math.min(100, MAX_DUPLICATE_TASKS - 1 - from)));
  apply({ op: 'task.duplicate', id: 'big', copyId: 'fits' });
  assert.equal(store.detail('fits').subtasks.length, MAX_DUPLICATE_TASKS - 1);
  apply(...children(MAX_DUPLICATE_TASKS, 1));
  const before = store.revision();
  assert.throws(() => apply({ op: 'task.duplicate', id: 'big', copyId: 'too-many' }), error => kind(error) === 'invalid' && /500/.test((error as Error).message));
  assert.equal(store.revision(), before);
});

test(`one request copies at most ${MAX_DUPLICATE_TASKS} tasks, however many copies it asks for`, async t => {
  const { apply, store } = await fixture(t);
  apply({ op: 'task.create', id: 'big', content: 'Big' });
  const half = Math.ceil(MAX_DUPLICATE_TASKS / 2);
  for (let from = 0; from < half - 1; from += 100) apply(...Array.from({ length: Math.min(100, half - 1 - from) }, (_, index): TodoOp => ({ op: 'task.create', id: `c${from + index}`, parentId: 'big', content: 'Child' })));
  const before = store.revision();
  assert.throws(() => apply({ op: 'task.duplicate', id: 'big', copyId: 'one' }, { op: 'task.duplicate', id: 'big', copyId: 'two' }, { op: 'task.duplicate', id: 'big', copyId: 'three' }),
    error => kind(error) === 'invalid' && /500/.test((error as Error).message));
  assert.equal(store.revision(), before);
  apply({ op: 'task.duplicate', id: 'big', copyId: 'one' });
  apply({ op: 'task.duplicate', id: 'big', copyId: 'two' });
  assert.equal(store.detail('two').subtasks.length, half - 1, 'each request has its own allowance');
});

test('nothing is put in, under or copied into an archived project or section', async t => {
  const { apply, store } = await fixture(t);
  apply(
    { op: 'project.create', id: 'old', name: 'Old' },
    { op: 'project.create', id: 'kid', name: 'Kid', parentId: 'old' },
    { op: 'project.create', id: 'live', name: 'Live' },
    { op: 'section.create', id: 'shelf', projectId: 'live', name: 'Shelf' },
    { op: 'task.create', id: 'in-kid', projectId: 'kid', content: 'In kid' },
    { op: 'task.create', id: 'on-shelf', projectId: 'live', sectionId: 'shelf', content: 'On shelf' },
    { op: 'task.create', id: 'free', projectId: 'live', content: 'Free' },
  );
  apply({ op: 'project.update', id: 'old', patch: { archived: true } }, { op: 'section.update', id: 'shelf', patch: { archived: true } });
  const before = store.revision();
  for (const op of [
    { op: 'task.move', id: 'free', parentId: 'in-kid' },
    { op: 'task.move', id: 'free', parentId: 'on-shelf' },
    { op: 'task.move', id: 'free', projectId: 'live', sectionId: 'shelf' },
    { op: 'task.create', id: 'new', parentId: 'on-shelf', content: 'New' },
    { op: 'task.duplicate', id: 'on-shelf', copyId: 'copy' },
    { op: 'task.duplicate', id: 'in-kid', copyId: 'copy' },
  ] as TodoOp[]) assert.throws(() => apply(op), error => kind(error) === 'invalid' && /보관된/.test((error as Error).message), op.op);
  assert.equal(store.revision(), before);
});

test('the overview carries the completed sub-tasks of open tasks only, for their cards', async t => {
  const { store, apply } = await fixture(t);
  const done = (id: string) => apply({ op: 'task.complete', id, completionId: `c-${id}`, occurrence: null, today: '2026-10-17' });
  apply(
    { op: 'task.create', id: 'p', content: 'Open parent' },
    { op: 'task.create', id: 'a', parentId: 'p', content: 'Done' },
    { op: 'task.create', id: 'b', parentId: 'p', content: 'Open' },
    { op: 'task.create', id: 'c', parentId: 'p', content: 'Done, then deleted' },
    { op: 'task.create', id: 'a1', parentId: 'a', content: 'Done grandchild' },
    { op: 'task.create', id: 'q', content: 'Completed parent' },
    { op: 'task.create', id: 'q1', parentId: 'q', content: 'Its done sub-task' },
    { op: 'task.create', id: 'top', content: 'Done top-level task' },
  );
  for (const id of ['a', 'c', 'q', 'top']) done(id);
  apply({ op: 'task.delete', id: 'c' });
  const overview = store.overview();
  assert.deepEqual(overview.doneSubtasks?.map(task => task.id), ['a']);
  assert.ok(overview.doneSubtasks?.every(task => task.completedAt));
  assert.ok(overview.tasks.every(task => !task.completedAt), 'the open list keeps its meaning');
});

test('the overview counts each open task’s sub-tasks, and every answer carries the counts it changed', async t => {
  const { store, apply } = await fixture(t);
  apply(
    { op: 'task.create', id: 'p', content: 'Parent' },
    { op: 'task.create', id: 'other', content: 'Other parent' },
    { op: 'task.create', id: 'a', parentId: 'p', content: 'A' },
    { op: 'task.create', id: 'b', parentId: 'p', content: 'B' },
    { op: 'task.create', id: 'c', parentId: 'p', content: 'C' },
  );
  apply({ op: 'task.complete', id: 'a', completionId: 'ca', occurrence: null, today: '2026-10-17' });
  assert.deepEqual(store.overview().subtaskCounts, { p: { done: 1, total: 3 } });
  assert.deepEqual(apply({ op: 'task.complete', id: 'b', completionId: 'cb', occurrence: null, today: '2026-10-17' }).subtaskCounts, { p: { done: 2, total: 3 } });
  assert.deepEqual(apply({ op: 'task.uncomplete', id: 'b', completionId: 'cb' }).subtaskCounts, { p: { done: 1, total: 3 } });
  assert.deepEqual(apply({ op: 'task.delete', id: 'c' }).subtaskCounts, { p: { done: 1, total: 2 } });
  assert.deepEqual(apply({ op: 'task.restore', id: 'c' }).subtaskCounts, { p: { done: 1, total: 3 } });
  assert.deepEqual(apply({ op: 'task.move', id: 'c', parentId: 'other' }).subtaskCounts, { p: { done: 1, total: 2 }, other: { done: 0, total: 1 } });
  assert.deepEqual(apply({ op: 'task.move', id: 'c', projectId: 'inbox', parentId: null }).subtaskCounts, { other: { done: 0, total: 0 } });
  assert.equal(apply({ op: 'task.update', id: 'p', patch: { content: 'Renamed' } }).subtaskCounts, undefined);
  // Completing the parent completes its sub-tasks, and a completed task is not in the overview's counts.
  assert.deepEqual(apply({ op: 'task.complete', id: 'p', completionId: 'cp', occurrence: null, today: '2026-10-17' }).subtaskCounts, { p: { done: 2, total: 2 } });
  assert.deepEqual(store.overview().subtaskCounts, {});
});

test('completed tasks can be listed by label, and search with completed ones gives their completion time', async t => {
  const { store, apply, tick } = await fixture(t);
  apply({ op: 'label.create', id: 'call', name: 'call' }, { op: 'label.create', id: 'mail', name: 'mail' });
  for (const [id, labelIds] of [['one', ['call']], ['two', []], ['three', ['call', 'mail']]] as const) {
    apply({ op: 'task.create', id, content: `Report ${id}`, labelIds: [...labelIds] });
    tick();
    apply({ op: 'task.complete', id, completionId: `c-${id}`, occurrence: null, today: '2026-10-17' });
    tick();
  }
  assert.deepEqual(store.completed({ labelId: 'call' }).items.map(item => item.task.id), ['three', 'one']);
  assert.deepEqual(store.completed({ labelId: 'mail' }).items.map(item => item.task.id), ['three']);
  const first = store.completed({ labelId: 'call', limit: 1 });
  assert.deepEqual(store.completed({ labelId: 'call', before: first.before }).items.map(item => item.task.id), ['one']);
  assert.equal(store.completed({}).items.length, 3);
  const found = store.search('report', { completed: true });
  assert.deepEqual(found.map(task => task.id).sort(), ['one', 'three', 'two']);
  assert.deepEqual(Object.fromEntries(found.map(task => [task.id, task.completedAt])),
    { one: '2026-10-17T09:00:01.000Z', two: '2026-10-17T09:00:03.000Z', three: '2026-10-17T09:00:05.000Z' });
  assert.deepEqual(store.search('report'), []);
});

test('activity names the fields an update changed, where a move went, and who made the task', async t => {
  const { store, apply } = await fixture(t);
  apply({ op: 'task.create', id: 'a', content: 'A', dueDate: '2026-10-17' }, { op: 'task.create', id: 'b', content: 'B', dueDate: '2026-10-17' });
  apply({ op: 'task.update', id: 'a', patch: { dueDate: '2026-10-18', priority: 1 } });
  apply({ op: 'task.update', id: 'b', patch: { content: 'Bee' } });
  apply({ op: 'task.move', id: 'b', dayAfterId: null });
  assert.deepEqual(store.detail('a').events.map(event => [event.kind, event.detail]), [['updated', { fields: ['priority', 'dueDate'] }], ['created', { by: 'owner' }]]);
  assert.deepEqual(store.detail('b').events.map(event => [event.kind, event.detail]), [['moved', { day: '2026-10-17' }], ['updated', { fields: ['content'] }], ['created', { by: 'owner' }]]);
});
