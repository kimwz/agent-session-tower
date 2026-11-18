import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/skip-fsync.js';
import { fastScrypt } from '../../helpers/fast-scrypt.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../../../server/auth/store.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { ownerMcpOverHttp } from '../../../server/owner-mcp/tools.js';
import { RemoteMcpKeys } from '../../../server/remote-mcp/keys.js';
import { remoteMcpOverHttp } from '../../../server/remote-mcp/tools.js';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import type { RemoteMcpCreated, RemoteMcpOverview } from '../../../shared/remote-mcp.js';
import type { Snapshot } from '../../../shared/types.js';

fastScrypt();

const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
const PASSWORD = 'fixture-password-123';
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: any };

/** A Tower whose public address is HTTPS (as behind Cloudflare Access), with a plain-HTTP public address beside it. */
async function serve(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-remote-mcp-http-'));
  const auth = new AuthStore(join(dir, 'auth'));
  await auth.start();
  await auth.setCredentials('monitor', PASSWORD);
  const login = await auth.login('127.0.0.1', 'monitor', PASSWORD);
  await auth.flush();
  let port: number | undefined;
  const origins = new Set<string>();
  const keys = await RemoteMcpKeys.open(dir);
  const groups: Array<{ cwd: string; title?: string | null }> = [], linkUpdates: string[] = [];
  const tools = remoteMcpOverHttp(dir, () => port);
  const localMcp = ownerMcpOverHttp(dir, () => port);
  // Backups exist here so that a refusal, not their absence, answers.
  const backup = { overview: async () => ({ ok: true }), saveSettings: async () => ({ ok: true }) } as never;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, localMcp, backup, remoteMcp: { keys, answer: tools.answer },
    links: { node: { list: () => [] }, controller: { update: async (id: string) => { linkUpdates.push(id); } } } as never,
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
      setGroup: async patch => { groups.push(patch); return { cwd: patch.cwd, title: patch.title ?? null } as never; } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const secure = `ast.test:${port}`, plain = `plain.test:${port}`;
  origins.add(`https://${secure}`); origins.add(`http://${plain}`);
  t.after(async () => { tools.close(); localMcp.close(); dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });

  /** One request as it arrives: from the tunnel (a public Host and a forwarded address) or from this computer. */
  const send = (method: string, path: string, options: { host?: string; headers?: Record<string, string>; body?: unknown; remote?: boolean } = {}) => new Promise<Reply>((resolve, reject) => {
    const remote = options.remote ?? true;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { Host: options.host ?? (remote ? secure : `127.0.0.1:${port}`), ...(remote ? { 'X-Forwarded-For': '192.0.2.1' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode!, headers: res.headers, body: parsed }); });
    });
    req.on('error', reject); req.end(body);
  });
  const token = (await send('GET', '/api/bootstrap', { remote: false })).body.token as string;
  const cookie = `tower_session=${login.sessionId}`;
  /** The owner's page, here or signed in through the HTTPS address. */
  const page = (method: string, path: string, body?: unknown, remote = false) => send(method, path, { remote, body,
    headers: { ...(method === 'POST' ? { [REQUEST_TOKEN_HEADER]: token, Origin: remote ? `https://${secure}` : `http://127.0.0.1:${port}` } : {}), ...(remote ? { Cookie: cookie } : {}) } });
  const makeKey = async (scope: 'read' | 'write') => (await page('POST', '/api/remote-mcp/create', { name: `test ${scope}`, scope })).body as RemoteMcpCreated;
  let id = 0;
  const rpc = (key: string | undefined, method: string, params?: unknown, options: { host?: string; headers?: Record<string, string> } = {}) =>
    send('POST', '/mcp', { host: options.host, body: { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }, headers: { ...(key ? { 'X-Tower-Mcp-Key': key } : {}), ...options.headers } });
  const call = async (key: string, name: string, args: Record<string, unknown>) => {
    const reply = await rpc(key, 'tools/call', { name, arguments: args });
    assert.equal(reply.status, 200);
    return JSON.parse(reply.body.result.content[0].text);
  };
  return { send, page, makeKey, rpc, call, secure, plain, token, cookie, port, groups, linkUpdates };
}

test('the owner\'s outside MCP client uses Tower at the HTTPS address with a key; a read key only reads', async t => {
  const { makeKey, rpc, call, page, send } = await serve(t);
  const made = await makeKey('read');
  assert.equal(made.created.scope, 'read');
  assert.ok(!JSON.stringify((await page('GET', '/api/remote-mcp')).body).includes(made.key), 'the list never shows a key again');

  const init = await rpc(made.key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc(made.key, 'initialize', { protocolVersion: '2099-01-01' })).body.result.protocolVersion, '2025-06-18', 'an unknown version gets the newest this server speaks');
  const notice = await send('POST', '/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { 'X-Tower-Mcp-Key': made.key } });
  assert.equal(notice.status, 202, 'a notification has no answer');
  const tools = (await rpc(made.key, 'tools/list')).body.result.tools as Array<{ name: string; description: string }>;
  assert.deepEqual(tools.map(tool => tool.name), ['tower_api', 'tower_query', 'session_read', 'terminal_read', 'tower_guide']);
  assert.match(tools[0].description, /read scope/);

  const read = await call(made.key, 'tower_api', { method: 'GET', path: '/api/snapshot' });
  assert.equal(read.state, 'succeeded');
  assert.equal(read.body.hostname, 'here');
  const change = await call(made.key, 'tower_api', { method: 'POST', path: '/api/groups', body: { cwd: '/work' } });
  assert.match(change.error, /읽기 권한 키로는 바꿀 수 없습니다/);
  const guide = await call(made.key, 'tower_guide', {});
  assert.ok(!guide.includes('/api/bootstrap') && guide.includes('read scope'), 'the guide is for outside: no page token, and the scopes');
});

test('without a valid key, or not over the HTTPS address, nobody gets in, and refusals never ask to sign in again', async t => {
  const { makeKey, rpc, send, page, plain, secure } = await serve(t);
  const made = await makeKey('write');
  for (const [label, reply] of [
    ['no key', await rpc(undefined, 'tools/list')],
    ['a wrong key', await rpc(`tower_mcp_${'A'.repeat(43)}`, 'tools/list')],
    ['the page token or a sign-in instead', await rpc(undefined, 'tools/list', undefined, { headers: { Authorization: 'Bearer x', Cookie: 'tower_session=abc' } })],
    ['plain HTTP public address', await rpc(made.key, 'tools/list', undefined, { host: plain })],
    ['a browser page', await rpc(made.key, 'tools/list', undefined, { headers: { Origin: 'https://evil.example' } })],
    ['Tower\'s own page', await rpc(made.key, 'tools/list', undefined, { headers: { Origin: `https://${secure}` } })],
    ['a page of Tower', await rpc(made.key, 'tools/list', undefined, { headers: { 'Sec-Fetch-Site': 'same-origin' } })],
  ] as const) {
    assert.equal(reply.status, 403, `${label}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    assert.equal(reply.headers['www-authenticate'], undefined, `${label}: no sign-in challenge`);
  }
  assert.equal((await rpc(undefined, 'tools/list')).body.error.code, -32001);
  assert.equal((await rpc(made.key, 'tools/list', undefined, { headers: { Origin: `https://${secure}` } })).body.error.code, -32001, 'refused by /mcp itself, not by the origin check');
  assert.equal((await send('GET', '/mcp', { headers: { 'X-Tower-Mcp-Key': made.key } })).status, 405, 'no server-sent stream');

  await page('POST', '/api/remote-mcp/revoke', { id: made.created.id });
  assert.equal((await rpc(made.key, 'tools/list')).status, 403, 'a revoked key stops at once');
});

test('a write key changes things; what only the owner does in person stays closed to it', async t => {
  const { makeKey, call, groups, linkUpdates } = await serve(t);
  const { key } = await makeKey('write');
  const change = await call(key, 'tower_api', { method: 'POST', path: '/api/groups', body: { cwd: '/work', title: 'Work' } });
  assert.equal(change.state, 'succeeded', 'an ordinary change goes through');
  assert.deepEqual(groups, [{ cwd: '/work', title: 'Work' }]);
  const update = await call(key, 'tower_api', { method: 'POST', path: `/api/link/nodes/${'a'.repeat(32)}/update`, body: {} });
  assert.equal(update.status, 403, 'nor does it update, join or remove computers');
  assert.deepEqual(linkUpdates, []);
  for (const [method, path, body] of [
    ['GET', '/api/backup'], ['POST', '/api/backup/settings', {}], ['POST', '/api/storage/retry', {}], ['GET', '/api/retention'],
    ['POST', '/api/sessions/s1/compaction', {}], ['POST', '/api/tower/update', {}], ['POST', '/api/runner/force-update', {}],
    ['GET', '/api/auth/overview'], ['POST', '/api/auth/credentials', { username: 'a', password: 'b' }], ['GET', '/api/secrets/settings'],
    ['GET', '/api/remote-mcp'], ['POST', '/api/remote-mcp/create', { name: 'more', scope: 'write' }], ['POST', '/api/claude-accounts/switch', {}],
    ['POST', '/api/v1/secrets.create', { secret: { name: 'x', origin: 'https://a.example', header: 'X-A', value: 'v' } }], ['POST', '/api/v1/secrets.delete', { id: '00000000-0000-4000-8000-000000000000' }],
    ['POST', '/api/v1/permissions.decide', { id: '00000000-0000-4000-8000-000000000000', approve: true }], ['POST', '/api/v1/models.settings', {}],
    ['POST', `/api/nodes/${'b'.repeat(32)}/v1/models.update`, { settings: {} }], ['POST', `/api/nodes/${'b'.repeat(32)}/v1/permissions.decide`, { id: '00000000-0000-4000-8000-000000000000', approve: true }],
  ] as const) {
    const answer = await call(key, 'tower_api', { method, path, ...(body ? { body } : {}) });
    assert.equal(answer.status, 403, `${method} ${path}: ${JSON.stringify(answer.body)}`);
  }
});

test('saying "remote agent" only ever takes rights away', async t => {
  const { send } = await serve(t);
  const claim = { 'X-Tower-Agent': 'remote' };
  assert.equal((await send('GET', '/api/snapshot', { headers: claim })).status, 401, 'from the tunnel it is no sign-in');
  assert.equal((await send('GET', '/api/snapshot', { remote: false, headers: claim })).status, 200, 'here it reads like a page');
  assert.equal((await send('GET', '/api/auth/overview', { remote: false, headers: claim })).status, 403, 'but not what only this computer may do');
  assert.equal((await send('GET', '/api/auth/overview', { remote: false })).status, 200, 'which this computer still may');
});

test('only the owner\'s page makes keys; from elsewhere it asks the Tower password again', async t => {
  const { page, send, token, cookie, secure } = await serve(t);
  assert.equal((await send('POST', '/api/remote-mcp/create', { remote: false, body: { name: 'a', scope: 'read' }, headers: { [REQUEST_TOKEN_HEADER]: token } })).status, 403, 'no Origin: not a page');
  for (const agent of [{ 'X-Tower-Agent': 'local' }, { 'X-Tower-Master': 'x' }, { 'X-Tower-Run-Capability': 'a'.repeat(64) }] as Record<string, string>[]) {
    assert.equal((await send('POST', '/api/remote-mcp/create', { remote: false, body: { name: 'a', scope: 'read' }, headers: { [REQUEST_TOKEN_HEADER]: token, Origin: `http://127.0.0.1:${new URL(`http://${secure}`).port}`, ...agent } })).status, 403, JSON.stringify(agent));
    assert.equal((await send('GET', '/api/remote-mcp', { remote: false, headers: agent })).status, 403, `list: ${JSON.stringify(agent)}`);
  }
  const overview = (await page('GET', '/api/remote-mcp', undefined, true)).body as RemoteMcpOverview;
  assert.equal(overview.passwordRequired, true, JSON.stringify(overview));
  assert.deepEqual(overview.endpoints, [`https://${secure}/mcp`], 'only the HTTPS address is offered');
  assert.equal((await page('POST', '/api/remote-mcp/create', { name: 'a', scope: 'read' }, true)).status, 400, 'no password');
  assert.equal((await page('POST', '/api/remote-mcp/create', { name: 'a', scope: 'read', password: 'wrong' }, true)).status, 403, 'a wrong one');
  const made = await page('POST', '/api/remote-mcp/create', { name: 'a', scope: 'read', password: PASSWORD }, true);
  assert.equal(made.status, 200);
  assert.match(made.body.key, /^tower_mcp_/);
  assert.equal((await send('POST', '/api/remote-mcp/create', { host: `plain.test:${new URL(`http://${secure}`).port}`, body: { name: 'a', scope: 'read', password: PASSWORD },
    headers: { [REQUEST_TOKEN_HEADER]: token, Origin: `http://plain.test:${new URL(`http://${secure}`).port}`, Cookie: cookie } })).status, 403, 'never over plain HTTP from elsewhere');
});
