import { workerSettingsFixture, closeWorkerSettingsFixture } from '../remote/external-storage-fixture.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { machinePassword, readMachineKey } from '../../../server/secrets/machine-key.js';
import { keyedPendingImports, stageVaultImport } from '../../../server/secrets/imports.js';
import { BackupService } from '../../../server/backup/service.js';
import { collectEncryptedVault, importPendingSecret, listPendingSecretImports } from '../../../server/backup/secrets.js';
import { decryptBackup, encryptBackup } from '../../../server/backup/crypto.js';
import type { SecretSettingsView } from '../../../shared/secrets.js';
import { FixtureRuns, secretService } from '../../helpers/secrets.js';

const BACKUP_PASSWORD = 'fixture-backup-password';
const TARGET_PASSWORD = 'fixture-target-vault-password';
const CANARY = 'MACHINE_VAULT_BACKUP_CANARY';
const HOST = 'c'.repeat(32);

async function state(t: TestContext, name: string) {
  const directory = await mkdtemp(join(tmpdir(), `tower-machine-backup-${name}-`));
  t.after(async () => { await closeWorkerSettingsFixture(directory); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function backup(stateDir: string) {
  const store = { backupValue: () => ({}), restore: async () => undefined };
  const service = new BackupService({ stateDir, settings: (await workerSettingsFixture(stateDir)).collect, triggers: async () => undefined, version: '1.137.0',
    skills: async () => ({ bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'fixture', skills: [] }, guidance: '', settings: { enabled: false, provider: 'codex' } }),
    restartWorker: async () => true, stores: { groups: store, exclusions: store, decisions: store } });
  await service.start(); (await workerSettingsFixture(stateDir)).beforeClose.push(async () => { service.close(); await service.flush(); });
  return service;
}
/** A computer that followed a host: its vault made by itself with its machine key, holding one saved secret. */
async function followingComputer(stateDir: string) {
  const service = new SecretService({ stateDir }); await service.start();
  const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns(), followed: async () => HOST });
  assert.equal(await runtime.machineVault(), 'open');
  await service.create({ name: 'NODE_TOKEN', kind: 'scalar', value: CANARY });
  return { service, runtime, key: machinePassword((await readMachineKey(stateDir))!) };
}

test('a vault made with a machine key restores from a backup on another computer without any password', async t => {
  const sourceDir = await state(t, 'source'), targetDir = await state(t, 'target');
  const printed: string[] = []; const original = { warn: console.warn, error: console.error, log: console.log };
  for (const name of ['warn', 'error', 'log'] as const) console[name] = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  t.after(() => Object.assign(console, original));
  const source = await followingComputer(sourceDir); source.runtime.close();
  const file = await (await backup(sourceDir)).export(BACKUP_PASSWORD);
  assert.equal(file.text.includes(source.key), false, 'only inside the encrypted backup');
  const { payload } = await decryptBackup(file.text, BACKUP_PASSWORD);
  assert.equal((payload as { worker: { machineKey?: string } }).worker.machineKey, source.key);

  // Another computer, with its own vault and nothing of the source's.
  const recipient = await secretService(targetDir, { password: TARGET_PASSWORD });
  const runtime = new SecretRuntime({ stateDir: targetDir, service: recipient, runs: new FixtureRuns(), pendingImports: () => listPendingSecretImports(targetDir),
    importPending: (id, password) => importPendingSecret(targetDir, id, password, recipient) });
  t.after(() => runtime.close());
  const restore = await backup(targetDir);
  const report = await restore.apply((await restore.check(file.text, BACKUP_PASSWORD)).id);
  const [pending] = report.pendingSecretImports!;
  assert.deepEqual(await keyedPendingImports(targetDir), [pending]);
  const view = await runtime.control('settings', {}) as SecretSettingsView;
  assert.deepEqual(view.status.pendingImportsKeyed, [pending], 'the page offers it without a password');
  assert.equal(JSON.stringify(view).includes(source.key), false);
  await runtime.control('import', { id: pending });
  assert.deepEqual(recipient.settings().secrets.map(item => item.name), ['NODE_TOKEN']);
  assert.deepEqual(await listPendingSecretImports(targetDir), []);
  assert.equal(printed.join('\n').includes(source.key), false, 'never printed');
});

test('a backup without the machine key, or with one its vault does not open with, asks for the source password as before', async t => {
  const sourceDir = await state(t, 'old-source'), targetDir = await state(t, 'old-target');
  const source = await followingComputer(sourceDir); source.runtime.close();
  const encryptedVault = (await collectEncryptedVault(sourceDir))!;
  const target = await secretService(targetDir, { password: TARGET_PASSWORD });
  // An older backup: no machine key; the vault's password (the key's text) is asked for.
  const older = await stageVaultImport(targetDir, encryptedVault, 'older');
  await assert.rejects(importPendingSecret(targetDir, older, '', target), /source Vault password is required/);
  await importPendingSecret(targetDir, older, source.key, target);
  assert.deepEqual(target.settings().secrets.map(item => item.name), ['NODE_TOKEN']);
  // A key this vault was not wrapped with is dropped when staged.
  const wrong = await stageVaultImport(targetDir, encryptedVault, 'wrong', Buffer.alloc(32, 9).toString('base64url'));
  assert.deepEqual(await keyedPendingImports(targetDir), []);
  const error = await importPendingSecret(targetDir, wrong, '', target).then(() => undefined, (failure: Error) => failure);
  assert.ok(error); assert.equal(error.message.includes(source.key), false);
  // A malformed key in a backup is refused when the backup is read.
  const restore = await backup(targetDir);
  const bad = await encryptBackup({ version: 1, worker: { files: {}, encryptedVault, machineKey: 'not a key' }, web: {} }, BACKUP_PASSWORD, { towerVersion: '1.137.0', from: 'fixture' });
  await assert.rejects(restore.check(bad, BACKUP_PASSWORD), /머신 키/);
  const stray = await encryptBackup({ version: 1, worker: { files: {}, machineKey: source.key }, web: {} }, BACKUP_PASSWORD, { towerVersion: '1.137.0', from: 'fixture' });
  await assert.rejects(restore.check(stray, BACKUP_PASSWORD), /머신 키/, 'never without the vault it opens');
  assert.equal((await readFile(join(targetDir, 'secrets', 'vault.json'), 'utf8')).includes(source.key), false);
});

test('the owner opens a vault its machine key opens without a password, also after an owner lock or once it no longer follows', async t => {
  const stateDir = await state(t, 'unlock');
  const made = await followingComputer(stateDir); made.runtime.close();
  const follow: { host?: string } = { host: HOST };
  const service = new SecretService({ stateDir }); await service.start();
  const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns(), followed: async () => follow.host });
  t.after(() => runtime.close());
  assert.equal(await runtime.machineVault(), 'open');
  assert.equal((await runtime.control('settings', {}) as SecretSettingsView).status.machineKey, undefined, 'only said while locked');
  await runtime.control('lock', {});
  assert.equal((await runtime.control('settings', {}) as SecretSettingsView).status.machineKey, true, 'the page offers a plain open');
  assert.equal((await runtime.control('session', { sessionId: 'unknown' }) as { status: { machineKey?: true } }).status.machineKey, true, 'in a chat too');
  assert.equal(await runtime.machineVault(), 'needs-open', 'an owner lock is kept by the automatic open');
  await runtime.control('unlock', { password: 'whatever the owner typed' });
  assert.equal(service.status().locked, false, 'the owner’s unlock opens it with the machine key');
  await runtime.control('lock', {}); follow.host = undefined;
  assert.equal(await runtime.machineVault(), 'off');
  await runtime.control('unlock', {});
  assert.equal(service.status().locked, false, 'following or not');
  follow.host = HOST; assert.equal(await runtime.machineVault(), 'open', 'and the owner lock ended with it');
});

test('a password vault without a machine wrapper is not offered a plain open', async t => {
  const stateDir = await state(t, 'password');
  const service = await secretService(stateDir, { password: TARGET_PASSWORD });
  const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns() }); t.after(() => runtime.close());
  await runtime.control('lock', {});
  assert.equal((await runtime.control('settings', {}) as SecretSettingsView).status.machineKey, undefined);
  await assert.rejects(runtime.control('unlock', {}), { kind: 'invalid' }, 'its password is still needed');
});
