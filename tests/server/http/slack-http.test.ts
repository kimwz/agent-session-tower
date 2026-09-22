import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer } from '../../../server/http/server.js';
import type { SlackPublicStatus } from '../../../shared/slack.js';

const status: SlackPublicStatus = { connected: false, enabled: false, status: 'disconnected', rules: [], events: [] };
test('Slack settings and credentials require existing authentication, origin, CSRF and JSON protections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-slack-http-'));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const mutations: { action: string; body: Record<string, unknown> }[] = [];
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() }),
    detail: async () => undefined, enqueue: async () => { throw new Error('Native execution forbidden'); }, cancel: async () => {}, subscribe: () => () => {},
    slackOverview: async () => status,
    slackMutate: async (action, body) => { mutations.push({ action, body }); return status; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const post = (action: string, body: unknown, extra = {}) => fetch(`${base}/api/slack/${action}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/slack`)).status, 401);
  assert.equal((await fetch(`${base}/api/slack`, {headers:{cookie,Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await post('connect', {}, { cookie: '' })).status, 401);
  assert.equal((await post('connect', {}, { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await post('settings', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('disconnect', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('rules', {}, { 'Content-Type': 'text/plain' })).status, 415);
  for (const body of [null, [], 'invalid']) assert.equal((await post('settings', body)).status,400);
  assert.equal((await post('settings', {payload:'a'.repeat(1_000_001)})).status,413);
  assert.equal(mutations.length, 0);
  for (const [action, body] of [['connect',{appToken:'fixture-app',userToken:'fixture-user'}], ['settings',{enabled:true}], ['rules',{rules:[]}], ['disconnect',{}]] as const) {
    assert.equal((await post(action, body)).status,200);
    assert.deepEqual(mutations.at(-1),{action,body});
  }
  assert.deepEqual(await (await fetch(`${base}/api/slack`, { headers: { cookie } })).json(), status);
});
