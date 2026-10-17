import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { createMonitorServer } from '../../../server/http/server.js';
import { callWebTools } from '../../../server/mcp/stdio.js';
import { TodoStore } from '../../../server/todo/store.js';
import { startTodosMcp, todoToolsKey } from '../../../server/todo/agent-mcp.js';
import { answerTodoTools, TODO_TOOL_NAMES, TODO_TOOLS_PATH } from '../../../server/todo/agent-tools.js';
import type { Snapshot } from '../../../shared/types.js';

/** A web with todos and the agents' todo tools, like server/index.ts composes it. */
async function web(t: TestContext, dir: string, store: TodoStore, key: string) {
  let changes = 0;
  const calls = { overview: () => store.overview(), detail: (id: string) => store.detail(id), completed: (input: Parameters<TodoStore['completed']>[0]) => store.completed(input),
    search: (query: string, input: Parameters<TodoStore['search']>[1]) => store.search(query, input), apply: (request: Parameters<TodoStore['apply']>[0]) => { changes++; return store.apply(request); } };
  const snapshot = (): Snapshot => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'test', version: 'test', updatedAt: new Date().toISOString(), todoRevision: store.revision() });
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: { snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {}, todos: calls },
    todoTools: { key, answer: body => answerTodoTools(calls, body) } });
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
  const missing = await post({ method: 'tools/call', name: 'todos_get', arguments: { id: 'missing' } });
  assert.equal(missing.status, 200, 'a refused tool call is an answer, not a failure of the route');
  assert.match((await missing.json() as { error: { message: string } }).error.message, /not found|찾을 수 없/i);
  assert.match((await (await post({ method: 'tools/remove' })).json() as { error: { message: string } }).error.message, /Unknown todo tools request/);
  assert.equal((await fetch(`${base}${TODO_TOOLS_PATH}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `TodoKey ${key}` }, body: '{}' })).status, 415);
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
  assert.deepEqual(tools.result.tools.map((tool: { name: string }) => tool.name), TODO_TOOL_NAMES);
  const added = await ask('tools/call', { name: 'todos_add', arguments: { text: 'Water the plants 매일' } });
  assert.equal(JSON.parse(added.result.content[0].text).added.recurrence.freq, 'day');
  await current.close();
  const down = await ask('tools/call', { name: 'todos_overview', arguments: {} });
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /not running/);
  // A turn that starts while the web is down still gets the tools: the list is the server's own.
  assert.deepEqual((await ask('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name), TODO_TOOL_NAMES);
  // A message too large is answered as such, and the server goes on.
  const big = await ask('tools/call', { name: 'todos_apply', arguments: { ops: [{ op: 'task.create', id: 'x', content: 'x'.repeat(9 * 1024 * 1024) }] } });
  assert.match(big.error.message, /too large/);
  current = await web(t, dir, store, key);
  const back = await ask('tools/call', { name: 'todos_overview', arguments: {} });
  assert.equal(JSON.parse(back.result.content[0].text).counts.open, 1);
});

test('a request is never sent twice: an answer lost after sending is uncertain, and only a refused connection or a key not taken tries elsewhere', async t => {
  const servers: Server[] = [];
  t.after(() => { for (const server of servers) server.close(); });
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
  };
  let reached = 0;
  const ok = await serve((_req, res) => { reached++; res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { done: true } })); });
  const drop = await serve(req => { req.socket.destroy(); });
  const forbid = await serve((_req, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'This todo tools key is not valid.' } })); });
  const closed = await serve(() => undefined);
  await new Promise<void>(resolve => servers.at(-1)!.close(() => resolve()));
  const call = (ports: number[]) => callWebTools('/state', TODO_TOOLS_PATH, 'k'.repeat(64), { method: 'tools/call' }, async () => ports);
  await assert.rejects(call([drop, ok]), /may or may not have been made/);
  assert.equal(reached, 0, 'never sent to the next one');
  assert.deepEqual(await call([closed, forbid, ok]), { done: true });
  assert.equal(reached, 1);
  await assert.rejects(call([forbid]), /did not accept the todo tools key/);
  await assert.rejects(call([closed]), /not running/);
});
