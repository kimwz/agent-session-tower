import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createMonitorServer } from '../../../server/http/server.js';
import { TodoStore } from '../../../server/todo/store.js';
import { startTodosMcp, todoToolsKey } from '../../../server/todo/agent-mcp.js';
import { callTodoTool, TODO_TOOLS_PATH, todoToolList } from '../../../server/todo/agent-tools.js';
import type { Snapshot } from '../../../shared/types.js';

/** A web with todos and the agents' todo tools, like server/index.ts composes it. */
async function web(t: TestContext, dir: string, store: TodoStore, key: string) {
  let changes = 0;
  const calls = { overview: () => store.overview(), detail: (id: string) => store.detail(id), completed: (input: Parameters<TodoStore['completed']>[0]) => store.completed(input),
    search: (query: string, input: Parameters<TodoStore['search']>[1]) => store.search(query, input), apply: (request: Parameters<TodoStore['apply']>[0]) => { changes++; return store.apply(request); } };
  const snapshot = (): Snapshot => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: store.revision() });
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: { snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {}, todos: calls },
    todoTools: { key, answer: body => body.method === 'tools/list' ? { tools: todoToolList() } : callTodoTool(calls, String(body.name ?? ''), body.arguments) } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  t.after(close);
  return { port, close, changes: () => changes };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-todo-mcp-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Tower</title>');
  const store = new TodoStore(dir);
  store.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, key: await todoToolsKey(dir) };
}

test('the key is made once, kept owner-only, and is the same after a restart', async t => {
  const { dir, key } = await fixture(t);
  assert.match(key, /^[a-f\d]{64}$/);
  assert.equal((await stat(join(dir, 'todo-tools-key.json'))).mode & 0o777, 0o600);
  assert.equal(await todoToolsKey(dir), key);
});

test('the web answers the todo tools only with their key, from this computer, never from a page; the key opens nothing else', async t => {
  const { dir, store, key } = await fixture(t);
  const { port, changes } = await web(t, dir, store, key);
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${TODO_TOOLS_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `TodoKey ${key}`, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ method: 'tools/list' }, { Authorization: '' })).status, 403);
  assert.equal((await post({ method: 'tools/list' }, { Authorization: `TodoKey ${'0'.repeat(64)}` })).status, 403);
  assert.equal((await post({ method: 'tools/list' }, { Origin: base })).status, 403);
  assert.equal((await post({ method: 'tools/list' }, { 'Sec-Fetch-Site': 'same-origin' })).status, 403);
  assert.equal((await fetch(`${base}${TODO_TOOLS_PATH}`, { method: 'GET', headers: { Authorization: `TodoKey ${key}` } })).status, 405);
  const listed = await (await post({ method: 'tools/list' })).json() as { result: { tools: { name: string }[] } };
  assert.ok(listed.result.tools.some(tool => tool.name === 'todos_add'));
  const added = await (await post({ method: 'tools/call', name: 'todos_add', arguments: { text: 'Pay rent p1' } })).json() as { result: { added: { content: string; priority: number } } };
  assert.deepEqual([added.result.added.content, added.result.added.priority, changes(), store.revision()], ['Pay rent', 1, 1, 1]);
  const refused = await (await post({ method: 'tools/call', name: 'todos_get', arguments: { id: 'missing' } })).json() as { error: { message: string } };
  assert.ok(refused.error.message.length > 0);
  // The key is not the page token: it changes nothing elsewhere.
  assert.equal((await fetch(`${base}/api/todos/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `TodoKey ${key}` }, body: '{}' })).status, 403);
});

test('the tool server a turn starts reaches the web, finds it again after a restart on another port, and says when Tower is not running', async t => {
  const { dir, store, key } = await fixture(t);
  let current = await web(t, dir, store, key);
  const ports = async () => [current.port];
  const input = new PassThrough(), output = new PassThrough();
  const replies: any[] = [];
  let buffer = '';
  output.on('data', chunk => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf('\n')) !== -1) { replies.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const serving = startTodosMcp(dir, input, output, ports);
  t.after(() => { input.end(); return serving; });
  let next = 0;
  const ask = async (method: string, params: unknown) => {
    const id = ++next;
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let wait = 0; wait < 200 && !replies.some(reply => reply.id === id); wait++) await new Promise(resolve => setTimeout(resolve, 10));
    return replies.find(reply => reply.id === id);
  };
  const tools = await ask('tools/list', {});
  assert.ok(tools.result.tools.length >= 10);
  const added = await ask('tools/call', { name: 'todos_add', arguments: { text: 'Water the plants 매일' } });
  assert.equal(JSON.parse(added.result.content[0].text).added.recurrence.freq, 'day');
  await current.close();
  const down = await ask('tools/call', { name: 'todos_overview', arguments: {} });
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /not running/);
  current = await web(t, dir, store, key);
  const back = await ask('tools/call', { name: 'todos_overview', arguments: {} });
  assert.equal(JSON.parse(back.result.content[0].text).counts.open, 1);
});
