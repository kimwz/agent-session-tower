import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { applySnapshotPatch, type SnapshotPatch } from '../../../shared/snapshot-patch.js';
import type { Session, Snapshot } from '../../../shared/types.js';

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'claude', title: id, cwd: '/work/app', project: 'app',
  status: 'completed', statusReason: '', createdAt: ago(1), updatedAt: ago(1), lastCompletedAt: ago(1), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true,
  filePath: '/private/native.jsonl', ...extra });

async function serve(t: test.TestContext, sessions: Session[]) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-scoped-'));
  const snapshot: Snapshot = { sessions, runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString() };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: {
    snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  return { base, token };
}

/** Reads an event stream frame by frame, applying patches the way a page does. */
async function openEvents(url: string) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => request(url, resolve).on('error', reject).end());
  let buffer = '';
  let state: Snapshot | undefined;
  let last = 0;
  let id: string | undefined;
  const waiters: Array<() => void> = [];
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const field = (name: string) => block.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
      const event = field('event'); const data = field('data');
      if (!event || !data) continue;
      if (event === 'stream') id = (JSON.parse(data) as { id: string }).id;
      if (event === 'snapshot') { state = JSON.parse(data) as Snapshot; last = Number(field('id')); }
      if (event === 'patch') {
        const patch = JSON.parse(data) as SnapshotPatch;
        assert.equal(patch.base, last);
        state = applySnapshotPatch(state!, patch); last = Number(field('id'));
      }
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (check: () => boolean) => { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, 'timed out'); await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 50); }); } };
  return { response, until, state: () => state, id: () => id };
}

test('a scoped page gets only what its list shows and changes its scope on the open stream', { timeout: 15_000 }, async t => {
  const sessions = [session('recent'), session('old', { lastCompletedAt: ago(100), createdAt: ago(100) }), session('sub', { isSubagent: true, parentId: 'recent' }), session('archived', { closed: true })];
  const { base, token } = await serve(t, sessions);
  const headers = { 'X-Agent-Monitor-Token': token };

  const scoped = await (await fetch(`${base}/api/snapshot?scoped=1&days=1`, { headers })).json() as Snapshot;
  assert.deepEqual(scoped.sessions.map(item => item.id), ['recent']);
  assert.equal(scoped.sessions[0].filePath, undefined);
  assert.deepEqual(scoped.sessionSummary?.counts, { open: 2, closed: 1, working: 0, completed: 2 });
  assert.deepEqual(scoped.sessionScope, { days: 1, closed: false });
  const full = await (await fetch(`${base}/api/snapshot`, { headers })).json() as Snapshot;
  assert.equal(full.sessions.length, 4);
  assert.equal(full.sessionSummary, undefined);

  const events = await openEvents(`${base}/api/events?patch=1&scoped=1&days=1`);
  t.after(() => events.response.destroy());
  await events.until(() => Boolean(events.state() && events.id()));
  assert.deepEqual(events.state()!.sessions.map(item => item.id), ['recent']);
  const change = (scope: object) => fetch(`${base}/api/events/scope`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: events.id(), scope }) });

  assert.equal((await change({ days: 1, closed: true, focus: 'recent' })).status, 200);
  await events.until(() => events.state()!.sessions.length === 3);
  assert.deepEqual(events.state()!.sessions.map(item => item.id), ['recent', 'sub', 'archived']);
  assert.equal((await change({ closed: false })).status, 200);
  await events.until(() => events.state()!.sessions.length === 2);
  assert.deepEqual(events.state()!.sessions.map(item => item.id), ['recent', 'old']);

  // Many scope changes in a row are reads, not changes: they never run into the change budget.
  for (let index = 0; index < 40; index++) assert.equal((await change({ days: index % 2 ? 1 : 7, closed: false })).status, 200);
  assert.equal((await fetch(`${base}/api/events/scope`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: 'unknown', scope: {} }) })).status, 404);
  assert.equal((await fetch(`${base}/api/events/scope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: events.id(), scope: {} }) })).status, 403);

  const plain = await openEvents(`${base}/api/events?patch=1&nodes=1`);
  t.after(() => plain.response.destroy());
  await plain.until(() => Boolean(plain.state()));
  assert.equal(plain.state()!.sessions.length, 4, 'tools and older pages keep receiving every session');
  assert.equal(plain.id(), undefined);
});

test('resume candidates for the trigger editor come newest first, with the session a trigger names', { timeout: 10_000 }, async t => {
  const sessions = [
    session('older', { lastCompletedAt: ago(10) }), session('newer'), session('codex', { provider: 'codex' }), session('sub', { isSubagent: true, parentId: 'newer' }),
    session('not-resumable', { resumable: false }), session('master', { master: true }),
    ...Array.from({ length: 90 }, (_, index) => session(`bulk-${index}`, { lastCompletedAt: ago(20 + index) })),
  ];
  const { base, token } = await serve(t, sessions);
  const read = async (query: string) => (await (await fetch(`${base}/api/sessions/resume-candidates?${query}`, { headers: { 'X-Agent-Monitor-Token': token } })).json() as { sessions: Session[] }).sessions;
  const claude = await read('provider=claude');
  assert.equal(claude.length, 80);
  assert.deepEqual(claude.slice(0, 2).map(item => item.id), ['newer', 'older']);
  assert.ok(claude.every(item => item.provider === 'claude' && !item.isSubagent && item.resumable && !item.master && item.filePath === undefined));
  const named = await read('provider=claude&include=bulk-89');
  assert.equal(named.length, 81);
  assert.equal(named.at(-1)!.id, 'bulk-89');
  assert.deepEqual((await read('provider=codex')).map(item => item.id), ['codex']);
});
