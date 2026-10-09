import { collectTriggers } from '../../helpers/legacy-trigger-backup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretStore } from '../../../server/triggers/secrets.js';
import { BackupService } from '../../../server/backup/service.js';
import { TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { TriggerInput } from '../../../shared/triggers.js';
import { collectWorkerFiles } from '../../../server/backup/payload.js';
import { collectEncryptedVault, importPendingSecret, listPendingSecretImports } from '../../../server/backup/secrets.js';
import { decryptBackup, encryptBackup } from '../../../server/backup/crypto.js';
import { takeWorkerRestore, readReport } from '../../../server/backup/restore-files.js';
const VAULT_PASSWORD = 'fixture-vault-password';
const BACKUP_PASSWORD = 'fixture-backup-password';
const legacy = { id: 'legacy-identifier', name: 'HTTP token', origin: 'https://example.com', value: 'LEGACY_CANARY_VALUE', createdAt: '2026-10-02T00:00:00.000Z' };
async function vault(stateDir: string) { const service = new SecretService({ stateDir }); await service.start(); await service.initialize(VAULT_PASSWORD); return service; }
async function backup(stateDir: string) {
  const store = { backupValue: () => ({}), restore: async () => undefined };
  const service = new BackupService({ stateDir, triggers: () => collectTriggers(stateDir), version: '1.100.2', skills: async () => ({ bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'fixture', skills: [] }, guidance: '', settings: { enabled: false, provider: 'codex' } }), restartWorker: async () => true, stores: { groups: store, exclusions: store, decisions: store } });
  await service.start(); return service;
}
test('legacy migration keeps identity and grants, verifies encrypted commit, removes plaintext and fails locked', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-legacy-migrate-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(stateDir, 'trigger-secrets.json'), JSON.stringify([legacy]));
  const engine = JSON.stringify({ secretGrants: { [legacy.id]: ['trigger-identifier'] } }); await writeFile(join(stateDir, 'trigger-engine.json'), engine);
  const service = new SecretService({ stateDir }); await service.start(); const store = new SecretStore(stateDir, { vault: service }); await store.load(); assert.equal(store.get(legacy.id)?.value, legacy.value);
  await service.initialize(VAULT_PASSWORD); await store.migrate(); assert.deepEqual(store.get(legacy.id), legacy); assert.equal(await readFile(join(stateDir, 'trigger-engine.json'), 'utf8'), engine);
  await assert.rejects(readFile(join(stateDir, 'trigger-secrets.json')), { code: 'ENOENT' }); assert.equal((await readFile(join(stateDir, 'secrets/vault.json'), 'utf8')).includes(legacy.value), false);
  await store.create({ name: 'new', origin: 'https://example.com', value: 'NEW_ENCRYPTED_ONLY_CANARY' }, Date.now()); await assert.rejects(readFile(join(stateDir, 'trigger-secrets.json')), { code: 'ENOENT' });
  await service.lock(); assert.throws(() => store.get(legacy.id), /locked/); assert.throws(() => store.list(), /locked/); await assert.rejects(store.create({ name: 'blocked', origin: 'https://example.com', value: 'blocked' }, Date.now()), /locked/);
  await service.unlock(VAULT_PASSWORD); await store.remove(legacy.id); assert.equal(store.get(legacy.id), undefined);
});
test('migration refuses a symlink and preserves the original records', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-legacy-symlink-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const target = join(stateDir, 'original'); await writeFile(target, JSON.stringify([legacy])); await symlink(target, join(stateDir, 'trigger-secrets.json'));
  const service = await vault(stateDir); const store = new SecretStore(stateDir, { vault: service }); await store.load(); await assert.rejects(store.migrate()); assert.equal(await readFile(target, 'utf8'), JSON.stringify([legacy])); assert.equal(service.legacyGet(legacy.id), undefined);
});
test('backup carries only encrypted permanent vault and restore waits for explicit source password', async t => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tower-backup-vault-source-')); const targetDir = await mkdtemp(join(tmpdir(), 'tower-backup-vault-target-')); t.after(() => Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })]));
  const source = await vault(sourceDir); await source.importLegacy([legacy]);
  const target = await source.ensureTask('fixture-session', '/fixture'); await source.create({ name: 'ephemeral', kind: 'scalar', scope: 'task', value: 'EPHEMERAL_CANARY', target });
  await writeFile(join(sourceDir, 'trigger-secrets.json'), JSON.stringify([{ ...legacy, value: 'STALE_PLAINTEXT_CANARY' }])); assert.equal((await collectWorkerFiles(sourceDir))['trigger-secrets.json'], undefined);
  const sourceBackup = await backup(sourceDir); const file = await sourceBackup.export(BACKUP_PASSWORD); const { payload } = await decryptBackup(file.text, BACKUP_PASSWORD); const worker = (payload as { worker: { files: Record<string, unknown>; encryptedVault?: string } }).worker;
  assert.equal(worker.files['trigger-secrets.json'], undefined); assert.equal(worker.encryptedVault, await collectEncryptedVault(sourceDir)); assert.equal(JSON.stringify(payload).includes('journal.json'), false);
  const recipient = await vault(targetDir); const identity = recipient.device(); const recipientBackup = await backup(targetDir); const preview = await recipientBackup.check(file.text, BACKUP_PASSWORD); assert.ok(preview.parts.includes('secretVault'));
  const report = await recipientBackup.apply(preview.id); assert.equal(report.pendingSecretImports?.length, 1); const pendingId = report.pendingSecretImports![0];
  const taken = await takeWorkerRestore(targetDir); assert.ok(taken); await taken.finish({ parts: ['skills'], errors: [] }); assert.equal((await readReport(targetDir))?.status, 'waiting-secrets');
  await assert.rejects(importPendingSecret(targetDir, pendingId, 'wrong-password', recipient)); assert.deepEqual(await listPendingSecretImports(targetDir), [pendingId]); assert.deepEqual(recipient.device(), identity); assert.equal(recipient.legacyGet(legacy.id), undefined);
  await importPendingSecret(targetDir, pendingId, VAULT_PASSWORD, recipient); assert.deepEqual(recipient.device(), identity); assert.deepEqual(recipient.legacyGet(legacy.id), legacy); assert.deepEqual(await listPendingSecretImports(targetDir), []); assert.equal((await readReport(targetDir))?.status, 'applied'); await assert.rejects(readFile(join(targetDir, 'trigger-secrets.json')), { code: 'ENOENT' });
});
test('legacy-only restore before Vault initialization preserves the existing worker restoration path', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-backup-legacy-compatible-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const service = await backup(stateDir);
  const file = await encryptBackup({ version: 1, worker: { files: { 'trigger-secrets.json': [legacy] } }, web: {} }, BACKUP_PASSWORD, { towerVersion: '1.100.2', from: 'fixture' });
  const report = await service.apply((await service.check(file, BACKUP_PASSWORD)).id);
  assert.equal(report.status, 'waiting-worker'); assert.equal(report.pendingSecretImports, undefined);
  assert.deepEqual(await listPendingSecretImports(stateDir), []);
  const taken = await takeWorkerRestore(stateDir); assert.ok(taken);
  const store = new SecretStore(stateDir); await store.load(); assert.deepEqual(store.get(legacy.id), legacy);
  await taken.finish({ parts: ['triggers'], errors: [] });
  assert.equal((await readReport(stateDir))?.status, 'applied'); assert.equal(await collectEncryptedVault(stateDir), undefined);
});

test('old plaintext backup restores as an encrypted pending import without plaintext state files', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-backup-legacy-pending-')); t.after(() => rm(stateDir, { recursive: true, force: true })); const target = await vault(stateDir); const service = await backup(stateDir);
  const file = await encryptBackup({ version: 1, worker: { files: { 'trigger-secrets.json': [legacy] } }, web: {} }, BACKUP_PASSWORD, { towerVersion: '1.100.2', from: 'fixture' });
  const preview = await service.check(file, BACKUP_PASSWORD); const report = await service.apply(preview.id); assert.equal(report.status, 'waiting-secrets'); assert.deepEqual(report.worker, []); const id = report.pendingSecretImports![0];
  const pending = await readFile(join(stateDir, 'secrets', `pending-import-${id}.json`), 'utf8'); assert.equal(pending.includes(legacy.value), false); await assert.rejects(readFile(join(stateDir, 'trigger-secrets.json')), { code: 'ENOENT' }); await assert.rejects(readFile(join(stateDir, 'restore/pending-worker.json')), { code: 'ENOENT' });
  await target.lock(); await assert.rejects(importPendingSecret(stateDir, id, BACKUP_PASSWORD, target), /Unlock/); await target.unlock(VAULT_PASSWORD); await importPendingSecret(stateDir, id, BACKUP_PASSWORD, target); assert.deepEqual(target.legacyGet(legacy.id), legacy); assert.equal((await readReport(stateDir))?.status, 'applied');
});
test('encrypted trigger snapshot waits with its source grants and changes current definitions only after secret import', async t => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tower-backup-trigger-source-')), targetDir = await mkdtemp(join(tmpdir(), 'tower-backup-trigger-target-'));
  const engines: TriggerService[] = []; t.after(async () => { for (const engine of engines) engine.close(); await Promise.all(engines.map(engine => engine.settle())); await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })]); });
  const executor: TriggerExecutor = { submitAutoPrompt: async () => { throw new Error('No native provider in restore fixture'); }, getAutoPrompt: () => undefined, create: async () => { throw new Error('No native provider in restore fixture'); }, enqueue: async () => { throw new Error('No native provider in restore fixture'); }, runs: () => [], session: () => undefined };
  const triggerSecret = { ...legacy, id: '33333333-3333-4333-8333-333333333333' };
  const source = await vault(sourceDir); await source.importLegacy([triggerSecret]); const original = new TriggerService({ stateDir: sourceDir, executor, secretStore: new SecretStore(sourceDir, { vault: source }), tickMs: 60000 }); engines.push(original); await original.start();
  const input: TriggerInput = { name: 'Restored HTTP', enabled: false, source: { kind: 'http', schedule: { type: 'interval', everySeconds: 300 }, request: { method: 'GET', url: 'https://example.com/', headers: [{ name: 'authorization', secretId: triggerSecret.id }], timeoutSeconds: 5 }, condition: { type: 'every-success' } }, handler: { kind: 'task', instructions: 'Fixture only', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: sourceDir } }, policy: { overlap: 'skip', maxEventsPerHour: 20 } };
  const originalTrigger = await original.create(input, { kind: 'owner', via: 'ui' }); const file = await (await backup(sourceDir)).export(BACKUP_PASSWORD);
  const recipient = await vault(targetDir); const current = new TriggerService({ stateDir: targetDir, executor, secretStore: new SecretStore(targetDir, { vault: recipient }), tickMs: 60000 }); engines.push(current); await current.start();
  await current.create({ ...input, name: 'Current local trigger', source: { kind: 'schedule', schedule: { type: 'interval', everySeconds: 300 }, catchUp: 'latest' } }, { kind: 'owner', via: 'ui' });
  const restore = await backup(targetDir); const checked = await restore.check(file.text, BACKUP_PASSWORD); const report = await restore.apply(checked.id); assert.equal(report.pendingSecretImports?.length, 2);
  const kinds = await Promise.all(report.pendingSecretImports!.map(async id => ({ id, kind: (JSON.parse(await readFile(join(targetDir, 'secrets', `pending-import-${id}.json`), 'utf8')) as { kind: string }).kind })));
  const vaultId = kinds.find(item => item.kind === 'vault')!.id, triggerId = kinds.find(item => item.kind === 'legacy')!.id;
  await recipient.lock(); const taken = await takeWorkerRestore(targetDir); assert.ok(taken); assert.equal(taken.restore.triggers, undefined); assert.deepEqual(current.list().map(trigger => trigger.name), ['Current local trigger']); await taken.finish({ parts: ['skills'], errors: [] }); assert.equal((await readReport(targetDir))?.status, 'waiting-secrets');
  const options = { restoreTriggers: (snapshot: Parameters<TriggerService['restoreBackup']>[0]) => current.restoreBackup(snapshot) };
  await recipient.unlock(VAULT_PASSWORD); await assert.rejects(importPendingSecret(targetDir, triggerId, BACKUP_PASSWORD, recipient, options), /original secret Vault/); assert.deepEqual(current.list().map(trigger => trigger.name), ['Current local trigger']); assert.ok((await listPendingSecretImports(targetDir)).includes(triggerId));
  await importPendingSecret(targetDir, vaultId, VAULT_PASSWORD, recipient, options); assert.equal((await readReport(targetDir))?.status, 'waiting-secrets'); await importPendingSecret(targetDir, triggerId, BACKUP_PASSWORD, recipient, options);
  assert.deepEqual(current.list().map(trigger => trigger.id), [originalTrigger.id]); assert.deepEqual((await collectTriggers(targetDir))?.secretGrants[triggerSecret.id], [originalTrigger.id]); assert.equal((await readReport(targetDir))?.status, 'applied'); assert.equal((await readFile(join(targetDir, 'secrets/vault.json'), 'utf8')).includes(triggerSecret.value), false); await assert.rejects(readFile(join(targetDir, 'trigger-secrets.json')), { code: 'ENOENT' });
});
