import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdir, mkdtemp, open as openFile, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session, Snapshot } from '../../../shared/types.js';
import type { Backend } from '../../../server/http/server.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { WorkspaceTerminals, type WorkspacePty } from '../../../server/workspace-terminals.js';
import type { AttachmentStore, VerifiedAttachment } from '../../../server/stores/attachments.js';
import http2 from 'node:http2';

const CONTROLLER = 'controllera1b2c3d4e5f6';
const now = new Date().toISOString();
const requestIds = (() => { let next = 0; return () => `0199a2b3-c4d5-7123-8abc-${String(++next).padStart(12, '0')}`; })();

class Pty implements WorkspacePty {
  written: string[] = [];
  listeners = new Set<(data: string) => void>();
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() {}
  onData(listener: (data: string) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  onExit() { return { dispose: () => {} }; }
}

/** A computer sharing one folder, `open`, whose subfolder `open/secret` is excluded, with real files and fake shells. */
async function fixture(t: TestContext, options: { oldHost?: boolean; onSnapshot?: () => void; attachments?: (id: string) => Promise<VerifiedAttachment> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-remote-workspace-')));
  const open = join(root, 'open'), secret = join(open, 'secret');
  await mkdir(secret, { recursive: true });
  await mkdir(join(root, 'state'));
  await writeFile(join(open, 'readme.md'), 'hello');
  await writeFile(join(secret, 'keys.txt'), 'private');
  const exclusions = new RemoteExclusionStore(join(root, 'state'));
  await exclusions.start();
  await exclusions.add(secret);
  const session: Session = { id: 'codex:open', nativeId: 'open', provider: 'codex', title: 't', cwd: open, project: 'open', status: 'idle', statusReason: '',
    createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const snapshot = (): Snapshot => { options.onSnapshot?.(); return { sessions: [session], runs: [], providers: [], groups: [], scanning: false, hostname: 'machine-b', version: 'test', updatedAt: now }; };
  const ptys: Pty[] = [];
  const shells = new WorkspaceTerminals({ keepAliveOnDisconnect: true, spawnPty: () => { const pty = new Pty(); ptys.push(pty); return pty; } });
  const terminals = options.oldHost ? { ...shells, create: shells.create.bind(shells), attach: shells.attach.bind(shells), input: shells.input.bind(shells), resize: shells.resize.bind(shells), close: shells.close.bind(shells), dispose: shells.dispose.bind(shells), list: () => undefined } : shells;
  const backend: Backend = { snapshot, subscribe: () => () => {}, detail: async () => undefined, session: id => id === session.id ? session : undefined, coordinators: () => new Set(), cancel: async () => {},
    enqueue: async () => { throw new Error('unused'); } };
  const store = options.attachments && { openVerified: options.attachments } as unknown as AttachmentStore;
  const router = createRemoteRouter({ backend, exclusions, terminals, ...(store ? { attachmentStores: { chat: store, auto: store } } : {}) });
  const server = createServer((req, res) => { void router.handle(req, res, { controllerId: CONTROLLER }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { router.dispose(); shells.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const call = async (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, { method: init.body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const text = await response.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json };
  };
  const query = (path: string, values: Record<string, string>) => `${path}?${new URLSearchParams(values)}`;
  return { root, open, secret, exclusions, shells, ptys, base, call, query, router };
}

test('a controller browses and edits files in a shared folder, never inside an excluded one', async t => {
  const f = await fixture(t);
  const tree = await f.call(f.query('/api/workspace/tree', { cwd: f.open, path: '' }));
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.json.entries.map((entry: { name: string }) => entry.name), ['readme.md'], 'the excluded subfolder is not listed');
  assert.equal((await f.call(f.query('/api/workspace/tree', { cwd: f.open, path: 'secret' }))).status, 404);
  assert.equal((await f.call(f.query('/api/workspace/file', { cwd: f.open, path: 'secret/keys.txt' }))).status, 404);
  assert.equal((await f.call(f.query('/api/workspace/tree', { cwd: f.secret, path: '' }))).status, 404);
  assert.equal((await f.call(f.query('/api/workspace/tree', { cwd: f.root, path: '' }))).status, 404, 'only folders Tower shares can be opened');
  const read = await f.call(f.query('/api/workspace/file', { cwd: f.open, path: 'readme.md' }));
  assert.equal(read.json.content, 'hello');
  const save = { cwd: f.open, path: 'readme.md', content: 'hello again', revision: read.json.revision };
  assert.equal((await f.call('/api/workspace/file', { body: save })).status, 200);
  const repeated = await f.call('/api/workspace/file', { body: save });
  assert.equal(repeated.status, 200, 'a save sent again after its answer was lost succeeds without writing twice');
  assert.equal(repeated.json.revision, createHash('sha256').update('hello again').digest('hex'));
  assert.equal((await f.call('/api/workspace/file', { body: { ...save, content: 'something else' } })).status, 409);
  assert.equal((await f.call('/api/workspace/file', { body: { cwd: f.open, path: 'secret/new.txt', content: 'x', revision: null } })).status, 404);
  assert.equal(await readFile(join(f.secret, 'keys.txt'), 'utf8'), 'private');
  assert.equal((await f.call('/api/workspace/directory', { body: { cwd: f.open, path: 'docs' } })).status, 200);
  assert.equal((await f.call('/api/workspace/directory', { body: { cwd: f.open, path: 'docs' } })).status, 200, 'a folder made by a repeated request is already there');
  assert.equal((await f.call('/api/workspace/directory', { body: { cwd: f.open, path: 'secret/more' } })).status, 404);
});

test('no other way into an excluded folder: links, another spelling, parent steps or depth', async t => {
  const f = await fixture(t);
  await symlink(f.secret, join(f.open, 'shortcut'));
  const deep = join(f.open, 'a', 'b', 'hidden');
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'notes.txt'), 'private');
  await writeFile(join(f.open, 'a', 'b', 'visible.txt'), 'shared');
  await f.exclusions.add(deep);
  const names = async (path: string) => ((await f.call(f.query('/api/workspace/tree', { cwd: f.open, path }))).json.entries as Array<{ name: string }>).map(entry => entry.name);
  assert.deepEqual(await names(''), ['a', 'readme.md'], 'neither the excluded folder nor a link into it is listed');
  assert.deepEqual(await names('a/b'), ['visible.txt'], 'an excluded folder deep inside is left out too');
  for (const path of ['shortcut/keys.txt', 'SECRET/keys.txt', 'a/../secret/keys.txt', `${f.secret}/keys.txt`, 'a/b/hidden/notes.txt']) {
    const answer = await f.call(f.query('/api/workspace/file', { cwd: f.open, path }));
    assert.ok([400, 403, 404].includes(answer.status), `${path} answered ${answer.status}`);
    assert.notEqual(answer.json?.content, 'private');
  }
});

test('entries of excluded folders do not count toward the listing limit', async t => {
  const f = await fixture(t);
  const crowded = join(f.open, 'crowded');
  await mkdir(crowded);
  await Promise.all(Array.from({ length: 2000 }, (_, index) => writeFile(join(crowded, `file-${index}.txt`), '')));
  await mkdir(join(crowded, 'private'));
  await f.exclusions.add(join(crowded, 'private'));
  const listed = await f.call(f.query('/api/workspace/tree', { cwd: f.open, path: 'crowded' }));
  assert.equal(listed.status, 200);
  assert.equal(listed.json.entries.length, 2000);
});

test('shells in a shared folder are shared by every controller; excluded folders and unknown shells are not', async t => {
  const f = await fixture(t);
  const local = await f.shells.create(f.open, 80, 24);
  const other = await f.shells.create(f.open, 80, 24, { opener: 'controllerffffffffffff' });
  await f.shells.create(f.secret, 80, 24);
  const missing = await f.call('/api/workspace/terminals', { body: { cwd: f.open, cols: 80, rows: 24 } });
  assert.equal(missing.status, 400, 'opening a shell needs a request ID so a retry never opens two');
  const headers = { 'x-tower-request-id': requestIds() };
  const opened = await f.call('/api/workspace/terminals', { body: { cwd: f.open, cols: 80, rows: 24 }, headers });
  assert.equal(opened.status, 200);
  assert.equal((await f.call('/api/workspace/terminals', { body: { cwd: f.open, cols: 80, rows: 24 }, headers })).json.id, opened.json.id);
  assert.equal((await f.call('/api/workspace/terminals', { body: { cwd: f.secret, cols: 80, rows: 24 }, headers: { 'x-tower-request-id': requestIds() } })).status, 404);
  const listed = await f.call(f.query('/api/workspace/terminals', { cwd: f.open }));
  assert.deepEqual(listed.json.terminals.map((item: { id: string; origin: string; openedBy?: string }) => [item.id, item.origin, item.openedBy]).sort(),
    [[local.id, 'computer', undefined], [opened.json.id, 'self', undefined], [other.id, 'controller', undefined]].sort(), 'another controller is not named');
  assert.equal((await f.call(`/api/workspace/terminals/${local.id}/input`, { body: { data: 'ls\r' } })).status, 200, 'a shell opened on that computer can be joined');
  assert.deepEqual(f.ptys[0].written, ['ls\r']);
  assert.equal((await f.call(`/api/workspace/terminals/${f.shells.list().find(item => item.cwd === f.secret)!.id}/input`, { body: { data: 'cat keys.txt\r' } })).status, 404);
  assert.equal((await f.call('/api/workspace/terminals/00000000-0000-4000-8000-000000000000/input', { body: { data: 'x' } })).status, 404);
  assert.equal((await f.call(`/api/workspace/terminals/${other.id}/resize`, { body: { cols: 100, rows: 30 } })).status, 200);
  assert.equal((await f.call(`/api/workspace/terminals/${opened.json.id}/close`, { body: {} })).status, 200);
  assert.equal(f.shells.list().some(item => item.id === opened.json.id), false);
});

test('a controller’s view of a shell ends when its folder stops being shared; the shell itself goes on', async t => {
  const f = await fixture(t);
  const { id } = await f.shells.create(f.open, 80, 24);
  const frames: string[] = [];
  const ended = new Promise<void>(resolve => get(`${f.base}/api/workspace/terminals/${id}/events`, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => frames.push(chunk));
    res.on('end', () => resolve());
  }));
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const listener of f.ptys[0].listeners) listener('prompt$ ');
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.exclusions.add(f.open);
  await ended;
  assert.match(frames.join(''), /prompt\$/);
  assert.equal(f.shells.list().find(item => item.id === id)?.exited, false);
  assert.equal((await f.call(`/api/workspace/terminals/${id}/events`)).status, 404);
});

test('a terminal host too old to list its shells opens none for a controller', async t => {
  const f = await fixture(t, { oldHost: true });
  const refused = await f.call('/api/workspace/terminals', { body: { cwd: f.open, cols: 80, rows: 24 }, headers: { 'x-tower-request-id': requestIds() } });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.disposition, 'not-admitted');
  assert.equal(f.ptys.length, 0);
});

test('a controller plays media in a shared folder by byte range, never from an excluded one', async t => {
  const f = await fixture(t);
  await writeFile(join(f.open, 'clip.webm'), '0123456789');
  await writeFile(join(f.secret, 'private.mp3'), 'private');
  const play = (path: string, range?: string) => fetch(`${f.base}${f.query('/api/workspace/media', { cwd: f.open, path })}`, range ? { headers: { range } } : {});
  const part = await play('clip.webm', 'bytes=3-6');
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'video/webm');
  assert.equal(part.headers.get('content-range'), 'bytes 3-6/10');
  assert.equal(await part.text(), '3456');
  for (const path of ['secret/private.mp3', 'SECRET/private.mp3', `${f.secret}/private.mp3`]) {
    const answer = await play(path);
    assert.ok([400, 403, 404].includes(answer.status), `${path} answered ${answer.status}`);
    assert.notEqual(await answer.text(), 'private');
  }
  assert.equal((await fetch(`${f.base}${f.query('/api/workspace/media', { cwd: f.secret, path: 'private.mp3' })}`)).status, 404);
});

test('media being played stops when its folder stops being shared', async t => {
  const f = await fixture(t);
  await mkdir(join(f.open, 'clips'));
  await writeFile(join(f.open, 'clips', 'long.mp4'), Buffer.alloc(32 * 1024 * 1024));
  let received = 0;
  const ended = new Promise<string>(resolve => get(`${f.base}${f.query('/api/workspace/media', { cwd: f.open, path: 'clips/long.mp4' })}`, res => {
    assert.equal(res.statusCode, 200);
    // Read nothing at first, like a paused player, so the answer is still open when the list changes.
    res.pause();
    res.on('data', chunk => { received += chunk.length; });
    res.on('aborted', () => resolve('aborted'));
    res.on('error', () => resolve('error'));
    res.on('end', () => resolve('end'));
    setTimeout(() => { void f.exclusions.add(join(f.open, 'clips')).then(() => res.resume()); }, 50);
  }));
  assert.notEqual(await ended, 'end');
  assert.ok(received < 32 * 1024 * 1024, 'the file was not sent whole');
  assert.equal((await fetch(`${f.base}${f.query('/api/workspace/media', { cwd: f.open, path: 'clips/long.mp4' })}`)).status, 404);
});

test('a controller disconnected while media opens is sent none of it', async t => {
  // The folder list is read several times while a media request is checked and opened; a disconnect at any of those
  // reads, after the request reached the route, must end the answer.
  for (const at of [2, 3, 4]) {
    let reads = -1;
    let router: ReturnType<typeof createRemoteRouter> | undefined;
    const f = await fixture(t, { onSnapshot: () => { if (reads >= 0 && ++reads === at) router!.disconnect(CONTROLLER); } });
    router = f.router;
    await writeFile(join(f.open, 'clip.mp4'), Buffer.alloc(1024 * 1024, 1));
    reads = 0;
    let received = 0;
    await fetch(`${f.base}${f.query('/api/workspace/media', { cwd: f.open, path: 'clip.mp4' })}`).then(async response => {
      const reader = response.body!.getReader();
      for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.length; }
    }).catch(() => {});
    assert.equal(received, 0, `a disconnect at folder-list read ${at} still sent ${received} bytes`);
  }
});

test('an earlier answer ending late does not untrack a newer one', async t => {
  const f = await fixture(t);
  await mkdir(join(f.open, 'old')); await mkdir(join(f.open, 'new'));
  await writeFile(join(f.open, 'old', 'a.mp4'), Buffer.alloc(32 * 1024 * 1024));
  await writeFile(join(f.open, 'new', 'b.mp4'), Buffer.alloc(32 * 1024 * 1024));
  // The first answer's file is slow to stop reading, so its cleanup runs after the second answer is tracked.
  const probe = await openFile(join(f.open, 'old', 'a.mp4'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  const createReadStream = prototype.createReadStream;
  await probe.close();
  let slow = false;
  t.mock.method(prototype, 'createReadStream', function (this: typeof probe, ...args: unknown[]) {
    const stream = createReadStream.apply(this, args);
    if (slow) {
      slow = false;
      const destroy = stream._destroy.bind(stream);
      stream._destroy = (error: Error | null, done: (error?: Error | null) => void) => { setTimeout(() => destroy(error, done), 300); };
    }
    return stream;
  });
  // Paused like a player with a full buffer; a paused reader only learns how the answer ended once it reads again.
  const play = (path: string) => new Promise<{ finish: () => Promise<string> }>(resolve => get(`${f.base}${f.query('/api/workspace/media', { cwd: f.open, path })}`, res => {
    res.pause();
    res.on('error', () => {});
    const ended = new Promise<string>(done => res.on('close', () => done(res.complete ? 'whole' : 'cut off')));
    resolve({ finish: () => { res.resume(); return ended; } });
  }));
  slow = true;
  const first = await play('old/a.mp4');
  await f.exclusions.add(join(f.open, 'old'));
  const second = await play('new/b.mp4');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await first.finish(), 'cut off');
  await f.exclusions.add(join(f.open, 'new'));
  assert.equal(await second.finish(), 'cut off', 'the newer answer was still tracked');
});

test('over the link’s HTTP/2, media whose answer ended while it opened is not sent and its request settles', async t => {
  for (const at of [2, 3, 4]) {
    let reads = -1;
    let router: ReturnType<typeof createRemoteRouter> | undefined;
    const f = await fixture(t, { onSnapshot: () => { if (reads >= 0 && ++reads === at) router!.disconnect(CONTROLLER); } });
    router = f.router;
    await writeFile(join(f.open, 'clip.mp4'), Buffer.alloc(1024 * 1024, 1));
    const handled: Promise<void>[] = [];
    const link = http2.createServer((req, res) => { handled.push(f.router.handle(req, res, { controllerId: CONTROLLER })); });
    await new Promise<void>(resolve => link.listen(0, '127.0.0.1', resolve));
    const session = http2.connect(`http://127.0.0.1:${(link.address() as { port: number }).port}`);
    t.after(async () => { session.destroy(); await new Promise(resolve => link.close(resolve)); });
    reads = 0;
    const received = await new Promise<number>(resolve => {
      let bytes = 0;
      const stream = session.request({ ':path': f.query('/api/workspace/media', { cwd: f.open, path: 'clip.mp4' }) });
      stream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      stream.on('error', () => {});
      stream.on('close', () => resolve(bytes));
    });
    assert.equal(received, 0, `a disconnect at folder-list read ${at} still sent ${received} bytes`);
    const settled = await Promise.race([Promise.allSettled(handled).then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('hanging'), 2000))]);
    assert.equal(settled, 'settled', `the request ended at folder-list read ${at} never finished, so its file stays open`);
  }
});

test('an attachment download ending late does not untrack media played after it', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-remote-attachment-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, 'original.bin');
  await writeFile(original, Buffer.alloc(32 * 1024 * 1024));
  const f = await fixture(t, { attachments: async id => ({ metadata: { id, name: 'original.bin', mimeType: 'application/octet-stream', size: 32 * 1024 * 1024 }, path: original, file: await openFile(original, 'r'), sessionId: 'codex:open' }) });
  await mkdir(join(f.open, 'other')); await mkdir(join(f.open, 'new'));
  await writeFile(join(f.open, 'new', 'b.mp4'), Buffer.alloc(32 * 1024 * 1024));
  // The download is slow to stop reading, so its cleanup runs after the media answer is tracked.
  const probe = await openFile(original, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const createReadStream = prototype.createReadStream;
  await probe.close();
  let slow = false;
  t.mock.method(prototype, 'createReadStream', function (this: typeof probe, ...args: unknown[]) {
    const stream = createReadStream.apply(this, args);
    if (slow) {
      slow = false;
      const destroy = stream._destroy.bind(stream);
      stream._destroy = (error: Error | null, done: (error?: Error | null) => void) => { setTimeout(() => destroy(error, done), 300); };
    }
    return stream;
  });
  const fetchPaused = (path: string) => new Promise<{ status?: number; finish: () => Promise<string> }>(resolve => get(`${f.base}${path}`, res => {
    res.pause();
    res.on('error', () => {});
    const ended = new Promise<string>(done => res.on('close', () => done(res.complete ? 'whole' : 'cut off')));
    resolve({ status: res.statusCode, finish: () => { res.resume(); return ended; } });
  }));
  slow = true;
  const download = await fetchPaused('/api/attachments/11111111-1111-4111-8111-111111111111');
  assert.equal(download.status, 200);
  await f.exclusions.add(join(f.open, 'other'));
  const media = await fetchPaused(f.query('/api/workspace/media', { cwd: f.open, path: 'new/b.mp4' }));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await download.finish(), 'cut off');
  await f.exclusions.add(join(f.open, 'new'));
  assert.equal(await media.finish(), 'cut off', 'the media answer was still tracked');
});
