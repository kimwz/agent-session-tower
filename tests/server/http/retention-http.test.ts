import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer, type Backend } from '../../../server/http/server.js';
import type { Snapshot } from '../../../shared/types.js';

async function fixture(t: test.TestContext, retention?: Backend['retention']) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-retention-http-'));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(directory);
  const snapshot: Snapshot = { sessions: [], groups: [{ cwd: directory, title: 'fixture', pinned: false }], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: directory, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, retention, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const post = (action: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/retention/${action}`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...extra }, body: JSON.stringify(body) });
  return { directory, base, cookie, fetch, post };
}

test('retention reads stay read-only, mutations require the owner token, and agent access is refused', async t => {
  const calls: unknown[] = [];
  const f = await fixture(t, async (...args) => { calls.push(args); return { status: 'blocked-provider' }; });
  assert.equal((await f.fetch(`${f.base}/api/retention`)).status, 401);
  assert.equal((await f.fetch(`${f.base}/api/retention`, { headers: { cookie: f.cookie } })).status, 200);
  assert.deepEqual(calls, [['overview']]);
  assert.equal((await f.post('check', {})).status, 200);
  assert.equal((await f.post('check', { extra: true })).status, 400);
  assert.equal((await f.post('archive', { id: 'codex:child' }, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await f.post('archive', { id: 'codex:child' }, { 'X-Tower-Run-Capability': 'a'.repeat(64) })).status, 403);
  assert.equal((await f.post('archive', { id: 'codex:child' })).status, 200);
  assert.equal((await f.post('restore', { id: 'bundle', unexpected: true })).status, 400);
  assert.equal(calls.length, 3, 'rejected requests must not reach the worker');
  assert.equal((await f.fetch(`${f.base}/api/retention/bundles/bundle/files/file-0.gz`, { headers: { cookie: f.cookie } })).status, 200);
  assert.deepEqual(calls[3], ['read', 'bundle', 'file-0.gz']);
  assert.equal((await f.fetch(`${f.base}/api/retention/bundles/bundle/files/manifest.json`, { headers: { cookie: f.cookie } })).status, 400);
  assert.equal(calls.length, 4, 'invalid cold names never reach the worker');
});

test('cold directory export/import are confined to registered workspaces without traversal or symlinks', async t => {
  const calls: unknown[] = [];
  const f = await fixture(t, async (...args) => { calls.push(args); return { ok: true }; });
  await mkdir(join(f.directory, 'incoming'));
  await symlink('/tmp', join(f.directory, 'outside'));
  assert.equal((await f.post('export', { id: 'bundle', cwd: f.directory, path: '../escape' })).status, 400);
  assert.equal((await f.post('export', { id: 'bundle', cwd: f.directory, path: 'outside/export' })).status, 403);
  assert.equal((await f.post('import', { id: 'unused', cwd: '/unlisted', path: 'incoming' })).status, 403);
  assert.equal((await f.post('export', { id: 'bundle', cwd: f.directory, path: 'exported' })).status, 200);
  assert.equal((await f.post('import', { id: 'unused', cwd: f.directory, path: 'incoming' })).status, 200);
  const canonical = await realpath(f.directory);
  assert.deepEqual(calls, [['export', 'bundle', join(canonical, 'exported')], ['import', join(canonical, 'incoming'), undefined]]);
});

test('an unavailable retention backend is explicitly unavailable', async t => {
  const f = await fixture(t);
  assert.equal((await f.fetch(`${f.base}/api/retention`, { headers: { cookie: f.cookie } })).status, 503);
  assert.equal((await f.post('check', {})).status, 503);
});
