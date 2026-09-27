import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterJournal } from '../../server/master/journal.js';
import type { ModelCall, ModelItem, ModelRequest } from '../../server/master/model-openai.js';
import { MasterRoom } from '../../server/master/room.js';
import { MasterService } from '../../server/master/service.js';
import { MasterSettingsStore } from '../../server/master/settings.js';
import { TowerClient } from '../../server/master/tower-client.js';
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

interface Timing { towerPort?: number; waitForWebMs?: number; turnMs?: number; retryMs?: number }
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
  const service = new MasterService({ settings, room, journal, tower: client, model: script.model, taskPollMs: 40, ...(timing.turnMs ? { turnMs: timing.turnMs } : {}), ...(timing.retryMs ? { retryMs: timing.retryMs } : {}) });
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
