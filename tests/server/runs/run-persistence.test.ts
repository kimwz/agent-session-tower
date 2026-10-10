import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { restoreRuns, SCHEDULED_OUTPUT, serializeRuns } from '../../../server/runs/run-history.js';
import type { CodexBridgeOptions } from '../../../server/runs/codex-bridge.js';
import { checkedInstructions } from '../../../server/runs/turn-notes.js';
import { UUID, type CreatedSession } from '../../../server/runs/saved-state.js';
import type { Run, Session } from '../../../shared/types.js';
import { actualStorage, stopFixtureWriter } from './sql-fixture.js';
import { retainedReceipts } from '../../../server/runs/permission-continuation.js';
import { RunsRepository } from '../../../server/runs/storage-repository.js';
import { parseRunDocuments } from '../../../server/runs/storage-codec.js';
import { until } from '../../helpers/until.ts';

const ID = '10000000-0000-4000-8000-000000000001';

/** The private save path, reached directly to order writes deterministically. */
interface Internals { touch(...ids: string[]): void; changed(...runs: Run[]): void; registry: { touch(id: string): void }; persist(): void; flush(): Promise<void>; runs: Map<string, Run>; createdSessions: Map<string, CreatedSession> }

async function fixture(t: TestContext, outputPersistMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-persistence-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Persistence fixture', cwd: directory,
    project: 'fixture', status: 'idle', statusReason: 'Ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, activeProcess: true };
  let bridge: Omit<CodexBridgeOptions, 'codexHome'> | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const db = await actualStorage(stateDir);
  const manager = new RunManager({ stateDir, storage: db, getSession: id => id === session.id ? { ...session } : undefined, refreshSessions: async () => {},
    pollMs: 10, outputPersistMs, findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); },
    openCodexBridge: async options => {
      bridge = options;
      return { done, start: async () => { options.onStarted('fixture-turn'); },
        cancel: async () => { options.onFinished({ status: 'cancelled' }); finish(); }, close: () => finish() };
    },
  });
  await manager.start();
  const internals = manager as unknown as Internals;
  t.after(async () => { await manager.close(); await db.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = async (): Promise<Run[]> => (await new RunsRepository(db).exportCurrent()).documents.runs;
  const running = async () => {
    const run = await manager.enqueue(session.id, 'Stream some output');
    await until(() => bridge && manager.list().find(item => item.id === run.id)?.status === 'running');
    await internals.flush();
    return { run, bridge: bridge! };
  };
  return { manager, internals, stateDir, db, saved, running, finish };
}

test('streamed output is announced at once but saved on its slower cadence', async t => {
  const f = await fixture(t);
  const { run, bridge } = await f.running();
  let changes = 0;
  f.manager.on('change', () => { changes++; });
  bridge.onOutput('Partial answer');
  await until(() => changes > 0);
  assert.equal(f.manager.list().find(item => item.id === run.id)?.output, 'Partial answer');
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.output, '', 'output alone waits for its save cadence');
  bridge.onFinished({ status: 'completed' });
  await f.internals.flush();
  const finished = (await f.saved()).find(item => item.id === run.id);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.output, 'Partial answer', 'a state change saves the latest output with it');
});

test('output waiting for its cadence reaches disk on the cadence alone', async t => {
  const f = await fixture(t, 40);
  const { run, bridge } = await f.running();
  bridge.onOutput('Eventually saved');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if ((await f.saved()).find(item => item.id === run.id)?.output === 'Eventually saved') break;
    } catch (error) {
      // The cadence can commit during observation, so export safely refuses concurrent revisions.
      if (!(error instanceof Error) || error.message !== 'Runs changed while paging current export.') throw error;
    }
    assert.ok(Date.now() < deadline, 'output was not saved on its cadence');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await f.saved()).find(item => item.id === run.id)?.status, 'running');
});

test('shutdown saves output that was still waiting for its cadence', async t => {
  const f = await fixture(t);
  const { run, bridge } = await f.running();
  bridge.onOutput('Written at shutdown');
  await until(() => f.manager.list().find(item => item.id === run.id)?.output === 'Written at shutdown');
  await f.manager.close();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.output, 'Written at shutdown');
});

test('saving unchanged state writes no SQL rows and creates no runtime JSON files', async t => {
  const f = await fixture(t);
  const before = await new RunsRepository(f.db).head();
  let writes = 0;
  const write = f.db.write.bind(f.db);
  f.db.write = async <T>(...args: Parameters<typeof f.db.write>) => { writes++; return write<T>(...args); };
  f.internals.touch(...f.internals.runs.keys()); f.internals.persist(); await f.internals.flush();
  assert.deepEqual(await new RunsRepository(f.db).head(), before);
  assert.equal(writes, 0);
  for (const name of ['runs.json', 'created-sessions.json', 'run-instructions.json']) await assert.rejects(stat(join(f.stateDir, name)), { code: 'ENOENT' });
});

test('a queued save that restores earlier content still reaches disk', async t => {
  const f = await fixture(t);
  const { run } = await f.running();
  const live = f.internals.runs.get(run.id)!;
  const original = live.prompt;
  // A, then B and back to A while B is still queued: comparing against the last completed write
  // outside the queue would skip the final A and leave B on disk.
  live.prompt = 'Temporarily different';
  f.internals.touch(run.id);
  f.internals.persist();
  live.prompt = original;
  f.internals.touch(run.id);
  f.internals.persist();
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, original);
});

test('a known SQL failure retries only the touched run and does not rewrite saved identities', async t => {
  // holdUntilReady keeps the poll from retrying a failed save during SQL observation.
  // This fixture owns the single explicit retry; no provider turn is needed.
  const f = await quiet(t);
  const run = finishedRun(ID, '');
  f.internals.runs.set(run.id, run);
  f.internals.touch(run.id); f.internals.persist(); await f.internals.flush();
  const live = f.internals.runs.get(run.id)!;
  const savedPrompt = (await f.saved()).find(item => item.id === run.id)!.prompt;
  const session = f.manager.getSession(`codex:${ID}`)!;
  const createdId = 'codex:created-fixture';
  f.internals.createdSessions.set(createdId, { session: { ...session, id: createdId }, runId: run.id, confirmed: true });
  f.internals.registry.touch(createdId); f.internals.persist(); await f.internals.flush();
  const identity = (await new RunsRepository(f.db).exportCurrent()).rows.find(row => row.kind === 'created' && row.id === createdId)!.json;
  const write = f.db.write.bind(f.db);
  let failed = false, identityWrites = 0;
  f.db.write = async <T>(...args: Parameters<typeof f.db.write>) => {
    if (!failed && args[0] === 'runs' && args[1] === 'begin') { failed = true; throw new Error('Known refusal before staging'); }
    if (args[0] === 'runs' && args[1] === 'stage') {
      const payload = Buffer.from((args[2] as { data: string }).data, 'base64').toString('utf8');
      if (payload.includes(createdId)) identityWrites++;
    }
    return write<T>(...args);
  };
  live.prompt = 'Saved after the failure'; f.internals.changed(live);
  await assert.rejects(f.internals.flush(), /Cannot save the instruction queue/);
  assert.equal(failed, true, 'the real SQL storage write path refused the save');
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, savedPrompt, 'the failed write preserves the old SQL value');
  f.internals.changed(live); await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, live.prompt);
  assert.equal((await new RunsRepository(f.db).exportCurrent()).rows.find(row => row.kind === 'created' && row.id === createdId)!.json, identity);
  assert.equal(identityWrites, 0, 'saved identities are absent from the run-only retry payload');
  await assert.rejects(stat(join(f.stateDir, 'created-sessions.json')), { code: 'ENOENT' });
});

const SAVED_STATE = join(import.meta.dirname, 'fixtures', 'saved-state');
const STATE_FILES = ['runs.json', 'created-sessions.json', 'run-instructions.json'] as const;

/** Timestamps a restore stamps now (a run it ends) become a fixed marker; every other byte is compared as written. */
async function normalizedRestore(text: string): Promise<string> {
  const given = new Set<string>();
  for (const file of STATE_FILES) for (const match of (await readFile(join(SAVED_STATE, file), 'utf8')).matchAll(/\d{4}-\d\d-\d\dT[\d:.]+Z/g)) given.add(match[0]);
  return text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, stamp => given.has(stamp) ? stamp : '<restored-at>');
}

test('the previous-build DTO reads back unchanged through explicit fixture import and SQL projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-saved-state-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const file of STATE_FILES) await writeFile(join(stateDir, file), await readFile(join(SAVED_STATE, file)), { mode: 0o600 });
  const oldRuns = JSON.parse(await readFile(join(stateDir, 'runs.json'), 'utf8')) as Run[];
  const oldInstructions = JSON.parse(await readFile(join(stateDir, 'run-instructions.json'), 'utf8')) as Record<string, NonNullable<Run['instructions']>>;
  const kept = new Map<string, NonNullable<Run['instructions']>>();
  for (const [id, value] of Object.entries(oldInstructions)) {
    if (!UUID.test(id)) continue;
    try { kept.set(id, { ...checkedInstructions(value), required: true }); }
    catch { /* Explicit historical malformed-entry codec fixture; SQL importer is never relaxed. */ }
  }
  assert.deepEqual([...kept.keys()], ['20000000-0000-4000-8000-000000000004']);
  const historical = restoreRuns(oldRuns, kept);
  const historicalText = serializeRuns(historical.runs, {
    required: id => Boolean(historical.runs.find(run => run.id === id)?.instructions?.required),
    carried: new Set(historical.carried), retained: new Set([...historical.restoredRetained, ...retainedReceipts(historical.runs)]),
  });
  assert.equal(await normalizedRestore(historicalText), await readFile(join(SAVED_STATE, 'expected-runs.json'), 'utf8'), 'historical run export retains its exact golden bytes');
  const initial = parseRunDocuments({ runs: Buffer.from(serializeRuns(oldRuns, { required: runId => (oldRuns.find(run => run.id === runId) as unknown as { needsInstructions?: boolean })?.needsInstructions === true, carried: new Set(), retained: new Set() })), created: await readFile(join(stateDir, 'created-sessions.json')), instructions: Buffer.from(JSON.stringify(Object.fromEntries(kept))) });
  const db = await actualStorage(stateDir, initial);
  // Nothing starts: queued runs wait for markReady, and a launch would throw.
  const manager = new RunManager({ stateDir, storage: db, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, holdUntilReady: true,
    findExecutable: async () => { throw new Error('Launch forbidden'); }, spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); } });
  await manager.start();
  t.after(async () => { await manager.close(); await db.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.flushState();
  const actual: Record<string, string> = { 'list.json': await normalizedRestore(`${JSON.stringify(manager.list(), null, 1)}\n`) };
  for (const file of STATE_FILES) {
    const current = (await new RunsRepository(db).exportCurrent()).documents;
    const data = file === 'runs.json' ? serializeRuns(current.runs, { required: id => !!current.instructions[id]?.required, carried: new Set(current.runs.filter(run => (run as unknown as { keepQueued?: boolean }).keepQueued).map(run => run.id)), retained: new Set(current.runs.filter(run => (run as unknown as { retain?: boolean }).retain).map(run => run.id)) }) : JSON.stringify(file === 'created-sessions.json' ? current.created : current.instructions);
    actual[file] = await normalizedRestore(data);
    assert.equal((await stat(join(stateDir, file))).mode & 0o777, 0o600, file);
  }
  for (const [file, text] of Object.entries(actual)) {
    const expected = join(SAVED_STATE, `expected-${file}`);
    if (process.env.UPDATE_SAVED_STATE_GOLDEN === '1') await writeFile(expected, text);
    assert.deepEqual(JSON.parse(text), JSON.parse(await readFile(expected, 'utf8')), file);
  }
});

/** A manager that never starts anything, with its private run table at hand. */
async function quiet(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-history-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'History fixture', cwd: directory, project: 'fixture', status: 'idle', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const db = await actualStorage(stateDir);
  const manager = new RunManager({ stateDir, storage: db, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, pollMs: 60_000, holdUntilReady: true, findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); } });
  await manager.start();
  const successorOwner: { manager?: RunManager; storage?: typeof db } = {};
  t.after(async () => {
    await successorOwner.manager?.close(); await successorOwner.storage?.close();
    await manager.close(); await db.close(); await rm(directory, { recursive: true, force: true });
  });
  const internals = manager as unknown as Internals & { scheduleContinuation(run: Run, wakeup: { prompt: string; at: number }): void; drain: { settle(run: Run, target: { delegated: boolean; retryAt: number; stopping?: boolean }): void } };
  const saved = async (): Promise<Run[]> => (await new RunsRepository(db).exportCurrent()).documents.runs;
  return { directory, stateDir, session, manager, internals, db, saved, successorOwner };
}
const finishedRun = (id: string, output: string): Run => ({ id, sessionId: `codex:${ID}`, origin: { kind: 'owner' }, prompt: 'Long', status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output });

test('historical export over 11.5 MB keeps 2,000 characters of finished output while SQL remains lossless', async t => {
  const f = await quiet(t);
  const ids = Array.from({ length: 4 }, (_, index) => `50000000-0000-4000-8000-00000000000${index}`);
  for (const id of ids) f.internals.runs.set(id, finishedRun(id, 'o'.repeat(3_000_000)));
  f.internals.touch(...ids); f.internals.persist(); await f.internals.flush();
  const sql = await f.saved();
  for (const id of ids) assert.equal(sql.find(run => run.id === id)?.output.length, 3_000_000);
  const saved = JSON.parse(serializeRuns(sql, { required: () => false, carried: new Set(), retained: new Set() })) as Run[];
  for (const id of ids) assert.equal(saved.find(run => run.id === id)?.output.length, 2_000);
  assert.equal(f.manager.list().find(run => run.id === ids[0])?.output.length, 3_000_000, 'only the historical export copy is shortened');
});

test('a required-instruction SQL failure admits neither the run nor its instruction marker', async t => {
  const f = await quiet(t);
  const id = '50000000-0000-4000-8000-000000000010';
  const run: Run = { id, sessionId: `codex:${ID}`, origin: { kind: 'owner' }, prompt: 'Needs policy', status: 'queued', createdAt: new Date().toISOString(), output: '', instructions: { text: 'Policy', required: true } };
  f.internals.runs.set(id, run);
  const write = f.db.write.bind(f.db);
  f.db.write = async <T>(...args: Parameters<typeof f.db.write>) => { if (args[0] === 'runs' && args[1] === 'commit') throw new Error('Known instruction commit failure'); return write<T>(...args); };
  f.internals.changed(run);
  await assert.rejects(f.manager.flushState(), { kind: 'unavailable', message: /Cannot save the instruction queue/ });
  const current = (await new RunsRepository(f.db).exportCurrent()).documents;
  assert.equal(current.runs.some(row => row.id === id), false);
  assert.equal(current.instructions[id], undefined);
  f.db.write = write;
  f.internals.changed(run); await f.manager.flushState();
  assert.equal((await f.saved()).some(row => row.id === id), true);
});

test('a wakeup continuation, an update resume and a permission continuation inherit the same origin, delegation, required instructions, unattended, model and effort', async t => {
  const f = await quiet(t);
  const parent: Run = { id: '50000000-0000-4000-8000-000000000020', sessionId: f.session.id, origin: { kind: 'trigger', triggerId: 'trigger-a' },
    delegation: { parentRunId: '50000000-0000-4000-8000-000000000021', rootRunId: '50000000-0000-4000-8000-000000000022' },
    instructions: { text: 'Required policy', required: true }, unattended: true, model: 'gpt-5.5', effort: 'high', codexApprovalsReviewer: 'user',
    prompt: 'Parent', status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output: '' };
  const inherited = (run: Run | undefined) => run && { origin: run.origin, delegation: run.delegation, instructions: run.instructions, unattended: run.unattended, model: run.model, effort: run.effort };
  const expected = inherited(parent);
  // A wakeup the agent planned. Automated work does not schedule its own, so this one is the owner's.
  const owned = { ...parent, id: '50000000-0000-4000-8000-000000000023', origin: { kind: 'owner' as const } };
  f.internals.runs.set(owned.id, owned);
  f.internals.scheduleContinuation(owned, { prompt: 'Later', at: Date.now() + 60_000 });
  const wakeup = [...f.internals.runs.values()].find(run => run.scheduled?.afterRunId === owned.id);
  assert.deepEqual(inherited(wakeup), { ...expected, origin: { kind: 'owner' } });
  assert.equal(wakeup?.codexApprovalsReviewer, undefined);
  owned.status = 'cancelled'; f.internals.runs.delete(wakeup!.id);
  f.internals.drain.settle(owned, { delegated: false, retryAt: 0, stopping: true });
  const resume = [...f.internals.runs.values()].find(run => run.scheduled?.afterRunId === owned.id && run.scheduled.resume === 'update');
  assert.deepEqual(inherited(resume), { ...expected, origin: { kind: 'owner' } });
  assert.equal(resume?.codexApprovalsReviewer, undefined);
  f.internals.runs.set(parent.id, parent);
  const request = { id: '50000000-0000-4000-8000-000000000024', sessionId: f.session.id, runId: parent.id, status: 'approved' as const,
    rule: { kind: 'command' as const, value: 'gh pr merge', providers: ['codex' as const], scope: 'project' as const, cwd: f.directory }, reason: 'Fixture', cwd: f.directory, createdAt: new Date().toISOString() };
  const permission = await f.manager.permissionDecision(request, 'Approved.');
  assert.deepEqual(inherited(f.internals.runs.get(permission.id)), expected);
  assert.equal(f.internals.runs.get(permission.id)?.codexApprovalsReviewer, 'user', 'only the permission continuation keeps the reviewer');
});

test('restoreRuns keeps a scheduled continuation within its hour of grace and ends one past it', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const scheduled = (id: string, at: number): unknown => ({ id, sessionId: `codex:${ID}`, prompt: 'Later', status: 'queued', createdAt: '2026-10-01T00:00:00.000Z', output: '',
    scheduled: { at: new Date(at).toISOString(), afterRunId: '50000000-0000-4000-8000-000000000099' } });
  const { runs, carried, restoredRetained } = restoreRuns([scheduled('50000000-0000-4000-8000-000000000001', now - 59 * 60_000), scheduled('50000000-0000-4000-8000-000000000002', now - 61 * 60_000)], new Map(), now);
  assert.deepEqual(runs.map(run => run.status), ['queued', 'cancelled']);
  assert.equal(runs[0].output, SCHEDULED_OUTPUT);
  assert.deepEqual([carried, restoredRetained], [[], []]);
});

test('serializeRuns adds the markers a restore reads and leaves live fields out', () => {
  const base = { sessionId: `codex:${ID}`, prompt: 'p', createdAt: '2026-10-01T00:00:00.000Z' };
  const listed: Run[] = [
    { ...base, id: 'queued', status: 'queued', output: '', canSteer: true, steerBlocked: 'starting', approvals: [] },
    { ...base, id: 'kept', status: 'completed', output: 'k'.repeat(25_000) },
  ];
  const saved = JSON.parse(serializeRuns(listed, { required: id => id === 'queued', carried: new Set(['queued']), retained: new Set(['kept']) })) as Array<Record<string, unknown>>;
  assert.deepEqual(saved[0], { ...base, id: 'queued', status: 'queued', output: '', needsInstructions: true, keepQueued: true });
  assert.equal(saved[1].retain, true);
  assert.equal((saved[1].output as string).length, 20_000);
});

test('storage-held predecessor carries accepted private instructions and workflow into a real successor exactly once', async t => {
  const f = await quiet(t);
  const db = f.db;
  const instructions = { text: 'Required private workflow policy', required: true };
  const origin = { kind: 'owner' as const, workflowId: '90000000-0000-4000-8000-000000000093' };
  const accepted = await f.manager.enqueue(f.session.id, 'Accepted before hold', {}, { instructions, origin });
  f.manager.holdStorage();
  await f.manager.flushState();
  assert.equal(f.manager.list().find(r => r.id === accepted.id)?.status, 'queued');
  assert.equal(JSON.stringify((await new RunsRepository(db).exportCurrent()).documents.runs).includes(instructions.text), false);
  const carried = (await new RunsRepository(db).exportCurrent()).documents;
  await stopFixtureWriter(f.manager);
  assert.deepEqual((await new RunsRepository(db).exportCurrent()).documents, carried, 'stopped fixture lease release preserves queued work and private instructions');
  assert.equal((await db.close()).ack, 'closed');
  // The handoff flush is the predecessor's final save; do not call ordinary owner shutdown before restore.
  const nextDb = await actualStorage(f.stateDir); f.successorOwner.storage = nextDb;
  const provider = join(f.directory, 'provider.mjs');
  const submissions = join(f.directory, 'submissions.jsonl');
  // The existing stdio fixture protocol: production RunManager and Codex adapter
  // consume an owned fake provider's wire frames, rather than completion callbacks.
  await writeFile(provider, `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: {} });
  else if (r.method === 'account/read') send({ id: r.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  else if (r.method === 'thread/resume') send({ id: r.id, result: { thread: { id: '${ID}', status: { type: 'idle' } }, modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, approvalsReviewer: r.params.approvalsReviewer || 'user' } });
  else if (r.method === 'turn/start') {
    appendFileSync(${JSON.stringify(submissions)}, JSON.stringify(r.params) + '\\n');
    send({ id: r.id, result: { turn: { id: 'successor-turn', status: 'inProgress', items: [] } } });
    send({ method: 'turn/completed', params: { threadId: '${ID}', turn: { id: 'successor-turn', status: 'completed', items: [] } } });
  }
});
`, { mode: 0o600 });
  const successor = new RunManager({ stateDir: f.stateDir, storage: nextDb, getSession: id => id === f.session.id ? f.session : undefined,
    refreshSessions: async () => {}, holdUntilReady: true, pollMs: 10, findExecutable: async () => '/fixture/codex',
    spawnProcess: (_file, _args, options) => spawn(process.execPath, [provider], { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams });
  f.successorOwner.manager = successor;
  await successor.start();
  const restored = successor.list().find(r => r.id === accepted.id)!;
  assert.equal(restored.status, 'queued');
  assert.deepEqual(restored.origin, origin);
  assert.deepEqual((successor as unknown as Internals).runs.get(accepted.id)?.instructions, instructions);
  await assert.rejects(readFile(submissions), { code: 'ENOENT' });
  assert.equal((await nextDb.gate('core')).open, true);
  successor.markReady();
  await until(() => successor.list().find(r => r.id === accepted.id)?.status === 'completed');
  await successor.flushState();
  const dispatched = (await readFile(submissions, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(dispatched.length, 1);
  assert.ok(JSON.stringify(dispatched[0].input).includes(instructions.text), 'required instructions reach the actual provider wire');
  assert.equal(successor.list().filter(r => r.id === accepted.id).length, 1);
});
