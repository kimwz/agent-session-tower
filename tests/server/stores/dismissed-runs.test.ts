import { createRemoteAuthFixture } from '../../helpers/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DismissedRunStore } from '../../../server/stores/dismissed-runs.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { projectSessionStates } from '../../../server/sessions/snapshot.js';
import { RunManager } from '../../../server/runs/manager.js';
import type { Run, Session, Snapshot } from '../../../shared/types.js';
import { computeConversationRevision } from '../../../shared/conversation-revision.js';

const session: Session = {
  id: 'codex:example', nativeId: 'example', provider: 'codex', title: 'Native conversation', cwd: '/tmp/project', project: 'project',
  status: 'working', statusReason: 'Native activity', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  lastMessage: 'Native message', messageCount: 2, isSubagent: false, resumable: true, filePath: '/private/native-log.jsonl',
};
const failed: Run = {
  id: 'failed-1', sessionId: session.id, prompt: 'Failed request', output: 'Partial output', error: 'Fixture failure', status: 'error',
  createdAt: '2026-09-03T00:00:00.000Z', startedAt: '2026-09-03T00:00:01.000Z', finishedAt: '2026-09-03T00:00:02.000Z',
};

test('dismissal survives restart with private atomic storage and preserves native and legacy run history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-dismissed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nativePath = join(dir, 'native.jsonl');
  await writeFile(nativePath, 'Untouched native conversation\n');
  await writeFile(join(dir, 'runs.json'), JSON.stringify([failed]));
  const store = new DismissedRunStore(dir);
  await store.start();
  assert.deepEqual(store.visible([failed]), [failed], 'pre-feature history starts visible');
  const manager = new RunManager({ stateDir: dir, getSession: () => session, refreshSessions: async () => {} });
  await manager.start();
  try {
    const before = manager.list();
    const rawDocument = await readFile(join(dir, 'runs.json'), 'utf8');
    await store.dismiss(failed.id, before[0]);
    assert.deepEqual(manager.list(), before);
    assert.equal(await readFile(join(dir, 'runs.json'), 'utf8'), rawDocument);
    assert.equal(await readFile(nativePath, 'utf8'), 'Untouched native conversation\n');
    assert.deepEqual(store.visible(before), []);
    assert.equal((await stat(join(dir, 'dismissed-runs.json'))).mode & 0o777, 0o600);
    await store.flush();
    const reloaded = new DismissedRunStore(dir);
    await reloaded.start();
    assert.deepEqual(reloaded.visible(before), []);
    await reloaded.dismiss(failed.id, undefined);
    assert.deepEqual((await readdir(dir)).sort(), ['attachments', 'dismissed-runs.json', 'native.jsonl', 'runs.json']);
  } finally { await manager.close(); }
});

test('concurrent dismissals retain every id and rejection does not block subsequent writes or shutdown flush', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-dismissed-concurrent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DismissedRunStore(dir);
  await store.start();
  const runs = Array.from({ length: 12 }, (_, i) => ({ ...failed, id: `failed-${i}` }));
  const operations = runs.map(run => store.dismiss(run.id, run));
  await store.flush();
  await Promise.all(operations);
  await assert.rejects(store.dismiss('unknown', undefined), { statusCode: 404 });
  for (const status of ['running', 'queued', 'completed', 'cancelled'] as const) {
    await assert.rejects(store.dismiss(status, { ...failed, id: status, status }), { statusCode: 409 });
  }
  await store.dismiss('last', { ...failed, id: 'last' });
  const reloaded = new DismissedRunStore(dir);
  await reloaded.start();
  assert.deepEqual(reloaded.visible([...runs, { ...failed, id: 'last' }]), []);
  assert.equal(JSON.parse(await readFile(join(dir, 'dismissed-runs.json'), 'utf8')).length, 13);
});

test('dismiss HTTP authenticates, validates, commits before SSE, and preserves lifecycle projection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-dismissed-http-'));
  const stateDir = join(dir, 'state');
  await writeFile(join(dir, 'index.html'), '<title>Monitor</title>');
  const store = new DismissedRunStore(stateDir);
  await store.start();
  const raw = [failed, ...(['queued', 'running', 'completed', 'cancelled'] as const).map(status => ({ ...failed, id: status, sessionId: `session-${status}`, status }))];
  const settled = new Set([failed.id]);
  let broadcasts = 0;
  const listeners = new Set<() => void>();
  const snapshot = (): Snapshot => ({
    sessions: projectSessionStates([session], raw, settled), runs: store.visible(raw), providers: [],
    scanning: false, updatedAt: '2026-09-04T00:00:00.000Z', hostname: 'test', version: '0.1.0',
  });
  const before = snapshot().sessions;
  assert.equal(before[0]!.status, 'error');
  assert.equal(before[0]!.lastRequestAt, failed.createdAt);
  assert.equal(before[0]!.lastCompletedAt, failed.finishedAt);
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backend: {
    snapshot,
    detail: async () => ({ session, messages: [], hasMore: false }),
    enqueue: async () => { throw new Error('Dismiss must not enqueue'); },
    cancel: async () => { throw new Error('Dismiss must not cancel'); },
    dismiss: async id => { await store.dismiss(id, raw.find(run => run.id === id)); broadcasts++; listeners.forEach(listener => listener()); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.flush(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (id = failed.id, extra: Record<string, string> = {}, body = '{}') => fetch(`${base}/api/runs/${id}/dismiss`, { method: 'POST', headers: { ...headers, ...extra }, body });

  await t.test('rejects unauthenticated, invalid-origin, CSRF, non-JSON and malformed requests', async () => {
    assert.equal((await send(failed.id, { cookie: '' })).status, 401);
    assert.equal((await send(failed.id, { 'X-Agent-Monitor-Token': '' })).status, 403);
    assert.equal((await send(failed.id, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await send(failed.id, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send(failed.id, { 'Content-Type': 'text/plain' })).status, 415);
    for (const body of ['{bad', 'null', '[]']) assert.equal((await send(failed.id, {}, body)).status, 400);
    assert.equal((await send('unknown')).status, 404);
    for (const status of ['queued', 'running', 'completed', 'cancelled']) assert.equal((await send(status)).status, 409);
    assert.equal(broadcasts, 0);
    assert.deepEqual(store.visible(raw), raw);
  });
  await t.test('failed storage keeps the card visible, sends no change, and can be retried', async () => {
    await rename(stateDir, join(dir, 'saved'));
    await writeFile(stateDir, 'Blocked state directory');
    assert.equal((await send()).status, 503);
    assert.equal(broadcasts, 0);
    assert.deepEqual(store.visible(raw), raw);
    assert.deepEqual(snapshot().sessions, before);
    await rm(stateDir);
    await rename(join(dir, 'saved'), stateDir);
  });
  await t.test('a committed dismissal removes only its card from live and reconnected snapshots', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { headers: { cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    const reader = response.body!.getReader();
    let buffered = '';
    const readSnapshot = async () => {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'SSE stays connected');
        buffered += new TextDecoder().decode(chunk.value);
      }
    };
    try {
      assert.deepEqual((await readSnapshot()).runs, raw.map(run => ({ ...run, output: '' })));
      const result = await send();
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { ok: true });
      assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'dismissed-runs.json'), 'utf8')), [failed.id]);
      const data = await readSnapshot();
      assert.deepEqual(data.runs, raw.slice(1).map(run => ({ ...run, output: '' })));
      assert.deepEqual(snapshot().sessions, before);
      const { filePath: _, ...publicSession } = before[0]!;
      assert.deepEqual(data.sessions, [{ ...publicSession, readRevision: computeConversationRevision(before[0]!, raw.slice(1)) }]);
      assert.deepEqual((await (await fetch(`${base}/api/snapshot`, { headers: { cookie } })).json()).runs, raw.slice(1).map(run => ({ ...run, output: '' })));
      assert.equal((await send()).status, 200, 'duplicate dismissal is idempotent');
      assert.equal(raw[0]!.error, 'Fixture failure');
      assert.equal(raw[0]!.output, 'Partial output', 'public projection does not clear stored execution output');
      const restarted = new DismissedRunStore(stateDir);
      await restarted.start();
      assert.deepEqual(restarted.visible(raw), raw.slice(1));
    } finally { controller.abort(); }
  });
});
