import assert from 'node:assert/strict';
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
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
console.log(JSON.stringify({ format: 'tower-sqlite-foundation-baseline', sourceSHA: process.env.VALIDATION_SHA,
  completed, iterations: count, preflight, inspection, bundle: { origin: bundle.origin, sourceHash: bundle.sourceHash },
  durability: 'WAL/FULL', unit: 'milliseconds', timings: Object.fromEntries(Object.entries(samples).map(([name, values]) =>
    [name, { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), samples: values }])) }));
