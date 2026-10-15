import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStorageBundle } from '../../../server/storage/bundle.js';
import { bundleStorageThread } from '../../../server/storage/thread-bundle.mjs';
import { RemoteRepository } from '../../../server/remote/storage-repository.js';
import { remoteRows } from '../../../server/remote/storage-codec.js';
import { currentStorage } from '../../helpers/current-storage.js';
import { FixtureCompileCache } from './fixtures/compile-cache.js';

test('compile cache shares only immutable output and distinguishes source, plugin profile, faults and failed builds', async () => {
  const cache = new FixtureCompileCache(2);
  let builds = 0;
  const build = async (source: string) => { builds++; return source; };
  const entry = (dir: string, fault = 'normal') => `const path = ${JSON.stringify(dir + '/marker')}; const fault = '${fault}';`;
  const first = await cache.compile(entry('/one'), '/one', 'A', build);
  const second = await cache.compile(entry('/two'), '/two', 'A', build);
  assert.equal(builds, 1);
  assert.equal(first, entry('/one')); assert.equal(second, entry('/two'));
  await cache.compile(entry('/two', 'lost'), '/two', 'A', build);
  await cache.compile(entry('/two', 'lost'), '/two', 'B', build);
  assert.equal(builds, 3, 'fault and plugin profile cannot reuse another source');
  await cache.compile(entry('/one'), '/one', 'A', build);
  assert.equal(builds, 4, 'bounded cache evicts older entries');
  const fail = async () => { throw new Error('compile failed'); };
  await assert.rejects(cache.compile('broken', '/one', 'C', fail), /compile failed/);
  assert.equal(await cache.compile('broken', '/one', 'C', build), 'broken');
});

test('same-job disk cache reuses immutable builds across test processes and rejects corrupted bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-job-compile-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let builds = 0;
  const build = async (source: string) => { builds++; return source; };
  const entry = (dir: string) => `const marker = ${JSON.stringify(dir + '/marker')};`;
  const a = new FixtureCompileCache(128, directory);
  const b = new FixtureCompileCache(128, directory);
  await a.compile(entry('/one'), '/one', 'same-job-toolchain', build);
  assert.equal(await b.compile(entry('/two'), '/two', 'same-job-toolchain', build), entry('/two'));
  assert.equal(builds, 1);
  const original = (await readdir(directory))[0];
  await b.compile(entry('/two'), '/two', 'different-fault-profile', build);
  assert.equal(builds, 2);
  const file = join(directory, original);
  const saved = JSON.parse(await readFile(file, 'utf8')); saved.body += 'corruption';
  await writeFile(file, JSON.stringify(saved));
  const poisoned = new FixtureCompileCache(128, directory);
  await assert.rejects(poisoned.compile(entry('/three'), '/three', 'same-job-toolchain', build));
});

test('the current-storage fixture shares only the compiled thread: its warm bundle is the cold build byte for byte, and stores stay apart', async t => {
  const warm = await captureStorageBundle();
  assert.equal(await captureStorageBundle(), warm, 'one capture per process');
  const cold = await bundleStorageThread();
  assert.ok(warm.ok);
  assert.equal(warm.source, cold.source);
  assert.equal(warm.sourceHash, cold.sourceHash);
  const root = await mkdtemp(join(tmpdir(), 'tower-current-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = await currentStorage(join(root, 'one'));
  const two = await currentStorage(join(root, 'two')).catch(async error => { await one.close(); throw error; });
  try {
    const ids = [one.status().schema, two.status().schema].map(schema => schema?.kind === 'current' ? schema.storageId : undefined);
    assert.ok(ids[0] && ids[1] && ids[0] !== ids[1], 'each store is its own storage');
    const [remoteOne, remoteTwo] = [new RemoteRepository(one), new RemoteRepository(two)];
    const before = await remoteTwo.head();
    const rows = remoteRows([{ key: 'controller\noperation\n0190a5b2-1c3d-7abc-8def-0123456789ab', fingerprint: 'f'.repeat(64), at: 1 }]);
    await remoteOne.update(rows.map(row => ({ ...row, previous: null })));
    assert.equal((await remoteOne.loadRows()).length, 1);
    assert.deepEqual(await remoteTwo.head(), before, 'a write to one store leaves the other as it was');
    assert.deepEqual(await remoteTwo.loadRows(), []);
  } finally { await one.close(); await two.close(); }
});
