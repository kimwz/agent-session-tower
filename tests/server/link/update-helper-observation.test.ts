import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TowerError } from '../../../shared/errors.js';
import { processStart } from '../../../server/instance/process-start.js';
import { entryPoint, pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import * as hold from '../../../server/link/storage-hold.js';
import { evaluateStorageUpdate, readHelperLock, type HelperRead } from '../../../server/link/storage-update.js';
import * as update from '../../../server/link/update.js';
import { handoffHeld, heldWorkerEntry, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { TowerAutoUpdate } from '../../../server/updates/tower.js';
import { A, B, installArtifact, runningBuild } from './fixtures/storage-builds.js';

/**
 * W0U correction 5 (w0-update-fix4-review.txt, required 1): whether a helper lock's owner runs is observed, never
 * assumed. Only the system's own ESRCH says gone; EPERM still says running. A pid the system cannot be asked about
 * (outside what process.kill takes: 2^31 and up) is a lock naming no process it can have (`invalid`), and any other
 * failure to observe the pid or its start time is the observation's own typed unknown (`unreadable`, its error
 * kept): never gone, never false. Out-of-range pids go through Node's real process.kill. EIO/EINVAL/a generic error
 * are a memory hook on process.kill (named so); no other process is ever sent a signal, only signal 0 asked.
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-helper-observe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(versionDirectory(directory, '1.0.0'), { recursive: true });
  await pointCurrent(directory, '1.0.0');
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (stage: string, extra: Record<string, unknown> = {}) => ({ version: '1.1.0', previous: '1.0.0', stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
/** A pid no process has: a child that already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const old = () => new Date(Date.now() - 60 * 60_000);
const quiet = (t: TestContext) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };
const outcome = <T>(promise: Promise<T>) => promise.then(value => value, (error: unknown) => error);
const errno = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}, kill`), { code, syscall: 'kill' });

// ---- The new inputs ----

interface Shape {
  name: string;
  /** How the common judgment reports it, and the code its rejection carries. */
  helper: 'invalid' | 'unreadable';
  code: string;
  /** Written as the lock's bytes (a pid outside the range, through the real process.kill). */
  text?: string;
  /** Memory hook: what process.kill(pid, 0) throws for the lock's own pid (a pid already gone). */
  error?: () => unknown;
}
const SHAPES: Shape[] = [
  { name: 'pid 2^31 (real process.kill)', helper: 'invalid', code: 'helper-lock-invalid', text: '2147483648' },
  { name: 'pid MAX_SAFE_INTEGER with a start time (real process.kill)', helper: 'invalid', code: 'helper-lock-invalid', text: `${Number.MAX_SAFE_INTEGER} Thu Oct  8 00:00:00 2026` },
  { name: 'EIO (memory hook)', helper: 'unreadable', code: 'EIO', error: () => errno('EIO', 'i/o error') },
  { name: 'EINVAL (memory hook)', helper: 'unreadable', code: 'EINVAL', error: () => errno('EINVAL', 'invalid argument') },
  { name: 'a generic error (memory hook)', helper: 'unreadable', code: 'EUNKNOWN', error: () => new Error('the system could not be asked') },
];

/** Memory hook state: the pids whose observation throws, what each call asked, and any signal but 0 (never sent). */
const failing = new Map<number, unknown>();
const asked = new Map<number, number>();
const otherSignals: unknown[] = [];
/**
 * Hooks process.kill for this test: a pid in `failing` throws its error for signal 0; every other signal 0 goes to the
 * real process.kill (Node's own argument check included). Any other signal is recorded and never sent.
 */
function hookKill(t: TestContext) {
  const real = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (signal !== 0) { otherSignals.push([pid, signal]); throw new Error(`test: signal ${String(signal)} is never sent`); }
    asked.set(pid, (asked.get(pid) ?? 0) + 1);
    if (failing.has(pid)) throw failing.get(pid);
    return real(pid, 0);
  });
  t.after(() => assert.deepEqual(otherSignals, [], 'only signal 0 was ever asked'));
}

/** Writes the shape's lock; for a hooked shape, returns the very error its observation throws. */
async function unknownLock(state: string, shape: Shape): Promise<unknown> {
  const { lock } = updatePaths(state);
  if (shape.text) { await writeFile(lock, shape.text, { mode: 0o600 }); return undefined; }
  const pid = deadPid();
  const error = shape.error!();
  failing.set(pid, error);
  await writeFile(lock, String(pid), { mode: 0o600 });
  return error;
}
const lockPid = async (state: string) => Number((await readFile(updatePaths(state).lock, 'utf8')).split(' ')[0]);

/** A rejection as the common judgment makes it: typed, with its cause (the observation's own error) or its reason (the pid). */
async function assertUnknown(error: unknown, shape: Shape, state: string, cause: unknown, label: string) {
  assert.ok(error instanceof update.HelperLockUnknownError, `${label}: ${error instanceof Error ? error.stack : String(error)}`);
  assert.equal(error.code, shape.code, label);
  assert.equal(error.helper, shape.helper, label);
  assert.ok(error.message.includes(updatePaths(state).lock), `${label}: it names the lock: ${error.message}`);
  if (shape.helper === 'unreadable') assert.equal(error.cause, cause, `${label}: the observation's own error is kept`);
  else assert.ok(error.reason.includes(shape.text!.split(' ')[0]), `${label}: the pid is told: ${error.reason}`);
}

/** Everything in the runtime folder as it is: kind, inode, size, mtime and ctime (ns), and the bytes, link target or entries. */
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
async function setRecord(state: string, kind: RecordKind) {
  const { status } = updatePaths(state);
  await rm(status, { recursive: true, force: true });
  if (kind === 'active') await save(state, record('installing'));
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

// ---- 0. What Node itself does, without any hook ----

test('0. Node\'s real process.kill refuses a pid of 2^31 and up before the system is asked; 2^31-1 is asked, and no process has it', () => {
  for (const pid of [2 ** 31, Number.MAX_SAFE_INTEGER]) assert.throws(() => process.kill(pid, 0), { code: 'ERR_INVALID_ARG_TYPE' }, String(pid));
  assert.throws(() => process.kill(2 ** 31 - 1, 0), { code: 'ESRCH' }, 'the largest pid it takes is asked of the system');
});

// ---- 1. The raw observation and the common judgment ----

test('1. readHelperLock observes: only ESRCH is gone, EPERM is running, a pid out of range is invalid, any other failure is a typed unknown with its error', async t => {
  hookKill(t);
  const state = await stateDir(t);
  const { lock } = updatePaths(state);
  // Out of range, through the real process.kill: never gone.
  for (const shape of SHAPES.filter(shape => shape.text)) {
    await writeFile(lock, shape.text!);
    const before = await snapshot(state);
    const read = await readHelperLock(state);
    assert.equal(read.state, 'invalid', `${shape.name}: ${JSON.stringify(read)}`);
    assert.ok(read.state === 'invalid' && read.reason.includes(shape.text!.split(' ')[0]), shape.name);
    await assertUnknown(await outcome(update.helperRunning(state)), shape, state, undefined, shape.name);
    assert.deepEqual(await snapshot(state), before, `${shape.name}: reading changes nothing`);
  }
  // The largest pid process.kill takes is asked of the system, which has none: gone, as before.
  await writeFile(lock, String(2 ** 31 - 1));
  assert.deepEqual(await readHelperLock(state), { state: 'gone', pid: 2 ** 31 - 1 });
  // What names no process stays as it was.
  for (const text of ['not a lock', '0', '1.5', '-3']) {
    await writeFile(lock, text);
    const read = await readHelperLock(state);
    assert.ok(read.state === 'invalid' && /names no process/.test(read.reason), `${text}: ${JSON.stringify(read)}`);
  }
  // Observation failures (memory hook): the observation's own error, never gone.
  for (const shape of SHAPES.filter(shape => shape.error)) {
    const other = await stateDir(t);
    const thrown = await unknownLock(other, shape);
    const pid = await lockPid(other);
    const before = await snapshot(other);
    const read = await readHelperLock(other);
    assert.equal(read.state, 'unreadable', `${shape.name}: ${JSON.stringify(read)}`);
    assert.ok(read.state === 'unreadable' && read.error === thrown, `${shape.name}: the error itself is kept`);
    assert.ok((asked.get(pid) ?? 0) > 0, `${shape.name}: the system was asked through the hook`);
    await assertUnknown(await outcome(update.helperRunning(other)), shape, other, thrown, shape.name);
    assert.deepEqual(await snapshot(other), before, `${shape.name}: reading changes nothing`);
  }
  // The known answers keep their policy: ESRCH (real, and hooked) is gone, EPERM (real pid 1, and hooked) is running.
  const dead = deadPid();
  await writeFile(lock, String(dead));
  assert.deepEqual(await readHelperLock(state), { state: 'gone', pid: dead }, 'real ESRCH');
  const hookedGone = deadPid();
  failing.set(hookedGone, errno('ESRCH', 'no such process'));
  await writeFile(lock, String(hookedGone));
  assert.deepEqual(await readHelperLock(state), { state: 'gone', pid: hookedGone }, 'hooked ESRCH');
  const hookedDenied = deadPid();
  failing.set(hookedDenied, errno('EPERM', 'operation not permitted'));
  await writeFile(lock, String(hookedDenied));
  assert.deepEqual(await readHelperLock(state), { state: 'running', pid: hookedDenied }, 'hooked EPERM: a process of another user runs');
  const launchd = (() => { try { process.kill(1, 0); return 'answered'; } catch (error) { return (error as NodeJS.ErrnoException).code; } })();
  await writeFile(lock, '1');
  assert.deepEqual(await readHelperLock(state), { state: 'running', pid: 1 }, `real pid 1 (${launchd})`);
});

test('1. the start time of a live pid: undefined is running, another start is gone, the same is running; a failure to tell it is a typed unknown with its error', async t => {
  const state = await stateDir(t);
  const { lock } = updatePaths(state);
  const own = await processStart(process.pid);
  await writeFile(lock, `${process.pid} ${own}`);
  const calls: number[] = [];
  const started = (answer: () => Promise<string | undefined>) => (pid: number) => { calls.push(pid); return answer(); };
  assert.deepEqual(await readHelperLock(state, started(async () => undefined)), { state: 'running', pid: process.pid }, 'a start that cannot be told counts as running');
  assert.deepEqual(await readHelperLock(state, started(async () => 'Thu Jan  1 00:00:00 1970')), { state: 'gone', pid: process.pid }, 'its pid now belongs to a process started later');
  assert.deepEqual(await readHelperLock(state, started(async () => own)), { state: 'running', pid: process.pid }, 'the same process');
  const failures: Array<[string, unknown, (pid: number) => Promise<string | undefined>]> = [];
  const thrown = errno('EIO', 'i/o error');
  failures.push(['throws', thrown, () => { throw thrown; }]);
  const rejected = new Error('ps could not run');
  failures.push(['rejects', rejected, async () => { throw rejected; }]);
  for (const [name, error, observe] of failures) {
    const before = await snapshot(state);
    const read = await outcome(readHelperLock(state, observe)) as HelperRead | Error;
    assert.ok(!(read instanceof Error) && read.state === 'unreadable', `${name}: ${read instanceof Error ? read.stack : JSON.stringify(read)}`);
    assert.ok(read.state === 'unreadable' && read.error === error, `${name}: the error itself is kept`);
    assert.deepEqual(await snapshot(state), before, name);
  }
  // A lock without a start time is never asked for one.
  await writeFile(lock, String(process.pid));
  calls.length = 0;
  assert.deepEqual(await readHelperLock(state, started(async () => { throw new Error('not asked'); })), { state: 'running', pid: process.pid });
  assert.deepEqual(calls, [], 'no start time asked');
});

// ---- 2. Recovery ----

test('2. recovery beside a pid out of range or an observation failure (resume or previous version, any hold): rejects; nothing written, removed or started', async t => {
  hookKill(t);
  for (const shape of SHAPES) {
    for (const [web, stage] of [['1.1.0', 'verifying'], ['1.0.0', 'verifying'], ['1.0.0', 'failed']] as const) {
      for (const holder of [undefined, '1.1.0', '2.0.0']) {
        const label = `${shape.name} / web ${web} / ${stage} / hold ${holder ?? 'none'}`;
        const state = await stateDir(t);
        await save(state, record(stage, stage === 'failed' ? { code: 'start-failed', failedStage: 'verifying' } : {}));
        if (holder) await hold.writeHold(state, holder);
        const cause = await unknownLock(state, shape);
        const before = await snapshot(state);
        const spawned: Array<[string, boolean]> = [];
        const result = await outcome(new Updates({ stateDir: state, version: web, port: 1, managed: true, spawnHelper: (version, resume) => spawned.push([version, resume]) }).recover());
        await assertUnknown(result, shape, state, cause, label);
        assert.deepEqual(spawned, [], `${label}: no helper`);
        assert.deepEqual(await snapshot(state), before, `${label}: no hold written, refreshed or removed; no record saved; the lock left`);
      }
    }
  }
});

// ---- 3. The handoff ----

test('3. handoff beside a pid out of range or an observation failure, for every record and hold age: held, nothing changed; a worker to start is the previous one or the unknown', async t => {
  quiet(t);
  hookKill(t);
  for (const shape of SHAPES) {
    for (const kind of RECORDS) {
      for (const age of AGES) {
        const label = `${shape.name} / record ${kind} / hold ${age}`;
        const state = await stateDir(t);
        await setRecord(state, kind);
        await setHold(state, age);
        const cause = await unknownLock(state, shape);
        const before = await snapshot(state);
        const held = await outcome(handoffHeld(state));
        // A fresh hold holds; an expired one is kept beside a pid that names no process, and rejects on a failed observation.
        if (age === 'fresh' || (age === 'expired' && shape.helper === 'invalid')) assert.equal(held, true, label);
        else await assertUnknown(held, shape, state, cause, label);
        const web = new DurableRunManager({ stateDir: state, version: '99.0.0', handoffHeld: () => handoffHeld(state) });
        const refused = await outcome(web.restartWorker());
        assert.ok(refused instanceof TowerError && refused.kind === 'conflict', `${label}: the worker is not handed over: ${String(refused)}`);
        assert.deepEqual(await snapshot(state), before, `${label}: the hold generation, record and lock are as they were`);
      }
    }
    const state = await stateDir(t);
    const entry = entryPoint(versionDirectory(state, '1.0.0'));
    await mkdir(join(entry, '..'), { recursive: true });
    await writeFile(entry, '');
    const cause = await unknownLock(state, shape);
    await setRecord(state, 'active');
    assert.equal(await heldWorkerEntry(state), entry, `${shape.name}: active update, previous installed`);
    await setRecord(state, 'terminal');
    await assertUnknown(await outcome(heldWorkerEntry(state)), shape, state, cause, `${shape.name}: no previous to start: the unknown, never undefined`);
  }
});

// ---- 4. The helper itself ----

test('4. a helper (new or resumed) beside a pid out of range or an observation failure: rejects before any step; nothing taken over; its own temporary gone', async t => {
  hookKill(t);
  for (const shape of SHAPES) {
    for (const resume of [false, true]) {
      const label = `${shape.name} / ${resume ? 'resume' : 'new'}`;
      const state = await stateDir(t);
      const { lock } = updatePaths(state);
      await save(state, record(resume ? 'verifying' : 'installing'));
      if (resume) await hold.writeHold(state, '1.1.0');
      const cause = await unknownLock(state, shape);
      const before = await snapshot(state);
      const calls: string[] = [];
      const steps = new Proxy({} as UpdateHelperSteps, { get: (_, name) => () => { calls.push(String(name)); throw new Error(`unexpected step ${String(name)}`); } });
      // Test-only: which files this helper writes (its own lock's temporary is the only one it may).
      const written: string[] = [];
      const original = fsPromises.writeFile;
      const writes = t.mock.method(fsPromises, 'writeFile', async (...args: Parameters<typeof original>) => { written.push(String(args[0])); return original(...args); });
      syncBuiltinESMExports();
      let result: unknown;
      try { result = await outcome(runUpdateHelper(state, '1.1.0', steps, resume)); } finally { writes.mock.restore(); syncBuiltinESMExports(); }
      await assertUnknown(result, shape, state, cause, label);
      assert.deepEqual(calls, [], `${label}: no step`);
      assert.deepEqual(written, [`${lock}.${process.pid}`], `${label}: only its own lock's temporary was written`);
      assert.deepEqual(await snapshot(state), before, `${label}: the lock (inode, mtime), record and hold are as they were; no temporary is left`);
    }
  }
});

// ---- 5. Requests ----

test('5. a request beside a pid out of range or an observation failure: refused before anything is saved or started; early answers and an update under way answer as before', async t => {
  hookKill(t);
  for (const shape of SHAPES) {
    const cases: Array<[string, (state: string) => Promise<void>, string, number, string | undefined]> = [
      ['absent record', async () => {}, '1.1.0', 409, 'helper-lock-unknown'],
      ['finished record with storage and hold notes, its hold kept', async state => {
        await save(state, record('failed', { code: 'check-failed', failedStage: 'checking', storage: { code: 'contract-unverifiable' }, hold: { code: 'hold-owned-elsewhere', reason: 'kept', at } }));
        await hold.writeHold(state, '1.1.0');
      }, '1.1.0', 409, 'helper-lock-unknown'],
      ['stale active record, another target', async state => { await save(state, record('installing')); }, '1.2.0', 409, 'busy'],
      ['the target needs its preparation release (an early answer)', async state => {
        await save(state, record('failed', { code: 'check-failed', failedStage: 'checking', storage: { code: 'prerequisite-required', prepare: '1.0.5' } }));
      }, '1.1.0', 409, 'prerequisite-required'],
      ['an update whose helper never answered, the same target', async state => { await save(state, record('verifying')); }, '1.1.0', 202, undefined],
      ['a record this build does not understand', async state => { await save(state, '{'); }, '1.1.0', 409, 'busy'],
    ];
    for (const [name, arrange, target, status, code] of cases) {
      const label = `${shape.name} / ${name} / ${target}`;
      const state = await stateDir(t);
      await arrange(state);
      await unknownLock(state, shape);
      const before = await snapshot(state);
      const spawned: string[] = [];
      const updates = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: version => spawned.push(version), now: () => Date.parse(at) + 60 * 60_000 });
      const answer = await updates.request(target);
      assert.deepEqual([answer.status, answer.body.code], [status, code], `${label}: ${JSON.stringify(answer.body)}`);
      const told = shape.helper === 'invalid' ? shape.text!.split(' ')[0] : shape.code;
      if (code === 'helper-lock-unknown' || name.startsWith('a record')) assert.ok(answer.body.error?.includes(updatePaths(state).lock) && answer.body.error.includes(told), `${label}: the cause is told: ${answer.body.error}`);
      if (status === 202) assert.equal(answer.body.update?.startedAt, at, `${label}: the update under way, not a new one`);
      assert.deepEqual(spawned, [], `${label}: no helper`);
      assert.deepEqual(await snapshot(state), before, `${label}: record, notes and hold kept`);
    }
  }
});

// ---- 6. Status, the scheduler and pruning ----

test('6. status, the automatic update and pruning beside a pid out of range or an observation failure: not interrupted, not retried, nothing saved, started or removed', async t => {
  hookKill(t);
  for (const shape of SHAPES) {
    for (const kind of ['active', 'done', 'absent'] as const) {
      const label = `${shape.name} / ${kind}`;
      const state = await stateDir(t);
      await mkdir(versionDirectory(state, '0.9.0'), { recursive: true });
      if (kind === 'active') await save(state, record('verifying'));
      if (kind === 'done') await save(state, { version: '1.0.0', previous: '0.9.0', stage: 'done', startedAt: at, updatedAt: at });
      const cause = await unknownLock(state, shape);
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
      if (kind === 'active') assert.equal(pruned, undefined, `${label}: prune`);
      else await assertUnknown(pruned, shape, state, cause, `${label}: prune`);
      assert.deepEqual(spawned, [], label);
      assert.deepEqual(await snapshot(state), before, `${label}: no record, retry schedule or version changed`);
    }
  }
});

// ---- 7. The storage evaluation reads the same lock ----

test('7. the storage evaluation beside a pid out of range or an observation failure: the helper cannot be told, nothing imported; a gone pid still allows it', async t => {
  hookKill(t);
  const state = await mkdtemp(join(tmpdir(), 'tower-helper-observe-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(runtimePaths(state).versions, { recursive: true });
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, B);
  await writeFile(updatePaths(state).status, JSON.stringify({ version: B, previous: A, stage: 'done', startedAt: at, updatedAt: at }));
  const evaluate = () => evaluateStorageUpdate({ stateDir: state, build: runningBuild(B), managed: true });
  await writeFile(updatePaths(state).lock, String(deadPid()));
  const ready = await evaluate();
  assert.deepEqual([ready.code, ready.importAllowed], ['service-update-done', true], 'gone, as before');
  for (const shape of SHAPES) {
    await rm(updatePaths(state).lock, { force: true });
    await unknownLock(state, shape);
    const evaluation = await evaluate();
    assert.deepEqual([evaluation.verdict, evaluation.code, evaluation.importAllowed], ['recovery-required', 'helper-unreadable', false], `${shape.name}: ${evaluation.reason}`);
    assert.equal(evaluation.evidence.helper.state, shape.helper, shape.name);
    assert.ok(!('error' in evaluation.evidence.helper), `${shape.name}: the evidence carries no error object`);
  }
});
