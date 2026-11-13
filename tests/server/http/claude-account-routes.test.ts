import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../../../server/http/server.js';
import type { ClaudeAccountRoutes } from '../../../server/http/claude-account-routes.js';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';

test('only the owner’s own page lists, switches or adds Claude accounts; the master, agents and turns are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-claude-accounts-http-'));
  const switched: string[] = [];
  const routes = {
    available: () => true,
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
