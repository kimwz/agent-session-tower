import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageCommandError, type StorageStatus } from '../../../server/storage/contract.js';
import { DatabaseSync } from 'node:sqlite';
import { openStorage } from '../../../server/storage/client.js';
import { databasePath, fixtureBundleA, fixtureManifest, fixtureManifestA, openFixture, sleep, stateDir } from './helpers.js';
import { until } from '../../helpers/until.js';

const failsWith = (promise: Promise<unknown>, expected: Partial<StorageCommandError>) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StorageCommandError, String(error));
    for (const [key, value] of Object.entries(expected)) assert.equal((error as unknown as Record<string, unknown>)[key], value, `${key}: ${(error as Error).message}`);
    return true;
  });

/** Counts timer ticks, to show the worker's own event loop keeps running while the thread fails. */
function ticker(t: { after(fn: () => void): void }) {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  t.after(() => clearInterval(timer));
  return () => ticks;
}

test('a thread that commits and exits before answering: the write is unknown, not "not committed"; the receipt proves it after reopen', async t => {
  const dir = await stateDir(t);
  const statuses: StorageStatus[] = [];
  const client = await openFixture(t, dir, { onUnavailable: status => statuses.push(status) });
  await client.prepare({ allowMigration: true });
  const ticks = ticker(t);
  const dying = client.write('fixture', 'putThenDie', { key: 'ghost' }, 'die-1');
  const queued = client.write('fixture', 'put', { key: 'queued', value: '1' }, 'queued-1');
  const read = client.read('fixture', 'count', null);
  await failsWith(dying, { phase: 'thread-exit', code: 'thread-exited', disposition: 'unknown', retryable: true, commandId: 'die-1' });
  await failsWith(queued, { code: 'thread-exited', disposition: 'not-committed', commandId: 'queued-1' });
  await failsWith(read, { code: 'thread-exited', disposition: 'not-committed' });
  const before = ticks();
  await sleep(100);
  assert.ok(ticks() > before, 'the event loop keeps running');
  const status = client.status();
  assert.equal(status.state, 'unavailable');
  assert.equal(status.failure?.phase, 'thread-exit');
  assert.match(status.failure!.message, /code 9/);
  assert.equal(status.failure?.sourcePreserved, true);
  assert.equal(status.ownerEpoch, undefined, 'a failed storage has no claim to write with');
  assert.equal(statuses.length, 1, 'the worker hears of it once, to hold durable intake');
  await sleep(300);
  assert.equal(client.status().state, 'unavailable', 'no thread is respawned on its own');
  await failsWith(client.write('fixture', 'put', { key: 'x', value: '1' }, 'x-1'), { code: 'thread-exited', disposition: 'not-committed' });

  assert.equal((await client.reopen()).state, 'ready');
  const receipt = await client.receipt('die-1');
  assert.ok(receipt.found, 'the unknown write had committed');
  assert.equal(receipt.receipt.command, 'putThenDie');
  assert.deepEqual(await client.receipt('queued-1'), { found: false });
  assert.deepEqual(await client.read('fixture', 'get', { key: 'ghost' }), { key: 'ghost', value: 'committed-before-exit' });
  // Settling it by sending the same command ID again answers the stored result instead of writing twice.
  await client.prepare({ allowMigration: false });
  const again = await client.write('fixture', 'putThenDie', { key: 'ghost' }, 'die-1');
  assert.equal(again.replayed, true);
});

test('a thread that exits inside the transaction: unknown to the worker, and the receipt shows it did not commit', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await failsWith(client.write('fixture', 'exitNow', { key: 'half', code: 4 }, 'exit-1'), { phase: 'thread-exit', disposition: 'unknown' });
  assert.match(client.status().failure!.message, /code 4/);
  await client.reopen();
  assert.deepEqual(await client.receipt('exit-1'), { found: false });
  assert.equal(await client.read('fixture', 'get', { key: 'half' }), null);
});

test('an uncaught exception in the thread ends it; the error is reported and the worker keeps running', async t => {
  const dir = await stateDir(t);
  const statuses: StorageStatus[] = [];
  const client = await openFixture(t, dir, { onUnavailable: status => statuses.push(status) });
  await client.prepare({ allowMigration: true });
  const ticks = ticker(t);
  assert.equal(await client.read('fixture', 'throwLater', null), 'scheduled');
  await until(() => client.status().state === 'unavailable');
  assert.match(client.status().failure!.message, /fixture boom/);
  assert.equal(client.status().failure?.code, 'thread-exited');
  const before = ticks();
  await sleep(50);
  assert.ok(ticks() > before);
  assert.equal(statuses.length, 1);
  const closed = await client.close();
  assert.equal(closed.ack, 'thread-exited', 'close of a failed storage waits for the gone thread and says so');
  assert.equal(closed.status.state, 'unavailable', 'the failure stays visible');
});

test('another worker claiming the storage makes this one\'s writes stale, not silently applied', async t => {
  const dir = await stateDir(t);
  const first = await openFixture(t, dir);
  assert.equal((await first.prepare({ allowMigration: true })).ownerEpoch, 1);
  await first.write('fixture', 'put', { key: 'one', value: '1' }, 'one-1');
  const second = await openFixture(t, dir);
  assert.equal((await second.prepare({ allowMigration: false })).ownerEpoch, 2);
  await failsWith(first.write('fixture', 'put', { key: 'two', value: '2' }, 'two-1'), { code: 'stale-owner', disposition: 'not-committed' });
  assert.deepEqual(await second.receipt('two-1'), { found: false });
  assert.equal((await second.write('fixture', 'put', { key: 'two', value: '2' }, 'two-1')).replayed, false);
});

test('domain authority changes only through the owning domain\'s command, generation by generation', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  const sha = (char: string) => char.repeat(64);
  await failsWith(client.write('fixture', 'export', { manifestSha256: sha('e') }, 'export-0'), { code: 'authority-missing', disposition: 'not-committed' });
  const imported = await client.write<{ generation: number; authority: string }>('fixture', 'import', { manifestSha256: sha('a') }, 'import-1');
  assert.deepEqual([imported.result.authority, imported.result.generation], ['database', 1]);
  const exported = await client.write<{ generation: number; authority: string }>('fixture', 'export', { manifestSha256: sha('b') }, 'export-1');
  assert.deepEqual([exported.result.authority, exported.result.generation], ['legacy-exported', 2]);
  const again = await client.write<{ generation: number }>('fixture', 'import', { manifestSha256: sha('c') }, 'import-2');
  assert.equal(again.result.generation, 3, 'a re-import is a new generation, never a reset');
  await failsWith(client.write('fixture', 'import', { manifestSha256: 'not-a-hash' }, 'import-3'), { code: 'domain-failed' });
  // A domain whose manifest has no cutover contract cannot claim an import.
  await failsWith(client.write('plain', 'import', null, 'plain-1'), { code: 'no-cutover-contract', disposition: 'not-committed' });
  const authority = (await client.inspect()).authority;
  assert.deepEqual(authority.map(row => [row.domain, row.authority, row.generation, row.manifestSha256]), [['fixture', 'database', 3, sha('c')]]);
});

test('release A (same schema and reader/writer contract, no cutover) never imports, yet reads, writes and exports back what release B imported', async t => {
  const sha = (char: string) => char.repeat(64);
  const a = (dir: string) => openStorage({ stateDir: dir, bundle: aBundle, manifest: fixtureManifestA });
  const aBundle = await fixtureBundleA();
  assert.notEqual(fixtureManifestA.digest, fixtureManifest.digest, 'A and B are different builds');
  assert.deepEqual(fixtureManifestA.domains.map(({ scope, schemaDigest, preparation }) => ({ scope, schemaDigest, preparation })), fixtureManifest.domains.map(({ scope, schemaDigest, preparation }) => ({ scope, schemaDigest, preparation })), 'with the same schema and contracts');

  // Before any cutover, A refuses the first import, on a database of its own and on one B prepared but never imported.
  const fresh = await stateDir(t);
  const prepOnly = await a(fresh);
  t.after(() => prepOnly.close());
  await prepOnly.prepare({ allowMigration: true });
  await failsWith(prepOnly.write('fixture', 'import', { manifestSha256: sha('a') }, 'a-import-0'), { code: 'no-cutover-contract', disposition: 'not-committed' });
  await failsWith(prepOnly.write('fixture', 'export', { manifestSha256: sha('a') }, 'a-export-0'), { code: 'authority-missing', disposition: 'not-committed' });
  assert.deepEqual((await prepOnly.inspect()).authority, []);

  // B imports and writes; A opens B's database as current (same schema), works in it, and exports it back.
  const dir = await stateDir(t);
  const b = await openFixture(t, dir);
  await b.prepare({ allowMigration: true });
  await b.write('fixture', 'import', { manifestSha256: sha('b') }, 'b-import');
  await b.write('fixture', 'put', { key: 'from-b', value: 'b' }, 'b-put');
  await b.close();
  const rollback = await a(dir);
  t.after(() => rollback.close());
  assert.equal(rollback.status().schema?.kind, 'current');
  await rollback.prepare({ allowMigration: false });
  assert.deepEqual(await rollback.read('fixture', 'get', { key: 'from-b' }), { key: 'from-b', value: 'b' });
  await rollback.write('fixture', 'put', { key: 'from-a', value: 'a' }, 'a-put');
  await failsWith(rollback.write('fixture', 'import', { manifestSha256: sha('c') }, 'a-import'), { code: 'no-cutover-contract', disposition: 'not-committed' });
  const exported = await rollback.write<{ authority: string; generation: number; readerContract: number; writerContract: number }>('fixture', 'export', { manifestSha256: sha('d') }, 'a-export');
  assert.deepEqual([exported.result.authority, exported.result.generation, exported.result.readerContract, exported.result.writerContract], ['legacy-exported', 2, 1, 1]);
  // Exported once, it is not exported again until something imports it.
  await failsWith(rollback.write('fixture', 'export', { manifestSha256: sha('e') }, 'a-export-2'), { code: 'authority-missing' });
  await rollback.close();

  // B reads what A wrote and the marker A left, and only B imports again.
  const forward = await openFixture(t, dir);
  await forward.prepare({ allowMigration: false });
  assert.deepEqual(await forward.read('fixture', 'get', { key: 'from-a' }), { key: 'from-a', value: 'a' });
  assert.deepEqual((await forward.inspect()).authority.map(row => [row.domain, row.authority, row.generation]), [['fixture', 'legacy-exported', 2]]);
  assert.equal((await forward.write<{ generation: number }>('fixture', 'import', { manifestSha256: sha('f') }, 'b-import-2')).result.generation, 3);
  await forward.close();

  // A database whose marker carries another reader/writer contract is not exported by A.
  const raw = new DatabaseSync(databasePath(dir));
  raw.exec("UPDATE domain_imports SET writer_contract = 2 WHERE domain = 'fixture'");
  raw.close();
  const mismatched = await a(dir);
  t.after(() => mismatched.close());
  await mismatched.prepare({ allowMigration: false });
  await failsWith(mismatched.write('fixture', 'export', { manifestSha256: sha('0') }, 'a-export-3'), { code: 'contract-mismatch', disposition: 'not-committed' });
  assert.deepEqual((await mismatched.inspect()).authority.map(row => [row.authority, row.generation]), [['database', 3]]);
});
