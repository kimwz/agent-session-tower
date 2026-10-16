import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { remoteSnapshot } from '../../../server/remote/visibility.js';
import { TodoStore } from '../../../server/todo/store.js';
import type { Snapshot } from '../../../shared/types.js';
import type { TodoOverview } from '../../../shared/todo/types.js';

test('the todo routes take the page token and JSON, check every change, and have their own change budget', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  const store = new TodoStore(dir);
  store.start();
  let changes = 0;
  const snapshot = (): Snapshot => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: store.revision() });
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
    todos: {
      overview: () => store.overview(), detail: id => store.detail(id), completed: input => store.completed(input), search: (query, input) => store.search(query, input),
      apply: request => { changes++; return store.apply(request); },
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (body: unknown, extra: Record<string, string> = headers) => fetch(`${base}/api/todos/ops`, { method: 'POST', headers: extra, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const create = (id: string) => send({ requestId: randomUUID(), ops: [{ op: 'task.create', id, content: `Task ${id}` }] });

  const empty = await (await fetch(`${base}/api/todos`)).json() as TodoOverview;
  assert.equal(empty.availability.state, 'ready');
  assert.equal(empty.revision, 0);

  assert.equal((await send({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A' }] }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send('{}', { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  for (const body of [{}, { requestId: 'nope', ops: [{ op: 'task.create', id: 'a', content: 'A' }] }, { requestId: randomUUID(), ops: [] },
    { requestId: randomUUID(), ops: [{ op: 'task.drop', id: 'a' }] }, { requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A', extra: true }] },
    { requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a/b', content: 'A' }] }, { requestId: randomUUID(), ops: [{ op: 'task.create', id: 'a', content: 'A', dueDate: '2026-02-30' }] }]) {
    assert.equal((await send(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(changes, 0);

  const created = await create('a');
  assert.equal(created.status, 200);
  assert.equal((await created.json() as { revision: number }).revision, 1);
  assert.equal(snapshot().todoRevision, 1);
  // Reusing an id is the page's mistake, answered as such.
  assert.equal((await create('a')).status, 400);
  assert.equal((await fetch(`${base}/api/todos/tasks/a`)).status, 200);
  assert.equal((await fetch(`${base}/api/todos/tasks/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/todos/tasks/${encodeURIComponent('a b')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/todos/search?q=`)).status, 400);
  assert.deepEqual((await (await fetch(`${base}/api/todos/search?q=task`)).json() as { tasks: { id: string }[] }).tasks.map(task => task.id), ['a']);
  assert.equal((await fetch(`${base}/api/todos/completed?before=yesterday`)).status, 400);
  assert.equal((await fetch(`${base}/api/todos/elsewhere`)).status, 404);

  // Far more changes than the page's general budget of 30 a minute, and the general budget is still untouched.
  for (let index = 0; index < 60; index++) assert.equal((await create(`bulk-${index}`)).status, 200);
  const other = await fetch(`${base}/api/groups`, { method: 'POST', headers, body: JSON.stringify({ cwd: '/tmp/x', title: 'X' }) });
  assert.notEqual(other.status, 429);
});

test('a controlling computer never sees the todo revision', () => {
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: 7 };
  const view = remoteSnapshot(snapshot, { matcher: { revision: 1, excludes: () => false }, coordinators: new Set() });
  assert.equal('todoRevision' in view, false);
});
