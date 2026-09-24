import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import type { Snapshot } from '../../../shared/types.js';

test('this machine’s own browser manages the remote-sharing exclusion list', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tower-exclusions-http-')));
  await mkdir(join(dir, 'secret'));
  const exclusions = new RemoteExclusionStore(dir);
  await exclusions.start();
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, exclusions, backend: {
    snapshot: () => snapshot, detail: async () => undefined, cancel: async () => {}, subscribe: () => () => {},
    enqueue: async () => { throw Object.assign(new Error('Tower is replacing its execution worker right now.'), { statusCode: 503, disposition: 'handoff' }); },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/remote/exclusions`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  assert.deepEqual(await (await fetch(`${base}/api/remote/exclusions`, { headers: { cookie } })).json(), { folders: [], revision: 0 });
  assert.equal((await post({ add: join(dir, 'secret') }, { 'X-Agent-Monitor-Token': '' })).status, 403, 'a change needs the page token');
  assert.equal((await fetch(`${base}/api/remote/exclusions`)).status, 401, 'a signed-out browser sees nothing');
  for (const body of [{}, { add: 'relative' }, { add: join(dir, 'secret'), remove: join(dir, 'secret') }, { clear: true }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  const added = await post({ add: join(dir, 'secret') });
  assert.equal(added.status, 200);
  assert.deepEqual(await added.json(), { folders: [join(dir, 'secret')], revision: 1 });
  assert.deepEqual(await (await post({ remove: join(dir, 'secret') })).json(), { folders: [], revision: 2 });

  // A refusal the worker never admitted says so, so the page knows sending again is safe.
  const refused = await fetch(`${base}/api/sessions/codex:x/messages`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hi' }) });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).disposition, 'not-admitted');
});
