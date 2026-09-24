import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { get, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Http2ServerRequest } from 'node:http2';
import type { Run, Session, Snapshot } from '../../../shared/types.js';
import type { Backend } from '../../../server/http/server.js';
import type { RequestContext } from '../../../server/http/request-context.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { NodeViewStore } from '../../../server/link/views.js';
import { RemoteNodes } from '../../../server/link/nodes.js';
import { loadLinkIdentity } from '../../../server/link/identity.js';
import { until } from '../../helpers/until.ts';

const now = new Date().toISOString();
const session = (id: string, cwd: string, title = id): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title, cwd, project: 'p',
  status: 'idle', statusReason: '', createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true });

/** A joined computer with a real remote router over a backend of fixed sessions, one of them in an excluded folder. */
async function node(t: TestContext, name: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `tower-nodes-${name}-`)));
  const open = join(root, 'open'), secret = join(root, 'secret');
  await mkdir(open); await mkdir(secret); await mkdir(join(root, 'state'));
  const exclusions = new RemoteExclusionStore(join(root, 'state'));
  await exclusions.start();
  await exclusions.add(secret);
  const sessions = [session('codex:shared', open, 'Shared work'), session('codex:private', secret, 'Private work')];
  const runs: Run[] = [];
  const listeners = new Set<() => void>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend: Backend = {
    snapshot: (): Snapshot => ({ sessions, runs, providers: [{ provider: 'codex', available: true, sessionCount: 2 }], groups: [], scanning: false, hostname: name, version: 'test', updatedAt: new Date().toISOString() }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    detail: async id => { const found = sessions.find(item => item.id === id); return found ? { session: found, messages: [], hasMore: false } : undefined; },
    session: id => sessions.find(item => item.id === id),
    coordinators: () => new Set(),
    enqueue: async (id, prompt, _attachments, context?: RequestContext) => { calls.push({ method: 'enqueue', args: [id, prompt, context] }); return { id: 'run-new', sessionId: id, prompt, status: 'queued', createdAt: now, output: '' }; },
    setGroup: async patch => { calls.push({ method: 'setGroup', args: [patch] }); return { cwd: patch.cwd, title: patch.title ?? '', pinned: false }; },
    cancel: async () => {},
  };
  const router = createRemoteRouter({ backend, exclusions });
  const identity = await loadLinkIdentity(join(root, 'state'));
  const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const links = new NodeLinks({ stateDir: join(root, 'state'), identity, version: '1.23.0', hostname: () => name, features: () => ['read', 'work'],
    handle: (req: Http2ServerRequest, res, principal) => {
      seen.push({ url: req.url, headers: { ...req.headers } });
      if (req.url === '/api/refuse') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"no"}'); return; }
      return router.handle(req, res, principal);
    } });
  await links.start();
  const changed = () => { for (const listener of listeners) listener(); };
  t.after(async () => { await links.close(); router.dispose(); await rm(root, { recursive: true, force: true }); });
  return { name, open, secret, sessions, calls, seen, links, changed, identity, stop: () => links.close() };
}

/** This Tower: a controller with its web server, the way its page reaches joined computers. */
async function tower(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-nodes-a-'));
  const identity = await loadLinkIdentity(stateDir);
  const controller = new ControllerLinks({ stateDir, identity, version: '1.23.0', hostname: () => 'computer-a' });
  await controller.start();
  await controller.setHub({ enabled: true, port: 0, bind: '127.0.0.1' });
  await controller.setHub({ custom: [`ws://127.0.0.1:${controller.hub().port}/tower-link`] });
  const views = new NodeViewStore(stateDir);
  await views.start();
  const nodes = new RemoteNodes(controller, views);
  let local: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'computer-a', version: 'test', updatedAt: now };
  const listeners = new Set<() => void>();
  const read = () => { const list = nodes.list(); return { ...local, ...(list.length ? { nodes: list } : {}) }; };
  nodes.on('summary', () => { for (const listener of listeners) listener(); });
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: stateDir, nodes, backend: {
    snapshot: read, detail: async () => undefined, cancel: async () => {}, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enqueue: async () => { throw new Error('unused'); } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { nodes.close(); await controller.close(); dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(stateDir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json() as { token: string };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token, ...headers }, body: JSON.stringify(body) });
  return { stateDir, identity, controller, nodes, base, post, setLocal: (next: Snapshot) => { local = next; } };
}

/** The page's event stream, as frames. */
function events(t: TestContext, url: string) {
  const frames: Array<{ event: string; data: any }> = [];
  let response: IncomingMessage | undefined;
  const request = get(url, res => {
    response = res;
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const text = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(text)?.[1];
        const data = /^data: (.*)$/m.exec(text)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) });
      }
    });
  });
  request.on('error', () => {});
  t.after(() => { request.destroy(); response?.destroy(); });
  return frames;
}

async function joined(t: TestContext, a: Awaited<ReturnType<typeof tower>>, name: string) {
  const b = await node(t, name);
  await b.links.join((await a.controller.invite()).code);
  const id = (await until(() => a.controller.list().find(item => item.name === name && item.status === 'connected'), 5000)).id;
  await until(() => a.nodes.snapshot(id), 5000);
  return { ...b, id };
}

test('a joined computer’s shared sessions reach this Tower’s page on the same stream and follow its changes', async t => {
  const a = await tower(t);
  const b = await joined(t, a, 'computer-b');
  const frames = events(t, `${a.base}/api/events?patch=1&nodes=1`);
  const first = await until(() => frames.find(frame => frame.event === 'node'), 5000);
  assert.equal(first.data.node, b.id);
  assert.deepEqual(first.data.snapshot.sessions.map((item: Session) => item.id), ['codex:shared'], 'excluded folders never leave the joined computer');
  const own = frames.find(frame => frame.event === 'snapshot');
  assert.deepEqual(own?.data.nodes.map((item: { name: string; status: string; streaming: boolean }) => [item.name, item.status, item.streaming]), [['computer-b', 'connected', true]]);
  b.sessions[0] = { ...b.sessions[0], title: 'Renamed over there' };
  b.changed();
  const patch = await until(() => frames.find(frame => frame.event === 'node' && frame.data.patch), 5000);
  assert.deepEqual(patch.data.patch.sessions.upsert.map((item: Session) => item.title), ['Renamed over there']);
  // A page that does not ask for joined computers sees only this Tower, as before.
  const plain = events(t, `${a.base}/api/events?patch=1`);
  await until(() => plain.find(frame => frame.event === 'snapshot'), 5000);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(plain.some(frame => frame.event === 'node'), false);
});

test('requests for a joined computer pass through its link with only the headers its routes read', async t => {
  const a = await tower(t);
  const b = await joined(t, a, 'computer-b');
  const detail = await fetch(`${a.base}/api/nodes/${b.id}/sessions/codex:shared`, { headers: { cookie: 'tower_session=secret', 'X-Agent-Monitor-Token': 'page-token' } });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { session: Session }).session.title, 'Shared work');
  const forwarded = b.seen.find(item => item.url === '/api/sessions/codex:shared')!;
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers['x-agent-monitor-token'], undefined);
  assert.equal((await fetch(`${a.base}/api/nodes/${b.id}/sessions/codex:private`)).status, 404, 'the joined computer decides what exists');
  const sent = await a.post(`/api/nodes/${b.id}/sessions/codex:shared/messages`, { prompt: 'continue' }, { 'X-Tower-Request-Id': '0199a2b3-c4d5-7123-8abc-0123456789ab' });
  assert.equal(sent.status, 202);
  assert.deepEqual(b.calls.at(-1)?.args.slice(0, 2), ['codex:shared', 'continue']);
  assert.deepEqual((b.calls.at(-1)?.args[2] as RequestContext).origin, { kind: 'owner', controllerId: a.identity.id });
  const refused = await fetch(`${a.base}/api/nodes/${b.id}/refuse`);
  assert.equal(refused.status, 502, 'the other computer refusing is not this browser being signed out');
  assert.equal((await refused.json() as { code: string }).code, 'node-refused');
  assert.equal((await fetch(`${a.base}/api/nodes/0123456789abcdef0123456789abcdef/sessions/codex:shared`)).status, 404);
  await b.stop();
  await until(() => a.controller.list().find(item => item.id === b.id && item.status === 'offline'), 5000);
  const offline = await fetch(`${a.base}/api/nodes/${b.id}/sessions/codex:shared`);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json() as { code: string }).code, 'node-offline');
});

test('pins and hidden folders for another computer are kept by this Tower, never sent to it', async t => {
  const a = await tower(t);
  const b = await joined(t, a, 'computer-b');
  const frames = events(t, `${a.base}/api/events?patch=1&nodes=1`);
  await until(() => frames.find(frame => frame.event === 'node'), 5000);
  assert.equal((await a.post(`/api/nodes/${b.id}/view`, { cwd: b.open, hidden: true })).status, 200);
  const hidden = await until(() => frames.find(frame => frame.event === 'node' && frame.data.patch?.fields?.groups), 5000);
  assert.deepEqual(hidden.data.patch.fields.groups, [{ cwd: b.open, title: '', pinned: false, hidden: true }]);
  assert.equal(b.calls.some(call => call.method === 'setGroup'), false);
  assert.match(await readFile(join(a.stateDir, 'link', 'views.json'), 'utf8'), /"hidden":true/);
  assert.equal((await a.post(`/api/nodes/${b.id}/view`, { cwd: b.secret, pinned: true })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(a.nodes.snapshot(b.id)?.groups?.some(group => group.cwd === b.secret), false, 'a folder that computer does not share never appears');
  assert.equal((await a.post(`/api/nodes/${b.id}/view`, { cwd: b.open, title: 'x' })).status, 400);
});

test('a joined computer that goes away stays shown as last seen, and leaves the page when removed', async t => {
  const a = await tower(t);
  const b = await joined(t, a, 'computer-b');
  const frames = events(t, `${a.base}/api/events?patch=1&nodes=1`);
  await until(() => frames.find(frame => frame.event === 'node'), 5000);
  await b.stop();
  await until(() => frames.find(frame => frame.event === 'patch' && frame.data.fields?.nodes?.[0]?.streaming === false), 5000);
  assert.deepEqual(a.nodes.snapshot(b.id)?.sessions.map(item => item.id), ['codex:shared'], 'its last state stays in memory');
  await a.controller.remove(b.id);
  const removed = await until(() => frames.find(frame => frame.event === 'node' && frame.data.removed), 5000);
  assert.equal(removed.data.node, b.id);
  assert.equal(a.nodes.snapshot(b.id), undefined);
});

test('two joined computers with the same folders and session ids arrive as separate streams', async t => {
  const a = await tower(t);
  const b = await joined(t, a, 'computer-b');
  const c = await joined(t, a, 'computer-c');
  const frames = events(t, `${a.base}/api/events?patch=1&nodes=1`);
  await until(() => frames.filter(frame => frame.event === 'node').length >= 2 || undefined, 5000);
  const streams = frames.filter(frame => frame.event === 'node');
  assert.deepEqual(streams.map(frame => frame.data.node).sort(), [b.id, c.id].sort());
  for (const frame of streams) assert.deepEqual(frame.data.snapshot.sessions.map((item: Session) => item.id), ['codex:shared']);
});
