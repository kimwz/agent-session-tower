import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMonitorServer } from '../../../server/http/server.js';
import { storageWebHealth, storageWebServing } from '../../../server/link/storage-web.js';
import { artifactStorageContract, readRollbackRecord, runRollback, type RollbackFence } from '../../../server/link/storage-update.js';
import { rollbackPorts, storageControl } from '../../../server/runs/storage-control.js';
import { entryPoint, pointCurrent } from '../../../server/link/service.js';
import { Updates } from '../../../server/link/update.js';
import { storageManifest } from '../../../server/storage/schema.js';
import { buildIdentityModule, buildIdentityPlugin, STORAGE_THREAD_ENTRY } from '../../../server/storage/thread-bundle.mjs';
import { contextOf, fixtureParentFile, stateDir, storage, threadBundle } from '../storage/helpers.js';
import { installArtifact } from './fixtures/storage-builds.js';

test('serving target web resumes only the durable owner rollback through the real executor and SDK successor consumer', { timeout: 90000 }, async t => {
  const state = await stateDir(t);
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'storage-web-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Build the existing SDK fixture as the newer predecessor, using the real runtime gate and core schema.
  const version = '99.0.0';
  const versionPlugin = { name: 'fixture-release', setup(builder: import('esbuild').PluginBuild) {
    builder.onLoad({ filter: /shared\/app-identity\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${version}';`), loader: 'ts' }));
  } };
  const thread = await build({ entryPoints: [STORAGE_THREAD_ENTRY], bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', plugins: [versionPlugin], logLevel: 'silent' });
  const body = thread.outputFiles[0].text;
  const sourceHash = createHash('sha256').update(body).digest('hex');
  const artifact = { format: 'tower-storage-thread-bundle/2', sourceHash, source: `var __TOWER_STORAGE_SOURCE_HASH__ = "${sourceHash}";\n${body}` };
  const manifest = storageManifest([], version);
  const parentFile = join(root, 'predecessor.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../storage/fixtures/parent.ts', import.meta.url))], outfile: parentFile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [versionPlugin, buildIdentityPlugin(buildIdentityModule({ contexts: [{ sourceHash, manifest }] }))] });
  const predecessor = await import(pathToFileURL(parentFile).href) as typeof storage;
  const bundle = predecessor.storageBundleFromArtifact(JSON.stringify(artifact), 'artifact');
  const preflight = await predecessor.preflightStorage({ bundle, stateDir: state });
  assert.equal(preflight.supported, true, 'actual supported SQLite required; no runtime gate substitution');
  const client = await predecessor.openStorage({ stateDir: state, bundle });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  const targetContext = contextOf('production');
  const target = targetContext.identity.appVersion;
  const targetPreflight = await storage.preflightStorage({ bundle: threadBundle('production'), stateDir: state });
  assert.equal(targetPreflight.supported, true);
  for (const [release, context, checked] of [[version, predecessor.storageBuildContext(bundle), preflight], [target, targetContext, targetPreflight]] as const) {
    assert.ok(context.ok);
    const installed = await installArtifact(state, release, { manifest: context.manifest });
    await writeFile(join(dirname(entryPoint(installed)), 'contract.json'), JSON.stringify(artifactStorageContract(context, checked)));
  }
  await pointCurrent(state, version);
  let held = false; let handoffs = 0; let successorFence: RollbackFence | undefined;
  const control = storageControl({ stateDir: state, client: () => client, hold: async () => { held = true; }, release: async () => { held = false; }, quiet: () => true,
    handoff: (_command, fence) => { handoffs++; successorFence = fence; } });
  const updates = new Updates({ stateDir: state, version, port: 1, managed: true, spawnHelper: () => {} });
  const serialize = <T>(work: () => Promise<T>) => updates.exclusive(work);
  const ports = rollbackPorts(control, async () => {});
  const switched = await runRollback({ stateDir: state, managed: true, running: { version, manifest, preflight }, ports, serialize }, { target, by: 'owner', reason: 'existing owned operation' });
  assert.equal(switched.state, 'switched'); assert.equal(held, true); assert.equal(handoffs, 0);
  const running = { version: target, manifest: targetContext.manifest, preflight: targetPreflight };
  const web = createMonitorServer({ port: 0, clientDir: root, service: true,
    storageWebHealth: () => storageWebHealth({ stateDir: state, managed: true, build: running }),
    backend: { snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: target, updatedAt: new Date().toISOString() }), detail: async () => undefined,
      enqueue: async () => { throw new Error('No intake in held fixture.'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.dispose(); web.server.closeAllConnections(); await new Promise<void>(resolve => web.server.close(() => resolve())); });
  assert.equal((await fetch(`http://127.0.0.1:${(web.server.address() as { port: number }).port}/api/health`)).status, 200, 'target web actually serves while the existing rollback holds intake');
  // Unknown target build must not dispatch a successor; the executor retains the durable hold.
  const refused = await storageWebServing({ stateDir: state, managed: true, running: { ...running, preflight: { ...targetPreflight, identity: { ...targetContext.identity, sourceHash: 'f'.repeat(64) } } }, ports, serialize });
  assert.equal(refused?.state, 'refused'); assert.equal(handoffs, 0); assert.equal(held, true);
  // The fixture successor is an owned child using the existing SDK build and the actual storageControl consumer.
  const script = join(root, 'successor.mjs');
  await writeFile(script, `import * as sdk from ${JSON.stringify(pathToFileURL(fixtureParentFile).href)};
import { storageControl } from ${JSON.stringify(new URL('../../../server/runs/storage-control.ts', import.meta.url).href)};
const stateDir = process.argv[2]; const fence = JSON.parse(process.argv[3]);
const client = await sdk.openStorage({stateDir, bundle: sdk.storageBundleFromArtifact(process.argv[4], 'artifact')});
await client.prepare({allowMigration:false});
const call = storageControl({stateDir, client:()=>client, successorFence:fence, hold:async()=>{}, release:async()=>{}, quiet:()=>true, handoff:()=>{throw new Error('duplicate successor');}});
process.on('message', async message => { try { process.send({id:message.id, result:await call(message.action, message.input)}); } catch(error) { process.send({id:message.id, error:String(error)}); } });
process.send({ready:true});`);
  let child: ReturnType<typeof spawn> | undefined;
  let childReady: Promise<void> | undefined;
  let sequence = 0;
  const targetPorts = rollbackPorts(async (action, input) => {
    if (!successorFence) {
      const answer = await control(action, input);
      if (action === 'handoff' && successorFence) {
        await client.close();
        const { artifactOf } = await import('../storage/helpers.js');
        child = spawn(process.execPath, ['--import', 'tsx', script, state, JSON.stringify(successorFence), JSON.stringify(artifactOf('production'))], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = '';
        child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
        const ended = once(child, 'exit');
        t.after(async () => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); await ended; });
        childReady = new Promise((resolve, reject) => { child!.on('message', message => { if ((message as { ready?: boolean }).ready) resolve(); }); child!.once('exit', code => reject(new Error(`successor exited ${code}: ${stderr}`))); });
      }
      return answer;
    }
    await childReady;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const listener = (message: unknown) => { const reply = message as { id: number; result?: unknown; error?: string }; if (reply.id !== id) return; child!.off('message', listener); if (reply.error) reject(new Error(reply.error)); else resolve(reply.result); };
      child!.on('message', listener); child!.send({ id, action, input });
    });
  }, async () => { assert.fail('target web does not restart for continuation'); });
  const outcome = await storageWebServing({ stateDir: state, managed: true, running, ports: targetPorts, serialize });
  assert.equal(outcome?.state, 'completed', JSON.stringify(outcome)); assert.equal(handoffs, 1);
  const durable = await readRollbackRecord(state);
  assert.ok(durable.state === 'present' && !durable.record.held && durable.record.handoff?.state === 'done');
  if (durable.state !== 'present') assert.fail('durable completion required');
  await assert.rejects(targetPorts.holdAdmission({ id: durable.record.id, attempt: durable.record.attempt!.n - 1 }, 'stale'));
  assert.equal(handoffs, 1, 'stale control and completed startup never duplicate dispatch');
  assert.equal((await storageWebServing({ stateDir: state, managed: true, running, ports: targetPorts, serialize }))?.state, 'completed');
  assert.equal(handoffs, 1);
});
