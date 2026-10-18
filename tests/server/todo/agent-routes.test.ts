import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer } from '../../../server/http/server.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import { TowerError } from '../../../shared/errors.js';
import { TODO_MASTER_ISSUE_HEADER } from '../../../shared/master.js';
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

test('an issue master creates sessions as the main master does, and only the verified master\'s todo header records them in a family', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-issue-http-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  const contexts: unknown[] = [];
  const recorded: [string, string][] = [];
  const unused = () => { throw new Error('unused'); };
  const masterSecret = 'm'.repeat(64);
  let count = 0;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, master: { callerSecret: masterSecret, handle: async () => false }, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: 0 }),
    detail: async () => undefined, enqueue: async () => unused(), cancel: async () => {}, subscribe: () => () => {},
    createSession: async (_input, context) => {
      contexts.push(context);
      const id = `s${++count}`;
      return { session: { id } as never, run: { id: `r${count}`, sessionId: id } as never };
    },
    startAutoPrompt: async () => ({ id: `job-${++count}` }) as never,
    todos: { overview: unused, detail: unused, completed: unused, search: unused, apply: unused, issueSession: (taskId, sessionId) => { recorded.push([taskId, sessionId]); },
      issueJob: (taskId, jobId) => { recorded.push([taskId, jobId]); } },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const create = (extra: Record<string, string>) => fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...extra },
    body: JSON.stringify({ provider: 'claude', cwd: '/work', prompt: 'do it' }) });

  assert.equal((await create({ 'X-Tower-Master': masterSecret })).status, 202);
  assert.equal((await create({ 'X-Tower-Master': masterSecret, [TODO_MASTER_ISSUE_HEADER]: 'task_1' })).status, 202);
  // The same calling rights as the main master's: no calling turn, so secrets and approvals work as the owner's.
  assert.deepEqual(contexts[1], contexts[0]);
  assert.equal((contexts[0] as { callerCapability?: string }).callerCapability, undefined);
  // Without the verified master the header is nobody's word, and a malformed one is ignored.
  assert.equal((await create({ [TODO_MASTER_ISSUE_HEADER]: 'task_1', 'X-Tower-Agent': 'local' })).status, 202);
  assert.equal((await create({ 'X-Tower-Master': masterSecret, [TODO_MASTER_ISSUE_HEADER]: '../x' })).status, 202);
  assert.deepEqual(recorded, [['task_1', 's2']]);
  // An Auto Prompt job it sends is remembered for its todo the same way: a new session the job makes joins the family.
  const job = (extra: Record<string, string>) => fetch(`${base}/api/auto-prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...extra },
    body: JSON.stringify({ requestId: randomUUID(), provider: 'claude', prompt: 'do it' }) });
  assert.equal((await job({ 'X-Tower-Master': masterSecret, [TODO_MASTER_ISSUE_HEADER]: 'task_1' })).status, 202);
  assert.equal((await job({ [TODO_MASTER_ISSUE_HEADER]: 'task_1', 'X-Tower-Agent': 'local' })).status, 202);
  assert.deepEqual(recorded.slice(1), [['task_1', 'job-5']]);
});
