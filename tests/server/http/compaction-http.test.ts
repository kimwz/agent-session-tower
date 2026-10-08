import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer, type Backend } from '../../../server/http/server.js';
import type { Snapshot } from '../../../shared/types.js';
import { TowerError } from '../../../shared/errors.js';

async function fixture(t: test.TestContext, compaction?: Backend['compaction']) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-compaction-http-'));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(directory);
  const snapshot: Snapshot = { sessions: [], groups: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: directory, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, compaction, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...extra }, body: JSON.stringify(body) });
  return { base, cookie, fetch, post };
}

test('the owner starts, reads and cancels a compaction; agents and odd bodies are refused before the worker', async t => {
  const calls: unknown[][] = [];
  const f = await fixture(t, async (...args) => {
    calls.push(args);
    if (args[1] === 'claude:busy') throw new TowerError('conflict', '작업 중이거나 대기·예약된 요청이 있는 세션은 압축할 수 없습니다. 끝나거나 취소된 뒤 다시 시도하세요.');
    return args[0] === 'get' && args[1] === 'claude:none' ? null : { id: 'j', sessionId: args[1], state: args[0] === 'cancel' ? 'cancelled' : 'reading', createdAt: '', updatedAt: '' };
  });
  const started = await f.post('/api/sessions/claude:s/compaction', {});
  assert.equal(started.status, 202);
  assert.equal((await started.json()).compaction.state, 'reading');
  const read = await f.fetch(`${f.base}/api/sessions/claude:none/compaction`, { headers: { cookie: f.cookie } });
  assert.deepEqual(await read.json(), { compaction: null });
  assert.equal((await f.post('/api/sessions/claude:s/compaction/cancel', {})).status, 200);
  const busy = await f.post('/api/sessions/claude:busy/compaction', {});
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /작업 중/);
  assert.equal((await f.post('/api/sessions/claude:s/compaction', { model: 'x' })).status, 400);
  assert.equal((await f.post('/api/sessions/claude:s/compaction', {}, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await f.post('/api/sessions/claude:s/compaction', {}, { 'X-Tower-Run-Capability': 'a'.repeat(64) })).status, 403);
  assert.deepEqual(calls, [['start', 'claude:s'], ['get', 'claude:none'], ['cancel', 'claude:s'], ['start', 'claude:busy']]);
});

test('a Tower without compaction answers that it is unavailable', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/sessions/claude:s/compaction', {})).status, 503);
});
