import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { APP_VERSION } from '../../../shared/app-identity.js';
import { captureStorageBundle, type CapturedStorageBundle } from '../../../server/storage/bundle.js';
import { openStorage, type StorageClientOptions } from '../../../server/storage/client.js';
import { STORAGE_PROTOCOL, type StorageStatus } from '../../../server/storage/contract.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { alteredBundle, filesUnder, fixtureBundle, fixtureManifest, openFixture, stateDir } from './helpers.js';

/** Opens, expects the refusal, and closes. Answers the status. */
async function refused(t: { after(fn: () => unknown): void }, options: StorageClientOptions, expected: { phase: string; code: string; retryable?: boolean }): Promise<StorageStatus> {
  const statuses: StorageStatus[] = [];
  const client = await openStorage({ ...options, onUnavailable: status => statuses.push(status) });
  t.after(() => client.close());
  const status = client.status();
  assert.equal(status.state, 'unavailable', JSON.stringify(status));
  assert.equal(status.failure?.phase, expected.phase, status.failure?.message);
  assert.equal(status.failure?.code, expected.code, status.failure?.message);
  if (expected.retryable !== undefined) assert.equal(status.failure?.retryable, expected.retryable);
  assert.equal(status.failure?.sourcePreserved, true);
  assert.equal(statuses.length, 1, 'the worker is told, so it can hold intake');
  await client.close();
  return status;
}

/** A prepared fixture storage with a row, closed: the "existing state" the refusals must not touch. */
async function existingStorage(t: Parameters<typeof openFixture>[0]): Promise<string> {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'put', { key: 'kept', value: 'original' }, 'kept-1');
  await client.close();
  return dir;
}

test('a thread from another build, protocol or schema contract is refused before any file is touched', async t => {
  const production = await captureStorageBundle() as CapturedStorageBundle;
  const fixture = await fixtureBundle();
  const cases: [string, Parameters<typeof alteredBundle>[1] | undefined, CapturedStorageBundle, string][] = [
    ['app version', source => source.replaceAll(JSON.stringify(APP_VERSION), JSON.stringify('0.0.0-other')), production, 'app-version-mismatch'],
    ['protocol', source => source.replaceAll(JSON.stringify(STORAGE_PROTOCOL), JSON.stringify('tower-storage/999')), production, 'protocol-mismatch'],
    ['schema contract', source => source.replace('CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;', 'CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, extra TEXT) STRICT;'), production, 'schema-contract-mismatch'],
    // A production worker handed the fixture thread: same version and protocol, other domains.
    ['domains', undefined, fixture, 'schema-contract-mismatch'],
  ];
  for (const [name, change, base, code] of cases) {
    const dir = await existingStorage(t);
    const before = await filesUnder(dir);
    const bundle = change ? alteredBundle(base, change) : base;
    // The worker expects this build's own (production) manifest in every case.
    await refused(t, { stateDir: dir, bundle }, { phase: 'handshake', code, retryable: false });
    assert.deepEqual(await filesUnder(dir), before, `${name}: no byte or timestamp changed`);
  }
  // Nothing at all is created in a fresh state directory either.
  const fresh = await stateDir(t);
  await refused(t, { stateDir: fresh, bundle: fixture }, { phase: 'handshake', code: 'schema-contract-mismatch' });
  assert.deepEqual(await filesUnder(fresh), {});
});

test('a bundle that does not match its hash, a missing artifact, or a thread without node:sqlite is refused without touching files', async t => {
  const fixture = await fixtureBundle();
  const dir = await stateDir(t);
  const { storageBundleFromArtifact, readStorageBundleArtifact } = await import('../../../server/storage/bundle.js');
  const tampered = storageBundleFromArtifact(JSON.stringify({ format: 'tower-storage-thread-bundle/1', source: `${fixture.source}\n`, sourceHash: fixture.sourceHash }), 'artifact');
  assert.equal(tampered.ok, false);
  await refused(t, { stateDir: dir, bundle: tampered, manifest: fixtureManifest }, { phase: 'bundle', code: 'bundle-hash-mismatch', retryable: false });
  await refused(t, { stateDir: dir, bundle: await readStorageBundleArtifact(join(dir, 'missing.json')), manifest: fixtureManifest }, { phase: 'bundle', code: 'bundle-missing' });
  assert.equal(storageBundleFromArtifact('{"format":"other"}', 'artifact').ok, false);
  // An eval thread whose runtime has no node:sqlite says so in its hello; the worker refuses the runtime.
  const withoutSqlite = alteredBundle(fixture, source => `process.getBuiltinModule = () => undefined;\n${source}`);
  const status = await refused(t, { stateDir: dir, bundle: withoutSqlite, manifest: fixtureManifest }, { phase: 'runtime', code: 'unsupported-runtime', retryable: false });
  assert.match(status.failure!.message, /node:sqlite/);
  assert.deepEqual(await filesUnder(dir), {});
});

test('an unknown schema, another program\'s database, a damaged file or a schema change it may not make: refused, bytes kept', async t => {
  const productionBundle = await captureStorageBundle();
  // A newer core migration this build does not know.
  const newer = await existingStorage(t);
  const database = join(newer, 'storage', 'tower.db');
  const raw = new DatabaseSync(database);
  raw.exec("INSERT INTO schema_migrations VALUES ('core', 2, 'future', '2030-01-01', '9.9.9', 'x', 9)");
  raw.close();
  let before = await filesUnder(newer);
  await refused(t, { stateDir: newer, bundle: await fixtureBundle(), manifest: fixtureManifest }, { phase: 'schema', code: 'unknown-schema', retryable: false });
  assert.deepEqual(await filesUnder(newer), before);
  // A domain this build does not know (the production build does not know "fixture").
  const domain = await existingStorage(t);
  before = await filesUnder(domain);
  await refused(t, { stateDir: domain, bundle: productionBundle }, { phase: 'schema', code: 'unknown-schema' });
  assert.deepEqual(await filesUnder(domain), before);
  // Another program's SQLite database stays in its own journal mode, untouched.
  const foreign = await stateDir(t);
  await mkdir(join(foreign, 'storage'), { mode: 0o700 });
  const other = new DatabaseSync(join(foreign, 'storage', 'tower.db'));
  other.exec('CREATE TABLE notes (body TEXT)');
  other.close();
  await chmod(join(foreign, 'storage', 'tower.db'), 0o600);
  before = await filesUnder(foreign);
  await refused(t, { stateDir: foreign, bundle: productionBundle }, { phase: 'schema', code: 'foreign-database' });
  assert.deepEqual(await filesUnder(foreign), before);
  assert.equal((await readFile(join(foreign, 'storage', 'tower.db')))[18], 1, 'still a rollback-journal database');
  // A damaged file.
  const damaged = await stateDir(t);
  await mkdir(join(damaged, 'storage'), { mode: 0o700 });
  await writeFile(join(damaged, 'storage', 'tower.db'), Buffer.alloc(8192, 7), { mode: 0o600 });
  before = await filesUnder(damaged);
  await refused(t, { stateDir: damaged, bundle: productionBundle }, { phase: 'open', code: 'not-a-database', retryable: false });
  assert.deepEqual(await filesUnder(damaged), before);
  // A production storage opened by a build with one more domain is behind: it waits for an allowed migration.
  const behind = await stateDir(t);
  const plain = await openStorage({ stateDir: behind, bundle: productionBundle });
  await plain.prepare({ allowMigration: true });
  await plain.close();
  const upgraded = await openFixture(t, behind);
  assert.equal(upgraded.status().schema?.kind, 'behind');
  await assert.rejects(upgraded.prepare({ allowMigration: false }), { code: 'migration-required', disposition: 'not-committed' });
  const applied = await upgraded.prepare({ allowMigration: true });
  assert.deepEqual(applied.applied, [{ scope: 'fixture', version: 1 }, { scope: 'plain', version: 1 }]);
  assert.equal(applied.schema.kind, 'current');
});

test('symlinks, foreign modes, hard links and stray journals are refused as found', async t => {
  const bundle = await fixtureBundle();
  const options = (dir: string) => ({ stateDir: dir, bundle, manifest: fixtureManifest });
  const cases: [string, (dir: string) => Promise<void>, string][] = [
    ['database symlink', async dir => { const db = join(dir, 'storage', 'tower.db'); await rename(db, join(dir, 'real.db')); await symlink(join(dir, 'real.db'), db); }, 'symlink'],
    ['wal symlink', async dir => { await writeFile(join(dir, 'elsewhere'), ''); await symlink(join(dir, 'elsewhere'), join(dir, 'storage', 'tower.db-wal')); }, 'symlink'],
    ['database 0644', async dir => chmod(join(dir, 'storage', 'tower.db'), 0o644), 'wrong-permissions'],
    ['database read-only 0400', async dir => chmod(join(dir, 'storage', 'tower.db'), 0o400), 'wrong-permissions'],
    ['storage folder 0755', async dir => chmod(join(dir, 'storage'), 0o755), 'wrong-permissions'],
    ['storage folder symlink', async dir => { await rename(join(dir, 'storage'), join(dir, 'moved')); await symlink(join(dir, 'moved'), join(dir, 'storage')); }, 'symlink'],
    ['hard link', async dir => link(join(dir, 'storage', 'tower.db'), join(dir, 'second-name.db')), 'hard-linked'],
    ['stray rollback journal', async dir => writeFile(join(dir, 'storage', 'tower.db-journal'), 'hot', { mode: 0o600 }), 'unexpected-journal'],
    ['state directory group-writable', async dir => chmod(dir, 0o770), 'state-dir-invalid'],
  ];
  for (const [name, damage, code] of cases) {
    const dir = await existingStorage(t);
    await damage(dir);
    const before = await filesUnder(dir);
    await refused(t, options(dir), { phase: 'paths', code, retryable: false });
    assert.deepEqual(await filesUnder(dir), before, `${name}: preserved as found`);
    await chmod(dir, 0o700);
  }
});

test('a missing or replaced database is not replaced by a new empty one', async t => {
  const bundle = await fixtureBundle();
  // Gone, with its identity recorded beside it.
  const gone = await existingStorage(t);
  await rename(join(gone, 'storage', 'tower.db'), join(gone, 'aside.db'));
  let before = await filesUnder(gone);
  await refused(t, { stateDir: gone, bundle, manifest: fixtureManifest }, { phase: 'paths', code: 'database-missing' });
  assert.deepEqual(await filesUnder(gone), before, 'no new tower.db');
  // An empty file in its place.
  await writeFile(join(gone, 'storage', 'tower.db'), '', { mode: 0o600 });
  before = await filesUnder(gone);
  await refused(t, { stateDir: gone, bundle, manifest: fixtureManifest }, { phase: 'schema', code: 'database-missing' });
  assert.deepEqual(await filesUnder(gone), before);
  // Another storage's database in its place.
  const mine = await existingStorage(t);
  const theirs = await existingStorage(t);
  await rename(join(theirs, 'storage', 'tower.db'), join(mine, 'storage', 'tower.db'));
  before = await filesUnder(mine);
  await refused(t, { stateDir: mine, bundle, manifest: fixtureManifest }, { phase: 'schema', code: 'storage-replaced' });
  assert.deepEqual(await filesUnder(mine), before);
  // Sidecars without their database.
  const orphan = await stateDir(t);
  await mkdir(join(orphan, 'storage'), { mode: 0o700 });
  await writeFile(join(orphan, 'storage', 'tower.db-wal'), 'frames', { mode: 0o600 });
  before = await filesUnder(orphan);
  await refused(t, { stateDir: orphan, bundle, manifest: fixtureManifest }, { phase: 'paths', code: 'database-missing' });
  assert.deepEqual(await filesUnder(orphan), before);
});

test('the default manifest is this build\'s: core only', () => {
  assert.deepEqual(storageManifest().domains, []);
});
