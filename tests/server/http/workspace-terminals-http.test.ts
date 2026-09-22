import { createRemoteAuthFixture } from '../../helpers/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { WorkspaceTerminals, type WorkspacePty } from '../../../server/workspace-terminals.js';
import type { Snapshot } from '../../../shared/types.js';

test('remote terminal HTTP authenticates streams and mutations while allowing interactive input beyond 30 requests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-terminal-http-'));
  const cwd = join(dir, 'space \' " $(never) project'); await mkdir(cwd);
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString(), groups: [{ cwd, title: '', pinned: true }] };
  let killed = 0; let spawns = 0; const inputs: string[] = [];
  let output!: (data: string) => void;
  const pty: WorkspacePty = { write: data => { inputs.push(data); }, resize: () => {}, kill: () => { killed++; },
    onData: listener => { output = listener; return { dispose() {} }; }, onExit: () => ({ dispose() {} }),
  };
  const workspaceTerminals = new WorkspaceTerminals({ spawnPty: (_shell, _args, options) => { spawns++; assert.ok(options.cwd.endsWith('space \' " $(never) project')); return pty; } });
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, workspaceTerminals,
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (path: string, body: unknown, overrides: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  const endpoint = '/api/workspace/terminals'; const valid = { cwd, cols: 80, rows: 24 };
  assert.equal((await send(endpoint, valid, { cookie: '' })).status, 401);
  assert.equal((await send(endpoint, valid, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await send(endpoint, valid, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send(endpoint, valid, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send(endpoint, { ...valid, cwd: dir })).status, 403);
  assert.equal((await send(endpoint, { ...valid, command: 'injected' })).status, 400);
  assert.equal((await send(endpoint, { ...valid, cols: 0 })).status, 400);
  assert.equal(spawns, 0);
  const created = await send(endpoint, valid); assert.equal(created.status, 200);
  const { id } = await created.json(); assert.equal(spawns, 1);
  const terminal = `${endpoint}/${id}`;
  assert.equal((await fetch(`${base}${terminal}/events`)).status, 401);
  assert.equal((await fetch(`${base}${terminal}/events`, { headers: { cookie, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await send(`${terminal}/input`, { data: 'bad' }, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await send(`${terminal}/input`, { data: 'bad', command: 'x' })).status, 400);
  assert.deepEqual(inputs, []);
  output('ready\r\n');
  const abort = new AbortController();
  const events = await fetch(`${base}${terminal}/events`, { headers: { cookie }, signal: abort.signal });
  assert.equal(events.status, 200); assert.match(events.headers.get('content-type')!, /text\/event-stream/);
  const reader = events.body!.getReader();
  let received = '';
  while (!received.includes('ready')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += new TextDecoder().decode(chunk.value);
  }
  assert.match(received, /ready\\r\\n/);
  for (let i = 0; i < 40; i++) assert.equal((await send(`${terminal}/input`, { data: 'x' })).status, 200);
  assert.equal(inputs.length, 40);
  assert.equal((await send(`${terminal}/resize`, { cols: 100, rows: 40 })).status, 200);
  assert.equal((await send(`${terminal}/resize`, { cols: 100, rows: 0 })).status, 400);
  abort.abort();
  assert.equal((await send(`${terminal}/close`, {})).status, 200); assert.equal(killed, 1);
  assert.equal((await send(`${terminal}/input`, { data: 'x' })).status, 404);
});

test('credential changes end an open remote terminal stream and reject its old session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-terminal-revoke-'));
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString(), groups: [{ cwd: dir, title: '', pinned: true }] };
  const inputs: string[] = [];
  let output!: (data: string) => void;
  const pty: WorkspacePty = {
    write: data => { inputs.push(data); }, resize() {}, kill() {},
    onData: listener => { output = listener; return { dispose() {} }; }, onExit: () => ({ dispose() {} }),
  };
  const workspaceTerminals = new WorkspaceTerminals({ spawnPty: () => pty });
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, workspaceTerminals,
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); auth.close(); await auth.flush(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const created = await fetch(`${base}/api/workspace/terminals`, { method: 'POST', headers, body: JSON.stringify({ cwd: dir, cols: 80, rows: 24 }) });
  assert.equal(created.status, 200);
  const { id } = await created.json();
  const terminal = `${base}/api/workspace/terminals/${id}`;
  output('before-revocation');
  const events = await fetch(`${terminal}/events`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(events.status, 200);
  const reader = events.body!.getReader();
  let received = '';
  while (!received.includes('before-revocation')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += new TextDecoder().decode(chunk.value);
  }
  await auth.setCredentials('monitor', 'replacement-fixture-password');
  output('secret-after-revocation');
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += new TextDecoder().decode(chunk.value);
  }
  assert.doesNotMatch(received, /secret-after-revocation/);
  assert.equal((await fetch(`${terminal}/events`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${terminal}/input`, { method: 'POST', headers, body: JSON.stringify({ data: 'must-not-run' }) })).status, 401);
  assert.deepEqual(inputs, []);
});
