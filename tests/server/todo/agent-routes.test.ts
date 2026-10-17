import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { TowerError } from '../../../shared/errors.js';
import type { Snapshot } from '../../../shared/types.js';
import type { TodoAgent } from '../../../shared/todo/types.js';

test('only the owner\'s own page starts an issue master; badges read the open families', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-agent-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  const started: [string, string][] = [];
  const snapshot = (): Snapshot => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: 0 });
  const unused = () => { throw new Error('unused'); };
  const masterSecret = 'm'.repeat(64);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, master: { callerSecret: masterSecret, handle: async () => false }, backend: {
    snapshot, detail: async () => undefined, enqueue: async () => unused(), cancel: async () => {}, subscribe: () => () => {},
    todos: {
      overview: unused, detail: unused, completed: unused, search: unused, apply: unused,
      startAgent: async (id, text) => {
        if (id === 'closed') throw new TowerError('conflict', 'closed');
        started.push([id, text]);
        return { taskId: id, sessionId: 's1', provider: 'claude', state: 'active', createdAt: '', updatedAt: '' } satisfies TodoAgent;
      },
      agentSessions: () => ({ s1: { taskId: 'a', title: 'A' } }),
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  // As the page sends it: a browser names the page's origin on every POST.
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, Origin: base };
  const start = (body: unknown, extra: Record<string, string> = {}, id = 'a') => fetch(`${base}/api/todos/tasks/${id}/agent`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  // Whatever names the master, a local agent, a calling turn or the todo tools' key is refused, proven or not.
  for (const extra of <Record<string, string>[]>[{ 'X-Tower-Master': masterSecret }, { 'X-Tower-Master': 'x' }, { 'X-Tower-Agent': 'local' }, { [CALLER_CAPABILITY_HEADER]: 'a'.repeat(64) }, { Authorization: `TodoKey ${'b'.repeat(64)}` }]) {
    assert.equal((await start({ text: 'go' }, extra)).status, 403, JSON.stringify(extra));
  }
  assert.equal((await fetch(`${base}/api/todos/tasks/a/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"text":"go"}' })).status, 403);
  // Something on this computer that is not a page (no origin) is not the owner either, page token or not.
  assert.equal((await fetch(`${base}/api/todos/tasks/a/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: '{"text":"go"}' })).status, 403);
  for (const body of [{}, { text: '   ' }, { text: 'x'.repeat(32_001) }, { text: 'go', provider: 'codex' }, { text: 1 }]) assert.equal((await start(body)).status, 400, JSON.stringify(body).slice(0, 40));
  assert.equal((await start({ text: 'go' }, {}, 'a%20b')).status, 400);
  assert.deepEqual(started, []);

  const answer = await start({ text: '  고쳐줘 ' });
  assert.equal(answer.status, 202);
  assert.deepEqual((await answer.json() as { agent: TodoAgent }).agent.sessionId, 's1');
  assert.deepEqual(started, [['a', '고쳐줘']]);
  assert.equal((await start({ text: 'go' }, {}, 'closed')).status, 409);

  assert.deepEqual(await (await fetch(`${base}/api/todos/agents/sessions`)).json(), { sessions: { s1: { taskId: 'a', title: 'A' } } });
});
