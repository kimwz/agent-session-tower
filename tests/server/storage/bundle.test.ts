import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import type { CapturedStorageBundle } from '../../../server/storage/bundle.js';
import { STORAGE_BUNDLE_FORMAT } from '../../../server/storage/contract.js';
import {
  buildIdentityModule, buildIdentityPlugin, bundleStorageThread, STORAGE_BUILD_IDENTITY_MODULE, STORAGE_BUNDLE_ARTIFACT, storageThreadPlugin, writeStorageThreadArtifact,
} from '../../../server/storage/thread-bundle.mjs';
import {
  DATABASE, databasePath, filesUnder, FIXTURE_ENTRY, fixtureManifest, openFixture, rehashedArtifact, stateDir, statedSource, storage, threadBundle,
} from './helpers.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const lastJson = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1)!);

test('a checkout trusts only the thread its own first capture bundles from its canonical entry: before it nothing, after it nothing else (a tsx process without the fixture build)', async t => {
  const state = await stateDir(t);
  const script = `
    const { captureStorageBundle, storageBundleFromArtifact, storageBuildContext } = await import(${JSON.stringify(join(root, 'server/storage/bundle.ts'))});
    const { openStorage, preflightStorage } = await import(${JSON.stringify(join(root, 'server/storage/index.ts'))});
    const { bundleStorageThread } = await import(${JSON.stringify(join(root, 'server/storage/thread-bundle.mjs'))});
    const { readdir } = await import('node:fs/promises');
    const state = ${JSON.stringify(state)};
    const code = bundle => bundle.ok ? 'ok' : bundle.failure.code;
    const canonical = await bundleStorageThread();
    const own = { ok: true, source: canonical.source, sourceHash: canonical.sourceHash, origin: 'development', capturedAt: '' };
    // A valid, self-consistent thread of the same version, protocol and schema: the fixture thread, and the canonical one re-hashed.
    const fixture = await bundleStorageThread(${JSON.stringify(FIXTURE_ENTRY)});
    const body = canonical.source.slice(canonical.source.indexOf('\\n') + 1) + '\\n;void 0;\\n';
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(body).digest('hex');
    const rehashed = { format: canonical.format, source: 'var __TOWER_STORAGE_SOURCE_HASH__ = ' + JSON.stringify(hash) + ';\\n' + body, sourceHash: hash };
    const foreign = { ok: true, source: rehashed.source, sourceHash: hash, origin: 'development', capturedAt: '' };
    const refusals = async () => {
      const opened = await openStorage({ stateDir: state, bundle: foreign });
      const result = [code(storageBundleFromArtifact(JSON.stringify(fixture), 'development')), code(storageBundleFromArtifact(JSON.stringify(rehashed), 'development')),
        opened.status().failure?.code, (await preflightStorage({ bundle: foreign, stateDir: state })).refusal?.code, code(storageBuildContext(foreign))];
      await opened.close();
      return result;
    };
    const before = { refusals: await refusals(), own: code(storageBundleFromArtifact(JSON.stringify(canonical), 'development')), ownContext: code(storageBuildContext(own)) };
    const files = (await readdir(state)).length;
    const captured = await captureStorageBundle();
    const capture = { code: code(captured), origin: captured.origin, same: captured.sourceHash === canonical.sourceHash, once: (await captureStorageBundle()) === captured,
      requires: [...new Set([...captured.source.matchAll(/\\brequire\\(["']([^"']+)["']\\)/g)].map(match => match[1]))].sort(), sqliteRequired: /require\\(["']node:sqlite["']\\)/.test(captured.source) };
    const after = { refusals: await refusals(), own: code(storageBundleFromArtifact(JSON.stringify(canonical), 'development')) };
    const client = await openStorage({ stateDir: state, bundle: captured });
    const prepared = await client.prepare({ allowMigration: true });
    const closed = await client.close();
    const reopened = await client.reopen();
    await client.prepare({ allowMigration: false });
    const gate = await client.gate('core');
    await client.close();
    console.log(JSON.stringify({ before, files, capture, after, open: [prepared.created, closed.ack, reopened.state, reopened.identity.sourceHash === captured.sourceHash, gate.open] }));`;
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root });
  const untrusted = Array(5).fill('bundle-untrusted');
  assert.deepEqual(lastJson(stdout), {
    // Before: nothing is trusted, not even the canonical text when a caller hands it in.
    before: { refusals: untrusted, own: 'bundle-untrusted', ownContext: 'bundle-untrusted' },
    files: 0,
    capture: { code: 'ok', origin: 'development', same: true, once: true, requires: ['node:crypto', 'node:worker_threads'], sqliteRequired: false },
    // After: the same canonical source is the one trusted; foreign and re-hashed sources still are not.
    after: { refusals: untrusted, own: 'ok' },
    open: [true, 'closed', 'ready', true, true],
  });
  assert.deepEqual(Object.keys(await filesUnder(state)).sort(), [DATABASE, 'storage-recovery', 'storage-recovery/identity.json']);
});

test('a checkout whose own thread entry changes after its capture reopens with the capture, and trusts no thread bundled from the change (an isolated copy of the checkout)', async t => {
  // A copy of what a checkout capture bundles (compileStorage's sources, and the tsconfig.json esbuild compiles them
  // with), run by tsx from its own folder.
  const checkout = await mkdtemp(join(tmpdir(), 'tower-storage-checkout-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await cp(join(root, 'server/storage'), join(checkout, 'server/storage'), { recursive: true });
  for (const name of ['storage-schema.ts', 'storage-codec.ts', 'storage-commands.ts']) {
    await cp(join(root, 'server/sessions/retention', name), join(checkout, 'server/sessions/retention', name));
  }
  await cp(join(root, 'shared/app-identity.ts'), join(checkout, 'shared/app-identity.ts'));
  await cp(join(root, 'tsconfig.json'), join(checkout, 'tsconfig.json'));
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'));
  const state = await stateDir(t);
  const fresh = await stateDir(t);
  const module = (path: string) => JSON.stringify(join(checkout, path));
  const script = `
    const { captureStorageBundle, storageBundleFromArtifact } = await import(${module('server/storage/bundle.ts')});
    const { openStorage } = await import(${module('server/storage/index.ts')});
    const { bundleStorageThread, STORAGE_THREAD_ENTRY } = await import(${module('server/storage/thread-bundle.mjs')});
    const { readdir, readFile, writeFile } = await import('node:fs/promises');
    const code = bundle => bundle.ok ? 'ok' : bundle.failure.code;
    const captured = await captureStorageBundle();
    const client = await openStorage({ stateDir: ${JSON.stringify(state)}, bundle: captured });
    const prepared = await client.prepare({ allowMigration: true });
    const closed = await client.close();
    // The checkout's own default entry changes, in code its thread would run.
    const entry = await readFile(STORAGE_THREAD_ENTRY, 'utf8');
    await writeFile(STORAGE_THREAD_ENTRY, entry.replace('runStorageThread(', 'if (Date.now() < 0) throw new Error("a changed checkout");\\nrunStorageThread('));
    const changed = await bundleStorageThread();
    const reopened = await client.reopen();
    const claimed = await client.prepare({ allowMigration: false });
    const gate = await client.gate('core');
    await client.close();
    const other = await openStorage({ stateDir: ${JSON.stringify(fresh)}, bundle: { ok: true, source: changed.source, sourceHash: changed.sourceHash, origin: 'development', capturedAt: '' } });
    const refusal = other.status().failure?.code;
    await other.close();
    console.log(JSON.stringify({
      entry: STORAGE_THREAD_ENTRY, captured: captured.sourceHash, changed: changed.sourceHash, runsChange: changed.source.includes('a changed checkout'), once: (await captureStorageBundle()) === captured,
      open: [prepared.created, closed.ack, reopened.state, reopened.identity.sourceHash, claimed.claimed, gate.open],
      changedArtifact: code(storageBundleFromArtifact(JSON.stringify(changed), 'development')), refusal, freshFiles: (await readdir(${JSON.stringify(fresh)})).length,
    }));`;
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: checkout });
  const result = lastJson(stdout);
  const canonical = await bundleStorageThread();
  assert.equal(result.entry, join(await realpath(checkout), 'server/storage/thread/main.ts'), 'the copy bundles its own default entry');
  assert.equal(result.captured, canonical.sourceHash, 'the same sources as this checkout: the capture is the canonical thread');
  assert.notEqual(result.changed, result.captured, 'the change is in the bundled code, not only in its comments');
  assert.equal(result.runsChange, true);
  assert.equal(result.once, true);
  assert.deepEqual(result.open, [true, 'closed', 'ready', result.captured, true, true], 'the reopen runs the captured thread');
  assert.equal(result.changedArtifact, 'bundle-untrusted');
  assert.equal(result.refusal, 'bundle-untrusted');
  assert.equal(result.freshFiles, 0, 'nothing touched for the changed thread');
  assert.equal((await bundleStorageThread()).sourceHash, canonical.sourceHash, 'this checkout itself is unchanged');
});

test('the same sources give the same thread text and hash, in the format the worker reads', async () => {
  const first = await bundleStorageThread();
  const again = await bundleStorageThread();
  assert.equal(again.sourceHash, first.sourceHash);
  assert.equal(again.source, first.source);
  assert.equal(first.format, STORAGE_BUNDLE_FORMAT);
});

test('a dist artifact replaced after capture changes nothing: flush, close and reopen keep the captured bundle', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-dist-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { path, artifact } = await writeStorageThreadArtifact(out, FIXTURE_ENTRY);
  assert.equal(relative(out, path), STORAGE_BUNDLE_ARTIFACT);
  const captured = await storage.readStorageBundleArtifact(path) as CapturedStorageBundle;
  assert.equal(captured.sourceHash, artifact.sourceHash);
  const dir = await stateDir(t);
  const client = await storage.openStorage({ stateDir: dir, bundle: captured });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'put', { key: 'before', value: '1' }, 'before-1');

  // A new build (here: a mismatched one, then garbage) lands in dist while the worker runs.
  await writeFile(path, rehashedArtifact(captured, source => source.replaceAll('"tower-storage/1"', '"tower-storage/2"')));
  await client.flush();
  assert.equal((await client.close()).ack, 'closed');
  await writeFile(path, 'not a bundle');
  const reopened = await client.reopen();
  assert.equal(reopened.state, 'ready', JSON.stringify(reopened.failure));
  assert.equal(reopened.identity?.sourceHash, artifact.sourceHash);
  await client.prepare({ allowMigration: false });
  assert.deepEqual(await client.read('fixture', 'get', { key: 'before' }), { key: 'before', value: '1' });
  // Reading the replaced file now would be refused: only the capture kept the reopen working.
  assert.equal((await storage.readStorageBundleArtifact(path)).ok, false);
});

/** server/storage and what it imports, compiled one by one like tsc output (no bundling), into `out`. */
async function compileStorage(out: string): Promise<void> {
  const sources = [
    ...(await readdir(join(root, 'server/storage'), { recursive: true })).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).map(name => join(root, 'server/storage', name)),
    ...['storage-schema.ts', 'storage-codec.ts', 'storage-commands.ts'].map(name => join(root, 'server/sessions/retention', name)),
    join(root, 'shared/app-identity.ts'),
  ];
  await build({ entryPoints: sources, outbase: root, outdir: out, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  await writeFile(join(out, 'package.json'), '{"type":"module"}');
}

test('compiled server modules run the generated artifact without tsx, esbuild or a checkout thread entry', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-compiled-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await compileStorage(out);
  await writeStorageThreadArtifact(out);
  const state = await mkdtemp(join(tmpdir(), 'tower-storage-compiled-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const script = `
    const storage = await import(${JSON.stringify(join(out, 'server/storage/index.js'))});
    const bundle = await storage.captureStorageBundle();
    const client = await storage.openStorage({ stateDir: ${JSON.stringify(state)}, bundle });
    const prepared = await client.prepare({ allowMigration: true });
    const closed = await client.close();
    console.log(JSON.stringify({ origin: bundle.origin, state: prepared.schema.kind, ack: closed.ack }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: out, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.deepEqual(lastJson(stdout), { origin: 'dist', state: 'current', ack: 'closed' });
});

test('a compiled build trusts only the one source its build fixed: a valid re-hashed artifact of the same version, protocol and schema is refused before any file', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-trust-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await compileStorage(out);
  const { path, artifact } = await writeStorageThreadArtifact(out);
  assert.equal(await readFile(join(out, STORAGE_BUILD_IDENTITY_MODULE), 'utf8'), buildIdentityModule({ contexts: [{ sourceHash: artifact.sourceHash }] }), 'the build fixed its one source, with no contract of its own');
  // Another thread text, consistent with its own stated hash, with the same version, protocol and schema contract.
  const other = statedSource(`${artifact.source.slice(artifact.source.indexOf('\n') + 1)}\n;void 0;\n`);
  const rehashed = join(out, 'rehashed.json');
  await writeFile(rehashed, JSON.stringify({ format: artifact.format, ...other }));
  const state = await mkdtemp(join(tmpdir(), 'tower-storage-trust-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const probe = `
    const { readStorageBundleArtifact } = await import(${JSON.stringify(join(out, 'server/storage/bundle.js'))});
    const storage = await import(${JSON.stringify(join(out, 'server/storage/index.js'))});
    const own = await readStorageBundleArtifact(${JSON.stringify(path)}, 'dist');
    const rehashed = await readStorageBundleArtifact(${JSON.stringify(rehashed)}, 'dist');
    const forged = { ok: true, source: ${JSON.stringify(other.source)}, sourceHash: ${JSON.stringify(other.sourceHash)}, origin: 'dist', capturedAt: '' };
    const opened = [];
    for (const bundle of [rehashed, forged]) {
      const client = await storage.openStorage({ stateDir: ${JSON.stringify(state)}, bundle });
      const failure = client.status().failure;
      opened.push([client.status().state, failure?.phase, failure?.code]);
      await client.close();
    }
    const preflight = await storage.preflightStorage({ bundle: forged });
    console.log(JSON.stringify({ own: own.ok ? own.sourceHash : own.failure.code, rehashed: rehashed.ok || rehashed.failure.code, opened, preflight: preflight.refusal?.code }));`;
  const runProbe = async () => lastJson((await run(process.execPath, ['--input-type=module', '-e', probe], { cwd: out, env: { ...process.env, NODE_OPTIONS: '' } })).stdout);
  assert.deepEqual(await runProbe(), {
    own: artifact.sourceHash, rehashed: 'bundle-untrusted', preflight: 'bundle-untrusted',
    opened: [['unavailable', 'bundle', 'bundle-untrusted'], ['unavailable', 'bundle', 'bundle-untrusted']],
  });
  assert.deepEqual(await filesUnder(state), {}, 'nothing was touched');
  // A compiled build that does not say which thread it trusts (its module not replaced) trusts none, its own artifact included.
  await writeFile(join(out, STORAGE_BUILD_IDENTITY_MODULE), 'export const BUILD_STORAGE = undefined;\n');
  assert.equal((await runProbe()).own, 'bundle-untrusted');
  // Nor does one whose identity is malformed.
  await writeFile(join(out, STORAGE_BUILD_IDENTITY_MODULE), buildIdentityModule({ contexts: [{ sourceHash: artifact.sourceHash }, { sourceHash: artifact.sourceHash }] }));
  assert.equal((await runProbe()).own, 'bundle-untrusted');
  assert.deepEqual(await filesUnder(state), {});
});

test('a bundled server built with the storage plugin carries the thread as text (the standalone path), trusts exactly it, and runs it from anywhere', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-sea-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const entry = join(out, 'entry.ts');
  await writeFile(entry, `
    import { captureStorageBundle, openStorage } from ${JSON.stringify(join(root, 'server/storage/index.ts'))};
    import { BUILD_STORAGE } from ${JSON.stringify(join(root, 'server/storage/build-identity.ts'))};
    const identity = { contexts: BUILD_STORAGE.contexts, artifact: typeof BUILD_STORAGE.artifact };
    const bundle = await captureStorageBundle();
    if (!bundle.ok) { console.log(JSON.stringify({ refused: bundle.failure.code, identity })); process.exit(0); }
    const client = await openStorage({ stateDir: process.argv[2], bundle });
    await client.prepare({ allowMigration: true });
    const closed = await client.close();
    console.log(JSON.stringify({ origin: bundle.origin, ack: closed.ack, state: closed.status.state, identity }));`);
  const state = await mkdtemp(join(tmpdir(), 'tower-storage-sea-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const runBundled = async (name: string, plugin: Awaited<ReturnType<typeof storageThreadPlugin>>) => {
    const main = join(out, name);
    await build({ entryPoints: [entry], outfile: main, bundle: true, platform: 'node', format: 'esm', target: 'node22', plugins: [plugin], logLevel: 'silent' });
    const { stdout } = await run(process.execPath, [main, state], { cwd: state, env: { ...process.env, NODE_OPTIONS: '' } });
    return lastJson(stdout);
  };
  const artifact = await bundleStorageThread();
  // An executable whose trusted source is not its thread's refuses to start it.
  const mismatched = buildIdentityPlugin(buildIdentityModule({ contexts: [{ sourceHash: 'f'.repeat(64) }], artifact: JSON.stringify(artifact) }));
  assert.deepEqual(await runBundled('mismatched.mjs', mismatched), { refused: 'bundle-untrusted', identity: { contexts: [{ sourceHash: 'f'.repeat(64) }], artifact: 'string' } });
  assert.deepEqual(await filesUnder(state), {});
  assert.deepEqual(await runBundled('server.mjs', await storageThreadPlugin()), { origin: 'standalone', ack: 'closed', state: 'closed', identity: { contexts: [{ sourceHash: artifact.sourceHash }], artifact: 'string' } });
  // A build the identity module is not part of fails instead of shipping without one.
  const lone = join(out, 'lone.ts');
  await writeFile(lone, 'console.log(1);');
  await assert.rejects(build({ entryPoints: [lone], outfile: join(out, 'lone.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [await storageThreadPlugin()], logLevel: 'silent' }), /build-identity\.ts was not part of the build/);
});

test('the fixture build stays in tests: no server or script module reaches it, the storage reads no environment, globals or arguments for trust, and the checkout\'s own identity is empty', async () => {
  const files = async (dir: string) => (await readdir(join(root, dir), { recursive: true })).filter(name => /\.(ts|mts|mjs|js)$/.test(name)).map(name => join(dir, name));
  const product = [...await files('server'), ...await files('shared'), ...(await files('scripts')).filter(name => !name.startsWith('scripts/test-'))];
  for (const path of product) {
    const text = await readFile(join(root, path), 'utf8');
    assert.doesNotMatch(text, /from\s+['"][^'"]*\btests\/|import\(\s*['"][^'"]*\btests\//, `${path} imports test code`);
    assert.doesNotMatch(text, /fixtures\/parent|faults\//, `${path} names the fixture build`);
  }
  for (const path of await files('server/storage')) {
    const text = await readFile(join(root, path), 'utf8');
    assert.doesNotMatch(text, /process\.env|process\.argv|globalThis|__TOWER_STORAGE_(THREAD_BUNDLE|EXPECTED_SOURCE_HASH)__/, `${path} reads trust from outside its build`);
  }
  // The checkout's identity module trusts nothing; only builds replace it.
  const { BUILD_STORAGE } = await import('../../../server/storage/build-identity.js');
  assert.equal(BUILD_STORAGE, undefined);
  // The storage's public surface offers no way to set or widen trust.
  const surface = Object.keys(await import('../../../server/storage/index.js'));
  for (const name of ['BUILD_STORAGE', 'storageBundleFromArtifact', 'buildIdentityModule', 'buildIdentityPlugin', 'isStorageBuildContext', 'proveRecoveryBarrier']) assert.ok(!surface.includes(name), name);
  // Only scripts that build the product use the build identity helpers, each with the one source it bundles.
  const builder = await readFile(join(root, 'scripts/build-executable.mjs'), 'utf8');
  assert.match(builder, /plugins: \[await storageThreadPlugin\(\)\]/);
  assert.doesNotMatch(builder, /buildIdentityModule|buildIdentityPlugin/);
});

test('read-only preflight: same bundle and execPath, in-memory only, and the state files stay byte-for-byte as they were', async t => {
  const dir = await stateDir(t);
  const client = await openFixture(t, dir);
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'putMany', { prefix: 'row', count: 20 }, 'rows-1');
  // Leave a live WAL and shm behind, as a crashed worker would: another connection keeps them while the thread closes.
  const holder = new DatabaseSync(databasePath(dir), { readOnly: true });
  t.after(() => holder.close());
  holder.prepare('SELECT count(*) FROM fixture_items').get();
  await client.close();
  const before = await filesUnder(dir);
  assert.ok(before[`${DATABASE}-wal`] && before[`${DATABASE}-shm`], 'the fixture has sidecars to protect');

  const bundle = threadBundle('fixture');
  const result = await storage.preflightStorage({ bundle, stateDir: dir });
  assert.equal(result.supported, true, JSON.stringify(result.refusal));
  assert.equal(result.runtime?.execPath, process.execPath);
  assert.deepEqual(result.identity, { appVersion: fixtureManifest.appVersion, protocol: 'tower-storage/1', sourceHash: bundle.sourceHash, manifestDigest: fixtureManifest.digest });
  assert.deepEqual(result.probe, { foreignKeysEnforced: true, trustedSchema: 0, busyTimeout: 250, transactionRollback: true, preparedRows: 50 });
  assert.deepEqual(result.state, { database: 'present', sidecars: ['wal', 'shm'], identity: 'created', recovery: { state: 'clear' } });
  assert.deepEqual(await filesUnder(dir), before);

  // Refusals come back structured, and still touch nothing.
  const untrusted = await storage.preflightStorage({ bundle: storage.storageBundleFromArtifact(rehashedArtifact(bundle, body => `${body}\n;void 0;\n`), 'artifact'), stateDir: dir });
  assert.deepEqual([untrusted.supported, untrusted.refusal?.phase, untrusted.refusal?.code], [false, 'bundle', 'bundle-untrusted']);
  const forged = await storage.preflightStorage({ bundle: threadBundle('forged-manifest'), stateDir: dir });
  assert.deepEqual([forged.supported, forged.refusal?.code], [false, 'schema-contract-mismatch']);
  const noSqlite = await storage.preflightStorage({ bundle: threadBundle('no-sqlite'), stateDir: dir });
  assert.deepEqual([noSqlite.supported, noSqlite.refusal?.phase, noSqlite.refusal?.code], [false, 'runtime', 'unsupported-runtime']);
  const missing = await storage.preflightStorage({ bundle: await storage.readStorageBundleArtifact(join(dir, 'nope.json')), stateDir: dir });
  assert.deepEqual(missing.refusal?.phase, 'bundle');
  assert.deepEqual(await filesUnder(dir), before);
  // A state directory without storage is reported as such and left empty.
  const empty = await stateDir(t);
  assert.deepEqual((await storage.preflightStorage({ bundle, stateDir: empty })).state, { database: 'absent', sidecars: [], identity: 'absent', recovery: { state: 'clear' } });
  assert.deepEqual(await filesUnder(empty), {});
});
