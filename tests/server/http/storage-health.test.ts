import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../../../server/http/server.js';
import { HEALTH_APPLICATION_ID, REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { storageWebBuild, storageWebHealth } from '../../../server/link/storage-web.js';
import { APP_VERSION } from '../../../shared/app-identity.js';
import { readdir } from 'node:fs/promises';
import type { WorkerStorageStatus } from '../../../shared/storage.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerPaths, RUNNER_PROTOCOL, type RunnerReply } from '../../../server/runs/runner-protocol.js';
import { updatePaths } from '../../../server/link/update.js';

test('storage health keeps identity at 503; verification holds stay 200 and recovery keeps owner authentication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-storage-health-'));
  let status: WorkerStorageStatus = { state: 'unavailable', code: 'unsupported-runtime', reason: 'Unsupported SQLite runtime.', admissionOpen: false, sessionsAvailable: false, healthStatus: 503 };
  let retries = 0;
  const recoveries: Array<{ action: string; input: Record<string, unknown> }> = [];
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, master: { callerSecret: 'fixture-master-secret', handle: async () => false }, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
    detail: async () => undefined, enqueue: async () => { throw new Error('No intake allowed.'); }, cancel: async () => {}, subscribe: () => () => {},
    storageRecovery: async (action, input) => { recoveries.push({ action, input }); return { forwarded: true }; },
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
  const recovery = { kind: 'overwritten-done', by: 'owner', evidence: 'verified current build and failed back' };
  const verify = { ...options, body: JSON.stringify(recovery) };
  for (const headers of [{ ...verify.headers, 'x-tower-agent': 'local' }, { ...verify.headers, 'x-tower-master': 'fixture-master-secret' }, { ...verify.headers, [CALLER_CAPABILITY_HEADER]: 'a'.repeat(64) }, { 'content-type': 'application/json' }]) {
    assert.equal((await fetch(`${base}/api/storage/verify-update`, { ...verify, headers })).status, 403);
  }
  assert.equal(recoveries.length, 0);
  assert.equal((await fetch(`${base}/api/storage/verify-update`, { ...verify, body: JSON.stringify({ ...recovery, kind: 'ignore-failed' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/storage/verify-update`, verify)).status, 200);
  assert.deepEqual(recoveries, [{ action: 'verify-update', input: recovery }], 'the owner route forwards the exact worker recovery contract');
  status = { ...status, state: 'update-held', code: 'update-verifying', reason: 'Verification is running.', healthStatus: 200 };
  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'the helper can complete verification while import remains held');
});


test('candidate HTTP health independently preflights a captured web attached to a JSON-only worker without opening storage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-candidate-health-'));
  const build = storageWebBuild(dir, APP_VERSION);
  const candidate = await build();
  let mismatched = false;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir,
    storageWebHealth: async () => storageWebHealth({ stateDir: dir, managed: false, build: { ...await build(), ...(mismatched ? { version: '99.0.0' } : {}) } }),
    backend: {
      snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'legacy', version: 'legacy', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: async () => { throw new Error('No fixture intake.'); }, cancel: async () => {}, subscribe: () => () => {},
    } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`);
  const health = await response.json() as { application: string; pid: number; version: string; candidateStorage: { code: string } };
  assert.equal(response.status, candidate.preflight.supported ? 200 : 503);
  assert.equal(health.application, HEALTH_APPLICATION_ID); assert.equal(health.pid, process.pid); assert.equal(health.version, APP_VERSION);
  if (!candidate.preflight.supported) assert.equal(health.candidateStorage.code, 'runtime-unsupported');
  mismatched = true;
  const mismatch = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`);
  assert.equal(mismatch.status, 503, 'an independently captured contract cannot be presented as another web build');
  assert.deepEqual(await readdir(dir), [], 'candidate runtime/contract checks never create the actual database or private state');
});

test('owner verify-update HTTP reaches the actual diagnostic worker RPC and its receipt refusal without modifying source data', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-owner-verify-')));
  const state = join(root, 'state');
  const paths = await runnerPaths(state);
  const lock = updatePaths(state).lock;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  await writeFile(lock, 'unknown fixture helper', { mode: 0o600 });
  const original = join(state, 'runs.json');
  await writeFile(original, '{"fixture":"preserve exact bytes"}', { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../runs/fixtures/storage-diagnostic-worker.ts', import.meta.url)), state], {
    env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const ended = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; await rm(paths.directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  const call = async (method: string, args: unknown[] = []): Promise<RunnerReply> => {
    const token = await readFile(paths.token, 'utf8');
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); res.on('error', reject);
      });
      req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Fixture RPC timeout'))); req.end(JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args }));
    });
  };
  const deadline = Date.now() + 60000;
  let first: RunnerReply | undefined;
  while (!first) {
    assert.equal(child.exitCode, null, stderr);
    try { first = await call('snapshot'); } catch { if (Date.now() > deadline) assert.fail(stderr); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(first.snapshot?.storage?.state, 'recovery-required', 'actual runtime gate passed; unknown helper holds startup');
  let recoveryCalls = 0;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: root, backend: {
    snapshot: () => ({ sessions: first!.snapshot!.sessions, runs: first!.snapshot!.runs, providers: [], scanning: false, hostname: 'fixture', version: APP_VERSION, updatedAt: new Date().toISOString() }), detail: async () => undefined, enqueue: async () => { throw new Error('No intake.'); }, cancel: async () => {}, subscribe: () => () => {},
    storageRecovery: async (action, input) => { recoveryCalls++; const reply = await call('storageRecovery', [action, input]); assert.equal(reply.error, undefined); return reply.result; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const options = { method: 'POST', headers: { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify({ kind: 'overwritten-done', by: 'owner', evidence: 'fixture verification' }) };
  assert.equal((await fetch(`${base}/api/storage/verify-update`, { ...options, headers: { ...options.headers, 'x-tower-agent': 'local' } })).status, 403);
  assert.equal(recoveryCalls, 0);
  const response = await fetch(`${base}/api/storage/verify-update`, options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { recorded: false, code: 'update-status', reason: 'The update record is absent; there is nothing this receipt could verify.' });
  assert.equal(recoveryCalls, 1);
  assert.equal(await readFile(original, 'utf8'), '{"fixture":"preserve exact bytes"}');
  assert.equal(await readFile(lock, 'utf8'), 'unknown fixture helper');
  assert.equal((await call('snapshot')).instance, first.instance);
});
