import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { setImmediate as tick } from 'node:timers/promises';
import type { RunApproval } from '../shared/types.js';
import { openCodexStdioRun, type CodexStdioResult } from '../server/runs/codex-stdio.js';

const ROOT = '10000000-0000-4000-8000-000000000001';
const CHILD = '10000000-0000-4000-8000-000000000002';
const GRAND = '10000000-0000-4000-8000-000000000003';
const UNRELATED = '10000000-0000-4000-8000-000000000004';
const ROOT_TURN = 'root-turn';
const CHILD_TURN = 'child-turn';
const START = 1789516800;
type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
const active = (id: string, startedAt = START + 1) => ({ id, startedAt, status: 'inProgress', items: [] });
const metadata = (id: string, parentThreadId: string | null) => ({ id, parentThreadId, agentNickname: id === CHILD ? 'Faraday' : 'Nested', turns: [] });

async function fixture(t: TestContext, settings: { beforeStart?: (f: Harness) => void; onRequest?: (frame: Frame, f: Harness) => boolean } = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const sent: Frame[] = [], approvals: RunApproval[] = [], cleared: string[] = [], finished: CodexStdioResult[] = [];
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { setImmediate(() => child.emit('close', 0, null)); return true; } });
  const f = { sent, approvals, cleared, finished,
    send(frame: Frame) { child.stdout.emit('data', JSON.stringify(frame) + '\n'); },
    notice(method: string, params: any) { f.send({ method, params }); },
    request(id: string, threadId = ROOT, turnId: string | null = ROOT_TURN, overrides: any = {}, method = 'item/commandExecution/requestApproval') { f.send({ id, method, params: { threadId, turnId, itemId: 'same-item', command: 'printf exact-command', availableDecisions: ['accept', 'cancel'], ...overrides } }); },
    thread(id: string, parent: string) { f.notice('thread/started', { thread: metadata(id, parent) }); },
    turn(threadId: string, turnId: string) { f.notice('turn/started', { threadId, turn: active(turnId) }); },
    complete(threadId = ROOT, turnId = ROOT_TURN) { f.notice('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } }); },
  };
  Object.assign(child, { stdin: new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(String(chunk)); sent.push(frame);
    if (!settings.onRequest?.(frame, f)) {
      if (frame.method === 'initialize' || frame.method === 'turn/interrupt') f.send({ id: frame.id, result: {} });
      else if (frame.method === 'thread/resume') f.send({ id: frame.id, result: { thread: { id: ROOT, status: { type: 'idle' } } } });
      else if (frame.method === 'turn/start') { settings.beforeStart?.(f); f.send({ id: frame.id, result: { turn: active(ROOT_TURN, START) } }); }
      else if (frame.method === 'thread/read') f.send({ id: frame.id, result: { thread: metadata(frame.params.threadId, frame.params.threadId === UNRELATED ? null : ROOT) } });
      else if (frame.method === 'thread/turns/list') f.send({ id: frame.id, result: { data: [active(CHILD_TURN)], nextCursor: null } });
      else if (frame.method === 'thread/items/list') f.send({ id: frame.id, result: { data: [], nextCursor: null } });
    }
    callback();
  } }) });
  const run = await openCodexStdioRun({ executable: '/fixture/codex', cwd: '/tmp', threadId: ROOT, prompt: 'task', spawnProcess: () => child,
    onSession() {}, onOutput() {}, onApproval(approval) { approvals.push(approval); }, onApprovalCancelled(id) { cleared.push(id); }, onFinished(result) { finished.push(result); } });
  t.after(async () => { run.close(); await run.done; });
  await run.start(); await tick();
  return { ...f, run };
}
type Harness = { sent: Frame[]; approvals: RunApproval[]; cleared: string[]; finished: CodexStdioResult[]; send(frame: Frame): void; notice(method: string, params: any): void; request(id: string, threadId?: string, turnId?: string | null, overrides?: any, method?: string): void; thread(id: string, parent: string): void; turn(threadId: string, turnId: string): void; complete(threadId?: string, turnId?: string): void };

async function flush() { for (let i = 0; i < 5; i++) await tick(); }

test('parent and verified nested children hold concurrent approvals, with scoped patches and child completion', async t => {
  const f = await fixture(t);
  f.request('parent'); f.thread(GRAND, CHILD); f.turn(GRAND, 'grand-turn'); f.thread(CHILD, ROOT); f.turn(CHILD, CHILD_TURN);
  f.notice('item/started', { threadId: ROOT, turnId: ROOT_TURN, item: { id: 'same-item', type: 'fileChange', changes: [{ path: '/wrong-root', diff: 'root-patch' }] } });
  f.notice('item/started', { threadId: CHILD, turnId: CHILD_TURN, item: { id: 'same-item', type: 'fileChange', changes: [{ path: '/child', diff: 'child-patch' }] } });
  f.request('child-patch', CHILD, CHILD_TURN, {}, 'item/fileChange/requestApproval');
  f.request('nested-network', GRAND, 'grand-turn', { command: null, networkApprovalContext: { host: 'api.github.com', protocol: 'https' } });
  await flush(); assert.equal(f.approvals.length, 3);
  const root = f.approvals.find(a => !a.origin)!;
  const patch = f.approvals.find(a => a.origin?.threadId === CHILD)!;
  const network = f.approvals.find(a => a.origin?.threadId === GRAND)!;
  assert.equal(patch.origin?.agentName, 'Faraday'); assert.equal((patch.input.changes as any[])[0].diff, 'child-patch');
  assert.equal(network.toolName, 'Codex network access'); assert.equal(network.input.command, undefined);
  f.notice('serverRequest/resolved', { threadId: UNRELATED, requestId: 'parent' });
  f.notice('serverRequest/resolved', { threadId: ROOT, turnId: 'old-root-turn', requestId: 'parent' });
  await f.run.respondToApproval(network.id, 'allow');
  f.complete(GRAND, 'grand-turn'); f.complete(CHILD, CHILD_TURN); await flush();
  assert.equal(f.finished.length, 0); assert.ok(f.cleared.includes(patch.id));
  await assert.rejects(f.run.respondToApproval(patch.id, 'allow'), { statusCode: 409 });
  await f.run.respondToApproval(root.id, 'deny');
  assert.deepEqual(f.sent.find(frame => frame.id === 'parent')?.result, { decision: 'cancel' });
  assert.deepEqual(f.sent.find(frame => frame.id === 'nested-network')?.result, { decision: 'accept' });
  f.complete(); await f.run.done; assert.equal(f.finished[0].status, 'completed');
});

test('child requests and patches before root acknowledgement survive metadata and turn ordering', async t => {
  const f = await fixture(t, { beforeStart(f) {
    f.notice('item/started', { threadId: CHILD, turnId: CHILD_TURN, item: { id: 'same-item', type: 'fileChange', changes: [{ path: '/child', diff: 'early-patch' }] } });
    f.request('early-child', CHILD, CHILD_TURN, {}, 'item/fileChange/requestApproval');
    f.thread(CHILD, ROOT); f.turn(CHILD, CHILD_TURN);
  } });
  await flush(); assert.equal(f.approvals.length, 1);
  assert.equal((f.approvals[0].input.changes as any[])[0].diff, 'early-patch');
  await f.run.respondToApproval(f.approvals[0].id, 'deny');
  assert.equal(f.finished.length, 0);
});

test('unknown resumed descendants use metadata and bounded turn summaries, never unrelated or old turns', async t => {
  const f = await fixture(t);
  f.request('resumed', CHILD, CHILD_TURN); await flush();
  assert.equal(f.approvals.length, 1);
  assert.deepEqual(f.sent.find(frame => frame.method === 'thread/read')?.params, { threadId: CHILD, includeTurns: false });
  assert.deepEqual(f.sent.find(frame => frame.method === 'thread/turns/list')?.params, { threadId: CHILD, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
  f.request('unrelated', UNRELATED, CHILD_TURN); f.request('old-root', ROOT, 'older'); f.request('missing-turn', ROOT, null); f.request('old-child', CHILD, 'older'); await flush();
  for (const id of ['unrelated', 'old-root', 'missing-turn', 'old-child']) assert.ok(f.sent.find(frame => frame.id === id)?.error, id);
  assert.equal(f.approvals.length, 1); assert.equal(f.finished.length, 0);
});

test('old child active turn cannot be adopted merely because its ancestry matches', async t => {
  const f = await fixture(t, { onRequest(frame, f) {
    if (frame.method !== 'thread/turns/list') return false;
    f.send({ id: frame.id, result: { data: [active(CHILD_TURN, START - 50)] } }); return true;
  } });
  f.request('old-active-child', CHILD, CHILD_TURN); await flush();
  assert.equal(f.approvals.length, 0); assert.ok(f.sent.find(frame => frame.id === 'old-active-child')?.error);
});

test('resolution, child closure, child completion and root completion preempt delayed ownership lookup', async t => {
  for (const ending of ['resolved', 'child-closed', 'child-completed', 'root-completed']) await t.test(ending, async t => {
    let delayed: Frame | undefined;
    const f = await fixture(t, { onRequest(frame) { if (frame.method !== 'thread/read') return false; delayed = frame; return true; } });
    f.request('delayed', CHILD, CHILD_TURN); await flush(); assert.ok(delayed);
    if (ending === 'resolved') f.notice('serverRequest/resolved', { threadId: CHILD, requestId: 'delayed' });
    if (ending === 'child-closed') f.notice('thread/closed', { threadId: CHILD });
    if (ending === 'child-completed') f.complete(CHILD, CHILD_TURN);
    if (ending === 'root-completed') f.complete();
    f.send({ id: delayed!.id, result: { thread: metadata(CHILD, ROOT) } }); await flush();
    assert.equal(f.approvals.length, 0);
    assert.equal(f.sent.some(frame => frame.id === 'delayed' && frame.result?.decision === 'accept'), false);
    if (ending === 'root-completed') { await f.run.done; assert.equal(f.finished[0].status, 'completed'); }
    else assert.equal(f.finished.length, 0);
  });
});

test('new child turns retire pending approvals and cannot reuse cached old patches', async t => {
  const f = await fixture(t); f.thread(CHILD, ROOT); f.turn(CHILD, CHILD_TURN); f.request('old', CHILD, CHILD_TURN); await flush();
  const old = f.approvals[0]; f.turn(CHILD, 'next-child-turn');
  await assert.rejects(f.run.respondToApproval(old.id, 'allow'), { statusCode: 409 });
  f.request('next', CHILD, 'next-child-turn'); await flush(); assert.equal(f.approvals.length, 2);
  f.notice('serverRequest/resolved', { threadId: CHILD, requestId: 'old' });
  await f.run.respondToApproval(f.approvals[1].id, 'deny');
});

const questions = [{ id: 'choice', header: 'Scope', question: 'Pick a scope', isOther: false, isSecret: false, options: [{ label: 'Local', description: 'Local only' }, { label: 'Remote', description: 'Remote only' }] }, { id: 'secret', header: 'Token', question: 'Provide token', isOther: true, isSecret: true, options: null }];
test('multiple native questions retain original constraints and reply without persisting secret answers', async t => {
  const f = await fixture(t); f.request('questions', ROOT, ROOT_TURN, { questions }, 'item/tool/requestUserInput'); await flush();
  const approval = f.approvals[0]; assert.equal(approval.interaction?.type, 'questions');
  await assert.rejects(f.run.respondToApproval(approval.id, 'allow'), { statusCode: 400 });
  (approval.interaction as any).questions[0].isOther = true;
  await assert.rejects(f.run.respondToApproval(approval.id, { answers: { choice: { answers: ['unlisted'] }, secret: { answers: ['secret-value'] } } }), { statusCode: 400 });
  const answers = { choice: { answers: ['Remote'] }, secret: { answers: ['secret-value'] } };
  await f.run.respondToApproval(approval.id, { answers });
  assert.deepEqual(f.sent.find(frame => frame.id === 'questions')?.result, { answers });
  assert.equal(JSON.stringify(f.approvals).includes('secret-value'), false);
});

test('questions can be cancelled and MCP form/url replies preserve native actions and metadata', async t => {
  const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] };
  for (const mode of ['questions', 'form', 'url']) for (const action of ['accept', 'decline', 'cancel'] as const) await t.test(`${mode}-${action}`, async t => {
    const f = await fixture(t);
    if (mode === 'questions') f.request('interaction', ROOT, ROOT_TURN, { questions }, 'item/tool/requestUserInput');
    else f.request('interaction', ROOT, null, { mode, serverName: 'fixture', message: 'Need your input', requestedSchema: schema, url: 'https://example.com/authorize' }, 'mcpServer/elicitation/request');
    await flush(); const approval = f.approvals[0]; assert.ok(approval);
    if (mode === 'questions') {
      await f.run.respondToApproval(approval.id, 'deny');
      assert.deepEqual(f.sent.find(frame => frame.id === 'interaction')?.result, { answers: {} });
    } else {
      const content = mode === 'form' && action === 'accept' ? { count: 2 } : null;
      await f.run.respondToApproval(approval.id, { action, content });
      assert.deepEqual(f.sent.find(frame => frame.id === 'interaction')?.result, { action, content, _meta: null });
    }
  });
});

test('cancel admission blocks stale allow responses before native interruption completes', async t => {
  const f = await fixture(t); f.request('pending'); await flush(); const approval = f.approvals[0];
  const cancelled = f.run.cancel();
  await assert.rejects(f.run.respondToApproval(approval.id, 'allow'), { statusCode: 409 });
  await flush(); f.notice('turn/completed', { threadId: ROOT, turn: { id: ROOT_TURN, status: 'interrupted', items: [] } });
  await cancelled;
  assert.deepEqual(f.sent.find(frame => frame.id === 'pending')?.result, { decision: 'cancel' });
});

test('cancellation still interrupts when another concurrent approval resolves during denial', async t => {
  const f = await fixture(t, { onRequest(frame, f) {
    if (frame.id === 'first' && frame.result) {
      f.notice('serverRequest/resolved', { threadId: CHILD, requestId: 'second' });
      return true;
    }
    if (frame.method === 'turn/interrupt') {
      f.send({ id: frame.id, result: {} });
      f.notice('turn/completed', { threadId: ROOT, turn: { id: ROOT_TURN, status: 'interrupted', items: [] } });
      return true;
    }
    return false;
  } });
  f.request('first'); f.thread(CHILD, ROOT); f.turn(CHILD, CHILD_TURN); f.request('second', CHILD, CHILD_TURN); await flush();
  assert.equal(f.approvals.length, 2);
  await f.run.cancel();
  assert.equal(f.sent.filter(frame => frame.method === 'turn/interrupt').length, 1);
  assert.equal(f.finished[0].status, 'cancelled');
});

test('a closed child reopens only after fresh active metadata and a new nonretired turn', async t => {
  let loaded = false;
  const f = await fixture(t, { onRequest(frame, f) {
    if (frame.method === 'thread/read') {
      f.send({ id: frame.id, result: { thread: { ...metadata(CHILD, ROOT), status: { type: loaded ? 'active' : 'notLoaded' } } } }); return true;
    }
    if (frame.method === 'thread/turns/list') { f.send({ id: frame.id, result: { data: [active('resumed-turn')] } }); return true; }
    return false;
  } });
  f.thread(CHILD, ROOT); f.turn(CHILD, CHILD_TURN); f.request('original', CHILD, CHILD_TURN); await flush();
  f.notice('thread/closed', { threadId: CHILD });
  await assert.rejects(f.run.respondToApproval(f.approvals[0].id, 'allow'), { statusCode: 409 });
  f.request('unloaded', CHILD, 'resumed-turn'); await flush(); assert.equal(f.approvals.length, 1);
  assert.ok(f.sent.find(frame => frame.id === 'unloaded')?.error);
  loaded = true;
  f.request('resumed', CHILD, 'resumed-turn'); await flush(); assert.equal(f.approvals.length, 2);
  f.request('retired', CHILD, CHILD_TURN); await flush(); assert.ok(f.sent.find(frame => frame.id === 'retired')?.error);
  await f.run.respondToApproval(f.approvals[1].id, 'deny'); assert.equal(f.finished.length, 0);
});

test('a fresh child turn notification reopens a closed descendant but cannot revive its retired turn', async t => {
  const f = await fixture(t); f.thread(CHILD, ROOT); f.turn(CHILD, CHILD_TURN); f.request('old', CHILD, CHILD_TURN); await flush();
  f.notice('thread/closed', { threadId: CHILD }); f.turn(CHILD, CHILD_TURN); f.request('stale', CHILD, CHILD_TURN); await flush();
  assert.equal(f.approvals.length, 1); assert.ok(f.sent.find(frame => frame.id === 'stale')?.error);
  f.turn(CHILD, 'resumed-observed'); f.request('new', CHILD, 'resumed-observed'); await flush();
  assert.equal(f.approvals.length, 2); await f.run.respondToApproval(f.approvals[1].id, 'allow');
});

test('post-close ownership reads never reuse or revive the pre-close lookup', async t => {
  let delayed: Frame | undefined;
  const f = await fixture(t, { onRequest(frame, f) {
    if (frame.method === 'thread/read') {
      if (!delayed) { delayed = frame; return true; }
      f.send({ id: frame.id, result: { thread: { ...metadata(CHILD, ROOT), status: { type: 'active' } } } }); return true;
    }
    if (frame.method === 'thread/turns/list') { f.send({ id: frame.id, result: { data: [active('reopened')] } }); return true; }
    return false;
  } });
  f.request('old-pending', CHILD, CHILD_TURN); await flush(); assert.ok(delayed);
  f.notice('thread/closed', { threadId: CHILD }); f.request('new-pending', CHILD, 'reopened'); await flush();
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].origin?.turnId, 'reopened');
  f.send({ id: delayed!.id, result: { thread: { ...metadata(CHILD, ROOT), status: { type: 'active' } } } }); await flush();
  assert.equal(f.approvals.length, 1);
  f.request('old-after-reopen', CHILD, CHILD_TURN); await flush(); assert.ok(f.sent.find(frame => frame.id === 'old-after-reopen')?.error);
});

test('an explicitly observed old child turn cannot be refreshed by contradictory history metadata', async t => {
  const f = await fixture(t); f.thread(CHILD, ROOT);
  f.notice('turn/started', { threadId: CHILD, turn: active(CHILD_TURN, START - 1) });
  f.request('known-old', CHILD, CHILD_TURN); await flush();
  assert.equal(f.approvals.length, 0); assert.ok(f.sent.find(frame => frame.id === 'known-old')?.error);
});
