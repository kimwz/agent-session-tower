import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVersion, pointCurrent, pointUpdate, runtimePaths, storagePinPath, useVersion, versionDirectory } from '../../../server/link/service.js';
import {
  evaluateStorageUpdate, nextChainStep, preparationCheck, probeInstalledArtifact, readHelperLock, readHold, readRollbackRecord, readStoragePin, recordUpdateRecoveryReceipt, releaseStoragePin,
  resumeRollback, runRollback, storageHealth, storageUpdatePaths, validateRollback, withdrawRollback, withStorageTransition,
  type ArtifactRead, type RollbackContext, type RollbackPorts, type RollbackRecord, type SavedUpdate, type StorageUpdateInput,
} from '../../../server/link/storage-update.js';
import { transitionLockPath } from '../../../server/link/storage-transition-lock.js';
import { handoffHeld, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { A, A0, B, C, L, changedManifest, installArtifact, manifests, runningBuild } from './fixtures/storage-builds.js';
import { databaseOfB, rollbackWorld } from './fixtures/rollback-world.js';

/**
 * The corrections of the W0U review (w0-update-review.txt, required 1–11), each against the real producer: strict
 * reads, the whole-schema takeover check, the pin across processes, the rollback's reservation, readiness, durable
 * intents and their recovery at every step, retries, the pin release, the target's use of the rollback record, and the
 * owner's receipt for a build's own failed update. Ports stand for the worker and service (W0I connects the real ones).
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-storage-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (version: string, previous: string, stage: SavedUpdate['stage'], extra: Partial<SavedUpdate> = {}): SavedUpdate => ({ version, previous, stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, typeof value === 'string' ? value : JSON.stringify(value));
/** A managed start whose preflight sees the database these worlds hold (B's storage). */
const evaluate = (state: string, version: string, extra: Partial<StorageUpdateInput> = {}) =>
  evaluateStorageUpdate({ stateDir: state, build: runningBuild(version, { state: { database: 'present', sidecars: [], identity: 'created', recovery: { state: 'clear' } } }), managed: true, ...extra });
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const onDisk = (state: string): RollbackRecord | undefined => existsSync(storageUpdatePaths(state).rollback) ? JSON.parse(readFileSync(storageUpdatePaths(state).rollback, 'utf8')) : undefined;
const pointer = (state: string) => readlinkSync(runtimePaths(state).current);
/** A clock whose save fails (as a full disk or a stop would end it) once `when` holds: what was written before stays. */
const failingWhen = (when: () => boolean) => () => { if (when()) throw new Error('simulated stop before this save'); return Date.now(); };

async function rollbackState(t: TestContext) {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, B);
  await save(state, record(B, A, 'done'));
  return state;
}
/** The worker and service as the rollback sees them (fixtures/rollback-world.ts): holds kept by ID, calls in order, some ports replaced. */
function ports(overrides: Partial<RollbackPorts> = {}) {
  const world = rollbackWorld();
  Object.assign(world.ports, overrides);
  return { value: world.ports, calls: world.calls, holds: world.holds, holdIds: world.holdIds, world };
}
/** A transition lock (or breaker) as this build writes it, owned by `pid` started at `start`. */
const ownerFile = (role: 'lock' | 'breaker', pid: number, start: string) => JSON.stringify({ format: 'tower-transition-owner', version: 1, role, pid, start, nonce: '0123456789abcdef0123' });
const updatesOn = (state: string, version = B) => new Updates({ stateDir: state, version, port: 1, managed: true, spawnHelper: () => {} });
const onFrom = (state: string, port: RollbackPorts, extra: Partial<RollbackContext> = {}, updates = updatesOn(state)): RollbackContext =>
  ({ stateDir: state, running: runningBuild(B), managed: true, ports: port, serialize: work => updates.exclusive(work), ...extra });
const onTarget = (state: string, port: RollbackPorts, extra: Partial<RollbackContext> = {}): RollbackContext =>
  ({ stateDir: state, running: runningBuild(A), managed: true, ports: port, serialize: work => work(), ...extra });
const ask = (context: RollbackContext, target = A) => runRollback(context, { target, by: 'owner', reason: 'B misbehaves' });
const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };

// ---- 1. Strict reads ----

test('1. a link in place of the hold or helper lock (dangling or not) is neither absent nor present, and nothing is changed', async t => {
  const state = await rollbackState(t);
  await symlink(join(state, 'nowhere'), updatePaths(state).hold);
  assert.equal((await readHold(state)).state, 'unreadable');
  assert.equal((await evaluate(state, B)).code, 'hold-unreadable');
  await assert.rejects(handoffHeld(state), 'the web cannot tell whether to hand over: it does not');
  await save(state, '{');
  assert.equal((await updatesOn(state).request(C)).body.code, 'busy', 'an update record it does not understand is not replaced while a hold may be there');
  await save(state, record(B, A, 'done'));
  await rm(updatePaths(state).hold);
  await writeFile(join(state, 'some-file'), '{}');
  await symlink(join(state, 'some-file'), updatePaths(state).hold);
  assert.equal((await readHold(state)).state, 'unreadable', 'a link to a file is not a hold a helper wrote');
  await rm(updatePaths(state).hold);
  for (const target of [join(state, 'nowhere'), join(state, 'some-file')]) {
    await symlink(target, updatePaths(state).lock);
    assert.equal((await readHelperLock(state)).state, 'unreadable', target);
    const evaluation = await evaluate(state, B);
    assert.equal(evaluation.code, 'helper-unreadable');
    assert.equal(evaluation.importAllowed, false);
    assert.equal(readlinkSync(updatePaths(state).lock), target, 'the link is left as it is');
    await rm(updatePaths(state).lock);
  }
  assert.equal((await evaluate(state, B)).verdict, 'ready', 'with neither there, the kept update decides again');
});

// ---- 2. The previous version takes over the whole schema ----

const contractOf = (version: string, manifest = runningBuild(version).manifest!): ArtifactRead => {
  const build = runningBuild(version, { manifest });
  return { state: 'contract', contract: { format: 'tower-artifact-storage-contract', version: 1, appVersion: version, supported: true, identity: build.preflight.identity!, manifest } };
};
const coreChanged = () => changedManifest(B, body => ({ ...body, core: { ...body.core, schemaVersion: 2, schemaDigest: 'd'.repeat(64) } }));
const withTriggers = (preparedBy: string) => changedManifest(B, body => ({ ...body, domains: [...body.domains, { scope: 'triggers', schemaVersion: 1, schemaDigest: 'e'.repeat(64), preparation: { requiredArtifactVersion: preparedBy, readerContract: 1, writerContract: 1 } }] }));

test('2. a previous version must take over everything the target applies: protocol, core, every scope and its contracts', () => {
  assert.equal(preparationCheck(manifests[B], contractOf(A)).state, 'satisfied', 'A prepared B exactly');
  for (const [manifest, scope] of [
    [coreChanged(), 'core'],
    [changedManifest(B, body => ({ ...body, protocol: 'tower-storage/2' })), 'protocol'],
    [withTriggers(B), 'triggers'],
    [changedManifest(B, body => ({ ...body, domains: body.domains.map(domain => ({ ...domain, preparation: { ...domain.preparation, writerContract: 2 } })) })), 'retention'],
  ] as const) {
    const check = preparationCheck(manifest, contractOf(A));
    assert.equal(check.state, 'incompatible', scope);
    assert.deepEqual(check.domains, [scope]);
    assert.equal(check.prepare, undefined, 'no release between A and B prepares it');
  }
  const prepared = preparationCheck(withTriggers('1.1.5'), contractOf(A));
  assert.deepEqual([prepared.state, prepared.prepare, prepared.domains], ['prerequisite-required', '1.1.5', ['triggers']], 'a release between them that prepares the scope is named');
  // PR0's approved scope stays: a build without cutover asks nothing of its previous version, a JSON-only one included.
  assert.equal(preparationCheck(manifests[A0], { state: 'legacy', version: L }).state, 'not-required');
  assert.equal(preparationCheck(changedManifest(A, body => ({ ...body, core: { ...body.core, schemaVersion: 2, schemaDigest: 'd'.repeat(64) } })), { state: 'legacy', version: L }).state, 'not-required');
});

test('2. the updater refuses an incompatible target before anything switches, is not asked again, and the chain stops for the owner', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B, { manifest: coreChanged() });
  await pointCurrent(state, A);
  const updates = updatesOn(state, A);
  assert.equal((await updates.request(B)).status, 202);
  let restarts = 0;
  const steps: UpdateHelperSteps = {
    free: async () => undefined, install: async version => versionDirectory(state, version), check: async () => {}, contract: probeInstalledArtifact,
    point: version => pointUpdate(state, version), restart: async () => { restarts++; }, health: async () => ({ version: A, pid: 1 }), controllers: async () => [],
    sleep: async () => {}, now: () => Date.parse(at), log: () => {},
  };
  const failed = await runUpdateHelper(state, B, steps) as SavedUpdate;
  assert.deepEqual([failed.stage, failed.code, failed.storage], ['failed', 'check-failed', { code: 'previous-incompatible', domains: ['core'] }]);
  assert.equal(await currentVersion(state), A);
  assert.equal(restarts, 0);
  assert.equal(existsSync(updatePaths(state).hold), false);
  const again = await updates.request(B);
  assert.deepEqual([again.status, again.body.code], [409, 'previous-incompatible'], 'asked again, nothing is installed again');
  const step = nextChainStep({ running: A, update: failed, progress: { target: B, attempts: { [B]: 1 } } });
  assert.ok(step.action === 'blocked' && step.code === 'previous-incompatible');
  // The candidate itself, verifying with that previous version, refuses with 503 and its identity.
  await save(state, record(B, A, 'verifying'));
  const refused = await evaluateStorageUpdate({ stateDir: state, build: runningBuild(B, { manifest: coreChanged() }), managed: true });
  assert.deepEqual([refused.verdict, refused.code, storageHealth(refused).status], ['refused', 'previous-incompatible', 503]);
});

// ---- 3. The pin across processes ----

test('3. useVersion and the helper\'s forward switch respect the pin; one that cannot be read refuses; no pin keeps the monotonic rule', async t => {
  const state = await rollbackState(t);
  await installArtifact(state, C);
  assert.equal((await ask(onFrom(state, ports({ waitQuiet: async () => ({ state: 'pending', reason: 'busy' }) }).value))).state, 'waiting');
  await assert.rejects(useVersion(state, C), { code: 'pinned' });
  await assert.rejects(pointUpdate(state, C), { code: 'pinned' });
  assert.equal(await currentVersion(state), B);
  await pointUpdate(state, A);
  assert.equal(await currentVersion(state), A, 'an update going back is not stopped by the pin');
  await pointCurrent(state, B);
  const pinBytes = await readFile(storagePinPath(state));
  await rm(storagePinPath(state));
  await mkdir(storagePinPath(state));
  await assert.rejects(useVersion(state, C), { code: 'pin-unreadable' });
  assert.equal(await currentVersion(state), B);
  await rm(storagePinPath(state), { recursive: true });
  await writeFile(storagePinPath(state), pinBytes, { mode: 0o600 });
  await useVersion(state, A);
  assert.equal(await currentVersion(state), B, 'never back, pin or not');
});

/** Starts the CLI child (useVersion in its own process) and answers its exit and its JSON line. */
function cliUseVersion(state: string, version: string) {
  const script = fileURLToPath(new URL('./fixtures/use-version-child.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script, state, version], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const asking = new Promise<void>(resolve => {
    child.stdout.on('data', chunk => { out += String(chunk); if (out.includes('asking\n')) resolve(); });
    child.on('close', () => resolve());
  });
  child.stderr.on('data', chunk => { err += String(chunk); });
  const exited = new Promise<{ code: number | null; answer: { ok: boolean; code?: string } }>(resolve => child.on('close', code => {
    const line = out.split('\n').find(item => item.startsWith('{'));
    resolve({ code, answer: line ? JSON.parse(line) : { ok: false, code: `no answer: ${err.slice(0, 300)}` } });
  }));
  return { child, asking, exited, done: () => child.exitCode !== null || child.signalCode !== null };
}

test('3. a separate CLI process waits for the web\'s transition turn and then sees the pin written in it', async t => {
  const state = await rollbackState(t);
  await installArtifact(state, C);
  const cli = cliUseVersion(state, C);
  t.after(() => { if (!cli.done()) cli.child.kill(); });
  let waited = false;
  await withStorageTransition(state, async () => {
    await cli.asking;
    await new Promise(resolve => setTimeout(resolve, 400));
    waited = !cli.done();
    // What the web writes in its turn (here: the owner's pin), the CLI sees once it gets the turn.
    await writeFile(storagePinPath(state), JSON.stringify({ format: 'tower-storage-pin', version: 1, pinned: A, sourceHash: runningBuild(A).preflight.identity!.sourceHash, manifestDigest: manifests[A].digest, entrySha256: 'a'.repeat(64), rollbackId: 'r1', by: 'owner', reason: 'r', at }), { mode: 0o600 });
  });
  const { code, answer } = await cli.exited;
  assert.equal(waited, true, 'the CLI could not move current while the web held the turn');
  assert.deepEqual([code, answer.ok, answer.code], [3, false, 'pinned']);
  assert.equal(await currentVersion(state), B);

  // Without a pin the CLI goes on after the turn, still monotonic.
  await rm(storagePinPath(state));
  const second = cliUseVersion(state, C);
  t.after(() => { if (!second.done()) second.child.kill(); });
  const result = await second.exited;
  assert.deepEqual([result.code, result.answer.ok], [0, true]);
  assert.equal(await currentVersion(state), C);
});

test('3. a transition lock left by a stopped process is broken; one that is not a plain file stops everything and is kept', async t => {
  const state = await rollbackState(t);
  await installArtifact(state, C);
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.on('close', resolve));
  await writeFile(transitionLockPath(state), ownerFile('lock', dead.pid!, 'Thu Jan  1 00:00:00 1970'), { mode: 0o600 });
  await useVersion(state, C);
  assert.equal(await currentVersion(state), C);
  assert.equal(existsSync(transitionLockPath(state)), false, 'broken, then released');
  await symlink(join(state, 'nowhere'), transitionLockPath(state));
  await assert.rejects(useVersion(state, B), { code: 'transition-lock-unreadable' });
  assert.equal(await currentVersion(state), C);
  assert.equal(readlinkSync(transitionLockPath(state)), join(state, 'nowhere'));
});

// ---- 4. One reservation, in turn with update requests ----

test('4. an update asked for while the rollback is validated wins; a rollback under way refuses updates', async t => {
  const state = await rollbackState(t);
  const updates = updatesOn(state);
  const inspected = gate();
  const port = ports({ inspectStorage: async () => { await inspected.opened; return databaseOfB(); } });
  const rollback = ask(onFrom(state, port.value, {}, updates));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await updates.request(C)).status, 202);
  inspected.open();
  const outcome = await rollback;
  assert.ok(outcome.state === 'refused' && outcome.code === 'update-changed', JSON.stringify(outcome));
  assert.deepEqual([(await readStoragePin(state)).state, onDisk(state), port.holds.size, await currentVersion(state)], ['absent', undefined, 0, B]);

  const other = await rollbackState(t);
  const otherUpdates = updatesOn(other);
  // A reservation cut short after its record was written and before its pin: updates stay refused.
  const crashed = await ask(onFrom(other, ports().value, { now: failingWhen(() => onDisk(other)?.state === 'pinning' && existsSync(storagePinPath(other))) }, otherUpdates)).catch(error => error as Error);
  assert.ok(crashed instanceof Error);
  await rm(storagePinPath(other));
  const refused = await otherUpdates.request(C);
  assert.deepEqual([refused.status, refused.body.code], [409, 'rollback-under-way']);
});

test('4. two requests for the same target are one rollback with one hold; another target is refused meanwhile', async t => {
  const state = await rollbackState(t);
  await installArtifact(state, '1.1.5');
  const updates = updatesOn(state);
  const quiet = gate();
  const waiting = gate();
  const port = ports({ waitQuiet: async () => { waiting.open(); await quiet.opened; return { state: 'quiet' }; } });
  const first = ask(onFrom(state, port.value, {}, updates));
  const second = ask(onFrom(state, port.value, {}, updates));
  const elsewhere = await ask(onFrom(state, port.value, {}, updates), '1.1.5');
  assert.ok(elsewhere.state === 'refused' && elsewhere.code === 'rollback-in-progress');
  // A long wait for running work holds no update request or pruning back.
  await waiting.opened;
  const blocked = await Promise.race([updates.request(C), new Promise(resolve => setTimeout(() => resolve('queued'), 2000))]);
  assert.ok(typeof blocked === 'object' && (blocked as { body: { code?: string } }).body.code === 'pinned', 'answered at once, refused by the pin');
  await updates.prune(async () => []);
  assert.equal(await withdrawRollback(onFrom(state, port.value)).then(answer => answer.state === 'refused' && answer.code), 'rollback-busy');
  assert.equal((await releaseStoragePin(state, { version: A })).released, false);
  quiet.open();
  const [one, two] = await Promise.all([first, second]);
  assert.ok('record' in one && 'record' in two && one.record.id === two.record.id && one.state === 'switched');
  assert.deepEqual([...new Set(port.holdIds)], [one.record.id]);
  const pin = await readStoragePin(state);
  assert.ok(pin.state === 'present' && pin.pin.rollbackId === one.record.id);
});

test('4. after the wait the database and the target are checked again; a change fails it and releases its hold', async t => {
  for (const change of ['database', 'artifact'] as const) {
    const state = await rollbackState(t);
    let inspections = 0;
    const port = ports({
      inspectStorage: async () => (++inspections === 1 || change !== 'database' ? databaseOfB() : { ...databaseOfB(), authority: [{ ...databaseOfB().authority[0], writerContract: 2 }] }),
      waitQuiet: async () => { if (change === 'artifact') { await rm(versionDirectory(state, A), { recursive: true }); await installArtifact(state, A, { salt: 'replaced' }); } return { state: 'quiet' }; },
    });
    const outcome = await ask(onFrom(state, port.value));
    assert.ok(outcome.state === 'failed' && outcome.record.failure?.phase === 'revalidate' && !outcome.record.held, change);
    assert.deepEqual([await currentVersion(state), port.holds.size], [B, 0], change);
  }
});

// ---- 5. Readiness before anything is pinned ----

test('5. a rollback is validated only on a settled service running this build, or on the owner\'s verification', async t => {
  const state = await rollbackState(t);
  await installArtifact(state, C);
  const check = async () => { const answer = await validateRollback(onFrom(state, ports().value), { target: A }); return answer.ok ? 'ok' : answer.code; };
  for (const [update, current, expected] of [
    [record(C, B, 'failed', { code: 'rollback-failed', failedStage: 'verifying' }), B, 'update-uncertain'],
    [record(B, A, 'done'), C, 'current-pointer'],
    [record(B, A, 'failed', { code: 'start-failed', failedStage: 'verifying' }), B, 'own-update-failed'],
    [record(B, A, 'failed', { code: 'rollback-failed', failedStage: 'verifying' }), B, 'update-uncertain'],
    [record(C, B, 'failed', { code: 'start-failed', failedStage: 'verifying' }), B, 'owner-verification-required'],
    [record(C, B, 'done'), B, 'owner-verification-required'],
  ] as const) {
    await save(state, update);
    await pointCurrent(state, current);
    assert.equal(await check(), expected, `${update.version} ${update.stage} ${update.code ?? ''} on ${current}`);
  }
  await save(state, record(C, B, 'failed', { code: 'start-failed', failedStage: 'verifying' }));
  assert.equal((await recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: true, kind: 'overwritten-done', by: 'owner', evidence: 'B serves; C went back' })).recorded, true);
  assert.equal(await check(), 'ok');
  await save(state, record(B, A, 'failed', { code: 'rollback-failed', failedStage: 'verifying' }));
  assert.equal((await recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: true, kind: 'own-failed', by: 'owner', evidence: 'B serves; nothing imported', cutoverMarkers: 'absent' })).recorded, true);
  assert.equal(await check(), 'ok', 'its own failed update, verified by the owner');
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B, { salt: 'another build' });
  assert.equal(await check(), 'current-artifact');
});

// ---- 6. Durable intents, and what each interruption leaves ----

test('6. a stop after the pin was written and before the record said so: asked again, the same rollback goes on', async t => {
  for (const pinLost of [false, true]) {
    const state = await rollbackState(t);
    const crashed = await ask(onFrom(state, ports().value, { now: failingWhen(() => onDisk(state)?.state === 'pinning' && existsSync(storagePinPath(state))) })).catch(error => error as Error);
    assert.ok(crashed instanceof Error);
    const id = onDisk(state)!.id;
    if (pinLost) await rm(storagePinPath(state));
    const port = ports();
    const outcome = await ask(onFrom(state, port.value));
    assert.ok(outcome.state === 'switched' && outcome.record.id === id, String(pinLost));
    const pin = await readStoragePin(state);
    assert.ok(pin.state === 'present' && pin.pin.rollbackId === id);
  }
});

test('6. a stop between the hold and its record: the hold is accounted for, released by a withdrawal or kept by a retry', async t => {
  for (const next of ['withdraw', 'retry'] as const) {
    const state = await rollbackState(t);
    const port = ports();
    const crashed = await ask(onFrom(state, port.value, { now: failingWhen(() => port.holds.size > 0 && onDisk(state)?.state === 'holding') })).catch(error => error as Error);
    assert.ok(crashed instanceof Error);
    assert.deepEqual([onDisk(state)?.state, onDisk(state)?.held, port.holds.size], ['holding', true, 1], 'the intent names the hold that is there');
    if (next === 'withdraw') {
      assert.equal((await withdrawRollback(onFrom(state, port.value))).state, 'withdrawn');
      assert.equal(port.holds.size, 0);
    } else {
      assert.equal((await ask(onFrom(state, port.value))).state, 'switched');
      assert.equal(new Set(port.holdIds).size, 1, 'the same hold, asked for again');
    }
  }
});

test('6. a stop between the switch intent and the pointer: the pointer decides, on either web', async t => {
  for (const web of ['from', 'target'] as const) {
    const state = await rollbackState(t);
    const port = ports({ waitQuiet: async () => ({ state: 'pending', reason: 'busy' }) });
    await ask(onFrom(state, port.value));
    const stopped = { ...onDisk(state)!, state: 'switching' };
    await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(stopped), { mode: 0o600 });
    const go = ports();
    if (web === 'target') {
      const outcome = await resumeRollback(onTarget(state, go.value));
      assert.ok(outcome.state === 'refused' && outcome.code === 'not-switched');
      assert.deepEqual([onDisk(state)?.state, await currentVersion(state)], ['held', B], 'nothing switched: the rollback is held again');
    } else {
      const outcome = await resumeRollback(onFrom(state, go.value));
      assert.equal(outcome.state, 'switched', JSON.stringify(outcome));
      assert.equal(await currentVersion(state), A);
    }
  }
});

test('6. a stop after the pointer moved: the target goes on; a pointer at neither version fails it and keeps its hold', async t => {
  const state = await rollbackState(t);
  const port = ports();
  const crashed = await ask(onFrom(state, port.value, { now: failingWhen(() => pointer(state).endsWith(A) && onDisk(state)?.state === 'switching') })).catch(error => error as Error);
  assert.ok(crashed instanceof Error);
  assert.deepEqual([onDisk(state)?.state, await currentVersion(state)], ['switching', A]);
  assert.equal((await resumeRollback(onTarget(state, port.value))).state, 'completed');

  const other = await rollbackState(t);
  await installArtifact(other, C);
  const otherPort = ports();
  await ask(onFrom(other, otherPort.value, { now: failingWhen(() => pointer(other).endsWith(A) && onDisk(other)?.state === 'switching') })).catch(() => undefined);
  await pointCurrent(other, C);
  const releases = otherPort.calls.filter(call => call === 'release').length;
  const outcome = await resumeRollback(onTarget(other, otherPort.value));
  assert.ok(outcome.state === 'failed' && outcome.record.failure?.phase === 'switch' && outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  assert.equal(otherPort.calls.filter(call => call === 'release').length, releases, 'nothing released on what cannot be told');
  assert.equal(otherPort.holds.size, 1);
});

test('6. the switch checks its facts once more: a pin that changed during the wait stops it before the pointer, and it is retried', async t => {
  const state = await rollbackState(t);
  let pinBytes = '';
  const port = ports({ waitQuiet: async () => {
    pinBytes = await readFile(storagePinPath(state), 'utf8');
    await writeFile(storagePinPath(state), JSON.stringify({ ...JSON.parse(pinBytes), rollbackId: 'another' }), { mode: 0o600 });
    return { state: 'quiet' };
  } });
  const outcome = await ask(onFrom(state, port.value));
  assert.ok(outcome.state === 'failed' && outcome.record.failure?.phase === 'pin' && !outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  assert.deepEqual([await currentVersion(state), port.holds.size], [B, 0]);
  await writeFile(storagePinPath(state), pinBytes, { mode: 0o600 });
  assert.equal((await ask(onFrom(state, ports().value))).state, 'switched', 'with its own pin back, the same rollback goes on');
});

test('6. a stop after the handoff took effect and before the record said so: it is settled from what serves, never sent again', async t => {
  const state = await rollbackState(t);
  const port = ports();
  assert.equal((await ask(onFrom(state, port.value))).state, 'switched');
  const crashed = await resumeRollback(onTarget(state, port.value, { now: failingWhen(() => port.calls.includes('handoff') && onDisk(state)?.state === 'handing-off') })).catch(error => error as Error);
  assert.ok(crashed instanceof Error);
  const stopped = onDisk(state)!;
  assert.deepEqual([stopped.state, stopped.handoff?.state], ['handing-off', 'sent']);
  port.calls.length = 0;
  assert.equal((await resumeRollback(onTarget(state, port.value))).state, 'completed');
  assert.deepEqual(port.calls, ['release'], 'no new hold, wait or handoff: the serving worker proves the target took over');
  assert.deepEqual(onDisk(state)!.handoff?.baseline, stopped.handoff?.baseline, 'judged against the baseline recorded before the handoff');
});

// ---- 7. Continuing on the target verifies what is actually there ----

test('7. continuing verifies the pointer, the pin, the build and the web that continues; a mismatch keeps the hold', async t => {
  for (const change of ['pointer', 'pin', 'artifact', 'web'] as const) {
    const state = await rollbackState(t);
    await installArtifact(state, C);
    const port = ports();
    assert.equal((await ask(onFrom(state, port.value))).state, 'switched');
    if (change === 'pointer') await pointCurrent(state, C);
    if (change === 'pin') { const pin = JSON.parse(await readFile(storagePinPath(state), 'utf8')); await writeFile(storagePinPath(state), JSON.stringify({ ...pin, rollbackId: 'another' }), { mode: 0o600 }); }
    if (change === 'artifact') { await rm(versionDirectory(state, A), { recursive: true }); await installArtifact(state, A, { salt: 'replaced' }); }
    const outcome = await resumeRollback(onTarget(state, port.value, change === 'web' ? { running: runningBuild(A, { salt: 'another build' }) } : {}));
    if (change === 'web') { assert.ok(outcome.state === 'refused' && outcome.code === 'not-target'); continue; }
    assert.ok(outcome.state === 'failed' && outcome.record.failure?.phase === 'verify', change);
    assert.ok(!port.calls.includes('handoff') && port.holds.size === 1, `${change}: nothing handed over, nothing released`);
  }
});

test('7. after a handoff that had no effect the hold is released; a retry holds and waits again before it hands over', async t => {
  const state = await rollbackState(t);
  let fails = true;
  const port = ports();
  const take = port.value.handoff;
  port.value.handoff = async (target, fence) => { if (!fails) return take(target, fence); port.calls.push('handoff'); throw new Error('worker busy'); };
  assert.equal((await ask(onFrom(state, port.value))).state, 'switched');
  const failed = await resumeRollback(onTarget(state, port.value));
  assert.ok(failed.state === 'failed' && failed.record.failure?.phase === 'handoff' && !failed.record.held);
  assert.equal(port.holds.size, 0);
  fails = false;
  port.calls.length = 0;
  let quiet: 'pending' | 'quiet' = 'pending';
  port.value.waitQuiet = async () => { port.calls.push('quiet'); return quiet === 'pending' ? { state: 'pending', reason: 'a turn runs' } : { state: 'quiet' }; };
  const waiting = await resumeRollback(onTarget(state, port.value));
  assert.ok(waiting.state === 'waiting' && waiting.record.switched, 'an earlier quiet is not taken for the present');
  quiet = 'quiet';
  assert.equal((await resumeRollback(onTarget(state, port.value))).state, 'completed');
  assert.deepEqual(port.calls, ['hold', 'quiet', 'hold', 'quiet', 'inspect', 'handoff', 'release']);
});

// ---- 8. Releasing holds is retried until it succeeds ----

test('8. a withdrawal or a completion whose release failed is retried, and reports nothing released before it is', async t => {
  const state = await rollbackState(t);
  let refuse = true;
  const port = ports({ waitQuiet: async () => ({ state: 'pending', reason: 'busy' }) });
  const release = port.value.releaseAdmission;
  port.value.releaseAdmission = async id => { if (refuse) throw new Error('worker did not answer'); await release(id); };
  await ask(onFrom(state, port.value));
  const first = await withdrawRollback(onFrom(state, port.value), { releasePin: true });
  assert.ok(first.state === 'refused' && first.code === 'hold-not-released');
  assert.deepEqual([onDisk(state)?.state, onDisk(state)?.held, (await readStoragePin(state)).state], ['withdrawn', true, 'present']);
  assert.equal((await releaseStoragePin(state, { version: A })).released, false, 'the pin stays while the hold may be there');
  refuse = false;
  const second = await withdrawRollback(onFrom(state, port.value), { releasePin: true });
  assert.ok(second.state === 'withdrawn' && !second.record.held && second.pin?.released === true);
  assert.equal(port.holds.size, 0);

  const done = await rollbackState(t);
  refuse = true;
  const quiet = ports();
  const releaseQuiet = quiet.value.releaseAdmission;
  quiet.value.releaseAdmission = async id => { if (refuse) throw new Error('worker did not answer'); await releaseQuiet(id); };
  await ask(onFrom(done, quiet.value));
  const completed = await resumeRollback(onTarget(done, quiet.value));
  assert.ok(completed.state === 'completed' && completed.record.held, 'kept, with its hold still to release');
  assert.equal((await evaluate(done, A)).code, 'rollback-hold-release');
  assert.equal((await releaseStoragePin(done, { version: A })).released, false);
  refuse = false;
  const settled = await resumeRollback(onTarget(done, quiet.value));
  assert.ok(settled.state === 'completed' && !settled.record.held);
  assert.equal((await evaluate(done, A)).verdict, 'ready');
});

// ---- 9. The pin is released only over a rollback that is over ----

test('9. the pin stays while its rollback record cannot be read, belongs to another rollback, is under way, or is missing', async t => {
  const state = await rollbackState(t);
  const port = ports({ waitQuiet: async () => ({ state: 'pending', reason: 'busy' }) });
  await ask(onFrom(state, port.value));
  const saved = await readFile(storageUpdatePaths(state).rollback);
  const tries: Array<[string, () => Promise<unknown>]> = [
    ['under way', async () => {}],
    ['garbled', () => writeFile(storageUpdatePaths(state).rollback, '{"format":"garbled"')],
    ['a folder', async () => { await rm(storageUpdatePaths(state).rollback); await mkdir(storageUpdatePaths(state).rollback); }],
    ['missing', () => rm(storageUpdatePaths(state).rollback, { recursive: true })],
    ['another rollback', () => writeFile(storageUpdatePaths(state).rollback, JSON.stringify({ ...JSON.parse(String(saved)), id: 'another', state: 'withdrawn', held: false }))],
  ];
  for (const [why, setup] of tries) {
    await setup();
    assert.equal((await releaseStoragePin(state, { version: A })).released, false, why);
    assert.equal((await readStoragePin(state)).state, 'present', why);
  }
  await writeFile(storageUpdatePaths(state).rollback, saved);
  assert.equal((await withdrawRollback(onFrom(state, port.value))).state, 'withdrawn');
  assert.equal((await releaseStoragePin(state, { version: A })).released, true);
});

// ---- 10. The target starts on the rollback's durable record ----

test('10. the target boots held while the worker is handed over, is ready once kept, and stays so after the pin is released', async t => {
  const state = await rollbackState(t);
  const updateSha = sha(updatePaths(state).status);
  const port = ports({ waitQuiet: async () => ({ state: 'pending', reason: 'a turn runs' }) });
  await ask(onFrom(state, port.value));
  assert.equal((await evaluate(state, B)).code, 'rollback-under-way', 'the build rolled back from changes nothing meanwhile');
  port.value.waitQuiet = async () => ({ state: 'quiet' });
  assert.equal((await ask(onFrom(state, port.value))).state, 'switched');
  const booting = await evaluate(state, A);
  assert.deepEqual([booting.verdict, booting.code, booting.importAllowed, storageHealth(booting).status], ['update-held', 'rollback-handoff', false, 200]);
  assert.equal((await resumeRollback(onTarget(state, port.value))).state, 'completed');
  const kept = await evaluate(state, A);
  assert.deepEqual([kept.verdict, kept.code], ['ready', 'owner-rollback']);
  assert.equal(sha(updatePaths(state).status), updateSha, 'B\'s update record is left exactly as it was');
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: port.value })).released, true);
  assert.equal((await evaluate(state, A)).code, 'owner-rollback', 'releasing the pin does not undo the rollback');
  assert.notEqual((await evaluateStorageUpdate({ stateDir: state, build: runningBuild(A, { salt: 'another build' }), managed: true })).verdict, 'ready', 'only the build rolled back to');
  // A later update replaces the record the rollback stood on: from then on that update decides.
  assert.equal((await updatesOn(state, A).request(C)).status, 202);
  assert.equal((await evaluate(state, A)).code, 'other-update-active');
});

test('10. a rollback that stopped after the switch is the owner\'s; its record and pin cannot be read: nothing is imported', async t => {
  const state = await rollbackState(t);
  const port = ports({ handoff: async () => { throw new Error('worker busy'); } });
  await ask(onFrom(state, port.value));
  await resumeRollback(onTarget(state, port.value));
  assert.deepEqual([(await evaluate(state, A)).verdict, (await evaluate(state, A)).code], ['recovery-required', 'rollback-failed']);
  await writeFile(storageUpdatePaths(state).rollback, '{');
  assert.equal((await evaluate(state, A)).code, 'rollback-record-unreadable');
  await rm(storageUpdatePaths(state).rollback);
  await rm(storagePinPath(state));
  await mkdir(storagePinPath(state));
  assert.equal((await evaluate(state, A)).code, 'pin-unreadable');
});

// ---- 11. The owner's receipt for this build's own failed update ----

test('11. a build\'s own failed update is recovered only through the owner\'s strict receipt; every other shape records nothing', async t => {
  const state = await rollbackState(t);
  const failed = record(B, A, 'failed', { code: 'start-failed', failedStage: 'verifying' });
  await save(state, failed);
  const receipt = (extra: Partial<Parameters<typeof recordUpdateRecoveryReceipt>[0]> = {}) => recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: true, kind: 'own-failed', by: 'owner', evidence: 'B serves; nothing imported', cutoverMarkers: 'absent', ...extra });
  const code = async (extra: Partial<Parameters<typeof recordUpdateRecoveryReceipt>[0]> = {}) => { const answer = await receipt(extra); return answer.recorded ? 'recorded' : answer.code; };
  assert.equal((await evaluate(state, B, { cutoverMarkers: 'absent' })).code, 'own-update-failed', 'refused by default');
  assert.equal(await code({ cutoverMarkers: 'present' }), 'cutover-markers');
  assert.equal(await code({ cutoverMarkers: 'unknown' }), 'cutover-markers');
  assert.equal(await code({ cutoverMarkers: undefined }), 'cutover-markers');
  assert.equal(await code({ build: runningBuild(B, { supported: false }) }), 'runtime-unsupported');
  assert.equal(await code({ kind: 'own-failed', evidence: '' }), 'invalid-request');
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal(await code(), 'hold');
  await rm(updatePaths(state).hold);
  await pointCurrent(state, A);
  assert.equal(await code(), 'current-pointer');
  await pointCurrent(state, B);
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B, { salt: 'another build' });
  assert.equal(await code(), 'current-artifact');
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B);
  await save(state, record(B, A, 'done'));
  assert.equal(await code(), 'not-own-failed');
  await save(state, record(C, B, 'failed', { code: 'start-failed' }));
  assert.equal(await code(), 'not-own-failed', 'a later update\'s failure is overwritten-done\'s');
  assert.equal(existsSync(storageUpdatePaths(state).receipt), false, 'no refusal wrote anything');

  await save(state, failed);
  assert.equal(await code(), 'recorded');
  assert.deepEqual([(await evaluate(state, B)).verdict, (await evaluate(state, B)).code], ['ready', 'owner-receipt']);
  assert.notEqual((await evaluateStorageUpdate({ stateDir: state, build: runningBuild(B, { salt: 'another build' }), managed: true })).verdict, 'ready', 'another build of B');
  await save(state, { ...failed, updatedAt: '2026-10-08T00:00:01.000Z' });
  assert.equal((await evaluate(state, B)).code, 'own-update-failed', 'another record voids it');
  await save(state, failed);
  await pointCurrent(state, A);
  assert.notEqual((await evaluate(state, B)).verdict, 'ready', 'another pointer voids it');
  await pointCurrent(state, B);
  // The receipt lets the other rules decide; it does not stand in for them: a previous version that cannot take over still refuses.
  await save(state, record(B, L, 'failed', { code: 'start-failed' }));
  await installArtifact(state, L, { legacy: true });
  assert.equal(await code(), 'recorded');
  assert.equal((await evaluate(state, B)).code, 'prerequisite-required');
});

test('11. a direct start of a build whose own update failed goes on to its direct rules once the owner verified it', async t => {
  const state = await stateDir(t);
  await save(state, record(B, A, 'failed', { code: 'start-failed' }));
  const direct = (extra: Partial<StorageUpdateInput> = {}) => evaluateStorageUpdate({ stateDir: state, build: runningBuild(B), managed: false, ...extra });
  assert.equal((await direct()).code, 'own-update-failed');
  assert.equal((await recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: false, kind: 'own-failed', by: 'owner', evidence: 'checkout run; nothing imported', cutoverMarkers: 'absent' })).recorded, true);
  assert.equal((await direct({ legacyFiles: async () => 'present' })).code, 'prerequisite-required', 'still needs its preparation evidence');
  assert.equal((await direct({ legacyFiles: async () => 'absent' })).code, 'new-state');
});
