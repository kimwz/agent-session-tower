import { createRemoteAuthFixture } from '../../helpers/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { MAX_WORKSPACE_FILE_BYTES } from '../../../server/workspace-files.js';
import type { Snapshot } from '../../../shared/types.js';

test('remote editor authenticates file APIs and accepts escaped JSON for files near the text limit', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tower-editor-http-'));
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString(), groups: [{ cwd, title: '', pinned: true }] };
  const authDir = await mkdtemp(join(tmpdir(), 'tower-editor-auth-'));
  t.after(() => rm(authDir, { recursive: true, force: true }));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(authDir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: cwd, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (path: string, body: unknown, overrides: Record<string, string> = {}) => fetch(`${base}/api/workspace/${path}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  const read = (kind: string, path = '', authorized = true) => fetch(`${base}/api/workspace/${kind}?${new URLSearchParams({ cwd, path })}`, { headers: authorized ? { cookie } : {} });
  assert.equal((await read('tree', '', false)).status, 401);
  const valid = { cwd, path: 'large.txt', content: '\\'.repeat(MAX_WORKSPACE_FILE_BYTES - 100), revision: null };
  assert.equal((await send('file', valid, { cookie: '' })).status, 401);
  assert.equal((await send('file', valid, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await send('file', valid, { Origin: 'https://attacker.example' })).status, 403);
  const created = await send('file', valid); assert.equal(created.status, 200);
  const saved = await created.json(); assert.equal(saved.content, valid.content);
  assert.equal(await readFile(join(cwd, 'large.txt'), 'utf8'), valid.content);
  assert.equal((await read('file', 'large.txt', false)).status, 401);
  const opened = await read('file', 'large.txt'); assert.equal(opened.status, 200);
  assert.equal((await opened.json()).revision, saved.revision);
  assert.equal((await send('file', { ...valid, content: 'stale overwrite' })).status, 409);
  assert.equal((await send('file', { ...valid, content: 'updated', revision: saved.revision })).status, 200);
  assert.equal((await read('file', '../outside')).status, 400);
  assert.equal((await send('directory', { cwd, path: 'new-folder' })).status, 200);
  const tree = await (await read('tree')).json();
  assert.deepEqual(tree.entries.map((entry: { name: string }) => entry.name), ['new-folder', 'large.txt']);
});
