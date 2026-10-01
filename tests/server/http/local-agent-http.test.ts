import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer } from '../../../server/http/server.js';
import type { Snapshot } from '../../../shared/types.js';

const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };

test('an agent of the owner\'s on this computer has a budget for changes apart from the owner\'s pages; elsewhere the mark changes nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-local-agent-http-'));
  const { auth, origins, cookie, fetch: remoteFetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });

  // Localhost needs no sign-in: the page token comes straight from bootstrap.
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const local = (headers: Record<string, string> = {}) => fetch(`${base}/api/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...headers }, body: '{"cwd":"/work"}' });
  const agentStatuses: number[] = [];
  for (let index = 0; index < 121; index++) agentStatuses.push((await local({ 'X-Tower-Agent': 'local' })).status);
  assert.ok(!agentStatuses.slice(0, 120).includes(429), 'the agent may make 120 changes a minute, more than a page');
  assert.equal(agentStatuses[120], 429, 'and no more');
  assert.notEqual((await local()).status, 429, 'the owner\'s page still has its whole budget');

  const remote = (headers: Record<string, string>) => remoteFetch(`${base}/api/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, 'X-Agent-Monitor-Token': token, ...headers }, body: '{"cwd":"/work"}' });
  const remoteStatuses: number[] = [];
  for (let index = 0; index < 32; index++) remoteStatuses.push((await remote({ 'X-Tower-Agent': 'local' })).status);
  assert.ok(remoteStatuses.includes(429), 'a request from elsewhere keeps the page budget, mark or not');

});

test('changes the owner\'s agents send to a joined computer keep to half of what it allows this computer, so the pages always have room there', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-local-agent-node-'));
  const { auth, origins } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const node = 'a'.repeat(32), other = 'b'.repeat(32);
  const send = (to: string, headers: Record<string, string> = {}) => fetch(`${base}/api/nodes/${to}/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...headers }, body: '{"cwd":"/work"}' });
  const statuses: number[] = [];
  for (let index = 0; index < 31; index++) statuses.push((await send(node, { 'X-Tower-Agent': 'local' })).status);
  assert.ok(!statuses.slice(0, 30).includes(429));
  assert.equal(statuses[30], 429, 'the 31st change in a minute to one joined computer waits');
  assert.notEqual((await send(other, { 'X-Tower-Agent': 'local' })).status, 429, 'another joined computer has its own share');
  assert.notEqual((await send(node)).status, 429, 'and the owner\'s page still reaches the first one');
});
