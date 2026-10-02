import { initialModelSettings } from '../../shared/models.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { startMasterHost } from '../../server/master/host.js';
import { MasterClient } from '../../server/master/client.js';
import { startMasterMcp } from '../../server/master/mcp.js';
import { MasterTools } from '../../server/master/tools.js';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { MasterStreamEvent } from '../../shared/master.js';
import { until } from '../helpers/until.js';

const TOKEN = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);

/** A web that answers like Tower's and notes what it was asked. */
async function fakeWeb(t: test.TestContext, remoteSettings?: unknown) {
  const seen: Array<{ method: string; path: string; token?: string; caller?: string; body?: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ method: req.method!, path: req.url!, token: req.headers['x-agent-monitor-token'] as string, caller: req.headers['x-tower-master'] as string, ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}) });
    if (req.url?.endsWith('/v1/models.settings') && remoteSettings) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { settings: remoteSettings } })); return; }
    if (req.method === 'POST' && req.url === '/api/sessions') { res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session: { id: 'claude:new' }, run: { id: 'run-new', sessionId: 'claude:new' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: (server.address() as { port: number }).port, seen };
}

test('the master\'s tools call Tower like a page, follow the work they start, and reach the owner\'s screen only where the master is shown', async t => {
  const web = await fakeWeb(t);
  const tower = new TowerClient(1_000);
  tower.setCredentials({ port: web.port, token: TOKEN, callerSecret: SECRET });
  const events: MasterStreamEvent[] = [];
  const started: string[] = [];
  let tools!: MasterTools;
  tools = new MasterTools({ tower, ackMs: 300, delegated: () => ({ name: 'delegated', columns: [], rows: [] }), started: async target => { started.push(target.local); },
    broadcast: event => { events.push(event); if (event.type === 'directive') setTimeout(() => tools.ack(event.directive.id, 'done'), 5); } });

  const read = await tools.call('tower_api', { method: 'GET', path: '/api/snapshot' }) as { state: string; body: unknown };
  assert.equal(read.state, 'succeeded');
  const created = await tools.call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'codex', cwd: '/work', prompt: 'fix it' } }) as { state: string };
  assert.equal(created.state, 'succeeded');
  assert.deepEqual(started, ['/api/sessions'], 'work a call started is followed');
  const post = web.seen.find(item => item.method === 'POST')!;
  assert.equal(post.token, TOKEN, 'a change carries the page token, like the owner\'s page');
  assert.equal((post.body as { modelRole?: string }).modelRole, 'master.worker');
  assert.equal(post.caller, SECRET, 'and the master\'s own budget marker');
  assert.match(String((await tools.call('tower_api', { method: 'GET', path: '/api/master' }) as { error: string }).error), /부를 수 없습니다/);
  assert.match(String((await tools.call('tower_api', { method: 'GET', path: '/api/../x' }) as { error: string }).error), /올바르지 않습니다/);

  // No page shows the master: nothing is shown anywhere.
  assert.equal((await tools.call('ui', { action: 'openSession', sessionId: 'claude:new' }) as { result: string }).result, 'no-page');
  tools.present('tab-0001');
  assert.deepEqual(await tools.call('ui', { action: 'openSession', sessionId: 'claude:new' }), { result: 'done' });
  const directive = events.find(event => event.type === 'directive');
  assert.equal(directive?.type === 'directive' && directive.directive.tabId, 'tab-0001');
  assert.match(String((await tools.call('ui', { action: 'openPanel', panel: 'nowhere' }) as { error: string }).error), /panel/);
  assert.match(String((await tools.call('nothing', {}) as { error: string }).error), /알 수 없는 도구/);
});

test('the master session\'s tool server lists the tools and relays each call to the running master host, never starting one', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-master-mcp-'));
  const cleanup: Array<() => unknown> = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(stateDir, { recursive: true, force: true }); });
  const web = await fakeWeb(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Array<Record<string, any>> = [];
  let buffer = '';
  output.on('data', chunk => { buffer += String(chunk); for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) { lines.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const serving = startMasterMcp(stateDir, input, output);
  cleanup.push(async () => { input.end(); await serving; });
  const ask = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return until(() => lines.find(line => line.id === id));
  };
  const list = await ask(1, 'tools/list');
  assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ['tower_api', 'tower_query', 'session_read', 'ui', 'terminal_read']);
  // No host runs: the call says so, and none is started.
  const absent = await ask(2, 'tools/call', { name: 'tower_api', arguments: { method: 'GET', path: '/api/snapshot' } });
  assert.equal(absent.result.isError, true);
  assert.match(absent.result.content[0].text, /not running/);
  const host = await startMasterHost({ stateDir, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const page = new MasterClient({ stateDir, credentials: () => ({ port: web.port, token: TOKEN, callerSecret: SECRET }) });
  cleanup.push(() => page.dispose());
  await page.call('hello');
  const answered = await ask(3, 'tools/call', { name: 'tower_api', arguments: { method: 'GET', path: '/api/snapshot' } });
  assert.equal(answered.result.isError, undefined);
  assert.equal(JSON.parse(answered.result.content[0].text).body.path, '/api/snapshot');
});

test('a failed report subscription preserves the accepted work and exposes a warning without replay', async t => {
  const web = await fakeWeb(t);
  const tower = new TowerClient(1_000);
  tower.setCredentials({ port: web.port, token: TOKEN, callerSecret: SECRET });
  const tools = new MasterTools({ tower, delegated: () => ({ name: 'delegated', columns: [], rows: [] }),
    started: async () => { throw new Error('Fixture persistence failure'); }, broadcast: () => {} });
  const answer = await tools.call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'codex', cwd: '/work', prompt: 'fix it' } }) as { state: string; trackingWarning?: string; body: { run: { id: string } } };
  assert.equal(answer.state, 'succeeded');
  assert.equal(answer.body.run.id, 'run-new');
  assert.match(answer.trackingWarning ?? '', /Do not resubmit/);
  assert.equal(web.seen.filter(request => request.method === 'POST').length, 1);
});


test('remote direct creation resolves the receiving role before sending, and an older remote gets no work', async t => {
  const settings = initialModelSettings();
  settings.roles['master.worker'] = { provider: 'claude', claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'low' } };
  for (const supported of [true, false]) {
    const remote = structuredClone(settings);
    if (!supported) delete (remote.roles as Record<string, unknown>)['master.worker'];
    const web = await fakeWeb(t, remote);
    const tower = new TowerClient(1_000); tower.setCredentials({ port: web.port, token: TOKEN, callerSecret: SECRET });
    const tools = new MasterTools({ tower, delegated: () => ({ name: 'delegated', columns: [], rows: [] }), started: async () => {}, broadcast: () => {} });
    const result = await tools.call('tower_api', { method: 'POST', path: '/api/sessions', node: 'c'.repeat(32), body: { provider: 'codex', prompt: 'new', cwd: '/project' } }) as { error?: string };
    const sent = web.seen.filter(item => item.path.endsWith('/sessions'));
    if (!supported) { assert.match(result.error!, /지원하지/); assert.equal(sent.length, 0); }
    else {
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].body, { provider: 'codex', prompt: 'new', cwd: '/project', model: 'gpt-6.1-sol', effort: 'low' });
    }
  }
});

test('master Auto Prompt variants get the selector but existing messages get no defaults', async t => {
  const web = await fakeWeb(t);
  const tower = new TowerClient(1_000); tower.setCredentials({ port: web.port, token: TOKEN, callerSecret: SECRET });
  const tools = new MasterTools({ tower, delegated: () => ({ name: 'delegated', columns: [], rows: [] }), started: async () => {}, broadcast: () => {} });
  for (const path of ['/api/auto-prompts', '/api/v1/autoPrompt.submit']) {
    await tools.call('tower_api', { method: 'POST', path, body: { prompt: 'work', model: 'explicit' } });
    assert.equal((web.seen.at(-1)!.body as any).modelRole, 'master.worker');
    assert.equal((web.seen.at(-1)!.body as any).model, 'explicit');
  }
  await tools.call('tower_api', { method: 'POST', path: '/api/sessions/codex:existing/messages', body: { prompt: 'continue' } });
  assert.deepEqual(web.seen.at(-1)!.body, { prompt: 'continue' });
});
