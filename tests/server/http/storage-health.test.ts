import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../../../server/http/server.js';
import { HEALTH_APPLICATION_ID, REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import type { WorkerStorageStatus } from '../../../shared/storage.js';

test('storage health keeps identity at 503; verification holds stay 200 and recovery keeps owner authentication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-storage-health-'));
  let status: WorkerStorageStatus = { state: 'unavailable', code: 'unsupported-runtime', reason: 'Unsupported SQLite runtime.', admissionOpen: false, sessionsAvailable: false, healthStatus: 503 };
  let retries = 0;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
    detail: async () => undefined, enqueue: async () => { throw new Error('No intake allowed.'); }, cancel: async () => {}, subscribe: () => () => {},
    storageStatus: () => status, storageRetry: async () => { retries++; return status; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const failed = await fetch(`${base}/api/health`);
  assert.equal(failed.status, 503);
  const health = await failed.json() as { application: string; pid: number; version: string; diagnostic: boolean; storage: WorkerStorageStatus };
  assert.equal(health.application, HEALTH_APPLICATION_ID); assert.equal(health.pid, process.pid); assert.equal(health.diagnostic, true); assert.ok(health.version);
  assert.equal(health.storage.code, status.code);
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 503, 'an unavailable index never looks like a successful empty snapshot');
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const options = { method: 'POST', headers: { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: '{}' };
  assert.equal((await fetch(`${base}/api/storage/retry`, { ...options, headers: { ...options.headers, 'x-tower-agent': 'local' } })).status, 403);
  assert.equal((await fetch(`${base}/api/storage/retry`, { ...options, headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal(retries, 0);
  assert.equal((await fetch(`${base}/api/storage/retry`, options)).status, 200); assert.equal(retries, 1);
  status = { ...status, state: 'update-held', code: 'update-verifying', reason: 'Verification is running.', healthStatus: 200 };
  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'the helper can complete verification while import remains held');
});
