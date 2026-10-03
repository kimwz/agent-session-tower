import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deferredSecretParts, importPendingSecret, listPendingSecretImports, stagePendingImport } from '../../../server/secrets/imports.js';
import { SecretService } from '../../../server/secrets/service.js';
import type { TriggerBackup } from '../../../server/triggers/backup.js';

const triggers: TriggerBackup = { triggers: [], settings: {}, trustedFolders: [], secretGrants: {}, fired: {}, github: {} };

test('with a Vault on either side, trigger secrets and triggers wait for an encrypted import', () => {
  const secrets = [{ id: 'a' }];
  for (const [target, staged] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const waits = target || staged;
    assert.deepEqual(deferredSecretParts({ files: { 'trigger-secrets.json': secrets }, triggers }, target, staged), waits ? { legacy: { records: secrets, triggers } } : {}, `${target} ${staged}`);
    assert.deepEqual(deferredSecretParts({ files: { 'trigger-secrets.json': secrets } }, target, staged), waits ? { legacy: { records: secrets } } : {});
    assert.deepEqual(deferredSecretParts({ files: {}, triggers }, target, staged), waits ? { legacy: { records: [], triggers } } : {});
    assert.deepEqual(deferredSecretParts({ files: {} }, target, staged), {});
  }
});

test('a legacy import is opened by the injected opener and removed only after it committed', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-secret-imports-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const target = new SecretService({ stateDir }); await target.start(); await target.initialize('fixture vault password 1');
  const record = { id: 'legacy-1', name: 'Token', origin: 'https://example.com', value: 'IMPORTED', createdAt: '2026-10-01T00:00:00.000Z' };
  const id = await stagePendingImport(stateDir, { version: 1, kind: 'legacy', content: 'opaque' });
  const opened: Array<[string, string]> = [];
  await assert.rejects(importPendingSecret(stateDir, id, 'backup passphrase', target, { openLegacy: async (content, password) => { opened.push([content, password]); return { version: 1, records: [record], triggers }; } }),
    /trigger engine must be ready/);
  assert.deepEqual(await listPendingSecretImports(stateDir), [id], 'kept when it cannot commit');
  const restored: TriggerBackup[] = [];
  await importPendingSecret(stateDir, id, 'backup passphrase', target, { openLegacy: async () => ({ version: 1, records: [record], triggers }), restoreTriggers: async backup => { restored.push(backup); } });
  assert.deepEqual(opened, [['opaque', 'backup passphrase']]);
  assert.deepEqual(restored, [triggers]);
  assert.equal(target.legacyGet('legacy-1')?.value, 'IMPORTED');
  assert.deepEqual(await listPendingSecretImports(stateDir), []);
});

test('the secrets domain never reaches into backup', async () => {
  const folder = join(import.meta.dirname, '../../../server/secrets');
  for (const name of await readdir(folder)) assert.doesNotMatch(await readFile(join(folder, name), 'utf8'), /from '\.\.\/backup\//, name);
});
