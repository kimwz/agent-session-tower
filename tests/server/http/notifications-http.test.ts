import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer } from '../../../server/http/server.js';
import type { NotificationOverview } from '../../../shared/notifications.js';

test('the app shell installs without signing in, while notification settings need a signed-in page and its token', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-notifications-http-'));
  for (const [name, content] of [['index.html', 'app'], ['manifest.webmanifest', '{}'], ['sw.js', '//'], ['icon-192.png', 'png'], ['icon-1024.png', 'png'], ['secret.js', 'private']]) await writeFile(join(dir, name), content);
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const calls: Array<[string, Record<string, unknown>]> = [];
  const overview: NotificationOverview = { publicKey: 'key', devices: [] };
  const record = (name: string) => async (body: Record<string, unknown>) => { calls.push([name, body]); return overview; };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins },
    backend: { snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 't', version: 't', updatedAt: '' }), detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
    notifications: { overview: () => overview, subscribe: record('subscribe'), update: record('update'), remove: record('remove'), test: record('test') } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${base}/icon-192.png`)).status, 200);
  assert.equal((await fetch(`${base}/icon-1024.png?v=rainbow-2`)).status, 200);
  assert.equal((await fetch(`${base}/secret.js`)).status, 401);
  assert.equal((await fetch(`${base}/api/notifications`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/notifications`, { headers: { cookie } })).json(), overview);
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const post = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"id":"x"}' });
  assert.equal((await post('/api/notifications/test', { cookie })).status, 403);
  assert.equal((await post('/api/notifications/test', { 'X-Agent-Monitor-Token': token })).status, 401);
  assert.equal((await post('/api/notifications/test', { cookie, 'X-Agent-Monitor-Token': token })).status, 200);
  assert.equal((await post('/api/notifications/other', { cookie, 'X-Agent-Monitor-Token': token })).status, 404);
  assert.deepEqual(calls, [['test', { id: 'x' }]]);
});
