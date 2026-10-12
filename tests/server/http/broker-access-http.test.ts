import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { ownerSecretControl } from '../../../server/link/secret-routes.js';

test('broker approval needs a real owner login and preserves HTTP boundaries on loopback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-broker-http-'));
  const { auth, cookie } = await createRemoteAuthFixture(dir);
  const calls: unknown[] = [];
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' }),
    detail: async () => undefined, enqueue: async () => { throw new Error('Native execution forbidden'); }, cancel: async () => {}, subscribe: () => () => {},
    secrets: async (action, input) => { calls.push([action, input]); return { eligible: true }; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); auth.close(); await auth.flush(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const input = { sessionId: 'codex:fixture', root: '/fixture', taskId: null, taskLabel: 'Deploy', ttlMs: 1000 };
  const post = (action: string, extra: Record<string, string> = {}) => fetch(`${base}/api/secrets/${action}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
  assert.equal((await post('approve-broker')).status, 401, 'loopback automatic authentication is insufficient');
  assert.equal((await post('revoke-broker')).status, 401);
  for (const extra of [{ 'X-Tower-Agent': 'local' }, { 'X-Tower-Master': 'fixture' }, { [CALLER_CAPABILITY_HEADER]: 'fixture' }] as Record<string, string>[]) {
    assert.equal((await post('approve-broker', { cookie, ...extra })).status, 403);
    assert.equal((await fetch(`${base}/api/secrets/broker-access?sessionId=codex:fixture`, { headers: extra })).status, 403);
  }
  assert.equal((await post('approve-broker', { cookie, 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await post('approve-broker', { cookie, Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('approve-broker', { cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('approve-broker', { cookie, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(calls.length, 0);
  assert.equal((await post('approve-broker', { cookie })).status, 200);
  assert.deepEqual(calls[0], ['approve-broker', input]);
  assert.equal((await post('revoke-broker', { cookie })).status, 200);
  assert.equal((await fetch(`${base}/api/secrets/broker-access?sessionId=codex:fixture`)).status, 200);
  assert.deepEqual(calls.at(-1), ['broker-access', { sessionId: 'codex:fixture' }]);
});

test('broker control preserves expected task identity and rejects remote routing', async () => {
  const calls: unknown[] = [];
  const worker = { secretCall: async (operation: string, args?: unknown[]) => { calls.push([operation, args]); return {}; } };
  const input = { sessionId: 'codex:fixture', root: '/fixture', taskId: null, taskLabel: 'Deploy', ttlMs: 1000 };
  await ownerSecretControl(undefined, worker, 'approve-broker', input);
  assert.deepEqual(calls, [['control', ['approve-broker', input]]]);
  await assert.rejects(ownerSecretControl(undefined, worker, 'approve-broker', { ...input, nodeId: 'remote' }), /이 컴퓨터/);
  assert.equal(calls.length, 1);
});
