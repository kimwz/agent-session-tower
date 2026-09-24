import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session, Snapshot } from '../../../shared/types.js';
import type { Backend } from '../../../server/http/server.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { WorkspaceTerminals, type WorkspacePty } from '../../../server/workspace-terminals.js';

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
async function fixture(t: TestContext, options: { oldHost?: boolean } = {}) {
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
  const snapshot = (): Snapshot => ({ sessions: [session], runs: [], providers: [], groups: [], scanning: false, hostname: 'machine-b', version: 'test', updatedAt: now });
  const ptys: Pty[] = [];
  const shells = new WorkspaceTerminals({ keepAliveOnDisconnect: true, spawnPty: () => { const pty = new Pty(); ptys.push(pty); return pty; } });
  const terminals = options.oldHost ? { ...shells, create: shells.create.bind(shells), attach: shells.attach.bind(shells), input: shells.input.bind(shells), resize: shells.resize.bind(shells), close: shells.close.bind(shells), dispose: shells.dispose.bind(shells), list: () => undefined } : shells;
  const backend: Backend = { snapshot, subscribe: () => () => {}, detail: async () => undefined, session: id => id === session.id ? session : undefined, coordinators: () => new Set(), cancel: async () => {},
    enqueue: async () => { throw new Error('unused'); } };
  const router = createRemoteRouter({ backend, exclusions, terminals });
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
  return { root, open, secret, exclusions, shells, ptys, base, call, query };
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
  assert.deepEqual(listed.json.terminals.map((item: { id: string; openedBy?: string }) => [item.id, item.openedBy]).sort(), [[local.id, 'local'], [opened.json.id, undefined], [other.id, 'other']].sort());
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
