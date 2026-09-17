import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTitleStore, normalizeSessionTitle } from '../server/session-titles.js';
import { createMonitorServer } from '../server/http.js';
import type { Session } from '../shared/types.js';
import { computeConversationRevision } from '../shared/conversation-revision.js';

const native: Session = {
  id: 'codex:example', nativeId: 'example', provider: 'codex', title: 'First conversation', cwd: '/tmp/project', project: 'project',
  status: 'completed', statusReason: 'Turn complete', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  lastMessage: 'Done', messageCount: 2, isSubagent: false, resumable: true, filePath: '/private/native-log.jsonl',
};

test('custom titles survive restart, stay private, and reset without changing native metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-titles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionTitleStore(dir);
  await store.start();
  assert.deepEqual(store.apply(native), native);
  const updated = await store.set(native, '  내 작업 제목  ');
  assert.deepEqual(updated, { ...native, customTitle: '내 작업 제목' });
  assert.equal(native.customTitle, undefined);
  assert.equal((await stat(join(dir, 'session-titles.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['session-titles.json']);
  const reloaded = new SessionTitleStore(dir);
  await reloaded.start();
  assert.deepEqual(reloaded.apply(native), updated);
  assert.deepEqual(reloaded.apply({ ...native, title: 'Later native title' }), { ...native, title: 'Later native title', customTitle: '내 작업 제목' });
  assert.deepEqual(await reloaded.set(native, ' \n\t '), native);
  const reset = new SessionTitleStore(dir);
  await reset.start();
  assert.deepEqual(reset.apply(native), native);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'session-titles.json'), 'utf8')), {});
});

test('concurrent title saves retain every session and commit repeated edits in request order', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-titles-concurrent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionTitleStore(dir);
  await store.start();
  const sessions = Array.from({ length: 15 }, (_, index) => ({ ...native, id: `codex:${index}` }));
  await Promise.all(sessions.map((session, index) => store.set(session, `Title ${index}`)));
  const edits = await Promise.all([store.set(native, 'first'), store.set(native, 'second'), store.set(native, 'last')]);
  assert.deepEqual(edits.map(session => session.customTitle), ['first', 'second', 'last']);
  const reloaded = new SessionTitleStore(dir);
  await reloaded.start();
  sessions.forEach((session, index) => assert.equal(reloaded.apply(session).customTitle, `Title ${index}`));
  assert.equal(reloaded.apply(native).customTitle, 'last');
  assert.deepEqual(await readdir(dir), ['session-titles.json']);
});

test('failed persistence leaves the committed title intact and later saves can recover', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-titles-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  const savedDir = join(dir, 'saved');
  const store = new SessionTitleStore(stateDir);
  await store.start();
  await store.set(native, 'Committed title');
  await rename(stateDir, savedDir);
  await writeFile(stateDir, 'This file prevents new writes.');
  await assert.rejects(store.set(native, 'Unsaved title'), { statusCode: 503 });
  assert.equal(store.apply(native).customTitle, 'Committed title');
  assert.equal(JSON.parse(await readFile(join(savedDir, 'session-titles.json'), 'utf8'))[native.id], 'Committed title');
  await rm(stateDir);
  await rename(savedDir, stateDir);
  await store.set(native, 'Recovered title');
  await store.flush();
  const reloaded = new SessionTitleStore(stateDir);
  await reloaded.start();
  assert.equal(reloaded.apply(native).customTitle, 'Recovered title');
});

test('title validation trims whitespace and uses the same UTF-16 length as browser inputs', () => {
  assert.equal(normalizeSessionTitle(` ${'x'.repeat(120)} `), 'x'.repeat(120));
  assert.equal(normalizeSessionTitle('😀'.repeat(60)), '😀'.repeat(60));
  for (const value of [undefined, null, 12, {}, [], 'x'.repeat(121), '😀'.repeat(61)]) {
    assert.throws(() => normalizeSessionTitle(value), { statusCode: 400 });
  }
});

test('title HTTP endpoint validates, authenticates, persists, and broadcasts sanitized sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-titles-http-'));
  const store = new SessionTitleStore(join(dir, 'state'));
  await store.start();
  await mkdir(join(dir, 'client'));
  const authorization = `Basic ${Buffer.from('monitor:test-password').toString('base64')}`;
  let notify = () => {};
  let saves = 0;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: join(dir, 'client'), remote: { password: 'test-password', origins: new Set() }, backend: {
    snapshot: () => ({ sessions: [store.apply(native)], providers: [], runs: [], scanning: false, updatedAt: native.updatedAt, hostname: 'test', version: '0.1.0' }),
    detail: async id => id === native.id ? { session: store.apply(native), messages: [], hasMore: false } : undefined,
    setTitle: async (id, title) => {
      if (id !== native.id) return undefined;
      const session = await store.set(native, title);
      saves++;
      notify();
      return session;
    },
    enqueue: async () => { throw new Error('unused'); }, cancel: async () => {},
    subscribe: listener => { notify = listener; return () => {}; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  });
  const path = `${base}/api/sessions/${encodeURIComponent(native.id)}/title`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { Authorization: authorization } })).json();
  const headers = { Authorization: authorization, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (value: unknown, extra: Record<string, string> = {}, url = path) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });

  await t.test('requires remote credentials, CSRF token, trusted origin, and JSON', async () => {
    assert.equal((await send({ title: 'bad' }, { Authorization: '' })).status, 401);
    assert.equal((await send({ title: 'bad' }, { 'X-Agent-Monitor-Token': '' })).status, 403);
    assert.equal((await send({ title: 'bad' }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await send({ title: 'bad' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send({ title: 'bad' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(saves, 0);
  });
  await t.test('rejects invalid values and sessions that are no longer available', async () => {
    for (const value of [{}, { title: null }, { title: 42 }, { title: [] }, { title: 'x'.repeat(121) }, { title: '😀'.repeat(61) }, null, []]) {
      assert.equal((await send(value)).status, 400);
    }
    assert.equal((await fetch(path, { method: 'POST', headers, body: '{bad' })).status, 400);
    assert.equal((await send({ title: 'Unknown' }, {}, `${base}/api/sessions/missing/title`)).status, 404);
    assert.equal(saves, 0);
  });
  await t.test('publishes committed title to POST, snapshot, detail, and SSE without exposing the native file', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { headers: { Authorization: authorization }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    const reader = response.body!.getReader();
    try {
      await reader.read();
      const result = await send({ title: '  Custom session title  ' });
      assert.equal(result.status, 200);
      const data = await result.json();
      const { filePath: _, ...publicNative } = native;
      assert.deepEqual(data.session, { ...publicNative, customTitle: 'Custom session title' });
      let events = '';
      while (!events.includes('Custom session title')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        events += new TextDecoder().decode(chunk.value);
      }
      assert.match(events, /Custom session title/);
      assert.doesNotMatch(events, /native-log|filePath/);
      for (const url of [`${base}/api/snapshot`, `${base}/api/sessions/${encodeURIComponent(native.id)}`]) {
        const body = await (await fetch(url, { headers: { Authorization: authorization } })).json();
        if (url.endsWith('/api/snapshot')) {
          assert.deepEqual(body.sessions[0], { ...data.session, readRevision: computeConversationRevision(data.session, []) });
        } else assert.deepEqual(body.session, data.session);
      }
      assert.equal(native.readRevision, undefined, 'snapshot revisions do not mutate native metadata');
      const reset = await send({ title: '' });
      assert.equal(reset.status, 200);
      assert.deepEqual((await reset.json()).session, publicNative);
    } finally { controller.abort(); }
  });
  await t.test('reports failed writes instead of returning success or notifying clients', async () => {
    await rename(join(dir, 'state'), join(dir, 'saved'));
    await writeFile(join(dir, 'state'), 'Blocked');
    const before = saves;
    assert.equal((await send({ title: 'Unsaved' })).status, 503);
    assert.equal(saves, before);
    assert.equal(store.apply(native).customTitle, undefined);
  });
});
