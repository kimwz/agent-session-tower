import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { restoreRuns, SCHEDULED_OUTPUT, serializeRuns } from '../../../server/runs/run-history.js';
import type { CodexBridgeOptions } from '../../../server/runs/codex-bridge.js';
import type { CreatedSession } from '../../../server/runs/saved-state.js';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const ID = '10000000-0000-4000-8000-000000000001';

/** The private save path, reached directly to order writes deterministically. */
interface Internals { persist(): void; flush(): Promise<void>; runs: Map<string, Run>; createdSessions: Map<string, CreatedSession> }

async function fixture(t: TestContext, outputPersistMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-persistence-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Persistence fixture', cwd: directory,
    project: 'fixture', status: 'idle', statusReason: 'Ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, activeProcess: true };
  let bridge: Omit<CodexBridgeOptions, 'codexHome'> | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? { ...session } : undefined, refreshSessions: async () => {},
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
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = async (): Promise<Run[]> => JSON.parse(await readFile(join(stateDir, 'runs.json'), 'utf8'));
  const running = async () => {
    const run = await manager.enqueue(session.id, 'Stream some output');
    await until(() => bridge && manager.list().find(item => item.id === run.id)?.status === 'running');
    await internals.flush();
    return { run, bridge: bridge! };
  };
  return { manager, internals, stateDir, saved, running, finish };
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
    await f.internals.flush();
    if ((await f.saved()).find(item => item.id === run.id)?.output === 'Eventually saved') break;
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

test('saving unchanged state rewrites neither file, and no identities file appears without created sessions', async t => {
  const f = await fixture(t);
  const before = await stat(join(f.stateDir, 'runs.json'));
  f.internals.persist();
  await f.internals.flush();
  const after = await stat(join(f.stateDir, 'runs.json'));
  assert.equal(after.ino, before.ino, 'an atomic rewrite would replace the inode');
  await assert.rejects(stat(join(f.stateDir, 'created-sessions.json')), { code: 'ENOENT' });
});

test('a queued save that restores earlier content still reaches disk', async t => {
  const f = await fixture(t);
  const { run } = await f.running();
  const live = f.internals.runs.get(run.id)!;
  const original = live.prompt;
  // A, then B and back to A while B is still queued: comparing against the last completed write
  // outside the queue would skip the final A and leave B on disk.
  live.prompt = 'Temporarily different';
  f.internals.persist();
  live.prompt = original;
  f.internals.persist();
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, original);
});

test('a failed run-history write is retried by the next save while saved identities are not rewritten', async t => {
  const f = await fixture(t);
  const { run } = await f.running();
  const runsFile = join(f.stateDir, 'runs.json');
  const createdFile = join(f.stateDir, 'created-sessions.json');
  const session = f.manager.getSession(`codex:${ID}`)!;
  f.internals.createdSessions.set('created-fixture', { session: { ...session, id: 'created-fixture' }, runId: run.id, confirmed: true });
  await rm(runsFile);
  await mkdir(runsFile);
  f.internals.runs.get(run.id)!.prompt = 'Saved after the failure';
  f.internals.persist();
  await assert.rejects(f.internals.flush(), /Cannot save the instruction queue/);
  const identities = await stat(createdFile);
  await rm(runsFile, { recursive: true });
  f.internals.persist();
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, 'Saved after the failure');
  assert.equal((await stat(createdFile)).ino, identities.ino, 'identities already on disk are not written again');
});

const SAVED_STATE = join(import.meta.dirname, 'fixtures', 'saved-state');
const STATE_FILES = ['runs.json', 'created-sessions.json', 'run-instructions.json'] as const;

/** Timestamps a restore stamps now (a run it ends) become a fixed marker; every other byte is compared as written. */
async function normalizedRestore(text: string): Promise<string> {
  const given = new Set<string>();
  for (const file of STATE_FILES) for (const match of (await readFile(join(SAVED_STATE, file), 'utf8')).matchAll(/\d{4}-\d\d-\d\dT[\d:.]+Z/g)) given.add(match[0]);
  return text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, stamp => given.has(stamp) ? stamp : '<restored-at>');
}

test('state saved by the previous build reads back and saves again unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-saved-state-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const file of STATE_FILES) await writeFile(join(stateDir, file), await readFile(join(SAVED_STATE, file)), { mode: 0o600 });
  // Nothing starts: queued runs wait for markReady, and a launch would throw.
  const manager = new RunManager({ stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, holdUntilReady: true,
    findExecutable: async () => { throw new Error('Launch forbidden'); }, spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); } });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.flushState();
  const actual: Record<string, string> = { 'list.json': await normalizedRestore(`${JSON.stringify(manager.list(), null, 1)}\n`) };
  for (const file of STATE_FILES) {
    actual[file] = await normalizedRestore(await readFile(join(stateDir, file), 'utf8'));
    assert.equal((await stat(join(stateDir, file))).mode & 0o777, 0o600, file);
  }
  for (const [file, text] of Object.entries(actual)) {
    const expected = join(SAVED_STATE, `expected-${file}`);
    if (process.env.UPDATE_SAVED_STATE_GOLDEN === '1') await writeFile(expected, text);
    assert.equal(text, await readFile(expected, 'utf8'), file);
  }
});

/** A manager that never starts anything, with its private run table at hand. */
async function quiet(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-history-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'History fixture', cwd: directory, project: 'fixture', status: 'idle', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, pollMs: 60_000, holdUntilReady: true,
    spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); } });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const internals = manager as unknown as Internals & { scheduleContinuation(run: Run, wakeup: { prompt: string; at: number }): void; drain: { settle(run: Run, target: { delegated: boolean; retryAt: number; stopping?: boolean }): void } };
  const saved = async (): Promise<Run[]> => JSON.parse(await readFile(join(stateDir, 'runs.json'), 'utf8'));
  return { directory, stateDir, session, manager, internals, saved };
}
const finishedRun = (id: string, output: string): Run => ({ id, sessionId: `codex:${ID}`, origin: { kind: 'owner' }, prompt: 'Long', status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output });

test('a history over 11.5 MB keeps 2,000 characters of finished output', async t => {
  const f = await quiet(t);
  const ids = Array.from({ length: 4 }, (_, index) => `50000000-0000-4000-8000-00000000000${index}`);
  for (const id of ids) f.internals.runs.set(id, finishedRun(id, 'o'.repeat(3_000_000)));
  f.internals.persist(); await f.internals.flush();
  const saved = await f.saved();
  for (const id of ids) assert.equal(saved.find(run => run.id === id)?.output.length, 2_000);
  assert.equal(f.manager.list().find(run => run.id === ids[0])?.output.length, 3_000_000, 'only the saved copy is shortened');
});

test('when instructions cannot be saved, runs.json is still saved and flushState refuses with 503', async t => {
  t.mock.method(console, 'error', () => {});
  const f = await quiet(t);
  const id = '50000000-0000-4000-8000-000000000010';
  f.internals.runs.set(id, { id, sessionId: `codex:${ID}`, origin: { kind: 'owner' }, prompt: 'Needs policy', status: 'queued', createdAt: new Date().toISOString(), output: '', instructions: { text: 'Policy', required: true } });
  await mkdir(join(f.stateDir, 'run-instructions.json'));
  await assert.rejects(f.manager.flushState(), { kind: 'unavailable', message: /Cannot save instructions of turns still to run/ });
  const saved = await f.saved();
  assert.equal((saved.find(run => run.id === id) as unknown as Record<string, unknown>).needsInstructions, true);
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
