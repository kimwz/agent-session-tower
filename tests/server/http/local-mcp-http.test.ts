import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { ownerMcpOverHttp } from '../../../server/owner-mcp/tools.js';
import type { Snapshot } from '../../../shared/types.js';

const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };

async function serve(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-local-mcp-http-'));
  const { auth, origins, cookie, fetch: remoteFetch } = await createRemoteAuthFixture(dir);
  let port: number | undefined;
  const localMcp = ownerMcpOverHttp(dir, () => port);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, localMcp,
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { localMcp.close(); dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const rpc = (body: unknown, headers: Record<string, string> = {}, send: (input: string, init: RequestInit) => Promise<Response> = fetch) => send(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  return { base, cookie, remoteFetch, rpc };
}

test('an agent reaching this computer\'s localhost (an SSH tunnel too) uses Tower\'s tools at /mcp with nothing installed', async t => {
  const { rpc } = await serve(t);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, 'tower_local');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202, 'a notification has no answer');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 7, result: {} })).status, 202, 'nor a response');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 8, error: { code: 1, message: 'x' } })).status, 202);
  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ['tower_api', 'tower_query', 'session_read', 'terminal_read', 'tower_guide']);
  const call = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tower_api', arguments: { method: 'GET', path: '/api/snapshot' } } })).json();
  const answer = JSON.parse(call.result.content[0].text);
  assert.equal(answer.state, 'succeeded', 'the tools call this web like its own page');
  assert.equal(answer.body.hostname, 'here');
  const guide = JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tower_guide', arguments: {} } })).json()).result.content[0].text);
  assert.ok(guide.includes(`http://127.0.0.1:${new URL(init.url).port}/api/bootstrap`), 'the guide names this web\'s port');
});

test('/mcp is for this computer only, and never for a browser page', async t => {
  const { base, cookie, remoteFetch, rpc } = await serve(t);
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await rpc(list, {}, remoteFetch)).status, 401, 'from elsewhere without signing in');
  assert.equal((await rpc(list, { cookie }, remoteFetch)).status, 403, 'and signed in from elsewhere: the tools would act with localhost\'s rights');
  assert.equal((await rpc(list, { Origin: 'https://evil.example' })).status, 403, 'a page of another site');
  assert.equal((await rpc(list, { Origin: base, 'Sec-Fetch-Site': 'same-origin' })).status, 403, 'nor Tower\'s own page: only agents call it');
  assert.equal((await rpc(list, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(list) })).status, 415, 'a form-like body a page could send without asking');
  assert.equal((await fetch(`${base}/mcp`)).status, 405, 'no server-sent stream');
  const rebound = await new Promise<number>((resolve, reject) => {
    const url = new URL(`${base}/mcp`);
    const req = request({ host: url.hostname, port: url.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end(JSON.stringify(list));
  });
  assert.equal(rebound, 403, 'a name rebound to this computer');
});

test('the /mcp request itself is not a page change; what its tools change counts on the local agents\' budget', async t => {
  const { rpc } = await serve(t);
  for (let index = 0; index < 40; index++) assert.equal((await rpc({ jsonrpc: '2.0', id: index, method: 'ping' })).status, 200);
});
