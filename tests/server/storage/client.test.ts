import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { captureStorageBundle } from '../../../server/storage/bundle.js';
import { openStorage } from '../../../server/storage/client.js';
import { StorageCommandError, type StorageStatus } from '../../../server/storage/contract.js';
import { fixtureBundle, fixtureManifest, openFixture, sleep, stateDir } from './helpers.js';

const rejectsWith = (promise: Promise<unknown>, expected: Partial<StorageCommandError>) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StorageCommandError, String(error));
    for (const [key, value] of Object.entries(expected)) assert.equal((error as unknown as Record<string, unknown>)[key], value, `${key}: ${(error as Error).message}`);
    return true;
  });

test('the production storage opens, needs an explicit prepare, and keeps WAL/FULL/foreign keys/untrusted schema as read back', async t => {
  const dir = await stateDir(t);
  const bundle = await captureStorageBundle();
  assert.ok(bundle.ok && bundle.origin === 'development');
  const client = await openStorage({ stateDir: dir, bundle });
  t.after(() => client.close());
  assert.equal(client.status().state, 'ready');
  assert.deepEqual(client.status().schema, { kind: 'empty' });

  // Without permission to migrate, an empty file stays without tables.
  await rejectsWith(client.prepare({ allowMigration: false }), { code: 'migration-required', disposition: 'not-committed', phase: 'prepare' });
  const prepared = await client.prepare({ allowMigration: true, commandId: 'prepare-1' });
  assert.equal(prepared.created, true);
  assert.equal(prepared.ownerEpoch, 1);
  assert.deepEqual(prepared.applied, [{ scope: 'core', version: 1 }]);
  assert.equal(prepared.identityRecorded, true);

  const inspection = await client.inspect();
  assert.deepEqual(inspection.pragmas, { journalMode: 'wal', synchronous: 2, foreignKeys: 1, trustedSchema: 0, busyTimeout: 250 });
  assert.equal(inspection.ownerEpoch, 1);
  assert.deepEqual(inspection.authority, []);

  // An independent connection sees the file as WAL (header bytes 18/19 = 2) and the receipt of the prepare.
  const database = join(dir, 'storage', 'tower.db');
  const header = await readFile(database);
  assert.deepEqual([header[18], header[19]], [2, 2]);
  const other = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal((other.prepare("SELECT value FROM storage_meta WHERE key = 'format'").get() as { value: string }).value, 'agent-session-tower/storage');
    assert.equal((other.prepare("SELECT count(*) AS n FROM operation_receipts WHERE command_id = 'prepare-1'").get() as { n: number }).n, 1);
  } finally { other.close(); }
  assert.deepEqual(await client.receipt('prepare-1').then(found => found.found), true);
  assert.deepEqual(await client.receipt('never-sent'), { found: false });

  // The same prepare command again answers what it committed and claims nothing new.
  const replayed = await client.prepare({ allowMigration: true, commandId: 'prepare-1' });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.ownerEpoch, 1);
  await rejectsWith(client.prepare({ allowMigration: false, commandId: 'prepare-1' }), { code: 'command-id-conflict', disposition: 'not-committed' });

  // No production domain exists yet: a domain command is refused by the thread's fixed registry.
  await rejectsWith(client.write('runs', 'admit', {}, 'w-1'), { code: 'unknown-domain', disposition: 'not-committed' });
  await rejectsWith(client.read('runs', 'list', {}), { code: 'unknown-domain' });
});

test('flush, close ack and an explicit reopen with the same captured bundle; nothing is sent while closed', async t => {
  const dir = await stateDir(t);
  const bundle = await fixtureBundle();
  const client = await openStorage({ stateDir: dir, bundle, manifest: fixtureManifest });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  const queued = [client.write('fixture', 'put', { key: 'a', value: '1' }, 'put-a'), client.write('fixture', 'put', { key: 'b', value: '2' }, 'put-b')];
  await client.flush();
  assert.equal(client.status().pending, 0, 'flush answers after every earlier command');
  await Promise.all(queued);

  const closed = await client.close();
  assert.equal(closed.ack, 'closed');
  assert.equal(closed.status.state, 'closed');
  assert.equal((await client.close()).ack, 'already-closed');
  await rejectsWith(client.inspect(), { code: 'not-ready', disposition: 'not-committed' });
  await rejectsWith(client.write('fixture', 'put', { key: 'c', value: '3' }, 'put-c'), { code: 'not-ready', disposition: 'not-committed' });

  const reopened = await client.reopen();
  assert.equal(reopened.state, 'ready');
  assert.equal(reopened.identity?.sourceHash, bundle.sourceHash);
  await rejectsWith(client.reopen(), { code: 'invalid-command' });
  // Writes wait for this worker's own claim.
  await rejectsWith(client.write('fixture', 'put', { key: 'c', value: '3' }, 'put-c'), { code: 'not-prepared' });
  assert.equal((await client.prepare({ allowMigration: false })).ownerEpoch, 2);
  assert.equal(await client.read('fixture', 'count', null), 2);
  const written = await client.write('fixture', 'put', { key: 'c', value: '3' }, 'put-c');
  assert.deepEqual(written, { disposition: 'committed', result: { key: 'c' }, replayed: false, commandId: 'put-c' });
  assert.equal((await client.write('fixture', 'put', { key: 'c', value: '3' }, 'put-c')).replayed, true, 'a committed command ID is not applied twice');
  assert.equal(await client.read('fixture', 'count', null), 3);
  await rejectsWith(client.write('fixture', 'put', { key: 'c', value: 'other' }, 'put-c'), { code: 'command-id-conflict', disposition: 'not-committed' });
});

test('domain commands roll back on failure, keep foreign keys, and are refused when asynchronous or oversized', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir, { limits: { maxResultBytes: 4096 } });
  await client.prepare({ allowMigration: true });
  await rejectsWith(client.write('fixture', 'fail', null, 'fail-1'), { code: 'domain-failed', disposition: 'not-committed' });
  assert.equal(await client.read('fixture', 'get', { key: 'fail-row' }), null);
  assert.deepEqual(await client.receipt('fail-1'), { found: false });
  await rejectsWith(client.write('fixture', 'put', { key: 'orphan', value: 'x', parent: 'missing' }, 'fk-1'), { code: 'sqlite-error', disposition: 'not-committed' });
  assert.equal(await client.read('fixture', 'get', { key: 'orphan' }), null);
  await rejectsWith(client.read('fixture', 'later', null), { code: 'domain-failed' });
  await rejectsWith(client.read('fixture', 'big', { bytes: 10_000 }), { code: 'result-too-large' });
  await rejectsWith(client.read('fixture', 'put', null), { code: 'unknown-command' });
  await rejectsWith(client.write('fixture', 'get', null, 'x-1'), { code: 'unknown-command' });
  await rejectsWith(client.write('fixture', 'put', { key: 'k', value: 'v' }, 'bad id with spaces'), { code: 'invalid-command' });
  assert.equal(client.status().state, 'ready', 'command errors leave the storage serving');
});

test('busy: another connection holding the write lock makes a write fail not-committed and retryable, then succeed', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir, { limits: { busyTimeoutMs: 50 } });
  await client.prepare({ allowMigration: true });
  const other = new DatabaseSync(join(dir, 'storage', 'tower.db'));
  t.after(() => other.close());
  other.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  await rejectsWith(client.write('fixture', 'put', { key: 'busy', value: '1' }, 'busy-1'), { code: 'busy', disposition: 'not-committed', retryable: true });
  assert.ok(Date.now() - started >= 50, 'it waited at least the busy timeout');
  other.exec('ROLLBACK');
  assert.equal(client.status().state, 'ready');
  assert.equal((await client.write('fixture', 'put', { key: 'busy', value: '1' }, 'busy-1')).replayed, false);
});

test('queue and payload bounds refuse before the thread sees the command', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir, { limits: { maxQueue: 2, maxPayloadBytes: 1024 } });
  await client.prepare({ allowMigration: true });
  const slow = client.read('fixture', 'spin', { ms: 300 });
  const waiting = client.read('fixture', 'count', null);
  await rejectsWith(client.read('fixture', 'count', null), { code: 'queue-full', disposition: 'not-committed', retryable: true });
  await rejectsWith(client.write('fixture', 'put', { key: 'k', value: 'v' }, 'queued-out'), { code: 'queue-full', disposition: 'not-committed' });
  assert.equal(await slow, 'spun');
  assert.equal(await waiting, 0);
  await rejectsWith(client.write('fixture', 'put', { key: 'big', value: 'x'.repeat(2000) }, 'big-1'), { code: 'payload-too-large', disposition: 'not-committed' });
  await rejectsWith(client.write('fixture', 'put', { value: 1n }, 'bigint-1'), { code: 'invalid-command', disposition: 'not-committed' });
  assert.deepEqual(await client.receipt('big-1'), { found: false });
  assert.deepEqual(await client.receipt('queued-out'), { found: false });
});

test('a missed deadline fails the storage: the running write is unknown, waiting ones not committed, no new thread', async t => {
  const dir = await stateDir(t);
  const statuses: StorageStatus[] = [];
  const client = await openFixture(t, dir, { limits: { commandDeadlineMs: 1000 }, onUnavailable: status => statuses.push(status) });
  await client.prepare({ allowMigration: true });
  const slow = client.write('fixture', 'spinWrite', { key: 'slow', ms: 1600 }, 'slow-1');
  const queued = client.write('fixture', 'put', { key: 'after', value: '1' }, 'after-1');
  await rejectsWith(slow, { code: 'deadline-exceeded', phase: 'deadline', disposition: 'unknown', retryable: true, commandId: 'slow-1' });
  await rejectsWith(queued, { code: 'deadline-exceeded', disposition: 'not-committed' });
  assert.equal(client.status().state, 'unavailable');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].failure?.phase, 'deadline');
  await sleep(800);
  assert.equal(client.status().state, 'unavailable', 'nothing reopens it on its own');
  await rejectsWith(client.inspect(), { code: 'deadline-exceeded', disposition: 'not-committed' });

  // The explicit retry, then the receipt settles what the deadline left unknown: here terminating the thread stopped
  // the command inside its transaction, and the receipt and the data agree that it did not commit.
  assert.equal((await client.reopen()).state, 'ready');
  assert.deepEqual(await client.receipt('slow-1'), { found: false });
  assert.equal(await client.read('fixture', 'get', { key: 'slow' }), null);
  assert.deepEqual(await client.receipt('after-1'), { found: false });
});
