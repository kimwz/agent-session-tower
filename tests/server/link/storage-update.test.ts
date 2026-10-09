import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VERSION } from '../../../shared/app-identity.js';
import { currentVersion, entryPoint, pointCurrent, pointRollbackTarget, runtimePaths, storagePinPath, useVersion, versionDirectory } from '../../../server/link/service.js';
import {
  chainAsked, describeArtifactStorageContract, evaluateStorageUpdate, nextChainStep, parseArtifactStorageContract, preparationCheck, probeInstalledArtifact,
  readCurrentPointer, readHelperLock, readHold, readPreparationEvidence, readRollbackRecord, readStoragePin, readUpdateRecord, recordPreparationEvidence,
  recordUpdateRecoveryReceipt, releaseStoragePin, resumeRollback, runRollback, storageHealth, storageUpdatePaths, validateRollback, withdrawRollback,
  type ArtifactRead, type ChainProgress, type RollbackContext, type RollbackPorts, type SavedUpdate, type StorageUpdateInput,
} from '../../../server/link/storage-update.js';
import { readUpdateStatus, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { TowerAutoUpdate } from '../../../server/updates/tower.js';
import { CORE_MIGRATIONS, storageManifest } from '../../../server/storage/schema.js';
import { A, A0, B, C, L, identityOf, installArtifact, manifests, openGate, preparedStorage, runningBuild } from './fixtures/storage-builds.js';
import { appliedFor, databaseOfB, rollbackWorld } from './fixtures/rollback-world.js';

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-storage-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}
const at = '2026-10-08T00:00:00.000Z';
const record = (version: string, previous: string, stage: SavedUpdate['stage'], extra: Partial<SavedUpdate> = {}): SavedUpdate => ({ version, previous, stage, startedAt: at, updatedAt: at, ...extra });
const save = (state: string, value: unknown) => writeFile(updatePaths(state).status, typeof value === 'string' ? value : JSON.stringify(value));
/** A pid no process has: a child that already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const evaluate = (state: string, version: string, extra: Partial<StorageUpdateInput> = {}) => evaluateStorageUpdate({ stateDir: state, build: runningBuild(version), managed: true, ...extra });

/** Every file under `root` with its bytes, for a before/after comparison. */
async function tree(root: string, skip: (path: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (skip(path)) continue;
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else out[path] = info.isSymbolicLink() ? `link:${await readlink(path)}` : (await readFile(path)).toString('base64');
    }
  };
  await walk(root);
  return out;
}

// ---- Strict reads ----

test('the update record is told apart: absent, active, terminal, invalid, and unreadable', async t => {
  const state = await stateDir(t);
  assert.deepEqual(await readUpdateRecord(state), { state: 'absent' });
  await save(state, record(B, A, 'verifying', { controllers: ['controller-a'] }));
  assert.equal((await readUpdateRecord(state)).state, 'active');
  await save(state, { ...record(B, A, 'done'), carriedBy: 'a newer helper' });
  assert.equal((await readUpdateRecord(state)).state, 'terminal', 'fields a newer helper carries over do not make it unusable');
  for (const [bad, why] of [['{', 'not JSON'], [record(B, A, 'paused' as SavedUpdate['stage']), 'unknown stage'], [record(B, A, 'failed', { code: 'eaten' as SavedUpdate['code'] }), 'unknown failure'],
    [record(B, 'dev', 'done'), 'previous not a release'], [{ ...record(B, A, 'failed'), storage: { code: 'whatever' } }, 'unknown storage failure']] as const) {
    await save(state, bad);
    const read = await readUpdateRecord(state);
    assert.equal(read.state, 'invalid', why);
    assert.equal(await readUpdateStatus(state), undefined, 'the old reader still answers nothing for it');
  }
  await rm(updatePaths(state).status);
  await mkdir(updatePaths(state).status);
  assert.equal((await readUpdateRecord(state)).state, 'unreadable', 'a folder in its place is not a missing record');
  await rm(updatePaths(state).status, { recursive: true });
  await symlink(updatePaths(state).status, updatePaths(state).status);
  assert.equal((await readUpdateRecord(state)).state, 'unreadable', 'a link is not followed');
  const before = await lstat(updatePaths(state).status);
  assert.ok(before.isSymbolicLink(), 'nothing was changed by reading');
});

test('the hold, helper lock and current pointer are read without removing or repairing anything', async t => {
  const state = await stateDir(t);
  assert.deepEqual(await readHold(state), { state: 'absent' });
  await writeFile(updatePaths(state).hold, '{}');
  const day = new Date(Date.now() - 24 * 60 * 60_000);
  await utimes(updatePaths(state).hold, day, day);
  const old = await readHold(state);
  assert.equal(old.state, 'present');
  assert.ok(old.state === 'present' && old.ageMs > 23 * 60 * 60_000);
  assert.ok(existsSync(updatePaths(state).hold), 'an old hold is not removed by reading it');
  await rm(updatePaths(state).hold);
  await symlink(updatePaths(state).hold, updatePaths(state).hold);
  assert.equal((await readHold(state)).state, 'unreadable');

  assert.deepEqual(await readHelperLock(state), { state: 'absent' });
  await writeFile(updatePaths(state).lock, String(process.pid));
  assert.equal((await readHelperLock(state)).state, 'running');
  await writeFile(updatePaths(state).lock, `${process.pid} Thu Jan  1 00:00:00 1970`);
  assert.equal((await readHelperLock(state)).state, 'gone', 'its pid now belongs to a process started later');
  await writeFile(updatePaths(state).lock, String(deadPid()));
  assert.equal((await readHelperLock(state)).state, 'gone');
  await writeFile(updatePaths(state).lock, 'not a pid');
  assert.equal((await readHelperLock(state)).state, 'invalid');
  await rm(updatePaths(state).lock);
  await mkdir(updatePaths(state).lock);
  assert.equal((await readHelperLock(state)).state, 'unreadable');

  assert.deepEqual(await readCurrentPointer(state), { state: 'absent' });
  await pointCurrent(state, B);
  assert.deepEqual(await readCurrentPointer(state), { state: 'version', version: B });
  await rm(runtimePaths(state).current);
  await symlink('/tmp/elsewhere', runtimePaths(state).current);
  assert.equal((await readCurrentPointer(state)).state, 'invalid');
  await rm(runtimePaths(state).current);
  await writeFile(runtimePaths(state).current, B);
  assert.equal((await readCurrentPointer(state)).state, 'invalid', 'a file in place of the link names no version');
});

// ---- Installed artifacts and the real producer ----

test('an installed artifact states its storage contract; a JSON-only release is legacy; anything else is unverifiable', async t => {
  const state = await stateDir(t);
  assert.equal((await probeInstalledArtifact(versionDirectory(state, B), B)).state, 'missing');
  await installArtifact(state, L, { legacy: true });
  assert.deepEqual(await probeInstalledArtifact(versionDirectory(state, L), L), { state: 'legacy', version: L });
  await installArtifact(state, A);
  const contract = await probeInstalledArtifact(versionDirectory(state, A), A);
  assert.equal(contract.state, 'contract');
  assert.ok(contract.state === 'contract' && contract.contract.identity.sourceHash === identityOf(A).sourceHash && contract.contract.manifest.digest === manifests[A].digest);
  await installArtifact(state, B, { broken: true });
  assert.equal((await probeInstalledArtifact(versionDirectory(state, B), B)).state, 'unverifiable');
  // A JSON-only artifact that does not answer as the version it is installed as is not taken for that legacy version.
  await installArtifact(state, C, { legacy: true });
  assert.equal((await probeInstalledArtifact(versionDirectory(state, C), '1.3.1')).state, 'unverifiable');

  const text = JSON.stringify((contract as Extract<ArtifactRead, { state: 'contract' }>).contract);
  assert.equal(parseArtifactStorageContract(text, A).state, 'contract');
  assert.equal(parseArtifactStorageContract(text, B).state, 'unverifiable', 'another version');
  const tampered = JSON.parse(text);
  tampered.manifest.domains[0].preparation.writerContract = 9;
  assert.equal(parseArtifactStorageContract(JSON.stringify(tampered), A).state, 'unverifiable', 'a manifest whose digest does not follow from it');
  const rebound = JSON.parse(text);
  rebound.identity.manifestDigest = 'f'.repeat(64);
  assert.equal(parseArtifactStorageContract(JSON.stringify(rebound), A).state, 'unverifiable', 'an identity bound to another manifest');
});

test('this build prints its own contract: trusted bundle, runtime probe, two preparation-only domains', async t => {
  const answer = await describeArtifactStorageContract();
  assert.ok('contract' in answer, 'error' in answer ? answer.error : '');
  const { supported, identity, runtime, refusal } = answer.contract;
  t.diagnostic(JSON.stringify({ supported, appVersion: identity.appVersion, sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest, runtime, refusal }));
  const parsed = parseArtifactStorageContract(JSON.stringify(answer.contract), APP_VERSION);
  assert.equal(parsed.state, 'contract');
  assert.ok(parsed.state === 'contract');
  assert.deepEqual(parsed.contract.manifest.domains, storageManifest().domains);
  assert.equal(parsed.contract.manifest.domains[0].scope, 'retention');
  assert.equal(parsed.contract.manifest.domains.length, 2);
  assert.ok(parsed.contract.manifest.domains.every(domain => !domain.cutover));
  assert.equal(parsed.contract.identity.manifestDigest, parsed.contract.manifest.digest);
  assert.equal(typeof parsed.contract.supported, 'boolean');
  if (!parsed.contract.supported) assert.ok(parsed.contract.refusal, 'an unsupported runtime says why');
});

// ---- One evaluation: the service ----

test('a refused runtime or contract answers 503 with its identity, while the update is verified or not', async t => {
  const state = await stateDir(t);
  await save(state, record(B, A, 'verifying'));
  const refused = await evaluateStorageUpdate({ stateDir: state, build: runningBuild(B, { supported: false }), managed: true });
  assert.equal(refused.verdict, 'refused');
  assert.equal(refused.code, 'runtime-unsupported');
  const health = storageHealth(refused);
  assert.equal(health.status, 503);
  assert.equal(health.storage.importAllowed, false);
  assert.equal(refused.evidence.build.identity?.sourceHash, identityOf(B).sourceHash, 'the identity stays beside the refusal');
  const other = runningBuild(B);
  other.manifest = manifests[C];
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: other, managed: true })).code, 'contract-mismatch');
  const problem = runningBuild(B, { state: { database: 'absent', sidecars: [], identity: 'absent', recovery: { state: 'clear' }, problem: { code: 'wrong-permissions', message: 'state.sqlite must be 0600' } } });
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: problem, managed: true })).code, 'storage-state-invalid');
});

test('a candidate whose previous version prepared its domains waits with health 200; one whose previous did not is refused with 503', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await save(state, record(B, A, 'verifying'));
  await writeFile(updatePaths(state).hold, '{}');
  const held = await evaluate(state, B);
  assert.equal(held.verdict, 'update-held');
  assert.equal(storageHealth(held).status, 200);
  assert.equal(held.importAllowed, false, 'storage changes wait for the update to be kept');
  assert.equal(held.evidence.previous?.check.state, 'satisfied');

  for (const [previous, setup, code] of [
    [L, () => installArtifact(state, L, { legacy: true }), 'prerequisite-required'],
    [A0, () => installArtifact(state, A0), 'prerequisite-required'],
    ['1.0.9', async () => {}, 'previous-missing'],
    ['1.0.8', () => installArtifact(state, '1.0.8', { broken: true }), 'previous-unverifiable'],
  ] as const) {
    await setup();
    await save(state, record(B, previous, 'verifying'));
    const refused = await evaluate(state, B);
    assert.equal(refused.verdict, 'refused', previous);
    assert.equal(refused.code, code, previous);
    assert.equal(storageHealth(refused).status, 503);
    if (code === 'prerequisite-required') assert.equal(storageHealth(refused).storage.prepare, A);
  }
  // A previous version whose storage does not run here could not take the storage back either.
  await rm(versionDirectory(state, A), { recursive: true });
  await installArtifact(state, A, { supported: false });
  await save(state, record(B, A, 'verifying'));
  assert.equal((await evaluate(state, B)).code, 'previous-runtime-unsupported');
});

test('only a kept update of this very build, with no hold or helper left and current running it, allows storage changes', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, B);
  await save(state, record(B, A, 'done'));
  const ready = await evaluate(state, B);
  assert.equal(ready.verdict, 'ready', ready.reason);
  assert.equal(ready.code, 'service-update-done');
  assert.equal(ready.importAllowed, true);

  await writeFile(updatePaths(state).hold, '{}');
  const day = new Date(Date.now() - 24 * 60 * 60_000);
  await utimes(updatePaths(state).hold, day, day);
  assert.equal((await evaluate(state, B)).code, 'hold-present', 'an old hold is not taken for none');
  assert.ok(existsSync(updatePaths(state).hold), 'and it is not removed for being old');
  await rm(updatePaths(state).hold);
  await symlink(updatePaths(state).hold, updatePaths(state).hold);
  assert.equal((await evaluate(state, B)).code, 'hold-unreadable');
  await rm(updatePaths(state).hold);

  for (const [lock, code] of [[String(process.pid), 'helper-running'], ['garbage', 'helper-unreadable'], [String(deadPid()), 'service-update-done']] as const) {
    await writeFile(updatePaths(state).lock, lock);
    assert.equal((await evaluate(state, B)).code, code, lock);
  }
  await rm(updatePaths(state).lock);
  await mkdir(updatePaths(state).lock);
  assert.equal((await evaluate(state, B)).code, 'helper-unreadable');
  await rm(updatePaths(state).lock, { recursive: true });

  await pointCurrent(state, A);
  assert.equal((await evaluate(state, B)).code, 'current-pointer', 'the service does not start this build');
  await pointCurrent(state, B);
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B, { salt: 'another build' });
  assert.equal((await evaluate(state, B)).code, 'current-artifact', 'the same version, another build');
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B, { legacy: true });
  assert.equal((await evaluate(state, B)).code, 'current-artifact');

  await save(state, '{');
  assert.equal((await evaluate(state, B)).code, 'update-status-invalid');
  await rm(updatePaths(state).status);
  await mkdir(updatePaths(state).status);
  const unreadable = await evaluate(state, B);
  assert.equal(unreadable.code, 'update-status-unreadable');
  assert.equal(storageHealth(unreadable).status, 200, 'what cannot be told holds the storage; it is not a refusal');
});

test('an update cut short by a restart holds the storage until its resumed helper keeps it', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, B);
  await save(state, record(B, A, 'verifying', { controllers: [] }));
  await writeFile(updatePaths(state).lock, String(deadPid()));
  const resumed: Array<[string, boolean]> = [];
  await new Updates({ stateDir: state, version: B, port: 1, managed: true, spawnHelper: (version, again) => resumed.push([version, again]) }).recover();
  assert.deepEqual(resumed, [[B, true]]);
  const waiting = await evaluate(state, B);
  assert.equal(waiting.verdict, 'update-held', 'the helper died; the computer restarted; the new version running is not yet kept');
  assert.equal(storageHealth(waiting).status, 200, 'so its health lets the resumed helper check it');
  const s = service(state, A);
  const kept = await runUpdateHelper(state, B, { ...s.steps, health: async () => ({ version: B, pid: 9 }) }, true);
  assert.equal(kept?.stage, 'done');
  assert.equal((await evaluate(state, B)).code, 'service-update-done');
});

test('a failed, interrupted or rolled-back update of this build never allows storage changes; pre-import-refused is told apart', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, A);
  await save(state, record(B, A, 'failed', { code: 'start-failed', failedStage: 'verifying' }));
  const refused = await evaluate(state, B, { cutoverMarkers: 'absent' });
  assert.equal(refused.code, 'pre-import-refused');
  assert.equal(refused.preImportRefused, true);
  assert.equal(refused.importAllowed, false);
  for (const markers of ['present', 'unknown', undefined] as const) {
    const answer = await evaluate(state, B, markers ? { cutoverMarkers: markers } : {});
    assert.equal(answer.code, 'own-update-failed', String(markers));
    assert.equal(answer.preImportRefused, undefined, 'a marker that is there or cannot be told is the owner\'s to recover');
  }
  await save(state, record(B, A, 'failed', { code: 'rollback-failed', failedStage: 'verifying' }));
  assert.equal((await evaluate(state, B, { cutoverMarkers: 'absent' })).code, 'own-update-rollback-failed');
  await pointCurrent(state, B);
  await save(state, record(B, A, 'failed', { code: 'interrupted', failedStage: 'verifying' }));
  assert.equal((await evaluate(state, B, { cutoverMarkers: 'absent' })).code, 'own-update-failed', 'not gone back: not pre-import-refused');
  await save(state, record(C, B, 'verifying'));
  assert.equal((await evaluate(state, B)).code, 'other-update-active');
});

test('a kept build whose record a later failed update overwrote is ready again only through the owner\'s receipt', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await installArtifact(state, C);
  await pointCurrent(state, B);
  const overwritten = record(C, B, 'failed', { code: 'start-failed', failedStage: 'verifying' });
  await save(state, overwritten);
  assert.equal((await evaluate(state, B)).code, 'done-overwritten');
  const ask = (extra: Partial<Parameters<typeof recordUpdateRecoveryReceipt>[0]> = {}) => recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: true, kind: 'overwritten-done', by: 'owner', evidence: 'checked B serves and C went back', ...extra });

  // Every refusal writes nothing.
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal(((await ask()) as { code: string }).code, 'hold');
  await rm(updatePaths(state).hold);
  await writeFile(updatePaths(state).lock, String(process.pid));
  assert.equal(((await ask()) as { code: string }).code, 'helper');
  await rm(updatePaths(state).lock);
  assert.equal(((await ask({ build: runningBuild(B, { supported: false }) })) as { code: string }).code, 'runtime-unsupported');
  assert.equal(((await ask({ managed: false })) as { code: string }).code, 'not-service');
  assert.equal(((await ask({ kind: 'stale-active' })) as { code: string }).code, 'service');
  await pointCurrent(state, C);
  assert.equal(((await ask()) as { code: string }).code, 'current-pointer');
  await pointCurrent(state, B);
  await save(state, { ...overwritten, code: 'rollback-failed' });
  assert.equal(((await ask()) as { code: string }).code, 'not-overwritten', 'a back that did not come back is not verified');
  await save(state, record(C, A, 'failed', { code: 'start-failed' }));
  assert.equal(((await ask()) as { code: string }).code, 'not-overwritten', 'the update went back to another build');
  await save(state, overwritten);
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B, { salt: 'other' });
  assert.equal(((await ask()) as { code: string }).code, 'current-artifact');
  assert.equal(existsSync(storageUpdatePaths(state).receipt), false);
  await rm(versionDirectory(state, B), { recursive: true });
  await installArtifact(state, B);

  const outcome = await ask();
  assert.equal(outcome.recorded, true);
  assert.equal(((await stat(storageUpdatePaths(state).receipt)).mode & 0o777), 0o600);
  const ready = await evaluate(state, B);
  assert.equal(ready.verdict, 'ready');
  assert.equal(ready.code, 'owner-receipt');
  // The receipt covers exactly that record: any later update makes it void.
  await save(state, { ...overwritten, updatedAt: '2026-10-08T00:00:01.000Z' });
  assert.equal((await evaluate(state, B)).code, 'done-overwritten');
  await save(state, overwritten);
  await pointCurrent(state, C);
  assert.notEqual((await evaluate(state, B)).verdict, 'ready', 'nor does it cover another pointer');
});

// ---- One evaluation: direct starts ----

test('a direct start needs no record or another build\'s verified terminal one, and its preparation evidence or a new state', async t => {
  const state = await stateDir(t);
  /** What the start's preflight sees of the storage files: none at first, then the database A prepared. */
  let seen: ReturnType<typeof runningBuild>['preflight']['state'];
  const direct = (version: string, extra: Partial<StorageUpdateInput> = {}) => evaluateStorageUpdate({ stateDir: state, build: runningBuild(version, seen ? { state: seen } : {}), managed: false, ...extra });
  assert.equal((await direct(A0)).code, 'no-cutover');
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal((await direct(A0)).verdict, 'update-held');
  await rm(updatePaths(state).hold);

  const refused = await direct(B, { legacyFiles: async () => 'present' });
  assert.equal(refused.verdict, 'refused');
  assert.equal(refused.code, 'prerequisite-required');
  assert.equal(refused.prepare, A);
  assert.equal((await direct(B)).code, 'prerequisite-required', 'without an answer about its JSON files, a state directory is not taken for a new one');
  assert.equal((await direct(B, { legacyFiles: async () => 'absent' })).code, 'new-state');
  assert.equal((await direct(B, { legacyFiles: async () => { throw new Error('EACCES'); } })).code, 'prerequisite-required', 'a failed look is not an empty state');
  const known = runningBuild(B, { state: { database: 'absent', sidecars: [], identity: 'created', recovery: { state: 'clear' } } });
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: known, managed: false, legacyFiles: async () => 'absent' })).code, 'known-storage-missing');

  // A's worker records its evidence once its storage contract was checked; B's direct start compares it.
  const a = runningBuild(A);
  const prepared = { prepared: preparedStorage(), gate: openGate };
  assert.deepEqual(await recordPreparationEvidence(state, { context: { identity: a.preflight.identity!, manifest: a.manifest! }, preflight: runningBuild(A0).preflight, ...prepared }).catch(error => error.message), 'Preparation evidence is recorded only for a storage runtime that passed its preflight as this build.');
  assert.deepEqual(await recordPreparationEvidence(state, { context: { identity: identityOf(A0), manifest: manifests[A0] }, preflight: runningBuild(A0).preflight, ...prepared }), [], 'a build without domains has nothing to record');
  const written = await recordPreparationEvidence(state, { context: { identity: a.preflight.identity!, manifest: a.manifest! }, preflight: a.preflight, ...prepared });
  assert.deepEqual(written.map(item => item.domain), ['retention']);
  const evidencePath = join(state, 'storage-contracts', 'retention.json');
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(state, 'storage-contracts'))).mode & 0o777, 0o700);
  assert.equal((await readPreparationEvidence(state, 'retention')).state, 'present');
  assert.equal((await direct(B, { legacyFiles: async () => 'present' })).code, 'known-storage-missing', 'the evidence names a storage the preflight does not see');
  seen = { database: 'present', sidecars: [], identity: 'created', recovery: { state: 'clear' } };
  const ready = await direct(B, { legacyFiles: async () => 'present' });
  assert.equal(ready.code, 'direct-evidence');
  assert.equal(ready.importAllowed, true);

  await save(state, record(A, L, 'done'));
  assert.equal((await direct(B, { legacyFiles: async () => 'present' })).code, 'direct-evidence', 'another build\'s kept update');
  await save(state, record(A, L, 'failed', { code: 'rollback-failed' }));
  assert.equal((await direct(B)).code, 'rollback-failed-recorded');
  await save(state, record(B, A, 'failed', { code: 'start-failed' }));
  assert.equal((await direct(B)).code, 'own-update-failed', 'its own failed record is the owner\'s');
  await save(state, record(B, A, 'verifying'));
  assert.equal((await direct(B)).code, 'stale-active-update');
  const receipt = await recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: false, kind: 'stale-active', by: 'owner', evidence: 'no helper, no hold, service removed' });
  assert.equal(receipt.recorded, true);
  assert.equal((await direct(B)).code, 'direct-evidence', 'after the owner verified the stale record, the direct rules decide');
  await save(state, record(B, A, 'done'));
  assert.equal(((await recordUpdateRecoveryReceipt({ stateDir: state, build: runningBuild(B), managed: false, kind: 'stale-active', by: 'owner', evidence: 'x' })) as { code: string }).code, 'not-active');

  await rm(updatePaths(state).status);
  await writeFile(evidencePath, '{"format":"something else"}', { mode: 0o600 });
  assert.equal((await direct(B)).code, 'preparation-evidence-unreadable');
  const weaker = { ...written[0], writerContract: 0 };
  await writeFile(evidencePath, JSON.stringify(weaker), { mode: 0o600 });
  assert.equal((await direct(B)).code, 'preparation-evidence-unreadable');
  await writeFile(evidencePath, JSON.stringify({ ...written[0], schema: { ...written[0].schema, digest: 'e'.repeat(64) } }), { mode: 0o600 });
  assert.equal((await direct(B, { legacyFiles: async () => 'present' })).code, 'preparation-evidence-unreadable', 'evidence whose domain is not the one its own manifest declares is not used');
  await writeFile(evidencePath, JSON.stringify({ ...written[0], version: 1 }), { mode: 0o600 });
  assert.equal((await readPreparationEvidence(state, 'retention')).state, 'legacy');
  const withDatabase = runningBuild(B, { state: { database: 'present', sidecars: [], identity: 'created', recovery: { state: 'clear' } } });
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: withDatabase, managed: false, legacyFiles: async () => 'present' })).code, 'prerequisite-required', 'evidence of one domain\'s schema alone prepares nothing');
  seen = undefined;
  assert.equal((await direct(B, { legacyFiles: async () => 'absent' })).code, 'known-storage-missing', 'and with it there, a state directory without its database is not a new one');
  await chmod(evidencePath, 0o644);
  assert.equal((await readPreparationEvidence(state, 'retention')).state, 'unreadable', 'a file others can read is refused as it is');
});

// ---- Staged updates ----

test('preparation is judged per domain: schema, reader and writer contracts, release and runtime', () => {
  const contract = (version: string, extra: { supported?: boolean } = {}): ArtifactRead => {
    const build = runningBuild(version, extra);
    return { state: 'contract', contract: { format: 'tower-artifact-storage-contract', version: 1, appVersion: version, supported: build.preflight.supported, identity: build.preflight.identity!, manifest: build.manifest! } };
  };
  assert.equal(preparationCheck(manifests[A0], { state: 'legacy', version: L }).state, 'not-required', 'a build that imports nothing needs nothing');
  assert.equal(preparationCheck(manifests[A], { state: 'legacy', version: L }).state, 'not-required', 'nor does the preparation release itself');
  assert.deepEqual(preparationCheck(manifests[B], { state: 'legacy', version: L }), { state: 'prerequisite-required', prepare: A, domains: ['retention'], reason: `${L} keeps its state in JSON only; ${A} has to run first.` });
  assert.equal(preparationCheck(manifests[B], contract(A0)).state, 'prerequisite-required');
  assert.equal(preparationCheck(manifests[B], contract(A)).state, 'satisfied');
  assert.equal(preparationCheck(manifests[C], contract(B)).state, 'satisfied', 'a later build that imported the domain itself prepares it');
  assert.equal(preparationCheck(manifests[B], contract(A, { supported: false })).state, 'runtime-unsupported');
  assert.equal(preparationCheck(manifests[B], { state: 'unverifiable', reason: 'timed out' }).state, 'unverifiable', 'a failed look is never taken for legacy');
});

/** The fixture service of update.test.ts, with each installed artifact's real contract probe. */
function service(state: string, start: string, behaviour: { starts?: (version: string) => boolean } = {}) {
  let clock = Date.parse(at);
  let running = { version: start, pid: 100 };
  const restarts: string[] = [];
  const steps: UpdateHelperSteps = {
    free: async () => undefined,
    install: async version => versionDirectory(state, version),
    check: async () => {},
    contract: probeInstalledArtifact,
    point: version => pointCurrent(state, version),
    restart: async () => { const version = (await currentVersion(state))!; restarts.push(version); running = (behaviour.starts ?? (() => true))(version) ? { version, pid: running.pid + 1 } : { version: 'none', pid: 0 }; },
    health: async () => running.pid ? running : undefined,
    controllers: async () => [],
    sleep: async ms => { clock += ms; },
    now: () => clock,
    log: () => {},
  };
  return { steps, restarts, running: () => running };
}

test('the updater refuses a target its previous version did not prepare, before anything switches, and is not asked to install it again', async t => {
  const state = await stateDir(t);
  for (const version of [A0, A, B]) await installArtifact(state, version);
  await pointCurrent(state, A0);
  const spawned: string[] = [];
  const onA0 = new Updates({ stateDir: state, version: A0, port: 1, managed: true, spawnHelper: version => spawned.push(version) });
  assert.equal((await onA0.request(B)).status, 202);
  const s = service(state, A0);
  const failed = await runUpdateHelper(state, B, s.steps) as SavedUpdate;
  assert.equal(failed.stage, 'failed');
  assert.equal(failed.code, 'check-failed');
  assert.deepEqual(failed.storage, { code: 'prerequisite-required', prepare: A, domains: ['retention'] });
  assert.equal(await currentVersion(state), A0, 'nothing switched');
  assert.deepEqual(s.restarts, [], 'nothing restarted');
  assert.equal(existsSync(updatePaths(state).hold), false, 'no hold was taken');
  const again = await onA0.request(B);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'prerequisite-required');
  assert.equal(again.body.prepare, A);
  assert.deepEqual(spawned, [B], 'asked again, nothing is installed again');

  // The preparation release first, then the target.
  assert.equal((await onA0.request(A)).status, 202);
  assert.equal((await runUpdateHelper(state, A, service(state, A0).steps))?.stage, 'done');
  const onA = new Updates({ stateDir: state, version: A, port: 1, managed: true, spawnHelper: version => spawned.push(version) });
  assert.equal((await onA.request(B)).status, 202, 'from the preparation release the target is asked for again');
  const kept = await runUpdateHelper(state, B, service(state, A).steps);
  assert.equal(kept?.stage, 'done');
  assert.equal(await currentVersion(state), B);
});

test('the updater refuses a target whose storage does not run here, or whose contract cannot be read', async t => {
  for (const [options, code] of [[{ supported: false }, 'target-runtime-unsupported'], [{ broken: true }, 'contract-unverifiable']] as const) {
    const state = await stateDir(t);
    await installArtifact(state, A);
    await installArtifact(state, B, options);
    await pointCurrent(state, A);
    await new Updates({ stateDir: state, version: A, port: 1, managed: true, spawnHelper: () => {} }).request(B);
    const s = service(state, A);
    const failed = await runUpdateHelper(state, B, s.steps) as SavedUpdate;
    assert.equal(failed.storage?.code, code);
    assert.equal(await currentVersion(state), A);
    assert.deepEqual(s.restarts, []);
  }
});

test('a controller or deploy agent goes through the preparation release, a bounded number of times, and never backwards', () => {
  let progress: ChainProgress = { target: B, attempts: {} };
  // An offline follower comes back on the JSON-only release and is asked for the target straight away.
  assert.deepEqual(nextChainStep({ running: L, progress }), { action: 'request', version: B });
  progress = chainAsked(progress, B);
  const failure = record(B, L, 'failed', { code: 'check-failed', failedStage: 'checking', storage: { code: 'prerequisite-required', prepare: A, domains: ['retention'] } });
  assert.deepEqual(nextChainStep({ running: L, update: failure, progress }), { action: 'request', version: A }, 'its refusal names the preparation release');
  progress = chainAsked(progress, A, failure);
  assert.equal(progress.prerequisite, A);
  assert.deepEqual(nextChainStep({ running: L, update: record(A, L, 'verifying'), progress }).action, 'wait');
  progress = chainAsked(chainAsked(progress, A), A);
  const blocked = nextChainStep({ running: L, update: record(A, L, 'failed', { code: 'start-failed' }), progress });
  assert.equal(blocked.action, 'blocked');
  assert.ok(blocked.action === 'blocked' && blocked.code === 'prerequisite-required' && blocked.version === A, 'after its attempts it is the owner\'s');
  assert.deepEqual(nextChainStep({ running: A, update: record(A, L, 'done'), progress }), { action: 'request', version: B }, 'once the preparation release runs, the target');
  assert.deepEqual(nextChainStep({ running: '1.1.5', progress }), { action: 'request', version: B }, 'a computer already past the preparation release goes straight on');
  assert.deepEqual(nextChainStep({ running: B, progress }), { action: 'done' });
  assert.deepEqual(nextChainStep({ running: C, progress }), { action: 'done' }, 'never backwards');
  assert.equal(nextChainStep({ running: L, progress: { target: B, prerequisite: C, attempts: {} } }).action, 'blocked');
  const exhausted = nextChainStep({ running: A, progress: { target: B, attempts: { [B]: 3 } } });
  assert.ok(exhausted.action === 'blocked' && exhausted.code === 'attempts-exhausted');
});

// ---- Pin, pruning and requests ----

/** A pin on `version` left by an owner's rollback that has ended (withdrawn, its hold released), as the owner may release it. */
async function pin(state: string, version: string) {
  const value = { format: 'tower-storage-pin', version: 1, pinned: version, sourceHash: identityOf(version).sourceHash, manifestDigest: identityOf(version).manifestDigest, entrySha256: 'a'.repeat(64), rollbackId: 'r1', by: 'owner', reason: 'test', at };
  await writeFile(storagePinPath(state), JSON.stringify(value), { mode: 0o600 });
  const ended = { format: 'tower-storage-rollback', version: 1, id: 'r1', from: C, target: version, sourceHash: value.sourceHash, manifestDigest: value.manifestDigest, entrySha256: value.entrySha256,
    updateSha256: null, state: 'withdrawn', by: 'owner', reason: 'test', held: false, switched: false, startedAt: at, updatedAt: at };
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(ended), { mode: 0o600 });
}

test('update requests from the owner, the scheduler and controllers respect the pin; a pin that cannot be read refuses them', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await pointCurrent(state, A);
  const spawned: string[] = [];
  const updates = new Updates({ stateDir: state, version: A, port: 1, managed: true, spawnHelper: version => spawned.push(version) });
  await pin(state, A);
  const refused = await updates.request(B);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'pinned');
  // The scheduler asks through the same request; it moves nothing either.
  const scheduler = new TowerAutoUpdate({ stateDir: state, version: A, enabled: true, updates, controllers: () => 0, latest: async () => ({ version: B, checkedAt: at }) as never });
  await scheduler.check();
  assert.equal((await scheduler.updateNow(B)).body.code, 'pinned');
  assert.deepEqual(spawned, []);
  await rm(storagePinPath(state));
  await mkdir(storagePinPath(state));
  assert.equal((await updates.request(B)).body.code, 'pin-unreadable');
  await rm(storagePinPath(state), { recursive: true });
  await pin(state, A);
  assert.deepEqual(await releaseStoragePin(state, { version: B }), { released: false, code: 'pinned-elsewhere', reason: `The pin keeps ${A}, not ${B}.` });
  assert.deepEqual(await releaseStoragePin(state, { version: A }), { released: true });
  assert.equal((await updates.request(B)).status, 202, 'once the owner releases it');
  assert.deepEqual(spawned, [B]);
});

test('a request does not overwrite an update record it cannot read; one it does not understand only when nothing of it is left', async t => {
  const state = await stateDir(t);
  const spawned: string[] = [];
  const updates = new Updates({ stateDir: state, version: A, port: 1, managed: true, spawnHelper: version => spawned.push(version) });
  await mkdir(updatePaths(state).status);
  assert.equal((await updates.request(B)).body.code, 'update-status-unreadable');
  await rm(updatePaths(state).status, { recursive: true });
  await save(state, { version: B, previous: A, stage: 'migrating', startedAt: at, updatedAt: at });
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal((await updates.request(B)).body.code, 'busy', 'its hold may belong to it');
  await rm(updatePaths(state).hold);
  assert.equal((await updates.request(B)).status, 202);
  assert.deepEqual(spawned, [B]);
});

test('pruning keeps the pinned version and a rollback\'s versions, and removes nothing when the record, pin or pointer cannot be read', async t => {
  const state = await stateDir(t);
  for (const version of ['0.9.0', L, A, B]) await mkdir(versionDirectory(state, version), { recursive: true });
  await pointCurrent(state, B);
  const updates = new Updates({ stateDir: state, version: B, port: 1, managed: true });
  const installed = async () => (await readdir(runtimePaths(state).versions)).sort();
  await pin(state, A);
  await save(state, '{');
  await updates.prune(async () => []);
  assert.deepEqual(await installed(), ['0.9.0', L, A, B].sort(), 'a record that cannot be used keeps everything');
  await rm(updatePaths(state).status);
  const ended = await readFile(storageUpdatePaths(state).rollback);
  await rm(storageUpdatePaths(state).rollback);
  await mkdir(storageUpdatePaths(state).rollback);
  await updates.prune(async () => []);
  assert.deepEqual(await installed(), ['0.9.0', L, A, B].sort(), 'a rollback record that cannot be read keeps everything');
  await rm(storageUpdatePaths(state).rollback, { recursive: true });
  await writeFile(storageUpdatePaths(state).rollback, ended, { mode: 0o600 });
  await rm(runtimePaths(state).current);
  await writeFile(runtimePaths(state).current, 'x');
  await updates.prune(async () => []);
  assert.deepEqual(await installed(), ['0.9.0', L, A, B].sort(), 'a current link that cannot be read keeps everything');
  await rm(runtimePaths(state).current);
  await pointCurrent(state, B);
  await updates.prune(async () => []);
  assert.deepEqual(await installed(), [A, B].sort(), 'the pinned version stays');
  await rm(storagePinPath(state));
  await mkdir(storagePinPath(state));
  await mkdir(versionDirectory(state, L));
  await updates.prune(async () => []);
  assert.deepEqual(await installed(), [L, A, B].sort(), 'a pin that cannot be read keeps everything');
});

// ---- The owner's rollback ----

/** The worker side (fixtures/rollback-world.ts), with some of its ports replaced. */
function ports(overrides: Partial<RollbackPorts> = {}) {
  const world = rollbackWorld();
  Object.assign(world.ports, overrides);
  return { value: world.ports, calls: world.calls, world };
}
async function rollbackState(t: TestContext) {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, B);
  await save(state, record(B, A, 'done'));
  return state;
}
const contextFor = (state: string, port: RollbackPorts, updates = new Updates({ stateDir: state, version: B, port: 1, managed: true }), extra: Partial<RollbackContext> = {}): RollbackContext =>
  ({ stateDir: state, running: runningBuild(B), managed: true, ports: port, serialize: work => updates.exclusive(work), ...extra });
/** The target's web, after the switch: it continues the rollback. */
const onTarget = (state: string, port: RollbackPorts): RollbackContext => ({ stateDir: state, running: runningBuild(A), managed: true, ports: port, serialize: work => work() });

test('a rollback is validated without changing anything, and refused for every target or state it cannot take', async t => {
  const state = await rollbackState(t);
  const before = await tree(state);
  const check = async (target: string, port = ports().value, extra: Partial<RollbackContext> = {}) => validateRollback(contextFor(state, port, undefined, extra), { target });
  assert.equal((await check(A)).ok, true);
  const expectCode = async (promise: ReturnType<typeof check>, code: string) => { const answer = await promise; assert.equal(answer.ok ? 'ok' : answer.code, code); };
  await expectCode(check(A, ports().value, { managed: false }), 'not-service');
  await expectCode(check(C), 'not-lower');
  await expectCode(check(B), 'not-lower');
  await expectCode(check('1.0.9'), 'target-missing');
  await installArtifact(state, L, { legacy: true });
  await expectCode(check(L), 'target-no-contract');
  await installArtifact(state, '1.1.4', { broken: true });
  await expectCode(check('1.1.4'), 'target-unverifiable');
  await expectCode(check(A, ports({ inspectStorage: async () => { throw new Error('thread exited'); } }).value), 'storage-uninspectable');
  await expectCode(check(A, ports({ inspectStorage: async () => ({ ...databaseOfB(), schema: appliedFor([['core', CORE_MIGRATIONS.map(migration => migration.sql)], ['retention', ['CREATE TABLE x (y TEXT) STRICT;']]]) }) }).value), 'target-incompatible');
  await expectCode(check(A, ports({ inspectStorage: async () => ({ ...databaseOfB(), schema: appliedFor([['core', CORE_MIGRATIONS.map(migration => migration.sql)], ['triggers', ['CREATE TABLE t (y TEXT) STRICT;']]]) }) }).value), 'target-incompatible');
  await expectCode(check(A, ports({ inspectStorage: async () => ({ ...databaseOfB(), authority: [{ ...databaseOfB().authority[0], writerContract: 2 }] }) }).value), 'target-incompatible');
  await expectCode(check(A, ports({ inspectStorage: async () => ({ schema: { kind: 'behind', storageId: 'x', applied: [], pending: [{ scope: 'core', version: 1 }] }, authority: [], ownerEpoch: 1 }) }).value), 'target-incompatible');
  await expectCode(check(A, ports({ inspectStorage: async () => ({ ...databaseOfB(), ownerEpoch: undefined as never }) }).value), 'storage-uninspectable');
  await expectCode(check(A, ports().value, { running: runningBuild(B, { state: { database: 'present', sidecars: [], identity: 'created', recovery: { state: 'held', reason: 'snapshot', reconciled: [], unreconciled: ['core'] } } }) }), 'recovery-held');
  await save(state, record(C, B, 'verifying'));
  await expectCode(check(A), 'update-active');
  await save(state, record(B, A, 'done'));
  await writeFile(updatePaths(state).hold, '{}');
  await expectCode(check(A), 'update-hold');
  await rm(updatePaths(state).hold);
  await pin(state, '1.1.4');
  await expectCode(check(A), 'pinned-elsewhere');
  await rm(storagePinPath(state));
  await rm(storageUpdatePaths(state).rollback);
  await rm(versionDirectory(state, A), { recursive: true });
  await installArtifact(state, A, { supported: false });
  await expectCode(check(A), 'target-runtime-unsupported');
  const after = await tree(state, path => path.includes(`${join('versions', '1.')}`));
  const unchanged = Object.fromEntries(Object.entries(before).filter(([path]) => !path.includes(`${join('versions', '1.')}`)));
  assert.deepEqual(after, unchanged, 'validation wrote nothing');
});

test('the owner\'s rollback pins, holds, waits for running work, switches, and keeps the target only once its worker answers', async t => {
  const state = await rollbackState(t);
  const port = ports();
  const updates = new Updates({ stateDir: state, version: B, port: 1, managed: true, spawnHelper: () => {} });
  const switched = await runRollback(contextFor(state, port.value, updates), { target: A, by: 'owner', reason: 'B misbehaves' });
  assert.equal(switched.state, 'switched');
  assert.deepEqual(port.calls, ['inspect', 'hold', 'quiet', 'inspect', 'restart'], 'pinned before the hold, the database compared again after the quiet, no provider cancelled');
  assert.equal(await currentVersion(state), A);
  const pinned = await readStoragePin(state);
  assert.ok(pinned.state === 'present' && pinned.pin.pinned === A && pinned.pin.sourceHash === identityOf(A).sourceHash);
  assert.equal((await stat(storagePinPath(state))).mode & 0o777, 0o600);
  // While the rollback goes on, nothing moves the service forward again or removes its versions.
  assert.equal((await updates.request(C)).body.code, 'pinned');
  await updates.prune(async () => []);
  assert.ok(existsSync(versionDirectory(state, A)) && existsSync(versionDirectory(state, B)));

  // The target's web resumes it: admissions held and running work ended again, the database compared, then the handoff.
  const resumed = await resumeRollback(onTarget(state, port.value));
  assert.equal(resumed.state, 'completed');
  assert.deepEqual(port.calls.slice(-5), ['hold', 'quiet', 'inspect', 'handoff', 'release'], 'the hold is released once the serving worker proved the pinned build took over');
  const done = await readRollbackRecord(state);
  assert.ok(done.state === 'present' && done.record.state === 'completed' && done.record.worker?.version === A && done.record.held === false);
  const onA = new Updates({ stateDir: state, version: A, port: 1, managed: true, spawnHelper: () => {} });
  assert.equal((await onA.request(B)).body.code, 'pinned', 'always-latest cannot reinstall B while the pin stays');
  assert.equal((await runRollback(contextFor(state, port.value, onA, { running: runningBuild(A) }), { target: A, by: 'owner', reason: 'again' })).state, 'completed', 'asked again, it is done');
  assert.equal((await releaseStoragePin(state, { version: A })).code, 'serving-unproven', 'a switched rollback\'s pin goes only over the worker that serves now');
  assert.equal((await releaseStoragePin(state, { version: A }, { ports: port.value })).released, true);
  assert.equal((await onA.request(B)).status, 202, 'moving on is the owner\'s explicit step');
});

test('a living legacy terminal keeps the rollback waiting; a failure releases the hold and keeps the pin; a retry resumes', async t => {
  const state = await rollbackState(t);
  let quiet: { state: 'quiet' } | { state: 'pending'; reason: string } = { state: 'pending', reason: 'legacy-terminal' };
  const port = ports({ waitQuiet: async () => quiet });
  const context = contextFor(state, port.value);
  const waiting = await runRollback(context, { target: A, by: 'owner', reason: 'r' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(await currentVersion(state), B, 'nothing switches while the legacy terminal lives');
  assert.ok(!port.calls.includes('release'), 'the hold stays; the terminal keeps its input and attach');
  const first = await readRollbackRecord(state);
  quiet = { state: 'quiet' };
  const switched = await runRollback(context, { target: A, by: 'owner', reason: 'r' });
  assert.ok(switched.state === 'switched' && first.state === 'present' && switched.record.id === first.record.id, 'the same rollback goes on and switches');
  assert.equal((await withdrawRollback(context)).state, 'refused', 'a switched rollback is not withdrawn');

  let fails = true;
  const handoffPorts = ports();
  const take = handoffPorts.value.handoff;
  // Refused before anything happened, as the serving worker (still B's, knowing no handoff) proves.
  handoffPorts.value.handoff = async (target, fence) => { if (!fails) return take(target, fence); handoffPorts.calls.push('handoff'); throw new Error('worker busy'); };
  const failed = await resumeRollback(onTarget(state, handoffPorts.value));
  assert.equal(failed.state, 'failed');
  assert.ok(handoffPorts.calls.includes('release'), 'the admission hold is released');
  assert.equal((await readStoragePin(state)).state, 'present', 'the pin stays');
  fails = false;
  assert.equal((await runRollback(contextFor(state, handoffPorts.value, undefined, { running: runningBuild(A) }), { target: A, by: 'owner', reason: 'retry' })).state, 'completed', 'asked again on the target, it goes on');

  const other = await rollbackState(t);
  const wrong = ports();
  const handOver = wrong.value.handoff;
  // The worker that serves afterwards is another build of A than the one pinned.
  wrong.value.handoff = async (target, fence) => { const answer = await handOver(target, fence); wrong.world.state.serving = { ...wrong.world.state.serving, sourceHash: 'f'.repeat(64) }; return answer; };
  assert.equal((await runRollback(contextFor(other, wrong.value), { target: A, by: 'owner', reason: 'r' })).state, 'switched');
  const mismatch = await resumeRollback(onTarget(other, wrong.value));
  assert.ok(mismatch.state === 'handing-off' && mismatch.record.handoff?.state === 'unknown', 'a worker without the pinned identity is not taken for it');
  assert.equal(mismatch.state === 'handing-off' && mismatch.record.held, true, 'and its hold stays: which worker serves cannot be told');
  assert.ok(!wrong.calls.slice(wrong.calls.indexOf('handoff')).includes('release'));
});

test('a hold that fails or a withdrawal releases admissions; the pin goes only when the owner releases it too', async t => {
  const state = await rollbackState(t);
  const port = ports({ holdAdmission: async () => { throw new Error('worker did not answer'); } });
  const failed = await runRollback(contextFor(state, port.value), { target: A, by: 'owner', reason: 'r' });
  assert.ok(failed.state === 'failed' && failed.record.failure?.phase === 'hold');
  assert.ok(port.calls.includes('release'));
  assert.equal(await currentVersion(state), B);
  const elsewhere = await runRollback(contextFor(state, ports().value), { target: A0, by: 'owner', reason: 'r' });
  assert.ok(elsewhere.state === 'refused' && elsewhere.code === 'pinned-elsewhere', 'another target waits until the owner releases this pin');
  await rm(versionDirectory(state, A), { recursive: true });
  await installArtifact(state, A, { salt: 'reinstalled' });
  const reinstalled = await runRollback(contextFor(state, ports().value), { target: A, by: 'owner', reason: 'retry' });
  assert.ok(reinstalled.state === 'refused' && reinstalled.code === 'target-changed', 'the pin stands over the validated build only, not a reinstalled one');
  await rm(versionDirectory(state, A), { recursive: true });
  await installArtifact(state, A);
  const withdrawn = await withdrawRollback(contextFor(state, port.value));
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal((await readStoragePin(state)).state, 'present', 'withdrawing keeps the pin');
  assert.equal((await releaseStoragePin(state, { version: A })).released, true);

  const again = await rollbackState(t);
  const waiting = ports({ waitQuiet: async () => ({ state: 'pending', reason: 'busy' }) });
  await runRollback(contextFor(again, waiting.value), { target: A, by: 'owner', reason: 'r' });
  assert.equal((await withdrawRollback(contextFor(again, waiting.value), { releasePin: true })).state, 'withdrawn');
  assert.ok(waiting.calls.includes('release'));
  assert.equal((await readStoragePin(again)).state, 'absent', 'released with it, by the owner\'s explicit choice');
});

test('pruning and a rollback\'s pin take turns: a pin never stands over a removed artifact', async t => {
  for (let round = 0; round < 4; round++) {
    const state = await rollbackState(t);
    const updates = new Updates({ stateDir: state, version: B, port: 1, managed: true });
    // B's own record keeps A as its previous; a record without it leaves A to pruning alone.
    await save(state, record(B, '1.1.9', 'done'));
    const [outcome] = await Promise.all([runRollback(contextFor(state, ports().value, updates), { target: A, by: 'owner', reason: 'race' }), ...round % 2 ? [updates.prune(async () => [])] : []]);
    await updates.prune(async () => []);
    const pinned = (await readStoragePin(state)).state === 'present';
    assert.equal(pinned, outcome.state !== 'refused');
    if (pinned) assert.ok(existsSync(entryPoint(versionDirectory(state, A))), 'the pinned artifact is still installed');
  }
});

test('only the pinned version can be pointed back to; useVersion respects the pin and stays monotonic', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, B);
  await assert.rejects(pointRollbackTarget(state, A), /not the version the owner pinned/);
  await pin(state, '1.1.4');
  await assert.rejects(pointRollbackTarget(state, A));
  await pin(state, A);
  await assert.rejects(pointRollbackTarget(state, A, 'another-rollback'), 'only for the rollback that pinned it, when one is named');
  await pointRollbackTarget(state, A);
  assert.equal(await currentVersion(state), A);
  await assert.rejects(useVersion(state, B), { code: 'pinned' }, 'installing B (service install, join) is not releasing the pin');
  assert.equal(await currentVersion(state), A);
  await useVersion(state, A);
  assert.equal(await currentVersion(state), A, 'the pinned version itself is fine');
  assert.equal((await releaseStoragePin(state, { version: A })).released, true);
  await useVersion(state, B);
  assert.equal(await currentVersion(state), B);
  await useVersion(state, A);
  assert.equal(await currentVersion(state), B, 'useVersion never goes back');
});
