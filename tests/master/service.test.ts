import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterJournal } from '../../server/master/journal.js';
import type { ModelCall, ModelItem, ModelRequest } from '../../server/master/model-openai.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterService } from '../../server/master/service.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
import type { MasterDirective, MasterEntry } from '../../shared/master.js';
import type { Snapshot } from '../../shared/types.js';
import { until } from '../helpers/until.js';

const TOKEN = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);

interface Seen { method: string; path: string; body: unknown; token?: string; caller?: string; callsOnDisk?: string }
type Handler = (seen: Seen) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

async function fakeTower(t: test.TestContext, dir: string, handle: Handler) {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry: Seen = { method: req.method!, path: req.url!, body: text ? JSON.parse(text) : undefined, token: req.headers['x-agent-monitor-token'] as string | undefined,
      caller: req.headers['x-tower-master'] as string | undefined, callsOnDisk: await readFile(join(dir, 'calls.json'), 'utf8').catch(() => '') };
    seen.push(entry);
    const answer = await handle(entry);
    res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: (server.address() as { port: number }).port, seen };
}

type Step = ModelItem[] | ((request: ModelRequest, signal: AbortSignal) => ModelItem[] | Promise<ModelItem[]>);
/** A model that answers each request with the next scripted step. */
function scripted(steps: Step[]) {
  const requests: ModelRequest[] = [];
  const model: ModelCall = async (request, _onText, signal) => {
    requests.push(structuredClone(request));
    const next = steps.shift();
    if (!next) throw new Error('no more scripted steps');
    const output = typeof next === 'function' ? await next(request, signal) : next;
    const text = output.filter(item => item.type === 'message').map(item => ((item.content as Array<{ text: string }>)[0]?.text ?? '')).join('');
    return { output, text };
  };
  return { model, requests };
}
const call = (name: string, args: unknown): ModelItem => ({ type: 'function_call', call_id: `c${Math.random().toString(16).slice(2)}`, name, arguments: JSON.stringify(args) });
const say = (text: string): ModelItem => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const toolOutputs = (request: ModelRequest) => request.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(String(item.output)) as Record<string, unknown>);

interface Timing { towerPort?: number; waitForWebMs?: number; turnMs?: number; retryMs?: number; ackMs?: number }
async function master(t: test.TestContext, handle: Handler, steps: Step[], prepare?: (dir: string, journal: MasterJournal, room: MasterRoom) => Promise<void>, settingsPatch: Record<string, unknown> = {}, timing: Timing = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-service-'));
  const tower = await fakeTower(t, dir, handle);
  const settings = new MasterSettingsStore(dir);
  await settings.start();
  await settings.update({ apiKey: 'sk-test-0123456789abcdef', ...settingsPatch });
  const room = new MasterRoom(dir);
  await room.start();
  const journal = new MasterJournal(dir);
  await journal.start();
  await prepare?.(dir, journal, room);
  const client = new TowerClient(timing.waitForWebMs);
  client.setCredentials({ port: timing.towerPort ?? tower.port, token: TOKEN, callerSecret: SECRET });
  const script = scripted(steps);
  const service = new MasterService({ settings, room, journal, tower: client, model: script.model, taskPollMs: 40, ...(timing.turnMs ? { turnMs: timing.turnMs } : {}), ...(timing.retryMs ? { retryMs: timing.retryMs } : {}), ...(timing.ackMs ? { ackMs: timing.ackMs } : {}) });
  await service.start();
  // The service finishes its writes before its folder goes.
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const said = (pattern: RegExp) => until(() => room.recent(60).find(entry => (entry.data.kind === 'master' || entry.data.kind === 'event' || entry.data.kind === 'error') && pattern.test(entry.data.text)));
  return { dir, service, room, journal, tower, script, said };
}

const snapshot = (runs: Snapshot['runs']): Snapshot => ({ sessions: [], runs, providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' });

test('the master delegates what the owner asks through the pages\' own API and reports when the work ends', async t => {
  let status: 'running' | 'completed' = 'running';
  const started = new Date(Date.now() - 5000).toISOString();
  const { service, room, tower, script, said } = await master(t, seen => {
    if (seen.method === 'POST' && seen.path === '/api/sessions') return { status: 202, body: { session: { id: 'claude:s1' }, run: { id: 'r1', sessionId: 'claude:s1' } } };
    if (seen.path === '/api/snapshot') return { body: snapshot([{ id: 'r1', sessionId: 'claude:s1', prompt: 'fix the login bug', status, createdAt: started, startedAt: started, output: '' }]) };
    if (seen.path.startsWith('/api/sessions/claude%3As1')) return { body: { session: { id: 'claude:s1', updatedAt: new Date().toISOString() }, hasMore: false, messages: [
      { id: 'u', role: 'user', text: 'fix the login bug', timestamp: started }, { id: 'm', role: 'assistant', text: 'Fixed the login bug.', timestamp: new Date().toISOString() }] } };
    return { status: 404, body: { error: 'nope' } };
  }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/work/monitor', prompt: 'fix the login bug' } })],
    [say('monitor에 세션을 열어 맡겼습니다.')],
    request => { assert.match(JSON.stringify(request.input), /Delegated work ended/); assert.match(JSON.stringify(request.input), /Fixed the login bug/); return [say('로그인 버그가 고쳐졌습니다.')]; },
  ]);
  await service.send({ clientMessageId: 'message-0001', text: 'monitor에 세션 열어서 로그인 버그 고쳐줘', local: true });
  await said(/맡겼습니다/);
  const created = tower.seen.find(seen => seen.path === '/api/sessions')!;
  assert.equal(created.token, TOKEN, 'a change carries the page token, like the owner\'s page');
  assert.equal(created.caller, SECRET, 'and the master\'s own budget marker');
  assert.match(created.callsOnDisk!, /"state":"sending"/, 'the change was on disk before Tower saw it');
  assert.ok(room.recent(20).some(entry => entry.data.kind === 'task' && entry.data.state === 'running'));
  status = 'completed';
  await said(/고쳐졌습니다/);
  const task = room.recent(30).find(entry => entry.data.kind === 'task')!;
  assert.equal(task.data.kind === 'task' && task.data.state, 'completed');
  assert.equal(task.data.kind === 'task' && task.data.answer, 'Fixed the login bug.');
  assert.equal(script.requests.length, 3);
  // The same message sent twice is one message.
  await service.send({ clientMessageId: 'message-0001', text: 'monitor에 세션 열어서 로그인 버그 고쳐줘', local: true });
  assert.equal(room.recent(60).filter(entry => entry.data.kind === 'owner').length, 1);
});

test('a change whose outcome is unknown is never sent again, and the master is told to check instead', async t => {
  const { service, tower, script, said } = await master(t, seen => seen.method === 'POST' ? { status: 503, body: { error: 'lost', disposition: 'uncertain' } } : { body: {} }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions/claude:s1/messages', body: { prompt: 'continue' } })],
    request => { const [output] = toolOutputs(request); assert.equal(output.state, 'uncertain'); assert.match(String(output.note), /다시 보내지 말고/); return [say('결과를 확인해야 합니다.')]; },
  ]);
  await service.send({ clientMessageId: 'message-0002', text: '이어서 해', local: true });
  await said(/확인해야/);
  assert.equal(tower.seen.filter(seen => seen.method === 'POST').length, 1);
  assert.equal(script.requests.length, 2);
});

test('keys the owner pastes reach Tower but never the model', async t => {
  const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  const { service, tower, script, said } = await master(t, () => ({ body: { configured: true } }), [
    request => {
      const text = JSON.stringify(request.input);
      assert.doesNotMatch(text, /ABCDEFGHIJKLMNOP/);
      const ref = /\{\{secret:[a-f0-9]{16}\}\}/.exec(text)![0];
      return [call('tower_api', { method: 'POST', path: '/api/decisions/settings', body: { apiKey: ref } })];
    },
    [say('키를 저장했습니다.')],
  ]);
  await service.send({ clientMessageId: 'message-0003', text: `Jev 키를 ${key} 로 바꿔줘`, local: true });
  await said(/저장했습니다/);
  assert.deepEqual(tower.seen.find(seen => seen.path === '/api/decisions/settings')!.body, { apiKey: key });
  assert.ok(script.requests.every(request => !JSON.stringify(request).includes(key)));
});

test('account pages stay with this computer: a request typed elsewhere cannot reach them through the master', async t => {
  const { service, tower, said } = await master(t, () => ({ body: {} }), [
    [call('tower_api', { method: 'GET', path: '/api/auth/overview' })],
    request => { assert.match(String(toolOutputs(request)[0].error), /이 컴퓨터/); return [say('이 컴퓨터에서 직접 요청해야 합니다.')]; },
  ]);
  await service.send({ clientMessageId: 'message-0004', text: '계정 설정 보여줘', local: false });
  await said(/직접 요청/);
  assert.equal(tower.seen.length, 0);
});

test('stopping the master ends its thinking but not the work it already sent', async t => {
  const { service, said } = await master(t, () => ({ body: {} }), [
    (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  ]);
  await service.send({ clientMessageId: 'message-0005', text: '생각해 봐', local: true });
  await until(() => service.overview().state === 'thinking');
  assert.equal(service.stop(), true);
  await said(/생각을 멈췄습니다/);
  assert.equal(service.overview().state, 'idle');
});

test('after a restart, a turn that changed nothing runs again and one that did is reported, never repeated', async t => {
  const { said, script, room } = await master(t, () => ({ body: {} }), [[say('다시 처리했습니다.')]], async (_dir, journal, room) => {
    const at = new Date().toISOString();
    room.add({ kind: 'owner', text: 'read only' }, 'in-1');
    room.add({ kind: 'owner', text: 'changed' }, 'in-2');
    const action = room.add({ kind: 'action', turnId: 'turn-2', method: 'POST', path: '/api/sessions', state: 'sending', write: true });
    journal.inbox.push({ id: 'in-1', kind: 'owner', text: 'read only', local: true, at, state: 'processing', turnId: 'turn-1', retries: 0 });
    journal.inbox.push({ id: 'in-2', kind: 'owner', text: 'changed', local: true, at, state: 'processing', turnId: 'turn-2', retries: 0 });
    journal.calls.push({ id: 'call-1', turnId: 'turn-2', inputIds: ['in-2'], method: 'POST', path: '/api/sessions', fingerprint: 'f', state: 'sending', at, entryId: action.id });
    await journal.save('inbox', 'calls');
  });
  await said(/중단됐습니다.*결과를 알 수 없는 것: POST \/api\/sessions/);
  await said(/다시 처리했습니다/);
  assert.equal(script.requests.length, 1);
  assert.match(JSON.stringify(script.requests[0].input), /read only/);
  const action = room.recent(20).find(entry => entry.data.kind === 'action')!;
  assert.equal(action.data.kind === 'action' && action.data.state, 'uncertain');
});

test('a change whose outcome is unknown is not sent again even when the model asks twice in the same request', async t => {
  const body = { prompt: 'continue' };
  const { service, tower, said } = await master(t, seen => seen.method === 'POST' ? { status: 504, body: { error: 'lost', disposition: 'uncertain' } } : { body: {} }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions/claude:s1/messages', body })],
    [call('tower_api', { method: 'POST', path: '/api/sessions/claude:s1/messages', body })],
    request => { assert.equal(toolOutputs(request)[1].state, 'uncertain'); return [say('확인이 필요합니다.')]; },
  ]);
  await service.send({ clientMessageId: 'message-0010', text: '이어서 해', local: true });
  await said(/확인이 필요/);
  assert.equal(tower.seen.filter(seen => seen.method === 'POST').length, 1);
});

test('after "stop thinking", a change already sent finishes and the next one is never sent', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { service, tower, said, room } = await master(t, async seen => {
    if (seen.path === '/api/sessions/claude:a/messages') { await held; return { status: 202, body: { run: { id: 'ra', sessionId: 'claude:a' } } }; }
    return { status: 202, body: { run: { id: 'rb', sessionId: 'claude:b' } } };
  }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions/claude:a/messages', body: { prompt: 'one' } }), call('tower_api', { method: 'POST', path: '/api/sessions/claude:b/messages', body: { prompt: 'two' } })],
  ]);
  await service.send({ clientMessageId: 'message-0011', text: '두 세션에 보내', local: true });
  await until(() => tower.seen.some(seen => seen.path === '/api/sessions/claude:a/messages'));
  assert.equal(service.stop(), true);
  release();
  await said(/생각을 멈췄습니다/);
  assert.equal(tower.seen.some(seen => seen.path === '/api/sessions/claude:b/messages'), false);
  const action = room.recent(20).find(entry => entry.data.kind === 'action')!;
  assert.equal(action.data.kind === 'action' && action.data.state, 'succeeded', 'the change that was on its way is recorded');
});

test('with secrets hidden, a key in an answer from Tower is kept nowhere: not in records, the conversation or the model', async t => {
  const key = 'xoxp-1234567890-abcdefghijklmnop';
  const started = new Date(Date.now() - 5000).toISOString();
  const { service, said, dir, room, script } = await master(t, seen => {
    if (seen.method === 'POST' && seen.path === '/api/slack/connect') return { status: 400, body: { error: `token ${key} was refused` } };
    if (seen.method === 'POST') return { status: 202, body: { session: { id: 'claude:k' }, run: { id: 'rk', sessionId: 'claude:k' } } };
    if (seen.path === '/api/snapshot') return { body: snapshot([{ id: 'rk', sessionId: 'claude:k', prompt: 'p', status: 'completed', createdAt: started, startedAt: started, finishedAt: new Date().toISOString(), output: '' }]) };
    return { body: { session: { id: 'claude:k', updatedAt: new Date(Date.now() + 1000).toISOString() }, hasMore: false, messages: [
      { id: 'u', role: 'user', text: 'p', timestamp: started }, { id: 'a', role: 'assistant', text: `The token is ${key}`, timestamp: new Date().toISOString() }] } };
  }, [
    [call('tower_api', { method: 'POST', path: '/api/slack/connect', body: {} }), call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/w', prompt: 'p' } })],
    [say('보냈습니다.')],
    [say('보고합니다.')],
  ]);
  await service.send({ clientMessageId: 'message-0012', text: '연결해 줘', local: true });
  await said(/보고합니다/);
  await service.close();
  const files = await Promise.all(['calls.json', 'inbox.json', 'tasks.json', 'room/000000.json'].map(name => readFile(join(dir, name), 'utf8')));
  for (const file of files) assert.doesNotMatch(file, /abcdefghijklmnop/);
  assert.doesNotMatch(JSON.stringify(room.recent(50)), /abcdefghijklmnop/);
  assert.doesNotMatch(JSON.stringify(script.requests), /abcdefghijklmnop/);
});

test('a finished task is reported once, even when a restart lands between the report and marking the task', async t => {
  const started = new Date(Date.now() - 5000).toISOString();
  const { journal, said, script } = await master(t, seen => seen.path === '/api/snapshot'
    ? { body: snapshot([{ id: 'r9', sessionId: 'claude:s9', prompt: 'p', status: 'completed', createdAt: started, startedAt: started, finishedAt: started, output: '' }]) }
    : { body: { session: { id: 'claude:s9', updatedAt: new Date().toISOString() }, hasMore: false, messages: [] } }, [[say('보고했습니다.')]], async (_dir, journal, room) => {
    const entry = room.add({ kind: 'task', title: 'fix', state: 'running', sessionId: 'claude:s9', runId: 'r9' });
    journal.tasks.push({ id: 'task-9', entryId: entry.id, sessionId: 'claude:s9', runId: 'r9', title: 'fix', state: 'running', createdAt: started });
    journal.inbox.push({ id: 'event-9', kind: 'event', text: 'Delegated work ended: "fix"', local: false, at: started, state: 'queued', retries: 0, taskId: 'task-9' });
    await journal.save('inbox', 'tasks');
  });
  await said(/보고했습니다/);
  await until(() => journal.tasks[0].state === 'completed');
  assert.equal(journal.inbox.filter(item => item.taskId === 'task-9').length, 1);
  assert.equal(script.requests.length, 1);
});

test('the reported answer is the one the run gave: after its own request, before the next message, once history caught up', async t => {
  const created = new Date(Date.now() - 60_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  let reads = 0;
  const { said, script } = await master(t, seen => {
    if (seen.path === '/api/snapshot') return { body: snapshot([{ id: 'r5', sessionId: 'claude:s5', prompt: 'fix it', status: 'completed', createdAt: at(0), startedAt: at(0), finishedAt: at(20), output: '' }]) };
    reads++;
    // The first read is from before the run's end reached the history.
    return { body: { session: { id: 'claude:s5', updatedAt: reads === 1 ? at(10) : at(40) }, hasMore: false, messages: [
      { id: '0', role: 'assistant', text: 'An earlier answer.', timestamp: at(-30) },
      { id: '1', role: 'user', text: 'fix it', timestamp: at(0) },
      { id: '2', role: 'assistant', text: 'Looking.', timestamp: at(5) },
      { id: '3', role: 'assistant', text: 'Fixed it.', timestamp: at(19) },
      { id: '4', role: 'user', text: 'something else', timestamp: at(30) },
      { id: '5', role: 'assistant', text: 'A later answer.', timestamp: at(35) },
    ] } };
  }, [request => { const text = JSON.stringify(request.input); assert.match(text, /Fixed it\./); assert.doesNotMatch(text, /An earlier answer|A later answer/); assert.match(text, /more messages after this/); return [say('고쳤다고 합니다.')]; }],
  async (_dir, journal, room) => {
    const entry = room.add({ kind: 'task', title: 'fix it', state: 'running', sessionId: 'claude:s5', runId: 'r5' });
    journal.tasks.push({ id: 'task-5', entryId: entry.id, sessionId: 'claude:s5', runId: 'r5', title: 'fix it', state: 'running', createdAt: at(0) });
    await journal.save('tasks');
  });
  await said(/고쳤다고/);
  assert.ok(reads >= 2);
  assert.equal(script.requests.length, 1);
});

test('with a cap set, closing a session counts the queued work it cancels', async t => {
  const { service, tower, said } = await master(t, seen => seen.path === '/api/snapshot'
    ? { body: snapshot([1, 2].map(index => ({ id: `q${index}`, sessionId: 'claude:c', prompt: 'later', status: 'queued' as const, createdAt: new Date().toISOString(), output: '' }))) }
    : { body: {} }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions/claude:c/close', body: {} })],
    request => { assert.match(String(toolOutputs(request)[0].error), /2개까지/); return [say('나눠서 해야 합니다.')]; },
  ], undefined, { guards: { maxIrreversiblePerTurn: 2 } });
  await service.send({ clientMessageId: 'message-0013', text: '그 세션 닫아', local: true });
  await said(/나눠서/);
  assert.equal(tower.seen.some(seen => seen.method === 'POST'), false);
});

test('a stop that comes while a change is being prepared means it is never sent', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { service, tower, said } = await master(t, async seen => {
    if (seen.path === '/api/snapshot') { await held; return { body: snapshot([]) }; }
    return { body: {} };
  }, [[call('tower_api', { method: 'POST', path: '/api/sessions/claude:c/close', body: {} })]], undefined, { guards: { maxIrreversiblePerTurn: 5 } });
  await service.send({ clientMessageId: 'message-0020', text: '그 세션 닫아', local: true });
  await until(() => tower.seen.some(seen => seen.path === '/api/snapshot'));
  service.stop();
  release();
  await said(/생각을 멈췄습니다/);
  assert.equal(tower.seen.some(seen => seen.method === 'POST'), false);
});

test('with a cap set, a change whose reach cannot be checked is not sent', async t => {
  const { service, tower, said } = await master(t, seen => seen.path === '/api/snapshot' ? { status: 500, body: { error: 'down' } } : { body: {} }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions/claude:c/close', body: {} })],
    request => { assert.match(String(toolOutputs(request)[0].error), /확인하지 못해/); return [say('지금은 닫지 못했습니다.')]; },
  ], undefined, { guards: { maxIrreversiblePerTurn: 1 } });
  await service.send({ clientMessageId: 'message-0021', text: '그 세션 닫아', local: true });
  await said(/닫지 못했습니다/);
  assert.equal(tower.seen.some(seen => seen.method === 'POST'), false);
});

test('an earlier request just before the run, or a request out of view, is never taken for the run\'s answer', async t => {
  const created = new Date(Date.now() - 60_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  let view: 'near' | 'missing' = 'near';
  const history = () => view === 'near' ? [
    // Another request one second before this run's own; its answer must not be reported.
    { id: '1', role: 'user', text: 'check the tests', timestamp: at(-1) },
    { id: '2', role: 'assistant', text: 'Tests pass.', timestamp: at(-0.5) },
    { id: '3', role: 'user', text: 'deploy it', timestamp: at(0) },
    { id: '4', role: 'assistant', text: 'Deployed.', timestamp: at(10) },
  ] : [
    { id: '5', role: 'user', text: 'a later request', timestamp: at(30) },
    { id: '6', role: 'assistant', text: 'A later answer.', timestamp: at(31) },
  ];
  const outputs: string[] = [];
  const { said, room, journal } = await master(t, seen => seen.path === '/api/snapshot'
    ? { body: snapshot([{ id: 'r6', sessionId: 'claude:s6', prompt: 'deploy it', status: 'completed', createdAt: at(0), startedAt: at(0), finishedAt: at(20), output: '' },
      { id: 'r7', sessionId: 'claude:s7', prompt: 'deploy it', status: 'completed', createdAt: at(0), startedAt: at(0), finishedAt: at(20), output: '' }]) }
    : { body: { session: { id: 'x', updatedAt: at(40) }, hasMore: false, messages: history() } }, [
    request => { outputs.push(JSON.stringify(request.input)); view = 'missing'; return [say('첫 보고.')]; },
    request => { outputs.push(JSON.stringify(request.input)); return [say('둘째 보고.')]; },
  ], async (_dir, journal, room) => {
    const first = room.add({ kind: 'task', title: 'deploy', state: 'running', sessionId: 'claude:s6', runId: 'r6' });
    journal.tasks.push({ id: 'task-6', entryId: first.id, sessionId: 'claude:s6', runId: 'r6', title: 'deploy', state: 'running', createdAt: at(0) });
    await journal.save('tasks');
  });
  await said(/첫 보고/);
  assert.match(outputs[0], /Deployed\./);
  assert.doesNotMatch(outputs[0], /Tests pass/);
  const second = room.add({ kind: 'task', title: 'deploy again', state: 'running', sessionId: 'claude:s7', runId: 'r7' });
  journal.tasks.push({ id: 'task-7', entryId: second.id, sessionId: 'claude:s7', runId: 'r7', title: 'deploy again', state: 'running', createdAt: at(0) });
  await said(/둘째 보고/);
  assert.doesNotMatch(outputs[1], /A later answer/);
  assert.match(outputs[1], /could not be read/);
});

test('the run\'s request is its whole text within its own time: a longer request that contains it, or the same text later, is not it', async t => {
  const created = new Date(Date.now() - 600_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  let view: 'contains' | 'later' | 'twice' = 'contains';
  const history = () => view === 'contains' ? [
    { id: '1', role: 'user', text: 'do not deploy it', timestamp: at(0.5) },
    { id: '2', role: 'assistant', text: 'I will not deploy.', timestamp: at(1) },
  ] : view === 'later' ? [
    // The run's own request is out of view; the same words asked again much later are another request.
    { id: '3', role: 'user', text: 'deploy it', timestamp: at(400) },
    { id: '4', role: 'assistant', text: 'Deployed again.', timestamp: at(401) },
  ] : [
    { id: '5', role: 'user', text: 'deploy it', timestamp: at(0.5) },
    { id: '6', role: 'assistant', text: 'First.', timestamp: at(1) },
    { id: '7', role: 'user', text: 'deploy it', timestamp: at(2) },
    { id: '8', role: 'assistant', text: 'Second.', timestamp: at(3) },
  ];
  const outputs: string[] = [];
  const runs = ['a', 'b', 'c'].map(name => ({ id: `r-${name}`, sessionId: `claude:${name}`, prompt: 'deploy it', status: 'completed' as const, createdAt: at(0), startedAt: at(0), finishedAt: at(20), output: '' }));
  const { said, room, journal } = await master(t, seen => seen.path === '/api/snapshot' ? { body: snapshot(runs) } : { body: { session: { id: 'x', updatedAt: at(500) }, hasMore: false, messages: history() } }, [
    request => { outputs.push(JSON.stringify(request.input)); view = 'later'; return [say('하나.')]; },
    request => { outputs.push(JSON.stringify(request.input)); view = 'twice'; return [say('둘.')]; },
    request => { outputs.push(JSON.stringify(request.input)); return [say('셋.')]; },
  ]);
  for (const [index, name] of ['a', 'b', 'c'].entries()) {
    const entry = room.add({ kind: 'task', title: `deploy ${name}`, state: 'running', sessionId: `claude:${name}`, runId: `r-${name}` });
    journal.tasks.push({ id: `task-${name}`, entryId: entry.id, sessionId: `claude:${name}`, runId: `r-${name}`, title: `deploy ${name}`, state: 'running', createdAt: at(0) });
    await said(new RegExp(['하나', '둘', '셋'][index]));
  }
  for (const output of outputs) {
    assert.doesNotMatch(output, /I will not deploy|Deployed again|First\.|Second\./);
    assert.match(output, /could not be read/);
  }
});

test('a long run\'s request pages back is still found, reading back only as far as the run\'s start', async t => {
  const created = new Date(Date.now() - 600_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  const tools = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${from + index}`, role: 'tool', text: 'ran a command', timestamp: at(1 + (from + index) * 0.01) }));
  const pages: string[] = [];
  const { said } = await master(t, seen => {
    if (seen.path === '/api/snapshot') return { body: snapshot([{ id: 'r8', sessionId: 'claude:s8', prompt: 'refactor the parser', status: 'completed', createdAt: at(0), startedAt: at(0), finishedAt: at(30), output: '' }]) };
    pages.push(seen.path);
    if (!seen.path.includes('before=')) return { body: { session: { id: 'claude:s8', updatedAt: at(40) }, hasMore: true, nextBefore: 200, messages: [...tools(200, 199), { id: 'a', role: 'assistant', text: 'Refactored.', timestamp: at(29) }] } };
    return { body: { session: { id: 'claude:s8', updatedAt: at(40) }, hasMore: true, nextBefore: 0, messages: [
      { id: 'old', role: 'assistant', text: 'Before.', timestamp: at(-10) }, { id: 'u', role: 'user', text: 'refactor the parser', timestamp: at(0.5) }, ...tools(0, 198)] } };
  }, [request => { assert.match(JSON.stringify(request.input), /Refactored\./); return [say('리팩터링이 끝났습니다.')]; }], async (_dir, journal, room) => {
    const entry = room.add({ kind: 'task', title: 'refactor', state: 'running', sessionId: 'claude:s8', runId: 'r8' });
    journal.tasks.push({ id: 'task-8', entryId: entry.id, sessionId: 'claude:s8', runId: 'r8', title: 'refactor', state: 'running', createdAt: at(0) });
    await journal.save('tasks');
  });
  await said(/리팩터링이 끝났습니다/);
  assert.equal(pages.length, 2, 'it stopped once it had read past the run\'s start');
});

test('when part of the run\'s time cannot be read, no answer is taken from the rest', async t => {
  const created = new Date(Date.now() - 600_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  const { said } = await master(t, seen => {
    if (seen.path === '/api/snapshot') return { body: snapshot([{ id: 'r10', sessionId: 'claude:s10', prompt: 'deploy it', status: 'completed', createdAt: at(0), startedAt: at(0), finishedAt: at(60), output: '' }]) };
    // Every page reaches back only to 30 seconds after the run started, and there is always more.
    const later = [{ id: 'u2', role: 'user', text: 'deploy it', timestamp: at(30) }, { id: 'a2', role: 'assistant', text: 'A later deploy.', timestamp: at(31) }];
    return { body: { session: { id: 'claude:s10', updatedAt: at(70) }, hasMore: true, nextBefore: 1, messages: seen.path.includes('before=') ? [{ id: 't', role: 'tool', text: 'x', timestamp: at(29) }] : later } };
  }, [request => { assert.doesNotMatch(JSON.stringify(request.input), /A later deploy/); assert.match(JSON.stringify(request.input), /could not be read/); return [say('답을 읽지 못했습니다.')]; }], async (_dir, journal, room) => {
    const entry = room.add({ kind: 'task', title: 'deploy', state: 'running', sessionId: 'claude:s10', runId: 'r10' });
    journal.tasks.push({ id: 'task-10', entryId: entry.id, sessionId: 'claude:s10', runId: 'r10', title: 'deploy', state: 'running', createdAt: at(0) });
    await journal.save('tasks');
  });
  await said(/읽지 못했습니다/);
});

test('when an earlier page of the history cannot be read, no answer is taken from the page that could', async t => {
  const created = new Date(Date.now() - 600_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  const { said } = await master(t, seen => {
    if (seen.path === '/api/snapshot') return { body: snapshot([{ id: 'r11', sessionId: 'claude:s11', prompt: 'deploy it', status: 'completed', createdAt: at(0), startedAt: at(0), finishedAt: at(60), output: '' }]) };
    if (seen.path.includes('before=')) return { status: 400, body: { error: 'no such page' } };
    return { body: { session: { id: 'claude:s11', updatedAt: at(70) }, hasMore: true, nextBefore: 7, messages: [{ id: 'u', role: 'user', text: 'deploy it', timestamp: at(30) }, { id: 'a', role: 'assistant', text: 'A later deploy.', timestamp: at(31) }] } };
  }, [request => { assert.doesNotMatch(JSON.stringify(request.input), /A later deploy/); return [say('기록을 다 읽지 못했습니다.')]; }], async (_dir, journal, room) => {
    const entry = room.add({ kind: 'task', title: 'deploy', state: 'running', sessionId: 'claude:s11', runId: 'r11' });
    journal.tasks.push({ id: 'task-11', entryId: entry.id, sessionId: 'claude:s11', runId: 'r11', title: 'deploy', state: 'running', createdAt: at(0) });
    await journal.save('tasks');
  });
  await said(/다 읽지 못했습니다/);
});

/** A port nothing listens on: like a web that went away and did not come back. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

test('a change that never found a web is recorded as not sent, not left as being sent', async t => {
  const { service, journal, script, said } = await master(t, () => ({ body: {} }), [
    [call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/w', prompt: 'x' } })],
    request => { const [output] = toolOutputs(request); assert.equal(output.state, 'not-admitted'); return [say('웹에 닿지 못했습니다.')]; },
  ], undefined, {}, { towerPort: await closedPort(), waitForWebMs: 200 });
  await service.send({ clientMessageId: 'message-0101', text: '세션 열어', local: true });
  await said(/닿지 못했습니다/);
  assert.equal(script.requests.length, 2);
  assert.deepEqual(journal.calls.map(call => call.state), ['not-admitted']);
});

test('a change waiting for the web is not sent once the owner stops the master', async t => {
  let posts = 0;
  const { service, journal, room, said } = await master(t, () => { posts++; return { body: {} }; }, [
    [call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/w', prompt: 'x' } })],
  ], undefined, {}, { towerPort: await closedPort(), waitForWebMs: 5_000 });
  await service.send({ clientMessageId: 'message-0102', text: '세션 열어', local: true });
  await until(() => journal.calls.length === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(service.stop(), true);
  await said(/생각을 멈췄습니다/);
  await until(() => journal.calls[0].state !== 'sending');
  assert.equal(journal.calls[0].state, 'not-admitted');
  assert.equal(posts, 0);
  assert.ok(room.recent(20).some(entry => entry.data.kind === 'action' && entry.data.state === 'not-admitted'));
});

test('a model answer that stalls ends at the turn\'s time limit, and the master takes the next message', async t => {
  const { service, said } = await master(t, () => ({ body: {} }), [
    (_request, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
    [say('다음 요청은 바로 답합니다.')],
  ], undefined, {}, { turnMs: 300 });
  await service.send({ clientMessageId: 'message-0103', text: '느린 질문', local: true });
  await said(/시간이 오래 걸려/);
  await service.send({ clientMessageId: 'message-0104', text: '다음 질문', local: true });
  await said(/바로 답합니다/);
});

test('a turn that failed without changing anything is tried once more; one that changed something is not', async t => {
  const quiet = await master(t, () => ({ body: {} }), [
    () => { throw new Error('rate limited'); },
    [say('두 번째에 답했습니다.')],
  ], undefined, {}, { retryMs: 50 });
  await quiet.service.send({ clientMessageId: 'message-0105', text: '상태 알려줘', local: true });
  await quiet.said(/rate limited — 잠시 뒤 한 번 더/);
  await quiet.said(/두 번째에 답했습니다/);
  await until(() => quiet.journal.inbox[0].state === 'answered');
  assert.equal(quiet.script.requests.length, 2);

  const changed = await master(t, () => ({ status: 202, body: {} }), [
    [call('tower_api', { method: 'POST', path: '/api/groups', body: { cwd: '/w', title: 'W' } })],
    () => { throw new Error('connection lost'); },
  ], undefined, {}, { retryMs: 50 });
  await changed.service.send({ clientMessageId: 'message-0106', text: '폴더 이름 바꿔', local: true });
  await changed.said(/^connection lost$/);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(changed.script.requests.length, 2, 'not tried again after a change was sent');
  assert.equal(changed.journal.inbox[0].state, 'failed');
});

test('after a restart, a turn whose answer was already saved is done, not run again', async t => {
  const { script, journal } = await master(t, () => ({ body: {} }), [], async (_dir, journal, room) => {
    room.add({ kind: 'owner', text: '상태' }, 'in-9');
    room.add({ kind: 'master', text: '이미 답했습니다.', turnId: 'turn-9', final: true });
    journal.inbox.push({ id: 'in-9', kind: 'owner', text: '상태', local: true, at: new Date().toISOString(), state: 'processing', turnId: 'turn-9', retries: 0 });
    await journal.save('inbox');
    await room.flush();
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(script.requests.length, 0);
  assert.equal(journal.inbox[0].state, 'answered');
});

test('delegated work is on disk as watched by the time its call counts as done, Auto Prompts sent through /api/v1 included', async t => {
  let tasksOnDisk = '';
  let callsOnDisk = '';
  const { service, dir, room, said } = await master(t, seen => seen.path === '/api/v1/autoPrompt.submit' ? { body: { result: { job: { id: 'job-1', status: 'queued' } } } } : { body: snapshot([]) }, [
    [call('tower_api', { method: 'POST', path: '/api/v1/autoPrompt.submit', body: { requestId: '0190f1c2-3d4e-7f00-8a00-000000000001', provider: 'claude', prompt: 'tidy the docs' } })],
    async () => {
      tasksOnDisk = await readFile(join(dir, 'tasks.json'), 'utf8');
      callsOnDisk = await readFile(join(dir, 'calls.json'), 'utf8');
      return [say('맡겼습니다.')];
    },
  ]);
  await service.send({ clientMessageId: 'message-0107', text: '문서 정리 맡겨', local: true });
  await said(/맡겼습니다/);
  assert.match(callsOnDisk, /"state":"succeeded"/);
  assert.match(tasksOnDisk, /"jobId":"job-1"/);
  assert.ok(room.recent(20).some(entry => entry.data.kind === 'task' && entry.data.jobId === 'job-1'));
});

test('a longer request that only starts like the run\'s is not its request; the same request with Tower\'s list of attached files is', async t => {
  const created = new Date(Date.now() - 600_000);
  const at = (seconds: number) => new Date(created.getTime() + seconds * 1000).toISOString();
  let view: 'longer' | 'attached' = 'longer';
  const history = () => view === 'longer' ? [
    { id: '1', role: 'user', text: 'deploy it after approval', timestamp: at(0.5) },
    { id: '2', role: 'assistant', text: 'Waiting for approval.', timestamp: at(1) },
  ] : [
    { id: '3', role: 'user', text: 'deploy it\n\n첨부 파일 (사용자가 이번 메시지에 첨부한 로컬 파일):\n- "notes.txt" (text/plain, 12 bytes): "/tmp/notes.txt"', timestamp: at(0.5) },
    { id: '4', role: 'assistant', text: 'Deployed with the notes.', timestamp: at(1) },
  ];
  const outputs: string[] = [];
  const runs = ['a', 'b'].map(name => ({ id: `r-${name}`, sessionId: `claude:${name}`, prompt: 'deploy it', status: 'completed' as const, createdAt: at(0), startedAt: at(0), finishedAt: at(20), output: '' }));
  const { said, room, journal } = await master(t, seen => seen.path === '/api/snapshot' ? { body: snapshot(runs) } : { body: { session: { id: 'x', updatedAt: at(500) }, hasMore: false, messages: history() } }, [
    request => { outputs.push(JSON.stringify(request.input)); view = 'attached'; return [say('하나.')]; },
    request => { outputs.push(JSON.stringify(request.input)); return [say('둘.')]; },
  ]);
  for (const [index, name] of ['a', 'b'].entries()) {
    const entry = room.add({ kind: 'task', title: `deploy ${name}`, state: 'running', sessionId: `claude:${name}`, runId: `r-${name}` });
    journal.tasks.push({ id: `task-${name}`, entryId: entry.id, sessionId: `claude:${name}`, runId: `r-${name}`, title: `deploy ${name}`, state: 'running', createdAt: at(0) });
    await said(new RegExp(['하나', '둘'][index]));
  }
  assert.doesNotMatch(outputs[0], /Waiting for approval/);
  assert.match(outputs[0], /could not be read/);
  assert.match(outputs[1], /Deployed with the notes/);
});

test('a session\'s messages are hidden whole before they are shortened, so a key at the cut never shows in part', async t => {
  const key = 'AKIAABCDEFGHIJKLMNOP';
  const { service, said } = await master(t, () => ({ body: { session: { id: 'claude:s' }, hasMore: false, messages: [{ id: 'm', role: 'assistant', text: `${'x'.repeat(1989)} ${key}`, timestamp: new Date().toISOString() }] } }), [
    [call('session_read', { sessionId: 'claude:s' })],
    request => { assert.doesNotMatch(JSON.stringify(request.input), /AKIAABCDEF/); return [say('읽었습니다.')]; },
  ]);
  await service.send({ clientMessageId: 'message-0108', text: '세션 읽어', local: true });
  await said(/읽었습니다/);
});

test('an answer that could not be saved does not mark its message answered, so a restart does not lose it', async t => {
  const { service, dir, journal } = await master(t, () => ({ body: {} }), [
    async () => {
      // The conversation's file can no longer be written: a directory stands where it should go.
      await rm(join(dir, 'room', '000000.json'), { force: true });
      await mkdir(join(dir, 'room', '000000.json'));
      return [say('답했지만 저장되지 않습니다.')];
    },
    [say('두 번째도 저장되지 않습니다.')],
  ], undefined, {}, { retryMs: 50 });
  await service.send({ clientMessageId: 'message-0109', text: '상태', local: true });
  await until(() => journal.inbox[0].state === 'failed', 10_000);
  assert.notEqual(journal.inbox[0].state, 'answered');
});

test('a second try that was due while the host was down still runs after the restart', async t => {
  const { said, script, journal } = await master(t, () => ({ body: {} }), [[say('다시 시도해 답했습니다.')]], async (_dir, journal, room) => {
    room.add({ kind: 'owner', text: '상태' }, 'in-10');
    journal.inbox.push({ id: 'in-10', kind: 'owner', text: '상태', local: true, at: new Date().toISOString(), state: 'queued', retries: 1, notBefore: new Date(Date.now() + 200).toISOString() });
    await journal.save('inbox');
  });
  await said(/다시 시도해 답했습니다/);
  assert.equal(script.requests.length, 1);
  await until(() => journal.inbox[0].state === 'answered');
});

test('the work a change started is written before the change is recorded as done', async t => {
  let dir = '';
  const { service, said, ...rest } = await master(t, async seen => {
    if (seen.path === '/api/v1/autoPrompt.submit') {
      // The next write of the call records fails, as if the host stopped right there.
      await rm(join(dir, 'calls.json'), { force: true });
      await mkdir(join(dir, 'calls.json'));
      return { body: { result: { job: { id: 'job-2', status: 'queued' } } } };
    }
    return { body: snapshot([]) };
  }, [
    [call('tower_api', { method: 'POST', path: '/api/v1/autoPrompt.submit', body: { requestId: '0190f1c2-3d4e-7f00-8a00-000000000002', provider: 'claude', prompt: 'tidy the docs' } })],
    [say('끝.')],
  ]);
  dir = rest.dir;
  await service.send({ clientMessageId: 'message-0110', text: '문서 정리 맡겨', local: true });
  await said(/끝/);
  assert.match(await readFile(join(dir, 'tasks.json'), 'utf8'), /"jobId":"job-2"/);
});

/** Screen commands the room sent to pages, answered like a page would. */
function screen(room: MasterRoom, answer?: (directive: MasterDirective) => { result: 'done' | 'unavailable' | 'failed'; note?: string } | undefined, service?: () => MasterService) {
  const seen: MasterDirective[] = [];
  room.subscribe(event => {
    if (event.type !== 'directive') return;
    seen.push(event.directive);
    const reply = answer?.(event.directive);
    if (reply) setTimeout(() => service!().ack(event.directive.id, reply.result, reply.note), 5);
  });
  return seen;
}

test('the master works the owner\'s screen in the tab they wrote from, and hears whether the page did it', async t => {
  let answerOf: (directive: MasterDirective) => { result: 'done' | 'unavailable'; note?: string } = () => ({ result: 'done' });
  const { service, room, said } = await master(t, () => ({ body: {} }), [
    [call('ui', { action: 'openSession', sessionId: 'claude:s1' }), call('ui', { action: 'filter', filter: { reset: true, query: 'login', status: 'working' } }), call('ui', { action: 'openPanel', panel: 'account' })],
    request => {
      const outputs = toolOutputs(request);
      assert.equal(outputs[0].result, 'done');
      assert.equal(outputs[1].result, 'done');
      assert.equal(outputs[2].result, 'unavailable');
      assert.match(String(outputs[2].note), /this computer/);
      return [call('ui', { action: 'setPreference', language: 'fr' })];
    },
    request => { assert.match(String(toolOutputs(request).at(-1)!.error), /language/); return [say('화면을 바꿨습니다.')]; },
  ]);
  const seen = screen(room, directive => answerOf(directive), () => service);
  answerOf = directive => directive.kind === 'openPanel' ? { result: 'unavailable', note: 'Account management opens only on a page of this computer itself.' } : { result: 'done' };
  await service.send({ clientMessageId: 'message-0201', text: '로그인 작업 중인 세션 보여줘', local: false, viewContext: { tabId: 'tab-a' } });
  await said(/화면을 바꿨습니다/);
  assert.deepEqual(seen.map(directive => [directive.kind, directive.tabId]), [['openSession', 'tab-a'], ['filter', 'tab-a'], ['openPanel', 'tab-a']]);
  assert.deepEqual(seen[1].kind === 'filter' && seen[1].filter, { reset: true, query: 'login', status: 'working' });
});

test('a screen command no page confirms comes back as unconfirmed; with showing results off, opening becomes a card', async t => {
  const quiet = await master(t, () => ({ body: {} }), [
    [call('ui', { action: 'close' })],
    request => { assert.equal(toolOutputs(request)[0].result, 'no-answer'); return [say('확인되지 않았습니다.')]; },
  ], undefined, {}, { ackMs: 100 });
  await quiet.service.send({ clientMessageId: 'message-0202', text: '대화 닫아', local: true, viewContext: { tabId: 'tab-b' } });
  await quiet.said(/확인되지 않았습니다/);

  const off = await master(t, () => ({ body: {} }), [
    [call('ui', { action: 'openSession', sessionId: 'codex:s2', node: 'a'.repeat(32) })],
    request => { assert.equal(toolOutputs(request)[0].result, 'card'); return [say('열기 버튼을 드렸습니다.')]; },
  ], undefined, { showResults: false });
  const seen = screen(off.room);
  await off.service.send({ clientMessageId: 'message-0203', text: '그 세션 보여줘', local: true, viewContext: { tabId: 'tab-c' } });
  await off.said(/열기 버튼/);
  assert.equal(seen.length, 0, 'nothing is opened on the screen');
  const card = off.room.recent(20).find(entry => entry.data.kind === 'card')!;
  assert.deepEqual(card.data.kind === 'card' && card.data.card.type === 'open' && card.data.card.command, { kind: 'openSession', sessionId: 'codex:s2', node: 'a'.repeat(32) });
});

test('a secret typed into a card reaches Tower but never the model, the conversation or the records, and the card answers once', async t => {
  const value = 'hunter2-correct-horse-battery';
  const { service, room, dir, tower, script, said } = await master(t, seen => seen.method === 'POST' ? { body: { ok: true } } : { body: {} }, [
    [call('request_secret', { purpose: 'Slack bot token' })],
    [say('카드에 입력해 주세요.')],
    request => {
      const text = JSON.stringify(request.input);
      assert.doesNotMatch(text, /hunter2/);
      const reference = /\{\{secret:[a-f0-9]{16}\}\}/.exec(text)![0];
      return [call('tower_api', { method: 'POST', path: '/api/slack/connect', body: { appToken: 'xapp-1-A0-plain', userToken: reference } })];
    },
    [say('연결했습니다.')],
  ], undefined, { guards: { hideSecrets: false } });
  await service.send({ clientMessageId: 'message-0204', text: 'Slack 연결해줘', local: true });
  await said(/카드에 입력/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  // A value too short to be found and hidden reliably is refused; the card still waits.
  await assert.rejects(service.card(card.id, { value: '731' }, true), /8자 이상/);
  await assert.rejects(service.card(card.id, { value: 'prefix{{secret:0123456789abcdef}}suffix' }, true), /\{\{secret:/);
  const answered = await service.card(card.id, { value }, true);
  assert.equal(answered.data.kind === 'card' && answered.data.card.type === 'secret' && answered.data.card.state, 'provided');
  await said(/연결했습니다/);
  assert.deepEqual((tower.seen.find(seen => seen.path === '/api/slack/connect')!.body as { userToken: string }).userToken, value);
  assert.equal(script.requests.length, 4);
  // Answered once: a second answer changes nothing and starts nothing.
  await service.card(card.id, { value: 'another' }, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(script.requests.length, 4);
  await service.close();
  for (const name of ['inbox.json', 'calls.json', 'tasks.json']) assert.doesNotMatch(await readFile(join(dir, name), 'utf8').catch(() => ''), /hunter2/);
  for (const name of await readdir(join(dir, 'room'))) assert.doesNotMatch(await readFile(join(dir, 'room', name), 'utf8'), /hunter2/);
});

test('a secret from a card goes only into secret fields, is hidden when Tower echoes it, and later commands go to the tab that answered', async t => {
  const value = 'correct-horse-battery-staple';
  const { service, room, said, tower } = await master(t, seen => {
    // A careless API that echoes what it was given.
    if (seen.method === 'POST') return { body: { saved: seen.body } };
    return { body: {} };
  }, [
    [call('request_secret', { purpose: 'API password' })],
    [say('카드에 입력해 주세요.')],
    request => {
      const reference = /\{\{secret:[a-f0-9]{16}\}\}/.exec(JSON.stringify(request.input))![0];
      return [call('tower_api', { method: 'POST', path: '/api/sessions/claude:s1/title', body: { title: reference } }), call('tower_api', { method: 'POST', path: '/api/public-agents/password', body: { id: 'a', password: reference } }), call('ui', { action: 'close' })];
    },
    request => {
      const [title, password] = toolOutputs(request);
      assert.match(String(title.error), /비밀 값을 넣을 칸이 없습니다/);
      assert.doesNotMatch(JSON.stringify(request.input), /correct-horse/);
      assert.equal(password.state, 'succeeded');
      return [say('저장했습니다.')];
    },
  ], undefined, { guards: { hideSecrets: false } });
  const seen = screen(room, () => ({ result: 'done' }), () => service);
  await service.send({ clientMessageId: 'message-0207', text: '비밀번호 바꿔줘', local: true, viewContext: { tabId: 'tab-asked' } });
  await said(/카드에 입력/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  await service.card(card.id, { value, tabId: 'tab-answered' }, true);
  await said(/저장했습니다/);
  assert.equal(tower.seen.filter(entry => entry.path.endsWith('/title')).length, 0, 'the title was never sent');
  assert.equal((tower.seen.find(entry => entry.path === '/api/public-agents/password')!.body as { password: string }).password, value);
  assert.deepEqual(seen.map(directive => directive.tabId), ['tab-answered']);
});

test('with key hiding off, a value typed into a secret card is still hidden when the owner pastes it into the chat', async t => {
  const { service, room, said, script } = await master(t, () => ({ body: {} }), [
    [call('request_secret', { purpose: 'password' })],
    [say('카드를 드렸습니다.')],
    [say('받았습니다.')],
    request => { assert.doesNotMatch(JSON.stringify(request.input), /card-password-never-public/); assert.match(JSON.stringify(request.input), /login failed for \{\{secret:/); return [say('로그를 봤습니다.')]; },
  ], undefined, { guards: { hideSecrets: false } });
  await service.send({ clientMessageId: 'message-0208', text: '비밀번호 받아줘', local: true });
  await said(/카드를 드렸습니다/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  await service.card(card.id, { value: 'card-password-never-public' }, true);
  await said(/받았습니다/);
  await service.send({ clientMessageId: 'message-0209', text: 'error: login failed for card-password-never-public', local: true });
  await said(/로그를 봤습니다/);
  assert.equal(script.requests.length, 4);
  assert.ok(room.recent(30).every(entry => !JSON.stringify(entry.data).includes('card-password-never-public')));
});

test('a card value in where the owner is looking is hidden too, and a card that cannot take another value stays open', async t => {
  const { service, room, dir, said, script } = await master(t, () => ({ body: {} }), [
    [call('request_secret', { purpose: 'password' }), call('request_secret', { purpose: 'another' })],
    [say('카드 두 장을 드렸습니다.')],
    [say('받았습니다.')],
    request => { assert.doesNotMatch(JSON.stringify(request.input), /card-password-never-public/); return [say('폴더를 봤습니다.')]; },
  ], undefined, { guards: { hideSecrets: false } });
  await service.send({ clientMessageId: 'message-0210', text: '비밀번호 두 개 받아줘', local: true });
  await said(/두 장/);
  const [first, second] = room.recent(20).filter(entry => entry.data.kind === 'card');
  await service.card(first.id, { value: 'card-password-never-public' }, true);
  await said(/받았습니다/);
  await service.send({ clientMessageId: 'message-0211', text: '이 폴더 봐줘', local: true, viewContext: { tabId: 'tab-x', cwd: '/work/card-password-never-public' } });
  await said(/폴더를 봤습니다/);
  assert.equal(script.requests.length, 4);
  await service.close();
  assert.doesNotMatch(await readFile(join(dir, 'inbox.json'), 'utf8'), /card-password-never-public/);
  // Full: the vault refuses, and the card still waits for a value instead of reading as entered.
  const vault = (service as unknown as { vault: { reference(value: string): string } }).vault;
  for (let index = 0; index < 199; index++) vault.reference(`card-value-${String(index).padStart(4, '0')}`);
  await assert.rejects(service.card(second.id, { value: 'one-card-too-many' }, true), { statusCode: 409 });
  const still = room.get(second.id)!;
  assert.equal(still.data.kind === 'card' && still.data.card.type === 'secret' && still.data.card.state, 'waiting');
});

test('a card value never shows through settings, message ids, page notes or the answer as it is written', async t => {
  const value = 'card-password-never-public';
  const { service, room, dir, said } = await master(t, () => ({ body: {} }), [
    [call('request_secret', { purpose: 'password' })],
    [say('받았습니다.')],
    [call('ui', { action: 'close' })],
    request => { assert.doesNotMatch(JSON.stringify(request.input), /card-password/); return [say('닫았습니다.')]; },
  ]);
  const seen = screen(room, () => ({ result: 'done', note: `closed; the page says ${value}${'!'.repeat(290)}` }), () => service);
  await service.send({ clientMessageId: 'message-0212', text: '비밀번호 받아줘', local: true });
  await said(/받았습니다/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  await service.card(card.id, { value }, true);
  await said(/받았습니다/);
  await assert.rejects(service.updateSettings({ model: value }), /비밀 카드/);
  await service.send({ clientMessageId: `id-${value}`, text: '대화 닫아', local: true, viewContext: { tabId: 'tab-z' } });
  await said(/닫았습니다/);
  assert.equal(seen.length, 1);
  await service.close();
  assert.doesNotMatch(await readFile(join(dir, 'inbox.json'), 'utf8'), /card-password/);
  assert.doesNotMatch(await readFile(join(dir, 'settings.json'), 'utf8').catch(() => ''), /card-password/);
});

test('the answer as it is written never shows a card value, not even the start of one', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-draft-'));
  const settings = new MasterSettingsStore(dir); await settings.start(); await settings.update({ apiKey: 'sk-test-0123456789abcdef' });
  const room = new MasterRoom(dir); await room.start();
  const journal = new MasterJournal(dir); await journal.start();
  const drafts: string[] = [];
  room.subscribe(event => { if (event.type === 'draft' && event.draft) drafts.push(event.draft.text); });
  let turn = 0;
  const model: ModelCall = async (_request, onText) => {
    turn++;
    if (turn === 1) return { output: [call('request_secret', { purpose: 'password' })], text: '' };
    if (turn === 2) return { output: [say('카드를 드렸습니다.')], text: '카드를 드렸습니다.' };
    // The model happens to write the value, in pieces, as a stream does.
    for (const piece of ['the pass is card-pass', 'word-never-', 'public, done']) { onText(piece); await new Promise(resolve => setTimeout(resolve, 200)); }
    return { output: [say('the pass is card-password-never-public, done')], text: 'the pass is card-password-never-public, done' };
  };
  const service = new MasterService({ settings, room, journal, tower: new TowerClient(), model, taskPollMs: 40 });
  await service.start();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  await service.send({ clientMessageId: 'message-0213', text: '비밀번호 받아줘', local: true });
  await until(() => room.recent(10).some(entry => entry.data.kind === 'master'));
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  await service.card(card.id, { value: 'card-password-never-public' }, true);
  await until(() => room.recent(20).filter(entry => entry.data.kind === 'master').length === 2);
  assert.ok(drafts.length >= 2);
  for (const draft of drafts) assert.doesNotMatch(draft, /card-pass/);
  const answer = room.recent(20).filter(entry => entry.data.kind === 'master').at(-1)!;
  assert.doesNotMatch(JSON.stringify(answer.data), /card-password/);
});

test('a card value the model writes out itself goes nowhere: not into requests, the screen, cards, notes or numbers it reads', async t => {
  const value = '97531864';
  const long = 'L'.repeat(4096);
  const { service, room, tower, said } = await master(t, seen => seen.method === 'GET' ? { body: { payload: { selected: 97531864 } } } : { body: {} }, [
    [call('request_secret', { purpose: 'pin' }), call('request_secret', { purpose: 'long' })],
    [say('카드를 드렸습니다.')],
    [say('첫째 받았습니다.')],
    [say('둘째 받았습니다.')],
    [call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/w', prompt: `type ${value}` } }),
      call('tower_api', { method: 'GET', path: '/api/triggers/t/events/e' }),
      call('ui', { action: 'openPanel', panel: 'newSession', cwd: '/w', prompt: `type ${value}` })],
    request => {
      const [post, read, ui] = toolOutputs(request);
      assert.match(String(post.error), /그대로 들어 있습니다/);
      assert.doesNotMatch(JSON.stringify(read), /97531864/);
      assert.doesNotMatch(JSON.stringify(ui), /LLLLLLLL/);
      return [say('끝.')];
    },
  ]);
  const seen = screen(room, () => ({ result: 'done', note: long }), () => service);
  await service.send({ clientMessageId: 'message-0214', text: '핀이랑 긴 값 받아줘', local: true });
  await said(/카드를 드렸습니다/);
  const [pin, longCard] = room.recent(20).filter(entry => entry.data.kind === 'card');
  await service.card(pin.id, { value }, true);
  await said(/첫째 받았습니다/);
  await service.card(longCard.id, { value: long }, true);
  await said(/둘째 받았습니다/);
  await service.send({ clientMessageId: 'message-0215', text: '진행해', local: true, viewContext: { tabId: 'tab-q' } });
  await said(/끝/);
  assert.equal(tower.seen.filter(entry => entry.method === 'POST').length, 0, 'nothing was sent with the value in it');
  assert.equal(seen.length, 1);
  assert.doesNotMatch(JSON.stringify(seen[0]), /97531864/);
});

test('Tower never hands the model a card value: not in results, errors, earlier lines or the card\'s own description', async t => {
  const value = 'hunter2x';
  const quoted = 'abcd"efgh-ijkl';
  const { service, room, tower, said } = await master(t, () => ({ body: {} }), [
    [call('request_secret', { purpose: 'account hunter2x' }), call('request_secret', { purpose: 'quoted' })],
    [say('카드를 드렸습니다.')],
    [say('첫째.')],
    [say('둘째.')],
    [call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/w', prompt: quoted } }),
      call('session_read', { sessionId: 'hunter2x' }),
      call('ui', { action: 'filter', filter: { [quoted]: true } })],
    request => {
      const text = JSON.stringify(request.input.filter(item => item.type !== 'function_call'));
      assert.doesNotMatch(text, /hunter2x|abcd\\"efgh/);
      const [post, read, filter] = toolOutputs(request);
      assert.match(String(post.error), /그대로 들어 있습니다/);
      assert.match(String(read.error), /그대로 들어 있습니다/);
      // A result holding a value with a quote is hidden before it is written out, where the quote would be escaped.
      assert.doesNotMatch(String(filter.error), /abcd/);
      return [say('끝.')];
    },
  ]);
  await service.send({ clientMessageId: 'message-0216', text: '비밀번호 두 개 받아줘', local: true });
  await said(/카드를 드렸습니다/);
  const [first, second] = room.recent(20).filter(entry => entry.data.kind === 'card');
  await service.card(first.id, { value }, true);
  await said(/첫째/);
  await service.card(second.id, { value: quoted }, true);
  await said(/둘째/);
  const card = room.get(first.id)!;
  assert.doesNotMatch(JSON.stringify(card.data), /hunter2x/);
  await service.send({ clientMessageId: 'message-0217', text: '진행해', local: true, viewContext: { tabId: 'tab-r' } });
  await said(/끝/);
  assert.equal(tower.seen.length, 0, 'nothing went out with a card value in it');
});

test('a word from the master\'s own instructions cannot be a card value; a card value in a command\'s text is hidden, the command kept', async t => {
  const { service, room, said } = await master(t, () => ({ body: {} }), [
    [call('request_secret', { purpose: 'word' })],
    [say('카드를 드렸습니다.')],
    [say('받았습니다.')],
    [call('ui', { action: 'openPanel', panel: 'newSession', cwd: '/w', prompt: 'sesame-open-9 please' })],
    [say('열었습니다.')],
  ]);
  const seen = screen(room, () => ({ result: 'done' }), () => service);
  await service.send({ clientMessageId: 'message-0220', text: '단어 받아줘', local: true });
  await said(/카드를 드렸습니다/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  // Words the model is always told (a tool's name, "password") could never be kept from it.
  await assert.rejects(service.card(card.id, { value: 'openPanel' }, true), /안내문/);
  await assert.rejects(service.card(card.id, { value: 'password' }, true), /안내문/);
  await service.card(card.id, { value: 'sesame-open-9' }, true);
  await said(/받았습니다/);
  await service.send({ clientMessageId: 'message-0221', text: '새 세션 창 열어줘', local: true, viewContext: { tabId: 'tab-o' } });
  await said(/열었습니다/);
  assert.equal(seen[0].kind, 'openPanel');
  assert.equal(seen[0].kind === 'openPanel' && seen[0].panel, 'newSession');
  assert.match(seen[0].kind === 'openPanel' ? String(seen[0].prompt) : '', /^\{\{secret:[a-f0-9]{16}\}\} please$/);
});

test('a result gathered before a card was answered reaches the model hidden if it goes out after', async t => {
  const value = 'card-only-value-928xyz';
  let submit: (() => Promise<unknown>) | undefined;
  const { service, room, said } = await master(t, async seen => {
    if (seen.path.startsWith('/api/sessions/claude%3As1')) return { body: { session: { id: 'claude:s1' }, hasMore: false, messages: [{ id: 'm', role: 'user', text: `the token is ${value}`, timestamp: new Date().toISOString() }] } };
    // The owner answers the card while the second lookup of the round is still running.
    if (seen.path === '/api/link') { await submit?.(); return { body: {} }; }
    return { body: {} };
  }, [
    [call('request_secret', { purpose: 'token' })],
    [say('카드를 드렸습니다.')],
    [call('session_read', { sessionId: 'claude:s1' }), call('tower_api', { method: 'GET', path: '/api/link' })],
    request => { assert.doesNotMatch(JSON.stringify(request.input), /card-only-value/); return [say('읽었습니다.')]; },
    [say('받았습니다.')],
  ]);
  await service.send({ clientMessageId: 'message-0224', text: '토큰 받아줘', local: true });
  await said(/카드를 드렸습니다/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  submit = () => service.card(card.id, { value }, true);
  await service.send({ clientMessageId: 'message-0225', text: '그 세션 읽어줘', local: true });
  await said(/읽었습니다/);
  await said(/받았습니다/);
});

test('a notifications card records how it went on the device that pressed it', async t => {
  const { service, room, said } = await master(t, () => ({ body: {} }), [
    [call('browser_action', { kind: 'push-subscribe' })],
    [say('알림 카드를 드렸습니다.')],
  ]);
  await service.send({ clientMessageId: 'message-0205', text: '이 폰에서 알림 받게 해줘', local: true });
  await said(/알림 카드/);
  const card = room.recent(20).find(entry => entry.data.kind === 'card')!;
  const failed = await service.card(card.id, { result: 'failed', note: 'permission denied' }, false);
  assert.deepEqual(failed.data.kind === 'card' && failed.data.card, { type: 'push', state: 'failed', note: 'permission denied' });
  const subscribed = await service.card(card.id, { result: 'subscribed' }, false);
  assert.deepEqual(subscribed.data.kind === 'card' && subscribed.data.card, { type: 'push', state: 'subscribed' });
  await assert.rejects(service.card(card.id.replace(/.$/, '0') === card.id ? card.id.replace(/.$/, '1') : card.id.replace(/.$/, '0'), { result: 'subscribed' }, false), /찾을 수 없습니다/);
});

test('a terminal\'s recent output reads as plain text, with secrets hidden before it is shortened', async t => {
  const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  const terminal = '0190f1c2-3d4e-7f00-8a00-00000000abcd';
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-terminal-'));
  const web = createServer((req, res) => {
    if (req.url === `/api/workspace/terminals/${terminal}/events`) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = [`\u001b[32m$ npm test\u001b[0m\r\n`, `${'x'.repeat(4100)} OPENAI_API_KEY=${key}\r\n`, 'ok 12 tests\r\n'];
      frames.forEach((data, index) => res.write(`id: ${index + 1}\nevent: output\ndata: ${JSON.stringify({ data })}\n\n`));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.closeAllConnections(); await new Promise<void>(resolve => web.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { service, said } = await master(t, () => ({ body: {} }), [
    [call('terminal_read', { terminalId: terminal })],
    request => {
      const [output] = toolOutputs(request);
      assert.doesNotMatch(JSON.stringify(output), /ABCDEFGHIJ|\\u001b/);
      assert.match(String(output.output), /ok 12 tests$/m);
      assert.ok(String(output.output).length <= 4001);
      return [say('테스트가 통과했습니다.')];
    },
  ], undefined, {}, { towerPort: (web.address() as { port: number }).port });
  await service.send({ clientMessageId: 'message-0206', text: '터미널에 뭐 떴어?', local: true });
  await said(/통과했습니다/);
});
