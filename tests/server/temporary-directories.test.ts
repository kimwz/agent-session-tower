import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateTemporary, TemporaryCollector } from '../../server/temporary/directories.js';
import { temporaryFixture, removeTemporaryFixture } from '../helpers/temporary.js';
const old = new Date(Date.now() - 3 * 86400_000);
test('owned temporary release is awaited, records consumer and is idempotent after failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owned-temp-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const allocation = await createPrivateTemporary('mcp', root);
  await allocation.bindConsumer(999999998);
  const namespace = join(root, `tower-owned-${process.getuid?.() ?? 0}`);
  const records = await readdir(join(namespace, 'records')); assert.equal(records.length, 1);
  const owner = JSON.parse(await readFile(join(namespace, 'records', records[0]), 'utf8'));
  assert.deepEqual(owner.consumerPids, [999999998]);
  await writeFile(join(allocation.directory, 'config.json'), 'fixture');
  await allocation.release(); await allocation.release();
  await assert.rejects(lstat(allocation.directory), { code: 'ENOENT' }); assert.deepEqual(await readdir(join(namespace, 'records')), []);
});
test('legacy sweep removes only old empty allowed fixtures and protects active, unproven, symlink and runner paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-sweep-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (name: string, aged = true) => { const path = join(root, name); await mkdir(path); if (aged) await utimes(path, old, old); return path; };
  const removable = await make('tower-terminal-host-ABC123');
  const active = await make('tower-nodes-same-ABC123');
  const nonempty = await make('tower-terminal-host-FIL123'); await writeFile(join(nonempty, 'keep.txt'), 'retain'); await utimes(nonempty, old, old);
  const young = await make('tower-terminal-host-YNG123', false);
  const runner = await make('tower-runner-501-deadbeef');
  const unknown = await make('tower-user-work-ABC123');
  const target = await make('target'); const linked = join(root, 'tower-terminal-host-LNK123'); await symlink(target, linked);
  const collector = new TemporaryCollector({ roots: [root], protection: async () => ({ complete: true, issues: [], paths: [join(active, 'pending-work')] }) });
  const result = await collector.cycle(); assert.equal(result.removedEmpty, 1);
  await assert.rejects(lstat(removable), { code: 'ENOENT' });
  for (const path of [active, nonempty, young, runner, unknown, linked]) await lstat(path);
  assert.equal((await collector.cycle()).removedEmpty, 0); await collector.close();
});
test('inspection failure and collector quiesce never remove empty fixtures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-guard-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'tower-terminal-host-ABC123'); await mkdir(path); await utimes(path, old, old);
  const collector = new TemporaryCollector({ roots: [root], protection: async () => ({ complete: false, issues: ['failed'], paths: [] }) });
  assert.equal((await collector.cycle()).removedEmpty, 0); await lstat(path); await collector.quiesce(); await collector.cycle(); await lstat(path); await collector.close();
});
test('fixture root teardown removes exact nested runner sibling and never recreates roots', async () => {
  const root = await temporaryFixture('tower-helper-cleanup-');
  const state = join(root, 'state'); await mkdir(state);
  const { runnerPaths } = await import('../../server/runs/runner-protocol.js'); const paths = await runnerPaths(state);
  await writeFile(join(paths.directory, 'fixture.txt'), 'fixture');
  await removeTemporaryFixture(root); await removeTemporaryFixture(root); await assert.rejects(lstat(paths.directory), { code: 'ENOENT' }); await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('orphan collection preserves a live consumer and collects only proven dead owner/consumer records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-orphan-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const allocation = await createPrivateTemporary('mcp', root);
  const namespace = join(root, `tower-owned-${process.getuid?.() ?? 0}`);
  const recordPath = join(namespace, 'records', (await readdir(join(namespace, 'records')))[0]);
  const owner = JSON.parse(await readFile(recordPath, 'utf8')); owner.ownerPid = 999999999; owner.createdAt = old.getTime(); owner.consumerPids = [process.pid];
  await writeFile(recordPath, JSON.stringify(owner), { mode: 0o600 });
  const collector = new TemporaryCollector({ roots: [root], protection: async () => ({ complete: true, issues: [], paths: [] }) });
  assert.equal((await collector.cycle()).releasedOwned, 0); await lstat(allocation.directory);
  owner.consumerPids = [999999998]; await writeFile(recordPath, JSON.stringify(owner), { mode: 0o600 });
  assert.equal((await collector.cycle()).releasedOwned, 1); await assert.rejects(lstat(allocation.directory), { code: 'ENOENT' }); await collector.close();
});
test('dry run exposes eligible old empty fixtures without deleting them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-dry-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'tower-terminal-host-ABC123'); await mkdir(path); await utimes(path, old, old);
  const collector = new TemporaryCollector({ roots: [root], dryRun: true, protection: async () => ({ complete: true, issues: [], paths: [] }) });
  const result = await collector.cycle(); assert.equal(result.eligibleEmpty, 1); assert.equal(result.removedEmpty, 0); await lstat(path); await collector.close();
});
test('release rejects changed directory identity and can retry after the owned directory is restored', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-identity-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const allocation = await createPrivateTemporary('mcp', root); const aside = allocation.directory + '-aside';
  await rename(allocation.directory, aside); await mkdir(allocation.directory);
  const errors: unknown[][] = []; const log = console.error; console.error = (...args) => { errors.push(args); }; t.after(() => { console.error = log; });
  await assert.rejects(allocation.release(), /identity changed/); assert.equal(errors.length, 1); await lstat(aside);
  await rm(allocation.directory, { recursive: true }); await rename(aside, allocation.directory); await allocation.release();
  await assert.rejects(lstat(allocation.directory), { code: 'ENOENT' });
});

test('explicit release preserves a still-live consumer and treats reused/unknown PID conservatively', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-live-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const allocation = await createPrivateTemporary('mcp', root); await allocation.bindConsumer(process.pid);
  const errors: unknown[][] = []; const log = console.error; console.error = (...args) => { errors.push(args); }; t.after(() => { console.error = log; });
  await assert.rejects(allocation.release(), /consumer still alive/); await lstat(allocation.directory); assert.equal(errors.length, 1);
  await assert.rejects(allocation.bindConsumer(0), /Invalid/);
  const namespace = join(root, `tower-owned-${process.getuid?.() ?? 0}`), recordPath = join(namespace, 'records', (await readdir(join(namespace, 'records')))[0]);
  const owner = JSON.parse(await readFile(recordPath, 'utf8')); owner.createdAt = old.getTime(); owner.ownerStartedAt = old.getTime();
  await writeFile(recordPath, JSON.stringify(owner));
  const collector = new TemporaryCollector({ roots: [root], protection: async () => ({ complete: true, issues: [], paths: [] }) });
  assert.equal((await collector.cycle()).releasedOwned, 0); await lstat(allocation.directory); await collector.close();
});

test('consumer registration publishes only after durable save and a failed write can retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'temp-bind-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const allocation = await createPrivateTemporary('mcp', root);
  const records = join(root, `tower-owned-${process.getuid?.() ?? 0}`, 'records'); const file = join(records, (await readdir(records))[0]);
  const original = await readFile(file, 'utf8'); await rm(file); await mkdir(file);
  await assert.rejects(allocation.bindConsumer(999999998));
  await rm(file, { recursive: true }); await writeFile(file, original, { mode: 0o600 });
  await allocation.bindConsumer(999999998);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).consumerPids, [999999998]); await allocation.release();
});
