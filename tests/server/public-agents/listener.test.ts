import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PublicListener } from '../../../server/public-agents/listener.js';
import type { PublicVisitorState } from '../../../shared/public-agents.js';

const SLUG = 'AbCdEfGhIjKlMnOpQrStUv';
interface Reply { status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> }
const STATE: PublicVisitorState = { agent: { name: 'Desk', description: '', conversation: 'visitor', passwordRequired: false }, access: 'open', canReset: true,
  conversation: { id: 'c', messages: [], requests: [], busy: false, contextPercent: 0 } };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t: TestContext, fail?: Error) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-public-listener-'));
  const calls: Array<{ action: string; slug: string; input: Record<string, unknown> }> = [];
  const listener = new PublicListener({ stateDir: directory, reservedPorts: () => [8000], backend: { publicVisit: async (action, slug, input) => {
    calls.push({ action, slug, input });
    if (fail) throw fail;
    return { state: STATE, ...(input.token ? {} : { token: 'a'.repeat(64) }) };
  } } });
  await listener.start();
  const port = await freePort();
  await listener.configure({ port, publicUrl: 'https://agents.example.com' });
  t.after(async () => { await listener.close(); await rm(directory, { recursive: true, force: true }); });
  // fetch cannot set Host, which is exactly what the listener checks first.
  const request = (path: string, init: { method?: string; body?: string; headers?: Record<string, string>; host?: string } = {}) => new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: init.host ?? 'agents.example.com', ...init.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, headers: { get: (name: string) => { const value = res.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value ?? null; } },
          text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
  return { listener, calls, port, request };
}

test('the public port serves only visitor pages and their calls, for the configured address', async t => {
  const { listener, calls, request, port } = await fixture(t);
  assert.deepEqual(listener.status(), { port, publicUrl: 'https://agents.example.com', listening: true });
  const page = await request(`/a/${SLUG}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.match(await page.text(), /\/_pa\/app\.js/);
  for (const path of ['/', '/api/snapshot', '/api/bootstrap', '/api/public-agents', '/api/v1/triggers.list', '/assets/index.js', `/a/${SLUG}/api/other`, '/a/short/api/state']) {
    assert.equal((await request(path)).status, 404, path);
  }
  // Another host name is refused before anything else.
  assert.equal((await request(`/a/${SLUG}/api/state`, { host: 'ast.example.com' })).status, 403);
  assert.equal(calls.length, 0);

  const state = await request(`/a/${SLUG}/api/state`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(state.status, 200);
  assert.deepEqual(await state.json(), STATE);
  assert.equal(state.headers.get('set-cookie'), `pa_visitor=${'a'.repeat(64)}; Path=/a/${SLUG}; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure`);
  assert.deepEqual(calls[0], { action: 'state', slug: SLUG, input: { ip: '203.0.113.9' } });
});

test('visitor calls need the page\'s own header and JSON, and pass only their fields and cookie', async t => {
  const { calls, request } = await fixture(t);
  const cookie = `pa_visitor=${'b'.repeat(64)}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(`/a/${SLUG}/api/${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-public-agent': '1', cookie, origin: 'https://agents.example.com', ...headers } });
  assert.equal((await post('message', { text: 'hi' }, { 'x-public-agent': '' })).status, 403);
  assert.equal((await post('message', { text: 'hi' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('message', { text: 'hi' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(`/a/${SLUG}/api/message`)).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await post('message', { text: 'hi', admin: true, origin: { kind: 'owner' } })).status, 200);
  assert.equal((await post('login', { password: 'pw', text: 'ignored' })).status, 200);
  assert.deepEqual(calls.map(call => call.input), [{ ip: '127.0.0.1', token: 'b'.repeat(64), text: 'hi' }, { ip: '127.0.0.1', token: 'b'.repeat(64), password: 'pw' }]);
});

test('visitors see only the service\'s own error codes, never internal messages', async t => {
  const internal = await fixture(t, Object.assign(new Error('ENOENT: /Users/owner/.agent-monitor/public-agents.json'), { statusCode: 500 }));
  const failed = await internal.request(`/a/${SLUG}/api/state`);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'unavailable' });
});

test('a coded refusal keeps its code and status', async t => {
  const { request } = await fixture(t, Object.assign(new Error('wrong_password'), { statusCode: 401 }));
  const refused = await request(`/a/${SLUG}/api/state`);
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: 'wrong_password' });
});

test('the public port can be turned off and never takes Tower\'s own port', async t => {
  const { listener } = await fixture(t);
  await assert.rejects(listener.configure({ port: 8000, publicUrl: '' }), /Tower가 이미 쓰는 포트/);
  await assert.rejects(listener.configure({ port: 8790, publicUrl: 'https://agents.example.com/path' }));
  assert.equal((await listener.configure({ port: 0, publicUrl: '' })).listening, false);
});
