import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { remoteSnapshot } from '../../../server/remote/visibility.js';
import { TodoStore } from '../../../server/todo/store.js';
import { TodoFiles } from '../../../server/todo/files.js';
import type { Snapshot } from '../../../shared/types.js';
import type { TodoFile, TodoOverview } from '../../../shared/todo/types.js';

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

  // The completed list of one label, and search with completed tasks.
  assert.equal((await send({ requestId: randomUUID(), ops: [{ op: 'label.create', id: 'call', name: 'call' }, { op: 'task.create', id: 'b', content: 'Task b', labelIds: ['call'] },
    { op: 'task.complete', id: 'b', completionId: 'cb', occurrence: null, today: '2026-10-17' }, { op: 'task.complete', id: 'a', completionId: 'ca', occurrence: null, today: '2026-10-17' }] })).status, 200);
  const done = async (query: string) => (await (await fetch(`${base}/api/todos/completed?${query}`)).json() as { items: { task: { id: string } }[] }).items.map(item => item.task.id).sort();
  assert.deepEqual(await done('labelId=call'), ['b']);
  assert.deepEqual(await done(''), ['a', 'b']);
  assert.equal((await fetch(`${base}/api/todos/completed?labelId=${encodeURIComponent('a b')}`)).status, 400);
  const found = (await (await fetch(`${base}/api/todos/search?q=task&completed=1`)).json() as { tasks: { id: string; completedAt: string | null }[] }).tasks;
  assert.deepEqual(found.map(task => [task.id, typeof task.completedAt]).sort(), [['a', 'string'], ['b', 'string']]);

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

/** The smallest bytes that read as a PNG. */
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(16, 1)]);

test('attachments upload in pieces apart from the change budget, and come back as downloads that never run as a page', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-files-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  const store = new TodoStore(dir);
  store.start();
  const files = new TodoFiles(dir, store);
  await files.start();
  const snapshot = (): Snapshot => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: store.revision() });
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
    todos: {
      overview: () => store.overview(), detail: id => store.detail(id), completed: input => store.completed(input), search: (query, input) => store.search(query, input),
      apply: request => store.apply(request), files,
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const post = (path: string, body: unknown, extra: Record<string, string> = headers) => fetch(`${base}${path}`, { method: 'POST', headers: extra, body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) });
  store.apply({ requestId: randomUUID(), ops: [{ op: 'task.create', id: 't', content: 'With files' }] });
  const upload = async (content: Buffer, name: string, mimeType: string) => {
    const started = await post('/api/todos/uploads', { taskId: 't', name, mimeType, size: content.length });
    assert.equal(started.status, 201);
    const { id } = await started.json() as { id: string };
    assert.equal((await post(`/api/todos/uploads/${id}?offset=0`, content, { ...headers, 'Content-Type': 'application/octet-stream' })).status, 200);
    return (await (await post(`/api/todos/uploads/${id}/complete`, {})).json() as { file: TodoFile }).file;
  };

  assert.equal((await post('/api/todos/uploads', { taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: 1 }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('/api/todos/uploads', { taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: 1, path: '/etc' })).status, 400);
  assert.equal((await post('/api/todos/uploads', { taskId: 'gone', name: 'a.txt', mimeType: 'text/plain', size: 1 })).status, 404);
  assert.equal((await post('/api/todos/uploads', { taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: 100 * 1024 * 1024 + 1 })).status, 413);
  // Many more pieces than the page's 30 changes a minute.
  const content = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEF');
  const { id } = await (await post('/api/todos/uploads', { taskId: 't', name: '메모 (1).txt', mimeType: 'text/plain', size: content.length })).json() as { id: string };
  const piece = (offset: number, bytes: Buffer, type = 'application/octet-stream') => post(`/api/todos/uploads/${id}?offset=${offset}`, bytes, { ...headers, 'Content-Type': type });
  assert.equal((await piece(0, content.subarray(0, 1), 'application/json')).status, 415);
  for (let offset = 0; offset < content.length; offset++) assert.equal((await piece(offset, content.subarray(offset, offset + 1))).status, 200, `piece ${offset}`);
  const wrong = await piece(3, Buffer.from('x'));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json() as { offset: number }).offset, content.length);
  assert.deepEqual(await (await fetch(`${base}/api/todos/uploads/${id}`)).json(), { offset: content.length });
  assert.equal((await post(`/api/todos/uploads/${id}/complete`, '', { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  const completed = await post(`/api/todos/uploads/${id}/complete`, {});
  assert.equal(completed.status, 200);
  const { file, changes } = await completed.json() as { file: TodoFile; changes: { revision: number; files: TodoFile[] } };
  assert.equal(changes.revision, store.revision());
  assert.deepEqual(changes.files, [file]);
  assert.notEqual((await post('/api/groups', { cwd: '/tmp/x', title: 'X' })).status, 429, 'the pieces left the change budget alone');

  const download = await fetch(`${base}/api/todos/files/${file.id}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent('메모 (1).txt').replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('cache-control') ?? '', /^private\b/);
  assert.match(download.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(download.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  const part = await fetch(`${base}/api/todos/files/${file.id}`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 2-5/${content.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '2345');
  assert.equal((await fetch(`${base}/api/todos/files/${file.id}`, { headers: { Range: 'bytes=999-' } })).status, 416);
  const head = await fetch(`${base}/api/todos/files/${file.id}`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(content.length));
  // Asked inline: only real image bytes are shown as an image.
  const notImage = await fetch(`${base}/api/todos/files/${file.id}?inline=1`);
  assert.match(notImage.headers.get('content-disposition') ?? '', /^attachment;/);
  await notImage.arrayBuffer();
  const disguised = await upload(Buffer.from('<svg onload="alert(1)"></svg> and more bytes'), 'shot.png', 'image/png');
  const refused = await fetch(`${base}/api/todos/files/${disguised.id}?inline=1`);
  assert.equal(refused.headers.get('content-type'), 'application/octet-stream');
  assert.match(refused.headers.get('content-disposition') ?? '', /^attachment;/);
  await refused.arrayBuffer();
  const png = await upload(PNG, 'real.png', 'image/png');
  const shown = await fetch(`${base}/api/todos/files/${png.id}?inline=1`);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  assert.match(shown.headers.get('content-disposition') ?? '', /^inline;/);
  assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
  await shown.arrayBuffer();
  // A recording plays in the page, from any point.
  const recording = Buffer.from('\0\0\0\x18ftypmp42 a short recording');
  const video = await upload(recording, 'after.mp4', 'video/mp4');
  const played = await fetch(`${base}/api/todos/files/${video.id}?inline=1`, { headers: { Range: 'bytes=4-7' } });
  assert.equal(played.status, 206);
  assert.equal(played.headers.get('content-type'), 'video/mp4');
  assert.match(played.headers.get('content-disposition') ?? '', /^inline;/);
  assert.equal(played.headers.get('x-content-type-options'), 'nosniff');
  assert.match(played.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(Buffer.from(await played.arrayBuffer()).toString(), 'ftyp');

  store.apply({ requestId: randomUUID(), ops: [{ op: 'file.delete', id: file.id }] });
  assert.equal((await fetch(`${base}/api/todos/files/${file.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/todos/files/${encodeURIComponent('../x')}`)).status, 404);
  const cancelled = await (await post('/api/todos/uploads', { taskId: 't', name: 'a.txt', mimeType: 'text/plain', size: 1 })).json() as { id: string };
  assert.equal((await post(`/api/todos/uploads/${cancelled.id}/cancel`, {})).status, 200);
  assert.equal((await fetch(`${base}/api/todos/uploads/${cancelled.id}`)).status, 404);
});

test('a controlling computer has no route to the todos', async () => {
  const router = await readFile(new URL('../../../server/remote/router.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /todo/i);
});
