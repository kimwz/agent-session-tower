import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { captureStorageBundle, readStorageBundleArtifact, type CapturedStorageBundle } from '../../../server/storage/bundle.js';
import { openStorage } from '../../../server/storage/client.js';
import { STORAGE_BUNDLE_FORMAT } from '../../../server/storage/contract.js';
import { preflightStorage } from '../../../server/storage/preflight.js';
import {
  STORAGE_BUILD_IDENTITY_MODULE, STORAGE_BUNDLE_ARTIFACT, STORAGE_BUNDLE_DEFINE, STORAGE_EXPECTED_HASH_DEFINE, bundleStorageThread, storageThreadDefine, writeStorageThreadArtifact,
} from '../../../server/storage/thread-bundle.mjs';
import { alteredBundle, DATABASE, databasePath, filesUnder, FIXTURE_ENTRY, fixtureBundle, fixtureManifest, openFixture, stateDir, statedSource } from './helpers.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('the process captures its bundle once; the thread code needs only Node built-ins', async () => {
  const first = await captureStorageBundle();
  assert.equal(await captureStorageBundle(), first, 'every later call answers the same capture');
  assert.ok(first.ok);
  assert.equal(first.origin, 'development');
  const required = [...first.source.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(required)].sort(), ['node:crypto', 'node:worker_threads']);
  assert.doesNotMatch(first.source, /require\(["']node:sqlite["']\)/, 'node:sqlite is loaded inside a try, so its absence is a hello, not a crash');
  // The same sources give the same text and hash, in the format the worker reads.
  const again = await bundleStorageThread();
  assert.equal(again.sourceHash, first.sourceHash);
  assert.equal(again.format, STORAGE_BUNDLE_FORMAT);
});

test('a dist artifact replaced after capture changes nothing: flush, close and reopen keep the captured bundle', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-dist-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { path, artifact } = await writeStorageThreadArtifact(out, FIXTURE_ENTRY);
  assert.equal(relative(out, path), STORAGE_BUNDLE_ARTIFACT);
  const captured = await readStorageBundleArtifact(path) as CapturedStorageBundle;
  assert.equal(captured.sourceHash, artifact.sourceHash);
  const dir = await stateDir(t);
  const client = await openStorage({ stateDir: dir, bundle: captured, manifest: fixtureManifest });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  await client.write('fixture', 'put', { key: 'before', value: '1' }, 'before-1');

  // A new build (here: a mismatched one, then garbage) lands in dist while the worker runs.
  const other = alteredBundle(captured, source => source.replaceAll('"tower-storage/1"', '"tower-storage/2"'));
  assert.ok(other.ok);
  await writeFile(path, JSON.stringify({ format: 'tower-storage-thread-bundle/1', source: other.source, sourceHash: other.sourceHash }));
  await client.flush();
  assert.equal((await client.close()).ack, 'closed');
  await writeFile(path, 'not a bundle');
  const reopened = await client.reopen();
  assert.equal(reopened.state, 'ready', JSON.stringify(reopened.failure));
  assert.equal(reopened.identity?.sourceHash, artifact.sourceHash);
  await client.prepare({ allowMigration: false });
  assert.deepEqual(await client.read('fixture', 'get', { key: 'before' }), { key: 'before', value: '1' });
  // Reading the replaced file now would be refused: only the capture kept the reopen working.
  assert.equal((await readStorageBundleArtifact(path)).ok, false);
});

test('compiled server modules run the generated artifact without tsx, esbuild or a checkout thread entry', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-compiled-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  // The storage modules and what they import, compiled one by one like tsc output (no bundling).
  const sources = [
    ...(await readdir(join(root, 'server/storage'), { recursive: true })).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).map(name => join(root, 'server/storage', name)),
    join(root, 'server/stores/private-json.ts'), join(root, 'shared/app-identity.ts'),
  ];
  await build({ entryPoints: sources, outbase: root, outdir: out, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  await writeFile(join(out, 'package.json'), '{"type":"module"}');
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
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)!), { origin: 'dist', state: 'current', ack: 'closed' });
});

test('a compiled build trusts only the thread its build fixed: a valid re-hashed artifact of the same version, protocol and schema is refused before any file', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-trust-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const sources = [
    ...(await readdir(join(root, 'server/storage'), { recursive: true })).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).map(name => join(root, 'server/storage', name)),
    join(root, 'shared/app-identity.ts'),
  ];
  await build({ entryPoints: sources, outbase: root, outdir: out, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  await writeFile(join(out, 'package.json'), '{"type":"module"}');
  const { path, artifact } = await writeStorageThreadArtifact(out);
  assert.equal(await readFile(join(out, STORAGE_BUILD_IDENTITY_MODULE), 'utf8'), `export const BUILD_STORAGE_SOURCE_HASH = ${JSON.stringify(artifact.sourceHash)};\n`, 'the build fixed the hash its worker expects');
  // Another thread text, consistent with its own stated hash, with the same version, protocol and schema contract.
  const other = statedSource(`${artifact.source.slice(artifact.source.indexOf('\n') + 1)}\n;void 0;\n`);
  const rehashed = join(out, 'rehashed.json');
  await writeFile(rehashed, JSON.stringify({ format: artifact.format, ...other }));
  const state = await mkdtemp(join(tmpdir(), 'tower-storage-trust-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const probe = (extra = '') => `
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
    ${extra}
    console.log(JSON.stringify({ own: own.ok ? own.sourceHash : own.failure.code, rehashed: rehashed.ok || rehashed.failure.code, opened, preflight: preflight.refusal?.code }));`;
  const runProbe = async (extra?: string) => JSON.parse((await run(process.execPath, ['--input-type=module', '-e', probe(extra)], { cwd: out, env: { ...process.env, NODE_OPTIONS: '' } })).stdout.trim().split('\n').at(-1)!);
  assert.deepEqual(await runProbe(), {
    own: artifact.sourceHash, rehashed: 'bundle-untrusted', preflight: 'bundle-untrusted',
    opened: [['unavailable', 'bundle', 'bundle-untrusted'], ['unavailable', 'bundle', 'bundle-untrusted']],
  });
  assert.deepEqual(await filesUnder(state), {}, 'nothing was touched');
  // A compiled build that does not say which thread it expects trusts none, its own artifact included.
  await writeFile(join(out, STORAGE_BUILD_IDENTITY_MODULE), 'export const BUILD_STORAGE_SOURCE_HASH = undefined;\n');
  assert.equal((await runProbe()).own, 'bundle-untrusted');
  assert.deepEqual(await filesUnder(state), {});
});

test('a bundled server with the define carries the thread as text (the standalone path) and runs it from anywhere', async t => {
  const out = await mkdtemp(join(tmpdir(), 'tower-storage-sea-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const define = await storageThreadDefine();
  assert.deepEqual(Object.keys(define), [STORAGE_BUNDLE_DEFINE, STORAGE_EXPECTED_HASH_DEFINE]);
  const entry = join(out, 'entry.ts');
  await writeFile(entry, `
    import { captureStorageBundle, openStorage } from ${JSON.stringify(join(root, 'server/storage/index.ts'))};
    const bundle = await captureStorageBundle();
    if (!bundle.ok) { console.log(JSON.stringify({ refused: bundle.failure.code })); process.exit(0); }
    const client = await openStorage({ stateDir: process.argv[2], bundle });
    await client.prepare({ allowMigration: true });
    const closed = await client.close();
    console.log(JSON.stringify({ origin: bundle.origin, ack: closed.ack, state: closed.status.state }));`);
  const state = await mkdtemp(join(tmpdir(), 'tower-storage-sea-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const runBundled = async (name: string, defines: Record<string, string>) => {
    const main = join(out, name);
    await build({ entryPoints: [entry], outfile: main, bundle: true, platform: 'node', format: 'esm', target: 'node22', define: defines, logLevel: 'silent' });
    const { stdout } = await run(process.execPath, [main, state], { cwd: state, env: { ...process.env, NODE_OPTIONS: '' } });
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
  };
  // An executable whose expected hash is not its thread's refuses to start it.
  assert.deepEqual(await runBundled('mismatched.mjs', { ...define, [STORAGE_EXPECTED_HASH_DEFINE]: JSON.stringify('f'.repeat(64)) }), { refused: 'bundle-untrusted' });
  assert.deepEqual(await filesUnder(state), {});
  assert.deepEqual(await runBundled('server.mjs', define), { origin: 'standalone', ack: 'closed', state: 'closed' });
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

  const bundle = await fixtureBundle();
  const result = await preflightStorage({ bundle, manifest: fixtureManifest, stateDir: dir });
  assert.equal(result.supported, true, JSON.stringify(result.refusal));
  assert.equal(result.runtime?.execPath, process.execPath);
  assert.equal(result.identity?.sourceHash, bundle.sourceHash);
  assert.deepEqual(result.probe, { foreignKeysEnforced: true, trustedSchema: 0, busyTimeout: 250, transactionRollback: true, preparedRows: 50 });
  assert.deepEqual(result.state, { database: 'present', sidecars: ['wal', 'shm'], identity: 'created', recovery: { state: 'clear' } });
  assert.deepEqual(await filesUnder(dir), before);

  // Refusals come back structured, and still touch nothing.
  const mismatched = await preflightStorage({ bundle, stateDir: dir });
  assert.equal(mismatched.supported, false);
  assert.deepEqual(mismatched.refusal?.code, 'schema-contract-mismatch');
  const noSqlite = await preflightStorage({ bundle: alteredBundle(bundle, source => `process.getBuiltinModule = () => undefined;\n${source}`), manifest: fixtureManifest, stateDir: dir });
  assert.deepEqual([noSqlite.supported, noSqlite.refusal?.phase, noSqlite.refusal?.code], [false, 'runtime', 'unsupported-runtime']);
  const missing = await preflightStorage({ bundle: await readStorageBundleArtifact(join(dir, 'nope.json')), stateDir: dir });
  assert.deepEqual(missing.refusal?.phase, 'bundle');
  assert.deepEqual(await filesUnder(dir), before);
  // A state directory without storage is reported as such and left empty.
  const empty = await stateDir(t);
  assert.deepEqual((await preflightStorage({ bundle, manifest: fixtureManifest, stateDir: empty })).state, { database: 'absent', sidecars: [], identity: 'absent', recovery: { state: 'clear' } });
  assert.deepEqual(await filesUnder(empty), {});
});
