import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../../../server/http/server.js';
import { HEALTH_APPLICATION_ID, REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import type { WorkerStorageStatus } from '../../../shared/storage.js';

test('health answers 503 only for a worker storage 503 or a refused web runtime; recovery stays owner-only and the update routes are gone', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-storage-health-'));
  let status: WorkerStorageStatus = { state: 'unavailable', code: 'unsupported-runtime', reason: 'Unsupported SQLite runtime.', admissionOpen: false, sessionsAvailable: false, healthStatus: 503 };
  let webRefusal: { code: string; message: string } | undefined;
  let retries = 0;
  const recoveries: Array<{ action: string; input: Record<string, unknown> }> = [];
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, master: { callerSecret: 'fixture-master-secret', handle: async () => false },
    storageRefusal: async () => webRefusal,
    backend: {
      snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: async () => { throw new Error('No intake allowed.'); }, cancel: async () => {}, subscribe: () => () => {},
      storageRecovery: async (action, input) => { recoveries.push({ action, input }); return { forwarded: true }; },
      storageStatus: () => status, storageRetry: async () => { retries++; return status; },
    } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const health = async () => { const response = await fetch(`${base}/api/health`); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  const keys = ['application', 'bindHost', 'diagnostic', 'ok', 'pid', 'remoteAccess', 'service', 'storage', 'version'];

  const failed = await health();
  assert.equal(failed.status, 503);
  assert.deepEqual(Object.keys(failed.body).sort(), keys, 'no candidate storage or other update evaluation is reported');
  assert.equal(failed.body.application, HEALTH_APPLICATION_ID); assert.equal(failed.body.pid, process.pid); assert.equal(failed.body.ok, false); assert.equal(failed.body.diagnostic, true); assert.ok(failed.body.version);
  assert.equal((failed.body.storage as WorkerStorageStatus).code, status.code);
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 503, 'an unavailable index never looks like a successful empty snapshot');

  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const owner = { method: 'POST', headers: { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' };
  const notOwner = [{ ...owner.headers, 'x-tower-agent': 'local' }, { ...owner.headers, 'x-tower-master': 'fixture-master-secret' }, { ...owner.headers, [CALLER_CAPABILITY_HEADER]: 'a'.repeat(64) }, { 'content-type': 'application/json' }];
  for (const headers of notOwner) assert.equal((await fetch(`${base}/api/storage/retry`, { ...owner, headers })).status, 403);
  assert.equal(retries, 0);
  assert.equal((await fetch(`${base}/api/storage/retry`, owner)).status, 200); assert.equal(retries, 1);
  const receipt = { ...owner, body: JSON.stringify({ commandId: 'fixture-command' }) };
  for (const headers of notOwner) assert.equal((await fetch(`${base}/api/storage/runs-receipt`, { ...receipt, headers })).status, 403);
  assert.equal(recoveries.length, 0);
  const forwarded = await fetch(`${base}/api/storage/runs-receipt`, receipt);
  assert.equal(forwarded.status, 200);
  assert.deepEqual(recoveries, [{ action: 'runs-receipt', input: { commandId: 'fixture-command' } }], 'the owner route forwards the exact worker recovery request');
  assert.deepEqual(await (await fetch(`${base}/api/storage/status`)).json(), status);
  for (const removed of ['verify-update', 'rollback/status', 'rollback/run', 'rollback/release-pin']) {
    const response = await fetch(`${base}/api/storage/${removed}`, { ...owner, body: JSON.stringify({ kind: 'overwritten-done', by: 'owner', evidence: 'fixture', target: '1.0.0', reason: 'fixture' }) });
    assert.equal(response.status, 404, removed);
  }
  assert.equal(recoveries.length, 1, 'a removed route reaches no worker recovery');

  status = { ...status, state: 'recovery-required', code: 'storage-gate-held', reason: 'Held.', healthStatus: 200 };
  const held = await health();
  assert.equal(held.status, 200, 'a held storage keeps serving the owner its diagnosis');
  assert.equal(held.body.diagnostic, true);
  status = { state: 'ready', code: 'ready', reason: 'Storage is ready.', admissionOpen: true, sessionsAvailable: true, healthStatus: 200 };
  const ready = await health();
  assert.equal(ready.status, 200);
  assert.deepEqual(Object.keys(ready.body).sort(), keys);
  assert.equal(ready.body.ok, true); assert.equal(ready.body.diagnostic, false); assert.equal(ready.body.service, false); assert.equal(ready.body.remoteAccess, false);
  assert.deepEqual(ready.body.storage, status);

  webRefusal = { code: 'runtime-unsupported', message: 'This web cannot run its storage.' };
  const refused = await health();
  assert.equal(refused.status, 503, 'a web whose own storage runtime is refused is not healthy whatever its worker says');
  assert.equal(refused.body.ok, false); assert.equal(refused.body.diagnostic, true);
  assert.deepEqual(Object.keys(refused.body).sort(), keys);
});

test('health without a worker storage diagnosis is 200 with no storage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-storage-health-'));
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, storageRefusal: async () => undefined, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
    detail: async () => undefined, enqueue: async () => { throw new Error('No intake allowed.'); }, cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.ok, true); assert.equal(body.diagnostic, false); assert.equal('storage' in body, false);
});
