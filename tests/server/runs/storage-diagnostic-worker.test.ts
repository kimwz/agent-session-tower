import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runnerPaths, RUNNER_PROTOCOL, type RunnerReply } from '../../../server/runs/runner-protocol.js';
import { updatePaths } from '../../../server/link/storage-update.js';

// Hosted disposable jobs only: this starts the actual product worker and its actual SQLite memory preflight,
// with no native providers, no copied credentials, and only the direct child owned by this fixture.
test('actual diagnostic worker holds restore, journal, proofs and launches before a storage update can be proven', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-storage-diagnostic-'));
  const state = join(root, 'state');
  const paths = await runnerPaths(state);
  const lock = updatePaths(state).lock;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  await writeFile(lock, 'invalid helper owner', { mode: 0o600 });
  const protectedFiles = [join(state, 'restore', 'pending-worker.json'), join(state, 'retention', 'journal.json'), join(state, 'agent-launches.json'), join(state, 'launch-marks', 'fixture.json')];
  for (const path of protectedFiles) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, 'fixture bytes: must not be consumed', { mode: 0o600 }); }
  const before = await Promise.all(protectedFiles.map(async path => ({ bytes: await readFile(path), info: await lstat(path) })));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url)), state], {
    env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const ended = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
    // Both directories are exact fixture-owned paths, recorded before the child was launched.
    await rm(paths.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const call = async (method: string): Promise<RunnerReply> => {
    const token = await readFile(paths.token, 'utf8');
    const body = JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args: [] });
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); res.on('error', reject);
      });
      req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Fixture RPC timeout'))); req.end(body);
    });
  };
  let snapshot: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!snapshot) {
    if (child.exitCode !== null) assert.fail(`Actual worker exited: ${stderr}`);
    try { snapshot = await call('snapshot'); } catch {
      if (Date.now() > deadline) assert.fail(`Actual worker did not answer: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const status = snapshot.snapshot?.storage;
  assert.ok(status, 'actual worker advertises its storage diagnosis');
  assert.equal(status.admissionOpen, false);
  assert.equal(status.sessionsAvailable, false);
  assert.equal(status.state, 'recovery-required', 'actual supported SQLite preflight passed; the unknown helper holds startup');
  assert.equal((await call('sessionHistory')).error?.statusCode, 503);
  assert.equal((await call('forceHandoff')).error?.statusCode, 503, 'storage hold cannot become a forced cancellation');
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(state, 'restore', 'applying-worker.json')), { code: 'ENOENT' });
  for (const [index, path] of protectedFiles.entries()) {
    assert.deepEqual(await readFile(path), before[index].bytes);
    const info = await lstat(path); assert.equal(info.ino, before[index].info.ino); assert.equal(info.mtimeMs, before[index].info.mtimeMs);
  }
  assert.equal(await readFile(lock, 'utf8'), 'invalid helper owner');
  assert.equal((await call('snapshot')).instance, snapshot.instance, 'diagnosis keeps its live runtime lock and RPC identity');
});
