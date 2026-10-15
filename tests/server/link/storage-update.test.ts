import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentVersion, entryPoint, pointCurrent, pointUpdate, runtimePaths, useVersion, versionDirectory } from '../../../server/link/service.js';
import { readCurrentPointer, readHelperLock, readHold, readUpdateRecord, type SavedUpdate } from '../../../server/link/storage-update.js';
import { transitionLockPath } from '../../../server/link/storage-transition-lock.js';
import { handoffHeld, readUpdateStatus, updatePaths, Updates } from '../../../server/link/update.js';

/** The strict reads of what an update leaves behind, and the rules for moving `current`. */

const A = '1.1.0';
const B = '1.2.0';
const C = '1.3.0';

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
async function installArtifact(state: string, version: string) {
  const entry = entryPoint(versionDirectory(state, version));
  await mkdir(join(entry, '..'), { recursive: true });
  await writeFile(entry, `console.log(${JSON.stringify(version)});\n`);
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


test('a link in place of the hold or helper lock (dangling or not) is neither absent nor present, and nothing is changed', async t => {
  const state = await stateDir(t);
  await save(state, record(B, A, 'done'));
  await symlink(join(state, 'nowhere'), updatePaths(state).hold);
  assert.equal((await readHold(state)).state, 'unreadable');
  await assert.rejects(handoffHeld(state), 'the web cannot tell whether to hand over: it does not');
  await save(state, '{');
  const updates = new Updates({ stateDir: state, version: B, port: 1, managed: true, spawnHelper: () => {} });
  assert.equal((await updates.request(C)).body.code, 'busy', 'an update record it does not understand is not replaced while a hold may be there');
  await save(state, record(B, A, 'done'));
  await rm(updatePaths(state).hold);
  await writeFile(join(state, 'some-file'), '{}');
  await symlink(join(state, 'some-file'), updatePaths(state).hold);
  assert.equal((await readHold(state)).state, 'unreadable', 'a link to a file is not a hold a helper wrote');
  await rm(updatePaths(state).hold);
  for (const target of [join(state, 'nowhere'), join(state, 'some-file')]) {
    await symlink(target, updatePaths(state).lock);
    assert.equal((await readHelperLock(state)).state, 'unreadable', target);
    await assert.rejects(handoffHeld(state), target);
    assert.equal(readlinkSync(updatePaths(state).lock), target, 'the link is left as it is');
    await rm(updatePaths(state).lock);
  }
  assert.equal(await handoffHeld(state), false, 'with neither there, nothing holds');
});

// ---- Requests and the pointer ----

test('a transition lock left by a stopped process is broken; one that is not a plain file stops everything and is kept', async t => {
  const state = await stateDir(t);
  for (const version of [A, B, C]) await installArtifact(state, version);
  await pointCurrent(state, B);
  const dead = deadPid();
  await writeFile(transitionLockPath(state), JSON.stringify({ format: 'tower-transition-owner', version: 1, role: 'lock', pid: dead, start: 'Thu Jan  1 00:00:00 1970', nonce: '0123456789abcdef0123' }), { mode: 0o600 });
  await useVersion(state, C);
  assert.equal(await currentVersion(state), C);
  assert.equal(existsSync(transitionLockPath(state)), false, 'broken, then released');
  await symlink(join(state, 'nowhere'), transitionLockPath(state));
  await assert.rejects(useVersion(state, B), { code: 'transition-lock-unreadable' });
  assert.equal(await currentVersion(state), C);
  assert.equal(readlinkSync(transitionLockPath(state)), join(state, 'nowhere'));
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

test('useVersion is monotonic; the helper\'s switch goes either way; files a rollback or pin left behind change nothing', async t => {
  const state = await stateDir(t);
  await installArtifact(state, A);
  await installArtifact(state, B);
  await useVersion(state, A);
  assert.equal(await currentVersion(state), A);
  await useVersion(state, B);
  assert.equal(await currentVersion(state), B);
  await useVersion(state, A);
  assert.equal(await currentVersion(state), B, 'useVersion never goes back');
  await pointUpdate(state, A);
  assert.equal(await currentVersion(state), A, 'an update going back points at the previous version');
  // 1.137-or-older builds left an owner's pin and rollback records here; they no longer hold anything back.
  const left = { pin: join(runtimePaths(state).root, 'storage-pin.json'), rollback: join(runtimePaths(state).root, 'storage-rollback.json') };
  await writeFile(left.pin, JSON.stringify({ format: 'tower-storage-pin', version: 1, pinned: A }), { mode: 0o600 });
  await writeFile(left.rollback, '{', { mode: 0o600 });
  await useVersion(state, B);
  assert.equal(await currentVersion(state), B, 'a pin left behind does not keep the service on its version');
  const spawned: string[] = [];
  const answer = await new Updates({ stateDir: state, version: A, port: 1, managed: true, spawnHelper: version => spawned.push(version) }).request(B);
  assert.equal(answer.status, 202, 'nor does a rollback record left behind refuse an update');
  assert.deepEqual(spawned, [B]);
  assert.ok(existsSync(left.pin) && existsSync(left.rollback), 'and nothing removes them');
});
