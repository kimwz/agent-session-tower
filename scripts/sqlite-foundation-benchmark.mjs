import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { captureStorageBundle, preflightStorage, openStorage } from '../server/storage/index.ts';

// Hosted job owns this fresh state until runner disposal. No domain fixtures or SQL escape hatch.
assert.equal(process.env.SQLITE_VALIDATION_CI, '1', 'run only in the hosted private validation environment');
assert.ok(process.env.VALIDATION_ROOT, 'private validation root required');
const count = Number(process.argv[2] ?? 20);
assert.ok(Number.isSafeInteger(count) && count >= 2 && count <= 1000);
const bundle = await captureStorageBundle();
assert.equal(bundle.ok, true, JSON.stringify(bundle));
const preflight = await preflightStorage({ bundle });
assert.equal(preflight.supported, true, JSON.stringify(preflight));
const stateDir = await mkdtemp(join(resolve(process.env.VALIDATION_ROOT), 'state', 'foundation-'));
const samples = { prepare: [], inspect: [], close: [], reopen: [] };
const time = async (name, operation) => {
  const start = performance.now();
  const result = await operation();
  samples[name].push(performance.now() - start);
  return result;
};
let client;
let inspection;
let completed = false;
try {
  client = await openStorage({ stateDir, bundle });
  assert.equal(client.status().state, 'ready', JSON.stringify(client.status()));
  for (let index = 0; index < count; index++) {
    const prepared = await time('prepare', () => client.prepare({ allowMigration: index === 0 }));
    assert.equal(prepared.claimed, true);
    assert.equal((await client.gate('core')).open, true);
    inspection = await time('inspect', () => client.inspect());
    assert.deepEqual(inspection.pragmas, { journalMode: 'wal', synchronous: 2, foreignKeys: 1, trustedSchema: 0, busyTimeout: 250 });
    assert.deepEqual(inspection.authority, [], 'domain authority is not migrated');
    const closed = await time('close', () => client.close());
    assert.equal(closed.ack, 'closed');
    assert.equal(closed.exitCode, 0);
    const reopened = await time('reopen', () => client.reopen());
    assert.equal(reopened.state, 'ready');
    assert.deepEqual(reopened.identity, preflight.identity);
  }
  completed = true;
} finally {
  if (client) {
    const closed = await client.close();
    assert.equal(closed.status.state, 'closed');
  }
}
// Same production core schema, seeded outside timing through the captured SDK. Each
// repetition owns fresh private files; cold means first claim after connection open,
// not cold SSD caches (the hosted job cannot control the machine's cache).
const commitComparison = { repetitions: 3, commitsPerRepetition: count,
  coldDefinition: 'first claim after open on a freshly SDK-seeded database; OS caches uncontrolled',
  reference: 'main-thread node:sqlite BEGIN IMMEDIATE core claim + receipt; no SDK validation/IPC/identity sync',
  sdk: 'actual captured SDK prepare end-to-end, including validation, IPC, schema reads and identity durability',
  interpretation: 'difference is not pure IPC cost or project speedup',
  environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch,
    fixtureRoot: resolve(process.env.VALIDATION_ROOT), storage: 'same hosted private validation filesystem for both modes' },
  mainThread: { cold: [], warm: [] }, sdkThread: { cold: [], warm: [] }, outcomes: [] };
const configure = db => db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250');
const verifyDatabase = (path, expectedEpoch) => {
  const db = new DatabaseSync(path);
  try {
    configure(db);
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 250);
    assert.equal(Number(db.prepare("SELECT value FROM storage_meta WHERE key='owner_epoch'").get().value), expectedEpoch);
    assert.equal(db.prepare('SELECT count(*) AS n FROM operation_receipts').get().n, expectedEpoch);
    assert.equal(db.prepare('SELECT count(DISTINCT owner_epoch) AS n FROM operation_receipts').get().n, expectedEpoch);
    assert.equal(db.prepare('SELECT count(*) AS n FROM domain_imports').get().n, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const rows = db.prepare('SELECT * FROM operation_receipts ORDER BY owner_epoch').all();
    for (const row of rows.slice(1)) {
      assert.equal(row.scope, 'core'); assert.equal(row.command, 'prepare');
      assert.deepEqual(JSON.parse(row.result), { ownerEpoch: row.owner_epoch, applied: [], created: false });
      const storageId = db.prepare("SELECT value FROM storage_meta WHERE key='storage_id'").get().value;
      assert.equal(row.payload_sha256, createHash('sha256').update(JSON.stringify({ allowMigration: false, storageId })).digest('hex'));
    }
    return { epoch: expectedEpoch, receipts: rows.length, integrity: 'ok', authority: [], synchronous: 2,
      measuredReceiptBytes: rows.slice(1).map(row => Buffer.byteLength(JSON.stringify(row))) };
  } finally { db.close(); }
};
for (let repetition = 0; repetition < commitComparison.repetitions; repetition++) {
  for (const mode of ['mainThread', 'sdkThread']) {
    const dir = await mkdtemp(join(resolve(process.env.VALIDATION_ROOT), 'state', `full-${mode}-`));
    let sdk = await openStorage({ stateDir: dir, bundle });
    let direct;
    try {
      assert.equal((await sdk.prepare({ allowMigration: true })).ownerEpoch, 1);
      assert.deepEqual((await sdk.inspect()).pragmas, { journalMode: 'wal', synchronous: 2, foreignKeys: 1, trustedSchema: 0, busyTimeout: 250 });
      if (mode === 'mainThread') {
        assert.equal((await sdk.close()).ack, 'closed'); sdk = undefined;
        direct = new DatabaseSync(join(dir, 'state.sqlite')); configure(direct);
      } else {
        assert.equal((await sdk.close()).ack, 'closed');
        assert.equal((await sdk.reopen()).state, 'ready');
        assert.deepEqual((await sdk.inspect()).pragmas, { journalMode: 'wal', synchronous: 2, foreignKeys: 1, trustedSchema: 0, busyTimeout: 250 });
      }
      for (let index = 0; index < count; index++) {
        const commandId = `benchmark-${repetition}-${index}`;
        const epoch = index + 2;
        const start = performance.now();
        if (direct) {
          const now = new Date().toISOString();
          const storageId = direct.prepare("SELECT value FROM storage_meta WHERE key='storage_id'").get().value;
          assert.equal(Number(direct.prepare("SELECT value FROM storage_meta WHERE key='owner_epoch'").get().value), epoch - 1);
          const payloadHash = createHash('sha256').update(JSON.stringify({ allowMigration: false, storageId })).digest('hex');
          direct.exec('BEGIN IMMEDIATE');
          try {
            const meta = direct.prepare('INSERT INTO storage_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value');
            for (const [key, value] of [['owner_epoch', String(epoch)], ['owner_app_version', preflight.identity.appVersion],
              ['owner_source_hash', preflight.identity.sourceHash], ['owner_claimed_at', now]]) meta.run(key, value);
            direct.prepare('INSERT INTO operation_receipts (command_id, scope, command, payload_sha256, owner_epoch, committed_at, result) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(commandId, 'core', 'prepare', payloadHash, epoch, now, JSON.stringify({ ownerEpoch: epoch, applied: [], created: false }));
            direct.exec('COMMIT');
          } catch (error) { direct.exec('ROLLBACK'); throw error; }
        } else {
          const result = await sdk.prepare({ allowMigration: false, commandId });
          assert.equal(result.ownerEpoch, epoch); assert.equal(result.claimed, true); assert.equal(result.replayed, false);
        }
        commitComparison[mode][index === 0 ? 'cold' : 'warm'].push(performance.now() - start);
        if (sdk) {
          const receipt = await sdk.receipt(commandId);
          assert.equal(receipt.found, true); assert.equal(receipt.receipt.ownerEpoch, epoch);
        }
      }
    } finally {
      if (direct) direct.close();
      if (sdk) assert.equal((await sdk.close()).ack, 'closed');
    }
    commitComparison.outcomes.push({ repetition, mode, ...verifyDatabase(join(dir, 'state.sqlite'), count + 1) });
  }
}
for (let repetition = 0; repetition < commitComparison.repetitions; repetition++) {
  const pair = commitComparison.outcomes.filter(outcome => outcome.repetition === repetition);
  assert.deepEqual(pair[0].measuredReceiptBytes, pair[1].measuredReceiptBytes, 'matching-sized actual receipt writes');
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
for (const mode of ['mainThread', 'sdkThread']) for (const phase of ['cold', 'warm']) {
  const values = commitComparison[mode][phase];
  commitComparison[mode][phase] = { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), samples: values };
}
console.log(JSON.stringify({ commitComparison, format: 'tower-sqlite-foundation-baseline', sourceSHA: process.env.VALIDATION_SHA,
  completed, iterations: count, preflight, inspection, bundle: { origin: bundle.origin, sourceHash: bundle.sourceHash },
  durability: 'WAL/FULL', unit: 'milliseconds', timings: Object.fromEntries(Object.entries(samples).map(([name, values]) =>
    [name, { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), samples: values }])) }));
