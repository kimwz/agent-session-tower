import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { artifactOf, contextOf } from '../storage/helpers.js';
import { buildIdentityModule, buildIdentityPlugin } from '../../../server/storage/thread-bundle.mjs';
import { readHandoff } from '../../../server/runs/handoff.js';
import { runnerPaths, RUNNER_PROTOCOL, type RunnerReply } from '../../../server/runs/runner-protocol.js';
import { currentStorage } from '../../helpers/current-storage.js';

// Each test starts the actual product worker as its own child (its actual SQLite runtime preflight, no native
// providers, no copied credentials) and waits for it to close before its folders are removed.

const FIXTURE_WORKER = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url));
/**
 * The fixture worker compiled (bundled) once for this file as a build of this checkout's own storage thread, so each
 * test starts it as plain node instead of compiling it again. Generated under the checkout so its external packages
 * resolve from the installed dependencies; removed after the file's tests.
 */
const generated: string[] = [];
after(() => Promise.all(generated.map(directory => rm(directory, { recursive: true, force: true }))));
const bundledWorker = async (name: string, source: 'production' | 'no-sqlite'): Promise<string> => {
  const directory = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), `w0-${name}-fixture-`));
  generated.push(directory);
  const entry = join(directory, 'worker.mjs');
  await build({ entryPoints: [FIXTURE_WORKER], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [buildIdentityPlugin(buildIdentityModule({ contexts: [contextOf(source)], artifact: JSON.stringify(artifactOf(source)) }))] });
  return entry;
};
let currentBuild: Promise<string> | undefined;
const currentWorker = () => currentBuild ??= bundledWorker('current', 'production');
/** Long enough for a loaded machine to start a worker; reaching it is a failure, never a result. */
const LIMIT_MS = 60_000;

type Paths = Awaited<ReturnType<typeof runnerPaths>>;
type Worker = Awaited<ReturnType<typeof launchDiagnostic>>;

async function launchDiagnostic(t: TestContext, root: string, state: string, paths: Paths, entry?: string, extraEnv: Record<string, string> = {}) {
  assert.equal(state, join(root, 'state'), 'diagnostic state must belong to the exact fixture root');
  const child = spawn(process.execPath, [entry ?? await currentWorker(), state], {
    env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  // close also drains the child's stdio: it is ended and closed before the folders it uses are removed.
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(paths.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  const alive = () => child.exitCode === null && child.signalCode === null;
  const diagnosis = () => `exit=${child.exitCode}, signal=${child.signalCode}; stderr=${stderr}`;
  return { child, closed, alive, diagnosis, call: (method: string, args: unknown[] = []) => fixtureCall(paths, method, args) };
}

async function fixtureCall(paths: Paths, method: string, args: unknown[] = []): Promise<RunnerReply> {
  const token = await readFile(paths.token, 'utf8');
  const body = JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args });
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

/** The first answer of `read` (asked again until it has one) while the worker runs; the limit only reports a stuck worker. */
async function poll<T>(worker: Worker, what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + LIMIT_MS;
  for (;;) {
    if (!worker.alive()) assert.fail(`The actual worker stopped before ${what}: ${worker.diagnosis()}`);
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) assert.fail(`The actual worker never reached ${what}: ${worker.diagnosis()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** The first snapshot (its endpoint may not be up yet) whose storage admission is `open`, with `code` when given. */
const waitForStorage = (worker: Worker, open: boolean, code?: string) => poll(worker, `admission ${open ? 'open' : 'closed'}${code ? ` (${code})` : ''}`, async () => {
  const reply = await worker.call('snapshot').catch(() => undefined);
  return reply?.snapshot?.storage?.admissionOpen === open && (!code || reply.snapshot.storage.code === code) ? reply : undefined;
});

const exists = (path: string) => stat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });

test('actual product worker refuses an unsupported captured thread before restore or SQLite open, without hiding it as an empty successful snapshot', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-unsupported-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const entry = await bundledWorker('unsupported', 'no-sqlite');
  const restore = join(state, 'restore', 'pending-worker.json');
  await mkdir(dirname(restore), { recursive: true, mode: 0o700 });
  await writeFile(restore, 'original restore bytes', { mode: 0o600 });
  const before = await lstat(restore);
  const worker = await launchDiagnostic(t, root, state, paths, entry);
  const first = await waitForStorage(worker, false);
  assert.equal(first.snapshot?.storage?.state, 'unavailable');
  assert.equal(first.snapshot?.storage?.code, 'runtime-unsupported');
  assert.equal(first.snapshot?.storage?.healthStatus, 503);
  assert.equal(first.snapshot?.storage?.sessionsAvailable, false);
  assert.equal((await worker.call('create')).error?.disposition, 'not-admitted');
  assert.equal((await worker.call('sessionHistory')).error?.statusCode, 503);
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  assert.equal(await readFile(restore, 'utf8'), 'original restore bytes');
  assert.equal((await lstat(restore)).ino, before.ino);
  assert.equal((await worker.call('snapshot')).instance, first.instance, 'there is no automatic worker respawn');
});

test('explicit same-worker retry rechecks a repaired private database path without changing captured build identity', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-path-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const database = join(state, 'state.sqlite'); await mkdir(database, { recursive: true, mode: 0o700 });
  const worker = await launchDiagnostic(t, root, state, paths);
  const held = await waitForStorage(worker, false);
  assert.equal(held.snapshot?.storage?.code, 'storage-state-invalid');
  assert.equal((await worker.call('create')).error?.disposition, 'not-admitted');
  // The retry answers once its attempt has finished.
  assert.equal(((await worker.call('storageRetry')).result as { admissionOpen: boolean }).admissionOpen, false, 'unrepaired non-file DB remains refused');
  await rm(database, { recursive: true }); // Exact empty directory created by this fixture, never owner storage.
  const retried = await worker.call('storageRetry');
  assert.equal((retried.result as { state: string }).state, 'ready', worker.diagnosis());
  const ready = await waitForStorage(worker, true, 'ready');
  assert.equal(ready.instance, held.instance);
  assert.deepEqual(ready.snapshot?.storage?.identity, held.snapshot?.storage?.identity);
  assert.equal((await lstat(database)).isFile(), true);
});

test('known identity with absent DB stays held until explicit snapshot adoption and reconciliation allow same-worker retry', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-adopt-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  // The current build's storage with all seven domains, its snapshot taken, then its database lost.
  const seed = await currentStorage(state);
  let snapshotId: string;
  try { snapshotId = (await seed.snapshot()).id; } finally { await seed.close(); }
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) await rm(join(state, name), { force: true });
  const worker = await launchDiagnostic(t, root, state, paths);
  const held = await waitForStorage(worker, false, 'known-storage-missing');
  assert.equal(held.snapshot?.storage?.state, 'recovery-required');
  assert.equal(((await worker.call('storageRetry')).result as { code: string }).code, 'known-storage-missing');
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  const adoption = await worker.call('storageRecovery', ['adopt', { snapshotId, reason: 'fixture owner restores its missing database' }]);
  assert.equal(adoption.error, undefined);
  const barrier = adoption.result as { id: string; scopes: { scope: string }[] };
  assert.equal(((await worker.call('storageRetry')).result as { admissionOpen: boolean }).admissionOpen, false, 'adoption never grants reconciliation');
  const reconciled = await worker.call('storageRecovery', ['reconcile', { barrierId: barrier.id, scopes: barrier.scopes.map(scope => scope.scope), by: 'fixture-owner', evidence: 'snapshot and absent original verified' }]);
  assert.equal(reconciled.error, undefined);
  await worker.call('storageRetry');
  assert.equal((await waitForStorage(worker, true, 'ready')).instance, held.instance);
});

test('a held worker never hands off while an owned permission command runs, and does once it completes', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-command-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const worker = await launchDiagnostic(t, root, state, paths, undefined, { TOWER_FIXTURE_STORAGE_STARTUP: 'command', TOWER_FIXTURE_CHECKS: '1' });
  // The command started during startup; the next startup gate then failed for real and parked the worker.
  const held = await waitForStorage(worker, false);
  assert.equal(held.snapshot?.storage?.state, 'unavailable', worker.diagnosis());
  assert.equal(await readFile(join(state, 'fixture-command-started'), 'utf8'), 'started\n');
  assert.ok(await exists(join(state, 'fixture-startup-failure.json')));
  const marker = join(state, 'fixture-successor');
  const successor = { execPath: '/bin/sh', args: ['-c', 'printf started > "$1/fixture-successor"', '--runner-worker', paths.stateDir] };
  assert.deepEqual((await worker.call('requestHandoff', [successor])).result, { accepted: true });
  // Count real handoff checks with nothing else asked of the worker (a request underway would hold it by itself).
  const checks = join(state, 'fixture-checks');
  const rounds = async () => (await readFile(checks, 'utf8').catch(() => '')).length;
  const asked = await rounds();
  await poll(worker, 'five more handoff checks', async () => await rounds() >= asked + 5 || undefined);
  assert.equal(await readHandoff(paths.runtime), undefined, 'no handoff while the owned command runs');
  assert.equal(await exists(marker), false);
  assert.equal((await worker.call('snapshot')).instance, held.instance);
  await writeFile(join(state, 'fixture-command-finish'), 'owner allows fixture command completion', { mode: 0o600 });
  // The worker exits right after handing off: its record, written before it stops, is what proves the handoff.
  await worker.closed;
  const record = await readHandoff(paths.runtime);
  assert.equal(record?.previous, held.instance);
  assert.equal(record?.storageTransition, true);
  const id = await readFile(join(state, 'fixture-command-id'), 'utf8');
  const output = JSON.parse(await readFile(join(state, 'permission-runs', `${id}.json`), 'utf8'));
  assert.match(output.stdout, /completed/, 'the command ran to its end before the worker handed off');
  // The successor (a shell standing in for a worker) writes its marker and exits.
  const deadline = performance.now() + LIMIT_MS;
  while (!await exists(marker)) {
    if (performance.now() > deadline) assert.fail('The successor never started.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
});
