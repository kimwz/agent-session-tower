import assert from 'node:assert/strict';
import { chmod, copyFile, link, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CapturedStorageBundle } from '../../../server/storage/bundle.js';
import type { StorageClientOptions } from '../../../server/storage/client.js';
import type { StorageStatus } from '../../../server/storage/contract.js';
import { storageManifest } from '../../../server/storage/schema.js';
import {
  artifactOf, bundleBody, crashWith, DATABASE, databasePath, filesUnder, fixtureManifest, fsPromises, openFixture, rehashedArtifact, replaceCall, stateDir, statedSource, storage,
  threadBundle, threadRequests, type FaultThread,
} from './helpers.js';

const { openStorage, storageBundleFromArtifact, readStorageBundleArtifact } = storage;

/** Opens, expects the refusal, and closes. Answers the status. `sourcePreserved` is what the refusal must report. */
async function refused(t: { after(fn: () => unknown): void }, options: StorageClientOptions, expected: { phase: string; code: string; retryable?: boolean; sourcePreserved?: boolean }): Promise<StorageStatus> {
  const statuses: StorageStatus[] = [];
  const client = await openStorage({ ...options, onUnavailable: status => statuses.push(status) });
  t.after(() => client.close());
  const status = client.status();
  assert.equal(status.state, 'unavailable', JSON.stringify(status));
  assert.equal(status.failure?.phase, expected.phase, status.failure?.message);
  assert.equal(status.failure?.code, expected.code, status.failure?.message);
  if (expected.retryable !== undefined) assert.equal(status.failure?.retryable, expected.retryable);
  assert.equal(status.failure?.sourcePreserved, expected.sourcePreserved ?? true, status.failure?.message);
  assert.equal(statuses.length, 1, 'the worker is told, so it can hold intake');
  assert.deepEqual(statuses[0].failure, status.failure, 'the worker is told the failure as it stands, preservation included');
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
const fault = (name: FaultThread) => ({ bundle: threadBundle(name) });

test('a trusted source whose thread says hello from another build, protocol, schema contract or source is refused before any file is touched', async t => {
  const cases: [FaultThread, string][] = [
    ['app-version', 'app-version-mismatch'],
    ['protocol', 'protocol-mismatch'],
    // The same stated digest beside one more domain: the digest is recomputed from the manifest's body.
    ['forged-manifest', 'schema-contract-mismatch'],
    // Same version, protocol and contract, but a thread that reports running other source than it was started with.
    ['source-hash', 'source-hash-mismatch'],
  ];
  for (const [name, code] of cases) {
    const dir = await existingStorage(t);
    const before = await filesUnder(dir);
    await refused(t, { stateDir: dir, ...fault(name) }, { phase: 'handshake', code, retryable: false });
    assert.deepEqual(await filesUnder(dir), before, `${name}: no byte or timestamp changed`);
  }
  // Nothing at all is created in a fresh state directory either.
  const fresh = await stateDir(t);
  await refused(t, { stateDir: fresh, ...fault('forged-manifest') }, { phase: 'handshake', code: 'schema-contract-mismatch' });
  assert.deepEqual(await filesUnder(fresh), {});
});

test('the contract comes from the source the build trusts, never from the caller: a manifest handed to open or preflight changes nothing', async t => {
  // The same stated digest as the fixture contract, with one more domain.
  const forged = { ...fixtureManifest, domains: [...fixtureManifest.domains, { ...fixtureManifest.domains[0], scope: 'later-domain' }] };
  const dir = await existingStorage(t);
  const client = await openStorage({ stateDir: dir, bundle: threadBundle('fixture'), manifest: forged } as StorageClientOptions);
  t.after(() => client.close());
  assert.equal(client.status().identity?.manifestDigest, fixtureManifest.digest);
  assert.deepEqual(client.context?.manifest, fixtureManifest, 'the fixture contract, not the one handed in');
  assert.equal(Object.isFrozen(client.context?.manifest.domains), true);
  const preflight = await storage.preflightStorage({ bundle: threadBundle('production'), manifest: forged } as Parameters<typeof storage.preflightStorage>[0]);
  assert.deepEqual([preflight.supported, preflight.identity?.manifestDigest], [true, storageManifest().digest]);
});

test('a capture built by hand, with a text that does not state its hash, is refused before a thread starts', async t => {
  const production = threadBundle('production');
  const dir = await stateDir(t);
  const body = `${bundleBody(production)}\n;void 0;\n`;
  // Claims the production hash for other text.
  const forged: CapturedStorageBundle = { ...production, source: `var __TOWER_STORAGE_SOURCE_HASH__ = ${JSON.stringify(production.sourceHash)};\n${body}` };
  await refused(t, { stateDir: dir, bundle: forged }, { phase: 'bundle', code: 'bundle-hash-mismatch', retryable: false });
  // Consistent text, but no first line stating the hash.
  const unstated: CapturedStorageBundle = { ...production, source: body, sourceHash: statedSource(body).sourceHash };
  await refused(t, { stateDir: dir, bundle: unstated }, { phase: 'bundle', code: 'bundle-hash-mismatch' });
  // Consistent with its own stated hash, but a source the build does not trust.
  const foreign: CapturedStorageBundle = { ...production, ...statedSource(body) };
  await refused(t, { stateDir: dir, bundle: foreign }, { phase: 'bundle', code: 'bundle-untrusted' });
  assert.deepEqual(await filesUnder(dir), {});
});

test('a bundle that does not match its hash, an untrusted or missing artifact, or a thread without node:sqlite is refused without touching files', async t => {
  const fixture = artifactOf('fixture');
  const dir = await stateDir(t);
  const tampered = storageBundleFromArtifact(JSON.stringify({ format: 'tower-storage-thread-bundle/2', source: `${fixture.source}\n`, sourceHash: fixture.sourceHash }), 'artifact');
  assert.equal(tampered.ok, false);
  await refused(t, { stateDir: dir, bundle: tampered }, { phase: 'bundle', code: 'bundle-hash-mismatch', retryable: false });
  // A valid, self-consistent artifact of changed thread code (here: another protocol) is not one this build trusts.
  const altered = storageBundleFromArtifact(rehashedArtifact(fixture, body => body.replaceAll('"tower-storage/1"', '"tower-storage/2"')), 'artifact');
  await refused(t, { stateDir: dir, bundle: altered }, { phase: 'bundle', code: 'bundle-untrusted', retryable: false });
  await refused(t, { stateDir: dir, bundle: await readStorageBundleArtifact(join(dir, 'missing.json')) }, { phase: 'bundle', code: 'bundle-missing' });
  assert.equal(storageBundleFromArtifact('{"format":"other"}', 'artifact').ok, false);
  assert.equal(storageBundleFromArtifact(JSON.stringify({ format: 'tower-storage-thread-bundle/1', source: fixture.source, sourceHash: fixture.sourceHash }), 'artifact').ok, false, 'an earlier bundle format');
  // An eval thread whose runtime has no node:sqlite says so in its hello; the worker refuses the runtime.
  const status = await refused(t, { stateDir: dir, ...fault('no-sqlite') }, { phase: 'runtime', code: 'unsupported-runtime', retryable: false });
  assert.match(status.failure!.message, /node:sqlite/);
  assert.deepEqual(await filesUnder(dir), {});
});

test('an unknown schema, another program\'s database, a damaged file or a schema change it may not make: refused, bytes kept', async t => {
  const productionBundle = threadBundle('production');
  // A newer core migration this build does not know.
  const newer = await existingStorage(t);
  const raw = new DatabaseSync(databasePath(newer));
  raw.exec("INSERT INTO schema_migrations VALUES ('core', 2, 'future', '2030-01-01', '9.9.9', 'x', 9)");
  raw.close();
  let before = await filesUnder(newer);
  await refused(t, { stateDir: newer, bundle: threadBundle('fixture') }, { phase: 'schema', code: 'unknown-schema', retryable: false });
  assert.deepEqual(await filesUnder(newer), before);
  // A domain this build does not know (the production build does not know "fixture").
  const domain = await existingStorage(t);
  before = await filesUnder(domain);
  await refused(t, { stateDir: domain, bundle: productionBundle }, { phase: 'schema', code: 'unknown-schema' });
  assert.deepEqual(await filesUnder(domain), before);
  // Another program's SQLite database stays in its own journal mode, untouched.
  const foreign = await stateDir(t);
  const other = new DatabaseSync(databasePath(foreign));
  other.exec('CREATE TABLE notes (body TEXT)');
  other.close();
  await chmod(databasePath(foreign), 0o600);
  before = await filesUnder(foreign);
  await refused(t, { stateDir: foreign, bundle: productionBundle }, { phase: 'schema', code: 'foreign-database' });
  assert.deepEqual(await filesUnder(foreign), before);
  assert.equal((await readFile(databasePath(foreign)))[18], 1, 'still a rollback-journal database');
  // A damaged file.
  const damaged = await stateDir(t);
  await writeFile(databasePath(damaged), Buffer.alloc(8192, 7), { mode: 0o600 });
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

test('an unknown schema left only in the WAL of a crashed last connection is refused with DB, WAL and shm byte-, inode- and mtime-identical', async t => {
  for (const [name, sql, code] of [
    ['newer core migration', "INSERT INTO schema_migrations VALUES ('core', 2, 'future', '2030-01-01', '9.9.9', 'x', 9)", 'unknown-schema'],
    ['unknown domain', "INSERT INTO schema_migrations VALUES ('later', 1, 'later', '2030-01-01', '9.9.9', 'x', 9)", 'unknown-schema'],
    ['other storage meta', "UPDATE storage_meta SET value = 'someone-else' WHERE key = 'format'", 'foreign-database'],
  ] as const) {
    const dir = await existingStorage(t);
    await crashWith(databasePath(dir), sql);
    // The main file alone (a copy elsewhere) still holds only what this build knows: the refusal can only come from the WAL.
    const probe = await stateDir(t);
    await copyFile(databasePath(dir), join(probe, 'main.db'));
    const mainOnly = new DatabaseSync(join(probe, 'main.db'));
    try {
      assert.equal((mainOnly.prepare("SELECT count(*) AS n FROM schema_migrations WHERE scope = 'later' OR version > 1").get() as { n: number }).n, 0, name);
      assert.equal((mainOnly.prepare("SELECT value FROM storage_meta WHERE key = 'format'").get() as { value: string }).value, 'agent-session-tower/storage', name);
    } finally { mainOnly.close(); }
    const before = await filesUnder(dir);
    assert.ok((before[`${DATABASE}-wal`] as { size: number }).size > 0 && before[`${DATABASE}-shm`], `${name}: the crash left a WAL and shm`);
    await refused(t, { stateDir: dir, bundle: threadBundle('fixture') }, { phase: 'schema', code, retryable: false });
    assert.deepEqual(await filesUnder(dir), before, `${name}: DB, WAL and shm unchanged, no copy left behind`);
  }
});

/** A storage closed cleanly (no sidecars) and one a crash left with a WAL and shm. */
const shapes = [['without sidecars', false], ['with a WAL and shm', true]] as const;
async function existingShaped(t: Parameters<typeof openFixture>[0], crashed: boolean): Promise<string> {
  const dir = await existingStorage(t);
  if (crashed) await crashWith(databasePath(dir), "INSERT INTO fixture_items (key, value) VALUES ('crash', 'x')");
  return dir;
}

test('every existing database is judged on a private copy before SQLite opens the live files, sidecars or not', async t => {
  for (const [shape, crashed] of shapes) {
    // The fault thread ends when asked to check a copy: only an open that sends the check is refused this way.
    const dir = await existingShaped(t, crashed);
    const before = await filesUnder(dir);
    await refused(t, { stateDir: dir, ...fault('exit-on-check') }, { phase: 'thread-exit', code: 'thread-exited', sourcePreserved: true });
    assert.deepEqual(await filesUnder(dir), before, `${shape}: the live files are as found, no copy left`);
    // A normal open of the same files reports what its check cost.
    const client = await openFixture(t, dir);
    assert.equal(client.status().state, 'ready', shape);
    const check = client.status().openCheck!;
    assert.equal(check.copiedBytes, (before[DATABASE] as { size: number }).size + ((before[`${DATABASE}-wal`] as { size: number } | undefined)?.size ?? 0), shape);
    assert.equal(check.staleCopies, 0);
    await client.close();
  }
  // A database this open makes itself is new and empty: nothing to check.
  const fresh = await openFixture(t, await stateDir(t));
  assert.equal(fresh.status().openCheck, undefined);
});

test('a refused open reports whether the live files were preserved by comparing them, whatever failed: thread exit, deadline or a change during the check', async t => {
  for (const [shape, crashed] of shapes) {
    // The thread ends during the check, the live files untouched: preserved, as compared.
    let dir = await existingShaped(t, crashed);
    let before = await filesUnder(dir);
    await refused(t, { stateDir: dir, ...fault('exit-on-check') }, { phase: 'thread-exit', code: 'thread-exited', sourcePreserved: true });
    assert.deepEqual(await filesUnder(dir), before, shape);
    // The thread ends when asked to open the live files, before SQLite opens them: preserved, as compared.
    dir = await existingShaped(t, crashed);
    before = await filesUnder(dir);
    await refused(t, { stateDir: dir, ...fault('exit-on-open') }, { phase: 'thread-exit', code: 'thread-exited', sourcePreserved: true });
    assert.deepEqual(await filesUnder(dir), before, shape);
    // The check misses its deadline: the thread is ended, the live files compared.
    dir = await existingShaped(t, crashed);
    before = await filesUnder(dir);
    await refused(t, { stateDir: dir, ...fault('stall-on-check'), limits: { handshakeDeadlineMs: 1000 } }, { phase: 'deadline', code: 'deadline-exceeded', sourcePreserved: true });
    assert.deepEqual(await filesUnder(dir), before, shape);
    // Another process writes to the live database while the copy is checked: source-changed, never reported preserved.
    dir = await existingShaped(t, crashed);
    let status = await refused(t, { stateDir: dir, ...fault('change-on-check') }, { phase: 'open', code: 'source-changed', retryable: true, sourcePreserved: false });
    assert.match(status.failure!.message, /changed while it was checked/);
    // The same, and then the thread ends: the comparison, not the default, decides.
    dir = await existingShaped(t, crashed);
    status = await refused(t, { stateDir: dir, ...fault('change-exit-on-check') }, { phase: 'thread-exit', code: 'thread-exited', sourcePreserved: false });
  }
});

test('the live database opened must hold the storage its copy was checked as: one rewritten in place between the check and the open is refused, not preserved', async t => {
  // No identity beside it, so only the comparison with the checked copy can tell.
  const dir = await existingStorage(t);
  await rename(join(dir, 'storage-recovery', 'identity.json'), join(dir, 'identity-aside.json'));
  const other = await existingStorage(t);
  await copyFile(databasePath(other), join(dir, 'swap-in.sqlite'));
  const status = await refused(t, { stateDir: dir, ...fault('swap-on-open') }, { phase: 'paths', code: 'source-changed', retryable: true, sourcePreserved: false });
  assert.match(status.failure!.message, /not the storage its copy was checked as/);
  assert.ok(!(await filesUnder(dir))['storage-recovery/identity.json'], 'no identity was recorded for the storage it found');
});

/** The live database files of a filesUnder() listing. */
const liveFiles = (facts: Awaited<ReturnType<typeof filesUnder>>) => Object.fromEntries(Object.entries(facts).filter(([name]) => name.startsWith(DATABASE)));
const eio = () => Object.assign(new Error('injected EIO'), { code: 'EIO' });
/** A storage found without its identity: the open names it only after SQLite opened the live files. */
async function unnamedShaped(t: Parameters<typeof openFixture>[0], crashed: boolean): Promise<{ dir: string; recoveryDir: string }> {
  const dir = await existingShaped(t, crashed);
  await rename(join(dir, 'storage-recovery', 'identity.json'), join(dir, 'identity-aside.json'));
  return { dir, recoveryDir: (await storage.storageLayout(dir)).recoveryDir };
}

test('an open refused after SQLite opened the live files (the identity cannot be recorded) is compared once the thread closed them: changed when the close checkpointed a WAL, preserved when not', async t => {
  for (const [shape, crashed] of shapes) {
    const { dir, recoveryDir } = await unnamedShaped(t, crashed);
    const before = await filesUnder(dir);
    const requests = threadRequests(t);
    let injected = 0;
    replaceCall(t, storage.storageFs, 'syncDirectory', (original, path) => { if (path === recoveryDir) { injected++; throw eio(); } return original(path); });
    await refused(t, { stateDir: dir, bundle: threadBundle('fixture') }, { phase: 'paths', code: 'io-error', retryable: true, sourcePreserved: !crashed });
    assert.equal(injected, 1, `${shape}: the identity record failed after the open`);
    assert.deepEqual(requests.map(request => request.op), ['check', 'open', 'close'], `${shape}: SQLite opened the live files, and closed them before the comparison`);
    if (crashed) assert.notDeepEqual(liveFiles(await filesUnder(dir)), liveFiles(before), 'the close checkpointed the WAL into the database');
    else assert.deepEqual(liveFiles(await filesUnder(dir)), liveFiles(before), 'nothing to checkpoint: the live files are as found');
  }
});

test('a thread that ends right after it opened the live files: the refusal waits for the end, compares, and tells the worker once', async t => {
  for (const [shape, crashed] of shapes) {
    const { dir, recoveryDir } = await unnamedShaped(t, crashed);
    const before = await filesUnder(dir);
    const requests = threadRequests(t);
    let recorded = 0;
    // The open's identity record waits until the thread that answered the open has ended.
    replaceCall(t, storage.storageFs, 'createFile', async (original, path, data) => {
      if (path.startsWith(join(recoveryDir, '.identity.json.'))) {
        recorded++;
        const opened = requests.find(request => request.op === 'open')!;
        // Identity creation follows the parent's proof of the actual live paths.
        opened.worker.postMessage({ type: 'fixture-exit-after-open' });
        await opened.exited;
      }
      return original(path, data);
    });
    await refused(t, { stateDir: dir, ...fault('exit-after-open') }, { phase: 'thread-exit', code: 'thread-exited', sourcePreserved: !crashed });
    assert.equal(recorded, 1, `${shape}: the open was answered before the thread ended`);
    if (crashed) assert.notDeepEqual(liveFiles(await filesUnder(dir)), liveFiles(before), 'the connection recovered the WAL before the thread ended');
    else assert.deepEqual(liveFiles(await filesUnder(dir)), liveFiles(before), 'the ended thread\'s connection left the live files as found');
  }
});

test('a refusal whose own cleanup fails keeps its cause: a comparison that cannot be made, or a close that is never answered, is not preserved', async t => {
  // The comparison cannot be made: a rollback journal appears beside the database.
  const unreadable = await unnamedShaped(t, false);
  replaceCall(t, storage.storageFs, 'syncDirectory', async (original, path) => {
    if (path === unreadable.recoveryDir) { await writeFile(`${databasePath(unreadable.dir)}-journal`, '', { mode: 0o600 }); throw eio(); }
    return original(path);
  });
  await refused(t, { stateDir: unreadable.dir, bundle: threadBundle('fixture') }, { phase: 'paths', code: 'io-error', sourcePreserved: false });
  // The thread never answers the close: it is ended at the deadline, and the identity failure stays the cause.
  const unanswered = await unnamedShaped(t, true);
  const requests = threadRequests(t, op => op === 'close');
  replaceCall(t, storage.storageFs, 'syncDirectory', (original, path) => { if (path === unanswered.recoveryDir) throw eio(); return original(path); });
  const status = await refused(t, { stateDir: unanswered.dir, bundle: threadBundle('fixture'), limits: { commandDeadlineMs: 1000 } }, { phase: 'paths', code: 'io-error', sourcePreserved: false });
  assert.match(status.failure!.message, /injected EIO/);
  assert.deepEqual(requests.map(request => request.op), ['check', 'open', 'close']);
});

test('a change to the live files after the private copy was checked and removed, just before the open, is refused before SQLite is asked to open them', async t => {
  const dir = await existingShaped(t, true);
  const requests = threadRequests(t);
  let removed = 0;
  replaceCall(t, fsPromises, 'rm', async (original, path, options) => {
    await original(path, options);
    if (String(path).includes('.storage-check-')) {
      removed++;
      // Another process writes to the live database.
      const other = new DatabaseSync(databasePath(dir));
      try { other.exec('PRAGMA user_version = 77'); } finally { other.close(); }
    }
  });
  const status = await refused(t, { stateDir: dir, bundle: threadBundle('fixture') }, { phase: 'open', code: 'source-changed', retryable: true, sourcePreserved: false });
  assert.match(status.failure!.message, /changed while it was checked/);
  assert.equal(removed, 1, 'the change came once the copy was checked and removed');
  assert.deepEqual(requests.map(request => request.op).filter(op => op !== 'close'), ['check'], 'the open of the live files was never sent');
});

test('without room for the private check copy, the open is refused no-space and retryable, says how much it needs, and leaves the source as it was', async t => {
  const dir = await existingShaped(t, true);
  const before = await filesUnder(dir);
  const needed = (before[DATABASE] as { size: number }).size + (before[`${DATABASE}-wal`] as { size: number }).size;
  t.mock.method(storage.storageFs, 'availableBytes', async () => needed - 1);
  const status = await refused(t, { stateDir: dir, bundle: threadBundle('fixture') }, { phase: 'open', code: 'no-space', retryable: true, sourcePreserved: true });
  assert.deepEqual(status.failure?.space, { requiredBytes: needed, availableBytes: needed - 1 });
  assert.deepEqual(await filesUnder(dir), before);
  // With room again, the same files open.
  t.mock.restoreAll();
  const client = await openFixture(t, dir);
  assert.equal(client.status().state, 'ready');
});

test('the database is <state-dir>/state.sqlite: an existing one is opened, never shadowed, and nothing named storage/ is made', async t => {
  const dir = await existingStorage(t);
  assert.deepEqual(Object.keys(await filesUnder(dir)).sort(), [DATABASE, 'storage-recovery', 'storage-recovery/identity.json']);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: false });
  assert.deepEqual(await client.read('fixture', 'get', { key: 'kept' }), { key: 'kept', value: 'original' });
  await client.close();
  assert.ok(!Object.keys(await filesUnder(dir)).some(name => name === 'storage' || name.startsWith('storage/') || name.startsWith('.storage-check')));
});

test('symlinks, foreign modes, hard links and stray journals are refused as found', async t => {
  const options = (dir: string) => ({ stateDir: dir, bundle: threadBundle('fixture') });
  const cases: [string, (dir: string) => Promise<void>, string][] = [
    ['database symlink', async dir => { await rename(databasePath(dir), join(dir, 'real.db')); await symlink(join(dir, 'real.db'), databasePath(dir)); }, 'symlink'],
    ['wal symlink', async dir => { await writeFile(join(dir, 'elsewhere'), ''); await symlink(join(dir, 'elsewhere'), databasePath(dir, '-wal')); }, 'symlink'],
    ['shm symlink', async dir => { await writeFile(join(dir, 'elsewhere'), ''); await symlink(join(dir, 'elsewhere'), databasePath(dir, '-shm')); }, 'symlink'],
    ['database 0644', async dir => chmod(databasePath(dir), 0o644), 'wrong-permissions'],
    ['database read-only 0400', async dir => chmod(databasePath(dir), 0o400), 'wrong-permissions'],
    ['database a folder', async dir => { await rename(databasePath(dir), join(dir, 'real.db')); await mkdir(databasePath(dir), { mode: 0o700 }); }, 'not-regular'],
    ['hard link', async dir => link(databasePath(dir), join(dir, 'second-name.db')), 'hard-linked'],
    ['stray rollback journal', async dir => writeFile(`${databasePath(dir)}-journal`, 'hot', { mode: 0o600 }), 'unexpected-journal'],
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
  const bundle = threadBundle('fixture');
  // Gone, with its identity recorded beside it.
  const gone = await existingStorage(t);
  await rename(databasePath(gone), join(gone, 'aside.db'));
  let before = await filesUnder(gone);
  await refused(t, { stateDir: gone, bundle }, { phase: 'paths', code: 'database-missing' });
  assert.deepEqual(await filesUnder(gone), before, 'no new state.sqlite');
  // An empty file in its place.
  await writeFile(databasePath(gone), '', { mode: 0o600 });
  before = await filesUnder(gone);
  await refused(t, { stateDir: gone, bundle }, { phase: 'schema', code: 'database-missing' });
  assert.deepEqual(await filesUnder(gone), before);
  // Another storage's database in its place.
  const mine = await existingStorage(t);
  const theirs = await existingStorage(t);
  await rename(databasePath(theirs), databasePath(mine));
  before = await filesUnder(mine);
  await refused(t, { stateDir: mine, bundle }, { phase: 'schema', code: 'storage-replaced' });
  assert.deepEqual(await filesUnder(mine), before);
  // Sidecars without their database.
  for (const suffix of ['-wal', '-shm'] as const) {
    const orphan = await stateDir(t);
    await writeFile(databasePath(orphan, suffix), 'frames', { mode: 0o600 });
    before = await filesUnder(orphan);
    await refused(t, { stateDir: orphan, bundle }, { phase: 'paths', code: 'database-missing' });
    assert.deepEqual(await filesUnder(orphan), before);
  }
});

test('the default manifest is this build\'s: core only', () => {
  assert.deepEqual(storageManifest().domains, []);
});
