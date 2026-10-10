import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { startRunnerHost } from '../../../server/runs/worker.js';
import { RunManager } from '../../../server/runs/manager.js';
import { importFixtureRuns, stopFixtureWriter } from '../runs/sql-fixture.js';
import { SessionService } from '../../../server/sessions/service.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMonitorServer } from '../../../server/http/server.js';
import { storageWebHealth, storageWebServing } from '../../../server/link/storage-web.js';
import { artifactStorageContract, storageUpdatePaths, readRollbackRecord, runRollback, type RollbackFence, type ServingProof } from '../../../server/link/storage-update.js';
import { rollbackPorts, storageControl } from '../../../server/runs/storage-control.js';
import { entryPoint, pointCurrent } from '../../../server/link/service.js';
import { Updates } from '../../../server/link/update.js';
import { STORAGE_DOMAIN_SCHEMAS, storageManifest } from '../../../server/storage/schema.js';
import { buildIdentityModule, buildIdentityPlugin, STORAGE_THREAD_ENTRY } from '../../../server/storage/thread-bundle.mjs';
import { contextOf, fixtureParentFile, stateDir, storage, threadBundle } from '../storage/helpers.js';
import { installArtifact } from './fixtures/storage-builds.js';

test('serving target web resumes only the durable owner rollback through the real executor and SDK successor consumer', { timeout: 90000 }, async t => {
  const state = await stateDir(t);
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'storage-web-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Use the existing B runs import contract in both the manifest and the registered thread domain.
  const version = '99.0.0';
  const runsCutover = { artifactVersion: '1.123.0', importContract: 1 };
  const versionPlugin = { name: 'fixture-release', setup(builder: import('esbuild').PluginBuild) {
    builder.onLoad({ filter: /server\/runs\/storage-schema\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/domain: 'runs',/, `domain: 'runs', cutover: ${JSON.stringify(runsCutover)},`), loader: 'ts' }));
    builder.onLoad({ filter: /shared\/app-identity\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${version}';`), loader: 'ts' }));
  } };
  const thread = await build({ entryPoints: [STORAGE_THREAD_ENTRY], bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', plugins: [versionPlugin], logLevel: 'silent' });
  const body = thread.outputFiles[0].text;
  const sourceHash = createHash('sha256').update(body).digest('hex');
  const artifact = { format: 'tower-storage-thread-bundle/2', sourceHash, source: `var __TOWER_STORAGE_SOURCE_HASH__ = "${sourceHash}";\n${body}` };
  const manifest = storageManifest(STORAGE_DOMAIN_SCHEMAS.map(schema => schema.domain === 'runs' ? { ...schema, cutover: runsCutover } : schema), version);
  const parentFile = join(root, 'predecessor.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../storage/fixtures/parent.ts', import.meta.url))], outfile: parentFile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [versionPlugin, buildIdentityPlugin(buildIdentityModule({ artifact: JSON.stringify(artifact), contexts: [{ sourceHash, manifest }] }))] });
  const predecessor = await import(pathToFileURL(parentFile).href) as typeof storage;
  const bundle = predecessor.storageBundleFromArtifact(JSON.stringify(artifact), 'artifact');
  const preflight = await predecessor.preflightStorage({ bundle, stateDir: state });
  assert.equal(preflight.supported, true, 'actual supported SQLite required; no runtime gate substitution');
  const client = await predecessor.openStorage({ stateDir: state, bundle });
  assert.equal(client.context?.identity.sourceHash, sourceHash);
  assert.deepEqual(client.context?.manifest, manifest);
  t.after(async () => { await stopFixtureWriter(runs); await client.close(); });
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
  let held = false; let handoffs = 0; let successorFence: RollbackFence | undefined; let evidenceLost = false;
  let hostDispatch: Parameters<NonNullable<import('../../../server/runs/worker.js').RunnerHostOptions['storageControl']>>[2] | undefined;
  const control = storageControl({ stateDir: state, client: () => client, hold: async () => { held = true; }, release: async () => { held = false; }, quiet: () => true,
    acceptedFence: () => evidenceLost ? { id: 'other-operation', attempt: 1 } : successorFence,
    handoff: (command, fence) => { handoffs++; successorFence = fence; hostDispatch!.handoff(command, fence); } });
  const updates = new Updates({ stateDir: state, version, port: 1, managed: true, spawnHelper: () => {} });
  const serialize = <T>(work: () => Promise<T>) => updates.exclusive(work);
  const sessions = new SessionService({ codexHome: join(root, 'codex'), claudeHome: join(root, 'claude'),
    inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } }) });
  sessions.list = () => [];
  await importFixtureRuns(client);
  const runs = new RunManager({ stateDir: state, storage: client, getSession: () => undefined, refreshSessions: async () => {},
    spawnProcess: () => { throw new Error('Native providers forbidden'); } });
  await runs.start();
  let child: ReturnType<typeof spawn> | undefined;
  let successorReady = false;
  let snapshotAdoptedBeforeProof = false;
  let proofOrderingStarted = false;
  let adoptionProbe: Promise<void> | undefined;
  let heldProofSha256: string | undefined;
  let releasedProofSha256: string | undefined;
  let proofReleased!: () => void;
  const proofRelease = new Promise<void>(resolve => { proofReleased = resolve; });
  const proofTrace: { event: string; at: number; details?: unknown }[] = [];
  const traceProof = (event: string, details?: unknown) => {
    if (proofTrace.length < 32) proofTrace.push({ event, at: Date.now(), details });
  };
  const traceError = (error: unknown) => error instanceof Error
    ? { ...error, name: error.name, message: error.message, stack: error.stack } : String(error);
  t.after(() => { if (!snapshotAdoptedBeforeProof || responseOrderError) console.error('snapshot-proof-trace', JSON.stringify(proofTrace)); });
  let responseOrderError: unknown;
  let launchError: unknown;
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  let drains = 0;
  let allowHandoff = false;
  const script = join(root, 'successor.mjs');
  const successorArtifactFile = join(root, 'successor-artifact.json');
  const host = await startRunnerHost({ stateDir: state, sessions, runs, inFlight: () => !allowHandoff,
    storageControl: (action, input, dispatch) => { hostDispatch = dispatch; return control(action, input); },
    quiesce: async () => { await delay(400); }, closeStorage: async () => { await stopFixtureWriter(runs); await client.close(); },
    startSuccessor: (_command, nonce) => {
      launchTimer = setTimeout(() => {
        void (async () => {
          const { artifactOf } = await import('../storage/helpers.js');
          await writeFile(successorArtifactFile, JSON.stringify(artifactOf('production')), { mode: 0o600 });
          child = spawn(process.execPath, ['--import', 'tsx', script, state, JSON.stringify(successorFence), successorArtifactFile, nonce, host.instance], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          let stderr = '';
          child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
          const ended = once(child, 'exit');
          t.after(async () => { if (child!.exitCode === null && child!.signalCode === null) child!.send({ close: true }); await ended; });
          child.on('message', message => {
            const event = message as { ready?: boolean; proofHeld?: boolean; proofReleased?: boolean; requestInstance?: string; replyInstance?: string; fence?: RollbackFence; sha256?: string };
            if (event.ready) {
              traceProof('ready', { runnerVersion: manager.runnerVersion(), predecessor: host.instance });
              successorReady = true;
              // Do not rely on the next timed continuation poll to produce the stale addressed proof.
              if (!proofOrderingStarted) adoptionProbe = targetPorts.servingProof(successorFence!).then(proof => {
                assert.equal(proof.gate.open, true);
              }).catch(error => {
                if ((error as { proofTransition?: { reason: string } }).proofTransition?.reason !== 'adopted') responseOrderError = error;
              });
            }
            if (event.proofHeld) {
              traceProof('proofHeld', event);
              proofOrderingStarted = true;
              heldProofSha256 = event.sha256;
              // The fixture holds bytes before call() can read the real handoff nonce and adopt.
              void (async () => {
                assert.equal(event.requestInstance, host.instance);
                assert.notEqual(event.replyInstance, host.instance);
                assert.deepEqual(event.fence, successorFence);
                traceProof('snapshotRequested');
                await (manager as unknown as { call(method: string): Promise<unknown> }).call('snapshot').catch(error => {
                  traceProof('snapshotError', { error: traceError(error), runnerVersion: manager.runnerVersion() });
                  if (manager.runnerVersion() !== target) throw error;
                });
                traceProof('snapshotResponse', { runnerVersion: manager.runnerVersion() });
                assert.equal(manager.runnerVersion(), target, 'actual snapshot adopted nonce-verified successor');
                snapshotAdoptedBeforeProof = true;
                traceProof('snapshotAdopted');
              })().catch(error => { responseOrderError = error; traceProof('adoptionError', traceError(error)); }).finally(() => { traceProof('releaseProofSent'); child!.send({ releaseProof: true }); });
            }
            if (event.proofReleased) { traceProof('proofReleased', event); releasedProofSha256 = event.sha256; proofReleased(); }
          });
          child.once('exit', code => { if (!successorReady) launchError = new Error(`successor exited ${code}: ${stderr}`); });
        })().catch(error => { launchError = error; traceProof('launchError', traceError(error)); });
      }, 400);
    } });
  const manager = new DurableRunManager({ stateDir: state, pollMs: 60_000, handoffHeld: async () => true,
    spawn: () => { throw new Error('Only the owned successor may start'); } });
  await manager.start();
  const paths = await runnerPaths(state);
  t.after(async () => { clearTimeout(launchTimer); await manager.close(); await host.close(); sessions.stop(); await runs.close(); await rm(paths.directory, { recursive: true, force: true }); });
  const ports = rollbackPorts((action, input) => manager.storageControl(action, input), async () => {});
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
  // The captured source SDK successor owns its own process and actual RPC endpoint.
  await writeFile(script, `import * as sdk from ${JSON.stringify(pathToFileURL(fixtureParentFile).href)};
import { storageControl } from ${JSON.stringify(new URL('../../../server/runs/storage-control.ts', import.meta.url).href)};
import { startRunnerHost } from ${JSON.stringify(new URL('../../../server/runs/worker.ts', import.meta.url).href)};
import { RunManager } from ${JSON.stringify(new URL('../../../server/runs/manager.ts', import.meta.url).href)};
import { SessionService } from ${JSON.stringify(new URL('../../../server/sessions/service.ts', import.meta.url).href)};
import { join } from 'node:path';
import { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
// Hold original predecessor responses before any caller can read the nonce and adopt.
// Concurrent stale replies must not overtake the proof/snapshot exchange.
const emit = Server.prototype.emit; const heldReplies = []; let latched = false; let released = false; let proofSha256; let proofValues; let releasedSha256;
const predecessorInstance = process.argv[6];
const expectedFence = JSON.parse(process.argv[3]);
Server.prototype.emit = function(event, ...args) {
  if(event === 'request' && args[0].url === '/rpc') {
    const [req, res] = args; const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    const end = res.end;
    res.end = function(...values) {
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const reply = JSON.parse(String(values[0]));
      if(!released && input.instance === predecessorInstance && input.instance !== reply.instance && reply.error?.statusCode === 409 && (input.method !== 'snapshot' || !latched)) {
        heldReplies.push(() => {
          if(values === proofValues) releasedSha256 = createHash('sha256').update(values[0]).digest('hex');
          return end.apply(this, values);
        });
        const fence = input.args[1]?.fence;
        if(!latched && input.method === 'storageControl' && input.args[0] === 'proof' && fence?.id === expectedFence.id && fence.attempt === expectedFence.attempt && reply.snapshot?.handoff === process.argv[5]) {
          latched = true;
          proofValues = values;
          proofSha256 = createHash('sha256').update(values[0]).digest('hex');
          process.send({proofHeld:true,requestInstance:input.instance,replyInstance:reply.instance,fence,sha256:proofSha256});
        }
        return this;
      }
      return end.apply(this, values);
    };
  }
  return emit.call(this, event, ...args);
};
const stateDir = process.argv[2]; const fence = JSON.parse(process.argv[3]);
const client = await sdk.openStorage({stateDir, bundle: sdk.storageBundleFromArtifact(await readFile(process.argv[4], 'utf8'), 'artifact')});
await client.prepare({allowMigration:false});
const sessions = new SessionService({codexHome:join(stateDir,'fixture-codex'),claudeHome:join(stateDir,'fixture-claude'),inspectProcesses:async()=>({claude:new Map(),codex:new Set(),providerRunning:{claude:false,codex:false}})});
sessions.list = () => [];
const runs = new RunManager({stateDir,storage:client,getSession:()=>undefined,refreshSessions:async()=>{},spawnProcess:()=>{throw new Error('native provider forbidden');}});
await runs.start();
const call = storageControl({stateDir, client:()=>client, successorFence:fence, hold:async()=>{}, release:async()=>{}, quiet:()=>true, handoff:()=>{throw new Error('duplicate successor');}});
const host = await startRunnerHost({stateDir,sessions,runs,handoffNonce:process.argv[5],storageControl:call,closeStorage:async()=>{await runs.close();await client.close();}});
const releaseReplies = () => { released = true; for(const release of heldReplies.splice(0)) release(); };
process.on('message', async message => { if(message.releaseProof){releaseReplies();process.send({proofReleased:true,sha256:releasedSha256});} if(message.close){releaseReplies();await host.close();await runs.close();sessions.stop();process.disconnect();} });
process.send({ready:true});`);
  let pendingProofs = 0;
  let unknownProof = false;
  const transitions = new Set<string>();
  let heldUnknownReads = 0;
  const targetPorts = rollbackPorts(async (action, input) => {
    if (launchError) throw launchError;
    if (action === 'proof' && unknownProof) throw new Error('Owned predecessor proof unavailable');
    if (action === 'proof' && drains) {
      const record = await readRollbackRecord(state);
      if (record.state === 'present' && record.record.held && record.record.handoff?.state === 'unknown') heldUnknownReads++;
    }
    try {
      const answer = await manager.storageControl(action, input);
      if (action === 'proof' && (answer as { handoff: string }).handoff === 'pending') pendingProofs++;
      return answer;
    } catch (error) {
      const transition = (error as { proofTransition?: { reason: string } }).proofTransition;
      if (transition) { transitions.add(transition.reason); if (transition.reason === 'draining') drains++; }
      throw error;
    }
  }, async () => { assert.fail('target web does not restart for continuation'); });
  const context = { stateDir: state, managed: true, running, ports: targetPorts, serialize };
  const timedOut = await storageWebServing(context, { intervalMs: 5, timeoutMs: 1000 });
  assert.ok(timedOut && 'record' in timedOut && timedOut.record.held && ['pending', 'unknown'].includes(timedOut.record.handoff?.state ?? ''));
  assert.equal(handoffs, 1); assert.equal(held, true);
  const abort = new AbortController();
  const aborted = await storageWebServing({ ...context, serialize: async work => {
    const result = await serialize(work);
    abort.abort();
    return result;
  } }, { signal: abort.signal });
  assert.ok(aborted && 'record' in aborted && aborted.record.held && ['pending', 'unknown'].includes(aborted.record.handoff?.state ?? ''));
  assert.equal(handoffs, 1); assert.equal(held, true);
  const unknown = await storageWebServing({ ...context, serialize: async work => {
    const result = await serialize(work);
    unknownProof = true;
    return result;
  } }, { intervalMs: 5 });
  assert.ok(unknown && 'record' in unknown && unknown.record.handoff?.state === 'unknown');
  assert.equal(handoffs, 1); assert.equal(held, true);
  unknownProof = false;
  // Restore only the fixture's pending state; a new session still needs a fresh actual proof.
  const unknownRecord = await readRollbackRecord(state);
  assert.ok(unknownRecord.state === 'present');
  if (unknownRecord.state !== 'present') assert.fail('record required');
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify({ ...unknownRecord.record, handoff: { ...unknownRecord.record.handoff, state: 'pending' } }));
  const lostEvidence = await storageWebServing({ ...context, serialize: async work => {
    const result = await serialize(work);
    evidenceLost = true;
    return result;
  } }, { intervalMs: 5 });
  assert.ok(lostEvidence && 'record' in lostEvidence && lostEvidence.record.handoff?.state === 'unknown');
  assert.equal(handoffs, 1); assert.equal(held, true);
  evidenceLost = false;
  const lostRecord = await readRollbackRecord(state);
  assert.ok(lostRecord.state === 'present');
  if (lostRecord.state !== 'present') assert.fail('record required');
  await writeFile(storageUpdatePaths(state).rollback, JSON.stringify({ ...lostRecord.record, handoff: { ...lostRecord.record.handoff, state: 'pending' } }));
  const saved = await readRollbackRecord(state);
  if (saved.state !== 'present') assert.fail('fixture record required');
  const restorePending = () => writeFile(storageUpdatePaths(state).rollback, JSON.stringify(saved.record));
  for (const failure of ['foreign', 'database', 'stale', 'late', 'abort-return'] as const) {
    await restorePending();
    let observed = false;
    let calls = 0;
    const cancelled = new AbortController();
    const failing = { ...context, serialize: async <T>(work: () => Promise<T>) => {
      const result = await serialize(work); observed = true; return result;
    }, ports: { ...targetPorts, servingProof: async (fence: RollbackFence): Promise<ServingProof> => {
      calls++;
      const proof = await targetPorts.servingProof(fence);
      if (!observed) return proof;
      if (failure === 'foreign') return { ...proof, worker: { ...proof.worker, sourceHash: 'f'.repeat(64) } };
      if (failure === 'database') throw new Error('Database closed/corrupt/barrier');
      if (failure === 'stale') throw Object.assign(new Error('Stale rollback fence'), { statusCode: 409 });
      if (failure === 'late') await delay(250);
      if (failure === 'abort-return') cancelled.abort();
      return proof;
    } } };
    const result = await storageWebServing(failing, { intervalMs: 5, timeoutMs: failure === 'late' ? 200 : 1000, signal: cancelled.signal });
    assert.ok(result && 'record' in result && result.record.handoff?.state === 'unknown', failure);
    assert.equal(calls, 2, `${failure} stops observation`);
    const retained = await readRollbackRecord(state);
    assert.ok(retained.state === 'present' && retained.record.held, failure);
    assert.equal(handoffs, 1, `${failure}: additional effects=0`);
  }
  for (const initial of ['pending', 'unknown'] as const) {
    await writeFile(storageUpdatePaths(state).rollback, JSON.stringify({ ...saved.record, handoff: { ...saved.record.handoff, state: initial } }));
    let calls = 0;
    const result = await storageWebServing({ ...context, ports: { ...targetPorts, servingProof: async fence => {
      calls++;
      throw Object.assign(new Error('Drain before any positive proof'), { proofTransition: { reason: 'draining', fence } });
    } } }, { intervalMs: 5 });
    assert.ok(result && 'record' in result && result.record.held && result.record.handoff?.state === 'unknown');
    assert.equal(calls, 1, `initial ${initial} has no observation eligibility`);
    assert.equal(handoffs, 1, 'unproven initial state: additional effects=0');
  }
  await restorePending();
  allowHandoff = true;
  const outcome = await storageWebServing(context, { intervalMs: 25 });
  await adoptionProbe;
  assert.equal(responseOrderError, undefined);
  assert.equal(snapshotAdoptedBeforeProof, true, `actual snapshot response precedes held proof 409: ${JSON.stringify(proofTrace)}`);
  await proofRelease;
  assert.match(heldProofSha256!, /^[0-9a-f]{64}$/);
  assert.equal(releasedProofSha256, heldProofSha256, 'held production proof reply retains exact bytes');
  console.log('concurrent-adoption: actual snapshot adopted before held predecessor proof 409');
  assert.equal(outcome?.state, 'completed', 'concurrent-adoption: predecessor proof 409 after snapshot adoption must complete'); assert.equal(handoffs, 1);
  assert.equal((await targetPorts.servingProof(successorFence!)).gate.open, true);
  assert.ok(pendingProofs > 0, 'accepted returns before the actual successor is ready');
  assert.ok(drains > 0, 'actual worker RPC refuses proof during slow quiesce');
  assert.ok(heldUnknownReads > 0, 'transient failure remains durable unknown/held while successor is observed');
  assert.deepEqual([...transitions].sort(), ['adopted', 'draining', 'socket']);
  assert.equal(successorReady, true);
  const durable = await readRollbackRecord(state);
  assert.ok(durable.state === 'present' && !durable.record.held && durable.record.handoff?.state === 'done');
  if (durable.state !== 'present') assert.fail('durable completion required');
  await assert.rejects(targetPorts.holdAdmission({ id: durable.record.id, attempt: durable.record.attempt!.n - 1 }, 'stale'));
  assert.equal(handoffs, 1, 'stale control and completed startup never duplicate dispatch');
  assert.equal((await storageWebServing({ stateDir: state, managed: true, running, ports: targetPorts, serialize }))?.state, 'completed');
  assert.equal(handoffs, 1);
});
