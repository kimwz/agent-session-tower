import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStart } from '../../../server/instance/process-start.js';
import { pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import { HoldError, holdPath, removeHold, writeHold } from '../../../server/link/storage-hold.js';
import { inspectStorageTransition, transitionBreakerPath, transitionLockPath, TransitionLockError, withStorageTransition } from '../../../server/link/storage-transition-lock.js';
import type { SavedUpdate } from '../../../server/link/storage-update.js';
import { runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { ownChild, ownDirectory, readLines } from '../../helpers/child-processes.js';

/**
 * The computer's transition turn (F1): exclusive through stale recovery and ended turns, real separate processes
 * included, which move only on explicit barriers (lines on their stdout and stdin). The hold's strict writer (F6).
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-transition-'));
  ownDirectory(t, directory);
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (version: string, previous: string, stage: SavedUpdate['stage'], extra: Partial<SavedUpdate> = {}): SavedUpdate => ({ version, previous, stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, JSON.stringify(value));
const bytes = (path: string) => readFileSync(path);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

// ---- F1. The transition lock ----

const ownerFile = (role: 'lock' | 'breaker', pid: number, start: string) => JSON.stringify({ format: 'tower-transition-owner', version: 1, role, pid, start, nonce: randomBytes(10).toString('hex') });
async function staleLock(state: string) {
  await mkdir(join(state, 'runtime'), { recursive: true });
  await writeFile(transitionLockPath(state), ownerFile('lock', deadPid(), 'Thu Jan  1 00:00:00 1970'), { mode: 0o600 });
}

test('F1. a stale lock is broken under its breaker; a live breaker, its payload after its owner, makes others wait and is kept', async t => {
  const state = await stateDir(t);
  await staleLock(state);
  const own = await processStart(process.pid);
  await writeFile(transitionBreakerPath(state), ownerFile('breaker', process.pid, own!), { mode: 0o600 });
  const before = bytes(transitionBreakerPath(state));
  const diagnostic = await inspectStorageTransition(state);
  assert.ok(diagnostic.breaker.state === 'held' && diagnostic.breaker.liveness === 'running', 'a breaker with its nonce after the owner is alive');
  assert.ok(diagnostic.lock.state === 'held' && diagnostic.lock.liveness === 'gone');
  let entered = false;
  await assert.rejects(withStorageTransition(state, async () => { entered = true; }, { waitMs: 300 }), { code: 'transition-busy' });
  assert.equal(entered, false);
  assert.deepEqual(bytes(transitionBreakerPath(state)), before);
  // Without it, the stale lock is broken and the turn taken.
  await rm(transitionBreakerPath(state));
  await withStorageTransition(state, async () => { entered = true; });
  assert.equal(entered, true);
  assert.deepEqual([existsSync(transitionLockPath(state)), existsSync(transitionBreakerPath(state))], [false, false]);
});

test('F1. a breaker whose owner is gone or cannot be told, beside a stale lock: no entry, a typed refusal with the diagnostic, both kept', async t => {
  for (const breaker of ['gone', 'unknown'] as const) {
    const state = await stateDir(t);
    await staleLock(state);
    // `unknown`: a pid that runs (this very process) written without a start time it could be told by.
    await writeFile(transitionBreakerPath(state), ownerFile('breaker', breaker === 'gone' ? deadPid() : process.pid, ''), { mode: 0o600 });
    const before = [bytes(transitionLockPath(state)), bytes(transitionBreakerPath(state))];
    let entered = false;
    const error = await withStorageTransition(state, async () => { entered = true; }, { waitMs: 300 }).then(() => undefined, failure => failure as TransitionLockError);
    assert.equal(entered, false, breaker);
    assert.ok(error instanceof TransitionLockError && error.code === 'transition-lock-stale-breaker', `${breaker}: ${error?.message}`);
    assert.ok(error.diagnostic?.lock.state === 'held' && error.diagnostic.lock.liveness === 'gone' && error.diagnostic.lock.path === transitionLockPath(state));
    assert.ok(error.diagnostic.breaker.state === 'held' && error.diagnostic.breaker.liveness === breaker && error.diagnostic.breaker.path === transitionBreakerPath(state));
    assert.deepEqual([bytes(transitionLockPath(state)), bytes(transitionBreakerPath(state))], before, `${breaker}: both files kept as they were`);
  }
});

test('F1. a breaker left alone, without a lock, does not keep the turn from anyone; it is left as it is', async t => {
  const state = await stateDir(t);
  await mkdir(join(state, 'runtime'), { recursive: true });
  await writeFile(transitionBreakerPath(state), ownerFile('breaker', deadPid(), 'x'), { mode: 0o600 });
  const before = bytes(transitionBreakerPath(state));
  let entered = false;
  await withStorageTransition(state, async () => { entered = true; }, { waitMs: 300 });
  assert.equal(entered, true);
  assert.deepEqual(bytes(transitionBreakerPath(state)), before);
});

test('F1. a lock or breaker that is a link, a folder or not an owner this build wrote fails the turn and is kept', async t => {
  for (const shape of ['link', 'dangling', 'folder', 'garbage', 'old-format'] as const) {
    const state = await stateDir(t);
    await mkdir(join(state, 'runtime'), { recursive: true });
    const path = transitionLockPath(state);
    if (shape === 'link') { await writeFile(join(state, 'file'), ownerFile('lock', deadPid(), 'x')); await symlink(join(state, 'file'), path); }
    if (shape === 'dangling') await symlink(join(state, 'nowhere'), path);
    if (shape === 'folder') await mkdir(path);
    if (shape === 'garbage') await writeFile(path, '{', { mode: 0o600 });
    if (shape === 'old-format') await writeFile(path, `${deadPid()} Thu Jan  1 00:00:00 1970`, { mode: 0o600 });
    let entered = false;
    await assert.rejects(withStorageTransition(state, async () => { entered = true; }, { waitMs: 300 }), { code: 'transition-lock-unreadable' }, shape);
    assert.equal(entered, false, shape);
    const info = await lstat(path);
    assert.ok(shape === 'link' || shape === 'dangling' ? info.isSymbolicLink() : shape === 'folder' ? info.isDirectory() : info.isFile(), `${shape} kept`);
  }
});

test('F1. contenders in this process over a stale lock: at most one inside, every one gets the turn', async t => {
  const state = await stateDir(t);
  await staleLock(state);
  let inside = 0;
  let most = 0;
  let done = 0;
  await Promise.all(Array.from({ length: 8 }, () => withStorageTransition(state, async () => {
    inside++; most = Math.max(most, inside);
    await new Promise(resolve => setTimeout(resolve, 20));
    inside--; done++;
  })));
  assert.deepEqual([most, done], [1, 8]);
});

test('F1. a promise made in a turn that has ended takes the lock like any other caller', async t => {
  const state = await stateDir(t);
  let inside = 0;
  let most = 0;
  const work = async (ms: number) => { inside++; most = Math.max(most, inside); await new Promise(resolve => setTimeout(resolve, ms)); inside--; };
  let late!: Promise<void>;
  await withStorageTransition(state, async () => {
    late = new Promise<void>(resolve => setTimeout(() => { void withStorageTransition(state, () => work(50)).then(resolve, resolve); }, 100));
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  await Promise.all([withStorageTransition(state, () => work(300)), late]);
  assert.equal(most, 1);
  // Inside a turn that is still running, a nested call is that same turn.
  await withStorageTransition(state, () => withStorageTransition(state, async () => { assert.ok(existsSync(transitionLockPath(state))); }, { waitMs: 50 }));
});

test('F1. separate processes over a stale lock (real processes, real files): the turn stays exclusive and each gets it once', async t => {
  const state = await stateDir(t);
  await staleLock(state);
  const script = fileURLToPath(new URL('./fixtures/transition-child.ts', import.meta.url));
  const count = 4;
  /** Who holds the turn now, as the children say: entered and not released yet. */
  const inside = new Set<number>();
  const problems: string[] = [];
  let trying = 0;
  let entered = 0;
  const release = new Map<number, () => void>();
  // A holder is released only once every child has asked for the turn, so the others contend while it is held.
  const next = () => {
    if (trying < count) return;
    for (const [pid, go] of release) {
      try {
        const owner = JSON.parse(readFileSync(transitionLockPath(state), 'utf8')) as { pid: number };
        if (owner.pid !== pid) problems.push(`the lock names ${owner.pid} while ${pid} is inside`);
      } catch (error) { problems.push(`the lock cannot be read while ${pid} is inside: ${(error as Error).message}`); }
      release.delete(pid);
      inside.delete(pid);
      go();
    }
  };
  const children = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, state], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Diagnostics: both streams as they come. Messages: only complete JSON lines of stdout.
    let out = '';
    readLines(child.stdout, text => {
      out += `${text}\n`;
      if (!text.startsWith('{')) return;
      const line = JSON.parse(text) as { trying?: number; entered?: number };
      if (line.trying) trying++;
      if (line.entered) {
        entered++;
        inside.add(line.entered);
        if (inside.size > 1) problems.push(`${[...inside].join(', ')} inside at once`);
        release.set(line.entered, () => child.stdin.write('release\n'));
      }
      next();
    });
    child.stderr.on('data', chunk => { out += String(chunk); });
    const closed = new Promise<{ code: number | null; out: string }>(resolve => child.on('close', code => resolve({ code, out })));
    ownChild(t, child, closed);
    return closed;
  });
  const exits = await Promise.all(children);
  assert.deepEqual(exits.map(exit => exit.code), Array(count).fill(0), exits.map(exit => exit.out).join(' '));
  assert.deepEqual([problems, entered], [[], count]);
  assert.deepEqual([existsSync(transitionLockPath(state)), existsSync(transitionBreakerPath(state))], [false, false]);
});

// ---- F6. The hold's writer ----

test('F6. writeHold creates and refreshes only its own plain file; links, folders and another version\'s hold are refused and kept', async t => {
  const state = await stateDir(t);
  const path = holdPath(state);
  assert.equal(path, updatePaths(state).hold);
  assert.equal(await writeHold(state, '1.1.0'), 'created');
  assert.deepEqual([JSON.parse(await readFile(path, 'utf8')), (await stat(path)).mode & 0o777], [{ version: '1.1.0' }, 0o600]);
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(path, old, old);
  assert.equal(await writeHold(state, '1.1.0'), 'refreshed');
  assert.ok(Date.now() - (await stat(path)).mtimeMs < 60_000, 'held anew');
  await assert.rejects(writeHold(state, '1.2.0'), (error: unknown) => error instanceof HoldError && error.code === 'hold-owned-elsewhere');
  await writeFile(path, '{}');
  await assert.rejects(writeHold(state, '1.1.0'), { code: 'hold-owned-elsewhere' }, 'a hold naming no version is not this update\'s');
  assert.equal(await readFile(path, 'utf8'), '{}');
  await rm(path);
  for (const shape of ['file-link', 'dangling', 'folder'] as const) {
    const target = join(state, `target-${shape}`);
    if (shape === 'file-link') { await writeFile(target, 'ORIGINAL'); await symlink(target, path); }
    if (shape === 'dangling') await symlink(target, path);
    if (shape === 'folder') await mkdir(path);
    await assert.rejects(writeHold(state, '1.1.0'), { code: 'hold-not-a-file' }, shape);
    await assert.rejects(removeHold(state, { version: '1.1.0' }), { code: 'hold-not-a-file' }, shape);
    if (shape === 'file-link') assert.equal(await readFile(target, 'utf8'), 'ORIGINAL');
    if (shape === 'dangling') assert.equal(existsSync(target), false);
    await rm(path, { recursive: true });
  }
  assert.equal(await removeHold(state, { version: '1.1.0' }), false, 'nothing there is not an error');
  await writeHold(state, '1.1.0');
  await assert.rejects(removeHold(state, { version: '1.2.0' }), { code: 'hold-owned-elsewhere' });
  assert.equal(await removeHold(state, { version: '1.1.0' }), true);
  assert.equal(existsSync(path), false);
});

test('F6. a hold replaced by a link between its check and its write or removal is refused, and the link and its target are left', async t => {
  for (const step of ['refresh', 'remove'] as const) {
    const state = await stateDir(t);
    const path = holdPath(state);
    await writeHold(state, '1.1.0');
    const target = join(state, 'target');
    await writeFile(target, 'ORIGINAL');
    // Test-only: right before the writer checks the path again (a refresh) or moves it aside (a removal), something
    // replaces the hold with a link.
    let swapped = 0;
    const swap = (name: unknown) => { if (name === path && !swapped) { swapped++; unlinkSync(path); symlinkSync(target, path); } };
    const original = { lstat: fsPromises.lstat, rename: fsPromises.rename };
    t.mock.method(fsPromises, step === 'refresh' ? 'lstat' : 'rename', async (...args: [string, ...unknown[]]) => {
      swap(args[0]);
      return (original[step === 'refresh' ? 'lstat' : 'rename'] as (...rest: unknown[]) => Promise<unknown>)(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(step === 'refresh' ? writeHold(state, '1.1.0') : removeHold(state, { version: '1.1.0' }), { code: 'hold-replaced' }, step);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(swapped, 1, step);
    assert.deepEqual([readlinkSync(path), await readFile(target, 'utf8')], [target, 'ORIGINAL'], step);
  }
});

test('F6. recovery and the helper do not write through a hold that is a link: no helper, no switch, the target\'s bytes as they were', async t => {
  for (const dangling of [false, true]) {
    const state = await stateDir(t);
    await save(state, record('1.1.0', '1.0.0', 'verifying'));
    const target = join(state, 'not-a-hold');
    if (!dangling) await writeFile(target, 'ORIGINAL');
    await symlink(target, updatePaths(state).hold);
    const spawned: string[] = [];
    await assert.rejects(new Updates({ stateDir: state, version: '1.1.0', port: 1, managed: true, spawnHelper: version => spawned.push(version) }).recover(), { code: 'hold-not-a-file' });
    assert.deepEqual(spawned, []);
    assert.equal(dangling ? existsSync(target) : await readFile(target, 'utf8'), dangling ? false : 'ORIGINAL');
  }
  const state = await stateDir(t);
  for (const version of ['1.0.0', '1.1.0']) await mkdir(versionDirectory(state, version), { recursive: true });
  await pointCurrent(state, '1.0.0');
  await save(state, record('1.1.0', '1.0.0', 'installing'));
  const target = join(state, 'not-a-hold');
  await writeFile(target, 'ORIGINAL');
  await symlink(target, updatePaths(state).hold);
  const points: string[] = [];
  let clock = Date.parse(at);
  const steps: UpdateHelperSteps = {
    free: async () => undefined, install: async version => versionDirectory(state, version), check: async () => {}, point: async version => { points.push(version); },
    restart: async () => {}, health: async () => ({ version: '1.0.0', pid: 1 }), controllers: async () => [], sleep: async ms => { clock += ms; }, now: () => clock, log: () => {},
  };
  const status = await runUpdateHelper(state, '1.1.0', steps);
  assert.deepEqual([status?.stage, status?.code, points, await readFile(target, 'utf8'), readlinkSync(updatePaths(state).hold)], ['failed', 'switch-failed', [], 'ORIGINAL', target]);
});
