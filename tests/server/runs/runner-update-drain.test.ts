import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunManager, fixtureDocuments } from './sql-fixture.js';
import { SteeringError } from '../../../server/runs/steering.js';
import { continuedRun, continuedRunById } from '../../../server/runs/continuations.js';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const nativeId = '10000000-0000-4000-8000-000000000001';
const owner = { kind: 'owner' as const };

/** One Claude conversation with a turn running in a fake provider. */
async function fixture(origin: Run['origin'] = owner) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-drain-'));
  const session: Session = { id: `claude:${nativeId}`, nativeId, provider: 'claude', title: 'Fixture', cwd: directory,
    project: 'fixture', status: 'completed', statusReason: 'Done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const received: Record<string, any>[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: undefined });
  const emit = (frame: Record<string, unknown>) => child.stdout.push(JSON.stringify(frame) + '\n');
  const exit = (code = 0) => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: code }); child.emit('close', code, null); };
  Object.assign(child, { stdin: new Writable({ write(chunk, _encoding, done) {
    const input = JSON.parse(String(chunk)); received.push(input);
    if (input.type === 'control_request') setImmediate(() => emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id } }));
    else if (!input.uuid) setImmediate(() => emit({ type: 'system', subtype: 'init', session_id: nativeId }));
    done();
  } }), kill: () => { exit(1); return true; } });
  child.stdin.on('finish', () => setImmediate(() => exit()));
  let launches = 0;
  const manager = new RunManager({ stateDir: directory, getSession: id => id === session.id ? session : undefined,
    refreshSessions: async () => {}, findExecutable: async () => '/fixture/claude', pollMs: 10,
    spawnProcess: () => { launches++; if (launches > 1) throw new Error('fixture: one provider process only'); return child; } });
  await manager.start();
  const first = await manager.enqueue(session.id, 'original work', {}, { origin });
  await until(() => received.some(frame => frame.type === 'user' && !frame.uuid));
  const run = (id: string) => manager.list().find(item => item.id === id);
  const continuation = () => manager.list().find(item => item.scheduled?.resume === 'update');
  return { manager, directory, session, child, received, emit, exit, first, run, continuation, launches: () => launches,
    cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a forced update starts no new turn while running turns go on', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  assert.equal(f.continuation(), undefined, 'nothing is queued for a turn until it ends');
  const later = await f.manager.enqueue(f.session.id, 'another message', {}, { origin: owner });
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id)?.status === 'completed');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.launches(), 1, 'nothing new started');
  assert.equal(f.run(later.id)?.status, 'queued');
  assert.match(f.run(later.id)!.output, /switching to its new version/);
  assert.equal(f.manager.updateDrainStatus()?.running, 0);
});

test('a turn that finishes its own work before any wrap-up gets no continuation', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id)?.status === 'completed');
  assert.equal(f.continuation(), undefined);
});

test('the wrap-up request reaches the running turn once, and the continuation stays the newest run', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  await until(() => f.received.some(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))));
  const wrapUp = f.received.find(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame)))!;
  assert.equal(wrapUp.priority, 'next');
  f.manager.driveUpdateDrain();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.received.filter(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))).length, 1, 'never sent twice');
  f.emit({ ...wrapUp, isReplay: true });
  await until(() => f.run(wrapUp.uuid)?.steering?.state === 'delivered');
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id)?.status === 'completed');
  const resume = f.continuation();
  assert.ok(resume, 'a wrapped-up turn is resumed');
  assert.equal(resume.scheduled?.afterRunId, f.first.id);
  assert.equal(resume.origin?.kind, 'owner');
  const newest = f.manager.list().filter(item => item.sessionId === f.session.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  assert.equal(newest?.id, resume.id);
});

test('a wakeup the turn scheduled survives when it finished its own work before any wrap-up', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'ScheduleWakeup', input: { delaySeconds: 1200, prompt: 'Read the review and continue.', reason: 'waiting' } }] } });
  f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Next wakeup scheduled for 19:52:00 (in 1200s).' }] } });
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id)?.status === 'completed');
  assert.equal(f.continuation(), undefined);
  const wakeup = f.manager.list().find(item => item.scheduled && item.scheduled.resume === undefined);
  assert.equal(wakeup?.prompt, 'Read the review and continue.');
  assert.equal(wakeup?.scheduled?.afterRunId, f.first.id);
});

test('at the deadline a running turn stops with the reason, and its continuation waits', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.run(f.first.id)?.status === 'cancelled');
  assert.match(f.run(f.first.id)!.error ?? '', /Tower update/);
  assert.equal(f.continuation()?.status, 'queued');
});

test('a turn the owner stops during the update is not brought back, even after its wrap-up', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  await until(() => f.received.some(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))));
  await f.manager.cancel(f.first.id);
  assert.equal(f.run(f.first.id)?.status, 'cancelled');
  assert.equal(f.continuation(), undefined);
});

test('a forced update that cannot hand off lets queued turns start again', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  const later = await f.manager.enqueue(f.session.id, 'waits for the switch', {}, { origin: owner });
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id)?.status === 'completed');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.launches(), 1);
  f.manager.endUpdateDrain();
  assert.equal(f.manager.updateDrainStatus(), undefined);
  await until(() => f.launches() === 2);
  assert.notEqual(f.run(later.id)?.status, 'cancelled');
});

test('after a forced update gave up, a turn the owner stops is still not brought back', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  await until(() => f.received.some(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))));
  f.manager.endUpdateDrain();
  await f.manager.cancel(f.first.id);
  await until(() => f.run(f.first.id)?.status === 'cancelled');
  assert.equal(f.continuation(), undefined);
});

test('after a forced update gave up, a turn that wraps up at its request is still resumed', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  await until(() => f.received.some(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))));
  const wrapUp = f.received.find(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame)))!;
  f.manager.endUpdateDrain();
  f.emit({ ...wrapUp, isReplay: true });
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id)?.status === 'completed');
  assert.ok(f.continuation());
});

test('a turn that fails on its own during the update is not resumed', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.exit(1);
  await until(() => f.run(f.first.id)?.status === 'error');
  assert.equal(f.continuation(), undefined);
});

test('delegated work is neither wrapped up nor resumed, and says why it stopped', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, run => run.id === f.first.id);
  assert.equal(f.continuation(), undefined);
  f.manager.driveUpdateDrain();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.received.some(frame => /about to restart/.test(JSON.stringify(frame))), false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.run(f.first.id)?.status === 'cancelled');
  assert.match(f.run(f.first.id)!.error ?? '', /not resumed automatically/);
});

test('a newer message does not replace the update continuation', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.continuation() !== undefined);
  await f.manager.enqueue(f.session.id, 'while updating', {}, { origin: owner });
  assert.equal(f.continuation()?.status, 'queued');
});

test('the next worker keeps queued turns, their instructions and the continuation, and starts them only when ready', async t => {
  const f = await fixture();
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  const receipt = await f.manager.enqueue(f.session.id, 'slack follow-up', {}, { origin: owner, instructions: { text: 'receipt: approved', required: true } });
  const plain = await f.manager.enqueue(f.session.id, 'plain follow-up', {}, { origin: owner });
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.continuation() !== undefined);
  await f.manager.flushState();
  const saved = JSON.parse(JSON.stringify((await fixtureDocuments(f.manager)).runs)) as Record<string, unknown>[];
  assert.equal(JSON.stringify(saved).includes('receipt: approved'), false, 'runs.json never holds instruction text');
  const kept = JSON.parse(JSON.stringify((await fixtureDocuments(f.manager)).instructions)) as Record<string, { text: string }>;
  assert.equal(kept[receipt.id]?.text, 'receipt: approved');

  let launches = 0;
  const next = new RunManager({ stateDir: join(f.directory, 'successor-sql'), fixtureInitial: await fixtureDocuments(f.manager), getSession: id => id === f.session.id ? f.session : undefined,
    refreshSessions: async () => {}, findExecutable: async () => '/fixture/claude', pollMs: 10, holdUntilReady: true,
    spawnProcess: () => { launches++; throw new Error('fixture: not started'); } });
  t.after(async () => { await next.close(); await f.cleanup(); });
  await next.start();
  const restored = (id: string) => next.list().find(item => item.id === id);
  assert.equal(restored(receipt.id)?.status, 'queued');
  assert.equal(restored(plain.id)?.status, 'queued');
  assert.equal(next.list().find(item => item.scheduled?.resume === 'update')?.status, 'queued');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(launches, 0, 'nothing starts before the worker is ready');
});

test('restore keeps every unfinished run and runs an automation still has to report, and 100 finished ones', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-restore-'));
  const at = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const id = (index: number) => `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const base = (index: number): Run => ({ id: id(index), sessionId: `claude:${nativeId}`, prompt: `p${index}`, output: '', createdAt: at(index), status: 'completed' });
  const runs: object[] = [];
  runs.push({ ...base(0), retain: true });
  for (let index = 1; index <= 150; index++) runs.push(base(index));
  for (let index = 151; index <= 260; index++) runs.push({ ...base(index), status: 'queued', keepQueued: true });
  await writeFile(join(directory, 'runs.json'), JSON.stringify(runs));
  const manager = new RunManager({ stateDir: directory, fixtureInitial: { runs: runs as Run[], created: [], instructions: {} }, getSession: () => undefined, refreshSessions: async () => {}, holdUntilReady: true });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.start();
  const list = manager.list();
  assert.ok(list.some(run => run.id === id(0)), 'retained run kept');
  assert.equal(list.filter(run => run.status === 'queued').length, 110);
  assert.equal(list.filter(run => run.status === 'completed' && run.id !== id(0)).length, 100);
  assert.ok(list.some(run => run.id === id(150)) && !list.some(run => run.id === id(1)), 'the newest finished runs are kept');
  await manager.flushState();
  const saved = JSON.parse(JSON.stringify((await fixtureDocuments(manager)).runs)) as Array<Record<string, unknown>>;
  assert.equal(saved.find(run => run.id === id(0))?.retain, true, 'still retained until the automations are loaded');
});

test('history keeps the runs that finished last, not the ones created last', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-prune-'));
  const at = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const id = (index: number) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  // The first run was created first but finished last, like a long turn.
  const runs = [{ id: id(0), sessionId: `claude:${nativeId}`, prompt: 'long', output: '', createdAt: at(0), finishedAt: at(500), status: 'completed' },
    ...Array.from({ length: 120 }, (_, index) => ({ id: id(index + 1), sessionId: `claude:${nativeId}`, prompt: 'short', output: '', createdAt: at(index + 1), finishedAt: at(index + 1), status: 'completed' }))];
  await writeFile(join(directory, 'runs.json'), JSON.stringify(runs));
  const manager = new RunManager({ stateDir: directory, fixtureInitial: { runs: runs as Run[], created: [], instructions: {} }, getSession: () => undefined, refreshSessions: async () => {} });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.start();
  assert.ok(manager.list().some(run => run.id === id(0)));
  assert.equal(manager.list().length, 100);
});

test('after the switch the interrupted turn resumes before a message queued behind it', async t => {
  const f = await fixture();
  const behind = await f.manager.enqueue(f.session.id, 'deploy what the turn builds', {}, { origin: owner });
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.run(f.first.id)?.status === 'cancelled');
  await f.manager.flushState();
  // A provider that starts and keeps running, so only the first run to launch is running.
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stop = () => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: 1 }); child.emit('close', 1, null); };
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, pid: undefined,
    stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }), kill: () => { stop(); return true; } });
  const next = new RunManager({ stateDir: join(f.directory, 'successor-sql'), fixtureInitial: await fixtureDocuments(f.manager), getSession: id => id === f.session.id ? f.session : undefined,
    refreshSessions: async () => {}, findExecutable: async () => '/fixture/claude', pollMs: 10, holdUntilReady: true,
    spawnProcess: () => child });
  t.after(async () => { await next.close(); await f.cleanup(); });
  await next.start();
  next.markReady();
  await until(() => next.list().some(run => run.status === 'running'));
  const running = next.list().find(run => run.status === 'running')!;
  assert.equal(running.scheduled?.resume, 'update', 'the continuation goes first');
  assert.equal(next.list().find(run => run.id === behind.id)?.status, 'queued');
});

test('watchers follow a turn into the continuation that carries it on', () => {
  const now = new Date().toISOString();
  const first: Run = { id: 'a', sessionId: 's', prompt: '', output: '', createdAt: now, status: 'cancelled' };
  const second: Run = { id: 'b', sessionId: 's', prompt: '', output: '', createdAt: now, status: 'cancelled', scheduled: { at: now, afterRunId: 'a', resume: 'update' } };
  const third: Run = { id: 'c', sessionId: 's', prompt: '', output: '', createdAt: now, status: 'running', scheduled: { at: now, afterRunId: 'b', resume: 'update' } };
  const wakeup: Run = { id: 'd', sessionId: 's', prompt: '', output: '', createdAt: now, status: 'queued', scheduled: { at: now, afterRunId: 'c' } };
  assert.equal(continuedRun([first, second, third, wakeup], first)?.id, 'c');
  assert.equal(continuedRun([first, wakeup], first)?.id, 'a');
  assert.equal(continuedRun([], undefined), undefined);
  assert.equal(continuedRunById([second, third], 'a')?.id, 'c', 'found even after the first run left the history');
  const steered: Run = { id: 's', sessionId: 's', prompt: '', output: '', createdAt: now, status: 'cancelled', steering: { targetRunId: 'a', state: 'delivered', requestedAt: now, deliveredAt: now } };
  assert.equal(continuedRun([first, second, third, steered], steered)?.id, 'c', 'an instruction delivered into the turn follows the turn');
  assert.equal(continuedRun([second, third, steered], steered)?.id, 'c', 'also once the turn itself left the history');
});

/** One Codex conversation whose turn runs in a fake adapter; the test decides how a stop and an insert end. */
async function codexFixture(onCancel: (finish: (result: { status: 'completed' | 'error' | 'cancelled'; error?: string }) => void) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-codex-'));
  const id = '20000000-0000-4000-8000-000000000002';
  const session: Session = { id: `codex:${id}`, nativeId: id, provider: 'codex', title: 'Codex', cwd: directory, project: 'fixture', status: 'completed',
    statusReason: 'Done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  let cancels = 0;
  let steers = 0;
  let reject = true;
  const manager = new RunManager({ stateDir: directory, getSession: value => value === session.id ? session : undefined, refreshSessions: async () => {},
    findExecutable: async () => '/fixture/codex', pollMs: 10,
    openCodexStdio: async options => {
      let finished = false;
      const finish = (result: { status: 'completed' | 'error' | 'cancelled'; error?: string }) => { if (finished) return; finished = true; options.onFinished({ ...result, finishedAt: new Date().toISOString() } as never); };
      return { done: Promise.resolve(), close: () => {}, respondToApproval: async () => {},
        start: async () => { options.onStarted?.('turn-1'); },
        canSteer: () => !finished,
        steer: async () => { steers++; if (reject) throw new SteeringError('The turn did not take it.', 'rejected'); },
        cancel: async () => { cancels++; onCancel(finish); } };
    } });
  await manager.start();
  const first = await manager.enqueue(session.id, 'long codex work', {}, { origin: owner });
  await until(() => manager.list().find(run => run.id === first.id)?.status === 'running');
  const continuation = () => manager.list().find(run => run.scheduled?.resume === 'update');
  return { manager, first, continuation, cancels: () => cancels, steers: () => steers, accept: () => { reject = false; },
    run: (runId: string) => manager.list().find(run => run.id === runId),
    cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a stop the deadline could not confirm is not resumed', async t => {
  const f = await codexFixture(finish => finish({ status: 'error', error: 'Could not confirm Codex cancellation.' })); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.run(f.first.id)?.status === 'error');
  assert.equal(f.continuation(), undefined);
});

test('a wrap-up the turn refused is tried again and never counts as reached', async t => {
  let finish!: (result: { status: 'completed' | 'error' | 'cancelled' }) => void;
  const f = await codexFixture(done => { finish = done; }); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  await until(() => f.steers() === 1);
  await until(() => !f.manager.list().some(run => run.updateWrapUp));
  f.manager.driveUpdateDrain(Date.now() + 31_000);
  await until(() => f.steers() === 2); // refused requests are sent again
  await until(() => !f.manager.list().some(run => run.updateWrapUp));
  // The turn then finishes by itself: nothing reached it, so it is not resumed.
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.cancels() === 1);
  finish({ status: 'completed' });
  await until(() => f.run(f.first.id)?.status === 'completed');
  assert.equal(f.continuation(), undefined);
});

test('a second forced update after a give-up sends its own stop, and a confirmed stop is resumed', async t => {
  let finish!: (result: { status: 'completed' | 'error' | 'cancelled' }) => void;
  const f = await codexFixture(done => { finish = done; }); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.cancels() === 1);
  f.manager.endUpdateDrain();
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain(Date.now() + 61_000);
  await until(() => f.cancels() === 2);
  finish({ status: 'cancelled' });
  await until(() => f.run(f.first.id)?.status === 'cancelled');
  assert.equal(f.continuation()?.scheduled?.afterRunId, f.first.id);
});


test('an update continuation retains the trigger event identity used by launch admission', async t => {
  const origin = { kind: 'trigger' as const, triggerId: 'once-reservation', eventId: 'consumed-event' };
  const f = await fixture(origin); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  await until(() => f.received.some(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))));
  const wrapUp = f.received.find(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame)))!;
  f.emit({ ...wrapUp, isReplay: true });
  await until(() => f.run(wrapUp.uuid)?.steering?.state === 'delivered');
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.continuation());
  assert.deepEqual(f.continuation()!.origin, origin);
  assert.equal(f.continuation()!.scheduled!.afterRunId, f.first.id);
});

/** One Codex conversation held by the desktop app, whose submissions wait in the app until they start. */
async function bridgeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-drain-bridge-'));
  const session: Session = { id: `codex:${nativeId}`, nativeId, provider: 'codex', title: 'Bridge fixture', cwd: directory,
    project: 'fixture', status: 'idle', statusReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, activeProcess: true };
  const bridges: Array<{ finish(result: { status: 'completed' | 'cancelled'; withdrawn?: boolean }): void; withdrawn: number }> = [];
  const manager = new RunManager({ stateDir: directory, getSession: id => id === session.id ? session : undefined,
    refreshSessions: async () => {}, findExecutable: async () => '/fixture/codex', pollMs: 10,
    spawnProcess: () => { throw new Error('fixture: no provider process'); },
    openCodexBridge: async options => {
      const state = { withdrawn: 0, finish: (result: { status: 'completed' | 'cancelled'; withdrawn?: boolean }) => options.onFinished(result) };
      bridges.push(state);
      return { done: new Promise<void>(() => {}), start: async () => {}, cancel: async () => { options.onFinished({ status: 'cancelled' }); }, close: () => {},
        withdraw: async () => { state.withdrawn++; options.onFinished({ status: 'cancelled', withdrawn: true }); return 'withdrawn' as const; } };
    } });
  await manager.start();
  return { manager, session, bridges, cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('updateDrainStatus counts running targets and Codex app submissions not yet started', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  assert.equal(f.manager.updateDrainStatus()?.running, 1, 'the running turn');
  const b = await bridgeFixture(); t.after(b.cleanup);
  const submitted = await b.manager.enqueue(b.session.id, 'Sent to the desktop app', {}, { origin: owner });
  await until(() => b.bridges.length === 1 && b.manager.busy());
  b.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  assert.equal(b.manager.updateDrainStatus()?.running, 1, 'the submission the app has not started');
  assert.equal(b.manager.list().find(run => run.id === submitted.id)?.status, 'queued');
});

test('a Codex app submission withdrawn for the update waits for the new worker', async t => {
  const b = await bridgeFixture(); t.after(b.cleanup);
  const submitted = await b.manager.enqueue(b.session.id, 'Sent to the desktop app', {}, { origin: owner });
  await until(() => b.bridges.length === 1 && b.manager.busy());
  b.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  b.manager.driveUpdateDrain();
  await until(() => b.bridges[0].withdrawn === 1);
  const waiting = b.manager.list().find(run => run.id === submitted.id)!;
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.output, 'Waiting: Tower is switching to its new version; this starts right after.');
  assert.equal(waiting.towerTools, undefined);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(b.bridges.length, 1, 'it is not submitted again on this worker');
});

test('a wrap-up request is never saved as keepQueued', async t => {
  const f = await fixture(); t.after(f.cleanup);
  // Inspect the real staged row payloads; the SDK still executes every command.
  const client = f.manager.sqlFixture(), write = client.write.bind(client);
  const writes: Array<Array<Record<string, unknown>>> = [];
  client.write = async <T>(...args: Parameters<typeof client.write>) => {
    if (args[0] === 'runs' && args[1] === 'stage') {
      const lines = Buffer.from((args[2] as { data: string }).data, 'base64').toString('utf8').trim().split('\n');
      writes.push(lines.slice(1).map(line => JSON.parse(line)).filter(row => row.kind === 'run' && !row.remove).map(row => row.value));
    }
    return write<T>(...args);
  };
  t.after(() => { client.write = write; });
  const waiting = await f.manager.enqueue(f.session.id, 'queued behind the turn', {}, { origin: owner });
  f.manager.beginUpdateDrain(Date.now() + 60_000, () => false);
  f.manager.driveUpdateDrain();
  // Observe the dispatch this fixture started before its shutdown removes the state directory.
  await until(() => f.received.some(frame => frame.uuid && /about to restart/.test(JSON.stringify(frame))));
  await f.manager.flushState();
  const saved = writes.flat();
  const wrapUps = saved.filter(run => run.updateWrapUp);
  assert.ok(wrapUps.some(run => run.status === 'queued'), 'a save saw the wrap-up while it was still queued');
  assert.ok(wrapUps.every(run => run.keepQueued === undefined));
  assert.ok(saved.some(run => run.id === waiting.id && run.keepQueued === true), 'a message accepted during the switch is kept queued');
});
