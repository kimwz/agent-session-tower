import test from 'node:test';
import assert from 'node:assert/strict';
import type { TodoRequest } from '../../../shared/todo/ops.js';
import type { TodoAgent, TodoChanges, TodoCompletedPage, TodoFile, TodoOverview, TodoTask, TodoTaskDetail } from '../../../shared/todo/types.js';
import { ApiError } from '../../../client/src/common/lib.js';
import { TodoClient, type TodoTransport } from '../../../client/src/todo/todo-store.js';
import { applyOps, inverseOps, mergeChanges, withDetail, worldFromOverview } from '../../../client/src/todo/todo-model.js';
import { createActions, quickAddOps } from '../../../client/src/todo/todo-actions.js';
import { overview, project, task } from './fixtures.js';

const changes = (revision: number, patch: Partial<TodoChanges> = {}): TodoChanges => ({ revision, projects: [], sections: [], labels: [], tasks: [], links: [], removedLinks: [], comments: [], files: [], ...patch });
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

class FakeTransport implements TodoTransport {
  requests: TodoRequest[] = [];
  reads = { overview: 0, detail: 0, completed: 0 };
  current: TodoOverview = overview([task('a', { content: 'A' }), task('b', { content: 'B' })]);
  answer: (request: TodoRequest) => Promise<TodoChanges> = async request => changes(++this.current.revision, { tasks: request.ops.flatMap(op => 'id' in op && this.current.tasks.find(item => item.id === op.id) ? [{ ...this.current.tasks.find(item => item.id === op.id)!, content: 'server' }] : []) });
  hold?: Promise<void>;
  overviewHold?: Promise<void>;
  completions: Record<string, string[]> = {};
  completedPages: (() => Promise<TodoCompletedPage>)[] = [];
  async overview() { this.reads.overview++; const answer = structuredClone(this.current); if (this.overviewHold) await this.overviewHold; return answer; }
  async detail(id: string): Promise<TodoTaskDetail> {
    this.reads.detail++;
    const completions = (this.completions[id] ?? []).map(completion => ({ id: completion, taskId: id, occurrenceDate: null, completedAt: 'x' }));
    return { task: this.current.tasks.find(item => item.id === id)!, subtasks: [], comments: [], completions, events: [], previous: [], next: [], files: [] };
  }
  completedAsked: Parameters<TodoTransport['completed']>[0][] = [];
  async completed(input: Parameters<TodoTransport['completed']>[0]): Promise<TodoCompletedPage> { this.reads.completed++; this.completedAsked.push(input); const next = this.completedPages.shift(); return next ? next() : { items: [] }; }
  async search(): Promise<TodoTask[]> { return []; }
  async apply(request: TodoRequest) { this.requests.push(request); if (this.hold) await this.hold; return this.answer(request); }
  started: { taskId: string; text: string }[] = [];
  startAnswer: (taskId: string) => Promise<{ agent?: TodoAgent } | undefined> = async () => undefined;
  async startAgent(taskId: string, text: string) { this.started.push({ taskId, text }); return this.startAnswer(taskId); }
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
  // A thread set on a task that had none is undone by clearing it, which a patch can say.
  assert.deepEqual(inverseOps(world, [{ op: 'task.update', id: 'a', patch: { slackThread: { teamId: 'T0TEAM', channel: 'C0CHANNEL', threadTs: '1.2' } } }], () => 'x'), [{ op: 'task.update', id: 'a', patch: { slackThread: null } }]);
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

test('a change made while the overview is read, with a newer revision announced meanwhile, is still sent, and the read follows', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  let release!: () => void;
  transport.overviewHold = new Promise(resolve => { release = resolve; });
  client.noticeRevision(2);
  await settle();
  client.apply([{ op: 'task.update', id: 'a', patch: { priority: 1 } }]);
  await settle();
  client.noticeRevision(3);
  assert.equal(transport.requests.length, 0, 'nothing is sent during a read');
  transport.overviewHold = undefined;
  release();
  await settle(40);
  assert.equal(transport.requests.length, 1);
  assert.equal(client.pending(), 0);
  assert.equal(transport.reads.overview, 3, 'the read asked for meanwhile runs after the request');
});

test('an answer more than one revision ahead reads the overview again, so another page’s change is not lost', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  // Another page changes b in between.
  transport.current.revision = 2;
  transport.current.tasks = transport.current.tasks.map(item => item.id === 'b' ? { ...item, content: 'other page' } : item);
  client.apply([{ op: 'task.update', id: 'a', patch: { priority: 1 } }]);
  await settle(40);
  assert.equal(client.getState().world.revision, 3);
  assert.equal(transport.reads.overview, 2);
  assert.equal(client.getState().world.tasks.b.content, 'other page');
});

test('an open completed list is read again after this page completes or reopens a task', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  await client.readCompleted('');
  const before = transport.reads.completed;
  client.apply([{ op: 'task.complete', id: 'a', completionId: 'c1', occurrence: null, today: '2026-10-14' }]);
  await settle();
  assert.equal(transport.reads.completed, before + 1);
  client.apply([{ op: 'task.update', id: 'b', patch: { priority: 2 } }]);
  await settle();
  assert.equal(transport.reads.completed, before + 1);
});

test('the completed sub-tasks of open tasks come with the overview; one gone from it (deleted elsewhere) leaves', () => {
  const p = task('p'), done = (id: string) => task(id, { parentId: 'p', completedAt: 'x' });
  const first = worldFromOverview(overview([p, task('p3', { parentId: 'p' })], { doneSubtasks: [done('p1'), done('p2')] }));
  assert.deepEqual(Object.keys(first.tasks).sort(), ['p', 'p1', 'p2', 'p3']);
  // Another page deleted p2; a task this page deleted, and a completed task of no open parent, stay known (undo).
  const mine = { ...done('p4'), deletedAt: 'y' }, other = task('t', { completedAt: 'x' });
  const next = worldFromOverview(overview([p, task('p3', { parentId: 'p' })], { doneSubtasks: [done('p1')] }), { ...first, tasks: { ...first.tasks, p4: mine, t: other } });
  assert.deepEqual(Object.keys(next.tasks).sort(), ['p', 'p1', 'p3', 'p4', 't']);
  // An older server sends none: what the page saw stays.
  assert.ok(worldFromOverview(overview([p]), first).tasks.p2);
});

test('reopening a task reads the overview again, for the completed sub-tasks its card lists', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  const before = transport.reads.overview;
  client.apply([{ op: 'task.update', id: 'a', patch: { priority: 2 } }]);
  await settle();
  assert.equal(transport.reads.overview, before);
  client.apply([{ op: 'task.uncomplete', id: 'a', completionId: 'c1' }]);
  await settle();
  assert.equal(transport.reads.overview, before + 1);
});

test('reopening sends the completion of the row chosen, or the task’s latest read fresh', async () => {
  const { client, transport } = await ready();
  const actions = createActions(client, { openTask() {} });
  const task = client.getState().world.tasks.a;
  await actions.reopen(task, 'c-old');
  transport.completions.a = ['c-new', 'c-old'];
  await actions.reopen(task);
  await settle();
  assert.deepEqual(transport.requests.flatMap(request => request.ops).map(op => 'completionId' in op ? op.completionId : ''), ['c-old', 'c-new']);
});

test('a period’s completed list is read whole, page after page, and again with its period after a completion', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  const item = (id: string) => ({ completion: { id, taskId: 'a', occurrenceDate: null, completedAt: 'x' }, task: transport.current.tasks[0] });
  transport.completedPages = [async () => ({ items: [item('c1')], before: 'p1' }), async () => ({ items: [item('c2')], before: 'p2' }), async () => ({ items: [item('c3')] })];
  const range = { since: '2026-09-28T15:00:00.000Z', until: '2026-11-09T15:00:00.000Z' };
  await client.readCompleted('inbox', false, undefined, range);
  const list = client.getState().completed!;
  assert.deepEqual(list.items.map(entry => entry.completion.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(list.range, range);
  assert.equal(list.before, undefined);
  assert.deepEqual(transport.completedAsked.map(input => input.before), [undefined, 'p1', 'p2']);
  assert.ok(transport.completedAsked.every(input => input.projectId === 'inbox' && input.since === range.since && input.until === range.until && input.limit === 100));
  client.apply([{ op: 'task.complete', id: 'b', completionId: 'cb', occurrence: null, today: '2026-10-14' }]);
  await settle();
  assert.deepEqual(transport.completedAsked.at(-1), { projectId: 'inbox', before: undefined, ...range, limit: 100 });
  // The board's list, of no period, starts afresh instead of keeping the period's rows.
  let release!: () => void;
  transport.completedPages = [() => new Promise(resolve => { release = () => resolve({ items: [] }); })];
  const board = client.readCompleted('inbox');
  assert.deepEqual(client.getState().completed?.items, []);
  assert.equal(client.getState().completed?.range, undefined);
  release();
  await board;
  assert.equal(transport.completedAsked.at(-1)?.since, undefined);
});

test('a period reads at most ten pages, and a page that fails leaves the list with its error', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  const item = (id: string) => ({ completion: { id, taskId: 'a', occurrenceDate: null, completedAt: 'x' }, task: transport.current.tasks[0] });
  transport.completedPages = Array.from({ length: 11 }, (_, index) => async () => ({ items: [item(`c${index}`)], before: `p${index}` }));
  const range = { since: '2026-09-28T15:00:00.000Z', until: '2026-11-09T15:00:00.000Z' };
  await client.readCompleted('', false, undefined, range);
  assert.equal(transport.completedAsked.length, 10);
  assert.equal(client.getState().completed?.items.length, 10);
  assert.equal(client.getState().completed?.before, undefined);
  transport.completedPages = [async () => ({ items: [item('d0')], before: 'q0' }), async () => { throw new ApiError('읽지 못했습니다.', 500); }];
  await client.readCompleted('', false, 'call', range);
  assert.equal(client.getState().completed?.loading, false);
  assert.equal(client.getState().completed?.error, '읽지 못했습니다.');
});

test('a change answered while the completed list is still being read reads it again', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  let release!: () => void;
  transport.completedPages = [() => new Promise(resolve => { release = () => resolve({ items: [] }); })];
  const first = client.readCompleted('');
  client.apply([{ op: 'task.update', id: 'a', patch: { priority: 2 } }]);
  await settle();
  release();
  await first;
  await settle();
  assert.equal(transport.reads.completed, 2);
});

test('the completed list is read again when the answer changes a listed task that was not asked for (moved with its parent)', async () => {
  const transport = new FakeTransport();
  transport.current = overview([task('p', { content: 'P' })]);
  const { client } = await ready(transport);
  const child = task('c', { parentId: 'p', completedAt: 'x' });
  transport.completedPages.push(async () => ({ items: [{ completion: { id: 'cc', taskId: 'c', occurrenceDate: null, completedAt: 'x' }, task: child }] }));
  await client.readCompleted('inbox');
  const before = transport.reads.completed;
  transport.answer = async () => changes(++transport.current.revision, { tasks: [{ ...task('p'), projectId: 'b' }, { ...child, projectId: 'b' }] });
  client.apply([{ op: 'task.move', id: 'p', projectId: 'b', sectionId: null, parentId: null }]);
  await settle();
  assert.equal(transport.reads.completed, before + 1);
});

test('a late answer to an older completed-list load never replaces a newer one', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  let releaseOld!: () => void;
  const done = { completion: { id: 'c1', taskId: 'a', occurrenceDate: null, completedAt: 'x' }, task: transport.current.tasks[0] };
  transport.completedPages = [
    () => new Promise(resolve => { releaseOld = () => resolve({ items: [] }); }),
    async () => ({ items: [done] }),
  ];
  const old = client.readCompleted('');
  await client.readCompleted('');
  assert.equal(client.getState().completed?.items.length, 1);
  releaseOld();
  await old;
  assert.equal(client.getState().completed?.items.length, 1);
  assert.equal(client.getState().completed?.loading, false);
});

test('files: an upload’s changes add the file and its count; deleting shows at once and undoes with file.restore', () => {
  const at = '2026-10-14T00:00:00.000Z';
  const file = (id: string, patch: Partial<TodoFile> = {}): TodoFile => ({ id, taskId: 'a', commentId: null, name: `${id}.png`, mimeType: 'image/png', size: 10, sha256: 'x'.repeat(64), createdAt: at, deletedAt: null, ...patch });
  let world = worldFromOverview(overview([task('a')], { fileCounts: { a: 1 }, restore: { state: 'partial', total: 3, missing: 1 } }));
  assert.deepEqual(world.restore, { state: 'partial', total: 3, missing: 1 });
  world = withDetail(world, { task: world.tasks.a, subtasks: [], comments: [], completions: [], events: [], previous: [], next: [], files: [file('f1')] });
  world = mergeChanges(world, changes(2, { files: [file('f2')] }));
  assert.equal(world.fileCounts.a, 2);
  assert.deepEqual(world.detail?.files.map(item => item.id), ['f1', 'f2']);
  const deleted = applyOps(world, [{ op: 'file.delete', id: 'f1' }], { now: at, today: '2026-10-14' });
  assert.equal(deleted.fileCounts.a, 1);
  assert.equal(deleted.detail?.files.find(item => item.id === 'f1')?.deletedAt, at);
  assert.deepEqual(inverseOps(world, [{ op: 'file.delete', id: 'f1' }], () => 'x'), [{ op: 'file.restore', id: 'f1' }]);
  // A file of a task whose detail is not open still moves the count.
  const closed = mergeChanges(withDetail(world, null), changes(3, { files: [file('f3', { taskId: 'b' })] }));
  assert.equal(closed.fileCounts.b, 1);
});

test('an upload’s answer reaches the page through the store like a request’s', async () => {
  const { client } = await ready();
  const at = '2026-10-14T00:00:00.000Z';
  client.receive(changes(2, { files: [{ id: 'f', taskId: 'a', commentId: null, name: 'n', mimeType: 'text/plain', size: 1, sha256: 'x'.repeat(64), createdAt: at, deletedAt: null }] }));
  assert.equal(client.getState().world.fileCounts.a, 1);
  assert.equal(client.getState().world.revision, 2);
});

test('a change can be waited for: true once saved, false when refused', async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  assert.equal(await client.applyAndWait([{ op: 'comment.create', id: 'c', taskId: 'a', body: 'x' }]), true);
  transport.answer = async () => { throw new ApiError('no', 400); };
  assert.equal(await client.applyAndWait([{ op: 'comment.create', id: 'd', taskId: 'a', body: 'x' }]), false);
});

test('the open task’s file count follows its detail, so answers arriving out of order cannot skew it', () => {
  const at = '2026-10-14T00:00:00.000Z';
  const file = (id: string, commentId: string | null = null): TodoFile => ({ id, taskId: 'a', commentId, name: id, mimeType: 'text/plain', size: 1, sha256: 'x'.repeat(64), createdAt: at, deletedAt: null });
  // The overview was read before the second upload finished; the detail after.
  let world = worldFromOverview(overview([task('a')], { fileCounts: { a: 1 } }));
  world = withDetail(world, { task: world.tasks.a, subtasks: [], comments: [{ id: 'c', taskId: 'a', body: 'x', author: 'owner', createdAt: at, updatedAt: at, deletedAt: null }], completions: [], events: [], previous: [], next: [], files: [file('f1'), file('f2'), file('f3', 'c')] });
  assert.equal(world.fileCounts.a, 3);
  world = mergeChanges(world, changes(5, { files: [file('f2')] }));
  assert.equal(world.fileCounts.a, 3);
  world = applyOps(world, [{ op: 'comment.delete', id: 'c' }], { now: at, today: '2026-10-14' });
  assert.equal(world.fileCounts.a, 2, 'a deleted comment’s file stops counting');
  // A comment the page writes shows as the owner's at once, before the server's answer says so too.
  world = applyOps(world, [{ op: 'comment.create', id: 'n', taskId: 'a', body: 'new' }], { now: at, today: '2026-10-14' });
  assert.equal(world.detail?.comments.find(comment => comment.id === 'n')?.author, 'owner');
});

test('an upload answer older than the overview is not counted again, and the overview is read to be sure', async () => {
  const transport = new FakeTransport();
  const at = '2026-10-14T00:00:00.000Z';
  const file = (id: string): TodoFile => ({ id, taskId: 'a', commentId: null, name: id, mimeType: 'text/plain', size: 1, sha256: 'x'.repeat(64), createdAt: at, deletedAt: null });
  transport.current = { ...transport.current, revision: 3, fileCounts: { a: 2 } };
  const { client } = await ready(transport);
  const reads = transport.reads.overview;
  client.receive(changes(2, { files: [file('f2')] }));
  assert.equal(client.getState().world.fileCounts.a, 2);
  await settle();
  assert.equal(transport.reads.overview, reads + 1);
});

test('a toast’s undo takes back its own change, even after another was made', async () => {
  const { client, transport } = await ready();
  client.apply([{ op: 'task.complete', id: 'a', completionId: 'done-1', occurrence: null, today: '2026-10-14' }]);
  const [undoA] = client.undoActions();
  client.apply([{ op: 'task.update', id: 'b', patch: { priority: 1 } }]);
  undoA.run();
  assert.equal(client.getState().world.tasks.a.completedAt, null);
  assert.equal(client.getState().world.tasks.b.priority, 1);
  assert.equal(client.getState().canUndo, true, 'the later change can still be undone');
  await settle();
  assert.deepEqual(transport.requests.flatMap(request => request.ops).map(op => op.op), ['task.complete', 'task.update', 'task.uncomplete']);
});

test('a detail read while a change is saved is read again, so an older answer never shows', async () => {
  const transport = new FakeTransport();
  let release!: () => void;
  const late = new Promise<void>(resolve => { release = resolve; });
  const detail = transport.detail.bind(transport);
  let first = true;
  transport.detail = async id => { const answer = await detail(id); if (first) { first = false; await late; } return answer; };
  transport.answer = async request => { transport.current.tasks = transport.current.tasks.map(item => item.id === 'a' ? { ...item, content: 'new' } : item); return changes(++transport.current.revision, { tasks: transport.current.tasks.filter(item => item.id === 'a') }); };
  const { client } = await ready(transport);
  client.openDetail('a');
  client.apply([{ op: 'task.update', id: 'a', patch: { content: 'new' } }]);
  await settle();
  release();
  await settle();
  assert.equal(client.getState().world.detail?.task.content, 'new');
  assert.equal(transport.reads.detail, 2);
});

test('the completed list is read again when a task in it changes', async () => {
  const transport = new FakeTransport();
  transport.completedPages.push(async () => ({ items: [{ completion: { id: 'c', taskId: 'b', occurrenceDate: null, completedAt: 'x' }, task: task('b', { content: 'B', completedAt: 'x' }) }] }));
  const { client } = await ready(transport);
  await client.readCompleted('');
  const before = transport.reads.completed;
  client.apply([{ op: 'task.update', id: 'b', patch: { content: 'renamed' } }]);
  await settle();
  assert.equal(transport.reads.completed, before + 1);
});

test('complete and add next is one call: complete, new labels, the task, then the link', () => {
  const draft = { content: 'Next', description: '', result: { projectId: 'inbox', labelIds: [], newLabels: ['new'], priority: 4 as const } };
  const before = task('a', { content: 'A' });
  const kinds = (ops: { op: string }[]) => ops.map(op => op.op);
  assert.deepEqual(kinds(quickAddOps(draft, { taskId: 'a', complete: true }, before, '2026-10-14').ops), ['task.complete', 'label.create', 'task.create', 'link.create']);
  assert.deepEqual(kinds(quickAddOps(draft, { taskId: 'a', complete: false }, before, '2026-10-14').ops), ['label.create', 'task.create', 'link.create']);
  assert.deepEqual(kinds(quickAddOps(draft, { taskId: 'a', complete: true }, { ...before, completedAt: 'x' }, '2026-10-14').ops), ['label.create', 'task.create', 'link.create']);
  const { ops, id } = quickAddOps(draft, { taskId: 'a', complete: true }, before, '2026-10-14');
  const created = ops.find(op => op.op === 'task.create') as { id: string; labelIds?: string[] };
  assert.equal(created.id, id);
  assert.deepEqual(created.labelIds, [(ops.find(op => op.op === 'label.create') as { id: string }).id]);
  assert.deepEqual(ops.at(-1), { op: 'link.create', id: (ops.at(-1) as { id: string }).id, fromTaskId: 'a', toTaskId: id });
});

test('an undo is used once: a toast pressed after ⌘Z took it back sends nothing', async () => {
  const { client, transport } = await ready();
  client.apply([{ op: 'task.delete', id: 'a' }]);
  const [toast] = client.undoActions();
  assert.equal(client.undo(), true);
  client.apply([{ op: 'task.delete', id: 'a' }]);
  toast.run();
  assert.ok(client.getState().world.tasks.a.deletedAt, 'the second delete stays');
  await settle();
  assert.deepEqual(transport.requests.flatMap(request => request.ops).map(op => op.op), ['task.delete', 'task.restore', 'task.delete']);
});

const agent = (taskId: string, patch: Partial<TodoAgent> = {}): TodoAgent => ({ taskId, provider: 'claude', state: 'active', sessionId: `claude:${taskId}`, createdAt: 'x', updatedAt: 'x', ...patch });

test('issue masters come with the overview and follow each answer; one closed or gone leaves', () => {
  let world = worldFromOverview(overview([task('a'), task('b')], { agents: { a: agent('a'), b: agent('b', { state: 'closing' }) } }));
  assert.deepEqual(Object.keys(world.agents), ['a', 'b']);
  world = mergeChanges(world, changes(2, { agents: { a: null, b: agent('b', { state: 'closed' }), c: agent('c', { state: 'starting', sessionId: undefined }) } }));
  assert.deepEqual(Object.keys(world.agents), ['c'], 'null and closed both take one away');
  assert.deepEqual(worldFromOverview(overview([])).agents, {}, 'an older server sends none');
});

test('starting an issue master shows the agent the server recorded and reads the overview again', async () => {
  const { client, transport } = await ready();
  // The server records it before it answers, so the overview read next has it too.
  transport.startAnswer = async taskId => { transport.current.agents = { [taskId]: agent(taskId) }; return { agent: agent(taskId) }; };
  const reads = transport.reads.overview;
  await client.startAgent('a', 'Look into it');
  assert.deepEqual(transport.started, [{ taskId: 'a', text: 'Look into it' }]);
  assert.equal(client.getState().world.agents.a?.sessionId, 'claude:a');
  await settle();
  assert.equal(transport.reads.overview, reads + 1);
});

test('a refused start throws and shows nothing', async () => {
  const { client, transport } = await ready();
  transport.startAnswer = async () => { throw new ApiError('already has one', 409); };
  await assert.rejects(client.startAgent('a', 'Again'), /already has one/);
  assert.deepEqual(client.getState().world.agents, {});
});

test("this page's completions show until a completed list read after the server took them comes, unless taken back or refused", async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  const completing = () => client.getState().completing.map(item => item.completion.id);
  const complete = (id: string, completionId: string) => client.apply([{ op: 'task.complete', id, completionId, occurrence: null, today: '2026-10-14' }]);
  await client.readCompleted('', false, undefined, { since: '2026-10-14T00:00:00.000Z', until: '2026-10-15T00:00:00.000Z' });

  // Shown at once, the task as completed; still there once answered, while the list is read again.
  let listed: () => void = () => {};
  transport.completedPages.push(() => new Promise(resolve => { listed = () => resolve({ items: [] }); }));
  complete('a', 'c1');
  assert.deepEqual(completing(), ['c1']);
  assert.ok(client.getState().completing[0].task.completedAt);
  await settle();
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(completing(), ['c1'], 'answered, the list not read since');
  listed();
  await settle();
  assert.deepEqual(completing(), [], 'the list read since has it (or it is gone elsewhere)');

  // Taken back before it is sent: shown as taken back at once, gone once answered.
  complete('b', 'c2');
  client.apply([{ op: 'task.uncomplete', id: 'b', completionId: 'c2' }]);
  assert.deepEqual(client.getState().undoing, ['c2']);
  await settle(40);
  assert.deepEqual([completing(), client.getState().undoing], [[], []]);

  // Refused by the server: gone with the change.
  transport.answer = async () => { throw new ApiError('nope', 400); };
  complete('a', 'c3');
  assert.deepEqual(completing(), ['c3']);
  await settle();
  assert.deepEqual(completing(), []);
});

test("with no completed list shown, this page's completions leave once the server has them", async () => {
  const { client } = await ready();
  client.apply([{ op: 'task.complete', id: 'a', completionId: 'c1', occurrence: null, today: '2026-10-14' }]);
  assert.equal(client.getState().completing.length, 1);
  await settle();
  assert.equal(client.getState().completing.length, 0);
});

test("a completion taken back shows again when the server refuses that, and a list read begun before the server took it keeps it", async () => {
  const transport = new FakeTransport();
  const { client } = await ready(transport);
  const range = { since: '2026-10-14T00:00:00.000Z', until: '2026-10-15T00:00:00.000Z' };
  const completing = () => client.getState().completing.map(item => item.completion.id);
  // A list read begun before the server has the completion answers without it: the completion stays. (An answer the
  // page has moved past reads the overview first, and the list only after it, so the earlier read is the latest one.)
  let early: () => void = () => {};
  transport.completedPages.push(() => new Promise(resolve => { early = () => resolve({ items: [] }); }));
  const reading = client.readCompleted('', false, undefined, range);
  let overviewRead: () => void = () => {};
  transport.overviewHold = new Promise(resolve => { overviewRead = resolve; });
  const answer = transport.answer;
  transport.answer = async () => changes(client.getState().world.revision);
  client.apply([{ op: 'task.complete', id: 'a', completionId: 'c1', occurrence: null, today: '2026-10-14' }]);
  await settle();
  early();
  await reading;
  assert.equal(client.getState().completed?.loading, false, 'that read is the one shown');
  assert.deepEqual(completing(), ['c1'], 'begun before the answer, it cannot have it');
  transport.overviewHold = undefined;
  overviewRead();
  await settle(40);
  assert.deepEqual(completing(), [], 'the read after it does');
  transport.answer = answer;

  // Its list read again fails, so only this page has it; taken back and refused, the completion shows again.
  transport.completedPages.push(() => Promise.reject(new Error('down')));
  client.apply([{ op: 'task.complete', id: 'b', completionId: 'c2', occurrence: null, today: '2026-10-14' }]);
  await settle();
  transport.answer = async () => { throw new ApiError('busy', 503); };
  client.apply([{ op: 'task.uncomplete', id: 'b', completionId: 'c2' }]);
  assert.deepEqual([completing(), client.getState().undoing], [['c2'], ['c2']]);
  await settle();
  assert.deepEqual([completing(), client.getState().undoing], [['c2'], []]);
});
