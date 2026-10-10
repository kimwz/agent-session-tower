import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStrictStateLock, validateStrictStateLease } from '../../../server/instance/state-lock.js';
import { checkStorageActivation, decodeOfflineActivation, offlineBootstrapHeld, validateOwnerContext } from '../../../server/link/storage-offline.js';
import { evaluateStorageUpdate, type StorageUpdateInput } from '../../../server/link/storage-update.js';

// Isolated filesystem only. No native provider, process termination or operating Tower.
test('strict conflict leaves even an empty/stale owner untouched and never probes its PID', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-lease-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lease = await acquireStrictStateLock(dir);
  await validateStrictStateLease(lease, dir);
  const lock = join(dir, '.instance-lock');
  const names = await readdir(lock);
  const bytes = await readFile(join(lock, names[0]));
  t.mock.method(process, 'kill', () => { throw new Error('PID probe forbidden'); });
  await assert.rejects(acquireStrictStateLock(dir), /conflict/);
  assert.deepEqual(await readdir(lock), names);
  assert.deepEqual(await readFile(join(lock, names[0])), bytes);
  await lease.release();
  await assert.rejects(validateStrictStateLease(lease, dir));
  await mkdir(lock);
  await assert.rejects(acquireStrictStateLock(dir), /conflict/);
  assert.deepEqual(await readdir(lock), []);
});
test('serialized owner and caller completion booleans confer no authority', async () => {
  await assert.rejects(validateOwnerContext({ kind: 'offline-owner' }), /forged owner/);
  assert.throws(() => decodeOfflineActivation({ complete: true, owner: true }), /invalid record/);
});
test('normal activation delegates the same refusal unchanged', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-normal-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const update: StorageUpdateInput = { stateDir: dir, managed: false, now: 1000,
    build: { version: '1.125.1', preflight: { supported: false } } };
  assert.deepEqual(await checkStorageActivation({ kind: 'normal', update }), await evaluateStorageUpdate(update));
  assert.equal(await offlineBootstrapHeld(dir), false);
});
test('invalid durable activation cannot be treated as absent after restart', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-restart-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'storage-offline-activation.json'), '{"phase":"schema-prepared"}', { mode: 0o600 });
  await assert.rejects(offlineBootstrapHeld(dir), /invalid record/);
});

test('actual offline CLI refuses a live lease before reading activation or creating SQL and releases no other owner', async t => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'offline-cli-conflict-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=join(dir,'runner-runtime');
  const lease=await acquireStrictStateLock(runtime);
  t.after(()=>lease.release());
  const { runOfflineStorageCommand }=await import('../../../server/link/storage-offline-cli.js');
  t.mock.method(process,'kill',()=>{throw new Error('PID signal forbidden');});
  await assert.rejects(runOfflineStorageCommand(['store','--state-dir',dir,'--input',join(dir,'must-not-read')]),/conflict/);
  await validateStrictStateLease(lease,runtime);
  await assert.rejects(readFile(join(dir,'state.sqlite')),{code:'ENOENT'});
});
