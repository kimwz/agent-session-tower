import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_VERSION } from '../../../shared/app-identity.js';
import { FixtureCompileCache } from './fixtures/compile-cache.js';
import { retentionBuild, currentProductProfile } from './fixtures/retention-build.js';

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

test('cached fixture bytes match fresh compilation for every fault and each private path while modules and databases remain isolated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-compile-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await retentionBuild('1.123.0', join(root, 'one'));
  const b = await retentionBuild('1.123.0', join(root, 'two'));
  const fresh = await retentionBuild('1.123.0', b.directory, true, false, false, undefined, false, 'normal', false);
  assert.notEqual(a.storage, b.storage, 'mutable module hooks are private');
  for (const fault of ['normal', 'before', 'after', 'after-native-hold', 'after-steer-hold', 'runs-refuse-compensation-loss', 'after-unsent-compensation', 'refuse-once', 'corrupt', 'io']) {
    const cached = b.bundle(fault), cold = fresh.bundle(fault);
    assert.ok(cached.ok && cold.ok);
    assert.equal(cached.sourceHash, cold.sourceHash, `fresh hash matches for ${fault}`);
    assert.ok(cached.source === cold.source, `fresh bytes match for ${fault}`);
  }
  assert.notEqual(a.bundle('corrupt').sourceHash, b.bundle('corrupt').sourceHash, 'fault paths are private');
  await mkdir(join(root, 'state-one')); await mkdir(join(root, 'state-two'));
  const ac = await a.storage.openStorage({ stateDir: join(root, 'state-one'), bundle: a.bundle() });
  const bc = await b.storage.openStorage({ stateDir: join(root, 'state-two'), bundle: b.bundle() });
  t.after(async () => { await ac.close(); await bc.close(); });
  await ac.prepare({ allowMigration: true });
  assert.equal(bc.status().schema?.kind, 'empty', 'one database cannot prepare another');
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

test('product fault cache matches cold bytes while the actual normal artifact remains the candidate SDK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-product-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const product = { ...await currentProductProfile(), serviceFixture: { installed: true, loadedAtCheck: 3 } };
  const a = await retentionBuild(APP_VERSION, join(root, 'one'), true, true, true, product);
  const b = await retentionBuild(APP_VERSION, join(root, 'two'), true, true, true, product);
  const fresh = await retentionBuild(APP_VERSION, b.directory, true, true, true, product, false, 'normal', false);
  assert.notEqual(a.storage, b.storage);
  assert.equal(b.bundle().sourceHash, product.artifact.sourceHash);
  for (const fault of ['normal', 'remote-completed-refused', 'inspect-exit-once', 'runs-before', 'before', 'after', 'after-native-hold', 'after-steer-hold', 'runs-refuse-compensation-loss', 'after-unsent-compensation', 'refuse-once', 'corrupt', 'io']) {
    assert.equal(b.bundle(fault).source, fresh.bundle(fault).source, fault);
    assert.equal(b.bundle(fault).sourceHash, fresh.bundle(fault).sourceHash, fault);
  }
});
