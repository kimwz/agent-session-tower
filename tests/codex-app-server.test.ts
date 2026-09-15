import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { openCodexBridgeRun, type CodexBridgeOptions } from '../server/codex-app-server.js';

type Request = { id: number; method: string; params: any };
type QueueItem = { id: string; clientUserMessageId: string; input: unknown[] };
type FakeTurn = { id: string; status: string; items: any[]; error?: { message: string } };

async function fixture(t: TestContext, hook?: (request: Request, fake: Fake) => boolean | void) {
  // macOS Unix socket paths are limited to 104 bytes; its usual TMPDIR is long.
  const codexHome = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'am-codex-'));
  await mkdir(join(codexHome, 'app-server-control'));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const fake = new Fake(codexHome, hook);
  wss.on('connection', socket => {
    fake.socket = socket;
    socket.on('message', data => {
      const request = JSON.parse(data.toString());
      fake.requests.push(request);
      if (!request.method || request.method === 'initialized') return;
      if (hook?.(request, fake)) return;
      fake.handle(request);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(codexHome, 'app-server-control/app-server-control.sock'), resolve); });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(codexHome, { recursive: true, force: true });
  });
  return fake;
}

class Fake {
  socket!: WebSocket;
  requests: Request[] = [];
  loaded = ['thread'];
  active = false;
  queue: QueueItem[] = [];
  turns: FakeTurn[] = [];
  constructor(readonly codexHome: string, readonly hook?: (request: Request, fake: Fake) => boolean | void) {}
  reply(request: Request, result: unknown) { this.socket.send(JSON.stringify({ id: request.id, result })); }
  error(request: Request, text: string) { this.socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: text } })); }
  notice(method: string, params: object) { this.socket.send(JSON.stringify({ method, params })); }
  createTurn(queueId: string, announce = true) {
    const index = this.queue.findIndex(item => item.id === queueId);
    assert.notEqual(index, -1);
    const queued = this.queue.splice(index, 1)[0];
    const turn = { id: `turn-${queued.clientUserMessageId}`, status: 'inProgress', items: [{ type: 'userMessage', id: `user-${queued.id}`, clientId: queued.clientUserMessageId }] };
    this.turns.unshift(turn); this.active = true;
    if (announce) {
      this.notice('turn/started', { threadId: 'thread', turn: { ...turn, items: [] } });
      this.notice('item/started', { threadId: 'thread', turnId: turn.id, item: turn.items[0] });
    }
    return turn;
  }
  complete(turn: FakeTurn, text: string, status = 'completed') {
    const item = { type: 'agentMessage', id: `agent-${turn.id}`, text };
    turn.items.push(item); turn.status = status; this.active = false;
    this.notice('item/agentMessage/delta', { threadId: 'thread', turnId: turn.id, itemId: item.id, delta: text });
    this.notice('item/completed', { threadId: 'thread', turnId: turn.id, item });
    this.notice('turn/completed', { threadId: 'thread', turn });
  }
  handle(request: Request) {
    const p = request.params;
    if (request.method === 'initialize') this.reply(request, {});
    else if (request.method === 'thread/loaded/list') this.reply(request, { data: this.loaded, nextCursor: null });
    else if (request.method === 'thread/resume') this.reply(request, { thread: { id: p.threadId } });
    else if (request.method === 'thread/read') this.reply(request, { thread: { id: p.threadId, status: { type: this.active ? 'active' : 'idle' } } });
    else if (request.method === 'thread/queue/add') {
      const queued = { id: `queue-${p.clientUserMessageId}`, clientUserMessageId: p.clientUserMessageId, input: p.input };
      this.queue.push(queued); this.reply(request, { queuedSubmission: queued });
    } else if (request.method === 'thread/queue/list') this.reply(request, { data: this.queue, nextCursor: null });
    else if (request.method === 'thread/queue/start') {
      if (this.active) this.error(request, 'thread already has an active or pending turn');
      else this.reply(request, { turn: this.createTurn(p.queuedSubmissionId) });
    } else if (request.method === 'thread/queue/delete') {
      const index = this.queue.findIndex(item => item.id === p.queuedSubmissionId);
      if (index >= 0) this.queue.splice(index, 1);
      this.reply(request, { deleted: index >= 0 });
    } else if (request.method === 'thread/items/list') {
      let data = this.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
      if (p.turnId) data = data.filter(entry => entry.turnId === p.turnId);
      this.reply(request, { data, nextCursor: null });
    } else if (request.method === 'thread/turns/list') this.reply(request, { data: this.turns.map(turn => ({ ...turn, items: [] })), nextCursor: null });
    else if (request.method === 'turn/interrupt') {
      const turn = this.turns.find(turn => turn.id === p.turnId)!;
      assert.ok(turn); this.reply(request, {}); this.complete(turn, '', 'interrupted');
    } else assert.fail(`Unexpected method ${request.method}`);
  }
}

async function open(fake: Fake, runId = 'monitor-run', imagePaths?: string[]) {
  const started: string[] = [];
  const output: string[] = [];
  const finished: Parameters<CodexBridgeOptions['onFinished']>[0][] = [];
  const bridge = await openCodexBridgeRun({ codexHome: fake.codexHome, threadId: 'thread', runId, prompt: 'Exact prompt: $(never execute)\n새 요청', imagePaths, onStarted: id => { started.push(id); }, onOutput: text => { output.push(text); }, onFinished: result => { finished.push(result); } });
  assert.ok(bridge);
  return { bridge, started, output, finished };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) assert.fail('Timed out waiting for bridge state'); await delay(10); }
}

test('native queue input preserves image paths as localImage blocks in the same thread', async t => {
  const fake = await fixture(t);
  const paths = ['/private/owned upload/image one.png', '/private/owned upload/두번째.jpg'];
  const run = await open(fake, 'images', paths);
  await run.bridge.start();
  const added = fake.requests.find(request => request.method === 'thread/queue/add');
  assert.equal(added!.params.threadId, 'thread');
  assert.deepEqual(added!.params.input.slice(1), paths.map(path => ({ type: 'localImage', path })));
  fake.complete(fake.turns[0], 'Both images received');
  await run.bridge.done;
  assert.equal(run.finished[0].status, 'completed');
});

test('opening is read-only and never resumes or creates an unloaded thread', async t => {
  const fake = await fixture(t);
  fake.loaded = [];
  const bridge = await openCodexBridgeRun({ codexHome: fake.codexHome, threadId: 'thread', runId: 'monitor-run', prompt: 'unused', onStarted() {}, onOutput() {}, onFinished() {} });
  assert.equal(bridge, undefined);
  assert.deepEqual(fake.requests.map(request => request.method), ['initialize', 'initialized', 'thread/loaded/list']);
});

test('existing writer receives the exact queued prompt and output/completion correlate to its turn', async t => {
  const fake = await fixture(t);
  const { bridge, output, started, finished } = await open(fake);
  t.after(() => bridge.close());
  assert.equal(fake.requests.some(request => request.method === 'thread/resume'), false);
  await bridge.start();
  assert.deepEqual(fake.requests.find(request => request.method === 'thread/resume')?.params, { threadId: 'thread', excludeTurns: true });
  assert.deepEqual(fake.requests.find(request => request.method === 'thread/queue/add')?.params.input, [{ type: 'text', text: 'Exact prompt: $(never execute)\n새 요청', text_elements: [] }]);
  assert.equal(fake.requests.some(request => ['thread/start', 'thread/fork', 'turn/start', 'turn/steer', 'command/exec'].includes(request.method)), false);
  fake.notice('item/agentMessage/delta', { threadId: 'another-thread', turnId: 'turn-monitor-run', itemId: 'wrong', delta: 'SECRET OTHER THREAD' });
  fake.notice('turn/completed', { threadId: 'thread', turn: { id: 'other-turn', status: 'completed', items: [] } });
  fake.complete(fake.turns[0], 'Answer from the existing writer');
  await bridge.done;
  assert.deepEqual(started, ['turn-monitor-run']);
  assert.equal(output.join(''), 'Answer from the existing writer\n\n');
  assert.deepEqual(finished, [{ status: 'completed' }]);
});

test('a turn that completes before queue/start responds retains its early output and completion', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/start') return;
    const turn = fake.createTurn(request.params.queuedSubmissionId, false);
    fake.notice('item/agentMessage/delta', { threadId: 'thread', turnId: turn.id, itemId: 'early', delta: 'Fast answer' });
    fake.notice('turn/completed', { threadId: 'thread', turn: { ...turn, status: 'completed', items: [] } });
    fake.notice('item/started', { threadId: 'thread', turnId: turn.id, item: turn.items[0] });
    fake.reply(request, { turn });
    return true;
  });
  const { bridge, output, started, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start(); await bridge.done;
  assert.deepEqual(started, ['turn-monitor-run']);
  assert.equal(output.join(''), 'Fast answer');
  assert.deepEqual(finished, [{ status: 'completed' }]);
});

test('busy start races wait without steering or resending the queued prompt', async t => {
  let busy = true;
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/start' || !busy) return;
    busy = false; fake.error(request, 'thread already has an active or pending turn'); return true;
  });
  const { bridge, started, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  assert.deepEqual(started, []);
  fake.notice('thread/status/changed', { threadId: 'thread', status: { type: 'idle' } });
  await until(() => started.length === 1);
  fake.complete(fake.turns[0], 'Done'); await bridge.done;
  assert.equal(fake.requests.filter(request => request.method === 'thread/queue/add').length, 1);
  assert.equal(fake.requests.filter(request => request.method === 'thread/queue/start').length, 2);
  assert.deepEqual(finished, [{ status: 'completed' }]);
});

test('the desktop may start the queued prompt first and its clientId still identifies the owned turn', async t => {
  const fake = await fixture(t); fake.active = true;
  const { bridge, started, output } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  const turn = fake.createTurn('queue-monitor-run');
  fake.complete(turn, 'Started by desktop'); await bridge.done;
  assert.equal(fake.requests.some(request => request.method === 'thread/queue/start'), false);
  assert.deepEqual(started, [turn.id]);
  assert.equal(output.join(''), 'Started by desktop\n\n');
});

test('queued cancellation deletes only this request and leaves the existing turn and other queue items alone', async t => {
  const fake = await fixture(t); fake.active = true;
  fake.queue.push({ id: 'someone-else', clientUserMessageId: 'external', input: [] });
  const { bridge, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start(); await bridge.cancel(); await bridge.done;
  assert.deepEqual(fake.queue.map(item => item.id), ['someone-else']);
  assert.deepEqual(fake.requests.find(request => request.method === 'thread/queue/delete')?.params, { threadId: 'thread', queuedSubmissionId: 'queue-monitor-run' });
  assert.equal(fake.requests.some(request => request.method === 'turn/interrupt'), false);
  assert.deepEqual(finished, [{ status: 'cancelled' }]);
});

test('cancel racing a desktop start recovers its clientId and interrupts only the matching turn', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/delete') return;
    fake.createTurn(request.params.queuedSubmissionId, false);
    fake.reply(request, { deleted: false }); return true;
  });
  fake.active = true;
  fake.turns.push({ id: 'external-turn', status: 'completed', items: [{ type: 'userMessage', id: 'external-user', clientId: 'external' }] });
  const { bridge, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start(); await bridge.cancel(); await bridge.done;
  assert.deepEqual(fake.requests.find(request => request.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'turn-monitor-run' });
  assert.deepEqual(finished, [{ status: 'cancelled' }]);
});

test('connection loss after queue submission is reported once without retry or a second writer', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/add') return;
    fake.socket.terminate(); return true;
  });
  const { bridge, finished } = await open(fake);
  await bridge.start(); await bridge.done;
  assert.equal(fake.requests.filter(request => request.method === 'thread/queue/add').length, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'error');
  assert.match(finished[0].error!, /자동으로 다시 보내지 않았습니다/);
});

test('closing the bridge only disconnects and never sends an interrupt or approval response', async t => {
  const fake = await fixture(t);
  const { bridge, finished } = await open(fake);
  await bridge.start();
  fake.socket.send(JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn-monitor-run' } }));
  await delay(20);
  bridge.close(); await bridge.done;
  assert.equal(fake.requests.some(request => request.method === 'turn/interrupt' || request.id === 900), false);
  assert.equal(fake.turns[0].status, 'inProgress');
  assert.equal(finished[0].status, 'error');
});

test('missing notifications recover a desktop-started completed turn and its full output from history', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/add') return;
    const queued = { id: 'queue-monitor-run', clientUserMessageId: request.params.clientUserMessageId, input: request.params.input };
    fake.queue.push(queued);
    const turn = fake.createTurn(queued.id, false);
    turn.status = 'completed'; fake.active = false;
    turn.items.push({ type: 'agentMessage', id: 'persisted-answer', text: 'Complete answer from persisted history' });
    fake.reply(request, { queuedSubmission: queued });
    return true;
  });
  const { bridge, started, output, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start(); await bridge.done;
  assert.deepEqual(started, ['turn-monitor-run']);
  assert.equal(output.join(''), 'Complete answer from persisted history\n\n');
  assert.deepEqual(finished, [{ status: 'completed' }]);
  assert.equal(fake.requests.some(request => request.method === 'thread/queue/start'), false);
});

test('a thread unloaded after opening is not resumed by start and no prompt is submitted', async t => {
  const fake = await fixture(t);
  const { bridge, finished } = await open(fake);
  fake.loaded = [];
  await assert.rejects(bridge.start(), /새 writer를 만들지 않았습니다/);
  await bridge.done;
  assert.equal(fake.requests.some(request => ['thread/resume', 'thread/queue/add'].includes(request.method)), false);
  assert.equal(finished[0].status, 'error');
});

test('repeated start calls still add only one prompt', async t => {
  const fake = await fixture(t);
  const { bridge } = await open(fake);
  t.after(() => bridge.close());
  await Promise.all([bridge.start(), bridge.start()]);
  fake.complete(fake.turns[0], 'One task'); await bridge.done;
  assert.equal(fake.requests.filter(request => request.method === 'thread/queue/add').length, 1);
});

test('a stale interrupted turn in queue/start response cannot claim or finish the new request', async t => {
  const previous = { id: 'previous-interrupted', status: 'interrupted', items: [{ id: 'old-user', type: 'userMessage', clientId: 'previous-run' }] };
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/start') return;
    fake.createTurn(request.params.queuedSubmissionId, false);
    fake.notice('turn/completed', { threadId: 'thread', turn: previous });
    fake.reply(request, { turn: previous });
    return true;
  });
  const { bridge, started, output, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
  const own = fake.turns[0];
  fake.notice('item/started', { threadId: 'thread', turnId: own.id, item: own.items[0] });
  fake.notice('turn/completed', { threadId: 'thread', turn: previous });
  fake.complete(own, 'New request actually completed');
  await bridge.done;
  assert.deepEqual(started, [own.id]);
  assert.equal(output.join(''), 'New request actually completed\n\n');
  assert.deepEqual(finished, [{ status: 'completed' }]);
});

test('cancellation after an uncorrelated start response recovers the clientId before interrupting', async t => {
  const previous = { id: 'unrelated-active', status: 'inProgress', items: [{ id: 'other-user', type: 'userMessage', clientId: 'other-run' }] };
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/start') return;
    fake.createTurn(request.params.queuedSubmissionId, false);
    fake.turns.push(previous);
    fake.reply(request, { turn: previous });
    return true;
  });
  const { bridge, started, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  assert.deepEqual(started, []);
  await bridge.cancel(); await bridge.done;
  assert.deepEqual(started, ['turn-monitor-run']);
  assert.deepEqual(fake.requests.find(request => request.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'turn-monitor-run' });
  assert.equal(previous.status, 'inProgress');
  assert.deepEqual(finished, [{ status: 'cancelled' }]);
});

test('a start response without the clientId waits for persisted ownership evidence', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/start') return;
    const own = fake.createTurn(request.params.queuedSubmissionId, false);
    fake.reply(request, { turn: { ...own, items: [] } });
    return true;
  });
  const { bridge, started, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  assert.deepEqual(started, []);
  await until(() => started.length === 1);
  assert.deepEqual(started, ['turn-monitor-run']);
  fake.complete(fake.turns[0], 'Verified from persisted client ID'); await bridge.done;
  assert.deepEqual(finished, [{ status: 'completed' }]);
});

test('a new clientId temporarily attached to the previous interrupted turn waits for a new turn ID', async t => {
  const previous: FakeTurn = { id: 'previous-interrupted', status: 'interrupted', items: [{ id: 'old-user', type: 'userMessage', clientId: 'previous-run' }] };
  let admitted!: QueueItem;
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/add') return;
    admitted = { id: 'queue-monitor-run', clientUserMessageId: request.params.clientUserMessageId, input: request.params.input };
    previous.items.push({ id: 'new-user', type: 'userMessage', clientId: request.params.clientUserMessageId });
    fake.reply(request, { queuedSubmission: admitted });
    return true;
  });
  fake.turns.push(previous);
  const { bridge, started, output, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
  fake.notice('item/started', { threadId: 'thread', turnId: previous.id, item: previous.items[1] });
  fake.notice('turn/completed', { threadId: 'thread', turn: previous });
  await delay(20);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
  fake.queue.push(admitted);
  const own = fake.createTurn(admitted.id);
  fake.complete(own, 'New turn after cancellation completed');
  await bridge.done;
  assert.deepEqual(started, [own.id]);
  assert.equal(output.join(''), 'New turn after cancellation completed\n\n');
  assert.deepEqual(finished, [{ status: 'completed' }]);
});

test('cancellation waits through temporary old-turn ownership until the new queued turn appears', async t => {
  const previous: FakeTurn = { id: 'previous-interrupted', status: 'interrupted', items: [{ id: 'old-user', type: 'userMessage', clientId: 'previous-run' }] };
  let admitted!: QueueItem;
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'thread/queue/start') return;
    admitted = fake.queue.splice(fake.queue.findIndex(item => item.id === request.params.queuedSubmissionId), 1)[0];
    previous.items.push({ id: 'new-user', type: 'userMessage', clientId: admitted.clientUserMessageId });
    fake.reply(request, { turn: previous });
    return true;
  });
  fake.turns.push(previous);
  const { bridge, started, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  let returned = false;
  const cancellation = bridge.cancel().then(() => { returned = true; });
  await until(() => fake.requests.some(request => request.method === 'thread/items/list'));
  await delay(20);
  assert.equal(returned, false);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
  fake.queue.push(admitted);
  fake.createTurn(admitted.id);
  await cancellation; await bridge.done;
  assert.deepEqual(fake.requests.find(request => request.method === 'turn/interrupt')?.params, { threadId: 'thread', turnId: 'turn-monitor-run' });
  assert.deepEqual(finished, [{ status: 'cancelled' }]);
});

test('an interrupt acknowledgement stays pending until the matching turn confirms interruption', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'turn/interrupt') return;
    fake.reply(request, {}); return true;
  });
  const { bridge, finished } = await open(fake);
  t.after(() => bridge.close());
  await bridge.start();
  let returned = false;
  const cancellation = bridge.cancel().then(() => { returned = true; });
  await until(() => fake.requests.some(request => request.method === 'turn/interrupt'));
  await delay(30);
  assert.equal(returned, false);
  assert.equal(fake.turns[0].status, 'inProgress');
  assert.deepEqual(finished, []);
  fake.notice('turn/completed', { threadId: 'thread', turn: { id: 'external-turn', status: 'interrupted', items: [] } });
  await delay(10);
  assert.deepEqual(finished, []);
  fake.complete(fake.turns[0], '', 'interrupted');
  await cancellation; await bridge.done;
  assert.deepEqual(finished, [{ status: 'cancelled' }]);
});

test('an acknowledged interrupt followed by connection loss rejects cancellation and retains unknown status', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'turn/interrupt') return;
    fake.reply(request, {});
    setTimeout(() => fake.socket.terminate(), 10);
    return true;
  });
  const { bridge, finished } = await open(fake);
  await bridge.start();
  await assert.rejects(bridge.cancel(), /연결이 끊겼습니다/);
  await bridge.done;
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'error');
  assert.equal(fake.turns[0].status, 'inProgress');
});

test('closing during cancellation reports unknown completion instead of confirming cancellation', async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'turn/interrupt') return;
    fake.reply(request, {}); return true;
  });
  const { bridge, finished } = await open(fake);
  await bridge.start();
  const rejected = assert.rejects(bridge.cancel(), /원래 앱에서 계속 실행될 수 있습니다/);
  await until(() => fake.requests.some(request => request.method === 'turn/interrupt'));
  bridge.close();
  await rejected; await bridge.done;
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'error');
  assert.equal(fake.turns[0].status, 'inProgress');
});

test('an acknowledged interrupt times out without marking a still-running turn cancelled', { timeout: 16_000 }, async t => {
  const fake = await fixture(t, (request, fake) => {
    if (request.method !== 'turn/interrupt') return;
    fake.reply(request, {}); return true;
  });
  const { bridge, finished } = await open(fake);
  await bridge.start();
  const startedAt = Date.now();
  await assert.rejects(bridge.cancel(), /12초 안에 Codex 작업 종료를 확인하지 못했습니다/);
  await bridge.done;
  assert.ok(Date.now() - startedAt < 15_000);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'error');
  assert.equal(fake.turns[0].status, 'inProgress');
});
