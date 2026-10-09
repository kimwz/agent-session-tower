import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { artifactOf, contextOf, storage, threadBundle } from '../storage/helpers.js';
import { createHash } from 'node:crypto';
import { installArtifact } from '../link/fixtures/storage-builds.js';
import { entryPoint, pointCurrent } from '../../../server/link/service.js';
import { rollbackPorts, storageControl } from '../../../server/runs/storage-control.js';
import { buildIdentityModule, buildIdentityPlugin } from '../../../server/storage/thread-bundle.mjs';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { readHandoff, writeHandoff } from '../../../server/runs/handoff.js';
import { parseRunDocuments } from '../../../server/runs/storage-codec.js';
import { retentionBootstrap, retentionLegacyFiles } from '../../../server/sessions/retention/storage-transfer.js';
import { RetentionStore } from '../../../server/sessions/retention/store.js';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { RetentionRepository } from '../../../server/sessions/retention/storage-repository.js';
import { recordPreparationEvidence } from '../../../server/link/storage-update.js';
import { runnerPaths, RUNNER_PROTOCOL, type RunnerReply } from '../../../server/runs/runner-protocol.js';
import { artifactStorageContract, completionProven, type ServingProof, resumeRollback, withdrawRollback, readRollbackRecord, evaluateStorageUpdate, type RunningBuild, storageUpdatePaths, type RollbackRecord } from '../../../server/link/storage-update.js';
import { updatePaths } from '../../../server/link/storage-update.js';
import { listPendingSecretImports } from '../../../server/secrets/imports.js';

// Hosted disposable jobs only: this starts the actual product worker and its actual SQLite memory preflight,
// with no native providers, no copied credentials, and only the direct child owned by this fixture.
test('actual diagnostic worker holds restore, journal, proofs and launches before a storage update can be proven', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-storage-diagnostic-')));
  const state = join(root, 'state');
  const paths = await runnerPaths(state);
  const lock = updatePaths(state).lock;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  await writeFile(lock, 'invalid helper owner', { mode: 0o600 });
  const protectedFiles = [join(state, 'restore', 'pending-worker.json'), join(state, 'retention', 'journal.json'), join(state, 'agent-launches.json'), join(state, 'launch-marks', 'fixture.json')];
  for (const path of protectedFiles) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, 'fixture bytes: must not be consumed', { mode: 0o600 }); }
  const before = await Promise.all(protectedFiles.map(async path => ({ bytes: await readFile(path), info: await lstat(path) })));
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths);
  let snapshot: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!snapshot) {
    if (child.exitCode !== null) assert.fail(`Actual worker exited: ${stderr()}`);
    try { snapshot = await call('snapshot'); } catch {
      if (Date.now() > deadline) assert.fail(`Actual worker did not answer: ${stderr()}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const status = snapshot.snapshot?.storage;
  assert.ok(status, 'actual worker advertises its storage diagnosis');
  assert.equal(status.admissionOpen, false);
  assert.equal(status.sessionsAvailable, false);
  assert.equal(status.state, 'recovery-required', 'actual supported SQLite preflight passed; the unknown helper holds startup');
  assert.equal((await call('sessionHistory')).error?.statusCode, 503);
  assert.equal((await call('forceHandoff')).error?.statusCode, 503, 'storage hold cannot become a forced cancellation');
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(state, 'restore', 'applying-worker.json')), { code: 'ENOENT' });
  for (const [index, path] of protectedFiles.entries()) {
    assert.deepEqual(await readFile(path), before[index].bytes);
    const info = await lstat(path); assert.equal(info.ino, before[index].info.ino); assert.equal(info.mtimeMs, before[index].info.mtimeMs);
  }
  assert.equal(await readFile(lock, 'utf8'), 'invalid helper owner');
  assert.equal((await call('snapshot')).instance, snapshot.instance, 'diagnosis keeps its live runtime lock and RPC identity');
});

const diagnosticRoots = new WeakMap<TestContext, Map<string, {
  directory: string;
  children: { child: ChildProcess; closed: Promise<unknown> }[];
}>>();

async function prepareRetentionA(root: string, stateDir: string): Promise<void> {
  // Whole A122 preparation uses the parent-captured official artifact, including both domains.
  const a = await retentionBuild('1.122.0', join(root, 'preparation-artifact'));
  const client = await a.storage.openStorage({ stateDir, bundle: a.bundle() });
  try {
    const prepared = await client.prepare({ allowMigration: true });
    assert.equal(prepared.claimed, true);
    assert.deepEqual(a.manifest.domains.map(domain => domain.scope).sort(), ['retention', 'runs']);
    const preflight = await a.storage.preflightStorage({ bundle: a.bundle(), stateDir });
    await recordPreparationEvidence(stateDir, { context: client.context!, preflight, prepared, gate: await client.gate('core') });
  } finally { await client.close(); }
}

/** Existing fixture factory supplies the captured future B SDK; A production declarations remain untouched. */
async function futureBWorker(t: TestContext, root: string): Promise<string> {
  const b = await retentionBuild('1.125.0',join(root,'future-b-artifact'));
  const captured = b.bundle();
  const generated = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)),'future-b-worker-'));
  t.after(() => rm(generated,{ recursive: true,force: true }));
  const entry = join(generated,'worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts',import.meta.url))],outfile: entry,bundle: true,packages: 'external',platform: 'node',format: 'esm',target: 'node22',logLevel: 'silent',plugins: [
    { name: 'future-b125-worker-profile',setup(builder) { builder.onLoad({ filter: /[\\/]shared[\\/]app-identity\.ts$/ },async args => ({ contents: (await readFile(args.path,'utf8')).replace(/export const APP_VERSION = '[^']+';/,"export const APP_VERSION = '1.125.0';"),loader: 'ts' })); } },
    buildIdentityPlugin(buildIdentityModule({ contexts: [{ sourceHash: captured.sourceHash,manifest: b.manifest }],artifact: JSON.stringify({ format: 'tower-storage-thread-bundle/2',source: captured.source,sourceHash: captured.sourceHash }) })),
  ] });
  return entry;
}
async function prepareTriggersA124(root: string,stateDir: string): Promise<void> {
  const a = await retentionBuild('1.124.0',join(root,'trigger-preparation-artifact'));
  const client = await a.storage.openStorage({ stateDir,bundle: a.bundle() });
  try {
    const prepared = await client.prepare({ allowMigration: true }),preflight = await a.storage.preflightStorage({ stateDir,bundle: a.bundle() });
    await recordPreparationEvidence(stateDir,{ context: client.context!,preflight,prepared,gate: await client.gate('core') });
  } finally { await client.close(); }
}

async function recoveryWorkerA122(root: string): Promise<string> {
  const a = await retentionBuild('1.122.0', join(root, 'recovery-artifact'));
  const captured = a.bundle();
  assert.equal(captured.ok, true);
  const artifact = await readFile(new URL('../storage/fixtures/runs-a122/thread-bundle.json', import.meta.url), 'utf8');
  const workerSource = await readFile(new URL('./fixtures/storage-diagnostic-worker-a122.ts.txt', import.meta.url), 'utf8');
  // Exact public A122 worker from 1544951; do not relabel B's bootstrap as a preparation worker.
  assert.equal(createHash('sha256').update(workerSource).digest('hex'), '35a804316f1a08b9ded92b9cfc30a71cb67f2466ee8de28a96a8e274e81e067a');
  const entry = join(root, 'recovery-worker-a122.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url))], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [
      { name: 'actual-a122-recovery-profile', setup(builder) {
        builder.onLoad({ filter: /[\\/]server[\\/]runs[\\/]worker\.ts$/ }, () => ({ contents: workerSource, loader: 'ts' }));
        builder.onLoad({ filter: /[\\/]server[\\/](runs|sessions[\\/]retention)[\\/]storage-schema\.ts$/ }, async args => ({
          contents: await readFile(new URL(`../storage/fixtures/runs-a122/${args.path.includes('/runs/') ? 'runs' : 'retention'}-storage-schema.ts.txt`, import.meta.url), 'utf8'), loader: 'ts',
        }));
        builder.onLoad({ filter: /[\\/]shared[\\/]app-identity\.ts$/ }, async args => ({
          contents: (await readFile(args.path, 'utf8')).replace(/export const APP_VERSION = '[^']+';/, "export const APP_VERSION = '1.122.0';"), loader: 'ts',
        }));
      } },
      buildIdentityPlugin(buildIdentityModule({ contexts: [{ sourceHash: captured.ok ? captured.sourceHash : '', manifest: a.manifest }], artifact })),
    ] });
  return entry;
}

async function launchDiagnostic(t: TestContext, root: string, state: string, paths: Awaited<ReturnType<typeof runnerPaths>>, entry = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url)), extraEnv: Record<string, string> = {}) {
  assert.equal(state, join(root, 'state'), 'diagnostic state must belong to the exact fixture root');
  let roots = diagnosticRoots.get(t);
  if (!roots) { roots = new Map(); diagnosticRoots.set(t, roots); }
  let owned = roots.get(root);
  if (!owned) {
    const fixture = { directory: paths.directory, children: [] as { child: ChildProcess; closed: Promise<unknown> }[] };
    roots.set(root, fixture); owned = fixture;
    t.after(async () => {
      for (const { child } of fixture.children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      // close also drains child stdio; the seed and its successor must both finish before removal.
      await Promise.all(fixture.children.map(({ closed }) => closed));
      // Both directories are exact fixture-owned paths, recorded before any child was launched.
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    });
  }
  assert.equal(paths.directory, owned.directory, 'diagnostic runner directory must match the owned root');
  const child = spawn(process.execPath, ['--import', 'tsx', entry, state], {
    env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  owned.children.push({ child, closed: once(child, 'close') });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
  const call = (method: string, args: unknown[] = []) => fixtureCall(paths, method, args);
  return { child, call, stderr: () => stderr };
}


test('actual product worker promotes update-held once in the same boot; a failed cold journal parks before scans and retries explicitly', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-storage-promotion-')));
  const state = join(root, 'state');
  const paths = await runnerPaths(state);
  const hold = updatePaths(state).hold;
  await mkdir(dirname(hold), { recursive: true, mode: 0o700 });
  await writeFile(hold, 'fixture update hold', { mode: 0o600 });
  const journal = join(state, 'retention', 'journal.json');
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
  await writeFile(journal, '{incomplete journal', { mode: 0o600 });
  await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  const journalBytes = await readFile(journal);
  const context = contextOf('production');
  const installed = await installArtifact(state, context.identity.appVersion, { manifest: context.manifest });
  const packageRoot = dirname(dirname(entryPoint(installed)));
  assert.equal(packageRoot, join(installed, 'node_modules', 'agent-session-tower'));
  assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).type, 'module');
  const managedEntry = join(packageRoot, 'bin', 'diagnostic-worker.ts');
  await writeFile(managedEntry, `import ${JSON.stringify(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url).href)};\n`);
  await pointCurrent(state, context.identity.appVersion);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, managedEntry);
  let first: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!first) {
    assert.equal(child.exitCode, null, stderr());
    try { first = await call('snapshot'); } catch { if (Date.now() > deadline) assert.fail(stderr()); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(first.snapshot?.storage?.state, 'update-held');
  assert.equal(first.snapshot?.storage?.healthStatus, 200);
  assert.equal(first.snapshot?.storage?.sessionsAvailable, false);
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  // Resume the actual managed producer from a durable, sent empty-storage handoff.
  // Its serving proof comes from the real SDK consumer, never a successful proof callback.
  const bundle = threadBundle('production');
  const preflight = await storage.preflightStorage({ bundle, stateDir: state });
  assert.equal(preflight.supported, true, 'the actual supported runtime floor must pass');
  const client = await storage.openStorage({ stateDir: state, bundle });
  t.after(() => client.close());
  await assert.rejects(client.prepare({ allowMigration: false }), (error: unknown) =>
    error instanceof storage.StorageCommandError && error.code === 'migration-required' && error.disposition === 'not-committed');
  const inspection = await client.inspect();
  assert.equal(inspection.schema.kind, 'empty'); assert.equal(inspection.ownerEpoch, 0);
  // The inspector's real SDK open creates this private database before normal bootstrap is allowed.
  const databasePath = join(state, 'state.sqlite');
  const databaseBaseline = { bytes: await readFile(databasePath), info: await lstat(databasePath) };
  assert.equal(databaseBaseline.info.mode & 0o777, 0o600);
  const identity = client.identity!;
  await writeFile(join(dirname(entryPoint(installed)), 'contract.json'), JSON.stringify(artifactStorageContract(context, preflight)));
  await pointCurrent(state, identity.appVersion);
  const at = new Date().toISOString();
  const fence = { id: 'initial-release', attempt: 1 };
  const rollback: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: fence.id, from: '99.0.0', target: identity.appVersion,
    sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest,
    entrySha256: createHash('sha256').update(await readFile(entryPoint(installed))).digest('hex'), updateSha256: null,
    state: 'handing-off', by: 'fixture', reason: 'initial held release', held: true, switched: true,
    storage: { kind: 'empty' },
    handoff: { attempt: fence.attempt, state: 'sent', baseline: {
      worker: { version: '99.0.0', sourceHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64), protocol: identity.protocol, pid: process.pid, start: 'previous-fixture-process' },
      storage: { kind: 'empty' }, ownerEpoch: 0, at } },
    attempt: { n: 1, pid: process.pid, start: 'fixture', nonce: 'a'.repeat(32), kind: 'run', at, ended: true }, startedAt: at, updatedAt: at };
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(rollback), { mode: 0o600 });
  await writeFile(storageUpdatePaths(state).pin, JSON.stringify({ format: 'tower-storage-pin', version: 1,
    pinned: rollback.target, sourceHash: rollback.sourceHash, manifestDigest: rollback.manifestDigest,
    entrySha256: rollback.entrySha256, rollbackId: rollback.id, by: rollback.by, reason: rollback.reason, at }), { mode: 0o600 });
  const sdkControl = storageControl({ stateDir: state, client: () => client, successorFence: fence,
    prepareRefusal: { code: 'migration-required', disposition: 'not-committed' },
    hold: async () => { assert.fail('sent handoff must settle without a second hold'); },
    release: async () => { assert.fail('release must reach the actual diagnostic worker'); },
    quiet: () => true, handoff: () => { assert.fail('sent handoff must not be replayed'); } });
  let releaseAcks = 0;
  let releaseFailed = false;
  let releaseError: unknown;
  const ports = rollbackPorts(async (action, input) => {
    if (action !== 'release') return sdkControl(action, input);
    try {
      const stale = await call('storageControl', [action, { fence }]);
      assert.equal(stale.error?.statusCode, 409, 'the previous producer attempt cannot release the new attempt');
      const ack = await call('storageControl', [action, input]);
      assert.equal(ack.error, undefined); releaseAcks++;
      const durable = await readRollbackRecord(state);
      assert.ok(durable.state === 'present' && durable.record.state === 'completed' && durable.record.held);
      await rm(hold); // Only the producer's still-held durable intent now keeps normal admission closed.
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false);
      assert.equal((await call('create')).error?.disposition, 'not-admitted');
      await assert.rejects(client.prepare({ allowMigration: false }), (error: unknown) =>
        error instanceof storage.StorageCommandError && error.code === 'migration-required' && error.disposition === 'not-committed');
      assert.deepEqual(await client.inspect(), inspection, 'held startup neither creates schema nor claims the inspector database');
      const heldProof = await sdkControl('proof', { fence }) as ServingProof;
      assert.equal(heldProof.inspection.schema.kind, 'empty');
      assert.equal(heldProof.inspection.ownerEpoch, 0);
      assert.equal(heldProof.gate.open, false);
      assert.equal(heldProof.bootstrap, undefined, 'held startup has no normal bootstrap receipt');
      assert.deepEqual(await readFile(databasePath), databaseBaseline.bytes);
      const databaseInfo = await lstat(databasePath);
      assert.equal(databaseInfo.dev, databaseBaseline.info.dev);
      assert.equal(databaseInfo.ino, databaseBaseline.info.ino);
      assert.equal(databaseInfo.mode, databaseBaseline.info.mode);
      assert.equal(databaseInfo.mtimeMs, databaseBaseline.info.mtimeMs);
      // The inspection owner exits before the producer publishes release and normal bootstrap claims storage.
      await client.close();
    } catch (error) {
      // cleanUp preserves held completion on release failure; keep the original assertion and callsite visible.
      if (!releaseFailed) { releaseFailed = true; releaseError = error; }
      throw error;
    }
  }, async () => { assert.fail('completion must not restart the web'); });
  const running: RunningBuild = { version: identity.appVersion, manifest: context.manifest, preflight };
  const completed = await resumeRollback({ stateDir: state, running, managed: true, ports, serialize: work => work() });
  if (releaseFailed) throw releaseError;
  assert.equal(completed.state, 'completed', JSON.stringify(completed)); assert.equal(releaseAcks, 1);
  const published = await readRollbackRecord(state);
  assert.ok(published.state === 'present' && published.record.held === false && published.record.handoff?.state === 'done');
  assert.ok(published.state === 'present' && published.record.worker?.sourceHash === identity.sourceHash);
  const trusted = await evaluateStorageUpdate({ stateDir: state, build: running, managed: true });
  assert.equal(trusted.verdict, 'ready');
  assert.equal(trusted.code, 'owner-rollback', 'durable producer completion is the trusted startup authority');
  let parked: RunnerReply | undefined;
  while (parked?.snapshot?.storage?.code !== 'cold-journal-unavailable') {
    if (Date.now() > deadline) assert.fail(stderr());
    parked = await call('snapshot'); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(parked.instance, first.instance);
  assert.equal(parked.snapshot?.storage?.sessionsAvailable, false);
  assert.deepEqual(await readFile(journal), journalBytes);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  // The fixture owner repairs only its own journal; product retry must publish it before sessions resume.
  await writeFile(journal, JSON.stringify({ version: 1, migratedAt: Date.now(), entries: [] }), { mode: 0o600 });
  await call('storageRetry');
  let promoted: RunnerReply | undefined;
  while (!promoted?.snapshot?.storage?.admissionOpen) {
    if (Date.now() > deadline) assert.fail(stderr());
    promoted = await call('snapshot'); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(promoted.instance, first.instance);
  assert.equal(promoted.snapshot?.storage?.sessionsAvailable, true);
  assert.equal(promoted.snapshot?.storage?.state, 'ready');
  assert.deepEqual(promoted.snapshot?.runs, []);
  assert.equal((await call('storageStatus')).instance, first.instance);
  const serving = await call('storageControl', ['proof', { fence }]);
  assert.equal(serving.error, undefined);
  const proof = serving.result as ServingProof;
  assert.equal(proof.inspection.schema.kind, 'current'); assert.equal(proof.gate.open, true);
  assert.ok(proof.status.ownerEpoch! > 0); assert.equal(proof.bootstrap?.found, true);
  if (published.state !== 'present') assert.fail('producer publication required');
  assert.deepEqual(completionProven(published.record, proof), { ok: true }, 'the actual target bootstrap receipt, schema and claim prove the continued completion');
  const store = new RetentionStore(dirname(journal)); await store.start();
  assert.deepEqual(store.list(), []);
});


test('actual product worker refuses an unsupported captured thread before restore or SQLite open, without hiding it as an empty successful snapshot', { timeout: 90000 }, async t => {
  // Keep generated ESM under the checkout so external package resolution uses its installed dependencies.
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'w0-unsupported-fixture-'));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const entry = join(root, 'worker.mjs');
  const artifact = artifactOf('no-sqlite');
  await build({ entryPoints: [fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url))], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [buildIdentityPlugin(buildIdentityModule({ contexts: [contextOf('no-sqlite')], artifact: JSON.stringify(artifact) }))] });
  const restore = join(state, 'restore', 'pending-worker.json');
  await mkdir(dirname(restore), { recursive: true, mode: 0o700 });
  await writeFile(restore, 'original restore bytes', { mode: 0o600 });
  const before = await lstat(restore);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, entry);
  let first: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (!first) {
    assert.equal(child.exitCode, null, stderr());
    try { first = await call('snapshot'); } catch { if (Date.now() > deadline) assert.fail(stderr()); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(first.snapshot?.storage?.state, 'unavailable');
  assert.equal(first.snapshot?.storage?.healthStatus, 503);
  assert.equal(first.snapshot?.storage?.admissionOpen, false);
  assert.equal(first.snapshot?.storage?.sessionsAvailable, false);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  assert.equal((await call('sessionHistory')).error?.statusCode, 503);
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  assert.equal(await readFile(restore, 'utf8'), 'original restore bytes');
  assert.equal((await lstat(restore)).ino, before.ino);
  assert.equal((await call('snapshot')).instance, first.instance, 'there is no automatic worker respawn');
});


for (const matching of [true, false]) test(`actual successor holds an unknown cold journal regardless of observed nonce (matching=${matching})`, { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-storage-successor-'))); const state = join(root, 'state'); const paths = await runnerPaths(state);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const nonce = 'a'.repeat(32);
  await writeHandoff(paths.runtime, { previous: 'fixture-predecessor', successor: matching ? nonce : 'b'.repeat(32), version: '1.0.0', clean: true, at: new Date().toISOString(), storageTransition: true });
  const journal = join(state, 'retention', 'journal.json'); await mkdir(dirname(journal), { recursive: true, mode: 0o700 }); await writeFile(journal, '{broken fixture journal', { mode: 0o600 });
  await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  await prepareRetentionA(root, state);
  const entry = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url));
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, entry, { TOWER_HANDOFF: nonce });
  let snapshot: RunnerReply | undefined;
  const deadline = Date.now() + 60000;
  while (snapshot?.snapshot?.storage?.code !== 'cold-journal-unavailable') {
    assert.equal(child.exitCode, null, stderr());
    if (Date.now() > deadline) assert.fail(stderr());
    try { snapshot = await call('snapshot'); } catch { /* Owned child has not published its endpoint yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(snapshot?.snapshot?.storage?.sessionsAvailable, false);
  assert.equal(snapshot?.snapshot?.storage?.admissionOpen, false);
  assert.equal(await readFile(journal, 'utf8'), '{broken fixture journal', 'failed journal reads preserve the original source');
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
});

async function fixtureCall(paths: Awaited<ReturnType<typeof runnerPaths>>, method: string, args: unknown[] = []): Promise<RunnerReply> {
    const token = await readFile(paths.token, 'utf8');
    const body = JSON.stringify({ protocol: RUNNER_PROTOCOL, method, args });
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); res.on('error', reject);
      });
      req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Fixture RPC timeout'))); req.end(body);
    });
}


test('initial and poll fallback start the actual current worker behind its storage gate; restart and force cannot bypass the unknown previous build', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-storage-fallback-'))); const state = join(root, 'state'); const paths = await runnerPaths(state);
  const lock = updatePaths(state).lock; await mkdir(dirname(lock), { recursive: true, mode: 0o700 }); await writeFile(lock, 'unknown previous helper', { mode: 0o600 });
  const restore = join(state, 'restore', 'pending-worker.json'); await mkdir(dirname(restore), { recursive: true, mode: 0o700 }); await writeFile(restore, 'preserve fallback source', { mode: 0o600 });
  const children: ChildProcess[] = []; const exits: Promise<unknown>[] = []; let closing = false;
  const entry = fileURLToPath(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url));
  const commands: string[][] = [];
  const manager = new DurableRunManager({ stateDir: state, version: '99.0.0', workerEntry: entry, startupTimeoutMs: 60000, pollMs: 25, successorTimeoutMs: 0,
    handoffHeld: async () => true,
    heldWorkerEntry: async () => { throw new Error('fixture previous artifact is unverifiable'); },
    spawn: command => {
      if (closing) throw new Error('Fixture teardown already owns its direct children.');
      commands.push(command.args);
      const child = spawn(command.execPath, command.args, { env: { ...process.env, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') }, stdio: ['ignore', 'ignore', 'ignore'] });
      children.push(child); exits.push(once(child, 'exit'));
    },
  });
  t.after(async () => { closing = true; await manager.close(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await Promise.all(exits); await rm(paths.directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  await manager.start();
  assert.equal(children.length, 1); assert.ok(commands[0]!.includes(entry));
  assert.equal(manager.storageStatus()?.admissionOpen, false);
  assert.equal(manager.storageStatus()?.sessionsAvailable, false);
  await assert.rejects(manager.restartWorker(), /verifying/);
  await assert.rejects(manager.forceUpdate(0), /verifying/);
  assert.equal(children.length, 1);
  const first = await fixtureCall(paths, 'snapshot');
  await writeHandoff(paths.runtime, { previous: first.instance!, successor: 'c'.repeat(32), version: '1.0.0', clean: true, at: new Date().toISOString(), storageTransition: true });
  children[0]!.kill('SIGKILL'); await exits[0];
  const deadline = Date.now() + 60000;
  while (Number(children.length) !== 2 || manager.storageStatus()?.admissionOpen !== false) {
    if (Date.now() > deadline) assert.fail('poll fallback did not attach its diagnostic worker');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  let second: RunnerReply | undefined;
  while (!second || second.instance === first.instance) {
    if (Date.now() > deadline) assert.fail('successor fallback did not publish a distinct instance');
    try { second = await fixtureCall(paths, 'snapshot'); } catch { /* The direct owned replacement is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(second.snapshot?.storage?.admissionOpen, false); assert.equal(second.snapshot?.storage?.sessionsAvailable, false);
  assert.equal((await fixtureCall(paths, 'create')).error?.disposition, 'not-admitted');
  assert.equal(await readFile(restore, 'utf8'), 'preserve fallback source');
  assert.equal(await readFile(lock, 'utf8'), 'unknown previous helper');
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  assert.equal(children.length, 2, 'no unrequested respawn beyond the proven poll fallback');
});


for (const stage of ['1', 'late']) test(`actual SDK startup failure parks its continuation (${stage}); failed owner retry stays held and successful retry does not restart services`, { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-storage-startup-retry-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, undefined, { TOWER_FIXTURE_STORAGE_STARTUP: stage });
  const deadline = Date.now() + 60000;
  let parked: RunnerReply | undefined;
  while (!parked?.snapshot?.storage?.sessionsAvailable || parked.snapshot.storage.admissionOpen) {
    assert.equal(child.exitCode, null, stderr());
    if (Date.now() > deadline) assert.fail(stderr());
    try { parked = await call('snapshot'); } catch { /* Endpoint not published yet. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const counts = join(state, 'fixture-startup-counts.json');
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
  // sessionsAvailable can publish while the fixture is still awaiting its failure write.
  let failure: { code: string; phase: string; disposition: string } | undefined;
  while (!failure) {
    assert.equal(child.exitCode, null, stderr());
    if (Date.now() > deadline) assert.fail('Fixture startup failure file did not finish: ' + stderr());
    try { failure = JSON.parse(await readFile(join(state, 'fixture-startup-failure.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (!failure) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(failure.code, 'not-ready'); assert.equal(failure.phase, 'prepare'); assert.equal(failure.disposition, 'not-committed');
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  // Refuse one explicit retry using the existing update hold, without replacing the DB or its claim.
  const hold = updatePaths(state).hold;
  await mkdir(dirname(hold), { recursive: true, mode: 0o700 }); await writeFile(hold, 'fixture owner retry hold', { mode: 0o600 });
  await call('storageRetry');
  const failed = await call('snapshot');
  assert.equal(failed.instance, parked.instance); assert.equal(failed.snapshot?.storage?.admissionOpen, false);
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
  await rm(hold); await call('storageRetry');
  let ready = await call('snapshot');
  while (!ready.snapshot?.storage?.admissionOpen) {
    assert.equal(child.exitCode, null, stderr()); if (Date.now() > deadline) assert.fail(stderr());
    await new Promise(resolve => setTimeout(resolve, 25)); ready = await call('snapshot');
  }
  assert.equal(ready.instance, parked.instance); assert.equal(ready.snapshot?.storage?.state, 'ready');
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
  assert.deepEqual(ready.snapshot?.runs, []);
  // A late parked gate must restore the full runtime retry handler, rather than leave its startup resolver behind.
  await writeFile(hold, 'fixture second owner hold', { mode: 0o600 }); await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false);
  await rm(hold); await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, true);
  assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { permissions: 1, autoPrompts: 1 });
});

async function waitForStorage(call: (method: string, args?: unknown[]) => Promise<RunnerReply>, ready: boolean, deadline: number, worker?: { child: ChildProcess; stderr(): string }) {
  let lastRpcError: unknown;
  const diagnosis = () => `exit=${worker?.child.exitCode}, signal=${worker?.child.signalCode}; RPC=${String(lastRpcError)}; stderr=${worker?.stderr() ?? ''}`;
  for (;;) {
    if (worker && (worker.child.exitCode !== null || worker.child.signalCode !== null)) assert.fail(`Actual worker stopped: ${diagnosis()}`);
    const reply = await call('snapshot').catch(error => { lastRpcError = error; return undefined; });
    if (reply?.snapshot?.storage?.admissionOpen === ready) return reply;
    if (Date.now() > deadline) assert.fail(`Actual worker storage did not reach the requested admission state. ${diagnosis()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('normal ready worker accepts withdrawal release but resumes only after the matching durable attempt commits', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-release-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const { call } = await launchDiagnostic(t, root, state, paths);
  const deadline = Date.now() + 60000;
  const first = await waitForStorage(call, true, deadline);
  const identity = first.snapshot!.storage!.identity!;
  const at = new Date().toISOString(); const fence = { id: 'normal-withdraw', attempt: 1 };
  const rollback: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: fence.id,
    from: identity.appVersion, target: '0.0.1', sourceHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64),
    entrySha256: 'd'.repeat(64), updateSha256: null, state: 'waiting', by: 'fixture-owner', reason: 'withdraw normal hold', held: true, switched: false,
    attempt: { n: 1, pid: process.pid, start: 'fixture-parent', nonce: 'a'.repeat(32), kind: 'run', at }, startedAt: at, updatedAt: at };
  const publish = () => writeFile(storageUpdatePaths(state).rollback, JSON.stringify(rollback), { mode: 0o600 });
  await publish();
  assert.equal((await call('storageControl', ['hold', { fence }])).error, undefined);
  const ports = rollbackPorts(async (action, input) => {
    if (action !== 'release') { const reply = await call('storageControl', [action, input]); assert.equal(reply.error, undefined); return reply.result; }
    assert.equal((await call('storageControl', ['release', { fence }])).error?.statusCode, 409, 'the withdrawal claims a new producer attempt');
    assert.equal((await call('storageControl', [action, input])).error, undefined);
    const durable = await readRollbackRecord(state);
    assert.ok(durable.state === 'present' && durable.record.state === 'withdrawn' && durable.record.held);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false);
    await call('storageRetry');
    assert.equal((await call('create')).error?.disposition, 'not-admitted', 'explicit retry cannot outrun the producer commit either');
  }, async () => assert.fail('withdrawal must not restart the web'));
  const withdrawn = await withdrawRollback({ stateDir: state, ports });
  assert.equal(withdrawn.state, 'withdrawn', JSON.stringify(withdrawn));
  const committed = await readRollbackRecord(state);
  assert.ok(committed.state === 'present' && !committed.record.held && committed.record.attempt!.n === 2);
  const resumed = await waitForStorage(call, true, deadline);
  assert.equal(resumed.instance, first.instance);
  assert.equal(resumed.snapshot?.storage?.state, 'ready');
  assert.equal((await call('storageControl', ['inspect'])).error, undefined, 'the same real SQLite worker remains serving');
});

test('actual recovery RPC verifies an own failed update, preserves refusal guards, and leaves retry explicit', { timeout: 90000 }, async t => {
  // Generated external-package ESM must resolve the checkout's installed dependencies.
  const root = await realpath(await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'tw-receipt-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const journal = join(state, 'retention', 'journal.json');
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
  await writeFile(journal, '{unknown journal', { mode: 0o600 });
  await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  await prepareRetentionA(root, state);
  const worker = await launchDiagnostic(t, root, state, paths, await recoveryWorkerA122(root));
  const { call } = worker;
  const deadline = Date.now() + 60000;
  const first = await waitForStorage(call, false, deadline, worker);
  assert.equal(first.snapshot?.storage?.code, 'cold-journal-unavailable');
  assert.equal(first.snapshot?.storage?.identity?.appVersion, '1.122.0');
  assert.equal(first.snapshot?.storage?.identity?.sourceHash, '7c5ffc9947cb27e8f21b158d3136f6ea22cc971552c51327f64d6c297673be58');
  const version = first.snapshot!.storage!.identity!.appVersion;
  const at = new Date().toISOString();
  await mkdir(dirname(updatePaths(state).status), { recursive: true, mode: 0o700 });
  await writeFile(updatePaths(state).status, JSON.stringify({ version, previous: '0.0.1', stage: 'failed', code: 'check-failed', startedAt: at, updatedAt: at }), { mode: 0o600 });
  await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false);
  assert.equal((await call('storageRecovery', ['verify-update', { kind: 'invented', by: 'owner', evidence: 'verified' }])).error?.statusCode, 400);
  const wrong = await call('storageRecovery', ['verify-update', { kind: 'overwritten-done', by: 'owner', evidence: 'verified' }]);
  assert.equal((wrong.result as { recorded: boolean }).recorded, false);
  await writeFile(updatePaths(state).hold, 'fixture hold', { mode: 0o600 });
  const held = await call('storageRecovery', ['verify-update', { kind: 'own-failed', by: 'owner', evidence: 'verified' }]);
  assert.equal((held.result as { code: string }).code, 'hold');
  await rm(updatePaths(state).hold);
  const receipt = await call('storageRecovery', ['verify-update', { kind: 'own-failed', by: 'owner', evidence: 'actual worker build and update inspected', cutoverMarkers: 'absent' }]);
  assert.equal(receipt.error, undefined);
  assert.equal((receipt.result as { recorded: boolean }).recorded, true);
  const saved = JSON.parse(await readFile(storageUpdatePaths(state).receipt, 'utf8'));
  assert.equal(saved.build.sourceHash, first.snapshot!.storage!.identity!.sourceHash);
  assert.equal(saved.cutoverMarkers, 'not-applicable', 'the actual preparation-only RPC derives applicability from its captured build, independently of request body hints');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false, 'receipt alone grants no runtime resume');
  await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.code, 'cold-journal-unavailable', 'the receipt cannot bypass an unrepaired source');
  await writeFile(journal, JSON.stringify({ version: 1, migratedAt: 1234, entries: [] }), { mode: 0o600 });
  await call('storageRetry');
  assert.equal((await waitForStorage(call, true, deadline, worker)).instance, first.instance);
});

test('explicit same-worker retry rechecks a repaired private database path without changing captured build identity', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-path-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const database = join(state, 'state.sqlite'); await mkdir(database, { recursive: true, mode: 0o700 });
  const { call } = await launchDiagnostic(t, root, state, paths);
  const deadline = Date.now() + 60000;
  const held = await waitForStorage(call, false, deadline);
  assert.equal(held.snapshot?.storage?.admissionOpen, false);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  await call('storageRetry');
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false, 'unrepaired non-file DB remains refused');
  await rm(database, { recursive: true }); // Exact empty directory created by this fixture, never owner storage.
  await call('storageRetry');
  const ready = await waitForStorage(call, true, deadline);
  assert.equal(ready.instance, held.instance);
  assert.deepEqual(ready.snapshot?.storage?.identity, held.snapshot?.storage?.identity);
  assert.equal((await lstat(database)).isFile(), true);
});

test('known identity with absent DB stays held until explicit snapshot adoption and reconciliation allow same-worker retry', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-adopt-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const seed = await launchDiagnostic(t, root, state, paths);
  const deadline = Date.now() + 60000;
  await waitForStorage(seed.call, true, deadline);
  const snapshot = await seed.call('storageRecovery', ['snapshot', {}]);
  assert.equal(snapshot.error, undefined);
  const snapshotId = (snapshot.result as { id: string }).id;
  const exit = once(seed.child, 'exit'); seed.child.kill('SIGKILL'); await exit;
  for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) await rm(join(state, name), { force: true });
  const live = await launchDiagnostic(t, root, state, paths);
  const held = await waitForStorage(live.call, false, deadline);
  assert.equal(held.snapshot?.storage?.code, 'known-storage-missing');
  await live.call('storageRetry');
  assert.equal((await live.call('snapshot')).snapshot?.storage?.code, 'known-storage-missing');
  await assert.rejects(lstat(join(state, 'state.sqlite')), { code: 'ENOENT' });
  const adoption = await live.call('storageRecovery', ['adopt', { snapshotId, reason: 'fixture owner restores its missing database' }]);
  assert.equal(adoption.error, undefined);
  const barrier = adoption.result as { id: string; scopes: { scope: string }[] };
  await live.call('storageRetry');
  assert.equal((await live.call('snapshot')).snapshot?.storage?.admissionOpen, false, 'adoption never grants reconciliation');
  const reconciled = await live.call('storageRecovery', ['reconcile', { barrierId: barrier.id, scopes: barrier.scopes.map(scope => scope.scope), by: 'fixture-owner', evidence: 'snapshot and absent original verified' }]);
  assert.equal(reconciled.error, undefined);
  await live.call('storageRetry');
  assert.equal((await waitForStorage(live.call, true, deadline)).instance, held.instance);
});

test('startup diagnostic quiet tracks a live owned permission command until its actual completion', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-command-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const hold = updatePaths(state).hold; await mkdir(dirname(hold), { recursive: true, mode: 0o700 });
  await writeFile(hold, 'fixture initial diagnostic hold', { mode: 0o600 });
  const { call } = await launchDiagnostic(t, root, state, paths, undefined, { TOWER_FIXTURE_STORAGE_STARTUP: 'command' });
  const deadline = Date.now() + 60000;
  const initial = await waitForStorage(call, false, deadline);
  await rm(hold); await call('storageRetry');
  let held = await call('snapshot');
  while (held.snapshot?.storage?.code !== 'not-ready') {
    if (Date.now() > deadline) assert.fail('Actual startup gate did not park after the owned command started.');
    await new Promise(resolve => setTimeout(resolve, 25)); held = await call('snapshot');
  }
  assert.equal(held.instance, initial.instance, 'the already-open diagnostic host observes newly registered permission activity');
  assert.equal(await readFile(join(state, 'fixture-command-started'), 'utf8'), 'started\n');
  const identity = held.snapshot!.storage!.identity!; const at = new Date().toISOString();
  const rollback: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: 'command-quiet', from: identity.appVersion, target: '0.0.1', sourceHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64), entrySha256: 'd'.repeat(64), updateSha256: null, state: 'waiting', by: 'fixture-owner', reason: 'owned command busy', held: true, switched: false, startedAt: at, updatedAt: at };
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(rollback), { mode: 0o600 });
  const quiet = () => call('storageControl', ['quiet', { id: rollback.id }]);
  assert.equal(((await quiet()).result as { state: string }).state, 'pending', 'handoff is refused while the real permission child is live');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(((await quiet()).result as { state: string }).state, 'pending');
  assert.equal((await call('snapshot')).instance, held.instance);
  await writeFile(join(state, 'fixture-command-finish'), 'owner allows fixture command completion', { mode: 0o600 });
  while (((await quiet()).result as { state: string }).state !== 'quiet') {
    if (Date.now() > deadline) assert.fail('Actual owned permission command never completed.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const id = await readFile(join(state, 'fixture-command-id'), 'utf8');
  const output = JSON.parse(await readFile(join(state, 'permission-runs', `${id}.json`), 'utf8'));
  assert.match(output.stdout, /completed/);
  assert.equal((await call('snapshot')).snapshot?.storage?.admissionOpen, false, 'command completion does not resume held storage');
});

test('managed B worker exposes overwritten-done owner recovery after a later C failure; changed pointer and artifact refuse the actual RPC', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-overwritten-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const seed = await launchDiagnostic(t, root, state, paths);
  const deadline = Date.now() + 60000;
  const serving = await waitForStorage(seed.call, true, deadline);
  const identity = serving.snapshot!.storage!.identity!;
  const exit = once(seed.child, 'exit'); seed.child.kill('SIGKILL'); await exit;
  const context = contextOf('production');
  assert.equal(context.manifest.digest, identity.manifestDigest);
  const installed = await installArtifact(state, identity.appVersion, { manifest: context.manifest });
  const contractPath = join(dirname(entryPoint(installed)), 'contract.json');
  const contract = JSON.stringify({ format: 'tower-artifact-storage-contract', version: 1, appVersion: identity.appVersion, identity, manifest: context.manifest, supported: true });
  await writeFile(contractPath, contract, { mode: 0o600 });
  const managedEntry = join(dirname(entryPoint(installed)), 'diagnostic-worker.ts');
  await writeFile(managedEntry, `import ${JSON.stringify(new URL('./fixtures/storage-diagnostic-worker.ts', import.meta.url).href)};\n`);
  await pointCurrent(state, identity.appVersion);
  const at = new Date().toISOString();
  await writeFile(updatePaths(state).status, JSON.stringify({ version: '99.0.0', previous: identity.appVersion, stage: 'failed', code: 'check-failed', startedAt: at, updatedAt: at }), { mode: 0o600 });
  const live = await launchDiagnostic(t, root, state, paths, managedEntry);
  const held = await waitForStorage(live.call, false, deadline);
  assert.equal(held.snapshot?.storage?.code, 'done-overwritten');
  const verify = () => live.call('storageRecovery', ['verify-update', { kind: 'overwritten-done', by: 'fixture-owner', evidence: 'B current artifact and C failure verified' }]);
  await pointCurrent(state, '99.0.0');
  assert.equal(((await verify()).result as { code: string }).code, 'current-pointer');
  await pointCurrent(state, identity.appVersion);
  await writeFile(contractPath, '{invalid artifact');
  assert.equal(((await verify()).result as { code: string }).code, 'current-artifact');
  await writeFile(contractPath, contract, { mode: 0o600 });
  await writeFile(updatePaths(state).lock, 'unverifiable fixture helper', { mode: 0o600 });
  assert.equal(((await verify()).result as { code: string }).code, 'helper');
  await rm(updatePaths(state).lock);
  const recorded = await verify();
  assert.equal(recorded.error, undefined); assert.equal((recorded.result as { recorded: boolean }).recorded, true);
  assert.equal((await live.call('snapshot')).snapshot?.storage?.admissionOpen, false);
  await live.call('storageRetry');
  assert.equal((await waitForStorage(live.call, true, deadline)).instance, held.instance);
  const saved = JSON.parse(await readFile(storageUpdatePaths(state).receipt, 'utf8'));
  assert.equal(saved.kind, 'overwritten-done'); assert.deepEqual(saved.build, identity);
});


test('a newer actual rollback hold wins while the matching withdrawal retry awaits prepare', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-new-hold-')));
  const state = join(root, 'state'); const paths = await runnerPaths(state);
  const { call } = await launchDiagnostic(t, root, state, paths, undefined, { TOWER_FIXTURE_STORAGE_RETRY: 'new-hold' });
  const deadline = Date.now() + 60000;
  const first = await waitForStorage(call, true, deadline);
  const identity = first.snapshot!.storage!.identity!; const at = new Date().toISOString();
  const record: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: 'old-withdrawal',
    from: identity.appVersion, target: '0.0.1', sourceHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64),
    entrySha256: 'd'.repeat(64), updateSha256: null, state: 'waiting', by: 'fixture-owner', reason: 'old hold', held: true, switched: false,
    attempt: { n: 1, pid: process.pid, start: 'fixture-parent', nonce: 'a'.repeat(32), kind: 'run', at }, startedAt: at, updatedAt: at };
  const publish = () => writeFile(storageUpdatePaths(state).rollback, JSON.stringify(record), { mode: 0o600 });
  await publish();
  assert.equal((await call('storageControl', ['hold', { fence: { id: record.id, attempt: 1 } }])).error, undefined);
  const ports = rollbackPorts(async (action, input) => {
    const reply = await call('storageControl', [action, input]); assert.equal(reply.error, undefined);
    if (action === 'release') await writeFile(join(state, 'fixture-retry-arm'), 'arm', { mode: 0o600 });
    return reply.result;
  }, async () => assert.fail('withdrawal must not restart the web'));
  assert.equal((await withdrawRollback({ stateDir: state, ports })).state, 'withdrawn');
  const withdrawn = await readRollbackRecord(state);
  assert.ok(withdrawn.state === 'present' && !withdrawn.record.held && withdrawn.record.attempt?.ended);
  const retry = call('storageRetry');
  try {
    for (;;) {
      try { await readFile(join(state, 'fixture-retry-waiting')); break; }
      catch { if (Date.now() > deadline) assert.fail('The real retry prepare await was not reached.'); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    record.id = 'new-rollback'; record.state = 'waiting'; record.held = true; record.reason = 'newest owner hold';
    record.attempt = { n: 1, pid: process.pid, start: 'fixture-parent', nonce: 'e'.repeat(32), kind: 'run', at };
    await publish();
    assert.equal((await call('storageControl', ['hold', { fence: { id: record.id, attempt: 1 } }])).error, undefined, 'new durable rollback is actually accepted');
  } finally { await writeFile(join(state, 'fixture-retry-release'), 'release old await', { mode: 0o600 }); }
  assert.equal((await retry).error, undefined);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const held = await call('snapshot');
  assert.equal(held.snapshot?.storage?.admissionOpen, false);
  assert.equal(held.snapshot?.storage?.code, 'rollback-held');
  assert.equal(held.snapshot?.storage?.reason, 'newest owner hold');
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  assert.equal(held.snapshot?.runs.length, 0, 'no dispatch after the old retry resumes');
  assert.deepEqual(held.snapshot?.autoPrompts, [], 'no automation dispatch after the old retry resumes');
  const durable = await readRollbackRecord(state);
  assert.ok(durable.state === 'present' && durable.record.id === record.id && durable.record.held);
});


for (const damage of ['malformed', 'missing-source', 'missing-wrapper', 'missing-state', 'physical'] as const) test(`normal boot holds cold journal ${damage} and repeated failed retry in the same actual worker`, { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-cold-boot-')));
  const state = join(root, 'state'), paths = await runnerPaths(state);
  const deadline = Date.now() + 60000;
  if (damage !== 'malformed' && damage !== 'missing-source') {
    // Actual source-built B121 SDK/handler seeds authority, not released-package proof; the successor is current A.
    const b = await retentionBuild('1.121.0', join(root, 'authority-artifact'));
    const before = await b.storage.preflightStorage({ bundle: b.bundle(), stateDir: state });
    const initial = { stateDir: state, managed: false, legacyFiles: (domain: string) => retentionLegacyFiles(state, domain),
      build: { version: b.version, manifest: b.manifest, preflight: before } };
    assert.equal((await evaluateStorageUpdate(initial)).code, 'new-state');
    const client = await b.storage.openStorage({ stateDir: state, bundle: b.bundle() });
    try {
      const prepared = await client.prepare({ allowMigration: true });
      const update = async () => ({ ...initial, build: { ...initial.build, preflight: await b.storage.preflightStorage({ bundle: b.bundle(), stateDir: state }) } });
      await recordPreparationEvidence(state, { context: client.context!, preflight: (await update()).build.preflight, prepared, gate: await client.gate('core') });
      await retentionBootstrap(client, state, update, true)();
    } finally { await client.close(); }
    // B123 cuts over both domains: B121 retention authority alone does not satisfy whole A122 preparation.
    await prepareRetentionA(root, state);
    const db = new DatabaseSync(join(state, 'state.sqlite'));
    try {
      assert.ok(db.prepare('SELECT * FROM domain_imports WHERE domain = ?').get('retention'));
      if (damage === 'missing-state') db.prepare('DELETE FROM retention_state').run();
      if (damage === 'missing-wrapper') db.prepare("DELETE FROM retention_metadata WHERE kind = 'journal'").run();
    } finally { db.close(); }
    if (damage === 'physical') await writeFile(join(state, 'state.sqlite'), 'fixture physical SQLite corruption', { mode: 0o600 });
  }
  const journal = join(state, 'retention', 'journal.json');
  await mkdir(dirname(journal), { recursive: true, mode: 0o700 });
  await writeFile(journal, '{unknown journal', { mode: 0o600 });
  if (damage === 'malformed' || damage === 'missing-source') {
    await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
    await prepareRetentionA(root, state);
    if (damage === 'missing-source') await rm(journal);
  }
  const proof = join(state, 'launch-marks', 'cold-proof.json'); await mkdir(dirname(proof), { recursive: true, mode: 0o700 }); await writeFile(proof, 'preserve proof', { mode: 0o600 });
  const launcher = join(state, 'agent-launches.json'), native = join(root, 'claude', 'projects', 'fixture', 'known-cold.jsonl');
  await mkdir(dirname(native), { recursive: true, mode: 0o700 });
  await writeFile(native, JSON.stringify({ type: 'user', sessionId: 'known-cold', cwd: state, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'fixture cold transcript' } }) + '\n', { mode: 0o600 });
  await writeFile(launcher, JSON.stringify({ version: 1, launches: { 'claude:known-cold': ['claude:parent'] } }), { mode: 0o600 });
  const protectedBytes = await Promise.all([launcher, native].map(path => readFile(path)));
  const coldSources = damage === 'missing-source' ? [join(state, 'retention-originals', 'preserved.jsonl'), join(state, 'retention-cold', 'preserved.jsonl')] : [];
  for (const path of coldSources) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, 'preserve cold source', { mode: 0o600 }); }
  const coldBefore = await Promise.all(coldSources.map(async path => ({ bytes: await readFile(path), info: await lstat(path) })));
  const before = await lstat(proof);
  const live = await launchDiagnostic(t, root, state, paths, undefined, { TOWER_FIXTURE_COLD_COUNTS: '1' });
  const held = await waitForStorage(live.call, false, deadline);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await live.call('snapshot'), status = snapshot.snapshot!.storage!;
    assert.equal(snapshot.instance, held.instance);
    assert.equal(status.admissionOpen, false); assert.equal(status.sessionsAvailable, false); assert.equal(status.healthStatus, 503);
    if (damage === 'physical') { assert.notEqual(status.code, 'cold-journal-unavailable'); assert.ok(status.failure); }
    else { assert.equal(status.code, 'cold-journal-unavailable'); assert.equal(status.failure, undefined, 'healthy shared SDK is distinct from physical failure'); }
    assert.equal((await live.call('sessionHistory')).error?.statusCode, 503);
    assert.equal((await live.call('create')).error?.disposition, 'not-admitted');
    assert.deepEqual(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')), { scanner: 0, temporary: 0, native: 0 });
    assert.equal(await readFile(proof, 'utf8'), 'preserve proof'); assert.equal((await lstat(proof)).mtimeMs, before.mtimeMs);
    if (damage === 'missing-source') {
      await assert.rejects(lstat(journal), { code: 'ENOENT' });
      for (const [index, path] of coldSources.entries()) {
        assert.deepEqual(await readFile(path), coldBefore[index].bytes);
        const info = await lstat(path); assert.equal(info.ino, coldBefore[index].info.ino); assert.equal(info.mtimeMs, coldBefore[index].info.mtimeMs);
      }
    } else assert.equal(await readFile(journal, 'utf8'), '{unknown journal');
    assert.deepEqual(await Promise.all([launcher, native].map(path => readFile(path))), protectedBytes, 'unknown cold state never prunes launcher proof or changes native transcript');
    if (attempt < 2) await live.call('storageRetry');
  }
  if (damage === 'physical') return; // physical schema damage requires the existing SDK recovery contract
  const knownMember = { sessionId: 'claude:known-cold', provider: 'claude', nativeId: 'known-cold', isSubagent: false,
    createdAt: '2026-10-01T00:00:00.000Z', operationId: 'known-operation', state: 'cold',
    originalPath: join(root, 'claude', 'projects', 'fixture', 'known-cold.jsonl'),
    coldPath: join(state, 'retention-originals', 'known-cold.jsonl'), identity: { dev: 1, ino: 2, size: 3, mtimeMs: 4 } };
  const knownEntry = { id: 'known-operation', phase: 'archived', archiveRevision: 1, candidate: { ids: ['claude:known-cold'] }, members: [knownMember] };
  if (damage === 'malformed' || damage === 'missing-source') await writeFile(journal, JSON.stringify({ version: 1, migratedAt: 1234, entries: [knownEntry] }), { mode: 0o600 });
  else {
    const db = new DatabaseSync(join(state, 'state.sqlite'));
    try {
      db.prepare('INSERT INTO retention_metadata (kind,id,ordinal,json) VALUES (?,?,?,?)').run('entry', knownEntry.id, 0, JSON.stringify(knownEntry));
      if (damage === 'missing-state') db.prepare('INSERT INTO retention_state VALUES (1,1)').run();
      else db.prepare('INSERT INTO retention_metadata (kind,id,ordinal,json) VALUES (?,?,?,?)').run('journal', '', 0, JSON.stringify({ version: 1, migratedAt: 1234, entries: [] }));
    } finally { db.close(); }
  }
  await live.call('storageRetry');
  const resumed = await waitForStorage(live.call, true, deadline);
  assert.equal(resumed.instance, held.instance); assert.equal(resumed.snapshot?.storage?.sessionsAvailable, true);
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')).scanner, 1);
  const registry = JSON.parse(await readFile(join(state, 'fixture-cold-registry.json'), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(join(state, 'fixture-firstscan-registry.json'), 'utf8')), registry, 'known registry precedes the actual first scan');
  assert.ok(registry.ids.includes('claude:known-cold')); assert.ok(registry.paths.includes(knownMember.originalPath));
  assert.equal(resumed.snapshot?.sessions.some(session => session.id === 'claude:known-cold'), false);
});


test('a durable owner hold accepted at the actual bootstrap success response parks restore until explicit release and retry', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-bootstrap-hold-'))), state = join(root, 'state');
  const paths = await runnerPaths(state), deadline = Date.now() + 60000;
  await mkdir(join(state, 'retention'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'retention', 'journal.json'), JSON.stringify({ version: 1, migratedAt: 1, entries: [], policies: [] }), { mode: 0o600 });
  await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  // The initial partial source failure opens the existing diagnostic RPC before retry imports all three files.
  await writeFile(join(state, 'runs.json'), '[]', { mode: 0o600 });
  await prepareTriggersA124(root, state);
  const pending = join(state, 'restore', 'pending-worker.json'), applying = join(state, 'restore', 'applying-worker.json');
  const settings = join(state, 'models.json');
  const oldSettings = JSON.stringify({ version: 1, roles: {}, custom: [] });
  const incoming = { version: 1, roles: {}, custom: [{ id: 'fixture.restore', provider: 'codex', claude: {}, codex: { model: 'fixture-restored' } }] };
  const restoreId = '11111111-1111-4111-8111-111111111111';
  const encryptedVault = Buffer.from(JSON.stringify({ format: 1, vaultId: 'fixture-encrypted', wrappedKey: {}, payload: {} })).toString('base64');
  await mkdir(dirname(pending), { recursive: true, mode: 0o700 });
  await writeFile(settings, oldSettings, { mode: 0o600 });
  await writeFile(pending, JSON.stringify({ id: restoreId, files: { 'models.json': incoming }, encryptedVault }), { mode: 0o600 });
  const pendingBytes = await readFile(pending), pendingInfo = await lstat(pending), settingsInfo = await lstat(settings);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, await futureBWorker(t,root), { TOWER_FIXTURE_COLD_COUNTS: '1', TOWER_FIXTURE_RUNS_BOOTSTRAP: 'new-hold' });
  const first = await waitForStorage(call, false, deadline);
  assert.equal(first.snapshot?.storage?.code, 'runs-bootstrap-held');
  await writeFile(join(state, 'created-sessions.json'), '[]', { mode: 0o600 });
  await writeFile(join(state, 'run-instructions.json'), '{}', { mode: 0o600 });
  assert.equal((await call('storageRetry')).error, undefined);
  for (;;) {
    assert.equal(child.exitCode, null, stderr());
    try { await readFile(join(state, 'fixture-bootstrap-waiting')); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const committed = await call('storageControl', ['inspect']);
  assert.equal(committed.error, undefined);
  const runsAuthority = (committed.result as { authority: { domain: string; authority: string; generation: number; appVersion: string }[] }).authority.find(domain => domain.domain === 'runs');
  assert.ok(runsAuthority);
  assert.equal(runsAuthority.authority, 'database'); assert.equal(runsAuthority.generation, 1); assert.equal(runsAuthority.appVersion, '1.125.0');
  const at = new Date().toISOString(), identity = first.snapshot!.storage!.identity!;
  const fence = { id: 'bootstrap-new-owner-hold', attempt: 1 };
  const record: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: fence.id,
    from: identity.appVersion, target: '0.0.1', sourceHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64), entrySha256: 'd'.repeat(64), updateSha256: null,
    state: 'waiting', by: 'fixture-owner', reason: 'new hold before restore', held: true, switched: false,
    attempt: { n: 1, pid: process.pid, start: 'fixture-parent', nonce: 'a'.repeat(32), kind: 'run', at }, startedAt: at, updatedAt: at };
  await mkdir(dirname(storageUpdatePaths(state).rollback), { recursive: true, mode: 0o700 });
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(record), { mode: 0o600 });
  assert.equal((await call('storageControl', ['hold', { fence }])).error, undefined, 'actual diagnostic RPC accepts the valid durable owner hold');
  await writeFile(join(state, 'fixture-bootstrap-release'), 'return successful product bootstrap', { mode: 0o600 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const held = await call('snapshot');
  assert.equal(held.instance, first.instance); assert.equal(held.snapshot?.storage?.admissionOpen, false);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  assert.deepEqual(await readFile(pending), pendingBytes);
  const heldPending = await lstat(pending);
  assert.equal(heldPending.ino, pendingInfo.ino); assert.equal(heldPending.mtimeMs, pendingInfo.mtimeMs);
  await assert.rejects(lstat(applying), { code: 'ENOENT' });
  assert.equal(await readFile(settings, 'utf8'), oldSettings);
  assert.equal((await lstat(settings)).ino, settingsInfo.ino); assert.equal((await lstat(settings)).mtimeMs, settingsInfo.mtimeMs);
  assert.deepEqual(await listPendingSecretImports(state), [], 'the held restore never stages its Vault');
  assert.deepEqual(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')), { scanner: 0, temporary: 0, native: 0 });
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-bootstrap-successes.json'), 'utf8')), 1);
  const durable = await readRollbackRecord(state);
  assert.ok(durable.state === 'present' && durable.record.id === fence.id && durable.record.held);
  // Publish the committed owner withdrawal, then explicitly release/retry the parked continuation.
  record.state = 'withdrawn'; record.held = false; record.attempt!.ended = true;
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify(record), { mode: 0o600 });
  assert.equal((await call('storageControl', ['release', { fence }])).error, undefined);
  assert.equal((await call('storageRetry')).error, undefined);
  const ready = await waitForStorage(call, true, deadline);
  assert.equal(ready.instance, first.instance);
  for (;;) {
    try {
      await readFile(join(state, 'restore', `outcome-${restoreId}.json`));
      try { await lstat(applying); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error; }
    if (Date.now() > deadline) assert.fail('The same boot did not finish its actual restore.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await assert.rejects(lstat(pending), { code: 'ENOENT' });
  await assert.rejects(lstat(applying), { code: 'ENOENT' });
  const restored = JSON.parse(await readFile(settings, 'utf8'));
  assert.deepEqual(restored.custom, incoming.custom);
  assert.equal((await listPendingSecretImports(state)).length, 1);
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')).scanner, 1);
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-bootstrap-successes.json'), 'utf8')), 1, 'release resumes the same bootstrap continuation without replay');
  await call('storageRetry');
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')).scanner, 1);
  assert.equal((await listPendingSecretImports(state)).length, 1);
});

test('actual prestart B patient handoff preserves nonempty partial runs sources without import evidence', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-runs-prestart-handoff-'))), state = join(root, 'state');
  const paths = await runnerPaths(state), deadline = Date.now() + 60000;
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(join(state, 'retention'), { mode: 0o700 });
  await writeFile(join(state, 'retention', 'journal.json'), JSON.stringify({ version: 1, migratedAt: 1, entries: [], policies: [] }), { mode: 0o600 });
  await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  const id = '10000000-0000-4000-8000-000000000001', sessionId = 'codex:monitor-10000000-0000-4000-8000-000000000002';
  const at = '2026-10-01T00:00:00.000Z';
  const runs = Buffer.from(JSON.stringify([{ id, sessionId, prompt: 'Preserve accepted work', status: 'queued', createdAt: at, output: '', needsInstructions: true, keepQueued: true, retain: true }], null, 2) + '\n');
  const created = Buffer.from(JSON.stringify([{ session: { id: sessionId, nativeId: '', provider: 'codex', title: 'Preserve provenance', cwd: root, project: 'fixture', status: 'idle', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: false, creationPending: true }, runId: id, confirmed: false, origin: { kind: 'owner', untrustedInput: false } }], null, 2) + '\n');
  // Validate the nonempty source records; the dependency stays missing on disk throughout.
  const valid = parseRunDocuments({ runs, created, instructions: Buffer.from(JSON.stringify({ [id]: { text: 'Missing private dependency', required: true } })) });
  assert.equal(valid.runs.length, 1); assert.equal(valid.created.length, 1);
  const sourcePaths = [join(state, 'runs.json'), join(state, 'created-sessions.json')];
  await writeFile(sourcePaths[0], runs, { mode: 0o600 });
  await writeFile(sourcePaths[1], created, { mode: 0o600 });
  const before = await Promise.all(sourcePaths.map(async path => ({ bytes: await readFile(path), info: await lstat(path) })));
  await prepareTriggersA124(root,state);
  const worker = await launchDiagnostic(t, root, state, paths, await futureBWorker(t,root), { TOWER_FIXTURE_COLD_COUNTS: '1' });
  let held = await waitForStorage(worker.call, false, deadline, worker);
  while (held.snapshot?.storage?.code !== 'runs-bootstrap-held') {
    assert.equal(worker.child.exitCode, null, worker.stderr());
    if (Date.now() > deadline) assert.fail(`Bootstrap did not hold: ${worker.stderr()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
    held = await worker.call('snapshot');
  }
  assert.equal(held.snapshot?.storage?.code, 'runs-bootstrap-held');
  assert.equal(held.snapshot?.storage?.sessionsAvailable, false);
  assert.equal((await worker.call('create')).error?.disposition, 'not-admitted');
  const preserved = async () => {
    for (const [index, path] of sourcePaths.entries()) {
      const bytes = await readFile(path), info = await lstat(path);
      assert.deepEqual(bytes, before[index].bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(before[index].bytes).digest('hex'));
      assert.equal(info.ino, before[index].info.ino); assert.equal(info.mtimeMs, before[index].info.mtimeMs);
    }
    await assert.rejects(lstat(join(state, 'run-instructions.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(state, 'runs-storage-migrations')), [], 'an empty parent is not a sealed backup');
    assert.deepEqual(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')), { scanner: 0, temporary: 0, native: 0 });
    const db = new DatabaseSync(join(state, 'state.sqlite'), { readOnly: true });
    try {
      for (const sql of ["SELECT * FROM domain_imports WHERE domain = 'runs'", 'SELECT * FROM runs_state', 'SELECT * FROM runs_rows', 'SELECT * FROM runs_stages', 'SELECT * FROM runs_stage_chunks', "SELECT * FROM operation_receipts WHERE scope = 'runs'"]) assert.deepEqual(db.prepare(sql).all(), []);
    } finally { db.close(); }
  };
  await preserved();
  // Exercise the real patient handoff/quiesce/close, but deliberately give it no executable
  // successor: no detached worker can mutate the sources or escape this fixture's ownership.
  const absentSuccessor = join(root, 'absent-successor');
  await assert.rejects(lstat(absentSuccessor), { code: 'ENOENT' });
  const closed = once(worker.child, 'close');
  assert.equal((await worker.call('requestHandoff', [{ execPath: absentSuccessor, args: ['--runner-worker', state] }, { patient: true }])).error, undefined);
  await closed;
  assert.equal(worker.child.exitCode, 0, worker.stderr());
  const handoff = await readHandoff(paths.runtime);
  assert.ok(handoff?.clean); assert.equal(handoff.previous, held.instance); assert.equal(handoff.storageTransition, true);
  assert.match(worker.stderr(), /Could not start the successor execution worker/);
  await preserved();
});

test('actual B runs bootstrap parks before scans and admits once after explicit source repair', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-runs-bootstrap-retry-'))), state = join(root, 'state');
  const paths = await runnerPaths(state);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(join(state, 'retention'), { mode: 0o700 });
  await writeFile(join(state, 'retention', 'journal.json'), JSON.stringify({ version: 1, migratedAt: 1, entries: [], policies: [] }), { mode: 0o600 });
  await writeFile(join(state, 'retention-observations.json'), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  await writeFile(join(state, 'runs.json'), '[]', { mode: 0o600 });
  await prepareTriggersA124(root,state);
  const { child, call, stderr } = await launchDiagnostic(t, root, state, paths, await futureBWorker(t,root), { TOWER_FIXTURE_COLD_COUNTS: '1' });
  const deadline = Date.now() + 60000;
  let snapshot: RunnerReply | undefined;
  while (snapshot?.snapshot?.storage?.code !== 'runs-bootstrap-held') {
    assert.equal(child.exitCode, null, stderr()); if (Date.now() > deadline) assert.fail(stderr());
    try { snapshot = await call('snapshot'); } catch { /* Diagnostic endpoint is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const heldCounts = JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8'));
  assert.deepEqual(heldCounts, { scanner: 0, temporary: 0, native: 0 });
  assert.equal(snapshot.snapshot?.storage?.sessionsAvailable, false);
  assert.equal(snapshot.snapshot?.storage?.admissionOpen, false);
  assert.equal((await call('create')).error?.disposition, 'not-admitted');
  await call('storageRetry');
  // A ready SDK with admission still closed is not the failed bootstrap's next parked continuation.
  // Wait for that actual failure before repairing the source and sending its explicit retry.
  let reparking = await call('snapshot');
  while (reparking.snapshot?.storage?.code !== 'runs-bootstrap-held') {
    assert.equal(child.exitCode, null, stderr());
    if (Date.now() > deadline) assert.fail(JSON.stringify(reparking.snapshot?.storage) + stderr());
    await new Promise(resolve => setTimeout(resolve, 25)); reparking = await call('snapshot');
  }
  assert.equal(reparking.snapshot?.storage?.admissionOpen, false);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')), heldCounts);
  await writeFile(join(state, 'created-sessions.json'), '[]', { mode: 0o600 });
  await writeFile(join(state, 'run-instructions.json'), '{}', { mode: 0o600 });
  await call('storageRetry');
  let ready = await call('snapshot');
  while (!ready.snapshot?.storage?.admissionOpen) {
    assert.equal(child.exitCode, null, stderr()); if (Date.now() > deadline) assert.fail(JSON.stringify(ready.snapshot?.storage) + stderr());
    await new Promise(resolve => setTimeout(resolve, 25)); ready = await call('snapshot');
  }
  assert.equal(ready.instance, snapshot.instance);
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')).scanner, 1);
  await call('storageRetry');
  assert.equal(JSON.parse(await readFile(join(state, 'fixture-cold-counts.json'), 'utf8')).scanner, 1);
});

test('actual A124 worker adds only trigger preparation over retained 123 SQL authorities and records whole evidence before admission', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'tower-trigger-prep-worker-'))), state = join(root,'state'), paths = await runnerPaths(state);
  const previous = await retentionBuild('1.123.0',join(root,'previous-artifact'));
  const client = await previous.storage.openStorage({ stateDir: state,bundle: previous.bundle() });
  await client.prepare({ allowMigration: true });
  await new RunsRepository(client).importPrepared({ runs: [],created: [],instructions: {} },'a'.repeat(64),'retained-runs');
  await new RetentionRepository(client).importPrepared({ journal: { version: 1,migratedAt: 1234,entries: [],policies: [] },observations: { version: 1,entries: [] } },'a'.repeat(64),'retained-retention');
  const authorities = (await client.inspect()).authority; await client.close();
  const source = JSON.stringify({ version: 1,onceConsumed: { deleted: { at: '2026-10-01T00:00:00Z' } },triggers: [],revisions: {},tombstones: [],cursors: {},events: [],fired: {},audit: [],secretGrants: {},settings: { maxTriggers: 50,maxConcurrentRuns: 3,maxEventsPerHour: 60,privateHosts: [] },trustedFolders: [],recentFires: [] });
  await writeFile(join(state,'trigger-engine.json'),source,{ mode: 0o600 });
  const { child,call,stderr } = await launchDiagnostic(t,root,state,paths);
  let ready: RunnerReply | undefined; const deadline = Date.now() + 60000;
  while (!ready?.snapshot?.storage?.admissionOpen) {
    assert.equal(child.exitCode,null,stderr());
    try { ready = await call('snapshot'); } catch { assert.equal(child.exitCode,null,stderr()); }
    if (Date.now() > deadline) assert.fail(`A124 never became ready: ${JSON.stringify(ready)} ${stderr()}`);
    await new Promise(resolve => setTimeout(resolve,25));
  }
  assert.equal(ready!.snapshot!.storage!.state,'ready');
  const db = new DatabaseSync(join(state,'state.sqlite'),{ readOnly: true });
  assert.deepEqual(db.prepare('SELECT domain,generation,manifest_sha256 FROM domain_imports ORDER BY domain').all().map(row => ({ domain: row.domain,generation: row.generation,manifestSha256: row.manifest_sha256 })),authorities.sort((a,b) => a.domain.localeCompare(b.domain)).map(row => ({ domain: row.domain,generation: row.generation,manifestSha256: row.manifestSha256 })));
  assert.equal((db.prepare('SELECT count(*) AS n FROM triggers_rows').get() as { n: number }).n,0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM triggers_stages').get() as { n: number }).n,0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM operation_receipts WHERE scope = 'triggers'").get() as { n: number }).n,0);
  db.close();
  const evidence = await Promise.all(['retention','runs','triggers'].map(async domain => JSON.parse(await readFile(join(state,'storage-contracts',`${domain}.json`),'utf8'))));
  for (const item of evidence) { assert.equal(item.preparationVersion,'1.124.0'); assert.deepEqual(item.manifest.domains.map((domain: { scope: string }) => domain.scope),['retention','runs','triggers']); assert.ok(item.manifest.domains.every((domain: { cutover?: unknown }) => domain.cutover === undefined)); }
  assert.deepEqual(evidence.map(item => item.manifest),[evidence[0].manifest,evidence[0].manifest,evidence[0].manifest]);
  assert.deepEqual(JSON.parse(await readFile(join(state,'trigger-engine.json'),'utf8')).onceConsumed,{ deleted: { at: '2026-10-01T00:00:00Z' } });
  const backup = await call('triggersBackup'); assert.equal(backup.error,undefined); assert.deepEqual((backup.result as { onceConsumed: unknown }).onceConsumed,{ deleted: { at: '2026-10-01T00:00:00Z' } });
});
