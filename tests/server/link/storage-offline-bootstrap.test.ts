import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageManifest } from '../../../server/storage/schema.js';
import { offlineBootstrapHeld, offlineActivationPath, type OfflineActivationRecord } from '../../../server/link/storage-offline.js';

test('schema evidence is not global completion; restart remains held before provider/permission release', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'offline-bootstrap-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = storageManifest([]);
  const build = { appVersion: manifest.appVersion, protocol: manifest.protocol, sourceHash: 'a'.repeat(64), manifestDigest: manifest.digest };
  const file = { path: join(dir, 'protected'), sha256: 'b'.repeat(64) };
  const record: OfflineActivationRecord = { format: 'tower-offline-activation', version: 1, activationId: 'fixture', stateDir: dir,
    storageId: 'fixture-storage', build, manifest, oldArtifact: { identity: build, entry: file, contract: file },
    backup: { root: dir, manifest: file, snapshotId: 'fixture-snapshot' }, targets: ['core'],
    domains: [], corePrepared: { commandId:'fixed',payloadSha256:'c'.repeat(64) }, phase: 'schema-prepared' };
  await writeFile(offlineActivationPath(dir), JSON.stringify(record), { mode: 0o600 });
  assert.equal(await offlineBootstrapHeld(dir, build, record.storageId), true);
  let effects = 0;
  if (!await offlineBootstrapHeld(dir, build, record.storageId)) effects++;
  assert.equal(effects, 0);
  // A different final build cannot consume a completion of this installation.
  await writeFile(offlineActivationPath(dir), JSON.stringify({ ...record, phase: 'complete' }));
  assert.equal(await offlineBootstrapHeld(dir, { ...build, sourceHash: 'e'.repeat(64) }, record.storageId), true);
  assert.equal(await offlineBootstrapHeld(dir, build, 'other-storage'), true);
  assert.equal(await offlineBootstrapHeld(dir, build, record.storageId), true, 'a completed file alone cannot prove live SQL receipts');
});
