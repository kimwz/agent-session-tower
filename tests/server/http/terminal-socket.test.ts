import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { WebSocket } from 'ws';
import { createMonitorServer } from '../../../server/http/server.js';
import { WorkspaceTerminals, type WorkspacePty } from '../../../server/workspace-terminals.js';
import { nodeRelay, serveTerminalSocket, SseReader, type TerminalRelay } from '../../../server/http/terminal-socket.js';
import { WebSocketServer } from 'ws';
import { openTerminalSocket, type TerminalConnectionHandlers } from '../../../client/src/workspace/terminal-connection.js';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { until } from '../../helpers/until.ts';
import type { Snapshot } from '../../../shared/types.js';

class Pty implements WorkspacePty {
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = 0;
  listeners = new Set<(data: string) => void>();
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed++; }
  onData(listener: (data: string) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  onExit() { return { dispose() {} }; }
  output(data: string) { for (const listener of this.listeners) listener(data); }
}

async function fixture(t: test.TestContext, remote = false) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-terminal-socket-'));
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: new Date().toISOString(), groups: [{ cwd: dir, title: '', pinned: true }] };
  const pty = new Pty();
  const workspaceTerminals = new WorkspaceTerminals({ spawnPty: () => pty });
  const authFixture = remote ? await createRemoteAuthFixture(dir) : undefined;
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, workspaceTerminals, ...(authFixture ? { auth: authFixture.auth, remote: { origins: authFixture.origins } } : {}),
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  const host = remote ? `remote.test:${port}` : `127.0.0.1:${port}`;
  const fetch = authFixture?.fetch ?? globalThis.fetch;
  const cookie = authFixture?.cookie ?? '';
  const base = `http://127.0.0.1:${port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json() as { token: string };
  const created = await fetch(`${base}/api/workspace/terminals`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify({ cwd: dir, cols: 80, rows: 24 }) });
  assert.equal(created.status, 200);
  const { id } = await created.json() as { id: string };
  const url = (shell = id) => `ws://127.0.0.1:${port}/api/workspace/terminals/${shell}/socket`;
  const headers = { Host: host, Origin: `http://${host}`, ...(remote ? { Cookie: cookie, 'X-Forwarded-For': '192.0.2.1' } : {}) };
  return { pty, token, id, url, headers, base, fetch, cookie, auth: authFixture?.auth };
}

/** Opens a socket the way a page does, recording what it hears. */
function connect(url: string, headers: Record<string, string>, token: string, cursor?: string) {
  const heard: { ready: number; output: string; ids: string[]; exit?: number; gone: number; lost: boolean[]; refused: string[] } = { ready: 0, output: '', ids: [], gone: 0, lost: [], refused: [] };
  const handlers: TerminalConnectionHandlers = {
    ready: () => { heard.ready++; },
    output: (data, id) => { heard.output += data; if (id) heard.ids.push(id); },
    exit: code => { heard.exit = code; },
    gone: () => { heard.gone++; },
    lost: opened => { heard.lost.push(opened); },
    refused: (_status, message) => { heard.refused.push(message); },
  };
  const connection = openTerminalSocket(url, token, cursor, handlers, { create: value => new WebSocket(value, { headers }) as unknown as globalThis.WebSocket });
  return { heard, connection };
}

/** The status a refused upgrade answers with. */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise(resolve => {
    const socket = new WebSocket(url, { headers });
    socket.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); socket.terminate(); });
    socket.on('open', () => { resolve(101); socket.close(); });
    socket.on('error', () => {});
  });
}

test('a terminal tab streams output and sends keys and sizes over one WebSocket', async t => {
  const f = await fixture(t);
  f.pty.output('history\r\n');
  const { heard, connection } = connect(f.url(), f.headers, f.token);
  await until(() => heard.ready === 1);
  assert.match(heard.output, /history/, 'what the shell printed before is replayed');
  f.pty.output('live\r\n');
  await until(() => heard.output.includes('live'));
  connection.input('echo hi\r');
  connection.input('x'.repeat(40 * 1024));
  connection.resize(120, 40);
  await until(() => f.pty.sizes.some(([cols]) => cols === 120));
  assert.deepEqual(f.pty.written.join(''), `echo hi\r${'x'.repeat(40 * 1024)}`, 'keys arrive whole and in order, in chunks under the input limit');
  // Many more keys than the page's request budget allows over HTTP in a minute.
  for (let index = 0; index < 100; index++) connection.input('y');
  await until(() => f.pty.written.join('').endsWith('y'.repeat(100)));

  // A reconnecting tab continues after the last output it showed instead of replaying everything.
  connection.close();
  f.pty.output('meanwhile\r\n');
  const again = connect(f.url(), f.headers, f.token, heard.ids.at(-1));
  await until(() => again.heard.ready === 1 && again.heard.output.includes('meanwhile'));
  assert.doesNotMatch(again.heard.output, /history|live/);

  await f.fetch(`${f.base}/api/workspace/terminals/${f.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': f.token }, body: '{}' });
  await until(() => again.heard.exit !== undefined);
  assert.equal(f.pty.killed, 1);
  const closed = connect(f.url(), f.headers, f.token);
  await until(() => closed.heard.gone === 1);
  assert.equal(closed.heard.ready, 0);
});

test('the page can list every shell of this computer, in any folder', async t => {
  const f = await fixture(t);
  const answer = await f.fetch(`${f.base}/api/workspace/terminals/all`);
  assert.equal(answer.status, 200);
  const { terminals } = await answer.json() as { terminals: Array<{ id: string; cwd: string; origin: string }> };
  assert.deepEqual(terminals.map(item => [item.id, item.origin]), [[f.id, 'self']]);
  assert.ok(terminals[0].cwd.length > 0);
});

test('a terminal socket passes the checks every page request does', async t => {
  const f = await fixture(t, true);
  assert.equal(await upgradeStatus(f.url(), f.headers), 101);
  assert.equal(await upgradeStatus(f.url(), { ...f.headers, Cookie: '' }), 401, 'signed out');
  assert.equal(await upgradeStatus(f.url(), { ...f.headers, Origin: 'https://attacker.example' }), 403, 'another site');
  const { Origin: _, ...noOrigin } = f.headers;
  assert.equal(await upgradeStatus(f.url(), noOrigin), 403, 'no page origin');
  assert.equal(await upgradeStatus(f.url(), { ...f.headers, Host: 'evil.test' }), 403, 'unknown host');
  assert.equal(await upgradeStatus(f.url().replace('/socket', '/sockets'), f.headers), 404);
  const wrong = connect(f.url(), f.headers, 'f'.repeat(64));
  await until(() => wrong.heard.lost.length === 1);
  wrong.connection.input('never');
  assert.equal(wrong.heard.ready, 0);
  assert.deepEqual(f.pty.written, [], 'nothing reaches the shell without the page token');
  const right = connect(f.url(), f.headers, f.token);
  await until(() => right.heard.ready === 1);
  right.connection.input('ok');
  await until(() => f.pty.written.join('') === 'ok');
  right.connection.close();
});

test('signing out cuts a remote page\'s terminal socket off at once', async t => {
  const f = await fixture(t, true);
  const { heard, connection } = connect(f.url(), f.headers, f.token);
  await until(() => heard.ready === 1);
  await f.auth!.setCredentials('monitor', 'replacement-fixture-password');
  await until(() => heard.lost.length === 1);
  connection.input('after sign-out');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(f.pty.written, []);
});

test('a socket ends when the shell\'s stream ends without an error, so the page reconnects', async t => {
  let attached: Writable | undefined;
  const relay: TerminalRelay = { events: async (_id, body) => { attached = body; }, input: async () => {}, resize: async () => {} };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise<void>(resolve => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()); }));
  await new Promise(resolve => wss.once('listening', resolve));
  wss.on('connection', ws => serveTerminalSocket(ws, 'fixture', relay, token => token === 'a'.repeat(64)));
  const { heard } = connect(`ws://127.0.0.1:${(wss.address() as { port: number }).port}/`, {}, 'a'.repeat(64));
  await until(() => heard.ready === 1);
  // The terminal host went away, or a reader was too slow: the stream is destroyed, not ended.
  attached!.destroy();
  await until(() => heard.lost.length === 1);
  assert.deepEqual(heard.lost, [true]);
});

test('a joined computer\'s shell is reached over its link with the routes it already offers', async t => {
  const events: Array<{ cursor?: string; res: http2.Http2ServerResponse }> = [];
  const posted: Array<{ path: string; body: unknown }> = [];
  const node = http2.createServer((req, res) => {
    const path = req.url;
    if (req.method === 'GET' && path === '/api/workspace/terminals/00000000-0000-4000-8000-000000000001/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      res.write(`id: 7\nevent: output\ndata: ${JSON.stringify({ data: 'over the link' })}\n\n`);
      events.push({ cursor: req.headers['last-event-id'] as string | undefined, res });
      return;
    }
    if (req.method === 'POST' && /0001\/(input|resize)$/.test(path)) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { posted.push({ path, body: JSON.parse(body) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '터미널을 찾을 수 없습니다. 새 터미널을 여세요.' }));
  });
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const session = http2.connect(`http://127.0.0.1:${(node.address() as { port: number }).port}`);
  t.after(async () => { session.destroy(); await new Promise<void>(resolve => node.close(() => resolve())); });
  const relay = nodeRelay(() => session);
  let text = '';
  const reader = new SseReader();
  const body = new Writable({ write(chunk, _encoding, callback) { for (const event of reader.push(String(chunk))) text += `${event.event}:${event.id}:${event.data}`; callback(); } });
  await relay.events('00000000-0000-4000-8000-000000000001', body, '5');
  await until(() => text.includes('over the link'));
  assert.equal(text, 'output:7:{"data":"over the link"}');
  assert.equal(events[0].cursor, '5');
  await relay.input('00000000-0000-4000-8000-000000000001', 'ls\r');
  await relay.resize('00000000-0000-4000-8000-000000000001', 90, 30);
  assert.deepEqual(posted, [{ path: '/api/workspace/terminals/00000000-0000-4000-8000-000000000001/input', body: { data: 'ls\r' } },
    { path: '/api/workspace/terminals/00000000-0000-4000-8000-000000000001/resize', body: { cols: 90, rows: 30 } }]);
  // The page closing its socket ends the stream over there too.
  body.destroy();
  await until(() => events[0].res.stream.destroyed);
  await assert.rejects(relay.events('00000000-0000-4000-8000-000000000002', new Writable({ write(_c, _e, cb) { cb(); } }), undefined), (error: { statusCode?: number; kind?: string }) => error.kind === 'not-found');
  await assert.rejects(relay.input('00000000-0000-4000-8000-000000000002', 'x'), (error: { kind?: string }) => error.kind === 'not-found');
  const offline = nodeRelay(() => undefined);
  await assert.rejects(offline.input('00000000-0000-4000-8000-000000000001', 'x'), (error: { kind?: string }) => error.kind === 'unavailable');
});

test('server-sent events are read whatever chunks they arrive in', () => {
  const reader = new SseReader();
  assert.deepEqual(reader.push(': heartbeat\n\nid: 1\nevent: out'), []);
  assert.deepEqual(reader.push('put\ndata: {"data":"a"}\n\nevent: exit\ndata: {"exitCode":2}\n\n'), [{ event: 'output', id: '1', data: '{"data":"a"}' }, { event: 'exit', data: '{"exitCode":2}' }]);
});
