import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readlinkSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStart } from '../../../server/instance/process-start.js';
import { entryPoint, pointCurrent, runtimePaths, storagePinPath, versionDirectory } from '../../../server/link/service.js';
import * as hold from '../../../server/link/storage-hold.js';
import { transitionBreakerPath, transitionLockPath } from '../../../server/link/storage-transition-lock.js';
import * as update from '../../../server/link/storage-update.js';
import {
  evaluateStorageUpdate, readRollbackRecord, recordPreparationEvidence, releaseStoragePin, resumeRollback, runRollback,
  storageUpdatePaths, type RollbackContext, type RollbackPorts, type RollbackRecord, type SavedUpdate, type ServingProof, type StorageUpdateInput,
} from '../../../server/link/storage-update.js';
import { handoffHeld, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import type { StoragePreflight } from '../../../server/storage/preflight.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { A, A0, B, C, installArtifact, openGate, preparedStorage, retentionA, runningBuild } from './fixtures/storage-builds.js';
import { rollbackWorld, type WorldOptions } from './fixtures/rollback-world.js';

/**
 * W0U correction 3 (w0u-fix3-invariants.md C1–C4), against the real producer. C1: a ready answer stands on the storage
 * files the preflight actually saw. C2: a completed rollback is verified as it is now whether or not its hold is still
 * counted. C3: the evaluator's held gate, the lost-ACK convergence, and the target's bootstrap proven by S's own
 * operation receipt (fake world here; the real StorageClient part is the `C3 real StorageClient` test). C4: every managed
 * hold writer and remover in the transition turn, removing only the generation it judged (memory hooks and real
 * separate processes, told apart in each test's name).
 */

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-storage-fix3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (version: string, previous: string, stage: SavedUpdate['stage'], extra: Partial<SavedUpdate> = {}): SavedUpdate => ({ version, previous, stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, JSON.stringify(value));
const onDisk = (state: string): RollbackRecord => JSON.parse(readFileSync(storageUpdatePaths(state).rollback, 'utf8'));
const count = (calls: string[], name: string) => calls.filter(call => call === name).length;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type FilesState = StoragePreflight['state'];
const files = (database: 'absent' | 'present', identity: NonNullable<FilesState>['identity'] = database === 'present' ? 'created' : 'absent', sidecars: ('wal' | 'shm')[] = []): FilesState =>
  ({ database, sidecars, identity, recovery: { state: 'clear' } });
const evaluate = (state: string, version: string, filesState: FilesState | 'unobserved', extra: Partial<StorageUpdateInput> = {}) => {
  const build = runningBuild(version, filesState === 'unobserved' ? {} : { state: filesState });
  if (filesState === 'unobserved') delete build.preflight.state;
  return evaluateStorageUpdate({ stateDir: state, build, managed: true, ...extra });
};
/** Everything under `dir`, so an evaluation is seen to create nothing. */
const listing = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

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
const onFrom = (state: string, port: RollbackPorts): RollbackContext =>
  ({ stateDir: state, running: runningBuild(B), managed: true, ports: port, serialize: work => updatesOn(state).exclusive(work) });
const onTarget = (state: string, port: RollbackPorts): RollbackContext =>
  ({ stateDir: state, running: runningBuild(A), managed: true, ports: port, serialize: work => work() });
const ask = (context: RollbackContext, target = A) => runRollback(context, { target, by: 'owner', reason: 'B misbehaves' });
/** The world, its serving proof looking the bootstrap receipt up by the producer's own command ID (W0I's part). */
const world = (options: WorldOptions = {}) => rollbackWorld({ bootstrapId: (update as { rollbackBootstrapCommandId?: WorldOptions['bootstrapId'] }).rollbackBootstrapCommandId, ...options });
async function switched(t: TestContext, options: WorldOptions = {}) {
  const state = await rollbackState(t);
  const fake = world(options);
  assert.equal((await ask(onFrom(state, fake.ports))).state, 'switched');
  return { state, world: fake };
}
async function completedHeld(t: TestContext, options: WorldOptions = {}) {
  const { state, world: fake } = await switched(t, options);
  const release = fake.ports.releaseAdmission;
  let refuse = true;
  fake.ports.releaseAdmission = async fence => { if (refuse) { fake.calls.push('release'); throw new Error('the worker did not answer'); } return release(fence); };
  const outcome = await resumeRollback(onTarget(state, fake.ports));
  assert.ok(outcome.state === 'completed' && outcome.record.held, JSON.stringify(outcome).slice(0, 300));
  return { state, world: fake, answer: () => { refuse = false; } };
}
const identityA = () => runningBuild(A).preflight.identity!;

// ---- C1. A ready answer stands on the storage files actually seen ----

test('C1. valid v2 evidence with the database absent: no direct readiness, whatever the identity says; nothing is created', async t => {
  const state = await stateDir(t);
  const manifest = storageManifest([retentionA], A);
  const build = runningBuild(A, { manifest });
  await recordPreparationEvidence(state, { context: { identity: build.preflight.identity!, manifest }, preflight: build.preflight, prepared: preparedStorage(), gate: openGate });
  const direct = (filesState: FilesState | 'unobserved') => evaluate(state, B, filesState, { managed: false, legacyFiles: async () => 'absent' });
  assert.deepEqual([(await direct(files('present'))).code, (await direct(files('present'))).importAllowed], ['direct-evidence', true], 'the database A prepared is there');
  const before = await listing(state);
  for (const identity of ['absent', 'created', 'creating', 'invalid'] as const) {
    const evaluation = await direct(files('absent', identity));
    assert.deepEqual([evaluation.verdict, evaluation.code, evaluation.importAllowed], ['recovery-required', 'known-storage-missing', false], `identity ${identity}`);
  }
  const unobserved = await direct('unobserved');
  assert.deepEqual([unobserved.verdict, unobserved.code, unobserved.importAllowed], ['recovery-required', 'storage-state-unobserved', false], 'a preflight that looked at no state directory');
  assert.deepEqual(await listing(state), before, 'no database, identity or other file was created by evaluating');
});

test('C1. a state directory with no history keeps its normal policy; one with any record of a storage does not', async t => {
  const state = await stateDir(t);
  const fresh = await evaluate(state, B, files('absent'), { managed: false, legacyFiles: async () => 'absent' });
  assert.deepEqual([fresh.code, fresh.importAllowed], ['new-state', true]);
  const plain = await evaluate(state, A0, files('absent'), { managed: false });
  assert.deepEqual([plain.code, plain.importAllowed], ['no-cutover', true], 'a build without cutover on a new state directory');
  for (const [why, seen] of [['identity recorded', files('absent', 'created')], ['WAL left', files('absent', 'absent', ['wal'])]] as const) {
    const evaluation = await evaluate(state, A0, seen, { managed: false });
    assert.deepEqual([evaluation.code, evaluation.importAllowed], ['known-storage-missing', false], why);
  }
  assert.equal((await evaluate(state, A0, 'unobserved', { managed: false })).code, 'storage-state-unobserved');
});

test('C1. managed starts: a kept update and the owner\'s rollback over a known storage need the database seen there', async t => {
  // A kept update of B, with A's evidence recorded here.
  {
    const state = await stateDir(t);
    await installArtifact(state, A);
    await installArtifact(state, B);
    await pointCurrent(state, B);
    await save(state, record(B, A, 'done'));
    assert.equal((await evaluate(state, B, files('absent'))).code, 'service-update-done', 'no history: the normal policy');
    const manifest = storageManifest([retentionA], A);
    const build = runningBuild(A, { manifest });
    await recordPreparationEvidence(state, { context: { identity: build.preflight.identity!, manifest }, preflight: build.preflight, prepared: preparedStorage(), gate: openGate });
    assert.deepEqual([(await evaluate(state, B, files('absent'))).code, (await evaluate(state, B, files('absent'))).importAllowed], ['known-storage-missing', false]);
    assert.equal((await evaluate(state, B, files('present'))).code, 'service-update-done');
    assert.equal((await evaluate(state, B, 'unobserved')).code, 'storage-state-unobserved');
  }
  // The owner's rollback to A, validated on B's storage.
  const { state, world: fake } = await switched(t);
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
  assert.deepEqual([(await evaluate(state, A, files('present'))).code, (await evaluate(state, A, files('present'))).importAllowed], ['owner-rollback', true]);
  for (const seen of [files('absent'), files('absent', 'created'), 'unobserved'] as const) {
    const evaluation = await evaluate(state, A, seen);
    assert.deepEqual([evaluation.verdict, evaluation.importAllowed], ['recovery-required', false], JSON.stringify(seen));
  }
});

// ---- C2. A completed rollback, verified as it is now ----

test('C2. a completed rollback whose hold is released is still verified as it is now; only the release call is skipped', async t => {
  const { state, world: fake } = await switched(t);
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
  assert.equal(onDisk(state).held, false);
  const proofs = fake.proofs();
  const releases = count(fake.calls, 'release');
  const again = await resumeRollback(onTarget(state, fake.ports));
  assert.ok(again.state === 'completed' && !again.record.held, JSON.stringify(again).slice(0, 200));
  assert.ok(fake.proofs() > proofs, 'the serving worker was asked');
  assert.equal(count(fake.calls, 'release'), releases, 'nothing to release');
});

test('C2. a released completed rollback whose operation or serving worker changed is not answered as completed', async t => {
  for (const change of ['pointer', 'update', 'pin-build', 'artifact', 'entry', 'worker', 'proof-fails'] as const) {
    const { state, world: fake } = await switched(t);
    assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed', change);
    const pinPath = storagePinPath(state);
    const pin = JSON.parse(await readFile(pinPath, 'utf8'));
    if (change === 'pointer') await pointCurrent(state, C);
    if (change === 'update') await save(state, record(C, B, 'failed', { code: 'start-failed' }));
    if (change === 'pin-build') await writeFile(pinPath, JSON.stringify({ ...pin, entrySha256: 'f'.repeat(64) }), { mode: 0o600 });
    if (change === 'artifact') { await rm(versionDirectory(state, A), { recursive: true }); await installArtifact(state, A, { salt: 'replaced' }); }
    if (change === 'entry') await writeFile(entryPoint(versionDirectory(state, A)), '// another entry\n');
    if (change === 'worker') fake.state.serving = { ...fake.state.serving, sourceHash: 'f'.repeat(64) };
    if (change === 'proof-fails') fake.ports.servingProof = async () => { throw new Error('the worker did not answer'); };
    const releases = count(fake.calls, 'release');
    const outcome = await resumeRollback(onTarget(state, fake.ports));
    assert.ok(outcome.state === 'refused' && outcome.code === 'cleanup-unproven', `${change}: ${JSON.stringify(outcome).slice(0, 200)}`);
    assert.equal(count(fake.calls, 'release'), releases, change);
  }
  // The owner released the pin: the completed operation keeps its authority, still verified.
  const { state, world: fake } = await switched(t);
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: fake.ports })).released, true);
  const proofs = fake.proofs();
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed', 'pin: optional');
  assert.ok(fake.proofs() > proofs);
});

test('C2. a superseded past rollback is answered as past, never as the current completion, and a new rollback gets its own ID', async t => {
  const { state, world: fake } = await switched(t);
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
  const first = onDisk(state).id;
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: fake.ports })).released, true);
  await save(state, record(B, A, 'done', { startedAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }));
  const proofs = fake.proofs();
  const past = await resumeRollback(onTarget(state, fake.ports));
  assert.ok(past.state === 'refused' && past.code === 'rollback-past', JSON.stringify(past).slice(0, 200));
  assert.equal(fake.proofs(), proofs, 'the past is not proven against what serves now');
  await pointCurrent(state, B);
  const second = await ask(onFrom(state, world().ports));
  assert.ok(second.state === 'switched' && second.record.id !== first, JSON.stringify(second).slice(0, 200));
});

// ---- C3. The held gate, the lost ACK, and the bootstrap receipt ----

test('C3. while the hold is counted, an empty storage that became current is unknown: nothing is released, the pin stays', async t => {
  const { state, world: fake, answer } = await completedHeld(t, { storage: 'empty' });
  const id = onDisk(state).id;
  const attempt = onDisk(state).handoff!.attempt;
  // The release had reached the worker after all, and the target bootstrapped, even with the deterministic ID.
  fake.holds.clear();
  fake.prepareEmpty(update.rollbackBootstrapCommandId?.({ id, attempt }) ?? 'rollback-bootstrap:x', identityA());
  answer();
  const releases = count(fake.calls, 'release');
  const outcome = await resumeRollback(onTarget(state, fake.ports));
  assert.ok(outcome.state === 'refused' && outcome.code === 'cleanup-unproven', JSON.stringify(outcome).slice(0, 300));
  assert.deepEqual([count(fake.calls, 'release'), onDisk(state).held], [releases, true]);
  const pin = await releaseStoragePin(state, { version: A }, { ports: fake.ports });
  assert.deepEqual([pin.released, pin.code], [false, 'hold-not-released']);
  assert.notEqual((await evaluate(state, A, files('present'))).verdict, 'ready');
});

test('C3. a lost ACK converges by the same logical release under a new fence while still empty; then bootstrap, proven by its receipt', async t => {
  const { state, world: fake, answer } = await completedHeld(t, { storage: 'empty' });
  const before = onDisk(state);
  // The release reached the worker; its answer was lost. The target is still empty, epoch 0, unclaimed.
  fake.holds.clear();
  assert.notEqual((await evaluate(state, A, files('absent'))).verdict, 'ready', 'held: no bootstrap');
  answer();
  const released = await resumeRollback(onTarget(state, fake.ports));
  assert.ok(released.state === 'completed' && !released.record.held, JSON.stringify(released).slice(0, 300));
  assert.ok(released.record.attempt!.n > before.attempt!.n, 'a new fence');
  assert.deepEqual([released.record.id, released.record.handoff], [before.id, before.handoff], 'the same rollback, handoff and baseline');
  assert.deepEqual([fake.state.storage.kind, fake.state.epoch, count(fake.calls, 'handoff')], ['empty', 0, 1]);
  // Released: the target's normal bootstrap goes ahead, with the producer's deterministic ID for an empty storage.
  assert.deepEqual([(await evaluate(state, A, files('absent'))).code, (await evaluate(state, A, files('absent'))).importAllowed], ['owner-rollback', true]);
  const rollback = await readRollbackRecord(state);
  const commandId = update.bootstrapPrepareCommandId(rollback, 'empty', identityA());
  assert.equal(commandId, update.rollbackBootstrapCommandId({ id: before.id, attempt: before.handoff!.attempt }));
  assert.match(commandId!, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.equal(update.bootstrapPrepareCommandId(rollback, 'current', identityA()), undefined, 'a storage already there: a fresh ID');
  fake.prepareEmpty(commandId!, identityA());
  const proofs = fake.proofs();
  const done = await resumeRollback(onTarget(state, fake.ports));
  assert.ok(done.state === 'completed' && !done.record.held, JSON.stringify(done).slice(0, 300));
  assert.ok(fake.proofs() > proofs);
  // A cold restart claims anew with a fresh ID: still proven (claim 2 >= receipt 1).
  fake.prepareAgain(`prepare-${randomBytes(8).toString('hex')}`, identityA());
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: fake.ports })).released, true);
});

test('C3. a creation not committed (crash before it), retried cold with the same deterministic ID, is proven', async t => {
  const { state, world: fake } = await switched(t, { storage: 'empty' });
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
  const commandId = update.bootstrapPrepareCommandId(await readRollbackRecord(state), 'empty', identityA())!;
  // The first try stopped before its commit: nothing there, the receipt not found.
  assert.equal(fake.lookup(commandId).found, false);
  assert.equal(update.bootstrapPrepareCommandId(await readRollbackRecord(state), 'empty', identityA()), commandId, 'still empty: the same ID');
  fake.prepareEmpty(commandId, identityA());
  assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed');
});

test('C3. a released empty storage that became current without its own receipt is refused: cleanup and the pin release alike', async t => {
  const variants = ['no-receipt', 'fresh-id', 'other-storage', 'omitted', 'malformed', 'created-false', 'scope', 'command', 'payload', 'epoch-mismatch', 'zero-epoch',
    'creator-version', 'creator-source', 'creator-epoch', 'no-core', 'gate-closed', 'other-claimant', 'unclaimed', 'handoff-not-done'] as const;
  for (const variant of variants) {
    const { state, world: fake } = await switched(t, { storage: 'empty' });
    assert.equal((await resumeRollback(onTarget(state, fake.ports))).state, 'completed', variant);
    const commandId = update.bootstrapPrepareCommandId?.(await readRollbackRecord(state), 'empty', identityA()) ?? 'rollback-bootstrap:x';
    if (variant === 'no-receipt') fake.bootstrap();
    else if (variant === 'fresh-id') fake.prepareEmpty(`prepare-${randomBytes(8).toString('hex')}`, identityA());
    else if (variant === 'other-storage') { fake.prepareEmpty(commandId, identityA()); fake.replaceStorage('00000000-0000-4000-8000-0000000000ff'); }
    else {
      fake.prepareEmpty(commandId, identityA());
      const receipt = fake.state.receipts.get(commandId)!;
      const value = (receipt.result as { value: Record<string, unknown> }).value;
      if (variant === 'omitted') receipt.result = { state: 'omitted', bytes: 120, sha256: 'a'.repeat(64), limit: 1024 };
      if (variant === 'malformed') receipt.result = { state: 'included', value: 'not an object' };
      if (variant === 'created-false') value.created = false;
      if (variant === 'scope') receipt.scope = 'retention';
      if (variant === 'command') receipt.command = 'write';
      if (variant === 'payload') receipt.payloadSha256 = sha256(JSON.stringify({ allowMigration: true, storageId: 'another' }));
      if (variant === 'epoch-mismatch') value.ownerEpoch = 2;
      if (variant === 'zero-epoch') { value.ownerEpoch = 0; receipt.ownerEpoch = 0; }
      if (variant === 'creator-version') fake.state.rows = fake.state.rows!.map(row => ({ ...row, appVersion: B }));
      if (variant === 'creator-source') fake.state.rows = fake.state.rows!.map(row => ({ ...row, sourceHash: 'f'.repeat(64) }));
      if (variant === 'creator-epoch') fake.state.rows = fake.state.rows!.map(row => ({ ...row, ownerEpoch: 2 }));
      if (variant === 'no-core') value.applied = (value.applied as { scope: string }[]).filter(item => item.scope !== 'core');
      if (variant === 'gate-closed') fake.state.gate = false;
      if (variant === 'other-claimant') fake.otherClaim();
      if (variant === 'unclaimed') fake.state.claim = undefined;
      if (variant === 'handoff-not-done') fake.state.handoffs.clear();
    }
    const releases = count(fake.calls, 'release');
    const outcome = await resumeRollback(onTarget(state, fake.ports));
    assert.ok(outcome.state === 'refused' && outcome.code === 'cleanup-unproven', `${variant}: ${JSON.stringify(outcome).slice(0, 200)}`);
    const pin = await releaseStoragePin(state, { version: A }, { ports: fake.ports });
    assert.deepEqual([pin.released, pin.code, count(fake.calls, 'release')], [false, 'serving-unproven', releases], variant);
    assert.ok(existsSync(storagePinPath(state)), variant);
  }
});

test('C3 real StorageClient: the producer\'s proof reads what S actually commits, and refuses a fresh ID, another storage and a replay', async t => {
  const { openFixture, stateDir: storageDir, storage } = await import('../storage/helpers.js');
  const dir = await storageDir(t);
  const client = await openFixture(t, dir);
  const identity = client.identity!;
  const fence = { id: 'real-rollback-1', attempt: 3 };
  const commandId = update.rollbackBootstrapCommandId(fence);
  const created = await client.prepare({ allowMigration: true, commandId });
  assert.deepEqual([created.created, created.ownerEpoch, created.claimed], [true, 1, true]);
  const proofOf = async (lookupId = commandId, source = client): Promise<ServingProof> => {
    const inspection = await source.inspect();
    return {
      worker: { version: identity.appVersion, sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest, protocol: identity.protocol, pid: 4242, start: 'started-4242' },
      status: { state: 'ready', ...(source.status().ownerEpoch !== undefined ? { ownerEpoch: source.status().ownerEpoch } : {}) },
      inspection: { schema: inspection.schema, authority: inspection.authority, ownerEpoch: inspection.ownerEpoch },
      gate: { open: (await source.gate('core')).open }, handoff: 'done', bootstrap: await source.receipt(lookupId),
    };
  };
  const completed = (extra: Partial<RollbackRecord> = {}): RollbackRecord => ({
    format: 'tower-storage-rollback', version: 1, id: fence.id, from: '9.9.9', target: identity.appVersion, sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest,
    entrySha256: 'e'.repeat(64), updateSha256: null, storage: { kind: 'empty' }, state: 'completed', by: 'owner', reason: '', held: false, switched: true,
    handoff: { attempt: fence.attempt, state: 'done', baseline: { worker: { version: '9.9.9', sourceHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64), protocol: identity.protocol, pid: 1, start: 's' }, storage: { kind: 'empty' }, ownerEpoch: 0, at } },
    startedAt: at, updatedAt: at, ...extra,
  });
  const verdict = (proof: ServingProof, rollback = completed()) => update.completionProven(rollback, proof);
  const proof = await proofOf();
  assert.equal(proof.bootstrap?.found && proof.bootstrap.receipt.result.state, 'included');
  assert.deepEqual(verdict(proof), { ok: true }, 'what S committed in one transaction proves the creation');
  assert.equal(verdict(proof, completed({ held: true })).ok, false, 'never while the hold is counted');
  assert.equal(verdict(proof, completed({ handoff: { ...completed().handoff!, attempt: 4 } })).ok, false, 'another attempt\'s ID');
  // A cold restart: a fresh claim, the receipt and the creator rows unchanged.
  await client.close();
  await client.reopen();
  await client.prepare({ allowMigration: false });
  assert.deepEqual(verdict(await proofOf()), { ok: true }, 'claim 2 >= receipt 1');
  // Replaying the deterministic ID on the storage that is there claims nothing new: no current claim, not proven.
  await client.close();
  await client.reopen();
  const replayed = await client.prepare({ allowMigration: true, commandId });
  assert.deepEqual([replayed.replayed, replayed.claimed], [true, false]);
  assert.equal(verdict(await proofOf()).ok, false, 'a replay is not a claim');
  // A storage created with a fresh ID has no receipt under the deterministic one.
  const freshDir = await storageDir(t);
  const fresh = await openFixture(t, freshDir);
  await fresh.prepare({ allowMigration: true });
  assert.equal((await proofOf(commandId, fresh)).bootstrap?.found, false);
  assert.equal(verdict(await proofOf(commandId, fresh)).ok, false, 'fresh ID');
  // Another storage's receipt beside this storage's inspection: the payload names another storageId.
  const otherDir = await storageDir(t);
  const other = await openFixture(t, otherDir);
  await other.prepare({ allowMigration: true, commandId });
  const mixed = { ...await proofOf(commandId, fresh), bootstrap: await other.receipt(commandId) };
  assert.equal(verdict(mixed).ok, false, 'foreign storageId');
  // The smallest maxResultBytes S allows: the receipt is still included (it is small); omitted is refused as such.
  const smallDir = await storageDir(t);
  const small = await storage.openStorage({ stateDir: smallDir, bundle: (await import('../storage/helpers.js')).threadBundle('fixture'), limits: { maxResultBytes: 1024 } });
  t.after(() => small.close());
  await small.prepare({ allowMigration: true, commandId });
  const smallProof = await proofOf(commandId, small);
  const state = smallProof.bootstrap?.found ? smallProof.bootstrap.receipt.result.state : 'missing';
  t.diagnostic(`maxResultBytes 1024: the bootstrap receipt is ${state}`);
  if (smallProof.bootstrap?.found) {
    const omitted = { ...smallProof, bootstrap: { found: true as const, receipt: { ...smallProof.bootstrap.receipt, result: { state: 'omitted' as const, bytes: 200, sha256: 'a'.repeat(64), limit: 1024 } } } };
    assert.equal(verdict(omitted).ok, false, 'omitted');
  }
});

// ---- C4. The hold: one turn for every managed writer and remover, the judged generation only ----

const old = () => new Date(Date.now() - 60 * 60_000);
async function oldHold(state: string, version = '1.1.0') {
  await hold.writeHold(state, version);
  await utimes(hold.holdPath(state), old(), old());
}
function child(t: TestContext, args: string[]) {
  const script = fileURLToPath(new URL('./fixtures/hold-child.ts', import.meta.url));
  const process_ = spawn(process.execPath, ['--import', 'tsx', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  process_.stdout.on('data', chunk => { out += String(chunk); });
  process_.stderr.on('data', chunk => { out += String(chunk); });
  t.after(() => { if (process_.exitCode === null && process_.signalCode === null) process_.kill(); });
  return new Promise<{ code: number | null; answer: { ok: boolean; result?: unknown; code?: string } | undefined; out: string }>(resolve => process_.on('close', code => {
    const line = out.trim().split('\n').reverse().find(item => item.startsWith('{'));
    resolve({ code, answer: line ? JSON.parse(line) : undefined, out });
  }));
}
async function until(check: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('C4 memory hook. a hold replaced by another version right before its removal is not removed; the remover refuses', async t => {
  const state = await stateDir(t);
  const path = hold.holdPath(state);
  await hold.writeHold(state, '1.1.0');
  const original = { unlink: fsPromises.unlink, rename: fsPromises.rename };
  let swapped = 0;
  const swap = () => { if (!swapped++) { unlinkSync(path); writeFileSync(path, JSON.stringify({ version: '2.0.0' }), { mode: 0o600 }); } };
  t.mock.method(fsPromises, 'unlink', async (...args: Parameters<typeof original.unlink>) => { if (args[0] === path) swap(); return original.unlink(...args); });
  t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof original.rename>) => { if (args[0] === path) swap(); return original.rename(...args); });
  syncBuiltinESMExports();
  let outcome: unknown;
  try { outcome = await hold.removeHold(state, { version: '1.1.0' }).catch(error => error); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(swapped, 1);
  assert.ok(outcome instanceof hold.HoldError && outcome.code === 'hold-replaced', String(outcome));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: '2.0.0' }, 'the other version\'s hold is there');
});

test('C4 memory hook. an expired hold judged old, then touched before its removal, is kept: the judgment is not taken for the new generation', async t => {
  const state = await stateDir(t);
  const path = hold.holdPath(state);
  await oldHold(state);
  const original = { unlink: fsPromises.unlink, rename: fsPromises.rename };
  let touched = 0;
  const touch = () => { if (!touched++) { const now = new Date(); utimesSync(path, now, now); } };
  t.mock.method(fsPromises, 'unlink', async (...args: Parameters<typeof original.unlink>) => { if (args[0] === path) touch(); return original.unlink(...args); });
  t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof original.rename>) => { if (args[0] === path) touch(); return original.rename(...args); });
  syncBuiltinESMExports();
  let held: unknown;
  try { held = await handoffHeld(state).catch(error => error); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(touched, 1);
  assert.equal(held, true, 'still held');
  assert.ok(existsSync(path) && Date.now() - (await stat(path)).mtimeMs < 60_000, 'the refreshed hold is kept');
});

test('C4 memory hook. a hold replaced right after it was read, before the turn, is not removed by that read', async t => {
  const state = await stateDir(t);
  const path = hold.holdPath(state);
  await oldHold(state);
  const read = await hold.observeHold(state);
  assert.ok(read.state === 'present');
  unlinkSync(path);
  await hold.writeHold(state, '1.1.0');
  await assert.rejects(hold.removeHold(state, { generation: read.generation }), { code: 'hold-replaced' });
  assert.ok(existsSync(path), 'a new hold of the same version is not removed by the old observation');
  const again = await hold.observeHold(state);
  assert.ok(again.state === 'present');
  assert.equal(await hold.removeHold(state, { generation: again.generation }), true, 'its own generation goes');
  assert.equal(existsSync(path), false);
});

test('C4 real processes. an expired hold judged by this web while another process holds the turn and refreshes it: kept, still held', async t => {
  const state = await stateDir(t);
  await oldHold(state);
  const marks = join(state, 'marks');
  appendFileSync(marks, '');
  const refresher = child(t, [state, marks, 'turn', '1.1.0', '400']);
  await until(() => readFileSync(marks, 'utf8').includes('enter'));
  const started = Date.now();
  const held = await handoffHeld(state).catch(error => error);
  const waited = Date.now() - started;
  const done = await refresher;
  assert.deepEqual([done.code, done.answer], [0, { ok: true, result: 'refreshed' }], done.out);
  assert.equal(held, true, `the web waited ${waited} ms for the turn and found the hold refreshed`);
  assert.ok(existsSync(hold.holdPath(state)) && Date.now() - (await stat(hold.holdPath(state))).mtimeMs < 60_000);
  assert.ok(waited >= 100, `the removal waited for the other process's turn (${waited} ms)`);
});

test('C4 real processes. another process replacing the generation judged here (same or another version) keeps it; the same generation goes', async t => {
  for (const next of ['1.1.0', '2.0.0'] as const) {
    const state = await stateDir(t);
    await oldHold(state);
    const judged = await hold.observeHold(state);
    assert.ok(judged.state === 'present');
    const marks = join(state, 'marks');
    const removed = await child(t, [state, marks, 'remove', '1.1.0']);
    assert.deepEqual(removed.answer, { ok: true, result: true }, removed.out);
    const written = await child(t, [state, marks, 'write', next]);
    assert.deepEqual(written.answer, { ok: true, result: 'created' }, written.out);
    await assert.rejects(hold.removeHold(state, { generation: judged.generation }), { code: 'hold-replaced' }, next);
    assert.deepEqual(JSON.parse(await readFile(hold.holdPath(state), 'utf8')), { version: next }, next);
  }
  const state = await stateDir(t);
  await oldHold(state);
  const judged = await hold.observeHold(state);
  assert.ok(judged.state === 'present');
  assert.equal(await hold.removeHold(state, { generation: judged.generation }), true);
});

test('C4. an expired hold beside a helper lock: removed only once no helper can be running; running, invalid or unreadable keep it', async t => {
  const own = (await processStart(process.pid))!;
  for (const [lock, expected] of [
    [`${process.pid} ${own}`, true], ['not a lock', true], [`${deadPid()} Thu Jan  1 00:00:00 1970`, false], ['link', 'throws'], [undefined, false],
  ] as const) {
    const state = await stateDir(t);
    await oldHold(state);
    if (lock === 'link') await symlink(join(state, 'nowhere'), updatePaths(state).lock);
    else if (lock !== undefined) await writeFile(updatePaths(state).lock, lock, { mode: 0o600 });
    const held = await handoffHeld(state).then(value => value, () => 'throws');
    assert.equal(held, expected, `${lock}`);
    assert.equal(existsSync(hold.holdPath(state)), expected !== false, `${lock}: the hold ${expected === false ? 'goes' : 'stays'}`);
  }
});

test('C4. the turn refused (busy, or a stale breaker) keeps the hold and holds; the breaker and lock are left as they are', async t => {
  const state = await stateDir(t);
  await oldHold(state);
  const ownerFile = (role: 'lock' | 'breaker', pid: number) => JSON.stringify({ format: 'tower-transition-owner', version: 1, role, pid, start: 'gone', nonce: randomBytes(10).toString('hex') });
  writeFileSync(transitionLockPath(state), ownerFile('lock', deadPid()), { mode: 0o600 });
  writeFileSync(transitionBreakerPath(state), ownerFile('breaker', deadPid()), { mode: 0o600 });
  const before = [readFileSync(transitionLockPath(state)), readFileSync(transitionBreakerPath(state))];
  await assert.rejects(handoffHeld(state), { code: 'transition-lock-stale-breaker' });
  assert.ok(existsSync(hold.holdPath(state)));
  await assert.rejects(hold.writeHold(state, '1.1.0'), { code: 'transition-lock-stale-breaker' });
  assert.deepEqual([readFileSync(transitionLockPath(state)), readFileSync(transitionBreakerPath(state))], before);
});

test('C4. links, FIFOs, folders and garbage at the hold: no observation removes them; their bytes and targets are left', async t => {
  for (const shape of ['link', 'dangling', 'fifo', 'folder', 'garbage'] as const) {
    const state = await stateDir(t);
    const path = hold.holdPath(state);
    const target = join(state, 'target');
    if (shape === 'link') { await writeFile(target, 'ORIGINAL'); await symlink(target, path); }
    if (shape === 'dangling') await symlink(target, path);
    if (shape === 'fifo') spawnSync('mkfifo', [path]);
    if (shape === 'folder') await mkdir(path);
    if (shape === 'garbage') { await writeFile(path, '{', { mode: 0o600 }); await utimes(path, old(), old()); }
    if (shape === 'garbage') {
      // A plain file nobody can read as a hold, judged old: its own generation goes, nothing else.
      const judged = await hold.observeHold(state);
      assert.ok(judged.state === 'present' && judged.generation.version === undefined);
      await writeFile(path, '{"', { mode: 0o600 });
      await assert.rejects(hold.removeHold(state, { generation: judged.generation }), { code: 'hold-replaced' });
      assert.equal(await readFile(path, 'utf8'), '{"');
      continue;
    }
    await assert.rejects(hold.observeHold(state), { code: 'hold-not-a-file' }, shape);
    await assert.rejects(handoffHeld(state), Error, shape);
    await assert.rejects(hold.writeHold(state, '1.1.0'), { code: 'hold-not-a-file' }, shape);
    if (shape === 'link') assert.deepEqual([readlinkSync(path), await readFile(target, 'utf8')], [target, 'ORIGINAL']);
    if (shape === 'dangling') assert.equal(existsSync(target), false);
    if (shape === 'fifo') assert.ok((await fsPromises.lstat(path)).isFIFO());
    if (shape === 'folder') assert.ok((await fsPromises.lstat(path)).isDirectory());
  }
});

test('C4. the helper\'s release that fails after it kept the update is recorded on the update, not swallowed', async t => {
  const state = await stateDir(t);
  for (const version of ['1.0.0', '1.1.0']) await mkdir(versionDirectory(state, version), { recursive: true });
  await pointCurrent(state, '1.0.0');
  await save(state, record('1.1.0', '1.0.0', 'installing'));
  let clock = Date.parse(at);
  let pid = 1;
  const steps: UpdateHelperSteps = {
    free: async () => undefined, install: async version => versionDirectory(state, version), check: async () => {}, point: async version => { await pointCurrent(state, version); },
    restart: async () => { pid++; }, health: async () => ({ version: '1.1.0', pid }), controllers: async () => [], log: () => {},
    sleep: async ms => {
      clock += ms;
      // Meanwhile something other than this update replaced its hold.
      if (existsSync(hold.holdPath(state)) && JSON.parse(readFileSync(hold.holdPath(state), 'utf8')).version === '1.1.0') {
        renameSync(hold.holdPath(state), `${hold.holdPath(state)}.gone`);
        writeFileSync(hold.holdPath(state), JSON.stringify({ version: '9.9.9' }), { mode: 0o600 });
      }
    },
    now: () => clock,
  };
  const status = await runUpdateHelper(state, '1.1.0', steps);
  const saved = JSON.parse(readFileSync(updatePaths(state).status, 'utf8')) as SavedUpdate & { hold?: { code: string } };
  assert.equal(status?.stage, 'done');
  assert.equal(saved.hold?.code, 'hold-owned-elsewhere', JSON.stringify(saved));
  assert.deepEqual(JSON.parse(readFileSync(hold.holdPath(state), 'utf8')), { version: '9.9.9' }, 'the other hold is left');
});

test('C4. recovery writes and removes the hold in the turn, and does not remove a hold of a new update recorded after it judged', async t => {
  const state = await stateDir(t);
  await save(state, record('1.1.0', '1.0.0', 'failed', { code: 'start-failed' }));
  await hold.writeHold(state, '1.1.0');
  // Between the record recovery judged and its removal, a new update to 1.1.0 is recorded and holds again.
  const original = fsPromises.open;
  let changed = 0;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    if (args[0] === hold.holdPath(state) && !changed++) await save(state, record('1.1.0', '1.0.0', 'switching', { startedAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }));
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: () => {} }).recover(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(changed > 0);
  assert.ok(existsSync(hold.holdPath(state)), 'the new update\'s hold stays');
});
