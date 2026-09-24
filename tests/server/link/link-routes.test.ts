import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { loadLinkIdentity } from '../../../server/link/identity.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import type { LinkInvite, LinkOverview } from '../../../shared/link.js';
import type { Snapshot } from '../../../shared/types.js';

/** One Tower's web server with real link state in a temporary folder, and no providers. */
async function tower(t: TestContext, name: string) {
  const stateDir = await mkdtemp(join(tmpdir(), `tower-link-routes-${name}-`));
  const identity = await loadLinkIdentity(stateDir);
  const exclusions = new RemoteExclusionStore(stateDir);
  await exclusions.start();
  const hostname = () => name;
  const controller = new ControllerLinks({ stateDir, identity, version: '1.23.0', hostname });
  const node = new NodeLinks({ stateDir, identity, version: '1.23.0', hostname, features: () => ['read', 'work'],
    handle: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); } });
  await controller.start();
  await node.start();
  // Loopback only in tests; the real default listens on every interface.
  await controller.setHub({ bind: '127.0.0.1', port: 0 });
  const auth = await createRemoteAuthFixture(stateDir);
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: name, version: 'test', updatedAt: new Date().toISOString() };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: stateDir, exclusions, auth: auth.auth, remote: { origins: auth.origins },
    links: { identity, hostname, controller, node, exclusions },
    backend: { snapshot: () => snapshot, detail: async () => undefined, cancel: async () => {}, subscribe: () => () => {}, enqueue: async () => { throw new Error('unused'); } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await node.close(); await controller.close();
    dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...headers }, body: JSON.stringify(body) });
  const overview = async () => await (await fetch(`${base}/api/link`)).json() as LinkOverview;
  return { name, base, identity, controller, node, auth, token, post, overview };
}

test('the Remote computers panel turns on joining, makes a code, and a second Tower joins with it', async t => {
  const a = await tower(t, 'computer-a');
  const b = await tower(t, 'computer-b');
  const first = await a.overview();
  assert.equal(first.identity.name, 'computer-a');
  assert.equal(first.identity.fingerprint, a.identity.fingerprint);
  assert.equal(first.hub.enabled, false);
  assert.deepEqual(first.nodes, []);
  assert.deepEqual(first.exclusions, { folders: [], revision: 0 });
  assert.equal((await a.post('/api/link/invite', {})).status, 409, 'a code needs joining turned on first');

  const hub = await (await a.post('/api/link/hub', { enabled: true })).json() as LinkOverview;
  assert.equal(hub.hub.enabled, true);
  assert.equal(hub.hub.listening, true);
  // The test hub listens on loopback, which is never advertised; point the code there.
  await a.controller.setHub({ custom: [`ws://127.0.0.1:${hub.hub.port}/tower-link`] });
  const invite = await (await a.post('/api/link/invite', {})).json() as LinkInvite;
  assert.match(invite.command, /join tower-link:/);
  assert.ok(invite.expiresAt > Date.now());

  const joined = await b.post('/api/link/join', { code: `  ${invite.code}\n` });
  assert.equal(joined.status, 200);
  const node = await waitForNode(a, 'computer-b');
  assert.equal(node.fingerprint, b.identity.fingerprint);
  assert.deepEqual(node.features, ['read', 'work']);
  const controller = await waitFor(async () => (await b.overview()).controllers.find(item => item.state === 'paired' && item.status === 'connected'));
  assert.equal(controller.name, 'computer-a');

  const renamed = await (await a.post(`/api/link/nodes/${node.id}`, { label: '  Studio Mac  ' })).json() as LinkOverview;
  assert.equal(renamed.nodes[0].label, 'Studio Mac');
  assert.equal((await (await a.post(`/api/link/nodes/${node.id}`, { label: '' })).json() as LinkOverview).nodes[0].label, undefined, 'an empty label shows the computer’s own name again');

  const removed = await (await b.post(`/api/link/controllers/${controller.id}/remove`, {})).json() as LinkOverview;
  assert.deepEqual(removed.controllers, []);
  await waitFor(async () => (await a.overview()).nodes.find(item => item.status === 'removed-by-node'));
  const forgotten = await (await a.post(`/api/link/nodes/${node.id}/remove`, {})).json() as LinkOverview;
  assert.deepEqual(forgotten.nodes, []);
});

test('the panel refuses malformed requests and codes with a message it can show', async t => {
  const a = await tower(t, 'computer-a');
  const b = await tower(t, 'computer-b');
  const hub = await (await a.post('/api/link/hub', { enabled: true })).json() as LinkOverview;
  await a.controller.setHub({ custom: [`ws://127.0.0.1:${hub.hub.port}/tower-link`] });
  const code = (await (await a.post('/api/link/invite', {})).json() as LinkInvite).code;
  const refusals: Array<[string, unknown, number, RegExp]> = [
    ['/api/link/hub', { enabled: 'yes' }, 400, /연결 받기 설정/],
    ['/api/link/hub', { bind: '0.0.0.0' }, 400, /연결 받기 설정/],
    ['/api/link/hub', { port: 80 }, 400, /1024에서 65535/],
    ['/api/link/invite', { extra: true }, 400, /비워 두세요/],
    ['/api/link/join', {}, 400, /붙여 넣으세요/],
    ['/api/link/join', { code: 'hello' }, 400, /연결 코드가 아닙니다/],
    ['/api/link/join', { code, extra: 1 }, 400, /붙여 넣으세요/],
    ['/api/link/nodes/0123456789abcdef0123456789abcdef', { label: 'x' }, 404, /연결된 컴퓨터가 아닙니다/],
    ['/api/link/nodes/0123456789abcdef0123456789abcdef', {}, 400, /표시 이름/],
    ['/api/link/nodes/0123456789abcdef0123456789abcdef/remove', { now: true }, 400, /비워 두세요/],
    ['/api/link/controllers/0123456789abcdef0123456789abcdef/remove', { now: true }, 400, /비워 두세요/],
  ];
  for (const [path, body, status, message] of refusals) {
    const response = await b.post(path, body);
    assert.equal(response.status, status, `${path} ${JSON.stringify(body)}`);
    assert.match((await response.json() as { error: string }).error, message);
  }
  const own = await a.post('/api/link/join', { code });
  assert.equal(own.status, 400);
  assert.match((await own.json() as { error: string }).error, /이 컴퓨터에서 만든 코드/);
  assert.equal((await b.post('/api/link/nodes/not-an-id', { label: 'x' })).status, 404);
  assert.deepEqual((await b.overview()).controllers, [], 'nothing refused was saved');
});

test('only this Tower’s own signed-in pages reach the Remote computers routes', async t => {
  const a = await tower(t, 'computer-a');
  const remote = a.auth;
  assert.equal((await remote.fetch(`${a.base}/api/link`)).status, 401, 'a signed-out browser elsewhere sees nothing');
  assert.equal((await remote.fetch(`${a.base}/api/link/hub`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: remote.cookie }, body: '{"enabled":true}' })).status, 403, 'a change needs the page token');
  assert.equal((await a.post('/api/link/hub', { enabled: true }, { 'X-Agent-Monitor-Token': 'wrong' })).status, 403);
  assert.equal((await a.overview()).hub.enabled, false);
  const signedIn = await remote.fetch(`${a.base}/api/link`, { headers: { cookie: remote.cookie } });
  assert.equal(signedIn.status, 200, 'signing in gives the same rights as sitting at this computer');
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${read}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const waitForNode = (a: Awaited<ReturnType<typeof tower>>, name: string) =>
  waitFor(async () => (await a.overview()).nodes.find(node => node.name === name && node.status === 'connected'));
