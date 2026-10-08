import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { artifactOf, contextOf } from '../storage/helpers.js';
import { buildIdentityModule, buildIdentityPlugin } from '../../../server/storage/thread-bundle.mjs';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { writeHandoff } from '../../../server/runs/handoff.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { runnerPaths, RUNNER_PROTOCOL, type RunnerReply } from '../../../server/runs/runner-protocol.js';
import { storageUpdatePaths, type RollbackRecord } from '../../../server/link/storage-update.js';
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
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths);
  let snapshot: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!snapshot) {
    if (child.exitCode !== null) assert.fail(`Actual worker exited: ${stderr()}`);
    try { snapshot = await call('snapshot'); } catch {
      if (Date.now() > deadline) assert.fail(`Actual worker did not answer: ${stderr()}`);
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

async function launchDiagnostic(t: TestContext, root: string, state: string, paths: Awaited<ReturnType<typeof runnerPaths>>, entry = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url)), extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, state], {
    env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const ended = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
    // Both directories are exact fixture-owned paths, recorded before the child was launched.
    await rm(paths.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const call = (method: string, args: unknown[] = []) => fixtureCall(paths, method, args);
  return { child, call, stderr: () => stderr };
}


test('actual product worker promotes update-held once in the same boot; a failed cold journal parks before scans and retries explicitly', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-storage-promotion-'));
  const state = join(root, 'state');
  const paths = await runnerPaths(state);
  const hold = updatePaths(state).hold;
  await mkdir(dirname(hold), { recursive: true, mode: 0o700 });
  await writeFile(hold, 'fixture update hold', { mode: 0o600 });
  const journal = join(state, 'retention', 'journal.json');
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
  await writeFile(journal, '{incomplete journal', { mode: 0o600 });
  const journalBytes = await readFile(journal);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths);
  let first: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!first) {
    assert.equal(child.exitCode, null, stderr());
    try { first = await call('snapshot'); } catch { if (Date.now() > deadline) assert.fail(stderr()); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(first.snapshot?.storage?.state, 'update-held');
  assert.equal(first.snapshot?.storage?.healthStatus, 200);
  assert.equal(first.snapshot?.storage?.sessionsAvailable, false);
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  // Release ACK must work in the initial diagnostic host, before retryNormal exists.
  const at = new Date().toISOString(); const identity = contextOf('production').identity;
  const rollback: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: 'initial-release', from: '99.0.0', target: identity.appVersion,
    sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest, entrySha256: 'a'.repeat(64), updateSha256: null,
    state: 'completed', by: 'fixture', reason: 'initial held release', held: true, switched: false,
    attempt: { n: 1, pid: process.pid, start: 'fixture', nonce: 'a'.repeat(32), kind: 'run', at }, startedAt: at, updatedAt: at };
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(rollback), { mode: 0o600 });
  const ack = await call('storageControl', ['release', { fence: { id: rollback.id, attempt: 1 } }]);
  assert.equal(ack.error, undefined);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false);
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  rollback.held = false;
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(rollback), { mode: 0o600 });
  await rm(hold);
  let parked: RunnerReply | undefined;
  while (parked?.snapshot?.storage?.code !== 'cold-journal-unavailable') {
    if (Date.now() > deadline) assert.fail(stderr());
    parked = await call('snapshot'); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(parked.instance, first.instance);
  assert.equal(parked.snapshot?.storage?.sessionsAvailable, false);
  assert.deepEqual(await readFile(journal), journalBytes);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  // The fixture owner repairs only its own journal; product retry must publish it before sessions resume.
  await writeFile(journal, JSON.stringify({ version: 1, migratedAt: Date.now(), entries: [] }), { mode: 0o600 });
  await call('storageRetry');
  let promoted: RunnerReply | undefined;
  while (!promoted?.snapshot?.storage?.admissionOpen) {
    if (Date.now() > deadline) assert.fail(stderr());
    promoted = await call('snapshot'); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(promoted.instance, first.instance);
  assert.equal(promoted.snapshot?.storage?.sessionsAvailable, true);
  assert.equal(promoted.snapshot?.storage?.state, 'ready');
  assert.deepEqual(promoted.snapshot?.runs, []);
  assert.equal((await call('storageStatus')).instance, first.instance);
  const store = new RetentionStore(dirname(journal)); await store.start();
  assert.deepEqual(store.list(), []);
});


test('actual product worker refuses an unsupported captured thread before restore or SQLite open, without hiding it as an empty successful snapshot', { timeout: 90000 }, async t => {
  // Keep generated ESM under the checkout so external package resolution uses its installed dependencies.
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'w0-unsupported-fixture-'));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const entry = join(root, 'worker.mjs');
  const artifact = artifactOf('no-sqlite');
  await build({ entryPoints: [fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url))], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [buildIdentityPlugin(buildIdentityModule({ contexts: [contextOf('no-sqlite')], artifact: JSON.stringify(artifact) }))] });
  const restore = join(state, 'restore', 'pending-worker.json');
  await mkdir(dirname(restore), { recursive: true, mode: 0o700 });
  await writeFile(restore, 'original restore bytes', { mode: 0o600 });
  const before = await lstat(restore);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, entry);
  let first: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!first) {
    assert.equal(child.exitCode, null, stderr());
    try { first = await call('snapshot'); } catch { if (Date.now() > deadline) assert.fail(stderr()); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(first.snapshot?.storage?.state, 'unavailable');
  assert.equal(first.snapshot?.storage?.healthStatus, 503);
  assert.equal(first.snapshot?.storage?.admissionOpen, false);
  assert.equal(first.snapshot?.storage?.sessionsAvailable, false);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  assert.equal((await call('sessionHistory')).error?.statusCode, 503);
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  assert.equal(await readFile(restore, 'utf8'), 'original restore bytes');
  assert.equal((await lstat(restore)).ino, before.ino);
  assert.equal((await call('snapshot')).instance, first.instance, 'there is no automatic worker respawn');
});


for (const matching of [true, false]) test(`actual successor applies the new cold journal transition only for its exact observed nonce (matching=${matching})`, { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-storage-successor-')); const state = join(root, 'state'); const paths = await runnerPaths(state);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const nonce = 'a'.repeat(32);
  await writeHandoff(paths.runtime, { previous: 'fixture-predecessor', successor: matching ? nonce : 'b'.repeat(32), version: '1.0.0', clean: true, at: new Date().toISOString(), storageTransition: true });
  const journal = join(state, 'retention', 'journal.json'); await mkdir(dirname(journal), { recursive: true, mode: 0o700 }); await writeFile(journal, '{broken fixture journal', { mode: 0o600 });
  const entry = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url));
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, entry, { TOWER_HANDOFF: nonce });
  let snapshot: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (matching ? snapshot?.snapshot?.storage?.code !== 'cold-journal-unavailable' : !snapshot?.snapshot?.storage?.admissionOpen) {
    assert.equal(child.exitCode, null, stderr());
    if (Date.now() > deadline) assert.fail(stderr());
    try { snapshot = await call('snapshot'); } catch { /* Owned child has not published its endpoint yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(snapshot?.snapshot?.storage?.sessionsAvailable, !matching);
  assert.equal(snapshot?.snapshot?.storage?.admissionOpen, !matching);
  assert.equal(await readFile(journal, 'utf8'), '{broken fixture journal', 'failed journal reads preserve the original source');
  if (matching) assert.equal((await call('create')).error?.disposition, 'not-admitted');
});

async function fixtureCall(paths: Awaited<ReturnType<typeof runnerPaths>>, method: string, args: unknown[] = []): Promise<RunnerReply> {
    const token = await readFile(paths.token, 'utf8');
    const body = JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args });
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); res.on('error', reject);
      });
      req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Fixture RPC timeout'))); req.end(body);
    });
}


test('initial and poll fallback start the actual current worker behind its storage gate; restart and force cannot bypass the unknown previous build', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-storage-fallback-')); const state = join(root, 'state'); const paths = await runnerPaths(state);
  const lock = updatePaths(state).lock; await mkdir(dirname(lock), { recursive: true, mode: 0o700 }); await writeFile(lock, 'unknown previous helper', { mode: 0o600 });
  const restore = join(state, 'restore', 'pending-worker.json'); await mkdir(dirname(restore), { recursive: true, mode: 0o700 }); await writeFile(restore, 'preserve fallback source', { mode: 0o600 });
  const children: ChildProcess[] = []; const exits: Promise<unknown>[] = []; let closing = false;
  const entry = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url));
  const commands: string[][] = [];
  const manager = new DurableRunManager({ stateDir: state, version: '99.0.0', workerEntry: entry, startupTimeoutMs: 60000, pollMs: 25, successorTimeoutMs: 0,
    handoffHeld: async () => true,
    heldWorkerEntry: async () => { throw new Error('fixture previous artifact is unverifiable'); },
    spawn: command => {
      if (closing) throw new Error('Fixture teardown already owns its direct children.');
      commands.push(command.args);
      const child = spawn(command.execPath, command.args, { env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') }, stdio: ['ignore', 'ignore', 'ignore'] });
      children.push(child); exits.push(once(child, 'exit'));
    },
  });
  t.after(async () => { closing = true; await manager.close(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await Promise.all(exits); await rm(paths.directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  await manager.start();
  assert.equal(children.length, 1); assert.ok(commands[0]!.includes(entry));
  assert.equal(manager.storageStatus()?.admissionOpen, false);
  assert.equal(manager.storageStatus()?.sessionsAvailable, false);
  await assert.rejects(manager.restartWorker(), /verifying/);
  await assert.rejects(manager.forceUpdate(0), /verifying/);
  assert.equal(children.length, 1);
  const first = await fixtureCall(paths, 'snapshot');
  await writeHandoff(paths.runtime, { previous: first.instance!, successor: 'c'.repeat(32), version: '1.0.0', clean: true, at: new Date().toISOString(), storageTransition: true });
  children[0]!.kill('SIGKILL'); await exits[0];
  const deadline = Date.now() + 60000;
  while (Number(children.length) !== 2 || manager.storageStatus()?.admissionOpen !== false) {
    if (Date.now() > deadline) assert.fail('poll fallback did not attach its diagnostic worker');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  let second: RunnerReply | undefined;
  while (!second || second.instance === first.instance) {
    if (Date.now() > deadline) assert.fail('successor fallback did not publish a distinct instance');
    try { second = await fixtureCall(paths, 'snapshot'); } catch { /* The direct owned replacement is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(second.snapshot?.storage?.admissionOpen, false); assert.equal(second.snapshot?.storage?.sessionsAvailable, false);
  assert.equal((await fixtureCall(paths, 'create')).error?.disposition, 'not-admitted');
  assert.equal(await readFile(restore, 'utf8'), 'preserve fallback source');
  assert.equal(await readFile(lock, 'utf8'), 'unknown previous helper');
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  assert.equal(children.length, 2, 'no unrequested respawn beyond the proven poll fallback');
});


for (const stage of ['1', 'late']) test(`actual SDK startup failure parks its continuation (${stage}); failed owner retry stays held and successful retry does not restart services`, { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-storage-startup-retry-'));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, undefined, { TOWER_FIXTURE_STORAGE_STARTUP: stage });
  const deadline = Date.now() + 60000;
  let parked: RunnerReply | undefined;
  while (!parked?.snapshot?.storage?.sessionsAvailable || parked.snapshot.storage.admissionOpen) {
    assert.equal(child.exitCode, null, stderr());
    if (Date.now() > deadline) assert.fail(stderr());
    try { parked = await call('snapshot'); } catch { /* Endpoint not published yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const counts = join(state, 'fixture-startup-counts.json');
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
  const failure = JSON.parse(await readFile(join(state, 'fixture-startup-failure.json'), 'utf8'));
  assert.equal(failure.code, 'not-ready'); assert.equal(failure.disposition, 'not-committed');
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  // Refuse one explicit retry using the existing update hold, without replacing the DB or its claim.
  const hold = updatePaths(state).hold;
  await mkdir(dirname(hold), { recursive: true, mode: 0o700 }); await writeFile(hold, 'fixture owner retry hold', { mode: 0o600 });
  await call('storageRetry');
  const failed = await call('snapshot');
  assert.equal(failed.instance, parked.instance); assert.equal(failed.snapshot?.storage?.admissionOpen, false);
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
  await rm(hold); await call('storageRetry');
  let ready = await call('snapshot');
  while (!ready.snapshot?.storage?.admissionOpen) {
    assert.equal(child.exitCode, null, stderr()); if (Date.now() > deadline) assert.fail(stderr());
    await new Promise(resolve => setTimeout(resolve, 25)); ready = await call('snapshot');
  }
  assert.equal(ready.instance, parked.instance); assert.equal(ready.snapshot?.storage?.state, 'ready');
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
  assert.deepEqual(ready.snapshot?.runs, []);
  // A late parked gate must restore the full runtime retry handler, rather than leave its startup resolver behind.
  await writeFile(hold, 'fixture second owner hold', { mode: 0o600 }); await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false);
  await rm(hold); await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, true);
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
});
