import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDay, reorderDay } from '../../../shared/todo/day-order.js';
import type { TodoOp } from '../../../shared/todo/ops.js';
import type { TodoChanges, TodoCompletedPage, TodoTask } from '../../../shared/todo/types.js';
import { applyOps, inverseOps, mergeChanges, worldFromOverview, type TodoWorld } from '../../../client/src/todo/todo-model.js';
import { TodoClient, type TodoTransport } from '../../../client/src/todo/todo-store.js';
import { boardColumns, defaultDisplay, dropOps, groupingsFor, manualOrder, type ViewContext } from '../../../client/src/todo/todo-views.js';
import { label, overview, task } from './fixtures.js';

// Saturday.
const today = '2026-10-17';
const context = { now: '2026-10-17T10:00:00.000Z', today };
const changes = (revision: number, patch: Partial<TodoChanges> = {}): TodoChanges => ({ revision, projects: [], sections: [], labels: [], tasks: [], links: [], removedLinks: [], comments: [], files: [], ...patch });
const dayIds = (world: TodoWorld, date: string) => Object.values(world.tasks).filter(item => !item.completedAt && !item.deletedAt && item.dueDate === date).sort(compareDay).map(item => item.id);

const tasks = [
  task('a', { dueDate: today, dueTime: '09:00' }),
  task('b', { dueDate: today, priority: 1, labelIds: ['call'] }),
  task('c', { dueDate: today, labelIds: ['call'] }),
  task('d', { dueDate: today, dayOrder: '2026-10-16|0' }),
  task('t', { dueDate: '2026-10-18' }),
];
const world = worldFromOverview(overview(tasks, { labels: [label('call')] }));
const view = (patch: Partial<ViewContext> = {}): ViewContext => ({ world, today, start: today, query: '', searchResults: null, ...patch });

test('a move within a date shows at once as the server will make it, and its undo puts the task back after its old neighbour', () => {
  const op: TodoOp = { op: 'task.move', id: 'd', dayAfterId: 'a' };
  const shown = applyOps(world, [op], context);
  assert.deepEqual(dayIds(shown, today), ['a', 'd', 'b', 'c']);
  const server = new Map(reorderDay(Object.values(world.tasks).filter(item => item.dueDate === today), 'd', 'a').map(item => [item.id, item.dayOrder]));
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(shown.tasks[id].dayOrder, server.get(id), id);
  assert.equal(shown.tasks.t.dayOrder, null);
  const undo = inverseOps(world, [op], () => 'new')!;
  assert.deepEqual(undo, [{ op: 'task.move', id: 'd', dayAfterId: 'c' }]);
  assert.deepEqual(dayIds(applyOps(shown, undo, context), today), ['a', 'b', 'c', 'd']);
  assert.deepEqual(inverseOps(shown, [{ op: 'task.move', id: 'a', dayAfterId: 'b' }], () => 'new'), [{ op: 'task.move', id: 'a', dayAfterId: null }]);
  // An undated task does not move.
  const undated = worldFromOverview(overview([task('n')]));
  assert.equal(applyOps(undated, [{ op: 'task.move', id: 'n', dayAfterId: null }], context), undated);
});

test('date columns keep the order put by hand, and a drop within its own date is a move within that date', () => {
  const ordered = applyOps(world, [{ op: 'task.move', id: 'c', dayAfterId: null }], context);
  const display = defaultDisplay({ kind: 'today' });
  assert.equal(manualOrder(display), true);
  assert.equal(manualOrder({ ...display, sort: 'priority' }), false);
  assert.deepEqual(boardColumns({ kind: 'today' }, display, view({ world: ordered })).find(column => column.id === 'date:today')!.tasks.map(item => item.id), ['c', 'a', 'b', 'd']);
  // Upcoming, and a label's date columns.
  assert.deepEqual(boardColumns({ kind: 'upcoming' }, defaultDisplay({ kind: 'upcoming' }), view({ world: ordered })).find(column => column.id === `date:${today}`)!.tasks.map(item => item.id), ['c', 'a', 'b', 'd']);
  assert.ok(groupingsFor({ kind: 'label', id: 'call' }).includes('date'));
  const labelColumns = boardColumns({ kind: 'label', id: 'call' }, { ...defaultDisplay({ kind: 'label', id: 'call' }), group: 'date' }, view({ world: ordered }));
  assert.deepEqual(labelColumns.find(column => column.id === 'date:today')!.tasks.map(item => item.id), ['c', 'b']);
  // Other groupings keep time and priority first.
  assert.deepEqual(boardColumns({ kind: 'today' }, { ...display, group: 'project' }, view({ world: ordered }))[0].tasks.map(item => item.id), ['a', 'b', 'c', 'd']);
  const b = ordered.tasks.b;
  assert.deepEqual(dropOps(b, { kind: 'date', date: today }, null), [{ op: 'task.move', id: 'b', dayAfterId: null }]);
  assert.deepEqual(dropOps(b, { kind: 'date', date: today }, 'c'), [{ op: 'task.move', id: 'b', dayAfterId: 'c' }]);
  assert.deepEqual(dropOps(b, { kind: 'date', date: today }), []);
  assert.deepEqual(dropOps(b, { kind: 'date', date: '2026-10-18' }, 't'), [{ op: 'task.update', id: 'b', patch: { dueDate: '2026-10-18' } }]);
  assert.deepEqual(dropOps(task('n'), { kind: 'date', date: null }, 'x'), []);
});

test('sub-task counts come from the overview and the answers, and follow a change at once', () => {
  const parents = worldFromOverview(overview([task('p'), task('x', { parentId: 'p' }), task('y', { parentId: 'p' })], { subtaskCounts: { p: { done: 1, total: 3 } } }));
  assert.deepEqual(parents.subtaskCounts, { p: { done: 1, total: 3 } });
  const done = applyOps(parents, [{ op: 'task.complete', id: 'x', completionId: 'c', occurrence: null, today }], context);
  assert.deepEqual(done.subtaskCounts, { p: { done: 2, total: 3 } });
  const added = applyOps(parents, [{ op: 'task.create', id: 'z', parentId: 'p', content: 'Z' }, { op: 'task.delete', id: 'y' }], context);
  assert.deepEqual(added.subtaskCounts, { p: { done: 1, total: 3 } });
  const moved = applyOps(parents, [{ op: 'task.move', id: 'x', parentId: null, projectId: 'inbox' }], context);
  assert.deepEqual(moved.subtaskCounts, { p: { done: 1, total: 2 } });
  assert.deepEqual(mergeChanges(parents, changes(2, { subtaskCounts: { p: { done: 0, total: 0 }, q: { done: 0, total: 1 } } })).subtaskCounts, { q: { done: 0, total: 1 } });
  assert.deepEqual(mergeChanges(parents, changes(2)).subtaskCounts, parents.subtaskCounts);
});

test('a copy waits for the answer, and its undo deletes the copy', () => {
  const op: TodoOp = { op: 'task.duplicate', id: 'a', copyId: 'copy' };
  assert.equal(applyOps(world, [op], context), world);
  assert.deepEqual(inverseOps(world, [op], () => 'new'), [{ op: 'task.delete', id: 'copy' }]);
});

test('a label’s completed list is read for that label, and more of it keeps the label', async () => {
  const asked: { projectId?: string; labelId?: string; before?: string }[] = [];
  const done = (id: string): TodoCompletedPage['items'][number] => ({ completion: { id: `c-${id}`, taskId: id, occurrenceDate: null, completedAt: 'x' }, task: task(id, { completedAt: 'x' }) as TodoTask });
  const transport: TodoTransport = {
    overview: async () => overview([]),
    detail: async () => { throw new Error('unused'); },
    completed: async input => { asked.push(input); return input.before ? { items: [done('two')] } : { items: [done('one')], before: 'cursor' }; },
    search: async () => [],
    apply: async () => changes(1),
    startAgent: async () => undefined,
  };
  const client = new TodoClient(transport, { batchMs: 5, toastMs: 60_000 });
  try {
    await client.readCompleted('', false, 'call');
    assert.deepEqual(client.getState().completed, { projectId: '', labelId: 'call', items: [done('one')], before: 'cursor', loading: false, error: '' });
    await client.readCompleted('', true);
    assert.deepEqual(asked, [{ projectId: undefined, labelId: 'call', before: undefined }, { projectId: undefined, labelId: 'call', before: 'cursor' }]);
    assert.deepEqual(client.getState().completed?.items.map(item => item.task.id), ['one', 'two']);
    // The project's own list is another list.
    await client.readCompleted('');
    assert.equal(client.getState().completed?.labelId, undefined);
    assert.deepEqual(asked.at(-1), { projectId: undefined, before: undefined });
  } finally { client.dispose(); }
});
