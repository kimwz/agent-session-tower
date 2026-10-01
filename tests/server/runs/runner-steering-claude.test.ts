import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const nativeId = '10000000-0000-4000-8000-000000000001';

async function fixture(options: { holdInit?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-claude-steering-'));
  const session: Session = { id: `claude:${nativeId}`, nativeId, provider: 'claude', title: 'Fixture', cwd: directory,
    project: 'fixture', status: 'completed', statusReason: 'Done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const received: Record<string, any>[] = [];
  const heldInit: (() => void)[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
  const emit = (frame: Record<string, unknown>) => child.stdout.push(JSON.stringify(frame) + '\n');
  const exit = (code = 0) => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: code }); child.emit('close', code, null); };
  Object.assign(child, { stdin: new Writable({ write(chunk, _encoding, done) {
    const input = JSON.parse(String(chunk)); received.push(input);
    const answer = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id } });
    if (input.type === 'control_request') { if (options.holdInit) heldInit.push(answer); else setImmediate(answer); }
    else if (!input.uuid) setImmediate(() => emit({ type: 'system', subtype: 'init', session_id: nativeId }));
    done();
  } }), kill: () => { exit(1); return true; } });
  child.stdin.on('finish', () => setImmediate(() => exit()));
  let launches = 0;
  const manager = new RunManager({ stateDir: directory, getSession: id => id === session.id ? session : undefined,
    refreshSessions: async () => {}, findExecutable: async () => '/fixture/claude', pollMs: 10,
    spawnProcess: () => { launches++; return child; } });
  // What the page last received: the run list as it was when the worker published a change.
  const published = new Map<string, Run>();
  manager.on('change', () => { for (const run of manager.list()) published.set(run.id, run); });
  await manager.start();
  const first = await manager.enqueue(session.id, 'original work');
  const followup = await manager.enqueue(session.id, 'change the direction');
  if (!options.holdInit) await until(() => manager.list().find(run => run.id === followup.id)?.canSteer === true);
  return { manager, session, directory, child, received, emit, exit, first, followup, launches: () => launches, published, heldInit,
    run: (id: string) => manager.list().find(run => run.id === id)!,
    cleanup: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a message queued before Claude is ready is published as insertable once it is', async t => {
  const f = await fixture({ holdInit: true }); t.after(f.cleanup);
  // The answer to the message carries this state; nothing else changes while Claude starts.
  await until(() => f.heldInit.length === 1 && f.run(f.followup.id).steerBlocked === 'starting');
  assert.equal(f.run(f.followup.id).canSteer, false);
  f.published.clear();
  f.heldInit[0]();
  await until(() => f.published.get(f.followup.id)?.canSteer === true);
  assert.equal(f.published.get(f.followup.id)?.steerBlocked, undefined);
});

test('Claude result before steering replay keeps stdin open through the subsequent result', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const pending = f.manager.steer(f.followup.id);
  await until(() => f.received.some(frame => frame.uuid === f.followup.id));
  const input = f.received.find(frame => frame.uuid === f.followup.id)!;
  assert.equal(input.priority, 'next');
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  assert.equal(f.child.stdin.writableEnded, false);
  assert.equal((await pending).steering?.state, 'sending', 'answered once handed over');
  f.emit({ ...input, isReplay: true });
  await until(() => f.run(f.followup.id).steering?.state === 'delivered');
  assert.equal(f.child.stdin.writableEnded, false);
  f.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Updated direction' }] } });
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id).status === 'completed');
  assert.equal(f.run(f.followup.id).status, 'completed');
  assert.equal(f.launches(), 1);
  assert.match(f.run(f.first.id).output, /Updated direction/);
});

test('Claude replay and completion in one output chunk settle both runs without another process', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const pending = f.manager.steer(f.followup.id);
  await until(() => f.received.some(frame => frame.uuid === f.followup.id));
  const input = f.received.find(frame => frame.uuid === f.followup.id)!;
  f.child.stdout.push(JSON.stringify({ ...input, isReplay: true }) + '\n' + JSON.stringify({ type: 'result', is_error: false }) + '\n');
  await pending;
  await until(() => f.run(f.first.id).status === 'completed');
  assert.equal(f.run(f.followup.id).status, 'completed');
  assert.equal(f.launches(), 1);
});

test('a turn busy past the acknowledgment window keeps the instruction pending until Claude takes it', async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal((await f.manager.steer(f.followup.id)).steering?.state, 'sending');
  const input = f.received.find(frame => frame.uuid === f.followup.id)!;
  // Claude is still writing its reply; nothing arrives for a while.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.run(f.followup.id).steering?.state, 'sending');
  assert.equal(f.run(f.followup.id).status, 'running');
  f.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } });
  f.emit({ ...input, isReplay: true });
  await until(() => f.run(f.followup.id).steering?.state === 'delivered');
  f.emit({ type: 'result', session_id: nativeId, is_error: false });
  await until(() => f.run(f.first.id).status === 'completed');
  assert.equal(f.run(f.followup.id).status, 'completed');
});

test('Claude process loss preserves uncertain delivery and never automatically requeues it', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.manager.steer(f.followup.id);
  await until(() => f.received.some(frame => frame.uuid === f.followup.id));
  f.exit(1);
  await until(() => f.run(f.followup.id).steering?.state === 'uncertain');
  assert.equal(f.run(f.followup.id).status, 'error');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.launches(), 1);
});

test('restored steering validates shape and converts in-flight delivery to uncertain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-claude-steering-restore-'));
  const now = new Date().toISOString();
  const base: Run = { id: nativeId, sessionId: `claude:${nativeId}`, prompt: 'test', output: '', createdAt: now, status: 'running' };
  const valid = { ...base, steerBlocked: 'origin', canSteer: true, steering: { targetRunId: '20000000-0000-4000-8000-000000000002', state: 'sending', requestedAt: now } };
  await writeFile(join(directory, 'runs.json'), JSON.stringify([valid, ...[null, 'bad', {}, { ...valid.steering, requestedAt: 42 }].map((steering, index) => ({ ...base, id: `invalid-${index}`, steering }))]));
  const manager = new RunManager({ stateDir: directory, getSession: () => undefined, refreshSessions: async () => {} });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.start();
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].steering?.state, 'uncertain');
  assert.equal(manager.list()[0].status, 'error');
  // Whether it could be inserted belonged to the worker that saved it.
  assert.equal(manager.list()[0].steerBlocked, undefined);
  assert.equal(manager.list()[0].canSteer, false);
});
