import test from 'node:test';
import assert from 'node:assert/strict';
import type { TodoRequest } from '../../../shared/todo/ops.js';
import type { TodoChanges, TodoCompletedPage, TodoOverview, TodoTask, TodoTaskDetail } from '../../../shared/todo/types.js';
import { ApiError } from '../../../client/src/common/lib.js';
import { TodoClient, type TodoTransport } from '../../../client/src/todo/todo-store.js';
import { applyOps, inverseOps, mergeChanges, worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { overview, project, task } from './fixtures.js';

const changes = (revision: number, patch: Partial<TodoChanges> = {}): TodoChanges => ({ revision, projects: [], sections: [], labels: [], tasks: [], links: [], removedLinks: [], comments: [], ...patch });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

class FakeTransport implements TodoTransport {
  requests: TodoRequest[] = [];
  reads = { overview: 0, detail: 0, completed: 0 };
  current: TodoOverview = overview([task('a', { content: 'A' }), task('b', { content: 'B' })]);
  answer: (request: TodoRequest) => Promise<TodoChanges> = async request => changes(++this.current.revision, { tasks: request.ops.flatMap(op => 'id' in op && this.current.tasks.find(item => item.id === op.id) ? [{ ...this.current.tasks.find(item => item.id === op.id)!, content: 'server' }] : []) });
  hold?: Promise<void>;
  async overview() { this.reads.overview++; return structuredClone(this.current); }
  async detail(id: string): Promise<TodoTaskDetail> {
    this.reads.detail++;
    return { task: this.current.tasks.find(item => item.id === id)!, subtasks: [], comments: [], completions: [], events: [], previous: [], next: [] };
  }
  async completed(): Promise<TodoCompletedPage> { this.reads.completed++; return { items: [] }; }
  async search(): Promise<TodoTask[]> { return []; }
  async apply(request: TodoRequest) { this.requests.push(request); if (this.hold) await this.hold; return this.answer(request); }
}

const clients: TodoClient[] = [];
test.afterEach(() => { for (const client of clients.splice(0)) client.dispose(); });
const ready = async (transport = new FakeTransport()) => {
  const client = new TodoClient(transport, { batchMs: 5, toastMs: 60_000 });
  clients.push(client);
  client.start();
  await settle();
  return { client, transport };
};

test('the overview loads, and a change shows at once and is replaced by the answer', async () => {
  const { client, transport } = await ready();
  assert.equal(client.getState().phase, 'ready');
  client.apply([{ op: 'task.update', id: 'a', patch: { content: 'mine' } }]);
  assert.equal(client.getState().world.tasks.a.content, 'mine');
  await settle();
  assert.equal(transport.requests.length, 1);
  assert.equal(client.getState().world.tasks.a.content, 'server');
  assert.equal(client.getState().world.revision, 2);
});

test('changes made within the batch window go as one request, each call kept whole', async () => {
  const { client, transport } = await ready();
  client.apply([{ op: 'task.update', id: 'a', patch: { priority: 1 } }]);
  client.apply([
    { op: 'task.complete', id: 'a', completionId: 'c1', occurrence: null, today: '2026-10-14' },
    { op: 'task.create', id: 'n', content: 'Next', projectId: 'inbox' },
    { op: 'link.create', id: 'l', fromTaskId: 'a', toTaskId: 'n' },
  ]);
  assert.equal(client.getState().world.tasks.n.content, 'Next');
  assert.ok(client.getState().world.links.l);
  await settle();
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0].ops.map(op => op.op), ['task.update', 'task.complete', 'task.create', 'link.create']);
  assert.match(transport.requests[0].requestId, /^[0-9a-f-]{36}$/);
});

test('a refused change is taken back and the page says why', async () => {
  const transport = new FakeTransport();
  transport.answer = async () => { throw new ApiError('제목이 너무 깁니다.', 400); };
  const { client } = await ready(transport);
  client.apply([{ op: 'task.update', id: 'a', patch: { content: 'mine' } }]);
  await settle();
  assert.equal(client.getState().world.tasks.a.content, 'A');
  assert.equal(client.getState().toasts.length, 1);
  assert.match(client.getState().toasts[0].message, /제목이 너무 깁니다/);
  assert.equal(client.getState().canUndo, false);
  assert.equal(transport.reads.overview, 1);
});

test('a conflict reads the overview again', async () => {
  const transport = new FakeTransport();
  transport.answer = async () => { throw new ApiError('이미 완료된 작업입니다.', 409); };
  const { client } = await ready(transport);
  client.apply([{ op: 'task.complete', id: 'a', completionId: 'c', occurrence: null, today: '2026-10-14' }]);
  await settle();
  assert.equal(transport.reads.overview, 2);
  assert.ok(client.getState().world.tasks.a && !client.getState().world.tasks.a.completedAt);
});

test('a newer revision reads the overview, the open detail and the completed list once the request in flight is answered', async () => {
  const transport = new FakeTransport();
  let release!: () => void;
  const { client } = await ready(transport);
  client.openDetail('a');
  await client.readCompleted('inbox');
  await settle();
  const before = { ...transport.reads };
  transport.hold = new Promise(resolve => { release = resolve; });
  client.apply([{ op: 'task.update', id: 'b', patch: { priority: 2 } }]);
  await settle();
  // Another page's change.
  transport.current.revision = 4;
  client.noticeRevision(4);
  client.noticeRevision(4);
  await settle();
  assert.equal(transport.reads.overview, before.overview, 'nothing is read while a request is in flight');
  release();
  await settle();
  assert.equal(transport.reads.overview, before.overview + 1);
  assert.equal(transport.reads.detail, before.detail + 1);
  assert.equal(transport.reads.completed, before.completed + 1);
  assert.equal(client.getState().world.revision, 5);
  // Its own answer counts as read.
  client.apply([{ op: 'task.update', id: 'b', patch: { priority: 3 } }]);
  await settle();
  client.noticeRevision(6);
  await settle();
  assert.equal(transport.reads.overview, before.overview + 1);
  assert.equal(client.getState().world.revision, 6);
});

test('undo sends the inverse of the last change: reopening the same completion', async () => {
  const { client, transport } = await ready();
  client.apply([{ op: 'task.complete', id: 'a', completionId: 'done-1', occurrence: null, today: '2026-10-14' }]);
  assert.ok(client.getState().world.tasks.a.completedAt);
  assert.equal(client.getState().canUndo, true);
  assert.equal(client.undo(), true);
  assert.equal(client.getState().world.tasks.a.completedAt, null);
  assert.equal(client.getState().canUndo, false);
  await settle();
  assert.deepEqual(transport.requests.flatMap(request => request.ops), [
    { op: 'task.complete', id: 'a', completionId: 'done-1', occurrence: null, today: '2026-10-14' },
    { op: 'task.uncomplete', id: 'a', completionId: 'done-1' },
  ]);
});

test('read-only todos refuse changes without sending them', async () => {
  const transport = new FakeTransport();
  transport.current = { ...transport.current, availability: { state: 'read-only', reason: 'newer' } };
  const { client } = await ready(transport);
  assert.equal(client.apply([{ op: 'task.update', id: 'a', patch: { priority: 1 } }]), false);
  await settle();
  assert.equal(transport.requests.length, 0);
  assert.equal(client.getState().toasts[0].tone, 'error');
});

test('completing a repeating task shows its next date, and its sub-tasks closed', () => {
  const world = worldFromOverview(overview([
    task('r', { dueDate: '2026-10-14', recurrence: { freq: 'week', interval: 1, weekdays: [3] } }),
    task('s', { parentId: 'r' }),
  ]));
  const next = applyOps(world, [{ op: 'task.complete', id: 'r', completionId: 'c', occurrence: '2026-10-14', today: '2026-10-14' }], { now: 'now', today: '2026-10-14' });
  assert.equal(next.tasks.r.dueDate, '2026-10-21');
  assert.equal(next.tasks.r.completedAt, null);
  assert.equal(next.tasks.s.completedAt, 'now');
});

test('moves place a task where the server will and their inverse puts it back', () => {
  const world = worldFromOverview(overview([task('a', { sortKey: 'a' }), task('b', { sortKey: 'b' }), task('c', { sortKey: 'c' })]));
  const moved = applyOps(world, [{ op: 'task.move', id: 'c', afterId: null }], { now: 'now', today: '2026-10-14' });
  assert.deepEqual(Object.values(moved.tasks).sort((x, y) => x.sortKey < y.sortKey ? -1 : 1).map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(inverseOps(world, [{ op: 'task.move', id: 'c', afterId: null }], () => 'x'), [{ op: 'task.move', id: 'c', projectId: 'inbox', sectionId: null, parentId: null, afterId: 'b' }]);
  assert.deepEqual(inverseOps(world, [{ op: 'task.update', id: 'a', patch: { dueDate: null } }], () => 'x'), [{ op: 'task.update', id: 'a', patch: { dueDate: null, dueTime: null, recurrence: null } }]);
  assert.equal(inverseOps(world, [{ op: 'task.uncomplete', id: 'a', completionId: 'c' }], () => 'x'), null);
});

test('an answer replaces what it changed: deleted things leave the overview, links come and go', () => {
  const world = worldFromOverview(overview([task('a'), task('b')], { projects: [project('inbox', { inbox: true }), project('p')] }));
  const next = mergeChanges(world, changes(4, {
    tasks: [{ ...world.tasks.a, deletedAt: 'now' }],
    projects: [{ ...world.projects[1], deletedAt: 'now' }],
    links: [{ id: 'l', fromTaskId: 'a', toTaskId: 'b', kind: 'next', createdAt: 'now' }],
  }));
  assert.equal(next.revision, 4);
  assert.equal(next.tasks.a.deletedAt, 'now');
  assert.deepEqual(next.projects.map(item => item.id), ['inbox']);
  assert.ok(next.links.l);
  assert.equal(mergeChanges(next, changes(5, { removedLinks: ['l'] })).links.l, undefined);
});
