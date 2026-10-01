import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
import { createMonitorServer } from '../../server/http/server.js';
import { masterRoutes } from '../../server/master/routes.js';
import type { MasterClient } from '../../server/master/client.js';
import { createRemoteAuthFixture } from '../helpers/auth.js';
import type { Snapshot } from '../../shared/types.js';

const listen = (server: Server, port = 0) => new Promise<number>(resolve => server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test('while the web restarts, a request the web never received waits for the new web and goes out once', async t => {
  const probe = createServer();
  const port = await listen(probe);
  await stop(probe);
  const client = new TowerClient();
  client.setCredentials({ port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const seen: string[] = [];
  const pending = client.call('POST', '/api/sessions', { prompt: 'x' }, { write: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  // The replacement web listens on the same port with a new page token, and says who it is.
  const web = createServer((req, res) => {
    seen.push(String(req.headers['x-agent-monitor-token']));
    res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  t.after(() => stop(web));
  await listen(web, port);
  client.setCredentials({ port, token: 'c'.repeat(64), callerSecret: 'b'.repeat(64) });
  const answer = await pending;
  assert.equal(answer.state, 'succeeded');
  assert.deepEqual(seen, ['c'.repeat(64)]);
});

test('a page token the web no longer knows is refused before anything runs, so the request waits for the new token', async t => {
  const seen: string[] = [];
  const web = createServer((req, res) => {
    const token = String(req.headers['x-agent-monitor-token']);
    seen.push(token);
    if (token !== 'd'.repeat(64)) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '연결 인증이 만료되었습니다. 페이지를 새로고침하세요.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  t.after(() => stop(web));
  const port = await listen(web);
  const client = new TowerClient();
  client.setCredentials({ port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const pending = client.call('POST', '/api/runs/r/steer', {}, { write: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  client.setCredentials({ port, token: 'd'.repeat(64), callerSecret: 'b'.repeat(64) });
  assert.equal((await pending).state, 'succeeded');
  assert.deepEqual(seen, ['a'.repeat(64), 'd'.repeat(64)]);
});

test('a stale page token refused after the new web already said who it is goes again with the new token', async t => {
  const seen: string[] = [];
  let port = 0;
  const client = new TowerClient();
  const web = createServer((req, res) => {
    const token = String(req.headers['x-agent-monitor-token']);
    seen.push(token);
    if (token !== 'd'.repeat(64)) {
      // The replacement web announces itself before the old token's refusal arrives.
      client.setCredentials({ port, token: 'd'.repeat(64), callerSecret: 'b'.repeat(64) });
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '연결 인증이 만료되었습니다. 페이지를 새로고침하세요.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  t.after(() => stop(web));
  port = await listen(web);
  client.setCredentials({ port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  assert.equal((await client.call('POST', '/api/runs/r/steer', {}, { write: true })).state, 'succeeded');
  assert.deepEqual(seen, ['a'.repeat(64), 'd'.repeat(64)]);
});

test('a change that finds no web in time comes back as not sent instead of failing the call', async () => {
  const probe = createServer();
  const port = await listen(probe);
  await stop(probe);
  const client = new TowerClient(200);
  client.setCredentials({ port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const answer = await client.call('POST', '/api/sessions', {}, { write: true });
  assert.equal(answer.state, 'not-admitted');
  assert.equal((await new TowerClient(100).call('POST', '/api/sessions', {}, { write: true })).state, 'not-admitted', 'also when no web ever said who it is');
});

test('a change waiting for a web is not sent once it is stopped, even when the web then comes back', async t => {
  const probe = createServer();
  const port = await listen(probe);
  await stop(probe);
  const client = new TowerClient();
  client.setCredentials({ port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const stopper = new AbortController();
  const pending = client.call('POST', '/api/sessions', { prompt: 'x' }, { write: true, beforeSend: stopper.signal });
  await new Promise(resolve => setTimeout(resolve, 150));
  stopper.abort();
  let calls = 0;
  const web = createServer((_req, res) => { calls++; res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}'); });
  t.after(() => stop(web));
  await listen(web, port);
  client.setCredentials({ port, token: 'c'.repeat(64), callerSecret: 'b'.repeat(64) });
  assert.equal((await pending).state, 'not-admitted');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls, 0);
});

test('a change the server says it did not admit is sent once more; one cut off mid-way is not', async t => {
  let calls = 0;
  const web = createServer((req, res) => {
    calls++;
    if (req.url === '/api/busy') { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'handoff', disposition: 'not-admitted' })); return; }
    req.socket.destroy();
  });
  t.after(() => stop(web));
  const port = await listen(web);
  const client = new TowerClient();
  client.setCredentials({ port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const busy = await client.call('POST', '/api/busy', {}, { write: true });
  assert.equal(busy.state, 'not-admitted');
  assert.equal(calls, 2, 'one retry after the server said it ran nothing');
  calls = 0;
  const cut = await client.call('POST', '/api/cut', {}, { write: true });
  assert.equal(cut.state, 'uncertain');
  assert.equal(calls, 1);
});

test('Tower\'s server gives the master routes only after sign-in, and the master\'s own calls their own budget', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-http-'));
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
  const backend = { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw Object.assign(new Error('no session'), { statusCode: 404 }); }, cancel: async () => {}, subscribe: () => () => {} };
  const identities: boolean[] = [];
  const callerSecret = 'e'.repeat(64);
  const { server, dispose, token } = createMonitorServer({ port: 0, clientDir: dir, backend, master: { callerSecret, handle: async (_req, res, path, _url, identity) => {
    identities.push(identity.local);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path }));
    return true;
  } } });
  // One cleanup, in order: hooks run as registered, and a directory removed under a running server fails and leaves it open.
  t.after(async () => { dispose(); await stop(server); await rm(dir, { recursive: true, force: true }); });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/api/master`)).json(), { path: '/api/master' });
  assert.deepEqual(identities, [true]);
  const post = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...headers }, body: '{}' });
  assert.equal((await fetch(`${base}/api/master/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'changes still need the page token');
  // The owner's pages use up their 30 changes a minute; the master's calls still go.
  for (let index = 0; index < 29; index++) await post('/api/sessions/x/messages');
  assert.notEqual((await post('/api/sessions/x/messages')).status, 429);
  assert.equal((await post('/api/sessions/x/messages')).status, 429);
  assert.equal((await post('/api/sessions/x/messages', { 'X-Tower-Master': 'f'.repeat(64) })).status, 429, 'a wrong marker counts as the owner');
  assert.notEqual((await post('/api/sessions/x/messages', { 'X-Tower-Master': callerSecret })).status, 429, 'the master has its own budget');
  // The page where voice is on reports every few seconds (240 a minute) and can always turn voice off.
  for (let index = 0; index < 240; index++) assert.notEqual((await post('/api/master/voice/activity')).status, 429);
  assert.equal((await post('/api/master/voice/activity')).status, 429);
  assert.equal((await post('/api/master/voice/played')).status, 429, 'reports share their budget');
  assert.equal((await post('/api/master/voice/finished')).status, 429, 'so do judgments of a pause');
  assert.equal((await post('/api/master/voice/token')).status, 429);
  assert.notEqual((await post('/api/master/voice/off')).status, 429, 'turning voice off has a budget of its own');
  assert.equal((await post('/api/master/voice/on')).status, 429, 'turning voice on counts as a change');
  assert.equal((await post('/api/master/voice/activity/')).status, 429, 'nothing else looks like a report');
});

test('without a master, Tower\'s server answers as before', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-http-'));
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} } });
  // One cleanup, in order: hooks run as registered, and a directory removed under a running server fails and leaves it open.
  t.after(async () => { dispose(); await stop(server); await rm(dir, { recursive: true, force: true }); });
  const port = await listen(server);
  const answer = await fetch(`http://127.0.0.1:${port}/api/master`);
  assert.notEqual(answer.status, 200);
});

test('signing a page out ends its live master stream, like every other stream', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-master-http-'));
  const { auth, origins, cookie, fetch: remoteFetch } = await createRemoteAuthFixture(dir);
  const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins }, backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} },
    master: { callerSecret: 'e'.repeat(64), handle: async (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return true; } } });
  // One cleanup, in order: the sign-out's session write must end before its directory is removed.
  t.after(async () => { dispose(); await stop(server); await auth.flush(); await rm(dir, { recursive: true, force: true }); });
  const port = await listen(server);
  const stream = await remoteFetch(`http://127.0.0.1:${port}/api/master/events`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  await reader.read();
  auth.logout(cookie.slice('tower_session='.length));
  const ended = await Promise.race([reader.read().then(() => 'ended', () => 'ended'), new Promise(resolve => setTimeout(() => resolve('open'), 2000))]);
  assert.equal(ended, 'ended');
});

test('a page\'s answers to screen commands, where it shows the master, and the master\'s start reach the host', async t => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { call: async (method: string, args: Record<string, unknown>) => { calls.push([method, args]); return { ok: true }; } } as unknown as MasterClient;
  const handle = masterRoutes(client);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://tower.invalid');
    if (!await handle(req, res, url.pathname, url, { local: true })) res.writeHead(404).end();
  });
  t.after(() => stop(server));
  const port = await listen(server);
  const id = '0190f1c2-3d4e-7f00-8a00-000000000001';
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(`/api/master/directives/${id}`, { result: 'done', note: 'ok' })).status, 200);
  assert.equal((await post('/api/master/presence', { tabId: 'tab-00000001' })).status, 200);
  assert.equal((await post('/api/master/start', { provider: 'claude', text: '안녕', model: 'opus' })).status, 200);
  assert.equal((await post('/api/master/release', {})).status, 200);
  // What the API master had is gone.
  assert.equal((await post(`/api/master/cards/${id}`, { value: 'x' })).status, 404);
  assert.equal((await post('/api/master/messages', { text: 'x' })).status, 404);
  assert.deepEqual(calls, [['ack', { id, result: 'done', note: 'ok' }], ['presence', { tabId: 'tab-00000001' }],
    ['start', { provider: 'claude', text: '안녕', model: 'opus', effort: undefined, replace: false }], ['release', {}]]);
});

test('voice goes to the host through the master routes, turning it on with whether the page is on this computer, and its audio is relayed', async t => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const piped: string[] = [];
  const client = {
    call: async (method: string, args: Record<string, unknown>) => { calls.push([method, args]); return method === 'voiceOn' ? { session: 's' } : true; },
    pipeAudio: async (res: import('node:http').ServerResponse, id: string) => { piped.push(id); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end('mp3'); },
  } as unknown as MasterClient;
  const handle = masterRoutes(client);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://tower.invalid');
    if (!await handle(req, res, url.pathname, url, { local: false })) res.writeHead(404).end();
  });
  t.after(() => stop(server));
  const port = await listen(server);
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tabId = '0190f1c2-3d4e-7f00-8a00-000000000002';
  assert.deepEqual(await (await post('/api/master/voice/on', { tabId, local: true })).json(), { session: 's' });
  await post('/api/master/voice/presence', { session: 's', listening: true, panelOpen: true });
  await post('/api/master/voice/token', { session: 's' });
  await post('/api/master/voice/usage', { tokenId: 't', seconds: 3 });
  await post('/api/master/voice/request', { session: 's', clientMessageId: 'message-0001', text: '안녕', viewContext: { sessionId: 'x' }, local: true });
  await post('/api/master/voice/activity', { session: 's', speaking: true, sinceSpeechMs: 0, extra: 'ignored' });
  await post('/api/master/voice/played', { session: 's', id: 'n', result: 'played' });
  assert.deepEqual(await (await post('/api/master/voice/finished', { session: 's', text: '배포해 줘', pauseMs: 1_000 })).json(), { unavailable: true }, 'without fast judgments the page decides');
  await post('/api/master/voice/off', { session: 's' });
  assert.equal((await post('/api/master/voice/other', {})).status, 404);
  assert.deepEqual(calls.map(([method]) => method), ['voiceOn', 'voicePresence', 'voiceToken', 'voiceUsage', 'voiceRequest', 'voiceActivity', 'voicePlayed', 'voiceOff']);
  assert.equal(calls[0][1].local, false, 'the server says where the page is, not the page');
  assert.equal(calls[4][1].local, false);
  assert.deepEqual(calls[5][1], { session: 's', speaking: true, sinceSpeechMs: 0 });
  const audio = await fetch(`http://127.0.0.1:${port}/api/master/voice/audio/clip-${'a'.repeat(64)}`);
  assert.equal(await audio.text(), 'mp3');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/master/voice/audio/../secret`)).status, 404);
  assert.deepEqual(piped, [`clip-${'a'.repeat(64)}`]);
});
