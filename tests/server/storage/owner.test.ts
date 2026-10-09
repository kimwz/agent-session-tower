import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { StorageClient } from '../../../server/storage/client.js';
import type { StorageStatus } from '../../../server/storage/contract.js';
import { historyAfterSnapshot } from './fixtures/history.js';
import { databasePath, fsPromises, holdCall, openFixture, rejectsWith, stateDir, storage } from './helpers.js';

const { adoptSnapshot, reconcileRecovery, storageFs, storageLayout } = storage;

/**
 * gate() and prepare() wait on files between their checks and their answers. An answer belongs to the open and the
 * claim it started on: what happens to the storage meanwhile (the thread ends, a deadline passes, a close, a reopen
 * and a new claim, even with the same owner number) is never answered as if it had not happened.
 */

type Disruption = 'none' | 'exit' | 'deadline' | 'close';
async function disrupt(client: StorageClient, how: Disruption): Promise<void> {
  if (how === 'exit') await rejectsWith(client.write('fixture', 'exitNow', { key: 'gone', code: 4 }, 'exit-1'), { code: 'thread-exited', disposition: 'unknown' });
  if (how === 'deadline') await rejectsWith(client.read('fixture', 'spin', { ms: 3000 }), { code: 'deadline-exceeded' });
  if (how === 'close') assert.equal((await client.close()).ack, 'closed');
}
const expectedReason = { exit: /unavailable.*exited/, deadline: /unavailable.*did not answer/, close: /closed/ } as const;

test('a gate waiting on its barrier read answers for the open it started on: a thread exit, a missed deadline or a close meanwhile keeps it closed', async t => {
  for (const how of ['none', 'exit', 'deadline', 'close'] as const) {
    const dir = await stateDir(t);
    const client = await openFixture(t, dir, { limits: { commandDeadlineMs: 1000 } });
    await client.prepare({ allowMigration: true });
    const { recoveryDir } = await storageLayout(dir);
    const read = holdCall(t, fsPromises, 'lstat', path => path === recoveryDir);
    const gate = client.gate('core');
    await read.reached;
    await disrupt(client, how);
    read.release();
    const answer = await gate;
    if (how === 'none') assert.deepEqual(answer, { open: true, reasons: [] }, 'nothing happened meanwhile: the gate opens');
    else {
      assert.equal(answer.open, false, how);
      assert.match(answer.reasons.join(' '), expectedReason[how], how);
    }
  }
});

/** A storage on an adopted snapshot whose barrier releases `fixture`, reconciled after the open (so a gate proves it again), prepared. */
async function releasing(t: TestContext) {
  const history = await historyAfterSnapshot(t);
  const barrier = await adoptSnapshot(history.dir, { snapshotId: history.snapshotId, reason: 'gate', context: history.context, known: history.known });
  // The database as adopted, before this worker claims it: put back, the next claim gets the same owner number.
  const unclaimed = await readFile(databasePath(history.dir));
  const client = await openFixture(t, history.dir, { limits: { commandDeadlineMs: 1000 } });
  const prepared = await client.prepare({ allowMigration: false });
  const reconcile = (scope: string) => reconcileRecovery(history.dir, { barrierId: barrier.id, scopes: [scope], by: 'owner', evidence: 'checked', context: history.context });
  await reconcile('fixture');
  const layout = await storageLayout(history.dir);
  return { dir: history.dir, client, unclaimed, ownerEpoch: prepared.ownerEpoch, reconcile, recoveryDir: layout.recoveryDir, barrierFile: join(layout.recoveryDir, 'barrier.json') };
}

test('a gate waiting on the proof of a barrier that releases its scope answers for the open it started on: a thread exit meanwhile keeps it closed', async t => {
  for (const how of ['none', 'exit'] as const) {
    const live = await releasing(t);
    const proof = holdCall(t, storageFs, 'syncFile', path => path === live.barrierFile);
    const gate = live.client.gate('fixture');
    // The proof really runs: the barrier changed since the open proved it.
    await proof.reached;
    await disrupt(live.client, how);
    proof.release();
    const answer = await gate;
    if (how === 'none') assert.deepEqual(answer, { open: true, reasons: [] });
    else {
      assert.equal(answer.open, false);
      assert.match(answer.reasons.join(' '), expectedReason[how]);
    }
  }
});

test('a gate started before a close, reopen and new claim (with the same owner number) stays closed and does not publish its barrier read', async t => {
  for (const wait of ['read', 'proof'] as const) {
    const live = await releasing(t);
    const held = wait === 'read' ? holdCall(t, fsPromises, 'lstat', path => path === live.recoveryDir) : holdCall(t, storageFs, 'syncFile', path => path === live.barrierFile);
    const gate = live.client.gate('fixture');
    await held.reached;
    assert.equal((await live.client.close()).ack, 'closed');
    await writeFile(databasePath(live.dir), live.unclaimed);
    assert.equal((await live.client.reopen()).state, 'ready');
    const claimed = await live.client.prepare({ allowMigration: false });
    assert.deepEqual([claimed.claimed, claimed.ownerEpoch], [true, live.ownerEpoch], 'another claim, with the same number');
    // The barrier changes again: only a gate of the current open may say so in the status.
    const view = live.client.status().recovery;
    if (wait === 'read') await live.reconcile('core');
    held.release();
    const answer = await gate;
    assert.equal(answer.open, false, wait);
    assert.match(answer.reasons.join(' '), /reopened or claimed again/, wait);
    assert.deepEqual(live.client.status().recovery, view, `${wait}: the earlier gate published nothing`);
    assert.deepEqual(await live.client.gate('fixture'), { open: true, reasons: [] }, `${wait}: a gate of the current claim opens`);
  }
});

test('a barrier replaced while its proof waits is not counted: the gate stays closed until it is read again', async t => {
  const live = await releasing(t);
  const proof = holdCall(t, storageFs, 'syncFile', path => path === live.barrierFile);
  const gate = live.client.gate('fixture');
  await proof.reached;
  await live.reconcile('core');
  proof.release();
  const answer = await gate;
  assert.equal(answer.open, false);
  assert.match(answer.reasons.join(' '), /not durable yet.*changed while it was checked/);
  assert.deepEqual(await live.client.gate('fixture'), { open: true, reasons: [] });
});

test('a prepare whose open was closed and reopened while it recorded the identity claims nothing in the new open and does not fail it; its commit stays committed', async t => {
  for (const outcome of ['recorded', 'failed'] as const) {
    const dir = await stateDir(t);
    const statuses: StorageStatus[] = [];
    const client = await openFixture(t, dir, { onUnavailable: status => statuses.push(status) });
    const { recoveryDir } = await storageLayout(dir);
    let identityWrites = 0;
    // The second identity record of this prepare: "created", after the thread committed the new storage.
    const created = holdCall(t, storageFs, 'createFile', path => path.startsWith(join(recoveryDir, '.identity.json.')) && ++identityWrites === 2);
    const preparing = client.prepare({ allowMigration: true, commandId: 'create-1' });
    await created.reached;
    assert.equal((await client.close()).ack, 'closed');
    assert.equal((await client.reopen()).state, 'ready');
    created.release(outcome === 'failed' ? Object.assign(new Error('injected EIO'), { code: 'EIO' }) : undefined);
    await rejectsWith(preparing, { phase: 'prepare', code: outcome === 'failed' ? 'io-error' : 'not-ready', disposition: 'committed', commandId: 'create-1' });
    const status = client.status();
    assert.deepEqual([status.state, status.ownerEpoch, status.failure], ['ready', undefined, undefined], `${outcome}: the open since is neither claimed nor failed by it`);
    assert.equal(statuses.length, 0, outcome);
    assert.equal((await client.gate('core')).open, false, outcome);
    await rejectsWith(client.write('fixture', 'put', { key: 'k', value: 'v' }, 'w-1'), { code: 'not-prepared', disposition: 'not-committed' });
    const again = await client.prepare({ allowMigration: false });
    assert.deepEqual([again.claimed, again.ownerEpoch], [true, 2], outcome);
    assert.ok((await client.receipt('create-1')).found, `${outcome}: the earlier prepare did commit`);
    assert.equal((await client.gate('core')).open, true, outcome);
  }
});
