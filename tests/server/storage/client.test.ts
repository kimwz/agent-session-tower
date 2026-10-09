import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { StorageStatus } from '../../../server/storage/contract.js';
import { databasePath, filesUnder, fixtureBundle, openFixture, rejectsWith, sleep, stateDir, storage, threadBundle } from './helpers.js';

const { openStorage } = storage;

test('the production storage opens, needs an explicit prepare, and keeps WAL/FULL/foreign keys/untrusted schema as read back', async t => {
  const dir = await stateDir(t);
  // The production thread entry, as the fixture build trusts it (the checkout's own capture is checked in bundle.test.ts).
  const bundle = threadBundle('production');
  const client = await openStorage({ stateDir: dir, bundle });
  t.after(() => client.close());
  assert.equal(client.status().state, 'ready');
  assert.deepEqual(client.status().schema, { kind: 'empty' });

  // Without permission to migrate, an empty file stays without tables.
  await rejectsWith(client.prepare({ allowMigration: false }), { code: 'migration-required', disposition: 'not-committed', phase: 'prepare' });
  const prepared = await client.prepare({ allowMigration: true, commandId: 'prepare-1' });
  assert.equal(prepared.created, true);
  assert.equal(prepared.claimed, true);
  assert.equal(prepared.ownerEpoch, 1);
  assert.deepEqual(prepared.applied, [{ scope: 'core', version: 1 }, { scope: 'retention', version: 1 }, { scope: 'retention', version: 2 }, { scope: 'runs', version: 1 }]);
  const identity = JSON.parse(await readFile(join(dir, 'storage-recovery', 'identity.json'), 'utf8'));
  assert.deepEqual([identity.state, identity.storageId], ['created', prepared.schema.kind !== 'empty' && prepared.schema.storageId], 'the claim comes after the identity says created');
  assert.ok(!Object.keys(await filesUnder(dir)).some(name => name.startsWith('storage/') || name === 'storage'), 'the database is <state-dir>/state.sqlite, with no storage/ folder');

  const inspection = await client.inspect();
  assert.deepEqual(inspection.pragmas, { journalMode: 'wal', synchronous: 2, foreignKeys: 1, trustedSchema: 0, busyTimeout: 250 });
  assert.equal(inspection.ownerEpoch, 1);
  assert.deepEqual(inspection.authority, []);

  // An independent connection sees the file as WAL (header bytes 18/19 = 2) and the receipt of the prepare.
  const database = databasePath(dir);
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

  // The fixed registry rejects absent domains and absent commands in the installed runs domain.
  await rejectsWith(client.write('missing-domain', 'admit', {}, 'w-1'), { code: 'unknown-domain', disposition: 'not-committed' });
  await rejectsWith(client.read('missing-domain', 'list', {}), { code: 'unknown-domain' });
  await rejectsWith(client.write('runs', 'missing-command', {}, 'w-2'), { code: 'unknown-command', disposition: 'not-committed' });
  await rejectsWith(client.read('runs', 'missing-command', {}), { code: 'unknown-command' });
});

test('flush, close ack and an explicit reopen with the same captured bundle; nothing is sent while closed', async t => {
  const dir = await stateDir(t);
  const bundle = await fixtureBundle();
  const client = await openStorage({ stateDir: dir, bundle });
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
  const other = new DatabaseSync(databasePath(dir));
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

test('a full queue still drains on flush and close: the accepted write commits, close acks, the thread exits 0, intake is refused meanwhile', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir, { limits: { maxQueue: 1 } });
  await client.prepare({ allowMigration: true });
  const accepted = client.write('fixture', 'spinWrite', { key: 'slow', ms: 300 }, 'slow-1');
  await rejectsWith(client.read('fixture', 'count', null), { code: 'queue-full', disposition: 'not-committed' });
  // Barriers wait behind the full queue instead of being refused; a flush right behind another one shares it.
  const flushed = [client.flush(), client.flush()];
  const closing = client.close();
  await new Promise(setImmediate);
  assert.equal(client.status().state, 'closing');
  await rejectsWith(client.write('fixture', 'put', { key: 'late', value: '1' }, 'late-1'), { code: 'not-ready', disposition: 'not-committed' });
  await Promise.all(flushed);
  assert.deepEqual(await accepted, { disposition: 'committed', result: 'spun', replayed: false, commandId: 'slow-1' });
  const closed = await closing;
  assert.deepEqual([closed.ack, closed.exitCode, closed.status.state, closed.status.failure], ['closed', 0, 'closed', undefined]);

  assert.equal((await client.reopen()).state, 'ready');
  await client.prepare({ allowMigration: false });
  const receipt = await client.receipt('slow-1');
  assert.ok(receipt.found && receipt.receipt.result.state === 'included' && receipt.receipt.result.value === 'spun');
  assert.deepEqual(await client.receipt('late-1'), { found: false });
});

test('receipts and replays answer within the current maxResultBytes and still say the command committed', async t => {
  const dir = await stateDir(t);
  const roomy = await openFixture(t, dir, { limits: { maxResultBytes: 4096 } });
  await roomy.prepare({ allowMigration: true });
  const written = await roomy.write<string>('fixture', 'putLarge', { key: 'large', bytes: 2048 }, 'large-1');
  assert.equal(written.result.length, 2048);
  const stored = await roomy.receipt('large-1');
  assert.ok(stored.found && stored.receipt.result.state === 'included');
  await roomy.close();

  const tight = await openFixture(t, dir, { limits: { maxResultBytes: 1024 } });
  await tight.prepare({ allowMigration: false });
  const lookup = await tight.receipt('large-1');
  assert.ok(lookup.found);
  const answer = JSON.stringify('x'.repeat(2048));
  assert.deepEqual(lookup.receipt.result, { state: 'omitted', bytes: Buffer.byteLength(answer), sha256: createHash('sha256').update(answer).digest('hex'), limit: 1024 });
  assert.deepEqual([lookup.receipt.commandId, lookup.receipt.scope, lookup.receipt.command], ['large-1', 'fixture', 'putLarge']);
  assert.match(lookup.receipt.payloadSha256, /^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(lookup)) <= 1024);
  // The same command again: committed, its answer too large for this connection, nothing written twice.
  await rejectsWith(tight.write('fixture', 'putLarge', { key: 'large', bytes: 2048 }, 'large-1'), { code: 'result-too-large', disposition: 'committed', commandId: 'large-1' });
  assert.equal(await tight.read('fixture', 'count', null), 1);
  // Another payload under the same ID is still a conflict, not a commit.
  await rejectsWith(tight.write('fixture', 'putLarge', { key: 'other', bytes: 10 }, 'large-1'), { code: 'command-id-conflict', disposition: 'not-committed' });
  // A fresh answer over the limit rolls its transaction back: not committed.
  await rejectsWith(tight.write('fixture', 'putLarge', { key: 'fresh', bytes: 2048 }, 'fresh-1'), { code: 'result-too-large', disposition: 'not-committed' });
  assert.deepEqual(await tight.receipt('fresh-1'), { found: false });
  assert.equal(tight.status().state, 'ready');
});

/** UTF-8 bytes of a value as JSON, the measure maxResultBytes is stated in. */
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** The length of a putLarge answer ('x' repeated) whose whole first WriteResult under `commandId` is exactly `bytes`. */
const answerFor = (bytes: number, commandId: string) => bytes - jsonBytes({ disposition: 'committed', result: '', replayed: false, commandId });

test('maxResultBytes 1024 bounds the whole public answer: a WriteResult of exactly 1024 bytes commits and replays, one byte more rolls back, and a read or receipt stays within it', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir, { limits: { maxResultBytes: 1024 } });
  await client.prepare({ allowMigration: true });
  const length = answerFor(1024, 'edge-1');
  const written = await client.write<string>('fixture', 'putLarge', { key: 'edge', bytes: length }, 'edge-1');
  assert.equal(jsonBytes(written), 1024, 'the first answer is exactly the limit');
  const replayed = await client.write('fixture', 'putLarge', { key: 'edge', bytes: length }, 'edge-1');
  assert.deepEqual([replayed.replayed, jsonBytes(replayed)], [true, 1023], 'a replay is one byte shorter, so it fits too');
  // One byte more: the domain command ran, its answer did not fit, and its transaction rolled back.
  await rejectsWith(client.write('fixture', 'putLarge', { key: 'over', bytes: answerFor(1025, 'edge-2') }, 'edge-2'), { code: 'result-too-large', disposition: 'not-committed', commandId: 'edge-2' });
  assert.deepEqual(await client.receipt('edge-2'), { found: false });
  assert.equal(await client.read('fixture', 'count', null), 1, 'only the first command left its row');
  // The receipt carries more than the answer, so here it says only how large the answer was.
  const receipt = await client.receipt('edge-1');
  assert.ok(receipt.found && receipt.receipt.result.state === 'omitted');
  assert.ok(jsonBytes(receipt) <= 1024);
  // A read's answer is its value: exactly the limit passes, one byte more is refused.
  assert.equal(jsonBytes(await client.read('fixture', 'big', { bytes: 1022 })), 1024);
  await rejectsWith(client.read('fixture', 'big', { bytes: 1023 }), { code: 'result-too-large', disposition: 'not-committed' });
});

test('an answer committed under a larger limit replays at 1024 as a small committed fact, and the command never runs again', async t => {
  const dir = await stateDir(t);
  const roomy = await openFixture(t, dir, { limits: { maxResultBytes: 4096 } });
  await roomy.prepare({ allowMigration: true });
  // Its text alone fits 1024; its WriteResult does not.
  const length = answerFor(1100, 'large-1');
  assert.ok(length + 2 <= 1024);
  await roomy.write('fixture', 'putLarge', { key: 'large', bytes: length }, 'large-1');
  // The longest command ID the storage accepts, with a large answer.
  const longest = 'i'.repeat(128);
  await roomy.write('fixture', 'putLarge', { key: 'long', bytes: 3000 }, longest);
  await roomy.close();
  const tight = await openFixture(t, dir, { limits: { maxResultBytes: 1024 } });
  await tight.prepare({ allowMigration: false });
  await rejectsWith(tight.write('fixture', 'putLarge', { key: 'large', bytes: length }, 'large-1'), { code: 'result-too-large', disposition: 'committed', commandId: 'large-1' });
  await rejectsWith(tight.write('fixture', 'putLarge', { key: 'long', bytes: 3000 }, longest), { code: 'result-too-large', disposition: 'committed' });
  assert.equal(await tight.read('fixture', 'count', null), 2, 'neither ran again');
  const receipt = await tight.receipt('large-1');
  assert.ok(receipt.found && receipt.receipt.result.state === 'omitted' && receipt.receipt.result.bytes === length + 2);
  // What stands in for an answer is small: within the ID and name limits it fits the smallest maxResultBytes.
  const long = await tight.receipt(longest);
  assert.ok(long.found && long.receipt.result.state === 'omitted');
  assert.ok(jsonBytes(long) <= 1024, `${jsonBytes(long)} bytes`);
});

test('control answers are not command results: a prepare with a fixed command ID replays at maxResultBytes 1024', async t => {
  const dir = await stateDir(t);
  const roomy = await openFixture(t, dir, { limits: { maxResultBytes: 4096 } });
  await roomy.prepare({ allowMigration: true, commandId: 'prepare-fixed' });
  await roomy.close();
  const tight = await openFixture(t, dir, { limits: { maxResultBytes: 1024 } });
  const replayed = await tight.prepare({ allowMigration: true, commandId: 'prepare-fixed' });
  // The same commit answered again: it claims nothing new, so the worker gates on its own fresh prepare.
  assert.deepEqual([replayed.replayed, replayed.ownerEpoch], [true, 1]);
  assert.equal((await tight.gate('core')).open, replayed.claimed);
  const fresh = await tight.prepare({ allowMigration: false });
  assert.deepEqual([fresh.replayed, fresh.claimed, fresh.ownerEpoch], [false, true, 2]);
  assert.equal((await tight.gate('core')).open, true);
});
