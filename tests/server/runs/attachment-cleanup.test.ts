import { temporaryFixture, removeTemporaryFixture } from '../../helpers/temporary.js';
import { externalStorageFixture, readAutoPromptFixture } from '../remote/external-storage-fixture.js';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { request } from 'node:http';
import { startRunnerHost } from '../../../server/runs/worker.js';
import { runnerPaths } from '../../../server/runs/runner-protocol.js';
import type { SessionService } from '../../../server/sessions/service.js';
import { until } from '../../helpers/until.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RunManager, fixtureDocuments, importFixtureRuns } from './sql-fixture.js';
import { AutoPromptManager } from '../../../server/auto-prompt/manager.js';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import type { Session, Snapshot } from '../../../shared/types.js';

function gate<T = void>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
interface CleanupInternals { attachments: AttachmentStore; cleanupAttachments(): Promise<void>; attachmentCleanupTimer?: ReturnType<typeof setInterval> }
const internals = (manager: RunManager | AutoPromptManager) => manager as unknown as CleanupInternals;
async function expire(store: AttachmentStore, id: string) {
  const path = join(store.directory, id, '.metadata.json'); const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.pendingUntil = 1; await writeFile(path, JSON.stringify(manifest));
}
async function manifest(store: AttachmentStore, id: string) { return JSON.parse(await readFile(join(store.directory, id, '.metadata.json'), 'utf8')); }
async function fixture(t: TestContext, executable?: () => Promise<string>) {
  const directory = await temporaryFixture('tower-cleanup-fixture-');
  const nativeId = randomUUID();
  const session: Session = { id: `codex:${nativeId}`, nativeId, provider: 'codex', cwd: directory, project: 'fixture', title: 'Fixture', status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const owners = await externalStorageFixture(t, directory, true, 'normal', false);
  await importFixtureRuns(owners.storage);
  const runs = new RunManager({ storage: owners.storage, stateDir: directory, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, maxConcurrent: 0, findExecutable: executable ?? (async () => '/fixture/codex'), spawnProcess: () => { throw new Error('No native provider allowed'); } });
  await runs.start();
  const snapshot = (): Snapshot => ({ sessions: [session], runs: runs.list(), providers: [{ provider: 'codex', available: true, sessionCount: 1 }], scanning: false, updatedAt: session.updatedAt, hostname: 'fixture', version: 'test' });
  const auto = new AutoPromptManager({ repository: owners.autoPrompt, effectGate: owners.effectGate, stateDir: directory, snapshot, detail: async () => undefined, refresh: async () => {}, runs, model: async () => { throw new Error('No native router allowed'); } }); await auto.start(); await auto.startRuntimeEffects();
  const drains: Array<() => void> = [];
  t.after(async () => { for (const drain of drains) drain(); await auto.close(); await runs.close(); await owners.storage.close(); await removeTemporaryFixture(directory); });
  return { directory, session, runs, auto, snapshot, drains, storage: owners.storage, autoRepository: owners.autoPrompt, captured: owners.captured };
}
async function upload(store: AttachmentStore, scope: string) { const item = await store.upload(scope, 'fixture.txt', 'text/plain', (async function* () { yield Buffer.from('original'); })(), { pending: true }); await expire(store, item.id); return item; }

test('incoming references are skipped during executable admission and remain pending after rejection', async t => {
  const executable = gate<string>(); const f = await fixture(t, () => executable.promise); const store = internals(f.runs).attachments;
  const item = await upload(store, f.session.id);
  const admission = f.runs.enqueue(f.session.id, '', { attachmentIds: [item.id] });
  const rejected = assert.rejects(admission, /executable fixture failed/);
  await internals(f.runs).cleanupAttachments();
  assert.equal((await manifest(store, item.id)).pendingUntil, 1, 'skip must not retain');
  executable.reject(new Error('executable fixture failed')); await rejected;
  await internals(f.runs).cleanupAttachments();
  await assert.rejects(store.openVerified(item.id), /not found|찾을 수|없습니다/i);
  assert.deepEqual(f.runs.list(), []);
});

test('concurrent admissions of the same reference keep protection until both fail', async t => {
  const executables = [gate<string>(), gate<string>()]; let calls = 0;
  const f = await fixture(t, () => executables[calls++].promise); const store = internals(f.runs).attachments; const item = await upload(store, f.session.id);
  const first = f.runs.enqueue(f.session.id, '', { attachmentIds: [item.id] }); const second = f.runs.enqueue(f.session.id, '', { attachmentIds: [item.id] });
  const rejectedFirst = assert.rejects(first); const rejectedSecond = assert.rejects(second);
  await internals(f.runs).cleanupAttachments(); assert.equal((await manifest(store, item.id)).pendingUntil, 1);
  executables[0].reject(new Error('first refused')); await rejectedFirst;
  await internals(f.runs).cleanupAttachments(); assert.equal((await manifest(store, item.id)).pendingUntil, 1, 'the second admission still protects the same ID');
  executables[1].reject(new Error('second refused')); await rejectedSecond; await internals(f.runs).cleanupAttachments();
  await assert.rejects(store.openVerified(item.id));
});

test('GC retains durable run references but only skips an admission before its durable flush', async t => {
  const f = await fixture(t); const store = internals(f.runs).attachments; const item = await upload(store, f.session.id);
  const flushed = gate(); const entered = gate(); const flush = (f.runs as unknown as { flush(): Promise<void> }).flush;
  (f.runs as unknown as { flush(): Promise<void> }).flush = async () => { entered.resolve(); await flushed.promise; };
  const admission = f.runs.enqueue(f.session.id, '', { attachmentIds: [item.id] }); const rejected = assert.rejects(admission, /durable flush failed/); await entered.promise;
  await internals(f.runs).cleanupAttachments(); assert.equal((await manifest(store, item.id)).pendingUntil, 1);
  flushed.reject(new Error('durable flush failed')); await rejected; (f.runs as unknown as { flush(): Promise<void> }).flush = flush;
  await internals(f.runs).cleanupAttachments(); await assert.rejects(store.openVerified(item.id));
  const durable = await upload(store, f.session.id); await f.runs.enqueue(f.session.id, '', { attachmentIds: [durable.id] }); await expire(store, durable.id);
  await internals(f.runs).cleanupAttachments(); assert.equal((await manifest(store, durable.id)).pendingUntil, undefined);
  const saved = JSON.parse(JSON.stringify((await fixtureDocuments(f.runs)).runs)); assert.equal(saved[0].attachments[0].id, durable.id);
});

test('Auto admission protects its scope without retaining unused originals and releases on failure', async t => {
  const f = await fixture(t); const store = internals(f.auto).attachments; const requestId = randomUUID(); const item = await upload(store, requestId);
  const ready = gate<Snapshot>(); (f.auto as unknown as { snapshotFor(): Promise<Snapshot> }).snapshotFor = () => ready.promise;
  const admission = f.auto.submit({ requestId, provider: 'codex', prompt: '', attachmentIds: [item.id], cwd: f.directory }); const rejected = assert.rejects(admission, /snapshot fixture failed/);
  await internals(f.auto).cleanupAttachments(); assert.equal((await manifest(store, item.id)).pendingUntil, 1);
  ready.reject(new Error('snapshot fixture failed')); await rejected;
  await internals(f.auto).cleanupAttachments(); await assert.rejects(store.openVerified(item.id));
});

test('Auto durable nonterminal entries skip unused originals in their scope until terminal', async t => {
  const f = await fixture(t); const store = internals(f.auto).attachments; const requestId = randomUUID();
  const accepted = await upload(store, requestId); const unused = await upload(store, requestId);
  (f.auto as unknown as { pump(): void }).pump = () => {};
  await f.auto.submit({ requestId, provider: 'codex', prompt: '', attachmentIds: [accepted.id], targetSessionId: f.session.id, cwd: f.directory });
  assert.equal(f.auto.get(requestId)?.status, 'queued');
  assert.equal(JSON.parse(await readAutoPromptFixture(f.autoRepository))[0].staged[0].id, accepted.id);
  await internals(f.auto).cleanupAttachments(); assert.equal((await manifest(store, unused.id)).pendingUntil, 1);
  await f.auto.cancel(requestId); await internals(f.auto).cleanupAttachments(); await assert.rejects(store.openVerified(unused.id));
});

for (const kind of ['runs', 'auto'] as const) test(`${kind} pause and repeated close wait for the same sweep, and resume rearms only once`, async t => {
  const f = await fixture(t); const manager = f[kind]; const state = internals(manager); const finished = gate(); const entered = gate(); let sweeps = 0;
  state.attachments.sweepPending = async () => { sweeps++; entered.resolve(); await finished.promise; };
  const sweep = state.cleanupAttachments(); assert.equal(state.cleanupAttachments(), sweep); await entered.promise; assert.equal(sweeps, 1);
  let paused = false; const pause = manager.pauseAttachmentCleanup().then(() => { paused = true; });
  assert.equal(state.attachmentCleanupTimer, undefined); await Promise.resolve(); assert.equal(paused, false);
  finished.resolve(); await pause; await state.cleanupAttachments(); assert.equal(sweeps, 1);
  manager.resumeAttachmentCleanup(); const timer = state.attachmentCleanupTimer; assert.ok(timer); manager.resumeAttachmentCleanup(); assert.equal(state.attachmentCleanupTimer, timer);
  const next = gate(); state.attachments.sweepPending = async () => next.promise; void state.cleanupAttachments();
  let closes = 0; const first = manager.close().then(() => { closes++; }); const second = manager.close().then(() => { closes++; });
  await Promise.resolve(); assert.equal(closes, 0); assert.equal(state.attachmentCleanupTimer, undefined);
  next.resolve(); await Promise.all([first, second]); assert.equal(closes, 2); manager.resumeAttachmentCleanup(); assert.equal(state.attachmentCleanupTimer, undefined);
});

test('failed sweep is logged and pause still drains without rejection', async t => {
  const f = await fixture(t); const finished = gate(); internals(f.runs).attachments.sweepPending = () => finished.promise;
  const errors: unknown[][] = []; const log = console.error; console.error = (...args) => { errors.push(args); };
  try { void internals(f.runs).cleanupAttachments(); const pause = f.runs.pauseAttachmentCleanup(); finished.reject(new Error('fixture disk error')); await pause; }
  finally { console.error = log; }
  assert.equal(errors.length, 1); assert.match(String(errors[0][0]), /Run attachment cleanup failed/);
});

test('GC registers deletion first: enqueue waits for the actual deletion and refuses the missing original', async t => {
  const f = await fixture(t); const store = internals(f.runs).attachments; const item = await upload(store, f.session.id);
  const deleting = gate(); const proceed = gate(); const remove = fsPromises.rm;
  fsPromises.rm = (async (path, options) => { if (String(path) === join(store.directory, item.id)) { deleting.resolve(); await proceed.promise; } return remove(path, options); }) as typeof fsPromises.rm;
  syncBuiltinESMExports();
  try {
    const sweep = internals(f.runs).cleanupAttachments(); await deleting.promise;
    let completed = false; const admission = f.runs.enqueue(f.session.id, '', { attachmentIds: [item.id] }).finally(() => { completed = true; }); const rejected = assert.rejects(admission);
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(completed, false); assert.deepEqual(f.runs.list(), []);
    proceed.resolve(); await sweep; await rejected; assert.deepEqual(f.runs.list(), []);
  } finally { proceed.resolve(); fsPromises.rm = remove; syncBuiltinESMExports(); }
});

// Run the production lifecycle closures with fixture services, so a later ordering change is exercised
// without starting the worker's native session scanner, provider transports or credentials.
async function lifecycle(f: Awaited<ReturnType<typeof fixture>>, toolsStop: () => Promise<void> = async () => {}, temporaryStop: () => Promise<void> = async () => {}) {
  const source = await readFile(new URL('../../../server/runs/worker.ts', import.meta.url), 'utf8');
  const noop = new Proxy({}, { get: () => async () => {} });
  const retentionCalls: string[] = [];
  const temporaryCalls: string[] = [];
  const temporary = { quiesce: async () => { temporaryCalls.push("quiesce"); await temporaryStop(); }, resume: () => { temporaryCalls.push("resume"); } };
  const retention = { service: { quiesce: async () => { retentionCalls.push('quiesce'); }, resume: () => { retentionCalls.push('resume'); } } };
  const context: Record<string, unknown> = { runs: f.runs, autoPrompts: f.auto, retention, temporary, clearInterval, secretExpiry: undefined, expiryTimer: undefined, releaseTimer: undefined, stopTelling: () => {}, paused: false, publishCold: () => {}, storageStatus: { admissionOpen: true },
    tools: { ...noop, stop: toolsStop, pause: () => {}, resume: () => {} } };
  for (const name of ['secrets', 'triggers', 'github', 'slack', 'publicAgents', 'skills', 'tasks', 'compactions', 'worktrees', 'reviewer', 'runner', 'permissions', 'sessions', 'terminals', 'ledger']) context[name] = noop;
  const lifecycleSource = source.slice(source.indexOf('      onIdle: async () =>'));
  const callback = (name: string) => { const match = lifecycleSource.match(new RegExp(`^      ${name}: (.+),$`, 'm')); assert.ok(match, name); return runInNewContext(`(${match[1]})`, context) as () => Promise<void>; };
  return { onIdle: callback('onIdle'), quiesce: callback('quiesce'), resume: callback('resume'), retentionCalls, temporaryCalls };
}
async function host(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof startRunnerHost>[0]>) {
  const sessions = Object.assign(new EventEmitter(), { list: () => [f.session] }) as unknown as SessionService;
  const paths = await runnerPaths(f.directory);
  // The custom release fixture replaces acquireStateLock, including its runtime-directory setup.
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const result = await startRunnerHost({ stateDir: f.directory, runs: f.runs, sessions, ...extra });
  return result;
}
async function requestHandoff(directory: string, method = 'requestHandoff') {
  const paths = await runnerPaths(directory); const token = await readFile(paths.token, 'utf8');
  return new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: paths.socket, path: '/rpc', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let bytes = ''; res.on('data', data => { bytes += data; }); res.on('end', () => { const reply = JSON.parse(bytes); if (reply.error) reject(new Error(reply.error.message)); else resolve(); });
    });
    req.on('error', reject); req.end(JSON.stringify({ protocol: 1, method, args: [{ execPath: process.execPath, args: ['--runner-worker', paths.stateDir] }] }));
  });
}

test('handoff holds the state lock and successor until both production manager sweeps drain', { timeout: 10_000 }, async t => {
  const f = await fixture(t); const runGC = gate(); const autoGC = gate(); const paused = gate();
  f.drains.push(() => { runGC.resolve(); autoGC.resolve(); });
  internals(f.runs).attachments.sweepPending = () => runGC.promise; internals(f.auto).attachments.sweepPending = () => autoGC.promise;
  void internals(f.runs).cleanupAttachments(); void internals(f.auto).cleanupAttachments();
  const hooks = await lifecycle(f); let released = false; let successor = false;
  const worker = await host(f, { quiesce: async () => { paused.resolve(); await hooks.quiesce(); }, resume: hooks.resume, releaseStateLock: async () => { released = true; }, startSuccessor: () => { assert.equal(released, true); successor = true; } });
  t.after(async () => { for (const drain of f.drains) drain(); await worker.close(); }); await requestHandoff(f.directory); await paused.promise;
  assert.equal(released, false); assert.equal(successor, false); runGC.resolve(); await Promise.resolve(); assert.equal(released, false);
  autoGC.resolve(); await until(() => successor); assert.equal(internals(f.runs).attachmentCleanupTimer, undefined); assert.equal(internals(f.auto).attachmentCleanupTimer, undefined);
  assert.deepEqual(hooks.retentionCalls, ['quiesce']); assert.deepEqual(hooks.temporaryCalls, ['quiesce']);
  await internals(f.runs).cleanupAttachments(); await internals(f.auto).cleanupAttachments();
});

test('failed production quiesce resumes both manager cleanup timers without releasing the lock', { timeout: 10_000 }, async t => {
  const f = await fixture(t); const hooks = await lifecycle(f); const resumed = gate(); let released = false;
  const worker = await host(f, { quiesce: async () => { await hooks.quiesce(); throw new Error('fixture flush failure'); }, resume: () => { hooks.resume(); resumed.resolve(); }, releaseStateLock: async () => { released = true; } });
  t.after(async () => { for (const drain of f.drains) drain(); await worker.close(); }); const log = console.error; console.error = () => {};
  try { await requestHandoff(f.directory); await resumed.promise; } finally { console.error = log; }
  assert.equal(released, false); assert.ok(internals(f.runs).attachmentCleanupTimer); assert.ok(internals(f.auto).attachmentCleanupTimer);
  assert.deepEqual(hooks.retentionCalls, ['quiesce', 'resume']); assert.deepEqual(hooks.temporaryCalls, ['quiesce', 'resume']);
});

test('production onIdle drains both GCs before a later flush failure can release the state lock', { timeout: 10_000 }, async t => {
  const f = await fixture(t); const runGC = gate(); const autoGC = gate(); const downstream = gate();
  f.drains.push(() => { runGC.resolve(); autoGC.resolve(); });
  internals(f.runs).attachments.sweepPending = () => runGC.promise; internals(f.auto).attachments.sweepPending = () => autoGC.promise;
  void internals(f.runs).cleanupAttachments(); void internals(f.auto).cleanupAttachments();
  const hooks = await lifecycle(f, async () => { downstream.resolve(); throw new Error('fixture tool flush failure'); }); let released = 0; let diagnosed = 0; let closeAcks = 0;
  const bundle = f.captured.bundle();
  const preflight = await f.captured.storage.preflightStorage({ stateDir: f.directory, bundle });
  assert.equal(preflight.supported, true, 'actual supported runtime required');
  const database = f.storage;
  const worker = await host(f, { onIdle: hooks.onIdle, onCloseFailure: () => { diagnosed++; },
    closeStorage: async () => { await f.auto.close(); await f.runs.close(); const ack = await database.close(); assert.equal(ack.ack, 'closed'); closeAcks++; },
    releaseStateLock: async () => { assert.equal(closeAcks, 1); released++; } });
  const closing = worker.close(true);
  try {
    const failed = assert.rejects(closing, /fixture tool flush failure/);
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(released, 0); runGC.resolve(); await Promise.resolve(); assert.equal(released, 0);
    autoGC.resolve(); await downstream.promise; await failed; assert.equal(released, 0); assert.equal(diagnosed, 1); assert.equal(closeAcks, 0);
    assert.equal((await database.gate('core')).open, true);
    await requestHandoff(f.directory, 'snapshot');
    await worker.close(); assert.equal(released, 1); assert.equal(closeAcks, 1);
    assert.equal(internals(f.runs).attachmentCleanupTimer, undefined); assert.equal(internals(f.auto).attachmentCleanupTimer, undefined);
    assert.deepEqual(hooks.retentionCalls, ['quiesce']); assert.deepEqual(hooks.temporaryCalls, ['quiesce']);
  } finally { runGC.resolve(); autoGC.resolve(); await closing.catch(() => {}); await worker.close(); await database.close(); }
});

for (const autoStarted of [false, true]) test(`production startup failure drains initialized managers before lock release (Auto ${autoStarted})`, async t => {
  const f = await fixture(t); const runGC = gate(); const autoGC = gate(); f.drains.push(() => { runGC.resolve(); autoGC.resolve(); });
  internals(f.runs).attachments.sweepPending = () => runGC.promise; void internals(f.runs).cleanupAttachments();
  if (autoStarted) { internals(f.auto).attachments.sweepPending = () => autoGC.promise; void internals(f.auto).cleanupAttachments(); }
  const source = await readFile(new URL('../../../server/runs/worker.ts', import.meta.url), 'utf8');
  const line = source.split('\n').find(line => line.includes('initializedAutoPrompts?.pauseAttachmentCleanup()')); assert.ok(line);
  const offset = source.indexOf(line);
  const finallyLine = source.slice(offset).split('\n')[1];
  assert.match(finallyLine, /finally \{ await closeStorage\(\); await release\(\); \}/);
  const body = `${line.trim()} ${finallyLine.trim()} throw error;`; let released = false; let closeAcks = 0;
  const bundle = f.captured.bundle();
  const preflight = await f.captured.storage.preflightStorage({ stateDir: f.directory, bundle });
  assert.equal(preflight.supported, true, 'actual supported runtime required');
  const database = f.storage;
  let retentionPaused = false, temporaryPaused = false;
  const cleanup = runInNewContext(`(async error => { ${body} })`, { runs: f.runs, initializedAutoPrompts: autoStarted ? f.auto : undefined,
    initializedRetention: { quiesce: async () => { retentionPaused = true; } }, temporary: { quiesce: async () => { temporaryPaused = true; } }, carry: undefined, tools: undefined, sessions: { stop() {} }, closeStorage: async () => { await f.auto.close(); await f.runs.close(); assert.equal((await database.close()).ack, 'closed'); closeAcks++; }, release: async () => { assert.equal(closeAcks, 1); released = true; } }) as (error: Error) => Promise<void>;
  try {
    const failed = assert.rejects(cleanup(new Error('fixture startup failure')), /fixture startup failure/);
    await Promise.resolve(); assert.equal(released, false); runGC.resolve(); await Promise.resolve(); if (autoStarted) assert.equal(released, false);
    autoGC.resolve(); await failed; assert.equal(released, true); assert.equal(internals(f.runs).attachmentCleanupTimer, undefined);
    if (autoStarted) assert.equal(internals(f.auto).attachmentCleanupTimer, undefined);
    assert.equal(retentionPaused, true); assert.equal(temporaryPaused, true);
  } finally { runGC.resolve(); autoGC.resolve(); await database.close(); }
});

test('a ready replacement host resumes both adopted engines once after host close paused cleanup', { timeout: 10_000 }, async t => {
  const f = await fixture(t); const runState = internals(f.runs); const autoState = internals(f.auto);
  const runTimer = runState.attachmentCleanupTimer; const autoTimer = autoState.attachmentCleanupTimer;
  const first = await host(f, { autoPrompts: f.auto });
  assert.equal(runState.attachmentCleanupTimer, runTimer); assert.equal(autoState.attachmentCleanupTimer, autoTimer);
  await first.close(); assert.equal(runState.attachmentCleanupTimer, undefined); assert.equal(autoState.attachmentCleanupTimer, undefined);
  const runItem = await upload(runState.attachments, f.session.id); const autoItem = await upload(autoState.attachments, randomUUID());
  await runState.cleanupAttachments(); await autoState.cleanupAttachments();
  assert.equal((await manifest(runState.attachments, runItem.id)).pendingUntil, 1); assert.equal((await manifest(autoState.attachments, autoItem.id)).pendingUntil, 1);
  const replacement = await host(f, { autoPrompts: f.auto }); t.after(() => replacement.close());
  assert.ok(runState.attachmentCleanupTimer); assert.ok(autoState.attachmentCleanupTimer);
  assert.notEqual(runState.attachmentCleanupTimer, runTimer); assert.notEqual(autoState.attachmentCleanupTimer, autoTimer);
  const adoptedRunTimer = runState.attachmentCleanupTimer; const adoptedAutoTimer = autoState.attachmentCleanupTimer;
  f.runs.resumeAttachmentCleanup(); f.auto.resumeAttachmentCleanup();
  assert.equal(runState.attachmentCleanupTimer, adoptedRunTimer); assert.equal(autoState.attachmentCleanupTimer, adoptedAutoTimer);
  await runState.cleanupAttachments(); await autoState.cleanupAttachments();
  await assert.rejects(runState.attachments.openVerified(runItem.id)); await assert.rejects(autoState.attachments.openVerified(autoItem.id));
});


test('production handoff drains owned temporary collection before releasing the worker lock', { timeout: 10_000 }, async t => {
  const f = await fixture(t), temporaryDrain = gate(), began = gate(); f.drains.push(() => temporaryDrain.resolve());
  const hooks = await lifecycle(f, async () => {}, async () => { began.resolve(); await temporaryDrain.promise; });
  let released = false, successor = false;
  const worker = await host(f, { quiesce: hooks.quiesce, resume: hooks.resume, releaseStateLock: async () => { released = true; }, startSuccessor: () => { assert.equal(released, true); successor = true; } });
  t.after(async () => { for (const drain of f.drains) drain(); await worker.close(); }); await requestHandoff(f.directory); await began.promise;
  assert.equal(released, false); assert.equal(successor, false); temporaryDrain.resolve(); await until(() => successor);
  assert.deepEqual(hooks.temporaryCalls, ['quiesce']);
});
