import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClosedSessionStore } from '../server/closed-sessions.js';
import { createMonitorServer } from '../server/http.js';
import type { CreateSessionRequest, Run, Session, Snapshot } from '../shared/types.js';

const session: Session = { id: 'claude:fixture', nativeId: 'fixture', provider: 'claude', title: 'Native task', cwd: '/tmp', project: 'tmp', status: 'working',
  statusReason: 'Active in original application', createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z', lastMessage: 'hello',
  messageCount: 1, isSubagent: false, resumable: true, filePath: '/private/native-log.jsonl', activeProcess: true };

test('closing and reopening are private persistent display preferences and leave active native records intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-closed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nativePath = join(dir, 'native.jsonl');
  await writeFile(nativePath, 'Native active conversation\n');
  const store = new ClosedSessionStore(dir);
  await store.start();
  const closed = await store.set(session, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.status, 'working');
  assert.equal(closed.activeProcess, true);
  assert.equal(session.closed, undefined);
  assert.equal(await readFile(nativePath, 'utf8'), 'Native active conversation\n');
  assert.equal((await stat(join(dir, 'closed-sessions.json'))).mode & 0o777, 0o600);
  const restarted = new ClosedSessionStore(dir);
  await restarted.start();
  assert.equal(restarted.apply(session).closed, true);
  await restarted.set(session, false);
  assert.equal(restarted.apply(session).closed, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'closed-sessions.json'), 'utf8')), []);
});

test('concurrent closure writes retain every session and failed storage never commits a hidden state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-closed-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  const store = new ClosedSessionStore(stateDir);
  await store.start();
  const all = Array.from({ length: 8 }, (_, i) => ({ ...session, id: `claude:${i}` }));
  await Promise.all(all.map(session => store.set(session, true)));
  assert.ok(all.every(session => store.apply(session).closed));
  await rename(stateDir, join(dir, 'saved'));
  await writeFile(stateDir, 'Blocked');
  await assert.rejects(store.set(session, true), { statusCode: 503 });
  assert.equal(store.apply(session).closed, undefined);
  await rm(stateDir);
  await rename(join(dir, 'saved'), stateDir);
  await store.set(session, true);
  assert.equal(store.apply(session).closed, true);
});

test('session creation, closure and reopen HTTP routes authenticate, validate, and sanitize results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-session-actions-'));
  const store = new ClosedSessionStore(join(dir, 'state'));
  await store.start();
  const password = 'fixture-password';
  const authorization = `Basic ${Buffer.from(`monitor:${password}`).toString('base64')}`;
  const created: CreateSessionRequest[] = [];
  let changes = 0;
  const listeners = new Set<() => void>();
  const changed = () => { changes++; listeners.forEach(listener => listener()); };
  const run: Run = { id: 'fixture-run', sessionId: session.id, prompt: 'first', status: 'queued', createdAt: session.createdAt, output: '' };
  const snapshot = (): Snapshot => ({ sessions: [store.apply(session)], runs: [run], providers: [], scanning: false, hostname: 'fixture', version: '0.1.0', updatedAt: session.updatedAt });
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, remote: { password, origins: new Set() }, backend: {
    snapshot, detail: async () => ({ session: store.apply(session), messages: [], hasMore: false }),
    setClosed: async (id, closed) => { if (id !== session.id) return undefined; const result = await store.set(session, closed); changed(); return result; },
    createSession: async input => { created.push(input); return { session, run }; },
    enqueue: async () => { throw new Error('Session actions must not resume a conversation'); },
    cancel: async () => { throw new Error('Closing must not stop a native process'); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.flush(); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { Authorization: authorization } })).json();
  const headers = { Authorization: authorization, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token };
  const send = (path: string, body = '{}', extra: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', body, headers: { ...headers, ...extra } });
  const closePath = `/api/sessions/${session.id}/close`;
  assert.equal((await send(closePath, '{}', { Authorization: '' })).status, 401);
  assert.equal((await send(closePath, '{}', { 'X-Agent-Monitor-Token': '' })).status, 403);
  assert.equal((await send(closePath, '{}', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await send(closePath, '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send(closePath, 'null')).status, 400);
  assert.equal((await send('/api/sessions/missing/close')).status, 404);
  assert.equal(changes, 0);
  const closed = await send(closePath);
  assert.equal(closed.status, 200);
  const closedBody = await closed.json();
  assert.equal(closedBody.session.closed, true);
  assert.equal(closedBody.session.filePath, undefined);
  assert.equal(closedBody.session.status, 'working');
  assert.equal(changes, 1);
  assert.equal((await (await fetch(`${base}/api/snapshot`, { headers: { Authorization: authorization } })).json()).sessions[0].closed, true);
  const reopened = await send(`/api/sessions/${session.id}/reopen`);
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).session.closed, undefined);
  for (const input of [{}, { provider: 'bad', cwd: '/tmp', prompt: 'hello' }, { provider: 'codex', cwd: 12, prompt: 'hi' }, { provider: 'codex', cwd: '/tmp', prompt: '' }, { provider: 'codex', cwd: '/tmp', prompt: 'hi', title: [] }]) {
    assert.equal((await send('/api/sessions', JSON.stringify(input))).status, 400);
  }
  assert.equal(created.length, 0);
  assert.equal((await send('/api/sessions', JSON.stringify({ provider: 'codex', cwd: '/tmp', prompt: 'first' }), { 'X-Agent-Monitor-Token': '' })).status, 403);
  const creation = await send('/api/sessions', JSON.stringify({ provider: 'codex', cwd: '/tmp', prompt: ' first ', title: ' Label ' }));
  assert.equal(creation.status, 202);
  assert.deepEqual(created, [{ provider: 'codex', cwd: '/tmp', prompt: 'first', title: 'Label' }]);
  const body = await creation.json();
  assert.equal(body.session.filePath, undefined);
  assert.equal(body.run.id, run.id);
});
