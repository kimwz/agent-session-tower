import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { HEALTH_APPLICATION_ID } from '../../shared/app-identity.js';
import { serveToolBridge } from '../../server/mcp/stdio.js';
import { OWNER_TOOLS, OWNER_TOOLS_SERVER, OwnerTools, ownerGuide } from '../../server/owner-mcp/tools.js';

interface Seen { method: string; path: string; token?: string; agent?: string; master?: string; body?: unknown }

/** A web that answers like Tower's on localhost: health, a page token, and whatever the test makes it answer. */
async function fakeWeb(t: test.TestContext, token: string, answer?: (seen: Seen, res: import('node:http').ServerResponse) => boolean) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const item: Seen = { method: req.method!, path: req.url!, token: req.headers['x-agent-monitor-token'] as string, agent: req.headers['x-tower-agent'] as string,
      master: req.headers['x-tower-master'] as string, ...(chunks.length ? { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}) };
    if (req.url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, application: HEALTH_APPLICATION_ID })); return; }
    if (req.url === '/api/bootstrap') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token })); return; }
    seen.push(item);
    if (answer?.(item, res)) return;
    if (item.method === 'POST' && item.token !== token) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '연결 인증이 만료되었습니다. 페이지를 새로고침하세요.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  t.after(close);
  return { port: (server.address() as { port: number }).port, seen, close };
}

test('an agent\'s tools find this computer\'s Tower and act as the owner\'s page, with a budget of their own', async t => {
  const web = await fakeWeb(t, 'a'.repeat(64));
  const tools = new OwnerTools('/unused', { ports: async () => [web.port], waitForWebMs: 2_000 });
  t.after(() => tools.close());

  const read = await tools.call('tower_api', { method: 'GET', path: '/api/skills?cwd=/work' }) as { state: string };
  assert.equal(read.state, 'succeeded');
  const saved = await tools.call('tower_api', { method: 'POST', path: '/api/v1/permissions.save', body: { rule: { pattern: 'gh pr view' } } }) as { state: string };
  assert.equal(saved.state, 'succeeded', 'operations only the owner may use are open to the owner\'s agent');
  const post = web.seen.find(item => item.method === 'POST')!;
  assert.equal(post.token, 'a'.repeat(64), 'a change carries the page token');
  assert.equal(post.agent, 'local', 'and counts on the local agents\' budget');
  assert.equal(post.master, undefined, 'never as the master');
  assert.equal((await tools.call('tower_api', { method: 'POST', path: '/api/master/settings', body: {} }) as { state: string }).state, 'succeeded', 'the master\'s settings are the owner\'s to change');

  assert.match(String((await tools.call('tower_api', { method: 'GET', path: '/api/events' }) as { error: string }).error), /부를 수 없습니다/);
  assert.match(String((await tools.call('tower_api', { method: 'POST', path: '/api/backup/export', body: { passphrase: 'x' } }) as { error: string }).error), /curl/, 'a whole file goes by curl, not in a tool result');
  assert.match(String((await tools.call('ui', { action: 'close' }) as { error: string }).error), /알 수 없는 도구/, 'no screen control');
  assert.equal(web.seen.filter(item => item.path === '/api/events' || item.path === '/api/backup/export').length, 0);
});

test('when Tower\'s web restarts, the tools find it again and a change is sent once', async t => {
  const first = await fakeWeb(t, 'a'.repeat(64));
  let ports = [first.port];
  const tools = new OwnerTools('/unused', { ports: async () => ports, waitForWebMs: 5_000 });
  t.after(() => tools.close());
  assert.equal((await tools.call('tower_api', { method: 'GET', path: '/api/snapshot' }) as { state: string }).state, 'succeeded');

  // A new web on another port with a new page token: the old one refuses connections now.
  await first.close();
  // Its kept-alive connection is gone too, as after any restart.
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await fakeWeb(t, 'b'.repeat(64));
  ports = [second.port];
  const sent = await tools.call('tower_api', { method: 'POST', path: '/api/groups', body: { cwd: '/work', pinned: true } }) as { state: string };
  assert.equal(sent.state, 'succeeded');
  assert.equal(second.seen.filter(item => item.method === 'POST').length, 1);
  assert.equal(second.seen[0]!.token, 'b'.repeat(64));

  // The same web gets a new page token: the stale one is refused before it runs anything, so it goes again.
  let token = 'b'.repeat(64);
  const third = await fakeWeb(t, 'c'.repeat(64), (item, res) => {
    if (item.method === 'POST' && item.path === '/api/sessions' && item.token === 'c'.repeat(64)) { res.destroy(); return true; }
    return false;
  });
  ports = [third.port];
  tools.tower.setCredentials({ port: third.port, token, callerSecret: '' });
  token = 'c'.repeat(64);
  const refused = await tools.call('tower_api', { method: 'POST', path: '/api/groups', body: { cwd: '/work' } }) as { state: string };
  assert.equal(refused.state, 'succeeded', 'a refused page token is renewed and the change sent again');
  assert.deepEqual(third.seen.filter(item => item.path === '/api/groups').map(item => item.token), ['b'.repeat(64), 'c'.repeat(64)]);

  // A change whose answer was lost may have run: it is never sent again.
  const lost = await tools.call('tower_api', { method: 'POST', path: '/api/sessions', body: { provider: 'claude', cwd: '/work', prompt: 'x' } }) as { state: string; note?: string };
  assert.equal(lost.state, 'uncertain');
  assert.match(String(lost.note), /다시 보내지 말고/);
  assert.equal(third.seen.filter(item => item.path === '/api/sessions').length, 1);
});

test('the guide tells an agent every route and each operation\'s input; the tools speak MCP over stdio', async t => {
  const guide = ownerGuide(8123);
  for (const text of ['/api/skills/save', '/api/v1/permissions.save', '/api/backup/export', 'http://127.0.0.1:8123/api/bootstrap', 'X-Tower-Agent: local', 'register-issue']) assert.ok(guide.includes(text), text);
  const tools = new OwnerTools('/unused', { ports: async () => [] });
  t.after(() => tools.close());
  const schema = await tools.call('tower_guide', { operation: 'permissions.save' }) as { route: string; input: { properties: Record<string, unknown> } };
  assert.equal(schema.route, 'POST /api/v1/permissions.save');
  assert.ok(schema.input.properties.rule);
  assert.match(String((await tools.call('tower_guide', { operation: 'nope.nope' }) as { error: string }).error), /알 수 없는 작업/);
  assert.match(String((await tools.call('tower_api', { method: 'GET', path: '/api/snapshot' }) as { error: string }).error), /Tower를 찾지 못했습니다/, 'without a running Tower it says so');

  const input = new PassThrough(), output = new PassThrough();
  const served = serveToolBridge({ name: OWNER_TOOLS_SERVER, listTools: async () => OWNER_TOOLS, callTool: (name, args) => tools.call(name, args) }, input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const [line] = await new Promise<string[]>(resolve => output.once('data', chunk => resolve(String(chunk).trim().split('\n'))));
  const names = (JSON.parse(line!).result.tools as Array<{ name: string }>).map(tool => tool.name);
  assert.deepEqual(names, ['tower_api', 'tower_query', 'session_read', 'terminal_read', 'tower_guide']);
  assert.ok(!(OWNER_TOOLS.find(tool => tool.name === 'tower_query')!.description).includes('delegated('), 'no master-only table in the agent\'s schema');
  input.end();
  await served;
});
