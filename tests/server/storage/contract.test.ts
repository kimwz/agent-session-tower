import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STORAGE_LIMITS, storageLimits } from '../../../server/storage/contract.js';
import { evaluateRuntime, nodeVerified, sqlitePatched } from '../../../server/storage/runtime.js';
import { CORE_MIGRATIONS, STORAGE_DOMAIN_SCHEMAS, storageManifest } from '../../../server/storage/schema.js';
import { WORKER_FILES } from '../../../server/backup/payload.js';
import { retentionSchema } from '../../../server/sessions/retention/storage-schema.js';
import { retentionDomain } from '../../../server/sessions/retention/storage-commands.js';
import { fixtureSchema } from './fixtures/fixture-domain.js';

test('only SQLite with the WAL-reset fix passes: 3.51.3+, or the official 3.44.6 / 3.50.7 backport lines', () => {
  for (const version of ['3.51.3', '3.51.4', '3.52.0', '3.53.4', '4.0.0', '3.44.6', '3.44.9', '3.50.7', '3.50.8']) assert.equal(sqlitePatched(version), true, version);
  for (const version of ['3.51.2', '3.51.0', '3.50.6', '3.50.4', '3.44.5', '3.45.0', '3.49.9', '', 'x']) assert.equal(sqlitePatched(version), false, version);
});

test('only verified Node.js lines and patches pass; odd and newer majors are unverified', () => {
  for (const version of ['22.22.3', '22.23.0', '24.15.0', '24.16.1', '26.0.0', '26.7.0']) assert.equal(nodeVerified(version), true, version);
  for (const version of ['22.22.2', '22.13.0', '24.14.9', '23.11.0', '25.9.0', '27.0.0', '20.19.0']) assert.equal(nodeVerified(version), false, version);
  const runtime = { node: '26.7.0', sqlite: '3.53.4', platform: 'darwin', arch: 'arm64', execPath: '/node', apis: { DatabaseSync: true, StatementSync: true } };
  assert.deepEqual(evaluateRuntime(runtime), { supported: true });
  assert.equal(evaluateRuntime({ ...runtime, sqlite: '3.50.4' }).supported, false);
  assert.equal(evaluateRuntime({ ...runtime, node: '23.11.0' }).supported, false);
  assert.equal(evaluateRuntime({ ...runtime, apis: { DatabaseSync: true, StatementSync: false } }).supported, false);
  assert.equal(evaluateRuntime(runtime, 'No such built-in module: node:sqlite').supported, false);
});

test('limits are chosen within their ranges and refused outside them', () => {
  assert.deepEqual(storageLimits(), DEFAULT_STORAGE_LIMITS);
  assert.equal(storageLimits({ busyTimeoutMs: 0, maxQueue: 1 }).maxQueue, 1);
  assert.throws(() => storageLimits({ busyTimeoutMs: 1001 }), RangeError);
  assert.throws(() => storageLimits({ maxQueue: 0 }), RangeError);
  assert.throws(() => storageLimits({ commandDeadlineMs: 1.5 }), RangeError);
  assert.throws(() => storageLimits({ maxPayloadBytes: 64 * 1024 * 1024 }), RangeError);
});

test('the preparation manifest registers actual retention schema/handler without cutover; schema text changes alter it', () => {
  assert.deepEqual(STORAGE_DOMAIN_SCHEMAS, [retentionSchema]);
  assert.strictEqual(retentionDomain.schema, retentionSchema);
  const manifest = storageManifest();
  assert.equal(manifest.core.schemaVersion, CORE_MIGRATIONS.length);
  assert.equal(manifest.domains.length, 1);
  assert.equal(manifest.domains[0].scope, 'retention');
  assert.equal(manifest.domains[0].cutover, undefined);
  assert.deepEqual(manifest.domains[0].preparation, { requiredArtifactVersion: '1.120.1', readerContract: 1, writerContract: 1 });
  assert.equal(storageManifest().digest, manifest.digest, 'the same declarations give the same digest');
  assert.notEqual(storageManifest([], '0.0.1').digest, manifest.digest);
  const withFixture = storageManifest([fixtureSchema]);
  assert.notEqual(withFixture.digest, manifest.digest);
  assert.deepEqual(withFixture.domains[0].cutover, fixtureSchema.cutover);
  const edited = storageManifest([{ ...fixtureSchema, migrations: [{ version: 1, sql: `${fixtureSchema.migrations[0].sql} ` }] }]);
  assert.notEqual(edited.domains[0].schemaDigest, withFixture.domains[0].schemaDigest);
  assert.throws(() => storageManifest([fixtureSchema, fixtureSchema]), /repeated/);
  assert.throws(() => storageManifest([{ ...fixtureSchema, domain: 'core' }]), /repeated/);
  assert.throws(() => storageManifest([{ ...fixtureSchema, migrations: [{ version: 2, sql: 'SELECT 1' }] }]), /1\.\.n/);
});

test('the settings backup names its files, and none of them is storage', () => {
  for (const name of Object.keys(WORKER_FILES)) assert.doesNotMatch(name, /^(storage|state\.sqlite|\.storage-check)/);
});
