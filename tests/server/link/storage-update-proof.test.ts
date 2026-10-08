import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStart } from '../../../server/instance/process-start.js';
import { currentVersion, entryPoint, pointCurrent, runtimePaths, storagePinPath, versionDirectory } from '../../../server/link/service.js';
import { HoldError, holdPath, removeHold, writeHold } from '../../../server/link/storage-hold.js';
import { inspectStorageTransition, transitionBreakerPath, transitionLockPath, TransitionLockError, withStorageTransition } from '../../../server/link/storage-transition-lock.js';
import {
  evaluateStorageUpdate, readPreparationEvidence, readRollbackRecord, readStoragePin, recordPreparationEvidence, releaseStoragePin, resumeRollback, runRollback,
  storageUpdatePaths, validateRollback, withdrawRollback, type RollbackContext, type RollbackPorts, type RollbackRecord, type SavedUpdate, type StorageUpdateInput,
} from '../../../server/link/storage-update.js';
import { runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import type { StorageBuildManifest, StorageDomainSchema } from '../../../server/storage/contract.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { A, B, C, changedManifest, installArtifact, openGate, preparedStorage, retentionA, retentionB, runningBuild } from './fixtures/storage-builds.js';
import { rollbackWorld, type WorldOptions } from './fixtures/rollback-world.js';

/**
 * W0U correction 2 (w0u-fix2-invariants.md L1–L6, F1–F6, and the four adopted recommendations of
 * w0u-fix2-contract-adoption-sidecar.md), against the real producer: the transition lock's exclusivity through stale
 * recovery and ended turns (real separate processes included), direct starts on the whole A contract, an operation's
 * actual proof at completion, cleanup and pin release, handoff outcomes judged by the read-only serving proof against a
 * durable baseline, withdrawal and retry fenced by one durable attempt, and the hold's strict writer. The worker side
 * is the fake world of fixtures/rollback-world.ts: what W0I connects to the real worker is not proven here.
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-storage-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (version: string, previous: string, stage: SavedUpdate['stage'], extra: Partial<SavedUpdate> = {}): SavedUpdate => ({ version, previous, stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, JSON.stringify(value));
/** A managed start whose preflight sees the database file the world's worker opened (empty or not). */
const evaluate = (state: string, version: string, extra: Partial<StorageUpdateInput> = {}) =>
  evaluateStorageUpdate({ stateDir: state, build: runningBuild(version, { state: { database: 'present', sidecars: [], identity: 'created', recovery: { state: 'clear' } } }), managed: true, ...extra });
const onDisk = (state: string): RollbackRecord => JSON.parse(readFileSync(storageUpdatePaths(state).rollback, 'utf8'));
const rewrite = (state: string, change: Partial<RollbackRecord>) => writeFile(storageUpdatePaths(state).rollback, JSON.stringify({ ...onDisk(state), ...change }), { mode: 0o600 });
const bytes = (path: string) => readFileSync(path);
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };
const count = (calls: string[], name: string) => calls.filter(call => call === name).length;

async function rollbackState(t: TestContext, options: { update?: boolean } = {}) {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await installArtifact(state, C);
  await pointCurrent(state, B);
  if (options.update !== false) await save(state, record(B, A, 'done'));
  return state;
}
const updatesOn = (state: string, version = B) => new Updates({ stateDir: state, version, port: 1, managed: true, spawnHelper: () => {} });
const onFrom = (state: string, port: RollbackPorts, extra: Partial<RollbackContext> = {}): RollbackContext =>
  ({ stateDir: state, running: runningBuild(B), managed: true, ports: port, serialize: work => updatesOn(state).exclusive(work), ...extra });
const onTarget = (state: string, port: RollbackPorts, extra: Partial<RollbackContext> = {}): RollbackContext =>
  ({ stateDir: state, running: runningBuild(A), managed: true, ports: port, serialize: work => work(), ...extra });
const ask = (context: RollbackContext, target = A) => runRollback(context, { target, by: 'owner', reason: 'B misbehaves' });
const pending = async () => ({ state: 'pending' as const, reason: 'a turn runs' });
/** A world whose rollback has switched to A (the target's web goes on from there). */
async function switched(t: TestContext, options: WorldOptions = {}) {
  const state = await rollbackState(t);
  const world = rollbackWorld(options);
  assert.equal((await ask(onFrom(state, world.ports))).state, 'switched');
  return { state, world };
}
/** A rollback completed with its admission hold still to release (the release did not answer). */
async function completedHeld(t: TestContext, options: WorldOptions = {}) {
  const { state, world } = await switched(t, options);
  const release = world.ports.releaseAdmission;
  let refuse = true;
  world.ports.releaseAdmission = async fence => { if (refuse) { world.calls.push('release'); throw new Error('the worker did not answer'); } return release(fence); };
  const outcome = await resumeRollback(onTarget(state, world.ports));
  assert.ok(outcome.state === 'completed' && outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  return { state, world, answer: () => { refuse = false; } };
}

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
  const marks = join(state, 'marks');
  appendFileSync(marks, '');
  const script = fileURLToPath(new URL('./fixtures/transition-child.ts', import.meta.url));
  const children = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, state, marks, '150'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return new Promise<{ code: number | null; out: string }>(resolve => child.on('close', code => resolve({ code, out })));
  });
  const exits = await Promise.all(children);
  assert.deepEqual(exits.map(exit => exit.code), [0, 0, 0, 0], exits.map(exit => exit.out).join(' '));
  let inside = 0;
  let most = 0;
  const lines = readFileSync(marks, 'utf8').trim().split('\n');
  for (const line of lines) { inside += line.startsWith('enter') ? 1 : -1; most = Math.max(most, inside); }
  assert.deepEqual([most, lines.filter(line => line.startsWith('enter')).length, inside], [1, 4, 0], lines.join(' | '));
  assert.deepEqual([existsSync(transitionLockPath(state)), existsSync(transitionBreakerPath(state))], [false, false]);
});

// ---- F2. Direct starts on the whole A contract ----

const triggersA: StorageDomainSchema = { domain: 'triggers', migrations: [{ version: 1, sql: 'CREATE TABLE trigger_items (id TEXT PRIMARY KEY) STRICT;' }], preparation: { requiredArtifactVersion: A, readerContract: 1, writerContract: 1 } };
const triggersB: StorageDomainSchema = { ...triggersA, cutover: { artifactVersion: B, importContract: 1 } };
const present = runningBuild(B, { state: { database: 'present', sidecars: [], identity: 'created', recovery: { state: 'clear' } } }).preflight.state!;
const direct = (state: string, manifest?: StorageBuildManifest, extra: Partial<StorageUpdateInput> = {}) =>
  evaluateStorageUpdate({ stateDir: state, build: runningBuild(B, { ...manifest ? { manifest } : {}, state: present }), managed: false, legacyFiles: async () => 'present', ...extra });
/** A's worker records its evidence, A as `domains` declares it, after its prepare and gate. */
async function prepareA(state: string, domains: StorageDomainSchema[] = [retentionA]) {
  const manifest = storageManifest(domains, A);
  const build = runningBuild(A, { manifest });
  return recordPreparationEvidence(state, { context: { identity: build.preflight.identity!, manifest }, preflight: build.preflight, prepared: preparedStorage(domains), gate: openGate });
}

test('F2. on correct A evidence, a B that changes protocol, core, a scope, a digest or a reader/writer contract imports nothing', async t => {
  const state = await stateDir(t);
  await prepareA(state);
  assert.deepEqual([(await direct(state)).code, (await direct(state)).importAllowed], ['direct-evidence', true], 'the B that A prepared');
  for (const [why, manifest] of [
    ['protocol', changedManifest(B, body => ({ ...body, protocol: 'tower-storage/2' }))],
    ['core', changedManifest(B, body => ({ ...body, core: { ...body.core, schemaVersion: 2, schemaDigest: 'd'.repeat(64) } }))],
    ['another scope', storageManifest([retentionB, triggersA], B)],
    ['a digest', changedManifest(B, body => ({ ...body, domains: body.domains.map(domain => ({ ...domain, schemaDigest: 'd'.repeat(64) })) }))],
    ['a writer contract', changedManifest(B, body => ({ ...body, domains: body.domains.map(domain => ({ ...domain, preparation: { ...domain.preparation, writerContract: 2 } })) }))],
    ['a reader contract', changedManifest(B, body => ({ ...body, domains: body.domains.map(domain => ({ ...domain, preparation: { ...domain.preparation, readerContract: 2 } })) }))],
  ] as const) {
    const evaluation = await direct(state, manifest);
    assert.deepEqual([evaluation.verdict, evaluation.code, evaluation.importAllowed], ['refused', 'prerequisite-required', false], why);
  }
  // The A that also prepared the other scope takes that B over.
  await prepareA(state, [retentionA, triggersA]);
  assert.equal((await direct(state, storageManifest([retentionB, triggersA], B))).code, 'direct-evidence', 'whole A evidence covering every scope');
});

test('F2. evidence is recorded only after a claimed prepare of the whole schema with the gate open, and never partly', async t => {
  const state = await stateDir(t);
  const manifest = storageManifest([retentionA], A);
  const build = runningBuild(A, { manifest });
  const ask = (prepared: object, gateOpen = true) => recordPreparationEvidence(state, { context: { identity: build.preflight.identity!, manifest }, preflight: build.preflight, prepared: prepared as never, gate: { open: gateOpen, reasons: [] } }).then(() => 'recorded', error => (error as Error).message);
  const good = preparedStorage();
  for (const [why, prepared, gateOpen] of [
    ['not claimed', { ...good, claimed: false }, true],
    ['gate closed', good, false],
    ['empty storage', { ...good, schema: { kind: 'empty' } }, true],
    ['a scope missing', { ...good, schema: { ...good.schema, applied: (good.schema as { applied: unknown[] }).applied.filter(row => (row as { scope: string }).scope !== 'retention') } }, true],
    ['another scope too', preparedStorage([retentionA, triggersA]), true],
  ] as const) {
    assert.notEqual(await ask(prepared, gateOpen), 'recorded', why);
    assert.equal((await readPreparationEvidence(state, 'retention')).state, 'absent', why);
  }
  assert.equal(await ask(good), 'recorded');
  const evidence = await readPreparationEvidence(state, 'retention');
  assert.ok(evidence.state === 'present' && evidence.evidence.manifest.digest === manifest.digest && evidence.evidence.prepared.storageId === (good.schema as { storageId: string }).storageId);
});

test('F2. a B importing two domains is not ready on the evidence of one; tampered evidence is never readiness', async t => {
  const state = await stateDir(t);
  const both = storageManifest([retentionB, triggersB], B);
  await prepareA(state, [retentionA, triggersA]);
  assert.equal((await direct(state, both)).code, 'direct-evidence');
  const triggers = join(state, 'storage-contracts', 'triggers.json');
  const kept = await readFile(triggers);
  await rm(triggers);
  assert.deepEqual([(await direct(state, both)).code, (await direct(state, both)).importAllowed], ['prerequisite-required', false], 'a domain without evidence: a partial preparation');
  const original = JSON.parse(String(kept));
  for (const [why, value] of [
    ['manifest digest', { ...original, manifest: { ...original.manifest, digest: 'f'.repeat(64) } }],
    ['build bound to another manifest', { ...original, build: { ...original.build, manifestDigest: 'f'.repeat(64) } }],
    ['build of another protocol', { ...original, build: { ...original.build, protocol: 'tower-storage/2' } }],
    ['its domain unlike its manifest\'s', { ...original, writerContract: 2 }],
    ['no prepared storage', { ...original, prepared: undefined }],
  ] as const) {
    await writeFile(triggers, JSON.stringify(value), { mode: 0o600 });
    const evaluation = await direct(state, both);
    assert.deepEqual([evaluation.code, evaluation.importAllowed], ['preparation-evidence-unreadable', false], why);
  }
});

test('F2. legacy (domain-only) evidence is history, not readiness; only a truly new state directory goes on without evidence', async t => {
  const state = await stateDir(t);
  const fresh = runningBuild(B);
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: fresh, managed: false, legacyFiles: async () => 'absent' })).code, 'new-state');
  const [written] = await prepareA(state);
  const legacy = { format: 'tower-storage-preparation', version: 1, domain: 'retention', build: written.build, preparationVersion: A, readerContract: 1, writerContract: 1, schema: written.schema, runtime: written.runtime, recordedAt: written.recordedAt };
  await writeFile(join(state, 'storage-contracts', 'retention.json'), JSON.stringify(legacy), { mode: 0o600 });
  assert.deepEqual([(await direct(state)).code, (await direct(state)).importAllowed], ['prerequisite-required', false]);
  const missing = await evaluateStorageUpdate({ stateDir: state, build: fresh, managed: false, legacyFiles: async () => 'absent' });
  assert.deepEqual([missing.code, missing.importAllowed], ['known-storage-missing', false], 'a state directory with evidence and no database is not a new one');
});

// ---- F3. The operation's actual proof ----

test('F3. a completed rollback\'s hold is released only over its own operation: pointer, pin, artifact, entry and serving worker', async t => {
  for (const change of ['pointer', 'pin-id', 'pin-build', 'artifact', 'entry', 'worker'] as const) {
    const { state, world, answer } = await completedHeld(t);
    answer();
    const pinPath = storagePinPath(state);
    const pin = JSON.parse(await readFile(pinPath, 'utf8'));
    const entry = entryPoint(versionDirectory(state, A));
    const entryBytes = await readFile(entry);
    if (change === 'pointer') await pointCurrent(state, C);
    if (change === 'pin-id') await writeFile(pinPath, JSON.stringify({ ...pin, rollbackId: 'another' }), { mode: 0o600 });
    if (change === 'pin-build') await writeFile(pinPath, JSON.stringify({ ...pin, sourceHash: 'f'.repeat(64) }), { mode: 0o600 });
    if (change === 'artifact') { await rm(versionDirectory(state, A), { recursive: true }); await installArtifact(state, A, { salt: 'replaced' }); }
    if (change === 'entry') await writeFile(entry, `${entryBytes}\n// changed\n`);
    if (change === 'worker') world.state.serving = { ...world.state.serving, sourceHash: 'f'.repeat(64) };
    const releases = count(world.calls, 'release');
    const outcome = await resumeRollback(onTarget(state, world.ports));
    assert.ok(outcome.state === 'refused' && outcome.code === 'cleanup-unproven', `${change}: ${JSON.stringify(outcome).slice(0, 200)}`);
    assert.deepEqual([count(world.calls, 'release'), world.holds.size, onDisk(state).held], [releases, 1, true], change);
    assert.notEqual((await evaluate(state, A)).verdict, 'ready', change);
  }
  // As it was, the release goes ahead.
  const { state, world, answer } = await completedHeld(t);
  answer();
  const outcome = await resumeRollback(onTarget(state, world.ports));
  assert.ok(outcome.state === 'completed' && !outcome.record.held && world.holds.size === 0);
  assert.equal((await evaluate(state, A)).code, 'owner-rollback');
});

test('F3. what the operation stands on, changed during the handoff, keeps it from completing or releasing', async t => {
  for (const change of ['update', 'pin-id', 'pin-build', 'entry'] as const) {
    const state = await rollbackState(t);
    const world = rollbackWorld();
    assert.equal((await ask(onFrom(state, world.ports))).state, 'switched');
    const take = world.ports.handoff;
    world.ports.handoff = async (target, fence) => {
      const answer = await take(target, fence);
      const pin = JSON.parse(await readFile(storagePinPath(state), 'utf8'));
      if (change === 'update') await save(state, record(C, B, 'verifying'));
      if (change === 'pin-id') await writeFile(storagePinPath(state), JSON.stringify({ ...pin, rollbackId: 'another' }), { mode: 0o600 });
      if (change === 'pin-build') await writeFile(storagePinPath(state), JSON.stringify({ ...pin, entrySha256: 'f'.repeat(64) }), { mode: 0o600 });
      if (change === 'entry') await writeFile(entryPoint(versionDirectory(state, A)), '// another entry\n');
      return answer;
    };
    const outcome = await resumeRollback(onTarget(state, world.ports));
    assert.ok(outcome.state === 'failed' && outcome.record.failure?.phase === 'complete' && outcome.record.held, `${change}: ${JSON.stringify(outcome).slice(0, 300)}`);
    assert.deepEqual([count(world.calls, 'release'), world.holds.size], [0, 1], change);
    assert.equal(onDisk(state).handoff?.state, 'done', 'the takeover itself is recorded; only the completion is withheld');
  }
});

test('F3. a rollback that switched the service decides what runs until it is superseded: no other build is ready (N3)', async t => {
  // completed to A, its pin there, while current and the running build are B
  {
    const { state, world } = await switched(t);
    assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
    await pointCurrent(state, B);
    assert.equal((await evaluate(state, B)).code, 'rollback-not-target');
    assert.equal(((await validateRollback(onFrom(state, rollbackWorld().ports), { target: '1.1.5' })) as { code: string }).code, 'pinned-elsewhere');
  }
  // no update record at all, switched to A, pin A, build B
  {
    const state = await rollbackState(t, { update: false });
    const world = rollbackWorld();
    assert.equal((await ask(onFrom(state, world.ports))).state, 'switched');
    await pointCurrent(state, B);
    assert.equal((await evaluate(state, B)).code, 'rollback-not-target');
  }
  // failed after its switch (the handoff refused), and handing-off (the handoff under way): pin A, pointer B, build B
  for (const handoff of ['refuse', 'pending'] as const) {
    const { state, world } = await switched(t, { handoff });
    const outcome = await resumeRollback(onTarget(state, world.ports));
    assert.equal(outcome.state, handoff === 'refuse' ? 'failed' : 'handing-off');
    await pointCurrent(state, B);
    const evaluation = await evaluate(state, B);
    assert.deepEqual([evaluation.code, evaluation.importAllowed], ['rollback-not-target', false], handoff);
  }
  // Before any switch the existing policy stands: withdrawn, or failed without switching, with the pin left on A, B is B.
  for (const end of ['withdrawn', 'failed'] as const) {
    const state = await rollbackState(t);
    const world = rollbackWorld();
    if (end === 'withdrawn') {
      world.ports.waitQuiet = pending;
      assert.equal((await ask(onFrom(state, world.ports))).state, 'waiting');
      assert.equal((await withdrawRollback(onFrom(state, world.ports))).state, 'withdrawn');
    } else {
      world.ports.holdAdmission = async () => { throw new Error('the worker did not answer'); };
      const failed = await ask(onFrom(state, world.ports));
      assert.ok(failed.state === 'failed' && !failed.record.switched);
    }
    assert.equal((await readStoragePin(state)).state, 'present');
    assert.equal((await evaluate(state, B)).code, 'service-update-done', `${end} before the switch: B's own kept update decides`);
  }
});

test('F3. the pin is released only over its own whole rollback and, after a switch, over the actual target and serving worker', async t => {
  const { state, world } = await switched(t);
  assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
  const pinPath = storagePinPath(state);
  const pin = await readFile(pinPath);
  const refuse = async (code: string, why: string) => {
    const answer = await releaseStoragePin(state, { version: A }, { ports: world.ports });
    assert.deepEqual([answer.released, answer.code], [false, code], `${why}: ${answer.reason}`);
    assert.ok(existsSync(pinPath), why);
  };
  await writeFile(pinPath, JSON.stringify({ ...JSON.parse(String(pin)), sourceHash: 'f'.repeat(64) }), { mode: 0o600 });
  await refuse('pin-mismatch', 'the same ID over another build');
  await writeFile(pinPath, pin, { mode: 0o600 });
  await pointCurrent(state, C);
  await refuse('rollback-unproven', 'current at C');
  await pointCurrent(state, A);
  world.state.serving = { ...world.state.serving, sourceHash: 'f'.repeat(64) };
  await refuse('serving-unproven', 'another worker serves');
  world.state.serving = { ...world.state.serving, sourceHash: runningBuild(A).preflight.identity!.sourceHash };
  assert.equal((await releaseStoragePin(state, { version: A })).code, 'serving-unproven', 'nobody asked the serving worker');
  assert.deepEqual(bytes(pinPath), pin, 'every refusal left the pin\'s bytes');
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: world.ports })).released, true);
  assert.equal((await evaluate(state, A)).code, 'owner-rollback', 'the completed operation keeps its authority once the owner released the pin');
});

test('F3. a past rollback and a new update generation: the next rollback gets a new ID; one not superseded is not covered', async t => {
  const { state, world } = await switched(t);
  assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
  const first = onDisk(state).id;
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: world.ports })).released, true);
  // The CLI moves current to B (the pin is gone), yet no update replaced the record the rollback stood on.
  await pointCurrent(state, B);
  assert.equal((await ask(onFrom(state, rollbackWorld().ports))).state, 'refused');
  assert.equal(((await validateRollback(onFrom(state, rollbackWorld().ports), { target: A })) as { code: string }).code, 'rollback-not-target');
  // A new, normal update to B is kept: the past operation no longer decides.
  await save(state, record(B, A, 'done', { startedAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }));
  assert.equal((await evaluate(state, B)).code, 'service-update-done');
  const again = rollbackWorld();
  const second = await ask(onFrom(state, again.ports));
  assert.ok(second.state === 'switched' && second.record.id !== first, JSON.stringify(second).slice(0, 200));
  assert.ok((await readStoragePin(state)).state === 'present' && onDisk(state).id === second.record.id);
});

// ---- F4. Handoff outcomes, from what serves ----

test('F4. a handoff refused (or unanswered) before any effect fails and releases; a retry hands over under a new attempt and baseline', async t => {
  for (const handoff of ['refuse', 'before'] as const) {
    const { state, world } = await switched(t, { handoff });
    const failed = await resumeRollback(onTarget(state, world.ports));
    assert.ok(failed.state === 'failed' && failed.record.failure?.phase === 'handoff' && !failed.record.held && failed.record.handoff?.state === 'no-effect', handoff);
    assert.deepEqual([count(world.calls, 'release'), world.holds.size], [1, 0], handoff);
    const firstAttempt = onDisk(state).handoff!.attempt;
    world.ports.handoff = async (target, fence) => {
      world.calls.push('handoff');
      // The lower worker now takes it: the target serves as a new process and claims the storage.
      world.state.serving = { ...world.state.serving, version: target.version, sourceHash: target.sourceHash, manifestDigest: runningBuild(A).preflight.identity!.manifestDigest, pid: 300, start: 'started-300' };
      world.state.epoch += 1; world.state.claim = world.state.epoch; world.state.gate = true;
      world.state.handoffs.set(`${fence.id}#${fence.attempt}`, 'done');
      return { state: 'accepted' };
    };
    const done = await resumeRollback(onTarget(state, world.ports));
    assert.equal(done.state, 'completed', handoff);
    assert.ok(onDisk(state).handoff!.attempt > firstAttempt, 'a new attempt, with its own baseline');
  }
});

test('F4. an effect whose answer was lost completes on the serving proof only; a target that has not claimed yet keeps everything', async t => {
  {
    const { state, world } = await switched(t, { handoff: 'lose' });
    assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
    assert.deepEqual([count(world.calls, 'handoff'), count(world.calls, 'release')], [1, 1]);
  }
  const { state, world } = await switched(t, { claim: 'later' });
  const first = await resumeRollback(onTarget(state, world.ports));
  assert.ok(first.state === 'handing-off' && first.record.handoff?.state === 'pending' && first.record.held);
  const again = await resumeRollback(onTarget(state, world.ports));
  assert.equal(again.state, 'handing-off');
  assert.deepEqual([count(world.calls, 'handoff'), count(world.calls, 'release'), world.holds.size], [1, 0, 1], 'claim before: held, nothing sent again');
  assert.equal((await evaluate(state, A)).importAllowed, false);
  world.claim();
  assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
  assert.deepEqual([count(world.calls, 'handoff'), count(world.calls, 'release'), world.holds.size], [1, 1, 0]);
});

test('F4. a handoff still under way is waited for and never sent again', async t => {
  const { state, world } = await switched(t, { handoff: 'pending' });
  for (let look = 0; look < 2; look++) {
    const outcome = await resumeRollback(onTarget(state, world.ports));
    assert.ok(outcome.state === 'handing-off' && outcome.record.handoff?.state === 'pending', String(look));
  }
  assert.deepEqual([count(world.calls, 'handoff'), count(world.calls, 'release')], [1, 0]);
  world.finish({ version: A });
  assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
  assert.equal(count(world.calls, 'handoff'), 1);
});

test('F4. the worker handed over from, still serving after its own reopen (epoch + 1) and knowing no handoff, is no effect', async t => {
  // Right after a refused answer: fails and releases.
  {
    const { state, world } = await switched(t, { handoff: 'refuse' });
    const refuse = world.ports.handoff;
    world.ports.handoff = async (target, fence) => { world.reopen(); return refuse(target, fence); };
    const failed = await resumeRollback(onTarget(state, world.ports));
    assert.ok(failed.state === 'failed' && failed.record.handoff?.state === 'no-effect' && world.holds.size === 0);
  }
  // On a later look at an accepted handoff that did nothing: what was unknown is found to be no effect, and a new attempt goes on.
  const { state, world } = await switched(t, { handoff: 'ignore' });
  const unknown = await resumeRollback(onTarget(state, world.ports));
  assert.ok(unknown.state === 'handing-off' && unknown.record.handoff?.state === 'unknown' && unknown.record.held, 'accepted, yet nothing serves differently: unknown');
  world.reopen();
  world.ports.handoff = async (target, fence) => { world.calls.push('handoff'); world.finish(target); world.state.handoffs.set(`${fence.id}#${fence.attempt}`, 'done'); return { state: 'accepted' }; };
  assert.equal((await resumeRollback(onTarget(state, world.ports))).state, 'completed');
  assert.equal(count(world.calls, 'handoff'), 2, 'sent again only after no effect was proven');
});

test('F4. what serves cannot be told, another claimant, or another storage: unknown, nothing released or imported', async t => {
  for (const after of ['proof-fails', 'other-claimant', 'storage-replaced'] as const) {
    const { state, world } = await switched(t);
    const take = world.ports.handoff;
    world.ports.handoff = async (target, fence) => {
      const answer = await take(target, fence);
      if (after === 'other-claimant') world.otherClaim();
      if (after === 'storage-replaced') world.replaceStorage();
      if (after === 'proof-fails') world.ports.servingProof = async () => { throw new Error('the worker did not answer'); };
      return answer;
    };
    const outcome = await resumeRollback(onTarget(state, world.ports));
    assert.ok(outcome.state === 'handing-off' && outcome.record.handoff?.state === 'unknown' && outcome.record.held, `${after}: ${JSON.stringify(outcome).slice(0, 200)}`);
    assert.deepEqual([count(world.calls, 'release'), world.holds.size], [0, 1], after);
    const evaluation = await evaluate(state, A);
    assert.deepEqual([evaluation.code, evaluation.importAllowed], ['rollback-handoff', false], after);
    // Asked again, it is judged against the same baseline and never sent again.
    const baseline = onDisk(state).handoff!.baseline;
    await resumeRollback(onTarget(state, world.ports));
    assert.deepEqual([onDisk(state).handoff!.baseline, count(world.calls, 'handoff')], [baseline, 1], after);
  }
});

test('F4. a target worker already serving before the handoff is not this rollback\'s takeover: nothing is sent, the hold stays', async t => {
  const { state, world } = await switched(t);
  world.state.serving = { ...world.state.serving, version: A, sourceHash: runningBuild(A).preflight.identity!.sourceHash, manifestDigest: runningBuild(A).preflight.identity!.manifestDigest, pid: 900, start: 'started-900' };
  const outcome = await resumeRollback(onTarget(state, world.ports));
  assert.ok(outcome.state === 'failed' && outcome.record.failure?.phase === 'baseline' && outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  assert.deepEqual([count(world.calls, 'handoff'), count(world.calls, 'release'), world.holds.size], [0, 0, 1]);
});

test('F4. an empty storage: the target that does not claim it, with its prepare refused and this handoff done, completes (N1)', async t => {
  const { state, world } = await switched(t, { storage: 'empty' });
  assert.deepEqual(onDisk(state).storage, { kind: 'empty' });
  const outcome = await resumeRollback(onTarget(state, world.ports));
  assert.ok(outcome.state === 'completed' && !outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  assert.deepEqual([world.state.storage.kind, world.state.claim, world.state.epoch], ['empty', undefined, 0], 'nothing was claimed or created by the handoff');
  assert.equal((await evaluate(state, A)).code, 'owner-rollback', 'the operation is done; the normal bootstrap is judged apart');
});

test('F4. an empty storage that became current during the handoff is unknown; one whose worker handed over from still serves is no effect', async t => {
  {
    const { state, world } = await switched(t, { storage: 'empty' });
    const take = world.ports.handoff;
    world.ports.handoff = async (target, fence) => { const answer = await take(target, fence); world.bootstrap(); return answer; };
    const outcome = await resumeRollback(onTarget(state, world.ports));
    assert.ok(outcome.state === 'handing-off' && outcome.record.handoff?.state === 'unknown', JSON.stringify(outcome).slice(0, 300));
    assert.deepEqual([count(world.calls, 'release'), world.holds.size, (await evaluate(state, A)).importAllowed], [0, 1, false]);
  }
  const { state, world } = await switched(t, { storage: 'empty', handoff: 'refuse' });
  const failed = await resumeRollback(onTarget(state, world.ports));
  assert.ok(failed.state === 'failed' && failed.record.handoff?.state === 'no-effect' && world.holds.size === 0);
});

test('F4. a release that did not answer on the empty storage: released again while it is still empty, never once it is not', async t => {
  const { state, world, answer } = await completedHeld(t, { storage: 'empty' });
  const baseline = onDisk(state).handoff!.baseline;
  // The release had reached the worker after all; the target, still held by its record, has not bootstrapped.
  world.holds.clear();
  answer();
  const outcome = await resumeRollback(onTarget(state, world.ports));
  assert.ok(outcome.state === 'completed' && !outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  assert.deepEqual([count(world.calls, 'handoff'), onDisk(state).handoff!.baseline], [1, baseline], 'no new handoff, the baseline as it was');
  // A storage that is no longer empty while the hold is still counted (bootstrapped, or another storage) is not released.
  for (const change of ['bootstrap', 'another-storage'] as const) {
    const other = await completedHeld(t, { storage: 'empty' });
    if (change === 'bootstrap') other.world.bootstrap(); else other.world.replaceStorage();
    other.answer();
    const releases = count(other.world.calls, 'release');
    const refused = await resumeRollback(onTarget(other.state, other.world.ports));
    assert.ok(refused.state === 'refused' && refused.code === 'cleanup-unproven' && other.world.holds.size === 1, change);
    assert.equal(count(other.world.calls, 'release'), releases, change);
  }
});

// ---- F5. One durable attempt: withdrawal and retry never overlap ----

test('F5. while a withdrawal waits for its release, a retry, a resume, an update or a pin release switches or releases nothing', async t => {
  const state = await rollbackState(t);
  const world = rollbackWorld();
  world.ports.waitQuiet = pending;
  assert.equal((await ask(onFrom(state, world.ports))).state, 'waiting');
  const released = gate();
  const releasing = gate();
  const release = world.ports.releaseAdmission;
  world.ports.releaseAdmission = async fence => { releasing.open(); await released.opened; return release(fence); };
  const withdrawal = withdrawRollback(onFrom(state, world.ports));
  await releasing.opened;
  world.ports.waitQuiet = async () => ({ state: 'quiet' });
  const answers = {
    run: await ask(onFrom(state, world.ports)),
    resume: await resumeRollback(onFrom(state, world.ports)),
    update: (await updatesOn(state).request(C)).body.code,
    pin: (await releaseStoragePin(state, { version: A })).code,
    withdraw: await withdrawRollback(onFrom(state, world.ports)),
  };
  released.open();
  const withdrawn = await withdrawal;
  assert.ok(answers.run.state === 'refused' && answers.run.code === 'hold-not-released', JSON.stringify(answers.run));
  assert.ok(answers.resume.state === 'refused');
  assert.deepEqual([answers.update, answers.pin], ['pinned', 'hold-not-released']);
  assert.ok(answers.withdraw.state === 'refused' && answers.withdraw.code === 'rollback-busy', 'a second withdrawal waits for the first one\'s attempt');
  assert.ok(withdrawn.state === 'withdrawn' && !withdrawn.record.held);
  assert.deepEqual([await currentVersion(state), world.holds.size, count(world.calls, 'hold')], [B, 0, 1]);
});

test('F5. a retry\'s hold under way in this process or another live one makes a withdrawal busy; after its ACK the withdrawal releases', async t => {
  // In this process: the hold call is still under way.
  {
    const state = await rollbackState(t);
    const world = rollbackWorld();
    const holding = gate();
    const acked = gate();
    const hold = world.ports.holdAdmission;
    world.ports.holdAdmission = async (fence, reason) => { holding.open(); await acked.opened; return hold(fence, reason); };
    world.ports.waitQuiet = pending;
    const run = ask(onFrom(state, world.ports));
    await holding.opened;
    assert.equal(((await withdrawRollback(onFrom(state, world.ports))) as { code: string }).code, 'rollback-busy');
    acked.open();
    assert.equal((await run).state, 'waiting');
    assert.deepEqual([world.holds.size, onDisk(state).held], [1, true]);
    assert.equal((await withdrawRollback(onFrom(state, world.ports))).state, 'withdrawn');
    assert.deepEqual([world.holds.size, onDisk(state).held], [0, false]);
  }
  // Another process that is alive (this test's parent) owns the attempt holding now.
  const state = await rollbackState(t);
  const world = rollbackWorld();
  world.ports.waitQuiet = pending;
  assert.equal((await ask(onFrom(state, world.ports))).state, 'waiting');
  const parent = { pid: process.ppid, start: (await processStart(process.ppid))! };
  const attempt = { n: 2, ...parent, nonce: randomBytes(10).toString('hex'), kind: 'run' as const, at };
  await rewrite(state, { state: 'holding', held: true, attempt });
  const busy = await withdrawRollback(onFrom(state, world.ports));
  assert.ok(busy.state === 'refused' && busy.code === 'rollback-busy', JSON.stringify(busy));
  assert.equal((await ask(onFrom(state, world.ports))).state, 'refused', 'a retry from here is busy too');
  // That process's hold is acknowledged and its attempt ends.
  await world.ports.holdAdmission({ id: onDisk(state).id, attempt: 2 }, 'retry');
  await rewrite(state, { state: 'held', attempt: { ...attempt, ended: true } });
  assert.deepEqual([world.holds.size, onDisk(state).held], [1, true]);
  assert.equal((await withdrawRollback(onFrom(state, world.ports))).state, 'withdrawn');
  assert.deepEqual([world.holds.size, onDisk(state).held, onDisk(state).attempt!.n], [0, false, 3]);
});

test('F5. an attempt whose process died during its hold: a withdrawal (before the switch) takes the next fence and the late hold is refused', async t => {
  const state = await rollbackState(t);
  const world = rollbackWorld();
  world.ports.waitQuiet = pending;
  assert.equal((await ask(onFrom(state, world.ports))).state, 'waiting');
  const id = onDisk(state).id;
  await rewrite(state, { state: 'holding', held: true, attempt: { n: 2, pid: deadPid(), start: 'gone', nonce: randomBytes(10).toString('hex'), kind: 'run', at } });
  const withdrawn = await withdrawRollback(onFrom(state, world.ports));
  assert.ok(withdrawn.state === 'withdrawn' && !withdrawn.record.held && withdrawn.record.attempt?.n === 3, JSON.stringify(withdrawn).slice(0, 300));
  assert.equal(world.holds.size, 0);
  await assert.rejects(world.ports.holdAdmission({ id, attempt: 2 }, 'late'), /newer attempt/);
  assert.deepEqual([world.holds.size, world.stale], [0, ['hold#2']], 'the dead attempt\'s late hold is not applied');
});

test('F5. an attempt whose process died during its hold after the switch: resume takes the next fence, holds again, and stale calls are refused', async t => {
  const { state, world } = await switched(t);
  const id = onDisk(state).id;
  await rewrite(state, { state: 'holding', held: true, attempt: { n: 5, pid: deadPid(), start: 'gone', nonce: randomBytes(10).toString('hex'), kind: 'resume', at } });
  world.ports.waitQuiet = pending;
  const waiting = await resumeRollback(onTarget(state, world.ports));
  assert.ok(waiting.state === 'waiting' && waiting.record.held && waiting.record.attempt?.n === 6, JSON.stringify(waiting).slice(0, 300));
  assert.equal(world.holds.size, 1);
  for (const call of [
    () => world.ports.holdAdmission({ id, attempt: 5 }, 'late'),
    () => world.ports.releaseAdmission({ id, attempt: 5 }),
    () => world.ports.handoff({ version: A, entry: '', sourceHash: runningBuild(A).preflight.identity!.sourceHash }, { id, attempt: 5 }),
  ]) await assert.rejects(call(), /newer attempt/);
  assert.deepEqual([world.stale, world.holds.size, world.state.serving.version], [['hold#5', 'release#5', 'handoff#5'], 1, B], 'nothing of attempt 5 applied');
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
