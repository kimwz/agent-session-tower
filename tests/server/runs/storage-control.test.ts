import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import { storageControl, rollbackPorts } from '../../../server/runs/storage-control.js';
import { rollbackBootstrapCommandId, storageUpdatePaths, type RollbackRecord } from '../../../server/link/storage-update.js';
import { stateDir, storage, threadBundle } from '../storage/helpers.js';

async function intent(dir: string, client: import('../../../server/storage/client.js').StorageClient): Promise<RollbackRecord> {
  const identity = client.identity!;
  const inspection = await client.inspect();
  const at = new Date().toISOString();
  const record: RollbackRecord = { format: 'tower-storage-rollback', version: 1, id: 'consumer-intent', from: '99.0.0', target: identity.appVersion,
    sourceHash: identity.sourceHash, manifestDigest: identity.manifestDigest, entrySha256: 'a'.repeat(64), updateSha256: null,
    state: 'holding', by: 'owner', reason: 'fixture', held: true, switched: false,
    storage: inspection.schema.kind === 'empty' ? { kind: 'empty' } : { kind: 'current', storageId: inspection.schema.storageId },
    attempt: { n: 2, pid: process.pid, start: 'fixture', nonce: 'a'.repeat(32), kind: 'run', at }, startedAt: at, updatedAt: at };
  const path = storageUpdatePaths(dir).rollback;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  return record;
}

test('real SDK owner control consumes the full durable fence; stale RPC and unreadable intent have zero effects', async t => {
  const dir = await stateDir(t);
  const client = await storage.openStorage({ stateDir: dir, bundle: threadBundle('production') });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  const record = await intent(dir, client);
  let holds = 0; let releases = 0; let handoffs = 0; let busy = true;
  const call = storageControl({ stateDir: dir, client: () => client, hold: async () => { holds++; }, release: async () => { releases++; }, quiet: () => !busy, handoff: () => { handoffs++; } });
  const ports = rollbackPorts(call, async () => {});
  const fence = { id: record.id, attempt: 2 };
  const path = storageUpdatePaths(dir).rollback;
  const bytes = await readFile(path);
  await assert.rejects(ports.holdAdmission({ ...fence, attempt: 1 }, 'late'));
  await assert.rejects(ports.releaseAdmission(fence));
  await assert.rejects(ports.handoff({ version: record.target, entry: '/invalid', sourceHash: record.sourceHash }, fence));
  assert.deepEqual([holds, releases, handoffs], [0, 0, 0]);
  await ports.holdAdmission(fence, 'owner');
  assert.equal(holds, 1);
  assert.equal((await ports.waitQuiet(record.id)).state, 'pending');
  busy = false;
  assert.deepEqual(await ports.waitQuiet(record.id), { state: 'quiet' });
  assert.deepEqual(await readFile(path), bytes, 'the consumer never rewrites the producer intent');
  await writeFile(path, '{unknown', { mode: 0o600 });
  await assert.rejects(ports.holdAdmission(fence, 'unknown'));
  assert.deepEqual([holds, releases, handoffs], [1, 0, 0]);
});

test('serving proof includes the actual core bootstrap transaction receipt, never a side receipt or the requested fence', async t => {
  const dir = await stateDir(t);
  const bundle = threadBundle('production');
  const client = await storage.openStorage({ stateDir: dir, bundle });
  t.after(() => client.close());
  const fence = { id: 'consumer-intent', attempt: 2 };
  const id = rollbackBootstrapCommandId(fence);
  const prepared = await client.prepare({ allowMigration: true, commandId: id });
  const record = await intent(dir, client);
  const path = storageUpdatePaths(dir).rollback;
  record.state = 'completed'; record.switched = true; record.held = false;
  record.handoff = { attempt: 2, state: 'done', baseline: { worker: { version: '99.0.0', sourceHash: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), protocol: client.identity!.protocol, pid: process.pid, start: 'previous' }, storage: { kind: 'empty' }, ownerEpoch: 0, at: record.startedAt } };
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  const call = storageControl({ stateDir: dir, client: () => client, hold: async () => {}, release: async () => {}, quiet: () => true, handoff: () => {}, successorFence: fence });
  const ports = rollbackPorts(call, async () => {});
  const proof = await ports.servingProof(fence);
  assert.equal(proof.handoff, 'done');
  assert.equal(proof.status.ownerEpoch, prepared.ownerEpoch);
  assert.equal(proof.gate.open, true);
  assert.deepEqual(proof.bootstrap, await client.receipt(id));
  assert.equal(proof.bootstrap?.found, true);
  const foreign = await ports.servingProof({ ...fence, id: 'foreign-intent' });
  assert.equal(foreign.handoff, 'none');
  assert.deepEqual(foreign.bootstrap, { found: false });
  await client.close();
  await assert.rejects(ports.servingProof(fence), 'an unavailable database cannot become an empty proof');
});

import { artifactStorageContract, resumeRollback, runRollback, validateRollback, withdrawRollback, readRollbackRecord } from '../../../server/link/storage-update.js';
import { installArtifact, runningBuild } from '../link/fixtures/storage-builds.js';
import { entryPoint, pointCurrent } from '../../../server/link/service.js';
import { contextOf } from '../storage/helpers.js';

test('lower compatible target validation and withdrawal use the existing U executor with a real full SQLite inspection and fenced consumer ports', async t => {
  const dir = await stateDir(t);
  const bundle = threadBundle('production');
  const preflight = await storage.preflightStorage({ bundle, stateDir: dir });
  assert.equal(preflight.supported, true, 'actual supported Node/SQLite is required; no mocked runtime pass');
  const client = await storage.openStorage({ stateDir: dir, bundle });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  const target = client.identity!.appVersion;
  const installed = await installArtifact(dir, target, { manifest: contextOf('production').manifest });
  await writeFile(dirname(entryPoint(installed)) + '/contract.json', JSON.stringify(artifactStorageContract(contextOf('production'), preflight)));
  await installArtifact(dir, '99.0.0');
  await pointCurrent(dir, '99.0.0');
  let held = false; let releases = 0; let restart = 0;
  const call = storageControl({ stateDir: dir, client: () => client, hold: async () => { held = true; }, release: async () => { held = false; releases++; }, quiet: () => false, handoff: () => { assert.fail('busy worker cannot hand off'); } });
  const ports = rollbackPorts(call, async () => { restart++; });
  const context = { stateDir: dir, running: runningBuild('99.0.0'), managed: true, ports, serialize: async <T>(work: () => Promise<T>) => work() };
  const validation = await validateRollback(context, { target });
  assert.equal(validation.ok, true);
  const before = await client.inspect();
  const waiting = await runRollback(context, { target, by: 'owner', reason: 'patient fixture' });
  assert.equal(waiting.state, 'waiting'); assert.equal(held, true); assert.equal(restart, 0);
  const read = await readRollbackRecord(dir); assert.equal(read.state, 'present');
  if (read.state !== 'present') assert.fail('rollback record required');
  await assert.rejects(ports.holdAdmission({ id: read.record.id, attempt: read.record.attempt!.n - 1 }, 'stale'));
  const withdrawn = await withdrawRollback(context, { releasePin: true });
  assert.equal(withdrawn.state, 'withdrawn'); assert.equal(held, false); assert.equal(releases, 1);
  assert.deepEqual(await client.inspect(), before, 'validation, wait and withdrawal never import or migrate');
  const incompatible = artifactStorageContract(contextOf('production'), preflight);
  incompatible.supported = false;
  await writeFile(dirname(entryPoint(installed)) + '/contract.json', JSON.stringify(incompatible));
  const replacement = entryPoint(installed) + '.replacement';
  await writeFile(replacement, await readFile(entryPoint(installed)));
  await rename(replacement, entryPoint(installed));
  const refusal = await validateRollback(context, { target });
  assert.equal(refusal.ok, false, JSON.stringify({ phase: 'replaced-artifact', outcome: refusal }));
  if (!refusal.ok) assert.equal(refusal.code, 'target-runtime-unsupported');
  assert.equal(restart, 0);
});

import { readHandoff, writeHandoff } from '../../../server/runs/handoff.js';

test('successor storage transition markers and rollback fences are strictly read; malformed observed state never applies a new cold transition', async t => {
  const runtime = await stateDir(t);
  const marker = { previous: 'predecessor', successor: 'a'.repeat(32), version: '1.0.0', clean: true as const, at: new Date().toISOString(), storageTransition: true, rollbackFence: { id: 'fence', attempt: 2 } };
  await writeHandoff(runtime, marker);
  assert.deepEqual(await readHandoff(runtime), marker);
  for (const invalid of [{ storageTransition: 'true' }, { rollbackFence: { id: 'fence', attempt: 0 } }, { rollbackFence: { id: 'fence', attempt: 1.5 } }, { rollbackFence: null }]) {
    await writeFile(runtime + '/handoff.json', JSON.stringify({ ...marker, ...invalid }), { mode: 0o600 });
    assert.equal(await readHandoff(runtime), undefined);
  }
  const old = { previous: marker.previous, successor: marker.successor, version: marker.version, clean: true as const, at: marker.at };
  await writeHandoff(runtime, old);
  assert.deepEqual(await readHandoff(runtime), old, 'old normal handoffs retain their old cold-start behavior');
});

import { join } from 'node:path';
import { storageManifest } from '../../../server/storage/schema.js';
import type { RollbackFence } from '../../../server/link/storage-update.js';
import { SessionService } from '../../../server/sessions/service.js';
import { LaunchProofFile } from '../../../server/sessions/launch-proofs.js';

test('real SDK failure leaves childless helper proof and the last cold registry visible to continuing scans and a successor', async t => {
  const dir = await stateDir(t);
  const codexHome = join(dir, 'codex'); const claudeHome = join(dir, 'claude');
  const helper = '10000000-0000-4000-8000-000000000001'; const child = '10000000-0000-4000-8000-000000000002';
  const launcher = 'claude:10000000-0000-4000-8000-000000000003';
  await mkdir(join(codexHome, 'sessions'), { recursive: true }); await mkdir(join(codexHome, 'archived_sessions')); await mkdir(join(claudeHome, 'projects'), { recursive: true });
  const at = new Date().toISOString();
  const helperFile = join(codexHome, 'sessions', `rollout-${helper}.jsonl`);
  const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: at }) + '\n';
  await writeFile(helperFile, row('session_meta', { id: helper, cwd: dir, timestamp: at, source: 'exec' }) + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'childless helper fixture' }] }) + row('event_msg', { type: 'task_complete' }));
  const proofPath = join(dir, 'agent-launches.json');
  const proofs = new LaunchProofFile(proofPath); proofs.save(new Map([[`codex:${helper}`, [launcher]]]), true); await proofs.flush(); proofs.close();
  const proofBytes = await readFile(proofPath); const nativeBytes = await readFile(helperFile);
  let held = false;
  const options = { codexHome, claudeHome, launchProofs: proofPath, inspectProcesses: async () => ({ claude: new Map(), codex: new Set<string>(), providerRunning: { claude: false, codex: false } }) };
  const sessions = new SessionService(options); t.after(() => sessions.stop());
  sessions.setColdRegistry([join(claudeHome, 'projects', 'cold-launcher.jsonl')], [launcher], async () => held ? { complete: false, issues: ['storage-held'] } : { complete: true, issues: [] });
  await sessions.refresh(true);
  assert.deepEqual(sessions.retentionRecords().launchers.get(`codex:${helper}`), [launcher]);
  assert.ok(!sessions.list().some(session => session.parentId === `codex:${helper}`), 'helper has no child at failure');
  const client = await storage.openStorage({ stateDir: dir, bundle: threadBundle('fixture'), onUnavailable: () => { held = true; sessions.resume(); } }); t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  await assert.rejects(client.write('fixture', 'putThenDie', { key: 'unknown-proof' }, 'unknown-proof'), (error: unknown) => error instanceof storage.StorageCommandError && error.disposition === 'unknown');
  await sessions.refresh(true);
  assert.equal(sessions.retentionRecords().complete, false);
  assert.ok(sessions.retentionRecords().issues.includes('storage-held'));
  assert.deepEqual(sessions.retentionRecords().launchers.get(`codex:${helper}`), [launcher]);
  assert.deepEqual(await readFile(helperFile), nativeBytes);
  await sessions.quiesce(); sessions.stop();
  assert.deepEqual(await readFile(proofPath), proofBytes);
  const successor = new SessionService(options); t.after(() => successor.stop());
  await successor.quiesce();
  successor.setColdRegistry([join(claudeHome, 'projects', 'cold-launcher.jsonl')], [launcher], async () => ({ complete: false, issues: ['storage-held'] }));
  successor.resume(); await successor.refresh(true);
  assert.deepEqual(successor.retentionRecords().launchers.get(`codex:${helper}`), [launcher]);
  await writeFile(join(codexHome, 'sessions', `rollout-${child}.jsonl`), row('session_meta', { id: child, cwd: dir, timestamp: at, parent_thread_id: helper, source: { subagent: { thread_spawn: { parent_thread_id: helper } } } }));
  await successor.refresh(true);
  assert.equal(successor.get(`codex:${child}`)?.parentId, `codex:${helper}`);
  assert.deepEqual(await readFile(proofPath), proofBytes, 'a future child does not reclassify or overwrite the helper proof');
});


for (const accept of [false, true]) test(`predecessor proof reflects callback acceptance rather than persisted handoff intent (accept=${accept})`, async t => {
  const dir = await stateDir(t); const bundle = threadBundle('production');
  const preflight = await storage.preflightStorage({ bundle, stateDir: dir });
  assert.equal(preflight.supported, true, 'actual supported Node/SQLite is required; no mocked runtime pass');
  const client = await storage.openStorage({ stateDir: dir, bundle }); t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  const source = contextOf('production');
  assert.deepEqual(client.identity, source.identity, 'the predecessor is the actual SDK build');
  const target = '1.0.0';
  const targetManifest = storageManifest(undefined, target);
  const targetBuild = runningBuild(target, { manifest: targetManifest });
  const installed = await installArtifact(dir, target, { manifest: targetManifest });
  await writeFile(dirname(entryPoint(installed)) + '/contract.json', JSON.stringify(artifactStorageContract(
    { identity: targetBuild.preflight.identity!, manifest: targetManifest }, { ...preflight, identity: targetBuild.preflight.identity! })));
  const predecessor = await installArtifact(dir, source.identity.appVersion, { manifest: source.manifest });
  await writeFile(dirname(entryPoint(predecessor)) + '/contract.json', JSON.stringify(artifactStorageContract(source, preflight)));
  await pointCurrent(dir, source.identity.appVersion);
  let quietCalls = 0; let handoffs = 0; let acceptedFence: RollbackFence | undefined;
  const call = storageControl({ stateDir: dir, client: () => client, hold: async () => {}, release: async () => {},
    quiet: () => ++quietCalls <= 2 || accept,
    handoff: (_command, fence) => { handoffs++; acceptedFence = { ...fence }; }, acceptedFence: () => acceptedFence });
  const ports = rollbackPorts(call, async () => {});
  const switched = await runRollback({ stateDir: dir, running: { version: source.identity.appVersion, manifest: source.manifest, preflight }, managed: true, ports, serialize: async <T>(work: () => Promise<T>) => work() }, { target, by: 'owner', reason: 'acceptance race' });
  assert.equal(switched.state, 'switched', JSON.stringify({ phase: 'switch', outcome: switched }));
  const outcome = await resumeRollback({ stateDir: dir, running: { ...targetBuild, preflight: { ...preflight, identity: targetBuild.preflight.identity! } }, managed: true, ports, serialize: work => work() });
  const read = await readRollbackRecord(dir); if (read.state !== 'present') assert.fail(JSON.stringify({ phase: 'resume', outcome, record: read }));
  assert.ok(read.record.handoff, JSON.stringify({ phase: 'consumer-handoff', outcome, record: read.record }));
  assert.equal(read.record.handoff.state, accept ? 'pending' : 'no-effect', 'the actual consumer settles the sent handoff');
  assert.equal(quietCalls, 3, 'the actual consumer rechecks quiet after the producer wait');
  assert.equal(handoffs, accept ? 1 : 0);
  const proof = await ports.servingProof({ id: read.record.id, attempt: read.record.handoff.attempt });
  assert.equal(proof.handoff, accept ? 'pending' : 'none');
  assert.deepEqual(acceptedFence, accept ? { id: read.record.id, attempt: read.record.handoff.attempt } : undefined);
  if (accept) assert.equal(outcome.state, 'handing-off');
  if (!accept) assert.equal(outcome.state, 'failed', 'refused predecessor must not settle forever as pending');
});

test('release ACK accepts a terminal held intent without rewriting the producer commit or SQLite claim', async t => {
  const dir = await stateDir(t);
  const client = await storage.openStorage({ stateDir: dir, bundle: threadBundle('production') });
  t.after(() => client.close());
  await client.prepare({ allowMigration: true });
  const record = await intent(dir, client); record.state = 'withdrawn';
  const path = storageUpdatePaths(dir).rollback;
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  const bytes = await readFile(path); const inspection = await client.inspect();
  let signals = 0;
  const call = storageControl({ stateDir: dir, client: () => client, hold: async () => assert.fail('release must not hold again'), release: async () => { signals++; }, quiet: () => true, handoff: () => assert.fail('withdraw must not hand off') });
  await call('release', { fence: { id: record.id, attempt: record.attempt!.n } });
  assert.equal(signals, 1);
  assert.deepEqual(await readFile(path), bytes, 'only the producer commits held:false after accepting the ACK');
  assert.deepEqual(await client.inspect(), inspection);
  await assert.rejects(call('release', { fence: { id: record.id, attempt: record.attempt!.n + 1 } }));
  assert.equal(signals, 1);
});
