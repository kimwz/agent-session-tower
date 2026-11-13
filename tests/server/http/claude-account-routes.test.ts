import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../../../server/http/server.js';
import { Readable } from 'node:stream';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { claudeAccountLink, type ClaudeAccountRoutes } from '../../../server/http/claude-account-routes.js';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';

test('only the owner’s own page lists, switches or adds Claude accounts; the master, agents and turns are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-claude-accounts-http-'));
  const switched: string[] = [];
  const routes = {
    unavailable: () => undefined,
    accounts: { list: () => [{ id: 'aaaaaaaaaaaa', email: 'alpha@example.com', addedAt: '2026-11-13T00:00:00Z', active: true }], switchTo: async (id: string) => { switched.push(id); return []; }, remove: async () => [] },
    login: { status: () => undefined, start: async () => ({}), submitCode: () => ({}), cancel: async () => {} },
  } as unknown as ClaudeAccountRoutes;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, claudeAccounts: routes, master: { callerSecret: 'fixture-master-secret', handle: async () => false },
    backend: { snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: async () => { throw new Error('No intake allowed.'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const page = { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token, origin: base };
  const agents: Record<string, string>[] = [{ 'x-tower-agent': 'local' }, { 'x-tower-master': 'fixture-master-secret' }, { [CALLER_CAPABILITY_HEADER]: 'a'.repeat(64) }];

  const list = await fetch(`${base}/api/claude-accounts`);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json() as { accounts: { email: string }[] }).accounts.map(account => account.email), ['alpha@example.com']);
  for (const headers of agents) assert.equal((await fetch(`${base}/api/claude-accounts`, { headers })).status, 403);

  const body = JSON.stringify({ id: 'aaaaaaaaaaaa' });
  for (const headers of agents) assert.equal((await fetch(`${base}/api/claude-accounts/switch`, { method: 'POST', headers: { ...page, ...headers }, body })).status, 403);
  // A request no page made (no origin) is refused too.
  assert.equal((await fetch(`${base}/api/claude-accounts/switch`, { method: 'POST', headers: { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body })).status, 403);
  assert.deepEqual(switched, []);
  assert.equal((await fetch(`${base}/api/claude-accounts/switch`, { method: 'POST', headers: page, body })).status, 200);
  assert.deepEqual(switched, ['aaaaaaaaaaaa']);
});

test('a joined computer’s accounts cross its link only from the owner’s page', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-claude-accounts-node-'));
  const node = 'a'.repeat(32);
  // No link session: a request the gate lets through reaches the proxy and is answered "not connected" (503).
  const nodes = { known: (id: string) => id === node, session: () => undefined, setView: async () => {}, on: () => {}, off: () => {} } as unknown as Parameters<typeof createMonitorServer>[0]['nodes'];
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, nodes, master: { callerSecret: 'fixture-master-secret', handle: async () => false },
    backend: { snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: new Date().toISOString() }),
      detail: async () => undefined, enqueue: async () => { throw new Error('No intake allowed.'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const page = { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token, origin: base };
  const path = `${base}/api/nodes/${node}/claude-accounts`;
  assert.equal((await fetch(path)).status, 503, 'the owner reads the list');
  assert.equal((await fetch(path, { headers: { 'x-tower-agent': 'local' } })).status, 403);
  const body = JSON.stringify({ id: 'aaaaaaaaaaaa' });
  assert.equal((await fetch(`${path}/switch`, { method: 'POST', headers: page, body })).status, 503, 'the owner page switches');
  for (const headers of [{ ...page, 'x-tower-master': 'fixture-master-secret' }, { ...page, [CALLER_CAPABILITY_HEADER]: 'a'.repeat(64) }, { 'content-type': 'application/json', [REQUEST_TOKEN_HEADER]: token }]) {
    assert.equal((await fetch(`${path}/switch`, { method: 'POST', headers, body })).status, 403);
  }
});

test('over the link a paired controller lists and switches accounts, and each change is recorded without an address', async () => {
  const switched: string[] = [];
  const routes = {
    unavailable: () => undefined,
    accounts: { list: () => [{ id: 'aaaaaaaaaaaa', email: 'alpha@example.com', addedAt: '2026-11-13T00:00:00Z', active: false }], switchTo: async (id: string) => { switched.push(id); return []; }, remove: async () => [] },
    login: { status: () => undefined, start: async () => ({}), submitCode: () => ({}), cancel: async () => {} },
  } as unknown as ClaudeAccountRoutes;
  const changes: string[] = [];
  const request = async (path: string, method: string, body?: unknown) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json' } }) as unknown as Http2ServerRequest;
    let status = 0; let text = '';
    const res = { writeHead(code: number) { status = code; }, end(value: string) { text = value; } } as unknown as Http2ServerResponse;
    const handled = await claudeAccountLink(req, res, routes, change => changes.push(change));
    return { handled, status, body: text ? JSON.parse(text) as { accounts?: { email: string }[] } : undefined };
  };
  const listed = await request('/api/claude-accounts', 'GET');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body?.accounts?.map(account => account.email), ['alpha@example.com']);
  assert.equal((await request('/api/claude-accounts/switch', 'POST', { id: 'aaaaaaaaaaaa' })).status, 200);
  assert.deepEqual(switched, ['aaaaaaaaaaaa']);
  assert.deepEqual(changes, ['switch']);
  assert.equal((await request('/api/claude-accounts/switch', 'GET')).handled, false, 'a change asked with GET is not an account request');
  assert.equal((await request('/api/sessions', 'GET')).handled, false);
});
