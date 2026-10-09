import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TowerError } from '../../../shared/errors.js';
import { processStart } from '../../../server/instance/process-start.js';
import { entryPoint, pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import * as hold from '../../../server/link/storage-hold.js';
import { transitionBreakerPath, transitionLockPath } from '../../../server/link/storage-transition-lock.js';
import * as update from '../../../server/link/update.js';
import { handoffHeld, heldWorkerEntry, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { TowerAutoUpdate } from '../../../server/updates/tower.js';
import { Updates as LegacyUpdates } from './fixtures/legacy-1.114.1/server/link/update.js';

/**
 * W0U correction 4 (w0u-helper-final-contract.md): whether an update helper may still run is told by one judgment.
 * Absent or a lock whose owner is gone: no helper. Running: one. A lock that names no process (invalid) or cannot be
 * read (unreadable) is unknown, never absence: it rejects with HelperLockUnknownError, and nothing is written, removed,
 * taken over or started on it, whatever the update record or the hold say. Real files and processes unless a test's name
 * says memory hook; the live helper is the released 1.114.1 helper's own code (fixtures/legacy-helper-child.ts).
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-helper-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(versionDirectory(directory, '1.0.0'), { recursive: true });
  await pointCurrent(directory, '1.0.0');
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (stage: string, extra: Record<string, unknown> = {}) => ({ version: '1.1.0', previous: '1.0.0', stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const old = () => new Date(Date.now() - 60 * 60_000);
const quiet = (t: TestContext) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };

// ---- The unknown locks: every shape is made for real, without chmod (so this holds as root too). ----

const INVALID = ['not a lock', '', '0', '1.5'] as const;
/** What readHelperLock's own read reports for each: a folder, a link (to a file naming a live pid, or to nowhere) and a FIFO. */
const UNREADABLE = { folder: 'EISDIR', link: 'ELOOP', dangling: 'ELOOP', fifo: 'ENOTFILE' } as const;
type Shape = typeof INVALID[number] | keyof typeof UNREADABLE;
const SHAPES: Shape[] = [...INVALID, ...Object.keys(UNREADABLE) as Array<keyof typeof UNREADABLE>];
const invalid = (shape: Shape) => (INVALID as readonly string[]).includes(shape);
const codeOf = (shape: Shape) => invalid(shape) ? 'helper-lock-invalid' : UNREADABLE[shape as keyof typeof UNREADABLE];
async function unknownLock(state: string, shape: Shape) {
  const { lock } = updatePaths(state);
  if (shape === 'folder') await mkdir(lock);
  else if (shape === 'link') { await writeFile(join(state, 'lock-target'), String(process.pid)); await symlink(join(state, 'lock-target'), lock); }
  else if (shape === 'dangling') await symlink(join(state, 'nowhere'), lock);
  else if (shape === 'fifo') assert.equal(spawnSync('mkfifo', [lock]).status, 0);
  else await writeFile(lock, shape, { mode: 0o600 });
}
/** A rejection as the common judgment makes it: typed, with the lock's own code (the original errno when unreadable). */
function assertUnknown(error: unknown, shape: Shape, label: string): asserts error is update.HelperLockUnknownError {
  assert.ok(typeof update.HelperLockUnknownError === 'function' && error instanceof update.HelperLockUnknownError, `${label}: ${error instanceof Error ? error.stack : String(error)}`);
  assert.equal(error.code, codeOf(shape), label);
  assert.equal(error.helper, invalid(shape) ? 'invalid' : 'unreadable', label);
  if (!invalid(shape)) assert.equal((error.cause as NodeJS.ErrnoException).code, codeOf(shape), `${label}: the read's own error is kept`);
}
const outcome = <T>(promise: Promise<T>) => promise.then(value => value, (error: unknown) => error);

/**
 * Everything in the runtime folder as it is: kind, inode, size, mtime and ctime (ns), and the bytes, link target or
 * entries. The hold's whole generation and the lock's and record's inode and mtime are in it; so is any file left over.
 */
async function snapshot(state: string) {
  const root = runtimePaths(state).root;
  const seen: Record<string, unknown> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await lstat(path, { bigint: true });
    const kind = info.isFile() ? 'file' : info.isDirectory() ? 'folder' : info.isSymbolicLink() ? 'link' : info.isFIFO() ? 'fifo' : 'other';
    seen[name] = {
      kind, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
      ...kind === 'file' ? { bytes: (await readFile(path)).toString('base64') } : {},
      ...kind === 'link' ? { target: await readlink(path) } : {},
      ...kind === 'folder' ? { entries: (await readdir(path)).sort() } : {},
    };
  }
  return seen;
}

type RecordKind = 'active' | 'terminal' | 'absent' | 'invalid' | 'unreadable';
const RECORDS: RecordKind[] = ['active', 'terminal', 'absent', 'invalid', 'unreadable'];
async function setRecord(state: string, kind: RecordKind, updatedAt = at) {
  const { status } = updatePaths(state);
  await rm(status, { recursive: true, force: true });
  if (kind === 'active') await save(state, record('installing', { updatedAt }));
  if (kind === 'terminal') await save(state, record('failed', { code: 'install-failed', failedStage: 'installing' }));
  if (kind === 'invalid') await save(state, 'not json');
  if (kind === 'unreadable') await mkdir(status);
}
type HoldAge = 'none' | 'fresh' | 'expired';
const AGES: HoldAge[] = ['none', 'fresh', 'expired'];
async function setHold(state: string, age: HoldAge) {
  await rm(hold.holdPath(state), { force: true });
  if (age === 'none') return;
  await hold.writeHold(state, '1.1.0');
  if (age === 'expired') await utimes(hold.holdPath(state), old(), old());
}
/**
 * How the web judges a handoff with this hold age and lock: without a hold, an unknown helper rejects; a fresh hold
 * holds; an expired one is kept (invalid) or rejects (unreadable). Either way it is held: never false.
 */
function assertHeld(held: unknown, shape: Shape, age: HoldAge, label: string) {
  if (age === 'fresh' || (age === 'expired' && invalid(shape))) assert.equal(held, true, label);
  else assertUnknown(held, shape, label);
}
/** The real DurableRunManager consuming the judgment: held refuses the owner's worker restart; no worker is asked anything. */
async function assertWebHolds(state: string, label: string) {
  const web = new DurableRunManager({ stateDir: state, version: '99.0.0', handoffHeld: () => handoffHeld(state) });
  const refused = await outcome(web.restartWorker());
  assert.ok(refused instanceof TowerError && refused.kind === 'conflict', `${label}: ${String(refused)}`);
}

// ---- 1. The common judgment ----

test('1. the common helper judgment: absent or gone is no helper, running is one; invalid or unreadable is a typed unknown, never false', async t => {
  const state = await stateDir(t);
  const { lock } = updatePaths(state);
  assert.equal(typeof update.helperRunning, 'function', 'the judgment every consumer takes is exported');
  assert.equal(await update.helperRunning(state), false, 'absent');
  await writeFile(lock, String(deadPid()));
  assert.equal(await update.helperRunning(state), false, 'gone');
  await writeFile(lock, `${process.pid} Thu Jan  1 00:00:00 1970`);
  assert.equal(await update.helperRunning(state), false, 'its pid now belongs to a process started later: gone');
  await writeFile(lock, `${process.pid} ${await processStart(process.pid)}`);
  assert.equal(await update.helperRunning(state), true, 'running');
  await writeFile(lock, String(process.pid));
  assert.equal(await update.helperRunning(state), true, 'a live pid without a start time');
  for (const shape of SHAPES) {
    const other = await stateDir(t);
    await unknownLock(other, shape);
    const before = await snapshot(other);
    const error = await outcome(update.helperRunning(other));
    assertUnknown(error, shape, `lock ${JSON.stringify(shape)}`);
    if (invalid(shape)) assert.match(error.reason, /names no process/);
    assert.match(error.message, new RegExp(updatePaths(other).lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the lock for the owner');
    assert.deepEqual(await snapshot(other), before, `${shape}: reading changes nothing`);
  }
});

// ---- 2. Recovery: nothing written on an unknown helper ----

test('2. recovery beside an unknown helper (resume or previous version, no hold, its own or another version\'s): rejects; hold, record and lock untouched, nothing started', async t => {
  for (const shape of SHAPES) {
    for (const [web, stage] of [['1.1.0', 'verifying'], ['1.0.0', 'verifying'], ['1.0.0', 'failed']] as const) {
      for (const holder of [undefined, '1.1.0', '2.0.0']) {
        const label = `${shape} / web ${web} / ${stage} / hold ${holder ?? 'none'}`;
        const state = await stateDir(t);
        await save(state, record(stage, stage === 'failed' ? { code: 'start-failed', failedStage: 'verifying' } : {}));
        if (holder) await hold.writeHold(state, holder);
        await unknownLock(state, shape);
        const before = await snapshot(state);
        const spawned: Array<[string, boolean]> = [];
        const result = await outcome(new Updates({ stateDir: state, version: web, port: 1, managed: true, spawnHelper: (version, resume) => spawned.push([version, resume]) }).recover());
        assertUnknown(result, shape, label);
        assert.deepEqual(spawned, [], `${label}: no helper`);
        assert.deepEqual(await snapshot(state), before, `${label}: no hold written, refreshed or removed; no record saved; the lock left`);
      }
    }
  }
});

// ---- 3. The handoff: held whatever the record and the hold say ----

test('3. handoff beside an unknown helper, for every record (active, terminal, absent, invalid, unreadable) and hold age: held, nothing changed', async t => {
  quiet(t);
  for (const shape of SHAPES) {
    for (const kind of RECORDS) {
      for (const age of AGES) {
        const label = `${shape} / record ${kind} / hold ${age}`;
        const state = await stateDir(t);
        await setRecord(state, kind);
        await setHold(state, age);
        await unknownLock(state, shape);
        const before = await snapshot(state);
        assertHeld(await outcome(handoffHeld(state)), shape, age, label);
        await assertWebHolds(state, label);
        assert.deepEqual(await snapshot(state), before, label);
      }
    }
  }
});

/** The released helper as its own process, paused in its install with its real lock published. Never killed: released. */
async function liveLegacyHelper(t: TestContext, state: string) {
  const script = fileURLToPath(new URL('./fixtures/legacy-helper-child.ts', import.meta.url));
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', script, state, '1.1.0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += String(chunk); });
  child.stderr.on('data', chunk => { out += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  let released = false;
  const release = () => { if (!released && child.exitCode === null) { released = true; child.stdin.write('release\n'); } };
  t.after(async () => { release(); await exited; });
  const deadline = Date.now() + 20_000;
  while (!out.includes('install-paused')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the helper did not reach its install: ${out}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { child, release, exited, output: () => out };
}

test('3. a live released helper beside an invalid or unreadable lock, any record and hold age: held, recovery and requests change nothing, and it finishes on its own', async t => {
  quiet(t);
  const state = await stateDir(t);
  const { lock, status } = updatePaths(state);
  await setRecord(state, 'active', new Date().toISOString());
  const helper = await liveLegacyHelper(t, state);
  const published = await readFile(lock);
  assert.equal(Number(published.toString().split(' ')[0]), helper.child.pid, 'the helper published its own lock');
  const activeRecord = await readFile(status);
  let observed = 0;
  try {
    for (const shape of ['not a lock', 'folder'] as const) {
      for (const kind of RECORDS) {
        for (const age of AGES) {
          const label = `live helper / ${shape} / record ${kind} / hold ${age}`;
          await rm(lock, { recursive: true, force: true });
          await unknownLock(state, shape);
          await setRecord(state, kind, new Date().toISOString());
          await setHold(state, age);
          const before = await snapshot(state);
          assertHeld(await outcome(handoffHeld(state)), shape, age, label);
          await assertWebHolds(state, label);
          const spawned: string[] = [];
          for (const web of ['1.1.0', '1.0.0']) {
            const recovered = await outcome(new Updates({ stateDir: state, version: web, port: 1, managed: true, spawnHelper: version => spawned.push(version) }).recover());
            if (kind === 'active' || kind === 'terminal') assertUnknown(recovered, shape, `${label} / recover ${web}`);
            else assert.equal(recovered, undefined, `${label} / recover ${web}: a record it cannot settle is left`);
          }
          const answer = await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: version => spawned.push(version) }).request('1.2.0');
          const expected = { active: 'busy', terminal: 'helper-lock-unknown', absent: 'helper-lock-unknown', invalid: 'busy', unreadable: 'update-status-unreadable' }[kind];
          assert.deepEqual([answer.status, answer.body.code], [409, expected], `${label}: ${JSON.stringify(answer.body)}`);
          assert.deepEqual(spawned, [], label);
          assert.deepEqual(await snapshot(state), before, label);
          assert.equal(helper.child.exitCode, null, `${label}: the helper still runs`);
          observed++;
        }
      }
    }
  } finally {
    // Its own lock and record back as it left them; then it is let go, never killed.
    await rm(lock, { recursive: true, force: true });
    await writeFile(lock, published, { mode: 0o600 });
    await rm(status, { recursive: true, force: true });
    await writeFile(status, activeRecord, { mode: 0o600 });
    await rm(hold.holdPath(state), { force: true });
    helper.release();
  }
  assert.equal(observed, 30);
  assert.equal(await helper.exited, 0, helper.output());
  assert.match(helper.output(), /"event":"finished","stage":"failed","code":"install-failed"/);
  assert.equal(JSON.parse(await readFile(status, 'utf8')).code, 'install-failed', 'the helper wrote its own outcome');
  await assert.rejects(lstat(lock), { code: 'ENOENT' }, 'and removed its own lock');
});

test('3. no hold because writing it failed (stale breaker, busy turn) or a released web removed it: an unknown helper still holds', async t => {
  quiet(t);
  // A stale breaker: the hold cannot be written, and the handoff is held regardless.
  {
    const state = await stateDir(t);
    await setRecord(state, 'active');
    await unknownLock(state, 'not a lock');
    const owner = (role: 'lock' | 'breaker') => JSON.stringify({ format: 'tower-transition-owner', version: 1, role, pid: deadPid(), start: 'gone', nonce: '0123456789abcdef0123' });
    writeFileSync(transitionLockPath(state), owner('lock'), { mode: 0o600 });
    writeFileSync(transitionBreakerPath(state), owner('breaker'), { mode: 0o600 });
    await assert.rejects(hold.writeHold(state, '1.1.0'), { code: 'transition-lock-stale-breaker' });
    const before = await snapshot(state);
    assertHeld(await outcome(handoffHeld(state)), 'not a lock', 'none', 'stale breaker');
    assert.deepEqual(await snapshot(state), before, 'stale breaker: the breaker, lock and record are left');
  }
  // Another process keeps the turn: the judgment does not wait for it, and holds at once.
  {
    const state = await stateDir(t);
    await setRecord(state, 'active');
    await unknownLock(state, 'folder');
    const marks = join(state, 'marks');
    appendFileSync(marks, '');
    const script = fileURLToPath(new URL('./fixtures/hold-child.ts', import.meta.url));
    const other = spawn(process.execPath, ['--import', 'tsx', script, state, marks, 'turn', '1.1.0', '1500'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise<number | null>(resolve => other.on('close', code => resolve(code)));
    t.after(() => done);
    const deadline = Date.now() + 20_000;
    while (!readFileSync(marks, 'utf8').includes('enter')) { if (Date.now() > deadline) throw new Error('the other process never took the turn'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const started = Date.now();
    assertHeld(await outcome(handoffHeld(state)), 'folder', 'none', 'busy turn');
    assert.ok(Date.now() - started < 1000, 'held without waiting for the turn');
    assert.equal(await done, 0);
    assert.equal(await handoffHeld(state), true, 'the other process\'s hold, written in its turn, holds once it is there');
  }
  // A released web (1.114.1) settling a finished update removes the hold directly: still held.
  {
    const state = await stateDir(t);
    await setRecord(state, 'terminal');
    await setHold(state, 'fresh');
    await unknownLock(state, 'not a lock');
    await new LegacyUpdates({ stateDir: state, version: '1.0.0', port: 1, managed: true }).recover();
    await assert.rejects(lstat(hold.holdPath(state)), { code: 'ENOENT' }, 'the released web removed the hold');
    const before = await snapshot(state);
    assertHeld(await outcome(handoffHeld(state)), 'not a lock', 'none', 'after the released web removed the hold');
    await assertWebHolds(state, 'after the released web removed the hold');
    assert.deepEqual(await snapshot(state), before);
  }
});

test('3 memory hook. writing the hold fails with an I/O error: no hold, and an unknown helper still holds', async t => {
  quiet(t);
  const state = await stateDir(t);
  await setRecord(state, 'active');
  await unknownLock(state, 'dangling');
  const path = hold.holdPath(state);
  const original = fsPromises.link;
  t.mock.method(fsPromises, 'link', async (...args: Parameters<typeof original>) => {
    if (args[1] === path) throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' });
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(hold.writeHold(state, '1.1.0'), { code: 'EIO' }); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  quiet(t);
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assertHeld(await outcome(handoffHeld(state)), 'dangling', 'none', 'after the I/O error');
});

test('3. a worker that must start while the helper is unknown: the previous version\'s when one is recorded and installed; otherwise the unknown, never undefined', async t => {
  quiet(t);
  for (const shape of ['not a lock', 'fifo'] as const) {
    const state = await stateDir(t);
    const entry = entryPoint(versionDirectory(state, '1.0.0'));
    await mkdir(join(entry, '..'), { recursive: true });
    await writeFile(entry, '');
    await unknownLock(state, shape);
    await setRecord(state, 'active');
    assert.equal(await heldWorkerEntry(state), entry, `${shape}: active update, previous installed`);
    for (const kind of ['terminal', 'absent', 'invalid', 'unreadable'] as const) {
      await setRecord(state, kind);
      assertUnknown(await outcome(heldWorkerEntry(state)), shape, `${shape} / record ${kind}`);
    }
    await setRecord(state, 'active');
    await rm(entry);
    assertUnknown(await outcome(heldWorkerEntry(state)), shape, `${shape}: the previous version is not installed`);
  }
});

// ---- 4. The helper itself: no takeover ----

test('4. a helper (new or resumed) beside an unknown lock: rejects before any step; the lock, record and hold untouched; its own temporary gone', async t => {
  for (const shape of SHAPES) {
    for (const resume of [false, true]) {
      const label = `${shape} / ${resume ? 'resume' : 'new'}`;
      const state = await stateDir(t);
      const { lock } = updatePaths(state);
      await save(state, record(resume ? 'verifying' : 'installing'));
      if (resume) await hold.writeHold(state, '1.1.0');
      await unknownLock(state, shape);
      const before = await snapshot(state);
      const calls: string[] = [];
      const steps = new Proxy({} as UpdateHelperSteps, { get: (_, name) => () => { calls.push(String(name)); throw new Error(`unexpected step ${String(name)}`); } });
      // Test-only: which files this helper writes (its own lock's temporary is the only one it may).
      const written: string[] = [];
      const original = fsPromises.writeFile;
      t.mock.method(fsPromises, 'writeFile', async (...args: Parameters<typeof original>) => { written.push(String(args[0])); return original(...args); });
      syncBuiltinESMExports();
      let result: unknown;
      try { result = await outcome(runUpdateHelper(state, '1.1.0', steps, resume)); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
      assertUnknown(result, shape, label);
      assert.deepEqual(calls, [], `${label}: no step`);
      assert.deepEqual(written, [`${lock}.${process.pid}`], `${label}: only its own lock's temporary was written`);
      assert.deepEqual(await snapshot(state), before, `${label}: the lock (inode, mtime), record and hold are as they were; no temporary is left`);
    }
  }
});

// ---- 5. Requests: nothing saved or started on an unknown helper ----

test('5. a request beside an unknown helper: refused before anything is saved or started; early answers and an update under way answer as before', async t => {
  for (const shape of SHAPES) {
    const cases: Array<[string, (state: string) => Promise<void>, string, number, string | undefined]> = [
      ['absent record', async () => {}, '1.1.0', 409, 'helper-lock-unknown'],
      ['finished record with storage and hold notes, its hold kept', async state => {
        await save(state, record('failed', { code: 'check-failed', failedStage: 'checking', storage: { code: 'contract-unverifiable' }, hold: { code: 'hold-owned-elsewhere', reason: 'kept', at } }));
        await hold.writeHold(state, '1.1.0');
      }, '1.1.0', 409, 'helper-lock-unknown'],
      ['the target needs its preparation release (an early answer)', async state => {
        await save(state, record('failed', { code: 'check-failed', failedStage: 'checking', storage: { code: 'prerequisite-required', prepare: '1.0.5' } }));
      }, '1.1.0', 409, 'prerequisite-required'],
      ['an update whose helper never answered, the same target', async state => { await save(state, record('verifying')); }, '1.1.0', 202, undefined],
      ['an update whose helper never answered, another target', async state => { await save(state, record('verifying')); }, '1.2.0', 409, 'busy'],
      ['a record this build does not understand', async state => { await save(state, '{'); }, '1.1.0', 409, 'busy'],
    ];
    for (const [name, arrange, target, status, code] of cases) {
      const label = `${shape} / ${name} / ${target}`;
      const state = await stateDir(t);
      await arrange(state);
      await unknownLock(state, shape);
      const before = await snapshot(state);
      const spawned: string[] = [];
      const updates = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: version => spawned.push(version), now: () => Date.parse(at) + 60 * 60_000 });
      const answer = await updates.request(target);
      assert.deepEqual([answer.status, answer.body.code], [status, code], `${label}: ${JSON.stringify(answer.body)}`);
      if (code === 'helper-lock-unknown' || name.startsWith('a record')) assert.ok(answer.body.error?.includes(updatePaths(state).lock) && answer.body.error.includes(invalid(shape) ? 'names no process' : codeOf(shape)), `${label}: the cause is told: ${answer.body.error}`);
      if (status === 202) assert.equal(answer.body.update?.startedAt, at, `${label}: the update under way, not a new one`);
      assert.deepEqual(spawned, [], `${label}: no helper`);
      assert.deepEqual(await snapshot(state), before, `${label}: record, notes and hold kept`);
    }
  }
});

// ---- 6. Status, the scheduler and pruning, through the real Updates ----

test('6. status, the automatic update and pruning beside an unknown helper: not interrupted, not retried, nothing saved, started or removed', async t => {
  for (const shape of SHAPES) {
    for (const kind of ['active', 'done', 'absent'] as const) {
      const label = `${shape} / ${kind}`;
      const state = await stateDir(t);
      await mkdir(versionDirectory(state, '0.9.0'), { recursive: true });
      if (kind === 'active') await save(state, record('verifying'));
      if (kind === 'done') await save(state, { version: '1.0.0', previous: '0.9.0', stage: 'done', startedAt: at, updatedAt: at });
      await unknownLock(state, shape);
      const before = await snapshot(state);
      const spawned: string[] = [];
      const updates = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: version => spawned.push(version), now: () => Date.parse(at) + 60 * 60_000 });
      const seen = await updates.status();
      if (kind === 'active') assert.deepEqual([seen?.stage, seen?.code], ['verifying', undefined], `${label}: not reported interrupted`);
      const answers: Array<{ status: number; code?: string }> = [];
      const scheduler = new TowerAutoUpdate({
        stateDir: state, version: '1.0.0', enabled: true, controllers: () => 0, latest: async () => ({ version: '1.1.0', checkedAt: at, source: 'api' }),
        updates: { managed: true, status: () => updates.status(), request: async version => { const answer = await updates.request(version); answers.push({ status: answer.status, code: answer.body.code }); return answer; } },
      });
      await scheduler.check();
      if (kind === 'active') assert.deepEqual(answers, [], `${label}: an update that may be under way is neither retried nor replaced`);
      else assert.deepEqual(answers, [{ status: 409, code: 'helper-lock-unknown' }], `${label}: the scheduler may ask; the request is refused`);
      const pruned = await outcome(updates.prune(async () => []));
      // An update under way already keeps everything, before the helper is looked at.
      if (kind === 'active') assert.equal(pruned, undefined, `${label}: prune`);
      else assertUnknown(pruned, shape, `${label}: prune`);
      assert.deepEqual(spawned, [], label);
      assert.deepEqual(await snapshot(state), before, `${label}: no record, retry schedule or version changed`);
    }
  }
});

// ---- 7. What is known keeps its policy ----

test('7. a known helper keeps its policy: absent or gone hands over and is taken over; running holds only with a hold; an expired hold goes only as judged', async t => {
  const own = `${process.pid} ${await processStart(process.pid)}`;
  for (const [lock, nohold, fresh, expired] of [[undefined, false, true, false], ['gone', false, true, false], [own, false, true, true]] as const) {
    const label = lock === undefined ? 'absent' : lock === 'gone' ? 'gone' : 'running';
    const state = await stateDir(t);
    if (lock) await writeFile(updatePaths(state).lock, lock === 'gone' ? String(deadPid()) : lock);
    assert.equal(await handoffHeld(state), nohold, `${label}: no hold`);
    await setHold(state, 'fresh');
    assert.equal(await handoffHeld(state), fresh, `${label}: a fresh hold`);
    await setHold(state, 'expired');
    const judged = await hold.observeHold(state);
    assert.equal(await handoffHeld(state), expired, `${label}: an expired hold`);
    const after = await hold.observeHold(state);
    if (expired) {
      assert.ok(judged.state === 'present' && after.state === 'present', label);
      assert.deepEqual(after.generation, judged.generation, `${label}: kept as it was`);
    } else await assert.rejects(lstat(hold.holdPath(state)), { code: 'ENOENT' }, `${label}: the judged generation went`);
  }
  // Recovery with no helper resumes with a fresh hold; a request starts one.
  for (const lock of [undefined, 'gone'] as const) {
    const state = await stateDir(t);
    await save(state, record('verifying'));
    if (lock) await writeFile(updatePaths(state).lock, String(deadPid()));
    const spawned: Array<[string, boolean]> = [];
    await new Updates({ stateDir: state, version: '1.1.0', port: 1, managed: true, spawnHelper: (version, resume) => spawned.push([version, resume]) }).recover();
    assert.deepEqual(spawned, [['1.1.0', true]], `${lock ?? 'absent'}: resumed`);
    assert.equal(await handoffHeld(state), true);
    await rm(updatePaths(state).status);
    const requests: string[] = [];
    const answer = await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: version => requests.push(version) }).request('1.2.0');
    assert.deepEqual([answer.status, requests], [202, ['1.2.0']], `${lock ?? 'absent'}: a request starts a helper`);
  }
  // A worker that must start with no hold and no helper is this build's (undefined), as before.
  const state = await stateDir(t);
  await setRecord(state, 'active');
  assert.equal(await heldWorkerEntry(state), undefined);
});
